/**
 * Flask project scanner.
 *
 * Produces a source-ordered inventory of applications, blueprints, routes, and
 * data models. Every route keeps its file/line so the generated Java can point
 * back at the Python it came from, and anything the scanner cannot resolve is
 * reported as a warning instead of being silently dropped.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  indentAt, keywordLiteral, lineOf, lineStarts, parseSignature, readBalanced, readBlock,
  skipInlineSpace, splitTopLevel, topLevelIndex, unquote,
} from './python.js'

/** Directories never worth scanning in a Flask checkout. */
export const DEFAULT_SKIP_DIRS = [
  '.git', '.hg', '.svn', '.venv', 'venv', 'env', 'node_modules', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.tox', '.idea', '.vscode', 'site-packages', 'build', 'dist', 'target',
  'migrations', 'alembic', 'docs', 'static', 'templates',
]

/** Blueprint method-decorator shorthand names. */
const SHORTHAND_METHODS = { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH' }

/** Collect `.py` files below `root`, skipping the configured directories. */
export function listPythonFiles(root, skipDirs = DEFAULT_SKIP_DIRS) {
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
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (entry.isDirectory()) continue
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        stack.push(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.py')) continue
      files.push(full)
    }
  }
  files.sort()
  return files
}

/** Read a file defensively; unreadable files become a warning. */
function readSource(file, warnings) {
  try {
    if (statSync(file).size > 2_000_000) {
      warnings.push({ file, message: 'skipped: source larger than 2 MB' })
      return undefined
    }
    return readFileSync(file, 'utf8')
  } catch (error) {
    warnings.push({ file, message: `skipped: ${error.message}` })
    return undefined
  }
}

/** Find the `def` that the decorators ending at `fromIndex` attach to. */
function findTargetDef(text, fromIndex) {
  let i = fromIndex
  const decorators = []
  for (let guard = 0; guard < 64; guard++) {
    i = skipWhitespaceFrom(text, i)
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
      if (text[cursor] === '(') {
        const call = readBalanced(text, cursor)
        i = call.end
      }
      continue
    }
    const def = /(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/y
    def.lastIndex = i
    const match = def.exec(text)
    if (!match) return undefined
    const open = i + match[0].length - 1
    const signature = readBalanced(text, open)
    const after = skipToColon(text, signature.end)
    return {
      name: match[1],
      isAsync: /^async/.test(match[0]),
      params: parseSignature(signature.content),
      decorators,
      bodyIndex: after.index,
      indent: indentAt(text, [], i),
    }
  }
  return undefined
}

/** Skip whitespace including newlines. */
function skipWhitespaceFrom(text, index) {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Find the `:` terminating a `def` header, skipping annotations. */
function skipToColon(text, index) {
  let i = index
  let depth = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch + ch + ch, i)
      const quote = triple ? ch + ch + ch : ch
      i += quote.length
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text.startsWith(quote, i)) { i += quote.length; break }
        i++
      }
      continue
    }
    if (ch === '#' && depth === 0) {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline + 1
      if (depth === 0) return { index: i }
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ':' && depth === 0) return { index: i + 1 }
    i++
  }
  return { index: text.length }
}

/** Interpret a Flask URL rule into a Spring path template plus typed variables. */
export function parseUrlRule(rule) {
  const variables = []
  const path = rule
    .replace(/<([A-Za-z_]\w*):([A-Za-z_]\w*)>/g, (_all, converter, name) => {
      variables.push({ name, converter })
      return `{${name}}`
    })
    .replace(/<([A-Za-z_]\w*)>/g, (_all, name) => {
      variables.push({ name, converter: 'string' })
      return `{${name}}`
    })
  return { path: normalizePath(path), variables }
}

/** Collapse duplicate slashes and keep a leading slash. */
function normalizePath(path) {
  const trimmed = path.replace(/\/{2,}/g, '/')
  if (trimmed.length === 0) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** Detect the HTTP methods a route decorator declares. */
function methodsOf(decoratorName, argsText) {
  const last = decoratorName.split('.').pop()
  if (SHORTHAND_METHODS[last]) return { methods: [SHORTHAND_METHODS[last]], declared: true }
  const literal = keywordLiteral(argsText, 'methods')
  if (literal === undefined) return { methods: ['GET'], declared: false }
  const names = []
  for (const part of splitTopLevel(literal.replace(/^\[|\]$/g, ''))) {
    const value = unquote(part).toUpperCase()
    if (/^[A-Z]+$/.test(value)) names.push(value)
  }
  return { methods: names.length > 0 ? names : ['GET'], declared: names.length > 0 }
}

/** Every `return ..., <status>` line in a view body, in source order. */
function returnStatuses(body) {
  const statuses = []
  const lines = body.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!/^return\b/.test(line)) continue
    const match = /,\s*(\d{3})\s*\)?\s*(?:#.*)?$/.exec(line)
    if (match) statuses.push({ index, status: Number(match[1]) })
  }
  return statuses
}

