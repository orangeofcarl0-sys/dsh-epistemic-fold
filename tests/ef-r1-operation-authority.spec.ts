/**
 * EF-R1 WP1: operation-level authority closure.
 *
 * ## The defect this certifies
 *
 * The R38 fix authorized the targets a delta NAMED in `supersedes`. It did not
 * authorize the state change the resulting operation would actually perform.
 * A declare at an occupied coordinate replaces the head in the reducer — a real
 * retirement, with the old anchor leaving every hot face — and nothing checked
 * it. Through the production path (`validateDeltas → planCommit → applyOps`),
 * an assistant decision with `supersedes: []` replaced a user decision; so did
 * an assistant decision that named an unrelated target, even while that
 * target's own retirement was correctly refused.
 *
 * Two further paths raised or laundered standing:
 *
 *   - `assistant + tool` evidence labelled the decision `tool`, and the source
 *     rule only refused `assistant`, so the tool citation unlocked the write;
 *   - quoting the user's ORIGINAL instruction let the assistant write its
 *     opposite and record the new anchor as user-sourced.
 *
 * ## What the fix is
 *
 * The planner resolves the EFFECT of every declare against the state it will
 * actually meet (including earlier declares in the same packet), authorizes a
 * displaced head through the same `mayRetire` used for explicit targets, and
 * withholds the whole delta when the effect is unauthorized. Decision origin is
 * derived only from decision-capable producers, and a revision must cite a
 * statement newer than the value it replaces (restating an identical value is
 * allowed — it changes nothing).
 *
 * Every case below drives the real validator, planner and reducer. Historical
 * replay is deliberately NOT re-authorized: recorded ops apply as recorded.
 *
 * @module tests/ef-r1-operation-authority
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { validateDeltas } from '../src/semantic/validate.ts'
import { applyOps, planCommit } from '../src/semantic/plan.ts'
import { mayRetire } from '../src/semantic/retirement.ts'
import { decisionSourceOf } from '../src/state/authority.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import type { Anchor, FoldCurrentState } from '../src/state/state.ts'

const user = (text: string): Message => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const model = (text: string): Message => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'test', model: 'test' },
})
const tool = (text: string, callId = 'call-1'): Message => createToolResultMessage({
  callId: ToolCallId(callId),
  content: [{ type: 'text', text }],
  isError: false,
})
const system = (text: string): Message => createMessage({
  role: 'system',
  content: [{ type: 'text', text }],
  source: { kind: 'system-prompt' },
})

/** Run validate → plan → apply over one message span. */
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

const activeValues = (state: FoldCurrentState): unknown[] =>
  Object.values(state.decisions).filter(anchor => anchor.lifecycle === 'active').map(anchor => anchor.value)

const userDecision = (subjectKey = 'queue', statement = 'Use the in-memory queue.') => {
  const first = fold([
    decision('Use the in-memory queue for now.', statement, { subjectKey }),
  ], [user('Use the in-memory queue for now.')])
  return { state: first.state, anchorId: first.plan.planned[0]!.anchorId! }
}

/** Two user decisions, so a supersedes can name a real unrelated target. */
function twoUserDecisions() {
  const state = fold([
    decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'queue' }),
    decision('Use the file cache for now.', 'Use the file cache.', { subjectKey: 'cache' }),
  ], [
    user('Use the in-memory queue for now.'),
    user('Use the file cache for now.'),
  ])
  return {
    state: state.state,
    queueId: state.plan.planned[0]!.anchorId!,
    cacheId: state.plan.planned[1]!.anchorId!,
  }
}

