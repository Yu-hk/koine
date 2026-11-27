/**
 * Contract → Python client generator.
 *
 * Emits a dependency-free package: `urllib` speaks HTTP and `dataclasses` model
 * the payloads, so the client drops into a Flask project without adding anything
 * to `requirements.txt`.
 */

import { escapePython, toSnake, toPascal } from './naming.js'

/** Python spelling of a neutral type plus the imports it needs. */
export function pythonTypeOf(type, models = new Set()) {
  switch (type?.kind) {
    case 'scalar': {
      switch (type.name) {
        case 'string': return { text: 'str', imports: [] }
        case 'int': return { text: 'int', imports: [] }
        case 'double': return { text: 'float', imports: [] }
        case 'boolean': return { text: 'bool', imports: [] }
        case 'decimal': return { text: 'Decimal', imports: ['from decimal import Decimal'] }
        case 'datetime': return { text: 'datetime', imports: ['from datetime import datetime'] }
        case 'date': return { text: 'date', imports: ['from datetime import date'] }
        case 'time': return { text: 'time', imports: ['from datetime import time'] }
        case 'uuid': return { text: 'UUID', imports: ['from uuid import UUID'] }
        case 'bytes': return { text: 'bytes', imports: [] }
        case 'void': return { text: 'None', imports: [] }
        default: return { text: 'Any', imports: ['from typing import Any'] }
      }
    }
    case 'list': {
      const inner = pythonTypeOf(type.of, models)
      return { text: `list[${inner.text}]`, imports: inner.imports }
    }
    case 'map': {
      const inner = pythonTypeOf(type.of, models)
      return { text: `dict[str, ${inner.text}]`, imports: inner.imports }
    }
    case 'ref': {
      const name = toPascal(type.name)
      if (models.has(name)) return { text: name, imports: [] }
      return { text: 'Any', imports: ['from typing import Any'] }
    }
    default: return { text: 'Any', imports: ['from typing import Any'] }
  }
}

/** Group consecutive `from x import ...` lines into one import block. */
function importBlock(imports) {
  const modules = new Map()
  for (const line of imports) {
    const match = /^from ([\w.]+) import (.+)$/.exec(line)
    if (match) {
      const [, module, names] = match
      const existing = modules.get(module) ?? new Set()
      for (const name of names.split(',').map(part => part.trim())) existing.add(name)
      modules.set(module, existing)
      continue
    }
    modules.set(line, undefined)
  }
  const lines = []
  for (const [module, names] of modules) {
    if (names === undefined) lines.push(module)
    else lines.push(`from ${module} import ${[...names].sort().join(', ')}`)
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`
}

/** Render every DTO dataclass, plus the imports the file needs. */
function renderModels(contract, models) {
  const blocks = []
  const fileImports = new Set([
    'from __future__ import annotations',
    'from dataclasses import dataclass',
    'from typing import Any',
  ])
  for (const model of contract.models) {
    const name = toPascal(model.name)
    // The set only lists models with fields; enums and unions carry values and variants
    // instead, so they are emitted regardless of whether anything references them.
    if (model.kind !== 'enum' && model.kind !== 'union' && !models.has(name)) continue
    if (model.kind === 'union') {
      // A type alias keeps the variants as plain models; resolution happens at the call site.
      blocks.push([
        `# Discriminated union selected by the \`${model.discriminator}\` property.`,
        `${name} = ${model.variants.map(variant => toPascal(variant.name)).join(' | ') || 'Any'}`,
        '',
      ].join('\n'))
      continue
    }
    if (model.kind === 'enum') {
      fileImports.add('from enum import Enum')
      blocks.push([
        `class ${name}(str, Enum):`,
        `    """Wire enum generated from the bridge contract entry \`${model.name}\`."""`,
        '',
        ...(model.values ?? []).map(value => `    ${String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_')} = "${value}"`),
        '',
      ].join('\n'))
      continue
    }
    const required = model.fields.filter(field => field.required)
    const optional = model.fields.filter(field => !field.required)
    const lines = []
    for (const field of [...required, ...optional]) {
      const python = pythonTypeOf(field.type, models)
      for (const line of python.imports) fileImports.add(line)
      const fieldName = toSnake(field.name)
      // `nullable` means the value itself may be JSON null, which is different from the key being
      // absent; both need `| None` in the annotation.
      const nullableSuffix = field.nullable || !field.required ? ' | None' : ''
      if (field.required) lines.push(`    ${fieldName}: ${python.text}${nullableSuffix}`)
      else lines.push(`    ${fieldName}: ${python.text} | None = None`)
    }
    const conversions = []
    for (const field of [...required, ...optional]) {
      const fieldName = toSnake(field.name)
      const fieldType = field.type
      if (fieldType?.kind === 'ref' && models.has(toPascal(fieldType.name))) {
        conversions.push(`            ${fieldName}=${toPascal(fieldType.name)}.from_dict(data.get("${escapePython(field.name)}")),`)
      } else if (fieldType?.kind === 'list' && fieldType.of?.kind === 'ref' && models.has(toPascal(fieldType.of.name))) {
        conversions.push(`            ${fieldName}=[${toPascal(fieldType.of.name)}.from_dict(item) for item in (data.get("${escapePython(field.name)}") or [])],`)
      } else if (fieldType?.kind === 'list' || fieldType?.kind === 'map') {
        conversions.push(`            ${fieldName}=data.get("${escapePython(field.name)}") or ${fieldType.kind === 'list' ? '[]' : '{}'},`)
      } else {
        conversions.push(`            ${fieldName}=data.get("${escapePython(field.name)}"),`)
      }
    }
    blocks.push([
      '@dataclass',
      `class ${name}:`,
      `    """Wire model generated from the bridge contract entry \`${model.name}\`."""`,
      '',
      lines.join('\n'),
      '',
      '    @classmethod',
      `    def from_dict(cls, data: dict[str, Any] | None) -> ${name} | None:`,
      '        """Build the model from a decoded JSON object, or \`None\` when the payload is empty."""',
      '        if data is None:',
      '            return None',
      '        return cls(',
      conversions.join('\n'),
      '        )',
      '',
    ].join('\n'))
  }
  return { content: blocks.join('\n\n'), imports: fileImports }
}

