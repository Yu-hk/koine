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
    case 'bytes': return 'string'
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

/** One client method per operation. */
function emitMethod(operation) {
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
  if (operation.requestBody !== undefined) signature.push(`body: ${tsType(operation.requestBody)}`)

  lines.push(`  async ${name}(${signature.join(', ')}): Promise<${tsType(operation.responses[0]?.type ?? VOID_TYPE)}> {`)
  lines.push(`    const url = new URL(\`\${this.baseUrl}${path}\`)`)
  lines.push(...queryLines(operation))
  lines.push('    const response = await this.fetchImpl(url, {')
  lines.push(`      method: ${JSON.stringify(operation.method)},`)
  if (operation.requestBody !== undefined) {
    lines.push('      headers: { "content-type": "application/json" },')
    lines.push('      body: JSON.stringify(body),')
  }
  lines.push('    })')
  lines.push('    const text = await response.text()')
  lines.push('    if (!response.ok) {')
  lines.push('      throw new BridgeHttpError(response.status, text)')
  lines.push('    }')
  lines.push('    return text.length === 0 ? (undefined as never) : (JSON.parse(text) as never)')
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
      return `  ${toCamel(field.name)}${optional}: ${tsType(field.type)}`
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
export function generateTypeScriptClient(contract, options = {}) {
  const service = options.serviceName ?? contract.name ?? 'service'
  const className = `${toPascal(service)}Client`
  const baseUrl = options.baseUrl ?? contract.baseUrl ?? ''
  const notes = []

  const models = emitModels(contract, notes)
  const methods = (contract.operations ?? []).map(emitMethod).join('\n\n')
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

export class ${className} {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

${methods}
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
