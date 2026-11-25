/**
 * The engine: four pure operations, with no host assumptions.
 *
 * A host adapter (the DSH plugin today, an MCP server or a CLI later) is responsible for
 * resolving paths against its own working directory, validating arguments, rendering results and
 * touching the filesystem. Everything here takes plain values and returns plain values, so the
 * same logic serves every host and can be tested without one.
 *
 * @module polyglot-bridge/engine
 */

import { extractContract } from './extract.js'
import { discoverDocuments, discoverRemote } from './discover.js'
import { fetchOpenApi } from './openapi.js'
import { diffContracts, severityOf } from './ir.js'
import { generateJavaClient } from './gen-java.js'
import { generatePythonClient } from './gen-python.js'
import { generateTypeScriptClient } from './gen-typescript.js'
import { generateJavaServer, generatePythonServer } from './gen-server.js'

/** Targets this build can generate, with the side each one serves. */
export const TARGETS = [
  { id: 'java-client', side: 'client', language: 'java' },
  { id: 'python-client', side: 'client', language: 'python' },
  { id: 'typescript-client', side: 'client', language: 'typescript' },
  { id: 'java-server', side: 'server', language: 'java' },
  { id: 'python-server', side: 'server', language: 'python' },
]

/**
 * Find candidate API documents.
 *
 * @param options.projectDir directory to scan, or
 * @param options.url running service to probe
 * @param options.keywords optional ranking terms, local scan only
 * @param options.headers optional request headers, url only
 * @returns candidates with evidence, highest score first
 */
export async function discover(options = {}) {
  const url = typeof options.url === 'string' && options.url.trim().length > 0 ? options.url.trim() : undefined
  if (url !== undefined) {
    return discoverRemote({ url, headers: options.headers })
  }
  if (typeof options.projectDir !== 'string' || options.projectDir.trim().length === 0) {
    throw new Error('discover needs a projectDir or a url')
  }
  const keywords = Array.isArray(options.keywords) ? options.keywords.map(String) : []
  return discoverDocuments({ projectDir: options.projectDir, keywords })
}

/**
 * Read a contract from a source, without writing anything.
 *
 * @param options.projectDir project directory, or
 * @param options.url running service
 * @param options.framework adapter hint; `auto` probes the tree
 * @param options.name optional service name override
 * @param options.headers optional request headers, url only
 * @returns `{ contract, framework }`
 */
export async function extract(options = {}) {
  const url = typeof options.url === 'string' && options.url.trim().length > 0 ? options.url.trim() : undefined
  if (url !== undefined) {
    const fetched = await fetchOpenApi(url, { name: options.name, headers: options.headers })
    return { contract: fetched.contract, framework: fetched.framework }
  }
  if (typeof options.projectDir !== 'string' || options.projectDir.trim().length === 0) {
    throw new Error('extract needs a projectDir or a url')
  }
  const extracted = extractContract(options.projectDir, {
    framework: options.framework ?? 'auto',
    name: options.name,
  })
  return { contract: extracted.contract, framework: extracted.framework }
}

/**
 * Generate sources for one contract, without writing them.
 *
 * @param contract a bridge contract, already normalised
 * @param target one of {@link TARGETS}
 * @param options serviceName, packageName, moduleName, baseUrl
 * @returns `{ files, className, moduleName, notes }`
 */
export function generate(contract, target, options = {}) {
  if (!TARGETS.some(entry => entry.id === target)) {
    throw new Error(`unknown target ${target}; expected one of ${TARGETS.map(entry => entry.id).join(', ')}`)
  }
  switch (target) {
    case 'java-client': return generateJavaClient(contract, options)
    case 'python-client': return generatePythonClient(contract, options)
    case 'typescript-client': return generateTypeScriptClient(contract, options)
    case 'java-server': return generateJavaServer(contract, options)
    default: return generatePythonServer(contract, options)
  }
}

/**
 * Compare two contracts and grade every difference.
 *
 * @param baseline side A, the current contract
 * @param candidate side B, the proposed contract
 * @param options.failOn 'none' | 'breaking' | 'additive'; the gate that decides acceptance
 * @returns the diff, severity counts and whether the gate tripped
 */
export function compare(baseline, candidate, options = {}) {
  const failOn = options.failOn ?? 'none'
  const result = diffContracts(baseline, candidate)

  const counts = { breaking: 0, additive: 0, cosmetic: 0 }
  for (const entry of [...result.changed, ...result.models.changed]) {
    for (const detail of entry.details) counts[severityOf(detail)] += 1
  }
  // A removed route or model has no detail string, so it is counted explicitly. It is the
  // severest change of all, and a severity loop alone would miss it.
  const removed = { routes: result.onlyInA.length, models: result.models.onlyInA.length }

  const tripped = failOn === 'none'
    ? false
    : failOn === 'breaking'
      ? counts.breaking > 0 || removed.routes > 0 || removed.models > 0
      : counts.breaking + counts.additive > 0 || removed.routes > 0 || removed.models > 0

  return { result, counts, removed, failOn, tripped }
}
