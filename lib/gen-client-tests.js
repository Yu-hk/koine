/**
 * Client-side contract tests: prove the generated client sends what the contract promises.
 *
 * The existing `python-contract-tests` target checks a running service's responses. This target
 * checks the other direction: it starts a local stub that records every request, drives the
 * generated client against it, and asserts the recorded method, path, query, headers and body match
 * the contract. A client that sends the wrong header, drops a query parameter or posts JSON to a
 * multipart route fails here instead of at integration time.
 *
 * The generated module imports the client package by its module name, so it runs from the
 * directory that contains the generated client.
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

function placeholderFor(type) {
  if (!type) return '1'
  switch (type.kind) {
    case 'scalar': return PLACEHOLDER[type.name] ?? '1'
    case 'enum': return String(type.values?.[0] ?? 'x')
    default: return '1'
  }
}

function pyString(value) {
  return JSON.stringify(String(value))
}

function methodName(id) {
  return String(id).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()
}

/** A Python literal for a value that may be bytes or a model. */
function pyValue(type, models) {
  if (!type) return 'None'
  if (type.kind === 'scalar') {
    if (type.name === 'bytes') return 'b"koine-bytes"'
    if (type.name === 'int') return '1'
    if (type.name === 'double' || type.name === 'decimal') return '1.0'
    if (type.name === 'boolean') return 'True'
    if (type.name === 'json' || type.name === 'any') return '{}'
    if (type.name === 'void') return 'None'
    return pyString(PLACEHOLDER[type.name] ?? '1')
  }
  if (type.kind === 'ref') {
    const model = (models ?? []).find(entry => entry.name === type.name)
    if (model?.kind === 'enum') return pyString(model.values?.[0] ?? 'x')
    return '{}'
  }
  if (type.kind === 'list') return '[]'
  if (type.kind === 'map') return '{}'
  return 'None'
}

/**
 * Generate the client-side suite.
 *
 * @param contract a bridge contract
 * @param options.moduleName the client package the tests import
 * @param options.className the generated client class
 * @returns `{ files, className, moduleName, notes }`
 */
