/**
 * OpenAPI → bridge contract adapter.
 *
 * Both Spring (springdoc) and FastAPI can export OpenAPI, so consuming that document is a
 * route to frameworks the source extractors do not understand. This covers the common
 * subset: paths, parameters, JSON request bodies, responses, and `components.schemas`,
 * including `$ref`, arrays, and single-level `allOf`.
 *
 * @module polyglot-bridge/openapi
 */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { JSON_TYPE, VOID_TYPE, listOf, makeContract, mapOf, normalizeSecurityScheme, refOf, scalar } from './ir.js'
import { toCamel } from './naming.js'

/** File names looked for when a project directory carries an OpenAPI document. */
export const OPENAPI_FILES = ['openapi.json', 'swagger.json']

/** Methods this adapter maps; anything else in the document is ignored. */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

/** Last segment of a `$ref`, e.g. `#/components/schemas/Order` → `Order`. */
function refName(ref) {
  return String(ref).split('/').pop()
}

/** Title FastAPI derives from a path: `/threads/{id}/runs` → `ThreadsIdRuns`. */
function pathTitle(path) {
  return path
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => segment
      .replace(/[{}]/g, '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(''))
    .join('')
}

/**
 * Drop the auto-generated suffix from an operationId.
 *
 * FastAPI names a route `<function><path title><method>`, so `runGraphRunsPost` becomes
 * `runGraph`. An explicit operationId that happens to end the same way is indistinguishable
 * and gets the same treatment, which is what a hand-written id usually wants anyway.
 */
function cleanOperationId(identifier, path, method) {
  const suffix = `${pathTitle(path)}${method.charAt(0).toUpperCase()}${method.slice(1).toLowerCase()}`
  if (suffix.length === 0 || identifier.length <= suffix.length) return identifier
  if (!identifier.toLowerCase().endsWith(suffix.toLowerCase())) return identifier
  const trimmed = identifier.slice(0, identifier.length - suffix.length)
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
}

/** Neutral type of one schema node. */
function typeOf(schema, models) {
  if (schema === undefined || schema === null) return JSON_TYPE
  if (typeof schema.$ref === 'string') {
    const name = refName(schema.$ref)
    return models.has(name) ? refOf(name) : JSON_TYPE
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const refs = schema.allOf.map(part => typeOf(part, models)).filter(type => type.kind === 'ref')
    return refs.length === 1 ? refs[0] : JSON_TYPE
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return JSON_TYPE
  switch (schema.type) {
    case 'array': return listOf(typeOf(schema.items, models))
    case 'object':
      if (schema.additionalProperties !== undefined) {
        return mapOf(typeOf(schema.additionalProperties, models))
      }
      return JSON_TYPE
    case 'integer': return scalar('int')
    case 'number': return scalar('double')
    case 'boolean': return scalar('boolean')
    case 'string':
      if (schema.format === 'date-time') return scalar('datetime')
      if (schema.format === 'date') return scalar('date')
      if (schema.format === 'uuid') return scalar('uuid')
      if (schema.format === 'binary' || schema.format === 'byte') return scalar('bytes')
      // The allowed values are kept on the scalar: the contract then records the real domain
      // and `bridge_check` treats a changed value set as a wire change, while code generation
      // still emits a plain string until enum types are generated.
      return Array.isArray(schema.enum) && schema.enum.length > 0
        ? { ...scalar('string'), values: schema.enum.map(String) }
        : scalar('string')
    default: return JSON_TYPE
  }
}

/** Models from `components.schemas`, one level of `allOf` inheritance included. */
function modelsOf(schemas, names) {
  const models = []
  for (const [name, schema] of Object.entries(schemas ?? {})) {
    // A named enumeration is a type of its own, not a string field producer.
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      models.push({ name, kind: 'enum', values: schema.enum.map(String) })
      continue
    }
    // A discriminated union becomes a model too, so references to it stay a `ref` and the
    // generators can emit a real union type instead of an opaque json.
    const branches = Array.isArray(schema.oneOf) ? schema.oneOf : undefined
    if (branches !== undefined && schema.discriminator?.propertyName !== undefined) {
      const mapping = schema.discriminator.mapping ?? {}
      const variants = branches
        .map(branch => {
          const branchName = typeof branch.$ref === 'string' ? refName(branch.$ref) : ''
          const tag = Object.entries(mapping)
            .find(([, target]) => refName(String(target)) === branchName)?.[0]
          return { name: branchName, tag: tag ?? branchName }
        })
        .filter(variant => variant.name.length > 0)
      if (variants.length > 0) {
        models.push({ name, kind: 'union', discriminator: schema.discriminator.propertyName, variants })
        continue
      }
    }
    const parts = Array.isArray(schema.allOf) && schema.allOf.length > 0 ? schema.allOf : [schema]
    const properties = {}
    const required = new Set()
    for (const part of parts) {
      if (typeof part.$ref === 'string') {
        const parent = schemas[refName(part.$ref)]
        if (parent && typeof parent === 'object') {
          for (const [key, value] of Object.entries(parent.properties ?? {})) properties[key] = value
          for (const key of parent.required ?? []) required.add(key)
        }
        continue
      }
      for (const [key, value] of Object.entries(part.properties ?? {})) properties[key] = value
      for (const key of part.required ?? []) required.add(key)
    }
    const fields = Object.entries(properties).map(([key, value]) => ({
      name: key,
      type: typeOf(value, names),
      required: required.has(key),
      ...(isNullable(value) ? { nullable: true } : {}),
    }))
    if (fields.length > 0) models.push({ name, origin: 'json', fields })
  }
  return models
}

/** 
ullable: true (OpenAPI 3.0) or a 
ull member in 	ype (3.1). */
function isNullable(schema) {
  if (schema === null || typeof schema !== 'object') return false
  if (schema.nullable === true) return true
  return Array.isArray(schema.type) && schema.type.includes('null')
}

/** One parameter of an operation. */
function paramOf(parameter) {
  const kind = parameter.in
  // Cookie parameters carry no cross-language meaning this bridge can honour, so they are
  // skipped; header parameters do, and the generators emit them.
  if (kind !== 'path' && kind !== 'query' && kind !== 'header') return undefined
  const schema = parameter.schema ?? {}
  const location = kind === 'path' ? 'path' : kind === 'header' ? 'header' : 'query'
  const param = {
    in: location,
    name: String(parameter.name),
    type: typeOf(schema, new Set()),
    required: location === 'path' ? true : parameter.required === true,
  }
  if (schema.default !== undefined) param.default = String(schema.default)
  if (isNullable(schema)) param.nullable = true
  return param
}

/** Operations of one path item. */
function operationsOf(path, item, names) {
  const operations = []
  for (const method of METHODS) {
    const operation = item[method]
    if (operation === undefined) continue
    const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])]
      .map(paramOf)
      .filter(parameter => parameter !== undefined)
    const bodySchema = operation.requestBody?.content?.['application/json']?.schema
    // OpenAPI has no dedicated "streaming" flag, but a server-sent event endpoint declares a
    // `text/event-stream` response body. Without this the generated client would read an SSE
    // endpoint to completion instead of consuming it incrementally.
    const streaming = Object.values(operation.responses ?? {})
      .some(response => response?.content?.['text/event-stream'] !== undefined)
    const responses = Object.entries(operation.responses ?? {})
      .filter(([code]) => /^\d{3}$/.test(code) || code === 'default')
      .map(([code, response]) => {
        const status = Number(code)
        if (!Number.isInteger(status)) return { status: 200, type: JSON_TYPE }
        const content = response?.content ?? {}
        const jsonSchema = content['application/json']?.schema
        if (jsonSchema !== undefined) return { status, type: typeOf(jsonSchema, names) }
        // A stream is consumed by the streaming path, not parsed as one value.
        if (content['text/event-stream'] !== undefined) return { status, type: VOID_TYPE }
        const kinds = Object.keys(content)
        if (kinds.some(kind => kind.startsWith('text/'))) {
          return { status, type: scalar('string') }
        }
        // Any other declared body (octet-stream, image/*, application/pdf) is a byte payload:
        // decoding it as JSON would fail, so the contract says `bytes` instead.
        if (kinds.length > 0) return { status, type: scalar('bytes') }
        return { status, type: VOID_TYPE }
      })
    operations.push({
      // Camel first: FastAPI emits snake_case ids (`run_graph_runs_post`), and the suffix
      // comparison only works on the camel form.
      id: cleanOperationId(toCamel(
        operation.operationId ?? `${method}_${path.replace(/[^A-Za-z0-9]+/g, '_')}`,
      ), path, method),
      method: method.toUpperCase(),
      path,
      summary: operation.summary ?? operation.description ?? '',
      params: parameters,
      ...(bodySchema === undefined ? {} : { requestBody: typeOf(bodySchema, names) }),
      responses: responses.length > 0 ? responses : [{ status: 200, type: JSON_TYPE }],
      ...(streaming ? { streaming: true } : {}),
      // A route's own list overrides the document default; an empty list means "no auth here".
      ...(Array.isArray(operation.security)
        ? { security: operation.security.flatMap(requirement => Object.keys(requirement ?? {})) }
        : {}),
      source: { file: 'openapi', line: 0 },
    })
  }
  return operations
}

