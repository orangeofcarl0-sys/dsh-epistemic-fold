/**
 * EF-R1 — protecting the ACTIVE user request from a leaf fold.
 *
 * The 120-cell confirm measured the active request being archived in 44 cells;
 * the model then answered "there is no question on the surface". This is a
 * different failure from losing a historical fact.
 *
 * The prototype is opt-in (`protectActiveRequest`, default false). The leaf
 * span starts AFTER the last real user message, so the request stays on the
 * surface verbatim; the emergency rebase is deliberately exempt because an
 * overflow that cannot meet the provider window must still be able to fold.
 *
 * @module tests/ef-r1-prompt-protection
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { activeRequestPosition, selectLeafSpan } from '../src/fold/leaf-policy.ts'
import { resolveEfConfig } from '../src/config/policy.ts'

const MODEL = 'prompt-protection-model'

function user(text: string, source: 'user' | 'compact-checkpoint' = 'user'): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    // The checkpoint source carries a compactionId at runtime; the test only
    // needs the producer KIND, which is what activeRequestPosition reads.
    source: source === 'user' ? { kind: 'user' } : ({ kind: 'compact-checkpoint' } as never),
  })
}

function assistant(text: string): Message {
  return createMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: MODEL, model: MODEL },
  })
}

function conversation(messages: readonly Message[]): Session {
  const session = Session.create(SessionId(`ef-r1-prompt-${Math.random().toString(36).slice(2)}`))
  session.append('turn/start', { turn: 1 })
  for (const message of messages) {
    if (message.role === 'user') {
      session.append('user/message', message, { surfaceOp: 'append' })
    } else if (message.role === 'assistant') {
      session.append('assistant/message', {
        stream: [],
        turn: 1,
        step: 1,
        message,
      }, { surfaceOp: 'append' })
    }
  }
  return session
}

function measurementOf(session: Session): TokenMeasurement {
  const nodes = [...session.surface.nodes]
  return {
    nodes: nodes.map(seq => ({ seq, tokens: 10 })),
    totalTokens: nodes.length * 10,
  } as unknown as TokenMeasurement
}

describe('EF-R1: the active request can be pinned out of a leaf fold', () => {
  it('finds the last REAL user message, not a checkpoint delivered in the user role', () => {
    const session = conversation([
      user('task root'),
      assistant('working'),
      user('the active request'),
      user('[EF1 L cp:00000000-0000-4000-8000-000000000000]', 'compact-checkpoint'),
    ])
    const position = activeRequestPosition(session)
    expect(position).toBe(2)
    expect(session.surface.nodes[position!]).toBeDefined()
  })

  it('returns undefined when the surface has no real user message', () => {
    const session = conversation([
      assistant('only model text'),
      user('[EF1 L cp:00000000-0000-4000-8000-000000000000]', 'compact-checkpoint'),
    ])
    expect(activeRequestPosition(session)).toBeUndefined()
  })

  it('starts the leaf span AFTER a protected active request', () => {
    const session = conversation([
      user('task root'),
      assistant('old work'),
      user('the active request'),
      assistant('new work'),
      assistant('more new work'),
    ])
    const measurement = measurementOf(session)

    const unprotected = selectLeafSpan(session, measurement, 0, -1, [0])
    expect(unprotected?.startIdx).toBe(1)
    expect(unprotected?.startIdx).toBeLessThan(2)

    const protectedSpan = selectLeafSpan(session, measurement, 0, -1, [0, 2])
    expect(protectedSpan).not.toBeNull()
    expect(protectedSpan!.startIdx).toBe(3)
    expect(protectedSpan!.startIdx).toBeGreaterThan(2)
    expect(protectedSpan!.endIdx).toBeGreaterThanOrEqual(3)
  })

  it('returns null when the active request is the last open message', () => {
    const session = conversation([
      user('task root'),
      assistant('old work'),
      user('the active request'),
    ])
    expect(selectLeafSpan(session, measurementOf(session), 0, -1, [0, 2])).toBeNull()
  })
})

describe('EF-R1: the flag is opt-in', () => {
  it('defaults off and rejects a non-boolean', () => {
    expect(resolveEfConfig({}).protectActiveRequest).toBe(false)
    expect(resolveEfConfig({ protectActiveRequest: true }).protectActiveRequest).toBe(true)
    expect(() => resolveEfConfig({ protectActiveRequest: 'true' as never })).toThrow(/protectActiveRequest/u)
  })
})
