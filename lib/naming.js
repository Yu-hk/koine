/**
 * Identifier and string helpers shared by both code generators.
 *
 * The two target languages disagree about casing, so every name crossing the
 * bridge is re-derived from the contract rather than carried over verbatim.
 */

/** Java keywords and literals that cannot name a type or member. */
export const JAVA_RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'true', 'false', 'null', 'record', 'var', 'yield', 'sealed', 'permits',
])

/** Python keywords that cannot name a member or module. */
export const PYTHON_RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with',
  'yield', 'match', 'case', 'type',
])

/** Split an identifier into lowercase words across snake_case and camelCase. */
export function words(identifier) {
  return String(identifier ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => word.toLowerCase())
}

/** PascalCase identifier safe as a Java class name. */
export function toPascal(identifier) {
  const joined = words(identifier).map(word => word[0].toUpperCase() + word.slice(1)).join('')
  const safe = joined.length === 0 ? 'Unnamed' : /^[0-9]/.test(joined) ? `T${joined}` : joined
  return JAVA_RESERVED.has(safe.toLowerCase()) ? `${safe}Type` : safe
}

/** lowerCamelCase identifier safe as a Java member name. */
export function toCamel(identifier) {
  const parts = words(identifier)
  const joined = parts.length === 0
    ? 'value'
    : parts[0] + parts.slice(1).map(word => word[0].toUpperCase() + word.slice(1)).join('')
  const safe = /^[0-9]/.test(joined) ? `v${joined}` : joined
  return JAVA_RESERVED.has(safe) ? `${safe}Value` : safe
}

/** snake_case identifier safe as a Python member name. */
export function toSnake(identifier) {
  const joined = words(identifier).join('_')
  const safe = joined.length === 0 ? 'value' : /^[0-9]/.test(joined) ? `v_${joined}` : joined
  return PYTHON_RESERVED.has(safe) ? `${safe}_` : safe
}

/** kebab-case artifact or directory name. */
export function toKebab(identifier) {
  const joined = words(identifier).join('-')
  return joined.length === 0 ? 'bridge' : joined
}

/** Dotted, lowercase package segments from arbitrary directory names. */
export function toPackageSegments(identifier) {
  const parts = words(identifier).map((word) => {
    if (/^[0-9]/.test(word)) return `p${word}`
    return JAVA_RESERVED.has(word) ? `${word}x` : word
  })
  return parts.length === 0 ? ['bridge'] : parts
}

/** Escape a Java string literal body. */
export function escapeJava(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/** Escape a Python string literal body. */
export function escapePython(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}