/** Build a contract from an already parsed OpenAPI document. */
export function contractFromOpenApi(document, options = {}) {
  const schemas = document.components?.schemas ?? {}
  const names = new Set(Object.keys(schemas))
  const models = modelsOf(schemas, names)
  const operations = []
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (item === null || typeof item !== 'object') continue
    operations.push(...operationsOf(path, item, names))
  }
  // `oneOf`/`anyOf` has no neutral representation yet, so it degrades to `json`. The warning
  // names the branches and the discriminator, because that is what a caller needs in order to
  // model the union by hand instead of guessing why the type became opaque.
  const warnings = []
  for (const [name, schema] of Object.entries(schemas)) {
    const branches = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
    if (branches === undefined) continue
    const names = branches.map(branch => (typeof branch.$ref === 'string' ? refName(branch.$ref) : branch.type ?? 'inline')).join(' | ')
    const property = schema.discriminator?.propertyName
    const hint = property === undefined ? 'no discriminator' : `discriminated by \`${property}\``
    warnings.push({
      file: 'openapi',
      message: `schema \`${name}\` uses oneOf/anyOf (${names}; ${hint}) and degrades to json`,
    })
  }
  // A component with the RFC 7807 members is almost certainly the shared error envelope.
  const problemDetails = Object.entries(schemas)
    .filter(([, schema]) => {
      const properties = schema.properties ?? {}
      return ['type', 'title', 'detail', 'status'].every(member => Object.prototype.hasOwnProperty.call(properties, member))
    })
    .map(([name]) => name)[0]

  // Authentication schemes live in components.securitySchemes; a route's own `security` list
  // overrides the document default. Only schemes a client can apply are kept, and a scheme the
  // client cannot apply is warned about instead of being dropped silently, because that would
  // produce a client that sends no credential against a route that needs one.
  const security = []
  for (const [name, scheme] of Object.entries(document.components?.securitySchemes ?? {})) {
    const normalized = normalizeSecurityScheme({
      name,
      type: scheme?.type,
      scheme: scheme?.scheme,
      in: scheme?.in,
      paramName: scheme?.name,
      description: scheme?.description,
    })
    if (normalized === undefined) {
      warnings.push({
        file: 'openapi',
        message: `security scheme \`${name}\` (${scheme?.type ?? 'unknown'}${scheme?.scheme === undefined ? '' : ` ${scheme.scheme}`}) is not supported and is omitted; generated clients will not authenticate for it`,
      })
      continue
    }
    security.push(normalized)
  }
  const securityDefault = Array.isArray(document.security)
    ? document.security.flatMap(requirement => Object.keys(requirement ?? {}))
    : undefined

  return makeContract({
    kind: 'openapi',
    name: options.name ?? document.info?.title ?? 'openapi',
    baseUrl: document.servers?.[0]?.url ?? '',
    source: { root: options.sourceDir ?? '', files: 1 },
    operations,
    models,
    problemDetails,
    security,
    securityDefault,
    warnings,
  })
}

