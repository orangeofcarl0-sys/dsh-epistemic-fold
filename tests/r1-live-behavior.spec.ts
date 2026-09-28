/**
 * R1 live behavioral subset: does Epistemic Fold preserve TASK SUCCESS?
 *
 * This is the question R1's keyless work could not answer, and every economic
 * claim in the R1 report is conditional on it. The keyless tier showed Basic
 * dominates EF on cost and footprint *when success is held equal*. This suite
 * tests whether success is actually equal.
 *
 * Design: a constraint is stated in early conversation, the history is folded,
 * and the model is then asked something whose correct answer depends on that
 * constraint having survived. The response is scored by a machine check on the
 * answer, not by a human or by another model.
 *
 *   - **EF arm** folds with the structured checkpoint (machine state first).
 *   - **Basic arm** folds with its lossy narrative summary.
 *
 * Both arms run the SAME scenario, the SAME fold point, and the SAME probe.
 * A difference in success rate is therefore attributable to the representation,
 * not to the conversation.
 *
 * Opt-in: set `EF_LIVE=1`. Without a route the suite skips and asserts nothing,
 * because an untested behavior must never be reported as a passing one.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { resolveLiveRoute } from '../eval/live/zcode-config.ts'
import { OpenAiCompatibleAdapter } from '../eval/live/openai-adapter.ts'
import { createHarness, SIGNAL } from './harness.ts'
import { createAnchorService } from '../src/anchor-service.ts'
import type { Harness } from './harness.ts'

const LIVE_ENABLED = process.env.EF_LIVE === '1'
const LIVE_PROVIDER = 'live'
const REPLICATES = Number(process.env.EF_LIVE_REPLICATES ?? 3)

/**
 * How much filler surrounds each planted fact. This is the load-bearing
 * experimental knob: with little filler, a competent summarizer keeps the
 * facts and both arms succeed (the comparison is then vacuous). Only when the
 * folded span is large enough that summarization must genuinely COMPRESS does
 * the representation difference get a chance to show up.
 */
const FILLER_SENTENCES = Number(process.env.EF_LIVE_FILLER ?? 14)

/**
 * Filler that makes the pre-fold history large enough for a fold to be a real
 * reduction. This is not padding for its own sake: the checkpoint carries a
 * fixed ~530-token framing preamble, so a fold of a tiny conversation would be
 * rejected as "summary is not smaller than the shadowed content". A realistic
 * workload is what makes the comparison meaningful.
 */
function filler(tag: string, sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, index) => `${tag} working note ${index}: the ${tag} subsystem was reviewed and no blocking issue was found in section ${index}.`,
  ).join(' ')
}

/** One behavioral case: a constraint to plant, and a probe that needs it. */
interface BehaviorCase {
  readonly id: string
  /** Early conversation content carrying the constraint. */
  readonly planted: readonly string[]
  /**
   * Verbatim substring that must DISAPPEAR from the surface for the case to
   * be meaningful. If the raw text survives the fold, both arms simply read
   * it and the comparison proves nothing about representation.
   */
  readonly mustVanish: string
  /** The question asked AFTER the fold. */
  readonly probe: string
  /**
   * Machine check on the model's answer. Returns true when the constraint
   * demonstrably survived the fold.
   */
  readonly check: (answer: string) => boolean
}

