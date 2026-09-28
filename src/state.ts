/**
 * The deterministic current state: anchors, state keys, supersession, and
 * failure lifecycle. The reducer folds RAW SESSION EVENTS only — compaction
 * summaries are structurally invisible to it (D-006: state never derives
 * from narrative).
 *
 * Boundedness model: the state faces hold ONLY current entries. A superseded
 * head is replaced in place and its old anchor leaves every face it occupied;
 * `retiredCount` is the single counter for every anchor that left hot state
 * (by supersession, verification, or explicit retirement). History remains
 * recoverable from the session log and bundles, never from hot state.
 *
 * @module dsh-epistemic-fold/state
 */

import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { AuthorityDomain } from './authority.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** EF anchor operation: whole-value durable state change (log-only). */
    'ef/anchor': EfAnchorEventData
  }
}

/** The eight deterministic anchor kinds (plan §18). */
export type AnchorKind =
  | 'objective'
  | 'constraint'
  | 'decision'
  | 'value'
  | 'artifact'
  | 'evidence'
  | 'failure'
  | 'obligation'

/** A durable state coordinate: `namespace/entity/property` (plan §19). */
export interface StateKey {
  readonly namespace: string
  readonly entity: string
  readonly property: string
}

/** Canonical string form of a state key; the heads index is keyed by this. */
export function stateKeyText(key: StateKey): string {
  return `${key.namespace}/${key.entity}/${key.property}`
}

/** Provenance pointer to one committed session event. */
export interface EventRef {
  /** Same-session refs omit the id: the fold context implies it. */
  readonly sessionId?: SessionId
  readonly seq: SessionSeq
}

/** Lifecycle of a general anchor. */
export type AnchorLifecycle = 'active' | 'superseded' | 'retired'

/** Failure lifecycle (RFC §15): only VERIFIED failures leave hot state. */
export type FailureState = 'open' | 'investigating' | 'resolved' | 'verified'

/** One durable epistemic anchor with full provenance. */
export interface Anchor {
  readonly id: string
  readonly kind: AnchorKind
  readonly stateKey?: StateKey
  readonly value: unknown
  readonly authority: AuthorityDomain
  /** General lifecycle; failures additionally carry `failureState`. */
  readonly lifecycle: AnchorLifecycle
  /** Failure-specific lifecycle; present only for `failure` anchors. */
  readonly failureState?: FailureState
  /** Every anchor cites the raw events it came from (ProvenanceCoverage). */
  readonly sourceRefs: readonly EventRef[]
  /** Set when a newer anchor replaced this one at the same state key. */
  readonly supersededBy?: string
}

/** The bounded current state (RFC §13): heads only, no history lineage. */
export interface FoldCurrentState {
  readonly objective?: Anchor
  readonly constraints: Record<string, Anchor>
  readonly stateHeads: Record<string, Anchor>
  readonly openFailures: Record<string, Anchor>
  readonly openObligations: Record<string, Anchor>
  readonly decisions: Record<string, Anchor>
  readonly evidence: Record<string, Anchor>
  /** Every anchor that has left hot state (superseded, verified, retired). */
  readonly retiredCount: number
}

/** The empty state for a fresh (or restored) session fold. */
export function emptyCurrentState(): FoldCurrentState {
  return {
    constraints: {},
    stateHeads: {},
    openFailures: {},
    openObligations: {},
    decisions: {},
    evidence: {},
    retiredCount: 0,
  }
}

/** The EF anchor event: a whole-value durable anchor operation (log-only). */
export interface EfAnchorEventData {
  readonly op: 'declare' | 'transition' | 'retire'
  /** The complete post-op anchor (whole-value rule) for declare. */
  readonly anchor?: Anchor
  /** Transition target: failure lifecycle or retirement. */
  readonly anchorId?: string
  readonly failureState?: FailureState
  /** Evidence backing a transition; validated against authority rules. */
  readonly evidenceRefs?: readonly EventRef[]
}

/**
 * Anchor kind → the face record it occupies. `value` and `artifact` anchors
 * live only in `stateHeads`.
 */
