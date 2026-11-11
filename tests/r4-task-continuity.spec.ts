import { describe, expect, it } from 'vitest'
import {
  ActiveTaskRootRegistry,
  protectedTaskRootPosition,
  resolveActiveTaskRoot,
  taskRootDigest,
} from '../src/fold/task-root.ts'

type FakeEvent = {
  seq: number
  type: 'user/message' | 'assistant/message'
  message: { role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> } | null
}

function sessionOf(id: string, events: FakeEvent[], nodes: number[]) {
  const bySeq = new Map(events.map(event => [event.seq, event]))
  return {
    id,
    surface: { nodes },
    eventAt: (seq: number) => bySeq.get(seq),
    deriveEventMessage: (event: FakeEvent | undefined) => event?.message ?? null,
  } as any
}

function userEvent(seq: number, text: string): FakeEvent {
  return {
    seq,
    type: 'user/message',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function refOf(sessionId: string, event: FakeEvent, generation = 1) {
  return {
    sessionId: sessionId as any,
    sourceSeq: event.seq as any,
    sourceDigest: taskRootDigest(event.message as any),
    generation,
  }
}

describe('EF-R4 task root continuity contract', () => {
  it('single-stage task: registers and resolves resident', () => {
    const task = userEvent(2, 'fix the retry cap')
    const session = sessionOf('s1', [task], [1, 2, 3])
    const registry = new ActiveTaskRootRegistry()
    const registration = registry.register(refOf('s1', task))
    expect(registration.status).toBe('registered')
    const resolution = resolveActiveTaskRoot(session, registry.get('s1' as any))
    expect(resolution).toEqual({ status: 'resident', position: 1, seq: 2 })
    expect(protectedTaskRootPosition(session, registry.get('s1' as any))).toBe(1)
  })

  it('task followed by a new constraint keeps the original root', () => {
    const task = userEvent(2, 'fix the retry cap')
    const constraint = userEvent(5, 'do not change the public API')
    const session = sessionOf('s1', [task, constraint], [1, 2, 5, 6])
    const registry = new ActiveTaskRootRegistry()
    registry.register(refOf('s1', task))
    expect(resolveActiveTaskRoot(session, registry.get('s1' as any))?.status).toBe('resident')
  })

  it('task revised by the user replaces the root and advances the generation', () => {
    const first = userEvent(2, 'fix the retry cap')
    const revised = userEvent(5, 'fix the retry cap, but keep the old default')
    const session = sessionOf('s1', [first, revised], [1, 2, 5, 6])
    const registry = new ActiveTaskRootRegistry()
    registry.register(refOf('s1', first))
    const replacement = registry.register(refOf('s1', revised))
    expect(replacement.status).toBe('replaced')
    expect(replacement.ref.generation).toBe(2)
    expect(resolveActiveTaskRoot(session, registry.get('s1' as any))).toEqual({ status: 'resident', position: 2, seq: 5 })
  })

  it('task B after restart is a different session and cannot resolve task A', () => {
    const a = userEvent(2, 'task A')
    const b = userEvent(10, 'task B')
    const sessionA = sessionOf('s1', [a], [1, 2, 3])
    const sessionB = sessionOf('s2', [b], [9, 10, 11])
    const registry = new ActiveTaskRootRegistry()
    registry.register(refOf('s1', a))
    registry.register(refOf('s2', b))
    expect(resolveActiveTaskRoot(sessionB, registry.get('s1' as any))).toBeUndefined()
    expect(resolveActiveTaskRoot(sessionB, registry.get('s2' as any))?.status).toBe('resident')
    expect(resolveActiveTaskRoot(sessionA, registry.get('s1' as any))?.status).toBe('resident')
  })

  it('a finished task stays resident until the surface changes', () => {
    const task = userEvent(2, 'write result.json')
    const finished = sessionOf('s1', [task], [1, 2, 3, 9])
    const registry = new ActiveTaskRootRegistry()
    registry.register(refOf('s1', task))
    expect(resolveActiveTaskRoot(finished, registry.get('s1' as any))?.status).toBe('resident')
  })

  it('a canceled or superseded task is cleared and re-registers as a new root', () => {
    const task = userEvent(2, 'task A')
    const session = sessionOf('s1', [task], [1, 2, 3])
    const registry = new ActiveTaskRootRegistry()
    registry.register(refOf('s1', task))
    expect(registry.clear('s1' as any)).toBe(true)
    expect(registry.get('s1' as any)).toBeUndefined()
    expect(resolveActiveTaskRoot(session, registry.get('s1' as any))).toBeUndefined()
    const again = registry.register(refOf('s1', task))
    expect(again.status).toBe('registered')
    expect(again.ref.generation).toBe(1)
  })

  it('a folded root is absent, not silently resident', () => {
    const task = userEvent(2, 'task A')
    const session = sessionOf('s1', [task], [1, 3])
    const registry = new ActiveTaskRootRegistry()
    registry.register(refOf('s1', task))
    expect(resolveActiveTaskRoot(session, registry.get('s1' as any))).toEqual({
      status: 'absent',
      reason: 'source-not-on-surface',
    })
    expect(protectedTaskRootPosition(session, registry.get('s1' as any))).toBeUndefined()
  })

  it('a changed digest is a mismatch, and a non-user event is rejected', () => {
    const task = userEvent(2, 'task A')
    const registry = new ActiveTaskRootRegistry()
    const ref = refOf('s1', task)
    registry.register(ref)
    const changed = sessionOf('s1', [{ ...task, message: { role: 'user', content: [{ type: 'text', text: 'task B' }] } }], [1, 2, 3])
    expect(resolveActiveTaskRoot(changed, ref)?.status).toBe('absent')
    const assistant: FakeEvent = {
      seq: 4,
      type: 'assistant/message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    }
    const assistantSession = sessionOf('s1', [assistant], [1, 4])
    const assistantRef = refOf('s1', assistant)
    expect(resolveActiveTaskRoot(assistantSession, assistantRef)).toEqual({
      status: 'absent',
      reason: 'not-a-user-message',
    })
  })
})
