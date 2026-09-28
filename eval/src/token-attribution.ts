/**
 * R1-A token source attribution: split one request's metered prompt into the
 * buckets docs/11 §5 names, so cost questions ("is it the checkpoints, the
 * tool output, or the raw history?") are answered from measurement rather than
 * intuition.
 *
 * Pricing authority: the DSH token meter's own per-node prices. A surface
 * node's price is authoritative and never recomputed here — the classifier
 * only decides WHICH bucket a node's metered price belongs to. The one
 * exception is an EF leaf checkpoint, whose single surface node carries three
 * semantically distinct payloads (machine state / rationale / framing); that
 * node is decomposed by the SAME fixed density heuristic the meter uses
 * (`ceil(chars / 4)`), and any residual — role and block overhead — is
 * assigned to `checkpoint-framing`, so the parts always reconcile exactly to
 * the metered node price. No precision is invented: a bucket that cannot be
 * separated is reported as `unattributed-envelope` rather than guessed.
 *
 * @module eval/token-attribution
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import { parseCheckpointMarker } from '../../src/checkpoint-marker.ts'

/** The closed attribution vocabulary (docs/11 §5). */
export type TokenBucket =
  | 'system'
  | 'tool-schema'
  | 'raw-user'
  | 'raw-assistant'
  | 'raw-tool-result'
  | 'checkpoint-root'
  | 'checkpoint-basic'
  | 'checkpoint-leaf-state'
  | 'checkpoint-leaf-rationale'
  | 'checkpoint-framing'
  | 'recall'
  | 'unattributed-envelope'

/** Every bucket, in report order. */
export const TOKEN_BUCKETS: readonly TokenBucket[] = [
  'system',
  'tool-schema',
  'raw-user',
  'raw-assistant',
  'raw-tool-result',
  'checkpoint-root',
  'checkpoint-basic',
  'checkpoint-leaf-state',
  'checkpoint-leaf-rationale',
  'checkpoint-framing',
  'recall',
  'unattributed-envelope',
]

/** One request's attributed prompt, in tokens, with shares of the total. */
export interface TokenAttribution {
  readonly buckets: Readonly<Record<TokenBucket, number>>
  /** Metered request pressure this attribution accounts for. */
  readonly total: number
  /** Per-bucket share of `total`; sums to 1 (0 when the prompt is empty). */
  readonly shares: Readonly<Record<TokenBucket, number>>
  /** Σ per-node metered prices (the surface part of `total`). */
  readonly surfaceTokens: number
  /** Tool-schema envelope price, priced from the last logged request header. */
  readonly toolSchemaTokens: number
}

/** Fixed density heuristic, mirrored from the meter's own estimator. */
const CHARS_PER_TOKEN = 4

function densityPrice(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * The three payloads of one rendered leaf checkpoint, split by section header.
 * @returns character slices, or `null` when the text is not the expected
 *   structured leaf layout (an unrecognized checkpoint is left whole).
 */
export function splitLeafCheckpointText(
  text: string,
): { state: string; rationale: string; framing: string } | null {
  const currentIdx = text.indexOf('\nCurrent\n')
  const rationaleIdx = text.indexOf('\nRationale\n')
  const recallIdx = text.indexOf('\nRecall\n')
  if (currentIdx < 0 || rationaleIdx < 0 || recallIdx < 0) return null
  if (!(currentIdx < rationaleIdx && rationaleIdx < recallIdx)) return null
  return {
    // Preamble, `<compacted-summary>` framing, marker line, and the Recall
    // pointer are all fixed overhead — they exist to frame the handoff, not
    // to carry state or reasoning.
    framing: text.slice(0, currentIdx + 1) + text.slice(recallIdx),
    state: text.slice(currentIdx + 1, rationaleIdx),
    rationale: text.slice(rationaleIdx + 1, recallIdx),
  }
}

/** Message text of one surface node, or `null` when it projects no message. */
function nodeText(session: Session, seq: number): string | null {
  const event = session.eventAt(seq as never)
  if (event === undefined) return null
  const message: Message | null = session.deriveEventMessage(event)
  if (message === null) return null
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join(String.fromCharCode(10))
}

/** Tool name of each `tool/call`, keyed by call id, for recall identification. */
function toolNamesByCallId(session: Session): Map<string, string> {
  const names = new Map<string, string>()
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event?.type !== 'tool/call') continue
    names.set(String(event.data.callId), event.data.name)
  }
  return names
}

/** The tools schema of the latest logged request envelope. */
function latestHeader(session: Session): { tools?: unknown } | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)
    if (event?.type === 'request/header') {
      return event.data.header as { tools?: unknown }
    }
  }
  return undefined
}

const EF_RECALL_TOOLS = new Set(['context_recall', 'context_search'])

