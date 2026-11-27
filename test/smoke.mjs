#!/usr/bin/env node
/**
 * Plugin self-test: the contract pipeline and the bundled runtime, no host app involved.
 *
 * Run with `node test/smoke.mjs`. Fixtures are written to a temporary directory so the test
 * is self-contained and leaves nothing behind.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { discoverDocuments, discoverRemote } from '../lib/discover.js'
import { TARGETS, compare, discover, extract as extractFrom, generate, validateContract } from '../lib/engine.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractContract } from '../lib/extract.js'
import { diffContracts, describeType, makeContract, severityOf, severitySummary } from '../lib/ir.js'
import { generateJavaClient } from '../lib/gen-java.js'
import { generatePythonClient } from '../lib/gen-python.js'
import { bundled } from '../lib/sidecar.js'
import { contractFromOpenApi, extractOpenApi } from '../lib/openapi.js'
import { generateJavaServer, generatePythonServer } from '../lib/gen-server.js'
import { generateTypeScriptClient } from '../lib/gen-typescript.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'polyglot-bridge-'))
// The bundled interpreter for this platform, used by the contract-test round trip below.
const runtimeDir = join(here, '..', 'runtime', `${process.platform}-${process.arch}`)
let failures = 0

function check(name, body) {
  try {
    body()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name} - ${error.message}`)
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function write(relative, content) {
  const path = join(work, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return join(work, relative)
}

// --- fixtures -----------------------------------------------------------------
write('flask/app.py', [
  'from flask import Flask, jsonify, request',
  'app = Flask(__name__)',
  '',
  '@app.route("/health")',
  'def health():',
  '    return "", 204',
  '',
  '@app.route("/users/<int:user_id>", methods=["GET", "PATCH"])',
  'def user(user_id, page: int = 1):',
  '    return jsonify({}), 200',
  '',
].join('\n'))

write('fastapi/app.py', [
  'from fastapi import APIRouter, FastAPI',
  'from models import Order',
  'app = FastAPI()',
  'router = APIRouter(prefix="/orders")',
  '',
  '@router.post("", response_model=Order, status_code=201)',
  'async def create(payload: Order):',
  '    return payload',
  '',
  '@router.get("/{order_id}")',
  'async def read(order_id: int):',
  '    return {}',
  '',
  'app.include_router(router, prefix="/api")',
].join('\n'))

write('fastapi/models.py', [
  'from pydantic import BaseModel',
  '',
  'class Order(BaseModel):',
  '    customer: str',
  '    quantity: int = 1',
].join('\n'))

// --- contract extraction ------------------------------------------------------
let flask
check('flask: framework detected', () => {
  flask = extractContract(join(work, 'flask'))
  expect(flask.framework === 'flask', `got ${flask.framework}`)
})

check('flask: routes and status codes', () => {
  const routes = flask.contract.operations.map(operation => `${operation.method} ${operation.path} ${operation.responses[0].status}`)
  expect(routes.includes('GET /health 204'), `missing health: ${routes.join(', ')}`)
  expect(routes.includes('GET /users/{user_id} 200'), 'missing GET user')
  expect(routes.includes('PATCH /users/{user_id} 200'), 'missing PATCH user')
})

check('flask: query parameter default', () => {
  const read = flask.contract.operations.find(operation => operation.method === 'GET' && operation.path.includes('/users/'))
  expect(read !== undefined, 'GET /users/{user_id} missing')
  const page = read.params.find(param => param.name === 'page')
  expect(page !== undefined, 'page missing')
  expect(page.default === '1', `default ${page.default}`)
  expect(page.required === false, 'page should be optional')
})

let fastapi
check('fastapi: framework and prefix joined once', () => {
  fastapi = extractContract(join(work, 'fastapi'))
  expect(fastapi.framework === 'fastapi', `got ${fastapi.framework}`)
  const paths = fastapi.contract.operations.map(operation => operation.path).sort()
  expect(paths.includes('/api/orders'), `paths: ${paths.join(', ')}`)
  expect(paths.includes('/api/orders/{order_id}'), `paths: ${paths.join(', ')}`)
  expect(!paths.some(path => path.includes('/api/orders/api')), 'prefix applied twice')
})

check('fastapi: body model and status', () => {
  const create = fastapi.contract.operations.find(operation => operation.method === 'POST')
  expect(create.requestBody?.kind === 'ref' && create.requestBody.name === 'Order', 'body model missing')
  expect(create.responses[0].status === 201, `status ${create.responses[0].status}`)
})

// --- diff ---------------------------------------------------------------------
check('diff: identical contracts are in sync', () => {
  expect(diffContracts(flask.contract, flask.contract).status === 'in-sync', 'expected in-sync')
})

check('ir: union types survive normalization', () => {
  const contract = makeContract({
    kind: 'unioncase',
    operations: [{
      id: 'pay',
      method: 'POST',
      path: '/pay',
      params: [],
      requestBody: { kind: 'union', discriminator: 'kind', variants: [{ name: 'Card', tag: 'card' }, { name: 'Cash', tag: 'cash' }] },
      responses: [{ status: 200, type: { kind: 'scalar', name: 'string' } }],
    }],
  })
  const body = contract.operations[0].requestBody
  expect(body.kind === 'union', `kind ${body.kind}`)
  expect(body.variants.length === 2, `variants ${JSON.stringify(body.variants)}`)
  expect(body.discriminator === 'kind', `discriminator ${body.discriminator}`)
  expect(describeType(body) === 'Card | Cash', `describe ${describeType(body)}`)
})

check('ir: enum types survive normalization with their values', () => {
  const contract = makeContract({
    kind: 'enumcase',
    operations: [{
      id: 'list',
      method: 'GET',
      path: '/items',
      params: [{ in: 'query', name: 'state', type: { kind: 'enum', name: 'State', values: ['active', 'suspended'] } }],
      responses: [{ status: 200, type: { kind: 'scalar', name: 'string' } }],
    }],
  })
  const state = contract.operations[0].params[0].type
  expect(state.kind === 'enum', `kind ${state.kind}`)
  expect(state.values.length === 2, `values ${JSON.stringify(state.values)}`)
  expect(describeType(state) === 'State(active|suspended)', `describe ${describeType(state)}`)
})

check('diff: different services drift', () => {
  expect(diffContracts(flask.contract, fastapi.contract).status === 'drift', 'expected drift')
})

check('ir: failures are separated from success responses', () => {
  const contract = makeContract({
    kind: 'errors',
    operations: [{
      id: 'read',
      method: 'GET',
      path: '/items/{id}',
      params: [{ in: 'path', name: 'id', required: true, type: { kind: 'scalar', name: 'string' } }],
      responses: [
        { status: 200, type: { kind: 'scalar', name: 'string' } },
        { status: 404, type: { kind: 'scalar', name: 'json' } },
        { status: 422, type: { kind: 'scalar', name: 'json' } },
      ],
    }],
  })
  const operation = contract.operations[0]
  expect(operation.responses.length === 3, 'responses should keep every status')
  expect(operation.errors.length === 2, `errors ${JSON.stringify(operation.errors)}`)
  expect(operation.errors.map(error => error.status).join(',') === '404,422', 'wrong error statuses')
})

check('diff: compatibility severity', () => {
  const before = makeContract({
    kind: 'before',
    operations: [
      { method: 'GET', path: '/users', params: [{ in: 'query', name: 'page', type: { kind: 'scalar', name: 'int' }, required: false, default: '1' }] },
      { method: 'DELETE', path: '/users/{id}', params: [{ in: 'path', name: 'id', type: { kind: 'scalar', name: 'int' }, required: true }] },
    ],
  })
  const after = makeContract({
    kind: 'after',
    operations: [
      { method: 'GET', path: '/users', params: [{ in: 'query', name: 'page', type: { kind: 'scalar', name: 'int' }, required: true }] },
      { method: 'GET', path: '/orders' },
    ],
  })
  const result = diffContracts(before, after)
  const counts = severitySummary(result.changed)
  // Tightening a parameter from optional to required breaks callers; removing a route does too.
  expect(counts.breaking === 1, `expected 1 breaking, got ${JSON.stringify(counts)}`)
  expect(counts.cosmetic === 1, `expected 1 cosmetic, got ${JSON.stringify(counts)}`)
  expect(result.onlyInA.length === 1, `removed route should be reported, got ${result.onlyInA.length}`)
})

// --- openapi adapter ----------------------------------------------------------
write('openapi/openapi.json', JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'orders-api' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/orders': {
      post: {
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
        responses: { 201: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
      },
    },
    '/orders/{id}': {
      get: {
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
          { in: 'query', name: 'expand', schema: { type: 'boolean' } },
          { in: 'header', name: 'X-Tenant', required: true, schema: { type: 'string' } },
          { in: 'cookie', name: 'session', schema: { type: 'string' } },
        ],
        responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } },
      },
    },
    '/health': { delete: { responses: { 204: { description: 'gone' } } } },
  },
  components: {
    schemas: {
      Order: {
        type: 'object',
        required: ['customer'],
        properties: { customer: { type: 'string' }, quantity: { type: 'integer' } },
      },
    },
  },
}))

check('openapi: paths become operations', () => {
  const extracted = extractOpenApi(join(work, 'openapi'))
  const keys = extracted.contract.operations.map(operation => `${operation.method} ${operation.path}`).sort()
  expect(keys.length === 3, `expected 3 operations, got ${keys.join(', ')}`)
  expect(keys.includes('POST /orders'), 'missing POST /orders')
  expect(keys.includes('DELETE /health'), 'missing DELETE /health')
  expect(extracted.contract.baseUrl === 'https://api.example.com', 'server url not used')
})

check('openapi: ref, array and void mapping', () => {
  const extracted = extractOpenApi(join(work, 'openapi'))
  const create = extracted.contract.operations.find(operation => operation.method === 'POST')
  expect(create.requestBody.kind === 'ref' && create.requestBody.name === 'Order', 'body ref lost')
  expect(create.responses[0].status === 201, `status ${create.responses[0].status}`)
  const read = extracted.contract.operations.find(operation => operation.path.includes('{id}'))
  expect(read.responses[0].type.kind === 'list', 'array response not a list')
  expect(read.params.find(param => param.name === 'id').required === true, 'path param not required')
  expect(read.params.find(param => param.name === 'X-Tenant').in === 'header', 'header param lost')
  expect(read.params.find(param => param.name === 'session') === undefined, 'cookie param should be skipped')
  const remove = extracted.contract.operations.find(operation => operation.method === 'DELETE')
  expect(remove.responses[0].type.kind === 'scalar' && remove.responses[0].type.name === 'void', '204 should be void')
})

check('openapi: enums currently degrade to string', () => {
  // Documented limitation, asserted so that adding real enum support is a deliberate change
  // rather than an accidental one.
  write('openapi/enum.json', JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'enumcase' },
    paths: {
      '/status': {
        get: {
          parameters: [{ in: 'query', name: 'state', schema: { type: 'string', enum: ['active', 'suspended'] } }],
          responses: { 200: { content: { 'application/json': { schema: { type: 'string', enum: ['active', 'suspended'] } } } } },
        },
      },
    },
  }))
  const extracted = extractOpenApi(join(work, 'openapi'), { file: join(work, 'openapi', 'enum.json') })
  const read = extracted.contract.operations[0]
  const state = read.params.find(param => param.name === 'state')
  expect(state.type.kind === 'scalar' && state.type.name === 'string', `param enum became ${JSON.stringify(state.type)}`)
  expect(read.responses[0].type.name === 'string', 'response enum should stay string')
  // The allowed values are recorded even though codegen emits a plain string.
  expect(Array.isArray(state.type.values), 'enum values not recorded on the parameter type')
  expect(state.type.values.length === 2, `values ${JSON.stringify(state.type.values)}`)
  expect(describeType(state.type).includes('active|suspended'), 'describe should expose the value set')
})

check('openapi: oneOf degrades to json with a warning', () => {
  write('openapi/union.json', JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'unions' },
    paths: { '/pay': { post: { responses: { 200: { description: 'ok' } } } } },
    components: {
      schemas: {
        Payment: { oneOf: [{ $ref: '#/components/schemas/Card' }, { $ref: '#/components/schemas/Cash' }] },
        Card: { type: 'object', properties: { number: { type: 'string' } } },
        Cash: { type: 'object', properties: { amount: { type: 'number' } } },
      },
    },
  }))
  const extracted = extractOpenApi(join(work, 'openapi'), { file: join(work, 'openapi', 'union.json') })
  const hit = extracted.contract.warnings.find(warning => warning.message.includes('oneOf'))
  expect(hit !== undefined, `no warning: ${JSON.stringify(extracted.contract.warnings)}`)
  expect(hit.message.includes('Payment'), `warning does not name the schema: ${hit.message}`)
})

check('openapi: a problem-details schema is recognised', () => {
  write('openapi/problem.json', JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'problems' },
    paths: { '/pay': { post: { responses: { 400: { description: 'bad' } } } } },
    components: {
      schemas: {
        Problem: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            detail: { type: 'string' },
            status: { type: 'integer' },
          },
        },
      },
    },
  }))
  const extracted = extractOpenApi(join(work, 'openapi'), { file: join(work, 'openapi', 'problem.json') })
  expect(extracted.contract.problemDetails === 'Problem', `problemDetails ${extracted.contract.problemDetails}`)
})

check('postman: routes, parameters and the partial warning', () => {
  const file = write('postman/orders.postman_collection.json', JSON.stringify({
    info: { name: 'Orders API' },
    item: [
      {
        name: 'Read order',
        request: { method: 'GET', url: { path: ['orders', ':id'], query: [{ key: 'expand' }], variable: [{ key: 'id' }] } },
        response: [{ code: 200 }, { code: 404 }],
      },
      {
        name: 'Create order',
        request: { method: 'POST', url: { path: ['orders'] }, body: { mode: 'raw', raw: '{"customer":"a","quantity":2}' } },
        response: [{ code: 201 }],
      },
    ],
  }))
  const extracted = extractContract(file)
  expect(extracted.framework === 'postman', `framework ${extracted.framework}`)
  const read = extracted.contract.operations.find(operation => operation.method === 'GET')
  // Postman spells a variable `:id`; the contract must spell it `{id}` or no generator binds it.
  expect(read.path === '/orders/{id}', `path ${read.path}`)
  expect(read.params.some(param => param.in === 'path' && param.name === 'id' && param.required === true), 'path parameter missing')
  expect(read.params.some(param => param.in === 'query' && param.name === 'expand' && param.required === false), 'query parameter missing')
  expect(read.responses.map(response => response.status).join(',') === '200,404', 'recorded statuses lost')
  const create = extracted.contract.operations.find(operation => operation.method === 'POST')
  expect(create.requestBody?.kind === 'ref', 'request sample should become a model reference')
  expect(extracted.contract.warnings.some(warning => warning.message.includes('Postman collection')), 'partial warning missing')
})

check('openapi: dispatch prefers the exported document', () => {
  const extracted = extractContract(join(work, 'openapi'))
  expect(extracted.framework === 'openapi', `framework ${extracted.framework}`)
  expect(extracted.contract.operations.length === 3, 'operations lost during dispatch')
})

check('openapi: component schemas become models', () => {
  const extracted = extractOpenApi(join(work, 'openapi'))
  const order = extracted.contract.models.find(model => model.name === 'Order')
  expect(order !== undefined, 'Order model missing')
  expect(order.fields.length === 2, `fields ${order.fields.map(field => field.name).join(', ')}`)
  expect(order.fields.find(field => field.name === 'customer').required === true, 'required field lost')
  expect(order.fields.find(field => field.name === 'quantity').type.name === 'int', 'integer not mapped')
})

check('streaming: every client emits a stream consumer, not a stub', () => {
  const streamContract = makeContract({
    kind: 'sse',
    name: 'streamer',
    operations: [{
      id: 'streamThread',
      method: 'GET',
      path: '/threads/{id}/stream',
      summary: 'Events for a run.',
      streaming: true,
      params: [{ in: 'path', name: 'id', required: true, type: { kind: 'scalar', name: 'string' } }],
      responses: [{ status: 200, type: { kind: 'scalar', name: 'string' } }],
    }],
    models: [],
  })
  const ts = generateTypeScriptClient(streamContract, {}).files.find(file => file.path.endsWith('client.ts')).content
  expect(ts.includes('async *streamThread('), 'typescript should emit an async generator')
  expect(ts.includes('getReader()'), 'typescript should consume a ReadableStream')
  expect(!ts.includes('UnsupportedOperationException'), 'typescript must not stub streaming')

  const java = generateJavaClient(streamContract, { packageName: 'com.x.bridge' }).files.find(file => file.path.endsWith('Client.java')).content
  expect(java.includes('java.io.InputStream streamThread('), 'java should return an InputStream')
  expect(java.includes('body(java.io.InputStream.class)'), 'java should ask RestClient for a stream')
  expect(!java.includes('UnsupportedOperationException'), 'java must not stub streaming')

  const py = generatePythonClient(streamContract, {}).files.find(file => file.path.endsWith('client.py')).content
  expect(py.includes('def stream_thread('), 'python should emit a method')
  expect(py.includes('yield text'), 'python should be a generator')
  expect(py.includes('text/event-stream'), 'python should ask for an event stream')
})

check('typescript client: class, models and union', () => {
  const union = makeContract({
    kind: 'ts',
    name: 'shop',
    operations: [{
      id: 'pay',
      method: 'POST',
      path: '/pay',
      summary: 'Pay for an order.',
      params: [],
      requestBody: { kind: 'ref', name: 'Payment' },
      responses: [{ status: 200, type: { kind: 'scalar', name: 'boolean' } }],
      errors: [{ status: 422, type: { kind: 'ref', name: 'ValidationError' } }],
    }],
    models: [
      { name: 'Payment', kind: 'union', discriminator: 'kind', variants: [{ name: 'Card', tag: 'card' }, { name: 'Cash', tag: 'cash' }], fields: [] },
      { name: 'ValidationError', fields: [{ name: 'detail', type: { kind: 'scalar', name: 'string' }, required: true }] },
    ],
  })
  const out = generateTypeScriptClient(union, {})
  const client = out.files.find(file => file.path.endsWith('client.ts'))
  const models = out.files.find(file => file.path.endsWith('models.ts'))
  expect(client !== undefined && client.content.includes('export class ShopClient'), 'client class missing')
  expect(client.content.includes('/** Pay for an order. */'), 'summary missing')
  expect(models.content.includes('export type Payment = Card | Cash'), 'union not emitted')
  expect(client.content.includes('decodeError'), 'error decoder missing')
  expect(out.notes.length > 0, 'notes must never be undefined or empty')
})

