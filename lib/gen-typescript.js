/**
 * TypeScript client generator.
 *
 * Follows docs/ADDING-A-LANGUAGE.md: one file set, explicit wire mapping, notes for anything
 * degraded. TypeScript was picked first because a discriminated union is native here, so the
 * contract's union model maps one-to-one instead of being approximated.
 *
 * @module polyglot-bridge/gen-typescript
 */

import { VOID_TYPE } from './ir.js'
import { toCamel, toPascal } from './naming.js'

/** Contract spelling of a value, translated to a TypeScript expression. */
function tsType(type) {
  if (type === undefined) return 'unknown'
  switch (type.kind) {
    case 'list': return `${tsType(type.of)}[]`
    case 'map': return `Record<string, ${tsType(type.of)}>`
    case 'ref': return toPascal(type.name)
    case 'enum': return (type.values ?? []).map(value => JSON.stringify(value)).join(' | ') || 'string'
    case 'union':
      return (type.variants ?? []).map(variant => toPascal(variant.name)).join(' | ') || 'unknown'
    default: break
  }
  switch (type.name) {
    case 'string': return 'string'
    case 'int':
    case 'double': return 'number'
    case 'decimal': return 'number'
    case 'boolean': return 'boolean'
    case 'datetime':
    case 'date':
    case 'time':
    case 'uuid':
    case 'bytes': return 'ArrayBuffer'
    case 'void': return 'void'
    default: return 'unknown'
  }
}

/** Query string entries for one operation, skipping absent optional values. */
function queryLines(operation) {
  return operation.params
    .filter(param => param.in === 'query')
    .map(param => `    if (params.${toCamel(param.name)} !== undefined) url.searchParams.set(${JSON.stringify(param.name)}, String(params.${toCamel(param.name)}))`)
}

/** Expression for a route's required schemes, resolved at call time from the emitted table. */
function securityExpression(operation) {
  return `REQUIRED_SECURITY[${JSON.stringify(operation.id)}] ?? []`
}

/** The fields of a multipart request body, resolved from the synthetic parts model. */
function multipartParts(partsOfRequest) {
  return partsOfRequest ?? []
}

