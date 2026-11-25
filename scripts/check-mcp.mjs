#!/usr/bin/env node
/**
 * Smoke-test the MCP server over stdio.
 *
 * The server is a separate process, so this checks the whole transport: handshake, tool listing,
 * one real tool call, and an error path. Run after changing mcp/ or lib/engine.js.
 *
 *   node scripts/check-mcp.mjs
 *
 * Exit codes: 0 pass, 1 a check failed, 2 the harness could not run.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const root = fileURLToPath(new URL('..', import.meta.url))
const server = join(root, 'mcp', 'server.mjs')

const work = mkdtempSync(join(tmpdir(), 'bridge-mcp-'))
mkdirSync(join(work, 'demo'), { recursive: true })
writeFileSync(join(work, 'demo', 'openapi.json'), JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'mcp demo' },
  paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } },
}), 'utf8')

// A contract for the resources assertions, in the root the server is told to scan.
writeFileSync(join(work, 'orders.bridge.json'), JSON.stringify({
  version: 1, kind: 'openapi', name: 'orders', baseUrl: '', operations: [], models: [], warnings: [],
}), 'utf8')

const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, BRIDGE_MCP_ROOT: work },
})
const lines = createInterface({ input: child.stdout })
const waiting = []
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const resolve = waiting.shift()
  if (resolve) resolve(message)
})
const send = message => new Promise(resolve => {
  waiting.push(resolve)
  child.stdin.write(`${JSON.stringify(message)}\n`)
})

let failed = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name} - ${detail}`)
  }
}

try {
  const init = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } } })
  check('handshake names the server', init.result?.serverInfo?.name === 'koine', JSON.stringify(init))
  check('handshake negotiates the version the client asked for', init.result?.protocolVersion === '2025-06-18', JSON.stringify(init.result))

  const list = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = (list.result?.tools ?? []).map(tool => tool.name).sort().join(',')
  check('five tools are exposed', names === 'bridge_check,bridge_discover,bridge_extract,bridge_generate,bridge_validate', names)

  const validated = await send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'bridge_validate', arguments: { contract: join(work, 'orders.bridge.json') } } })
  check('validate accepts a good contract', (validated.result?.content?.[0]?.text ?? '').includes('contract ok'), JSON.stringify(validated.result ?? validated.error))

  const discover = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_discover', arguments: { projectDir: join(work, 'demo') } } })
  const text = discover.result?.content?.[0]?.text ?? ''
  check('discover returns the document', text.includes('openapi.json') && text.includes('1 routes'), JSON.stringify(text))

  const extract = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bridge_extract', arguments: { projectDir: join(work, 'demo') } } })
  check('extract writes a contract', (extract.result?.content?.[0]?.text ?? '').includes('1 route'), JSON.stringify(extract.result ?? extract.error))

  const unknown = await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })
  check('unknown tool reports an error', typeof unknown.error?.message === 'string', JSON.stringify(unknown))

  const resources = await send({ jsonrpc: '2.0', id: 6, method: 'resources/list' })
  const listed = resources.result?.resources ?? []
  check('resources list the contract', listed.some(entry => entry.uri === 'bridge://contracts/orders.bridge.json'), JSON.stringify(listed))

  const read = await send({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'bridge://contracts/orders.bridge.json' } })
  const content = read.result?.contents?.[0]?.text ?? ''
  check('resource read returns the contract', content.includes('"name":"orders"'), content.slice(0, 120) || JSON.stringify(read))

  const schemaListed = listed.some(entry => entry.uri === 'bridge://schema/contract')
  check('the schema resource is listed', schemaListed, listed.map(entry => entry.uri).join(','))
  const schema = await send({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'bridge://schema/contract' } })
  const schemaText = schema.result?.contents?.[0]?.text ?? ''
  check('the schema resource explains the type kinds', schemaText.includes('"kind": "union"') && schemaText.includes('Rules:'), schemaText.slice(0, 120) || JSON.stringify(schema))

  // A contract URI must not be able to read outside the root.
  writeFileSync(join(work, '..', 'escape-probe.json'), '{"secret":true}', 'utf8')
  const escape = await send({ jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'bridge://contracts/../escape-probe.json' } })
  check('a traversal uri is refused', typeof escape.error?.message === 'string', JSON.stringify(escape.result ?? escape.error))

  // A file over the limit is refused instead of being loaded into memory.
  writeFileSync(join(work, 'huge.bridge.json'), 'x'.repeat(9 * 1024 * 1024), 'utf8')
  const huge = await send({ jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri: 'bridge://contracts/huge.bridge.json' } })
  check('an oversized contract is refused', (huge.error?.message ?? '').includes('too large'), JSON.stringify(huge.result ?? huge.error))

  console.log('')
  console.log(failed === 0 ? 'MCP OK' : `MCP FAILED (${failed})`)
  child.kill()
  process.exit(failed === 0 ? 0 : 1)
} catch (error) {
  console.error(`harness error: ${error.message}`)
  child.kill()
  process.exit(2)
}
