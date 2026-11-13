/**
 * Source authority: WHO took a decision, not only that one was taken.
 *
 * ## The defect this certifies
 *
 * `AuthorityDomain` is grounded by BOTH `user/message` and
 * `assistant/message` for `decision`, and the anchor recorded only the domain.
 * An assistant-origin decision therefore had exactly the user's retirement
 * standing. Two paths made that exploitable:
 *
 *   1. explicit `supersedes` naming the user's anchor (equal ranks pass);
 *   2. `supersedes: ['previous']` at the same coordinate, which skipped
 *      `mayRetire` entirely — the coordinate was treated as the permission.
 *
 * ## What is certified here
 *
 *   assistant → user decision      refused (both paths), user value survives
 *   assistant → assistant decision allowed (the assistant may revise itself)
 *   user → assistant decision      allowed (the user outranks the assistant)
 *   assistant → historical anchor  refused (unknown source is conservative)
 *   user → historical anchor       allowed
 *   replay                         the withheld delta contributes no op, and
 *                                  the authorized ops replay to the same state
 *
 * Historical replay is NOT re-authorized: `applyOps` applies recorded ops as
 * they are. The check lives in planning, so an old journal keeps its outcome.
 *
 * @module tests/semantic-source-authority
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { validateDeltas } from '../src/semantic/validate.ts'
import { applyOps, planCommit } from '../src/semantic/plan.ts'
import { mayRetire } from '../src/semantic/retirement.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import type { FoldCurrentState } from '../src/state/state.ts'
import type { Anchor } from '../src/state/state.ts'

const user = (text: string): Message => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const model = (text: string): Message => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'test', model: 'test' },
})
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
  quote: string,
  statement: string,
  options: { subjectKey?: string; supersedes?: readonly string[] } = {},
): Record<string, unknown> => ({
  kind: 'decision',
  subjectKey: options.subjectKey ?? 'queue',
  statement,
  status: 'claimed',
  evidence: [{ quote }],
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})

/** The user's decision, as a first fold. */
function withUserDecision() {
  const messages = [user('Use the in-memory queue for now.')]
  const first = fold([
    decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'queue' }),
  ], messages)
  const anchorId = first.plan.planned[0]!.anchorId!
  return { state: first.state, anchorId, messages }
}

const activeDecisionValues = (state: FoldCurrentState): unknown[] =>
  Object.values(state.decisions).filter(anchor => anchor.lifecycle === 'active').map(anchor => anchor.value)

