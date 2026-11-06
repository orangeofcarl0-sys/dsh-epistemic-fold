/**
 * R38-M0 WP6: the task-specific context overlay.
 *
 * ## What it is
 *
 * An IMMUTABLE checkpoint plus a task-specific overlay, delivered through the
 * DSH system-prompt CONTEXT channel. It does not rewrite the checkpoint, the
 * journal or the session log. The overlay is a snapshot message with
 * `source.kind = 'runtime-context'`, which the DSH loop logs and replays, and
 * which EF's authority model treats as context injection — never as a user
 * instruction.
 *
 * ## What it carries
 *
 *   - the four watermarks and the selection digest;
 *   - the task-aware selection;
 *   - integrity and recent-tail warnings;
 *   - bounded archive passages, each with a checkpoint/offset/seq.
 *
 * ## Cache stability
 *
 * The stable system prefix is not touched. The overlay is a context
 * contribution, assembled per step and re-emitted only when its text changes
 * (DSH's `RuntimeContextProjection` compares the retained snapshot). The digest
 * and the changed-byte count are recorded so a caller can see what moved.
 *
 * @module eval/r38/src/context-overlay
 */

import type { FoldCurrentState } from '../../../src/state/state.ts'
import { canonicalHash } from '../../../src/checkpoint/hash.ts'
import { selectTaskAwareContext } from './task-aware-selector.ts'
import type { TaskFrame } from './task-aware-selector.ts'
import { assessRecentTail } from './recent-tail.ts'
import type { SnapshotWatermarks, TailEvent } from './recent-tail.ts'
import type { RecoveredPassage } from './archive-recovery.ts'

/** Everything the overlay is built from. */
export interface OverlayInput {
  readonly state: FoldCurrentState
  readonly frame: TaskFrame
  readonly budgetTokens: number
  readonly events: readonly TailEvent[]
  readonly watermarks: SnapshotWatermarks
  readonly integrityWarnings?: readonly string[]
  readonly recovered?: readonly RecoveredPassage[]
  /** The previous overlay text, for the changed-byte count. */
  readonly previousText?: string
}

/** The composed overlay and its identities. */
export interface ContextOverlay {
  readonly text: string
  readonly selectionDigest: string
  readonly taskFrameDigest: string
  readonly stateRevision: string
  readonly renderedDigest: string
  readonly tokenEstimate: number
  readonly changedBytes: number
  readonly warnings: readonly string[]
  readonly recoveredPassages: number
  readonly selectedAnchorIds: readonly string[]
  readonly snapshot: SnapshotWatermarks
}

/** Longest common prefix length, bounded to the shorter string. */
function commonPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/** Longest common suffix length, not overlapping the prefix. */
function commonSuffix(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix
  let index = 0
  while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1
  return index
}

/**
 * Build the overlay for one task step.
 *
 * @param input - the state, frame, tail, watermarks and optional warnings.
 * @returns the rendered overlay plus the digests a caller records.
 */
export function buildContextOverlay(input: OverlayInput): ContextOverlay {
  const selection = selectTaskAwareContext({
    state: input.state,
    frame: input.frame,
    budgetTokens: input.budgetTokens,
    ...(input.integrityWarnings === undefined ? {} : { integrityWarnings: input.integrityWarnings }),
  })
  const tail = assessRecentTail({
    state: input.state,
    events: input.events,
    snapshot: input.watermarks,
    currentRequest: input.frame.currentRequest,
  })

  const warnings = [
    ...(input.integrityWarnings ?? []).map(line => `integrity: ${line}`),
    ...tail.warnings,
  ]

  const parts: string[] = [
    '[EF context overlay]',
    `snapshot state=${input.watermarks.semanticCommitWatermark} `
      + `session=${input.watermarks.sessionEventWatermark} `
      + `archive=${input.watermarks.archiveRevision} `
      + `frame=${input.watermarks.taskFrameRevision}`,
    `selection ${selection.selectionDigest}`,
  ]
  if (selection.renderedText.length > 0) parts.push(selection.renderedText)
  if (warnings.length > 0) {
    parts.push(['Warnings', ...warnings.map(line => `- ${line}`)].join('\n'))
  }
  if (tail.unsafeAnchorIds.length > 0) {
    parts.push(`unsafe-to-assert ${tail.unsafeAnchorIds.join(',')}`)
  }
  if ((input.recovered ?? []).length > 0) {
    const lines = (input.recovered ?? []).map(passage =>
      `- [${passage.checkpointId}:${passage.offset} seq ${passage.sourceRefs.join(',') || 'unknown'}] ${passage.excerpt}`)
    parts.push(['Recovered from archive', ...lines].join('\n'))
  }
  const text = parts.join('\n\n')

  const taskFrameDigest = canonicalHash({
    taskId: input.frame.taskId ?? null,
    phase: input.frame.phase ?? null,
    workspace: input.frame.workspace ?? null,
    branch: input.frame.branch ?? null,
    files: [...input.frame.files],
    symbols: [...input.frame.symbols],
    request: input.frame.currentRequest,
    revision: input.frame.semanticStateRevision,
    watermark: input.frame.sessionEventWatermark,
  })

  let changedBytes = text.length
  if (input.previousText !== undefined && input.previousText.length > 0) {
    const prefix = commonPrefix(text, input.previousText)
    const suffix = commonSuffix(text, input.previousText, prefix)
    changedBytes = text.length - prefix - suffix
  }

  return {
    text,
    selectionDigest: selection.selectionDigest,
    taskFrameDigest,
    stateRevision: input.frame.semanticStateRevision,
    renderedDigest: canonicalHash(text),
    tokenEstimate: Math.ceil(text.length / 4),
    changedBytes,
    warnings,
    recoveredPassages: (input.recovered ?? []).length,
    selectedAnchorIds: selection.selectedAnchorIds,
    snapshot: input.watermarks,
  }
}
