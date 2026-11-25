/**
 * Spring -bridge contract extractor.
 *
 * Scans Java sources for `@RestController` classes and reads the mapping
 * annotations, parameter annotations, and DTO declarations. Comments and string
 * literals are masked before any bracket matching, so braces inside them can
 * never shift the structure.
 *
 * Model names are collected in a first pass over every file, so the second pass
 * can resolve `User` in a return type to a contract reference instead of `any`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { VOID_TYPE, fromJavaType, makeContract, normalizeType, scalar } from './ir.js'
import { toCamel } from './naming.js'

/** Directories skipped while looking for Java sources. */
const SKIP_DIRS = new Set(['.git', 'target', 'build', 'node_modules', '.idea', '.gradle', 'out'])

/**
 * Replace comment and string-literal bodies with spaces, preserving length.
 *
 * Every structural scan runs on the masked text while values are sliced from the
 * original, so indices stay valid and quoting is never misread as structure.
 */
/**
 * First meaningful line of the Javadoc block that documents an annotation.
 *
 * The summary is what a generated client shows a caller, so `Controller.method` is only a
 * fallback: it names the code, not the operation. Only annotations and whitespace may sit
 * between the comment and the mapping, otherwise the comment belongs to something else.
 */
function javadocSummary(text, index) {
  const close = text.lastIndexOf('*/', index)
  if (close < 0) return undefined
  const open = text.lastIndexOf('/**', close)
  if (open < 0) return undefined
  if (text.indexOf('*/', open) !== close) return undefined
  if (/[;{}]/.test(text.slice(close + 2, index))) return undefined
  const lines = text.slice(open + 3, close)
    .split('\n')
    .map(line => line.replace(/^\s*\*?\s?/, '').trim())
    .filter(line => line.length > 0 && !line.startsWith('@'))
  return lines.length > 0 ? lines[0] : undefined
}

export function maskJava(text) {
  const out = text.split('')
  const blank = (index) => {
    if (index < out.length && text[index] !== '\n' && text[index] !== '\r') out[index] = ' '
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { blank(i); i++ }
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      blank(i); blank(i + 1); i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { blank(i); i++ }
      blank(i); blank(i + 1); i += 2
      continue
    }
    if (ch === '"' && text.startsWith('"""', i)) {
      blank(i); blank(i + 1); blank(i + 2); i += 3
      while (i < text.length && !text.startsWith('"""', i)) { blank(i); i++ }
      blank(i); blank(i + 1); blank(i + 2); i += 3
      continue
    }
    if (ch === '"' || ch === '\'') {
      blank(i); i++
      while (i < text.length) {
        if (text[i] === '\\') { blank(i); blank(i + 1); i += 2; continue }
        if (text[i] === ch) { blank(i); i++; break }
        blank(i); i++
      }
      continue
    }
    i++
  }
  return out.join('')
}

/** Read a bracket group from the masked text. */
function readGroup(masked, openIndex, open = '(', close = ')') {
  let depth = 0
  let i = openIndex
  while (i < masked.length) {
    const ch = masked[i]
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return { innerStart: openIndex + 1, innerEnd: i, end: i + 1 }
    }
    i++
  }
  return { innerStart: openIndex + 1, innerEnd: masked.length, end: masked.length }
}

/** Split a masked range by commas at bracket depth zero. */
function splitRange(masked, start, end) {
  const parts = []
  let depth = 0
  let piece = start
  for (let i = start; i < end; i++) {
    const ch = masked[i]
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--
    else if (ch === ',' && depth === 0) { parts.push([piece, i]); piece = i + 1 }
  }
  if (piece < end) parts.push([piece, end])
  return parts.filter(([from, to]) => masked.slice(from, to).trim().length > 0)
}