check('server: java interface carries route annotations', () => {
  const out = generateJavaServer(flask.contract, { packageName: 'com.example.demo.bridge' })
  const api = out.files.find(file => file.path.endsWith('Api.java'))
  expect(api !== undefined, 'api interface missing')
  expect(api.content.includes('@GetMapping("/health")'), 'health mapping missing')
  expect(api.content.includes('interface FlaskApi'), `interface name wrong: ${api.path}`)
  expect(api.content.includes('@PathVariable'), 'path variable annotation missing')
})

check('server: python router stub', () => {
  const out = generatePythonServer(fastapi.contract, { serviceName: 'orders' })
  const router = out.files.find(file => file.path.endsWith('router.py'))
  expect(router !== undefined, 'router missing')
  expect(router.content.includes('APIRouter()'), 'no router instance')
  expect(router.content.includes('NotImplementedError'), 'no stub body')
  expect(out.files.some(file => file.path.endsWith('models.py')), 'no models module')
})

// --- generators ---------------------------------------------------------------
check('java client: one class plus one record per model', () => {
  const generated = generateJavaClient(fastapi.contract, { packageName: 'com.example.demo.bridge' })
  const paths = generated.files.map(file => file.path)
  const client = generated.files.find(file => file.path.includes('/client/') && !file.path.includes('/model/'))
  expect(client !== undefined, `client missing: ${paths.join(', ')}`)
  expect(paths.some(path => path.endsWith('client/model/Order.java')), 'model record missing')
  expect(client.content.includes('HTTP_1_1'), 'client should pin HTTP/1.1')
})

