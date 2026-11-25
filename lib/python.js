/**
 * Small, dependency-free Python source helpers: line indexing, balanced
 * parenthesis/string scanning, and top-level argument splitting.
 *
 * The scanner deliberately does not build an AST. A Flask project's route and
 * model declarations are shallow, decorator-anchored constructs, and a balanced
 * textual scan stays predictable on incomplete or unusual sources.
 */

/** Build the character offset of every line start. */
export function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

/** One-based line number of a character offset. */
export function lineOf(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

/** Number of leading spaces (tabs count as one column) on the line owning `offset`. */
export function indentAt(text, starts, offset) {
  const line = lineOf(starts, offset)
  const begin = starts[line - 1]
  let i = begin
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  return i - begin
}

/** Skip spaces and tabs only; a newline ends the run. */
function skipInlineSpace(text, index) {
  let i = index
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  return i
}

/** Skip any whitespace including newlines. */
export function skipSpace(text, index) {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/**
 * Read a balanced `(`...`)` group starting at `openIndex`.
 *
 * Quoted strings (including triple-quoted forms), comments, and nested
 * brackets are skipped so a `)` inside them never closes the group.
 *
 * @returns the inner text, the index just past the closing bracket, and whether
 *   the group was closed at all.
 */
export function readBalanced(text, openIndex) {
  const opener = text[openIndex]
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : '}'
  let depth = 0
  let i = openIndex
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch + ch + ch, i)
      const quote = triple ? ch + ch + ch : ch
      i += quote.length
      let closed = false
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text.startsWith(quote, i)) { i += quote.length; closed = true; break }
        i++
      }
      if (!closed) break
      continue
    }
    if (ch === '#') {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline + 1
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      i++
      if (depth === 0) return { content: text.slice(openIndex + 1, i - 1), end: i, closed: ch === closer }
      continue
    }
    i++
  }
  return { content: text.slice(openIndex + 1), end: text.length, closed: false, truncated: true }
}

/** Split comma-separated items at bracket depth zero, preserving quoted commas. */
export function splitTopLevel(content) {
  const parts = []
  let start = 0
  let depth = 0
  let i = 0
  while (i < content.length) {
    const ch = content[i]
    if (ch === '"' || ch === "'") {
      const triple = content.startsWith(ch + ch + ch, i)
      const quote = triple ? ch + ch + ch : ch
      i += quote.length
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue }
        if (content.startsWith(quote, i)) { i += quote.length; break }
        i++
      }
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(content.slice(start, i))
      start = i + 1
    }
    i++
  }
  parts.push(content.slice(start))
  return parts.map(part => part.trim()).filter(part => part.length > 0)
}

/** Strip one layer of matching quotes from a literal. */
export function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    if ((first === '"' || first === "'") && trimmed[trimmed.length - 1] === first) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** Read a top-level keyword-argument literal such as `url_prefix='/api'`. */
export function keywordLiteral(content, keyword) {
  for (const part of splitTopLevel(content)) {
    const match = new RegExp(`^${keyword}\\s*=\\s*(.+)$`, 's').exec(part)
    if (match) return unquote(match[1])
  }
  return undefined
}

/**
 * Split a `def` signature into parameters with their annotation and default.
 * `self`/`cls`, `*args`, `**kwargs`, and `/` markers are dropped.
 */
export function parseSignature(content) {
  const params = []
  let position = 0
  for (const part of splitTopLevel(content)) {
    if (part === '*' || part === '/' || part.startsWith('**') || part.startsWith('*')) {
      position++
      continue
    }
    let body = part
    let defaultValue
    let depth = 0
    let eq = -1
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
      else if (ch === '=' && depth === 0) { eq = i; break }
    }
    if (eq !== -1) {
      defaultValue = body.slice(eq + 1).trim()
      body = body.slice(0, eq)
    }
    let name = ''
    let annotation
    const colon = topLevelIndex(body, ':')
    if (colon !== -1) {
      name = body.slice(0, colon).trim()
      annotation = body.slice(colon + 1).trim()
    } else {
      name = body.trim()
    }
    if (name === 'self' || name === 'cls' || name.length === 0) { position++; continue }
    params.push({ name, annotation, defaultValue, position })
    position++
  }
  return params
}

/** First occurrence of `needle` outside brackets and strings. */
export function topLevelIndex(text, needle) {
  let depth = 0
  let i = 0
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
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === needle && depth === 0) return i
    i++
  }
  return -1
}

/**
 * Extract the indented block that follows a statement ending at `fromIndex`.
 * The block ends at the first non-blank line indented at or below the owner.
 */
export function readBlock(text, starts, fromIndex, ownerIndent) {
  const startLine = lineOf(starts, fromIndex)
  let endLine = startLine
  const bodyStartOffset = lineOf(starts, fromIndex) < starts.length ? starts[startLine] : text.length
  let index = bodyStartOffset
  while (index < text.length) {
    const line = lineOf(starts, index)
    if (line >= starts.length) break
    const begin = starts[line - 1]
    const end = line < starts.length ? starts[line] : text.length
    const raw = text.slice(begin, end)
    const trimmed = raw.trim()
    if (trimmed.length === 0) { index = end; continue }
    const indent = raw.length - raw.trimStart().length
    if (indent <= ownerIndent) break
    endLine = line
    index = end
  }
  const start = starts[Math.min(startLine, starts.length - 1)] ?? text.length
  const stop = endLine < starts.length ? starts[endLine] : text.length
  return { text: text.slice(start, stop), startOffset: start, firstLine: startLine + 1 }
}

/** Skip inline whitespace, returning the next non-space index. */
export { skipInlineSpace }
