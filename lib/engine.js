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

import { existsSync, statSync } from 'node:fs'
import { extractContract } from './extract.js'
import { loadContractFile } from './io.js'
import { discoverDocuments, discoverRemote } from './discover.js'
import { fetchOpenApi } from './openapi.js'
import { IR_VERSION, SCALARS, diffContracts, severityOf } from './ir.js'
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
 * Resolve a caller-supplied contract argument.
 *
 * Every host accepts the same three shapes — an http(s) URL of a running service, a project
 * directory, or a contract file — so the resolution lives here rather than being reimplemented per
 * adapter. Hosts only translate their own path semantics first (a session working directory, a
 * client's root) and then call this.
 *
 * @param input URL, directory or file path
 * @param options.label used in the error message, and options.headers for a URL
 * @returns `{ contract, path, framework?, extracted }`
 */
export async function resolveContract(input, options = {}) {
  const text = String(input)
  const label = options.label ?? 'contract'
  if (/^https?:\/\//i.test(text)) {
    const { contract, framework } = await extract({ url: text, headers: options.headers })
    return { contract, path: text, framework, extracted: true }
  }
  if (!existsSync(text)) {
    throw new Error(`${label} does not exist: ${text}`)
  }
  if (statSync(text).isDirectory()) {
    const { contract, framework } = await extract({ projectDir: text, framework: options.framework })
    return { contract, path: text, framework, extracted: true }
  }
  return { contract: loadContractFile(text), path: text, extracted: false }
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** Collect problems with one type expression. */
function typeProblems(type, where, errors, modelNames) {
  if (type === undefined || type === null) {
    errors.push(`${where}: missing type`)
    return
  }
  switch (type.kind) {
    case 'scalar':
      if (!SCALARS.has(String(type.name))) errors.push(`${where}: unknown scalar \`${type.name}\``)
      return
    case 'list':
    case 'map':
      typeProblems(type.of, `${where}.of`, errors, modelNames)
      return
    case 'ref':
      if (!modelNames.has(String(type.name))) errors.push(`${where}: ref to unknown model \`${type.name}\``)
      return
    case 'enum':
      if (!Array.isArray(type.values) || type.values.length === 0) errors.push(`${where}: enum needs a non-empty values array`)
      return
    case 'union':
      if (!Array.isArray(type.variants) || type.variants.length === 0) errors.push(`${where}: union needs a non-empty variants array`)
      for (const variant of type.variants ?? []) {
        if (!modelNames.has(String(variant.name))) errors.push(`${where}: union variant \`${variant.name}\` is not a model`)
      }
      return
    default:
      errors.push(`${where}: unknown type kind \`${type.kind}\``)
  }
}

/**
 * Check a contract the caller authored, without throwing.
 *
 * An agent may compose a contract from source it read itself — for a framework the extractors do
 * not parse, or for routes built at runtime. That is a legitimate input, so the alternative to
 * "trust the model" is a structural check with actionable messages rather than an exception:
 * a caller has to be able to fix the contract and try again.
 *
 * @returns `{ ok, errors }`; errors are one-line, each naming a location
 */
export function validateContract(contract) {
  const errors = []
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
    return { ok: false, errors: ['contract must be a JSON object'] }
  }
  if (contract.version !== IR_VERSION) {
    errors.push(`version ${JSON.stringify(contract.version)} does not equal ${IR_VERSION}`)
  }
  if (!Array.isArray(contract.operations)) errors.push('operations must be an array')
  if (!Array.isArray(contract.models)) errors.push('models must be an array')

  const modelNames = new Set((contract.models ?? []).map(model => String(model?.name)))
  const seen = new Set()
  for (const [index, operation] of (contract.operations ?? []).entries()) {
    const where = `operations[${index}]`
    if (operation?.id === undefined) errors.push(`${where}.id is required`)
    if (!HTTP_METHODS.has(String(operation?.method))) errors.push(`${where}.method \`${operation?.method}\` is not an HTTP method`)
    if (typeof operation?.path !== 'string' || !operation.path.startsWith('/')) errors.push(`${where}.path must start with "/"`)
    const key = `${operation?.method} ${operation?.path}`
    if (seen.has(key)) errors.push(`${where}: duplicate route \`${key}\``)
    seen.add(key)
    if (!Array.isArray(operation?.params)) errors.push(`${where}.params must be an array`)
    for (const param of operation?.params ?? []) {
      typeProblems(param?.type, `${where}.params[${param?.name ?? '?'}]`, errors, modelNames)
    }
    if (operation?.requestBody !== undefined) {
      typeProblems(operation.requestBody, `${where}.requestBody`, errors, modelNames)
    }
    if (!Array.isArray(operation?.responses)) errors.push(`${where}.responses must be an array`)
    for (const response of operation?.responses ?? []) {
      if (typeof response?.status !== 'number') errors.push(`${where}.responses: status must be a number`)
    }
  }
  for (const [index, model] of (contract.models ?? []).entries()) {
    if (model?.name === undefined) errors.push(`models[${index}].name is required`)
    if (!Array.isArray(model?.fields)) errors.push(`models[${index}].fields must be an array`)
    for (const field of model?.fields ?? []) {
      typeProblems(field?.type, `models.${model?.name}.${field?.name}`, errors, modelNames)
    }
  }
  return { ok: errors.length === 0, errors }
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
