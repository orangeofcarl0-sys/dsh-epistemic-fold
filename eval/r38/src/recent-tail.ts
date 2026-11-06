/**
 * R38-M0 WP5: recent-tail consistency.
 *
 * ## The window this closes
 *
 * ```text
 * t1  user approves the in-memory queue
 * t2  a fold commits that decision at seq N
 * t3  user approves the durable outbox at seq M > N
 * t4  the agent starts a new request
 * ```
 *
 * If the assembler reads only the semantic journal, it can deliver the t2 value
 * as the ONLY current decision while the raw log already contains a newer user
 * instruction. The state is not wrong at its commit point; it is stale at the
 * point of delivery.
 *
 * ## What this module does, and does not do
 *
 * It does NOT write the t3 decision into the journal. That would require a new
 * fold and a new validated commit. It produces an assessment the overlay can
 * carry:
 *
 *   - which snapshot the context was built from (four watermarks);
 *   - which anchors a later raw event may have superseded;
 *   - which anchors are safe to assert as current;
 *   - a warning line for each unsafe anchor.
 *
 * ## Two strengths, never one guess
 *
 * A later user message that shares the anchor's subject AND carries a revision
 * cue is `superseded-by-user`. A later user message that is merely more
 * relevant to the current task than the anchor is `requires-reconciliation`:
 * the system cannot prove it is a revision, so it refuses to assert the old
 * value as the only current one and says so.
 *
 * A tool observation never revokes a normative anchor. An assistant message
 * never overrides a user constraint. Those are authority rules, not text rules.
 *
 * @module eval/r38/src/recent-tail
 */

import type { Anchor, FoldCurrentState } from '../../../src/state/state.ts'
import { stateKeyText } from '../../../src/state/state.ts'
import { canonicalHash } from '../../../src/checkpoint/hash.ts'

/** The four watermarks a delivery snapshot must name. */
export interface SnapshotWatermarks {
  /** Highest semantic `commitOrder` in the projected state. */
  readonly semanticCommitWatermark: number
  /** Session seq the task frame was built from. */
  readonly sessionEventWatermark: number
  /** Checkpoint id (or digest) the archive view was taken at. */
  readonly archiveRevision: string
  /** Task frame revision. */
  readonly taskFrameRevision: string
}

/** One raw event after the semantic commit watermark. */
export interface TailEvent {
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
  readonly scope?: { readonly workspace?: string; readonly branch?: string }
}

/** How one anchor stands relative to the tail. */
export type TailVerdict =
  | 'no-later-event'
  | 'no-effect'
  | 'superseded-by-user'
  | 'requires-reconciliation'
  | 'scope-different'

/** One anchor's assessment. */
export interface AnchorAssessment {
  readonly anchorId: string
  readonly stateKeyText: string
  readonly committedAt: number
  readonly verdict: TailVerdict
  readonly safeToAssertAsCurrent: boolean
  readonly laterEventSeq?: number
  readonly laterRole?: TailEvent['role']
  readonly reasons: readonly string[]
}

/** The complete assessment. */
export interface RecentTailAssessment {
  readonly snapshot: SnapshotWatermarks
  readonly snapshotDigest: string
  readonly anchors: readonly AnchorAssessment[]
  readonly safeAnchorIds: readonly string[]
  readonly unsafeAnchorIds: readonly string[]
  readonly warnings: readonly string[]
  /** The task frame's watermark is older than an event it was given. */
  readonly frameStale: boolean
}

/** Options for {@link assessRecentTail}. */
export interface AssessOptions {
  readonly state: FoldCurrentState
  readonly events: readonly TailEvent[]
  readonly snapshot: SnapshotWatermarks
  /** The current request, used only for the weak relevance signal. */
  readonly currentRequest: string
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'not', 'are', 'was', 'were',
  'use', 'using', 'should', 'must', 'will', 'can', 'may', 'have', 'has', 'had', 'but', 'its',
  'our', 'their', 'than', 'then', 'when', 'where', 'which', 'while', 'about', 'after', 'before',
  'now', 'only', 'also', 'still', 'just', 'any', 'all', 'one', 'two', 'per', 'via',
])

