/**
 * Flask → bridge contract extractor.
 *
 * Reuses the route/model scanner and maps its Python-flavoured findings onto the
 * neutral IR. A Flask URL rule and its Spring equivalent are the same interface,
 * so `/users/<int:user_id>` and `/users/{userId}` converge here.
 */

import { basename } from 'node:path'
import { scanProject } from './flask-scan.js'
import { JSON_TYPE, VOID_TYPE, fromPythonType, makeContract, scalar } from './ir.js'
import { toCamel } from './naming.js'

/** Normalize a Flask URL rule into a Spring/OpenAPI style path template. */
function toPathTemplate(rule) {
  const path = String(rule ?? '')
    .replace(/<([A-Za-z_]\w*):([A-Za-z_]\w*)>/g, (_all, _converter, name) => `{${name}}`)
    .replace(/<([A-Za-z_]\w*)>/g, (_all, name) => `{${name}}`)
    .replace(/\/{2,}/g, '/')
  if (path.length === 0) return '/'
  return path.startsWith('/') ? path : `/${path}`
}

/** Join a blueprint prefix with a route rule. */
function joinPath(base, path) {
  const left = String(base ?? '').replace(/\/+$/, '')
  const right = String(path ?? '').replace(/^\/+/, '')
  if (left.length === 0) return `/${right}`
  if (right.length === 0) return left
  return `${left}/${right}`
}

/** Effective prefix of every blueprint, following `register_blueprint` calls. */
function blueprintPrefixes(scan) {
  const prefixes = new Map()
  for (const blueprint of scan.blueprints) prefixes.set(blueprint.variable, blueprint.urlPrefix ?? '')
  for (const registration of scan.registrations) {
    if (!prefixes.has(registration.target)) continue
    const parent = prefixes.get(registration.parent) ?? ''
    prefixes.set(registration.target, joinPath(joinPath(parent, registration.urlPrefix ?? ''), prefixes.get(registration.target) ?? ''))
  }
  return prefixes
}

/** Whether a status code carries no response body. */
function isBodylessStatus(status) {
  return status === 204 || status === 205 || status === 304
}

/** Default port a Flask app serves unless `app.run(port=...)` says otherwise. */
function inferBaseUrl(scan) {
  const run = scan.runs.find(entry => entry.port !== undefined || entry.host !== undefined)
  if (run === undefined) return 'http://127.0.0.1:5000'
  const host = run.host ?? '127.0.0.1'
  const port = run.port ?? 5000
  return `http://${host}:${port}`
}

/**
 * Extract a contract from a Flask project tree.
 *
 * @param root absolute project directory.
 * @param options scan bounds plus an optional service name.
 */
export function extractFlask(root, options = {}) {
  const scan = scanProject(root, { maxFiles: options.maxFiles, skipDirs: options.skipDirs })
  const modelNames = new Set(scan.models.map(model => model.name))
  const warnings = [...scan.warnings]

  const models = scan.models.map((model) => ({
    name: model.name,
    origin: model.kind === 'sqlalchemy' ? 'table' : 'json',
    ...(model.table === undefined ? {} : { table: model.table }),
    fields: model.fields.map((field) => {
      const required = field.nullable !== undefined
        ? field.nullable === false
        : field.kind === 'annotation'
          ? field.required !== false
          : field.primaryKey === true
      const note = field.primaryKey
        ? 'primary key'
        : field.length !== undefined
          ? `max length ${field.length}`
          : undefined
      return {
        name: field.name,
        type: fromPythonType(field.pythonType, modelNames),
        required,
        ...(note === undefined ? {} : { note }),
      }
    }),
  }))

  const prefixes = blueprintPrefixes(scan)
  const operations = []
  const usedIds = new Map()

  for (const route of scan.routes) {
    const owner = route.owner.length === 0 ? '' : route.owner
    const base = owner.length === 0 ? '' : prefixes.get(owner) ?? ''
    const path = joinPath(base, toPathTemplate(route.path))
    const idBase = toCamel(route.viewName)

    const pathParams = route.variables.map((variable) => {
      const pythonParam = route.params.find(param => param.name === variable.name)
      const type = pythonParam?.annotation
        ? fromPythonType(pythonParam.annotation, modelNames)
        : converterType(variable.converter)
      return { in: 'path', name: variable.name, type, required: true }
    })

    const queryParams = []
    for (const param of route.params) {
      if (route.variables.some(variable => variable.name === param.name)) continue
      // `q: str | None = None` declares no default value, only optionality.
      const literal = param.defaultValue === undefined || param.defaultValue === 'None'
        ? undefined
        : param.defaultValue
      queryParams.push({
        in: 'query',
        name: param.name,
        type: fromPythonType(param.annotation, modelNames),
        required: literal === undefined && param.defaultValue === undefined,
        ...(literal === undefined ? {} : { default: literal }),
      })
    }

    for (const method of route.methods) {
      const count = (usedIds.get(idBase) ?? 0) + 1
      usedIds.set(idBase, count)
      const id = route.methods.length > 1 ? `${idBase}_${method.toLowerCase()}` : count === 1 ? idBase : `${idBase}${count}`
      const status = route.statusCodes?.[method] ?? route.statusCode
      // A shared GET/POST view only reads a JSON body on its write verbs.
      const readsBody = route.behavior.jsonBody
        && (route.methods.length === 1 || ['POST', 'PUT', 'PATCH'].includes(method))
      operations.push({
        id,
        method,
        path,
        summary: route.docstring ?? `Flask view \`${route.viewName}\``,
        params: [...pathParams, ...queryParams],
        ...(readsBody ? { requestBody: JSON_TYPE } : {}),
        responses: [{
          status,
          type: isBodylessStatus(status) ? VOID_TYPE : JSON_TYPE,
        }],
        source: { file: route.file, line: route.line },
      })
    }
  }

  if (scan.totalFiles > scan.files) {
    warnings.push({ file: root, message: `only ${scan.files} of ${scan.totalFiles} Python files were scanned` })
  }
  if (scan.apps.length === 0 && scan.blueprints.length === 0) {
    warnings.push({ file: root, message: 'no Flask app or Blueprint declaration found; routes may be incomplete' })
  }

  return makeContract({
    kind: 'flask',
    name: options.name ?? basename(root),
    baseUrl: inferBaseUrl(scan),
    source: { root, files: scan.files },
    operations,
    models,
    warnings,
  })
}

/** Neutral type implied by a Flask URL converter. */
function converterType(converter) {
  switch (converter) {
    case 'int': return scalar('int')
    case 'float': return scalar('double')
    case 'uuid': return scalar('uuid')
    default: return scalar('string')
  }
}
