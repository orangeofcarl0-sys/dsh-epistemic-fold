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
import type { FoldMode } from './types.ts'

/**
 * One state line: `- [<kind> <id> <stateKey>] <value> (<authority>)`.
 *
 * The ID is carried so the model can NAME an anchor it wants acted on — the
 * same reason `failureLine` has always carried one, where recall and the
 * evaluation oracles key on it. Before this, only failures were addressable: a
 * model that wanted to revise or retire a constraint could describe it but not
 * refer to it, so "confirm this change" had nothing to point at.
 *
 * The bracket order is kind → id → stateKey. The kind stays first so the line
 * still reads as a classification at a glance, and the stateKey stays last
 * before the closing bracket because it is the human-readable coordinate.
 *
 * `splitLeafCheckpointText` splits on SECTION headers (`\nCurrent\n`), never on
 * bracket content, so this format is not a parsing contract — which is what
 * lets the id be added without a reader change.
 *
 * Exported because the semantic working-set compiler renders the same lines:
 * two renderers for one anchor would drift, and the checkpoint would then show
 * two formats for the same kind of fact.
 */
export function renderAnchorLine(anchor: Anchor): string {
  const key = anchor.stateKey === undefined ? '' : ` ${stateKeyText(anchor.stateKey)}`
  const value = typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value)
  // ONE line, always. The validator already collapses whitespace in semantic
  // statements, but this renderer also serves anchors declared by other callers
  // — and a value containing a newline would otherwise emit a line shaped like
  // a runtime anchor, including the trailing authority marker.
  return `- [${anchor.kind} ${anchor.id}${key}] ${oneLine(value)} (${anchor.authority})`
}

/**
 * One open-failure line. The failure's DESCRIPTION matters as much as its
 * lifecycle: rendering only `[failure] <id> (open)` tells the model that
 * something is unresolved but not WHAT, which is useless for continuation and
 * was observed to produce a wrong answer on the live behavioral subset. The
 * id stays (recall and oracles key on it) alongside the value.
 */
export function renderFailureLine(anchor: Anchor): string {
  const value = typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value)
  const state = anchor.failureState ?? 'open'
  return value === undefined || value === '{}'
    ? `- [failure] ${anchor.id} (${state})`
    : `- [failure] ${anchor.id} (${state}): ${oneLine(value)}`
}

/** Collapse a rendered value to a single line. */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
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
export function describeRenderedState(
  state: FoldCurrentState,
  presentedAnchors?: number,
): {
  readonly digest: string
  readonly anchors: number
} {
  const presentation = projectForCheckpoint(state)
  return {
    digest: canonicalHash(state),
    // A temporal body renders a CAPPED, BUDGETED subset, so the count must be
    // what the body shows rather than what the state holds — otherwise the
    // documented "equal content, equal count" comparison is wrong for exactly
    // the folds that dropped something on purpose.
    anchors: presentedAnchors
      ?? presentation.current.length + presentation.evidence.length + presentation.open.length,
  }
}

export function renderStructuredCheckpoint(
  state: FoldCurrentState,
  checkpointId: string,
  rationale?: string,
  mode: FoldMode = 'leaf',
): string {
  const presentation = projectForCheckpoint(state)
  const lines: string[] = [encodeCheckpointMarker({ checkpointId, mode })]

  if (presentation.current.length > 0) {
    lines.push('', 'Current')
    for (const anchor of presentation.current) lines.push(renderAnchorLine(anchor))
  }

  if (presentation.evidence.length > 0) {
    lines.push('', 'Evidence')
    for (const anchor of presentation.evidence) lines.push(renderAnchorLine(anchor))
  }

  if (presentation.open.length > 0) {
    lines.push('', 'Open')
    for (const anchor of presentation.open) {
      lines.push(anchor.kind === 'failure' ? renderFailureLine(anchor) : renderAnchorLine(anchor))
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

/**
 * What one semantic checkpoint body is rendered from.
 *
 * The three inputs are deliberately separate: `changed` is provenance-scoped to
 * the fold, `workingSet` is the budgeted carried state, and `rationale` is the
 * only narrative. Collapsing them (for example, passing the whole state as
 * `changed`) would recreate the every-fold-repeats-everything defect this shape
 * exists to remove.
 */
export interface SemanticCheckpointInput {
  readonly checkpointId: string
  /** Which fold produced this body; the marker's mode code comes from it. */
  readonly mode: FoldMode
  /** Anchors whose source events lie inside THIS fold's span. */
  readonly changed: readonly Anchor[]
  /** The compiled, bounded carried state; empty when nothing is carried. */
  readonly workingSetText: string
  readonly rationale?: string
}

/**
 * Render a checkpoint whose state sections are TEMPORAL.
 *
 * ## The defect this shape fixes
 *
 * The original structured body had a `Current` section that rendered the whole
 * state at fold time. Frozen checkpoints are never rewritten, so after several
 * folds the surface held several sections titled `Current` — each asserting a
 * different value, with nothing saying which one won. Measured: after two folds
 * the older checkpoint still said "never commit to main" while the newer said
 * "work on the semantic-continuity branch", both under `Current`.
 *
 * ## The shape here
 *
 *   Changed in this fold                      provenance-scoped, unique per fold
 *   State from earlier folds (superseded…)    effective, budgeted, explicitly dated
 *   Rationale                                 advisory prose
 *
 * `Changed in this fold` makes a claim about the SPAN, not about today: it says
 * "this is what that fold established", which stays true forever. The carried
 * section states its own temporality in its heading, so an older checkpoint
 * cannot be misread as current even though it is never rewritten. A later
 * checkpoint's `Changed` section is the authority for a coordinate it touches.
 *
 * @param input - the fold's changes, the carried state, and the handoff.
 * @returns the checkpoint body, unframed.
 */
export function renderTemporalCheckpoint(input: SemanticCheckpointInput): string {
  const lines: string[] = [encodeCheckpointMarker({ checkpointId: input.checkpointId, mode: input.mode })]

  if (input.changed.length > 0) {
    lines.push('', 'Changed in this fold')
    for (const anchor of input.changed) {
      lines.push(anchor.kind === 'failure' ? renderFailureLine(anchor) : renderAnchorLine(anchor))
    }
  }

  const carried = input.workingSetText.trim()
  if (carried.length > 0) {
    // The heading is the temporal contract. It rides on every checkpoint, so it
    // survives the `legacy` framing mode where no system section exists to say
    // it once.
    lines.push('', 'State from earlier folds (later checkpoints supersede it)', carried)
  }

  const rationale = input.rationale?.trim() ?? ''
  if (rationale.length > 0) {
    lines.push('', 'Rationale')
    for (const line of rationale.split('\n')) lines.push(`- ${line}`)
  }

  return lines.join('\n')
}