/**
 * Map declared error statuses to their models, appended to the errors module.
 *
 * Kept separate from the exception class so the transport layer stays independent of the
 * contract: an operation that declares a typed 4xx body gets a decoder, and a caller that does
 * not care keeps using `.status` and `.detail`.
 */
function renderErrorMap(contract) {
  const byStatus = new Map()
  for (const operation of contract.operations ?? []) {
    for (const error of operation.errors ?? []) {
      if (error.type?.kind !== 'ref') continue
      if (!byStatus.has(error.status)) byStatus.set(error.status, new Set())
      byStatus.get(error.status).add(toPascal(error.type.name))
    }
  }
  if (byStatus.size === 0) return ''
  const names = [...new Set([...byStatus.values()].flatMap(set => [...set]))].sort()
  const entries = [...byStatus.entries()]
    .filter(([, set]) => set.size === 1)
    .map(([status, set]) => `    ${status}: ${[...set][0]},`)
  if (entries.length === 0) return ''
  return `

from .models import ${names.join(', ')}  # noqa: E402

# Error bodies declared by the contract, by HTTP status.
_ERROR_TYPES = {
${entries.join('\n')}
}


def decode_error(error: "BridgeHttpError"):
    """Decode the error body into the type this contract declares for its status, or None."""
    import json

    import_ = _ERROR_TYPES.get(getattr(error, "status", None))
    if import_ is None:
        return None
    payload = getattr(error, "detail", None)
    if not payload:
        return None
    try:
        decoded = json.loads(payload) if isinstance(payload, str) else payload
    except (TypeError, ValueError):
        return None
    try:
        return import_.from_dict(decoded)
    except Exception:
        return None
`
}

/** Emit the errors module. */
function renderErrors(moduleName) {
  return `"""Transport errors raised by the \`${moduleName}\` client."""

from __future__ import annotations


class BridgeError(RuntimeError):
    """Base class for every error raised by a generated bridge client."""


class BridgeHttpError(BridgeError):
    """The remote service answered with a non-2xx status."""

    def __init__(self, status: int, url: str, detail: str) -> None:
        super().__init__(f"{status} from {url}: {detail[:500]}")
        self.status = status
        self.url = url
        self.detail = detail


class BridgeConnectionError(BridgeError):
    """The remote service could not be reached."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"cannot reach {url}: {reason}")
        self.url = url
        self.reason = reason
`
}

