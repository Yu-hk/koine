/**
 * The bridge's neutral contract format.
 *
 * One IR sits between every extractor and every generator, so adding a language
 * means adding an extractor or a generator, never touching the other side. Types
 * are canonicalized to a language-neutral scale: Python `int` and Java
 * `long`/`Integer` all become `int`, because the contract describes what crosses
 * the wire, not what sits in memory.
 *
 * @module polyglot-bridge/ir
 */

/** Contract format version; bumped when the shape changes incompatibly. */
export const IR_VERSION = 1

/** Canonical scalar names shared by every language. */
export const SCALARS = new Set([
  'string', 'int', 'double', 'boolean', 'decimal', 'datetime', 'date', 'time',
  'uuid', 'bytes', 'json', 'any', 'void',
])

/** A scalar type. */
export const scalar = name => ({ kind: 'scalar', name })

/** A homogeneous list type. */
export const listOf = of => ({ kind: 'list', of })

/** A string-keyed map type. */
export const mapOf = of => ({ kind: 'map', of })

/** A reference to a named model in the same contract. */
export const refOf = name => ({ kind: 'ref', name })

/** An enumeration: a named, closed set of wire values. */
export const enumOf = (name, values) => ({ kind: 'enum', name, values })

/** A discriminated union of named model variants: `Card | Cash`, told apart by `kind`. */
export const unionOf = (variants, discriminator) => ({
  kind: 'union',
  variants: variants.map(variant => ({ name: String(variant.name), tag: String(variant.tag ?? variant.name) })),
  discriminator: String(discriminator ?? ''),
})
export function enumConstant(value) {
  const cleaned = String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.length === 0 ? 'EMPTY' : /^[0-9]/.test(cleaned) ? `V_${cleaned}` : cleaned
}

/** Any JSON value. */
export const JSON_TYPE = scalar('json')

/** No body. */
export const VOID_TYPE = scalar('void')

const PYTHON_SCALARS = {
  str: 'string',
  string: 'string',
  int: 'int',
  integer: 'int',
  biginteger: 'int',
  smallinteger: 'int',
  float: 'double',
  bool: 'boolean',
  boolean: 'boolean',
  decimal: 'decimal',
  numeric: 'decimal',
  datetime: 'datetime',
  date: 'date',
  time: 'time',
  uuid: 'uuid',
  bytes: 'bytes',
  bytearray: 'bytes',
  largebinary: 'bytes',
  pickletype: 'bytes',
  dict: 'json',
  mapping: 'json',
  json: 'json',
  jsonb: 'json',
  any: 'any',
  object: 'any',
  text: 'string',
  unicode: 'string',
  enum: 'string',
  none: 'void',
  nonetype: 'void',
  void: 'void',
}

const JAVA_SCALARS = {
  string: 'string',
  char: 'string',
  character: 'string',
  int: 'int',
  integer: 'int',
  long: 'int',
  short: 'int',
  byte: 'int',
  biginteger: 'decimal',
  double: 'double',
  float: 'double',
  bigdecimal: 'decimal',
  boolean: 'boolean',
  instant: 'datetime',
  localdatetime: 'datetime',
  offsetdatetime: 'datetime',
  zoneddatetime: 'datetime',
  localdate: 'date',
  localtime: 'time',
  uuid: 'uuid',
  jsonnode: 'json',
  object: 'any',
  void: 'void',
  'byte[]': 'bytes',
}

/** Remove whitespace and module qualifiers from a type expression. */
function compact(text) {
  return String(text ?? '').replace(/\s+/g, '').trim()
}

/** Drop one layer of `X[...]` or `X<...>` when X is a known wrapper. */
function unwrap(text, wrappers) {
  const match = /^(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)<([\s\S]*)>$/.exec(text)
    ?? /^(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)\[([\s\S]*)\]$/.exec(text)
  if (!match) return undefined
  if (!wrappers.has(match[1].toLowerCase())) return undefined
  return { wrapper: match[1].toLowerCase(), inner: match[2] }
}

/** Split a comma list at bracket depth zero. */
function splitArgs(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '[' || ch === '<' || ch === '(') depth++
    else if (ch === ']' || ch === '>' || ch === ')') depth--
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1 }
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

