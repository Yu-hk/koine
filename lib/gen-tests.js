/**
 * Contract tests: turn a contract into an executable test suite.
 *
 * The generator itself is data-driven on purpose. It emits one Python file containing the contract
 * as data plus a generic shape checker, and one method per operation. That keeps the generated file
 * small and means a richer contract does not mean more generated code to review — only more data.
 *
 * The tests check conformance, not behaviour: that every declared route exists, answers with a
 * declared status, and returns a body whose shape matches the declared model. They cannot know
 * whether an order was actually created; they can know the response stopped matching its own
 * contract.
 */

const PLACEHOLDER = {
  string: '1',
  int: '1',
  double: '1',
  decimal: '1',
  boolean: 'true',
  datetime: '2020-01-01T00:00:00Z',
  date: '2020-01-01',
  time: '00:00:00',
  uuid: '00000000-0000-0000-0000-000000000000',
  bytes: '1',
  json: '1',
  any: '1',
  void: '1',
}

/** A value for any type expression, used to fill path and query parameters. */
function placeholderFor(type) {
  if (type === undefined || type === null) return '1'
  switch (type.kind) {
    case 'scalar':
      return PLACEHOLDER[type.name] ?? '1'
    case 'enum':
      return String(type.values?.[0] ?? '1')
    case 'ref':
    case 'list':
    case 'map':
    case 'union':
      return '1'
    default:
      return '1'
  }
}

function pyString(value) {
  return JSON.stringify(String(value)).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => `\\u${hex}`)
}

function methodName(id) {
  return String(id).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1')
}

/**
 * Generate the test module.
 *
 * @param contract a bridge contract
 * @param options.className overrides the test class name
 * @returns `{ files, className, moduleName, notes }`
 */
