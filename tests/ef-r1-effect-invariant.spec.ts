/**
 * EF-R1 WP1/WP5: the operation-effect invariant.
 *
 * The 16-case matrix pins the paths that were found. This file pins the
 * PROPERTY those cases are instances of:
 *
 *   a declare may displace a head only when `mayRetire` allows that pair.
 *
 * It enumerates the authority/source matrix rather than sampling it, and it
 * does the same through the public `anchor-service` writer. A future change
 * that adds a new declaring domain or source cannot silently acquire a
 * state-changing effect: the effect and the policy are compared directly.
 *
 * @module tests/ef-r1-effect-invariant
 */

import { describe, expect, it } from 'vitest'
import {
  createMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { applyOps, planCommit } from '../src/semantic/plan.ts'
import { mayRetire } from '../src/semantic/retirement.ts'
import { createAnchorService } from '../src/state/anchor-service.ts'
import { emptyCurrentState, stateKeyText } from '../src/state/state.ts'
import type { Anchor, FoldCurrentState, StateKey } from '../src/state/state.ts'
import type { SourceAuthority } from '../src/state/authority.ts'
import type { AcceptedDelta } from '../src/semantic/types.ts'

const KEY: StateKey = { namespace: 'semantic', entity: 'decision', property: 'queue' }
const KEY_TEXT = stateKeyText(KEY)

const AUTHORITIES = ['normative', 'decision', 'empirical', 'procedural', 'hypothesis', 'narrative'] as const
const SOURCES: readonly SourceAuthority[] = ['user', 'system', 'tool', 'assistant', 'unknown']
const TARGETS = [
  { authority: 'decision', source: 'user' },
  { authority: 'decision', source: 'assistant' },
  { authority: 'decision', source: 'unknown' },
  { authority: 'normative', source: 'user' },
  { authority: 'empirical', source: 'tool' },
  { authority: 'hypothesis', source: 'assistant' },
] as const

const user = (text: string): UserMessage => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const model = (text: string): AssistantMessage => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'test', model: 'test' },
}) as AssistantMessage

function targetState(authority: Anchor['authority'], source: SourceAuthority): FoldCurrentState {
  const anchor: Anchor = {
    id: 'target-1',
    kind: 'decision',
    stateKey: KEY,
    value: 'old',
    authority,
    sourceAuthority: source,
    lifecycle: 'active',
    sourceRefs: [{ seq: 1 as never }],
  }
  return applyOps(emptyCurrentState(), [{ op: 'declare', anchor }])
}

function delta(authority: AcceptedDelta['authority'], source: SourceAuthority): AcceptedDelta {
  return {
    index: 0,
    deltaId: `${authority}-${source}`.padEnd(64, '0').slice(0, 64),
    kind: 'decision',
    subjectKey: 'queue',
    statement: 'new',
    status: 'claimed',
    grantedStatus: 'claimed',
    evidence: [{ seq: 10, messageDigest: 'm', quote: 'new' }],
    authority,
    sourceAuthority: source,
    latestDecisionSeq: 10,
    anchorKind: 'decision',
    stateKey: KEY,
    supersedes: [],
    dependsOn: [],
    rulesOut: [],
  }
}

describe('EF-R1 invariant: a displaced head is always an authorized retirement', () => {
  it('holds for every declaring authority/source against every target', () => {
    let checked = 0
    for (const declaring of AUTHORITIES) {
      for (const source of SOURCES) {
        for (const target of TARGETS) {
          const state = targetState(target.authority, target.source)
          const plan = planCommit([delta(declaring, source)], { state })
          const next = applyOps(state, plan.ops)
          const head = next.stateHeads[KEY_TEXT]
          const replaced = head !== undefined && head.id !== 'target-1'
          const authorized = mayRetire({
            declaring,
            target: target.authority,
            sameScope: true,
            declaringSource: source,
            targetSource: target.source,
            declaringLatestSeq: 10,
            targetLatestSeq: 1,
            declaringValue: 'new',
            targetValue: 'old',
          }).allowed

          expect(
            replaced,
            `${declaring}/${source} -> ${target.authority}/${target.source}: `
            + `replaced=${replaced} but mayRetire=${authorized ? 'allowed' : 'refused'}`,
          ).toBe(authorized)
          if (!replaced) {
            expect(next.stateHeads[KEY_TEXT]?.id, 'the old head survives a withheld declare').toBe('target-1')
            expect(plan.withheld.length, 'a refused replacement must be reported').toBe(1)
          } else {
            expect(plan.withheld, 'an authorized replacement is not withheld').toEqual([])
          }
          checked += 1
        }
      }
    }
    expect(checked).toBe(AUTHORITIES.length * SOURCES.length * TARGETS.length)
  })

  it('the public anchor-service writer enforces the same effect check', () => {
    const session = Session.create(SessionId('ef-r1-service-invariant'))
    session.append('turn/start', { turn: 1 })
    const firstUser = session.append('user/message', user('Use the in-memory queue.'), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'invariant', model: 'invariant' } },
      reason: 'initial',
    })
    const assistant = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: model('I decided the durable outbox is better.'),
    }, { surfaceOp: 'append' })

    const anchors = createAnchorService()
    anchors.declare(session, {
      kind: 'decision',
      stateKey: KEY,
      value: 'Use the in-memory queue.',
      authority: 'decision',
      sourceAuthority: 'user',
      sourceRefs: [{ seq: firstUser.seq as never }],
    })

    // An assistant decision cannot replace it.
    expect(() => anchors.declare(session, {
      kind: 'decision',
      stateKey: KEY,
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceAuthority: 'assistant',
      sourceRefs: [{ seq: assistant.seq as never }],
    })).toThrow(/insufficient-source-authority/u)

    // A NEWER user statement can.
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const secondUser = session.append('user/message', user('Use the durable outbox instead.'), { surfaceOp: 'append' })
    expect(() => anchors.declare(session, {
      kind: 'decision',
      stateKey: KEY,
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceAuthority: 'user',
      sourceRefs: [{ seq: secondUser.seq as never }],
    })).not.toThrow()
  })
})
