/**
 * R37-C1-A: byte-preserving DSML codec and strict parser.
 *
 * The R36/R37 parser used regular expressions for attribute values, trimmed
 * every parameter, and decoded escapes by repeated string replacement. That
 * cannot preserve a JavaScript template literal, a JSON document with escaped
 * quotes, or leading/trailing whitespace. This codec:
 *
 *   - encodes and decodes attribute values in ONE pass;
 *   - keeps parameter bodies byte-for-byte;
 *   - parses tags with a small state machine rather than a value regex;
 *   - records ambiguous or truncated input instead of guessing.
 *
 * Supported attribute escapes are `\\`, `` \` ``, `\${`, and `\"`. Unknown
 * escapes are preserved as two characters, because the codec cannot know
 * whether the backslash was literal. Newlines are literal.
 *
 * @module eval/r37c/src/dsml-codec
 */

export const DSML = '[\\uFF5C|]{2}DSML[\\uFF5C|]{2}'
export const TOOLS = new Set(['read_file', 'write_file', 'list_dir', 'run_tests', 'recall', 'finish'])
export const DIRECT_PARAMETERS = new Set(['path', 'query', 'content', 'summary'])
export const PARAMETER_NAMES = new Set(['path', 'query', 'content', 'summary', 'tool'])

const OPEN = '<'
const CLOSE = '>'
const SLASH = '/'
const EQUALS = '='
const QUOTE = '"'

/** Encode one attribute value so {@link decodeDsmlAttribute} returns it exactly. */
export function encodeDsmlAttribute(value) {
  const text = String(value ?? '')
  let encoded = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') encoded += '\\\\'
    else if (character === '`') encoded += '\\`'
    else if (character === '$' && text[index + 1] === '{') {
      encoded += '\\${'
      index += 1
    } else if (character === '"') encoded += '\\"'
    else encoded += character
  }
  return encoded
}

/**
 * Decode one attribute value in a single left-to-right pass.
 *
 * A backslash only consumes the next character when that character is one of
 * the four supported escapes. `\n`, `\t`, and a trailing backslash stay
 * literal; rewriting them would make `Decode(Encode(source))` lossy.
 */
export function decodeDsmlAttribute(value) {
  const text = String(value ?? '')
  let decoded = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character !== '\\') {
      decoded += character
      continue
    }
    const next = text[index + 1]
    if (next === '\\') { decoded += '\\'; index += 1; continue }
    if (next === '`') { decoded += '`'; index += 1; continue }
    if (next === '"') { decoded += '"'; index += 1; continue }
    if (next === '$' && text[index + 2] === '{') { decoded += '${'; index += 2; continue }
    decoded += character
  }
  return decoded
}

function isDsmlPrefix(text, index) {
  const slice = text.slice(index)
  const match = new RegExp(`^${DSML}`, 'u').exec(slice)
  return match === null ? null : match[0].length
}

function skipSpaces(text, index) {
  let cursor = index
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1
  return cursor
}

function readName(text, index) {
  let cursor = index
  while (cursor < text.length && /[A-Za-z0-9_:-]/u.test(text[cursor])) cursor += 1
  return { value: text.slice(index, cursor), end: cursor }
}

function readQuoted(text, index) {
  if (text[index] !== QUOTE) return null
  let cursor = index + 1
  let raw = ''
  while (cursor < text.length) {
    const character = text[cursor]
    if (character === '\\' && cursor + 1 < text.length) {
      raw += character + text[cursor + 1]
      cursor += 2
      continue
    }
    if (character === QUOTE) return { raw, end: cursor + 1 }
    raw += character
    cursor += 1
  }
  return { raw, end: cursor, unterminated: true }
}

/**
 * Read one DSML tag at `start`.
 *
 * Returns `{ closing, name, attrs, end, selfClosing, unterminated }`.
 * A short form such as `<DSML path="x">` has `name: null` and one attribute.
 */
