#!/usr/bin/env node
/**
 * MCP server for the bridge, over stdio.
 *
 * Any MCP-capable client (Claude Desktop, Cursor, VS Code, Zed) can now use the same engine the
 * DSH plugin uses. Messages are newline-delimited JSON-RPC, per the MCP stdio transport; there is
 * no dependency, because the protocol surface needed here is four tools and two methods.
 *
 * The engine holds all behaviour. This file only translates MCP arguments into engine calls and
 * results into MCP content, and resolves a contract argument that may be a file, a directory or a
 * live URL.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { writeContractFile, writeFiles } from '../lib/io.js'
import { TARGETS, compare, discover, extract, generate, resolveContract, validateContract } from '../lib/engine.js'

const PROTOCOL_VERSION = '2024-11-05'
/** Versions this server speaks; the client's choice wins when it is one of these. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
/** A contract is a description, not a database dump; refuse anything larger. */
const MAX_READ_BYTES = 8 * 1024 * 1024
const SERVER = { name: 'koine', version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version }

/**
 * Contracts are exposed as resources so a client can list and read them without an extract call.
 * The root is configurable because a server started by an editor does not inherit the project
 * directory: BRIDGE_MCP_ROOT tells it where the contracts live.
 */
const ROOT = process.env.BRIDGE_MCP_ROOT ?? process.cwd()
const CONTRACT_NAME = /^(bridge-contract|[A-Za-z0-9._-]+\.bridge)\.json$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'data', 'dist', 'build', 'vendor', 'runtime', '__pycache__'])

/** Contract files under the root, bounded in depth and count. */
function listContractFiles(dir = ROOT, depth = 0, out = []) {
  if (depth > 4 || out.length > 200) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listContractFiles(full, depth + 1, out)
      continue
    }
    if (entry.isFile() && CONTRACT_NAME.test(entry.name)) out.push(full)
  }
  return out
}

/** `bridge://contracts/<path relative to the root>` */
function contractUri(file) {
  return `bridge://contracts/${relative(ROOT, file).replace(/\\/g, '/')}`
}

/**
 * The contract template, exposed as a resource.
 *
 * A client that composes a contract itself (from source it read, for a framework the extractors do
 * not parse) needs the shape and the rules, not only the tools. Keeping it here rather than in a
 * prompt means it cannot drift from what validateContract checks.
 */
const SCHEMA_URI = 'bridge://schema/contract'
const CONTRACT_TEMPLATE = `{
  "version": 1,
  "kind": "openapi",
  "name": "service-name",
  "baseUrl": "http://127.0.0.1:8080",
  "operations": [
    {
      "id": "readOrder",
      "method": "GET",
      "path": "/orders/{id}",
      "summary": "Fetch one order.",
      "params": [
        { "in": "path", "name": "id", "type": { "kind": "scalar", "name": "string" }, "required": true }
      ],
      "responses": [{ "status": 200, "type": { "kind": "ref", "name": "Order" } }],
      "errors": [{ "status": 404, "type": { "kind": "scalar", "name": "json" } }]
    }
  ],
  "models": [
    { "name": "Order", "fields": [
      { "name": "id", "type": { "kind": "scalar", "name": "string" }, "required": true }
    ] }
  ],
  "warnings": []
}

Rules:
1. version must be 1. Every operation needs id, method, path (starting with /), params, responses.
2. A type is one of:
   { "kind": "scalar", "name": "string|int|double|decimal|boolean|datetime|date|time|uuid|bytes|json|any|void" }
   { "kind": "list", "of": <type> }
   { "kind": "map", "of": <type> }
   { "kind": "ref", "name": "Model" }
   { "kind": "enum", "name": "State", "values": ["active", "closed"] }
   { "kind": "union", "discriminator": "kind", "variants": [{ "name": "Card", "tag": "card" }] }
3. Every ref, enum variant and union variant must name an entry in models.
4. Put anything you could not confirm into warnings[] instead of guessing a type.
5. Do not invent routes. A route that does not exist produces a client that always fails.
6. Errors are separate from responses: success statuses in responses, declared failures in errors.`

