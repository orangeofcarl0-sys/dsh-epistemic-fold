/**
 * RC2: the `/context status` diagnostic surface.
 *
 * Two layers are tested separately, because they fail differently:
 *
 *  - `buildContextStatus` is PURE, so its fields can be pinned exactly —
 *    including the property that matters most: a figure that cannot be
 *    established is `undefined` and renders `unknown`, NEVER a zero. RC1.1
 *    corrected exactly this class of error (a cache-contract measurement
 *    presented as a price result), so the status surface is where it must not
 *    come back.
 *
 *  - the COMMAND is registered against the REAL `ctx.commands` registry and its
 *    handler is invoked against a REAL agent and a REAL plugin mount, so the
 *    wiring is exercised rather than described.
 *
 * @module tests/rc2-status
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHarness, SIGNAL } from './harness.ts'
import {
  buildContextStatus,
  contextStatusToLine,
  contextStatusToText,
} from '../src/status.ts'
import {
  CONTEXT_COMMAND_NAME,
  contextCommandDefinition,
  parseContextArgs,
  registerContextCommand,
} from '../src/command.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'

/** A real session with a routed header, so `routedTarget` resolves. */
function routedSession(): Session {
  const session = Session.create(SessionId(`rc2-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: 'test-model', model: 'test-model', maxTokens: 1_500 } },
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe('RC2: the status model reports every field the directive names', () => {
  it('carries mode, context, archive, checkpoints, recalls, folds and cost', () => {
    const session = routedSession()
    const status = buildContextStatus({
      mode: 'economy',
      session,
      measurement: { totalTokens: 12_345, surfaceTokens: 12_345 } as never,
      contextWindow: 131_072,
      foldThreshold: 19_660,
      bundles: [{ archive: { shadowedMessages: [{ content: [{ type: 'text', text: 'x'.repeat(400) }] }] } }],
      profile: parseEconomicsProfile({
        id: 'p', provider: 'test', modelPattern: '*', asOf: '2026-09-30',
        pricing: { inputMissPerM: 1, inputHitPerM: 0.1, outputPerM: 2 },
        cache: { mode: 'automatic', bestEffort: true },
        context: { windowTokens: 131_072 },
      }),
      usage: { uncachedInputTokens: 1_000, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 200 },
    })
    // mode / current context
    expect(status.mode).toBe('economy')
    expect(status.currentContext?.value).toBe(12_345)
    expect(status.contextWindow).toBe(131_072)
    expect(status.foldThreshold).toBe(19_660)
    // archived history
    expect(status.archivedMessages).toBe(1)
    expect(status.archivedTokens?.value).toBe(100)
    // checkpoint count / recalls / folds
    expect(status.checkpoints.value).toBe(0)
    expect(status.recalls.value).toBe(0)
    // LIFETIME folds live under `folds`, NOT on the lifecycle object, and they
    // are read from the BUNDLES rather than from the surface. This fixture
    // supplies one bundle while the surface carries no checkpoint, so the two
    // numbers legitimately DIFFER — which is exactly the distinction RC2.1
    // fixed. RC2 read the surface frontier and reported it under a lifetime
    // name, so a session that folded 40 times and rebased to one checkpoint
    // would have shown `leaves = 1`.
    expect(status.folds.leaves.value).toBe(1)
    expect(status.folds.roots.value).toBe(0)
    // estimated/realized cost
    expect(status.cost?.value).toBeGreaterThan(0)
  })

  it('marks every figure with the basis it was obtained on', () => {
    const status = buildContextStatus({
      mode: 'economy',
      session: routedSession(),
      measurement: { totalTokens: 10 } as never,
      bundles: [],
      profile: parseEconomicsProfile({
        id: 'p', provider: 'test', modelPattern: '*', asOf: '2026-09-30',
        pricing: { inputMissPerM: 1, inputHitPerM: 0.1, outputPerM: 2 },
        cache: { mode: 'automatic', bestEffort: true },
        context: { windowTokens: 1_000 },
      }),
      usage: { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    })
    // Tokens and counts are MEASURED; money is ESTIMATED. The distinction is
    // the whole reason the basis is carried rather than printed as a bare value.
    expect(status.currentContext?.basis).toBe('measured')
    expect(status.checkpoints.basis).toBe('measured')
    expect(status.recalls.basis).toBe('measured')
    expect(status.cost?.basis).toBe('estimated')
  })
})

describe('RC2.1: an unestablished figure is UNKNOWN, never zero', () => {
  it('omits the cost entirely when no profile was supplied', () => {
    // A session with no priced calls has an UNKNOWN cost. Reporting 0 would read
    // as "this mode is free", which is the opposite of the truth.
    const status = buildContextStatus({ mode: 'economy', session: routedSession() })
    expect(status.cost).toBeUndefined()
    expect(contextStatusToText(status)).toContain('unknown')
    expect(contextStatusToText(status)).not.toContain('0.000000')
  })

  it('omits the PRESSURE when no reading exists, instead of claiming a measured 0', () => {
    // THE DEFECT RC2.1 FIXED. RC2 reported `{value: 0, basis: 'measured'}` when
    // no meter reading was supplied — a fabricated measurement asserting the
    // context was empty. A session before its first provider report has an
    // UNKNOWN pressure, and `0` is the opposite of the truth.
    const status = buildContextStatus({ mode: 'economy', session: routedSession() })
    expect(status.currentContext).toBeUndefined()
    const text = contextStatusToText(status)
    expect(text).toContain('pressure        unknown')
    expect(text).not.toContain('pressure        0')
  })

  it('omits occupancy when the pressure is unknown, even if the window is known', () => {
    // A ratio with a missing numerator is not a ratio. RC2 computed it from the
    // fabricated zero, reporting `0.0%` occupancy for an unmeasured session.
    const status = buildContextStatus({
      mode: 'economy', session: routedSession(), contextWindow: 131_072,
    })
    expect(status.contextWindow).toBe(131_072)
    expect(status.occupancy).toBeUndefined()
    expect(contextStatusToText(status)).not.toContain('occupancy')
  })

  it('still reports a genuine zero pressure as zero', () => {
    // The converse: a REAL reading of 0 is a measurement and must be shown.
    const status = buildContextStatus({
      mode: 'economy', session: routedSession(), measurement: { totalTokens: 0 } as never,
    })
    expect(status.currentContext?.value).toBe(0)
    expect(status.currentContext?.basis).toBe('measured')
  })

  it('the one-line form says ctx=unknown rather than ctx=0', () => {
    const line = contextStatusToLine(buildContextStatus({ mode: 'economy', session: routedSession() }))
    expect(line).toContain('ctx=unknown')
    expect(line).not.toContain('ctx=0')
  })
})

describe('RC2.1: archived tokens are ESTIMATED, not measured', () => {
  it('marks the token figure estimated while the message COUNT stays measured', () => {
    // THE DEFECT RC2.1 FIXED. RC2 reported the archived token figure as
    // `measured`. The INPUT is real — real archived messages — but the
    // conversion to tokens is a fixed `chars / 4` heuristic that misprices CJK
    // and JSON, so calling it measured is the RC1.1 error repeating: a
    // heuristic presented as a measurement.
    const status = buildContextStatus({
      mode: 'economy',
      session: routedSession(),
      bundles: [{ archive: { shadowedMessages: [{ content: [{ type: 'text', text: 'x'.repeat(400) }] }] } }],
    })
    expect(status.archivedTokens?.basis).toBe('estimated')
    // The count is a count, so it is measured.
    expect(status.archivedMessages).toBe(1)
    // And the rendered line marks the estimate.
    expect(contextStatusToText(status)).toContain('~100 (estimated)')
  })

  it('marks a zero-length archive estimated too, not measured', () => {
    // A zero ESTIMATE is still an estimate; the basis describes how the figure
    // was derived, not whether it is non-zero.
    const status = buildContextStatus({ mode: 'economy', session: routedSession(), bundles: [] })
    expect(status.archivedTokens?.value).toBe(0)
    expect(status.archivedTokens?.basis).toBe('estimated')
  })
})

describe('RC2.1: current checkpoints and lifetime folds are separate numbers', () => {
  it('reports the surface count under `checkpoints` and the bundle count under `folds`', () => {
    // THE DEFECT RC2.1 FIXED. RC2 derived leaf/root counts from the SURFACE
    // frontier and put them on the lifecycle object as if they were lifetime
    // totals. A session that folded 40 times and then rebased to a single
    // checkpoint would have reported `leaves = 1`.
    const session = routedSession()
    const status = buildContextStatus({
      mode: 'economy',
      session,
      // The store holds many folds...
      bundles: [
        { mode: 'leaf', archive: { shadowedMessages: [] } },
        { mode: 'leaf', archive: { shadowedMessages: [] } },
        { mode: 'leaf', archive: { shadowedMessages: [] } },
        { mode: 'root', archive: { shadowedMessages: [] } },
      ],
    })
    // ...while the surface carries none right now.
    expect(status.checkpoints.value).toBe(0)
    expect(status.folds.leaves.value).toBe(3)
    expect(status.folds.roots.value).toBe(1)
    expect(status.folds.complete).toBe(true)
  })

  it('prefers the engine-reported counts when the caller supplies them', () => {
    // The engine knows what it COMMITTED; the store only knows what is on disk.
    const status = buildContextStatus({
      mode: 'economy',
      session: routedSession(),
      bundles: [{ mode: 'leaf', archive: { shadowedMessages: [] } }],
      foldCounts: { leaves: 12, roots: 2 },
    })
    expect(status.folds.leaves.value).toBe(12)
    expect(status.folds.roots.value).toBe(2)
  })

  it('flags the counts as INCOMPLETE when the store was not consulted', () => {
    // An unconsulted store means the counts are minimums, not totals. Reporting
    // zero would claim the session never folded.
    const status = buildContextStatus({ mode: 'economy', session: routedSession() })
    expect(status.folds.complete).toBe(false)
    expect(contextStatusToText(status)).toContain('minimums, not totals')
  })

  it('names the current figure `checkpoints now` so it cannot be read as lifetime', () => {
    const status = buildContextStatus({ mode: 'economy', session: routedSession(), bundles: [] })
    const text = contextStatusToText(status)
    expect(text).toContain('checkpoints now')
    expect(text).toContain('folds (lifetime):')
  })
})

describe('RC2.1: usage comes from the DSH projection', () => {
  it('carries the four provider buckets through to the report', () => {
    const status = buildContextStatus({
      mode: 'economy',
      session: routedSession(),
      usage: { uncachedInputTokens: 1_000, cacheReadTokens: 500, cacheWriteTokens: 50, outputTokens: 200 },
    })
    expect(status.usage).toEqual({
      uncachedInputTokens: 1_000, cacheReadTokens: 500, cacheWriteTokens: 50, outputTokens: 200,
    })
    const text = contextStatusToText(status)
    expect(text).toContain('provider usage (cumulative, measured)')
    expect(text).toContain('cache reads')
  })

  it('prices the cost FROM that usage, so the two cannot disagree', () => {
    const profile = parseEconomicsProfile({
      id: 'p', provider: 'test', modelPattern: '*', asOf: '2026-09-30',
      pricing: { inputMissPerM: 1, inputHitPerM: 0, outputPerM: 0 },
      cache: { mode: 'automatic', bestEffort: true },
      context: { windowTokens: 131_072 },
    })
    const status = buildContextStatus({
      mode: 'economy',
      session: routedSession(),
      profile,
      usage: { uncachedInputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    })
    // 1000 uncached tokens at 1 per million = 0.001.
    expect(status.cost?.value).toBeCloseTo(0.001, 9)
    expect(status.costProfileId).toBe('p')
  })
})

describe('RC2: an unknown figure is UNKNOWN, never zero', () => {
  it('omits the cost entirely when no profile was supplied', () => {
    // A session with no priced calls has an UNKNOWN cost. Reporting 0 would read
    // as "this mode is free", which is the opposite of the truth.
    const status = buildContextStatus({ mode: 'economy', session: routedSession() })
    expect(status.cost).toBeUndefined()
    expect(contextStatusToText(status)).toContain('unknown')
    expect(contextStatusToText(status)).not.toContain('0.000000')
  })

  it('omits the archive figures when the store was not consulted', () => {
    // `bundles: undefined` means "we did not look", which is NOT "nothing is
    // archived". The field is absent, and the renderer says unknown.
    const status = buildContextStatus({ mode: 'economy', session: routedSession() })
    expect(status.archivedTokens).toBeUndefined()
    expect(status.archivedMessages).toBeUndefined()
    expect(contextStatusToText(status)).toContain('archived tokens unknown')
  })

  it('reports a genuinely empty archive as zero, distinguishing it from unknown', () => {
    const status = buildContextStatus({ mode: 'economy', session: routedSession(), bundles: [] })
    expect(status.archivedMessages).toBe(0)
    expect(status.archivedTokens?.value).toBe(0)
  })

  it('omits the window and occupancy when the route is unknown', () => {
    const status = buildContextStatus({ mode: 'economy', session: routedSession() })
    expect(status.contextWindow).toBeUndefined()
    expect(status.occupancy).toBeUndefined()
  })

  it('the line form says cost=unknown rather than cost~0', () => {
    const line = contextStatusToLine(buildContextStatus({ mode: 'economy', session: routedSession() }))
    expect(line).toContain('cost=unknown')
    expect(line).not.toContain('cost~0.0000')
  })
})

describe('RC2: the status surface tells the truth about a tier', () => {
  it('names the tier and its evidence status', () => {
    const status = buildContextStatus({
      mode: 'quality', session: routedSession(), tier: { summary: 'a larger premium', evidence: 'hypothesis' },
    })
    expect(status.tier).toBe('quality')
    expect(status.tierSummary).toBe('a larger premium')
    // The user sees the status of the claim, not only a report reader.
    expect(contextStatusToText(status)).toContain('HYPOTHESIS')
    expect(contextStatusToText(status)).toContain('not yet measured')
  })

  it('does not print a hypothesis warning for a measured tier', () => {
    const status = buildContextStatus({
      mode: 'economy', session: routedSession(), tier: { summary: 'lowest cost', evidence: 'measured' },
    })
    expect(contextStatusToText(status)).not.toContain('HYPOTHESIS')
  })

  it('reports legacy as the engine default, not as a tier', () => {
    const status = buildContextStatus({ mode: 'legacy', session: routedSession() })
    expect(status.tier).toBeUndefined()
    expect(contextStatusToText(status)).toContain('not a tier')
  })
})

describe('RC2: lifecycle counters come from the durable log', () => {
  it('counts recall tool calls by name', () => {
    const session = routedSession()
    for (const name of ['context_search', 'context_search', 'context_recall', 'read']) {
      session.append('tool/call', {
        turn: 1, step: 1, callId: `c-${name}-${Math.random()}` as never, name, arguments: '{}',
      })
    }
    const status = buildContextStatus({ mode: 'economy', session })
    expect(status.searches.value).toBe(2)
    expect(status.recalls.value).toBe(1)
  })

  it('counts compactions and flags a failed one', () => {
    const session = routedSession()
    session.append('compaction/start', { compactionId: 'c1' as never, turn: null })
    session.append('compaction/end', { compactionId: 'c1' as never, turn: null })
    session.append('compaction/start', { compactionId: 'c2' as never, turn: null })
    session.append('compaction/end', { compactionId: 'c2' as never, turn: null, error: 'boom' })
    const status = buildContextStatus({ mode: 'economy', session })
    expect(status.lifecycle.compactions).toBe(2)
    expect(status.lifecycle.failedCompactions).toBe(1)
    // A failure is surfaced, not smoothed over.
    expect(contextStatusToText(status)).toContain('FAILED')
  })

  it('detects a resume from the request header reason', () => {
    const session = routedSession()
    session.append('request/header', {
      header: { config: { provider: 'test-model', model: 'test-model' } },
      reason: 'resume',
    })
    expect(buildContextStatus({ mode: 'economy', session }).lifecycle.resumed).toBe(true)
    expect(contextStatusToText(buildContextStatus({ mode: 'economy', session }))).toContain('resumed')
  })

  it('detects a mid-session model change from the durable notice', () => {
    const session = routedSession()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[model changed: assistant turns above this point were generated by a/b; the session continues with c/d]' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const status = buildContextStatus({ mode: 'economy', session })
    expect(status.lifecycle.modelChanges).toBe(1)
    expect(contextStatusToText(status)).toContain('model changes')
  })

  it('reports the routed provider/model', () => {
    const status = buildContextStatus({ mode: 'economy', session: routedSession() })
    expect(status.lifecycle.route).toBe('test-model/test-model')
  })
})

describe('RC2: the command grammar is the handler\'s own', () => {
  it('defaults to status when no sub-command is given', () => {
    expect(parseContextArgs('').subcommand).toBe('status')
    expect(parseContextArgs('   ').subcommand).toBe('status')
  })

  it('reads the sub-command and its arguments', () => {
    expect(parseContextArgs('status').subcommand).toBe('status')
    expect(parseContextArgs('line extra').subcommand).toBe('line')
    expect(parseContextArgs('line extra').rest).toEqual(['extra'])
  })
})

describe('RC2: the command registers against the REAL registry', () => {
  it('registers /context and answers status through the real dispatcher', async () => {
    // The registry is the real `CommandRuntime`, so the test exercises the same
    // parse → resolve → handler path a UI would.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072,
      plugin: true,
      systemPrompt: true,
      commands: true,
      // No threshold/retention override: the engine's own defaults, so the
      // command is exercised against the configuration a deployment gets.
      efConfig: { mode: 'economy', headroomTokens: 0, maxTokens: 1_500 },
    })
    const session = routedSession()
    const agent = { session, options: { provider: 'test-model', model: 'test-model' } } as unknown as Agent

    const descriptor = harness.ctx.commands.list(agent).find(entry => entry.name === CONTEXT_COMMAND_NAME)
    expect(descriptor, '/context must be discoverable').toBeDefined()
    expect(descriptor!.description).toContain('Epistemic Fold')

    const execution = await harness.ctx.commands.execute(agent, `/${CONTEXT_COMMAND_NAME} status`, [], SIGNAL)
    expect(execution).toBeDefined()
    expect(execution!.result.kind).toBe('success')
    const text = execution!.result.kind === 'success' ? execution!.result.text ?? '' : ''
    // The report answers the directive's own list of questions.
    expect(text).toContain('context mode: economy')
    expect(text).toContain('current context')
    expect(text).toContain('archived history')
    expect(text).toContain('checkpoints')
    expect(text).toContain('recalls')
    expect(text).toContain('folds')
    expect(text).toContain('cost')
  }, 120_000)

  it('answers the one-line form', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072,
      plugin: true,
      systemPrompt: true,
      commands: true,
      efConfig: { mode: 'balanced', headroomTokens: 0, maxTokens: 1_500 },
    })
    const agent = {
      session: routedSession(), options: { provider: 'test-model', model: 'test-model' },
    } as unknown as Agent
    const execution = await harness.ctx.commands.execute(agent, `/${CONTEXT_COMMAND_NAME} line`, [], SIGNAL)
    const text = execution!.result.kind === 'success' ? execution!.result.text ?? '' : ''
    expect(text).toContain('mode=balanced')
    expect(text).toContain('checkpoints=')
  }, 120_000)

  it('rejects an unknown sub-command without touching the model', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072, plugin: true, systemPrompt: true, commands: true,
      efConfig: { mode: 'economy' },
    })
    const agent = {
      session: routedSession(), options: { provider: 'test-model', model: 'test-model' },
    } as unknown as Agent
    const execution = await harness.ctx.commands.execute(agent, `/${CONTEXT_COMMAND_NAME} nonsense`, [], SIGNAL)
    expect(execution!.result.kind).toBe('error')
    const text = execution!.result.kind === 'error' ? execution!.result.text : ''
    expect(text).toContain('unknown subcommand')
  }, 120_000)

  it('does NOT register when no command registry is composed', async () => {
    // A compaction-only deployment has no `ctx.commands`. The mount must still
    // succeed — the same rule the recall tools follow for `ctx.tools`.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072, plugin: true, systemPrompt: true,
      efConfig: { mode: 'economy' },
    })
    expect(harness.ctx.get('commands')).toBeUndefined()
    // The plugin mounted, and the engine is live.
    expect(harness.plugin).toBeDefined()
    // And the helper reports that it registered nothing rather than throwing.
    const dispose = registerContextCommand(harness.ctx, {
      store: harness.engine.bundleStore,
      config: () => ({ mode: 'economy', raw: {} }),
    })
    expect(dispose).toBeUndefined()
  }, 120_000)

  it('the definition is buildable without a registry, for a report', async () => {
    const harness = await createHarness({ text: 'digest' }, { contextWindow: 1_000 })
    const definition = contextCommandDefinition(harness.ctx, {
      store: harness.store,
      config: () => ({ mode: 'economy', raw: {} }),
    })
    expect(definition.name).toBe(CONTEXT_COMMAND_NAME)
    expect(definition.input?.hint).toContain('status')
  })

})