const PYTHON_WRAPPERS = new Set([
  'list', 'sequence', 'iterable', 'set', 'frozenset', 'tuple', 'dict', 'mapping',
  'optional', 'mapped', 'annotated', 'list', 'type',
])

/** Last dotted or bracketed segment of a type expression. */
function lastSegment(text) {
  const tail = text.split(/[.|]/).pop() ?? text
  return tail.replace(/[<>[\]()]/g, '').toLowerCase()
}

/**
 * Map a Python annotation or SQLAlchemy column type onto the neutral type.
 *
 * @param raw the annotation text as written in the source.
 * @param modelNames names of contract models, so a reference stays a reference.
 */
export function fromPythonType(raw, modelNames = new Set()) {
  let text = compact(raw)
  if (text.length === 0) return { kind: 'scalar', name: 'any' }

  // Optional[X], Mapped[X], Annotated[X, ...] all collapse to X.
  for (let guard = 0; guard < 8; guard++) {
    const unwrapped = unwrap(text, PYTHON_WRAPPERS)
    if (unwrapped === undefined) break
    if (['list', 'sequence', 'iterable', 'set', 'frozenset', 'tuple'].includes(unwrapped.wrapper)) {
      const inner = splitArgs(unwrapped.inner)[0]
      if (inner === undefined) return listOf(scalar('any'))
      const item = fromPythonType(inner, modelNames)
      if (unwrapped.wrapper === 'tuple') return listOf(item)
      return listOf(item)
    }
    if (unwrapped.wrapper === 'dict' || unwrapped.wrapper === 'mapping') {
      const args = splitArgs(unwrapped.inner)
      return mapOf(args.length > 1 ? fromPythonType(args[1], modelNames) : scalar('json'))
    }
    // optional / mapped / annotated wrap a single value
    text = compact(unwrapped.inner)
  }
  // `X | None` unions collapse to X; a real multi-type union is unrepresentable.
  const union = text.split('|').filter(part => part.length > 0 && part.toLowerCase() !== 'none')
  if (union.length === 1) text = union[0]
  else if (union.length > 1) return { kind: 'scalar', name: 'any' }

  const lowered = text.toLowerCase()
  const direct = PYTHON_SCALARS[lowered]
  if (direct !== undefined) return { kind: 'scalar', name: direct }
  const tail = lastSegment(text)
  const tailed = PYTHON_SCALARS[tail]
  if (tailed !== undefined) return { kind: 'scalar', name: tailed }
  if (modelNames.has(text)) return refOf(text)
  const simple = text.split('.').pop() ?? text
  if (modelNames.has(simple)) return refOf(simple)
  return { kind: 'scalar', name: 'any' }
}

const JAVA_WRAPPERS = new Set([
  'list', 'set', 'collection', 'iterable', 'arraylist', 'linkedlist', 'hashset',
  'optional', 'responseentity', 'map', 'hashmap', 'linkedhashmap',
])

/**
 * Map a Java type onto the neutral type.
 *
 * @param raw the declared type as written in the source.
 * @param modelNames names of contract models.
 */
export function fromJavaType(raw, modelNames = new Set()) {
  const text = compact(raw)
  if (text.length === 0) return { kind: 'scalar', name: 'any' }
  if (JAVA_SCALARS[text.toLowerCase()] !== undefined) {
    return { kind: 'scalar', name: JAVA_SCALARS[text.toLowerCase()] }
  }

  for (let guard = 0; guard < 8; guard++) {
    const unwrapped = unwrap(text, JAVA_WRAPPERS)
    if (unwrapped === undefined) break
    const args = splitArgs(unwrapped.inner)
    if (unwrapped.wrapper === 'map' || unwrapped.wrapper === 'hashmap' || unwrapped.wrapper === 'linkedhashmap') {
      return mapOf(args.length > 1 ? fromJavaType(args[1], modelNames) : scalar('json'))
    }
    if (['list', 'set', 'collection', 'iterable', 'arraylist', 'linkedlist', 'hashset'].includes(unwrapped.wrapper)) {
      return listOf(args.length > 0 ? fromJavaType(args[0], modelNames) : scalar('any'))
    }
    text = compact(args.length > 0 ? args[0] : unwrapped.inner)
    const direct = JAVA_SCALARS[text.toLowerCase()]
    if (direct !== undefined) return { kind: 'scalar', name: direct }
  }

  if (/\[\s*\]$/.test(text)) return { kind: 'scalar', name: 'bytes' }
  const lowered = text.toLowerCase()
  if (JAVA_SCALARS[lowered] !== undefined) return { kind: 'scalar', name: JAVA_SCALARS[lowered] }
  if (modelNames.has(text)) return refOf(text)
  return { kind: 'scalar', name: 'any' }
}

