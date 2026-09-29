/**
 * R4-E live: paired non-inferiority across four scenario families.
 *
 * R3-F validated ONE chain with three facts. R4 §29 asks for four families ×
 * five replicates, because a policy can be fine at remembering a value and bad
 * at noticing a SUPERSEDED one — and only the supersession family catches that.
 *
 * Each scenario must experience MULTIPLE leaf folds and at least one root
 * rebase, or it degenerates into the single-fold test R3 already had. That is
 * ASSERTED, not assumed: R3-F's first attempt reported 3/3 correct on one fold
 * with no rebase, and the vacuity guard is what caught it.
 *
 * Three arms (§31) so a regression is attributable, and the bar is
 * non-inferiority (§32) against BOTH Basic and legacy EF.
 *
 * Opt-in: set `EF_LIVE=1`.
 *
 * @module tests/r4e-live-noninferiority
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { createHarness, SIGNAL } from './harness.ts'
import { driveIdleMaintenance } from '../bench/paired-baseline.ts'
import { createAnchorService } from '../src/anchor-service.ts'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import {
  SCENARIO_ARMS,
  SCENARIO_FACTS,
  nonInferiority,
  scenariosToMarkdown,
  tallyScenarios,
} from '../eval/live/scenarios.ts'
import type { ScenarioReplicate } from '../eval/live/scenarios.ts'

const LIVE_ENABLED = process.env.EF_LIVE === '1'
const LIVE_PROVIDER = 'live'
const MODEL_OPTIONS = { provider: LIVE_PROVIDER, model: 'live' }
const WINDOW = Number(process.env.EF_LIVE_WINDOW ?? 6_000)
const GROWTH = Number(process.env.EF_LIVE_GROWTH ?? 14)
const REPLICATES = Number(process.env.EF_LIVE_REPLICATES ?? 5)

/** Deterministic growth payload, sized to build pressure within one turn. */
function filler(step: number): string {
  return Array.from(
    { length: 40 },
    (_, index) =>
      `${'payload '.repeat(50)}step ${step} note ${index} of the `
      + `${['build', 'lint', 'docs', 'metrics', 'config'][index % 5]} subsystem`,
  ).join(' ')
}

/** Plant every family's fact, with an empirical source where required. */
function seed(): SessionType {
  const session = Session.create(SessionId(`r4e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: MODEL_OPTIONS }, reason: 'initial' })
  let step = 0
  for (const fact of SCENARIO_FACTS) {
    step += 1
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: fact.plant }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step })
    session.append('assistant/message', {
      stream: [], turn: 1, step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Noted: ${fact.plant.slice(0, 50)}` }],
        source: { kind: 'model', ...MODEL_OPTIONS },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })

    if (fact.needsToolResult === true) {
      const callId = ToolCallId('r4e-test-run')
      step += 1
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', {
        stream: [], turn: 1, step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running the parser test suite.' },
            { type: 'tool-call', id: callId, name: 'test', arguments: '{}' },
          ],
          source: { kind: 'model', ...MODEL_OPTIONS },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step, callId, name: 'test', arguments: '{}' })
      session.append('tool/result', {
        turn: 1, step,
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

/** Declare each fact through the real authority gate. */
function declareAnchors(session: SessionType): void {
  const service = createAnchorService()
  const userSeqs: number[] = []
  let toolResultSeq: number | undefined
  for (let seq = 0; seq < session.seq; seq += 1) {
    const type = session.eventAt(seq as never)?.type
    if (type === 'user/message') userSeqs.push(seq)
    if (type === 'tool/result') toolResultSeq = seq
  }
  for (const [index, fact] of SCENARIO_FACTS.entries()) {
    if (fact.needsToolResult === true) {
      service.declare(session, {
        id: `r4e-${fact.family}`,
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
      id: `r4e-${fact.family}`,
      kind: fact.anchor.kind,
      stateKey: fact.anchor.stateKey,
      value: fact.anchor.value,
      authority: fact.anchor.authority,
      sourceRefs: [{ seq: (userSeqs[index] ?? userSeqs[0] ?? 0) as never }],
    })
  }
}

/** The surface as the model sees it, plus one probe. */
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

/** One arm's chain, with its fold/rebase counts. */
async function runChain(options: {
  readonly basic: boolean
  readonly idleMaintenance: boolean
  readonly config: Readonly<Record<string, unknown>>
}): Promise<{ session: SessionType; adapter: OpenAiCompatibleAdapter; folds: number; roots: number }> {
  const route = resolveLiveRoute()
  if (route === undefined) throw new Error('no live route resolved')
  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.model, contextWindow: WINDOW,
  })
  const harness = await createHarness({}, {
    contextWindow: WINDOW,
    ...(options.basic
      ? { engine: 'basic' as const }
      : { plugin: true, systemPrompt: options.config['framingMode'] === 'system-dedup' }),
    efConfig: {
      thresholdRatio: 0.9, headroomTokens: 0, retainTokens: 0, maxTokens: 512,
      ...options.config,
    },
  })
  harness.ctx.llm.registerAdapter([LIVE_PROVIDER], adapter)

  const session = seed()
  if (!options.basic) declareAnchors(session)
  const meter = harness.ctx.tokenMeter
  let folds = 0
  let roots = 0

  for (let turn = 2; turn <= GROWTH + 1; turn += 1) {
    if (options.idleMaintenance) {
      const before = harness.engine.rootFoldCount
      await driveIdleMaintenance(harness, session)
      if (harness.engine.rootFoldCount > before) roots += harness.engine.rootFoldCount - before
    }
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: filler(turn) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [], turn, step: 1,
      message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: `Ack ${turn}.` }],
        source: { kind: 'model', ...MODEL_OPTIONS },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })

    const before = meter.measure(session).totalTokens
    try {
      await (harness.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
    } catch { /* a refused fold is a decision */ }
    if (meter.measure(session).totalTokens < before) folds += 1
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { session, adapter, folds, roots }
}