check('python client: package with stdlib only', () => {
  const generated = generatePythonClient(fastapi.contract, {})
  const paths = generated.files.map(file => file.path)
  expect(paths.some(path => path.endsWith('__init__.py')), 'package init missing')
  const client = generated.files.find(file => file.path.endsWith('client.py'))
  expect(client.content.includes('from urllib.request import'), 'should use stdlib urllib')
})

// --- bundled runtime ----------------------------------------------------------
check('runtime: interpreter and vendor present', () => {
  expect(bundled(), 'bundled() reported missing pieces')
})

check('vendor: matches vendor-lock.json', () => {
  execFileSync(process.execPath, [join(here, '..', 'scripts', 'check-vendor.mjs')], { stdio: 'pipe' })
})

check('engine: hosts get the same results as the direct modules', () => {
  // The engine exists so a host adapter (DSH today, MCP later) cannot drift from the modules it
  // wraps. These assertions are the contract between them.
  expect(TARGETS.length === 7, `targets ${TARGETS.length}`)

  // engine.extract is asynchronous, so it is exercised in the awaited block at the end of this
  // file; a synchronous body here would silently drop the assertion.
  const extracted = { contract: flask.contract }

  const generated = generate(extracted.contract, 'typescript-client', {})
  expect(generated.files.some(file => file.path.endsWith('client.ts')), 'no client emitted')
  expect(Array.isArray(generated.notes) && generated.notes.length > 0, 'notes must never be empty')

  const same = compare(extracted.contract, extracted.contract, { failOn: 'additive' })
  expect(same.result.status === 'in-sync' && same.tripped === false, 'identical contracts must pass the gate')

  const differ = compare(flask.contract, fastapi.contract, { failOn: 'breaking' })
  expect(differ.tripped === true, `gate should trip: ${JSON.stringify(differ.counts)}`)
})

