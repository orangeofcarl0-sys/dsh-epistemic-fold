/**
 * R3-F: live behavioral validation over a MULTI-FOLD / MULTI-REBASE trajectory.
 *
 * Both earlier live tiers validated a single deep fold. R2's report states
 * plainly that this left the rebase path behaviorally unvalidated, because the
 * harness built a whole session and then folded once — so the fold-and-rebase
 * CHAIN that R2-C's economics actually selects was never exercised against a
 * real model.
 *
 * This suite closes that gap. The session grows INCREMENTALLY: each step
 * appends a turn, runs the pressure fold inside it, closes it, and emits a real
 * idle transition so the PRODUCTION consumer (R3-0b) decides and performs any
 * rebase. That is the shape the product runs, and it is the shape R2 could not
 * test.
 *
 * What is being asked is narrow and falsifiable: after 4-8 maintenance events,
 * do the planted facts still survive the chain? A policy that saves tokens by
 * folding differently may also save tokens by forgetting differently, and that
 * is the failure this test exists to catch.
 *
 * Three arms, identical history, machine-scored:
 *
 *   B1  Basic             its own lossy narrative summary
 *   E0  EF legacy         fold whenever structurally legal, no rebase
 *   E3  EF economy        economic admission + rebase + system-dedup framing
 *
 * Opt-in: set `EF_LIVE=1`. Without a route every test SKIPS and asserts
 * nothing, so an untested behavior is never reported as a passing one.
 *
 * @module tests/r3f-live-chain
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { createAnchorService } from '../src/anchor-service.ts'
import { anchorSourceSeqs } from './anchor-fixture.ts'
import { locateFoldFrontier } from '../src/frontier.ts'
import { driveIdleMaintenance } from '../bench/paired-baseline.ts'
import { LIVE_ENABLED, LIVE_PROVIDER, MODEL_OPTIONS } from './live-gate.ts'

/** Turns of incremental growth. Each one is a candidate maintenance event. */
const GROWTH_TURNS = Number(process.env.EF_LIVE_GROWTH ?? 24)
/** Deliberately far below the model's real capacity: the point is to CHAIN. */
const POLICY_WINDOW = Number(process.env.EF_LIVE_WINDOW ?? 6_000)
const REPLICATES = Number(process.env.EF_LIVE_REPLICATES ?? 2)


interface Fact {
  readonly id: string
  readonly plant: string
  readonly probe: string
  readonly check: (answer: string) => boolean
  readonly anchor: {
    readonly kind: 'constraint' | 'value' | 'failure'
    readonly authority: 'normative' | 'decision' | 'empirical'
    readonly value: unknown
    readonly stateKey: { namespace: string; entity: string; property: string }
  }
}

const FACTS: readonly Fact[] = [
  {
    id: 'api-constraint',
    plant: 'Hard constraint: the public API must NOT change. No new required parameters, no renamed fields.',
    probe: 'May I add a new required parameter to the public API endpoint? Answer yes or no, then one short sentence.',
    check: answer => /\bno\b/iu.test(answer.slice(0, 40)),
    anchor: {
      kind: 'constraint', authority: 'normative',
      value: 'the public API must not change',
      stateKey: { namespace: 'scope', entity: 'work', property: 'public-api' },
    },
  },
  {
    id: 'timeout-value',
    plant: 'Configuration: the worker timeout was 30 seconds, and after the incident review it is now 60 seconds. 30 is superseded.',
    probe: 'What is the current worker timeout in seconds? Reply with only the number.',
    check: answer => /\b60\b/u.test(answer) && !/\b30\b/u.test(answer),
    anchor: {
      kind: 'value', authority: 'decision', value: 60,
      stateKey: { namespace: 'config', entity: 'worker', property: 'timeout' },
    },
  },
  {
    id: 'open-failure',
    plant: 'Known unresolved failure: 2 tests in the parser module fail with an unexpected token at line 42. Not fixed yet.',
    probe: 'Is there any known unresolved failure in the parser module? Answer yes or no.',
    check: answer => /\byes\b/iu.test(answer.slice(0, 40)),
    anchor: {
      kind: 'failure', authority: 'empirical', value: '2 tests fail in the parser module',
      stateKey: { namespace: 'failure', entity: 'test', property: 'parser' },
    },
  },
]

/**
 * Deterministic filler for one growth turn. Sized so a single turn can push the
 * surface over the threshold: the chain must fold REPEATEDLY, and a turn too
 * small to matter would leave every arm reading unfolded history.
 */
function stepFiller(step: number): string {
  return Array.from(
    { length: 30 },
    (_, index) =>
      `${'payload detail '.repeat(40)}step ${step} note ${index} of the `
      + `${['build', 'lint', 'docs', 'metrics', 'config'][index % 5]} subsystem`,
  ).join(' ')
}