/** Emit one client method. */
function emitOperation(operation, models, clientName, securityNames = []) {
  const imports = new Set()
  const params = []
  const pathParams = operation.params.filter(param => param.in === 'path')
  const queryParams = operation.params.filter(param => param.in === 'query')
  const headerParams = operation.params.filter(param => param.in === 'header')
  const requiredQuery = queryParams.filter(param => param.required && param.default === undefined)
  const optionalQuery = queryParams.filter(param => !(param.required && param.default === undefined))
  const requiredHeader = headerParams.filter(param => param.required && param.default === undefined)
  const optionalHeader = headerParams.filter(param => !(param.required && param.default === undefined))

  for (const param of pathParams) {
    const python = pythonTypeOf(param.type, models)
    for (const line of python.imports) imports.add(line)
    params.push(`${toSnake(param.name)}: ${python.text}`)
  }
  for (const param of requiredQuery) {
    const python = pythonTypeOf(param.type, models)
    for (const line of python.imports) imports.add(line)
    params.push(`${toSnake(param.name)}: ${python.text}`)
  }
  for (const param of requiredHeader) {
    const python = pythonTypeOf(param.type, models)
    for (const line of python.imports) imports.add(line)
    params.push(`${toSnake(param.name)}: ${python.text}`)
  }
  if (operation.requestBody !== undefined) params.push('payload: Any')
  for (const param of optionalQuery) {
    const python = pythonTypeOf(param.type, models)
    for (const line of python.imports) imports.add(line)
    params.push(`${toSnake(param.name)}: ${python.text} | None = None`)
  }
  for (const param of optionalHeader) {
    const python = pythonTypeOf(param.type, models)
    for (const line of python.imports) imports.add(line)
    params.push(`${toSnake(param.name)}: ${python.text} | None = None`)
  }

  const returnType = operation.responses.find(response => response.status >= 200 && response.status < 300)
    ?? operation.responses[0]
  const type = returnType?.type ?? { kind: 'scalar', name: 'json' }
  const isVoid = type.kind === 'scalar' && type.name === 'void'
  const pythonReturn = pythonTypeOf(type, models)
  for (const line of pythonReturn.imports) imports.add(line)

  const methodName = toSnake(operation.id)
  const lines = []
  const doc = operation.summary.trim().replace(/"""/g, "\"\"\"")
  // The generated module starts with `from __future__ import annotations`, so this annotation
  // is never evaluated at runtime and needs no import.
  const streamAnnotation = operation.streaming === true
    ? 'Iterator[str]'
    : `${isVoid ? 'None' : pythonReturn.text}${type.kind === 'ref' ? ' | None' : ''}`
  lines.push(`    def ${methodName}(${['self', ...params].join(', ')}) -> ${streamAnnotation}:`)
  lines.push(`        """\`${operation.method} ${operation.path}\`${doc.length > 0 ? ` - ${doc}` : ''}"""`)

  if (operation.streaming === true) {
    // A streamed endpoint is emitted as a generator: yielding chunks as they arrive is the
    // whole point, so the body is not read into memory first.
    const pyPath = operation.path.replace(/\{([^}]+)\}/g, (_, raw) => `{${toSnake(raw)}}`)
    lines.push(`        url = f"{self._base_url}${pyPath}"`)
    lines.push(`        request = Request(url, headers={"Accept": "text/event-stream"}, method="${operation.method}")`)
    lines.push('        try:')
    lines.push('            with urlopen(request, timeout=self._timeout) as response:')
    // Server-sent events are framed: `data:` lines carry the payload and a blank line ends the
    // event. Yielding raw chunks makes every caller re-implement that parsing.
    lines.push('                data_lines: list[str] = []')
    lines.push('                for raw_line in response:')
    lines.push('                    line = raw_line.decode("utf-8").rstrip("\\r\\n")')
    lines.push('                    if not line:')
    lines.push('                        if data_lines:')
    lines.push('                            yield "\\n".join(data_lines)')
    lines.push('                            data_lines = []')
    lines.push('                        continue')
    lines.push('                    if line.startswith(":"):')
    lines.push('                        continue')
    lines.push('                    if line.startswith("data:"):')
    lines.push('                        data_lines.append(line[5:].lstrip())')
    lines.push('                    # `event:` and `id:` frames are ignored: the payload is the event.')
    lines.push('                if data_lines:')
    lines.push('                    yield "\\n".join(data_lines)')
    lines.push('        except HTTPError as error:')
    lines.push('            detail = error.read().decode("utf-8", "replace")')
    lines.push('            raise BridgeHttpError(error.code, url, detail) from None')
    lines.push('        except URLError as error:')
    lines.push('            raise BridgeConnectionError(url, str(error.reason)) from None')
    return { text: lines.join('\n'), imports }
  }

  if (pathParams.length === 0) {
    lines.push(`        path = "${escapePython(operation.path)}"`)
  } else {
    const values = pathParams.map(param => `"${escapePython(param.name)}": ${toSnake(param.name)}`).join(', ')
    lines.push(`        path = _fill_path("${escapePython(operation.path)}", {${values}})`)
  }
  lines.push('        params: dict[str, Any] = {}')
  for (const param of queryParams) {
    const pythonName = toSnake(param.name)
    lines.push(`        if ${pythonName} is not None:`)
    lines.push(`            params["${escapePython(param.name)}"] = ${pythonName}`)
  }
  if (headerParams.length > 0) {
    // Header parameters are part of the call, not decoration: omitting one makes the request
    // wrong even though nothing in the signature complained.
    lines.push('        headers: dict[str, str] = {}')
    for (const param of headerParams) {
      const pythonName = toSnake(param.name)
      if (param.required && param.default === undefined) {
        lines.push(`        headers["${escapePython(param.name)}"] = str(${pythonName})`)
      } else {
        lines.push(`        if ${pythonName} is not None:`)
        lines.push(`            headers["${escapePython(param.name)}"] = str(${pythonName})`)
      }
    }
  }
  const isBytes = type.kind === 'scalar' && type.name === 'bytes'
  const callArgs = ['method="' + operation.method + '"', 'path=path', 'params=params']
  if (headerParams.length > 0) callArgs.push('headers=headers')
  if (isBytes) callArgs.push('binary=True')
  if (operation.requestContentType === 'multipart/form-data') callArgs.push('multipart=True')
  if (operation.requestBody !== undefined) callArgs.push('body=payload')
  if (securityNames.length > 0) callArgs.push(`security=${pyTuple(securityNames)}`)
  lines.push(`        result = self._request(${callArgs.join(', ')})`)

  if (isVoid) {
    lines.push('        return None')
  } else if (type.kind === 'ref' && models.has(toPascal(type.name))) {
    lines.push(`        return ${toPascal(type.name)}.from_dict(result)`)
  } else if (type.kind === 'list' && type.of?.kind === 'ref' && models.has(toPascal(type.of.name))) {
    lines.push(`        return [${toPascal(type.of.name)}.from_dict(item) for item in (result or [])]`)
  } else {
    lines.push('        return result')
  }
  return { text: lines.join('\n'), imports }
}

