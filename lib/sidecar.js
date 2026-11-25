/**
 * Managed Python sidecar for the LangGraph service bundled inside this plugin.
 *
 * The plugin ships its own CPython runtime, its own site-packages, and the service
 * sources, so nothing on the host (no Docker, no system Python) has to provide them. The
 * sidecar is started on demand, health-gated before use, and killed on unload.
 *
 * Because the port is chosen at start, the running instance publishes a discovery file
 * (`service/service.json`) that a consumer in another process — for example a Java service
 * that wants `lab.langgraph.url` — can read instead of having the port configured.
 *
 * Windows only: the vendored interpreter is a Windows x64 build. A different platform
 * needs its own vendored runtime under `runtime/`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')

/** Name of the discovery file a consumer looks for. */
export const DISCOVERY_FILE = 'langgraph-service.json'

/** Identifier of the vendored runtime this process needs, e.g. `win32-x64`. */
export function platformKey() {
  return `${process.platform}-${process.arch}`
}

const runtimeDir = join(root, 'runtime', platformKey())
const pythonName = process.platform === 'win32' ? 'python.exe' : 'bin/python3'

/** Paths of the bundled pieces, relative to the package root. */
export const PATHS = {
  root,
  runtime: runtimeDir,
  python: join(runtimeDir, ...pythonName.split('/')),
  vendor: join(root, 'vendor'),
  service: join(root, 'service'),
  discovery: join(root, 'service', DISCOVERY_FILE),
}

/** Whether this installation carries a runtime, dependencies, and the service sources. */
export function bundled() {
  return existsSync(PATHS.python)
    && existsSync(PATHS.vendor)
    && existsSync(join(PATHS.service, 'service.py'))
}

/** Append-only log next to the bundled service, so a crash leaves evidence behind. */
const LOG_DIR = join(root, 'service', 'logs')
const LOG_FILE = join(LOG_DIR, 'service.log')

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Whether the service answers its health route. */
async function healthy(baseUrl, timeoutMs = 1200) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

/** The bundled service, started once per plugin instance. */
export class LangGraphSidecar {

  constructor(options = {}) {
    this.host = '127.0.0.1'
    this.port = options.port
    this.baseUrl = undefined
    this.child = undefined
    this.starting = undefined
    this.logs = []
    // Project holds on the shared instance: projectDir -> its mirrored discovery file.
    this.projects = new Map()
    // Supervision: false while a stop is intended, so an exit can be classified.
    this.desiredRunning = false
    this.restarts = 0
    this.restartWindowStart = Date.now()
    this.restartTimer = undefined
    this.detached = false
  }

  /** Snapshot for tool output and diagnostics. */
  status() {
    return {
      bundled: bundled(),
      running: this.child !== undefined && this.child.exitCode === null,
      url: this.baseUrl ?? '',
      port: this.port ?? 0,
      python: PATHS.python,
      discovery: PATHS.discovery,
      projects: [...this.projects.keys()],
      logFile: LOG_FILE,
      lastLog: this.logs.slice(-6).join('\n'),
    }
  }

  /**
   * Start if needed and resolve once healthy; concurrent callers share one start.
   *
   * @param options.projectDir optional directory that also receives a discovery file, so a
   *     consumer next to that project's own configuration can read the URL.
   */
  async start(options = {}) {
    if (!bundled()) {
      throw new Error(
        `no bundled runtime for ${platformKey()}: expected an interpreter at ${PATHS.python}. `
        + 'The plugin ships one runtime per platform under runtime/<platform>-<arch>/.')
    }
    this.desiredRunning = true
    if (options.detached === true) this.detached = true
    if (this.starting !== undefined) return this.starting
    const restart = this.restarts > 0
    this.starting = this.#spawnAndWait(options.projectDir, restart).finally(() => { this.starting = undefined })
    return this.starting
  }