check('security: schemes are modelled, applied per route, and graded', () => {
  const document = {
    openapi: '3.0.3',
    info: { title: 'secure' },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        weird: { type: 'mutualTLS' },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/private': { get: { operationId: 'readPrivate', responses: { 200: { content: { 'application/json': { schema: { type: 'string' } } } } } } },
      '/public': { get: { operationId: 'readPublic', security: [], responses: { 200: { content: { 'application/json': { schema: { type: 'string' } } } } } } },
      '/keyed': { get: { operationId: 'readKeyed', security: [{ apiKey: [] }], responses: { 200: { content: { 'application/json': { schema: { type: 'string' } } } } } } },
    },
  }
  const secure = contractFromOpenApi(document)
  const names = secure.security.map(scheme => scheme.name).sort().join(',')
  expect(names === 'apiKey,bearerAuth', `schemes ${names}`)
  expect(secure.securityDefault.join(',') === 'bearerAuth', `default ${secure.securityDefault}`)
  expect(secure.warnings.some(warning => warning.message.includes('mutualTLS')), 'an unsupported scheme must warn, not vanish')
  const byId = new Map(secure.operations.map(operation => [operation.id, operation]))
  expect(byId.get('readPrivate').security === undefined, 'a route without its own list inherits the default')
  expect(Array.isArray(byId.get('readPublic').security) && byId.get('readPublic').security.length === 0, 'an explicit [] means no auth')
  expect(byId.get('readKeyed').security.join(',') === 'apiKey', `route scheme ${byId.get('readKeyed').security}`)
  expect(validateContract(secure).ok, `contract must validate: ${JSON.stringify(validateContract(secure).errors)}`)

  // Tightening auth on a public route breaks callers that send no credential.
  const tightened = JSON.parse(JSON.stringify(secure))
  tightened.operations.find(operation => operation.id === 'readPublic').security = ['bearerAuth']
  const result = diffContracts(secure, tightened)
  const details = result.changed.flatMap(entry => entry.details)
  expect(details.some(detail => detail.startsWith('security required:')), `no security diff: ${details.join('; ')}`)
  expect(details.filter(detail => detail.startsWith('security required:')).every(detail => severityOf(detail) === 'breaking'), 'a requirement change must be breaking')

  // Changing the header a scheme uses invalidates every client built from the old contract.
  const renamed = JSON.parse(JSON.stringify(secure))
  renamed.security.find(scheme => scheme.name === 'apiKey').param = 'X-Other-Key'
  const schemeDiff = diffContracts(secure, renamed)
  expect(schemeDiff.security.changed.length === 1, `scheme diff ${JSON.stringify(schemeDiff.security.changed)}`)
  expect(severityOf(schemeDiff.security.changed[0].details[0]) === 'breaking', 'a scheme change must be breaking')

  // A dangling reference is a contract error, not a warning.
  const dangling = JSON.parse(JSON.stringify(secure))
  dangling.operations[0].security = ['nope']
  expect(!validateContract(dangling).ok, 'an unknown scheme reference must fail validation')
})

