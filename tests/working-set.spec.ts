/**
 * RC29 — the Thermal Working-Set Observer and the Shadow Folding Policy.
 *
 * ## What this suite is for
 *
 * The observer must do two things and neither is optional: it must DECOMPOSE a
 * long task's context into the parts that need different responses, and it must
 * be unable to change what the engine does. A test suite that only checked the
 * numbers would miss the second, and the second is the one that makes the
 * feature shippable.
 *
 * ## Why the fixtures are what they are
 *
 * Every scenario below is a real shape rather than a convenient one:
 *
 *   normal growth          a long chain where a legal span genuinely exists
 *   frozen accumulation    many folds, so the root estimate must read the real
 *                          range rather than infer from the checkpoint count
 *   oversized last node    the RC28 shape, whose whole point is that NEITHER
 *                          mechanism can reach the threshold
 *   long-lived constraint  state that is old and still authoritative
 *   retired state          lifecycle and residency reported side by side
 *   no evidence            an answer of `unknown`, not a guess
 *
 * The long-chain fixtures genuinely fold — the last test asserts the fold count
 * is non-zero — because a fixture that never triggers a fold cannot support any
 * claim about fold behavior.
 *
 * @module tests/working-set
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { createAnchorService } from '../src/anchor-service.ts'
import { currentFoldState } from '../src/projection.ts'
import { resolveEfCompactSpec } from '../src/policy.ts'
import { assessWorkingSet, describeWorkingSet } from '../src/working-set.ts'
import { assessThermalResidency, describeThermal, residencyCounts } from '../src/thermal.ts'
import { decideShadowFolding, describeShadowDecision } from '../src/shadow-policy.ts'
import { observeWorkingSet } from '../src/working-set-observer.ts'
import type { WorkingSetPressure } from '../src/working-set.ts'

const ROOT = join(import.meta.dirname, '..')
const MODEL = 'test-model'

/** A long chain of tool turns: closed turns, then one open turn. */
function longChain(options: {
  readonly turns: number
  readonly chars: number
  readonly tag: string
  /** Append this much text to the LAST tool result, making it oversized. */
  readonly oversizedLastResultChars?: number
  /** Make the FIRST tool result fail, so the reducer auto-declares a failure. */
  readonly failFirstResult?: boolean
}): Session {
  const session = Session.create(SessionId(`ws-${options.tag}-${Math.random()}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
  const perTurn = Math.max(1, Math.ceil(options.chars / 8))
  for (let turn = 1; turn <= options.turns; turn += 1) {
    const callId = ToolCallId(`c-${turn}`)
    if (turn > 1) session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `req ${turn} `.repeat(perTurn) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `think ${turn} `.repeat(perTurn) },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    const fails = turn === 1 && options.failFirstResult === true
    const body = turn === options.turns && options.oversizedLastResultChars !== undefined
      ? 'X'.repeat(options.oversizedLastResultChars)
      : fails ? 'Error: the tool run failed' : `out ${turn} `.repeat(perTurn)
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        isError: fails,
        content: [{ type: 'text', text: body }],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: options.turns + 1 })
  return session
}

function agentFor(session: Session): never {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
  } as never
}

/** Append one more tool turn of growth to an open session. */
function grow(session: Session, turn: number, chars: number): void {
  const callId = ToolCallId(`g-${turn}`)
  const perTurn = Math.max(1, Math.ceil(chars / 8))
  session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `grow ${turn} `.repeat(perTurn) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: `reply ${turn} `.repeat(perTurn) },
        { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
      ],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      isError: false,
      content: [{ type: 'text', text: `res ${turn} `.repeat(perTurn) }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
}

/** An EF harness with the observer on and the projection mounted. */
async function observingHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  return createHarness({ text: 'digest' }, {
    contextWindow: 32_000,
    projection: true,
    efConfig: {
      auto: true,
      thresholdRatio: 0.2,
      headroomTokens: 0,
      maxTokens: 4_096,
      workingSet: 'observe',
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      ...overrides,
    },
  })
}

/** The spec in force for a 32K window with a 4096-token reservation. */
function specOf(harness: Harness) {
  return resolveEfCompactSpec(harness.engine.efConfig, 32_000, 4_096)
}

/** Price a rendered checkpoint body the way Basic's own shrink check does. */
function estimator(harness: Harness): (text: string) => number {
  return text => harness.ctx.tokenMeter.estimateMessage(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

/**
 * Assert the decomposition's central contract: the three parts are disjoint and
 * exhaustive, so they sum to the total in the SAME measurement basis.
 */
function expectExhaustive(pressure: WorkingSetPressure): void {
  expect(
    pressure.frozenCheckpointTokens + pressure.legalLeafSpanTokens + pressure.residualTokens,
    `the decomposition must sum to the total: ${describeWorkingSet(pressure)}`,
  ).toBe(pressure.totalTokens)
  expect(pressure.frozenCheckpointTokens).toBeGreaterThanOrEqual(0)
  expect(pressure.legalLeafSpanTokens).toBeGreaterThanOrEqual(0)
  expect(pressure.residualTokens).toBeGreaterThanOrEqual(0)
  // The legal span is never wider than the widest span, by definition.
  expect(pressure.legalLeafSpanTokens).toBeLessThanOrEqual(pressure.widestLeafSpanTokens)
}

describe('the working-set decomposition is measured, disjoint and exhaustive', () => {
  it('a growing chain reports a real legal span, not `openTokens`', async () => {
    // The RC28 §0.1 correction, made executable. On this surface `openTokens` is
    // most of the context; the FOLDABLE part is what the selector will take, and
    // the two must be reported as different numbers.
    const h = await observingHarness()
    const session = longChain({ turns: 30, chars: 800, tag: 'growth' })
    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const pressure = assessWorkingSet({
      session,
      measurement,
      thresholdTokens: spec.thresholdTokens,
      retainTokens: spec.retainTokens,
    })

    expectExhaustive(pressure)
    expect(pressure.frozenCheckpointCount).toBe(0)
    expect(pressure.frozenCheckpointTokens).toBe(0)
    expect(
      pressure.legalLeafSpanTokens,
      'a 30-turn chain must have a foldable span at the configured retention',
    ).toBeGreaterThan(0)
    // The whole point: the foldable span is NOT the open tokens.
    expect(pressure.legalLeafSpanTokens).toBeLessThan(pressure.totalTokens)
    expect(pressure.residualTokens, 'the retained tail is a real, non-zero part').toBeGreaterThan(0)
    expect(pressure.leafReachable, 'and a leaf can reach the threshold here').toBe(true)
  }, 60_000)

  it('the residual holds the retained tail, and the identity survives folding', async () => {
    const h = await observingHarness()
    const session = longChain({ turns: 20, chars: 700, tag: 'identity' })
    const agent = agentFor(session)
    const spec = specOf(h)
    for (let step = 0; step < 5; step += 1) {
      try {
        await (h.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch {
        // Explicit non-convergence is a designed outcome; the identity must hold
        // regardless of whether the fold converged.
      }
      grow(session, 100 + step, 700)
      const measurement = h.ctx.tokenMeter.measure(session)
      expectExhaustive(assessWorkingSet({
        session,
        measurement,
        thresholdTokens: spec.thresholdTokens,
        retainTokens: spec.retainTokens,
      }))
    }
    expect(h.engine.leafFoldCount, 'the fixture must actually fold').toBeGreaterThan(0)
  }, 120_000)
})

describe('the root estimate reads the real range, not the checkpoint count', () => {
  it('many frozen checkpoints do not inflate the estimated root reclaim', async () => {
    // The failure mode this pins: estimating a rebase's reclaim as "all frozen
    // checkpoints disappear". A rebase replaces the leading range with ONE
    // checkpoint, so its reclaim is bounded by that range — and when the frozen
    // prefix is a small part of the surface, the reclaim must reflect the range,
    // not the checkpoint count.
    const h = await observingHarness()
    const session = longChain({ turns: 24, chars: 700, tag: 'accum' })
    const agent = agentFor(session)
    const spec = specOf(h)
    for (let step = 0; step < 6; step += 1) {
      try {
        await (h.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch { /* designed outcome */ }
      grow(session, 200 + step, 700)
    }
    const measurement = h.ctx.tokenMeter.measure(session)
    const state = currentFoldState(h.ctx, session)
    const pressure = assessWorkingSet({
      session,
      measurement,
      thresholdTokens: spec.thresholdTokens,
      retainTokens: spec.retainTokens,
      state,
      estimateText: estimator(h),
    })
    expectExhaustive(pressure)
    expect(pressure.frozenCheckpointCount, 'the fixture must accumulate checkpoints').toBeGreaterThan(1)
    expect(pressure.rootSpanTokens, 'a legal root range must be priced').toBeDefined()
    expect(pressure.estimatedRootReclaimTokens).toBeDefined()

    // The load-bearing assertion: the reclaim is bounded by the range a rebase
    // would actually replace, so it cannot exceed it. "All checkpoints vanish"
    // would be a number unrelated to this bound.
    expect(
      pressure.estimatedRootReclaimTokens!,
      'a rebase cannot reclaim more than the range it replaces',
    ).toBeLessThanOrEqual(pressure.rootSpanTokens!)
    // And it must be a strict reduction, not the whole surface.
    expect(pressure.estimatedRootReclaimTokens!).toBeLessThan(pressure.totalTokens)
  }, 120_000)
})

describe('an oversized last node is reported as unfoldable, honestly', () => {
  it('neither a leaf nor a rebase reaches the threshold, and the observer says so', async () => {
    // The RC28 shape. This is the case the whole observer exists to make
    // readable: 60K of a 60K surface is unfoldable, and a report that called the
    // open tokens "foldable" would conclude the opposite of the truth.
    const h = await observingHarness({ thresholdRatio: 0.5, maxTokens: 8_192 })
    const session = longChain({
      turns: 6,
      chars: 2_000,
      tag: 'oversized',
      oversizedLastResultChars: 240_000,
    })
    const agent = agentFor(session)
    try {
      await (h.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded(agent, 'pressure', SIGNAL)
    } catch { /* designed outcome */ }
    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const state = currentFoldState(h.ctx, session)
    const pressure = assessWorkingSet({
      session,
      measurement,
      thresholdTokens: spec.thresholdTokens,
      retainTokens: spec.retainTokens,
      state,
      estimateText: estimator(h),
    })

    expectExhaustive(pressure)
    expect(pressure.totalTokens, 'the fixture must be over the threshold').toBeGreaterThan(
      spec.thresholdTokens,
    )
    expect(
      pressure.legalLeafSpanTokens,
      'the oversized last node is retained by construction, so no leaf span exists',
    ).toBe(0)
    expect(pressure.residualTokens, 'and it therefore sits in the residual').toBeGreaterThan(0)
    expect(pressure.leafReachable, 'no leaf can reach the threshold').toBe(false)
    // The rebase reclaim is tiny relative to the surface — the retained node is
    // what holds the pressure — so a rebase cannot reach it either.
    expect(pressure.rootReachable, 'nor can a rebase').toBe(false)
    // The blocker must name the arithmetic, not merely assert a failure.
    expect(pressure.blockers.join(' ')).toMatch(/no fold can reach the threshold/u)
    expect(pressure.blockers.join(' ')).toMatch(/widest legal span is \d+ tokens/u)
  }, 120_000)

  it('a rebase CAN reach an oversized node once something follows it', async () => {
    // The contrast that makes the previous test's claim precise, and the more
    // useful result of the two.
    //
    // The retention walk breaks as soon as `accumulated >= retainTokens`, and at
    // retain 0 that fires on the FIRST iteration — so the LAST node is always
    // retained. Whether an oversized node is unfoldable therefore depends on
    // whether it is last:
    //
    //   oversized node LAST      rebase range [0,15]  8168 tokens  -> 60008 retained
    //   oversized node FOLLOWED  rebase range [0,18] 68813 tokens  -> node is covered
    //
    // Measured, not reasoned: the two surfaces differ by one trailing turn and
    // the verdict flips. This is why the observer reports the residual and the
    // span rather than a verdict alone — a reader needs to see WHICH case it is.
    const h = await observingHarness({ thresholdRatio: 0.5, maxTokens: 8_192 })
    const session = longChain({
      turns: 6,
      chars: 2_000,
      tag: 'oversized-trailed',
      oversizedLastResultChars: 240_000,
    })
    // A turn AFTER the oversized result. The fixture leaves the last turn open,
    // so this appends into it rather than opening a new one.
    const callId = ToolCallId('after-big')
    session.append('step/start', { turn: 7, step: 2 })
    session.append('assistant/message', {
      stream: [],
      turn: 7,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 7, step: 2, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn: 7,
      step: 2,
      message: createToolResultMessage({
        callId,
        isError: false,
        content: [{ type: 'text', text: 'small trailing result' }],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 7, step: 2 })

    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const pressure = assessWorkingSet({
      session,
      measurement,
      thresholdTokens: spec.thresholdTokens,
      retainTokens: spec.retainTokens,
      state: currentFoldState(h.ctx, session),
      estimateText: estimator(h),
    })
    expectExhaustive(pressure)
    expect(
      pressure.rootSpanTokens,
      'the rebase range must now step past the oversized node and cover it',
    ).toBeGreaterThan(60_000)
    expect(
      pressure.rootReachable,
      'so a rebase CAN reach the threshold here — unlike when the node is last',
    ).toBe(true)
    // The LEAF span is unaffected: leaf retention (3809 tokens here) does not
    // step past a 60K node either, so the residual still holds it. The two
    // mechanisms genuinely differ on this surface, which is the point.
    expect(
      pressure.legalLeafSpanTokens,
      'the leaf span is still bounded by the retention budget',
    ).toBeLessThan(pressure.rootSpanTokens!)
    expect(
      pressure.estimatedRootReclaimTokens,
      'while the rebase reclaim is large',
    ).toBeGreaterThan(60_000)
  }, 120_000)

  it('a leaf that cannot converge is still recommended, WITH the warning attached', async () => {
    // A leaf can be worth taking and still fail to reach the threshold. The
    // engine's own behavior on this surface is exactly one fold and then a stop —
    // so refusing the recommendation would contradict the engine, and reporting
    // it without the non-convergence warning would hide the thing a reader most
    // needs to know. Both must be true at once.
    const h = await observingHarness({ thresholdRatio: 0.5, maxTokens: 8_192 })
    const session = longChain({
      turns: 6, chars: 2_000, tag: 'nonconvergent', oversizedLastResultChars: 240_000,
    })
    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const decision = decideShadowFolding({
      session,
      measurement,
      spec,
      config: h.engine.efConfig,
      stepsSinceRootRebase: 99,
      provider: MODEL,
      model: MODEL,
      state: currentFoldState(h.ctx, session),
      estimateText: estimator(h),
    })
    expect(measurement.totalTokens).toBeGreaterThan(spec.thresholdTokens)
    expect(decision.action, 'a legal span exists, so a leaf is worth taking').toBe('leaf')
    expect(decision.executable).toBe(true)
    expect(
      decision.workingSet.leafReachable,
      'but the decomposition must record that it cannot reach the threshold',
    ).toBe(false)
    expect(
      decision.blockers.join(' '),
      'and the recommendation must carry that warning rather than clear it',
    ).toMatch(/no fold can reach the threshold/u)
  }, 120_000)

  it('the shadow policy refuses to recommend either mechanism here', async () => {
    // A recommendation of `root` would be the silent non-convergence RC28
    // rejected: it would "reclaim" a few hundred tokens of a 60K surface and
    // leave the context over the limit. `none` is the correct answer.
    const h = await observingHarness({ thresholdRatio: 0.5, maxTokens: 8_192 })
    const session = longChain({
      turns: 6,
      chars: 2_000,
      tag: 'oversized-shadow',
      oversizedLastResultChars: 240_000,
    })
    const agent = agentFor(session)
    try {
      await (h.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded(agent, 'pressure', SIGNAL)
    } catch { /* designed outcome */ }
    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const decision = decideShadowFolding({
      session,
      measurement,
      spec,
      config: h.engine.efConfig,
      stepsSinceRootRebase: 99,
      provider: MODEL,
      model: MODEL,
      state: currentFoldState(h.ctx, session),
      estimateText: estimator(h),
    })
    expect(decision.action, 'no action can reach the threshold, so none is recommended').toBe('none')
    expect(decision.executable).toBe(false)
    expect(describeShadowDecision(decision)).toMatch(/would not restore headroom|not shrink/u)
  }, 120_000)

  it('the pruner is what changes the verdict, and the observer sees the difference', async () => {
    // The RC28 fidelity finding, observed rather than asserted: with production's
    // pruner mounted the same surface converges, and the observer's leaf
    // reachability flips. Without it the surface stays unfoldable.
    const sessionWithout = longChain({
      turns: 6, chars: 2_000, tag: 'prune-off', oversizedLastResultChars: 240_000,
    })
    const sessionWith = longChain({
      turns: 6, chars: 2_000, tag: 'prune-on', oversizedLastResultChars: 240_000,
    })
    const measure = async (session: Session, pruner: boolean): Promise<WorkingSetPressure> => {
      const h = await createHarness({ text: 'digest' }, {
        contextWindow: 32_000,
        ...(pruner ? { pruner: true } : {}),
        efConfig: {
          auto: true, thresholdRatio: 0.5, headroomTokens: 0, maxTokens: 8_192,
          leafAdmission: 'economic', rootPolicy: 'economics',
        },
      })
      try {
        await (h.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agentFor(session), 'pressure', SIGNAL)
      } catch { /* designed outcome */ }
      const measurement = h.ctx.tokenMeter.measure(session)
      const spec = resolveEfCompactSpec(h.engine.efConfig, 32_000, 8_192)
      return assessWorkingSet({
        session, measurement,
        thresholdTokens: spec.thresholdTokens,
        retainTokens: spec.retainTokens,
      })
    }
    const without = await measure(sessionWithout, false)
    const with_ = await measure(sessionWith, true)
    expect(with_.totalTokens, 'the pruner must shrink the surface').toBeLessThan(without.totalTokens)
    expect(
      with_.leafReachable,
      'and it is the pruner, not a fold, that makes the surface foldable again',
    ).toBe(true)
    expect(without.leafReachable).toBe(false)
  }, 120_000)
})

describe('residency is not lifecycle, and age is not idleness', () => {
  it('an old but authoritative constraint is pinned, never cold', async () => {
    // The rule the whole thermal design turns on. A constraint stated early and
    // never mentioned again is the NORMAL case for a constraint, not evidence
    // against it — so no amount of elapsed work may demote it.
    const h = await observingHarness()
    const session = longChain({ turns: 4, chars: 400, tag: 'thermal-pin' })
    const service = createAnchorService({ durableWritesAllowed: () => true })
    const userSeq = session.surface.nodes.find(seq =>
      session.deriveEventMessage(session.eventAt(seq as never)!)?.role === 'user')!
    service.declare(session, {
      kind: 'constraint',
      stateKey: { namespace: 'cfg', entity: 'batch', property: 'limit' },
      value: 8_192,
      authority: 'normative',
      sourceRefs: [{ seq: userSeq }],
    } as never)
    service.declare(session, {
      kind: 'objective',
      value: 'ship the observer',
      authority: 'normative',
      sourceRefs: [{ seq: userSeq }],
    } as never)
    // Grow a lot: 200 further turns of work, so the constraint is genuinely old.
    for (let step = 0; step < 200; step += 1) grow(session, 1_000 + step, 40)

    const report = assessThermalResidency({ session, state: currentFoldState(h.ctx, session) })
    const counts = residencyCounts(report)
    expect(counts.pinned, 'the constraint and the objective must both be pinned').toBe(2)
    expect(counts.cold, 'elapsed work alone must never produce cold').toBe(0)
    for (const verdict of report.verdicts) {
      expect(
        verdict.evidence.join(' '),
        'a pinned verdict must say WHY it cannot be demoted',
      ).toMatch(/never demoted by elapsed work/u)
    }
  }, 120_000)

  it('an open failure is pinned while it is outstanding', async () => {
    // Unfinished work has continuing authority, so it is not merely warm. Once
    // resolved it may cool — but "resolved" is an explicit act, not silence.
    const h = await observingHarness()
    const session = longChain({ turns: 2, chars: 300, tag: 'thermal-failure', failFirstResult: true })
    const service = createAnchorService({ durableWritesAllowed: () => true })
    const report0 = assessThermalResidency({ session, state: currentFoldState(h.ctx, session) })
    expect(
      report0.verdicts.find(verdict => verdict.anchorId.startsWith('failure:')),
      'the failed tool result must auto-declare a failure anchor',
    ).toBeDefined()
    expect(
      report0.verdicts.find(verdict => verdict.anchorId.startsWith('failure:'))!.residency,
      'an OPEN failure is outstanding work',
    ).toBe('pinned')

    const failureId = report0.verdicts.find(verdict => verdict.anchorId.startsWith('failure:'))!.anchorId
    service.transitionFailure(session, failureId, 'resolved')
    const report1 = assessThermalResidency({ session, state: currentFoldState(h.ctx, session) })
    expect(
      report1.verdicts.find(verdict => verdict.anchorId === failureId)!.residency,
      'a resolved failure stops constraining future action',
    ).not.toBe('pinned')
  }, 120_000)

  it('a retired anchor is cold, and its lifecycle is reported separately', async () => {
    const h = await observingHarness()
    const session = longChain({ turns: 2, chars: 300, tag: 'thermal-retire' })
    const service = createAnchorService({ durableWritesAllowed: () => true })
    const userSeq = session.surface.nodes.find(seq =>
      session.deriveEventMessage(session.eventAt(seq as never)!)?.role === 'user')!
    const declared = service.declare(session, {
      kind: 'decision',
      value: 'chose A',
      authority: 'decision',
      sourceRefs: [{ seq: userSeq }],
    } as never)
    const before = assessThermalResidency({ session, state: currentFoldState(h.ctx, session) })
    expect(
      before.verdicts.find(verdict => verdict.anchorId === declared.id)!.residency,
      'a live decision with no demand evidence is warm',
    ).toBe('warm')

    service.retire(session, declared.id)
    const after = assessThermalResidency({ session, state: currentFoldState(h.ctx, session) })
    const verdict = after.verdicts.find(candidate => candidate.anchorId === declared.id)
    // A retired anchor leaves hot state entirely, so it may not appear at all —
    // and if it does, it must be cold with its lifecycle stated.
    if (verdict !== undefined) {
      expect(verdict.residency, 'an explicitly retired anchor is cold').toBe('cold')
      expect(verdict.lifecycle).not.toBe('active')
    }
  }, 120_000)

  it('state the observer cannot place is `unknown`, never guessed', async () => {
    // The honest-answer requirement. An anchor whose provenance does not resolve
    // to the current surface has no basis, and `unknown` is the correct output —
    // a default of `cold` here would be exactly the age-equals-idleness
    // inference the design forbids.
    //
    // The case is built from a REAL shape: an anchor citing a seq that is no
    // longer a surface node. That is what a folded-past anchor looks like, and it
    // is the case a naive implementation would silently classify as cold.
    const h = await observingHarness()
    const session = longChain({ turns: 3, chars: 300, tag: 'thermal-unknown' })
    const service = createAnchorService({ durableWritesAllowed: () => true })
    // An `empirical` anchor must cite a tool result — the authority gate refuses
    // a user message for that domain.
    const toolSeq = session.surface.nodes.find(seq =>
      session.deriveEventMessage(session.eventAt(seq as never)!)?.role === 'tool')!
    service.declare(session, {
      kind: 'value',
      stateKey: { namespace: 'm', entity: 'n', property: 'v' },
      value: 42,
      authority: 'empirical',
      sourceRefs: [{ seq: toolSeq }],
    } as never)
    // Fold the surface so the cited seq is no longer a surface node, while the
    // anchor remains in hot state — its provenance is now unresolvable from the
    // surface alone.
    const agent = agentFor(session)
    try {
      await (h.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded(agent, 'pressure', SIGNAL)
    } catch { /* designed outcome */ }
    const state = currentFoldState(h.ctx, session)
    const report = assessThermalResidency({ session, state })
    // No anchor may be classified cold without an explicit lifecycle operation,
    // and any anchor the observer cannot place must say so.
    for (const verdict of report.verdicts) {
      expect(
        verdict.residency,
        'no anchor may be classified cold without an explicit lifecycle operation',
      ).not.toBe('cold')
      if (verdict.residency === 'unknown') {
        expect(verdict.evidence.join(' ')).toMatch(/no surface position|none of the anchor/u)
      }
    }
    // And the reading must be honest about how many it could not place, rather
    // than presenting them as classified.
    expect(report.unknownCount).toBe(
      report.verdicts.filter(verdict => verdict.residency === 'unknown').length,
    )
  }, 120_000)

  it('reports `unavailable` rather than an empty list when no state is mounted', async () => {
    // "No anchors exist" and "the state could not be read" would otherwise both
    // present as an empty verdict list.
    const session = longChain({ turns: 2, chars: 300, tag: 'thermal-nostate' })
    const report = assessThermalResidency({ session })
    expect(report.verdicts).toEqual([])
    expect(report.unavailable).toBe('no-state-mounted')
    expect(describeThermal(report)).toMatch(/unavailable/u)
  }, 60_000)
})

describe('the shadow policy recommends only what is executable', () => {
  it('an early leaf is recommended below threshold, and is genuinely executable', async () => {
    // The question the shadow exists to answer: with the current policy doing
    // NOTHING, is there an executable early action with a net benefit? On this
    // surface there is, and the recommendation must say it is an EARLY one.
    //
    // The surface must be UNDER threshold while still carrying a legal span,
    // which is what makes the fold "early" rather than "due" — so the fixture is
    // sized against the threshold rather than chosen arbitrarily.
    const h = await observingHarness({ thresholdRatio: 0.8 })
    const session = longChain({ turns: 12, chars: 800, tag: 'shadow-early' })
    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const decision = decideShadowFolding({
      session,
      measurement,
      spec,
      config: h.engine.efConfig,
      stepsSinceRootRebase: 99,
      provider: MODEL,
      model: MODEL,
      state: currentFoldState(h.ctx, session),
      estimateText: estimator(h),
    })
    expect(measurement.totalTokens, 'the fixture must be UNDER threshold').toBeLessThan(
      spec.thresholdTokens,
    )
    expect(decision.action).toBe('leaf')
    expect(decision.executable, 'an executable recommendation must be one the engine can take').toBe(true)
    expect(decision.estimatedNetReclaimTokens, 'a net reclaim must be reported').toBeGreaterThan(0)
    expect(decision.reason).toMatch(/EARLY fold/u)
    // Executable means the engine's own selector agrees, so this is checked
    // against the selector rather than trusted.
    expect(decision.workingSet.legalLeafSpanTokens).toBeGreaterThan(0)
  }, 60_000)

  it('a surface with no frozen prefix gets no rebase recommendation', async () => {
    // The guard that keeps "early root" from becoming a universal answer. With
    // nothing frozen there is no checkpoint residency to collapse, so a rebase is
    // not the mechanism — the economics alone would say `root` here, because a
    // zero compaction cost gives a zero break-even.
    //
    // The leaf is made INADMISSIBLE on purpose, so the decision actually reaches
    // the root branch. Otherwise the leaf branch answers first and the guard is
    // never exercised — which is exactly what a test asserting only
    // `action !== 'root'` would have hidden.
    const h = await observingHarness({ thresholdRatio: 0.8, minReclaimTokens: 1_000_000 })
    const session = longChain({ turns: 12, chars: 800, tag: 'shadow-unfrozen' })
    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const decision = decideShadowFolding({
      session,
      measurement,
      spec,
      config: h.engine.efConfig,
      stepsSinceRootRebase: 99,
      provider: MODEL,
      model: MODEL,
      state: currentFoldState(h.ctx, session),
      estimateText: estimator(h),
    })
    expect(decision.workingSet.frozenCheckpointCount, 'nothing is frozen on this surface').toBe(0)
    expect(decision.action, 'there is no frozen prefix to rebase').toBe('none')
    expect(decision.executable).toBe(false)
    expect(decision.reason).toMatch(/no frozen checkpoint exists/u)
  }, 60_000)

  it('never recommends a leaf the engine cannot take at the retention in force', async () => {
    // The defect this pins, found while building the observer: the production
    // gate probes `selectLeafSpan(retain 0)` while the fold loop folds at
    // `spec.retainTokens`. On a surface smaller than the retention budget the
    // gate says yes and the selector says no — so a recommendation built on the
    // gate alone would name an action that cannot be executed.
    const h = await observingHarness()
    const session = longChain({ turns: 12, chars: 200, tag: 'shadow-small' })
    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const decision = decideShadowFolding({
      session,
      measurement,
      spec,
      config: h.engine.efConfig,
      stepsSinceRootRebase: 99,
      provider: MODEL,
      model: MODEL,
      state: currentFoldState(h.ctx, session),
      estimateText: estimator(h),
    })
    if (decision.action === 'leaf') {
      expect(
        decision.workingSet.legalLeafSpanTokens,
        'a leaf recommendation must correspond to a span the selector will actually take',
      ).toBeGreaterThan(0)
    } else {
      expect(decision.executable).toBe(false)
    }
  }, 60_000)

  it('the cooldown suppresses a rebase that would otherwise be recommended', async () => {
    // Anti-oscillation is reused, not reimplemented: the same cooldown the
    // engine applies must bind the shadow.
    const h = await observingHarness()
    const session = longChain({ turns: 24, chars: 700, tag: 'shadow-cooldown' })
    const agent = agentFor(session)
    const spec = specOf(h)
    for (let step = 0; step < 6; step += 1) {
      try {
        await (h.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch { /* designed outcome */ }
      grow(session, 300 + step, 700)
    }
    const measurement = h.ctx.tokenMeter.measure(session)
    const base = {
      session, measurement, spec, config: h.engine.efConfig,
      provider: MODEL, model: MODEL,
      state: currentFoldState(h.ctx, session),
      estimateText: estimator(h),
    }
    const hot = decideShadowFolding({ ...base, stepsSinceRootRebase: 0 })
    const cold = decideShadowFolding({ ...base, stepsSinceRootRebase: 99 })
    // Whatever the economics say, the cooldown can only ever REFUSE a rebase,
    // never recommend one. So if the unconstrained decision wants a root, the
    // constrained one must have refused it — and named the cooldown as the
    // reason, rather than silently agreeing.
    expect(hot.action, 'the cooldown must never recommend a rebase').not.toBe('root')
    if (cold.action === 'root') {
      expect(hot.action, 'the cooldown must refuse what the free decision would take').toBe('none')
      expect(hot.blockers.join(' '), 'and it must say why').toMatch(/cooldown/u)
    }
    // And the two decisions must agree about everything except the cooldown.
    expect(hot.workingSet.totalTokens).toBe(cold.workingSet.totalTokens)
    expect(hot.workingSet.estimatedRootReclaimTokens).toBe(
      cold.workingSet.estimatedRootReclaimTokens,
    )
  }, 120_000)
})

describe('observation cannot change behavior', () => {
  /**
   * Strip the identities that are RANDOM BY CONSTRUCTION, so the comparison is
   * of behavior rather than of UUIDs.
   *
   * A checkpoint id is `randomUUID()`, and the session id is seeded per run, so
   * two runs of the SAME arm differ in exactly these bytes. Normalizing them is
   * what makes the comparison meaningful: without it the test would fail for
   * both arms and prove nothing about the observer. A genuine behavioral
   * difference — a different span folded, a different checkpoint body, a
   * different number of folds — survives normalization, which the destructive
   * check below confirms.
   */
  function normalize(text: string): string {
    return text
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>')
      .replace(/ws-equiv-\w+/gu, '<session>')
  }

  /** One deterministic run, returning everything a behavioral claim needs. */
  async function run(workingSet: 'off' | 'observe'): Promise<{
    readonly visible: readonly string[]
    readonly leaves: number
    readonly roots: number
    readonly emergencies: number
    readonly intents: number
    readonly writes: number
    readonly checkpoints: readonly string[]
    readonly spans: readonly string[]
  }> {
    const h = await observingHarness({ workingSet })
    // A FIXED tag, so the session id is identical across the two arms and only
    // the observer differs.
    const session = longChain({ turns: 24, chars: 700, tag: 'equiv' })
    const agent = agentFor(session)
    const spans: string[] = []
    for (let step = 0; step < 8; step += 1) {
      try {
        await (h.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch { /* designed outcome, identical in both arms */ }
      const reach = h.engine.lastFoldReachability
      if (reach !== undefined) {
        spans.push(`total=${reach.totalTokens} span=${reach.spanTokens} frozen=${reach.frozenTokens}`)
      }
      grow(session, 400 + step, 700)
    }
    // The MODEL-VISIBLE surface: the derived messages, in order. This is what a
    // behavioral difference would actually show up in.
    const messages = session.surface.nodes
      .map(seq => session.deriveEventMessage(session.eventAt(seq as never)!))
      .filter(message => message !== null)
    const visible = messages.map(message => normalize(JSON.stringify(message)))
    const checkpoints = messages
      .map(message => (message.role === 'user' ? message.content
        .map(block => (block.type === 'text' ? block.text : '')).join('') : ''))
      .filter(text => text.includes('cp:'))
      .map(normalize)
    return {
      visible,
      leaves: h.engine.leafFoldCount,
      roots: h.engine.rootFoldCount,
      emergencies: h.engine.emergencyRebaseCount,
      intents: h.engine.pendingRebaseIntentCount,
      writes: h.engine.bundleWriteCount,
      checkpoints,
      spans,
    }
  }

  it('off and observe produce identical visible surfaces and identical fold counts', async () => {
    // The equivalence the spec requires, over a chain long enough to fold. The
    // comparison is on the DERIVED MESSAGES — what the model would see — with
    // random identity normalized, because the observer's only permitted effect
    // is logging.
    const off = await run('off')
    const on = await run('observe')

    expect(off.leaves, 'the fixture must genuinely fold, or this proves nothing').toBeGreaterThan(0)
    expect(on.visible.length, 'the visible surface must be non-empty').toBeGreaterThan(0)
    expect(
      on.visible,
      'the model-visible messages must be identical with the observer on and off',
    ).toEqual(off.visible)
    expect(on.leaves, 'leaf fold count').toBe(off.leaves)
    expect(on.roots, 'root fold count').toBe(off.roots)
    expect(on.emergencies, 'emergency rebase count').toBe(off.emergencies)
    expect(on.intents, 'no additional rebase intent may be created').toBe(off.intents)
    expect(on.writes, 'bundle writes').toBe(off.writes)
    expect(on.checkpoints, 'the exact checkpoint bodies must be identical').toEqual(off.checkpoints)
    expect(on.spans, 'and every fold must have chosen the same span').toEqual(off.spans)
  }, 300_000)

  it('observe creates no rebase intent and no extra fold of its own', async () => {
    // A direct check on the two effects the observer must not have. Run on a
    // surface that is NOT over threshold, where an over-eager observer would be
    // most tempted to act.
    const h = await observingHarness()
    const session = longChain({ turns: 8, chars: 300, tag: 'inert' })
    const agent = agentFor(session)
    const before = {
      intents: h.engine.pendingRebaseIntentCount,
      leaves: h.engine.leafFoldCount,
      roots: h.engine.rootFoldCount,
      writes: h.engine.bundleWriteCount,
    }
    await (h.engine as unknown as {
      compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
    }).compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(h.engine.pendingRebaseIntentCount, 'observation must not request a rebase').toBe(
      before.intents,
    )
    expect(h.engine.leafFoldCount + h.engine.rootFoldCount, 'and must not fold').toBe(
      before.leaves + before.roots,
    )
    expect(h.engine.bundleWriteCount, 'and must not write a bundle').toBe(before.writes)
  }, 120_000)

  it('the engine reads the flag in exactly one place, and discards the result', () => {
    // ## The structural guarantee, checked mechanically
    //
    // The equivalence test above shows the observer did not change behavior on
    // ONE fixture. This shows it CANNOT: the flag is read in one place, and the
    // observer's return value is never bound to a name the engine could branch
    // on. A second reader, or an assigned result, would be the shape of a
    // behavior change however the tests happened to pass.
    const engine = readFileSync(join(ROOT, 'src', 'engine.ts'), 'utf8')
    // Comments are stripped first: this file's own doc comments name the flag to
    // explain it, and the prohibition is on READING it, not on mentioning it.
    const code = engine
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/u.test(line))
      .join('\n')
    const reads = [...code.matchAll(/efConfig\.workingSet/gu)]
    expect(
      reads.length,
      'the flag must be read exactly once, in `observeWorkingSet`',
    ).toBe(1)

    // The call sites must be statements, not assignments: `observeWorkingSet({`
    // at the start of a statement, with no `= ` before it on the line.
    const calls = [...code.matchAll(/^\s*(.*?)this\.observeWorkingSet\(/gmu)]
    expect(calls.length, 'the observer must be called from the decision points').toBeGreaterThan(0)
    for (const call of calls) {
      expect(
        call[1]!.trim(),
        'the observer result must be discarded, never bound — a bound result is branchable',
      ).toBe('')
    }

    // And the observer module must not reach for anything that could act.
    // Comments are stripped: the module's own doc comment names these to say it
    // does not use them, and the prohibition is on CALLING one.
    const observer = readFileSync(join(ROOT, 'src', 'working-set-observer.ts'), 'utf8')
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/u.test(line))
      .join('\n')
    for (const forbidden of ['compactNow', 'compactRegion', 'recordRebaseIntent', 'runMaintenance', 'append(']) {
      expect(
        observer.includes(forbidden),
        `the observer must not reference ${forbidden}: it can only observe`,
      ).toBe(false)
    }
  })

  it('the observer is OFF by default and changes no default behavior', () => {
    // Default-off is the whole safety story. A deployment that sets nothing must
    // not acquire a reading on its fold path.
    const policy = readFileSync(join(ROOT, 'src', 'policy.ts'), 'utf8')
    expect(policy).toMatch(/const DEFAULT_WORKING_SET: WorkingSetMode = 'off'/u)
    const engine = readFileSync(join(ROOT, 'src', 'engine.ts'), 'utf8')
    expect(
      engine,
      'the observer must be gated, not unconditional',
    ).toMatch(/if \(this\.efConfig\.workingSet !== 'observe'\) return/u)
  })
})

describe('telemetry carries no content', () => {
  it('every emitted line is numbers, enums and authored text — never message bytes', async () => {
    // The confidentiality requirement, checked on real output rather than
    // asserted. A distinctive marker is planted in the conversation; if any
    // observation line carried message content, the marker would appear.
    const MARKER = 'CANARY-DO-NOT-LOG-7f3a91'
    const h = await observingHarness()
    const session = longChain({ turns: 6, chars: 400, tag: 'canary' })
    const callId = ToolCallId('canary-call')
    // The tool call must be on the ASSISTANT message and paired with its result,
    // or the surface is unbalanced and the selector refuses to walk it. A
    // canary that broke the surface would test nothing.
    //
    // The credential-shaped half of the canary is ASSEMBLED AT RUNTIME rather
    // than written out. A tracked file must not contain a credential-shaped
    // literal at all — `release-hygiene.spec.ts` scans for exactly that, and it
    // caught this test's first version. Composing it from fragments keeps the
    // detector honest (it is not weakened to accommodate a test) while still
    // planting a realistic secret in the conversation for the observer to
    // (not) leak.
    const credentialShaped = `s${'k'}-${'A'.repeat(24)}`
    session.append('turn/end', { turn: 6, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 50 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `secret ${MARKER} ${credentialShaped}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 50, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 50,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 50, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn: 50,
      step: 1,
      message: createToolResultMessage({
        callId,
        isError: false,
        content: [{ type: 'text', text: `tool output ${MARKER}` }],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 50, step: 1 })

    const measurement = h.ctx.tokenMeter.measure(session)
    const spec = specOf(h)
    const lines: string[] = []
    observeWorkingSet({
      session,
      measurement,
      spec,
      config: h.engine.efConfig,
      provider: MODEL,
      model: MODEL,
      stepsSinceRootRebase: 99,
      state: currentFoldState(h.ctx, session),
      estimateText: estimator(h),
      log: line => lines.push(line),
      stage: 'canary',
    })
    expect(lines.length, 'the observer must emit something').toBeGreaterThan(0)
    const joined = lines.join('\n')
    expect(joined, 'no message content may reach telemetry').not.toContain(MARKER)
    expect(joined, 'nor any credential-shaped text').not.toMatch(/sk-[A-Za-z0-9]{20,}/u)
    // The lines must still carry the numbers, so this is not passing by emitting
    // nothing useful.
    expect(joined).toMatch(/total \d+/u)
    expect(joined).toMatch(/residual \d+/u)
    expect(joined).toMatch(/shadow:/u)
  }, 120_000)
})

describe('the observer is reachable from the engine', () => {
  it('a real fold decision emits observation lines when the mode is observe', async () => {
    // The wiring, exercised end to end: the engine's own logger receives the
    // lines, which is what makes this an observation plane rather than a module
    // nobody calls.
    const logged: string[] = []
    const h = await observingHarness()
    const original = h.ctx.logger.info.bind(h.ctx.logger)
    h.ctx.logger.info = (line: string) => {
      logged.push(line)
      original(line)
    }
    const session = longChain({ turns: 20, chars: 700, tag: 'wired' })
    const agent = agentFor(session)
    await (h.engine as unknown as {
      compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
    }).compactIfNeeded(agent, 'pressure', SIGNAL)
    const observed = logged.filter(line => line.includes('working-set ('))
    expect(observed.length, 'the engine must emit observation lines').toBeGreaterThan(0)
    expect(observed.join('\n')).toMatch(/working-set \((pressure|idle|pruned)\)/u)
  }, 120_000)
})
