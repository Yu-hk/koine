/**
 * Async Python client, for the target the sync client cannot serve.
 *
 * The sync client is deliberately stdlib-only, which is right for scripts and wrong for any modern
 * Python service: an `await`-based codebase must not block a thread per call. This target keeps the
 * same models and errors (reused verbatim from the sync generator, so the two clients cannot
 * disagree about a type) and swaps only the transport, for `httpx.AsyncClient`.
 */

import { generatePythonClient } from './gen-python.js'

/** Python annotation for a contract type, without reaching into the sync generator's internals. */
function annotation(type, fallback = 'Any') {
  if (!type) return fallback
  switch (type.kind) {
    case 'scalar':
      return {
        string: 'str', bytes: 'str', datetime: 'str', date: 'str', time: 'str', uuid: 'str',
        int: 'int', double: 'float', decimal: 'str', boolean: 'bool',
        json: 'Any', any: 'Any', void: 'None',
      }[type.name] ?? 'Any'
    case 'list': return `list[${annotation(type.of)}]`
    case 'map': return `dict[str, ${annotation(type.of)}]`
    case 'ref': return String(type.name)
    case 'enum': return String(type.name)
    case 'union': return 'Any'
    default: return 'Any'
  }
}

/** `from_dict` exists on reference models; scalars and anything else are returned as-is. */
function decodeExpression(type, payload) {
  if (type?.kind === 'ref') return `${type.name}.from_dict(${payload})`
  if (type?.kind === 'list' && type.of?.kind === 'ref') {
    return `[${type.of.name}.from_dict(item) for item in (${payload} or [])]`
  }
  return payload
}

function methodName(id) {
  return String(id).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()
}

function classNameFor(name) {
  return String(name)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('') || 'Service'
}

/**
 * Generate the async client.
 *
 * @param contract a bridge contract
 * @param options.moduleName, options.serviceName
 * @returns `{ files, className, moduleName, notes }`
 */