check('security: generated clients apply the declared scheme, tests read it from the environment', () => {
  const document = {
    openapi: '3.0.3',
    info: { title: 'secure' },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
    paths: { '/private': { get: { operationId: 'readPrivate', responses: { 200: { content: { 'application/json': { schema: { type: 'string' } } } } } } } },
  }
  const secure = contractFromOpenApi(document)

  const python = generate(secure, 'python-client', {}).files.find(file => file.path.endsWith('client.py')).content
  expect(python.includes('SECURITY = {'), 'no scheme table in the python client')
  expect(python.includes('def _apply_security'), 'no credential application in the python client')
  expect(python.includes('security=("bearerAuth",)'), 'the route does not pass its requirement')
  expect(python.includes('route requires authentication scheme'), 'missing credential must raise before the request')

  const typescript = generate(secure, 'typescript-client', {}).files.find(file => file.path.endsWith('client.ts')).content
  expect(typescript.includes('const SECURITY:'), 'no scheme table in the typescript client')
  expect(typescript.includes('private applyAuth'), 'no applyAuth in the typescript client')
  expect(typescript.includes('REQUIRED_SECURITY["readPrivate"]'), 'the route does not pass its requirement')

  const tests = generate(secure, 'python-contract-tests', {}).files.find(file => file.path.endsWith('test_contract.py')).content
  expect(tests.includes('BRIDGE_TOKEN'), 'contract tests must read a token from the environment')
  expect(tests.includes('unittest.SkipTest'), 'a missing credential must skip loudly, not pass quietly')

  const java = generate(secure, 'java-client', { packageName: 'com.acme.secure' }).files.find(file => file.path.endsWith('Client.java')).content
  expect(java.includes('securitySchemes'.slice(0, 0) + 'authHeaders("'), 'the java client does not resolve required schemes per route')
  expect(java.includes('.headers(h -> { securityHeaders.forEach(h::set); })'), 'the java client does not attach the credentials')
  expect(java.includes('java.util.List.of('), 'java.security types must be fully qualified, or javac cannot resolve List')
  expect(java.includes('private String credential('), 'the java client must fail loudly when a credential is missing')
})

