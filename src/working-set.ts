/**
 * The Thermal Working-Set Observer's measurement half: decompose the current
 * context into the three parts that need different responses, and estimate what
 * each fold mechanism could ACTUALLY reclaim.
 *
 * ## The defect this exists for
 *
 * `pressureBreakdown` splits pressure into `frozen` and `open`. That split is
 * correct and it is not sufficient, because `openTokens` is not the foldable
 * prefix — it is *everything a leaf fold could touch if the selector agreed to
 * touch it*, and the selector frequently does not. The RC28 investigation found
 * the LHTB shape where it never does:
 *
 *     surface after one fold:  [ checkpoint 116 | 12 | tool-result 60008 ]
 *     selectLeafSpan(retain 5120) -> null
 *     selectLeafSpan(retain 0)    -> null
 *
 * 60120 of 60136 tokens are open, and **zero** of them are foldable. A report
 * that read `openTokens` as "available to fold" would conclude the opposite of
 * the truth, which is exactly the misreading RC28 §0.1 had to correct.
 *
 * ## The decomposition, and why these three
 *
 *     totalTokens
 *       = frozenCheckpointTokens     the frozen EF checkpoints' own cost
 *       + legalLeafSpanTokens        the span selectLeafSpan() will actually take
 *       + residualTokens             everything else
 *
 * All three are in the SAME measurement basis (the token meter's node prices),
 * and they are disjoint and exhaustive by construction: the residual is computed
 * as the remainder, so the identity holds by arithmetic rather than by
 * convention, and a test asserts it.
 *
 * `residualTokens` is deliberately NOT called "hot data". It is the retained
 * verbatim tail, plus nodes no legal span may cover (an oversized last node, a
 * span boundary that would split a tool pair), plus any non-surface envelope
 * cost the meter carries. Those are different things and lumping them under a
 * thermal name would repeat the mistake this module exists to fix.
 *
 * ## Measured, estimated, unknown — stated per field
 *
 * A reclaim figure is a PREDICTION: it depends on the size of the checkpoint a
 * fold would leave behind, which does not exist yet. So every reclaim field
 * carries its basis, and `unknown` is a legal value that is never rendered as
 * zero. The decomposition fields are `measured` because they read the current
 * surface and nothing else.
 *
 * ## What a Root can actually reclaim
 *
 * Estimated from the CURRENT legal root range (`selectCompactableRange`, retain
 * 0) — never from "all frozen checkpoints disappear", which is the arithmetic
 * that makes an early rebase look free. A root rebase collapses the leading span
 * to exactly ONE checkpoint, so:
 *
 *     rootReclaim = rootSpanTokens - postRebaseCheckpointTokens
 *
 * The surviving checkpoint's size is estimated by rendering the CURRENT
 * deterministic state through the same renderer a real fold uses, when the
 * caller can supply both a state and a text estimator. When it cannot, the
 * observed per-checkpoint average is used and labelled as such; when there is no
 * frozen checkpoint to average and no state to render, the answer is `unknown`.
 *
 * @module dsh-epistemic-fold/working-set
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { selectCompactableRange } from './basic/region.ts'
import { FRAMING_FALLBACK_TOKENS, assessFoldReachability } from './fold-economics.ts'
import { selectLeafSpan } from './leaf-policy.ts'
import { pressureBreakdown } from './pressure.ts'
import { renderStructuredCheckpoint } from './renderer.ts'
import type { FoldCurrentState } from './state.ts'

/**
 * How a reclaim figure was obtained.
 *
 * `rendered-state` — the surviving checkpoint's body was rendered from the
 * current deterministic state and priced with the caller's estimator. The
 * strongest basis available, and still an estimate: the body is real, the fold
 * has not happened.
 * `observed-average` — the frozen prefix's own mean checkpoint cost. Measured
 * from real checkpoints, applied to a hypothetical one.
 * `framing-fallback` — no checkpoint exists yet, so the measured framing
 * constant is used. A first checkpoint is dominated by its preamble.
 * `unknown` — no basis exists. The figure is absent rather than zero.
 */
export type ReclaimBasis = 'rendered-state' | 'observed-average' | 'framing-fallback' | 'unknown'

/** How each field of a decomposition was obtained. */
export interface WorkingSetBasis {
  /** Always measured: read from the current surface's node prices. */
  readonly frozenCheckpointTokens: 'measured'
  /** Always measured: read from the current surface's node prices. */
  readonly legalLeafSpanTokens: 'measured'
  /** Always derived: the remainder of the same measurement. */
  readonly residualTokens: 'derived'
  readonly estimatedLeafReclaimTokens: 'estimated' | 'unknown'
  readonly estimatedRootReclaimTokens: 'estimated' | 'unknown'
  readonly leafReclaimBasis: ReclaimBasis
  readonly rootReclaimBasis: ReclaimBasis
}

