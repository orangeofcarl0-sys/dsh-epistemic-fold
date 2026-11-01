/**
 * The EF projection: wires the deterministic state reducer into
 * `ctx.sessionProjections` so the current state advances synchronously with
 * every committed session event, with a bounded, cacheable, JSON-safe state.
 *
 * The projection key is host-only (no wire view): the current state belongs
 * to the compaction backend, not to client renderers.
 *
 * @module dsh-epistemic-fold/projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyCurrentState, reduceEvent } from './state.ts'
import type { FoldCurrentState } from './state.ts'
import { efPluginRecordOf } from './plugin-events.ts'

/** The EF host projection key (merge-extended below). */
export const EF_CURRENT_STATE_KEY = 'epistemicFold.current' as const

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'epistemicFold.current': FoldCurrentState
  }
}

const anchorSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['objective', 'constraint', 'decision', 'value', 'artifact', 'evidence', 'failure', 'obligation']),
  stateKey: z.looseObject({ namespace: z.string(), entity: z.string(), property: z.string() }).optional(),
  value: z.json(),
  authority: z.enum(['normative', 'empirical', 'procedural', 'decision', 'narrative', 'hypothesis']),
  lifecycle: z.enum(['active', 'superseded', 'retired']),
  failureState: z.enum(['open', 'investigating', 'resolved', 'verified']).optional(),
  supersededBy: z.string().optional(),
  sourceRefs: z.array(z.looseObject({ sessionId: z.string().optional(), seq: z.number() })),
})

// The schemas validate the persisted JSON shape; the branded SessionId/seq
// faces are checked structurally, so the wiring casts through the registry's
// ZodType<S> contract once, here.
const currentStateSchema = z.looseObject({
  constraints: z.record(z.string(), anchorSchema),
  stateHeads: z.record(z.string(), anchorSchema),
  openFailures: z.record(z.string(), anchorSchema),
  openObligations: z.record(z.string(), anchorSchema),
  decisions: z.record(z.string(), anchorSchema),
  evidence: z.record(z.string(), anchorSchema),
  retiredCount: z.number(),
  objective: anchorSchema.optional(),
  // The revision chain. Optional in the SCHEMA even though it is required in
  // the type: a row written before this field existed must still validate, and
  // `stateVersion` below is what decides whether such a row is reused at all.
  superseded: z.record(z.string(), anchorSchema).optional(),
})

/**
 * The deterministic fold unit: synchronous, pure, bounded. `apply` receives
 * every committed event; the reducer ignores everything that is not an
 * `ef/anchor` operation or a failed tool result.
 */
export const epistemicFoldProjection: ProjectionDefinition<'epistemicFold.current', FoldCurrentState> = {
  key: EF_CURRENT_STATE_KEY,
  stateSchema: currentStateSchema as unknown as ZodType<FoldCurrentState>,
  /**
   * BUMPED 3 -> 4 when semantic state moved to the journal.
   *
   * A version-3 row folded `plugin:epistemic-fold/semantic` records directly.
   * A journal-authority deployment now replays those operations at their
   * historical commit positions, interleaved with session events. Reusing a
   * version-3 row would apply the same operations twice (or at the wrong
   * order), so the row is discarded and re-folded.
   *
   * BUMPED 2 -> 3 when plugin-record anchors and semantic records entered the
   * fold. A version-2 row cannot contain them, so reusing one would silently
   * drop committed semantic state after an upgrade.
   *
   * BUMPED 1 -> 2 when `superseded` was added.
   *
   * The projection contract is explicit: raise this whenever the serialized
   * state fields or the fold semantics change, so a persisted row from an older
   * unit is DISCARDED and re-folded rather than forward-applied. A version-1
   * row has no `superseded` map, and reusing it would leave the chain silently
   * empty — a state that looks valid and has quietly lost the thing this field
   * was added to carry.
   */
  stateVersion: 4,
  init: () => emptyCurrentState(),
  apply: reduceSessionEvent,
}

/**
 * Fold one committed session event into the deterministic state.
 *
 * Exported because the engine replays the same events when it must INTERLEAVE
 * journal commits at their historical seqs. A second implementation would be a
 * second state model; this is the one reducer, called from two places.
 *
 * Semantic commit records are deliberately NOT folded here. They are a legacy
 * source that the reconciler migrates into journal receipts, and the journal
 * replay applies their operations at the fold's commit position — not at the
 * log position where the old record happened to be appended.
 */
export function reduceSessionEvent(state: FoldCurrentState, event: SessionEvent): FoldCurrentState {
  // A plugin-record anchor (the 0.2.1 transport) is an `ef/anchor` event in
  // everything but its envelope type.
  const record = efPluginRecordOf(event)
  if (record !== undefined && record.kind === 'anchor') {
    return reduceEvent(state, { type: 'ef/anchor', seq: record.seq, data: record.data })
  }
  return reduceEvent(state, event)
}

/**
 * Register the EF current-state projection against the context's registry.
 * @returns the exact disposer that unregisters the unit.
 */
export function registerEpistemicFoldProjection(ctx: Context): () => void {
  const registry = ctx.get('sessionProjections') ?? new SessionProjectionRegistry(ctx)
  return registry.register(epistemicFoldProjection)
}

/** Read the current state for one session, materializing the fold on demand. */
export function currentFoldState(ctx: Context, session: Session): FoldCurrentState {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) return emptyCurrentState()
  return registry.stateOf(session, EF_CURRENT_STATE_KEY) ?? emptyCurrentState()
}
