/**
 * R36-E: the evaluation API must keep the operator's selection semantics.
 *
 * R35's selector filtered the dataset in dataset order, so `--cases F1,A1`
 * actually ran A1 first. That silently invalidated interleaving, randomised
 * order, budget-censoring studies, and any comparison that depends on which
 * case is attempted first. It also dropped unknown ids, so a typo looked like a
 * complete run.
 *
 * @module tests/r36-eval-api
 */

import { describe, expect, it } from 'vitest'
import { selectCases } from '../eval/r33/src/selection.mjs'

const CASES = [
  { id: 'A1' },
  { id: 'B2' },
  { id: 'F1' },
  { id: 'H1' },
]

describe('R36-E1: selectCases preserves request order', () => {
  it('returns the requested order, not the dataset order', () => {
    expect(selectCases(CASES, 'F1,A1').map(entry => entry.id)).toEqual(['F1', 'A1'])
    expect(selectCases(CASES, 'H1,B2,A1').map(entry => entry.id)).toEqual(['H1', 'B2', 'A1'])
  })

  it('returns the dataset when no selection is requested', () => {
    expect(selectCases(CASES, undefined).map(entry => entry.id)).toEqual(['A1', 'B2', 'F1', 'H1'])
    expect(selectCases(CASES, '').map(entry => entry.id)).toEqual(['A1', 'B2', 'F1', 'H1'])
  })

  it('refuses an unknown case instead of silently ignoring it', () => {
    expect(() => selectCases(CASES, 'F1,ZZ')).toThrow(/unknown case id "ZZ"/u)
    expect(() => selectCases(CASES, 'ZZ')).toThrow(/available cases: A1, B2, F1, H1/u)
  })

  it('refuses a duplicate case instead of silently running it once', () => {
    expect(() => selectCases(CASES, 'F1,F1')).toThrow(/duplicate case id "F1"/u)
  })
})
