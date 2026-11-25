#!/usr/bin/env node
/**
 * Guard the bundled service's own interface.
 *
 * `service/service.py` is a contract its consumers generate clients from, so a change there is a
 * contract change. This compares the live service against the frozen
 * `service/bridge-contract.json` and fails on anything breaking, which is the same gate the
 * project-side integration uses.
 *
 *   node scripts/check-service-contract.mjs --url http://127.0.0.1:8021
 *
 * Exit codes: 0 identical or additive only, 1 breaking drift, 2 the check could not run.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { diffContracts, severityOf } from '../lib/ir.js'
import { fetchOpenApi } from '../lib/openapi.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const frozen = join(root, 'service', 'bridge-contract.json')

const index = process.argv.indexOf('--url')
const url = index >= 0 ? process.argv[index + 1] : undefined

try {
  // Strip a BOM: PowerShell writes one on Windows and JSON.parse rejects it.
  const baseline = JSON.parse(readFileSync(frozen, 'utf8').replace(/^\uFEFF/, ''))
  if (url === undefined) {
    console.log(`frozen service contract: ${baseline.operations.length} route(s), ${baseline.models.length} model(s)`)
    console.log('pass --url <service> to compare it against a running instance')
    process.exit(0)
  }
  const live = await fetchOpenApi(url)
  const result = diffContracts(baseline, live.contract)

  const counts = { breaking: 0, additive: 0, cosmetic: 0 }
  for (const entry of [...result.changed, ...result.models.changed]) {
    for (const detail of entry.details) counts[severityOf(detail)] += 1
  }
  const removedRoutes = result.onlyInA.length
  const removedModels = result.models.onlyInA.length
  const added = result.onlyInB.length + result.models.onlyInB.length

  if (result.status === 'in-sync') {
    console.log(`service contract ok: ${baseline.operations.length} route(s) match the frozen contract`)
    process.exit(0)
  }

  const summary = `${counts.breaking} breaking, ${counts.additive} additive, ${counts.cosmetic} cosmetic, `
    + `${removedRoutes} route(s) removed, ${removedModels} model(s) removed, ${added} added`
  if (counts.breaking > 0 || removedRoutes > 0 || removedModels > 0) {
    console.error(`service contract drifted (breaking): ${summary}`)
    for (const entry of result.onlyInA.slice(0, 10)) console.error(`  removed route: ${entry.key}`)
    for (const entry of result.changed.slice(0, 10)) console.error(`  changed: ${entry.key}: ${entry.details[0]}`)
    for (const name of result.models.onlyInA.slice(0, 10)) console.error(`  removed model: ${name}`)
    process.exit(1)
  }
  console.log(`service contract compatible: ${summary}`)
  process.exit(0)
} catch (error) {
  console.error(`check failed: ${error.message}`)
  process.exit(2)
}
