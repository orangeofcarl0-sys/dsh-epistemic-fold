/**
 * The EF compile hook: splits Basic's summarization input into the retained
 * system head and the shadowed span, archives the span exactly, and renders
 * the checkpoint — semantic when the model call succeeds, deterministic
 * fallback when it does not.
 *
 * @module dsh-epistemic-fold/compiler
 */

import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { encodeCheckpointMarker } from './checkpoint-marker.ts'
import { canonicalHash } from './hash.ts'
import type { CheckpointBundleV1, FoldCandidate } from './types.ts'

export interface SplitSummarizationInput {
  /** Leading `system` message retained ahead of the checkpoint, if present. */
  readonly contextPrefix: readonly Message[]
  /** The exact model-visible messages being folded. */
  readonly shadowedMessages: readonly Message[]
}

/**
 * Basic's replay input is the system head (when one projects) followed by the
 * shadowed region in surface order. The archive covers ONLY the shadowed
 * region; the system head is not part of the fold.
 */
export function splitSummarizationInput(input: { readonly messages: readonly Message[] }): SplitSummarizationInput {
  const first = input.messages[0]
  if (first?.role === 'system') {
    return {
      contextPrefix: [first],
      shadowedMessages: input.messages.slice(1),
    }
  }
  return { contextPrefix: [], shadowedMessages: input.messages }
}

/**
 * Deterministic checkpoint body for a fold whose identity is known.
 *
 * R3-A: the id is not restated as a trailing line. The marker already carries
 * `cp:<id>` in the exact form `context_recall` accepts, so repeating it told
 * the model nothing new on every fold.
 */
export function renderFallbackCheckpoint(candidate: FoldCandidate, messageCount: number): string {
  return [
    encodeCheckpointMarker(candidate),
    '',
    `- Folded ${messageCount} message(s); semantic summary unavailable.`,
    '- Exact archived model history is recoverable via context_recall.',
  ].join('\n')
}

/** Model-written digest text; state never derives from it (D-006). */
export function renderSemanticCheckpoint(candidate: FoldCandidate, text: string): string {
  return [
    encodeCheckpointMarker(candidate),
    '',
    text,
  ].join('\n')
}

const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** Surface framing identical in shape to Basic's framed checkpoints. */
export function frameCheckpoint(text: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${text}\n</compacted-summary>`
}

/** Build the immutable bundle for one fold; the caller publishes it durably. */
export function buildBundle(options: {
  candidate: FoldCandidate
  orderedSurfaceSeqs: readonly SessionSeq[]
  shadowedMessages: readonly Message[]
  renderedText: string
  semanticText?: string
  compactionId?: CompactionId
  /**
   * The state the rendered body was projected from, if a projection was
   * mounted. Recorded as a digest so a later reader can prove the checkpoint
   * still shows what the log derives; see `CheckpointBundleV1.state`.
   */
  renderedState?: { readonly digest: string; readonly anchors: number }
}): CheckpointBundleV1 {
  const { candidate } = options
  const logicalHash = canonicalHash(options.shadowedMessages)
  return Object.freeze({
    format: 'ef-checkpoint',
    formatVersion: 1,
    checkpointId: candidate.checkpointId,
    sessionId: candidate.sessionId,
    createdAt: Date.now(),
    mode: candidate.mode,
    ...(options.compactionId === undefined ? {} : { compactionId: options.compactionId }),
    source: {
      orderedSurfaceSeqs: [...options.orderedSurfaceSeqs],
      sourceDigest: canonicalHash({
        seed: candidate.sourceDigestSeed,
        seqs: options.orderedSurfaceSeqs,
      }),
    },
    archive: {
      shadowedMessages: Object.freeze([...options.shadowedMessages]),
      logicalHash,
    },
    ...(options.semanticText === undefined
      ? {}
      : { semantic: { text: options.semanticText } }),
    ...(options.renderedState === undefined
      ? {}
      : { state: options.renderedState }),
    rendered: {
      text: options.renderedText,
      digest: canonicalHash(options.renderedText),
    },
  })
}
