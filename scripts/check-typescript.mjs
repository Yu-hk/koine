#!/usr/bin/env node
/**
 * Compile the generated TypeScript client for real.
 *
 * `node test/smoke.mjs` asserts on generated text, which cannot prove the output compiles.
 * This script generates into a scratch directory and runs `tsc --noEmit` with the DOM library,
 * because the client uses `fetch` and `URL`.
 *
 * Run: node scripts/check-typescript.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeContract } from '../lib/ir.js'
import { generateTypeScriptClient } from '../lib/gen-typescript.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = join(root, 'test', '.tscheck')

const contract = makeContract({
  kind: 'openapi',
  name: 'ledger',
  baseUrl: 'http://127.0.0.1:9000',
  operations: [
    {
      id: 'readAccount',
      method: 'GET',
      path: '/accounts/{id}',
      summary: 'Fetch one account by id.',
      params: [
        { in: 'path', name: 'id', required: true, type: { kind: 'scalar', name: 'string' } },
        { in: 'query', name: 'verbose', required: false, type: { kind: 'scalar', name: 'boolean' } },
        { in: 'header', name: 'X-Tenant', required: true, type: { kind: 'scalar', name: 'string' } },
      ],
      responses: [{ status: 200, type: { kind: 'ref', name: 'Account' } }],
      errors: [{ status: 404, type: { kind: 'ref', name: 'Problem' } }],
    },
    {
      id: 'pay',
      method: 'POST',
      path: '/pay',
      summary: 'Pay for an order.',
      params: [],
      requestBody: { kind: 'ref', name: 'Payment' },
      responses: [{ status: 201, type: { kind: 'scalar', name: 'boolean' } }],
    },
    {
      id: 'listStates',
      method: 'GET',
      path: '/states',
      params: [],
      responses: [{ status: 200, type: { kind: 'list', of: { kind: 'enum', name: 'State', values: ['active', 'closed'] } } }],
    },
    {
      id: 'streamThread',
      method: 'GET',
      path: '/threads/{id}/stream',
      summary: 'Server-sent events for a run.',
      streaming: true,
      params: [
        { in: 'path', name: 'id', required: true, type: { kind: 'scalar', name: 'string' } },
      ],
      responses: [{ status: 200, type: { kind: 'scalar', name: 'string' } }],
    },
  ],
  models: [
    { name: 'Account', fields: [
      { name: 'owner', type: { kind: 'scalar', name: 'string' }, required: true },
      { name: 'balance', type: { kind: 'scalar', name: 'decimal' }, required: true },
      { name: 'opened_at', type: { kind: 'scalar', name: 'datetime' }, required: false },
    ] },
    { name: 'Problem', fields: [{ name: 'title', type: { kind: 'scalar', name: 'string' }, required: true }] },
    { name: 'Payment', kind: 'union', discriminator: 'kind', fields: [], variants: [
      { name: 'Card', tag: 'card' }, { name: 'Cash', tag: 'cash' } ] },
    { name: 'Card', fields: [{ name: 'number', type: { kind: 'scalar', name: 'string' }, required: true }] },
    { name: 'Cash', fields: [{ name: 'amount', type: { kind: 'scalar', name: 'double' }, required: true }] },
    { name: 'State', kind: 'enum', fields: [], values: ['active', 'closed'] },
  ],
})

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

for (const file of generateTypeScriptClient(contract, {}).files) {
  const path = join(work, file.path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, file.content, 'utf8')
}

writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ES2022',
    moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['src/**/*.ts'],
}, null, 2), 'utf8')

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(process.execPath, [tsc, '-p', work], { encoding: 'utf8' })

if (result.status === 0) {
  console.log('typescript ok: generated client compiles')
  process.exit(0)
}
console.error('typescript check failed:')
console.error((result.stdout ?? '').trim())
console.error((result.stderr ?? '').trim())
process.exit(1)