const ANCHOR_FACE: Partial<Record<AnchorKind, 'constraints' | 'openFailures' | 'openObligations' | 'decisions' | 'evidence'>> = {
  constraint: 'constraints',
  failure: 'openFailures',
  obligation: 'openObligations',
  decision: 'decisions',
  evidence: 'evidence',
}

type AnchorFace = 'constraints' | 'openFailures' | 'openObligations' | 'decisions' | 'evidence'

const ALL_FACES: readonly AnchorFace[] = ['constraints', 'openFailures', 'openObligations', 'decisions', 'evidence']

/** Insert one anchor into its face; returns the state unchanged if faceless. */
function putFace(state: FoldCurrentState, anchor: Anchor): FoldCurrentState {
  const face = ANCHOR_FACE[anchor.kind]
  if (face === undefined) return state
  return { ...state, [face]: { ...state[face], [anchor.id]: anchor } }
}

/** Remove one anchor by id from its kind's face; also drops its head. */
function removeFace(state: FoldCurrentState, anchor: Anchor): FoldCurrentState {
  let next = state
  const face = ANCHOR_FACE[anchor.kind]
  if (face !== undefined && state[face][anchor.id] !== undefined) {
    const { [anchor.id]: _removed, ...rest } = state[face]
    void _removed
    next = { ...next, [face]: rest }
  }
  if (anchor.stateKey !== undefined) {
    const key = stateKeyText(anchor.stateKey)
    if (next.stateHeads[key]?.id === anchor.id) {
      const { [key]: _head, ...heads } = next.stateHeads
      void _head
      next = { ...next, stateHeads: heads }
    }
  }
  return next
}

/** How the reducer files one anchor into the bounded state faces. */
function indexAnchor(state: FoldCurrentState, anchor: Anchor): FoldCurrentState {
  if (anchor.kind === 'objective') {
    return { ...state, objective: anchor }
  }
  let next = state
  if (anchor.stateKey !== undefined) {
    next = { ...next, stateHeads: { ...next.stateHeads, [stateKeyText(anchor.stateKey)]: anchor } }
  }
  return putFace(next, anchor)
}

/**
 * The deterministic state reducer. Every recognized operation arrives as a
 * committed `ef/anchor` event; `tool/result` failures auto-declare OPEN
 * failure anchors; `compaction/summary` events are structurally IGNORED so
 * narrative can never mutate state (S02, D-006).
 */
export function reduceEvent(state: FoldCurrentState, event: { type: string; seq: number; data: unknown }): FoldCurrentState {
  if (event.type === 'compaction/summary') {
    return state
  }
  if (event.type === 'ef/anchor') {
    return applyAnchorOp(state, event.data as EfAnchorEventData)
  }
  if (event.type === 'tool/result') {
    return applyToolResult(state, event)
  }
  return state
}

function applyAnchorOp(state: FoldCurrentState, data: EfAnchorEventData): FoldCurrentState {
  if (data.op === 'declare' && data.anchor !== undefined) {
    const anchor = data.anchor
    if (anchor.lifecycle !== 'active') return state
    if (anchor.stateKey === undefined) {
      return indexAnchor(state, anchor)
    }
    const key = stateKeyText(anchor.stateKey)
    const previous = state.stateHeads[key]
    // The new head replaces the old in place; the old anchor leaves hot
    // state entirely (faces included) — history stays in the session log.
    const replaced = previous !== undefined && previous.id !== anchor.id
    let next = indexAnchor(state, anchor)
    if (replaced) {
      next = removeFace(next, previous)
      next = { ...next, retiredCount: next.retiredCount + 1 }
    }
    return next
  }
  if (data.op === 'transition' && data.anchorId !== undefined && data.failureState !== undefined) {
    return transitionFailure(state, data.anchorId, data.failureState, data.evidenceRefs)
  }
  if (data.op === 'retire' && data.anchorId !== undefined) {
    return retireAnchor(state, data.anchorId)
  }
  return state
}

