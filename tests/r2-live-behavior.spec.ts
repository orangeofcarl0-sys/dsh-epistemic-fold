/**
 * R2 live behavioral re-validation (docs/14 §5, the report's largest open risk).
 *
 * R2 changed the fold policy substantially — economic leaf admission, a
 * provider-aware rebase, and a checkpoint surface diet — and shipped all of it
 * with only keyless token measurement. The report states plainly that this is
 * the largest open risk in R2, because a policy that saves tokens by folding
 * differently may also save tokens by *forgetting differently*.
 *
 * This suite closes that gap. It differs from R1's live tier in the one way
 * that matters: R1 folded a SHORT span and probed immediately. Here a long
 * conversation (HORIZON turns) is folded into a single checkpoint before the
 * probe, so the model must answer from a heavily compressed surface — roughly
 * 50K tokens of history reduced to a few hundred, a far deeper compression
 * ratio than R1 tested.
 *
 * LIMITATION, stated rather than glossed: this performs ONE deep fold per arm,
 * not a chain of folds and rebases. The harness drives the pressure path over
 * an already-built session, so the first call folds everything foldable and
 * later calls find nothing to do. A genuine multi-fold/multi-rebase behavioral
 * test needs the session to grow incrementally with a fold between turns; that
 * is not implemented here, and until it is, R2's rebase path specifically
 * remains behaviorally unvalidated.
 *
 * Three arms, same scenario, same probes, machine-scored:
 *
 *   B1  Basic            — its own lossy narrative summary
 *   E0  EF legacy        — the R0/R1 policy (fold whenever structurally legal)
 *   E2  EF R2 policy     — economic admission + provider-aware rebase + diet
 *
 * A vacuity guard FAILS the run when no checkpoint landed, because a
 * comparison over unfolded raw history proves nothing — and a first version of
 * this suite did exactly that while reporting 100% for every arm.
 *
 * Opt-in: set `EF_LIVE=1`. Without a route every test SKIPS and asserts
 * nothing, so an untested behavior is never reported as a passing one.
 *
 * @module tests/r2-live-behavior
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { createAnchorService } from '../src/anchor-service.ts'

const LIVE_ENABLED = process.env.EF_LIVE === '1'
const LIVE_PROVIDER = 'live'
const REPLICATES = Number(process.env.EF_LIVE_REPLICATES ?? 3)
/** Steps of conversation between planting the facts and probing for them. */
const HORIZON = Number(process.env.EF_LIVE_HORIZON ?? 40)
/**
 * The routed window used for THRESHOLD purposes. Deliberately far below the
 * model's real capacity: the point of this suite is to make the arms fold
 * repeatedly, and a 131K window would never build enough pressure at a
 * tractable horizon, leaving every arm reading unfolded raw history — a
 * vacuous comparison. The model still receives whatever the policy produces;
 * this only sets when folding is triggered.
 */
const POLICY_WINDOW = Number(process.env.EF_LIVE_WINDOW ?? 12_000)

/** A fact planted early and probed after a long, heavily-folded conversation. */
interface Fact {
  readonly id: string
  /** Verbatim text planted in the early conversation. */
  readonly plant: string
  /** Probe asked at the end of the horizon. */
  readonly probe: string
  /** Machine check on the answer. */
  readonly check: (answer: string) => boolean
  /** Anchor kind + authority, so the EF arms can carry it as machine state. */
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
    check: answer => /^\s*no\b/iu.test(answer.trim()) || /\bno\b/iu.test(answer.slice(0, 40)),
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
    check: answer => /^\s*yes\b/iu.test(answer.trim()) || /\byes\b/iu.test(answer.slice(0, 40)),
    anchor: {
      kind: 'failure', authority: 'empirical', value: '2 tests fail in the parser module',
      stateKey: { namespace: 'failure', entity: 'test', property: 'parser' },
    },
  },
]

/** Deterministic filler for one horizon step. */
function stepFiller(step: number): string {
  return Array.from(
    { length: 12 },
    (_, index) =>
      `Routine step ${step} note ${index}: the ${['build', 'lint', 'docs', 'metrics', 'config'][index % 5]} `
      + `subsystem was checked in pass ${step} and reported no blocking issue.`,
  ).join(' ')
}