/** One client method per operation. */
function emitMethod(operation, partsOfRequest) {
  const name = toCamel(operation.id ?? operation.method.toLowerCase())
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, raw) => '${encodeURIComponent(String(' + toCamel(raw) + '))}')
  const lines = []
  const doc = String(operation.summary ?? '').trim()
  if (doc.length > 0) lines.push(`  /** ${doc.replace(/\*\//g, '* /')} */`)

  const signature = []
  for (const param of operation.params) {
    if (param.in === 'path') signature.push(`${toCamel(param.name)}: ${tsType(param.type)}`)
  }
  const query = operation.params.filter(param => param.in === 'query')
  if (query.length > 0) {
    const fields = query.map(param => `    ${toCamel(param.name)}?: ${tsType(param.type)}`)
    signature.push(`params: {\n${fields.join('\n')}\n  } = {}`)
  }
  for (const param of operation.params.filter(entry => entry.in === 'header')) {
    signature.push(`${toCamel(param.name)}${param.required ? '' : '?'}: ${tsType(param.type)}`)
  }
  if (operation.requestBody !== undefined) signature.push(`body: ${tsType(operation.requestBody)}`)

  lines.push(`  async ${name}(${signature.join(', ')}): Promise<${tsType(operation.responses[0]?.type ?? VOID_TYPE)}> {`)
  lines.push(`    const url = new URL(\`\${this.baseUrl}${path}\`)`)
  lines.push(...queryLines(operation))
  lines.push(`    const headers = this.applyAuth(${securityExpression(operation)}, url)`)
  for (const param of operation.params.filter(entry => entry.in === 'header')) {
    // Header parameters are part of the call: a missing one is a wrong request, not a default.
    lines.push(`    if (${toCamel(param.name)} !== undefined) headers[${JSON.stringify(param.name)}] = String(${toCamel(param.name)})`)
  }
  const multipart = operation.requestContentType === 'multipart/form-data'
  const parts = multipart ? multipartParts(partsOfRequest) : []
  if (multipart) lines.push('    const form = new FormData()')
  for (const part of parts) {
    // An ArrayBuffer part is a file; anything else is a text field.
    lines.push(`    if (body.${toCamel(part.name)} !== undefined && body.${toCamel(part.name)} !== null) {`)
    lines.push(`      const value${part.name} = body.${toCamel(part.name)} as unknown`)
    lines.push(`      form.append(${JSON.stringify(part.name)}, value${part.name} instanceof ArrayBuffer ? new Blob([value${part.name}]) : String(value${part.name}))`)
    lines.push('    }')
  }
  lines.push('    const response = await this.fetchImpl(url, {')
  lines.push(`      method: ${JSON.stringify(operation.method)},`)
  lines.push('      headers,')
  if (multipart) {
    // The browser sets the multipart boundary itself; setting the header would break the body.
    lines.push('      body: form,')
    lines.push('    })')
  } else if (operation.requestBody !== undefined) {
    lines.push('      body: JSON.stringify(body),')
    lines.push('    })')
    // The merged header object has to carry the content type; applyAuth only adds credentials.
    lines.push('    headers["content-type"] = "application/json"')
  } else {
    lines.push('    })')
  }
  const resultType = operation.responses[0]?.type
  const isBytes = resultType?.kind === 'scalar' && resultType.name === 'bytes'
  if (isBytes) {
    // The request was already emitted above; only the response handling differs, because a binary
    // body must not be decoded as text.
    lines.push('    if (!response.ok) {')
    lines.push('      throw new BridgeHttpError(response.status, await response.text())')
    lines.push('    }')
    lines.push('    return (await response.arrayBuffer()) as never')
    lines.push('  }')
    return lines.join('\n')
  }
  lines.push('    const text = await response.text()')
  lines.push('    if (!response.ok) {')
  lines.push('      throw new BridgeHttpError(response.status, text)')
  lines.push('    }')
  lines.push('    return text.length === 0 ? (undefined as never) : (JSON.parse(text) as never)')
  lines.push('  }')
  return lines.join('\n')
}

/**
 * One streaming method per operation marked `streaming`.
 *
 * `ReadableStream` is used rather than `EventSource`: the latter only speaks GET, cannot send a
 * request body, and hides the HTTP status. Consume as `for await (const chunk of ...)`.
 */
function emitStreamMethod(operation) {
  const name = toCamel(operation.id ?? operation.method.toLowerCase())
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, raw) => '${encodeURIComponent(String(' + toCamel(raw) + '))}')
  const lines = []
  const doc = String(operation.summary ?? '').trim()
  lines.push(`  /** ${doc.length > 0 ? doc.replace(/\*\//g, '* /') : 'Server-sent event stream.'} */`)

  const signature = []
  for (const param of operation.params) {
    if (param.in === 'path') signature.push(`${toCamel(param.name)}: ${tsType(param.type)}`)
  }
  const query = operation.params.filter(param => param.in === 'query')
  if (query.length > 0) {
    const fields = query.map(param => `    ${toCamel(param.name)}?: ${tsType(param.type)}`)
    signature.push(`params: {\n${fields.join('\n')}\n  } = {}`)
  }

  for (const param of operation.params.filter(entry => entry.in === 'header')) {
    signature.push(`${toCamel(param.name)}${param.required ? '' : '?'}: ${tsType(param.type)}`)
  }

  lines.push(`  async *${name}(${signature.join(', ')}): AsyncGenerator<string, void, unknown> {`)
  lines.push(`    const url = new URL(\`\${this.baseUrl}${path}\`)`)
  lines.push(...queryLines(operation))
  lines.push(`    const headers = this.applyAuth(${securityExpression(operation)}, url)`)
  for (const param of operation.params.filter(entry => entry.in === 'header')) {
    lines.push(`    if (${toCamel(param.name)} !== undefined) headers[${JSON.stringify(param.name)}] = String(${toCamel(param.name)})`)
  }
  lines.push('    const response = await this.fetchImpl(url, { method: ' + JSON.stringify(operation.method) + ', headers })')
  lines.push('    if (!response.ok) {')
  lines.push('      throw new BridgeHttpError(response.status, await response.text())')
  lines.push('    }')
  lines.push('    if (response.body === null) return')
  lines.push('    const reader = response.body.getReader()')
  lines.push('    const decoder = new TextDecoder()')
  // Server-sent events are framed: collect `data:` lines and yield the payload when a blank line
  // ends the event, so callers do not each re-implement the protocol.
  lines.push('    let buffer = ""')
  lines.push('    let pending: string[] = []')
  lines.push('    for (;;) {')
  lines.push('      const { done, value } = await reader.read()')
  lines.push('      if (done) {')
  lines.push('        if (pending.length > 0) yield pending.join("\\n")')
  lines.push('        return')
  lines.push('      }')
  lines.push('      if (value === undefined) continue')
  lines.push('      buffer += decoder.decode(value, { stream: true })')
  lines.push('      let index = buffer.indexOf("\\n")')
  lines.push('      while (index >= 0) {')
  lines.push('        const line = buffer.slice(0, index).replace(/\\r$/, "")')
  lines.push('        buffer = buffer.slice(index + 1)')
  lines.push('        if (line.length === 0) {')
  lines.push('          if (pending.length > 0) {')
  lines.push('            yield pending.join("\\n")')
  lines.push('            pending = []')
  lines.push('          }')
  lines.push('        } else if (!line.startsWith(":") && line.startsWith("data:")) {')
  lines.push('          pending.push(line.slice(5).trimStart())')
  lines.push('        }')
  lines.push('        index = buffer.indexOf("\\n")')
  lines.push('      }')
  lines.push('    }')
  lines.push('  }')
  return lines.join('\n')
}

