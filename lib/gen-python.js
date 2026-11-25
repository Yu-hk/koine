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
      if (field.required) lines.push(`    ${fieldName}: ${python.text}`)
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
function emitOperation(operation, models, clientName) {
  const imports = new Set()
  const params = []
  const pathParams = operation.params.filter(param => param.in === 'path')
  const queryParams = operation.params.filter(param => param.in === 'query')
  const requiredQuery = queryParams.filter(param => param.required && param.default === undefined)
  const optionalQuery = queryParams.filter(param => !(param.required && param.default === undefined))

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
  if (operation.requestBody !== undefined) params.push('payload: Any')
  for (const param of optionalQuery) {
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
    lines.push('                for chunk in response:')
    lines.push('                    text = chunk.decode("utf-8")')
    lines.push('                    if text:')
    lines.push('                        yield text')
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
  const callArgs = ['method="' + operation.method + '"', 'path=path', 'params=params']
  if (operation.requestBody !== undefined) callArgs.push('body=payload')
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
  const methods = []
  contract.operations.forEach((operation) => {
    const emitted = emitOperation(operation, models, options.className)
    for (const line of emitted.imports) imports.add(line)
    methods.push(emitted.text)
  })
  const modelImports = [...models].sort().map(name => `from .models import ${name}`)
  for (const line of modelImports) imports.add(line)
  imports.add('from .errors import BridgeConnectionError, BridgeHttpError')

  const header = `"""HTTP client for the \`${contract.kind}\` service \`${contract.name}\`.

Generated from a bridge contract; regenerate instead of editing.
"""

`
  const transport = `def _fill_path(template: str, values: dict[str, Any]) -> str:
    """Substitute path parameters, percent-encoding every value."""
    for key, value in values.items():
        if value is None:
            raise ValueError(f"path parameter {key!r} is required")
        template = template.replace("{" + key + "}", quote(str(value), safe=""))
    return template


class ${options.className}:
    """Typed access to ${contract.operations.length} route(s) of \`${contract.name}\`."""

    def __init__(self, base_url: str = "${escapePython(options.baseUrl)}", timeout: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        body: Any = None,
    ) -> Any:
        url = self._base_url + path
        if params:
            url = f"{url}?{urlencode(params)}"
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            if is_dataclass(body) and not isinstance(body, type):
                body = asdict(body)
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self._timeout) as response:
                raw = response.read()
        except HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise BridgeHttpError(error.code, url, detail) from None
        except URLError as error:
            raise BridgeConnectionError(url, str(error.reason)) from None
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
