/**
 * Polyglot Bridge -a contract-first bridge between language frameworks.
 *
 * Rather than translating one framework into another (which collides with
 * decorators, metaclasses, GC, and lifecycle semantics), this plugin extracts a
 * language-neutral HTTP contract from a project and generates a typed client in
 * another language. The languages never share a runtime; they share an interface
 * description.
 *
 * Tools:
 * - `bridge_extract`  project -contract JSON (Flask or Spring)
 * - `bridge_generate` contract -Java or Python client sources
 * - `bridge_check`    contract vs contract -drift report
 *
 * @module polyglot-bridge
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compare, discover as discoverApi, extract as extractApi, resolveContract, validateContract } from './lib/engine.js'
import { registerServiceTool } from './lib/service-tool.js'
import { generateJavaClient } from './lib/gen-java.js'
import { generatePythonClient } from './lib/gen-python.js'
import { diffContracts, severityOf } from './lib/ir.js'
import { renderDriftMarkdown } from './lib/check.js'
import {
  assertWritableTarget, loadContractFile, resolvePath, writeContractFile, writeFiles,
} from './lib/io.js'

/** Plugin name used by loader diagnostics. */
export const name = 'polyglot-bridge'

/** Services this plugin needs. */
export const inject = ['tools', 'workingDirectory']

/** Contract file written next to a project when no output path is given. */
const DEFAULT_CONTRACT = 'bridge-contract.json'

/** Output schema of `bridge_extract`. */
const EXTRACT_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    framework: { type: 'string' },
    contractPath: { type: 'string' },
    service: { type: 'string' },
    baseUrl: { type: 'string' },
    counts: {
      type: 'object',
      properties: {
        operations: { type: 'integer' },
        models: { type: 'integer' },
        warnings: { type: 'integer' },
        files: { type: 'integer' },
      },
      required: ['operations', 'models', 'warnings', 'files'],
      additionalProperties: false,
    },
    routes: { type: 'array', items: { type: 'string' } },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          message: { type: 'string' },
          line: { type: 'integer' },
        },
        required: ['file', 'message'],
        additionalProperties: false,
      },
    },
  },
  required: ['ok', 'framework', 'contractPath', 'service', 'baseUrl', 'counts', 'routes', 'warnings'],
  additionalProperties: false,
}

/** Output schema of `bridge_generate`. */
const GENERATE_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    target: { type: 'string' },
    outDir: { type: 'string' },
    service: { type: 'string' },
    className: { type: 'string' },
    packageName: { type: 'string' },
    moduleName: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'target', 'outDir', 'service', 'className', 'files', 'notes'],
  additionalProperties: false,
}

/** Output schema of `bridge_check`. */
const CHECK_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string' },
    contractA: { type: 'string' },
    contractB: { type: 'string' },
    reportPath: { type: 'string' },
    summary: {
      type: 'object',
      properties: {
        onlyInA: { type: 'integer' },
        onlyInB: { type: 'integer' },
        changed: { type: 'integer' },
        modelsOnlyInA: { type: 'integer' },
        modelsOnlyInB: { type: 'integer' },
        modelsChanged: { type: 'integer' },
      },
      required: ['onlyInA', 'onlyInB', 'changed', 'modelsOnlyInA', 'modelsOnlyInB', 'modelsChanged'],
      additionalProperties: false,
    },
    details: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'status', 'contractA', 'contractB', 'reportPath', 'summary', 'details'],
  additionalProperties: false,
}

/** Read a required non-empty string argument. */
function requireString(args, key) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`\`${key}\` must be a non-empty string`)
  }
  return value.trim()
}

/** Read an optional non-empty string argument. */
function optionalString(args, key) {
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`\`${key}\` must be a string when present`)
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Resolve a path against the session working directory. */
async function sessionPath(ctx, agent, candidate) {
  let base = process.cwd()
  try {
    if (agent !== undefined) base = await ctx.workingDirectory.ensure(agent)
  } catch {
    // Fall back to the host process directory; the tool reports resolved paths.
  }
  return resolvePath(base, candidate)
}

/** Load a tool input that may be a contract file, a project directory, or a live service. */
async function contractFromArgument(ctx, agent, candidate, label) {
  const text = String(candidate)
  // A URL is absolute; anything else resolves against the session working directory first, then
  // the shared resolver decides whether it is a file or a project.
  if (/^https?:\/\//i.test(text)) {
    return resolveContract(text, { label })
  }
  const resolved = await sessionPath(ctx, agent, candidate)
  return resolveContract(resolved, { label })
}