/** Python literal for a JSON-ish value: `null`/`true` are not valid Python. */
export function pyLiteral(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return `"${escapePython(value)}"`
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map(item => `${pad}    ${pyLiteral(item, indent + 4)},`).join('\n')}\n${pad}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([key, item]) => `${pad}    "${escapePython(key)}": ${pyLiteral(item, indent + 4)},`).join('\n')}\n${pad}}`
}

/** Effective requirement for a route: its own list, else the contract default. */
function securityOf(contract, operation) {
  return operation.security ?? contract.securityDefault ?? []
}

/** Python tuple literal for a list of names. */
function pyTuple(names) {
  if (names.length === 1) return `("${escapePython(names[0])}",)`
  return `(${names.map(name => `"${escapePython(name)}"`).join(', ')})`
}

/** Argument name a caller uses for a scheme, deduplicated across schemes. */
function argumentNames(schemes) {
  const used = new Set()
  const pick = (base, schemeName) => {
    let candidate = base
    if (used.has(candidate)) candidate = `${base}_${toSnake(schemeName)}`
    used.add(candidate)
    return candidate
  }
  return schemes.map(scheme => {
    if (scheme.type === 'http' && scheme.scheme === 'basic') {
      return { scheme, kind: 'basic', user: pick('username', scheme.name), password: pick('password', scheme.name) }
    }
    if (scheme.type === 'http' || scheme.type === 'oauth2') {
      return { scheme, kind: 'token', arg: pick('token', scheme.name) }
    }
    return { scheme, kind: 'apiKey', arg: pick('api_key', scheme.name) }
  })
}

/** One iterator per paginated operation: it walks every page and yields the items. */
function renderPagination(contract, models) {
  const blocks = []
  for (const operation of contract.operations ?? []) {
    const pagination = operation.pagination
    if (pagination === undefined) continue
    const method = toSnake(operation.id)
    const model = (contract.models ?? []).find(entry => entry.name === (operation.responses?.[0]?.type?.name ?? ''))
    const listField = (model?.fields ?? []).find(field => field.name === pagination.itemsField)
    const item = listField?.type?.of ?? { kind: 'scalar', name: 'json' }
    const itemType = pythonTypeOf(item, models).text
    // Every other query parameter is forwarded unchanged; only the paging ones are driven here.
    const passthrough = (operation.params ?? [])
      .filter(param => param.in === 'query' && ![pagination.pageParam, pagination.cursorParam, pagination.sizeParam].includes(param.name))
      .map(param => `${toSnake(param.name)}: ${pythonTypeOf(param.type, models).text} | None = None`)
    const forwards = (operation.params ?? [])
      .filter(param => param.in === 'query' && ![pagination.pageParam, pagination.cursorParam, pagination.sizeParam].includes(param.name))
      .map(param => `${toSnake(param.name)}=${toSnake(param.name)}`)
    const signature = ['self', ...passthrough, '*', `page_size: int = 100`].join(', ')
    if (pagination.style === 'cursor') {
      blocks.push(`
    def iter_${method}(${signature}) -> Iterator[${itemType}]:
        """Walk every page of \`${operation.method} ${operation.path}\`, yielding the items."""
        cursor = None
        while True:
            result = self.${method}(${[...forwards, `${toSnake(pagination.cursorParam)}=cursor`, `${toSnake(pagination.sizeParam)}=page_size`].join(', ')})
            items = getattr(result, "${pagination.itemsField}", None) or []
            for entry in items:
                yield entry
            cursor = getattr(result, "${pagination.nextField ?? 'next_cursor'}", None)
            if not cursor:
                return
