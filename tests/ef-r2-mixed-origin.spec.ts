/**
 * EF-R2 WP5: mixed-origin decision authority.
 *
 * ## The bypass this closes
 *
 * `decisionSourceOf` answered "did the citation set include a user message?".
 * `latestDecisionSeq` answered "what is the newest decision-capable seq in the
 * set?". An assistant could cite the user's OLD decision AND its own NEW
 * statement:
 *
 *     evidence: [old user quote (seq 1), assistant statement (seq 2)]
 *     sourceAuthority -> user     (because a user message was present)
 *     latestDecisionSeq -> 2      (because the assistant message was newer)
 *
 * The target user decision cited seq 1. The stale-source check saw 2 > 1 and
 * passed; the source check saw `user` and passed. The assistant replaced the
 * user's decision while both gates reported success.
 *
 * The fix asks a different question: who produced the NEWEST decision-capable
 * citation? If that is the assistant, the assistant-source gate applies even
 * when an older user quote is in the set. The same rule is applied at the
 * public `AnchorService.declare` door, where the producer is derived from the
 * cited raw events and a supplied label that disagrees is refused before the
 * append. A later tool/system event cannot refresh an old user quote either.
 *
 * Historical replay is not re-authorized: recorded ops still apply as recorded.
 *
 * @module tests/ef-r2-mixed-origin
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, Message, SystemMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { validateDeltas } from '../src/semantic/validate.ts'
import { applyOps, planCommit } from '../src/semantic/plan.ts'
import { decisionOriginOf } from '../src/state/authority.ts'
import { createAnchorService } from '../src/state/anchor-service.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import type { Anchor, FoldCurrentState } from '../src/state/state.ts'
import { conversation, toolConversation } from './harness.ts'

const user = (text: string): UserMessage => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const model = (text: string): AssistantMessage => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'test', model: 'test' },
}) as AssistantMessage
const system = (text: string): SystemMessage => createMessage({
  role: 'system',
  content: [{ type: 'text', text }],
  source: { kind: 'system-prompt' },
}) as SystemMessage

function fold(
  proposed: readonly Record<string, unknown>[],
  messages: readonly Message[],
  state: FoldCurrentState = emptyCurrentState(),
) {
  const foldedSeqs = messages.map((_, index) => index + 1)
  const validation = validateDeltas({ foldedSeqs, messages, proposed })
  const plan = planCommit(validation.accepted, { state })
  return { validation, plan, state: applyOps(state, plan.ops) }
}

const decision = (
  quotes: readonly string[],
  statement: string,
  options: { subjectKey?: string; supersedes?: readonly string[] } = {},
): Record<string, unknown> => ({
  kind: 'decision',
  subjectKey: options.subjectKey ?? 'queue',
  statement,
  status: 'claimed',
  evidence: quotes.map(quote => ({ quote })),
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})

const activeValues = (state: FoldCurrentState): unknown[] =>
  Object.values(state.decisions).filter(anchor => anchor.lifecycle === 'active').map(anchor => anchor.value)

/** The user's decision, anchored at seq 1. */
function withUserDecision() {
  const first = fold([
    decision(['Use the in-memory queue for now.'], 'Use the in-memory queue.', { subjectKey: 'queue' }),
  ], [user('Use the in-memory queue for now.')])
  return { state: first.state, anchorId: first.plan.planned[0]!.anchorId! }
}

/** The assistant's decision, anchored at seq 1. */
function withAssistantDecision() {
  const first = fold([
    decision(['I decided the in-memory queue is fine.'], 'Use the in-memory queue.', { subjectKey: 'queue' }),
  ], [model('I decided the in-memory queue is fine.')])
  return { state: first.state, anchorId: first.plan.planned[0]!.anchorId! }
}