/** Canonical scalar name of a neutral type, for comparison and rendering. */
export function describeType(type) {
  if (!type || typeof type !== 'object') return 'any'
  if (type.kind === 'scalar') {
    const name = SCALARS.has(type.name) ? type.name : 'any'
    // A recorded value set is part of the described type, so narrowing or widening it is
    // reported as a wire change instead of passing silently.
    return Array.isArray(type.values) && type.values.length > 0
      ? `${name}(${type.values.join('|')})`
      : name
  }
  if (type.kind === 'list') return `list<${describeType(type.of)}>`
  if (type.kind === 'map') return `map<${describeType(type.of)}>`
  if (type.kind === 'ref') return String(type.name)
  // The value set is part of the described type: widening or narrowing an enum is a wire
  // change, so diff reports it as one.
  if (type.kind === 'enum') {
    const values = Array.isArray(type.values) ? type.values : []
    return `${String(type.name)}(${values.join('|')})`
  }
  if (type.kind === 'union') {
    const variants = Array.isArray(type.variants) ? type.variants : []
    return variants.map(variant => String(variant.name)).join(' | ')
  }
  return 'any'
}

/** Whether two neutral types describe the same wire value. */
export function typeEquals(left, right) {
  return describeType(normalizeType(left)) === describeType(normalizeType(right))
}

/** Coerce a loosely-shaped type object into a valid neutral type. */
export function normalizeType(type) {
  if (type === undefined || type === null || typeof type !== 'object') return scalar('any')
  switch (type.kind) {
    case 'scalar': {
      const base = scalar(SCALARS.has(type.name) ? type.name : 'any')
      const values = Array.isArray(type.values) ? type.values.map(String) : []
      return values.length === 0 ? base : { ...base, values }
    }
    case 'list': return listOf(normalizeType(type.of))
    case 'map': return mapOf(normalizeType(type.of))
    case 'ref': return refOf(String(type.name ?? 'Unknown'))
    case 'enum': return enumOf(String(type.name ?? 'Unknown'), (Array.isArray(type.values) ? type.values : []).map(String))
    case 'union': return unionOf(
      Array.isArray(type.variants) ? type.variants : [],
      type.discriminator)
    default: return scalar('any')
  }
}

/** Build a contract object with the canonical field order. */
/**
 * Canonicalise one authentication scheme.
 *
 * Only schemes a generated client can actually apply are kept: `http` bearer/basic, an `apiKey`
 * in a header or query parameter, and `oauth2`/`openIdConnect` (treated as a bearer token, because
 * what a client does with them is send a token). Anything else returns undefined so the caller can
 * warn rather than emit a client that silently sends no credential.
 *
 * @param input `{name, type, scheme?, in?, paramName?, description?}` from an extractor
 * @returns `{name, type, scheme?, in?, param?, description?}` or undefined
 */
export function normalizeSecurityScheme(input) {
  if (input === null || input === undefined) return undefined
  const name = String(input.name ?? '').trim()
  if (name.length === 0) return undefined
  const type = String(input.type ?? '').toLowerCase()
  const description = input.description === undefined ? undefined : String(input.description)
  const withDescription = description === undefined ? {} : { description }
  if (type === 'http') {
    const scheme = String(input.scheme ?? '').toLowerCase()
    if (scheme !== 'bearer' && scheme !== 'basic') return undefined
    return { name, type: 'http', scheme, param: 'Authorization', ...withDescription }
  }
  if (type === 'apikey') {
    const where = String(input.in ?? '').toLowerCase()
    if (where !== 'header' && where !== 'query') return undefined
    const param = String(input.paramName ?? input.param ?? input.headerName ?? '').trim()
    if (param.length === 0) return undefined
    return { name, type: 'apiKey', in: where, param, ...withDescription }
  }
  if (type === 'oauth2' || type === 'openidconnect') {
    // What a client does with an OAuth2 or OIDC scheme is send a bearer token; the flow details
    // belong to the token issuer, not to the caller generated from this contract.
    return { name, type: 'oauth2', param: 'Authorization', ...withDescription }
  }
  return undefined
}