`)
    } else {
      blocks.push(`
    def iter_${method}(${signature}) -> Iterator[${itemType}]:
        """Walk every page of \`${operation.method} ${operation.path}\`, yielding the items."""
        page = 1
        while True:
            result = self.${method}(${[...forwards, `${toSnake(pagination.pageParam)}=page`, `${toSnake(pagination.sizeParam)}=page_size`].join(', ')})
            items = getattr(result, "${pagination.itemsField}", None) or []
            for entry in items:
                yield entry
            if len(items) < page_size:
                return
            page += 1
`)
    }
  }
  return blocks.join('')
}

/** Emit the client module. */
function renderClient(contract, options, models) {
  const imports = new Set([
    'from __future__ import annotations',
    'from dataclasses import asdict, is_dataclass',
    'import json',
    'from typing import Any',
    'from urllib.error import HTTPError, URLError',
    'from urllib.parse import quote, urlencode',
    'from urllib.request import Request, urlopen',
  ])
  const schemes = (contract.security ?? []).filter(scheme => scheme.type !== undefined)
  const argumentsOf = argumentNames(schemes)
  const methods = []
  contract.operations.forEach((operation) => {
    const emitted = emitOperation(operation, models, options.className, securityOf(contract, operation))
    for (const line of emitted.imports) imports.add(line)
    methods.push(emitted.text)
    if (operation.pagination !== undefined) {
      // Iterators need Iterator in the typing import; the annotation is a string at runtime.
      imports.add('from typing import Iterator')
    }
  })
  methods.push(renderPagination(contract, models))
  const modelImports = [...models].sort().map(name => `from .models import ${name}`)
  for (const line of modelImports) imports.add(line)
  imports.add('from .errors import BridgeConnectionError, BridgeHttpError')

  const header = `"""HTTP client for the \`${contract.kind}\` service \`${contract.name}\`.

Generated from a bridge contract; regenerate instead of editing.
"""

`
  const securityKwargs = argumentsOf
    .map(entry => (entry.kind === 'basic'
      ? `        ${entry.user}: str | None = None,\n        ${entry.password}: str | None = None,`
      : `        ${entry.arg}: str | None = None,`))
    .join('\n')
  const securityInit = argumentsOf
    .map(entry => (entry.kind === 'basic'
      ? `        if ${entry.user} is not None and ${entry.password} is not None:\n            self._credentials["${escapePython(entry.scheme.name)}"] = (${entry.user}, ${entry.password})`
      : `        if ${entry.arg} is not None:\n            self._credentials["${escapePython(entry.scheme.name)}"] = ${entry.arg}`))
    .join('\n')

  const securityBlock = schemes.length === 0
    ? ''
    : `