describe('EF-R1 WP1: implicit state effects are authorized', () => {
  it('refuses an undeclared same-coordinate replacement of a user decision', () => {
    const { state, anchorId } = userDecision()
    const second = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.'),
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ], state)

    expect(second.plan.withheld).toEqual([
      expect.objectContaining({ reason: 'unauthorized-replacement', targets: [anchorId] }),
    ])
    expect(second.plan.refusedRetirements).toEqual([
      expect.objectContaining({ anchorId, reason: 'insufficient-source-authority' }),
    ])
    // No declare was emitted: the assistant value was not written in another
    // coordinate either, because it claimed THIS coordinate.
    expect(second.plan.ops).toEqual([])
    expect(second.state.decisions[anchorId]?.lifecycle).toBe('active')
    expect(activeValues(second.state)).toEqual(['Use the in-memory queue.'])
    expect(second.state.superseded).toEqual({})
  })

  it('refuses an implicit replacement even when the named supersedes is unrelated', () => {
    const { state, queueId, cacheId } = twoUserDecisions()
    const second = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        supersedes: ['cache'],
      }),
    ], [
      user('Use the in-memory queue for now.'),
      user('Use the file cache for now.'),
      model('I decided the durable outbox is better.'),
    ], state)

    // The NAMED target was also refused (assistant vs user), but the point is
    // the UNNAMED same-coordinate effect: it is resolved and withheld.
    expect(second.plan.refusedRetirements.map(entry => entry.anchorId)).toContain(cacheId)
    expect(second.plan.withheld).toEqual([
      expect.objectContaining({ reason: 'unauthorized-replacement', targets: [queueId] }),
    ])
    expect(second.plan.ops).toEqual([])
    expect(second.state.decisions[queueId]?.lifecycle).toBe('active')
    expect(second.state.decisions[cacheId]?.lifecycle).toBe('active')
    expect(activeValues(second.state).sort()).toEqual(['Use the file cache.', 'Use the in-memory queue.'])
  })

  it('refuses a same-packet second declare that would displace an unauthorized head', () => {
    const second = fold([
      // Both at `queue`. The first is user-sourced, the second is not: applying
      // both would let the second silently replace the first.
      decision('Use the in-memory queue for now.', 'Use the in-memory queue.'),
      decision('I decided the durable outbox is better.', 'Use the durable outbox.'),
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ])

    expect(second.validation.accepted).toHaveLength(2)
    expect(second.plan.ops.filter(op => op.op === 'declare')).toHaveLength(1)
    expect(second.plan.withheld).toHaveLength(1)
    expect(second.plan.withheld[0]?.reason).toBe('unauthorized-replacement')
    expect(activeValues(second.state)).toEqual(['Use the in-memory queue.'])
  })

  it('allows an authorized same-coordinate revision and records the supersession link', () => {
    const first = fold([
      decision('I decided the in-memory queue is fine.', 'Use the in-memory queue.'),
    ], [model('I decided the in-memory queue is fine.')])
    const oldId = first.plan.planned[0]!.anchorId!
    const second = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        supersedes: ['previous'],
      }),
    ], [
      model('I decided the in-memory queue is fine.'),
      model('I decided the durable outbox is better.'),
    ], first.state)

    expect(second.plan.withheld).toEqual([])
    expect(second.plan.ops.some(op => op.op === 'declare')).toBe(true)
    expect(Object.values(second.state.superseded).find(anchor => anchor.id === oldId)?.lifecycle).toBe('superseded')
    expect(activeValues(second.state)).toEqual(['Use the durable outbox.'])
  })

  it('does not let an assistant decision retire a system-grounded constraint', () => {
    // A system message grounds normative authority (rank 5), which outranks a
    // decision (4). Different semantic kinds occupy different coordinates, so
    // this can only be an EXPLICIT cross-coordinate retirement; the rank gate
    // must refuse it while still recording the assistant's own claim.
    const first = fold([
      {
        kind: 'constraint',
        subjectKey: 'deploy-gate',
        statement: 'Deploys require a signed release.',
        status: 'claimed',
        evidence: [{ quote: 'Never deploy without a signed release.' }],
      },
    ], [system('Never deploy without a signed release.')])
    const anchorId = first.plan.planned[0]!.anchorId!
    const second = fold([
      decision('I decided the release gate is unnecessary.', 'Skip the signed-release gate.', {
        subjectKey: 'release-gate',
        supersedes: [anchorId],
      }),
    ], [system('Never deploy without a signed release.'), model('I decided the release gate is unnecessary.')], first.state)

    expect(second.plan.refusedRetirements[0]?.reason).toBe('insufficient-authority')
    expect(second.plan.ops.some(op => op.op === 'retire')).toBe(false)
    expect(second.state.constraints[anchorId]?.lifecycle).toBe('active')
    expect(Object.values(second.state.decisions)).toHaveLength(1)
  })

  it('allows the user to revise the user decision with a newer statement', () => {
    const { state, anchorId } = userDecision()
    const second = fold([
      decision('Use the durable outbox instead.', 'Use the durable outbox.', {
        supersedes: ['previous'],
      }),
    ], [
      user('Use the in-memory queue for now.'),
      user('Use the durable outbox instead.'),
    ], state)

    expect(second.plan.withheld).toEqual([])
    expect(second.state.decisions[anchorId]).toBeUndefined()
    expect(Object.values(second.state.superseded).find(anchor => anchor.id === anchorId)?.lifecycle).toBe('superseded')
    const active = Object.values(second.state.decisions).find(anchor => anchor.lifecycle === 'active')!
    expect(active.value).toBe('Use the durable outbox.')
    expect(active.sourceAuthority).toBe('user')
  })
})