const REVISION_CUE = /\b(switch|instead|revoke|revoked|no longer|change|changed|replace|replaced|supersede|supersedes|rather than|skip|skips|approve|approved|decide|decided|prefer|go with)\b|(改用|改为|不再|撤销|替换)/iu

function words(text: string): Set<string> {
  // Split on every non-alphanumeric, so a state key (`semantic/decision/
  // scheduler-queue`) contributes `scheduler` and `queue` as subjects instead
  // of one opaque token.
  const matches = text.toLowerCase().match(/[a-z0-9]{2,}/gu) ?? []
  return new Set(matches.filter(word => !STOPWORDS.has(word)))
}

function sharedTokens(left: string, right: string): string[] {
  const rightWords = words(right)
  return [...words(left)].filter(word => rightWords.has(word))
}

function anchorText(anchor: Anchor): string {
  const value = typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value)
  return `${anchor.stateKey === undefined ? '' : stateKeyText(anchor.stateKey)} ${value}`
}

function committedAt(anchor: Anchor): number {
  let latest = -1
  for (const ref of anchor.sourceRefs) {
    const seq = Number(ref.seq)
    if (seq > latest) latest = seq
  }
  return latest
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

function scopeConflicts(anchor: Anchor, event: TailEvent): boolean {
  if (anchor.scope === undefined || event.scope === undefined) return false
  if (anchor.scope.workspace !== undefined && event.scope.workspace !== undefined) {
    return anchor.scope.workspace !== event.scope.workspace
  }
  if (anchor.scope.branch !== undefined && event.scope.branch !== undefined) {
    return anchor.scope.branch !== event.scope.branch
  }
  return false
}

/**
 * Assess one anchor against the events after its commit.
 *
 * @returns the verdict and the reasons that produced it.
 */
function assessAnchor(
  anchor: Anchor,
  events: readonly TailEvent[],
  request: string,
): { verdict: TailVerdict; event?: TailEvent; reasons: string[] } {
  if (events.length === 0) return { verdict: 'no-later-event', reasons: ['no event after the commit watermark'] }
  const text = anchorText(anchor)
  // Shared-subject matching uses the CLAIM, not the coordinate: a coordinate
  // like `scheduler-queue` contributes `scheduler` and `queue` to every
  // scheduler message and would make any task-relevant note look like a
  // revision. Frame relevance still uses the coordinate, because the
  // coordinate is what says which part of the task the anchor belongs to.
  const valueText = typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value)
  const requestWords = words(request)
  const anchorMatchesFrame = [...words(text)].some(word => requestWords.has(word))

  // Latest first: the most recent raw signal decides.
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    const shared = sharedTokens(valueText, event.text)
    const cue = REVISION_CUE.test(event.text)
    const eventMatchesFrame = [...words(event.text)].some(word => requestWords.has(word))

    if (scopeConflicts(anchor, event)) {
      return { verdict: 'scope-different', event, reasons: ['the later event is in another scope'] }
    }

    if (event.role === 'user') {
      // One shared CLAIM token plus a cue is a revision of a decision or a
      // constraint. The coordinate is excluded above, so this cannot fire on
      // the task domain alone.
      if (shared.length >= 1 && cue) {
        if (anchor.authority === 'normative' || anchor.authority === 'decision') {
          return {
            verdict: 'superseded-by-user',
            event,
            reasons: [`shared subject: ${shared.join(', ')}`, 'revision cue in a user message'],
          }
        }
        return {
          verdict: 'requires-reconciliation',
          event,
          reasons: [
            `shared subject: ${shared.join(', ')}`,
            'a user instruction does not revoke an empirical finding; it may change its relevance',
          ],
        }
      }
      // A task-relevant user message with a cue, where the anchor is also
      // task-relevant, may be a revision the text does not prove.
      if (eventMatchesFrame && cue && anchorMatchesFrame) {
        return {
          verdict: 'requires-reconciliation',
          event,
          reasons: [
            'the later user message is relevant to the current task',
            'the anchor is relevant too, but the texts do not prove a revision',
          ],
        }
      }
      continue
    }

    if (event.role === 'tool') {
      if (anchor.authority === 'normative' || anchor.authority === 'decision') {
        return {
          verdict: 'no-effect',
          event,
          reasons: [`a tool observation cannot revoke a ${anchor.authority} anchor`],
        }
      }
      if (shared.length > 0) {
        return {
          verdict: 'requires-reconciliation',
          event,
          reasons: [`shared subject: ${shared.join(', ')}`, 'new empirical evidence may update the finding'],
        }
      }
      continue
    }

    // assistant
    if (anchor.authority === 'normative') {
      return {
        verdict: 'no-effect',
        event,
        reasons: ['an assistant message cannot override a user constraint'],
      }
    }
    if (shared.length > 0 && cue) {
      return {
        verdict: 'requires-reconciliation',
        event,
        reasons: [`shared subject: ${shared.join(', ')}`, 'an assistant proposal is not a user revision'],
      }
    }
  }
  return { verdict: 'no-effect', reasons: ['later events exist but none names this anchor'] }
}