/** Skip whitespace. */
function skipSpace(text, index) {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Read one `@Name(...)` annotation starting at `atIndex`. */
function readAnnotation(original, masked, atIndex) {
  let i = atIndex + 1
  while (i < masked.length && /[\w.]/.test(masked[i])) i++
  const name = original.slice(atIndex + 1, i).split('.').pop() ?? ''
  let args = ''
  let end = i
  const cursor = skipSpace(masked, i)
  if (masked[cursor] === '(') {
    const group = readGroup(masked, cursor)
    args = original.slice(group.innerStart, group.innerEnd)
    end = group.end
  }
  return { name, args, start: atIndex, end }
}

/** All annotations declared in a masked range. */
function annotationsIn(original, masked, start, end) {
  const found = []
  let i = start
  while (i < end) {
    if (masked[i] === '@' && /[A-Za-z_]/.test(masked[i + 1] ?? '')) {
      const annotation = readAnnotation(original, masked, i)
      found.push(annotation)
      i = annotation.end
      continue
    }
    i++
  }
  return found
}

/** First string literal in a span of text. */
function firstStringLiteral(text) {
  const match = /"((?:[^"\\]|\\.)*)"/.exec(text)
  return match ? match[1] : undefined
}

/** Read a `name = <string|array>` annotation attribute. */
function attributeValue(text, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*`, 'g')
  const match = pattern.exec(text)
  if (!match) return undefined
  const rest = text.slice(match.index + match[0].length)
  const string = /^"((?:[^"\\]|\\.)*)"/.exec(rest)
  if (string) return string[1]
  const braced = /^\{([^}]*)\}/.exec(rest)
  if (braced) return firstStringLiteral(braced[1])
  return undefined
}

/**
 * Wire name declared by a `@PathVariable`/`@RequestParam` annotation.
 *
 * `defaultValue = "1"` must never be mistaken for the name, so a positional
 * literal counts only when no other attribute is present.
 */
function annotationName(args) {
  const named = attributeValue(args, 'value') ?? attributeValue(args, 'name')
  if (named !== undefined) return named
  const hasAttribute = /\b(defaultValue|required|value|name)\s*=/.test(args)
  return hasAttribute ? undefined : firstStringLiteral(args)
}

/** Normalize a `{id:\\d+}` style template into `{id}`. */
function normalizeTemplate(path) {
  return String(path ?? '')
    .replace(/\{([A-Za-z_]\w*)\s*:[^}]*\}/g, '{$1}')
    .replace(/\/{2,}/g, '/')
}

/** Join a controller base path with a method path. */
function joinPath(base, path) {
  const left = String(base ?? '').replace(/\/+$/, '')
  const right = String(path ?? '').replace(/^\/+/, '')
  if (left.length === 0 && right.length === 0) return '/'
  if (left.length === 0) return `/${right}`
  if (right.length === 0) return left
  return `${left}/${right}`
}

/** HTTP verbs a mapping annotation may declare. */
const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'])

/** Every string literal in a span of text. */
function allStringLiterals(text) {
  const values = []
  const pattern = /"((?:[^"\\]|\\.)*)"/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) values.push(match[1])
  return values
}

/**
 * Every string literal inside a `{...}` array annotation argument.
 *
 * A regex bounded by the first `}` truncates on a path template such as
 * `"/runs/{identity}"`, so the array is scanned with brace depth and quoted
 * content skipped.
 */
function bracedLiterals(text) {
  const lead = /^\s*/.exec(text)[0].length
  if (text[lead] !== '{') return undefined
  let depth = 0
  let i = lead
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === '\'') {
      i++
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === ch) { i++; break }
        i++
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return allStringLiterals(text.slice(lead + 1, i))
    }
    i++
  }
  return undefined
}

/**
 * Paths declared by one mapping annotation.
 *
 * `@GetMapping({"/a", "/b"})` and `@RequestMapping(value = {"/a", "/b"})` both
 * mount several paths on one handler, so collapsing them to the first path would
 * silently drop routes.
 */
function declaredPaths(args) {
  const attribute = /\b(value|path)\s*=\s*/.exec(args)
  if (attribute !== null) {
    const rest = args.slice(attribute.index + attribute[0].length)
    const braced = bracedLiterals(rest)
    if (braced !== undefined) return braced
    const single = /^"((?:[^"\\]|\\.)*)"/.exec(rest)
    return single === null ? [] : [single[1]]
  }
  if (/\b(defaultValue|required|method|params|headers|consumes|produces)\s*=/.test(args)) return []
  const braced = bracedLiterals(args)
  if (braced !== undefined) return braced
  const single = firstStringLiteral(args)
  return single === undefined ? [] : [single]
}

/** Resolve the verbs and paths of one mapping annotation. */
function mappingOf(annotation) {
  const suffix = annotation.name.replace(/Mapping$/, '').toUpperCase()
  const fromName = VERBS.has(suffix) ? [suffix] : []
  const fromArgs = []
  const declared = /RequestMethod\.([A-Z]+)/g
  for (let match = declared.exec(annotation.args); match !== null; match = declared.exec(annotation.args)) {
    if (VERBS.has(match[1])) fromArgs.push(match[1])
  }
  const verbs = fromArgs.length > 0 ? fromArgs : fromName.length > 0 ? fromName : ['GET']
  return { verbs, paths: declaredPaths(annotation.args) }
}

/** Small HTTP status table covering the values people actually annotate. */
const HTTP_STATUS = {
  OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, PARTIAL_CONTENT: 206,
  MOVED_PERMANENTLY: 301, FOUND: 302, NOT_MODIFIED: 304,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, CONFLICT: 409, GONE: 410, UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503,
}

/** Numeric value of an `HttpStatus` constant. */
function httpStatusValue(name) {
  return HTTP_STATUS[name] ?? 200
}

/** Status implied by a `ResponseEntity` convenience method. */
const RESPONSE_SHORTCUTS = {
  ok: 200, created: 201, accepted: 202, noContent: 204,
  badRequest: 400, unauthorized: 401, forbidden: 403, notFound: 404,
  conflict: 409, unprocessableEntity: 422,
}

/**
 * Resolve the HTTP status a handler declares.
 *
 * A method body usually holds several statuses: an error branch first and the
 * normal path last. An interface contract describes the normal path, so a
 * declared 2xx wins; only a handler with no successful branch falls back to its
 * first declared status.
 */
function statusOf(annotations, body) {
  for (const annotation of annotations) {
    if (annotation.name !== 'ResponseStatus') continue
    const named = /HttpStatus\.([A-Z_]+)/.exec(annotation.args)
    if (named) return httpStatusValue(named[1])
    const numeric = Number(firstStringLiteral(annotation.args))
    if (Number.isInteger(numeric) && numeric > 0) return numeric
  }
  const declared = []
  for (const match of body.matchAll(/\bstatus\s*\(\s*(\d{3})\s*\)/g)) declared.push(Number(match[1]))
  for (const match of body.matchAll(/\bResponseEntity\s*\.\s*([a-zA-Z]+)\s*\(/g)) {
    const shortcut = RESPONSE_SHORTCUTS[match[1]]
    if (shortcut !== undefined) declared.push(shortcut)
  }
  const success = declared.find(status => status >= 200 && status < 300)
  if (success !== undefined) return success
  return declared.length > 0 ? declared[0] : 200
}

/** Scalar class names that map without a model lookup, so they never become hints. */
const SCALAR_CLASS_NAMES = new Set([
  'String', 'CharSequence', 'Object', 'Integer', 'Long', 'Short', 'Byte', 'Double',
  'Float', 'Boolean', 'Character', 'BigDecimal', 'BigInteger', 'Instant', 'LocalDate',
  'LocalTime', 'LocalDateTime', 'OffsetDateTime', 'ZonedDateTime', 'UUID', 'JsonNode',
  'Number',
])

/** Response types that cannot be a buffered JSON body. */
const STREAMING_TYPES = new Set([
  'StreamingResponseBody', 'SseEmitter', 'ResponseBodyEmitter', 'Flux', 'Mono',
  'Publisher', 'ServerSentEvent', 'InputStreamResource', 'Resource',
])

/**
 * Map a declared Java type, recording any unresolved class name so the caller can
 * turn it into a model on a later pass.
 */
function mapType(raw, modelNames, sink) {
  const mapped = fromJavaType(raw, modelNames)
  if (sink !== undefined && mapped.kind === 'scalar' && mapped.name === 'any') {
    const simple = String(raw).replace(/<[\s\S]*$/, '').replace(/\[\s*\]$/, '').trim()
    if (/^[A-Z][A-Za-z0-9_$]*$/.test(simple) && !SCALAR_CLASS_NAMES.has(simple)) sink.add(simple)
  }
  return normalizeType(mapped)
}

/** Whether a declared type names a streaming body. */
function isStreamingType(raw) {
  return STREAMING_TYPES.has(String(raw).replace(/<[\s\S]*$/, '').trim())
}

/** Parse one method parameter declaration into a neutral parameter. */
function parseParameter(original, masked, from, to, modelNames, sink) {
  const sub = masked.slice(from, to)
  const annotations = annotationsIn(original, masked, from, to)
  let stripped = ''
  let cursor = 0
  for (const annotation of annotations) {
    const localStart = annotation.start - from
    const localEnd = annotation.end - from
    if (localStart >= cursor) {
      stripped += sub.slice(cursor, localStart)
      cursor = localEnd
    }
  }
  stripped += sub.slice(cursor)
  const head = stripped.trim().replace(/\bfinal\b/g, ' ').trim()
  const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(head)
  if (!nameMatch) return undefined
  const name = nameMatch[1]
  const typeText = head.slice(0, nameMatch.index).trim()
  if (typeText.length === 0) return undefined

  const annotationFor = annotationName => annotations.find(annotation => annotation.name === annotationName)
  const body = annotationFor('RequestBody')
  if (body !== undefined) return { kind: 'body', type: mapType(typeText, modelNames, sink) }

  const pathVariable = annotationFor('PathVariable')
  if (pathVariable !== undefined) {
    return {
      kind: 'param',
      in: 'path',
      name: annotationName(pathVariable.args) ?? name,
      type: mapType(typeText, modelNames, sink),
      required: true,
    }
  }
  const requestParam = annotationFor('RequestParam')
  if (requestParam !== undefined) {
    const defaultValue = attributeValue(requestParam.args, 'defaultValue')
    const optional = /required\s*=\s*false/.test(requestParam.args) || defaultValue !== undefined
    return {
      kind: 'param',
      in: 'query',
      name: annotationName(requestParam.args) ?? name,
      type: mapType(typeText, modelNames, sink),
      required: !optional,
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
    }
  }
  return undefined
}

/** Parse the component list of a Java record. */
function parseRecordComponents(original, masked, openParen, modelNames, sink) {
  const group = readGroup(masked, openParen)
  const fields = []
  for (const [from, to] of splitRange(masked, group.innerStart, group.innerEnd)) {
    const annotations = annotationsIn(original, masked, from, to)
    let stripped = ''
    let cursor = from
    for (const annotation of annotations) {
      if (annotation.start >= cursor) {
        stripped += masked.slice(cursor, annotation.start)
        cursor = annotation.end
      }
    }
    stripped += masked.slice(cursor, to)
    const head = stripped.trim()
    const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(head)
    if (!nameMatch) continue
    const fieldType = head.slice(0, nameMatch.index).trim()
    if (fieldType.length === 0) continue
    fields.push({
      name: nameMatch[1],
      type: mapType(fieldType, modelNames, sink),
      required: annotations.some(annotation => ['NotBlank', 'NotNull', 'NotEmpty'].includes(annotation.name)),
      ...(annotations.some(annotation => annotation.name === 'Size') ? { note: 'length constrained' } : {}),
    })
  }
  return fields
}

/** Collect every `.java` file below a directory. */
function listJavaFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Dot-directories hold tool state (.git, .idea, .tmp, .archify), never sources.
        if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) stack.push(full)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.java')) files.push(full)
    }
  }
  return files.sort()
}

/** Read `server.port` from the Spring configuration files, if present. */
function inferPort(root) {
  const candidates = [
    join(root, 'src', 'main', 'resources', 'application.properties'),
    join(root, 'src', 'main', 'resources', 'application.yml'),
    join(root, 'src', 'main', 'resources', 'application.yaml'),
    join(root, 'application.properties'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const text = readFileSync(candidate, 'utf8')
    const match = /(?:^|\n)\s*(?:server\.)?port\s*[:=]\s*(\d+)/.exec(text)
    if (match) return Number(match[1])
  }
  return 8080
}

/** One-based line number of a character offset. */
function lineOfIndex(text, offset) {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/** Model names declared anywhere in one file, so references resolve. */
export function modelNamesIn(text) {
  const masked = maskJava(text)
  const names = new Set()
  const recordRe = /\brecord\s+([A-Za-z_]\w*)\s*\(/g
  for (let match = recordRe.exec(masked); match !== null; match = recordRe.exec(masked)) names.add(match[1])
  const entityRe = /@(Entity|Table)\b/g
  for (let match = entityRe.exec(masked); match !== null; match = entityRe.exec(masked)) {
    const annotation = readAnnotation(text, masked, match.index)
    const classRe = /\bclass\s+([A-Za-z_]\w*)/g
    classRe.lastIndex = annotation.end
    const declared = classRe.exec(masked)
    if (declared) names.add(declared[1])
  }
  return names
}

/** Neutral type of a `ResponseEntity<T>` / `void` / model return. */
function responseTypeOf(returnText, status, modelNames, sink) {
  if (status === 204 || status === 205 || status === 304) return VOID_TYPE
  const text = returnText.trim()
  if (text.length === 0 || text === 'void' || text === 'Void') return VOID_TYPE
  const unwrapped = /^(?:ResponseEntity|HttpEntity|Optional)<([\s\S]*)>$/.exec(text)
  const inner = (unwrapped ? unwrapped[1] : text).trim()
  if (inner === 'Void' || inner === 'void') return VOID_TYPE
  return mapType(inner, modelNames, sink)
}

/** Scan one file into models and controller operations. */
export function scanJavaFile(text, relPath, globalModelNames, sink) {
  const masked = maskJava(text)
  const models = []
  const controllers = []
  const warnings = []
  const localNames = new Set([...globalModelNames, ...modelNamesIn(text)])
  const modelNames = localNames

  // --- models: records ---------------------------------------------------
  const recordRe = /\brecord\s+([A-Za-z_]\w*)\s*\(/g
  for (let match = recordRe.exec(masked); match !== null; match = recordRe.exec(masked)) {
    const openParen = match.index + match[0].length - 1
    const group = readGroup(masked, openParen)
    const fields = parseRecordComponents(text, masked, openParen, modelNames, sink)
    recordRe.lastIndex = group.end
    if (fields.length === 0) continue
    models.push({ name: match[1], origin: 'json', fields })
  }

  // --- models: @Entity / @Table classes ----------------------------------
  const entityRe = /@(Entity|Table)\b/g
  const seenEntities = new Set()
  for (let match = entityRe.exec(masked); match !== null; match = entityRe.exec(masked)) {
    const annotation = readAnnotation(text, masked, match.index)
    const classRe = /\bclass\s+([A-Za-z_]\w*)/g
    classRe.lastIndex = annotation.end
    const declared = classRe.exec(masked)
    if (!declared) continue
    const name = declared[1]
    if (seenEntities.has(name)) continue
    const openBrace = masked.indexOf('{', classRe.lastIndex)
    if (openBrace === -1) continue
    const body = readGroup(masked, openBrace, '{', '}')
    const bodyText = masked.slice(body.innerStart, body.innerEnd)
    const fields = []
    const fieldRe = /^\s*(?:private|protected|public)\s+(?!static)([\w$.<>\[\],?\s]+?)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;/gm
    for (let field = fieldRe.exec(bodyText); field !== null; field = fieldRe.exec(bodyText)) {
      const typeText = field[1].trim()
      if (typeText.length === 0 || typeText === 'class') continue
      fields.push({ name: field[2], type: mapType(typeText, modelNames, sink), required: false })
    }
    seenEntities.add(name)
    const headerAnnotations = annotationsIn(text, masked, annotation.end, declared.index)
    const tableAnnotation = headerAnnotations.find(entry => entry.name === 'Table')
      ?? (annotation.name === 'Table' ? annotation : undefined)
    const tableName = tableAnnotation === undefined
      ? undefined
      : attributeValue(tableAnnotation.args, 'name') ?? firstStringLiteral(tableAnnotation.args)
    entityRe.lastIndex = body.end
    if (fields.length === 0) continue
    models.push({ name, origin: 'table', ...(tableName === undefined ? {} : { table: tableName }), fields })
  }

  // --- controllers -------------------------------------------------------
  const controllerRe = /@(RestController|Controller)\b/g
  for (let match = controllerRe.exec(masked); match !== null; match = controllerRe.exec(masked)) {
    const classRe = /\bclass\s+([A-Za-z_]\w*)/g
    classRe.lastIndex = match.index
    const declared = classRe.exec(masked)
    if (!declared) continue
    const className = declared[1]
    const openBrace = masked.indexOf('{', classRe.lastIndex)
    if (openBrace === -1) continue
    const classBody = readGroup(masked, openBrace, '{', '}')
    controllerRe.lastIndex = classBody.end

    const boundary = Math.max(
      masked.lastIndexOf(';', match.index),
      masked.lastIndexOf('}', match.index),
      masked.lastIndexOf('{', match.index),
    )
    const header = annotationsIn(text, masked, boundary + 1, declared.index)
    const classMapping = header.find(annotation => annotation.name === 'RequestMapping')
    const basePath = classMapping === undefined ? '' : normalizeTemplate(mappingOf(classMapping).paths[0])

    const operations = []
    const mappingRe = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g
    mappingRe.lastIndex = classBody.innerStart
    for (let annotationMatch = mappingRe.exec(masked); annotationMatch !== null; annotationMatch = mappingRe.exec(masked)) {
      if (annotationMatch.index >= classBody.innerEnd) break
      let depth = 0
      for (let i = classBody.innerStart; i < annotationMatch.index; i++) {
        if (masked[i] === '{') depth++
        else if (masked[i] === '}') depth--
      }
      if (depth !== 0) continue

      const annotation = readAnnotation(text, masked, annotationMatch.index)
      const { verbs, paths } = mappingOf(annotation)
      let cursor = annotation.end
      const leading = []
      for (let guard = 0; guard < 16; guard++) {
        cursor = skipSpace(masked, cursor)
        if (masked[cursor] !== '@') break
        const next = readAnnotation(text, masked, cursor)
        leading.push(next)
        cursor = next.end
      }
      const openParen = masked.indexOf('(', cursor)
      if (openParen === -1 || openParen > classBody.innerEnd) continue
      const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(masked.slice(cursor, openParen))
      if (!nameMatch) continue
      const methodName = nameMatch[1]
      const returnText = text.slice(cursor, openParen)
        .slice(0, text.slice(cursor, openParen).length - nameMatch[0].length)
        .replace(/@[A-Za-z_][\w.]*\s*(?:\([^)]*\))?/g, ' ')
        .replace(/\b(public|private|protected|static|final|synchronized|abstract|default|native)\b/g, ' ')
        .trim()

      const paramsGroup = readGroup(masked, openParen)
      const bodyBrace = masked.indexOf('{', paramsGroup.end)
      let methodBody = ''
      if (bodyBrace !== -1 && bodyBrace <= classBody.innerEnd) {
        const body = readGroup(masked, bodyBrace, '{', '}')
        methodBody = text.slice(body.innerStart, body.innerEnd)
        mappingRe.lastIndex = body.end
      } else {
        mappingRe.lastIndex = paramsGroup.end
      }

      const params = []
      let requestBody
      for (const [from, to] of splitRange(masked, paramsGroup.innerStart, paramsGroup.innerEnd)) {
        const parsed = parseParameter(text, masked, from, to, modelNames, sink)
        if (!parsed) continue
        if (parsed.kind === 'body') {
          requestBody = normalizeType(parsed.type)
          continue
        }
        params.push({
          in: parsed.in,
          name: parsed.name,
          type: normalizeType(parsed.type),
          required: parsed.required !== false,
          ...(parsed.default === undefined ? {} : { default: parsed.default }),
        })
      }

      const status = statusOf(leading, methodBody)
      const streaming = isStreamingType(returnText.replace(/^(?:ResponseEntity|HttpEntity)<([\s\S]*)>$/, '$1'))
      const returnType = streaming ? scalar('string') : responseTypeOf(returnText, status, modelNames, sink)
      const line = lineOfIndex(masked, annotationMatch.index)
      for (const path of (paths.length > 0 ? paths : [''])) {
        const fullPath = normalizeTemplate(joinPath(basePath, path))
        for (const verb of verbs) {
          const multiVerb = verbs.length > 1
          const multiPath = paths.length > 1
          const suffix = multiVerb ? `_${verb.toLowerCase()}` : multiPath ? `_${toCamel(path.replace(/[^A-Za-z0-9]+/g, ' ')) || 'root'}` : ''
          operations.push({
            id: toCamel(methodName) + suffix,
            method: verb,
            path: fullPath,
            summary: javadocSummary(text, annotationMatch.index) ?? `${className}.${methodName}`,
            params,
            ...(requestBody === undefined ? {} : { requestBody }),
            responses: [{ status, type: returnType }],
            ...(streaming ? { streaming: true } : {}),
            source: { file: relPath, line },
          })
        }
      }
    }

    if (operations.length === 0) {
      warnings.push({ file: relPath, message: `@RestController ${className} declares no mapping annotations` })
    }
    controllers.push({ className, basePath, operations })
  }

  return { models, controllers, warnings }
}

/**
 * Extract a contract from a Spring project tree.
 *
 * @param root absolute project directory.
 * @param options optional service name and scan bounds.
 */
export function extractSpring(root, options = {}) {
  const files = listJavaFiles(root)
  const maxFiles = options.maxFiles ?? 2000
  const scanned = files.slice(0, maxFiles)
  const warnings = []
  if (files.length > maxFiles) {
    warnings.push({ file: root, message: `truncated: ${files.length} Java files found, only the first ${maxFiles} are scanned` })
  }

  const sources = []
  for (const file of scanned) {
    const relPath = relative(root, file).split(sep).join('/')
    // Test sources declare fixtures, not the served interface.
    if (relPath.includes('src/test/') || relPath.includes('src/testFixtures/')) continue
    try {
      if (statSync(file).size > 2_000_000) {
        warnings.push({ file: relPath, message: 'skipped: source larger than 2 MB' })
        continue
      }
      sources.push({ relPath, text: readFileSync(file, 'utf8') })
    } catch (error) {
      warnings.push({ file: relPath, message: `skipped: ${error.message}` })
    }
  }

  // Pass 1: every declared model name, so the controller pass can resolve references.
  const globalModelNames = new Set()
  for (const source of sources) {
    for (const name of modelNamesIn(source.text)) globalModelNames.add(name)
  }

  // Pass 2: models and controllers, plus every class name a handler could not resolve.
  const models = []
  const seenModels = new Set()
  const operations = []
  const unresolved = new Set()
  for (const source of sources) {
    let scannedFile
    try {
      scannedFile = scanJavaFile(source.text, source.relPath, globalModelNames, unresolved)
    } catch (error) {
      warnings.push({ file: source.relPath, message: `scan failed: ${error.message}` })
      continue
    }
    for (const model of scannedFile.models) {
      if (seenModels.has(model.name)) continue
      seenModels.add(model.name)
      models.push({ ...model, file: source.relPath })
    }
    operations.push(...scannedFile.controllers.flatMap(controller => controller.operations))
    warnings.push(...scannedFile.warnings)
  }

  // Pass 3: a class that crosses the wire is a DTO even without a record or @Entity.
  const classIndex = new Map()
  for (const source of sources) {
    const masked = maskJava(source.text)
    for (const match of masked.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)) {
      if (!classIndex.has(match[1])) classIndex.set(match[1], source)
    }
  }
  const components = new Set()
  for (const source of sources) {
    const masked = maskJava(source.text)
    for (const match of masked.matchAll(/@(?:Service|Component|Repository|Configuration|RestController|Controller|Bean|ConfigurationProperties)\b/g)) {
      const classMatch = /\bclass\s+([A-Za-z_]\w*)/g
      classMatch.lastIndex = match.index
      const declared = classMatch.exec(masked)
      if (declared) components.add(declared[1])
    }
  }

  // Collect raw field declarations first; the types are mapped once every DTO name
  // is known, so two DTOs referencing each other both resolve.
  const rawClassModels = []
  for (const name of unresolved) {
    if (seenModels.has(name) || components.has(name)) continue
    const source = classIndex.get(name)
    if (source === undefined) continue
    const rawFields = scanPlainClassFields(source.text, name)
    if (rawFields.length === 0) continue
    seenModels.add(name)
    globalModelNames.add(name)
    rawClassModels.push({ name, origin: 'json', rawFields, file: source.relPath })
  }
  const classModels = rawClassModels.map(model => ({
    name: model.name,
    origin: model.origin,
    file: model.file,
    fields: model.rawFields.map(field => ({
      name: field.name,
      type: mapType(field.raw, globalModelNames, undefined),
      required: false,
    })),
  }))
  models.push(...classModels)
  if (classModels.length > 0) {
    warnings.push({
      file: root,
      message: `${classModels.length} plain class(es) treated as wire DTOs: `
        + classModels.map(model => model.name).join(', ')
        + '. Field types resolve at one level; a class no handler references stays json.',
    })
  }

  const seen = new Set()
  const usedIds = new Map()
  const deduped = []
  for (const operation of operations) {
    const key = `${operation.method} ${operation.path}`
    if (seen.has(key)) {
      warnings.push({ file: operation.source.file, line: operation.source.line, message: `duplicate mapping ${key} ignored` })
      continue
    }
    seen.add(key)
    const count = (usedIds.get(operation.id) ?? 0) + 1
    usedIds.set(operation.id, count)
    deduped.push(count === 1 ? operation : { ...operation, id: `${operation.id}${count}` })
  }
  deduped.sort((a, b) => a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line)

  // Pass 4: re-read the handlers now that the DTO names are known, so responses
  // reference models instead of falling back to json. Operation ids are kept.
  if (classModels.length > 0) {
    const refined = []
    for (const source of sources) {
      try {
        const rescanned = scanJavaFile(source.text, source.relPath, globalModelNames, new Set())
        refined.push(...rescanned.controllers.flatMap(controller => controller.operations))
      } catch {
        // The first pass already reported the failure for this file.
      }
    }
    const idByKey = new Map()
    for (const operation of deduped) idByKey.set(`${operation.method} ${operation.path}`, operation.id)
    const finalSeen = new Set()
    deduped.length = 0
    for (const operation of refined) {
      const key = `${operation.method} ${operation.path}`
      if (finalSeen.has(key)) continue
      finalSeen.add(key)
      deduped.push({ ...operation, id: idByKey.get(key) ?? operation.id })
    }
    deduped.sort((a, b) => a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line)
  }

  return makeContract({
    kind: 'spring',
    name: options.name ?? basename(root),
    baseUrl: `http://127.0.0.1:${inferPort(root)}`,
    source: { root, files: sources.length },
    operations: deduped,
    models,
    warnings,
  })
}

/**
 * Read the raw field declarations of a plain (non-record) class.
 *
 * Only instance fields declared directly in the class body count: statics are
 * constants and getters are not fields, so neither adds a wire property.
 */
function scanPlainClassFields(text, className) {
  const masked = maskJava(text)
  const classRe = new RegExp(`\\bclass\\s+${className}\\b`)
  const declared = classRe.exec(masked)
  if (!declared) return []
  const openBrace = masked.indexOf('{', declared.index + declared[0].length)
  if (openBrace === -1) return []
  const body = readGroup(masked, openBrace, '{', '}')
  const bodyText = masked.slice(body.innerStart, body.innerEnd)
  const fields = []
  const fieldRe = /^\s*(?:private|protected|public)\s+(?!static)([\w$.<>\[\],?\s]+?)\s+([A-Za-z_]\w*)\s*(?:=[^;]*)?;/gm
  for (let field = fieldRe.exec(bodyText); field !== null; field = fieldRe.exec(bodyText)) {
    const raw = field[1].trim()
    if (raw.length === 0 || raw === 'class' || raw === 'return') continue
    fields.push({ name: field[2], raw })
  }
  return fields
}

export { firstStringLiteral }