describe('EF-R2 WP5: a newer assistant statement cannot borrow an old user quote', () => {
  it('refuses an assistant decision citing the old user quote AND its own newer statement', () => {
    const { state } = withUserDecision()
    const second = fold([
      decision([
        'Use the in-memory queue for now.',
        'I decided the durable outbox is better.',
      ], 'Use the durable outbox.', { supersedes: ['previous'] }),
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ], state)

    expect(second.validation.accepted[0]?.sourceAuthority).toBe('assistant')
    expect(second.validation.accepted[0]?.latestDecisionSeq).toBe(2)
    expect(second.plan.withheld[0]?.reason).toBe('unauthorized-replacement')
    expect(second.plan.refusedRetirements[0]?.reason).toBe('insufficient-source-authority')
    expect(activeValues(second.state)).toEqual(['Use the in-memory queue.'])
  })

  it('refuses the same attack laundered with an unrelated newer user message', () => {
    const { state } = withUserDecision()
    const second = fold([
      decision([
        'Use the in-memory queue for now.',
        'The weather is fine today.',
        'I decided the durable outbox is better.',
      ], 'Use the durable outbox.', { supersedes: ['previous'] }),
    ], [
      user('Use the in-memory queue for now.'),
      user('The weather is fine today.'),
      model('I decided the durable outbox is better.'),
    ], state)

    expect(second.validation.accepted[0]?.sourceAuthority).toBe('assistant')
    expect(second.plan.withheld[0]?.reason).toBe('unauthorized-replacement')
    expect(activeValues(second.state)).toEqual(['Use the in-memory queue.'])
  })

  it('still allows a user revision grounded in a newer user statement', () => {
    const { state } = withUserDecision()
    const second = fold([
      decision(['Use the durable outbox instead.'], 'Use the durable outbox.', { supersedes: ['previous'] }),
    ], [
      user('Use the in-memory queue for now.'),
      model('I am reviewing the queue decision.'),
      user('Use the durable outbox instead.'),
    ], state)

    expect(second.plan.withheld).toEqual([])
    expect(activeValues(second.state)).toEqual(['Use the durable outbox.'])
  })

  it('allows an assistant to revise its OWN decision with a newer statement', () => {
    const { state } = withAssistantDecision()
    const second = fold([
      decision(['I now prefer the durable outbox.'], 'Use the durable outbox.', { supersedes: ['previous'] }),
    ], [
      model('Reviewing the queue decision.'),
      model('I now prefer the durable outbox.'),
    ], state)

    expect(second.plan.withheld).toEqual([])
    expect(activeValues(second.state)).toEqual(['Use the durable outbox.'])
  })

  it('allows a user to revise an assistant decision', () => {
    const { state } = withAssistantDecision()
    const second = fold([
      decision(['Use the durable outbox instead.'], 'Use the durable outbox.', { supersedes: ['previous'] }),
    ], [
      model('I am reviewing the queue decision.'),
      user('Use the durable outbox instead.'),
    ], state)

    expect(second.plan.withheld).toEqual([])
    expect(activeValues(second.state)).toEqual(['Use the durable outbox.'])
  })

  it('still refuses the old user quote alone as authority for its opposite', () => {
    const { state } = withUserDecision()
    const second = fold([
      decision(['Use the in-memory queue for now.'], 'Use the durable outbox.', { supersedes: ['previous'] }),
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ], state)

    expect(second.validation.accepted[0]?.sourceAuthority).toBe('user')
    expect(second.plan.refusedRetirements[0]?.reason).toBe('stale-source')
    expect(activeValues(second.state)).toEqual(['Use the in-memory queue.'])
  })
})