describe('source authority: the assistant may not retire the user decision', () => {
  it('refuses a same-coordinate replacement and withholds the assistant claim', () => {
    const { state, anchorId } = withUserDecision()
    const messages = [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ]
    const second = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        subjectKey: 'queue',
        supersedes: ['previous'],
      }),
    ], messages, state)

    // The user's value is still the only active decision.
    expect(activeDecisionValues(second.state)).toEqual(['Use the in-memory queue.'])
    expect(second.state.decisions[anchorId]?.lifecycle).toBe('active')
    // The assistant claim was NOT declared at the same coordinate.
    expect(second.plan.ops.some(op => op.op === 'declare')).toBe(false)
    expect(second.plan.withheld[0]?.reason).toBe('unauthorized-replacement')
    expect(second.plan.refusedRetirements[0]?.reason).toBe('insufficient-source-authority')
  })

  it('refuses an explicit supersedes of the user anchor', () => {
    const { state, anchorId } = withUserDecision()
    const messages = [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ]
    const second = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        subjectKey: 'outbox',
        supersedes: [anchorId],
      }),
    ], messages, state)

    // The assistant's OWN claim may still be declared in a different
    // coordinate; only the retirement of the user's decision is refused.
    expect(second.state.decisions[anchorId]?.lifecycle).toBe('active')
    expect(second.plan.refusedRetirements[0]?.reason).toBe('insufficient-source-authority')
    expect(second.plan.ops.some(op => op.op === 'retire')).toBe(false)
    expect(activeDecisionValues(second.state)).toContain('Use the durable outbox.')
  })

  it('allows the assistant to revise its own decision', () => {
    const first = fold([
      decision('I decided the in-memory queue is fine.', 'Use the in-memory queue.', { subjectKey: 'queue' }),
    ], [model('I decided the in-memory queue is fine.')])
    const anchorId = first.plan.planned[0]!.anchorId!
    const second = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        subjectKey: 'queue',
        supersedes: ['previous'],
      }),
    ], [model('I decided the in-memory queue is fine.'), model('I decided the durable outbox is better.')], first.state)

    expect(second.plan.withheld).toEqual([])
    expect(Object.values(second.state.superseded).find(anchor => anchor.id === anchorId)?.lifecycle).toBe('superseded')
    expect(activeDecisionValues(second.state)).toEqual(['Use the durable outbox.'])
  })

  it('allows the user to revise the assistant decision', () => {
    const first = fold([
      decision('I decided the in-memory queue is fine.', 'Use the in-memory queue.', { subjectKey: 'queue' }),
    ], [model('I decided the in-memory queue is fine.')])
    const anchorId = first.plan.planned[0]!.anchorId!
    const second = fold([
      decision('Use the durable outbox instead.', 'Use the durable outbox.', {
        subjectKey: 'queue',
        supersedes: ['previous'],
      }),
    ], [
      model('I decided the in-memory queue is fine.'),
      user('Use the durable outbox instead.'),
    ], first.state)

    expect(second.plan.withheld).toEqual([])
    expect(Object.values(second.state.superseded).find(anchor => anchor.id === anchorId)?.lifecycle).toBe('superseded')
    expect(activeDecisionValues(second.state)).toEqual(['Use the durable outbox.'])
    // The new anchor records WHO took it.
    const active = Object.values(second.state.decisions).find(anchor => anchor.lifecycle === 'active')!
    expect(active.sourceAuthority).toBe('user')
  })

  it('treats a historical anchor with no source as unknown and refuses the assistant', () => {
    // A pre-fix anchor: the field did not exist when this state was written.
    const historical: Anchor = {
      id: 'semantic-historical',
      kind: 'decision',
      stateKey: { namespace: 'semantic', entity: 'decision', property: 'queue' },
      value: 'Use the in-memory queue.',
      authority: 'decision',
      lifecycle: 'active',
      sourceRefs: [{ seq: SessionSeq(1) }],
    }
    const state = applyOps(emptyCurrentState(), [{ op: 'declare', anchor: historical }])
    const messages = [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ]
    const second = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        subjectKey: 'queue',
        supersedes: ['previous'],
      }),
    ], messages, state)

    expect(second.state.decisions['semantic-historical']?.lifecycle).toBe('active')
    expect(second.plan.withheld[0]?.reason).toBe('unauthorized-replacement')

    // A USER revision of the same historical anchor is allowed. The revision
    // must be a LATER statement than the anchor's own source (seq 2 > seq 1):
    // in a real session a later fold's messages always have higher seqs. The
    // original fixture put the new user message and the anchor's source at the
    // same seq, which no session can produce and which the stale-source rule
    // (EF-R1) correctly reads as reusing the old instruction.
    const third = fold([
      decision('Use the durable outbox instead.', 'Use the durable outbox.', {
        subjectKey: 'queue',
        supersedes: ['previous'],
      }),
    ], [model('Reviewing the queue decision.'), user('Use the durable outbox instead.')], state)
    expect(third.plan.withheld).toEqual([])
    expect(Object.values(third.state.superseded).find(anchor => anchor.id === 'semantic-historical')?.lifecycle).toBe('superseded')
  })

  it('replays the authorized ops to the same state and never replays a withheld delta', () => {
    const { state, anchorId } = withUserDecision()
    const refused = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        subjectKey: 'queue',
        supersedes: ['previous'],
      }),
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ], state)
    // A withheld delta contributes NO operations at all.
    expect(refused.plan.ops).toEqual([])
    expect(applyOps(state, refused.plan.ops)).toEqual(state)

    const accepted = fold([
      decision('Use the durable outbox instead.', 'Use the durable outbox.', {
        subjectKey: 'queue',
        supersedes: ['previous'],
      }),
    ], [model('Reviewing the queue decision.'), user('Use the durable outbox instead.')], state)
    // Replay is deterministic: the recorded ops, applied to the same input
    // state, produce the same output state. Historical ops are not
    // re-authorized; they are applied as recorded.
    expect(applyOps(state, accepted.plan.ops)).toEqual(accepted.state)
    expect(Object.values(accepted.state.superseded).find(anchor => anchor.id === anchorId)?.lifecycle).toBe('superseded')
  })
})

describe('mayRetire: source is a separate gate from rank', () => {
  it('refuses an assistant decision against a user decision', () => {
    expect(mayRetire({
      declaring: 'decision',
      target: 'decision',
      sameScope: true,
      declaringSource: 'assistant',
      targetSource: 'user',
    })).toMatchObject({ allowed: false, reason: 'insufficient-source-authority' })
  })

  it('allows the symmetric cases', () => {
    expect(mayRetire({
      declaring: 'decision',
      target: 'decision',
      sameScope: true,
      declaringSource: 'assistant',
      targetSource: 'assistant',
    })).toEqual({ allowed: true })
    expect(mayRetire({
      declaring: 'decision',
      target: 'decision',
      sameScope: true,
      declaringSource: 'user',
      targetSource: 'assistant',
    })).toEqual({ allowed: true })
    expect(mayRetire({
      declaring: 'decision',
      target: 'decision',
      sameScope: true,
      declaringSource: 'user',
      targetSource: 'user',
    })).toEqual({ allowed: true })
  })

  it('treats a missing source as unknown and refuses the assistant', () => {
    expect(mayRetire({
      declaring: 'decision',
      target: 'decision',
      sameScope: true,
      declaringSource: 'assistant',
    })).toMatchObject({ allowed: false, reason: 'insufficient-source-authority' })
  })

  it('keeps the rank gate independent of the source gate', () => {
    // Rank still refuses a tool finding against a user constraint, whatever
    // the source says.
    expect(mayRetire({
      declaring: 'empirical',
      target: 'normative',
      sameScope: true,
      declaringSource: 'tool',
      targetSource: 'user',
    })).toMatchObject({ allowed: false, reason: 'insufficient-authority' })
    // Scope still refuses a cross-scope retirement.
    expect(mayRetire({
      declaring: 'decision',
      target: 'decision',
      sameScope: false,
      declaringSource: 'user',
      targetSource: 'assistant',
    })).toMatchObject({ allowed: false, reason: 'cross-scope' })
  })
})