/** The seeded opening turn: every fact planted, plus an empirical tool result. */
function seedSession(): SessionType {
  const session = Session.create(SessionId(`ef-r3f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: MODEL_OPTIONS },
    reason: 'initial',
  })
  let step = 0
  for (const fact of FACTS) {
    step += 1
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: fact.plant }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Understood: ${fact.plant.slice(0, 60)}` }],
        source: { kind: 'model', ...MODEL_OPTIONS },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })

    if (fact.id === 'open-failure') {
      const callId = ToolCallId('r3f-test-run')
      step += 1
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', {
        stream: [],
        turn: 1,
        step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running the parser test suite.' },
            { type: 'tool-call', id: callId, name: 'test', arguments: '{"suite":"parser"}' },
          ],
          source: { kind: 'model', ...MODEL_OPTIONS },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step, callId, name: 'test', arguments: '{"suite":"parser"}' })
      session.append('tool/result', {
        turn: 1,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'FAIL parser.test.ts\n  2 tests failed\n  unexpected token at line 42' }],
          isError: true,
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/** Declare every fact's anchor through the real authority gate. */
function declareAnchors(session: SessionType): void {
  const service = createAnchorService()
  const { userSeqs, toolResultSeq } = anchorSourceSeqs(session)
  for (const [index, fact] of FACTS.entries()) {
    if (fact.anchor.kind === 'failure') {
      service.declare(session, {
        id: `r3f-${fact.id}`,
        kind: 'failure',
        stateKey: fact.anchor.stateKey,
        value: fact.anchor.value,
        authority: 'empirical',
        failureState: 'open',
        sourceRefs: [{ seq: (toolResultSeq ?? 0) as never }],
      })
      continue
    }
    service.declare(session, {
      id: `r3f-${fact.id}`,
      kind: fact.anchor.kind,
      stateKey: fact.anchor.stateKey,
      value: fact.anchor.value,
      authority: fact.anchor.authority,
      sourceRefs: [{ seq: (userSeqs[index] ?? userSeqs[0] ?? 0) as never }],
    })
  }
}

/** One arm's configuration. */
interface ArmSpec {
  readonly id: string
  readonly basic: boolean
  readonly config: Record<string, unknown>
  readonly idleMaintenance: boolean
}

const ARMS: readonly ArmSpec[] = [
  { id: 'B1-basic', basic: true, config: {}, idleMaintenance: false },
  { id: 'E0-legacy', basic: false, config: {}, idleMaintenance: false },
  {
    id: 'E3-economy',
    basic: false,
    config: {
      leafAdmission: 'economic', rootPolicy: 'economics',
      semanticMode: 'none', framingMode: 'system-dedup',
      // Sized so the frozen prefix actually crosses it within the horizon.
      // A default-sized budget would never trip on a compressed window, and
      // the whole point of this suite is to reach the rebase path.
      frozenCheckpointTokenBudget: 400,
    },
    idleMaintenance: true,
  },
]

/** One arm's measured trajectory. */
interface ArmRun {
  readonly folds: number
  readonly roots: number
  readonly maintenanceEvents: number
  readonly peakTokens: number
  readonly finalFrozen: number
  readonly observations: string[]
}

/**
 * Drive one arm through an INCREMENTAL trajectory.
 *
 * Each turn: grow inside the turn → pressure fold → close the turn → idle
 * maintenance. That order matters: the pressure fold needs an open turn and the
 * rebase needs it closed, so this is the only sequence in which the chain R2-C
 * selects can actually occur.
 */
