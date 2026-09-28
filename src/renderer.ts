/**
 * The structured leaf-checkpoint renderer (plan §22): machine state first.
 * The checkpoint is a structured handoff — Current / Evidence / Open /
 * Rationale / Recall — where Rationale is the ONLY narrative section and the
 * state sections derive from the deterministic projection, never from the
 * summary.
 *
 * @module dsh-epistemic-fold/renderer
 */

import { stateKeyText } from './state.ts'
import type { Anchor, FoldCurrentState } from './state.ts'

function anchorLine(anchor: Anchor): string {
  const key = anchor.stateKey === undefined ? '' : ` ${stateKeyText(anchor.stateKey)}`
  const value = typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value)
  return `- [${anchor.kind}${key}] ${value} (${anchor.authority})`
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
  const lines: string[] = [`[EF leaf checkpoint ${checkpointId} · state]`, '', 'Current']

  if (state.objective !== undefined) lines.push(anchorLine(state.objective))
  const heads = Object.values(state.stateHeads)
  for (const anchor of heads) {
    if (anchor.kind === 'failure') continue
    lines.push(anchorLine(anchor))
  }
  for (const anchor of Object.values(state.constraints)) {
    if (anchor.lifecycle === 'active') lines.push(anchorLine(anchor))
  }

  lines.push('', 'Evidence')
  const evidence = Object.values(state.evidence)
  if (evidence.length === 0) lines.push('- (none)')
  for (const anchor of evidence) lines.push(anchorLine(anchor))

  lines.push('', 'Open')
  const failures = Object.values(state.openFailures)
  const obligations = Object.values(state.openObligations)
  if (failures.length === 0 && obligations.length === 0) lines.push('- (none)')
  for (const anchor of failures) {
    lines.push(`- [failure] ${anchor.id} (${anchor.failureState ?? 'open'})`)
  }
  for (const anchor of obligations) lines.push(anchorLine(anchor))

  lines.push('', 'Rationale')
  if (rationale === undefined || rationale.trim().length === 0) {
    lines.push('- (none)')
  } else {
    for (const line of rationale.trim().split('\n')) lines.push(`- ${line}`)
  }

  lines.push('', 'Recall', `- cp:${checkpointId}`)
  return lines.join('\n')
}
