#!/usr/bin/env node
/**
 * Run every check in order and report one summary.
 *
 * Each check is its own process, so a failure in one cannot leave another half-initialised; the run
 * stops at the first failure, because later checks assume the earlier ones held.
 *
 *   node scripts/verify-all.mjs
 *   node scripts/verify-all.mjs --url http://127.0.0.1:8021   # also gate the service contract
 *
 * Exit codes: 0 everything passed, 1 a check failed, 2 the harness could not run.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const urlIndex = process.argv.indexOf('--url')
const serviceUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined

if (urlIndex >= 0 && serviceUrl === undefined) {
  console.error('--url needs a value, for example --url http://127.0.0.1:8021')
  process.exit(2)
}

/** @type {Array<[string, string, string[]]>} name, script, extra args */
const checks = [
  ['smoke', 'test/smoke.mjs', []],
  ['mcp', 'scripts/check-mcp.mjs', []],
  ['typescript', 'scripts/check-typescript.mjs', []],
  ['vendor', 'scripts/check-vendor.mjs', []],
]
if (serviceUrl !== undefined) {
  checks.push(['service-contract', 'scripts/check-service-contract.mjs', ['--url', serviceUrl]])
}

function run(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

const results = []
for (const [name, script, args] of checks) {
  process.stdout.write(`→ ${name} … `)
  const started = Date.now()
  const { code, output } = await run(script, args)
  const elapsed = Date.now() - started
  results.push({ name, code, elapsed, output })
  console.log(code === 0 ? `ok ${elapsed}ms` : `FAILED ${elapsed}ms`)
  if (code !== 0) {
    // Show only the lines that explain the failure; a full transcript buries it.
    const lines = output.trim().split('\n')
    const interesting = lines.filter(line => /FAIL|error|Error|refused|missing/i.test(line)).slice(0, 12)
    for (const line of (interesting.length > 0 ? interesting : lines.slice(-12))) {
      console.log(`    ${line}`)
    }
    break
  }
}

console.log('')
const passed = results.filter(result => result.code === 0)
console.log(`${passed.length}/${checks.length} check(s) passed`)
for (const result of results) {
  console.log(`  ${result.code === 0 ? '✓' : '✗'} ${result.name.padEnd(16)} ${result.elapsed}ms`)
}
process.exit(results.every(result => result.code === 0) && results.length === checks.length ? 0 : 1)
