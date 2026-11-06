/**
 * R38-M0 WP3: a task-aware working-set selector, run as a SHADOW adapter.
 *
 * ## What it changes
 *
 * The production selector answers "what is still effective?" and then fills the
 * remaining budget newest-first. It does not know what the agent is doing, so a
 * recent unrelated finding outranks an older decision that the current task
 * directly depends on.
 *
 * This selector answers "what does THIS task need?", using only deterministic
 * features:
 *
 *   scope applicability      workspace / branch / file / symbol
 *   file and symbol overlap  frame files and symbols against anchor text
 *   subject-key overlap      request tokens against the anchor's coordinate
 *   task dependency          obligations and open failures
 *   authority relevance      normative, decision
 *   negative knowledge       rejected approaches and their rulesOut phrases
 *   recency                  tie-breaker only
 *
 * ## Invariants
 *
 *  - Pinned state is never dropped. If it alone exceeds the budget, it is
 *    rendered and `pinnedOverflow` is reported.
 *  - `selected ∩ omitted = ∅` and `selected ∪ omitted = all eligible working
 *    candidates`. The sets are maintained directly, never inferred from a
 *    prefix of the sorted array.
 *  - A candidate that does not fit is SKIPPED, not treated as a stop signal, so
 *    a later smaller relevant item can still be selected.
 *  - Residency never changes lifecycle. Nothing here retires anything.
 *
 * ## Shadow only
 *
 * Nothing in `src/` imports this module. The ablation compares it with the
 * production `compileWorkingSet` on identical state and budget.
 *
 * @module eval/r38/src/task-aware-selector
 */

import type { Anchor, AnchorScope, FoldCurrentState } from '../../../src/state/state.ts'
import { stateKeyText } from '../../../src/state/state.ts'
import { renderAnchorLine, renderFailureLine } from '../../../src/checkpoint/renderer.ts'
import { residencyOf } from '../../../src/semantic/working-set-compiler.ts'
import { canonicalHash } from '../../../src/checkpoint/hash.ts'

/** The task the agent is doing, as far as deterministic state can describe it. */
export interface TaskFrame {
  readonly sessionId: string
  readonly taskId?: string
  readonly phase?: 'planning' | 'editing' | 'verifying' | 'handoff'
  readonly workspace?: string
  readonly branch?: string
  readonly files: readonly string[]
  readonly symbols: readonly string[]
  readonly operation?: string
  readonly currentRequest: string
  readonly semanticStateRevision: string
  readonly sessionEventWatermark: number
}

/** The selector's complete output. */
export interface ContextSelection {
  readonly renderedText: string
  readonly selectedAnchorIds: readonly string[]
  readonly omittedAnchorIds: readonly string[]
  readonly retrievalCandidates: readonly string[]
  readonly unresolvedCoverage: readonly string[]
  readonly integrityWarnings: readonly string[]
  readonly sourceRefs: readonly number[]
  readonly tokenEstimate: number
  /** Pinned + working sections only; excludes the omission/overflow notice. */
  readonly contentTokens: number
  /** The complete body (including the notice) exceeds the budget. */
  readonly bodyOverBudget: boolean
  readonly selectionDigest: string
  /** Diagnostics: the pinned set and each working anchor's score. */
  readonly pinnedAnchorIds: readonly string[]
  readonly scores: Readonly<Record<string, number>>
  readonly reasons: Readonly<Record<string, readonly string[]>>
  readonly pinnedOverflow: boolean
  readonly budgetTokens: number
  readonly estimateBasis: 'chars-per-4'
}

/** Options for {@link selectTaskAwareContext}. */
export interface SelectOptions {
  readonly state: FoldCurrentState
  readonly frame: TaskFrame
  readonly budgetTokens: number
  /** Ids already shown in the fold's changed section; excluded here. */
  readonly exclude?: ReadonlySet<string>
  /** Auditor findings to carry as warnings; the selector does not compute them. */
  readonly integrityWarnings?: readonly string[]
  /** Pricer override; defaults to the same chars-per-4 fallback as production. */
  readonly estimate?: (text: string) => number
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'not', 'are', 'was', 'were',
  'use', 'using', 'should', 'must', 'will', 'can', 'may', 'have', 'has', 'had', 'but', 'its',
  'our', 'their', 'than', 'then', 'when', 'where', 'which', 'while', 'about', 'after', 'before',
  'now', 'only', 'also', 'still', 'just', 'any', 'all', 'one', 'two', 'per', 'via', 'modify',
])