/**
 * Attribute one measured request to the docs/11 §5 buckets.
 *
 * @param session - session whose surface the measurement describes.
 * @param measurement - token-meter measurement of the CURRENT surface.
 * @returns per-bucket tokens, shares, and the reconciled total.
 * @throws when the measurement's nodes do not match the session surface — a
 *   stale measurement would silently misattribute, so it fails loud.
 */
export function attributeTokens(session: Session, measurement: TokenMeasurement): TokenAttribution {
  const nodes = session.surface.nodes
  if (nodes.length !== measurement.nodes.length
    || nodes.some((seq, index) => seq !== measurement.nodes[index]?.seq)) {
    throw new Error('token-attribution: measurement does not match the current session surface')
  }

  const buckets: Record<TokenBucket, number> = Object.fromEntries(
    TOKEN_BUCKETS.map(bucket => [bucket, 0]),
  ) as Record<TokenBucket, number>
  const names = toolNamesByCallId(session)

  for (let index = 0; index < nodes.length; index += 1) {
    const node = measurement.nodes[index]!
    const event = session.eventAt(nodes[index]!)
    const message = event === undefined ? null : session.deriveEventMessage(event)
    if (message === null) {
      buckets['unattributed-envelope'] += node.tokens
      continue
    }

    if (message.role === 'system' || message.role === 'developer') {
      buckets.system += node.tokens
      continue
    }

    const source = (message as unknown as { source?: { kind?: string } }).source
    if (source?.kind === 'compact-checkpoint') {
      const text = nodeText(session, nodes[index]!) ?? ''
      const marker = parseCheckpointMarker(text)
      if (marker === undefined) {
        // A Basic checkpoint: one opaque narrative node, no EF structure.
        buckets['checkpoint-basic'] += node.tokens
        continue
      }
      if (marker.mode !== 'leaf') {
        buckets['checkpoint-root'] += node.tokens
        continue
      }
      const split = splitLeafCheckpointText(text)
      if (split === null) {
        buckets['checkpoint-root'] += node.tokens
        continue
      }
      const stateTokens = densityPrice(split.state)
      const rationaleTokens = densityPrice(split.rationale)
      buckets['checkpoint-leaf-state'] += stateTokens
      buckets['checkpoint-leaf-rationale'] += rationaleTokens
      // Residual (role/block overhead) plus the fixed framing text.
      buckets['checkpoint-framing'] += Math.max(0, node.tokens - stateTokens - rationaleTokens)
      continue
    }

    if (message.role === 'tool') {
      const callId = (message as unknown as { toolCallId?: string }).toolCallId
      const name = callId === undefined ? undefined : names.get(String(callId))
      if (name !== undefined && EF_RECALL_TOOLS.has(name)) {
        buckets.recall += node.tokens
        continue
      }
      buckets['raw-tool-result'] += node.tokens
      continue
    }

    if (message.role === 'assistant') {
      buckets['raw-assistant'] += node.tokens
      continue
    }
    buckets['raw-user'] += node.tokens
  }

  const toolSchemaTokens = estimateToolsTokens(latestHeader(session) as never)
  buckets['tool-schema'] += toolSchemaTokens
  const surfaceTokens = measurement.surfaceTokens
  // Anything the meter charges beyond the priced surface and the tool schema
  // is the envelope's own fixed cost — reported honestly, never distributed.
  buckets['unattributed-envelope'] += Math.max(
    0,
    measurement.totalTokens - surfaceTokens - toolSchemaTokens,
  )

  const total = TOKEN_BUCKETS.reduce((sum, bucket) => sum + buckets[bucket], 0)
  const shares = Object.fromEntries(
    TOKEN_BUCKETS.map(bucket => [bucket, total === 0 ? 0 : buckets[bucket] / total]),
  ) as Record<TokenBucket, number>

  return { buckets, total, shares, surfaceTokens, toolSchemaTokens }
}

/** Attribution of one full run: per-step attributions plus bucket totals. */
export interface RunAttribution {
  readonly steps: readonly TokenAttribution[]
  /** Σ per-bucket tokens across every step (the run's total spend by source). */
  readonly totals: Readonly<Record<TokenBucket, number>>
  readonly grandTotal: number
  readonly shares: Readonly<Record<TokenBucket, number>>
}

/** Fold per-step attributions into one run-level view. */
export function summarizeAttribution(steps: readonly TokenAttribution[]): RunAttribution {
  const totals: Record<TokenBucket, number> = Object.fromEntries(
    TOKEN_BUCKETS.map(bucket => [bucket, 0]),
  ) as Record<TokenBucket, number>
  for (const step of steps) {
    for (const bucket of TOKEN_BUCKETS) totals[bucket] += step.buckets[bucket]
  }
  const grandTotal = TOKEN_BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0)
  const shares = Object.fromEntries(
    TOKEN_BUCKETS.map(bucket => [bucket, grandTotal === 0 ? 0 : totals[bucket] / grandTotal]),
  ) as Record<TokenBucket, number>
  return { steps, totals, grandTotal, shares }
}
