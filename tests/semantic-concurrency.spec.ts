/**
 * R31-A4: one reconciliation boundary per session.
 *
 * The fold's own pre-write reconciliation used to bypass the promise chain that
 * serialized the post-commit event feed. Two passes could read the same staged
 * packet, both conclude its fold committed, and both append the same durable
 * record — a duplicate logical activation produced by timing rather than by a
 * protocol error.
 *
 * These tests observe the boundary itself: a journal wrapper counts concurrent
 * `list()` calls, which is where a second pass would first become visible.
 *
 * @module tests/semantic-concurrency
 */

import { describe, expect, it } from 'vitest'
import { createHarness, conversation } from './harness.ts'
import type { Session } from './harness.ts'
import type { JournalRead, SemanticJournal } from '../src/semantic/journal.ts'
import { NullSemanticJournal } from '../src/semantic/journal.ts'

/** A journal whose reads can be delayed, failed, and counted. */
class ObservedJournal implements SemanticJournal {
  lists = 0
  activeLists = 0
  maxActiveLists = 0
  failNextList = false

  async write(): Promise<void> {}
  async writeReceipt(): Promise<void> {}
  async hasSession(): Promise<boolean> { return false }
  async sessionState(): Promise<'absent'> { return 'absent' }

  async list(): Promise<JournalRead> {
    this.lists += 1
    this.activeLists += 1
    this.maxActiveLists = Math.max(this.maxActiveLists, this.activeLists)
    try {
      await new Promise(resolve => setTimeout(resolve, 15))
      if (this.failNextList) {
        this.failNextList = false
        throw new Error('journal read failed')
      }
      return {
        packets: [],
        receipts: new Map(),
        legacy: [],
        invalid: [],
        orphans: [],
        rejectedReceipts: new Map(),
        state: 'ok',
      }
    } finally {
      this.activeLists -= 1
    }
  }
}

async function harnessWith(journal: SemanticJournal) {
  const h = await createHarness({}, {
    efConfig: { semanticContinuity: 'active', semanticMode: 'rationale' },
    semanticJournal: journal,
  })
  return h
}

describe('R31-A4: reconciliation is serialized per session', () => {
  it('two concurrent reconciliations do not overlap', async () => {
    const journal = new ObservedJournal()
    const h = await harnessWith(journal)
    const session: Session = conversation(1)

    const [first, second] = await Promise.all([
      h.engine.reconcileSemantics(session),
      h.engine.reconcileSemantics(session),
    ])

    expect(first.scanned).toBe(0)
    expect(second.scanned).toBe(0)
    expect(journal.lists).toBe(2)
    // Without the boundary this is 2: both passes read before either wrote.
    expect(journal.maxActiveLists).toBe(1)
  })

  it('the event feed and a direct call share the same boundary', async () => {
    const journal = new ObservedJournal()
    const h = await harnessWith(journal)
    const session: Session = conversation(1)

    // The event listener's entry point, exercised directly. It is private
    // because production reaches it only through `session/event`; the test
    // owns the scheduling so it can put it in flight before the direct call.
    const schedule = (h.engine as unknown as {
      scheduleSemanticActivation(session: Session): void
    }).scheduleSemanticActivation.bind(h.engine)
    schedule(session)
    await h.engine.reconcileSemantics(session)

    expect(journal.lists).toBe(2)
    expect(journal.maxActiveLists).toBe(1)
  })

  it('a failed pass does not poison the next one', async () => {
    const journal = new ObservedJournal()
    const h = await harnessWith(journal)
    const session: Session = conversation(1)

    journal.failNextList = true
    const failed = await h.engine.reconcileSemantics(session)
    expect(failed.health).toBe('unavailable')

    const retried = await h.engine.reconcileSemantics(session)
    expect(retried.health).toBe('ready')
    expect(journal.lists).toBe(2)
    expect(journal.maxActiveLists).toBe(1)
  })

  it('the null journal is not reachable in active mode (mount-time refusal still holds)', async () => {
    await expect(createHarness({}, {
      efConfig: { semanticContinuity: 'active', semanticMode: 'rationale' },
      semanticJournal: new NullSemanticJournal(),
    })).rejects.toThrow(/durable semantic journal/)
  })
})
