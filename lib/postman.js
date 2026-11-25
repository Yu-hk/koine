/**
 * Postman collection adapter.
 *
 * A collection is evidence of routes, not of types: a request may carry a JSON body sample and
 * a response example, but neither is a schema. This adapter therefore extracts what is
 * defensible — method, path, path/query parameters, body presence, recorded status codes — and
 * reports a `partial` warning for everything a collection cannot express.
 *
 * Treating a collection as equivalent to an OpenAPI document would silently generate clients
 * with `json` everywhere, so the limitation is stated rather than hidden.
 *
 * @module polyglot-bridge/postman
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { JSON_TYPE, VOID_TYPE, listOf, makeContract, mapOf, refOf, scalar } from './ir.js'
import { toCamel, toPascal } from './naming.js'

/** Whether a parsed JSON value looks like a Postman collection. */
export function isPostmanCollection(document) {
  if (document === null || typeof document !== 'object') return false
  if (!Array.isArray(document.item)) return false
  const schema = String(document.info?.schema ?? '')
  return schema.includes('collection') || document.info?.name !== undefined
}

/** Squash a URL description into a path string. */
function pathOf(url) {
  if (url === undefined) return '/'
  if (typeof url === 'string') return url
  const segments = Array.isArray(url.path) ? url.path : []
  const joined = segments
    .map(segment => (typeof segment === 'string' ? segment : String(segment?.value ?? '')))
    .filter(segment => segment.length > 0)
    .join('/')
  // Postman marks a path variable as `:id`; the contract spells it `{id}`, and a generator only
  // turns the latter into a real parameter.
  const templated = joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
  return templated.length > 0 ? `/${templated}` : '/'
}

/** Path variables declared by a Postman URL. */
function pathParamsOf(url) {
  if (url === null || typeof url !== 'object') return []
  const declared = new Set()
  if (Array.isArray(url.variable)) {
    for (const variable of url.variable) {
      if (variable?.key !== undefined) declared.add(String(variable.key))
    }
  }
  for (const segment of Array.isArray(url.path) ? url.path : []) {
    const text = typeof segment === 'string' ? segment : String(segment?.value ?? '')
    if (text.startsWith(':')) declared.add(text.slice(1))
  }
  return [...declared]
}

/** Query parameters declared by a Postman URL. */
function queryParamsOf(url) {
  if (url === null || typeof url !== 'object' || !Array.isArray(url.query)) return []
  return url.query
    .filter(entry => entry?.key !== undefined && String(entry.key).length > 0 && entry.disabled !== true)
    .map(entry => ({ in: 'query', name: String(entry.key), type: scalar('string'), required: false }))
}

/** Raw JSON body of a request, if the sample happens to be valid JSON. */
function bodyOf(request) {
  const raw = request?.body?.raw
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Infer one model from a JSON sample: keys and primitive types, one level deep. */
function modelFromSample(name, sample) {
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) return undefined
  const fields = Object.entries(sample).map(([key, value]) => {
    if (Array.isArray(value)) {
      const inner = value.length > 0 ? value[0] : undefined
      const element = inner === null || typeof inner !== 'object'
        ? scalar(typeof inner === 'number' ? 'double' : typeof inner === 'boolean' ? 'boolean' : 'string')
        : JSON_TYPE
      return { name: key, type: listOf(element), required: true }
    }
    if (value === null) return { name: key, type: JSON_TYPE, required: false }
    const kind = typeof value
    const type = kind === 'number' ? scalar('double') : kind === 'boolean' ? scalar('boolean') : kind === 'string' ? scalar('string') : JSON_TYPE
    return { name: key, type, required: true }
  })
  return fields.length === 0 ? undefined : { name, origin: 'json', fields }
}

/** Collect every request in a collection, walking folders. */
function collectItems(items, out = []) {
  for (const item of items ?? []) {
    if (Array.isArray(item.item)) {
      collectItems(item.item, out)
      continue
    }
    if (item.request !== undefined) out.push(item)
  }
  return out
}

/** Read a Postman collection into a contract. */
export function extractPostman(file, options = {}) {
  const document = JSON.parse(readFileSync(file, 'utf8'))
  if (!isPostmanCollection(document)) {
    throw new Error(`${file} is not a Postman collection`)
  }
  const name = String(document.info?.name ?? basename(file))
  const operations = []
  const models = []
  const warnings = []

  for (const item of collectItems(document.item)) {
    const request = item.request
    const url = request.url
    const path = pathOf(url)
    const params = [...pathParamsOf(url).map(variable => ({
      in: 'path',
      name: variable,
      type: scalar('string'),
      required: true,
    })), ...queryParamsOf(url)]

    const sample = bodyOf(request)
    let requestBody = JSON_TYPE
    if (sample !== undefined) {
      const model = modelFromSample(`${toPascal(item.name ?? 'body')}Input`, sample)
      if (model !== undefined) {
        models.push(model)
        requestBody = refOf(model.name)
      }
    }

    const recorded = Array.isArray(item.response) ? item.response : []
    const responses = recorded.length > 0
      ? recorded.map(response => ({
        status: Number(response.code ?? 200),
        type: Number(response.code) === 204 ? VOID_TYPE : JSON_TYPE,
      }))
      : [{ status: 200, type: JSON_TYPE }]

    operations.push({
      id: toCamel(String(item.name ?? `${request.method ?? 'get'}_${path}`).replace(/[^A-Za-z0-9]+/g, '_')),
      method: String(request.method ?? 'GET').toUpperCase(),
      path,
      summary: String(item.name ?? ''),
      params,
      ...(sample === undefined ? {} : { requestBody }),
      responses,
      source: { file: basename(file), line: 0 },
    })
  }

  warnings.push({
    file: basename(file),
    message: 'Postman collection: response types are `json` because a collection carries examples, '
      + 'not schemas; request bodies are inferred from a sample and may be incomplete',
  })
  warnings.push({
    file: basename(file),
    message: 'collection variables ({{baseUrl}}) are not resolved; set baseUrl when generating',
  })

  const contract = makeContract({
    kind: 'postman',
    name,
    baseUrl: '',
    source: { root: file, files: 1 },
    operations,
    models,
    warnings,
  })
  return { framework: 'postman', contract, warnings: contract.warnings }
}