check('async python client: awaits instead of blocking, and says it needs httpx', () => {
  const generated = generate(flask.contract, 'python-async-client', {})
  const client = generated.files.find(file => file.path.endsWith('client.py'))
  expect(client !== undefined, 'no client emitted')
  expect(/class \w+AsyncClient/.test(client.content), 'class name does not end in AsyncClient')
  expect(client.content.includes('httpx.AsyncClient'), 'no httpx client')
  expect(client.content.includes('async def aclose'), 'no aclose')
  expect(client.content.includes('async def __aenter__'), 'not usable as an async context manager')
  const awaited = (client.content.match(/^ {4}async def (?!__|_request|aclose)/gm) ?? []).length
  expect(awaited === (flask.contract.operations ?? []).length, `${awaited} awaited methods for ${(flask.contract.operations ?? []).length} routes`)
  expect((generated.notes ?? []).some(note => note.includes('httpx')), `notes must mention the dependency: ${JSON.stringify(generated.notes)}`)
})

check('contract tests: a suite is generated with one method per operation', () => {
  const generated = generate(flask.contract, 'python-contract-tests', {})
  const file = generated.files.find(entry => entry.path === 'tests/test_contract.py')
  expect(file !== undefined, 'no test module emitted')
  const routes = (flask.contract.operations ?? []).length
  const methods = (file.content.match(/^ {4}def test_/gm) ?? []).length
  expect(methods === routes, `${methods} test methods for ${routes} routes`)
  expect(file.content.includes('BRIDGE_BASE_URL'), 'the suite must be runnable against any base url')
  expect(file.content.includes('shape_problems'), 'no shape checker embedded')
})

