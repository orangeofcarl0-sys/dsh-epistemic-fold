/**
 * RC0-E: the default-configuration regime.
 *
 * RC0 §19 asked the question and §35 made it a required stage: the live tier
 * that produced R3/R4's numbers used a 6000–8000 window with a tiny frozen
 * budget so folds and rebases would happen inside a short test. Those are
 * MECHANISM knobs. A user writing `mode: economy` gets the model's REAL window
 * and the engine's default headroom and frozen budget — and nothing else.
 *
 * RC0-C then measured the consequence: at the real defaults only 3 folds and
 * ZERO rebases occurred across three 24-turn runs, and FullTaskRBCR came out at
 * 0.972 with a CI upper bound of 1.006. So the operating regime R3/R4 measured
 * is NOT the regime a default deployment runs in.
 *
 * This suite computes the boundaries analytically from the config, so the
 * finding is exact and does not depend on a provider, and then asserts the
 * shape the numbers imply.
 */

import { describe, expect, it } from 'vitest'
import { judgeRegime, regimeBoundaries, regimeToMarkdown } from '../eval/src/default-regime.ts'
import { resolvePreset } from '../src/preset.ts'
import { resolveEfConfig } from '../src/policy.ts'

/** The routed model's real window, as the live route reports it. */
const REAL_WINDOW = 131_072
const RESERVED_OUTPUT = 512

describe('RC0-E: the shipped defaults imply a very different regime', () => {
  it('computes the fold threshold the defaults actually produce', () => {
    const boundaries = regimeBoundaries(REAL_WINDOW, RESERVED_OUTPUT, { mode: 'economy' })
    // threshold = min(window * 0.8, window - headroom - reserved)
    //           = min(104857, 131072 - 65536 - 512) = 65024
    expect(boundaries.foldThresholdTokens).toBe(65_024)
    expect(boundaries.rebaseThresholdTokens).toBe(24_000)
    console.log(regimeToMarkdown(boundaries, judgeRegime(boundaries, 30, 3_600)))
  })

  it('a session must reach ~65K tokens before ANY fold can happen', () => {
    const boundaries = regimeBoundaries(REAL_WINDOW, RESERVED_OUTPUT, { mode: 'economy' })
    // This is the number RC0 §19 was worried about: the compressed-window tests
    // folded at 5400 tokens, an order of magnitude below the default threshold.
    expect(boundaries.tokensBeforeFirstFold).toBeGreaterThan(60_000)
    expect(boundaries.tokensBeforeFirstFold).toBeGreaterThan(10 * 5_400)
  })

  it('the rebase budget needs MANY folds when checkpoints carry only a marker', () => {
    // At the real defaults a checkpoint with no declared state is a single
    // marker line (~30 tokens). Crossing a 24000-token budget therefore takes
    // hundreds of folds, each of which itself needs a full threshold of growth.
    const boundaries = regimeBoundaries(REAL_WINDOW, RESERVED_OUTPUT, { mode: 'economy' })
    const folds = boundaries.foldsToReachRebase(30)
    expect(folds).toBe(800)
    const verdict = judgeRegime(boundaries, 30, 3_600)
    expect(verdict.rebaseReachable).toBe(false)
    expect(verdict.reason).toContain('does not engage')
    console.log(`marker-only checkpoints: ${verdict.reason}`)
  })

  it('state-rich checkpoints make the rebase reachable, which is the W2 shape', () => {
    // The comparison that makes the previous test meaningful rather than
    // alarming: checkpoints carrying real machine state are far larger, so the
    // budget is crossed in a realistic number of folds. The rebase mechanism is
    // not broken — it is engaged by the state-rich shape and not by the
    // marker-only one.
    const boundaries = regimeBoundaries(REAL_WINDOW, RESERVED_OUTPUT, { mode: 'economy' })
    const folds = boundaries.foldsToReachRebase(600)
    expect(folds).toBe(40)
    const verdict = judgeRegime(boundaries, 600, 3_600)
    expect(verdict.rebaseReachable).toBe(true)
    console.log(`state-rich checkpoints: ${verdict.reason}`)
  })

  it('the economy preset does NOT set any operational knob', () => {
    // The distinction RC0 §19 draws: a preset supplies POLICY. It must not
    // quietly retune the window, headroom, or budget, because that would make
    // the measured regime a property of the preset rather than of the engine.
    const preset = resolvePreset('economy')
    expect(Object.keys(preset).sort()).toEqual(
      ['framingMode', 'leafAdmission', 'rootPolicy', 'semanticMode'],
    )
    const resolved = resolveEfConfig({ mode: 'economy' })
    // Headroom and frozen budget are the engine's defaults, untouched.
    expect(resolved.headroomTokens).toBe(65_536)
    expect(resolved.frozenCheckpointTokenBudget).toBe(24_000)
  })

  it('a COMPRESSED window is not merely different — it is UNCONFIGURABLE at defaults', () => {
    // This is the sharpest form of the RC0 §19 finding, and it is why the
    // R3/R4 live tiers had to override `headroomTokens: 0`: the engine REFUSES
    // to resolve a 6000-token window with the default 65536-token headroom,
    // because the headroom alone exceeds the window.
    //
    // So the compressed-window regime those tiers measured was not a stricter
    // version of the default regime — it was a regime reachable only by
    // switching the defaults off.
    expect(() => regimeBoundaries(6_000, RESERVED_OUTPUT, { mode: 'economy' }))
      .toThrow(/leaving no pressure budget/u)

    // And with the overrides those tiers used, the threshold lands where they
    // reported it: far below the default's 65024.
    const compressed = regimeBoundaries(6_000, RESERVED_OUTPUT, {
      mode: 'economy', headroomTokens: 0, thresholdRatio: 0.9,
    })
    const real = regimeBoundaries(REAL_WINDOW, RESERVED_OUTPUT, { mode: 'economy' })
    expect(compressed.foldThresholdTokens).toBeLessThan(6_000)
    expect(real.foldThresholdTokens).toBeGreaterThan(compressed.foldThresholdTokens * 10)
    console.log(
      `threshold: compressed (overridden) ${compressed.foldThresholdTokens} vs `
      + `real defaults ${real.foldThresholdTokens}`,
    )
  })

  it('the regime analysis is exact arithmetic, not an estimate', () => {
    // Every number here is derived from the config, so it is reproducible
    // without a provider and cannot drift with cache state.
    const boundaries = regimeBoundaries(REAL_WINDOW, RESERVED_OUTPUT, { mode: 'economy' })
    const verdict = judgeRegime(boundaries, 30, 3_600)
    const turns = verdict.turnsToRebase(3_600, 30)
    // 800 folds x (65024 / 3600) turns per fold.
    expect(Math.round(turns)).toBe(Math.round(800 * (65_024 / 3_600)))
  })
})
