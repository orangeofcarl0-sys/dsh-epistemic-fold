/**
 * Bounded writer-protocol classification and envelope recovery (P1).
 *
 * R35's aggregate `protocolMalformed` merged structurally different failures:
 * a valid bare array, a sequence of concatenated objects, a real JSON syntax
 * error, and a lost row all looked the same. This module names them using the
 * bytes the model actually emitted.
 *
 * P1 is an EVAL ABLATION, not a production parser change. It may only repair
 * an unambiguous envelope:
 *
 *   ["bare array"]                 -> {"deltas":["bare array"]}
 *   {delta object}                 -> {"deltas":[{delta object}]}
 *   {object}{object}               -> {"deltas":[{object},{object}]}
 *   missing / unclosed envelope    -> only when the JSON value is complete
 *
 * It never rewrites a fact, kind, status, subjectKey, quote, or evidence list.
 * It never guesses at truncated JSON and never repairs a syntax error such as
 * an unescaped quote. Every recovered delta must still pass the real validator.
 *
 * @module eval/r36/writer-protocol
 */

import { createHash } from 'node:crypto'

const writerModule = await import('../../lib/semantic/writer.js')
  .catch(() => import('../../src/semantic/writer.ts'))
export const { parseWriterOutput } = writerModule

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'for', 'with',
  'as', 'at', 'by', 'from', 'it', 'its', 'we', 'you', 'they', 'he', 'she', 'i', 'not', 'no',
  'must', 'should', 'will', 'would', 'can', 'could', 'may', 'might', 'has', 'have', 'had',
  'do', 'does', 'did', 'so', 'because', 'when', 'where', 'which', 'what', 'who', 'how',
])

export function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()
}

export function tokens(text) {
  return new Set(normalize(text).split(' ').filter(token => token.length > 3 && !STOPWORDS.has(token)))
}

export function containment(left, right) {
  const leftTokens = tokens(left)
  const rightTokens = tokens(right)
  if (leftTokens.size === 0) return 0
  let matched = 0
  for (const token of leftTokens) if (rightTokens.has(token)) matched += 1
  return matched / leftTokens.size
}

/**
 * Split a concatenation of top-level JSON values without rewriting them.
 *
 * @returns the parsed values, or `undefined` when the text is not a complete
 *   sequence (a truncated value is deliberately not guessed at).
 */
export function parseJsonValues(text) {
  const values = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index])) index += 1
    if (index >= text.length) break
    const open = text[index]
    if (open !== '{' && open !== '[') return undefined
    const stack = []
    let inString = false
    let escaped = false
    let end = -1
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const character = text[cursor]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') { inString = true; continue }
      if (character === '{' || character === '[') stack.push(character)
      else if (character === '}' || character === ']') {
        stack.pop()
        if (stack.length === 0) { end = cursor + 1; break }
      }
    }
    if (end === -1) return undefined
    try {
      values.push(JSON.parse(text.slice(index, end)))
    } catch {
      return undefined
    }
    index = end
  }
  return values.length === 0 ? undefined : values
}

function between(text, open, close) {
  const start = text.indexOf(open)
  if (start === -1) return { found: false, closed: false, block: undefined }
  const from = start + open.length
  const end = text.indexOf(close, from)
  if (end === -1) return { found: true, closed: false, block: text.slice(from) }
  return { found: true, closed: true, block: text.slice(from, end) }
}