/** Model declarations: interfaces for records, literal unions for enums, unions for variants. */
function emitModels(contract, notes) {
  const blocks = []
  for (const model of contract.models ?? []) {
    const name = toPascal(model.name)
    if (model.kind === 'enum') {
      const values = (model.values ?? []).map(value => JSON.stringify(value)).join(' | ')
      blocks.push(`/** Wire enum \`${model.name}\`. */\nexport type ${name} = ${values || 'string'}`)
      continue
    }
    if (model.kind === 'union') {
      const variants = (model.variants ?? []).map(variant => toPascal(variant.name)).join(' | ')
      blocks.push(`/** Discriminated union on \`${model.discriminator}\`. */\nexport type ${name} = ${variants || 'unknown'}`)
      continue
    }
    const fields = model.fields.map(field => {
      const optional = field.required ? '' : '?'
      // `nullable` is the value being null; `?` is the key being absent. They are different
      // promises, so an optional nullable field needs both.
      const nullable = field.nullable === true ? ' | null' : ''
      return `  ${toCamel(field.name)}${optional}: ${tsType(field.type)}${nullable}`
    })
    blocks.push(`export interface ${name} {\n${fields.join('\n')}\n}`)
    if (model.fields.some(field => field.type?.kind === 'union')) {
      notes.push(`model \`${model.name}\` accepts a union field; discriminate it with the property the contract names`)
    }
  }
  return blocks.join('\n\n')
}

/** Status to decoder map, for operations that declare a model error body. */
function emitErrorTypes(contract) {
  const entries = []
  for (const operation of contract.operations ?? []) {
    for (const error of operation.errors ?? []) {
      if (error.type?.kind !== 'ref') continue
      if (!entries.some(entry => entry.status === error.status)) {
        entries.push({ status: error.status, name: toPascal(error.type.name) })
      }
    }
  }
  if (entries.length === 0) return ''
  const map = entries.map(entry => `  ${entry.status}: (data: unknown) => data as ${entry.name},`).join('\n')
  return `

const ERROR_TYPES: Record<number, (data: unknown) => unknown> = {
${map}
}

/** Decode an error body into the type the contract declares for that status, if any. */
export function decodeError(error: BridgeHttpError): unknown {
  const decoder = ERROR_TYPES[error.status]
  if (decoder === undefined || error.body.length === 0) return undefined
  try {
    return decoder(JSON.parse(error.body))
  } catch {
    return undefined
  }
}`
}

