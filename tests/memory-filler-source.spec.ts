/**
 * The background must be REAL text, and that has to be a checked property.
 *
 * ## The defect this pins
 *
 * The first background was generated from 48 sentence templates over 12 topics. It was measured,
 * not suspected: 2,344,000 word tokens drawn from **58 distinct words**, 99.60% of a 4M-token
 * corpus. Deleting every filler line collapsed the corpus to 16,240 tokens -- 12.4% of the window,
 * far below the 50%-of-window calibration target -- so fold 1 already overshot the target and
 * depth 2+ had nothing to do. The depth axis was dead while appearing alive, and every number the
 * calibration produced would have looked like a measurement.
 *
 * A comment in the generator claimed the paragraphs "differ in their subject, their numbers and
 * their phrasing". The phrasing was byte-identical. **That is why this is a test and not a
 * comment**: a claim about the corpus that nothing executes can stay false for as long as nobody
 * looks.
 *
 * ## What is asserted
 *
 *   1. the pool is lexically diverse -- the property the generated filler lacked
 *   2. no vocabulary FIELD NAME appears, because a field name is what binds a value to a fact and
 *      so is what could create a competing answer
 *   3. no NUMERIC probed value appears
 *   4. the source-code share stays bounded, because the background must match the register of the
 *      probed facts. Background in a different register lets a summariser treat the facts as the
 *      only real content and preserve them, which inflates retention.
 *
 * @module tests/memory-filler-source
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const MEM = join(ROOT, 'eval', 'memory')

const poolPath = join(MEM, 'filler_source.txt')
const provPath = join(MEM, 'filler_source_provenance.json')
const corePath = join(MEM, 'corpus_core.json')

const canRun = existsSync(poolPath) && existsSync(provPath) && existsSync(corePath)

/** Vocabulary field names and numeric probed values, split the way the extractor splits them. */
function vocabulary() {
  const core = JSON.parse(readFileSync(corePath, 'utf8')) as {
    projects: Record<string, { values: Record<string, unknown> }[]>
  }
  const fields = new Set<string>()
  const numeric = new Set<string>()
  for (const rows of Object.values(core.projects)) {
    for (const r of rows) {
      for (const [k, v] of Object.entries(r.values)) {
        fields.add(k)
        if (Number.isFinite(Number(v))) numeric.add(String(v))
      }
    }
  }
  return { fields: [...fields], numeric: [...numeric] }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
}

describe.skipIf(!canRun)('the memory corpus background', () => {
  const pool = canRun ? readFileSync(poolPath, 'utf8') : ''
  const prov = canRun ? JSON.parse(readFileSync(provPath, 'utf8')) : {}

  it('is lexically diverse, which is the property the generated filler lacked', () => {
    const words = pool.match(/[A-Za-z][A-Za-z'-]*/g) ?? []
    const distinct = new Set(words.map(w => w.toLowerCase()))
    const ratio = distinct.size / Math.max(1, words.length)
    // The generated filler scored 0.0000247: 2,344,000 word tokens from 58 distinct words. 0.01 is
    // two orders of magnitude above that and far below real prose's ~0.05, so it fails on
    // boilerplate without pinning an implementation.
    expect(words.length, 'the pool must be substantial').toBeGreaterThan(200_000)
    expect(ratio, 'type/token ' + ratio.toFixed(5) + ' is boilerplate-like').toBeGreaterThan(0.01)
  })

  it('names no vocabulary field, so no value in it can be bound to a fact', () => {
    const { fields } = vocabulary()
    const found = fields.filter(f => new RegExp('\\b' + escapeRe(f) + '\\b', 'i').test(pool))
    expect(found, 'a field name in the background could state a competing fact').toEqual([])
  })

  it('contains no numeric probed value', () => {
    const { numeric } = vocabulary()
    const found = numeric.filter(v => new RegExp('\\b' + escapeRe(v) + '\\b').test(pool))
    expect(found, 'a background figure equal to a probed one is a second candidate').toEqual([])
  })

  it('keeps the source-code share bounded, so the register stays documentation', () => {
    // Code is adopted in small quantity by explicit guidance: it is a different register from the
    // probed facts, and a background that is mostly code lets a summariser keep the facts as the
    // only "real" content.
    expect(prov.code_share_actual).toBeLessThanOrEqual(0.15)
    expect(prov.code_share_actual).toBeGreaterThan(0)
  })

  it('records the narrowing of filler_disjoint_from_probed rather than hiding it', () => {
    // 20 of the 86 probed values are ordinary English words, because four fields are categorical.
    // Their absence from real prose is unsatisfiable, so the rule was narrowed to field names and
    // NUMERIC values. An unrecorded narrowing is indistinguishable from a dropped rule.
    expect(prov.asserted_absent?.vocabulary_field_names).toBe(true)
    expect(prov.asserted_absent?.numeric_probed_values).toBe(true)
    expect(prov.narrowed_rule?.why, 'the narrowing must say why').toBeTruthy()
    expect(prov.narrowed_rule?.categorical_values_present_in_pool).toBeDefined()
  })

  it('records where the text came from and under which licences', () => {
    expect(prov.packages, 'provenance must name its sources').toBeDefined()
    expect(Object.keys(prov.packages).length).toBeGreaterThan(1)
    expect(existsSync(join(MEM, 'filler_source_NOTICE.md')), 'the notice must exist').toBe(true)
  })
})
