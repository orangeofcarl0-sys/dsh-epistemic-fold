/**
 * The structured leaf-checkpoint renderer (plan §22): machine state first.
 * The checkpoint is a structured handoff — Current / Evidence / Open /
 * Rationale / Recall — where Rationale is the ONLY narrative section and the
 * state sections derive from the deterministic projection, never from the
 * summary.
 *
 * @module dsh-epistemic-fold/renderer
 */

import { encodeCheckpointMarker } from './checkpoint-marker.ts'
import { canonicalHash } from './hash.ts'
import { stateKeyText } from './state.ts'
import type { Anchor, FoldCurrentState } from './state.ts'

function anchorLine(anchor: Anchor): string {
  const key = anchor.stateKey === undefined ? '' : ` ${stateKeyText(anchor.stateKey)}`
  const value = typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value)
  return `- [${anchor.kind}${key}] ${value} (${anchor.authority})`
}

/**
 * One open-failure line. The failure's DESCRIPTION matters as much as its
 * lifecycle: rendering only `[failure] <id> (open)` tells the model that
 * something is unresolved but not WHAT, which is useless for continuation and
 * was observed to produce a wrong answer on the live behavioral subset. The
 * id stays (recall and oracles key on it) alongside the value.
 */
function failureLine(anchor: Anchor): string {
  const value = typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value)
  const state = anchor.failureState ?? 'open'
  return value === undefined || value === '{}'
    ? `- [failure] ${anchor.id} (${state})`
    : `- [failure] ${anchor.id} (${state}): ${value}`
}

/**
 * The disjoint checkpoint presentation (R0-A): every anchor appears in
 * EXACTLY ONE section, deduplicated by id, so the model never sees the same
 * fact listed twice under different headings.
 */
export interface CheckpointPresentation {
  /** Objective + active constraints + active heads (excluding failures). */
  readonly current: Anchor[]
  /** Evidence anchors only. */
  readonly evidence: Anchor[]
  /** Open failures and obligations only. */
  readonly open: Anchor[]
}

export function projectForCheckpoint(state: FoldCurrentState): CheckpointPresentation {
  const seen = new Set<string>()
  const current: Anchor[] = []
  const evidence: Anchor[] = []
  const open: Anchor[] = []
  const take = (anchor: Anchor | undefined): void => {
    if (anchor === undefined || seen.has(anchor.id)) return
    seen.add(anchor.id)
    current.push(anchor)
  }
  take(state.objective)
  for (const anchor of Object.values(state.stateHeads)) {
    if (anchor.lifecycle !== 'active' || anchor.kind === 'failure') continue
    take(anchor)
  }
  for (const anchor of Object.values(state.constraints)) {
    if (anchor.lifecycle === 'active') take(anchor)
  }
  for (const anchor of Object.values(state.evidence)) {
    if (seen.has(anchor.id)) continue
    seen.add(anchor.id)
    evidence.push(anchor)
  }
  for (const anchor of Object.values(state.openFailures)) {
    if (seen.has(anchor.id)) continue
    seen.add(anchor.id)
    open.push(anchor)
  }
  for (const anchor of Object.values(state.openObligations)) {
    if (seen.has(anchor.id)) continue
    seen.add(anchor.id)
    open.push(anchor)
  }
  return { current, evidence, open }
}

/**
 * Render the machine-state handoff for one checkpoint.
 *
 * **Surface diet (R2-D).** A section that carries nothing is omitted entirely
 * — header and placeholder both. The earlier format emitted all five sections
 * unconditionally, so a checkpoint with no evidence, no open items and no
 * rationale still spent tokens announcing that it had none. The measured
 * framing cost is the single largest component of a leaf checkpoint, and most
 * of it is this kind of fixed boilerplate repeated once per fold.
 *
 * **Single-ID affordance (R3-A).** The trailing `Recall` section is GONE. The
 * marker line already carries `cp:<id>`, which is exactly the reference
 * `context_recall` takes, so writing it a second time under a `Recall` heading
 * told the model nothing the marker had not. The affordance is preserved in
 * full — the recall tool's own description defines what `cp:` means and is
 * registered once per request rather than once per checkpoint.
 *
 * What is never omitted: the marker line, which is simultaneously checkpoint
 * identity and the recall pointer. Omitting it would trade correctness for
 * tokens, which is exactly the trade R2 forbids.
 *
 * @param state - the deterministic current state at fold time.
 * @param checkpointId - the fold's checkpoint identity.
 * @param rationale - semantic digest text; advisory only, never state.
 * @returns the structured checkpoint body (unframed).
 */
/**
 * Describe the state a rendered checkpoint body was projected from.
 *
 * The digest is what makes a checkpoint's displayed state CHECKABLE: a reader
 * re-derives the state from the session log, hashes it the same way, and
 * compares. Without it, a rendering or reducer defect shows the model a state
 * snapshot that no longer matches the log and nothing can tell — the shape the
 * memory literature calls ghost memory / governance decay.
 *
 * `anchors` counts the entries the body actually presents, giving a reader a
 * cheap structural comparison alongside the cryptographic one: a digest
 * mismatch with an equal count points at a changed value, an unequal count at a
 * lost or duplicated anchor.
 *
 * @param state - the deterministic current state at fold time.
 * @returns the digest and the visible anchor count.
 */
export function describeRenderedState(state: FoldCurrentState): {
  readonly digest: string
  readonly anchors: number
} {
  const presentation = projectForCheckpoint(state)
  return {
    digest: canonicalHash(state),
    anchors: presentation.current.length + presentation.evidence.length + presentation.open.length,
  }
}

export function renderStructuredCheckpoint(
  state: FoldCurrentState,
  checkpointId: string,
  rationale?: string,
): string {
  const presentation = projectForCheckpoint(state)
  const lines: string[] = [encodeCheckpointMarker({ checkpointId, mode: 'leaf' })]

  if (presentation.current.length > 0) {
    lines.push('', 'Current')
    for (const anchor of presentation.current) lines.push(anchorLine(anchor))
  }

  if (presentation.evidence.length > 0) {
    lines.push('', 'Evidence')
    for (const anchor of presentation.evidence) lines.push(anchorLine(anchor))
  }

  if (presentation.open.length > 0) {
    lines.push('', 'Open')
    for (const anchor of presentation.open) {
      lines.push(anchor.kind === 'failure' ? failureLine(anchor) : anchorLine(anchor))
    }
  }

  // Rationale is advisory; when there is none, the section is not emitted and
  // its absence is not announced. A reader that finds no Rationale heading
  // learns exactly what `- (none)` would have told it, for zero tokens.
  const rationaleText = rationale?.trim() ?? ''
  if (rationaleText.length > 0) {
    lines.push('', 'Rationale')
    for (const line of rationaleText.split('\n')) lines.push(`- ${line}`)
  }

  return lines.join('\n')
}