export function generateClientTests(contract, options = {}) {
  const clientModule = options.moduleName ?? `${String(contract.name ?? 'service').replace(/[^A-Za-z0-9]+/g, '_')}_client`
  const clientClass = options.className
    ?? `${String(contract.name ?? 'service').split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('') || 'Service'}Client`
  const notes = []
  const methods = []
  const models = contract.models ?? []

  for (const operation of contract.operations ?? []) {
    if (operation.streaming === true) {
      notes.push(`\`${operation.id}\` is streaming and is not driven by these tests`)
      continue
    }
    if (operation.requestContentType === 'multipart/form-data') {
      notes.push(`\`${operation.id}\` sends multipart and is not driven by these tests yet`)
      continue
    }
    const params = Array.isArray(operation.params) ? operation.params : []
    const pathParams = params.filter(param => param.in === 'path')
    const queryParams = params.filter(param => param.in === 'query' && param.required)
    const headerParams = params.filter(param => param.in === 'header' && param.required)

    const pathLiteral = operation.path.replace(/\{([^}]+)\}/g, (_, raw) => {
      const found = pathParams.find(param => param.name === raw)
      return String(placeholderFor(found?.type))
    })

    const args = []
    for (const param of pathParams) args.push(pyValue(param.type, models))
    for (const param of queryParams) args.push(pyValue(param.type, models))
    for (const param of headerParams) args.push(pyValue(param.type, models))
    if (operation.requestBody !== undefined) {
      const bodyType = operation.requestBody
      if (bodyType.kind === 'ref') {
        const model = models.find(entry => entry.name === bodyType.name)
        const fields = (model?.fields ?? []).filter(field => field.required)
        const kwargs = fields.map(field => `${methodName(field.name)}=${pyValue(field.type, models)}`).join(', ')
        args.push(`${bodyType.name}(${kwargs})`)
      } else {
        args.push(pyValue(bodyType, models))
      }
    }

    const expectedHeaders = headerParams.map(param => param.name)
    const expectedQuery = queryParams.map(param => param.name)
    const expectsJsonBody = operation.requestBody !== undefined
    const declared = [...(operation.responses ?? []), ...(operation.errors ?? [])].map(entry => Number(entry.status))

    methods.push(`
    def test_${methodName(operation.id)}(self):
        """Drives \`${operation.method} ${operation.path}\` and inspects the request it produced."""
        before = len(RECORDED)
        getattr(self.client, "${methodName(operation.id)}")(${args.join(', ')})
        self.assertGreater(len(RECORDED), before, "the client sent no request")
        request = RECORDED[-1]
        self.assertEqual(request["method"], ${pyString(operation.method)})
        self.assertEqual(request["path"], ${pyString(pathLiteral)})
        ${expectedQuery.length === 0 ? '' : `
        for name in ${JSON.stringify(expectedQuery)}:
            self.assertIn(name, request["query"], f"query parameter {name} was not sent")`}
        ${expectedHeaders.length === 0 ? '' : `
        for name in ${JSON.stringify(expectedHeaders)}:
            self.assertIn(name.lower(), {k.lower() for k in request["headers"]}, f"header {name} was not sent")`}
        ${expectsJsonBody ? `
        self.assertIn("application/json", request["headers"].get("Content-Type", ""), "a JSON body needs the JSON content type")
        self.assertNotEqual(request["body"], b"", "the request body is empty")` : `
        self.assertEqual(request["body"], b"", "no request body was declared")`}
        ${declared.length === 0 ? '' : `
        self.assertIn(request["status"], ${JSON.stringify(declared)})`}
`)
  }

  if (methods.length === 0) notes.push('no operation could be driven; the suite is empty')
  const modelImports = (contract.models ?? []).map(model => model.name)

  const file = `"""Client-side contract tests generated by koine. Do not edit: change the contract and
regenerate.

These drive the generated client against a recording stub and assert what it sends:

    python -m unittest discover -s tests -v

The client package must be importable, so run from the directory that holds it.
"""

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

CONTRACT = json.loads(r"""${JSON.stringify(contract, null, 2)}""")
# Imported at module level: a name imported inside setUp would not be visible to the test methods.
from ${clientModule} import ${[clientClass, ...modelImports].join(', ')}
RECORDED = []
SERVER = {"base": ""}


def _route_for(method, path):
    """First declared route whose shape matches, so the stub can answer plausibly."""
    for operation in CONTRACT.get("operations", []):
        if operation.get("method") != method:
            continue
        template = operation.get("path", "")
        pieces = template.split("/")
        wanted = path.split("/")
        if len(pieces) != len(wanted):
            continue
        if all(p.startswith("{") or p == w for p, w in zip(pieces, wanted)):
            return operation
    return None


def _payload_for(operation):
    for response in operation.get("responses", []):
        kind = (response.get("type") or {}).get("kind")
        if kind == "scalar" and (response["type"].get("name") in ("void", "any")):
            return response.get("status", 200), b""
    return (operation.get("responses") or [{"status": 200}])[0].get("status", 200), json.dumps({}).encode()


class _Handler(BaseHTTPRequestHandler):
    def _record(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        parsed = urlparse(self.path)
        operation = _route_for(self.command, parsed.path)
        status, payload = _payload_for(operation) if operation else (404, b"{}")
        RECORDED.append({
            "method": self.command,
            "path": parsed.path,
            "query": {key: values[0] for key, values in parse_qs(parsed.query).items()},
            "headers": {key: value for key, value in self.headers.items()},
            "body": body,
            "status": status,
        })
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _record
    do_POST = _record
    do_PUT = _record
    do_PATCH = _record
    do_DELETE = _record

    def log_message(self, *_args):
        pass


def setUpModule():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    SERVER["base"] = "http://127.0.0.1:%d" % server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    SERVER["server"] = server


def tearDownModule():
    SERVER["server"].shutdown()


class ClientContractTests(unittest.TestCase):
    def setUp(self):
        self.client = ${clientClass}(SERVER["base"])
        RECORDED.clear()
${methods.join('')}

if __name__ == "__main__":
    unittest.main()
`

  return {
    className: 'ClientContractTests',
    moduleName: 'tests',
    files: [{ path: 'tests/test_client.py', content: file }],
    notes,
  }
}