function unfence(text) {
  const trimmed = text.trim()
  const match = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return match === null ? trimmed : match[1].trim()
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

/**
 * Name the structural failure of a non-parsed response.
 *
 * @param {string|null} text - the raw response, or null when it was lost.
 * @param {object} [parse] - the P0 result; recomputed when omitted.
 */
export function classifyWriterFailure(text, parse = undefined) {
  const parsed = parse ?? (text === null ? undefined : parseWriterOutput(text))
  if (parsed?.deltaParse === 'parsed') {
    return { category: 'parsed', recoverableProposals: parsed.proposed.length, detail: null }
  }
  if (text === null || text === undefined) {
    return { category: 'unknown', recoverableProposals: null, detail: 'raw output was not retained' }
  }
  const block = between(text, '<deltas>', '</deltas>')
  if (!block.found) {
    const whole = unfence(text)
    if (whole.startsWith('[') || whole.startsWith('{')) {
      const values = parseJsonValues(whole)
      if (values !== undefined) {
        return {
          category: 'absent-deltas-envelope',
          recoverableProposals: values.reduce((total, value) => total + (Array.isArray(value) ? value.length : 1), 0),
          detail: 'no <deltas> block; the response is a bare JSON value',
        }
      }
    }
    return { category: 'absent-deltas-envelope', recoverableProposals: null, detail: 'the response has no <deltas> block' }
  }
  const rawBlock = unfence(block.block ?? '')
  if (!block.closed) {
    const values = parseJsonValues(rawBlock)
    return {
      category: values === undefined ? 'truncated-output' : 'unclosed-deltas-envelope',
      recoverableProposals: values === undefined
        ? null
        : values.reduce((total, value) => total + (Array.isArray(value) ? value.length : 1), 0),
      detail: values === undefined
        ? 'the <deltas> block is unclosed and its JSON is incomplete'
        : 'the <deltas> block is unclosed but its JSON is complete',
    }
  }
  if (rawBlock.startsWith('[')) {
    try {
      const value = JSON.parse(rawBlock)
      return {
        category: 'bare-json-array',
        recoverableProposals: Array.isArray(value) ? value.length : null,
        detail: 'the block is an array, not the required {"deltas":[...]} object',
      }
    } catch (error) {
      return {
        category: 'invalid-json-syntax',
        recoverableProposals: null,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
  if (rawBlock.startsWith('{')) {
    try {
      const value = JSON.parse(rawBlock)
      if (value !== null && typeof value === 'object' && Array.isArray(value.deltas)) {
        return {
          category: 'invalid-top-level-schema',
          recoverableProposals: value.deltas.length,
          detail: 'the block parses but the P0 parser did not accept it',
        }
      }
      return {
        category: 'invalid-top-level-schema',
        recoverableProposals: 1,
        detail: 'the block is a delta object without the {"deltas":[...]} wrapper',
      }
    } catch {
      const sequence = parseJsonValues(rawBlock)
      if (sequence !== undefined && sequence.every(value => value !== null && typeof value === 'object' && !Array.isArray(value))) {
        return {
          category: 'bare-json-object',
          recoverableProposals: sequence.length,
          detail: `${sequence.length} concatenated top-level object(s), not one {"deltas":[...]} object`,
        }
      }
      return {
        category: 'invalid-json-syntax',
        recoverableProposals: null,
        detail: 'the block does not parse as JSON',
      }
    }
  }
  return { category: 'other', recoverableProposals: null, detail: 'the block has no JSON value' }
}

/**
 * Attempt P1's bounded envelope recovery.
 *
 * @param {string|null} text - raw writer response.
 * @returns {object} `status: 'parsed-p0' | 'recovered' | 'unrecovered'`, the
 *   deltas (when available), the category, and a content-preservation digest.
 */
export function recoverWriterOutput(text) {
  if (text === null || text === undefined) {
    return { status: 'unrecovered', category: 'unknown', detail: 'raw output was not retained', deltas: [] }
  }
  const p0 = parseWriterOutput(text)
  if (p0.deltaParse === 'parsed') {
    return {
      status: 'parsed-p0',
      category: 'parsed',
      deltas: p0.proposed,
      handoff: p0.handoff,
      recovery: 'none',
      contentPreserved: true,
      sourceDigest: digest(p0.proposed),
    }
  }
  const classification = classifyWriterFailure(text, p0)
  if (classification.category === 'invalid-json-syntax' || classification.category === 'truncated-output') {
    return {
      status: 'unrecovered',
      category: classification.category,
      detail: classification.detail,
      deltas: [],
      handoff: p0.handoff,
    }
  }
  const block = between(text, '<deltas>', '</deltas>')
  const candidate = unfence(block.found ? block.block ?? '' : text)
  const values = parseJsonValues(candidate)
  if (values === undefined) {
    return {
      status: 'unrecovered',
      category: classification.category,
      detail: 'the value is not a complete JSON array/object sequence',
      deltas: [],
      handoff: p0.handoff,
    }
  }

  let deltas
  let recovery
  let source
  if (values.length === 1 && Array.isArray(values[0])) {
    deltas = values[0]
    recovery = 'bare-array'
    source = values[0]
  } else if (values.length === 1 && values[0] !== null && typeof values[0] === 'object'
    && Array.isArray(values[0].deltas)) {
    deltas = values[0].deltas
    recovery = 'missing-envelope'
    source = values[0].deltas
  } else if (values.length === 1 && values[0] !== null && typeof values[0] === 'object'
    && typeof values[0].kind === 'string' && typeof values[0].statement === 'string') {
    deltas = [values[0]]
    recovery = 'bare-delta-object'
    source = [values[0]]
  } else if (values.every(value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.kind === 'string' && typeof value.statement === 'string')) {
    deltas = values
    recovery = 'object-sequence'
    source = values
  } else {
    return {
      status: 'unrecovered',
      category: classification.category,
      detail: 'the JSON values are not delta objects',
      deltas: [],
      handoff: p0.handoff,
    }
  }
  if (!Array.isArray(deltas) || deltas.some(delta => delta === null || typeof delta !== 'object')) {
    return {
      status: 'unrecovered',
      category: classification.category,
      detail: 'a recovered entry is not an object',
      deltas: [],
      handoff: p0.handoff,
    }
  }
  return {
    status: 'recovered',
    category: classification.category,
    recovery,
    deltas,
    handoff: p0.handoff,
    contentPreserved: digest(source) === digest(deltas),
    sourceDigest: digest(source),
    recoveredDigest: digest(deltas),
    detail: classification.detail,
  }
}

/**
 * Semantic fact matching for the funnel, deliberately separate from scoring.
 * A proposal is a capture of a gold fact when the kind family agrees and the
 * evidence quote, visible needle, subject, or sufficiently shared statement
 * vocabulary identifies it.
 */
export function deltaMatchesFact(delta, fact) {
  if (delta === null || typeof delta !== 'object') return undefined
  if (typeof delta.kind !== 'string') return undefined
  const family = kind => {
    if (kind === 'constraint' || kind === 'objective' || kind === 'obligation') return 'normative'
    if (kind === 'finding' || kind === 'failure') return 'empirical'
    return kind
  }
  const familyMatch = delta.kind !== fact.kind
    && family(delta.kind) === family(fact.kind)
    && family(fact.kind) !== fact.kind
  if (delta.kind !== fact.kind && !familyMatch) return undefined
  const quotes = Array.isArray(delta.evidence)
    ? delta.evidence.map(entry => (entry !== null && typeof entry === 'object' ? entry.quote : undefined))
      .filter(quote => typeof quote === 'string')
    : []
  if (quotes.some(quote => quote.includes(fact.quote) || quote.includes(fact.visibleNeedle))) {
    return 'evidence-quote'
  }
  if (normalize(delta.statement).includes(normalize(fact.visibleNeedle))) return 'visible-needle'
  if (normalize(delta.subjectKey) === normalize(fact.subjectKey)) return 'subject-key'
  if (typeof delta.statement !== 'string') return undefined
  const left = tokens(delta.statement)
  const right = tokens(fact.statement)
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  if (shared >= 2 && (containment(delta.statement, fact.statement) >= 0.45
    || containment(fact.statement, delta.statement) >= 0.45)) {
    return 'statement'
  }
  return undefined
}