describe('EF-R1 WP1: decision origin and newer evidence', () => {
  it('does not let a tool result raise an assistant decision to tool standing', () => {
    const { state } = userDecision()
    const second = fold([
      {
        kind: 'decision',
        subjectKey: 'queue',
        statement: 'Use the durable outbox.',
        status: 'claimed',
        evidence: [
          { quote: 'I decided the durable outbox is better.' },
          { quote: 'outbox probe returned 28 events' },
        ],
        supersedes: ['previous'],
      },
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
      tool('outbox probe returned 28 events'),
    ], state)

    expect(second.validation.accepted[0]?.sourceAuthority).toBe('assistant')
    expect(second.plan.withheld[0]?.reason).toBe('unauthorized-replacement')
    expect(second.plan.refusedRetirements[0]?.reason).toBe('insufficient-source-authority')
    expect(activeValues(second.state)).toEqual(['Use the in-memory queue.'])
  })

  it('does not accept the user’s OLD statement as authority for its opposite', () => {
    const { state } = userDecision()
    const second = fold([
      {
        kind: 'decision',
        subjectKey: 'queue',
        statement: 'Use the durable outbox.',
        status: 'claimed',
        // A real user quote — and the very message the current decision came
        // from. It says the OPPOSITE of the proposal, and it is not newer.
        evidence: [{ quote: 'Use the in-memory queue for now.' }],
        supersedes: ['previous'],
      },
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ], state)

    expect(second.validation.accepted[0]?.sourceAuthority).toBe('user')
    expect(second.plan.withheld[0]?.reason).toBe('unauthorized-replacement')
    expect(second.plan.refusedRetirements[0]?.reason).toBe('stale-source')
    expect(activeValues(second.state)).toEqual(['Use the in-memory queue.'])
  })

  it('allows a user revision grounded in a NEWER user statement', () => {
    const { state } = userDecision()
    const second = fold([
      decision('Use the durable outbox instead.', 'Use the durable outbox.', {
        supersedes: ['previous'],
      }),
    ], [
      user('Use the in-memory queue for now.'),
      model('I am reviewing the queue decision.'),
      user('Use the durable outbox instead.'),
    ], state)

    expect(second.plan.withheld).toEqual([])
    expect(activeValues(second.state)).toEqual(['Use the durable outbox.'])
    expect(Object.values(second.state.decisions).find(anchor => anchor.lifecycle === 'active')?.sourceAuthority)
      .toBe('user')
  })

  it('allows a same-value restatement from the same statement (it changes nothing)', () => {
    // Consolidating an existing decision at another coordinate quotes the same
    // message. It is not a revision of WHAT was decided, so the newer-evidence
    // rule would be a false refusal here.
    const first = fold([
      decision('Switch to the durable outbox.', 'Use the durable outbox.', { subjectKey: 'outbox' }),
    ], [user('Switch to the durable outbox.')])
    const oldId = first.plan.planned[0]!.anchorId!
    const second = fold([
      decision('Switch to the durable outbox.', 'Use the durable outbox.', {
        subjectKey: 'final-decision',
        supersedes: ['outbox'],
      }),
    ], [user('Switch to the durable outbox.')], first.state)

    expect(second.plan.withheld).toEqual([])
    expect(second.plan.ops.filter(op => op.op === 'retire')).toHaveLength(1)
    expect(second.state.decisions[oldId]).toBeUndefined()
    expect(activeValues(second.state)).toEqual(['Use the durable outbox.'])
  })
})

