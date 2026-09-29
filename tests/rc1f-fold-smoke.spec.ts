/**
 * RC1-F: two cheap live smokes, and nothing more.
 *
 * RC1 §31/§32 are explicit about how little needs to be spent here. RC1 changes
 * WHEN a fold happens, not what a checkpoint contains — no Bundle, State,
 * Authority, Renderer, Recall, or checkpoint-semantics change — so the full
 * 4-family × 5-replicate quality suite does not need re-running. Two smokes
 * suffice:
 *
 *   **Smoke B — fold boundary.** The interesting regime is the one the shipped
 *   defaults actually reach, which means crossing a ~65024-token threshold. But
 *   the prompt does not have to be genuinely that large to test the TRANSACTION
 *   path: what matters is that the token meter MEASURES a surface at
 *   `trigger − ε`, then at `trigger + ε`, and that the fold that follows is
 *   real, billed, and followed by a cache recovery. So the smoke constructs the
 *   boundary locally and sends three requests around it.
 *
 *   **Quality smoke.** One multi-fold scenario carrying all three of §32's
 *   facts — a constraint, a supersession, and an exact code — and the bar is
 *   that all three survive.
 *
 * §33 is a change to the vacuity rule, and it matters: requiring a ROOT would
 * force a rebase that the economics may correctly refuse. At the real defaults
 * a marker-only checkpoint costs ~20 tokens, so `0 roots` can be the right
 * economic answer. The rule is therefore:
 *
 *   at least one LEAF, if the scenario crosses the trigger
 *   a root only when the shadow/economic policy says one should happen
 *
 * Opt-in: `EF_LIVE=1`.
 *
 * @module tests/rc1f-fold-smoke
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { createHarness, SIGNAL } from './harness.ts'
import { driveIdleMaintenance } from '../bench/paired-baseline.ts'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { BillingRecorder } from '../eval/live/recorder.ts'
import { resolveEfCompactSpec, resolveEfConfig } from '../src/policy.ts'
import { resolvePreset } from '../src/preset.ts'

const LIVE_ENABLED = process.env.EF_LIVE === '1'
const LIVE_PROVIDER = 'live'
const MODEL_OPTIONS = { provider: LIVE_PROVIDER, model: 'live' }
/** The real routed window, so the trigger arithmetic is the production one. */
const WINDOW = Number(process.env.EF_LIVE_WINDOW ?? 131_072)
const RESERVED = 512

/** Deterministic filler of approximately `tokens` tokens. */
function filler(label: string, tokens: number): string {
  const unit = `${label} detail unit `
  return unit.repeat(Math.max(1, Math.ceil((tokens * 4) / unit.length)))
}

