/**
 * Layered, provenance-aware tool-protocol analysis for R37-A.
 *
 * This is an EVAL module. It does not replace the R36 production parser and
 * does not dispatch a tool. It exists to answer three separate questions:
 *
 *   1. Which protocol forms did the model actually emit?
 *   2. Which layer of the R36 parser recognized them?
 *   3. Would a bounded, deterministic correction have made the action valid?
 *
 * Layers:
 *   P0   one JSON object per turn (the original H0 behavior)
 *   P1   P0 + complete DSML `<invoke><parameter>` blocks
 *   P2   P1 + short direct-attribute DSML inside an invoke
 *   P3   P2 + multiple actions per turn (the R36 parser)
 *   P3e  P3 + DSML attribute unescaping (a proposed correction)
 *   P4   P3e + raw-body write_file content (experimental; not production)
 *
 * P4 is deliberately not called "fixed". It guesses that the remaining body of
 * a write invoke is content; the report separates how often that guess is safe
 * from whether it should be adopted.
 *
 * @module eval/r37/src/tool-protocol-r37
 */

export const MAX_ACTIONS_PER_TURN = 8
export const TOOLS = new Set(['read_file', 'write_file', 'list_dir', 'run_tests', 'recall', 'finish'])
export const LAYERS = ['P0', 'P1', 'P2', 'P3', 'P3e', 'P4']

const DSML = '[\\uFF5C|]{2}DSML[\\uFF5C|]{2}'
const INVOKE = new RegExp(
  `<${DSML}\\s*invoke\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${DSML}\\s*invoke>`,
  'gu',
)
const PARAMETER = new RegExp(
  `<${DSML}\\s*parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${DSML}\\s*parameter>`,
  'gu',
)
const DIRECT_ATTRIBUTE = new RegExp(
  `<${DSML}\\s+([A-Za-z_][\\w-]*)="([^"]*)"[^>]*>`,
  'gu',
)
const PARAMETER_NAMES = new Set(['path', 'query', 'content', 'summary', 'tool'])
const DIRECT_PARAMETERS = new Set(['path', 'query', 'content', 'summary'])

const LAYER_FLAGS = {
  P0: { json: 'first', dsml: null, multi: false, unescape: false, rawBody: false },
  P1: { json: 'first', dsml: 'parameter', multi: false, unescape: false, rawBody: false },
  P2: { json: 'first', dsml: 'direct', multi: false, unescape: false, rawBody: false },
  P3: { json: 'multi', dsml: 'direct', multi: true, unescape: false, rawBody: false },
  P3e: { json: 'multi', dsml: 'direct', multi: true, unescape: true, rawBody: false },
  P4: { json: 'multi', dsml: 'direct', multi: true, unescape: true, rawBody: true },
}

function clean(value) {
  return String(value ?? '').trim()
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/gu, '/')
}

/**
 * Decode the escapes the model uses inside a DSML attribute value.
 *
 * A DSML attribute is a quoted string. `\`` and `\${` are the two escapes the
 * R36 traces actually contain; `\"` and `\\` are the general quoted-string
 * cases. Newlines are already literal in the trace and are not rewritten.
 */
export function decodeDsmlAttribute(value) {
  let text = String(value ?? '')
  // Order matters: consume the escaped backslash last so `\\`` does not become
  // a backslash followed by a decoded backtick.
  text = text.split('\\`').join('`')
  text = text.split('\\${').join('${')
  text = text.split('\\"').join('"')
  text = text.split('\\\\').join('\\')
  return text
}

/** Scan action-looking constructs without deciding whether they are valid. */
export function scanEmitted(text) {
  const input = String(text ?? '')
  const dsmlInvokes = (input.match(new RegExp(`<${DSML}\\s*invoke\\s+name="[^"]+"`, 'gu')) ?? []).length
  const shortAttributes = (input.match(new RegExp(`<${DSML}\\s+[A-Za-z_][\\w-]*="[^"]*"`, 'gu')) ?? []).length
  const jsonObjects = []
  let index = input.indexOf('{')
  while (index !== -1) {
    let end = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let cursor = index; cursor < input.length; cursor += 1) {
      const character = input[cursor]
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
    if (end === -1) break
    try {
      const value = JSON.parse(input.slice(index, end))
      if (value !== null && typeof value === 'object' && typeof value.tool === 'string') jsonObjects.push(value)
    } catch {
      // Not a JSON action.
    }
    index = input.indexOf('{', end)
  }
  return {
    dsmlInvokes,
    shortAttributes,
    jsonActions: jsonObjects.length,
    emitted: dsmlInvokes + jsonObjects.length,
    hasUnclosedInvoke: (input.match(new RegExp(`<${DSML}\\s*invoke`, 'gu')) ?? []).length
      > (input.match(new RegExp(`<\\/${DSML}\\s*invoke>`, 'gu')) ?? []).length,
    isTruncated: input.length >= 1000,
  }
}

/** P0/P1/P2 parse only the first JSON action; P3+ parse every top-level one. */
export function parseJsonLayer(text, multi) {
  const input = String(text ?? '')
  const actions = []
  let index = input.indexOf('{')
  while (index !== -1 && actions.length < MAX_ACTIONS_PER_TURN) {
    let end = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let cursor = index; cursor < input.length; cursor += 1) {
      const character = input[cursor]
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
    if (end === -1) break
    try {
      const value = JSON.parse(input.slice(index, end))
      if (value !== null && typeof value === 'object' && typeof value.tool === 'string') {
        actions.push({ tool: value.tool, params: { ...value, tool: undefined }, form: 'json' })
        if (!multi) break
      }
    } catch {
      // Continue scanning from the next brace.
    }
    index = input.indexOf('{', end)
  }
  return actions
}

