/**
 * The runtime schema for a semantic packet's RESOLVED operations, plus the two
 * identity functions that bind a packet to its body and its operations.
 *
 * ## Why this is a runtime validator, not a type assertion
 *
 * A journal file is JSON an earlier process wrote. TypeScript checked the
 * WRITER, not the bytes on disk: a torn/corrupt/edited file can carry
 * `ops: [null]`, an anchor without a state key, an unknown lifecycle, or a
 * transition with no target. Passing that into the reducer does not throw — the
 * reducer simply ignores what it cannot interpret — so a malformed packet would
 * look like "a commit that happened to change nothing". That is worse than a
 * loud failure: it is a silent gap in the authoritative state.
 *
 * The validator here is the single definition every state-application path
 * uses. `journal.list`, the journal writer, the unified integrity check, and
 * the legacy-record reader all call it, so "the packet parsed" and "the ops are
 * applicable" can never drift apart.
 *
 * @module dsh-epistemic-fold/semantic/ops
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalHash } from '../checkpoint/hash.ts'
import type {
  Anchor,
  AnchorKind,
  AnchorLifecycle,
  AnchorScope,
  EfAnchorEventData,
  EventRef,
  FailureState,
  StateKey,
} from '../state/state.ts'
import type { AuthorityDomain } from '../state/authority.ts'
import { SEMANTIC_SCHEMA_VERSION } from './types.ts'

/** The anchor kinds the reducer understands. */
export const ANCHOR_KINDS: readonly AnchorKind[] = [
  'objective',
  'constraint',
  'decision',
  'value',
  'artifact',
  'evidence',
  'failure',
  'obligation',
]

/** The authority domains the state model admits. */
export const AUTHORITY_DOMAINS: readonly AuthorityDomain[] = [
  'normative',
  'empirical',
  'procedural',
  'decision',
  'narrative',
  'hypothesis',
]

/** The general anchor lifecycle. */
export const ANCHOR_LIFECYCLES: readonly AnchorLifecycle[] = ['active', 'superseded', 'retired']

/** The failure-specific lifecycle. */
export const FAILURE_STATES: readonly FailureState[] = ['open', 'investigating', 'resolved', 'verified']

const ANCHOR_KIND_SET = new Set<string>(ANCHOR_KINDS)
const AUTHORITY_SET = new Set<string>(AUTHORITY_DOMAINS)
const LIFECYCLE_SET = new Set<string>(ANCHOR_LIFECYCLES)
const FAILURE_STATE_SET = new Set<string>(FAILURE_STATES)

/** One validation failure, with the operation index that caused it. */
export interface OpsValidationFailure {
  readonly index: number
  readonly detail: string
}

/** The result of {@link validateOps}. */
export type OpsValidation =
  | { readonly ok: true; readonly ops: readonly EfAnchorEventData[] }
  | { readonly ok: false; readonly failure: OpsValidationFailure }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** One provenance pointer: a non-negative seq and, optionally, a session id. */
export function isEventRef(value: unknown): value is EventRef {
  if (!isRecord(value)) return false
  if (!validSeq(value['seq'])) return false
  const sessionId = value['sessionId']
  return sessionId === undefined || nonEmptyString(sessionId)
}

/** Scope fields are optional strings; an unknown key is not admitted. */
function isScope(value: unknown): value is AnchorScope {
  if (!isRecord(value)) return false
  const allowed = new Set(['workspace', 'branch', 'file', 'symbol', 'revision'])
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key)) return false
    if (entry !== undefined && !nonEmptyString(entry)) return false
  }
  return true
}

/** A coordinate is three non-empty strings; an empty segment is not a key. */
function isStateKey(value: unknown): value is StateKey {
  if (!isRecord(value)) return false
  return nonEmptyString(value['namespace'])
    && nonEmptyString(value['entity'])
    && nonEmptyString(value['property'])
}

/**
 * One anchor's complete durable shape.
 *
 * `value` is intentionally unconstrained JSON (the state model stores unknown
 * values), but its PRESENCE is required: a declare without a value would put an
 * `undefined` into the state and render as `{}`.
 */
