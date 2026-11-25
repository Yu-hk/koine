/**
 * FastAPI / Pydantic source scanner.
 *
 * FastAPI differs from Flask in three ways that matter here: routers are mounted
 * with `include_router` and a `prefix`, parameters are classified by their type
 * and `Depends`/`Query`/`Body` markers rather than by the URL rule alone, and
 * response shapes are declared with `response_model`. This scanner therefore
 * extracts syntax only; the extractor resolves models and parameter roles once
 * every declared name is known.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  indentAt, keywordLiteral, lineOf, lineStarts, parseSignature, readBalanced, readBlock,
  skipInlineSpace, splitTopLevel, topLevelIndex, unquote,
} from './python.js'

/** Directories never worth scanning in a Python service checkout. */
export const FASTAPI_SKIP_DIRS = [
  '.git', '.hg', '.svn', '.venv', 'venv', 'env', 'node_modules', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.tox', '.idea', '.vscode', 'site-packages', 'build', 'dist', 'target',
  'migrations', 'alembic', 'docs', 'static', 'templates', 'tests', 'test',
]

/** Route decorator verbs. */
const ROUTE_VERBS = {
  get: ['GET'], post: ['POST'], put: ['PUT'], delete: ['DELETE'], patch: ['PATCH'],
  head: ['HEAD'], options: ['OPTIONS'],
}

/** Collect `.py` files below `root`, skipping dot-directories and build output. */
export function listPythonFilesFastApi(root, skipDirs = FASTAPI_SKIP_DIRS) {
  const skip = new Set(skipDirs)
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(full)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.py')) files.push(full)
    }
  }
  files.sort()
  return files
}

/** Python type names that never describe a wire body. */
const NON_BODY_TYPES = new Set([
  'request', 'response', 'websocket', 'backgroundtasks', 'status',
])
const NON_BODY_QUALIFIED = new Set([
  'starlette.requests.request', 'starlette.responses.response', 'fastapi.request',
  'fastapi.response', 'fastapi.backgroundtasks.backgroundtasks', 'fastapi.websocket',
])

