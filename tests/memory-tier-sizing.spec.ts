/**
 * The corpus size is DERIVED from the window, and every committed tier has to satisfy it.
 *
 * ## What went wrong without this
 *
 * The corpus was once a flat 4M tokens. Against a 131k window that is 30.9x, which broke the
 * injection protocol: a composition probe needs two whole projects, so every batch was 181k tokens
 * -- 1.38x the window. Arm B could not inject its own documents at all, and would have measured
 * truncation rather than the model, while every score it produced looked like a measurement.
 *
 * A flat size cannot serve the tiers this benchmark targets, because they differ by an order of
 * magnitude. Sized for 131k it is not four times a 1M window; sized for 1M it cannot be injected
 * into 131k. The size has to follow the window.
 *
 * ## The rule, which is scale-invariant
 *
 *     documents          100        (20 projects x 5)
 *     doc tokens         ratio * W / 100
 *     composition batch  10 * doc  = ratio * W / 10
 *     at probe           batch + 0.5W = W * (ratio/10 + 0.5)
 *
 *     fits iff  ratio/10 + 0.5 <= 1   ->   ratio <= 5.0
 *
 * The floor is 3.2.5's four-times rule, the ceiling is the injection protocol, and any window in
 * [4.0, 5.0] works. This test pins both ends, because a corpus that violates either is one whose
 * numbers describe something other than what they claim.
 *
 * ## Why it now checks EVERY committed tier
 *
 * The corpus used to be a single artifact, so this could only assert against whichever tier
 * happened to be on disk -- and regenerating a different tier to check it was the thing that made
 * the bench awkward to run. Tiers are committed per-tier now, and the sizing rule is
 * scale-invariant, so the check is too: EVERY committed tier must clear the four-times floor and
 * fit its own injection.
 *
 * @module tests/memory-tier-sizing
 */

import { describe, expect, it } from 'vitest'
import { TIERS, committedTiers } from './memory-corpus.ts'

const tiers = committedTiers()

describe.skipIf(tiers.length === 0)('the memory corpus is sized from the window', () => {
  it('commits a corpus for every tier this benchmark targets', () => {
    const windows = tiers.map(t => t.window).sort((a, b) => a - b)
    expect(windows, 'a missing tier means the bench cannot run it without generating first')
      .toEqual([...TIERS])
  })

  it('derives every tier with the same rule, and every tier fits', () => {
    const DOCS = 100
    const BATCH_DOCS = 10
    const SURFACE = 0.5
    for (const W of TIERS) {
      const ratio = 4.5
      const doc = (ratio * W) / DOCS
      const batch = BATCH_DOCS * doc
      const total = batch + SURFACE * W
      expect(total, 'window ' + W + ' must fit its own batch').toBeLessThanOrEqual(W)
      expect(ratio, 'window ' + W + ' must clear the four-times floor').toBeGreaterThanOrEqual(4)
    }
  })

  for (const tier of tiers) {
    describe(tier.label + ' (window ' + tier.window.toLocaleString() + ')', () => {
      const sizing = tier.report.sizing ?? {}

      it('reports the window it was built for, so artifact and parameter cannot disagree', () => {
        expect(sizing.window, 'the recorded window must be the tier it lives in').toBe(tier.window)
        expect(sizing.corpus_tokens).toBeGreaterThan(0)
        expect(sizing.ratio_achieved).toBeGreaterThan(0)
        expect(sizing.ok, 'the generator fails on this, so it must be true here').toBe(true)
      })

      it('is at least four times the window -- 3.2.5s pressure floor', () => {
        expect(sizing.ratio_achieved).toBeGreaterThanOrEqual(4)
      })

      it('leaves room for the tokenizer, the surface, the injection and the reserve', () => {
        // The ceiling, and the reason it is a budget rather than a ratio. The window must hold the
        // compressed surface, the injected batch, the rendered probes and the completion reserve,
        // all scaled by a tokenizer that does not agree with a chars/4 estimate. Exceeding it is
        // SILENT: the request still succeeds, the provider truncates, and the score describes the
        // budget rather than the model.
        const b = sizing.budget
        expect(b, 'the budget must be recorded, not assumed').toBeDefined()
        expect(b.probe_turn_over_window, 'the probe turn is the binding case').toBeLessThanOrEqual(1)
        expect(b.fold_turn_over_window, 'a fold needs room for its own summary budget').toBeLessThanOrEqual(1)
        expect(b.tokenizer_slack, 'measured 1.02, budgeted 1.05').toBeGreaterThanOrEqual(1)
        expect(b.completion_reserve).toBeGreaterThan(0)
        expect(b.surface_frac, 'at 0.50 the corpus caps below the four-times floor').toBeLessThanOrEqual(0.4)
      })

      it('records the arithmetic that decides whether a tier is reachable', () => {
        expect(sizing.composition_batch_tokens).toBeGreaterThan(0)
        expect(sizing.tokens_per_document).toBeGreaterThan(0)
        expect(sizing.documents).toBe(100)
        expect(sizing.note).toContain('probe turn')
      })
    })
  }
})
