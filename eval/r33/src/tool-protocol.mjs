/**
 * The custom follow-up loop's tool-action parser.
 *
 * The R36 O2 traces showed the model emitting two protocols in the same run:
 *
 *   {"tool":"read_file","path":"src/config.mjs"}
 *   <｜｜DSML｜｜ calls>
 *     <｜｜DSML｜｜ invoke name="read_file">
 *       <｜｜DSML｜｜ parameter name="path" string="true">src/config.mjs</｜｜DSML｜｜ parameter>
 *     </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * H0 only parsed the first. Every DSML turn became an invalid action, the tool
 * result was never produced, and the model reasonably concluded "the tool
 * results are empty". That is a harness protocol defect, not a model failure.
 *
 * This module parses BOTH protocols and returns a bounded list of actions. It
 * is deliberately a parser, not an executor: tool execution and the finish
 * guard stay in `live.mjs`.
 *
 * @module eval/r33/src/tool-protocol
 */

export const MAX_ACTIONS_PER_TURN = 8

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
const DIRECT_PARAMETERS = new Set(['path', 'query', 'content', 'summary', 'tool'])

function normalizePath(value) {
  return String(value ?? '').replace(/\\/gu, '/')
}

function clean(value) {
  return String(value ?? '').trim()
}

/** Parse `<｜｜DSML｜｜ invoke>` blocks. */
export function parseDsmlActions(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const actions = []
  INVOKE.lastIndex = 0
  let match
  while ((match = INVOKE.exec(text)) !== null) {
    const tool = clean(match[1])
    if (tool.length === 0) continue
    const body = match[2]
    const action = { tool }
    PARAMETER.lastIndex = 0
    let parameter
    while ((parameter = PARAMETER.exec(body)) !== null) {
      const key = clean(parameter[1])
      const value = clean(parameter[2])
      action[key] = key === 'path' ? normalizePath(value) : value
    }
    // The same model also emits the short form:
    //   <｜｜DSML｜｜ path="src/config.mjs">
    // Treat it as the parameter it is. Only known parameter names are accepted,
    // so `name="read_file"` on the invoke tag cannot become data.
    DIRECT_ATTRIBUTE.lastIndex = 0
    let attribute
    while ((attribute = DIRECT_ATTRIBUTE.exec(body)) !== null) {
      const key = clean(attribute[1])
      if (!DIRECT_PARAMETERS.has(key) || action[key] !== undefined) continue
      const value = clean(attribute[2])
      action[key] = key === 'path' ? normalizePath(value) : value
    }
    actions.push(action)
    if (actions.length >= MAX_ACTIONS_PER_TURN) break
  }
  return actions
}

/**
 * Parse one or more top-level JSON objects with a `tool` string.
 *
 * A model sometimes emits several JSON actions in one turn. H0 parsed only the
 * first and silently discarded the rest.
 */
export function parseJsonActions(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const actions = []
  let index = text.indexOf('{')
  while (index !== -1 && actions.length < MAX_ACTIONS_PER_TURN) {
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
    if (end === -1) break
    try {
      const value = JSON.parse(text.slice(index, end))
      if (value !== null && typeof value === 'object' && typeof value.tool === 'string') {
        actions.push(value)
      }
    } catch {
      // Not a JSON action; keep scanning from the next brace.
    }
    index = text.indexOf('{', end)
  }
  return actions
}

/**
 * Parse a model turn into a bounded list of actions.
 *
 * DSML wins when both are present, because a JSON snippet inside a DSML
 * parameter is data, not a second action.
 *
 * @param {string} text - the model's text for one turn.
 * @returns {object[]} actions, possibly empty.
 */
export function parseActions(text) {
  const dsml = parseDsmlActions(text)
  if (dsml.length > 0) return dsml
  return parseJsonActions(text)
}
