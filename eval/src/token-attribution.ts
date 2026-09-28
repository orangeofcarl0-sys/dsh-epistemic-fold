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

/** Checkpoint populations on the surface, needed by the oracle arms. */
export interface CheckpointCounts {
  readonly leaf: number
  readonly root: number
  readonly basic: number
}

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
  /** How many checkpoints of each kind are on the surface. */
  readonly checkpoints: CheckpointCounts
}

/** Fixed density heuristic, mirrored from the meter's own estimator. */
const CHARS_PER_TOKEN = 4

function densityPrice(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * The three payloads of one rendered leaf checkpoint, split by section header.
 *
 * R2-D made sections OPTIONAL: a section carrying nothing is omitted entirely
 * rather than emitted as a header plus `- (none)`. The splitter therefore
 * locates whichever headers are present instead of requiring all of them.
 *
 * A checkpoint with NO state sections at all is still a perfectly valid leaf —
 * a fold with no declared anchors has no machine state to hand off — so it
 * splits with an empty state rather than being rejected. Rejecting it would
 * misclassify a legitimate leaf as a root and silently misattribute its cost.
 *
 * @returns character slices, or `null` when the text carries no Recall anchor,
 *   which means it is not a structured leaf layout at all.
 */
export function splitLeafCheckpointText(
  text: string,
): { state: string; rationale: string; framing: string } | null {
  const recallIdx = text.indexOf('\nRecall\n')
  if (recallIdx < 0) return null
  const rationaleIdx = text.indexOf('\nRationale\n')

  // The state region runs from the first state header (if any) to Rationale,
  // or to Recall when there is no Rationale.
  const stateStart = ['\nCurrent\n', '\nEvidence\n', '\nOpen\n']
    .map(header => text.indexOf(header))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0]
  const stateEnd = rationaleIdx >= 0 ? rationaleIdx : recallIdx

  const hasState = stateStart !== undefined && stateStart < stateEnd
  // Framing is everything before the state/rationale/recall body: the marker
  // line, the preamble, and the wrapper tags.
  const framingEnd = hasState ? stateStart + 1 : stateEnd

  return {
    framing: text.slice(0, framingEnd) + text.slice(recallIdx),
    state: hasState ? text.slice(stateStart + 1, stateEnd) : '',
    rationale: rationaleIdx >= 0 ? text.slice(rationaleIdx + 1, recallIdx) : '',
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
  const checkpoints: { leaf: number; root: number; basic: number } = { leaf: 0, root: 0, basic: 0 }
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
        checkpoints.basic += 1
        buckets['checkpoint-basic'] += node.tokens
        continue
      }
      if (marker.mode !== 'leaf') {
        checkpoints.root += 1
        buckets['checkpoint-root'] += node.tokens
        continue
      }
      const split = splitLeafCheckpointText(text)
      if (split === null) {
        checkpoints.root += 1
        buckets['checkpoint-root'] += node.tokens
        continue
      }
      checkpoints.leaf += 1
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

  return { buckets, total, shares, surfaceTokens, toolSchemaTokens, checkpoints }
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
