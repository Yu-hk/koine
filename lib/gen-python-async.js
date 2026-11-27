/**
 * Async Python client, for the target the sync client cannot serve.
 *
 * The sync client is deliberately stdlib-only, which is right for scripts and wrong for any modern
 * Python service: an `await`-based codebase must not block a thread per call. This target keeps the
 * same models and errors (reused verbatim from the sync generator, so the two clients cannot
 * disagree about a type) and swaps only the transport, for `httpx.AsyncClient`.
 */

import { generatePythonClient, pyLiteral } from './gen-python.js'

/** Effective requirement for a route: its own list, else the contract default. */
function securityOf(contract, operation) {
  return operation.security ?? contract.securityDefault ?? []
}

/** Constructor kwargs for the declared schemes, deduplicated across schemes. */
function credentialArgs(schemes) {
  const used = new Set()
  const pick = (base, name) => {
    let candidate = base
    if (used.has(candidate)) {
      const suffix = String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
      candidate = `${base}_${suffix}`
    }
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

/** Python annotation for a contract type, without reaching into the sync generator's internals. */
function annotation(type, fallback = 'Any') {
  if (!type) return fallback
  switch (type.kind) {
    case 'scalar':
      return {
        string: 'str', bytes: 'bytes', datetime: 'str', date: 'str', time: 'str', uuid: 'str',
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
    const headerParams = params.filter(param => param.in === 'header')
    const hasBody = operation.requestBody !== undefined
    const argumentsList = [
      ...pathParams.map(param => `${methodName(param.name)}: ${annotation(param.type)}`),
      ...queryParams.map(param => `${methodName(param.name)}: ${annotation(param.type)} | None = None`),
      ...headerParams.filter(param => param.required).map(param => `${methodName(param.name)}: ${annotation(param.type)}`),
      ...headerParams.filter(param => !param.required).map(param => `${methodName(param.name)}: ${annotation(param.type)} | None = None`),
      ...(hasBody ? ['payload: Any = None'] : []),
    ]
    const signature = ['self', ...argumentsList].join(', ')

    const success = (operation.responses ?? [])[0]
    const resultType = success?.type ? annotation(success.type) : 'None'
    const streaming = operation.streaming === true
    const secNames = securityOf(contract, operation)
    const securityArgument = secNames.length === 0
      ? ''
      : `, security=(${secNames.map(name => `"${name}"`).join(', ')}${secNames.length === 1 ? ',' : ''})`

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

    const headerLines = headerParams.length === 0
      ? ''
      : `        request_headers: dict[str, str] = {}\n`
        + headerParams.map(param => (param.required
          ? `        request_headers["${param.name}"] = str(${methodName(param.name)})\n`
          : `        if ${methodName(param.name)} is not None:\n            request_headers["${param.name}"] = str(${methodName(param.name)})\n`)).join('')
    const headersArgument = headerParams.length === 0 ? '' : ', headers=request_headers'
    const binaryArgument = success?.type?.kind === 'scalar' && success.type.name === 'bytes' ? ', binary=True' : ''
    const multipartArgument = operation.requestContentType === 'multipart/form-data' ? ', multipart=True' : ''

    const summary = (operation.summary || `${operation.method} ${operation.path}`).replace(/\s+/g, ' ').replace(/"""/g, "'''")

    if (streaming) {
      // AsyncIterator is a typing import handled by the client template; it must not be treated as
      // a model name, and StreamingResponse is not used by the client at all.
      methods.push(`
    async def ${methodName(operation.id)}(${signature}) -> AsyncIterator[str]:
        """${summary}"""
      ${headerLines}
        path = _fill_path(${JSON.stringify(operation.path)}, ${pathValues})
        async with self._client.stream(
            ${JSON.stringify(operation.method)}, path, params=${queryValues}, json=${hasBody ? 'payload' : 'None'}${headersArgument},
            headers={"Accept": "text/event-stream"},
        ) as response:
            await _raise_for_status(response, path)
            pending = []
            buffer = ""
            async for chunk in response.aiter_text():
                buffer += chunk
                while "\\n" in buffer:
                    line, buffer = buffer.split("\\n", 1)
                    line = line.rstrip("\\r")
                    if not line:
                        if pending:
                            yield "\\n".join(pending)
                            pending = []
                        continue
                    if line.startswith(":"):
                        continue
                    if line.startswith("data:"):
                        pending.append(line[5:].lstrip())
            if pending:
                yield "\\n".join(pending)
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
      ${headerLines}
        path = _fill_path(${JSON.stringify(operation.path)}, ${pathValues})
        payload = await self._request(
            ${JSON.stringify(operation.method)}, path, params=${queryValues}, body=${hasBody ? 'payload' : 'None'}${securityArgument}${headersArgument}${binaryArgument}${multipartArgument},
        )
        ${decode}
`)
  }

  // The client template adds AsyncIterator to the typing import itself; it must never reach the
  // model-import list, which is what `imports` feeds.
  const usesStreaming = (contract.operations ?? []).some(operation => operation.streaming === true)

  const modelImports = [...new Set([...models])].filter(name => /^[A-Z]/.test(name)).sort()
  const schemes = contract.security ?? []
  const credentials = credentialArgs(schemes)
  const credentialSignature = credentials.length === 0
    ? ''
    : ',\n                 ' + credentials.map(entry => (entry.kind === 'basic'
      ? `${entry.user}: str | None = None, ${entry.password}: str | None = None`
      : `${entry.arg}: str | None = None`)).join(',\n                 ')
  const credentialAssignment = credentials.map(entry => (entry.kind === 'basic'
    ? `        if ${entry.user} is not None and ${entry.password} is not None:\n            self._credentials["${entry.scheme.name}"] = (${entry.user}, ${entry.password})`
    : `        if ${entry.arg} is not None:\n            self._credentials["${entry.scheme.name}"] = ${entry.arg}`)).join('\n')
  const securityConstants = schemes.length === 0
    ? ''
    : `SECURITY = ${pyLiteral(Object.fromEntries(schemes.map(scheme => [scheme.name, {
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
            elif scheme["type"] == "apiKey":
                headers[scheme["param"]] = value
            elif scheme.get("scheme") == "basic":
                user, password = value
                encoded = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
                headers[scheme["param"]] = f"Basic {encoded}"
            else:
                headers[scheme["param"]] = f"Bearer {value}"
`
  if (schemes.some(scheme => scheme.type === 'http' && scheme.scheme === 'basic')) imports.add('base64')

  const clientSource = `"""Async HTTP client for the \`${contract.kind}\` service \`${contract.name}\`.

Generated from a bridge contract; regenerate instead of editing. Requires httpx.
"""

from __future__ import annotations
from dataclasses import asdict
from typing import Any${usesStreaming ? ', AsyncIterator' : ''}
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


${securityConstants}class ${clientName}:
    """Async access to ${(contract.operations ?? []).length} route(s) of \`${contract.name}\`.

    Use it as a context manager, or call \`await client.aclose()\` when done:

        async with ${clientName}("http://127.0.0.1:8080") as client:
            account = await client.read_account("42")
    """

    def __init__(self, base_url: str = ${JSON.stringify(contract.baseUrl || 'http://127.0.0.1:8080')}, timeout: float = 30.0,
                 client: httpx.AsyncClient | None = None${credentialSignature}) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(base_url=self.base_url, timeout=timeout)
        self._credentials: dict[str, Any] = {}
${credentialAssignment}

    async def __aenter__(self) -> ${clientName}:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()
${securityMethod}
    async def _request(self, method: str, path: str, params: dict[str, Any] | None = None,
                       body: Any = None, security: tuple[str, ...] = (),
                       headers: dict[str, str] | None = None, binary: bool = False,
                       multipart: bool = False) -> Any:
        request_headers = {"Accept": "application/json", **(headers or {})}
        params = dict(params or {})
        self._apply_security(security, request_headers, params) if security else None
        params = params or None
        payload = body
        if payload is not None and not isinstance(payload, (dict, list)):
            payload = asdict(payload) if hasattr(payload, "__dataclass_fields__") else payload
        if params is not None:
            params = {key: value for key, value in params.items() if value is not None}
        files = None
        form = None
        if multipart and payload is not None:
            # httpx takes text parts as data and byte parts as files, which is exactly how
            # multipart/form-data distinguishes a field from a file.
            files = {}
            form = {}
            for name, value in payload.items():
                if value is None:
                    continue
                if isinstance(value, (bytes, bytearray)):
                    files[name] = (f"{name}.bin", bytes(value), "application/octet-stream")
                else:
                    form[name] = str(value)
            payload = None
        try:
            response = await self._client.request(method, path, params=params, json=payload,
                                                  data=form, files=files,
                                                  headers=request_headers)
        except httpx.HTTPError as error:
            raise BridgeConnectionError(self.base_url + path, str(error)) from error
        await _raise_for_status(response, path)
        if binary:
            return response.content
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
