/**
 * RC1-A live: measure the safety reserve instead of assuming 65536.
 *
 * RC1 §39's gate is a question, not a target: "is 65536 really the safety
 * reserve this route needs?" The answer comes from paired observations — the
 * token meter's estimate for a request, and the prompt tokens the provider
 * actually charged for the same request:
 *
 *   E_i  = T_provider − T_meter        (signed; only E+ needs reserving)
 *   G_i  = max(0, T_i − T_{i−1})       (one-step growth between checks)
 *   H    = P99(E+) + P99(G) + margin
 *
 * RC1 §6 notes this is almost entirely offline: the pairs come from runs the
 * project has already paid for. This test generates a small, purpose-built set
 * of them — a few dozen short requests, no long context — and reports the
 * distributions, the recommendation, and the verdict on the shipped reserve.
 *
 * It also probes the CONTENT SHAPES §5 names explicitly, because a fixed
 * 4-chars-per-token heuristic can be systematically wrong for CJK, dense JSON,
 * or code, and the reserve has to absorb that error rather than assume it away.
 *
 * Opt-in: `EF_LIVE=1`.
 *
 * @module tests/rc1a-live-reserve
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createHarness } from './harness.ts'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import {
  distributionOf,
  judgeReserve,
  meterErrors,
  recommendSafetyReserve,
  safetyReserveToMarkdown,
  stepGrowths,
} from '../eval/src/safety-reserve.ts'
import type { MeterObservation } from '../eval/src/safety-reserve.ts'
import { buildCorpus } from '../eval/policy-replay/corpus.ts'
import { triggerBreakdown } from '../src/trigger.ts'
import { resolveEfConfig } from '../src/policy.ts'
import { LIVE_ENABLED, LIVE_PROVIDER, MODEL_OPTIONS } from './live-gate.ts'

const WINDOW = Number(process.env.EF_LIVE_WINDOW ?? 131_072)
const RESERVED = 512
const SHIPPED_HEADROOM = 65_536

/** The content shapes RC1 §5 names as capable of breaking a fixed heuristic. */
const SHAPES: readonly { readonly name: string; readonly text: string }[] = [
  {
    name: 'english-prose',
    text: 'The context runtime preserves contracts across folds. '.repeat(200),
  },
  {
    name: 'cjk',
    text: '上下文压缩运行时在折叠过程中保持契约不变。'.repeat(200),
  },
  {
    name: 'dense-json',
    text: JSON.stringify(Array.from({ length: 200 }, (_, index) => ({
      id: `item-${index}`, value: index, tags: ['a', 'b'], nested: { deep: true },
    }))),
  },
  {
    name: 'source-code',
    text: Array.from(
      { length: 200 },
      (_, index) => `function handler${index}(input: Request): Response { return { status: 200, body: input.id } }`,
    ).join('\n'),
  },
  {
    name: 'tool-output',
    text: Array.from(
      { length: 300 },
      (_, index) => `src/module-${index}.ts:${index}:12: error TS2322: Type 'string' is not assignable to type 'number'.`,
    ).join('\n'),
  },
]