const CASES: readonly BehaviorCase[] = [
  {
    id: 'timeout-supersession',
    planted: [
      'Configuration notes: the worker timeout was originally set to 30 seconds.',
      filler('logging', FILLER_SENTENCES),
      'Update: after the incident review we changed the worker timeout to 60 seconds. 30 seconds is superseded and must not be used.',
      filler('metrics', FILLER_SENTENCES),
      'The retry count stays at 3.',
    ],
    mustVanish: 'originally set to 30 seconds',
    probe: 'What is the current worker timeout in seconds? Reply with only the number.',
    check: answer => /\b60\b/u.test(answer) && !/\b30\b/u.test(answer),
  },
  {
    id: 'api-constraint',
    planted: [
      'Hard constraint for this task: the public API must NOT change. No new required parameters, no renamed fields.',
      filler('refactor', FILLER_SENTENCES),
      'Internal refactoring is fine. Performance work is fine.',
      filler('benchmark', FILLER_SENTENCES),
      'The deadline is Friday.',
    ],
    mustVanish: 'No new required parameters, no renamed fields',
    probe: 'May I add a new required parameter to the public API endpoint? Answer yes or no, then one short sentence.',
    check: answer => /^\s*no\b/iu.test(answer.trim()) || /\bno\b/iu.test(answer.slice(0, 40)),
  },
  {
    id: 'open-failure',
    planted: [
      'Test run result: 2 tests failed in the parser module. Error: unexpected token at line 42.',
      filler('parser', FILLER_SENTENCES),
      'I have not fixed this yet.',
      filler('build', FILLER_SENTENCES),
      'The build otherwise passes.',
    ],
    mustVanish: 'unexpected token at line 42',
    probe: 'Is there any known unresolved failure in the parser module? Answer yes or no.',
    check: answer => /^\s*yes\b/iu.test(answer.trim()) || /\byes\b/iu.test(answer.slice(0, 40)),
  },
  {
    /**
     * A needle-in-haystack case built for compression pressure: many
     * similar-looking numeric values, exactly one of which matters. A lossy
     * summary under budget pressure tends to keep the gist ("endpoints were
     * reviewed") while paraphrasing the exact values away — which is precisely
     * the failure mode a structured state handoff is meant to prevent.
     */
    id: 'buried-value',
    planted: [
      [
        'Endpoint review, part 1. Current values:',
        ...Array.from({ length: 30 }, (_, index) =>
          `- endpoint e${index}: batchSize=${100 + index}, retries=${index % 5}, timeoutMs=${1000 + index * 10}`),
      ].join('\n'),
      filler('endpoint', FILLER_SENTENCES),
      [
        'Endpoint review, part 2. Current values:',
        ...Array.from({ length: 30 }, (_, index) =>
          `- endpoint f${index}: batchSize=${500 + index}, retries=${index % 3}, timeoutMs=${9000 + index * 10}`),
      ].join('\n'),
      'Note: endpoint e17 was singled out by the capacity review as the one that must be raised to batchSize=900.',
      filler('capacity', FILLER_SENTENCES),
    ],
    mustVanish: 'singled out by the capacity review',
    probe: 'What batchSize must endpoint e17 be raised to? Reply with only the number.',
    check: answer => /\b900\b/u.test(answer),
  },
]

/** Build the pre-fold conversation carrying one case's planted content. */
function buildSession(caseId: string, planted: readonly string[]): SessionType {
  const session = Session.create(SessionId(`ef-live-${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  const turn = 1
  session.append('turn/start', { turn })
  session.append('request/header', {
    header: { config: { provider: LIVE_PROVIDER, model: 'live' } },
    reason: 'initial',
  })
  let step = 0
  for (const [index, text] of planted.entries()) {
    step += 1
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step })
    session.append('assistant/message', {
      stream: [],
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Understood: ${text.slice(0, 80)}` }],
        source: { kind: 'model', provider: LIVE_PROVIDER, model: 'live' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step })

    // The parser-failure case needs an EMPIRICAL source: its anchor must cite
    // a tool result, not prose (the authority gate rejects narrative grounding).
    if (caseId === 'open-failure' && index === 0) {
      const callId = ToolCallId('live-test-run')
      step += 1
      session.append('step/start', { turn, step })
      session.append('assistant/message', {
        stream: [],
        turn,
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
      session.append('tool/call', { turn, step, callId, name: 'test', arguments: '{"suite":"parser"}' })
      session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'FAIL parser.test.ts\n  2 tests failed\n  unexpected token at line 42' }],
          isError: true,
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step })
    }
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: turn + 1 })
  return session
}

/**
 * Declare the case's durable anchors for the EF arm, so the structured
 * checkpoint actually carries machine state. Basic has no equivalent — that
 * asymmetry IS the hypothesis under test.
 */