/** Read and extract from an OpenAPI file. Mirrors the shape of the source extractors. */
export function extractOpenApi(root, options = {}) {
  const file = options.file ?? join(root, OPENAPI_FILES[0])
  const document = JSON.parse(readFileSync(file, 'utf8'))
  if (document.openapi === undefined && document.swagger === undefined) {
    throw new Error(`${file} is not an OpenAPI document (no openapi/swagger version field)`)
  }
  const contract = contractFromOpenApi(document, { ...options, name: options.name ?? basename(root), sourceDir: root })
  return { framework: 'openapi', contract, warnings: contract.warnings ?? [] }
}

/** Whether a directory carries an OpenAPI document this adapter can read. */
export function hasOpenApi(root) {
  return OPENAPI_FILES.some(name => {
    try {
      readFileSync(join(root, name), 'utf8')
      return true
    } catch {
      return false
    }
  })
}

/**
 * Routes a running service commonly serves its own document on.
 *
 * Ordered from the most specific convention to the most generic. A YAML document is reported
 * separately: it is recognised, but not parsed, so the caller is told to convert it rather than
 * being told that nothing was found.
 */
export const OPENAPI_PATHS = [
  '/openapi.json',
  '/v3/api-docs',
  '/swagger.json',
  '/api-docs',
  '/swagger/v1/swagger.json',
  '/.well-known/openapi.json',
]