export function generateContractTests(contract, options = {}) {
  const serviceName = String(options.serviceName ?? contract.name ?? 'service')
  const derived = `${serviceName.replace(/[^A-Za-z0-9]/g, ' ')}ContractTests`
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('')
  // `??` and `||` cannot mix without parentheses, so the fallback is resolved first.
  const className = options.className ?? (derived || 'ServiceContractTests')

  const notes = []
  const methods = []
  const seen = new Set()

  for (const operation of contract.operations ?? []) {
    const name = methodName(operation.id)
    if (seen.has(name)) {
      notes.push(`duplicate test name ${name}: only the first operation is tested`)
      continue
    }
    seen.add(name)

    const params = Array.isArray(operation.params) ? operation.params : []
    const pathParams = params.filter(param => param.in === 'path')
    const queryParams = params.filter(param => param.in === 'query' && param.required === true)
    const declared = [...(operation.responses ?? []), ...(operation.errors ?? [])]
      .map(entry => Number(entry.status))
      .filter(status => Number.isFinite(status))

    const path = String(operation.path)
    const segments = []
    let cursor = 0
    const pattern = /\{([^}]+)\}/g
    let match
    while ((match = pattern.exec(path)) !== null) {
      segments.push(path.slice(cursor, match.index))
      const found = pathParams.find(param => param.name === match[1])
      segments.push(placeholderFor(found?.type))
      cursor = match.index + match[0].length
    }
    segments.push(path.slice(cursor))
    const filledPath = segments.join('') || '/'

    const query = queryParams.length === 0
      ? ''
      : `?${queryParams.map(param => `${encodeURIComponent(param.name)}=${encodeURIComponent(placeholderFor(param.type))}`).join('&')}`

    const expected = declared.length > 0 ? declared.join(', ') : ''
    const bodyType = operation.requestBody === undefined
      ? 'None'
      : JSON.stringify(shapeLiteral(operation.requestBody))
    // Header parameters are part of the call; a placeholder value is enough to exercise the route.
    // Optional ones are omitted, which is also the behaviour a caller gets by default.
    const requiredHeaders = params.filter(param => param.in === 'header' && param.required)
    const headerLiteral = requiredHeaders.length === 0
      ? '{}'
      : `{${requiredHeaders.map(param => `${JSON.stringify(param.name)}: ${JSON.stringify(placeholderFor(param.type))}`).join(', ')}}`

    methods.push(`
    def test_${name}(self):
        """${(operation.summary || `${operation.method} ${operation.path}`).replace(/\s+/g, ' ').replace(/"/g, "'")}"""
        status, payload, text = send(${pyString(operation.method)}, ${pyString(filledPath)}${query === '' ? '' : ` + ${pyString(query)}`}, BUILD_BODY(${bodyType}), security=REQUIRED_SECURITY.get(${pyString(operation.id)}, []), headers=${headerLiteral})
        declared = [${expected}]
        self.assertIn(status, declared, f"status {status} is not declared for ${operation.method} ${filledPath}: {text[:200]}")
        problems = shape_problems(payload, ${JSON.stringify(shapeLiteral(operation.responses?.[0]?.type ?? { kind: 'scalar', name: 'any' }))}, "body")
        if problems:
            self.fail("${operation.method} ${filledPath} response does not match the contract:\\n  " + "\\n  ".join(problems))
`)
  }

  if (methods.length === 0) {
    notes.push('the contract has no operations, so the generated suite is empty')
  }
  if ((contract.operations ?? []).some(operation => (operation.params ?? []).some(param => param.in === 'query' && param.required !== true))) {
    notes.push('optional query parameters are omitted: the tests exercise the simplest valid request')
  }

  const files = [{
    path: 'tests/test_contract.py',
    content: `"""Contract conformance tests generated by koine. Do not edit: change the contract and
regenerate.

Run against a live service:

    BRIDGE_BASE_URL=http://127.0.0.1:8080 python -m unittest discover -s tests -v
"""

import base64
import json
import os
import unittest
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = os.environ.get("BRIDGE_BASE_URL", ${pyString(contract.baseUrl || 'http://127.0.0.1:8080')}).rstrip("/")
TIMEOUT = float(os.environ.get("BRIDGE_TIMEOUT", "10"))

CONTRACT = json.loads(r"""${JSON.stringify(contract, null, 2)}""")

MODELS = {model["name"]: model for model in CONTRACT.get("models", [])}

# Route id -> required scheme names, and where each credential goes.
REQUIRED_SECURITY = json.loads(r"""${JSON.stringify(Object.fromEntries((contract.operations ?? [])
  .map(operation => [operation.id, operation.security ?? contract.securityDefault ?? []])
  .filter(([, names]) => names.length > 0)))}""")
SECURITY = json.loads(r"""${JSON.stringify(Object.fromEntries((contract.security ?? []).map(scheme => [scheme.name, {
  type: scheme.type,
  scheme: scheme.scheme ?? null,
  in: scheme.in ?? null,
  param: scheme.param ?? 'Authorization',
}])))}""")

PLACEHOLDER_BODY = ${JSON.stringify(placeholderBody(contract), null, 2)}


def BUILD_BODY(shape):
    """A minimal body for a declared request type; enough to exercise the route."""
    if shape is None:
        return None
    name = shape.get("name")
    return PLACEHOLDER_BODY.get(name)


def credentials_for(names):
    """Credentials from the environment, by scheme; a missing one skips the test loudly.

    A per-scheme variable wins over the generic one, so a contract with two api keys can be
    exercised with two different values.
    """
    values = {}
    for name in names:
        scheme = SECURITY.get(name, {})
        suffix = name.upper().replace("-", "_").replace(".", "_")
        if scheme.get("type") == "apiKey":
            value = os.environ.get("BRIDGE_API_KEY_" + suffix) or os.environ.get("BRIDGE_API_KEY")
            hint = "BRIDGE_API_KEY_" + suffix
        elif scheme.get("scheme") == "basic":
            user = os.environ.get("BRIDGE_USER")
            password = os.environ.get("BRIDGE_PASSWORD")
            if user is None or password is None:
                raise unittest.SkipTest("set BRIDGE_USER and BRIDGE_PASSWORD to test scheme " + name)
            encoded = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
            values[name] = encoded
            continue
        else:
            value = os.environ.get("BRIDGE_TOKEN_" + suffix) or os.environ.get("BRIDGE_TOKEN")
            hint = "BRIDGE_TOKEN_" + suffix
        if value is None:
            raise unittest.SkipTest("set " + hint + " to test scheme " + name)
        values[name] = value
    return values


def send(method, path, body=None, security=(), headers=None):
    values = credentials_for(security)
    headers = dict(headers or {})
    for name in security:
        scheme = SECURITY.get(name, {})
        value = values[name]
        if scheme.get("type") == "apiKey" and scheme.get("in") == "query":
            separator = "&" if "?" in path else "?"
            path = path + separator + urllib.parse.quote(str(scheme["param"])) + "=" + urllib.parse.quote(value)
        elif scheme.get("type") == "apiKey":
            headers[scheme["param"]] = value
        elif scheme.get("scheme") == "basic":
            headers[scheme["param"]] = "Basic " + value
        else:
            headers[scheme["param"]] = "Bearer " + value
    url = BASE_URL + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    if data is not None:
        request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            text = response.read().decode("utf-8", "replace")
            try:
                payload = json.loads(text) if text.strip() else None
            except json.JSONDecodeError:
                payload = None
            return response.status, payload, text
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        try:
            payload = json.loads(text) if text.strip() else None
        except json.JSONDecodeError:
            payload = None
        return error.code, payload, text


def shape_problems(value, shape, where):
    """Compare a decoded value against a contract type; returns human-readable problems."""
    if shape is None:
        return []
    kind = shape.get("kind")
    if kind == "scalar":
        name = shape.get("name")
        if name in ("json", "any", "void"):
            return []
        expected = {
            "string": str, "bytes": str, "datetime": str, "date": str, "time": str, "uuid": str,
            "boolean": bool, "int": int, "decimal": (int, float, str), "double": (int, float),
        }.get(name)
        if expected is not None and not isinstance(value, expected):
            return [f"{where}: expected {name}, got {type(value).__name__} ({str(value)[:60]})"]
        return []
    if kind == "list":
        if not isinstance(value, list):
            return [f"{where}: expected list, got {type(value).__name__}"]
        problems = []
        for index, item in enumerate(value[:20]):
            problems.extend(shape_problems(item, shape.get("of"), f"{where}[{index}]"))
        return problems
    if kind == "map":
        if not isinstance(value, dict):
            return [f"{where}: expected object, got {type(value).__name__}"]
        problems = []
        for key, item in list(value.items())[:20]:
            problems.extend(shape_problems(item, shape.get("of"), f"{where}.{key}"))
        return problems
    if kind == "enum":
        allowed = shape.get("values") or []
        return [] if not allowed or value in allowed else [f"{where}: {value!r} is not one of {allowed}"]
    if kind == "union":
        if not isinstance(value, dict):
            return [f"{where}: expected object for a union, got {type(value).__name__}"]
        discriminator = shape.get("discriminator")
        tag = value.get(discriminator) if discriminator else None
        for variant in shape.get("variants") or []:
            if variant.get("tag") == tag:
                return shape_problems(value, {"kind": "ref", "name": variant.get("name")}, where)
        known = [variant.get("tag") for variant in shape.get("variants") or []]
        return [f"{where}: discriminator {discriminator!r} is {tag!r}, expected one of {known}"]
    if kind == "ref":
        model = MODELS.get(shape.get("name"))
        if model is None:
            return []
        if model.get("kind") == "enum":
            allowed = model.get("values") or []
            return [] if not allowed or value in allowed else [f"{where}: {value!r} is not one of {allowed}"]
        if not isinstance(value, dict):
            return [f"{where}: expected object {shape.get('name')}, got {type(value).__name__}"]
        problems = []
        for field in model.get("fields") or []:
            name = field.get("name")
            if field.get("required") and name not in value:
                problems.append(f"{where}.{name}: required field missing")
            elif name in value:
                # A nullable field may be JSON null; anything else is checked as declared.
                if value[name] is None and field.get("nullable"):
                    continue
                problems.extend(shape_problems(value[name], field.get("type"), f"{where}.{name}"))
        return problems
    return []


class ${className}(unittest.TestCase):
${methods.join('')}

if __name__ == "__main__":
    unittest.main()
`,
  }]

  return {
    className,
    moduleName: 'tests',
    files,
    notes,
  }
}