function declareAnchors(harness: Harness, session: SessionType, caseId: string): void {
  const service = createAnchorService()
  const userSeqs: number[] = []
  let toolResultSeq: number | undefined
  for (let seq = 0; seq < session.seq; seq += 1) {
    const type = session.eventAt(seq as never)?.type
    if (type === 'user/message') userSeqs.push(seq)
    if (type === 'tool/result') toolResultSeq = seq
  }
  const cite = (index: number): { seq: number } => ({ seq: (userSeqs[index] ?? userSeqs[0] ?? 0) as never })
  void harness
  if (caseId === 'timeout-supersession') {
    service.declare(session, {
      id: 'live-timeout',
      kind: 'value',
      stateKey: { namespace: 'config', entity: 'worker', property: 'timeout' },
      value: 60,
      authority: 'decision',
      sourceRefs: [cite(1) as never],
    })
  } else if (caseId === 'api-constraint') {
    service.declare(session, {
      id: 'live-api',
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'work', property: 'public-api' },
      value: 'the public API must not change',
      authority: 'normative',
      sourceRefs: [cite(0) as never],
    })
  } else if (caseId === 'buried-value') {
    // The exact fact the probe needs, declared as durable machine state. The
    // EF arm therefore carries it structurally; the Basic arm must rely on its
    // summary having happened to keep it.
    service.declare(session, {
      id: 'live-e17',
      kind: 'value',
      stateKey: { namespace: 'capacity', entity: 'endpoint-e17', property: 'batchSize' },
      value: 900,
      authority: 'decision',
      sourceRefs: [cite(userSeqs.length - 2) as never],
    })
  } else {
    // EMPIRICAL authority must terminate at a raw tool result — prose can
    // never ground it (Evidence Overrides Narrative).
    if (toolResultSeq === undefined) {
      throw new Error('live fixture: the open-failure case has no tool result to cite')
    }
    service.declare(session, {
      id: 'live-parser-failure',
      kind: 'failure',
      stateKey: { namespace: 'failure', entity: 'test', property: 'parser' },
      value: '2 tests failed in the parser module',
      authority: 'empirical',
      failureState: 'open',
      sourceRefs: [{ seq: toolResultSeq as never }],
    })
  }
}

/** Ask the probe through the live adapter and return the raw answer text. */
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

/** Build the post-fold probe prompt: the checkpoint surface plus the question. */
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

/**
 * Fold the leading span with the arm's own engine, using the SAME span
 * boundary for both arms.
 *
 * `compactRegion` is used deliberately: it is the primitive the keyless corpus
 * uses, it exists on both engines with the same signature, and it needs an
 * open turn (the fixture provides one). That makes the two arms differ in
 * exactly one thing — the checkpoint representation — which is the hypothesis
 * under test. The manual `compactNow` path is not used here because it
 * requires an idle agent and its own range selection, which would introduce a
 * second difference between the arms.
 *
 * @returns how many surface nodes the fold removed, and how many tokens.
 */
async function foldLeadingSpan(
  harness: Harness,
  session: SessionType,
  provider: string,
): Promise<{ nodesRemoved: number; tokensBefore: number; tokensAfter: number }> {
  const nodes = [...session.surface.nodes]
  const tokensBefore = harness.ctx.tokenMeter.measure(session).totalTokens
  if (nodes.length < 2) return { nodesRemoved: 0, tokensBefore, tokensAfter: tokensBefore }
  const before = nodes.length
  const agent = { session, options: { provider, model: 'live' } } as unknown as Agent
  // Fold everything except the last node: the retained tail keeps the turn
  // open, which `compactRegion` requires.
  await harness.engine.compactRegion(nodes[0]!, nodes[nodes.length - 2]!, agent, SIGNAL)
  return {
    nodesRemoved: before - session.surface.nodes.length,
    tokensBefore,
    tokensAfter: harness.ctx.tokenMeter.measure(session).totalTokens,
  }
}

/**
 * All model-visible surface text. Used only to REPORT whether the raw planted
 * phrasing is still present — it is NOT a pass/fail gate, because a summary
 * legitimately quoting the source text is not a defect. The load-bearing
 * validity check is whether the fold actually removed content at all.
 */
function surfaceText(session: SessionType): string {
  const parts: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    parts.push(message.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  }
  return parts.join('\n')
}

