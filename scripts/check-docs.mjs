#!/usr/bin/env node
/**
 * Guard the documentation against mechanical damage.
 *
 * A bulk search-and-replace once turned every `s` into `c` in two readmes and every `n` into `o` in
 * two more, and the result was committed because nothing looked at the bytes. A misplaced global
 * substitution has a signature: words that are almost right. This checks for that signature, plus a
 * replacement character and a byte order mark, which are the other two ways a document gets silently
 * mangled.
 *
 *   node scripts/check-docs.mjs
 *
 * Exit codes: 0 clean, 1 a document looks damaged, 2 the check could not run.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SKIP = new Set(['node_modules', '.git', 'runtime', 'vendor', 'service', 'test', 'target', 'dist'])

/** Words that only appear when a character was substituted across a document. */
const SUSPECT = [
  [/\bRectClient\b/, 'RestClient with s→c'],
  [/\bClientc\b/, 'Clients with s→c'],
  [/\brecponce\b/, 'response with s→c'],
  [/\bctandard\b/, 'standard with s→c'],
  [/\bcervice\b/, 'service with s→c'],
  [/\booode\b/, 'node with n→o'],
  [/\bveodor\b/, 'vendor with n→o'],
  [/\bjsoo\b/, 'json with n→o'],
  [/\bruo\b/, 'run with n→o'],
  [/\bsccript\b/, 'script with another substitution'],
]

function markdownFiles(dir = root, depth = 0, out = []) {
  if (depth > 3) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) markdownFiles(full, depth + 1, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

try {
  const files = markdownFiles()
  const problems = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const name = relative(root, file).replace(/\\/g, '/')
    if (text.includes('\uFFFD')) problems.push(`${name}: contains U+FFFD (a byte was lost in a decode)`)
    if (text.startsWith('\uFEFF')) problems.push(`${name}: starts with a byte order mark`)
    for (const [pattern, label] of SUSPECT) {
      const match = text.match(pattern)
      if (match) {
        const line = text.slice(0, match.index).split('\n').length
        problems.push(`${name}:${line}: looks like ${label} (found ${JSON.stringify(match[0])})`)
      }
    }
    if (statSync(file).size === 0) problems.push(`${name}: empty file`)
  }

  if (problems.length > 0) {
    console.error(`docs check failed (${problems.length} problem(s) in ${files.length} file(s)):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`docs ok: ${files.length} markdown file(s) look intact`)
  process.exit(0)
} catch (error) {
  console.error(`docs check could not run: ${error.message}`)
  process.exit(2)
}