/** Auto-declare an OPEN failure from a failed tool result (empirical). */
function applyToolResult(state: FoldCurrentState, event: { seq: number; data: unknown }): FoldCurrentState {
  const data = event.data as { message?: { role?: string; isError?: boolean; toolCallId?: string } }
  const message = data.message
  if (message?.role !== 'tool' || message.isError !== true || message.toolCallId === undefined) {
    return state
  }
  const callId = message.toolCallId
  const anchor: Anchor = {
    id: `failure:${callId}`,
    kind: 'failure',
    stateKey: { namespace: 'failure', entity: 'tool', property: callId },
    value: { callId },
    authority: 'empirical',
    lifecycle: 'active',
    failureState: 'open',
    sourceRefs: [{ seq: event.seq as SessionSeq }],
  }
  return indexAnchor(state, anchor)
}

/** Advance one failure's lifecycle. VERIFIED without cited evidence is a no-op. */
function transitionFailure(
  state: FoldCurrentState,
  anchorId: string,
  failureState: FailureState,
  evidenceRefs?: readonly EventRef[],
): FoldCurrentState {
  const head = state.openFailures[anchorId]
  if (head === undefined) return state
  // Only VERIFIED failures leave hot state; the verified anchor itself stays
  // recoverable from the session log and bundles, not from hot state.
  if (failureState === 'verified') {
    // Fail closed: verification without evidence refs is refused outright.
    if (evidenceRefs === undefined || evidenceRefs.length === 0) return state
    return { ...removeFace(state, head), retiredCount: state.retiredCount + 1 }
  }
  const advanced: Anchor = { ...head, failureState }
  return { ...state, openFailures: { ...state.openFailures, [anchorId]: advanced } }
}

/** Retire one anchor by id (verified failures, revoked constraints). */
function retireAnchor(state: FoldCurrentState, anchorId: string): FoldCurrentState {
  let next = state
  let removed = 0
  // The objective is a single slot, not a face.
  if (next.objective?.id === anchorId) {
    const { objective: _dropped, ...rest } = next
    void _dropped
    next = rest
    removed += 1
  }
  for (const face of ALL_FACES) {
    const anchor = next[face][anchorId]
    if (anchor !== undefined) {
      // removeFace clears both the face entry and the matching head, so the
      // same anchor can never be counted twice.
      next = removeFace(next, anchor)
      removed += 1
    }
  }
  for (const head of Object.values(next.stateHeads)) {
    if (head.id === anchorId) {
      next = removeFace(next, head)
      removed += 1
      break
    }
  }
  return removed === 0 ? state : { ...next, retiredCount: next.retiredCount + removed }
}

/**
 * Authority Loss Rate (test spec §2.1): the fraction of expected active
 * authoritative anchors missing from the current state. M3a gate: 0.
 */
export function authorityLossRate(expectedIds: readonly string[], state: FoldCurrentState): number {
  if (expectedIds.length === 0) return 0
  const activeIds = new Set<string>()
  if (state.objective !== undefined) activeIds.add(state.objective.id)
  for (const anchor of Object.values(state.stateHeads)) {
    if (anchor.lifecycle === 'active') activeIds.add(anchor.id)
  }
  for (const face of [state.constraints, state.openFailures, state.openObligations, state.decisions]) {
    for (const anchor of Object.values(face)) {
      if (anchor.lifecycle === 'active') activeIds.add(anchor.id)
    }
  }
  let missing = 0
  for (const id of expectedIds) {
    if (!activeIds.has(id)) missing += 1
  }
  return missing / expectedIds.length
}

/**
 * State Staleness Rate (test spec §2.2): the fraction of displayed current
 * values that are actually superseded. Heads hold exactly one anchor per key
 * and replaced heads leave hot state immediately, so the gate is SSR=0 by
 * construction.
 */
export function stateStalenessRate(state: FoldCurrentState): number {
  const heads = Object.values(state.stateHeads)
  if (heads.length === 0) return 0
  const stale = heads.filter(anchor => anchor.lifecycle !== 'active').length
  return stale / heads.length
}
