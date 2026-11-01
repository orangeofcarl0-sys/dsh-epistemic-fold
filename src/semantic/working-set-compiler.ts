/**
 * The Working-Set Compiler: turn the whole deterministic state into the
 * bounded, prioritized slice a model must actually see to keep working.
 *
 * ## The problem, stated as measurement
 *
 * Every leaf checkpoint used to render the entire current state. With N folds,
 * the surface carried N copies of the same table, and the older copies asserted
 * values that later folds had already replaced. That is both a token problem
 * (the "166 anchors re-rendered on every fold" shape) and a correctness problem
 * (a superseded value presented next to its replacement is ghost memory).
 *
 * ## What replaces it
 *
 * Two sections with different jobs, rendered by `renderer.ts`:
 *
 *   Changed in this fold     provenance-scoped: only anchors whose source
 *                            events lie in the folded span. Unique per fold.
 *   State from earlier folds the still-effective state this fold did not touch,
 *                            BUDGETED. Never silently dropped.
 *
 * This module owns the second half. Its rules:
 *
 *  1. **Pinned state is never dropped.** A user constraint that does not fit
 *     the budget is still rendered, and the overflow is REPORTED. Trimming a
 *     hard constraint to save tokens is the failure mode this whole layer
 *     exists to prevent, so correctness wins and the size claim is retracted
 *     explicitly (`overflow: true`) rather than the constraint being lost.
 *  2. **Working state is budgeted.** Decisions and findings are useful but
 *     replaceable by a retrieval pointer, so they are added until the budget is
 *     reached and the remainder becomes a count plus an affordance.
 *  3. **Residency is not validity.** Nothing here retires or supersedes
 *     anything. An item that does not fit is still `active`; it is simply not
 *     rendered inline. The distinction is what stops a budget from becoming an
 *     accidental deletion policy.
 *
 * ## Why an injected estimator
 *
 * Token pricing lives on the context's token meter, and this module is kept
 * pure so it can be tested without one. The engine passes the meter's
 * estimator; a caller without one gets the documented byte-based fallback,
 * which is labelled in the result rather than passed off as a measurement.
 *
 * @module dsh-epistemic-fold/semantic/working-set-compiler
 */

import type { Anchor, FoldCurrentState } from '../state/state.ts'
import {
  renderAnchorLine,
  renderFailureLine,
  renderTemporalSections,
} from '../checkpoint/renderer.ts'
import type { FoldMode } from '../types.ts'
import type { SemanticResidency } from './types.ts'

/** Where the token figure came from. */
export type WorkingSetEstimateBasis = 'token-meter' | 'chars-per-4'

/** The compiled, bounded working set. */
export interface CompiledWorkingSet {
  /** The rendered body, without the checkpoint marker. Empty when nothing is shown. */
  readonly text: string
  /** Estimated tokens of `text`, excluding the checkpoint marker. */
  readonly tokens: number
  /** Estimated tokens of the pinned section alone. */
  readonly pinnedTokens: number
  readonly budgetTokens: number
  /**
   * `true` when PINNED state alone exceeds the budget. The body still contains
   * it; the flag is the honesty requirement, not a truncation signal.
   */
  readonly overflow: boolean
  readonly pinned: readonly Anchor[]
  readonly working: readonly Anchor[]
  /** Items that were effective but did not fit; retrievable, not deleted. */
  readonly omitted: readonly Anchor[]
  readonly estimateBasis: WorkingSetEstimateBasis
}

/** Options for {@link compileWorkingSet}. */
export interface CompileWorkingSetOptions {
  readonly state: FoldCurrentState
  /**
   * Anchor ids already rendered in the fold's delta section. Excluded here so
   * one fact never appears twice in one checkpoint — the disjoint-presentation
   * rule the structured renderer already enforces.
   */
  readonly exclude?: ReadonlySet<string>
  /**
   * Token budget for the state section. 512-2048 is the range this project
   * intends to measure; 1024 is the default because it fits the measured
   * framing cost with room for a dozen constraints, and it is a PARAMETER, not
   * a finding.
   */
  readonly budgetTokens?: number
  /** Prices one string. Defaults to a labelled chars-per-4 approximation. */
  readonly estimate?: (text: string) => number
}

