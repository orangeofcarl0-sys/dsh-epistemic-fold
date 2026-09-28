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
 * @param state - the deterministic current state at fold time.
 * @param checkpointId - the fold's checkpoint identity.
 * @param rationale - semantic digest text; advisory only, never state.
 * @returns the structured checkpoint body (unframed).
 */
export function renderStructuredCheckpoint(
  state: FoldCurrentState,
  checkpointId: string,
  rationale?: string,
): string {
  const presentation = projectForCheckpoint(state)
  const lines: string[] = [encodeCheckpointMarker({ checkpointId, mode: 'leaf' }), '', 'Current']

  if (presentation.current.length === 0) lines.push('- (none)')
  for (const anchor of presentation.current) {
    if (anchor.kind === 'objective') {
      lines.push(anchorLine(anchor))
      continue
    }
    lines.push(anchorLine(anchor))
  }

  lines.push('', 'Evidence')
  if (presentation.evidence.length === 0) lines.push('- (none)')
  for (const anchor of presentation.evidence) lines.push(anchorLine(anchor))

  lines.push('', 'Open')
  if (presentation.open.length === 0) {
    lines.push('- (none)')
  }
  for (const anchor of presentation.open) {
    if (anchor.kind === 'failure') {
      lines.push(failureLine(anchor))
      continue
    }
    lines.push(anchorLine(anchor))
  }

  lines.push('', 'Rationale')
  if (rationale === undefined || rationale.trim().length === 0) {
    lines.push('- (none)')
  } else {
    for (const line of rationale.trim().split('\n')) lines.push(`- ${line}`)
  }

  lines.push('', 'Recall', `- cp:${checkpointId}`)
  return lines.join('\n')
}