/**
 * The current context decomposed by what would actually fix it.
 *
 * The three size fields are disjoint and sum to `totalTokens` — that identity is
 * the contract, and it is what lets a reader see at a glance whether the
 * pressure is held by frozen checkpoints, by foldable history, or by something
 * neither mechanism can touch.
 */
export interface WorkingSetPressure {
  readonly totalTokens: number
  /** The frozen EF checkpoints' own recurring cost. Measured. */
  readonly frozenCheckpointTokens: number
  /** The span `selectLeafSpan` will take at the caller's retention. Measured. */
  readonly legalLeafSpanTokens: number
  /**
   * Everything the other two do not account for: the retained verbatim tail,
   * nodes no legal span may cover, and non-surface envelope cost.
   */
  readonly residualTokens: number
  readonly frozenCheckpointCount: number
  /** The widest span ANY leaf fold could take (retain 0) — an upper bound. */
  readonly widestLeafSpanTokens: number
  /**
   * Tokens the leading range a rebase would replace currently occupies.
   * `undefined` when no legal root range exists.
   */
  readonly rootSpanTokens?: number
  /**
   * `legalLeafSpanTokens - postFoldCheckpointTokens`. Signed: a negative value
   * means the fold would make the context LARGER.
   */
  readonly estimatedLeafReclaimTokens?: number
  /**
   * `rootSpanTokens - postRebaseCheckpointTokens`. Signed, and `undefined` when
   * the surviving checkpoint cannot be priced — never fabricated as 0.
   */
  readonly estimatedRootReclaimTokens?: number
  /** Whether some leaf fold could bring the surface under the threshold. */
  readonly leafReachable: boolean
  /**
   * Whether a rebase could bring the surface under the threshold. `undefined`
   * when `estimatedRootReclaimTokens` is unknown, because the answer is then
   * genuinely unavailable rather than false.
   */
  readonly rootReachable?: boolean
  /** Why an action is unavailable, in the terms of the arithmetic above. */
  readonly blockers: readonly string[]
  readonly basis: WorkingSetBasis
  readonly retainTokens: number
  readonly thresholdTokens: number
}

/** Options for {@link assessWorkingSet}. */
export interface AssessWorkingSetOptions {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly thresholdTokens: number
  /** The retention the caller's own selector will use. */
  readonly retainTokens: number
  /**
   * The current deterministic state, when the projection is mounted. Supplying
   * it upgrades the checkpoint estimate from an observed average to a rendered
   * body — the difference between "checkpoints here average N" and "the
   * checkpoint this fold would write is N".
   */
  readonly state?: FoldCurrentState
  /**
   * Prices one rendered checkpoint body. Supplied by the caller because the
   * estimator lives on the token meter, which is a context service; passing it
   * in is what keeps this module pure.
   */
  readonly estimateText?: (text: string) => number
}

/**
 * A fixed, well-formed checkpoint id for pricing a HYPOTHETICAL checkpoint.
 *
 * The marker line is part of the body and therefore part of the price, so the
 * estimate must include one. The id is constant so two estimates of the same
 * state are comparable; nothing ever persists it.
 */
const ESTIMATE_CHECKPOINT_ID = '00000000-0000-4000-8000-000000000000'

/** Sum the priced tokens of one inclusive node span. */
function spanTokens(measurement: TokenMeasurement, startIdx: number, endIdx: number): number {
  return measurement.nodes
    .slice(startIdx, endIdx + 1)
    .reduce((total, node) => total + node.tokens, 0)
}

/**
 * Price the checkpoint a fold would leave behind, and say how.
 *
 * ## Why the two kinds are priced differently
 *
 * A leaf and a rebase leave behind different things, and using one's evidence
 * for the other is a category error that flatters the rebase:
 *
 *  - A **leaf** checkpoint condenses a bounded span, so the frozen prefix's own
 *    mean checkpoint cost is a legitimate predictor — it is literally made of
 *    checkpoints of that kind. With no prefix yet, the measured framing constant
 *    is used, because a first checkpoint is dominated by its preamble.
 *  - A **rebase** checkpoint condenses the ENTIRE leading range, so it is not a
 *    leaf checkpoint and the leaf average does not predict it. Neither does the
 *    framing constant, which prices a nearly empty first checkpoint. With no
 *    rendered state there is no honest basis, so the answer is `unknown` — and
 *    `unknown` must not be silently replaced by a small number, because that
 *    would overstate the reclaim and make an early rebase look free.
 *
 * The order is otherwise by strength of evidence: a rendered body beats an
 * observed average, which beats the framing constant.
 */