/** Route table for the generated README. */
function renderReadme(contract, className) {
  const rows = (contract.operations ?? []).map(operation => {
    const summary = String(operation.summary ?? '').trim()
    return `| ${operation.method} | \`${operation.path}\` | \`${toCamel(operation.id)}\` | ${summary.length > 0 ? summary : '—'} |`
  })
  return `# TypeScript client for \`${contract.name}\`

Generated from a \`${contract.kind}\` bridge contract: ${(contract.operations ?? []).length} route(s),
${(contract.models ?? []).length} model(s). Uses \`fetch\` and the DOM \`URL\`; no runtime dependency.

## Usage

\`\`\`ts
import { ${className} } from "./client"

const client = new ${className}("${contract.baseUrl || 'http://localhost:8080'}")
const result = await client.${(contract.operations ?? [])[0] ? toCamel((contract.operations ?? [])[0].id) : 'call'}(...)
\`\`\`

## Routes

| Method | Path | Operation | Summary |
| --- | --- | --- | --- |
${rows.join('\n')}

## Wire behaviour

- Non-2xx responses throw \`BridgeHttpError\` (\`.status\`, \`.body\`).
- \`decimal\` maps to \`number\`: JavaScript has no decimal type, so very large or high-precision
  values lose precision. If that matters, change the field to a string in the service contract.
- \`datetime\`, \`date\`, \`time\`, \`uuid\` and \`bytes\` map to \`string\`; parse them at the call site.
`
}

/** Generate the TypeScript client file set. */
/** Declared schemes and route requirements, emitted as data the client looks up at call time. */
function securityTables(contract) {
  const schemes = contract.security ?? []
  // The tables are always emitted: `applyAuth` and the per-route calls reference them, and a
  // contract without authentication simply gets empty ones.
  const table = Object.fromEntries(schemes.map(scheme => [scheme.name, {
    type: scheme.type,
    ...(scheme.scheme === undefined ? {} : { scheme: scheme.scheme }),
    ...(scheme.in === undefined ? {} : { in: scheme.in }),
    param: scheme.param ?? 'Authorization',
  }]))
  const required = Object.fromEntries((contract.operations ?? [])
    .map(operation => [operation.id, operation.security ?? contract.securityDefault ?? []])
    .filter(([, names]) => names.length > 0))
  return `/** Where each declared credential goes on the wire. */
const SECURITY: Record<string, { type: string; scheme?: string; in?: string; param: string }> = ${JSON.stringify(table, null, 2)}

/** Route id -> required schemes; a route absent here needs no credential. */
const REQUIRED_SECURITY: Record<string, readonly string[]> = ${JSON.stringify(required, null, 2)}

`
}

/** One iterator per paginated operation: it walks every page and yields the items. */
function renderPaginationTs(contract) {
  const blocks = []
  for (const operation of contract.operations ?? []) {
    const pagination = operation.pagination
    if (pagination === undefined) continue
    const envelope = (contract.models ?? []).find(model => model.name === operation.responses?.[0]?.type?.name)
    const listField = (envelope?.fields ?? []).find(field => field.name === pagination.itemsField)
    const itemType = listField?.type?.of?.kind === 'ref' ? toPascal(listField.type.of.name) : 'unknown'
    const name = `iter${toPascal(operation.id)}`
    const sizeParam = pagination.sizeParam ?? 'limit'
    const forwards = (operation.params ?? [])
      .filter(param => param.in === 'query' && ![pagination.pageParam, pagination.cursorParam, pagination.sizeParam].includes(param.name))
      .map(param => `${toCamel(param.name)}: ${tsType(param.type)}`)
    const paramsArg = forwards.length === 0 ? '' : `params: { ${forwards.join('; ')} }, `
    const forwardObject = forwards.length === 0 ? '' : '...params, '
    if (pagination.style === 'cursor') {
      blocks.push(`
  /** Walks every page of \`${operation.method} ${operation.path}\`, yielding the items. */
  async *${name}(${paramsArg}pageSize = 100): AsyncGenerator<${itemType}, void, unknown> {
    let cursor: string | undefined
    for (;;) {
      const result = await this.${toCamel(operation.id)}({ ${forwardObject}${toCamel(pagination.cursorParam)}: cursor, ${toCamel(sizeParam)}: pageSize })
      const items = result?.${toCamel(pagination.itemsField)} ?? []
      for (const item of items) yield item
      cursor = result?.${toCamel(pagination.nextField ?? 'next_cursor')} ?? undefined
      if (!cursor) return
    }
  }`)
    } else {
      blocks.push(`
  /** Walks every page of \`${operation.method} ${operation.path}\`, yielding the items. */
  async *${name}(${paramsArg}pageSize = 100): AsyncGenerator<${itemType}, void, unknown> {
    let page = 1
    for (;;) {
      const result = await this.${toCamel(operation.id)}({ ${forwardObject}${toCamel(pagination.pageParam)}: page, ${toCamel(sizeParam)}: pageSize })
      const items = result?.${toCamel(pagination.itemsField)} ?? []
      for (const item of items) yield item
      if (items.length < pageSize) return
      page += 1
    }
  }`)
    }
  }
  return blocks.join('\n')
}

