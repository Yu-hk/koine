/**
 * FastAPI → bridge contract extractor.
 *
 * FastAPI classifies a parameter by its type and markers (`Depends`, `Query`,
 * `Body`, `Path`) rather than by the URL rule, and declares the response shape
 * with `response_model`. That classification happens here, once every model name
 * in the project is known.
 */

import { basename } from 'node:path'
import { scanFastApiProject } from './fastapi-scan.js'
import { keywordLiteral, splitTopLevel } from './python.js'
import { JSON_TYPE, VOID_TYPE, fromPythonType, makeContract, scalar } from './ir.js'
import { toCamel } from './naming.js'

/** Join a router prefix with a rule. */
function joinPath(base, path) {
  const left = String(base ?? '').replace(/\/+$/, '')
  const right = String(path ?? '').replace(/^\/+/, '')
  if (left.length === 0) return `/${right}`
  if (right.length === 0) return left
  return `${left}/${right}`
}

/** Path variable names declared by a FastAPI rule (`/items/{item_id}`). */
function pathVariableNames(rule) {
  const names = []
  for (const match of rule.matchAll(/\{([A-Za-z_]\w*)\}/g)) names.push(match[1])
  return names
}

/** Last segment of a qualified type expression, lowercased. */
function simpleName(annotation) {
  const text = String(annotation ?? '').replace(/\s+/g, '')
  const unwrapped = /^(?:[A-Za-z_][\w.]*\.)?(?:Optional|Annotated|list|List|Sequence|Set|set)\[(.*)\]$/.exec(text)
  return (unwrapped ? unwrapped[1] : text).split(/[.|<[]/)[0]
}

/** A literal Python default as a string, when it is one. */
function literalOf(text) {
  const trimmed = String(text ?? '').trim()
  if (/^(['"]).*\1$/.test(trimmed)) return trimmed.slice(1, -1)
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed
  if (trimmed === 'True' || trimmed === 'true') return 'true'
  if (trimmed === 'False' || trimmed === 'false') return 'false'
  return undefined
}

/**
 * Optionality and default of a parameter, unwrapping `Query(...)`/`Path(...)`.
 */
function defaultInfo(rawDefault) {
  if (rawDefault === undefined) return { required: true }
  const text = String(rawDefault).trim()
  if (text === '...') return { required: true }
  const marker = /^(Query|Path|Body|Form|File|Header|Cookie)\s*\(([\s\S]*)\)$/.exec(text)
  if (marker !== null) {
    const args = marker[2]
    const named = keywordLiteral(args, 'default')
    if (named !== undefined) {
      if (named === '...') return { required: true }
      const literal = literalOf(named)
      return literal === undefined ? { required: false } : { required: false, default: literal }
    }
    const positional = firstTopLevel(args)
    if (positional === undefined) return { required: false }
    if (positional === '...') return { required: true }
    const literal = literalOf(positional)
    return literal === undefined ? { required: false } : { required: false, default: literal }
  }
  if (text === 'None') return { required: false }
  const literal = literalOf(text)
  return literal === undefined ? { required: false } : { required: false, default: literal }
}

/** First positional argument of a call argument list. */
function firstTopLevel(content) {
  return splitTopLevel(content).find(part => !/^[A-Za-z_]\w*\s*=/.test(part))
}

/**
 * Whether a class is a Pydantic model, directly or through another model.
 *
 * `class Order(OrderIn)` declares `BaseModel` only on its ancestor, and the
 * ancestor may live in another file, so the check walks the recorded base names.
 */
function derivesFromBaseModel(model, byName, seen = new Set()) {
  if (model.extendsBaseModel === true) return true
  if (seen.has(model.name)) return false
  seen.add(model.name)
  return (model.bases ?? []).some(base => byName.has(base) && derivesFromBaseModel(byName.get(base), byName, seen))
}

/**
 * Fields of a Pydantic model including inherited ones.
 *
 * A subclass body declares only its own fields; the servable shape is the base
 * chain followed by the subclass, with a subclass field overriding its base.
 */
function mergedFields(model, allModels, seen = new Set()) {
  if (seen.has(model.name)) return []
  seen.add(model.name)
  const byName = new Map(allModels.map(entry => [entry.name, entry]))
  const inherited = (model.bases ?? []).flatMap(base => (
    byName.has(base) ? mergedFields(byName.get(base), allModels, seen) : []
  ))
  const own = new Set(model.fields.map(field => field.name))
  return [...inherited.filter(field => !own.has(field.name)), ...model.fields]
}

/** Whether a parameter declaration describes a request body. */
function looksLikeBody(annotation, modelNames) {
  if (annotation === undefined) return false
  const simple = simpleName(annotation)
  if (modelNames.has(simple)) return true
  const text = String(annotation).replace(/\s+/g, '')
  return /^(?:dict|Dict|Any|object|Mapping|list|List|Sequence|Set|set)\b/.test(text)
    || /^(?:(?:dict|Dict|list|List|Sequence|Set|set|Mapping)\[)/.test(text)
}

/**
 * Extract a contract from a FastAPI project tree.
 *
 * @param root absolute project directory.
 * @param options scan bounds plus an optional service name.
 */
export function extractFastApi(root, options = {}) {
  const scan = scanFastApiProject(root, options)
  const modelByName = new Map(scan.models.map(model => [model.name, model]))
  const pydanticModels = scan.models.filter(model => derivesFromBaseModel(model, modelByName))
  const modelNames = new Set(pydanticModels.map(model => model.name))
  const warnings = [...scan.warnings]

  const models = pydanticModels.map(model => ({
    name: model.name,
    origin: 'json',
    fields: mergedFields(model, pydanticModels).map(field => ({
      name: field.name,
      type: fromPythonType(field.pythonType, modelNames),
      required: field.required !== false,
      ...(field.length === undefined ? {} : { note: `max length ${field.length}` }),
    })),
  }))

  // Router prefixes: an include_router prefix precedes the router's own prefix.
  // The own prefixes stay immutable so repeated passes cannot stack the same
  // prefix on top of itself.
  const ownPrefix = new Map()
  for (const router of scan.routers) ownPrefix.set(router.variable, router.prefix)
  const prefixes = new Map(ownPrefix)
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (const include of scan.includes) {
      if (!ownPrefix.has(include.target)) continue
      const parent = prefixes.get(include.parent) ?? ''
      const next = joinPath(joinPath(parent, include.prefix), ownPrefix.get(include.target) ?? '')
      if (next !== prefixes.get(include.target)) {
        prefixes.set(include.target, next)
        changed = true
      }
    }
    if (!changed) break
  }

  const operations = []
  const usedIds = new Map()

  for (const route of scan.routes) {
    const base = prefixes.get(route.owner) ?? ''
    const path = joinPath(base, route.rule)
    const pathNames = new Set(pathVariableNames(route.rule))
    const params = []
    let requestBody

    for (const param of route.params) {
      const name = param.name
      if (['self', 'cls', 'request', 'response', 'background_tasks', 'websocket'].includes(name)) continue
      const rawDefault = param.defaultValue
      const marker = rawDefault === undefined ? '' : String(rawDefault).trim()
      if (/^(?:Depends|Security)\s*\(/.test(marker)) continue
      if (/^(?:Header|Cookie)\s*\(/.test(marker)) continue

      if (/^(?:File|Form)\s*\(/.test(marker)) {
        warnings.push({
          file: route.file,
          line: route.line,
          message: `\`${name}\` is multipart input; the contract covers JSON bodies only`,
        })
        continue
      }

      if (/^Body\s*\(/.test(marker)) {
        requestBody = fromPythonType(param.annotation, modelNames)
        continue
      }

      const isPath = /^Path\s*\(/.test(marker) || pathNames.has(name)
      if (isPath) {
        const info = defaultInfo(rawDefault)
        params.push({
          in: 'path',
          name,
          type: param.annotation === undefined ? scalar('string') : fromPythonType(param.annotation, modelNames),
          required: true,
          ...(info.default === undefined ? {} : { default: info.default }),
        })
        continue
      }

      if (looksLikeBody(param.annotation, modelNames)) {
        requestBody = fromPythonType(param.annotation, modelNames)
        continue
      }

      const info = defaultInfo(rawDefault)
      params.push({
        in: 'query',
        name,
        type: param.annotation === undefined ? scalar('string') : fromPythonType(param.annotation, modelNames),
        required: info.required,
        ...(info.default === undefined ? {} : { default: info.default }),
      })
    }

    if (route.usesDepends) {
      warnings.push({
        file: route.file,
        line: route.line,
        message: `\`${route.viewName}\` uses Depends/Security; authentication is not represented in the contract`,
      })
    }
    for (const decorator of route.decorators) {
      if (/^(?:login_required|jwt_required|requires)/.test(decorator)) {
        warnings.push({
          file: route.file,
          line: route.line,
          message: `\`${route.viewName}\` is decorated with @${decorator}; authentication is not represented in the contract`,
        })
      }
    }

    const bodyless = route.statusCode === 204 || route.statusCode === 205 || route.statusCode === 304
    // FastAPI streams by returning a StreamingResponse/EventSourceResponse or by
    // yielding; such a route cannot be a buffered JSON call.
    const streaming = route.yieldsUpdates === true
      || /StreamingResponse|EventSourceResponse/.test(route.returnAnnotation ?? '')
    let responseType
    if (bodyless) responseType = VOID_TYPE
    else if (streaming) responseType = scalar('string')
    else if (route.responseModel !== undefined) {
      // `response_model=list[str]` is a generic, not a model name: map it, and fall
      // back to opaque JSON only when the mapping really produced `any`.
      const mapped = fromPythonType(route.responseModel, modelNames)
      responseType = mapped.kind === 'scalar' && mapped.name === 'any' ? JSON_TYPE : mapped
    } else if (route.returnAnnotation !== undefined) {
      const annotation = route.returnAnnotation
      const normalized = annotation.replace(/\s+/g, '')
      if (/^None(?:Type)?$/.test(normalized)) {
        responseType = VOID_TYPE
      } else {
        const mapped = fromPythonType(annotation, modelNames)
        responseType = mapped.kind === 'scalar' && mapped.name === 'any' ? JSON_TYPE : mapped
      }
    } else {
      responseType = JSON_TYPE
    }

    const docstring = /^[ \t]*(?:[rRuUbB]{0,2})("""|''')([\s\S]*?)\1/m.exec(route.body)
    const summary = route.summary
      ?? (docstring === null
        ? `FastAPI endpoint \`${route.viewName}\``
        : docstring[2].trim().split('\n').map(line => line.trim()).filter(Boolean).join(' '))

    for (const method of route.methods) {
      const idBase = toCamel(route.viewName)
      const count = (usedIds.get(idBase) ?? 0) + 1
      usedIds.set(idBase, count)
      operations.push({
        id: route.methods.length > 1 ? `${idBase}_${method.toLowerCase()}` : count === 1 ? idBase : `${idBase}${count}`,
        method,
        path,
        summary,
        params,
        ...(requestBody === undefined ? {} : { requestBody }),
        responses: [{ status: route.statusCode, type: responseType }],
        ...(streaming ? { streaming: true } : {}),
        source: { file: route.file, line: route.line },
      })
    }
  }

  if (scan.apps.length === 0 && scan.routers.length === 0) {
    warnings.push({ file: root, message: 'no FastAPI app or APIRouter declaration found; routes may be incomplete' })
  }

  return makeContract({
    kind: 'fastapi',
    name: options.name ?? basename(root),
    baseUrl: 'http://127.0.0.1:8000',
    source: { root, files: scan.files },
    operations,
    models,
    warnings,
  })
}