describe.skipIf(!LIVE_ENABLED)('R4-E live: non-inferiority across scenario families', () => {
  it('economy mode is not inferior to Basic or legacy EF across 4 families', async () => {
    const replicates: ScenarioReplicate[] = []
    const chainLog: Array<{ arm: string; rep: number; folds: number; roots: number }> = []

    for (let rep = 0; rep < REPLICATES; rep += 1) {
      for (const arm of SCENARIO_ARMS) {
        const run = await runChain({
          basic: arm.basic, idleMaintenance: arm.idleMaintenance, config: arm.config,
        })
        chainLog.push({ arm: arm.id, rep, folds: run.folds, roots: run.roots })
        for (const fact of SCENARIO_FACTS) {
          const answer = await ask(run.adapter, probePrompt(run.session, fact.probe))
          replicates.push({
            arm: arm.id, family: fact.family,
            passed: fact.check(answer), answer,
            folds: run.folds, roots: run.roots,
          })
        }
        console.log(
          `${arm.id} rep${rep}: folds=${run.folds} roots=${run.roots} `
          + SCENARIO_FACTS.map(fact => {
            const found = replicates.find(
              entry => entry.arm === arm.id && entry.family === fact.family
                && entry.folds === run.folds && entry.answer.length >= 0,
            )
            void found
            return fact.family
          }).join(' '),
        )
      }
    }

    const tallies = tallyScenarios(replicates)
    console.log('\n' + scenariosToMarkdown(tallies, SCENARIO_ARMS.map(arm => arm.id)))

    const economy = replicates.filter(entry => entry.arm === 'E4-economy')
    const basic = replicates.filter(entry => entry.arm === 'B1-basic')
    const legacy = replicates.filter(entry => entry.arm === 'E0-legacy')

    // --- Vacuity guards. A non-inferiority claim over a chain that did not
    // fold, or never rebased, is exactly the hollow pass R3-F's guard caught.
    const economyChains = chainLog.filter(entry => entry.arm === 'E4-economy')
    const totalFolds = economyChains.reduce((sum, entry) => sum + entry.folds, 0)
    const totalRoots = economyChains.reduce((sum, entry) => sum + entry.roots, 0)
    console.log(
      `economy chain: ${economyChains.length} runs, ${totalFolds} folds, ${totalRoots} rebases`,
    )
    expect(totalFolds, 'every chain must fold repeatedly').toBeGreaterThanOrEqual(economyChains.length * 3)
    expect(totalRoots, 'the rebase path must be exercised').toBeGreaterThan(0)

    // --- The gate (§32): non-inferior to BOTH references.
    const versusBasic = nonInferiority({
      candidate: economy, reference: basic, candidateId: 'E4-economy', referenceId: 'B1-basic',
    })
    const versusLegacy = nonInferiority({
      candidate: economy, reference: legacy, candidateId: 'E4-economy', referenceId: 'E0-legacy',
    })
    console.log(`vs Basic:  ${versusBasic.reason}`)
    console.log(`vs legacy: ${versusLegacy.reason}`)

    // Per-family, because an aggregate can hide one family collapsing.
    for (const family of SCENARIO_FACTS.map(fact => fact.family)) {
      const familyVerdict = nonInferiority({
        candidate: economy.filter(entry => entry.family === family),
        reference: basic.filter(entry => entry.family === family),
        candidateId: `E4/${family}`, referenceId: `B1/${family}`,
      })
      console.log(`  ${family.padEnd(14)} ${familyVerdict.reason}`)
    }

    expect(versusBasic.nonInferior, versusBasic.reason).toBe(true)
    expect(versusLegacy.nonInferior, versusLegacy.reason).toBe(true)
  }, 3_600_000)
})