/** `Authorization: bearer` vs `X-Api-Key` — enough to tell two schemes apart in a report. */
export function describeSecurityScheme(scheme) {
  if (scheme === undefined) return 'none'
  if (scheme.type === 'http') return `http ${scheme.scheme} (${scheme.param})`
  if (scheme.type === 'apiKey') return `apiKey ${scheme.in} ${scheme.param}`
  if (scheme.type === 'oauth2') return `oauth2 (${scheme.param})`
  return scheme.type
}

export function makeContract(input) {
  const operations = (input.operations ?? []).map((operation, index) => ({
    id: operation.id ?? `operation${index + 1}`,
    method: String(operation.method ?? 'GET').toUpperCase(),
    path: String(operation.path ?? '/'),
    summary: operation.summary ?? '',
    params: (operation.params ?? []).map(param => ({
      in: param.in ?? 'query',
      name: String(param.name ?? 'arg'),
      type: normalizeType(param.type),
      required: param.required !== false,
      ...(param.nullable === true ? { nullable: true } : {}),
      ...(param.default === undefined ? {} : { default: String(param.default) }),
    })),
    ...(operation.requestBody === undefined ? {} : { requestBody: normalizeType(operation.requestBody) }),
    // How the request body is encoded: JSON by default, multipart when the operation uploads parts.
    ...(operation.requestContentType === undefined ? {} : { requestContentType: String(operation.requestContentType) }),
    responses: (operation.responses ?? []).map(response => ({
      status: Number(response.status ?? 200),
      type: normalizeType(response.type ?? VOID_TYPE),
    })),
    ...(operation.streaming === true ? { streaming: true } : {}),
    // Success and failure bodies are different contracts: a generated client must be able to
    // map a 4xx/422 body to its own exception instead of pretending every response is the
    // happy path. Errors are derived from `responses`, so extractors need no change.
    errors: (operation.errors ?? operation.responses ?? [])
      .filter(response => Number(response?.status ?? 0) >= 400)
      .map(response => ({
        status: Number(response.status),
        type: normalizeType(response.type ?? JSON_TYPE),
      })),
    // undefined means "inherit the contract default"; [] means "explicitly unauthenticated".
    ...(operation.security === undefined
      ? {}
      : { security: Array.from(new Set((operation.security ?? []).map(String))) }),
    source: operation.source ?? { file: '', line: 0 },
  }))
  return {
    version: IR_VERSION,
    kind: String(input.kind ?? 'unknown'),
    name: String(input.name ?? 'service'),
    baseUrl: String(input.baseUrl ?? ''),
    generatedBy: String(input.generatedBy ?? 'polyglot-bridge'),
    source: {
      root: String(input.source?.root ?? ''),
      files: Number(input.source?.files ?? 0),
    },
    operations,
    // Name of the model that plays the role of a shared error envelope (RFC 7807 or a local
    // equivalent), when one was recognised. Generators use it to type a generic failure.
    ...(input.problemDetails === undefined ? {} : { problemDetails: String(input.problemDetails) }),
    // Named authentication schemes, in the order the source declared them, plus the contract-wide
    // requirement list. An operation without its own `security` inherits `security` here.
    security: (input.security ?? [])
      .map(normalizeSecurityScheme)
      .filter(scheme => scheme !== undefined),
    ...(input.securityDefault === undefined
      ? {}
      : { securityDefault: Array.from(new Set((input.securityDefault ?? []).map(String))) }),
    models: (input.models ?? []).map(model => ({
      name: String(model.name),
      origin: model.origin ?? 'table',
      ...(model.kind === undefined ? {} : { kind: String(model.kind) }),
      ...(model.values === undefined ? {} : { values: model.values.map(String) }),
      ...(model.discriminator === undefined ? {} : { discriminator: String(model.discriminator) }),
      ...(model.variants === undefined
        ? {}
        : { variants: model.variants.map(variant => ({ name: String(variant.name), tag: String(variant.tag ?? variant.name) })) }),
      ...(model.table === undefined ? {} : { table: String(model.table) }),
      fields: (model.fields ?? []).map(field => ({
        name: String(field.name),
        type: normalizeType(field.type),
        required: field.required !== false,
        ...(field.nullable === true ? { nullable: true } : {}),
        ...(field.note === undefined ? {} : { note: String(field.note) }),
      })),
    })),
    warnings: (input.warnings ?? []).map(warning => ({
      file: String(warning.file ?? ''),
      ...(warning.line === undefined ? {} : { line: Number(warning.line) }),
      message: String(warning.message ?? ''),
    })),
  }
}

