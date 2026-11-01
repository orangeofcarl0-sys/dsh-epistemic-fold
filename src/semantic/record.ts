/**
 * The durable semantic record: the payload of one committed packet, plus the
 * replay that turns committed records back into state.
 *
 * ## A record is a COMMIT record, not a proposal
 *
 * It is written only after the fold's surface replacement is observed, and it
 * carries the packet's already-resolved `ops`. Reading it therefore needs no
 * second resolution pass, no evidence quotes, and no current-state oracle: the
 * log says exactly which operations became state and in what order.
 *
 * ## Owner validation is mandatory
 *
 * A restored record carries whatever JSON an earlier build of this package
 * wrote, or a V3 event a format migration renamed into the `plugin:` namespace.
 * `semanticRecordPayloadOf` validates the fields that decide state and refuses
 * everything else; the projection applies only what passed.
 *
 * @module dsh-epistemic-fold/semantic/record
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { FoldCurrentState } from '../state/state.ts'
import { efPluginRecordOf } from '../state/plugin-events.ts'
import type { EfPluginRecord } from '../state/plugin-events.ts'
import type { EfAnchorEventData } from '../state/state.ts'
import { isAnchorOp } from './ops.ts'
import { LEGACY_SEMANTIC_RECORD_VERSION, SEMANTIC_SCHEMA_VERSION } from './types.ts'
import { applyOps } from './plan.ts'

/** The payload written as `plugin:epistemic-fold/semantic`. */
export interface SemanticRecordPayload {
  readonly schemaVersion: number
  readonly packetId: string
  readonly checkpointId: string
  readonly foldedSeqs: readonly number[]
  readonly bodyDigest: string
  /** The resolved operations, in application order. */
  readonly ops: readonly EfAnchorEventData[]
}

/**
 * Whether one unknown value is a replayable v3 semantic record.
 *
 * The ops are checked structurally and then individually: a `declare` without
 * an anchor, or an anchor without an id/stateKey/lifecycle, is refused rather
 * than passed to the reducer. A malformed record must not be able to clear a
 * field or crash the projection on every later event.
 */
export function semanticRecordPayloadOf(value: unknown): SemanticRecordPayload | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const payload = value as Partial<SemanticRecordPayload>
  // v3 is the legacy record schema; v4 is accepted for forward-compatible
  // readers even though the journal is now the sole state authority (a record
  // is still useful as a MIGRATION source, never as an independent authority).
  if (payload.schemaVersion !== LEGACY_SEMANTIC_RECORD_VERSION
    && payload.schemaVersion !== SEMANTIC_SCHEMA_VERSION) return undefined
  if (typeof payload.packetId !== 'string' || typeof payload.bodyDigest !== 'string') return undefined
  if (typeof payload.checkpointId !== 'string') return undefined
  if (!Array.isArray(payload.foldedSeqs) || payload.foldedSeqs.some(seq => typeof seq !== 'number')) return undefined
  if (!Array.isArray(payload.ops)) return undefined
  if (!payload.ops.every(isAnchorOp)) return undefined
  return {
    schemaVersion: payload.schemaVersion,
    packetId: payload.packetId,
    checkpointId: payload.checkpointId,
    foldedSeqs: payload.foldedSeqs,
    bodyDigest: payload.bodyDigest,
    ops: payload.ops,
  }
}

/** Read one committed event as a semantic record, or `undefined`. */
export function semanticRecordOf(event: {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data: unknown
}): { readonly record: EfPluginRecord; readonly payload: SemanticRecordPayload } | undefined {
  const record = efPluginRecordOf(event)
  if (record === undefined || record.kind !== 'semantic') return undefined
  const payload = semanticRecordPayloadOf(record.data)
  return payload === undefined ? undefined : { record, payload }
}

/** Every committed semantic record in one session, in commit order. */
export function semanticRecordsIn(session: Session): readonly {
  readonly seq: number
  readonly payload: SemanticRecordPayload
}[] {
  const out: { seq: number; payload: SemanticRecordPayload }[] = []
  for (const event of session.snapshotEvents()) {
    const parsed = semanticRecordOf(event)
    if (parsed !== undefined) out.push({ seq: parsed.record.seq, payload: parsed.payload })
  }
  return out
}

/**
 * Project committed semantic records onto a session-derived state.
 *
 * The SAME reducer folds the operations, so a semantic anchor obeys exactly
 * the coordinate/supersession/failure rules a user-declared anchor does. This
 * is a layer, not a second state model: it starts from the projection's value
 * and returns a new value.
 *
 * @param state - the session-derived current state.
 * @param records - committed records in seq order.
 * @returns the state with every record's operations applied.
 */
export function projectSemanticRecords(
  state: FoldCurrentState,
  records: readonly { readonly payload: SemanticRecordPayload }[],
): FoldCurrentState {
  let next = state
  for (const record of records) {
    next = applyOps(next, record.payload.ops)
  }
  return next
}

/** The same layer, for a journal-authority deployment. */
export function projectSemanticOps(
  state: FoldCurrentState,
  opsByPacket: readonly (readonly EfAnchorEventData[])[],
): FoldCurrentState {
  let next = state
  for (const ops of opsByPacket) next = applyOps(next, ops)
  return next
}