check('discover: local scan prefers the machine-readable document', () => {
  write('discover/docs/openapi.json', JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Orders API' },
    paths: { '/orders': {}, '/orders/{id}': {} },
  }))
  write('discover/README.md', '# Orders service\n\nSee docs/openapi.json.\n')
  const found = discoverDocuments({ projectDir: join(work, 'discover'), keywords: ['orders'] })
  expect(found.length >= 1, 'no candidates')
  expect(found[0].kind === 'openapi', `first candidate kind ${found[0].kind}`)
  expect(found[0].trust === 'high', `first candidate trust ${found[0].trust}`)
  expect(found[0].routes === 2, `routes ${found[0].routes}`)
  expect(found.some(candidate => candidate.trust === 'pointer-only'), 'a markdown file should be pointer-only')
})

// Remote discovery needs a listening server, so it is awaited explicitly rather than inside
// check(), whose body is synchronous.
try {
  const server = createServer((request, response) => {
    if (request.url === '/openapi.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ openapi: '3.0.3', info: { title: 'Remote' }, paths: { '/x': {} } }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  const found = await discoverRemote({ url: origin })
  expect(found.length === 1, `expected one candidate, got ${JSON.stringify(found)}`)
  expect(found[0].trust === 'high' && found[0].kind === 'openapi', `unexpected candidate ${JSON.stringify(found[0])}`)
  expect(found[0].routes === 1, `routes ${found[0].routes}`)
  console.log('PASS discover: remote probe finds the document')
  server.close()
} catch (error) {
  failures++
  console.log(`FAIL discover: remote probe - ${error.message}`)
}

// engine.extract and engine.discover are asynchronous, so they are awaited here rather than inside
// check(), whose body is synchronous: an unawaited promise would make the assertion vacuous.
try {
  const engineDir = join(work, 'engine-demo')
  mkdirSync(engineDir, { recursive: true })
  writeFileSync(join(engineDir, 'openapi.json'), JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'engine demo' },
    paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } },
  }), 'utf8')

  const extracted = await extractFrom({ projectDir: engineDir })
  expect(extracted.framework === 'openapi', `engine.extract framework ${extracted.framework}`)
  expect(extracted.contract.operations.length === 1, `engine.extract routes ${extracted.contract.operations.length}`)

  const found = await discover({ projectDir: engineDir })
  expect(found.length >= 1 && found[0].kind === 'openapi', `engine.discover ${JSON.stringify(found)}`)
  console.log('PASS engine: extract and discover resolve through the host-agnostic layer')
} catch (error) {
  failures++
  console.log(`FAIL engine: extract and discover - ${error.message}`)
}

