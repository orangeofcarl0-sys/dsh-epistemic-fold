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
  /**
   * The surface node's seq, when the model can see this checkpoint.
   *
   * Distinct from `seq`: a checkpoint is a `compaction/summary` LOG record at one seq, and the
   * model-visible node is a `user/message` materialised at a LATER one. Removal has to unhook the
   * surface node, so the two are carried separately rather than assumed equal.
   */
  readonly surfaceSeq?: SessionSeq
  /** Whether the model can see this checkpoint RIGHT NOW (its marker is on a surface node). */
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

/** Read the text blocks out of a SURFACE message event's content. */
function messageText(event: { readonly data?: unknown }): string | undefined {
  const data = event.data as { content?: readonly { type?: string; text?: string }[] } | undefined
  if (!Array.isArray(data?.content)) return undefined
  return data.content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
}

/**
 * Every checkpoint the session has ever written, with its residency.
 *
 * ## A checkpoint is TWO events, and the surface is the second one
 *
 * Measured 2026-10-20 on a real fold at 131K:
 *
 *     seq 24  compaction/start
 *     seq 25  compaction/summary   <- the fold's record: shadowedSeqs, digest text
 *     seq 26  user/message         <- THE SURFACE NODE the model actually sees
 *     seq 27  compaction/end
 *
 * The first version enumerated `compaction/summary` events and asked whether THEIR seq was on the
 * surface. It never is, so every checkpoint read as `archived` and nothing was ever retirable --
 * eight folds, zero residents, and the phase-exit driver silently retired nothing.
 *
 * So residency is read from the SURFACE nodes: each is a message whose text carries the same
 * marker, and the marker's id is what joins the two events. The log record supplies the fold
 * history (which seqs it shadowed); the surface node supplies whether the model can still see it.
 */
export function deriveCheckpointResidency(session: Session): CheckpointResidencyReport {
  const surfaceSeqs = session.surface.nodes as readonly number[]

  // Pass 1: retirements. They are recorded AFTER the checkpoint they retire, so they cannot be
  // resolved while walking past the checkpoint itself.
  const retirements = new Map<string, SessionSeq>()
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event === undefined || event.type !== 'ef/retire') continue
    const data = event.data as EfRetireEventData
    if (!retirements.has(data.checkpointId)) retirements.set(data.checkpointId, seq as SessionSeq)
  }

  // Pass 2: which checkpoint ids the model can see right now. Read from the surface's own nodes,
  // because that is the definition of resident -- not a count, and not an inference.
  const residentOn = new Map<string, SessionSeq>()
  for (const seq of surfaceSeqs) {
    const event = session.eventAt(seq as never)
    if (event === undefined) continue
    const text = messageText(event)
    if (text === undefined) continue
    const marker = parseCheckpointMarker(text)
    if (marker === undefined) continue
    residentOn.set(marker.checkpointId, seq as SessionSeq)
  }

  // Pass 3: the fold records, which are what carry an id and a mode. A summary with no EF marker
  // is Basic's checkpoint: it has no id, so a retirement cannot name it and it is left out rather
  // than given an invented one.
  const sites: CheckpointSite[] = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event === undefined || event.type !== 'compaction/summary') continue
    const text = summaryText(event)
    if (text === undefined) continue
    const marker = parseCheckpointMarker(text)
    if (marker === undefined) continue
    const retiredBy = retirements.get(marker.checkpointId)
    const surfaceSeq = residentOn.get(marker.checkpointId)
    const onSurface = surfaceSeq !== undefined
    sites.push({
      checkpointId: marker.checkpointId,
      mode: marker.mode,
      seq: seq as SessionSeq,
      ...(surfaceSeq === undefined ? {} : { surfaceSeq }),
      onSurface,
      ...(retiredBy === undefined ? {} : { retiredBy }),
      residency: retiredBy === undefined ? (onSurface ? 'resident' : 'archived') : 'retired',
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

/** Why a durable `ef/retire` write was refused. */
export type RetireRefusal = 'no-such-checkpoint' | 'already-retired'

/** The outcome of one retirement attempt: written, or refused with the reason. */
export interface RetireOutcome {
  readonly checkpointId: string
  readonly written: boolean
  readonly refusal?: RetireRefusal
}

/** Construction options for a retirement write. */
export interface CheckpointRetirementOptions {
  /**
   * Whether this deployment may write a plugin-owned durable session event.
   *
   * Defaults to true -- the in-memory and test face. The plugin wires the real host capability,
   * and a deployment that persists sessions on a host without the `ignorable` marker would
   * otherwise poison every log it writes.
   */
  readonly durableWritesAllowed?: () => boolean
}

/**
 * Retire one checkpoint: an EXPLICIT operation, recorded in the log.
 *
 * ## Two refusals, and both matter
 *
 *   no-such-checkpoint  a retirement that names nothing is a no-op wearing the shape of an
 *                       action. It would let a driver believe it retired a phase while the
 *                       surface never changed, and the next measurement would compare a
 *                       baseline against a baseline.
 *   already-retired     a second retirement cannot move the seq that retired it, so accepting it
 *                       would make the reading depend on how many times the driver asked.
 *
 * Neither is thrown: a caller retiring a LIST needs the per-item answer, and throwing on the
 * first duplicate would abandon the rest without saying so.
 *
 * The write is refused BEFORE the append rather than after it, for the same reason an anchor
 * declaration is: a log that writes cleanly and cannot be reopened is not a failure that can be
 * reported after the fact, because by then the damage is durable.
 */
export function retireCheckpoint(
  session: Session,
  checkpointId: string,
  reason?: string,
  options: CheckpointRetirementOptions = {},
): RetireOutcome {
  const durableWritesAllowed = options.durableWritesAllowed ?? ((): boolean => true)
  if (!durableWritesAllowed()) {
    throw new Error(
      'epistemic-fold: refusing to append `ef/retire` -- this DSH host cannot mark a plugin-owned'
      + ' session event `ignorable`, and the persistence read path refuses to reopen a log'
      + ' containing an unknown event type without that marker. See README, "State ownership".',
    )
  }
  const report = deriveCheckpointResidency(session)
  const site = report.sites.find(candidate => candidate.checkpointId === checkpointId)
  if (site === undefined) return { checkpointId, written: false, refusal: 'no-such-checkpoint' }
  if (site.residency === 'retired') return { checkpointId, written: false, refusal: 'already-retired' }
  session.append('ef/retire', {
    checkpointId,
    ...(reason === undefined ? {} : { reason }),
  })
  return { checkpointId, written: true }
}