function priceSurvivingCheckpoint(options: {
  readonly kind: 'leaf' | 'root'
  readonly breakdown: ReturnType<typeof pressureBreakdown>
  readonly state?: FoldCurrentState
  readonly estimateText?: (text: string) => number
}): { readonly tokens?: number; readonly basis: ReclaimBasis } {
  const { kind, breakdown, state, estimateText } = options
  if (state !== undefined && estimateText !== undefined) {
    const rendered = renderStructuredCheckpoint(state, ESTIMATE_CHECKPOINT_ID)
    const tokens = estimateText(rendered)
    if (Number.isFinite(tokens) && tokens > 0) {
      return { tokens, basis: 'rendered-state' }
    }
  }
  if (kind === 'root') {
    // No state to render: a rebase checkpoint's size is genuinely unestablished.
    return { basis: 'unknown' }
  }
  if (breakdown.frozenCount > 0) {
    return {
      tokens: breakdown.frozenTokens / breakdown.frozenCount,
      basis: 'observed-average',
    }
  }
  return { tokens: FRAMING_FALLBACK_TOKENS, basis: 'framing-fallback' }
}

/**
 * Decompose the current working set and estimate each mechanism's real reclaim.
 *
 * @param options - session, matching measurement, the thresholds in force, and
 *   optionally the deterministic state plus a text estimator.
 * @returns the decomposition, both reclaim estimates with their basis, and the
 *   blockers that explain any unavailable action.
 * @throws when the measurement does not match the session surface, which
 *   `pressureBreakdown` already refuses — a stale measurement would attribute
 *   pressure to the wrong part.
 */
