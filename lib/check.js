/**
 * Contract comparison and the drift report.
 *
 * Two contracts describe the same interface when their operations match by
 * `METHOD path`; everything else — parameter types, requiredness, response
 * shapes, model fields — is reported per key so a mismatch is actionable.
 */

import { severityOf } from './ir.js'

/** Render the human-readable drift report. */
export function renderDriftMarkdown(result, left, right) {
  const lines = [
    '# Bridge contract drift',
    '',
    `A: \`${left.name}\` (${left.kind}) — ${left.operations.length} route(s), ${left.models.length} model(s)`,
    `B: \`${right.name}\` (${right.kind}) — ${right.operations.length} route(s), ${right.models.length} model(s)`,
    '',
    result.status === 'in-sync'
      ? '**In sync.** No interface difference was found.'
      : `**Drift.** ${result.summary.onlyInA + result.summary.onlyInB + result.summary.changed} route difference(s), `
        + `${result.summary.modelsOnlyInA + result.summary.modelsOnlyInB + result.summary.modelsChanged} model difference(s).`,
    '',
  ]
  if (result.onlyInA.length > 0) {
    lines.push('## Only in A', '', 'These are callable on A but missing from B:')
    lines.push('')
    for (const entry of result.onlyInA) lines.push(`- \`${entry.key}\`${entry.summary ? ` — ${entry.summary}` : ''}`)
    lines.push('')
  }
  if (result.onlyInB.length > 0) {
    lines.push('## Only in B', '', 'These are callable on B but missing from A:')
    lines.push('')
    for (const entry of result.onlyInB) lines.push(`- \`${entry.key}\`${entry.summary ? ` — ${entry.summary}` : ''}`)
    lines.push('')
  }
  if (result.changed.length > 0) {
    lines.push('## Changed routes', '')
    for (const entry of result.changed) {
      lines.push(`### \`${entry.key}\``, '')
      for (const detail of entry.details) lines.push(`- [${severityOf(detail)}] ${detail}`)
      lines.push('')
    }
  }
  const modelLines = []
  if (result.models.onlyInA.length > 0) modelLines.push(`Only in A: ${result.models.onlyInA.map(name => `\`${name}\``).join(', ')}`)
  if (result.models.onlyInB.length > 0) modelLines.push(`Only in B: ${result.models.onlyInB.map(name => `\`${name}\``).join(', ')}`)
  for (const entry of result.models.changed) {
    modelLines.push(`\`${entry.name}\`: ${entry.details.join('; ')}`)
  }
  if (modelLines.length > 0) {
    lines.push('## Changed models', '')
    for (const line of modelLines) lines.push(`- ${line}`)
    lines.push('')
  }
  lines.push(
    '## Reading this report',
    '',
    'A route difference is not automatically a bug: a service may legitimately expose more'
    + ' operations than its consumer calls. Treat "only in B" as an unimplemented consumer path'
    + ' and "changed" as a contract break that needs a decision.',
    '',
  )
  return lines.join('\n')
}

/** Build a compact, model-facing summary of a drift result. */