/** Render the `bridge_extract` result for the model. */
function renderExtract(value) {
  const lines = [
    `**Bridge contract extracted** - \`${value.framework}\` service \`${value.service}\``,
    '',
    `- routes: ${value.counts.operations}`,
    `- models: ${value.counts.models}`,
    `- files scanned: ${value.counts.files}`,
    `- base URL hint: \`${value.baseUrl}\``,
    `- contract: \`${value.contractPath}\``,
  ]
  if (value.routes.length > 0) {
    lines.push('', 'Routes:')
    for (const route of value.routes.slice(0, 25)) lines.push(`- \`${route}\``)
    if (value.routes.length > 25) lines.push(`- -${value.routes.length - 25} more in the contract file`)
  }
  if (value.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of value.warnings.slice(0, 10)) {
      lines.push(`- \`${warning.file}${warning.line === undefined ? '' : `:${warning.line}`}\` ${warning.message}`)
    }
    if (value.warnings.length > 10) lines.push(`- -${value.warnings.length - 10} more in the contract file`)
  }
  lines.push(
    '',
    'Next: `bridge_generate` turns this contract into a typed client, and `bridge_check` compares it with another contract.',
  )
  return lines.join('\n')
}

/** Render the `bridge_generate` result for the model. */
function renderGenerate(value) {
  const identity = value.packageName !== undefined
    ? `\`${value.packageName}.${value.className}\``
    : `\`${value.moduleName}.${value.className}\``
  const lines = [
    `**${value.target} generated** - ${identity}`,
    '',
    `- service: \`${value.service}\``,
    `- output: \`${value.outDir}\``,
    `- files: ${value.files.length}`,
  ]
  if (value.files.length > 0) {
    lines.push('')
    for (const file of value.files.slice(0, 20)) lines.push(`- \`${file}\``)
    if (value.files.length > 20) lines.push(`- -${value.files.length - 20} more`)
  }
  if (value.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of value.notes) lines.push(`- ${note}`)
  }
  lines.push('', `Integration notes are in \`${value.outDir}/README-BRIDGE.md\`.`)
  return lines.join('\n')
}

/** Render the `bridge_check` result for the model. */
function renderCheck(value) {
  const lines = [
    `**${value.status === 'in-sync' ? 'In sync' : 'Drift'}** - \`${value.contractA}\` vs \`${value.contractB}\``,
    '',
    `- routes only in A: ${value.summary.onlyInA}`,
    `- routes only in B: ${value.summary.onlyInB}`,
    `- routes changed: ${value.summary.changed}`,
    `- models only in A/B: ${value.summary.modelsOnlyInA}/${value.summary.modelsOnlyInB}`,
    `- models changed: ${value.summary.modelsChanged}`,
  ]
  if (value.details.length > 0) {
    lines.push('')
    for (const detail of value.details.slice(0, 15)) lines.push(`- ${detail}`)
    if (value.details.length > 15) lines.push(`- -${value.details.length - 15} more in the report`)
  }
  lines.push('', `Full report: \`${value.reportPath}\``)
  return lines.join('\n')
}

/**
 * Register the three bridge tools.
 *
 * Each tool is self-contained: the contract is the only state that crosses a
 * call, so a conversion can be re-run or resumed at any point.
 */
