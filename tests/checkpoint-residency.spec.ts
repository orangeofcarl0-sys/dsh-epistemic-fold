/**
 * Checkpoint residency is a READING, and a reading that is wrong is worse than no reading.
 *
 * The module exists because a checkpoint had no lifecycle at all: anchors have
 * active/superseded/retired and a checkpoint written onto the surface had nothing, so "this
 * phase is done" could not be expressed.
 *
 * ## A checkpoint is TWO events, and the tests model both
 *
 * Measured on a real fold: `compaction/summary` at one seq is the FOLD RECORD (it carries the
 * digest and the shadowed seqs), and a `user/message` at a LATER seq is the surface node the
 * model actually sees. A derivation that asked whether the SUMMARY's seq was on the surface
 * therefore found every checkpoint archived: eight folds, zero residents, and the phase-exit
 * driver silently retired nothing. These tests would have caught it if they had modelled the
 * second event, which is why they do now.
 *
 * @module tests/checkpoint-residency
 */

import { describe, expect, it } from 'vitest'
import { deriveCheckpointResidency, retireCheckpoint } from '../src/checkpoint/residency.ts'

const V2 = (code: string, id: string): string => `[EF1 ${code} cp:${id}]`

interface FakeEvent {
  readonly type: string
  readonly data?: unknown
}

/** The fold record: what a `compaction/summary` event carries. */
const summary = (id: string, code = 'L') => ({
  type: 'compaction/summary',
  data: { shadowedSeqs: [1, 2], summary: [{ type: 'text', text: V2(code, id) + '\n\nbody' }] },
})

/** The surface node: the model-visible message the fold is materialised as. */
const node = (id: string, code = 'L') => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text: V2(code, id) + '\n\nbody' }] },
})

const retire = (checkpointId: string) => ({
  type: 'ef/retire',
  data: { checkpointId, reason: 'phase complete' },
})

function fakeSession(events: readonly FakeEvent[], surface: readonly number[]) {
  return {
    seq: events.length,
    eventAt: (seq: number) => events[seq],
    surface: { nodes: surface },
  } as never
}

describe('checkpoint residency', () => {
  it('reports a checkpoint whose marker is on a surface node as resident', () => {
    const report = deriveCheckpointResidency(fakeSession([summary('a'), node('a')], [1]))
    expect(report.resident).toBe(1)
    expect(report.archived).toBe(0)
    expect(report.sites[0]).toMatchObject({
      checkpointId: 'a', mode: 'leaf', seq: 0, surfaceSeq: 1, onSurface: true, residency: 'resident',
    })
  })

  it('reports a checkpoint whose node left the surface as ARCHIVED, not retired', () => {
    // Its content was re-summarised into a later checkpoint: carried, lossily. Different fact,
    // opposite consequence for accuracy -- and that difference is the measurement.
    const report = deriveCheckpointResidency(fakeSession([summary('a'), node('a')], []))
    expect(report.resident).toBe(0)
    expect(report.archived).toBe(1)
    expect(report.retired).toBe(0)
    expect(report.sites[0]).toMatchObject({ checkpointId: 'a', residency: 'archived', onSurface: false })
  })

  it('reports an explicitly retired checkpoint as retired', () => {
    const report = deriveCheckpointResidency(fakeSession([summary('a'), node('a'), retire('a')], [1]))
    expect(report.retired).toBe(1)
    expect(report.sites[0]).toMatchObject({ residency: 'retired', retiredBy: 2 })
  })

  it('COUNTS a retired checkpoint still on the surface as a conflict', () => {
    // Nothing removes nodes yet, so this state is reachable, and it is the one state that must not
    // be measured: a treatment recorded and never applied. The count must reach zero once removal
    // exists -- an invariant, not a comment.
    const report = deriveCheckpointResidency(fakeSession([summary('a'), node('a'), retire('a')], [1]))
    expect(report.retired).toBe(1)
    expect(report.conflicts).toBe(1)
  })

  it('ignores a summary that carries no EF marker', () => {
    // A Basic checkpoint has no id, so a retirement cannot name it. Inventing one would make it
    // addressable by a record that cannot mean it.
    const plain = { type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'no marker' }] } }
    expect(deriveCheckpointResidency(fakeSession([plain], [])).sites).toHaveLength(0)
  })

  it('keeps the FIRST retirement record when a checkpoint is retired twice', () => {
    const report = deriveCheckpointResidency(fakeSession([summary('a'), retire('a'), retire('a')], []))
    expect(report.retired).toBe(1)
    expect(report.sites[0]?.retiredBy).toBe(1)
  })
})

// ---------------------------------------------------------------- the writer

/** A session that actually appends, so the writer can be exercised rather than mocked. */
function liveSession() {
  const events: FakeEvent[] = []
  const session = {
    get seq() { return events.length },
    eventAt: (seq: number) => events[seq],
    surface: { nodes: [] as number[] },
    append: (type: string, data: unknown) => { events.push({ type, data }); return {} },
  }
  // Cast at the CALL SITES, not here: `as never` on the returned value makes every member of it
  // unreachable, which turns these tests into a typecheck failure instead of a test.
  return { session, events }
}

describe('checkpoint retirement', () => {
  it('writes the retirement, and the report then shows ONE conflict', () => {
    const { session } = liveSession()
    session.append('compaction/summary', summary('a').data)
    session.append('user/message', node('a').data)
    ;(session.surface.nodes as number[]).push(1)

    const before = deriveCheckpointResidency(session as never)
    expect(before.resident).toBe(1)
    expect(before.conflicts).toBe(0)

    const outcome = retireCheckpoint(session as never, 'a', 'phase complete')
    expect(outcome).toEqual({ checkpointId: 'a', written: true })

    const after = deriveCheckpointResidency(session as never)
    expect(after.retired).toBe(1)
    expect(after.conflicts).toBe(1)
  })

  it('REFUSES an id that names nothing, and writes no event', () => {
    const { session, events } = liveSession()
    session.append('compaction/summary', summary('a').data)
    const outcome = retireCheckpoint(session as never, 'does-not-exist')
    expect(outcome).toEqual({ checkpointId: 'does-not-exist', written: false, refusal: 'no-such-checkpoint' })
    expect(events.filter(event => event.type === 'ef/retire')).toHaveLength(0)
  })

  it('REFUSES a second retirement of the same checkpoint', () => {
    const { session, events } = liveSession()
    session.append('compaction/summary', summary('a').data)
    expect(retireCheckpoint(session as never, 'a').written).toBe(true)
    expect(retireCheckpoint(session as never, 'a')).toEqual({
      checkpointId: 'a', written: false, refusal: 'already-retired',
    })
    expect(events.filter(event => event.type === 'ef/retire')).toHaveLength(1)
  })

  it('throws BEFORE appending when the host cannot persist a plugin event', () => {
    const { session, events } = liveSession()
    session.append('compaction/summary', summary('a').data)
    expect(() => retireCheckpoint(session as never, 'a', undefined, { durableWritesAllowed: () => false }))
      .toThrow(/cannot mark a plugin-owned/)
    expect(events.filter(event => event.type === 'ef/retire')).toHaveLength(0)
  })
})