describe('EF-R2 WP5: the anchor-service door derives the producer', () => {
  it('refuses a supplied sourceAuthority that disagrees with the cited raw event', () => {
    const session = conversation(1)
    const assistantSeq = session.snapshotEvents()
      .filter(event => event.type === 'assistant/message')
      .at(-1)!.seq
    const service = createAnchorService()
    const before = session.snapshotEvents().filter(event => event.type === 'ef/anchor').length

    expect(() => service.declare(session, {
      kind: 'decision',
      stateKey: { namespace: 'scope', entity: 'queue', property: 'mode' },
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceAuthority: 'user',
      sourceRefs: [{ seq: assistantSeq }],
    })).toThrow(/disagrees with the raw evidence/u)
    expect(session.snapshotEvents().filter(event => event.type === 'ef/anchor')).toHaveLength(before)
  })

  it('derives assistant origin when the caller omits sourceAuthority', () => {
    const session = conversation(1)
    const assistantSeq = session.snapshotEvents()
      .filter(event => event.type === 'assistant/message')
      .at(-1)!.seq
    const service = createAnchorService()
    const anchor = service.declare(session, {
      kind: 'decision',
      stateKey: { namespace: 'scope', entity: 'queue', property: 'mode' },
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceRefs: [{ seq: assistantSeq }],
    })
    expect(anchor.sourceAuthority).toBe('assistant')
  })

  it('refuses an assistant declare at an occupied user coordinate', () => {
    const session = conversation(1)
    const events = session.snapshotEvents()
    const userSeq = events.find(event => event.type === 'user/message')!.seq
    const assistantSeq = events.filter(event => event.type === 'assistant/message').at(-1)!.seq
    const service = createAnchorService()
    service.declare(session, {
      kind: 'decision',
      stateKey: { namespace: 'scope', entity: 'queue', property: 'mode' },
      value: 'Use the in-memory queue.',
      authority: 'decision',
      sourceRefs: [{ seq: userSeq }],
    })

    expect(() => service.declare(session, {
      kind: 'decision',
      stateKey: { namespace: 'scope', entity: 'queue', property: 'mode' },
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceRefs: [{ seq: assistantSeq }],
    })).toThrow(/insufficient-source-authority/u)
  })

  it('does not let a later non-decision event refresh an old user quote', () => {
    const session = toolConversation(1)
    const events = session.snapshotEvents()
    const oldUserSeq = events.find(event => event.type === 'user/message')!.seq
    session.append('user/message', user('Use the durable outbox instead.'), { surfaceOp: 'append' })
    const targetUserSeq = session.seq - 1
    session.append('system/message', {
      turn: 2,
      step: 1,
      message: system('Later context, not a decision.'),
    }, { surfaceOp: 'append' })
    const laterSystemSeq = session.seq - 1
    const service = createAnchorService()
    service.declare(session, {
      kind: 'decision',
      stateKey: { namespace: 'scope', entity: 'queue', property: 'mode' },
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceRefs: [{ seq: SessionSeq(targetUserSeq) }],
    })

    expect(() => service.declare(session, {
      kind: 'decision',
      stateKey: { namespace: 'scope', entity: 'queue', property: 'mode' },
      value: 'Use the in-memory queue.',
      authority: 'decision',
      sourceRefs: [{ seq: oldUserSeq }, { seq: SessionSeq(laterSystemSeq) }],
    })).toThrow(/stale-source/u)
  })
})

describe('EF-R2 WP5: origin and replay', () => {
  it('decisionOriginOf takes the newest decision-capable citation', () => {
    expect(decisionOriginOf([
      { kind: 'user/message', seq: 1 },
      { kind: 'assistant/message', seq: 2 },
    ])).toBe('assistant')
    expect(decisionOriginOf([
      { kind: 'assistant/message', seq: 1 },
      { kind: 'user/message', seq: 2 },
    ])).toBe('user')
    expect(decisionOriginOf([
      { kind: 'user/message', seq: 1 },
      { kind: 'tool/result', seq: 9 },
    ])).toBe('user')
    expect(decisionOriginOf([{ kind: 'tool/result', seq: 9 }])).toBe('unknown')
    expect(decisionOriginOf([])).toBe('unknown')
  })

  it('keeps historical replay mechanical for a recorded mixed-origin anchor', () => {
    const historical: Anchor = {
      id: 'historical-user',
      kind: 'decision',
      stateKey: { namespace: 'semantic', entity: 'decision', property: 'queue' },
      value: 'Use the in-memory queue.',
      authority: 'decision',
      sourceAuthority: 'user',
      lifecycle: 'active',
      sourceRefs: [{ seq: SessionSeq(1) }],
    }
    const base = applyOps(emptyCurrentState(), [{ op: 'declare', anchor: historical }])
    const recorded = [{
      op: 'declare' as const,
      anchor: {
        id: 'recorded-assistant',
        kind: 'decision' as const,
        stateKey: { namespace: 'semantic', entity: 'decision', property: 'queue' },
        value: 'Use the durable outbox.',
        authority: 'decision' as const,
        sourceAuthority: 'assistant' as const,
        lifecycle: 'active' as const,
        sourceRefs: [{ seq: SessionSeq(2) }],
      },
    }]
    const first = applyOps(base, recorded)
    const second = applyOps(base, recorded)
    expect(first).toEqual(second)
    expect(first.decisions['historical-user']).toBeUndefined()
  })
})