/** Assert that an unknown value looks like a bridge contract. */
export function assertContract(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('contract must be a JSON object')
  }
  if (value.version === undefined) throw new Error('contract.version is missing')
  if (Number(value.version) !== IR_VERSION) {
    throw new Error(`unsupported contract version ${JSON.stringify(value.version)}; this build writes and reads version ${IR_VERSION}`)
  }
  if (!Array.isArray(value.operations)) throw new Error('contract.operations must be an array')
  if (!Array.isArray(value.models)) throw new Error('contract.models must be an array')
  return value
}

/** Stable identity of one operation across languages. */
export function operationKey(operation) {
  return `${operation.method} ${operation.path}`
}

/** Stable identity of one parameter inside an operation. */
export function paramKey(param) {
  return `${param.in}:${param.name}`
}

/**
 * Compatibility class of one reported difference.
 *
 * `breaking` breaks an existing caller, `additive` only adds surface, `cosmetic` changes
 * documentation or defaults. Callers use this to gate a deployment instead of eyeballing a
 * diff: a breaking change needs a coordinated release on both sides.
 */
export function severityOf(detail) {
  const text = String(detail)
  if (/^(param|field) removed|^(param|field) type|^request body|^response types|^response statuses/.test(text)) {
    return 'breaking'
  }
  if (/^(param|field) required/.test(text)) {
  return /false\s*(?:->|\u2192)\s*true/.test(text) ? 'breaking' : 'additive'
  }
  if (/^(param|field) added/.test(text)) {
    // A newly required parameter breaks existing callers; an optional one does not.
    return /\(required\)/.test(text) ? 'breaking' : 'additive'
  }
  if (/^request encoding:/.test(text)) return 'breaking'
  if (/^union variant (removed|tag)|^union discriminator/.test(text)) return 'breaking'
  if (/^union variant added/.test(text)) return 'additive'
  // Authentication is part of the call contract: a caller that does not send a credential breaks,
  // and so does a caller that sends one to a route that no longer wants it.
  if (/^security required:/.test(text)) return 'breaking'
  if (/^security scheme changed/.test(text)) return 'breaking'
  if (/^security scheme (added|removed)/.test(text)) return 'additive'
  // A nullable change is a shape change in both directions: readers that assumed non-null break,
  // and writers that assumed null break when it goes away.
  if (/^(param|field) nullable:/.test(text)) return 'breaking'
  if (/^param default|^summary/.test(text)) return 'cosmetic'
  return 'cosmetic'
}

/** Count details by severity for one set of change entries. */
export function severitySummary(entries) {
  const summary = { breaking: 0, additive: 0, cosmetic: 0 }
  for (const entry of entries) {
    for (const detail of entry.details) summary[severityOf(detail)]++
  }
  return summary
}