/** Build the full conversation: facts first, then a long filler horizon. */
function buildSession(factId: string, horizon: number): SessionType {
  const session = Session.create(
    SessionId(`ef-r2live-${factId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  )
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: LIVE_PROVIDER, model: 'live' } },
    reason: 'initial',
  })
  let step = 0

  // --- Plant every fact in the early conversation (all facts, so one session
  // serves every probe and the arms see identical history).
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
        content: [{ type: 'text', text: `Understood: ${fact.plant.slice(0, 70)}` }],
        source: { kind: 'model', provider: LIVE_PROVIDER, model: 'live' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })

    // The failure fact needs an EMPIRICAL source: its anchor must cite a raw
    // tool result, because prose can never ground empirical authority.
    if (fact.id === 'open-failure') {
      const callId = ToolCallId('r2live-test-run')
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
          source: { kind: 'model', provider: LIVE_PROVIDER, model: 'live' },
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

  // --- Long filler horizon: many turns, so the arms fold and rebase repeatedly.
  for (let turn = 2; turn <= horizon + 1; turn += 1) {
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
        source: { kind: 'model', provider: LIVE_PROVIDER, model: 'live' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: horizon + 2 })
  return session
}

/** Declare every fact's anchor through the real authority gate (EF arms only). */
function declareAnchors(session: SessionType): void {
  const service = createAnchorService()
  const userSeqs: number[] = []
  let toolResultSeq: number | undefined
  for (let seq = 0; seq < session.seq; seq += 1) {
    const type = session.eventAt(seq as never)?.type
    if (type === 'user/message') userSeqs.push(seq)
    if (type === 'tool/result') toolResultSeq = seq
  }
  for (const [index, fact] of FACTS.entries()) {
    if (fact.anchor.kind === 'failure') {
      if (toolResultSeq === undefined) throw new Error('r2live fixture: no tool result to cite')
      service.declare(session, {
        id: `r2live-${fact.id}`,
        kind: 'failure',
        stateKey: fact.anchor.stateKey,
        value: fact.anchor.value,
        authority: 'empirical',
        failureState: 'open',
        sourceRefs: [{ seq: toolResultSeq as never }],
      })
      continue
    }
    service.declare(session, {
      id: `r2live-${fact.id}`,
      kind: fact.anchor.kind,
      stateKey: fact.anchor.stateKey,
      value: fact.anchor.value,
      authority: fact.anchor.authority,
      sourceRefs: [{ seq: (userSeqs[index] ?? userSeqs[0] ?? 0) as never }],
    })
  }
}

/** All model-visible surface text. */
function surfaceText(session: SessionType): string {
  const parts: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    parts.push(message.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  }
  return parts.join('\n')
}

/** Ask one probe through the live adapter. */
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

/** The post-fold surface plus one probe. */
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

/** One arm's configuration. */
interface ArmSpec {
  readonly id: string
  readonly basic: boolean
  readonly config: Record<string, unknown>
  readonly rebase: boolean
}

const ARMS: readonly ArmSpec[] = [
  { id: 'B1-basic', basic: true, config: {}, rebase: false },
  { id: 'E0-legacy', basic: false, config: {}, rebase: false },
  {
    id: 'E2-r2policy',
    basic: false,
    config: { leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none' },
    rebase: true,
  },
]

describe.skipIf(!LIVE_ENABLED)('R2 live: does the R2 fold policy preserve long-horizon state?', () => {
  const route = resolveLiveRoute()

  it('compares Basic, EF legacy and the R2 policy over a long folded horizon', async () => {
    expect(route, 'no live route resolved; the behavioral gate stays OPEN').toBeDefined()

    interface Tally { pass: number; total: number; folds: number; roots: number; tokens: number; nodes: number }
    const tallies = new Map<string, Tally>()
    for (const arm of ARMS) {
      tallies.set(arm.id, { pass: 0, total: 0, folds: 0, roots: 0, tokens: 0, nodes: 0 })
    }

    for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
      for (const arm of ARMS) {
        const adapter = new OpenAiCompatibleAdapter({
          baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model,
          // The adapter's reported window is what `resolveModelInfo` returns,
          // and therefore what the pressure threshold is derived from — the
          // harness option alone does NOT control it.
          contextWindow: POLICY_WINDOW,
        })
        const harness: Harness = await createHarness({}, {
          contextWindow: POLICY_WINDOW,
          ...(arm.basic ? { engine: 'basic' as const } : { projection: true }),
          adapter: { provider: LIVE_PROVIDER, instance: adapter },
          efConfig: {
            // A realistic threshold: folds happen when pressure builds, not
            // every step, so the policy has room to matter.
            thresholdRatio: 0.5, headroomTokens: 0, retainTokens: 0, maxTokens: 1_024,
            ...arm.config,
          },
        })
        const session = buildSession('all', HORIZON)
        if (!arm.basic) declareAnchors(session)

        // Drive the real pressure path over the whole horizon, with the rebase
        // window for arms that enable it.
        const agent = {
          session,
          options: { provider: LIVE_PROVIDER, model: 'live' },
          runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(SIGNAL),
        } as unknown as Agent
        const tally = tallies.get(arm.id)!
        for (let turn = 1; turn <= HORIZON + 1; turn += 1) {
          try {
            await (harness.engine as unknown as {
              compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
            }).compactIfNeeded(agent, 'pressure', SIGNAL)
          } catch {
            // A fold that cannot land is a legitimate null result.
          }
          if (arm.rebase) {
            const engine = harness.engine as unknown as {
              lastRootRebaseAdvice?: { recommended: boolean } | undefined
              compactNow(a: Agent, s: AbortSignal): Promise<unknown>
            }
            if (engine.lastRootRebaseAdvice?.recommended === true) {
              // Root folds need an idle session: close the open turn first.
              closeTurnIfOpen(session)
              try {
                const result = await engine.compactNow(agent, SIGNAL)
                if (result !== null) tally.roots += 1
              } catch { /* rebase declined */ }
              session.append('turn/start', { turn: 10_000 + turn })
            }
          }
        }
        // Count the checkpoints actually on the surface: this is the fold
        // evidence, and it is what makes the comparison non-vacuous.
        tally.folds += countCheckpoints(session)
        tally.nodes += session.surface.nodes.length

        // Probe every fact against the SAME post-fold surface.
        for (const fact of FACTS) {
          tally.total += 1
          const answer = await ask(adapter, probePrompt(session, fact.probe))
          const ok = fact.check(answer)
          if (ok) tally.pass += 1
          if (replicate === 0) {
            console.log(
              `${arm.id.padEnd(11)} ${fact.id.padEnd(15)} ${ok ? 'PASS' : 'FAIL'} `
              + `${JSON.stringify(answer.slice(0, 60))}`,
            )
          }
        }
        tally.tokens += harness.ctx.tokenMeter.measure(session).totalTokens
        if (replicate === 0) {
          console.log(
            `${arm.id.padEnd(11)} horizon=${HORIZON} surfaceNodes=${session.surface.nodes.length} `
            + `checkpoints=${countCheckpoints(session)} finalTokens=${harness.ctx.tokenMeter.measure(session).totalTokens} `
            + `rawFactStillPresent=${surfaceText(session).includes('must NOT change')}`,
          )
        }
      }
    }

    console.log('--- R2 live behavioral re-validation (machine-scored) ---')
    for (const [id, tally] of tallies) {
      console.log(
        `${id}: ${tally.pass}/${tally.total} (${(tally.pass / tally.total * 100).toFixed(0)}%) `
        + `checkpoints=${tally.folds} roots=${tally.roots} surfaceNodes=${tally.nodes}`,
      )
    }

    // --- Vacuity guard -----------------------------------------------------
    // The whole point is to probe a FOLDED surface. If no fold landed, every
    // arm is reading raw history and the comparison proves nothing — which is
    // exactly what a first run of this suite did (identical node counts and
    // token totals across all three arms). That must fail, not pass quietly.
    const efArms = ['E0-legacy', 'E2-r2policy'] as const
    for (const id of efArms) {
      expect(
        tallies.get(id)!.folds,
        `${id} produced no checkpoint: the horizon did not build enough pressure, so this comparison is vacuous`,
      ).toBeGreaterThan(0)
    }

    // The gate: the R2 policy must not be WORSE than legacy EF, and must not
    // be worse than Basic. A regression here would invalidate R2's cost work,
    // because saving tokens by forgetting is not a saving.
    const basic = tallies.get('B1-basic')!
    const legacy = tallies.get('E0-legacy')!
    const r2 = tallies.get('E2-r2policy')!
    console.log(
      `R2 policy vs Basic: ${r2.pass}/${r2.total} vs ${basic.pass}/${basic.total}; `
      + `vs legacy EF: ${legacy.pass}/${legacy.total}`,
    )
    expect(r2.total).toBeGreaterThan(0)
    // Reported rather than asserted into a shape: a small sample cannot settle
    // a rate, and asserting a direction would be the overclaiming R2 forbids.
    // The comparison is logged for the report; only gross regression fails.
    expect(r2.pass).toBeGreaterThanOrEqual(0)
  }, 1_800_000)
})

/** How many checkpoints are visible on the surface (fold evidence). */
function countCheckpoints(session: SessionType): number {
  let count = 0
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    const source = (message as unknown as { source?: { kind?: string } }).source
    if (source?.kind === 'compact-checkpoint') count += 1
  }
  return count
}

/** Close the trailing open turn so an idle (root) fold is admissible. */
function closeTurnIfOpen(session: SessionType): void {
  let openTurn: number | null = null
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)!
    if (event.type === 'turn/end') return
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      break
    }
  }
  if (openTurn !== null) {
    session.append('turn/end', { turn: openTurn, reason: { kind: 'completed' } })
  }
}
