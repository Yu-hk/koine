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

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadContractFile, writeContractFile, writeFiles } from '../lib/io.js'
import { TARGETS, compare, discover, extract, generate } from '../lib/engine.js'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER = { name: 'polyglot-bridge', version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version }

/** Resolve a tool argument into a contract value. */
async function resolveContract(text, label) {
  if (/^https?:\/\//i.test(text)) {
    const { contract } = await extract({ url: text })
    return contract
  }
  try {
    // A directory is extracted; a file is loaded as a contract.
    return loadContractFile(text)
  } catch {
    const { contract } = await extract({ projectDir: text })
    void label
    return contract
  }
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
      const contract = await resolveContract(args.contract, 'contract')
      const generated = generate(contract, args.target, {
        serviceName: args.serviceName,
        packageName: args.packageName,
        moduleName: args.moduleName,
        baseUrl: args.baseUrl,
      })
      const files = writeFiles(args.outDir, generated.files)
      return `${args.target}: ${files} file(s) in ${args.outDir}${generated.notes?.length ? `\nnotes: ${generated.notes.join('; ')}` : ''}`
    }
    case 'bridge_check': {
      const left = await resolveContract(args.contractA, 'contractA')
      const right = await resolveContract(args.contractB, 'contractB')
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
      case 'initialize':
        return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER })
      case 'notifications/initialized':
        return undefined
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        const text = await callTool(params.name, params.arguments ?? {})
        return reply({ content: [{ type: 'text', text }] })
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