export function readDsmlTag(text, start) {
  if (text[start] !== OPEN) return null
  let cursor = start + 1
  let closing = false
  if (text[cursor] === SLASH) {
    closing = true
    cursor += 1
  }
  const prefixLength = isDsmlPrefix(text, cursor)
  if (prefixLength === null) return null
  cursor += prefixLength
  cursor = skipSpaces(text, cursor)
  const first = readName(text, cursor)
  let name = first.value
  cursor = first.end
  const attrs = {}
  cursor = skipSpaces(text, cursor)
  if (text[cursor] === EQUALS) {
    // The first token was an attribute name, not a tag name.
    name = null
    cursor = skipSpaces(text, cursor + 1)
    const quoted = readQuoted(text, cursor)
    if (quoted === null) return { closing, name, attrs, end: cursor, unterminated: true }
    attrs[first.value] = quoted.raw
    cursor = quoted.end
  }
  let selfClosing = false
  while (cursor < text.length) {
    cursor = skipSpaces(text, cursor)
    if (text[cursor] === CLOSE) return { closing, name, attrs, end: cursor + 1, selfClosing, unterminated: false }
    if (text[cursor] === SLASH && text[cursor + 1] === CLOSE) {
      return { closing, name, attrs, end: cursor + 2, selfClosing: true, unterminated: false }
    }
    const attribute = readName(text, cursor)
    if (attribute.value.length === 0) {
      cursor += 1
      continue
    }
    cursor = skipSpaces(text, attribute.end)
    if (text[cursor] !== EQUALS) {
      cursor = attribute.end
      continue
    }
    cursor = skipSpaces(text, cursor + 1)
    const quoted = readQuoted(text, cursor)
    if (quoted === null) return { closing, name, attrs, end: cursor, unterminated: true }
    attrs[attribute.value] = quoted.raw
    cursor = quoted.end
  }
  return { closing, name, attrs, end: cursor, selfClosing, unterminated: true }
}

function closingTagPattern(name) {
  return new RegExp(`<\\/${DSML}\\s*${name}\\s*>`, 'u')
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/gu, '/').trim()
}

/**
 * Parse every DSML invoke in one model turn.
 *
 * Parameter bodies are not trimmed. A direct attribute is decoded in one pass.
 * An unclosed invoke is a diagnostic, not a guessed action.
 */
