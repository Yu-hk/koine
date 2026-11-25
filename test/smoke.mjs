#!/usr/bin/env node
/**
 * Plugin self-test: the contract pipeline and the bundled runtime, no host app involved.
 *
 * Run with `node test/smoke.mjs`. Fixtures are written to a temporary directory so the test
 * is self-contained and leaves nothing behind.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractContract } from '../lib/extract.js'
import { diffContracts, describeType, makeContract, severitySummary } from '../lib/ir.js'
import { generateJavaClient } from '../lib/gen-java.js'
import { generatePythonClient } from '../lib/gen-python.js'
import { bundled } from '../lib/sidecar.js'
import { extractOpenApi } from '../lib/openapi.js'
import { generateJavaServer, generatePythonServer } from '../lib/gen-server.js'
import { generateTypeScriptClient } from '../lib/gen-typescript.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'polyglot-bridge-'))
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

console.log('')
console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures} failing check(s))`)
process.exit(failures === 0 ? 0 : 1)

