/**
 * R31-C4: semantic commits and session events share one logical timeline.
 *
 * Applying the whole journal after the whole log lets an early fold overwrite a
 * later raw event. These tests put the same operations on both sides of that
 * boundary and assert the final value is the one that entered history last.
 *
 * @module tests/semantic-replay-order
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { stateKeyText } from '../src/state/state.ts'
import type { Anchor, EfAnchorEventData } from '../src/state/state.ts'
import { replayWithSemanticCommits } from '../src/semantic/replay.ts'

const KEY = { namespace: 'semantic', entity: 'decision', property: 'strategy' }

function anchor(id: string, value: string): Anchor {
  return {
    id,
    kind: 'decision',
    stateKey: KEY,
    value,
    authority: 'decision',
    lifecycle: 'active',
    sourceRefs: [{ seq: 0 as never }],
  }
}

function declare(id: string, value: string): EfAnchorEventData {
  return { op: 'declare', anchor: anchor(id, value) }
}

function sessionWithEvents(): Session {
  const session = Session.create(SessionId(`replay-${Math.random().toString(16).slice(2)}`))
  for (const text of ['first', 'commit point', 'third']) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  return session
}

function appendRaw(session: Session, id: string, value: string): number {
  const seq = Number(session.seq)
  session.append('ef/anchor', { op: 'declare', anchor: anchor(id, value) })
  return seq
}

describe('R31-C4: interleaved replay', () => {
  it('a later raw event wins over an earlier semantic commit (not the reverse)', () => {
    const session = sessionWithEvents()
    const commitAt = 1
    const raw = appendRaw(session, 'raw-after', 'raw value, later')
    expect(raw).toBe(3)

    const replayed = replayWithSemanticCommits(session, [
      { packetId: 'p-early', atSeq: commitAt, ops: [declare('semantic-early', 'semantic value, earlier')] },
    ])
    const head = replayed.state.stateHeads[stateKeyText(KEY)]
    expect(head?.id).toBe('raw-after')
    expect(head?.value).toBe('raw value, later')
    expect(replayed.unplaced).toHaveLength(0)
  })

  it('a later semantic commit wins over an earlier raw event', () => {
    const session = sessionWithEvents()
    const raw = appendRaw(session, 'raw-before', 'raw value, earlier')
    const latest = appendRaw(session, 'raw-middle', 'raw value, middle')
    expect(raw).toBe(3)
    expect(latest).toBe(4)

    const replayed = replayWithSemanticCommits(session, [
      { packetId: 'p-late', atSeq: latest, ops: [declare('semantic-late', 'semantic value, later')] },
    ])
    const head = replayed.state.stateHeads[stateKeyText(KEY)]
    expect(head?.id).toBe('semantic-late')
    expect(head?.value).toBe('semantic value, later')
  })

  it('two commits at one seq are ordered by packet id, not by array order', () => {
    const session = sessionWithEvents()
    const replayed = replayWithSemanticCommits(session, [
      { packetId: 'b', atSeq: 1, ops: [declare('b-anchor', 'from b')] },
      { packetId: 'a', atSeq: 1, ops: [declare('a-anchor', 'from a')] },
    ])
    // 'a' applies before 'b', so b is the current head regardless of input order.
    expect(replayed.state.stateHeads[stateKeyText(KEY)]?.id).toBe('b-anchor')
    expect(replayed.applied.map(commit => commit.packetId)).toEqual(['a', 'b'])
  })

  it('a commit whose seq is absent is reported and never applied', () => {
    const session = sessionWithEvents()
    const replayed = replayWithSemanticCommits(session, [
      { packetId: 'ghost', atSeq: 10_000, ops: [declare('ghost-anchor', 'not history')] },
    ])
    expect(replayed.unplaced.map(commit => commit.packetId)).toEqual(['ghost'])
    expect(replayed.state.stateHeads[stateKeyText(KEY)]).toBeUndefined()
  })
})