/**
 * Extract the declared status code from a view body.
 *
 * The last `return ..., NNN` wins: an early `return ..., 404` is a branch, while
 * the trailing return is the view's normal outcome.
 */
function statusOf(body) {
  const statuses = returnStatuses(body)
  if (statuses.length > 0) return statuses[statuses.length - 1].status
  const response = /status\s*=\s*(\d{3})/.exec(body)
  if (response) return Number(response[1])
  const abort = /abort\(\s*(\d{3})/.exec(body)
  return abort ? Number(abort[1]) : 200
}

/**
 * Per-method status hints for a view that branches on `request.method`.
 *
 * A single Flask function serving GET and POST usually returns a different code
 * per verb; without this, one operation's status would leak into the other.
 */
function statusesByMethod(body, methods) {
  if (methods.length <= 1) return {}
  const lines = body.split('\n')
  const guards = []
  for (let index = 0; index < lines.length; index++) {
    const match = /request\s*\.\s*method\s*==\s*['"](\w+)['"]/.exec(lines[index])
    if (match) guards.push({ index, method: match[1].toUpperCase() })
  }
  if (guards.length === 0) return {}
  const statuses = returnStatuses(body)
  const fallback = statuses.length > 0 ? statuses[statuses.length - 1].status : 200
  const result = {}
  for (const method of methods) {
    const guard = guards.find(entry => entry.method === method)
    if (guard === undefined) {
      result[method] = fallback
      continue
    }
    const next = statuses.find(entry => entry.index > guard.index)
    result[method] = next === undefined ? fallback : next.status
  }
  return result
}

/** Summarize what a view body touches, so generated code can say what is missing. */
function behaviorOf(body, decorators = []) {
  const text = `${body}\n${decorators.join('\n')}`
  return {
    jsonBody: /\brequest\s*\.\s*(?:json|get_json\s*\()|\bget_json\s*\(/.test(body),
    form: /\brequest\s*\.\s*(?:form|files)\b/.test(body),
    queryArgs: /\brequest\s*\.\s*args\b/.test(body),
    template: /\brender_template(?:_string)?\s*\(/.test(body),
    persistence: /\bdb\s*\.\s*session\b|\b\.query\s*\(|\bsession\s*\.\s*commit\s*\(/.test(body),
    currentUser: /\bcurrent_user\b|\bg\s*\.\s*user\b/.test(text)
      || decorators.some(name => /login_required|jwt_required|verify_jwt/.test(name)),
  }
}

/** First triple-quoted docstring in a block, as a single paragraph. */
function docstringOf(body) {
  const match = /^[ \t]*(?:[rRuUbB]{0,2})("""|''')([\s\S]*?)\1/m.exec(body)
  if (!match) return undefined
  const text = match[2].trim().split('\n').map(line => line.trim()).filter(Boolean).join(' ')
  return text.length > 0 ? text : undefined
}

/** Parse SQLAlchemy / Pydantic style model fields. */
function parseModelFields(body) {
  const fields = []
  const columnRe = /^[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*(?:[A-Za-z_][\w.]*\.)?Column[ \t]*\(/gm
  for (let match = columnRe.exec(body); match !== null; match = columnRe.exec(body)) {
    const name = match[1]
    const open = match.index + match[0].length - 1
    const call = readBalanced(body, open)
    const args = call.content
    const typeMatch = /(?:[A-Za-z_][\w.]*\.)?(Integer|BigInteger|SmallInteger|String|Text|Unicode|Boolean|Float|Numeric|DECIMAL|DateTime|Date|Time|JSON|JSONB|LargeBinary|PickleType|Enum|UUID)\b[ \t]*(?:\([ \t]*(\d+))?/.exec(args)
    fields.push({
      name,
      kind: 'column',
      pythonType: typeMatch ? typeMatch[1] : 'Unknown',
      length: typeMatch && typeMatch[2] ? Number(typeMatch[2]) : undefined,
      primaryKey: /primary_key[ \t]*=[ \t]*True/.test(args),
      nullable: /nullable[ \t]*=[ \t]*True/.test(args) ? true
        : /nullable[ \t]*=[ \t]*False/.test(args) ? false
          : undefined,
      default: /default[ \t]*=/.test(args) ? true : undefined,
    })
  }

  const annotatedRe = /^[ \t]+([A-Za-z_]\w*)[ \t]*:[ \t]*([^=\n#]+?)[ \t]*(?:=[ \t]*([^\n#]+))?[ \t]*$/gm
  for (let match = annotatedRe.exec(body); match !== null; match = annotatedRe.exec(body)) {
    const name = match[1]
    if (fields.some(field => field.name === name)) continue
    if (name === 'Config' || name === 'class') continue
    const annotation = match[2].trim()
    if (annotation.length === 0) continue
    const defaultText = match[3] ? match[3].trim() : undefined
    const fieldCall = defaultText ? /^Field\s*\(/.exec(defaultText) : null
    const maxLength = defaultText ? /max_length\s*=\s*(\d+)/.exec(defaultText) : null
    fields.push({
      name,
      kind: 'annotation',
      pythonType: annotation,
      length: maxLength ? Number(maxLength[1]) : undefined,
      primaryKey: false,
      nullable: annotation.includes('Optional') || annotation.includes('| None') || fieldCall !== null ? true : undefined,
      default: defaultText !== undefined,
      required: defaultText === undefined,
    })
  }
  return fields
}

/** Scan one source file. */
export function scanFile(text, relPath) {
  const starts = lineStarts(text)
  const result = { apps: [], blueprints: [], routes: [], models: [], registrations: [], runs: [], warnings: [] }

  const declarationRe = /^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*(?:[A-Za-z_][\w.]*\.)?(Flask|Blueprint)[ \t]*\(/gm
  for (let match = declarationRe.exec(text); match !== null; match = declarationRe.exec(text)) {
    const variable = match[1]
    const kind = match[2]
    const open = match.index + match[0].length - 1
    const call = readBalanced(text, open)
    const line = lineOf(starts, match.index)
    if (kind === 'Flask') {
      result.apps.push({ variable, file: relPath, line })
      continue
    }
    const positional = splitTopLevel(call.content).filter(part => topLevelIndex(part, '=') === -1)
    result.blueprints.push({
      variable,
      file: relPath,
      line,
      blueprintName: positional.length > 0 ? unquote(positional[0]) : variable,
      urlPrefix: keywordLiteral(call.content, 'url_prefix'),
    })
  }

  const registrationRe = /^[ \t]*([A-Za-z_]\w*)[ \t]*\.\s*register_blueprint[ \t]*\(/gm
  for (let match = registrationRe.exec(text); match !== null; match = registrationRe.exec(text)) {
    const parent = match[1]
    const open = match.index + match[0].length - 1
    const call = readBalanced(text, open)
    const parts = splitTopLevel(call.content)
    const target = parts.length > 0 ? parts[0].replace(/\s/g, '') : ''
    result.registrations.push({
      parent,
      target,
      urlPrefix: keywordLiteral(call.content, 'url_prefix'),
      file: relPath,
      line: lineOf(starts, match.index),
    })
  }

  const runRe = /^[ \t]*([A-Za-z_]\w*)[ \t]*\.\s*run[ \t]*\(/gm
  for (let match = runRe.exec(text); match !== null; match = runRe.exec(text)) {
    const open = match.index + match[0].length - 1
    const call = readBalanced(text, open)
    const host = keywordLiteral(call.content, 'host')
    const port = keywordLiteral(call.content, 'port')
    if (host === undefined && port === undefined) continue
    result.runs.push({
      owner: match[1],
      host,
      port: port === undefined ? undefined : Number(port),
      file: relPath,
      line: lineOf(starts, match.index),
    })
  }

  const decoratorRe = /^[ \t]*@([A-Za-z_][\w.]*)/gm
  for (let match = decoratorRe.exec(text); match !== null; match = decoratorRe.exec(text)) {
    const decoratorName = match[1]
    let cursor = skipInlineSpace(text, match.index + match[0].length)
    let argsText = ''
    if (text[cursor] === '(') {
      const call = readBalanced(text, cursor)
      argsText = call.content
      cursor = call.end
    }
    const last = decoratorName.split('.').pop()
    if (last !== 'route' && !SHORTHAND_METHODS[last]) continue
    const owner = decoratorName.split('.').slice(0, -1).join('.')
    const routeLine = lineOf(starts, match.index)
    const target = findTargetDef(text, cursor)
    if (!target) {
      result.warnings.push({ file: relPath, line: routeLine, message: `no view function found for @${decoratorName}` })
      continue
    }
    const ruleText = /^[ \t]*url_rule[ \t]*=|^[ \t]*rule[ \t]*=/.test(argsText)
      ? keywordLiteral(argsText, 'rule')
      : firstPositional(argsText)
    if (ruleText === undefined) {
      result.warnings.push({ file: relPath, line: routeLine, message: `@${decoratorName} has no literal URL rule` })
      continue
    }
    const { methods, declared } = methodsOf(decoratorName, argsText)
    const { path, variables } = parseUrlRule(ruleText)
    const bodyStart = target.bodyIndex
    const body = readBlock(text, starts, bodyStart, indentAt(text, starts, bodyStart)).text
    result.routes.push({
      owner,
      file: relPath,
      line: routeLine,
      viewName: target.name,
      rule: ruleText,
      path,
      variables,
      methods,
      methodsDeclared: declared,
      params: target.params,
      decorators: target.decorators,
      statusCode: statusOf(body),
      statusCodes: statusesByMethod(body, methods),
      behavior: behaviorOf(body, target.decorators),
      docstring: docstringOf(body),
      isAsync: target.isAsync,
    })
  }

  const classRe = /^[ \t]*class[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]*)\)[ \t]*:/gm
  for (let match = classRe.exec(text); match !== null; match = classRe.exec(text)) {
    const bases = match[2]
    const framework = /(?:^|,)[ \t]*(?:[A-Za-z_][\w.]*\.)?(Model|BaseModel|Schema)\b/.test(`,${bases}`)
    if (!framework) continue
    const name = match[1]
    const kind = /BaseModel|Schema/.test(bases) ? 'pydantic' : 'sqlalchemy'
    const line = lineOf(starts, match.index)
    const headerEnd = match.index + match[0].length
    const body = readBlock(text, starts, headerEnd, indentAt(text, starts, match.index)).text
    const tableMatch = /__tablename__[ \t]*=[ \t]*['"]([^'"]+)['"]/.exec(body)
    const fields = parseModelFields(body)
    if (fields.length === 0) continue
    result.models.push({
      name,
      kind,
      table: tableMatch ? tableMatch[1] : undefined,
      file: relPath,
      line,
      fields,
    })
  }

  return result
}

/** First positional literal argument of a decorator call. */
function firstPositional(argsText) {
  for (const part of splitTopLevel(argsText)) {
    if (topLevelIndex(part, '=') !== -1) break
    const value = unquote(part)
    if (value.startsWith('/') || value.length === 0) return value
    return value
  }
  return undefined
}

/** Scan a whole project directory. */
export function scanProject(root, options = {}) {
  const skipDirs = options.skipDirs ? [...DEFAULT_SKIP_DIRS, ...options.skipDirs] : DEFAULT_SKIP_DIRS
  const maxFiles = options.maxFiles ?? 400
  const warnings = []
  const files = listPythonFiles(root, skipDirs)
  if (files.length > maxFiles) {
    warnings.push({
      file: root,
      message: `truncated: ${files.length} Python files found, only the first ${maxFiles} are scanned`,
    })
  }
  const scanned = files.slice(0, maxFiles)
  const aggregate = { apps: [], blueprints: [], routes: [], models: [], registrations: [], runs: [], warnings, files: scanned.length, totalFiles: files.length }
  for (const file of scanned) {
    const relPath = relative(root, file).split(sep).join('/')
    const text = readSource(file, warnings)
    if (text === undefined) continue
    let one
    try {
      one = scanFile(text, relPath)
    } catch (error) {
      warnings.push({ file: relPath, message: `scan failed: ${error.message}` })
      continue
    }
    aggregate.apps.push(...one.apps)
    aggregate.blueprints.push(...one.blueprints)
    aggregate.routes.push(...one.routes)
    aggregate.models.push(...one.models)
    aggregate.registrations.push(...one.registrations)
    aggregate.runs.push(...one.runs)
    for (const warning of one.warnings) warnings.push({ file: warning.file, line: warning.line, message: warning.message })
  }

  aggregate.routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return aggregate
}