export function parseDsmlStrict(text) {
  const input = String(text ?? '')
  const actions = []
  const diagnostics = []
  let cursor = 0
  while (cursor < input.length) {
    const start = input.indexOf(OPEN, cursor)
    if (start === -1) break
    const tag = readDsmlTag(input, start)
    if (tag === null) {
      cursor = start + 1
      continue
    }
    if (tag.closing || tag.name !== 'invoke') {
      cursor = tag.end
      continue
    }
    const tool = decodeDsmlAttribute(tag.attrs.name ?? '')
    const params = {}
    const forms = new Set()
    let bodyCursor = tag.end
    let closed = false
    while (bodyCursor < input.length) {
      const innerStart = input.indexOf(OPEN, bodyCursor)
      if (innerStart === -1) break
      const inner = readDsmlTag(input, innerStart)
      if (inner === null) {
        bodyCursor = innerStart + 1
        continue
      }
      if (inner.closing) {
        if (inner.name === 'invoke') {
          closed = true
          bodyCursor = inner.end
          break
        }
        bodyCursor = inner.end
        continue
      }
      if (inner.name === 'invoke') {
        diagnostics.push({ reason: 'nested-invoke', detail: `nested invoke at offset ${innerStart}` })
        bodyCursor = inner.end
        continue
      }
      if (inner.name === 'parameter') {
        const key = decodeDsmlAttribute(inner.attrs.name ?? '')
        if (!PARAMETER_NAMES.has(key)) {
          diagnostics.push({ reason: 'unknown-parameter', detail: `unknown parameter ${key}` })
          bodyCursor = inner.end
          continue
        }
        const pattern = closingTagPattern('parameter')
        const rest = input.slice(inner.end)
        const match = pattern.exec(rest)
        if (match === null) {
          diagnostics.push({ reason: 'truncated-parameter', detail: `parameter ${key} has no closing tag` })
          bodyCursor = input.length
          break
        }
        const body = rest.slice(0, match.index)
        if (params[key] !== undefined) {
          diagnostics.push({ reason: 'duplicate-parameter', detail: `parameter ${key} appears twice` })
        } else {
          params[key] = key === 'path' ? normalizePath(body) : body
          forms.add('dsml-parameter')
        }
        bodyCursor = inner.end + match.index + match[0].length
        continue
      }
      if (inner.name === null) {
        for (const [key, raw] of Object.entries(inner.attrs)) {
          if (!DIRECT_PARAMETERS.has(key)) continue
          if (params[key] !== undefined) {
            diagnostics.push({ reason: 'conflicting-parameter', detail: `parameter ${key} has both forms` })
            continue
          }
          const value = decodeDsmlAttribute(raw)
          params[key] = key === 'path' ? normalizePath(value) : value
          forms.add('dsml-direct')
        }
        bodyCursor = inner.end
        continue
      }
      bodyCursor = inner.end
    }
    if (!closed) {
      diagnostics.push({ reason: 'truncated-invoke', detail: `invoke ${tool || '(empty)'} has no closing tag` })
      cursor = bodyCursor
      continue
    }
    if (tool.length === 0) {
      diagnostics.push({ reason: 'empty-tool', detail: 'invoke has no name attribute' })
      cursor = bodyCursor
      continue
    }
    if (Object.keys(params).length === 0) {
      diagnostics.push({ reason: 'empty-invoke', detail: `invoke ${tool} has no parameters` })
    }
    actions.push({
      tool,
      params,
      form: forms.has('dsml-parameter') ? 'dsml-parameter' : 'dsml-direct',
    })
    cursor = bodyCursor
  }
  return { actions, diagnostics }
}

export function validateAction(action) {
  const reasons = []
  if (!TOOLS.has(action.tool)) return [{ reason: 'unknown-tool', detail: `unknown tool ${action.tool}` }]
  const params = action.params ?? {}
  const requireString = (name, allowEmpty = false) => {
    if (params[name] === undefined) reasons.push({ reason: 'missing-parameter', detail: `${action.tool} requires ${name}` })
    else if (typeof params[name] !== 'string') reasons.push({ reason: 'parameter-type', detail: `${name} must be a string` })
    else if (!allowEmpty && params[name].length === 0) reasons.push({ reason: 'empty-parameter', detail: `${name} must not be empty` })
  }
  if (action.tool === 'read_file' || action.tool === 'write_file') {
    requireString('path')
    if (typeof params.path === 'string'
      && (params.path.startsWith('/') || params.path.includes('../') || params.path.includes('..\\'))) {
      reasons.push({ reason: 'path-escape', detail: `path ${params.path} is outside the workspace` })
    }
  }
  if (action.tool === 'write_file') requireString('content', true)
  if (action.tool === 'recall') requireString('query')
  if (action.tool === 'finish' && params.summary !== undefined && typeof params.summary !== 'string') {
    reasons.push({ reason: 'parameter-type', detail: 'summary must be a string' })
  }
  return reasons
}

/**
 * Strict P3e analysis. Source must be `model`; any other source is data and
 * can never produce a dispatchable action.
 */
