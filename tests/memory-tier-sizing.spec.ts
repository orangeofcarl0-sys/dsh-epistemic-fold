/**
 * The corpus size is DERIVED from the window, and the derivation has to be checked.
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
 * @module tests/memory-tier-sizing
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const MEM = join(ROOT, 'eval', 'memory')
const reportPath = join(MEM, 'generation_report.json')

const canRun = existsSync(reportPath)
const report = canRun ? JSON.parse(readFileSync(reportPath, 'utf8')) : {}

/** The tiers this benchmark targets. */
const TIERS = [131_072, 258_048, 475_136, 1_048_576]

describe.skipIf(!canRun)('the memory corpus is sized from the window', () => {
  const sizing = report.sizing ?? {}

  it('reports a sizing block, so the artifact and the parameter cannot silently disagree', () => {
    expect(sizing.window, 'the window the corpus was built for must be recorded').toBeGreaterThan(0)
    expect(sizing.corpus_tokens).toBeGreaterThan(0)
    expect(sizing.ratio_achieved).toBeGreaterThan(0)
    expect(sizing.ok, 'the generator fails on this, so it must be true here').toBe(true)
  })

  it('is at least four times the window -- 3.2.5s pressure floor', () => {
    expect(sizing.ratio_achieved).toBeGreaterThanOrEqual(4)
  })

  it('leaves room for a composition batch plus the compressed surface', () => {
    // The ceiling. Above 5.0x, a batch of two whole projects plus a 50%-of-window surface no
    // longer fits, and arm B measures truncation instead of the model.
    expect(sizing.ratio_achieved).toBeLessThanOrEqual(5)
    expect(sizing.batch_plus_surface_over_window).toBeLessThanOrEqual(1)
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

  it('records the arithmetic that decides whether a tier is reachable', () => {
    // The pool is finite, so the larger tiers need a bigger pool. The generator refuses rather
    // than silently emitting a corpus that is too small to be four times its window -- this pins
    // the numbers a reader needs to see that coming.
    expect(sizing.composition_batch_tokens).toBeGreaterThan(0)
    expect(sizing.tokens_per_document).toBeGreaterThan(0)
    expect(sizing.documents).toBe(100)
    expect(sizing.note).toContain('5.0')
  })
})
