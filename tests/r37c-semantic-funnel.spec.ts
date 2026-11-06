/**
 * R37-C0-B: accepted, committed, and rendered are separate facts.
 *
 * @module tests/r37c-semantic-funnel
 */

import { describe, expect, it } from 'vitest'
import {
  aggregateFunnels,
  factFunnelStage,
  lexicalMention,
  semanticFunnel,
} from '../eval/r37c/src/semantic-funnel.mjs'

const fact = {
  factId: 'f1',
  kind: 'decision',
  subjectKey: 'queue',
  quote: 'use an in-memory queue',
  statement: 'Keep the in-memory queue.',
  visibleNeedle: 'in-memory queue',
  criticality: 'high',
  current: true,
}

const delta = {
  deltaId: 'd1',
  kind: 'decision',
  subjectKey: 'queue',
  statement: 'Keep the in-memory queue.',
  evidence: [{ quote: 'use an in-memory queue' }],
  stateKey: { namespace: 'semantic', entity: 'decision#x', property: 'queue' },
}

const anchor = {
  id: 'a1',
  kind: 'decision',
  stateKey: { namespace: 'semantic', entity: 'decision#x', property: 'queue' },
  value: 'Keep the in-memory queue.',
  lifecycle: 'active',
}

const caseData = { gold: [fact] }

function funnel(overrides: any = {}) {
  return semanticFunnel(caseData, {
    writerRaw: 'use an in-memory queue',
    proposed: [delta],
    accepted: [delta],
    anchors: [anchor],
    commitProof: true,
    checkpoint: 'in-memory queue',
    unavailable: null,
    ...overrides,
  })
}

describe('R37-C0-B: semantic funnel', () => {
  it('separates accepted from committed', () => {
    const result = funnel({ commitProof: false, anchors: [] })
    expect(result.recall.accepted).toBe(1)
    expect(result.recall.committed).toBe(0)
    expect(result.acceptedButNotCommitted).toHaveLength(1)
    expect(result.acceptedButNotCommitted[0].anchorPresentButNotCommitted.reason).toBe('no-active-anchor')
  })

  it('does not count an accepted proposal as committed when the fold refused', () => {
    const result = funnel({ commitProof: false, anchors: [] })
    expect(result.facts[0].accepted).toBe(true)
    expect(result.facts[0].committed).toBe(false)
  })

  it('counts a committed fact that the checkpoint omitted', () => {
    const result = funnel({ checkpoint: 'nothing relevant' })
    expect(result.recall.committed).toBe(1)
    expect(result.recall.rendered).toBe(0)
    expect(result.committedButNotRendered).toHaveLength(1)
  })

  it('does not count a superseded anchor as committed', () => {
    const result = funnel({ anchors: [{ ...anchor, lifecycle: 'superseded' }] })
    expect(result.recall.committed).toBe(0)
    expect(result.facts[0].anchorPresentButNotCommitted.reason).toBe('anchor-not-active')
  })

  it('does not count an anchor whose value differs from the accepted statement', () => {
    const result = funnel({ anchors: [{ ...anchor, value: 'A different value.' }] })
    expect(result.recall.committed).toBe(0)
    expect(result.facts[0].anchorPresentButNotCommitted.reason).toBe('anchor-value-differs')
  })

  it('reports a missing journal as null, not zero', () => {
    const result = funnel({ commitProof: null, anchors: [], unavailable: 'no-journal' })
    expect(result.recall.committed).toBeNull()
    expect(result.recall.activeState).toBeNull()
    expect(result.unavailable).toBe('no-journal')
  })

  it('reports a missing writer as null, not zero', () => {
    const result = funnel({ writerRaw: null, proposed: null, accepted: null })
    expect(result.recall.rawMention).toBeNull()
    expect(result.recall.accepted).toBeNull()
  })

  it('keeps rendered coverage lexical and semantic validity unavailable', () => {
    const result = funnel({ checkpoint: 'The old value was us-east-1.' })
    expect(result.facts[0].rendered).toBe(false)
    expect(result.facts[0].renderedSemantic).toBeNull()
    expect(result.semanticValidity.rendered).toBeNull()
  })

  it('lexicalMention is true for a visible needle and false for unrelated text', () => {
    expect(lexicalMention('Keep the in-memory queue.', fact)).toBe(true)
    expect(lexicalMention('A durable outbox is rejected.', fact)).toBe(false)
  })

  it('aggregates only measured rows', () => {
    const measured = funnel()
    const missing = funnel({ commitProof: null, anchors: [] })
    const result = aggregateFunnels([measured, missing])
    expect(result.byStage.committed).toBe(1)
    expect(result.missing.committed).toBe(1)
  })

  it('reports the exact stage for a fact', () => {
    const stage = factFunnelStage(fact, {
      writerRaw: 'use an in-memory queue',
      proposed: [delta],
      accepted: [delta],
      anchors: [anchor],
      commitProof: true,
      checkpoint: 'in-memory queue',
    })
    expect(stage.rawMention).toBe(true)
    expect(stage.proposed).toBe(true)
    expect(stage.accepted).toBe(true)
    expect(stage.committed).toBe(true)
    expect(stage.activeState).toBe(true)
    expect(stage.rendered).toBe(true)
  })
})
