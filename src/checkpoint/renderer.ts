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
import { stateKeyText } from '../state/state.ts'
import type { Anchor, FoldCurrentState } from '../state/state.ts'
import type { FoldMode } from '../types.ts'

/**
 * Collapse a value to one line before interpolation.
 *
 * A state line is a runtime-authored fact: `- [kind id key] value (authority)`.
 * A value containing a newline could emit additional lines with that exact
 * shape, so a model-written statement (or a tool output promoted into a user
 * anchor) could forge the appearance of a different anchor. Collapsing
 * whitespace is the renderer's half of that guard; `semantic/validate.ts` has
 * the other half on the semantic path.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

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
 */
function anchorLine(anchor: Anchor): string {
  const key = anchor.stateKey === undefined ? '' : ` ${stateKeyText(anchor.stateKey)}`
  const value = oneLine(typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value))
  return `- [${anchor.kind} ${anchor.id}${key}] ${value} (${anchor.authority})`
}

/**
 * One open-failure line. The failure's DESCRIPTION matters as much as its
 * lifecycle: rendering only `[failure] <id> (open)` tells the model that
 * something is unresolved but not WHAT, which is useless for continuation and
 * was observed to produce a wrong answer on the live behavioral subset. The
 * id stays (recall and oracles key on it) alongside the value.
 */
function failureLine(anchor: Anchor): string {
  const value = oneLine(typeof anchor.value === 'string' ? anchor.value : JSON.stringify(anchor.value))
  const state = anchor.failureState ?? 'open'
  return value === undefined || value === '{}'
    ? `- [failure] ${anchor.id} (${state})`
    : `- [failure] ${anchor.id} (${state}): ${value}`
}

/** Exported for the working-set compiler, which renders the same lines. */
export function renderAnchorLine(anchor: Anchor): string {
  return anchorLine(anchor)
}

/** Exported for the working-set compiler, which renders the same lines. */
export function renderFailureLine(anchor: Anchor): string {
  return failureLine(anchor)
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

/**
 * How many anchors the machine sections will carry, without rendering them.
 *
 * The rationale's instruction depends on this: with anchors it cites them by id, and with
 * none it is the sole carrier of the facts. Counted through `projectForCheckpoint` so the
 * number cannot disagree with what actually renders.
 */
export function machineAnchorCount(state: FoldCurrentState | undefined): number {
  if (state === undefined) return 0
  const p = projectForCheckpoint(state)
  return p.current.length + p.evidence.length + p.open.length
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
  mode: FoldMode = 'leaf',
): string {
  const presentation = projectForCheckpoint(state)
  const lines: string[] = [encodeCheckpointMarker({ checkpointId, mode })]

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

/** One temporal checkpoint's inputs. */
export interface SemanticCheckpointInput {
  readonly checkpointId: string
  /** Which fold produced this body; the marker's mode code comes from it. */
  readonly mode: FoldMode
  /** Anchors whose source events lie inside THIS fold's span. */
  readonly changed: readonly Anchor[]
  /** The compiled, bounded carried state; empty when nothing is carried. */
  readonly workingSetText: string
  readonly rationale?: string
  /**
   * A visible degradation statement (blocked continuity, over-budget
   * checkpoint). Rendered near the top so it cannot be mistaken for narrative.
   */
  readonly notice?: string
}

/** The exact section strings of a temporal checkpoint, for capacity accounting. */
export interface TemporalSections {
  readonly marker: string
  readonly notice: string
  readonly changed: string
  readonly carried: string
  readonly rationale: string
}

/**
 * Build a temporal checkpoint's sections without joining them.
 *
 * Capacity accounting prices these exact strings, so the reported components
 * cannot drift from what actually lands on the surface.
 *
 * @param input - the fold's identity, changed anchors, carried state, rationale.
 * @returns one string per section; an absent section is the empty string.
 */
export function renderTemporalSections(input: SemanticCheckpointInput): TemporalSections {
  const marker = encodeCheckpointMarker({ checkpointId: input.checkpointId, mode: input.mode })

  const noticeText = input.notice?.trim() ?? ''
  const notice = noticeText.length === 0
    ? ''
    : ['Semantic status', ...noticeText.split('\n').map(line => `- ${line}`)].join('\n')

  const changed = input.changed.length === 0
    ? ''
    : [
        'Changed in this fold',
        ...input.changed.map(anchor =>
          anchor.kind === 'failure' ? renderFailureLine(anchor) : renderAnchorLine(anchor)),
      ].join('\n')

  const carriedText = input.workingSetText.trim()
  // The heading is the temporal contract. It rides on every checkpoint, so it
  // survives the `legacy` framing mode where no system section exists to say
  // it once.
  const carried = carriedText.length === 0
    ? ''
    : ['State from earlier folds (later checkpoints supersede it)', carriedText].join('\n')

  const rationaleText = input.rationale?.trim() ?? ''
  const rationale = rationaleText.length === 0
    ? ''
    : ['Rationale', ...rationaleText.split('\n').map(line => `- ${line}`)].join('\n')

  return { marker, notice, changed, carried, rationale }
}

/**
 * Render a checkpoint whose state sections are TEMPORAL.
 *
 * ## The defect this shape fixes
 *
 * The original structured body had a `Current` section that rendered the whole
 * current state. With N folds the surface carried N copies of the same table:
 * tokens grew with the NUMBER OF FOLDS rather than with the number of facts,
 * and every older copy asserted values that later folds had replaced. A model
 * reading a frozen checkpoint from ten folds ago sees `timeout = 30` presented
 * with the same authority marker as today's `timeout = 45`.
 *
 * ## The two sections, and why they are different
 *
 * `Changed in this fold` is provenance-scoped: an anchor appears only when its
 * source events lie inside the span this checkpoint replaces. That set is
 * disjoint per fold, so repeating it across the chain duplicates nothing.
 *
 * `State from earlier folds` is the bounded working set: the still-effective
 * facts this fold did not touch. The heading states the temporal rule on every
 * checkpoint, which matters under `legacy` framing where there is no system
 * section to say it once.
 *
 * @param input - the fold's identity, changed anchors, carried state, rationale.
 * @returns the unframed checkpoint body.
 */
export function renderTemporalCheckpoint(input: SemanticCheckpointInput): string {
  const sections = renderTemporalSections(input)
  return [sections.marker, sections.notice, sections.changed, sections.carried, sections.rationale]
    .filter(section => section.length > 0)
    .join('\n\n')
}