/** Resolve a tool argument into a contract value. */
async function resolve(text, label) {
  const { contract } = await resolveContract(text, { label })
  return contract
}

/** Tool definitions, mirroring the plugin's tools so both hosts behave the same. */
const TOOLS = [
  {
    name: 'bridge_discover',
    description: 'Find candidate API documents in a project or on a running service, ranked, with evidence. OpenAPI JSON is high trust, Markdown is pointer-only, YAML is unsupported.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'Directory to scan.' },
        url: { type: 'string', description: 'Running service to probe.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Ranking terms for a local scan.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers for a protected service.' },
      },
    },
  },
  {
    name: 'bridge_extract',
    description: 'Read a contract from a project directory, an exported OpenAPI document, or a running service, and write bridge-contract.json.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string' },
        url: { type: 'string' },
        framework: { type: 'string', description: 'auto, openapi, fastapi, flask, spring or postman.' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        outFile: { type: 'string', description: 'Where to write the contract. Defaults beside or inside the input.' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'bridge_generate',
    description: `Generate a client or server skeleton from a contract. Targets: ${TARGETS.map(entry => entry.id).join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        contract: { type: 'string', description: 'Contract file, project directory or service URL.' },
        target: { type: 'string', enum: TARGETS.map(entry => entry.id) },
        outDir: { type: 'string' },
        serviceName: { type: 'string' },
        packageName: { type: 'string' },
        moduleName: { type: 'string' },
        baseUrl: { type: 'string' },
      },
      required: ['contract', 'target', 'outDir'],
    },
  },
  {
    name: 'bridge_check',
    description: 'Compare two contracts and grade every difference. failOn turns it into a gate: A is the baseline, B the candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        contractA: { type: 'string' },
        contractB: { type: 'string' },
        failOn: { type: 'string', enum: ['none', 'breaking', 'additive'] },
      },
      required: ['contractA', 'contractB'],
    },
  },
  {
    name: 'bridge_validate',
    description: 'Check a contract structurally without generating anything, returning one-line errors that name each problem. Use it after composing a contract from source you read yourself, before generate.',
    inputSchema: {
      type: 'object',
      properties: {
        contract: { type: 'string', description: 'Contract file, project directory or service URL to validate.' },
      },
      required: ['contract'],
    },
  },
]

/** Run one tool and return its text result. */
async function callTool(name, args) {
  switch (name) {
    case 'bridge_discover': {
      const candidates = await discover({ projectDir: args.projectDir, url: args.url, keywords: args.keywords, headers: args.headers })
      if (candidates.length === 0) return 'No API document found. If the service is running, pass url.'
      return candidates.map(entry => `${entry.trust}\t${entry.path}\t${entry.title}\t${entry.routes} routes\t${entry.match || '-'}`).join('\n')
    }
    case 'bridge_extract': {
      const { contract, framework } = await extract({ projectDir: args.projectDir, url: args.url, framework: args.framework, name: args.name, headers: args.headers })
      const base = args.projectDir ?? args.url
      const outFile = args.outFile ?? (args.url !== undefined ? undefined : join(base.replace(/[\\/][^\\/]+$/, ''), 'bridge-contract.json'))
      if (outFile === undefined) throw new Error('outFile is required when extracting from a url')
      writeContractFile(outFile, contract)
      return `${framework} contract: ${contract.operations.length} route(s), ${contract.models.length} model(s) -> ${outFile}`
    }
    case 'bridge_generate': {
      const contract = await resolve(args.contract, 'contract')
      const generated = generate(contract, args.target, {
        serviceName: args.serviceName,
        packageName: args.packageName,
        moduleName: args.moduleName,
        baseUrl: args.baseUrl,
      })
      const files = writeFiles(args.outDir, generated.files)
      return `${args.target}: ${files} file(s) in ${args.outDir}${generated.notes?.length ? `\nnotes: ${generated.notes.join('; ')}` : ''}`
    }
    case 'bridge_validate': {
      // Read a plain file raw: a contract with a bad version must come back as a problem the
      // caller can fix, not as an exception raised while loading it.
      const raw = !/^https?:\/\//i.test(args.contract) && existsSync(args.contract) && statSync(args.contract).isFile()
      if (raw && statSync(args.contract).size > MAX_READ_BYTES) {
        throw new Error(`contract is too large: ${statSync(args.contract).size} bytes, limit ${MAX_READ_BYTES}`)
      }
      const contract = raw ? JSON.parse(readFileSync(args.contract, 'utf8')) : await resolve(args.contract, 'contract')
      const { ok, errors } = validateContract(contract)
      return ok
        ? `contract ok: ${contract.operations.length} route(s), ${contract.models.length} model(s)`
        : `contract has ${errors.length} problem(s):\n${errors.map(error => `- ${error}`).join('\n')}`
    }
    case 'bridge_check': {
      const left = await resolve(args.contractA, 'contractA')
      const right = await resolve(args.contractB, 'contractB')
      const { result, counts, removed, tripped } = compare(left, right, { failOn: args.failOn ?? 'none' })
      const lines = [
        `${result.status}: ${result.onlyInA.length} only in A, ${result.onlyInB.length} only in B, ${result.changed.length} changed`,
        `breaking=${counts.breaking} additive=${counts.additive} cosmetic=${counts.cosmetic} removedRoutes=${removed.routes} removedModels=${removed.models}`,
      ]
      if (tripped) lines.push(`GATE FAILED (failOn=${args.failOn})`)
      return lines.join('\n')
    }
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

/** Handle one JSON-RPC message; returns the response object or undefined for notifications. */
async function handle(message) {
  const { id, method, params } = message
  const reply = result => ({ jsonrpc: '2.0', id, result })
  const failure = error => ({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } })

  try {
    switch (method) {
      case 'initialize': {
        // Answer with a version the client asked for when we speak it: a server that always
        // replies with its own version makes a newer client negotiate down or fail.
        const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined
        const agreed = asked !== undefined && SUPPORTED_PROTOCOLS.includes(asked) ? asked : PROTOCOL_VERSION
        return reply({ protocolVersion: agreed, capabilities: { tools: {}, resources: {} }, serverInfo: SERVER })
      }
      case 'notifications/initialized':
        return undefined
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        const text = await callTool(params.name, params.arguments ?? {})
        return reply({ content: [{ type: 'text', text }] })
      }
      case 'resources/list':
        return reply({
          resources: [
            {
              uri: SCHEMA_URI,
              name: 'contract-schema',
              mimeType: 'text/plain',
              description: 'Shape and rules for a contract you compose yourself',
            },
            ...listContractFiles().map(file => ({
              uri: contractUri(file),
              name: relative(ROOT, file).replace(/\\/g, '/'),
              mimeType: 'application/json',
              description: 'Bridge contract',
            })),
          ],
        })
      case 'resources/read': {
        const uri = String(params?.uri ?? '')
        if (uri === SCHEMA_URI) {
          return reply({ contents: [{ uri, mimeType: 'text/plain', text: CONTRACT_TEMPLATE }] })
        }
        if (!uri.startsWith('bridge://contracts/')) throw new Error(`unsupported uri ${uri}`)
        // Resolve first, then prove the target is still under the root: `bridge://contracts/../..`
        // must not read an arbitrary file, and join() alone cannot stop that.
        const root = resolvePath(ROOT)
        const target = resolvePath(join(root, uri.slice('bridge://contracts/'.length)))
        if (target !== root && !target.startsWith(root + sep)) {
          throw new Error(`uri escapes the root: ${uri}`)
        }
        const stats = statSync(target)
        if (stats.size > MAX_READ_BYTES) {
          throw new Error(`contract is too large: ${stats.size} bytes, limit ${MAX_READ_BYTES}`)
        }
        return reply({ contents: [{ uri, mimeType: 'application/json', text: readFileSync(target, 'utf8') }] })
      }
      case 'ping':
        return reply({})
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } }
    }
  } catch (error) {
    return failure(error)
  }
}

/** Newline-delimited JSON over stdio. */
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const response = await handle(message)
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`)
  }
})