export function generatePythonAsyncClient(contract, options = {}) {
  const sync = generatePythonClient(contract, options)
  const moduleName = options.moduleName ?? sync.moduleName ?? `${contract.name ?? 'service'}_client`
  const clientName = `${classNameFor(contract.name ?? 'service')}AsyncClient`
  const notes = [
    'this client needs httpx: `pip install httpx` (the sync python-client target needs nothing)',
    ...(sync.notes ?? []),
  ]

  const models = new Set((contract.models ?? []).map(model => String(model.name)))
  const methods = []
  const imports = new Set()

  for (const operation of contract.operations ?? []) {
    const params = Array.isArray(operation.params) ? operation.params : []
    const pathParams = params.filter(param => param.in === 'path')
    const queryParams = params.filter(param => param.in === 'query')
    const hasBody = operation.requestBody !== undefined
    const argumentsList = [
      ...pathParams.map(param => `${methodName(param.name)}: ${annotation(param.type)}`),
      ...queryParams.map(param => `${methodName(param.name)}: ${annotation(param.type)} | None = None`),
      ...(hasBody ? ['payload: Any = None'] : []),
    ]
    const signature = ['self', ...argumentsList].join(', ')

    const success = (operation.responses ?? [])[0]
    const resultType = success?.type ? annotation(success.type) : 'None'
    const streaming = operation.streaming === true

    const pathValues = pathParams.length === 0
      ? '{}'
      : `{${pathParams.map(param => `"${param.name}": ${methodName(param.name)}`).join(', ')}}`
    const queryValues = queryParams.length === 0
      ? 'None'
      : `{${
      queryParams
        .map(param => `"${param.name}": ${methodName(param.name)}`)
        .join(', ')
    }}`

    const summary = (operation.summary || `${operation.method} ${operation.path}`).replace(/\s+/g, ' ').replace(/"""/g, "'''")

    if (streaming) {
      imports.add('AsyncIterator')
      imports.add('StreamingResponse')
      methods.push(`
    async def ${methodName(operation.id)}(${signature}) -> AsyncIterator[str]:
        """${summary}"""
        path = _fill_path(${JSON.stringify(operation.path)}, ${pathValues})
        async with self._client.stream(
            ${JSON.stringify(operation.method)}, path, params=${queryValues}, json=${hasBody ? 'payload' : 'None'},
            headers={"Accept": "text/event-stream"},
        ) as response:
            await _raise_for_status(response, path)
            async for chunk in response.aiter_text():
                if chunk:
                    yield chunk
`)
      continue
    }

    const decode = success?.type
      ? `return ${decodeExpression(success.type, 'payload')}`
      : 'return payload'
    if (success?.type?.kind === 'ref') imports.add(String(success.type.name))
    if (success?.type?.kind === 'list' && success.type.of?.kind === 'ref') imports.add(String(success.type.of.name))

    methods.push(`
    async def ${methodName(operation.id)}(${signature}) -> ${resultType}${resultType === 'None' ? '' : ' | None'}:
        """${summary}"""
        path = _fill_path(${JSON.stringify(operation.path)}, ${pathValues})
        payload = await self._request(
            ${JSON.stringify(operation.method)}, path, params=${queryValues}, body=${hasBody ? 'payload' : 'None'},
        )
        ${decode}
`)
  }

  if ((contract.operations ?? []).some(operation => operation.streaming === true)) {
    imports.add('AsyncIterator')
  }

  const modelImports = [...new Set([...models, ...imports])].filter(name => /^[A-Z]/.test(name)).sort()
  const clientSource = `"""Async HTTP client for the \`${contract.kind}\` service \`${contract.name}\`.

Generated from a bridge contract; regenerate instead of editing. Requires httpx.
"""

from __future__ import annotations
from dataclasses import asdict
from typing import Any${imports.has('AsyncIterator') ? ', AsyncIterator' : ''}
from urllib.parse import quote

import httpx

${modelImports.length > 0 ? `from .models import ${modelImports.join(', ')}` : ''}
from .errors import BridgeConnectionError, BridgeHttpError


def _fill_path(template: str, values: dict[str, Any]) -> str:
    """Substitute path parameters, percent-encoding every value."""
    for key, value in values.items():
        if value is None:
            raise ValueError(f"path parameter {key!r} is required")
        template = template.replace("{" + key + "}", quote(str(value), safe=""))
    return template


async def _raise_for_status(response: "httpx.Response", path: str) -> None:
    """Turn an error status into the same exception the sync client raises."""
    if response.status_code < 400:
        return
    detail = await response.aread()
    text = detail.decode("utf-8", "replace")
    raise BridgeHttpError(response.status_code, str(response.request.url), text)


class ${clientName}:
    """Async access to ${(contract.operations ?? []).length} route(s) of \`${contract.name}\`.

    Use it as a context manager, or call \`await client.aclose()\` when done:

        async with ${clientName}("http://127.0.0.1:8080") as client:
            account = await client.read_account("42")
    """

    def __init__(self, base_url: str = ${JSON.stringify(contract.baseUrl || 'http://127.0.0.1:8080')}, timeout: float = 30.0,
                 client: httpx.AsyncClient | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(base_url=self.base_url, timeout=timeout)

    async def __aenter__(self) -> ${clientName}:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, params: dict[str, Any] | None = None,
                       body: Any = None) -> Any:
        payload = body
        if payload is not None and not isinstance(payload, (dict, list)):
            payload = asdict(payload) if hasattr(payload, "__dataclass_fields__") else payload
        if params is not None:
            params = {key: value for key, value in params.items() if value is not None}
        try:
            response = await self._client.request(method, path, params=params, json=payload,
                                                  headers={"Accept": "application/json"})
        except httpx.HTTPError as error:
            raise BridgeConnectionError(self.base_url + path, str(error)) from error
        await _raise_for_status(response, path)
        if response.status_code == 204 or not response.content:
            return None
        return response.json()
${methods.join('')}`

  const files = sync.files.filter(file => file.path.endsWith('models.py') || file.path.endsWith('errors.py'))
  // `decode_error` only exists when the contract declares error bodies; importing it unconditionally
  // makes the package fail to import for a contract that declares none.
  const errorsFile = sync.files.find(file => file.path.endsWith('errors.py'))
  const hasDecodeError = (errorsFile?.content ?? '').includes('def decode_error')
  files.push({ path: `${moduleName}/client.py`, content: clientSource })
  files.push({
    path: `${moduleName}/__init__.py`,
    content: `"""Generated async client for \`${contract.name}\`. Regenerate instead of editing."""

from .client import ${clientName}
from .errors import BridgeConnectionError, BridgeError, BridgeHttpError${hasDecodeError ? ', decode_error' : ''}
${modelImports.length > 0 ? `from .models import ${modelImports.join(', ')}` : ''}

__all__ = ["${clientName}", "BridgeConnectionError", "BridgeError", "BridgeHttpError"${
  hasDecodeError ? ', "decode_error"' : ''
}${modelImports.length > 0 ? `, ${modelImports.map(name => `"${name}"`).join(', ')}` : ''}]
`,
  })
  files.push({
    path: 'README-BRIDGE.md',
    content: `# ${contract.name} — async Python client

Generated by koine from a bridge contract. Do not edit; change the contract and regenerate.

## Install

    pip install httpx

The sync \`python-client\` target needs nothing; this one needs httpx because the standard library has
no async HTTP client.

## Use

    import asyncio
    from ${moduleName} import ${clientName}

    async def main():
        async with ${clientName}("${contract.baseUrl || 'http://127.0.0.1:8080'}") as client:
${(contract.operations ?? []).slice(0, 3).map(operation => `            await client.${methodName(operation.id)}(...)`).join('\n')}

    asyncio.run(main())

Errors: \`BridgeHttpError\` for a 4xx/5xx (status, url, detail), \`BridgeConnectionError\` for a transport
failure. Neither is retried: retry policy belongs to the caller.
`,
  })

  return { files, className: clientName, moduleName, notes }
}