# Declared authentication schemes. A route that requires one of them raises before the request
# when no credential was supplied, instead of failing with a bare 401.
SECURITY = ${pyLiteral(Object.fromEntries(schemes.map(scheme => [scheme.name, {
      type: scheme.type,
      scheme: scheme.scheme ?? null,
      in: scheme.in ?? null,
      param: scheme.param ?? null,
    }])))}

REQUIRED_SECURITY = ${pyLiteral(Object.fromEntries(contract.operations
      .filter(operation => securityOf(contract, operation).length > 0)
      .map(operation => [operation.id, securityOf(contract, operation)])))}
`

  const securityMethod = schemes.length === 0
    ? ''
    : `
    def _apply_security(self, names: tuple[str, ...], headers: dict[str, str], params: dict[str, Any]) -> None:
        """Attach each required credential, or fail before the request is sent."""
        for name in names:
            scheme = SECURITY.get(name)
            if scheme is None:
                continue
            value = self._credentials.get(name)
            if value is None:
                raise ValueError(f"route requires authentication scheme {name!r}; pass it to the constructor")
            if scheme["type"] == "apiKey" and scheme["in"] == "query":
                params[scheme["param"]] = value
            elif scheme["type"] == "http" and scheme["scheme"] == "bearer":
                headers[scheme["param"]] = f"Bearer {value}"
            elif scheme["type"] == "http" and scheme["scheme"] == "basic":
                user, password = value
                token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
                headers[scheme["param"]] = f"Basic {token}"
            elif scheme["type"] == "oauth2":
                headers[scheme["param"]] = f"Bearer {value}"
            else:
                headers[scheme["param"]] = value
`
  if (schemes.some(scheme => scheme.type === 'http' && scheme.scheme === 'basic')) imports.add('import base64')
  const usesMultipart = (contract.operations ?? []).some(operation => operation.requestContentType === 'multipart/form-data')
  if (usesMultipart) imports.add('from uuid import uuid4')

  const multipartHelper = usesMultipart
    ? `def _multipart_body(fields: dict[str, Any], boundary: str) -> bytes:
    """Encode parts as multipart/form-data; a bytes part is sent as a file."""
    lines: list[bytes] = []
    for name, value in fields.items():
        if value is None:
            continue
        lines.append(f"--{boundary}".encode())
        if isinstance(value, (bytes, bytearray)):
            lines.append(f'Content-Disposition: form-data; name="{name}"; filename="{name}.bin"'.encode())
            lines.append(b"Content-Type: application/octet-stream")
            lines.append(b"")
            lines.append(bytes(value))
        else:
            lines.append(f'Content-Disposition: form-data; name="{name}"'.encode())
            lines.append(b"")
            lines.append(str(value).encode("utf-8"))
    lines.append(f"--{boundary}--".encode())
    lines.append(b"")
    return b"\\r\\n".join(lines)


`
    : ''

  const transport = `def _fill_path(template: str, values: dict[str, Any]) -> str:
    """Substitute path parameters, percent-encoding every value."""
    for key, value in values.items():
        if value is None:
            raise ValueError(f"path parameter {key!r} is required")
        template = template.replace("{" + key + "}", quote(str(value), safe=""))
    return template
${multipartHelper}${securityBlock}

class ${options.className}:
    """Typed access to ${contract.operations.length} route(s) of \`${contract.name}\`."""

    def __init__(self, base_url: str = "${escapePython(options.baseUrl)}", timeout: float = 30.0,
${securityKwargs.length > 0 ? `${securityKwargs}\n` : ''}    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._credentials: dict[str, Any] = {}
${securityInit.length > 0 ? `${securityInit}\n` : ''}${securityMethod}
    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        body: Any = None,
        security: tuple[str, ...] = (),
        binary: bool = False,
        multipart: bool = False,
        headers: dict[str, str] | None = None,
    ) -> Any:
        params = dict(params or {})
        request_headers = {"Accept": "application/json", **(headers or {})}
        if security:
            self._apply_security(security, request_headers, params)
        url = self._base_url + path
        if params:
            url = f"{url}?{urlencode(params)}"
        data = None
        if body is not None:
            if is_dataclass(body) and not isinstance(body, type):
                body = asdict(body)
            if multipart:
                boundary = "----koine" + uuid4().hex
                data = _multipart_body(body, boundary)
                request_headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
            else:
                data = json.dumps(body).encode("utf-8")
                request_headers["Content-Type"] = "application/json"
        request = Request(url, data=data, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=self._timeout) as response:
                raw = response.read()
        except HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise BridgeHttpError(error.code, url, detail) from None
        except URLError as error:
            raise BridgeConnectionError(url, str(error.reason)) from None
        if binary:
            return raw
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

