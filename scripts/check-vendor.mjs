#!/usr/bin/env node
/**
 * Verify that `vendor/` matches `vendor-lock.json`.
 *
 * `pip --target` installs are easy to corrupt: upgrading a package that shares a namespace
 * directory silently removes its sibling's files (see VENDOR.md). This check turns that
 * class of drift into a failing exit code instead of an ImportError at runtime.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const lock = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'vendor-lock.json'), 'utf8')))
const vendor = join(root, 'vendor')

/** dist-info directories normalize `-`/`_` and case, so compare the same way. */
const normalize = name => name.toLowerCase().replace(/_/g, '-')

/** All installed distributions, keyed by normalized name. */
function installed() {
  const found = new Map()
  if (!existsSync(vendor)) return found
  for (const entry of readdirSync(vendor)) {
    const match = /^(.+?)-(\d[^-]*)\.dist-info$/.exec(entry)
    if (match === null) continue
    found.set(normalize(match[1]), { version: match[2], dir: entry })
  }
  return found
}

const have = installed()
const problems = []
for (const [name, version] of Object.entries(lock.packages)) {
  const entry = have.get(normalize(name))
  if (entry === undefined) {
    problems.push(`missing: ${name} ${version}`)
    continue
  }
  if (entry.version !== version) {
    problems.push(`version drift: ${name} expected ${version}, found ${entry.version}`)
  }
}

for (const dir of ['langgraph/graph', 'langgraph/checkpoint/sqlite']) {
  if (!existsSync(join(vendor, dir))) {
    problems.push(`missing module directory: ${dir} (a namespace sibling was overwritten)`)
  }
}

/** Every file below a directory, as sorted relative paths. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') continue
      walk(full, base, out)
    } else if (entry.isFile()) {
      out.push(full.slice(base.length + 1).replace(/\\/g, '/'))
    }
  }
  return out.sort()
}

/**
 * Content digest of the whole vendor tree.
 *
 * Version matching cannot see a package that was replaced or patched in place, and a
 * `--target` install is easy to corrupt. This digest makes any content change visible.
 */
function vendorDigest() {
  const hash = createHash('sha256')
  for (const relative of walk(vendor)) {
    const file = join(vendor, relative)
    // Sizes first: a truncated file changes the digest without hashing twice.
    hash.update(`${relative}\u0000${statSync(file).size}\u0000`)
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

const digest = vendorDigest()
if (process.argv.includes('--record')) {
  lock.contentHash = digest
  writeFileSync(join(root, 'vendor-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  console.log(`recorded vendor content hash ${digest.slice(0, 16)}…`)
} else if (lock.contentHash === undefined) {
  problems.push('vendor-lock.json has no contentHash; run `node scripts/check-vendor.mjs --record` once')
} else if (lock.contentHash !== digest) {
  problems.push(`vendor content changed: expected ${lock.contentHash.slice(0, 16)}…, found ${digest.slice(0, 16)}…`)
}

if (problems.length === 0) {
  console.log(`vendor ok: ${Object.keys(lock.packages).length} packages match vendor-lock.json`)
  process.exit(0)
}
console.error('vendor check failed:')
for (const problem of problems) console.error(`  - ${problem}`)
process.exit(1)
