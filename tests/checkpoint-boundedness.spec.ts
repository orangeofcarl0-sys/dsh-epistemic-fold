/**
 * Why semantic merge can bound what the prose digest cannot.
 *
 * Measured 2026-10-27: a memory-bench session holds ZERO coordinates -- `constraints`,
 * `stateHeads`, `evidence`, `superseded` and the rest are all empty before ingest, after ingest,
 * and after a fold, with the projection mounted. The corpus never issues `ef/anchor`, so the
 * deterministic state has nothing in it and the checkpoint carries only model prose. Prose
 * accumulates: measured +310 tokens of checkpoint per fold on the free model and +1,024 on the
 * paid route at 252K.
 *
 * EF's merge substrate is that state, and its bound is BY COORDINATE: one entry per state key,
 * the displaced value kept in `superseded`, and `projectForCheckpoint` taking only ACTIVE
 * entries. That is a property of a pure function, so it is proved here rather than measured by
 * sampling a score.
 *
 * @module tests/checkpoint-boundedness
 */

import { describe, expect, it } from 'vitest'
import { renderStructuredCheckpoint } from '../src/checkpoint/renderer.ts'
import type { Anchor, FoldCurrentState } from '../src/state/state.ts'

const ID = '11111111-2222-3333-4444-555555555555'

function anchor(index: number, revision: number): Anchor {
  return {
    id: `anchor-${index}`,
    kind: 'constraint',
    stateKey: { namespace: 'memory', entity: 'project', property: `fact-${index}` },
    value: `value-${revision}`,
    authority: 'normative',
    lifecycle: 'active',
    sourceRefs: [{ seq: 1 }],
  } as never
}

/** A state holding `coordinates` live coordinates, each at `revision` of its history. */
function stateWith(coordinates: number, revision: number): FoldCurrentState {
  const constraints: Record<string, Anchor> = {}
  const superseded: Record<string, Anchor> = {}
  for (let i = 0; i < coordinates; i += 1) {
    constraints[`memory/project/fact-${i}`] = anchor(i, revision)
    // The displaced value EF keeps for traceability. It is bounded by coordinate, so a state
    // with a long revision history has the SAME number of entries as one with none.
    if (revision > 0) superseded[`memory/project/fact-${i}`] = anchor(i, revision - 1)
  }
  return {
    constraints, stateHeads: {}, openFailures: {}, openObligations: {},
    decisions: {}, evidence: {}, retiredCount: revision * coordinates, superseded,
  } as never
}

describe('a structured checkpoint is bounded by coordinate', () => {
  it('does not grow when the SAME coordinates are revised many times', () => {
    // This is the property the prose digest lacks. Fifty revisions of forty coordinates is two
    // thousand historical facts; the checkpoint must still describe forty.
    const once = renderStructuredCheckpoint(stateWith(40, 0), ID)
    const many = renderStructuredCheckpoint(stateWith(40, 50), ID)
    expect(Math.abs(many.length - once.length)).toBeLessThan(100)
    // And the revision count really did move: retiredCount is 2,000 in the second state.
    expect((stateWith(40, 50) as { retiredCount: number }).retiredCount).toBe(2000)
  })

  it('does grow with the number of COORDINATES, because that is what it encodes', () => {
    const forty = renderStructuredCheckpoint(stateWith(40, 0), ID)
    const eighty = renderStructuredCheckpoint(stateWith(80, 0), ID)
    expect(eighty.length).toBeGreaterThan(forty.length + 500)
  })

  it('renders only ACTIVE entries, so a displaced value never reaches the prompt', () => {
    // ghost memory: showing the old value beside its replacement is what `superseded` exists to
    // keep out of the model's view while remaining recoverable from the log.
    const text = renderStructuredCheckpoint(stateWith(5, 50), ID)
    // The live value is revision 50; revision 49 is the one sitting in `superseded`.
    expect(text).toContain('value-50')
    expect(text).not.toContain('value-49')
  })
})