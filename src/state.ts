/**
 * The deterministic current state: anchors, state keys, supersession, and
 * failure lifecycle. The reducer folds RAW SESSION EVENTS only — compaction
 * summaries are structurally invisible to it (D-006: state never derives
 * from narrative).
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
  /** Small telemetry: how many anchors were retired in total. */
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

/** How the reducer files one anchor into the bounded state faces. */
function indexAnchor(state: FoldCurrentState, anchor: Anchor): FoldCurrentState {
  if (anchor.kind === 'objective') {
    return { ...state, objective: anchor }
  }
  let next = state
  if (anchor.stateKey !== undefined) {
    next = { ...next, stateHeads: { ...next.stateHeads, [stateKeyText(anchor.stateKey)]: anchor } }
  }
  switch (anchor.kind) {
    case 'constraint':
      return { ...next, constraints: { ...next.constraints, [anchor.id]: anchor } }
    case 'failure':
      if (anchor.failureState === 'verified' || anchor.lifecycle === 'retired') {
        const { [anchor.id]: _removed, ...rest } = next.openFailures
        void _removed
        return { ...next, openFailures: rest }
      }
      return { ...next, openFailures: { ...next.openFailures, [anchor.id]: anchor } }
    case 'obligation':
      return { ...next, openObligations: { ...next.openObligations, [anchor.id]: anchor } }
    case 'decision':
      return { ...next, decisions: { ...next.decisions, [anchor.id]: anchor } }
    case 'evidence':
      return { ...next, evidence: { ...next.evidence, [anchor.id]: anchor } }
    default:
      return next
  }
}

/** Supersede: the old head at the same key keeps history, loses currency. */
function supersedeHead(state: FoldCurrentState, incoming: Anchor): FoldCurrentState {
  if (incoming.stateKey === undefined) return state
  const key = stateKeyText(incoming.stateKey)
  const previous = state.stateHeads[key]
  let next = state
  if (previous !== undefined && previous.id !== incoming.id) {
    const superseded: Anchor = {
      ...previous,
      lifecycle: 'superseded',
      supersededBy: incoming.id,
    }
    next = {
      ...next,
      stateHeads: { ...next.stateHeads, [key]: superseded },
    }
  }
  return next
}

/** Drop superseded heads whose replacement has landed (boundedness). */
function dropSuperseded(state: FoldCurrentState, key: string): FoldCurrentState {
  const head = state.stateHeads[key]
  if (head === undefined) return state
  if (head.lifecycle !== 'active') {
    const { [key]: _removed, ...rest } = state.stateHeads
    void _removed
    return { ...state, stateHeads: rest, retiredCount: state.retiredCount + 1 }
  }
  return state
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
    const previous = anchor.stateKey === undefined
      ? undefined
      : state.stateHeads[stateKeyText(anchor.stateKey)]
    let next = supersedeHead(state, anchor)
    next = indexAnchor(next, anchor)
    if (anchor.stateKey !== undefined) next = dropSuperseded(next, stateKeyText(anchor.stateKey))
    // Replacing a head removes lineage from hot state; count it.
    if (previous !== undefined && previous.id !== anchor.id) {
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
    const { [anchorId]: _removed, ...rest } = state.openFailures
    void _removed
    return { ...state, openFailures: rest, retiredCount: state.retiredCount + 1, stateHeads: removeHead(state.stateHeads, head) }
  }
  const advanced: Anchor = { ...head, failureState }
  return { ...state, openFailures: { ...state.openFailures, [anchorId]: advanced } }
}

function removeHead(heads: Record<string, Anchor>, anchor: Anchor): Record<string, Anchor> {
  if (anchor.stateKey === undefined) return heads
  const key = stateKeyText(anchor.stateKey)
  if (heads[key]?.id !== anchor.id) return heads
  const { [key]: _removed, ...rest } = heads
  void _removed
  return rest
}

/** Retire one anchor by id (verified failures, revoked constraints). */
function retireAnchor(state: FoldCurrentState, anchorId: string): FoldCurrentState {
  let next = state
  for (const [key, anchor] of Object.entries(state.stateHeads)) {
    if (anchor.id === anchorId) {
      const { [key]: _removed, ...rest } = next.stateHeads
      void _removed
      next = { ...next, stateHeads: rest, retiredCount: next.retiredCount + 1 }
    }
  }
  for (const face of ['openFailures', 'openObligations', 'decisions', 'evidence', 'constraints'] as const) {
    const faceState = next[face] as Record<string, Anchor>
    if (faceState[anchorId] !== undefined) {
      const { [anchorId]: _removed, ...rest } = faceState
      void _removed
      next = { ...next, [face]: rest, retiredCount: next.retiredCount + 1 }
    }
  }
  if (next.objective?.id === anchorId) {
    next = { ...next, retiredCount: next.retiredCount + 1 }
  }
  return next
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
 * values that are actually superseded. Heads only ever hold one anchor per
 * key and superseded heads are dropped, so the gate is SSR=0 by construction.
 */
export function stateStalenessRate(state: FoldCurrentState): number {
  const heads = Object.values(state.stateHeads)
  if (heads.length === 0) return 0
  const stale = heads.filter(anchor => anchor.lifecycle !== 'active').length
  return stale / heads.length
}