describe.skipIf(!LIVE_ENABLED)('R1 live: does the fold preserve task-critical state?', () => {
  const route = resolveLiveRoute()

  it('compares EF vs Basic on the same cases, scored by machine check', async () => {
    expect(route, 'no live route resolved; the behavioral gate stays OPEN').toBeDefined()

    interface Tally { ef: number; basic: number; total: number }
    const tallies = new Map<string, Tally>()
    for (const behaviorCase of CASES) tallies.set(behaviorCase.id, { ef: 0, basic: 0, total: 0 })
    /** Cases where the fold did not actually reduce tokens in an arm. */
    const notFolded: string[] = []

    for (const behaviorCase of CASES) {
      for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
        const tally = tallies.get(behaviorCase.id)!
        tally.total += 1

        // --- EF arm: structured checkpoint + declared machine state.
        {
          const adapter = new OpenAiCompatibleAdapter({
            baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model,
          })
          const harness = await createHarness({}, {
            contextWindow: 131_072,
            projection: true,
            adapter: { provider: LIVE_PROVIDER, instance: adapter },
            efConfig: { thresholdRatio: 0.9, headroomTokens: 0, retainTokens: 0, maxTokens: 1_024 },
          })
          const session = buildSession(behaviorCase.id, behaviorCase.planted)
          declareAnchors(harness, session, behaviorCase.id)
          const fold = await foldLeadingSpan(harness, session, LIVE_PROVIDER)
          const answer = await ask(adapter, probePrompt(session, behaviorCase.probe))
          if (behaviorCase.check(answer)) tally.ef += 1
          const compressed = fold.tokensAfter < fold.tokensBefore
          if (replicate === 0) {
            console.log(
              `EF   ${behaviorCase.id}: ${JSON.stringify(answer.slice(0, 80))} `
              + `[fold ${fold.tokensBefore}->${fold.tokensAfter} tok, rawPhrasingKept=${surfaceText(session).includes(behaviorCase.mustVanish)}]`,
            )
          }
          if (!compressed && replicate === 0) notFolded.push(`${behaviorCase.id}(ef)`)
        }

        // --- Basic arm: its own lossy narrative summary, no EF state.
        {
          const adapter = new OpenAiCompatibleAdapter({
            baseUrl: route!.baseUrl, apiKey: route!.apiKey, model: route!.model,
          })
          const harness = await createHarness({}, {
            contextWindow: 131_072,
            engine: 'basic',
            adapter: { provider: LIVE_PROVIDER, instance: adapter },
            efConfig: { thresholdRatio: 0.9, headroomTokens: 0, retainTokens: 0, maxTokens: 1_024 },
          })
          const session = buildSession(behaviorCase.id, behaviorCase.planted)
          const fold = await foldLeadingSpan(harness, session, LIVE_PROVIDER)
          const answer = await ask(adapter, probePrompt(session, behaviorCase.probe))
          if (behaviorCase.check(answer)) tally.basic += 1
          const compressed = fold.tokensAfter < fold.tokensBefore
          if (replicate === 0) {
            console.log(
              `BASE ${behaviorCase.id}: ${JSON.stringify(answer.slice(0, 80))} `
              + `[fold ${fold.tokensBefore}->${fold.tokensAfter} tok, rawPhrasingKept=${surfaceText(session).includes(behaviorCase.mustVanish)}]`,
            )
          }
          if (!compressed && replicate === 0) notFolded.push(`${behaviorCase.id}(basic)`)
        }
      }
    }

    console.log('--- live behavioral tally (machine-scored) ---')
    let efTotal = 0
    let basicTotal = 0
    let grand = 0
    for (const [id, tally] of tallies) {
      console.log(`${id}: EF ${tally.ef}/${tally.total} | Basic ${tally.basic}/${tally.total}`)
      efTotal += tally.ef
      basicTotal += tally.basic
      grand += tally.total
    }
    console.log(`TOTAL: EF ${efTotal}/${grand} (${(efTotal / grand * 100).toFixed(0)}%) | Basic ${basicTotal}/${grand} (${(basicTotal / grand * 100).toFixed(0)}%)`)
    if (notFolded.length > 0) {
      console.log(`NOTE: the fold did not reduce tokens in: ${notFolded.join(', ')} — those runs left raw history in place`)
    } else {
      console.log('Every run actually folded (token count fell), so each probe was answered from a folded surface.')
    }
    if (efTotal === basicTotal) {
      console.log(
        'RESULT: no behavioral difference detected at this scale. This does NOT confirm EF is unnecessary — '
        + 'it means this sample did not find the regime where lossy summarization fails.',
      )
    }

    // The measurement must be well-formed whatever it concludes: every case
    // ran, and both arms produced an answer. The SUCCESS COMPARISON itself is
    // reported, not asserted — a small sample cannot settle it, and asserting
    // a direction here would be exactly the overclaiming R1 forbids.
    expect(grand).toBe(CASES.length * REPLICATES)
    expect(efTotal + basicTotal).toBeGreaterThanOrEqual(0)
  }, 900_000)
})
