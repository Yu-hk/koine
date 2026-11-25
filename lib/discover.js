/**
 * Documentation discovery.
 *
 * Users often do not know which file holds the contract, and a document they hand over may be
 * the wrong one. This scans a project for candidate documents and returns them with evidence —
 * what matched, how trustworthy it is — instead of picking one. Selection stays with the caller.
 *
 * Deliberately excluded: YAML documents (no parser here) and human-readable docs, which are
 * reported as pointers at most, never as a contract source.
 *
 * @module polyglot-bridge/discover
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { OPENAPI_PATHS, OPENAPI_YAML_PATHS } from './openapi.js'

/** Directory names never worth walking into. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', 'build', 'dist', 'vendor', 'runtime',
  '__pycache__', '.venv', 'venv', 'data', '.idea', '.tmp',
])

/** Names that usually carry an OpenAPI or Swagger document. */
const SPEC_NAME = /^(openapi|swagger)([.-].*)?\.json$|[-_](openapi|swagger)\.json$/i

/** Files that may point at a document without being one. */
const POINTER_NAME = /^(readme|api|docs?)([.-].*)?\.md$/i

/** Walk a tree, bounded in depth and file count, skipping build and dependency directories. */
function walk(root, maxDepth = 6, maxFiles = 4000) {
  const found = []
  const visit = (dir, depth) => {
    if (depth > maxDepth || found.length >= maxFiles) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        visit(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      // Documents this plugin generated are not evidence of the service's own documentation.
      if (entry.name === 'README-BRIDGE.md' || entry.name === 'bridge-contract.json') continue
      if (SPEC_NAME.test(entry.name) || POINTER_NAME.test(entry.name)) found.push(full)
    }
  }
  visit(root, 0)
  return found
}

/** Whether a parsed JSON value looks like an OpenAPI or Swagger document. */
function isSpec(document) {
  return document !== null && typeof document === 'object'
    && (document.openapi !== undefined || document.swagger !== undefined)
}

/** Keywords matched in a haystack, lowercased. */
function matched(keywords, haystack) {
  const text = haystack.toLowerCase()
  return keywords.filter(keyword => text.includes(keyword.toLowerCase()))
}

/** Read an OpenAPI JSON file into a candidate, or undefined when it is not one. */
function readSpec(file, root, keywords) {
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (!isSpec(document)) return undefined
  const title = String(document.info?.title ?? '')
  const paths = document.paths === undefined ? [] : Object.keys(document.paths)
  const hit = [
    ...matched(keywords, title).map(word => `title:${word}`),
    ...matched(keywords, basename(file)).map(word => `file:${word}`),
    ...matched(keywords, paths.join(' ')).map(word => `path:${word}`),
  ]
  return {
    kind: 'openapi',
    path: relative(root, file).replace(/\\/g, '/'),
    title: title.length > 0 ? title : basename(file),
    routes: paths.length,
    match: hit.join(', '),
    trust: hit.length > 0 || keywords.length === 0 ? 'high' : 'low',
    score: 100 + paths.length + hit.length * 10,
  }
}

/** Read a Markdown file as a pointer only: it can name a document, it is not one. */
function readPointer(file, root, keywords) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const hit = matched(keywords, text)
  if (keywords.length > 0 && hit.length === 0) return undefined
  return {
    kind: 'pointer',
    path: relative(root, file).replace(/\\/g, '/'),
    title: basename(file),
    routes: 0,
    match: hit.map(word => `text:${word}`).join(', '),
    trust: 'pointer-only',
    score: keywords.length === 0 ? 1 : hit.length,
  }
}

/**
 * Probe a running service for the documents it serves.
 *
 * The same candidate shape as the local scan, so a caller can treat both sources uniformly.
 * YAML is reported with trust `unsupported`: it is a real find, but this plugin does not parse
 * it, and saying "nothing found" would send the reader looking in the wrong direction.
 */
export async function discoverRemote(options = {}) {
  const origin = String(options.url ?? '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(origin)) {
    throw new Error('discoverRemote needs an http(s) url')
  }
  const headers = options.headers ?? {}
  const timeout = options.timeoutMs ?? 8000
  const candidates = []

  for (const path of OPENAPI_PATHS) {
    try {
      const response = await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(timeout) })
      if (!response.ok) continue
      const document = await response.json().catch(() => undefined)
      if (document === undefined || (document.openapi === undefined && document.swagger === undefined)) continue
      candidates.push({
        kind: 'openapi',
        path: `${origin}${path}`,
        title: String(document.info?.title ?? path),
        routes: Object.keys(document.paths ?? {}).length,
        match: 'probe',
        trust: 'high',
      })
    } catch {
      // Keep probing: one route failing says nothing about the others.
    }
  }

  for (const path of OPENAPI_YAML_PATHS) {
    try {
      const response = await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(timeout) })
      if (!response.ok) continue
      const head = (await response.text()).slice(0, 200)
      if (/^\s*(openapi|swagger)\s*:/i.test(head)) {
        candidates.push({
          kind: 'yaml',
          path: `${origin}${path}`,
          title: path,
          routes: 0,
          match: 'probe',
          trust: 'unsupported',
        })
      }
    } catch {
      // Same reasoning as above.
    }
  }

  return candidates
}

/**
 * Find candidate documents under a project directory.
 *
 * @param options.projectDir directory to scan
 * @param options.keywords terms to rank against; empty means "list everything found"
 * @returns candidates sorted by score, highest first
 */
export function discoverDocuments(options = {}) {
  const root = options.projectDir
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new Error('discoverDocuments needs a projectDir')
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${root}`)
  }
  const keywords = (options.keywords ?? []).map(String).filter(word => word.length > 0)
  const candidates = []
  for (const file of walk(root)) {
    const candidate = SPEC_NAME.test(basename(file))
      ? readSpec(file, root, keywords)
      : readPointer(file, root, keywords)
    if (candidate !== undefined) candidates.push(candidate)
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  return candidates.map(({ score, ...rest }) => rest)
}