/** Default budget: the middle of the range this round intends to test. */
export const DEFAULT_WORKING_SET_TOKENS = 1024

/**
 * Default budget for the WHOLE checkpoint, not only carried state.
 *
 * The working-set budget answers "how much earlier state may I repeat". It does
 * not bound the changed delta, the rationale, or the marker/framing, so a fold
 * could satisfy `WorkingSet.overflow === false` while the complete body was
 * twice this size. This is the second, honest ceiling.
 */
export const DEFAULT_CHECKPOINT_TOKENS = 4096

/**
 * Fallback pricer: four characters per token.
 *
 * Deliberately conservative for English prose and optimistic for code, which is
 * why the result records `estimateBasis`. A caller that cares passes the token
 * meter's own estimator; this exists so the compiler is usable (and testable)
 * without a mounted meter.
 */
function charsPerFour(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Kind order inside the pinned section: contracts first, then outstanding work. */
const PINNED_ORDER: Readonly<Record<string, number>> = {
  objective: 0,
  constraint: 1,
  obligation: 2,
  failure: 3,
}

/**
 * Whether an anchor still constrains what may happen next.
 *
 * Mirrors `thermal.ts`'s rule (objective / constraint / obligation, plus an
 * unresolved failure) but is stated here independently because the two answer
 * different questions: thermal asks "is this being worked with", the compiler
 * asks "must this be visible". A fact can be both, neither, or either.
 */
function isPinned(anchor: Anchor): boolean {
  if (anchor.lifecycle !== 'active') return false
  if (anchor.kind === 'objective' || anchor.kind === 'constraint' || anchor.kind === 'obligation') {
    return true
  }
  return anchor.kind === 'failure'
    && (anchor.failureState === 'open' || anchor.failureState === 'investigating')
}

/**
 * Which residency class an anchor falls into for THIS fold.
 *
 * The `SemanticResidency` axis, implemented rather than merely declared: a
 * still-binding contract is `pinned`, an effective but droppable fact is
 * `working`, and anything that has left hot state is `archived`. Residency is
 * a compilation decision — it never changes lifecycle, and nothing here retires
 * anything.
 *
 * @param anchor - one anchor from the deterministic state.
 * @returns its residency class.
 */
export function residencyOf(anchor: Anchor): SemanticResidency {
  if (isPinned(anchor)) return 'pinned'
  return anchor.lifecycle === 'active' ? 'working' : 'archived'
}

/** Most recent provenance position, for ordering the working section. */
function recency(anchor: Anchor): number {
  let latest = -1
  for (const ref of anchor.sourceRefs) {
    const seq = ref.seq as unknown as number
    if (seq > latest) latest = seq
  }
  return latest
}

/** Every distinct anchor the state holds, deduplicated by id. */
function anchorsOf(state: FoldCurrentState): readonly Anchor[] {
  const byId = new Map<string, Anchor>()
  if (state.objective !== undefined) byId.set(state.objective.id, state.objective)
  for (const face of [
    state.constraints,
    state.openObligations,
    state.openFailures,
    state.decisions,
    state.evidence,
    state.stateHeads,
  ]) {
    for (const anchor of Object.values(face)) {
      if (anchor.lifecycle !== 'active') continue
      // A later face cannot contradict an earlier one for an ACTIVE anchor:
      // the same object is indexed in each. First writer wins, so the more
      // specific faces above take precedence over the generic heads index.
      if (!byId.has(anchor.id)) byId.set(anchor.id, anchor)
    }
  }
  return [...byId.values()]
}

/**
 * Compile the bounded working set for one checkpoint.
 *
 * @param options - the state, what the delta section already shows, and a budget.
 * @returns the rendered section, its size, and what did not fit.
 */
export function compileWorkingSet(options: CompileWorkingSetOptions): CompiledWorkingSet {
  const estimate = options.estimate ?? charsPerFour
  const basis: WorkingSetEstimateBasis = options.estimate === undefined ? 'chars-per-4' : 'token-meter'
  const budget = options.budgetTokens ?? DEFAULT_WORKING_SET_TOKENS
  const exclude = options.exclude ?? new Set<string>()

  const considered = anchorsOf(options.state).filter(anchor => !exclude.has(anchor.id))
  const byResidency = (wanted: SemanticResidency): Anchor[] =>
    considered.filter(anchor => residencyOf(anchor) === wanted)
  const pinned = byResidency('pinned')
    .sort((left, right) =>
      (PINNED_ORDER[left.kind] ?? 9) - (PINNED_ORDER[right.kind] ?? 9)
      || left.id.localeCompare(right.id))
  const working = byResidency('working')
    .sort((left, right) => recency(right) - recency(left) || left.id.localeCompare(right.id))

  const lineOf = (anchor: Anchor): string =>
    anchor.kind === 'failure' ? renderFailureLine(anchor) : renderAnchorLine(anchor)

  // --- Pinned: all of it, or an explicit overflow.
  const pinnedLines = pinned.map(lineOf)
  const pinnedText = section('Pinned (still in force)', pinnedLines)
  const pinnedTokens = pinnedText.length === 0 ? 0 : estimate(pinnedText)
  let tokens = pinnedTokens
  const overflow = pinnedLines.length > 0 && tokens > budget

  // --- Working: fill the BUDGET, newest first. Nothing is dropped silently:
  // whatever does not fit is counted in the `Not shown` line below.
  //
  // When pinned state alone already overflows, no working item is added. The
  // checkpoint is over budget at that point, and growing it further would make
  // the size claim worse without improving what the model can act on — the
  // pinned contracts and the fold's own changes are the minimum viable handoff.
  const workingLines: string[] = []
  const separator = estimate('\n\n')
  if (!overflow) {
    for (const anchor of working) {
      const line = lineOf(anchor)
      const candidate = section('Working', [...workingLines, line])
      if (tokens + separator + estimate(candidate) > budget) break
      workingLines.push(line)
    }
  }
  const shownWorking = working.slice(0, workingLines.length)
  const omitted = working.slice(workingLines.length)

  const parts: string[] = []
  if (pinnedText.length > 0) parts.push(pinnedText)
  if (workingLines.length > 0) parts.push(section('Working', workingLines))
  if (omitted.length > 0) {
    parts.push([
      'Not shown',
      `- ${omitted.length} more effective item(s) did not fit this checkpoint's budget; `
      + 'use context_search with a keyword to retrieve them',
    ].join('\n'))
  }
  if (overflow) {
    parts.push(
      `- working-set-overflow: pinned state is ${tokens} tokens against a ${budget}-token budget; `
      + 'it is shown in full because it is still in force',
    )
  }
  const text = parts.join('\n\n')
  return {
    text,
    tokens: text.length === 0 ? 0 : estimate(text),
    pinnedTokens,
    budgetTokens: budget,
    overflow,
    pinned,
    working: shownWorking,
    omitted,
    estimateBasis: basis,
  }
}

/** The whole-checkpoint accounting: every section, not only carried state. */
export interface CheckpointCapacity {
  readonly changedTokens: number
  readonly carriedTokens: number
  readonly rationaleTokens: number
  readonly framingTokens: number
  readonly noticeTokens: number
  /** Measured on the complete body; not the sum of the components. */
  readonly totalCheckpointTokens: number
  readonly pinnedTokens: number
  readonly budgetTokens: number
  readonly totalBudgetTokens: number
  /** Pinned state alone exceeds the WORKING-SET budget; it is still shown in full. */
  readonly pinnedOverflow: boolean
  /** The complete body exceeds the whole-checkpoint budget. */
  readonly totalOverflow: boolean
  readonly estimateBasis: WorkingSetEstimateBasis
}

/** Options for {@link measureCheckpointCapacity}. */
export interface MeasureCheckpointOptions {
  readonly checkpointId: string
  readonly mode: FoldMode
  readonly changed: readonly Anchor[]
  readonly workingSetText: string
  readonly rationale?: string
  readonly notice?: string
  readonly workingSet: CompiledWorkingSet
  readonly totalBudgetTokens?: number
  /** Prices one string; the same estimator the working set used. */
  readonly estimate?: (text: string) => number
}

/**
 * Price the COMPLETE checkpoint, using the renderer's own section strings.
 *
 * The components are priced separately for diagnosis and the total is measured
 * on the joined body, because tokenizers are not additive across separators.
 *
 * @param options - the exact sections and the budgets they are compared to.
 * @returns the capacity report; never truncates anything.
 */
export function measureCheckpointCapacity(options: MeasureCheckpointOptions): CheckpointCapacity {
  const estimate = options.estimate ?? charsPerFour
  const basis: WorkingSetEstimateBasis = options.estimate === undefined
    ? options.workingSet.estimateBasis
    : 'token-meter'
  const sections = renderTemporalSections({
    checkpointId: options.checkpointId,
    mode: options.mode,
    changed: options.changed,
    workingSetText: options.workingSetText,
    ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    ...(options.notice === undefined ? {} : { notice: options.notice }),
  })
  const price = (text: string): number => text.length === 0 ? 0 : estimate(text)
  const full = [sections.marker, sections.notice, sections.changed, sections.carried, sections.rationale]
    .filter(section => section.length > 0)
    .join('\n\n')
  const totalBudget = options.totalBudgetTokens ?? DEFAULT_CHECKPOINT_TOKENS
  const totalCheckpointTokens = price(full)
  return {
    changedTokens: price(sections.changed),
    carriedTokens: price(sections.carried),
    rationaleTokens: price(sections.rationale),
    framingTokens: price(sections.marker),
    noticeTokens: price(sections.notice),
    totalCheckpointTokens,
    pinnedTokens: options.workingSet.pinnedTokens,
    budgetTokens: options.workingSet.budgetTokens,
    totalBudgetTokens: totalBudget,
    pinnedOverflow: options.workingSet.overflow,
    totalOverflow: totalCheckpointTokens > totalBudget,
    estimateBasis: basis,
  }
}

/** One-line description for telemetry; counts, never content. */
export function describeCheckpointCapacity(capacity: CheckpointCapacity): string {
  return `checkpoint ${capacity.totalCheckpointTokens}/${capacity.totalBudgetTokens} tokens `
    + `[${capacity.estimateBasis}] changed=${capacity.changedTokens} carried=${capacity.carriedTokens} `
    + `rationale=${capacity.rationaleTokens} framing=${capacity.framingTokens} `
    + `notice=${capacity.noticeTokens}`
    + (capacity.pinnedOverflow ? ' PINNED-OVERFLOW' : '')
    + (capacity.totalOverflow ? ' TOTAL-OVERFLOW' : '')
}

/** Render one titled section; an empty list yields an empty string. */
function section(title: string, lines: readonly string[]): string {
  return lines.length === 0 ? '' : [title, ...lines].join('\n')
}

/**
 * One-line description for telemetry. Counts, sizes and the basis — never
 * content, so a log line cannot leak a user's constraint.
 *
 * @param set - a compiled working set.
 * @returns the log line body.
 */
export function describeWorkingSetCompilation(set: CompiledWorkingSet): string {
  return `pinned ${set.pinned.length}, working ${set.working.length}, omitted ${set.omitted.length}, `
    + `${set.tokens}/${set.budgetTokens} tokens [${set.estimateBasis}]`
    + (set.overflow ? ', OVERFLOW' : '')
}