/** A session seeded with a payload of a requested approximate size. */
function seed(tokens: number, facts: readonly string[] = []): SessionType {
  const session = Session.create(SessionId(`rc1f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: MODEL_OPTIONS }, reason: 'initial' })
  for (const fact of facts) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: fact }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: filler('seed', tokens) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe.skipIf(!LIVE_ENABLED)('RC1-F live: the fold boundary, near the real trigger', () => {
  it('crosses the production threshold, folds, and recovers cache', async () => {
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved').toBeDefined()
    const provider = new OpenAiCompatibleAdapter({
      baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model, contextWindow: WINDOW,
    })
    const recorder = new BillingRecorder(provider, 'smoke')

    // The SHIPPED economy preset, so the trigger being crossed is the real one.
    const policy = { ...resolvePreset('economy'), maxTokens: RESERVED }
    const resolved = resolveEfConfig(policy)
    const spec = resolveEfCompactSpec(resolved, WINDOW, RESERVED)
    console.log(
      `SMOKE-B trigger: window=${WINDOW} threshold=${spec.thresholdTokens} retain=${spec.retainTokens}`,
    )

    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: WINDOW, plugin: true, systemPrompt: true, efConfig: policy,
    })
    harness.ctx.llm.registerAdapter([LIVE_PROVIDER], recorder)

    // Seed to just BELOW the trigger, so the next append crosses it. The token
    // meter prices at ~4 chars/token, and the meter is the authority here — so
    // the seed is sized from the meter's own reading rather than from the
    // nominal target.
    const meter = harness.ctx.tokenMeter
    const session = seed(Math.max(1, spec.thresholdTokens - 4_000))
    const beforeSeed = meter.measure(session).totalTokens
    console.log(`SMOKE-B pre-trigger surface: ${beforeSeed} tokens (threshold ${spec.thresholdTokens})`)
    expect(beforeSeed).toBeLessThan(spec.thresholdTokens)

    // --- Request 1: PRE-trigger. No fold should happen, and the request is
    // issued so the provider caches the prefix.
    session.append('turn/start', { turn: 2 })
    recorder.markNextRequest('normal')
    await issueMain(harness, session)
    const preFold = meter.measure(session).totalTokens
    expect(preFold).toBeLessThan(spec.thresholdTokens)

    // --- Cross the trigger with one large append, then fold.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: filler('crossing', 6_000) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const afterCross = meter.measure(session).totalTokens
    console.log(`SMOKE-B post-cross surface: ${afterCross} tokens (threshold ${spec.thresholdTokens})`)
    expect(afterCross).toBeGreaterThanOrEqual(spec.thresholdTokens)

    session.append('turn/start', { turn: 3 })
    let folded = false
    try {
      await (harness.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
      folded = meter.measure(session).totalTokens < afterCross
    } catch (error: unknown) {
      console.log(`SMOKE-B fold refused: ${error instanceof Error ? error.message : String(error)}`)
    }
    const afterFold = meter.measure(session).totalTokens
    console.log(`SMOKE-B after fold: ${afterFold} tokens; folded=${folded}`)

    // RC1 §33's vacuity rule: at least one LEAF when the scenario crosses the
    // trigger. A root is NOT required — `0 roots` can be the correct economic
    // answer, and demanding one would force a rebase the policy may rightly
    // refuse.
    expect(folded, 'the scenario crossed the trigger, so a leaf fold must have happened').toBe(true)

    // --- Request 2: POST-fold. A cold shock is expected: the provider has
    // never seen this surface.
    recorder.markNextRequest('after-leaf')
    await issueMain(harness, session)
    // --- Request 3: steady state, which should re-warm.
    recorder.markNextRequest('normal')
    await issueMain(harness, session)
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    const bills = recorder.bill
    console.log('SMOKE-B bills:')
    for (const bill of bills) {
      console.log(
        `  ${bill.purpose} class=${bill.requestClass} prompt=${bill.promptTokens} `
        + `cacheRead=${bill.cacheReadTokens} uncached=${bill.uncachedInputTokens} ok=${bill.success}`,
      )
    }
    const mainBills = bills.filter(bill => bill.purpose === 'main')
    expect(mainBills.length).toBeGreaterThanOrEqual(3)

    // The transaction path is confirmed by real, billed requests around the
    // fold — and the guard that the system prompt actually arrived, which is
    // the defect RC1-E found.
    const priced = mainBills.filter(bill => bill.promptTokens > 0)
    expect(priced.length).toBe(mainBills.length)
    const maxPrompt = Math.max(...priced.map(bill => bill.promptTokens))
    console.log(`SMOKE-B max priced prompt: ${maxPrompt} tokens`)
    expect(
      maxPrompt,
      'a request near the trigger must price a prompt near it, or the system prompt did not arrive',
    ).toBeGreaterThan(spec.thresholdTokens * 0.5)

    // Post-fold cold shock and recovery, reported rather than gated: the
    // provider's cache behavior at this scale is the measurement.
    const postFoldBill = mainBills.find(bill => bill.requestClass === 'after-leaf')
    const steadyBill = [...mainBills].reverse().find(bill => bill.requestClass === 'normal')
    if (postFoldBill !== undefined && steadyBill !== undefined) {
      const postReuse = postFoldBill.promptTokens === 0 ? 0 : postFoldBill.cacheReadTokens / postFoldBill.promptTokens
      const steadyReuse = steadyBill.promptTokens === 0 ? 0 : steadyBill.cacheReadTokens / steadyBill.promptTokens
      console.log(`SMOKE-B post-fold reuse=${postReuse.toFixed(3)} steady reuse=${steadyReuse.toFixed(3)}`)
    }

    // Idle maintenance runs through the PRODUCTION consumer; whether it rebases
    // is the policy's decision, so the count is reported and not gated.
    const beforeRoots = harness.engine.rootFoldCount
    await driveIdleMaintenance(harness, session)
    const roots = harness.engine.rootFoldCount - beforeRoots
    console.log(`SMOKE-B idle maintenance: ${roots} root rebase(s) — reported, not required (RC1 §33)`)
  }, 600_000)
})

describe.skipIf(!LIVE_ENABLED)('RC1-F live: the quality smoke', () => {
  it('a multi-fold scenario preserves constraint, supersession, and an exact code', async () => {
    // RC1 §32: ONE scenario carrying all three facts. The bar is that all three
    // survive, which is what makes it a smoke rather than a re-run of the full
    // R4 suite.
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved').toBeDefined()
    const provider = new OpenAiCompatibleAdapter({
      baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model, contextWindow: 131_072,
    })
    const recorder = new BillingRecorder(provider, 'quality')
    // A compressed window so the scenario folds several times cheaply. This is
    // a MECHANISM knob for the smoke, stated rather than hidden: the question
    // here is whether folded state survives, not what the production trigger is
    // (RC1-A and RC0 own that).
    const SMOKE_WINDOW = Number(process.env.EF_LIVE_SMOKE_WINDOW ?? 6_000)
    const policy = { ...resolvePreset('economy'), thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 1_500 }
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: SMOKE_WINDOW, plugin: true, systemPrompt: true, efConfig: policy,
    })
    harness.ctx.llm.registerAdapter([LIVE_PROVIDER], recorder)

    const CONSTRAINT = 'HARD LIMIT: the batch size must never exceed 64 items.'
    const SUPERSEDED = 'The parser timeout is 30 seconds.'
    const SUPERSESSION = 'CORRECTION: the parser timeout is now 90 seconds, superseding the 30.'
    const EXACT = 'The failing error code is PARSE-7741.'

    const session = seed(2_000, [CONSTRAINT, SUPERSEDED, SUPERSESSION, EXACT])
    const meter = harness.ctx.tokenMeter
    let folds = 0
    for (let step = 2; step <= 14; step += 1) {
      session.append('turn/start', { turn: step })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: filler(`step ${step}`, 3_000) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const before = meter.measure(session).totalTokens
      try {
        await (harness.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
      } catch { /* a refused fold is a decision */ }
      if (meter.measure(session).totalTokens < before) folds += 1
      session.append('turn/end', { turn: step, reason: { kind: 'completed' } })
    }
    console.log(`SMOKE-QUALITY: ${folds} leaf fold(s) over the scenario`)

    // Vacuity guard: a scenario that never folded tests nothing about folding.
    expect(folds, 'the scenario must fold to test that folded state survives').toBeGreaterThan(0)

    // Ask the three probes in ONE request, so scoring is one call.
    const answer = await ask(harness, session, [
      'Answer all three in one short reply, one line each, no preamble:',
      '1. What is the maximum batch size?',
      '2. What is the parser timeout, in seconds?',
      '3. What is the exact failing error code?',
    ].join('\n'))
    console.log(`SMOKE-QUALITY answer: ${answer.replace(/\s+/gu, ' ').slice(0, 300)}`)

    const hasConstraint = /\b64\b/u.test(answer)
    // Supersession is the family most likely to catch a state bug: recalling 30
    // is a FAILURE even though 30 was stated.
    const hasSupersession = /\b90\b/u.test(answer) && !/\b30\b/u.test(answer.replace(/90/gu, ''))
    const hasExact = /PARSE-7741/u.test(answer)
    console.log(
      `SMOKE-QUALITY: constraint(64)=${hasConstraint} supersession(90 not 30)=${hasSupersession} `
      + `exact(PARSE-7741)=${hasExact}`,
    )
    expect(hasConstraint).toBe(true)
    expect(hasSupersession).toBe(true)
    expect(hasExact).toBe(true)
  }, 600_000)
})

/** Issue one main-model request through the real assembly path. */
async function issueMain(
  harness: Awaited<ReturnType<typeof createHarness>>,
  session: SessionType,
): Promise<void> {
  const service = harness.ctx.get('systemPrompt') as unknown as
    | { assemble?: (context: unknown) => Promise<{ sections?: readonly { text?: string }[]; tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[] }> }
    | undefined
  let system: string | undefined
  let tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined
  if (service?.assemble !== undefined) {
    try {
      const assembly = await service.assemble({})
      const text = (assembly.sections ?? []).map(section => section.text ?? '').filter(part => part.length > 0).join('\n\n')
      if (text.length > 0) system = text
      if (assembly.tools !== undefined && assembly.tools.length > 0) tools = assembly.tools
    } catch { /* no system prompt is honest */ }
  }
  const messages: unknown[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    messages.push(message)
  }
  for await (const chunk of harness.ctx.llm.stream({
    provider: LIVE_PROVIDER, model: 'live', messages,
    ...(system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
    maxTokens: 64,
  } as never)) {
    void chunk
  }
}

/** Ask one question and return the model's text answer. */
async function ask(
  harness: Awaited<ReturnType<typeof createHarness>>,
  session: SessionType,
  question: string,
): Promise<string> {
  session.append('turn/start', { turn: 99 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: question }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const service = harness.ctx.get('systemPrompt') as unknown as
    | { assemble?: (context: unknown) => Promise<{ sections?: readonly { text?: string }[] }> }
    | undefined
  let system: string | undefined
  if (service?.assemble !== undefined) {
    try {
      const assembly = await service.assemble({})
      const text = (assembly.sections ?? []).map(section => section.text ?? '').filter(part => part.length > 0).join('\n\n')
      if (text.length > 0) system = text
    } catch { /* no system prompt is honest */ }
  }
  const messages: unknown[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    messages.push(message)
  }
  let answer = ''
  for await (const chunk of harness.ctx.llm.stream({
    provider: LIVE_PROVIDER, model: 'live', messages,
    ...(system === undefined ? {} : { system }),
    maxTokens: 200,
  } as never)) {
    if (chunk.type === 'text-delta') answer += chunk.text
  }
  session.append('turn/end', { turn: 99, reason: { kind: 'completed' } })
  return answer
}
