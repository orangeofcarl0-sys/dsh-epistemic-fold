/**
 * What the RC29 thermal observer says about THIS bench's state.
 *
 * The observer was ported from `rc29-working-set-observer` (PR #4) to answer one question before
 * anything is merged or run: now that the memory bench actually populates the deterministic
 * state (166 coordinates, docs/140 G), does the residency classification have anything to
 * classify?
 *
 * The answer matters because the bench's coordinates are all `constraint` + `normative`, and
 * RC29 pins exactly that combination. If every coordinate is pinned, temperature has no work to
 * do on this workload -- and the demotable content is the prose digest, which is not an anchor at
 * all.
 *
 * @module tests/thermal-residency
 */

import { describe, expect, it } from 'vitest'
import { assessThermalResidency, residencyCounts } from '../src/state/thermal.ts'
import type { Anchor, FoldCurrentState } from '../src/state/state.ts'

function anchor(index: number, overrides: Partial<Anchor> = {}): Anchor {
  return {
    id: `anchor-${index}`,
    kind: 'constraint',
    stateKey: { namespace: 'memory', entity: 'project', property: `fact-${index}` },
    value: index,
    authority: 'normative',
    lifecycle: 'active',
    sourceRefs: [{ seq: (index + 2) as never }],
    ...overrides,
  } as Anchor
}

function state(anchors: readonly Anchor[]): FoldCurrentState {
  const constraints: Record<string, Anchor> = {}
  for (const entry of anchors) constraints[`memory/project/${entry.id}`] = entry
  return {
    constraints, stateHeads: {}, openFailures: {}, openObligations: {},
    decisions: {}, evidence: {}, retiredCount: 0, superseded: {},
  } as never
}

/** A session whose surface holds the events the anchors cite. */
function session(surfaceSeqs: readonly number[], events: number) {
  return {
    id: 'session-under-test',
    seq: events,
    eventAt: () => ({ type: 'user/message' }),
    surface: { nodes: surfaceSeqs },
  } as never
}

describe('the RC29 observer on the memory bench', () => {
  it('pins every coordinate, because the bench declares constraints with normative authority', () => {
    // 166 coordinates is what the extractor actually declares (docs/140 G). All of them are
    // `constraint` kind with `normative` authority, which is precisely the combination RC29
    // refuses to demote: a constraint that has not been mentioned recently is in the normal state
    // of a constraint.
    const anchors = Array.from({ length: 166 }, (_, i) => anchor(i))
    const report = assessThermalResidency({
      session: session([], 400),
      state: state(anchors),
      leafSpan: { startIdx: 0, endIdx: 10 },
    })
    const counts = residencyCounts(report)
    expect(counts.pinned).toBe(166)
    expect(counts.warm).toBe(0)
    expect(counts.cold).toBe(0)
    expect(counts.unknown).toBe(0)
  })

  it('has classes to offer once the kind and authority are NOT the pinned ones', () => {
    // `evidence` with empirical authority is not pinned, so the observer can place it by demand:
    // inside the current legal leaf span is `hot`; active but outside it is `warm`; and an
    // explicit lifecycle operation is the only route to `cold`.
    // anchor(1) would cite seq 3; the span below covers surface position 0, which is seq 2.
    const hot = anchor(1, { kind: 'evidence', authority: 'empirical', sourceRefs: [{ seq: 2 as never }] })
    const warm = anchor(2, { kind: 'evidence', authority: 'empirical' })
    const cold = anchor(3, { kind: 'evidence', authority: 'empirical', lifecycle: 'retired' })
    const report = assessThermalResidency({
      session: session([2, 3, 4], 400),
      state: state([hot, warm, cold]),
      // The span covers surface POSITIONS 0..0, i.e. only seq 2 -- anchor 1's source.
      leafSpan: { startIdx: 0, endIdx: 0 },
    })
    const byId = Object.fromEntries(report.verdicts.map(v => [v.anchorId, v.residency]))
    expect(byId['anchor-1']).toBe('hot')
    expect(byId['anchor-2']).toBe('warm')
    expect(byId['anchor-3']).toBe('cold')
  })

  it('says unknown, never cold, for an anchor whose source is not on the surface', () => {
    // The module's central discipline: a state it cannot see is not a state it may demote.
    const orphan = anchor(9, { kind: 'evidence', authority: 'empirical' })
    const report = assessThermalResidency({
      session: session([], 400),
      state: state([orphan]),
    })
    expect(report.verdicts[0]?.residency).toBe('unknown')
    expect(report.unknownCount).toBe(1)
  })

  it('reports nothing rather than an empty reading when no state is mounted', () => {
    const report = assessThermalResidency({ session: session([], 10) })
    expect(report.unavailable).toBe('no-state-mounted')
    expect(report.verdicts).toHaveLength(0)
  })
})