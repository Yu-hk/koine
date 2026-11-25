/**
 * Framework detection and extraction dispatch.
 *
 * Detection is a bounded content probe rather than a full parse: it decides which
 * extractor owns the tree before any scanning happens, and reports an explicit
 * framework choice without second-guessing it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extractOpenApi, hasOpenApi } from './openapi.js'
import { join } from 'node:path'
import { extractFastApi } from './fastapi-extract.js'
import { extractFlask } from './flask-extract.js'
import { extractSpring } from './spring-extract.js'

/** Directories never worth probing. */
const SKIP_DIRS = new Set([
  '.git', '.venv', 'venv', 'env', 'node_modules', '__pycache__', 'target', 'build',
  'dist', 'site-packages', 'migrations', 'alembic', '.idea', '.gradle', 'out',
])

/** Patterns that identify each supported framework. */
const SIGNATURES = {
  fastapi: { extension: '.py', pattern: /\b(?:FastAPI|APIRouter)\s*\(/ },
  flask: { extension: '.py', pattern: /\b(?:Flask|Blueprint)\s*\(/ },
  spring: { extension: '.java', pattern: /@(?:RestController|RequestMapping|GetMapping)\b/ },
}

/** Collect candidate files of one extension, bounded. */
function candidates(root, extension, limit) {
  const files = []
  const stack = [root]
  while (stack.length > 0 && files.length < limit) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (files.length >= limit) break
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name))
        continue
      }
      if (entry.isFile() && entry.name.endsWith(extension)) files.push(join(dir, entry.name))
    }
  }
  return files
}

/** Whether any file of a framework's extension matches its signature. */
function looksLike(root, framework, limit = 60) {
  const { extension, pattern } = SIGNATURES[framework]
  for (const file of candidates(root, extension, limit)) {
    try {
      if (statSync(file).size > 1_000_000) continue
      if (pattern.test(readFileSync(file, 'utf8'))) return true
    } catch {
      continue
    }
  }
  return false
}

/**
 * Decide which supported framework a project tree belongs to.
 *
 * A FastAPI app is checked before Flask: both are `.py` trees, and a project that
 * imports FastAPI is served by FastAPI even if a stray Flask import exists.
 *
 * @returns `'fastapi'`, `'flask'`, `'spring'`, or `undefined` when no signature is found.
 */
export function detectFramework(root) {
  if (!existsSync(root)) throw new Error(`project directory does not exist: ${root}`)
  if (looksLike(root, 'fastapi')) return 'fastapi'
  if (looksLike(root, 'flask')) return 'flask'
  if (looksLike(root, 'spring')) return 'spring'
  return undefined
}

/** Extract a contract from a project with the owning framework adapter. */
export function extractContract(root, options = {}) {
  const requested = options.framework ?? 'auto'
  // An exported OpenAPI document wins when present: it describes the wire surface even for
  // frameworks the source extractors cannot read, and it is an explicit artifact rather
  // than a guess.
  if (requested === 'openapi' || (requested === 'auto' && hasOpenApi(root))) {
    return extractOpenApi(root, options)
  }
  const detected = requested === 'auto' ? detectFramework(root) : requested
  if (detected === undefined) {
    throw new Error(
      `no supported framework found under ${root}: expected a FastAPI app/APIRouter, `
      + 'a Flask app/Blueprint, or a Spring @RestController',
    )
  }
  const contract = detected === 'fastapi'
    ? extractFastApi(root, options)
    : detected === 'flask'
      ? extractFlask(root, options)
      : extractSpring(root, options)
  return { contract, framework: detected }
}

export { SIGNATURES }