export function analyzeTurnStrict(text, source = 'model') {
  if (source !== 'model') {
    return {
      actions: [],
      invalid: [],
      diagnostics: [{ reason: 'untrusted-source', detail: `${source} text is data, not a model tool request` }],
    }
  }
  const dsml = parseDsmlStrict(text)
  const actions = dsml.actions
  const diagnostics = [...dsml.diagnostics]
  if (actions.length === 0) {
    // JSON fallback is intentionally limited to one object per turn here; the
    // live harness's P3e layer parses multiple JSON actions separately.
    const parsed = parseJsonActions(String(text ?? ''))
    actions.push(...parsed.actions)
    diagnostics.push(...parsed.diagnostics)
  }
  const valid = []
  const invalid = []
  const seen = new Set()
  for (const action of actions) {
    const reasons = validateAction(action)
    if (reasons.length > 0) {
      invalid.push({ ...action, reasons })
      continue
    }
    const key = `${action.tool}|${action.params?.path ?? ''}|${action.params?.query ?? ''}`
    if (seen.has(key)) diagnostics.push({ reason: 'duplicate-action', detail: `duplicate ${action.tool} request in one turn` })
    seen.add(key)
    valid.push({ ...action, duplicate: seen.has(key) && valid.some(entry => `${entry.tool}|${entry.params?.path ?? ''}|${entry.params?.query ?? ''}` === key) })
  }
  if (actions.length > 1) diagnostics.push({ reason: 'multiple-actions', detail: `${actions.length} actions in one turn` })
  return { actions: valid, invalid, diagnostics }
}

function parseJsonActions(text) {
  const actions = []
  const diagnostics = []
  let index = text.indexOf('{')
  while (index !== -1 && actions.length < 8) {
    let end = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const character = text[cursor]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') { inString = true; continue }
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) { end = cursor + 1; break }
      }
    }
    if (end === -1) {
      diagnostics.push({ reason: 'truncated-json', detail: 'a JSON object has no closing brace' })
      break
    }
    try {
      const value = JSON.parse(text.slice(index, end))
      if (value !== null && typeof value === 'object' && typeof value.tool === 'string') {
        actions.push({ tool: value.tool, params: { ...value, tool: undefined }, form: 'json' })
      }
    } catch {
      diagnostics.push({ reason: 'invalid-json', detail: 'a JSON-looking object did not parse' })
    }
    index = text.indexOf('{', end)
  }
  return { actions, diagnostics }
}

/** Encode one direct-attribute write action. Used by the fidelity tests. */
export function encodeDirectWrite({ path, content, tool = 'write_file' }) {
  return `<｜｜DSML｜｜ invoke name="${tool}">`
    + `<｜｜DSML｜｜ path="${encodeDsmlAttribute(path)}">`
    + `<｜｜DSML｜｜ content="${encodeDsmlAttribute(content)}">`
    + `</｜｜DSML｜｜ invoke>`
}

/** Encode one parameter-body write action. Used by the fidelity tests. */
export function encodeParameterWrite({ path, content, tool = 'write_file' }) {
  if (content.includes('</｜｜DSML｜｜ parameter>') || content.includes('</||DSML|| parameter>')) {
    throw new Error('parameter-body content contains the closing parameter tag; use the direct-attribute form')
  }
  return `<｜｜DSML｜｜ invoke name="${tool}">`
    + `<｜｜DSML｜｜ parameter name="path">${path}</｜｜DSML｜｜ parameter>`
    + `<｜｜DSML｜｜ parameter name="content">${content}</｜｜DSML｜｜ parameter>`
    + `</｜｜DSML｜｜ invoke>`
}

/** Deterministic fidelity corpus for the regression test. */
export const FIDELITY_SAMPLES = [
  'plain text',
  'const value = `template ${name}`',
  'const escaped = "quoted"',
  'backslash \\ and double \\\\ backslash',
  'unicode: 你好 — café — 🚀',
  'line one\nline two\nline three',
  '  leading and trailing spaces  ',
  '',
  '{"json": "with \\"quotes\\"", "nested": {"a": [1, 2, 3]}}',
  'key: value\nlist:\n  - one\n  - two',
  'def f():\n    if True:\n        return "indented"',
  '# Heading\n\n- item\n- item\n',
  'invoke-like text: <｜｜DSML｜｜ invoke name="read_file"> is data here',
]