/** A type expression reduced to the literal embedded in the generated file. */
function shapeLiteral(type) {
  if (type === undefined || type === null) return { kind: 'scalar', name: 'json' }
  return type
}

/** A minimal request body built from the contract's models, keyed by model name. */
function placeholderBody(contract) {
  const body = {}
  for (const model of contract.models ?? []) {
    if (model.kind === 'enum' || model.kind === 'union') {
      body[model.name] = model.kind === 'enum' ? (model.values?.[0] ?? 'x') : {}
      continue
    }
    const fields = {}
    for (const field of model.fields ?? []) {
      if (!field.required) continue
      fields[field.name] = placeholderValue(field.type, contract)
    }
    body[model.name] = fields
  }
  return body
}

function placeholderValue(type, contract) {
  if (!type) return '1'
  switch (type.kind) {
    case 'scalar':
      return { string: '1', int: 1, double: 1, decimal: '1', boolean: true, datetime: '2020-01-01T00:00:00Z', date: '2020-01-01', time: '00:00:00', uuid: '00000000-0000-0000-0000-000000000000', bytes: '1', json: {}, any: 1, void: null }[type.name] ?? 1
    case 'list':
      return []
    case 'map':
      return {}
    case 'enum':
      return type.values?.[0] ?? 'x'
    case 'ref': {
      const model = (contract.models ?? []).find(entry => entry.name === type.name)
      return model?.kind === 'enum' ? (model.values?.[0] ?? 'x') : {}
    }
    default:
      return 1
  }
}