export function generateTypeScriptClient(contract, options = {}) {
  const service = options.serviceName ?? contract.name ?? 'service'
  const className = `${toPascal(service)}Client`
  const baseUrl = options.baseUrl ?? contract.baseUrl ?? ''
  const notes = []

  const models = emitModels(contract, notes)
  const methods = (contract.operations ?? [])
    .map(operation => {
      const partsOfRequest = operation.requestBody?.kind === 'ref'
        ? (contract.models ?? []).find(model => model.name === operation.requestBody.name)?.fields ?? []
        : []
      return operation.streaming === true ? emitStreamMethod(operation) : emitMethod(operation, partsOfRequest)
    })
    .join('\n\n')
  const pagination = renderPaginationTs(contract)
  const modelNames = (contract.models ?? []).map(model => toPascal(model.name))
  const modelImport = modelNames.length > 0
    ? `import type { ${modelNames.join(', ')} } from "./models"\n\n`
    : ''

  const client = `/**
 * Generated HTTP client for the \`${contract.kind}\` service \`${contract.name}\`.
 *
 * Do not edit: regenerate from the bridge contract instead.
 */
${modelImport}export class BridgeHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(\`HTTP \${status}\`)
    this.name = "BridgeHttpError"
  }
}

${securityTables(contract)}export class ${className} {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** One entry per declared scheme, e.g. \`{ bearerAuth: "…" }\`. A required scheme that is
     *  missing throws before the request is sent. */
    private readonly auth: Readonly<Record<string, string>> = {},
  ) {}

  private applyAuth(schemes: readonly string[], url: URL): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const name of schemes) {
      const scheme = SECURITY[name]
      if (scheme === undefined) continue
      const value = this.auth[name]
      if (value === undefined) {
        throw new Error(\`route requires authentication scheme "\${name}"; pass it to the constructor\`)
      }
      if (scheme.type === "apiKey" && scheme.in === "query") url.searchParams.set(scheme.param, value)
      else if (scheme.type === "apiKey") headers[scheme.param] = value
      else if (scheme.scheme === "basic") headers[scheme.param] = \`Basic \${btoa(value)}\`
      else headers[scheme.param] = \`Bearer \${value}\`
    }
    return headers
  }

${methods}${pagination}
}
${emitErrorTypes(contract)}
`

  const modelFile = models.length > 0 ? `/** Wire models generated from the bridge contract. */\n\n${models}\n` : ''
  const files = [
    { path: 'src/client.ts', content: client },
  ]
  if (modelFile.length > 0) files.push({ path: 'src/models.ts', content: modelFile })
  files.push({ path: 'README-BRIDGE.md', content: renderReadme(contract, className) })

  if ((contract.models ?? []).some(model => model.kind === 'union')) {
    notes.push('union models are emitted as TypeScript unions; discriminate on the property the contract names')
  }
  notes.push('models live in src/models.ts; import them from the client when you add your own handlers')

  return { files, className, moduleName: 'client', notes }
}
