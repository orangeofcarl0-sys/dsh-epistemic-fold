/**
 * R32-C5: semantic coordinates carry a trustworthy task scope, or admit that
 * they cannot.
 *
 * The writer supplies an optional `scope` (workspace / branch / file / symbol /
 * revision). When present, a stable digest of it joins the state coordinate, so
 * two tasks that both name `timeout` cannot silently supersede each other. When
 * ABSENT, the runtime has no trustworthy task identity to invent: the unscoped
 * coordinate remains shared, and that boundary is asserted here rather than
 * hidden.
 *
 * @module tests/r32-scope
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { applyOps, planCommit } from '../src/semantic/plan.ts'
import { semanticStateKey, validateDeltas } from '../src/semantic/validate.ts'
import { emptyCurrentState, stateKeyText } from '../src/state/state.ts'
import type { FoldCurrentState } from '../src/state/state.ts'

const user = (text: string): Message => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const messages = [
  user('Repository A: the timeout is 30 seconds.'),
  user('Repository B: the timeout is five minutes.'),
]

function constraint(
  statement: string,
  quote: string,
  options: {
    readonly subjectKey?: string
    readonly scope?: Record<string, string>
    readonly supersedes?: readonly string[]
  } = {},
): Record<string, unknown> {
  return {
    kind: 'constraint',
    subjectKey: options.subjectKey ?? 'timeout',
    statement,
    status: 'claimed',
    evidence: [{ quote }],
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
  }
}

function planned(proposed: readonly Record<string, unknown>[], state: FoldCurrentState) {
  const validation = validateDeltas({
    foldedSeqs: [1, 2],
    messages,
    proposed: [...proposed],
  })
  expect(validation.refused).toHaveLength(0)
  const plan = planCommit(validation.accepted, { state })
  return { validation, plan, state: applyOps(state, plan.ops) }
}

describe('R32-C5: scoped semantic coordinates do not collide', () => {
  it('keeps the same subject in two workspaces as two active claims', () => {
    const result = planned([
      constraint('The timeout is 30 seconds.', 'Repository A: the timeout is 30 seconds.', {
        scope: { workspace: 'repo-a' },
      }),
      constraint('The timeout is five minutes.', 'Repository B: the timeout is five minutes.', {
        scope: { workspace: 'repo-b' },
      }),
    ], emptyCurrentState())

    expect(result.validation.accepted).toHaveLength(2)
    const [first, second] = result.validation.accepted
    expect(first?.stateKey).toBeDefined()
    expect(second?.stateKey).toBeDefined()
    expect(stateKeyText(first!.stateKey!)).not.toBe(stateKeyText(second!.stateKey!))
    expect(stateKeyText(first!.stateKey!)).toContain('constraint#')
    expect(first!.stateKey!.property).toBe('timeout')

    const anchors = Object.values(result.state.constraints)
    expect(anchors).toHaveLength(2)
    expect(anchors.map(anchor => anchor.value)).toEqual(expect.arrayContaining([
      'The timeout is 30 seconds.',
      'The timeout is five minutes.',
    ]))
    expect(result.state.retiredCount).toBe(0)
    expect(anchors.every(anchor => anchor.lifecycle === 'active')).toBe(true)
    expect(anchors.map(anchor => anchor.scope?.workspace)).toEqual(expect.arrayContaining(['repo-a', 'repo-b']))
  })

  it('lets a scoped revision supersede only its own coordinate', () => {
    const first = planned([
      constraint('The timeout is 30 seconds.', 'Repository A: the timeout is 30 seconds.', {
        scope: { workspace: 'repo-a' },
      }),
    ], emptyCurrentState())
    const second = planned([
      constraint('The timeout is 30 seconds.', 'Repository A: the timeout is 30 seconds.', {
        scope: { workspace: 'repo-a' },
      }),
      constraint('Repository A: the timeout is 45 seconds after measurement.', 'Repository A: the timeout is 30 seconds.', {
        subjectKey: 'timeout',
        scope: { workspace: 'repo-a' },
      }),
    ], first.state)

    // The second claim is a different statement at the same SCOPED coordinate.
    // It displaces the first (one revision), and nothing in repo-b exists.
    expect(second.state.retiredCount).toBe(1)
    expect(Object.values(second.state.constraints)).toHaveLength(1)
    expect(Object.values(second.state.constraints)[0]?.value)
      .toBe('Repository A: the timeout is 45 seconds after measurement.')
    expect(second.state.constraints[Object.keys(second.state.constraints)[0]!]?.scope?.workspace)
      .toBe('repo-a')
  })

  it('resolves a bare supersede target inside the proposal scope, never another task', () => {
    const base = planned([
      constraint('The timeout is 30 seconds.', 'Repository A: the timeout is 30 seconds.', {
        scope: { workspace: 'repo-a' },
      }),
      constraint('The timeout is five minutes.', 'Repository B: the timeout is five minutes.', {
        scope: { workspace: 'repo-b' },
      }),
    ], emptyCurrentState())
    expect(Object.values(base.state.constraints)).toHaveLength(2)

    const revision = planned([
      constraint('Repository A: the timeout is 45 seconds.', 'Repository A: the timeout is 30 seconds.', {
        subjectKey: 'timeout',
        scope: { workspace: 'repo-a' },
        supersedes: ['timeout'],
      }),
    ], base.state)
    expect(revision.plan.unresolvedTargets).toHaveLength(0)
    // Only repo-a was displaced; repo-b's contract is untouched.
    expect(revision.state.retiredCount).toBe(1)
    expect(Object.values(revision.state.constraints)).toHaveLength(2)
    const values = Object.values(revision.state.constraints).map(anchor => anchor.value)
    expect(values).toContain('Repository A: the timeout is 45 seconds.')
    expect(values).toContain('The timeout is five minutes.')
  })

  it('states the unscoped support boundary: two tasks with no scope still share a coordinate', () => {
    const result = planned([
      constraint('The timeout is 30 seconds.', 'Repository A: the timeout is 30 seconds.'),
      constraint('The timeout is five minutes.', 'Repository B: the timeout is five minutes.'),
    ], emptyCurrentState())

    expect(result.validation.accepted).toHaveLength(2)
    expect(stateKeyText(result.validation.accepted[0]!.stateKey!))
      .toBe(stateKeyText(result.validation.accepted[1]!.stateKey!))
    // This is the documented limitation, not a desired behavior: without a
    // trustworthy task identity the second declare displaces the first.
    expect(Object.values(result.state.constraints)).toHaveLength(1)
    expect(result.state.retiredCount).toBe(1)
  })

  it('keeps the pre-R32 coordinate shape for an unscoped claim', () => {
    expect(semanticStateKey('constraint', 'timeout')).toEqual({
      namespace: 'semantic',
      entity: 'constraint',
      property: 'timeout',
    })
    expect(semanticStateKey('constraint', 'timeout', { workspace: 'repo-a' }))
      .not.toEqual(semanticStateKey('constraint', 'timeout'))
  })
})
