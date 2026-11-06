/**
 * R37-C semantic funnel.
 *
 * R37-B named accepted-delta matching "commitRecall". That was wrong: an
 * accepted proposal can still be refused by the fold, committed without a
 * receipt, superseded, or omitted from the rendered checkpoint. This module
 * keeps the stages separate and returns `null` when the evidence needed for a
 * stage was not recorded. It never turns "not measured" into zero.
 *
 * The stages are:
 *
 *   rawMention       the fact appears in the writer's raw output
 *   proposed         a proposed delta matches the fact
 *   accepted         an accepted delta matches the fact
 *   committed        the matched accepted delta has an active anchor in a
 *                    journal state whose receipt is committed and whose packet
 *                    identity/ops digest checks out
 *   activeState      a current fact is committed and not superseded
 *   rendered         the checkpoint text lexically contains the fact
 *
 * `rendered` is lexical by construction. A checkpoint is prose, so this module
 * does not claim to prove semantic validity from it; `renderedSemantic` is
 * `null` with an explicit reason.
 *
 * @module eval/r37c/src/semantic-funnel
 */

import { deltaMatchesFact, normalize } from '../../r36/writer-protocol.mjs'

function scopeText(scope) {
  if (scope === undefined || scope === null) return ''
  return Object.keys(scope).sort().map(key => `${key}=${scope[key]}`).join('&')
}

export function stateKeyText(key) {
  if (key === undefined || key === null) return null
  return `${key.namespace}/${key.entity}/${key.property}`
}

export function lexicalMention(text, fact) {
  const haystack = normalize(text)
  if (haystack.length === 0) return false
  const needles = [fact.quote, fact.visibleNeedle, fact.statement]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(normalize)
  if (needles.some(needle => haystack.includes(needle))) return true
  const left = new Set(normalize(fact.visibleNeedle ?? fact.statement ?? '').split(' ').filter(Boolean))
  const right = new Set(haystack.split(' ').filter(Boolean))
  if (left.size === 0) return false
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / left.size >= 0.6
}

function matchingDelta(list, fact) {
  if (!Array.isArray(list)) return undefined
  for (const delta of list) {
    if (deltaMatchesFact(delta, fact) !== undefined) return delta
  }
  return undefined
}

function anchorForDelta(anchors, delta) {
  const key = stateKeyText(delta?.stateKey)
  if (key === null) return undefined
  return anchors.find(anchor => stateKeyText(anchor.stateKey) === key)
}

/**
 * Compute one fact's funnel state.
 *
 * @param {object} fact - frozen gold fact.
 * @param {object} input
 * @param {string|null} input.writerRaw - raw writer output, or null when absent.
 * @param {object[]|null} input.proposed - proposed deltas.
 * @param {object[]|null} input.accepted - accepted deltas.
 * @param {object[]|null} input.anchors - active anchors from a verified journal.
 * @param {boolean|null} input.commitProof - whether the journal proof checked out.
 * @param {string|null} input.checkpoint - rendered checkpoint text.
 * @param {string|null} input.unavailable - why the journal/anchors are absent.
 */
export function factFunnelStage(fact, input) {
  const proposed = matchingDelta(input.proposed, fact)
  const accepted = matchingDelta(input.accepted, fact)
  const anchor = accepted === undefined ? undefined : anchorForDelta(input.anchors ?? [], accepted)
  const anchorValueMatches = anchor !== undefined
    && typeof anchor.value === 'string'
    && normalize(anchor.value) === normalize(accepted.statement)
  const committed = input.commitProof === true
    && accepted !== undefined
    && anchor !== undefined
    && anchor.lifecycle === 'active'
    && anchorValueMatches
  const writerRaw = typeof input.writerRaw === 'string' ? input.writerRaw : null
  const checkpoint = typeof input.checkpoint === 'string' ? input.checkpoint : null
  return {
    factId: fact.factId,
    kind: fact.kind,
    current: fact.current === true,
    criticality: fact.criticality ?? null,
    rawMention: writerRaw === null ? null : lexicalMention(writerRaw, fact),
    proposed: input.proposed === null || input.proposed === undefined ? null : proposed !== undefined,
    accepted: input.accepted === null || input.accepted === undefined ? null : accepted !== undefined,
    committed: input.commitProof === null || input.commitProof === undefined ? null : committed,
    activeState: committed ? fact.current === true : (input.commitProof === null ? null : false),
    rendered: checkpoint === null ? null : lexicalMention(checkpoint, fact),
    renderedSemantic: null,
    renderedSemanticReason: 'checkpoint text is prose; semantic validity is not provable from it',
    acceptedDeltaId: accepted?.deltaId ?? null,
    committedAnchorId: committed ? anchor.id : null,
    committedAnchorValue: committed ? anchor.value : null,
    anchorPresentButNotCommitted: !committed && accepted !== undefined
      ? (anchor === undefined
        ? {
          anchorId: null,
          lifecycle: null,
          valueMatches: false,
          reason: input.commitProof === false ? 'no-active-anchor' : 'journal-proof-unavailable',
        }
        : {
          anchorId: anchor.id,
          lifecycle: anchor.lifecycle ?? null,
          valueMatches: anchorValueMatches,
          reason: input.commitProof !== true ? 'journal-proof-unavailable'
            : anchor.lifecycle !== 'active' ? 'anchor-not-active'
              : !anchorValueMatches ? 'anchor-value-differs' : 'unknown',
        })
      : null,
    unavailable: input.unavailable ?? null,
  }
}