`
  return `${header}${importBlock(imports)}${transport}${methods.map(method => `${method}\n`).join('\n')}`
}

/** Emit the package init that re-exports the public surface. */
function renderInit(contract, options, models) {
  const exported = [options.className, ...models]
  const lines = [
    `"""Bridge client for \`${contract.name}\` (generated, do not edit)."""`,
    '',
    'from .client import ' + options.className,
    'from .errors import BridgeConnectionError, BridgeError, BridgeHttpError',
  ]
  if (models.size > 0) lines.push('from .models import ' + [...models].sort().join(', '))
  lines.push('')
  lines.push('__all__ = [')
  for (const name of ['BridgeError', 'BridgeHttpError', 'BridgeConnectionError', ...exported].sort()) {
    lines.push(`    "${name}",`)
  }
  lines.push(']')
  lines.push('')
  return lines.join('\n')
}

/** Integration notes for the generated Python client. */
function renderReadme(contract, options) {
  const models = [...options.models].sort()
  return `# Python client for \`${contract.name}\`

Generated from a \`${contract.kind}\` bridge contract: ${contract.operations.length} route(s), ${contract.models.length} model(s).

No third-party dependency: the client uses \`urllib\` and \`dataclasses\` from the standard library.

## Usage

\`\`\`python
from ${options.moduleName} import ${options.className}

client = ${options.className}("${options.baseUrl}")
result = client.${contract.operations.length > 0 ? toSnake(contract.operations[0].id) : 'call'}(...)
\`\`\`

## Routes

| Method | Path | Operation | Summary |
| --- | --- | --- | --- |
${contract.operations.map(operation => `| ${operation.method} | \`${operation.path}\` | \`${toSnake(operation.id)}\` | ${operation.summary && operation.summary.trim().length > 0 ? operation.summary.trim() : '—'} |`).join('\n')}

## Generated models

${models.length === 0 ? '_This contract declares no models._' : models.map(name => `- \`${name}\``).join('\n')}

## Wire behaviour

- Non-2xx responses raise \`BridgeHttpError\` (\`.status\`, \`.detail\`).
- Unreachable hosts raise \`BridgeConnectionError\`.
- Optional query parameters are only sent when they are not \`None\`.
- Empty response bodies decode to \`None\`.
`
}

/**
 * Generate the Python client package for a contract.
 *
 * @returns files relative to the output directory, plus generated identities.
 */
export function generatePythonClient(contract, options) {
  const serviceName = options.serviceName ?? contract.name
  const moduleName = options.moduleName ?? `${toSnake(serviceName)}_client`
  const className = `${toPascal(serviceName)}Client`
  const baseUrl = options.baseUrl ?? contract.baseUrl
  const models = new Set(contract.models.filter(model => model.fields.length > 0).map(model => toPascal(model.name)))
  const files = []

  const modelSource = renderModels(contract, models)
  files.push({ path: `${moduleName}/__init__.py`, content: renderInit(contract, { className }, models) })
  files.push({ path: `${moduleName}/errors.py`, content: renderErrors(moduleName) + renderErrorMap(contract) })
  files.push({
    path: `${moduleName}/models.py`,
    content: modelSource.content.length === 0
      ? '"""No models are declared by this contract."""\n'
      : `${importBlock(modelSource.imports)}${modelSource.content}`,
  })
  files.push({ path: `${moduleName}/client.py`, content: renderClient(contract, { className, baseUrl }, models) })
  files.push({
    path: 'README-BRIDGE.md',
    content: renderReadme(contract, { moduleName, className, baseUrl, models }),
  })

  const notes = contract.models
    .filter(model => model.fields.length === 0)
    .map(model => `model \`${model.name}\` has no fields and was skipped`)

  return { files, notes, moduleName, className }
}