export function assessWorkingSet(options: AssessWorkingSetOptions): WorkingSetPressure {
  const { session, measurement, thresholdTokens, retainTokens, state, estimateText } = options
  const breakdown = pressureBreakdown(session, measurement, thresholdTokens)

  // --- Measured: the frozen prefix, and the span a leaf would really take.
  //
  // The frozen load comes from `pressureBreakdown` rather than a second call to
  // `frozenCheckpointLoad`: that function is what the breakdown already ran, and
  // calling it twice would be two chances to disagree about the same prefix.
  const frozenCheckpointTokens = breakdown.frozenTokens
  const legal = selectLeafSpan(session, measurement, retainTokens)
  const widest = selectLeafSpan(session, measurement, 0)
  const legalLeafSpanTokens = legal === null
    ? 0
    : spanTokens(measurement, legal.startIdx, legal.endIdx)
  const widestLeafSpanTokens = widest === null
    ? 0
    : spanTokens(measurement, widest.startIdx, widest.endIdx)

  // --- Derived: the remainder. Computed, not asserted, so the identity holds.
  //
  // The clamp is against the OPEN portion rather than the total, because the
  // legal span lives inside the open trajectory by construction (it never starts
  // before the frontier). Clamping against the total would silently absorb a
  // frontier bug into the residual, where nobody would look for it.
  const openTokens = Math.max(0, breakdown.totalTokens - frozenCheckpointTokens)
  const boundedLeafSpan = Math.min(legalLeafSpanTokens, openTokens)
  const residualTokens = openTokens - boundedLeafSpan

  const blockers: string[] = []

  // --- Estimated: what a leaf would reclaim.
  //
  // The reclaim is `span - surviving checkpoint`, computed from the SAME priced
  // checkpoint reported above, so the number and its stated basis cannot
  // disagree. (Reusing `leafMarginalReclaim` here would have re-derived the
  // checkpoint internally and silently ignored the better estimate — the
  // reclaim and its basis would then describe two different checkpoints.)
  const surviving = priceSurvivingCheckpoint({
    kind: 'leaf',
    breakdown,
    ...(state === undefined ? {} : { state }),
    ...(estimateText === undefined ? {} : { estimateText }),
  })
  let estimatedLeafReclaimTokens: number | undefined
  let leafReclaimBasis: ReclaimBasis = 'unknown'
  if (legal === null) {
    blockers.push(
      widest === null
        ? 'no structurally legal span exists past the frontier, so no leaf fold can be taken'
        : `no span reaches past the frontier at retain ${retainTokens}; the widest span `
          + `(retain 0) is ${widestLeafSpanTokens} tokens`,
    )
  } else if (surviving.tokens === undefined) {
    blockers.push('the checkpoint a leaf would leave behind cannot be priced')
  } else {
    estimatedLeafReclaimTokens = legalLeafSpanTokens - surviving.tokens
    leafReclaimBasis = surviving.basis
  }

  // --- Estimated: what a rebase would reclaim, from the CURRENT legal root
  // range. Never "all frozen checkpoints vanish" — a rebase leaves one behind.
  const rootRange = selectCompactableRange(session, measurement, 0)
  let rootSpanTokens: number | undefined
  let estimatedRootReclaimTokens: number | undefined
  let rootReclaimBasis: ReclaimBasis = 'unknown'
  if (rootRange === null) {
    blockers.push('no compactable range exists for a rebase')
  } else {
    const startIdx = measurement.nodes.findIndex(node => node.seq === rootRange.start)
    const endIdx = measurement.nodes.findIndex(node => node.seq === rootRange.end)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      blockers.push('the rebase range is not present in the current measurement')
    } else {
      rootSpanTokens = spanTokens(measurement, startIdx, endIdx)
      // Priced as a ROOT checkpoint, which is what a rebase leaves: see
      // `priceSurvivingCheckpoint` for why the leaf average must not be reused.
      const rootSurviving = priceSurvivingCheckpoint({
        kind: 'root',
        breakdown,
        ...(state === undefined ? {} : { state }),
        ...(estimateText === undefined ? {} : { estimateText }),
      })
      rootReclaimBasis = rootSurviving.basis
      if (rootSurviving.tokens === undefined) {
        blockers.push(
          'the checkpoint a rebase would leave behind cannot be priced: it condenses the whole '
          + `leading range (${rootSpanTokens} tokens), so neither the leaf-checkpoint average nor `
          + 'the framing constant predicts it, and no deterministic state was available to render',
        )
      } else {
        estimatedRootReclaimTokens = rootSpanTokens - rootSurviving.tokens
        if (estimatedRootReclaimTokens <= 0) {
          blockers.push(
            `a rebase would reclaim ${estimatedRootReclaimTokens.toFixed(0)} tokens `
            + `(leading range ${rootSpanTokens} vs the checkpoint it leaves, `
            + `${rootSurviving.tokens.toFixed(0)}); it would not shrink the context`,
          )
        }
      }
    }
  }

  // --- Reachability, reusing the engine's own guard so the observer's verdict
  // and the engine's cannot drift apart.
  const reach = assessFoldReachability({
    session,
    measurement,
    thresholdTokens,
    retainTokens,
  })
  if (!reach.canReachThreshold) {
    blockers.push(
      `no fold can reach the threshold: the widest legal span is ${reach.spanTokens} tokens and `
      + `${reach.retainedTokens.toFixed(0)} would remain against a threshold of ${thresholdTokens}`,
    )
  }
  const rootReachable = estimatedRootReclaimTokens === undefined
    ? undefined
    : breakdown.totalTokens - estimatedRootReclaimTokens < thresholdTokens

  return {
    totalTokens: breakdown.totalTokens,
    frozenCheckpointTokens,
    legalLeafSpanTokens: boundedLeafSpan,
    residualTokens,
    frozenCheckpointCount: breakdown.frozenCount,
    widestLeafSpanTokens,
    ...(rootSpanTokens === undefined ? {} : { rootSpanTokens }),
    ...(estimatedLeafReclaimTokens === undefined ? {} : { estimatedLeafReclaimTokens }),
    ...(estimatedRootReclaimTokens === undefined ? {} : { estimatedRootReclaimTokens }),
    leafReachable: reach.canReachThreshold,
    ...(rootReachable === undefined ? {} : { rootReachable }),
    blockers,
    basis: {
      frozenCheckpointTokens: 'measured',
      legalLeafSpanTokens: 'measured',
      residualTokens: 'derived',
      estimatedLeafReclaimTokens: estimatedLeafReclaimTokens === undefined ? 'unknown' : 'estimated',
      estimatedRootReclaimTokens: estimatedRootReclaimTokens === undefined ? 'unknown' : 'estimated',
      leafReclaimBasis,
      rootReclaimBasis,
    },
    retainTokens,
    thresholdTokens,
  }
}

/**
 * Render one decomposition as a single line, so a report can carry the numbers
 * and their provenance without re-deriving either.
 */
export function describeWorkingSet(pressure: WorkingSetPressure): string {
  const parts = [
    `total ${pressure.totalTokens}`,
    `frozen ${pressure.frozenCheckpointTokens} (${pressure.frozenCheckpointCount} checkpoint(s))`,
    `legal leaf span ${pressure.legalLeafSpanTokens}`,
    `residual ${pressure.residualTokens}`,
  ]
  parts.push(
    pressure.estimatedLeafReclaimTokens === undefined
      ? 'leaf reclaim unknown'
      : `leaf reclaim ${pressure.estimatedLeafReclaimTokens.toFixed(0)} [${pressure.basis.leafReclaimBasis}]`,
  )
  parts.push(
    pressure.estimatedRootReclaimTokens === undefined
      ? 'root reclaim unknown'
      : `root reclaim ${pressure.estimatedRootReclaimTokens.toFixed(0)} [${pressure.basis.rootReclaimBasis}]`,
  )
  parts.push(`threshold ${pressure.thresholdTokens}, retain ${pressure.retainTokens}`)
  return parts.join('; ')
}