  async #spawnAndWait(projectDir, restart = false) {
    if (this.baseUrl !== undefined && await healthy(this.baseUrl)) {
      this.#publish(projectDir)
      return this.baseUrl
    }
    // A fresh start wipes stale traces; a supervised restart keeps the crash evidence.
    if (!restart) {
      this.logs = []
    }
    this.port = this.port ?? await freePort()
    this.baseUrl = `http://${this.host}:${this.port}`
    const env = {
      ...process.env,
      PYTHONPATH: PATHS.vendor,
      PYTHONNOUSERSITE: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    }
    // A detached instance outlives this plugin: its stdio goes to the log file (pipes would
    // close when the plugin unloads) and the child is unref'd so the host can exit.
    let stdio = ['ignore', 'pipe', 'pipe']
    let logDescriptor
    if (this.detached) {
      try {
        mkdirSync(LOG_DIR, { recursive: true })
        logDescriptor = openSync(LOG_FILE, 'a')
        stdio = ['ignore', logDescriptor, logDescriptor]
      } catch {
        stdio = ['ignore', 'ignore', 'ignore']
      }
    }
    this.child = spawn(
      PATHS.python,
      ['-m', 'uvicorn', 'service:app', '--host', this.host, '--port', String(this.port), '--log-level', 'warning'],
      { cwd: PATHS.service, env, windowsHide: true, detached: this.detached, stdio },
    )
    if (logDescriptor !== undefined) {
      try { closeSync(logDescriptor) } catch { /* the child owns its copy now */ }
    }
    if (this.detached) this.child.unref()
    const record = (chunk) => {
      const text = String(chunk).trim()
      if (text.length === 0) return
      this.logs.push(text)
      if (this.logs.length > 200) this.logs.shift()
      // The in-memory ring dies with the process; the file is what survives a crash.
      try {
        mkdirSync(LOG_DIR, { recursive: true })
        appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`, 'utf8')
      } catch {
        // Logging must never break the service.
      }
    }
    this.child.stdout?.on('data', record)
    this.child.stderr?.on('data', record)
    this.child.once('exit', (code) => this.#onExit(code))

    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (this.child === undefined) {
        throw new Error(`bundled service exited before it became ready:\n${this.logs.slice(-20).join('\n')}`)
      }
      if (await healthy(this.baseUrl)) {
        this.#publish(projectDir)
        return this.baseUrl
      }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    this.stop()
    throw new Error(`bundled service did not become ready within 60s:\n${this.logs.slice(-20).join('\n')}`)
  }

  /** Write the discovery record next to the bundled service and, optionally, a project. */
  #publish(projectDir) {
    const record = {
      url: this.baseUrl,
      port: this.port,
      pid: this.child?.pid ?? 0,
      startedAt: new Date().toISOString(),
      runtime: PATHS.python,
    }
    const text = `${JSON.stringify(record, null, 2)}\n`
    try {
      writeFileSync(PATHS.discovery, text, 'utf8')
    } catch {
      // The tool still returns the URL, so a read-only install is not fatal.
    }
    if (typeof projectDir === 'string' && projectDir.trim().length > 0) {
      this.projects.set(projectDir, join(projectDir, DISCOVERY_FILE))
    }
    // Every holder gets the current URL: a supervised restart comes up on a fresh port and
    // has no projectDir of its own, so refreshing only the passed one would leave the others
    // pointing at a dead address.
    for (const [project, target] of this.projects) {
      try {
        writeFileSync(target, text, 'utf8')
      } catch {
        // An unwritable project directory must not break publishing; the canonical file is
        // what a consumer falls back to.
        this.projects.delete(project)
      }
    }
  }

  /**
   * Classify an exit and restart a crashed service, bounded.
   *
   * <p>A stop is intended when `desiredRunning` is false. Otherwise it restarted on the same
   * port, so a consumer holding the discovery URL keeps working; at most three attempts per
   * five minutes, after which the sidecar stays down and the log says why.
   */
  #onExit(code) {
    this.child = undefined
    const line = `[sidecar] service exited (code ${code ?? 'unknown'})`
    this.logs.push(line)
    this.#appendLog(line)
    if (!this.desiredRunning) return
    if (Date.now() - this.restartWindowStart > 300_000) {
      this.restartWindowStart = Date.now()
      this.restarts = 0
    }
    if (this.restarts >= 3) {
      const give = '[sidecar] giving up after 3 restarts in 5 minutes'
      this.logs.push(give)
      this.#appendLog(give)
      return
    }
    this.restarts++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      // The dead child may still hold its port for a moment (Windows keeps the socket in
      // TIME_WAIT), so a restart takes a fresh one and re-publishes discovery instead of
      // racing to bind the same address.
      this.port = undefined
      this.baseUrl = undefined
      this.start().catch((error) => {
        const failed = `[sidecar] restart failed: ${error.message}`
        this.logs.push(failed)
        this.#appendLog(failed)
      })
    }, 1000 * this.restarts)
  }

  /** Append one line to the on-disk service log. */
  #appendLog(line) {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      // Logging must never break supervision.
    }
  }

  /** Stop and start again; used when the service died or hangs. */
  async restart(options = {}) {
    this.stop()
    this.port = undefined
    this.baseUrl = undefined
    return this.start(options)
  }

  /** Kill the process tree; uvicorn spawns children on Windows. */
  /**
   * Release one project's hold, or force the service down.
   *
   * <p>The instance is shared to keep resource use low: `stop({ projectDir })` only removes
   * that project's discovery file and leaves the service running while other projects still
   * hold it. `stop()` with no argument — plugin unload, explicit teardown — always kills it.
   */
  stop(options = {}) {
    // Unloading the plugin must not kill a detached instance: it belongs to whatever starts
    // and stops it explicitly, which is the whole point of starting it detached.
    if (options.dispose === true && this.detached) {
      this.desiredRunning = false
      if (this.restartTimer !== undefined) {
        clearTimeout(this.restartTimer)
        this.restartTimer = undefined
      }
      this.child = undefined
      return
    }
    const project = typeof options.projectDir === 'string' && options.projectDir.trim().length > 0
      ? options.projectDir
      : undefined
    if (project !== undefined) {
      const mirror = this.projects.get(project)
      if (mirror !== undefined) {
        try { rmSync(mirror, { force: true }) } catch { /* best effort */ }
        this.projects.delete(project)
      }
      if (this.projects.size > 0) return
    }
    this.desiredRunning = false
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    this.child = undefined
    for (const mirror of this.projects.values()) {
      try { rmSync(mirror, { force: true }) } catch { /* best effort */ }
    }
    this.projects.clear()
    try { rmSync(PATHS.discovery, { force: true }) } catch { /* best effort */ }
    if (child === undefined) return
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // Killing is best effort; the port is released when the process dies.
    }
  }
}