function rate(part, total) {
  return total === 0 ? null : part / total
}

function countTrue(facts, key) {
  return facts.filter(fact => fact[key] === true).length
}

/**
 * Compute the funnel for one writer row.
 *
 * @param {object} caseData - frozen case with `gold`.
 * @param {object} input - see {@link factFunnelStage}.
 */
export function semanticFunnel(caseData, input) {
  const facts = caseData.gold.map(fact => factFunnelStage(fact, input))
  const denominator = facts.length
  const current = facts.filter(fact => fact.current)
  const accepted = input.accepted
  const proposed = input.proposed
  const applicable = Array.isArray(accepted) || Array.isArray(proposed) || typeof input.writerRaw === 'string'
  const committedAvailable = input.commitProof !== null && input.commitProof !== undefined
  const renderedAvailable = typeof input.checkpoint === 'string'
  return {
    applicable,
    denominator,
    facts,
    rawMention: input.writerRaw === null || input.writerRaw === undefined ? null : countTrue(facts, 'rawMention'),
    proposed: proposed === null || proposed === undefined ? null : countTrue(facts, 'proposed'),
    accepted: accepted === null || accepted === undefined ? null : countTrue(facts, 'accepted'),
    committed: committedAvailable ? countTrue(facts, 'committed') : null,
    activeState: committedAvailable ? current.filter(fact => fact.activeState === true).length : null,
    rendered: renderedAvailable ? countTrue(facts, 'rendered') : null,
    recall: {
      rawMention: input.writerRaw === null || input.writerRaw === undefined ? null : rate(countTrue(facts, 'rawMention'), denominator),
      proposed: proposed === null || proposed === undefined ? null : rate(countTrue(facts, 'proposed'), denominator),
      accepted: accepted === null || accepted === undefined ? null : rate(countTrue(facts, 'accepted'), denominator),
      committed: committedAvailable ? rate(countTrue(facts, 'committed'), denominator) : null,
      activeState: committedAvailable ? rate(current.filter(fact => fact.activeState === true).length, current.length) : null,
      rendered: renderedAvailable ? rate(countTrue(facts, 'rendered'), denominator) : null,
    },
    acceptedButNotCommitted: facts.filter(fact => fact.accepted === true && fact.committed === false),
    committedButNotRendered: facts.filter(fact => fact.committed === true && fact.rendered === false),
    lexicalVisibility: {
      rawMention: input.writerRaw === null || input.writerRaw === undefined ? null : countTrue(facts, 'rawMention'),
      rendered: renderedAvailable ? countTrue(facts, 'rendered') : null,
    },
    semanticValidity: {
      committed: committedAvailable ? countTrue(facts, 'committed') : null,
      rendered: null,
      renderedReason: 'not assessable from checkpoint prose',
    },
    commitProof: input.commitProof ?? null,
    unavailable: input.unavailable ?? null,
  }
}

/**
 * Aggregate per-row funnels without hiding missing stages.
 *
 * Each rate is the mean of row rates whose denominator was non-zero. A row
 * with no measurement contributes to `rows` but not to that rate's denominator.
 */
export function aggregateFunnels(rows) {
  const keys = ['rawMention', 'proposed', 'accepted', 'committed', 'activeState', 'rendered']
  const result = { rows: rows.length, byStage: {}, missing: {} }
  for (const key of keys) {
    const measured = rows.filter(row => row?.recall?.[key] !== null && row?.recall?.[key] !== undefined)
    result.byStage[key] = measured.length === 0
      ? null
      : measured.reduce((total, row) => total + row.recall[key], 0) / measured.length
    result.missing[key] = rows.length - measured.length
  }
  result.acceptedButNotCommitted = rows.flatMap(row => row.acceptedButNotCommitted ?? []).length
  result.committedButNotRendered = rows.flatMap(row => row.committedButNotRendered ?? []).length
  return result
}