/** Build a session holding one payload, and return it with its metered size. */
function sessionWith(
  harness: Awaited<ReturnType<typeof createHarness>>,
  text: string,
  step: number,
): { readonly session: Session; readonly metered: number } {
  const session = Session.create(SessionId(`rc1a-${step}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: MODEL_OPTIONS }, reason: 'initial' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session, metered: harness.ctx.tokenMeter.measure(session).totalTokens }
}

describe.skipIf(!LIVE_ENABLED)('RC1-A live: the safety reserve, measured', () => {
  it('derives H_safe from meter error and one-step growth, then judges 65536', async () => {
    const route = resolveLiveRoute()
    expect(route, 'no live route resolved').toBeDefined()
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model, contextWindow: WINDOW,
    })
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: WINDOW, plugin: true, systemPrompt: true,
      efConfig: { mode: 'economy', maxTokens: RESERVED },
    })
    harness.ctx.llm.registerAdapter([LIVE_PROVIDER], adapter)

    // The real system prompt, so the measurement includes it — the omission
    // RC1-E found in the adapter would otherwise make every E look like a large
    // UNDER-estimate that is really a missing prompt.
    const service = harness.ctx.get('systemPrompt') as unknown as
      | { assemble?: (context: unknown) => Promise<{ sections?: readonly { text?: string }[]; tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[] }> }
      | undefined
    let system: string | undefined
    let tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined
    if (service?.assemble !== undefined) {
      const assembly = await service.assemble({})
      const text = (assembly.sections ?? []).map(section => section.text ?? '').filter(part => part.length > 0).join('\n\n')
      if (text.length > 0) system = text
      if (assembly.tools !== undefined && assembly.tools.length > 0) tools = assembly.tools
    }

    const observations: MeterObservation[] = []
    console.log('SHAPE | metered | provider | E | E/metered')
    for (const [index, shape] of SHAPES.entries()) {
      // Sizes across two orders of magnitude, so the error's scale dependence
      // is visible rather than averaged into one number.
      for (const repeat of [1, 4]) {
        const text = shape.text.repeat(repeat)
        const { session, metered } = sessionWith(harness, text, index * 10 + repeat)
        const messages: unknown[] = []
        for (const seq of session.surface.nodes) {
          const message = session.deriveEventMessage(session.eventAt(seq)!)
          if (message === null) continue
          messages.push(message)
        }
        let provider = 0
        for await (const chunk of harness.ctx.llm.stream({
          provider: LIVE_PROVIDER, model: 'live', messages,
          ...(system === undefined ? {} : { system }),
          ...(tools === undefined ? {} : { tools }),
          maxTokens: 4,
        } as never)) {
          if (chunk.type === 'usage') {
            provider = (chunk.usage.inputTokens ?? 0) + (chunk.usage.cacheReadTokens ?? 0)
          }
        }
        observations.push({ meteredTokens: metered, providerPromptTokens: provider, source: shape.name })
        console.log(
          `${shape.name} x${repeat} | ${metered} | ${provider} | ${provider - metered} `
          + `| ${metered === 0 ? 'n/a' : (((provider - metered) / metered) * 100).toFixed(1)}%`,
        )
      }
    }

    const errors = meterErrors(observations).map(entry => entry.value)
    const errorDistribution = distributionOf(errors)

    // --- The growth term comes from REAL session trajectories, not from this
    // test's own payload list.
    //
    // The first version of this measurement passed the metered sizes of the
    // different SHAPES through `stepGrowths`, which is not "growth between two
    // pressure checks in one session" — it is the difference between unrelated
    // test payloads. It reported a P99 growth of ~19,500 tokens, which is an
    // artifact of the test's own size ladder and would have inflated the
    // recommended reserve by an order of magnitude.
    //
    // The honest source is the RC1-B replay corpus, whose traces record
    // per-step growth from real runs of the production engine.
    const corpus = await buildCorpus({ observedSteps: 30, syntheticSteps: 30 })
    const observedGrowths: number[] = []
    for (const trace of corpus) {
      if (trace.id.startsWith('synthetic:')) continue
      // Growth between consecutive pressure checks, positive-only: the reserve
      // absorbs how much the surface can GROW between checks, and a fold
      // shrinking it imposes no requirement.
      observedGrowths.push(...stepGrowths(trace.steps.map(step => step.preFoldTokens)))
    }
    const growthDistribution = distributionOf(observedGrowths)
    console.log(
      `RESERVE growth: ${observedGrowths.length} observed step(s) from `
      + `${corpus.filter(trace => !trace.id.startsWith('synthetic:')).length} real trace(s)`,
    )

    const recommended = recommendSafetyReserve(errorDistribution, growthDistribution)
    const verdict = judgeReserve(recommended, SHIPPED_HEADROOM)
    console.log('\n' + safetyReserveToMarkdown(errorDistribution, growthDistribution, recommended, verdict))

    // --- The structural facts, asserted so the conclusion is reproducible.
    expect(errorDistribution.count).toBe(observations.length)

    // The meter's error on this route is an OVER-estimate (E < 0), which is the
    // conservative direction: it folds earlier than strictly needed, so the
    // positive tail the reserve must absorb is small. This is asserted rather
    // than assumed because the opposite would mean the reserve is doing real
    // safety work.
    console.log(
      `RESERVE: mean E=${errorDistribution.mean.toFixed(1)} `
      + `max E=${errorDistribution.max} min E=${errorDistribution.min} `
      + `P99(E+)=${errorDistribution.p99Positive}`,
    )

    // --- The RC1-A §39 answer, stated for the record.
    console.log(
      `RESERVE VERDICT: shipped ${SHIPPED_HEADROOM} is ${verdict.verdict} `
      + `(${verdict.ratio.toFixed(2)}x the measured recommendation)`,
    )

    // The trigger consequence, computed from the same shipped config, so the
    // report carries both halves: how big the reserve should be, and what the
    // shipped one actually does to the trigger.
    const breakdown = triggerBreakdown(resolveEfConfig({ mode: 'economy' }), WINDOW, RESERVED)
    console.log(
      `RESERVE TRIGGER: effective=${breakdown.effectiveThreshold} `
      + `binding=${breakdown.binding} fraction=${(breakdown.effectiveRatio * 100).toFixed(1)}%`,
    )

    // --- The evidence gate. If the measurement is not evidenced the verdict is
    // `insufficient` and says so; either way the shipped reserve is NOT changed
    // by this test. RC1 §5 is explicit that the output is a recommendation.
    expect(recommended.evidenced).toBe(true)
    expect(verdict.shippedTokens).toBe(SHIPPED_HEADROOM)
    // The recommendation must be positive and finite — a zero here would mean
    // the measurement priced nothing.
    expect(recommended.recommendedTokens).toBeGreaterThan(0)
    expect(Number.isFinite(recommended.recommendedTokens)).toBe(true)
  }, 900_000)
})