const PINNED_ORDER: Readonly<Record<string, number>> = {
  objective: 0,
  constraint: 1,
  obligation: 2,
  failure: 3,
}

function charsPerFour(text: string): number {
  return Math.ceil(text.length / 4)
}

function words(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9_./-]{1,}/gu) ?? []
  return new Set(matches.filter(word => !STOPWORDS.has(word)))
}

function recency(anchor: Anchor): number {
  let latest = -1
  for (const ref of anchor.sourceRefs) {
    const seq = Number(ref.seq)
    if (seq > latest) latest = seq
  }
  return latest
}

function textOf(anchor: Anchor): string {
  const value = typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value)
  return `${anchor.stateKey === undefined ? '' : stateKeyText(anchor.stateKey)} ${value}`
}

/** Every active anchor, once. */
function activeAnchors(state: FoldCurrentState): readonly Anchor[] {
  const byId = new Map<string, Anchor>()
  const push = (anchor: Anchor | undefined): void => {
    if (anchor === undefined || anchor.lifecycle !== 'active') return
    if (!byId.has(anchor.id)) byId.set(anchor.id, anchor)
  }
  push(state.objective)
  for (const face of [state.constraints, state.openObligations, state.openFailures, state.decisions, state.evidence, state.stateHeads]) {
    for (const anchor of Object.values(face)) push(anchor)
  }
  return [...byId.values()]
}

/** Whether a scope names the frame's workspace/branch/file/symbol. */
function scopeFit(anchor: AnchorScope | undefined, frame: TaskFrame): {
  readonly verdict: 'match' | 'unknown' | 'mismatch'
  readonly score: number
  readonly reason: string
} {
  if (anchor === undefined) {
    const framed = frame.workspace !== undefined || frame.branch !== undefined
      || frame.files.length > 0 || frame.symbols.length > 0
    return framed
      ? { verdict: 'unknown', score: 0.2, reason: 'scope-unknown' }
      : { verdict: 'match', score: 0, reason: 'scope-global' }
  }
  let score = 0
  let matched = false
  if (anchor.workspace !== undefined) {
    if (frame.workspace !== anchor.workspace) return { verdict: 'mismatch', score: 0, reason: 'workspace-mismatch' }
    score += 1
    matched = true
  }
  if (anchor.branch !== undefined) {
    if (frame.branch !== undefined && frame.branch !== anchor.branch) {
      return { verdict: 'mismatch', score: 0, reason: 'branch-mismatch' }
    }
    if (frame.branch === anchor.branch) {
      score += 0.8
      matched = true
    }
  }
  if (anchor.file !== undefined) {
    if (!frame.files.includes(anchor.file)) return { verdict: 'mismatch', score: 0, reason: 'file-mismatch' }
    score += 1.5
    matched = true
  }
  if (anchor.symbol !== undefined) {
    if (!frame.symbols.includes(anchor.symbol)) return { verdict: 'mismatch', score: 0, reason: 'symbol-mismatch' }
    score += 1.5
    matched = true
  }
  return matched
    ? { verdict: 'match', score, reason: 'scope-match' }
    : { verdict: 'unknown', score: 0.1, reason: 'scope-unbounded' }
}

/**
 * The SEMANTIC kind, which is not always the anchor kind.
 *
 * A `rejected-approach` becomes a `decision` anchor; the semantic kind lives in
 * the state key's entity (`rejected-approach#<scope>`), and using the anchor
 * kind here silently disabled the negative-knowledge rule.
 */
function semanticKindOf(anchor: Anchor): string {
  const entity = anchor.stateKey?.entity
  if (entity === undefined) return anchor.kind
  return entity.includes('#') ? entity.slice(0, entity.indexOf('#')) : entity
}