// Contract tests end to end: generate the suite, serve a mock that answers according to the
// contract, and run the suite with the bundled interpreter. This is the only check that proves the
// generated tests actually execute, and it uses spawn rather than a synchronous wait because the
// mock server lives in this process: blocking here would stop it answering.
try {
  const contract = {
    version: 1,
    kind: 'openapi',
    name: 'ct-demo',
    baseUrl: 'http://127.0.0.1:1',
    operations: [
      {
        id: 'readThing',
        method: 'GET',
        path: '/things/{id}',
        summary: 'Read one thing',
        params: [{ in: 'path', name: 'id', type: { kind: 'scalar', name: 'string' }, required: true }],
        responses: [{ status: 200, type: { kind: 'ref', name: 'Thing' } }],
      },
      {
        id: 'createThing',
        method: 'POST',
        path: '/things',
        summary: 'Create a thing',
        params: [],
        requestBody: { kind: 'ref', name: 'ThingInput' },
        responses: [{ status: 201, type: { kind: 'ref', name: 'Thing' } }],
      },
    ],
    models: [
      { name: 'Thing', fields: [{ name: 'id', type: { kind: 'scalar', name: 'string' }, required: true }] },
      { name: 'ThingInput', fields: [{ name: 'id', type: { kind: 'scalar', name: 'string' }, required: true }] },
    ],
    warnings: [],
  }

  const ctDir = join(work, 'ct-run')
  const generated = generate(contract, 'python-contract-tests', {})
  for (const file of generated.files) {
    mkdirSync(join(ctDir, file.path, '..'), { recursive: true })
    writeFileSync(join(ctDir, file.path), file.content, 'utf8')
  }

  const server = createServer((request, response) => {
    const status = request.method === 'POST' ? 201 : 200
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: '1' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const run = await new Promise(resolve => {
    const child = spawn(join(runtimeDir, process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
      ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
      { cwd: ctDir, env: { ...process.env, BRIDGE_BASE_URL: `http://127.0.0.1:${port}` } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => resolve({ code, output }))
  })
  await new Promise(resolve => server.close(resolve))

  expect(run.code === 0, `contract tests failed (exit ${run.code}): ${run.output.slice(-300)}`)
  expect(/Ran 2 tests/.test(run.output), `expected 2 tests, got: ${run.output.slice(-200)}`)
  console.log('PASS contract tests: the generated suite runs green against a conforming service')

  // The same suite must fail when the service stops matching, otherwise it proves nothing.
  const mutant = createServer((request, response) => {
    response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 12345 }))
  })
  await new Promise(resolve => mutant.listen(0, '127.0.0.1', resolve))
  const mutantPort = mutant.address().port
  const failing = await new Promise(resolve => {
    const child = spawn(join(runtimeDir, process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
      ['-m', 'unittest', 'discover', '-s', 'tests'],
      { cwd: ctDir, env: { ...process.env, BRIDGE_BASE_URL: `http://127.0.0.1:${mutantPort}` } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => resolve({ code, output }))
  })
  await new Promise(resolve => mutant.close(resolve))
  expect(failing.code !== 0, 'a wrong shape must fail the suite')
  expect(/expected string, got int/.test(failing.output), `the failure must name the field: ${failing.output.slice(-200)}`)
  console.log('PASS contract tests: a shape violation fails the suite, naming the field')
} catch (error) {
  failures++
  console.log(`FAIL contract tests: ${error.message}`)
}

console.log('')
console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures} failing check(s))`)
process.exit(failures === 0 ? 0 : 1)