/** Document routes that exist but are not parsed by this adapter. */
export const OPENAPI_YAML_PATHS = ['/openapi.yaml', '/swagger.yaml']

/**
 * Fetch the document a running service describes itself with.
 *
 * Runtime documents often carry a relative or placeholder `servers` entry, so the base URL
 * comes from the address actually used unless the document names an absolute one.
 *
 * @param baseUrl service origin, e.g. `http://127.0.0.1:8021`
 * @param options.headers extra request headers, for a protected endpoint
 */
export async function fetchOpenApi(baseUrl, options = {}) {
  const origin = String(baseUrl).replace(/\/+$/, '')
  const failures = []
  for (const path of OPENAPI_PATHS) {
    const url = `${origin}${path}`
    let response
    try {
      response = await fetch(url, {
        headers: options.headers ?? {},
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      })
    } catch (error) {
      failures.push(`${path}: ${error.message}`)
      continue
    }
    if (!response.ok) {
      failures.push(`${path}: HTTP ${response.status}`)
      continue
    }
    const document = await response.json().catch(() => undefined)
    if (document === undefined || (document.openapi === undefined && document.swagger === undefined)) {
      failures.push(`${path}: not an OpenAPI document`)
      continue
    }    const declared = document.servers?.[0]?.url ?? ''
    const absolute = /^https?:\/\//i.test(declared) ? declared : origin
    const contract = contractFromOpenApi(document, {
      name: options.name ?? document.info?.title ?? origin,
      sourceDir: origin,
    })
    return {
      framework: 'openapi',
      contract: { ...contract, baseUrl: absolute },
      warnings: contract.warnings ?? [],
    }
  }
  // A YAML document is a real find, not a miss: report it and say what to do about it, instead
  // of claiming nothing was found.
  for (const path of OPENAPI_YAML_PATHS) {
    try {
      const response = await fetch(`${origin}${path}`, {
        headers: options.headers ?? {},
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      })
      if (!response.ok) continue
      const head = (await response.text()).slice(0, 200)
      if (/^\s*(openapi|swagger)\s*:/i.test(head)) {
        throw new Error(`yaml-document`, { cause: new Error(
          `found a YAML OpenAPI document at ${origin}${path}, but YAML is not parsed here; `
          + 'convert it to JSON (for example `yq -o=json`) and pass the file path instead') })
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'yaml-document') {
        throw error.cause
      }
    }
  }
  throw new Error(
    `no OpenAPI document at ${origin}; tried ${OPENAPI_PATHS.join(', ')} (${failures.join('; ')})`)
}