/**
 * Assess the whole projected state against the raw tail.
 *
 * @param options - the state, the tail events, the watermarks and the request.
 * @returns the per-anchor verdicts, the unsafe set and the warning lines.
 */
export function assessRecentTail(options: AssessOptions): RecentTailAssessment {
  const tail = options.events.filter(event => event.seq > options.snapshot.semanticCommitWatermark)
  const maxEventSeq = options.events.reduce((max, event) => Math.max(max, event.seq), 0)
  const frameStale = maxEventSeq > options.snapshot.sessionEventWatermark
  const anchors = activeAnchors(options.state).map(anchor => {
    const result = assessAnchor(anchor, tail, options.currentRequest)
    const safe = result.verdict === 'no-later-event'
      || result.verdict === 'no-effect'
      || result.verdict === 'scope-different'
    return {
      anchorId: anchor.id,
      stateKeyText: anchor.stateKey === undefined ? '' : stateKeyText(anchor.stateKey),
      committedAt: committedAt(anchor),
      verdict: result.verdict,
      safeToAssertAsCurrent: safe,
      ...(result.event === undefined ? {} : { laterEventSeq: result.event.seq, laterRole: result.event.role }),
      reasons: result.reasons,
    }
  }).sort((left, right) => left.anchorId.localeCompare(right.anchorId))

  const warnings: string[] = []
  if (frameStale) {
    warnings.push(
      `frame-stale: the task frame watermark is ${options.snapshot.sessionEventWatermark} `
      + `but the session has an event at ${maxEventSeq}; rebuild the frame before delivery`,
    )
  }
  for (const row of anchors) {
    if (row.safeToAssertAsCurrent) continue
    warnings.push(
      `reconcile ${row.anchorId}: committed at seq ${row.committedAt}; a later ${row.laterRole ?? 'event'} `
      + `at seq ${row.laterEventSeq ?? '?'} gives "${row.verdict}"; do not assert the old value as the only current one`,
    )
  }

  const snapshotDigest = canonicalHash({
    snapshot: options.snapshot,
    verdicts: anchors.map(row => ({
      anchorId: row.anchorId,
      verdict: row.verdict,
      laterEventSeq: row.laterEventSeq ?? null,
    })),
    frameStale,
  })

  return {
    snapshot: options.snapshot,
    snapshotDigest,
    anchors,
    safeAnchorIds: anchors.filter(row => row.safeToAssertAsCurrent).map(row => row.anchorId).sort(),
    unsafeAnchorIds: anchors.filter(row => !row.safeToAssertAsCurrent).map(row => row.anchorId).sort(),
    warnings,
    frameStale,
  }
}