/** Score one working anchor against the frame. */
function scoreAnchor(anchor: Anchor, frame: TaskFrame): { score: number; reasons: string[] } {
  const reasons: string[] = []
  const kind = semanticKindOf(anchor)
  const scope = scopeFit(anchor.scope, frame)
  if (scope.verdict === 'mismatch') return { score: Number.NEGATIVE_INFINITY, reasons: [scope.reason] }
  let score = scope.score
  reasons.push(scope.reason)

  const anchorWords = words(textOf(anchor))
  const requestWords = words(frame.currentRequest)
  let shared = 0
  for (const word of requestWords) {
    if (!anchorWords.has(word)) continue
    shared += 1
    if (shared <= 5) score += 0.3
  }
  if (shared > 0) reasons.push(`subject-overlap:${shared}`)

  for (const file of frame.files) {
    const base = file.split('/').pop() ?? file
    if (anchorWords.has(file.toLowerCase()) || anchorWords.has(base.toLowerCase())) {
      score += 1.2
      reasons.push(`file:${file}`)
    }
  }
  for (const symbol of frame.symbols) {
    if (anchorWords.has(symbol.toLowerCase())) {
      score += 1.2
      reasons.push(`symbol:${symbol}`)
    }
  }

  if (kind === 'obligation') {
    score += 1
    reasons.push('obligation')
  }
  if (kind === 'failure' && (anchor.failureState === 'open' || anchor.failureState === 'investigating')) {
    score += 1.2
    reasons.push('open-failure')
  }
  if (anchor.authority === 'normative') {
    score += 0.6
    reasons.push('normative')
  } else if (anchor.authority === 'decision') {
    score += 0.2
    reasons.push('decision')
  }
  if (kind === 'rejected-approach') {
    score += 0.8
    reasons.push('negative-knowledge')
    // The rendered value carries `rules out: …`; a phrase the request also
    // names is a strong retrieval cue.
    const value = typeof anchor.value === 'string' ? anchor.value : ''
    const ruledOut = value.includes('rules out:') ? value.slice(value.indexOf('rules out:') + 10) : ''
    for (const word of words(ruledOut)) {
      if (requestWords.has(word)) {
        score += 0.5
        reasons.push(`rules-out-overlap:${word}`)
      }
    }
  }
  if (frame.phase === 'verifying' && (kind === 'failure' || kind === 'obligation')) {
    score += 0.5
    reasons.push('phase-verifying')
  }
  if (frame.phase === 'editing' && (kind === 'decision' || kind === 'constraint' || kind === 'rejected-approach')) {
    score += 0.2
    reasons.push('phase-editing')
  }
  // Recency is a tie-breaker, never a primary signal.
  score += recency(anchor) / 1e6
  return { score, reasons }
}

function section(title: string, lines: readonly string[]): string {
  return lines.length === 0 ? '' : [title, ...lines].join('\n')
}

/**
 * Select the context for one task.
 *
 * @param options - the state, the task frame, the budget and optional warnings.
 * @returns the rendered selection plus the exact selected/omitted sets.
 */