function isAnchor(value: unknown): value is Anchor {
  if (!isRecord(value)) return false
  if (!nonEmptyString(value['id']) || value['id'].length > 512) return false
  if (typeof value['kind'] !== 'string' || !ANCHOR_KIND_SET.has(value['kind'])) return false
  if (!isStateKey(value['stateKey'])) return false
  if (!Object.prototype.hasOwnProperty.call(value, 'value')) return false
  if (typeof value['authority'] !== 'string' || !AUTHORITY_SET.has(value['authority'])) return false
  if (typeof value['lifecycle'] !== 'string' || !LIFECYCLE_SET.has(value['lifecycle'])) return false
  const failureState = value['failureState']
  if (failureState !== undefined
    && (typeof failureState !== 'string' || !FAILURE_STATE_SET.has(failureState))) return false
  const supersededBy = value['supersededBy']
  if (supersededBy !== undefined && !nonEmptyString(supersededBy)) return false
  const scope = value['scope']
  if (scope !== undefined && !isScope(scope)) return false
  const refs = value['sourceRefs']
  if (!Array.isArray(refs) || !refs.every(isEventRef)) return false
  return true
}

/**
 * One resolved operation.
 *
 * A `transition` to `verified` without evidence refs is refused here even
 * though the reducer already treats it as a no-op: a stored operation that is
 * guaranteed to do nothing is a malformed decision, not a harmless one.
 */
export function isAnchorOp(value: unknown): value is EfAnchorEventData {
  if (!isRecord(value)) return false
  if (value['op'] === 'declare') return isAnchor(value['anchor'])
  if (value['op'] === 'retire') return nonEmptyString(value['anchorId'])
  if (value['op'] !== 'transition') return false
  if (!nonEmptyString(value['anchorId'])) return false
  const failureState = value['failureState']
  if (typeof failureState !== 'string' || !FAILURE_STATE_SET.has(failureState)) return false
  const refs = value['evidenceRefs']
  if (refs !== undefined && (!Array.isArray(refs) || !refs.every(isEventRef))) return false
  if (failureState === 'verified' && (refs === undefined || refs.length === 0)) return false
  return true
}

/**
 * Validate every operation in a packet.
 *
 * @param value - the `ops` array read from a file.
 * @returns the validated operations or the first failure.
 */
export function validateOps(value: unknown): OpsValidation {
  if (!Array.isArray(value)) {
    return { ok: false, failure: { index: -1, detail: 'ops is not an array' } }
  }
  const ops: EfAnchorEventData[] = []
  for (const [index, op] of value.entries()) {
    if (!isAnchorOp(op)) return { ok: false, failure: { index, detail: describeOp(op) } }
    ops.push(op)
  }
  return { ok: true, ops }
}

/** A precise-enough description for a malformed operation. */
function describeOp(value: unknown): string {
  if (value === null) return 'operation is null'
  if (!isRecord(value)) return `operation is ${typeof value}`
  const op = value['op']
  if (op === 'declare') return 'declare without a complete anchor'
  if (op === 'transition') return 'transition without a valid target/state/evidence'
  if (op === 'retire') return 'retire without an anchorId'
  return `unknown operation ${JSON.stringify(op)}`
}

/**
 * The identity of one prepared body.
 *
 * Native v4 packets derive their id from this function; the journal reader
 * recomputes it and refuses a file whose id does not match. Legacy v3 ids were
 * produced by a different algorithm and are re-derived only during verified
 * migration, never compared as if they were v4.
 *
 * @param input - the packet's session, checkpoint, span and body identity.
 * @returns the canonical packet id.
 */
export function packetIdOf(input: {
  readonly sessionId: SessionId
  readonly checkpointId: string
  readonly foldedSeqs: readonly number[]
  readonly bodyDigest: string
}): string {
  return canonicalHash({
    schema: SEMANTIC_SCHEMA_VERSION,
    sessionId: String(input.sessionId),
    checkpointId: input.checkpointId,
    foldedSeqs: [...input.foldedSeqs],
    bodyDigest: input.bodyDigest,
  })
}

/**
 * `canonicalHash` of a packet's resolved operations.
 *
 * The receipt stores this value. Any later state application recomputes it from
 * the packet file and compares: a packet changed after its receipt is a
 * conflict, not a new truth.
 *
 * @param packet - any object carrying an `ops` array.
 * @returns the operation digest.
 */
export function opsDigestOf(packet: { readonly ops: readonly EfAnchorEventData[] }): string {
  return canonicalHash(packet.ops)
}