function bodyParameters(body, mode, unescape) {
  const params = {}
  if (mode === 'parameter' || mode === 'direct') {
    PARAMETER.lastIndex = 0
    let match
    while ((match = PARAMETER.exec(body)) !== null) {
      const key = clean(match[1])
      if (!PARAMETER_NAMES.has(key)) continue
      const raw = clean(match[2])
      params[key] = key === 'path' ? normalizePath(raw) : (unescape ? decodeDsmlAttribute(raw) : raw)
    }
  }
  if (mode === 'direct') {
    DIRECT_ATTRIBUTE.lastIndex = 0
    let match
    while ((match = DIRECT_ATTRIBUTE.exec(body)) !== null) {
      const key = clean(match[1])
      if (!DIRECT_PARAMETERS.has(key) || params[key] !== undefined) continue
      const raw = clean(match[2])
      params[key] = key === 'path' ? normalizePath(raw) : (unescape ? decodeDsmlAttribute(raw) : raw)
    }
  }
  return params
}

/**
 * Extract the raw body after the last DSML tag. Only used by P4 for write_file.
 * The result is marked `rawBody: true`; it is not presented as a parsed
 * parameter.
 */
function rawBody(body) {
  const tags = [...body.matchAll(new RegExp(`<${DSML}\\s+[^>]*>`, 'gu'))]
  if (tags.length === 0) return ''
  const last = tags[tags.length - 1]
  return clean(body.slice(last.index + last[0].length))
}

export function parseDsmlLayer(text, { mode, multi, unescape, rawBody: allowRawBody }) {
  if (mode === null) return { actions: [], rejected: [] }
  const input = String(text ?? '')
  const actions = []
  const rejected = []
  INVOKE.lastIndex = 0
  let match
  while ((match = INVOKE.exec(input)) !== null && actions.length < MAX_ACTIONS_PER_TURN) {
    const tool = clean(match[1])
    if (tool.length === 0) continue
    const body = match[2]
    const params = bodyParameters(body, mode, unescape)
    if (allowRawBody && tool === 'write_file' && params.content === undefined) {
      const remainder = rawBody(body)
      if (remainder.length > 0) {
        params.content = remainder
        params.__rawBody = true
      }
    }
    actions.push({ tool, params, form: mode === 'parameter' ? 'dsml-parameter' : 'dsml-direct' })
    if (!multi) break
  }
  if (actions.length === 0) {
    const scan = scanEmitted(input)
    if (scan.hasUnclosedInvoke) {
      rejected.push({ reason: 'truncated-invoke', detail: 'an invoke tag has no closing tag in the available text' })
    } else if (scan.dsmlInvokes > 0) {
      rejected.push({ reason: 'unparsed-invoke', detail: 'an invoke is present but no supported parameter form was parsed' })
    }
  }
  return { actions, rejected }
}

function validateAction(action) {
  const reasons = []
  if (!TOOLS.has(action.tool)) {
    return [{ reason: 'unknown-tool', detail: `unknown tool ${action.tool}` }]
  }
  const params = action.params ?? {}
  const requireString = (name, allowEmpty = false) => {
    if (params[name] === undefined) reasons.push({ reason: 'missing-parameter', detail: `${action.tool} requires ${name}` })
    else if (typeof params[name] !== 'string') reasons.push({ reason: 'parameter-type', detail: `${name} must be a string` })
    else if (!allowEmpty && params[name].length === 0) reasons.push({ reason: 'empty-parameter', detail: `${name} must not be empty` })
  }
  if (action.tool === 'read_file' || action.tool === 'write_file') {
    requireString('path')
    if (typeof params.path === 'string' && (params.path.startsWith('/') || params.path.includes('../') || params.path.includes('..\\'))) {
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
 * Parse and validate one model turn.
 *
 * `source` is mandatory. Tool results and file contents are data; they are
 * never parsed into dispatchable actions, even if they contain an exact DSML
 * invocation or JSON action object.
 */
export function analyzeTurn(text, layer, source = 'model') {
  const flags = LAYER_FLAGS[layer]
  if (flags === undefined) throw new Error(`unknown layer ${layer}`)
  const raw = String(text ?? '')
  if (source !== 'model') {
    return {
      layer,
      source,
      actions: [],
      invalid: [],
      diagnostics: [{
        reason: 'untrusted-source',
        detail: `${source} text is data, not a model tool request`,
      }],
      emitted: scanEmitted(raw),
    }
  }
  const dsml = flags.dsml === null
    ? { actions: [], rejected: [] }
    : parseDsmlLayer(raw, {
      mode: flags.dsml,
      multi: flags.multi,
      unescape: flags.unescape,
      rawBody: flags.rawBody,
    })
  let actions = dsml.actions
  let diagnostics = [...dsml.rejected]
  if (actions.length === 0) {
    actions = parseJsonLayer(raw, flags.json === 'multi')
  } else if (flags.dsml === 'direct') {
    // DSML wins when present; a JSON object inside a DSML parameter is data.
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
    const duplicate = seen.has(key)
    seen.add(key)
    if (duplicate) {
      diagnostics.push({ reason: 'duplicate-action', detail: `duplicate ${action.tool} request in one turn` })
    }
    valid.push({ ...action, duplicate })
  }
  if (actions.length > 1) {
    diagnostics.push({ reason: 'multiple-actions', detail: `${actions.length} actions in one turn` })
  }
  return {
    layer,
    source,
    actions: valid,
    invalid,
    diagnostics,
    emitted: scanEmitted(raw),
  }
}

/** Aggregate one model turn across every layer, preserving the same bytes. */
export function analyzeTurnLayers(text, source = 'model') {
  const result = {}
  for (const layer of LAYERS) result[layer] = analyzeTurn(text, layer, source)
  return result
}
