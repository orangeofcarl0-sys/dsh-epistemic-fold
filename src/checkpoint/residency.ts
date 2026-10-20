/**
 * Checkpoint residency: whether a checkpoint is still part of the working surface.
 *
 * ## Why this exists before anything uses it
 *
 * Anchors have a lifecycle -- `active` / `superseded` / `retired`, driven by an explicit
 * `ef/anchor` operation -- and a checkpoint written onto the surface has NONE. That asymmetry is
 * the reason the exit mechanism does not exist: there is no state a retirement could name, so
 * there is nothing to retire, and "this phase is done" cannot be expressed at all.
 *
 * This module is the data model and the derivation, and nothing else. It retires nothing, it
 * removes nothing, and no decision reads it -- which is deliberate, because a model change that
 * also changes behaviour cannot be validated on its own. The order is: name the state, expose it,
 * check that the reading is right on runs that already exist, and only then let anything act.
 *
 * ## Three states, because a checkpoint can leave the surface WITHOUT being retired
 *
 *   resident  on the surface: the model can see it now
 *   archived  no longer on the surface, because a later fold folded it away
 *   retired   an explicit operation took it out of the working set
 *
 * `archived` and `retired` are different facts with different consequences. An archived
 * checkpoint's content has been re-summarised into a later one -- the information is still carried,
 * lossily. A retired checkpoint's content is deliberately NOT carried; the only route back is
 * `context_recall`. Collapsing the two into one `gone` flag would make a retirement look like a
 * fold, and the accuracy difference between them is the entire measurement.
 *
 * ## Why a retired checkpoint that is still on the surface is reported as a CONFLICT
 *
 * Nothing enforces retirement yet, so `retired && resident` is reachable, and it is exactly the
 * state that must not be measured: the report says so rather than picking one of the two facts.
 * When removal lands, this state becomes unreachable and the conflict count must go to zero --
 * which makes it a usable invariant rather than a comment.
 *
 * @module dsh-epistemic-fold/checkpoint-residency
 */

import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { parseCheckpointMarker } from './checkpoint-marker.ts'
import type { EfCheckpointMarker } from './checkpoint-marker.ts'

/**
 * An explicit retirement of one checkpoint.
 *
 * Modelled on `ef/anchor`'s `retire` operation: a RECORDED ACT, never an inference from age or
 * from the absence of retrieval demand. The failure this rules out is a system that quietly drops
 * a constraint because it has not been mentioned recently -- and a constraint not being mentioned
 * is the normal state of a constraint.
 */
export interface EfRetireEventData {
  /** The checkpoint id, in the `cp:` form the marker carries. */
  readonly checkpointId: string
  /** Free text: why it was retired. Recorded so a later reader cannot mistake the reason. */
  readonly reason?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** EF checkpoint retirement: an explicit operation, log-only, never inferred. */
    'ef/retire': EfRetireEventData
  }
}

/** Where a checkpoint stands. See the module note for why these are three and not two. */
export type CheckpointResidency = 'resident' | 'archived' | 'retired'

/** One checkpoint found in the session, with the facts behind its residency. */
export interface CheckpointSite {
  readonly checkpointId: string
  readonly mode: EfCheckpointMarker['mode']
  /** The seq of the `compaction/summary` event that wrote it. */
  readonly seq: SessionSeq
  /** Whether that seq is still one of the surface's nodes RIGHT NOW. */
  readonly onSurface: boolean
  /** The retirement record naming it, if any. */
  readonly retiredBy?: SessionSeq
  readonly residency: CheckpointResidency
}

/** The derivation's answer, with the counts a caller would otherwise recompute. */
export interface CheckpointResidencyReport {
  readonly sites: readonly CheckpointSite[]
  readonly resident: number
  readonly archived: number
  readonly retired: number
  /**
   * Retired checkpoints STILL on the surface.
   *
   * Must be zero once removal exists. Non-zero means a retirement was recorded and not honoured,
   * so any measurement taken in that state compares a treatment that was never applied against a
   * baseline -- the exact silent failure this report exists to make loud.
   */
  readonly conflicts: number
}

/** Read the summary text out of a `compaction/summary` event, or undefined when it has none. */
function summaryText(event: { readonly data?: unknown }): string | undefined {
  const data = event.data as { summary?: readonly { type?: string; text?: string }[] } | undefined
  if (data?.summary === undefined) return undefined
  return data.summary.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
}

/**
 * Every checkpoint the session has ever written, in seq order, with its residency.
 *
 * Iterates the log rather than the surface, because a checkpoint that has been folded away is
 * still a fact about the session and is exactly what `archived` names. Surface membership is then
 * a lookup, not the enumeration.
 */
export function deriveCheckpointResidency(session: Session): CheckpointResidencyReport {
  const onSurface = new Set<number>(session.surface.nodes as readonly number[])

  // ## Two passes, because a retirement is recorded AFTER the checkpoint it retires
  //
  // The first version resolved each checkpoint's retirement as it walked past it, and every
  // retirement therefore looked absent: the record sits at a LATER seq than the summary it
  // names. Three of the six tests failed on exactly that, which is what they were written for.
  const retirements = new Map<string, SessionSeq>()
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event === undefined || event.type !== 'ef/retire') continue
    const data = event.data as EfRetireEventData
    // First record wins. A checkpoint retired twice retires once, and the second record cannot
    // move the seq that retired it, which keeps the reading stable if a host replays an op.
    if (!retirements.has(data.checkpointId)) retirements.set(data.checkpointId, seq as SessionSeq)
  }

  const sites: CheckpointSite[] = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event === undefined || event.type !== 'compaction/summary') continue
    const text = summaryText(event)
    if (text === undefined) continue
    const marker = parseCheckpointMarker(text)
    // A summary without EF's marker is BASIC's checkpoint, not EF's. It has no checkpoint id, so
    // a retirement cannot name it; leaving it out is the honest answer, and inventing an id would
    // make it addressable by a record that cannot mean it.
    if (marker === undefined) continue
    const retiredBy = retirements.get(marker.checkpointId)
    const resident = onSurface.has(seq)
    sites.push({
      checkpointId: marker.checkpointId,
      mode: marker.mode,
      seq: seq as SessionSeq,
      onSurface: resident,
      ...(retiredBy === undefined ? {} : { retiredBy }),
      residency: retiredBy === undefined ? (resident ? 'resident' : 'archived') : 'retired',
    })
  }

  let resident = 0
  let archived = 0
  let retired = 0
  let conflicts = 0
  for (const site of sites) {
    if (site.residency === 'resident') resident += 1
    else if (site.residency === 'archived') archived += 1
    else {
      retired += 1
      if (site.onSurface) conflicts += 1
    }
  }
  return { sites, resident, archived, retired, conflicts }
}