export function selectTaskAwareContext(options: SelectOptions): ContextSelection {
  const estimate = options.estimate ?? charsPerFour
  const exclude = options.exclude ?? new Set<string>()
  const anchors = activeAnchors(options.state).filter(anchor => !exclude.has(anchor.id))
  const pinned = anchors
    .filter(anchor => residencyOf(anchor) === 'pinned')
    .sort((left, right) =>
      (PINNED_ORDER[left.kind] ?? 9) - (PINNED_ORDER[right.kind] ?? 9)
      || left.id.localeCompare(right.id))
  const working = anchors.filter(anchor => residencyOf(anchor) === 'working')

  const scored = working.map(anchor => ({ anchor, ...scoreAnchor(anchor, options.frame) }))
  const eligible = scored.filter(entry => Number.isFinite(entry.score))
  const disqualified = scored.filter(entry => !Number.isFinite(entry.score))
  eligible.sort((left, right) =>
    right.score - left.score
    || recency(right.anchor) - recency(left.anchor)
    || left.anchor.id.localeCompare(right.anchor.id))

  const lineOf = (anchor: Anchor): string =>
    anchor.kind === 'failure' ? renderFailureLine(anchor) : renderAnchorLine(anchor)

  // Pinned is never budgeted. It is the correctness invariant.
  const pinnedLines = pinned.map(lineOf)
  const pinnedText = section('Pinned (still in force)', pinnedLines)
  const pinnedTokens = pinnedText.length === 0 ? 0 : estimate(pinnedText)
  const pinnedOverflow = pinnedLines.length > 0 && pinnedTokens > options.budgetTokens

  const selectedWorking: Anchor[] = []
  const workingLines: string[] = []
  const separator = estimate('\n\n')
  if (!pinnedOverflow) {
    for (const entry of eligible) {
      const line = lineOf(entry.anchor)
      const candidate = section('Working', [...workingLines, line])
      if (pinnedTokens + separator + estimate(candidate) > options.budgetTokens) {
        // SKIP, do not break: a later, smaller relevant item may still fit.
        continue
      }
      selectedWorking.push(entry.anchor)
      workingLines.push(line)
    }
  }

  const selectedIds = new Set([...pinned.map(anchor => anchor.id), ...selectedWorking.map(anchor => anchor.id)])
  // The omitted set is computed from the eligible set, never from an array
  // suffix: selected ∩ omitted = ∅ and selected ∪ omitted = eligible.
  const omitted = eligible.filter(entry => !selectedIds.has(entry.anchor.id)).map(entry => entry.anchor)
  const omittedIds = omitted.map(anchor => anchor.id)

  const retrievalCandidates = eligible
    .filter(entry => !selectedIds.has(entry.anchor.id) && entry.score > 0)
    .map(entry => entry.anchor.id)

  const unresolvedCoverage = [
    ...disqualified.map(entry => `scope-mismatch:${entry.anchor.id}`),
    ...scored.filter(entry => entry.reasons.includes('scope-unknown')).map(entry => `scope-unknown:${entry.anchor.id}`),
  ]

  const parts: string[] = []
  if (pinnedText.length > 0) parts.push(pinnedText)
  if (workingLines.length > 0) parts.push(section('Working', workingLines))
  if (omitted.length > 0) {
    parts.push([
      'Not shown',
      `- ${omitted.length} more effective item(s) did not fit this checkpoint's budget; `
      + 'use context_search with a keyword to retrieve them',
    ].join('\n'))
  }
  if (pinnedOverflow) {
    parts.push(
      `- working-set-overflow: pinned state is ${pinnedTokens} tokens against a ${options.budgetTokens}-token budget; `
      + 'it is shown in full because it is still in force',
    )
  }
  const renderedText = parts.join('\n\n')
  const contentText = [pinnedText, section('Working', workingLines)].filter(part => part.length > 0).join('\n\n')
  const contentTokens = contentText.length === 0 ? 0 : estimate(contentText)
  const tokenEstimate = renderedText.length === 0 ? 0 : estimate(renderedText)

  const scores: Record<string, number> = {}
  const reasons: Record<string, readonly string[]> = {}
  for (const entry of scored) {
    scores[entry.anchor.id] = Number.isFinite(entry.score) ? entry.score : -1
    reasons[entry.anchor.id] = entry.reasons
  }

  const sourceRefs = [...new Set([...pinned, ...selectedWorking]
    .flatMap(anchor => anchor.sourceRefs.map(ref => Number(ref.seq))))].sort((left, right) => left - right)

  const selectionDigest = canonicalHash({
    frame: {
      taskId: options.frame.taskId ?? null,
      phase: options.frame.phase ?? null,
      workspace: options.frame.workspace ?? null,
      files: [...options.frame.files],
      symbols: [...options.frame.symbols],
      request: options.frame.currentRequest,
      revision: options.frame.semanticStateRevision,
      watermark: options.frame.sessionEventWatermark,
    },
    budget: options.budgetTokens,
    selected: [...selectedIds].sort((left, right) => left.localeCompare(right)),
    scores,
  })

  return {
    renderedText,
    selectedAnchorIds: [...selectedIds].sort((left, right) => left.localeCompare(right)),
    omittedAnchorIds: omittedIds,
    retrievalCandidates,
    unresolvedCoverage,
    integrityWarnings: options.integrityWarnings ?? [],
    sourceRefs,
    tokenEstimate,
    contentTokens,
    bodyOverBudget: tokenEstimate > options.budgetTokens,
    selectionDigest,
    pinnedAnchorIds: pinned.map(anchor => anchor.id),
    scores,
    reasons,
    pinnedOverflow,
    budgetTokens: options.budgetTokens,
    estimateBasis: 'chars-per-4',
  }
}