async function driveChain(arm: ArmSpec, session: SessionType, harness: Harness): Promise<ArmRun> {
  const engine = harness.engine
  const meter = harness.ctx.tokenMeter
  const observations: string[] = []
  let folds = 0
  let roots = 0
  let maintenanceEvents = 0
  let peakTokens = meter.measure(session).totalTokens

  for (let turn = 2; turn <= GROWTH_TURNS + 1; turn += 1) {
    // The idle maintenance window (turn already closed by the previous step).
    if (arm.idleMaintenance) {
      const before = engine.rootFoldCount
      await driveIdleMaintenance(harness, session)
      if (engine.rootFoldCount > before) {
        roots += engine.rootFoldCount - before
        maintenanceEvents += 1
      }
    }

    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: stepFiller(turn) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Acknowledged routine step ${turn}.` }],
        source: { kind: 'model', ...MODEL_OPTIONS },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })

    const before = meter.measure(session).totalTokens
    try {
      await (engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
    } catch { /* a refused fold is a decision, not a failure */ }
    const after = meter.measure(session).totalTokens
    if (after < before) folds += 1
    peakTokens = Math.max(peakTokens, after)
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  observations.push(`folds=${folds} roots=${roots} maintenanceEvents=${maintenanceEvents}`)
  return {
    folds,
    roots,
    maintenanceEvents,
    peakTokens,
    finalFrozen: locateFoldFrontier(session).frozenCount,
    observations,
  }
}

/** The post-trajectory surface plus one probe, as the model would see it. */
function probePrompt(session: SessionType, probe: string): string {
  const lines: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    const text = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .filter(part => part.length > 0)
      .join('\n')
    if (text.length === 0) continue
    lines.push(`[${message.role}] ${text}`)
  }
  lines.push(`[user] ${probe}`)
  return lines.join('\n\n')
}

async function ask(adapter: OpenAiCompatibleAdapter, prompt: string): Promise<string> {
  const parts: string[] = []
  for await (const chunk of adapter.stream({
    provider: LIVE_PROVIDER,
    model: 'live',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 60,
  } as never)) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
  }
  return parts.join('').trim()
}

describe.skipIf(!LIVE_ENABLED)('R3-F live: multi-fold / multi-rebase chain', () => {
  const route = resolveLiveRoute()

  it('a chained fold+rebase trajectory preserves the planted facts', async () => {
    expect(route, 'no live route resolved; the chain gate stays OPEN').toBeDefined()

    interface Tally { pass: number; total: number; runs: ArmRun[] }
    const tallies = new Map<string, Tally>()
    for (const arm of ARMS) tallies.set(arm.id, { pass: 0, total: 0, runs: [] })

    for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
      for (const arm of ARMS) {
        const adapter = new OpenAiCompatibleAdapter({
          baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model,
          contextWindow: POLICY_WINDOW,
        })
        const harness = await createHarness({}, {
          contextWindow: POLICY_WINDOW,
          ...(arm.basic
            ? { engine: 'basic' as const }
            : { plugin: true, systemPrompt: arm.config['framingMode'] === 'system-dedup' }),
          ...(arm.basic ? {} : { adapter: { provider: LIVE_PROVIDER, instance: adapter } }),
          efConfig: { thresholdRatio: 0.9, headroomTokens: 0, retainTokens: 0, maxTokens: 1_024, ...arm.config },
        })
        const session = seedSession()
        if (!arm.basic) declareAnchors(session)
        // The Basic arm reads a real adapter only through its own summarize
        // path, which needs the route registered on the context.
        if (arm.basic) harness.ctx.llm.registerAdapter([LIVE_PROVIDER], adapter)

        const run = await driveChain(arm, session, harness)
        const tally = tallies.get(arm.id)!
        tally.runs.push(run)

        // Probe immediately after the chain: this is the state the model would
        // actually be asked to continue from.
        for (const fact of FACTS) {
          tally.total += 1
          const answer = await ask(adapter, probePrompt(session, fact.probe))
          if (fact.check(answer)) tally.pass += 1
          if (replicate === 0) {
            console.log(`  ${arm.id} ${fact.id}: ${JSON.stringify(answer.slice(0, 70))}`)
          }
        }
      }
    }

    for (const arm of ARMS) {
      const tally = tallies.get(arm.id)!
      const aggregate = tally.runs.reduce(
        (sum, r) => ({
          folds: sum.folds + r.folds, roots: sum.roots + r.roots,
          maintenanceEvents: sum.maintenanceEvents + r.maintenanceEvents,
          peak: Math.max(sum.peak, r.peakTokens),
          frozen: r.finalFrozen,
        }),
        { folds: 0, roots: 0, maintenanceEvents: 0, peak: 0, frozen: 0 },
      )
      console.log(
        `${arm.id.padEnd(12)} ${tally.pass}/${tally.total} correct | `
        + `folds=${aggregate.folds} roots=${aggregate.roots} maintenance=${aggregate.maintenanceEvents} `
        + `peak=${aggregate.peak} finalFrozen=${aggregate.frozen}`,
      )
    }

    // --- Vacuity guard, the lesson from the R1/R2 live tiers: a chain claim is
    // worthless if no chain happened. The EF economy arm must have performed
    // MANY folds, and — this is the part R2 could never check — at least one
    // rebase through the production consumer.
    const economyRuns = tallies.get('E3-economy')!.runs
    const totalFolds = economyRuns.reduce((sum, r) => sum + r.folds, 0)
    const totalRoots = economyRuns.reduce((sum, r) => sum + r.roots, 0)
    expect(totalFolds, 'the chain must fold repeatedly').toBeGreaterThanOrEqual(4)
    expect(totalRoots, 'the chain must include rebases — R2 left this unvalidated').toBeGreaterThan(0)

    // --- The gate. Economy mode must not lose facts the baseline keeps.
    const economy = tallies.get('E3-economy')!
    const basic = tallies.get('B1-basic')!
    console.log(`\nquality: basic=${basic.pass}/${basic.total} economy=${economy.pass}/${economy.total}`)
    // R3 §38: the requirement is "not worse than Basic", not "better".
    expect(economy.pass, 'economy mode must not lose facts Basic preserves').toBeGreaterThanOrEqual(basic.pass)
  }, 1_800_000)
})