/** Compare two contracts and list every interface difference. */
export function diffContracts(left, right) {
  const leftOps = new Map(left.operations.map(operation => [operationKey(operation), operation]))
  const rightOps = new Map(right.operations.map(operation => [operationKey(operation), operation]))
  const onlyInA = []
  const onlyInB = []
  const changed = []

  for (const [key, operation] of leftOps) {
    if (!rightOps.has(key)) onlyInA.push({ key, summary: operation.summary })
  }
  for (const [key, operation] of rightOps) {
    if (!leftOps.has(key)) onlyInB.push({ key, summary: operation.summary })
  }

  for (const [key, a] of leftOps) {
    const b = rightOps.get(key)
    if (b === undefined) continue
    const details = []
    if (a.summary !== b.summary && (a.summary.length > 0 || b.summary.length > 0)) {
      details.push(`summary: "${a.summary}" -> "${b.summary}"`)
    }
    const aParams = new Map(a.params.map(param => [paramKey(param), param]))
    const bParams = new Map(b.params.map(param => [paramKey(param), param]))
    for (const [paramName, param] of aParams) {
      const other = bParams.get(paramName)
      if (other === undefined) {
        details.push(`param removed: ${paramName}`)
        continue
      }
      if (!typeEquals(param.type, other.type)) {
        details.push(`param type: ${paramName} ${describeType(param.type)} -> ${describeType(other.type)}`)
      }
      if (param.required !== other.required) {
        details.push(`param required: ${paramName} ${param.required} -> ${other.required}`)
      }
      if ((param.nullable === true) !== (other.nullable === true)) {
        details.push(`param nullable: ${paramName} ${param.nullable === true} -> ${other.nullable === true}`)
      }
      if (param.default !== other.default) {
        details.push(`param default: ${paramName} ${JSON.stringify(param.default)} -> ${JSON.stringify(other.default)}`)
      }
    }
    for (const paramName of bParams.keys()) {
      if (!aParams.has(paramName)) details.push(`param added: ${paramName}${bParams.get(paramName)?.required ? ' (required)' : ''}`)
    }
    const aBody = a.requestBody === undefined ? 'none' : describeType(a.requestBody)
    const aEncoding = a.requestContentType ?? 'application/json'
    const bEncoding = b.requestContentType ?? 'application/json'
    if (aEncoding !== bEncoding) {
      details.push(`request encoding: ${aEncoding} -> ${bEncoding}`)
    }
    const bBody = b.requestBody === undefined ? 'none' : describeType(b.requestBody)
    if (aBody !== bBody) details.push(`request body: ${aBody} -> ${bBody}`)
    const aStatuses = a.responses.map(response => response.status).sort().join(',')
    const bStatuses = b.responses.map(response => response.status).sort().join(',')
    if (aStatuses !== bStatuses) details.push(`response statuses: [${aStatuses}] -> [${bStatuses}]`)
    const aTypes = a.responses.map(response => `${response.status}:${describeType(response.type)}`).sort().join(',')
    const bTypes = b.responses.map(response => `${response.status}:${describeType(response.type)}`).sort().join(',')
    if (aTypes !== bTypes) details.push(`response types: {${aTypes}} -> {${bTypes}}`)
    // Effective requirement: an operation's own list, else the contract default.
    const aSecurity = [...(a.security ?? left.securityDefault ?? [])].sort().join(',')
    const bSecurity = [...(b.security ?? right.securityDefault ?? [])].sort().join(',')
    if (aSecurity !== bSecurity) {
      details.push(`security required: ${aSecurity === '' ? 'none' : aSecurity} -> ${bSecurity === '' ? 'none' : bSecurity}`)
    }
  if (details.length > 0) changed.push({ key, details })
  }

  const leftModels = new Map(left.models.map(model => [model.name, model]))
  const rightModels = new Map(right.models.map(model => [model.name, model]))
  const modelOnlyInA = [...leftModels.keys()].filter(name => !rightModels.has(name))
  const modelOnlyInB = [...rightModels.keys()].filter(name => !leftModels.has(name))
  const modelChanged = []
  for (const [name, a] of leftModels) {
    const b = rightModels.get(name)
    if (b === undefined) continue
    const details = []
    const aFields = new Map(a.fields.map(field => [field.name, field]))
    const bFields = new Map(b.fields.map(field => [field.name, field]))
    for (const [fieldName, field] of aFields) {
      const other = bFields.get(fieldName)
      if (other === undefined) { details.push(`field removed: ${fieldName}`); continue }
      if (!typeEquals(field.type, other.type)) {
        details.push(`field type: ${fieldName} ${describeType(field.type)} -> ${describeType(other.type)}`)
      }
      if (field.required !== other.required) {
        details.push(`field required: ${fieldName} ${field.required} -> ${other.required}`)
      }
      if ((field.nullable === true) !== (other.nullable === true)) {
        details.push(`field nullable: ${fieldName} ${field.nullable === true} -> ${other.nullable === true}`)
      }
    }
    for (const fieldName of bFields.keys()) {
      if (!aFields.has(fieldName)) details.push(`field added: ${fieldName}${bFields.get(fieldName)?.required ? ' (required)' : ''}`)
    }
    if (details.length > 0) modelChanged.push({ name, details })
  }

  // Unions carry variants instead of fields, so they are compared separately.
  for (const [name, a] of leftModels) {
    const b = rightModels.get(name)
    if (b === undefined || a.kind !== 'union' || b.kind !== 'union') continue
    const details = []
    const aVariants = new Map((a.variants ?? []).map(variant => [variant.name, variant]))
    const bVariants = new Map((b.variants ?? []).map(variant => [variant.name, variant]))
    for (const [variantName, variant] of aVariants) {
      const other = bVariants.get(variantName)
      if (other === undefined) { details.push(`union variant removed: ${variantName}`); continue }
      if (variant.tag !== other.tag) {
        details.push(`union variant tag: ${variantName} ${variant.tag} -> ${other.tag}`)
      }
    }
    for (const variantName of bVariants.keys()) {
      if (!aVariants.has(variantName)) details.push(`union variant added: ${variantName}`)
    }
    if ((a.discriminator ?? '') !== (b.discriminator ?? '')) {
      details.push(`union discriminator: ${a.discriminator} -> ${b.discriminator}`)
    }
    if (details.length > 0) modelChanged.push({ name, details })
  }

  // Authentication schemes are compared by definition, since two contracts can both require
  // "bearerAuth" while sending it under different header names.
  const leftSecurity = new Map((left.security ?? []).map(scheme => [scheme.name, scheme]))
  const rightSecurity = new Map((right.security ?? []).map(scheme => [scheme.name, scheme]))
  const securityOnlyInA = [...leftSecurity.keys()].filter(name => !rightSecurity.has(name))
  const securityOnlyInB = [...rightSecurity.keys()].filter(name => !leftSecurity.has(name))
  const securityChanged = []
  for (const [name, a] of leftSecurity) {
    const b = rightSecurity.get(name)
    if (b === undefined) continue
    const details = []
    if (describeSecurityScheme(a) !== describeSecurityScheme(b)) {
      details.push(`security scheme changed: ${name} ${describeSecurityScheme(a)} -> ${describeSecurityScheme(b)}`)
    }
    if ((a.description ?? '') !== (b.description ?? '')) {
      details.push(`security scheme description: ${name}`)
    }
    if (details.length > 0) securityChanged.push({ name, details })
  }
  for (const name of securityOnlyInA) {
    // A definition that disappears is only a problem if a route still asks for it; the route-level
    // `security required` diff catches that case separately.
    securityChanged.push({ name, details: [`security scheme removed: ${name}`] })
  }
  for (const name of securityOnlyInB) {
    securityChanged.push({ name, details: [`security scheme added: ${name}`] })
  }
  const securityOnlyInAFiltered = []
  const securityOnlyInBFiltered = []

  const total = onlyInA.length + onlyInB.length + changed.length + modelOnlyInA.length
    + modelOnlyInB.length + modelChanged.length + securityChanged.length
  return {
    status: total === 0 ? 'in-sync' : 'drift',
    summary: {
      onlyInA: onlyInA.length,
      onlyInB: onlyInB.length,
      changed: changed.length,
      modelsOnlyInA: modelOnlyInA.length,
      modelsOnlyInB: modelOnlyInB.length,
      modelsChanged: modelChanged.length,
      securityChanged: securityChanged.length,
    },
    onlyInA,
    onlyInB,
    changed,
    models: {
      onlyInA: modelOnlyInA,
      onlyInB: modelOnlyInB,
      changed: modelChanged,
    },
    security: {
      onlyInA: securityOnlyInAFiltered,
      onlyInB: securityOnlyInBFiltered,
      changed: securityChanged,
    },
  }
}