export function apply(ctx) {
  registerServiceTool(ctx)

  ctx.tools.register({
    name: 'bridge_extract',
    description:
      'Read a FastAPI, Flask, or Spring project, an exported OpenAPI document, or a running service\'s own document, and write its HTTP bridge contract: every route, HTTP method, '
      + 'path and query parameter with a language-neutral type, request-body presence, response status, '
      + 'and the data models. The contract is the shared artifact between languages: `bridge_generate` '
      + 'turns it into a client in another language and `bridge_check` compares two contracts. '
      + 'Static analysis only: routes registered dynamically or built from computed strings are reported '
      + 'as warnings instead of being resolved.',
    parameters: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'FastAPI, Flask, or Spring project root, or a project carrying an exported openapi.json/swagger.json; relative paths resolve against the session working directory.' },
        framework: { type: 'string', enum: ['auto', 'openapi', 'fastapi', 'flask', 'spring', 'postman'], description: 'Adapter to use. Defaults to auto, which probes the tree and prefers an exported OpenAPI document when present. For a framework this plugin does not parse, export its OpenAPI document (or point at a running service with `url`) instead of asking for a new extractor. `postman` reads a collection file: routes and parameters are reliable there, response models are not.' },
        url: { type: 'string', description: 'Base URL of a running service to read its own OpenAPI document from; alternative to projectDir. Tries /openapi.json, /v3/api-docs, /swagger.json.' },
        headers: {
          type: 'object',
          description: 'Request headers for a service that protects its own document, e.g. {"authorization": "Bearer …"}. Only used with url.',
          additionalProperties: { type: 'string' },
        },
        outFile: { type: 'string', description: `Contract file to write. Defaults to \`${DEFAULT_CONTRACT}\` inside the project directory.` },
        name: { type: 'string', description: 'Service name recorded in the contract. Defaults to the project directory name.' },
      },
      required: [],
    },
    output: {
      schema: EXTRACT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderExtract(value) }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const framework = optionalString(args, 'framework') ?? 'auto'
      if (!['auto', 'openapi', 'fastapi', 'flask', 'spring', 'postman'].includes(framework)) {
        throw new Error('`framework` must be auto, openapi, flask, fastapi, spring, or postman')
      }
      const url = optionalString(args, 'url')
      let contract
      let detected
      let defaultDir
      if (url !== undefined) {
        // A running service describes itself; this costs nothing and reflects what is really
        // deployed, which can differ from the source tree.
        const headers = args.headers !== null && typeof args.headers === 'object' ? args.headers : undefined
        const fetched = await extractApi({ url, name: optionalString(args, 'name'), headers })
        contract = fetched.contract
        detected = fetched.framework
        defaultDir = undefined
        if (args.outFile === undefined) {
          throw new Error('`outFile` is required when extracting from a url: there is no project directory to default to')
        }
      } else {
        const projectDir = await sessionPath(ctx, exec.agent, requireString(args, 'projectDir'))
        if (!existsSync(projectDir)) {
          throw new Error(`project directory does not exist: ${projectDir}`)
        }
        // A Postman collection is a file, so a file is accepted when it is one.
        if (!statSync(projectDir).isDirectory() && !/postman[_-]?collection\.json$/i.test(projectDir)) {
          throw new Error(`project directory does not exist: ${projectDir}`)
        }
        const extracted = await extractApi({
          projectDir,
          framework,
          name: optionalString(args, 'name'),
        })
        contract = extracted.contract
        detected = extracted.framework
        // A collection is a file, so the contract goes beside it; a project directory receives
        // the contract inside itself.
        defaultDir = statSync(projectDir).isDirectory()
          ? projectDir
          : projectDir.replace(/[\\/][^\\/]+$/, '')
      }
      const outFile = args.outFile === undefined
        ? join(defaultDir, DEFAULT_CONTRACT)
        : await sessionPath(ctx, exec.agent, requireString(args, 'outFile'))
      writeContractFile(outFile, contract)
      return {
        ok: true,
        framework: detected,
        contractPath: outFile,
        service: contract.name,
        baseUrl: contract.baseUrl,
        counts: {
          operations: contract.operations.length,
          models: contract.models.length,
          warnings: contract.warnings.length,
          files: contract.source.files,
        },
        routes: contract.operations.slice(0, 200).map(operation => `${operation.method} ${operation.path} (${operation.id})`),
        warnings: contract.warnings.slice(0, 200).map(warning => ({
          file: warning.file,
          message: warning.message,
          ...(warning.line === undefined ? {} : { line: warning.line }),
        })),
      }
    },
  })

  ctx.tools.register({
    name: 'bridge_discover',
    description:
      'Find candidate API documents under a project directory, ranked by how well they match the '
      + 'given keywords, instead of trusting one file the user remembers. Returns every candidate '
      + 'with the evidence: which keyword matched where, route count, and a trust level. Machine '
      + 'readable documents (OpenAPI/Swagger JSON) are `high`; Markdown is `pointer-only`, a hint '
      + 'where to look, never a contract source. YAML documents are not parsed yet. Choose one '
      + 'candidate and pass it to `bridge_extract`; when two candidates disagree, extract both and '
      + 'run `bridge_check` to see the drift.',
    parameters: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'Directory to scan; relative paths resolve against the session working directory.' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Terms to rank candidates against, for example the service name or a route segment. Empty lists everything found.',
        },
        url: { type: 'string', description: 'Base URL of a running service to probe for documents instead of scanning a directory.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers for a protected service; only used with url.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          projectDir: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                path: { type: 'string' },
                title: { type: 'string' },
                routes: { type: 'integer' },
                match: { type: 'string' },
                trust: { type: 'string' },
              },
              required: ['kind', 'path', 'title', 'routes', 'match', 'trust'],
              additionalProperties: false,
            },
          },
        },
        required: ['projectDir', 'candidates'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (value.candidates.length === 0) {
          return [{ type: 'text', text: `**No API document found** under \`${value.projectDir}\`.\n\nIf the service is running, read its own document with \`bridge_extract({ url })\`.` }]
        }
        const rows = value.candidates.map(candidate =>
          `| ${candidate.trust} | \`${candidate.path}\` | ${candidate.title} | ${candidate.routes} | ${candidate.match || '—'} |`)
        return [{
          type: 'text',
          text: [
            `**${value.candidates.length} candidate(s)** under \`${value.projectDir}\``, '',
            '| Trust | Path | Title | Routes | Match |',
            '| --- | --- | --- | --- | --- |',
            ...rows, '',
            'Pick one and pass it to `bridge_extract`. `pointer-only` rows are hints, not contracts.',
          ].join('\n'),
        }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = optionalString(args, 'url')
      const headers = args.headers !== null && typeof args.headers === 'object' ? args.headers : undefined
      if (url !== undefined) {
        return { projectDir: url, candidates: await discoverApi({ url, headers }) }
      }
      const projectDir = await sessionPath(ctx, exec.agent, requireString(args, 'projectDir'))
      const keywords = Array.isArray(args.keywords) ? args.keywords.map(String) : []
      return { projectDir, candidates: await discoverApi({ projectDir, keywords }) }
    },
  })

  ctx.tools.register({
    name: 'bridge_generate',
    description:
      'Generate a typed HTTP client from a bridge contract so code in another language can call the service. '
      + 'Targets: `java-client` (Spring RestClient plus Jackson records), `python-client` (standard-library '
      + 'urllib plus dataclasses, no third-party dependency), `typescript-client` (fetch plus generated '
      + 'interfaces, streaming endpoints as async generators), `java-server` (Spring MVC interface plus records '
      + 'that a @RestController implements), `python-server` (FastAPI router skeleton plus pydantic models) '
      + 'and `python-contract-tests` (a stdlib unittest suite that calls the service and checks each response against the declared shape; run it with BRIDGE_BASE_URL set). '
      + 'The client targets call another service; the server targets are the skeleton that service implements. '
      + 'Writes the sources and README-BRIDGE.md into '
      + 'outDir; refuses a non-empty directory this plugin did not generate unless overwrite is true.',
    parameters: {
      type: 'object',
      properties: {
        contract: { type: 'string', description: 'Path to a contract JSON file produced by `bridge_extract`.' },
        target: { type: 'string', enum: ['java-client', 'python-client', 'typescript-client', 'java-server', 'python-server', 'python-contract-tests'], description: 'Language and side to generate for; the client targets call another service, the server targets are the skeleton that service implements.' },
        outDir: { type: 'string', description: 'Directory to write into; sources land under language-standard paths.' },
        serviceName: { type: 'string', description: 'Overrides the service name used for class, module, and package names.' },
        packageName: { type: 'string', description: 'Java only: base package. Defaults to com.example.<service>.bridge.' },
        moduleName: { type: 'string', description: 'Python only: importable package directory name.' },
        baseUrl: { type: 'string', description: 'Overrides the base URL recorded in the contract.' },
        overwrite: { type: 'boolean', description: 'Write even into a non-empty directory this plugin did not generate.' },
      },
      required: ['contract', 'target', 'outDir'],
    },
    output: {
      schema: GENERATE_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderGenerate(value) }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const target = requireString(args, 'target')
      const targets = ['java-client', 'python-client', 'typescript-client', 'java-server', 'python-server', 'python-contract-tests']
      if (!targets.includes(target)) {
        throw new Error(`\`target\` must be one of ${targets.join(', ')}`)
      }
      const contractPath = await sessionPath(ctx, exec.agent, requireString(args, 'contract'))
      const contract = loadContractFile(contractPath)
      // Refuse a contract this build does not understand instead of generating something that
      // looks right and is subtly wrong.
      const { IR_VERSION } = await import('./lib/ir.js')
      if (contract.version !== IR_VERSION) {
        throw new Error(
          `contract IR version ${contract.version} does not match this plugin's IR version ${IR_VERSION}; `
          + 'either upgrade the plugin or re-extract the contract with it')
      }
      const outDir = await sessionPath(ctx, exec.agent, requireString(args, 'outDir'))
      assertWritableTarget(outDir, args.overwrite === true)

      const options = {
        serviceName: optionalString(args, 'serviceName') ?? contract.name,
        packageName: optionalString(args, 'packageName'),
        moduleName: optionalString(args, 'moduleName'),
        baseUrl: optionalString(args, 'baseUrl') ?? contract.baseUrl,
      }
      const { generate } = await import('./lib/engine.js')
      const generated = generate(contract, target, options)
      const files = writeFiles(outDir, generated.files)

      // Provenance: which plugin, which IR, which contract produced this code. Committed with the
      // sources so a regenerated tree can be compared instead of guessed at.
      const fsModule = await import('node:fs')
      const cryptoModule = await import('node:crypto')
      const contractText = fsModule.readFileSync(contractPath, 'utf8')
      const manifest = {
        plugin: JSON.parse(fsModule.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version,
        ir: contract.version,
        contractHash: `sha256:${cryptoModule.createHash('sha256').update(contractText).digest('hex')}`,
        contractName: contract.name,
        target,
        generatedAt: new Date().toISOString(),
      }
      const manifestPath = join(outDir, '.bridge-manifest.json')
      fsModule.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      return {
        ok: true,
        target,
        outDir,
        service: contract.name,
        className: generated.className ?? '',
        ...(generated.packageName === undefined ? {} : { packageName: generated.packageName }),
        ...(generated.moduleName === undefined ? {} : { moduleName: generated.moduleName }),
        files,
        notes: generated.notes ?? [],
      }
    },
  })

  ctx.tools.register({
    name: 'bridge_check',
    description:
      'Compare two bridge contracts and report interface drift: routes present on only one side, changed '
      + 'parameter types or requiredness, changed request and response shapes, and model field differences. '
      + 'Each input may be a contract JSON file, a project directory, or an http(s) URL of a running '
      + 'service, and a URL or directory is extracted first. Writes bridge-drift.md and bridge-drift.json '
      + 'and returns a bounded summary. `failOn` turns the comparison into a gate: A is the baseline and '
      + 'B the candidate, so `failOn: "breaking"` fails the call (and prints the counts) when the new '
      + 'document would remove a route or model, change a type, or tighten a requirement.',
    parameters: {
      type: 'object',
      properties: {
        contractA: { type: 'string', description: 'Side A: a contract file, a project directory, or an http(s) URL of a running service.' },
        contractB: { type: 'string', description: 'Side B: a contract file, a project directory, or an http(s) URL of a running service.' },
        failOn: {
          type: 'string',
          enum: ['none', 'breaking', 'additive'],
          description: 'Gate: fail the call when the drift reaches this severity (A is the baseline, B the candidate). `breaking` blocks removed routes, type changes and tightened requirements; `additive` also blocks new optional surface. Use it when deciding whether a new document can replace the current contract.',
        },
        outDir: { type: 'string', description: 'Where to write the reports. Defaults to the directory of contract A.' },
      },
      required: ['contractA', 'contractB'],
    },
    output: {
      schema: CHECK_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderCheck(value) }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const left = await contractFromArgument(ctx, exec.agent, requireString(args, 'contractA'), 'contractA')
      const right = await contractFromArgument(ctx, exec.agent, requireString(args, 'contractB'), 'contractB')
      const outDir = args.outDir === undefined
        ? (left.extracted ? left.path : dirname(left.path))
        : await sessionPath(ctx, exec.agent, requireString(args, 'outDir'))

      // One diff serves the report and the gate. Grading twice could disagree if the rules changed
      // in one place only, and it is the same data either way.
      const comparison = compare(left.contract, right.contract, { failOn: optionalString(args, 'failOn') ?? 'none' })
      const result = comparison.result
      const reportPath = join(outDir, 'bridge-drift.md')
      writeFiles(outDir, [
        { path: 'bridge-drift.md', content: renderDriftMarkdown(result, left.contract, right.contract) },
        {
          path: 'bridge-drift.json',
          content: `${JSON.stringify({
            a: { path: left.path, name: left.contract.name, kind: left.contract.kind },
            b: { path: right.path, name: right.contract.name, kind: right.contract.kind },
            status: result.status,
            summary: result.summary,
            onlyInA: result.onlyInA,
            onlyInB: result.onlyInB,
            changed: result.changed,
            models: result.models,
          }, undefined, 2)}\n`,
        },
      ])

      const details = []
      for (const entry of result.onlyInA.slice(0, 20)) details.push(`only in A: \`${entry.key}\``)
      for (const entry of result.onlyInB.slice(0, 20)) details.push(`only in B: \`${entry.key}\``)
      for (const entry of result.changed.slice(0, 20)) {
        const tagged = entry.details.slice(0, 3).map(detail => `[${severityOf(detail)}] ${detail}`)
        details.push(`changed \`${entry.key}\`: ${tagged.join('; ')}`)
      }
      for (const name of result.models.onlyInA.slice(0, 10)) details.push(`model only in A: \`${name}\``)
      for (const name of result.models.onlyInB.slice(0, 10)) details.push(`model only in B: \`${name}\``)
      for (const entry of result.models.changed.slice(0, 10)) {
        details.push(`model \`${entry.name}\`: ${entry.details.slice(0, 3).join('; ')}`)
      }

      // Gate: A is the baseline, B the candidate. The grading lives in the engine so this tool and
      // any other host cannot drift apart on what "breaking" means.
      if (comparison.tripped) {
        const { counts, removed } = comparison
        throw new Error(
          `contract gate failed (failOn=${comparison.failOn}): ${counts.breaking} breaking, ${counts.additive} additive, `
          + `${counts.cosmetic} cosmetic, ${removed.routes} route(s) only in A, `
          + `${removed.models} model(s) only in A. Full report: ${reportPath}`)
      }

      return {
        ok: result.status === 'in-sync',
        status: result.status,
        contractA: left.path,
        contractB: right.path,
        reportPath,
        summary: {
          onlyInA: result.summary.onlyInA,
          onlyInB: result.summary.onlyInB,
          changed: result.summary.changed,
          modelsOnlyInA: result.summary.modelsOnlyInA,
          modelsOnlyInB: result.summary.modelsOnlyInB,
          modelsChanged: result.summary.modelsChanged,
        },
        details,
      }
    },
  })

  ctx.tools.register({
    name: 'bridge_validate',
    description:
      'Check a contract structurally without generating anything, returning one-line errors that name '
      + 'each problem. Use it after composing a contract yourself, for example from source you read for '
      + 'a framework this plugin does not parse: read the shape from the MCP resource '
      + 'bridge://schema/contract, write the contract, validate, fix, then `bridge_generate`. It '
      + 'extracts nothing and writes no files.',
    parameters: {
      type: 'object',
      properties: {
        contract: { type: 'string', description: 'Contract file, project directory, or an http(s) URL of a running service.' },
      },
      required: ['contract'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          ok: { type: 'boolean' },
          routes: { type: 'number' },
          models: { type: 'number' },
          errors: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'ok', 'routes', 'models', 'errors'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `**Contract valid** - \`${value.path}\`\n\n- routes: ${value.routes}\n- models: ${value.models}\n\nReady for \`bridge_generate\`.`
          : `**Contract invalid** - \`${value.path}\`\n\n${value.errors.map(error => `- ${error}`).join('\n')}`,
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const resolved = await sessionPath(ctx, exec.agent, requireString(args, 'contract'))
      // Read a plain file raw: a contract with a bad version has to come back as a fixable problem
      // rather than as an exception raised while loading it.
      const isFile = existsSync(resolved) && statSync(resolved).isFile()
      const contract = isFile
        ? JSON.parse(readFileSync(resolved, 'utf8'))
        : (await resolveContract(resolved, { label: 'contract' })).contract
      const { ok, errors } = validateContract(contract)
      return {
        path: resolved,
        ok,
        routes: (contract.operations ?? []).length,
        models: (contract.models ?? []).length,
        errors,
      }
    },
  })
}