/** Parse the annotated fields of a Pydantic model body. */
export function parsePydanticFields(body) {
  const fields = []
  const lineRe = /^[ \t]+([A-Za-z_]\w*)[ \t]*:[ \t]*([^=\n#]+?)[ \t]*(?:=[ \t]*([^\n#]+))?[ \t]*$/gm
  for (let match = lineRe.exec(body); match !== null; match = lineRe.exec(body)) {
    const name = match[1]
    if (name === 'model_config') continue
    const annotation = match[2].trim()
    if (annotation.length === 0) continue
    const defaultText = match[3] === undefined ? undefined : match[3].trim()
    const required = defaultText === undefined
      || defaultText === '...'
      || /^Field\s*\(\s*\.\.\./.test(defaultText)
    const maxLength = defaultText === undefined ? null : /max_length\s*=\s*(\d+)/.exec(defaultText)
    fields.push({
      name,
      pythonType: annotation,
      required,
      length: maxLength === null ? undefined : Number(maxLength[1]),
    })
  }
  return fields
}

/** Return annotation declared between the parameter list and the body colon. */
function returnAnnotationOf(text, signatureEnd) {
  const colon = text.indexOf(':', signatureEnd)
  if (colon === -1) return undefined
  const between = text.slice(signatureEnd, colon).trim()
  if (!between.startsWith('->')) return undefined
  const annotation = between.slice(2).trim()
  return annotation.length === 0 ? undefined : annotation
}

/** Find the `def` that the decorators ending at `fromIndex` attach to. */
function findTargetDef(text, fromIndex) {
  let i = fromIndex
  const decorators = []
  for (let guard = 0; guard < 64; guard++) {
    i = skipAllSpace(text, i)
    if (i >= text.length) return undefined
    if (text[i] === '#') {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline + 1
      continue
    }
    if (text[i] === '@') {
      const name = /^@([A-Za-z_][\w.]*)/.exec(text.slice(i, i + 200))
      if (!name) return undefined
      decorators.push(name[1])
      i += name[0].length
      const cursor = skipInlineSpace(text, i)
      if (text[cursor] === '(') i = readBalanced(text, cursor).end
      continue
    }
    const def = /(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/y
    def.lastIndex = i
    const match = def.exec(text)
    if (!match) return undefined
    const open = i + match[0].length - 1
    const signature = readBalanced(text, open)
    return {
      name: match[1],
      isAsync: /^async/.test(match[0]),
      params: parseSignature(signature.content),
      decorators,
      signatureEnd: signature.end,
      returnAnnotation: returnAnnotationOf(text, signature.end),
      bodyIndex: signature.end,
    }
  }
  return undefined
}

/** Skip whitespace including newlines. */
function skipAllSpace(text, index) {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Scan one FastAPI source file. */
export function scanFastApiFile(text, relPath) {
  const starts = lineStarts(text)
  const result = { apps: [], routers: [], includes: [], routes: [], models: [], warnings: [] }

  const declarationRe = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*(?:fastapi\.)?(FastAPI|APIRouter)[ \t]*\(/gm
  for (let match = declarationRe.exec(text); match !== null; match = declarationRe.exec(text)) {
    const variable = match[1]
    const kind = match[2]
    const open = match.index + match[0].length - 1
    const call = readBalanced(text, open)
    const entry = {
      variable,
      file: relPath,
      line: lineOf(starts, match.index),
      prefix: keywordLiteral(call.content, 'prefix') ?? '',
    }
    if (kind === 'FastAPI') result.apps.push(entry)
    else result.routers.push(entry)
  }

  const includeRe = /^[ \t]*([A-Za-z_]\w*)[ \t]*\.\s*include_router[ \t]*\(/gm
  for (let match = includeRe.exec(text); match !== null; match = includeRe.exec(text)) {
    const open = match.index + match[0].length - 1
    const call = readBalanced(text, open)
    const parts = splitTopLevel(call.content)
    const target = parts.length > 0 ? parts[0].replace(/\s/g, '') : ''
    result.includes.push({
      parent: match[1],
      target,
      prefix: keywordLiteral(call.content, 'prefix') ?? '',
      file: relPath,
      line: lineOf(starts, match.index),
    })
  }

  const modelRe = /^[ \t]*class[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]*)\)[ \t]*:/gm
  for (let match = modelRe.exec(text); match !== null; match = modelRe.exec(text)) {
    const bases = match[2]
    const name = match[1]
    const line = lineOf(starts, match.index)
    const headerEnd = match.index + match[0].length
    const body = readBlock(text, starts, headerEnd, indentAt(text, starts, match.index)).text
    const fields = parsePydanticFields(body)
    if (fields.length === 0) continue
    // A model may inherit another model declared in a different file, so every
    // class is recorded here and filtered by ancestry once all names are known.
    const extendsBaseModel = /(?:^|,)[ \t]*(?:[A-Za-z_][\w.]*\.)?(BaseModel|RootModel)\b/.test(`,${bases}`)
    const baseNames = splitTopLevel(bases.replace(/\s+/g, ''))
      .map(base => base.split('.').pop())
      .filter(base => base !== 'BaseModel' && base !== 'RootModel' && base.length > 0)
    result.models.push({ name, kind: 'pydantic', file: relPath, line, fields, bases: baseNames, extendsBaseModel })
  }

  const decoratorRe = /^[ \t]*@([A-Za-z_][\w.]*)/gm
  for (let match = decoratorRe.exec(text); match !== null; match = decoratorRe.exec(text)) {
    const decoratorName = match[1]
    const last = decoratorName.split('.').pop()
    const routeLine = lineOf(starts, match.index)
    let cursor = skipInlineSpace(text, match.index + match[0].length)
    let argsText = ''
    if (text[cursor] === '(') {
      const call = readBalanced(text, cursor)
      argsText = call.content
      cursor = call.end
    }
    if (last === 'websocket') {
      result.warnings.push({ file: relPath, line: routeLine, message: 'websocket routes are not part of the HTTP contract' })
      continue
    }
    if (last !== 'api_route' && ROUTE_VERBS[last] === undefined) continue

    const owner = decoratorName.split('.').slice(0, -1).join('.')
    const target = findTargetDef(text, cursor)
    if (!target) {
      result.warnings.push({ file: relPath, line: routeLine, message: `no endpoint function found for @${decoratorName}` })
      continue
    }
    const ruleText = firstPositional(argsText)
    if (ruleText === undefined) {
      result.warnings.push({ file: relPath, line: routeLine, message: `@${decoratorName} has no literal path` })
      continue
    }
    const methods = last === 'api_route'
      ? parseMethods(keywordLiteral(argsText, 'methods')) ?? ['GET']
      : ROUTE_VERBS[last]
    const statusCode = Number(keywordLiteral(argsText, 'status_code') ?? 200)
    const body = readBlock(text, starts, target.bodyIndex, indentAt(text, starts, target.bodyIndex)).text
    result.routes.push({
      owner,
      file: relPath,
      line: routeLine,
      viewName: target.name,
      rule: ruleText,
      methods,
      params: target.params,
      decorators: target.decorators,
      responseModel: keywordLiteral(argsText, 'response_model'),
      statusCode: Number.isInteger(statusCode) && statusCode > 0 ? statusCode : 200,
      returnAnnotation: target.returnAnnotation,
      summary: keywordLiteral(argsText, 'summary'),
      body,
      usesForm: /Form\s*\(|File\s*\(|UploadFile/.test(text.slice(target.bodyIndex, target.bodyIndex + 4000)),
      yieldsUpdates: /^[ \t]+yield\b/m.test(body),
      usesDepends: target.params.some(param => /^\s*(?:Depends|Security)\s*\(/.test(param.defaultValue ?? '')),
      isAsync: target.isAsync,
    })
  }

  return result
}

/** First positional literal of a decorator call, including an empty `""` rule. */
function firstPositional(argsText) {
  for (const part of splitTopLevel(argsText)) {
    if (topLevelIndex(part, '=') !== -1) break
    return unquote(part)
  }
  return undefined
}

/** Parse a `methods=[...]` literal into verbs. */
function parseMethods(literal) {
  if (literal === undefined) return undefined
  const verbs = []
  for (const part of splitTopLevel(literal.replace(/^\[|\]$/g, ''))) {
    const value = unquote(part).toUpperCase()
    if (/^[A-Z]+$/.test(value)) verbs.push(value)
  }
  return verbs.length > 0 ? verbs : undefined
}

/** Scan a whole FastAPI project directory. */
export function scanFastApiProject(root, options = {}) {
  const skipDirs = options.skipDirs ? [...FASTAPI_SKIP_DIRS, ...options.skipDirs] : FASTAPI_SKIP_DIRS
  const maxFiles = options.maxFiles ?? 400
  const warnings = []
  const files = listPythonFilesFastApi(root, skipDirs)
  if (files.length > maxFiles) {
    warnings.push({
      file: root,
      message: `truncated: ${files.length} Python files found, only the first ${maxFiles} are scanned`,
    })
  }
  const scanned = files.slice(0, maxFiles)
  const aggregate = {
    apps: [], routers: [], includes: [], routes: [], models: [], warnings,
    files: scanned.length, totalFiles: files.length,
  }
  for (const file of scanned) {
    const relPath = relative(root, file).split(sep).join('/')
    let text
    try {
      if (statSync(file).size > 2_000_000) {
        warnings.push({ file: relPath, message: 'skipped: source larger than 2 MB' })
        continue
      }
      text = readFileSync(file, 'utf8')
    } catch (error) {
      warnings.push({ file: relPath, message: `skipped: ${error.message}` })
      continue
    }
    let one
    try {
      one = scanFastApiFile(text, relPath)
    } catch (error) {
      warnings.push({ file: relPath, message: `scan failed: ${error.message}` })
      continue
    }
    for (const key of ['apps', 'routers', 'includes', 'routes', 'models']) aggregate[key].push(...one[key])
    for (const warning of one.warnings) warnings.push({ file: warning.file, line: warning.line, message: warning.message })
  }
  aggregate.routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return aggregate
}

export { NON_BODY_TYPES, NON_BODY_QUALIFIED }
