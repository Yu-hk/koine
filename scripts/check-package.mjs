#!/usr/bin/env node
/**
 * Guard the package manifest.
 *
 * Two defects here were silent rather than loud: a second `files` key overrode the first, so the
 * tarball shipped 41 MB of platform binaries, and `exports` did not list the `lib/` subpaths the
 * documentation tells people to import. Neither broke a test, because nothing looked at what the
 * published package actually contains. This does, using `npm pack --dry-run`.
 *
 *   node scripts/check-package.mjs
 *
 * Exit codes: 0 the manifest and the payload are sound, 1 a check failed, 2 the check could not run.
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const MAX_TARBALL_BYTES = 2 * 1024 * 1024
const MAX_FILE_COUNT = 250
/** Never publish these: platform binaries, rebuilt per platform and far too large. */
const FORBIDDEN = ['runtime', 'vendor', 'node_modules', 'service/data', 'service/logs']

const problems = []
const notes = []

function check(name, condition, detail) {
  if (condition) notes.push(`ok ${name}`)
  else problems.push(`${name}${detail === undefined ? '' : `: ${detail}`}`)
}

try {
  const raw = readFileSync(join(root, 'package.json'), 'utf8')
  const pkg = JSON.parse(raw)

  // A duplicate top-level key is legal JSON and silently wins with the last value.
  const keys = raw
    .split('\n')
    .filter(line => /^ {2}"[A-Za-z0-9_-]+"\s*:/.test(line))
    .map(line => line.trim().split('"')[1])
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
  check('no duplicate top-level keys', duplicates.length === 0, duplicates.join(', '))

  check('files list present', Array.isArray(pkg.files) && pkg.files.length > 0)
  const offenders = (pkg.files ?? []).filter(entry => FORBIDDEN.some(bad => entry === bad || entry.startsWith(`${bad}/`)))
  check('files list excludes binaries and state', offenders.length === 0, offenders.join(', '))

  for (const entry of pkg.files ?? []) {
    if (entry.includes('*')) {
      const [dir, pattern] = [entry.slice(0, entry.lastIndexOf('/')), entry.slice(entry.lastIndexOf('/') + 1)]
      const suffix = pattern.replace('*', '')
      const matches = existsSync(join(root, dir))
        ? readdirSync(join(root, dir)).filter(name => name.endsWith(suffix)).length
        : 0
      check(`files entry has matches: ${entry}`, matches > 0, 'no file matches this pattern')
      continue
    }
    check(`files entry exists: ${entry}`, existsSync(join(root, entry)), 'missing on disk')
  }

  const exportsMap = pkg.exports ?? {}
  check('exports the package root', exportsMap['.'] === './index.js' || typeof exportsMap === '.' === 'string')
  check('exports ./lib/*.js (what the docs import)', './lib/*.js' in exportsMap, Object.keys(exportsMap).join(' '))
  check('exports ./lib/* (extensionless form)', './lib/*' in exportsMap, Object.keys(exportsMap).join(' '))

  const binName = Object.keys(pkg.bin ?? {})[0]
  const binPath = binName === undefined ? undefined : pkg.bin[binName]
  check('bin points at an existing file', binPath !== undefined && existsSync(join(root, binPath)), String(binPath))

  const packing = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, shell: true, encoding: 'utf8' })
  if (packing.status !== 0) {
    problems.push(`npm pack failed: ${(packing.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`)
  } else {
    const report = JSON.parse(packing.stdout.trim())
    const entry = report[report.length - 1]
    notes.push(`payload: ${entry.entryCount} file(s), ${Math.round(entry.unpackedSize / 1024)} KB unpacked, ${Math.round(entry.size / 1024)} KB tarball`)
    check('tarball stays small', entry.size <= MAX_TARBALL_BYTES, `${Math.round(entry.size / 1024)} KB > ${Math.round(MAX_TARBALL_BYTES / 1024)} KB`)
    check('file count stays small', entry.entryCount <= MAX_FILE_COUNT, `${entry.entryCount} > ${MAX_FILE_COUNT}`)
  }

  if (problems.length > 0) {
    console.error(`package check failed (${problems.length} problem(s)):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    for (const note of notes) console.error(`  (${note})`)
    process.exit(1)
  }
  console.log(`package ok: ${notes.filter(note => note.startsWith('payload')).join('; ')}`)
  process.exit(0)
} catch (error) {
  console.error(`package check could not run: ${error.message}`)
  process.exit(2)
}
