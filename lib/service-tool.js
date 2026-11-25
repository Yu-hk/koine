/**
 * `bridge_service` tool: lifecycle for the Python LangGraph service bundled in this plugin.
 *
 * Keeping it as its own module means the sidecar instance lives with the plugin context and
 * is disposed with it, and `index.js` stays about contract handling.
 */

import { LangGraphSidecar } from './sidecar.js'

const sidecar = new LangGraphSidecar()

const OUTPUT = {
  type: 'object',
  properties: {
    bundled: { type: 'boolean' },
    running: { type: 'boolean' },
    url: { type: 'string' },
    port: { type: 'integer' },
    python: { type: 'string' },
    discovery: { type: 'string' },
    projects: { type: 'array', items: { type: 'string' } },
    logFile: { type: 'string' },
    lastLog: { type: 'string' },
  },
  required: ['bundled', 'running', 'url', 'port', 'python', 'discovery', 'projects', 'logFile', 'lastLog'],
  additionalProperties: false,
}

/** Render the service snapshot for the model. */
function render(value) {
  const lines = [
    `**Bundled LangGraph service** - ${value.running ? 'running' : 'stopped'}`,
    '',
    `- runtime present: ${value.bundled}`,
    `- base URL: ${value.url === '' ? '(not started)' : `\`${value.url}\``}`,
    `- discovery file: \`${value.discovery}\``,
    `- projects holding it: ${value.projects.length === 0 ? '(none)' : value.projects.map(project => `\`${project}\``).join(', ')}`,
    `- log file: \`${value.logFile}\``,
    `- python: \`${value.python}\``,
  ]
  if (value.lastLog !== '') {
    lines.push('', 'Last log:', '```text', value.lastLog, '```')
  }
  return lines.join('\n')
}

/**
 * Register the lifecycle tool and tie the sidecar to the plugin's lifetime.
 *
 * @param ctx the plugin context whose tools registry and effect scope receive the work.
 */
export function registerServiceTool(ctx) {
  ctx.effect(() => () => sidecar.stop({ dispose: true }))

  ctx.tools.register({
    name: 'bridge_service',
    description:
      'Start, stop, or inspect the Python LangGraph service that ships inside this plugin. '
      + 'The plugin carries its own CPython runtime and site-packages, so no Docker and no '
      + 'system Python are involved. `start` launches the service on a free loopback port, '
      + 'health-gates it, and publishes a discovery file; pass projectDir to also mirror that '
      + 'file next to a project\'s own configuration, so that project can read the URL without '
      + 'a hard-coded port. A service started normally stops when the plugin unloads; start it '
      + 'detached when it should outlive the editor session and be owned by the project.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop', 'restart'],
          description: '`start` launches and health-gates the service, `stop` releases it, `restart` stops then starts, `status` only reports.',
        },
        projectDir: {
          type: 'string',
          description: 'Consumer project root. On start it also receives langgraph-service.json; on stop it releases only that project, and the shared service keeps running while others still hold it.',
        },
        detached: {
          type: 'boolean',
          description: 'Start the service detached from the plugin process, so unloading the plugin does not stop it. Use it when the service should outlive the editor session and belong to the project instead.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: render(value) }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = args?.action
      const projectDir = typeof args?.projectDir === 'string' ? args.projectDir : undefined
      const detached = args?.detached === true
      if (action === 'start') {
        await sidecar.start({ projectDir, detached })
      } else if (action === 'restart') {
        await sidecar.restart({ projectDir, detached })
      } else if (action === 'stop') {
        sidecar.stop({ projectDir })
      } else if (action !== 'status') {
        throw new Error('`action` must be status, start, stop, or restart')
      }
      return sidecar.status()
    },
  })
}