describe('EF-R1 WP1: historical state and replay', () => {
  it('refuses an assistant revision of a historical anchor with no source', () => {
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
    const second = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        supersedes: ['previous'],
      }),
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ], state)

    expect(second.plan.withheld[0]?.reason).toBe('unauthorized-replacement')
    expect(second.plan.refusedRetirements[0]?.reason).toBe('insufficient-source-authority')
    expect(second.state.decisions['semantic-historical']?.lifecycle).toBe('active')
  })

  it('keeps historical replay mechanical: a recorded op applies even when a NEW plan would refuse it', () => {
    const historical: Anchor = {
      id: 'semantic-historical',
      kind: 'decision',
      stateKey: { namespace: 'semantic', entity: 'decision', property: 'queue' },
      value: 'Use the in-memory queue.',
      authority: 'decision',
      lifecycle: 'active',
      sourceRefs: [{ seq: SessionSeq(1) }],
    }
    const base = applyOps(emptyCurrentState(), [{ op: 'declare', anchor: historical }])
    // What an OLD planner might have recorded: the assistant declare replaces
    // the user-origin anchor in place.
    const recorded = [{
      op: 'declare' as const,
      anchor: {
        id: 'semantic-recorded',
        kind: 'decision' as const,
        stateKey: { namespace: 'semantic', entity: 'decision', property: 'queue' },
        value: 'Use the durable outbox.',
        authority: 'decision' as const,
        sourceAuthority: 'assistant' as const,
        lifecycle: 'active' as const,
        sourceRefs: [{ seq: SessionSeq(2) }],
      },
    }]
    const replayed = applyOps(base, recorded)
    expect(replayed).toEqual(applyOps(base, recorded))
    expect(replayed.decisions['semantic-historical']).toBeUndefined()
    expect(Object.values(replayed.superseded).find(anchor => anchor.id === 'semantic-historical')?.lifecycle)
      .toBe('superseded')

    // The SAME proposal planned today contributes no operation.
    const today = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', {
        supersedes: ['previous'],
      }),
    ], [
      user('Use the in-memory queue for now.'),
      model('I decided the durable outbox is better.'),
    ], base)
    expect(today.plan.ops).toEqual([])
    expect(applyOps(base, today.plan.ops)).toEqual(base)
  })
})

describe('EF-R1 WP1: authorized flexibility still works', () => {
  it('applies an explicitly authorized cross-coordinate revision with a newer user statement', () => {
    const first = fold([
      decision('I decided the durable outbox is better.', 'Use the durable outbox.', { subjectKey: 'outbox' }),
      decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'queue' }),
    ], [
      model('I decided the durable outbox is better.'),
      user('Use the in-memory queue for now.'),
    ])
    const outboxId = first.plan.planned[0]!.anchorId!
    const queueId = first.plan.planned[1]!.anchorId!

    const second = fold([
      decision('Use the in-memory queue instead.', 'Keep the in-memory queue and retire the outbox.', {
        subjectKey: 'queue',
        supersedes: ['outbox'],
      }),
    ], [
      model('I decided the durable outbox is better.'),
      user('Use the in-memory queue for now.'),
      user('Use the in-memory queue instead.'),
    ], first.state)

    expect(second.plan.withheld).toEqual([])
    expect(second.plan.refusedRetirements).toEqual([])
    // The explicit cross-coordinate retire AND the implicit same-coordinate
    // replacement both ran, and both were authorized.
    expect(second.state.decisions[outboxId]).toBeUndefined()
    expect(second.state.decisions[queueId]).toBeUndefined()
    expect(activeValues(second.state)).toEqual(['Keep the in-memory queue and retire the outbox.'])
  })
})

describe('EF-R1 WP1: mayRetire policy units', () => {
  it('refuses a decision revision whose evidence is not newer', () => {
    expect(mayRetire({
      declaring: 'decision',
      target: 'decision',
      sameScope: true,
      declaringSource: 'user',
      targetSource: 'user',
      declaringLatestSeq: 5,
      targetLatestSeq: 5,
      declaringValue: 'Use the durable outbox.',
      targetValue: 'Use the in-memory queue.',
    })).toMatchObject({ allowed: false, reason: 'stale-source' })
  })

  it('allows the same value at the same evidence position', () => {
    expect(mayRetire({
      declaring: 'decision',
      target: 'decision',
      sameScope: true,
      declaringSource: 'user',
      targetSource: 'user',
      declaringLatestSeq: 5,
      targetLatestSeq: 5,
      declaringValue: 'Use the durable outbox.',
      targetValue: 'Use the durable outbox.',
    })).toEqual({ allowed: true })
  })

  it('derives decision origin only from decision-capable producers', () => {
    expect(decisionSourceOf(['assistant/message', 'tool/result'])).toBe('assistant')
    expect(decisionSourceOf(['user/message', 'tool/result'])).toBe('user')
    expect(decisionSourceOf(['tool/result'])).toBe('unknown')
    expect(decisionSourceOf(['system/message'])).toBe('unknown')
  })
})
