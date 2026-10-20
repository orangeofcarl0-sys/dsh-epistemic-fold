/**
 * Checkpoint residency is a READING, and a reading that is wrong is worse than no reading.
 *
 * The module exists because a checkpoint had no lifecycle at all: anchors have
 * active/superseded/retired and a checkpoint written onto the surface had nothing, so "this
 * phase is done" could not be expressed. Before anything is allowed to act on a retirement, the
 * derivation has to be shown correct on the states that are hard to tell apart:
 *
 *   resident   on the surface
 *   archived   folded away by a later checkpoint (content re-summarised, still carried)
 *   retired    explicitly taken out (content NOT carried; only recall reaches it)
 *
 * `archived` and `retired` have opposite consequences for accuracy, so a derivation that merged
 * them would make a fold look like a retirement and the accuracy difference -- which IS the
 * measurement -- would vanish.
 *
 * @module tests/checkpoint-residency
 */

import { describe, expect, it } from 'vitest'
import { deriveCheckpointResidency } from '../src/checkpoint/residency.ts'

const V2 = (code: string, id: string): string => `[EF1 ${code} cp:${id}]`

interface FakeEvent {
  readonly type: string
  readonly data?: unknown
}

function fakeSession(events: readonly FakeEvent[], surface: readonly number[]) {
  return {
    seq: events.length,
    eventAt: (seq: number) => events[seq],
    surface: { nodes: surface },
  } as never
}

const summary = (id: string, code = 'L') => ({
  type: 'compaction/summary',
  data: { shadowedSeqs: [1, 2], summary: [{ type: 'text', text: V2(code, id) + '\n\nbody' }] },
})

const retire = (checkpointId: string) => ({
  type: 'ef/retire',
  data: { checkpointId, reason: 'phase complete' },
})

describe('checkpoint residency', () => {
  it('reports a checkpoint on the surface as resident', () => {
    const report = deriveCheckpointResidency(fakeSession([summary('a')], [0]))
    expect(report.resident).toBe(1)
    expect(report.archived).toBe(0)
    expect(report.retired).toBe(0)
    expect(report.sites[0]).toMatchObject({ checkpointId: 'a', mode: 'leaf', residency: 'resident' })
  })

  it('reports a checkpoint that a later fold folded away as ARCHIVED, not retired', () => {
    // Its content was re-summarised into the later checkpoint: carried, lossily. That is not the
    // same fact as an explicit retirement, and the accuracy versions of the two differ.
    const report = deriveCheckpointResidency(fakeSession([summary('a'), summary('b')], [1]))
    expect(report.resident).toBe(1)
    expect(report.archived).toBe(1)
    expect(report.retired).toBe(0)
    expect(report.sites[0]).toMatchObject({ checkpointId: 'a', residency: 'archived', onSurface: false })
  })

  it('reports an explicitly retired checkpoint as retired', () => {
    const report = deriveCheckpointResidency(fakeSession([summary('a'), retire('a')], []))
    expect(report.retired).toBe(1)
    expect(report.archived).toBe(0)
    expect(report.sites[0]).toMatchObject({ residency: 'retired', retiredBy: 1 })
  })

  it('COUNTS a retired checkpoint that is still on the surface as a conflict', () => {
    // Nothing removes nodes yet, so this state is reachable. It is the one state that must not be
    // measured: a treatment was recorded and never applied. The report names it instead of
    // choosing between the two facts, and the count must reach zero once removal exists.
    const report = deriveCheckpointResidency(fakeSession([summary('a'), retire('a')], [0]))
    expect(report.retired).toBe(1)
    expect(report.conflicts).toBe(1)
  })

  it('ignores a summary that carries no EF marker', () => {
    // A Basic checkpoint has no id, so a retirement cannot name it. Leaving it out is the honest
    // answer; inventing an id would make it addressable by a record that cannot mean it.
    const plain = { type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'no marker' }] } }
    const report = deriveCheckpointResidency(fakeSession([plain], [0]))
    expect(report.sites).toHaveLength(0)
  })

  it('keeps the FIRST retirement record when a checkpoint is retired twice', () => {
    const report = deriveCheckpointResidency(fakeSession([summary('a'), retire('a'), retire('a')], []))
    expect(report.retired).toBe(1)
    expect(report.sites[0]?.retiredBy).toBe(1)
  })
})