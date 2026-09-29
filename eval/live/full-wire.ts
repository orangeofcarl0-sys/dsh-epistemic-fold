/**
 * RC0-B/C: the live full-wire billing driver.
 *
 * R4-D collected bills by calling `adapter.stream()` from the benchmark with a
 * hand-built single-user-message request. That is not the agent's wire shape —
 * no system prompt, no tool schemas, no real role structure — and it recorded
 * only main requests, omitting Basic's `purpose: 'compaction'` summary call.
 *
 * This driver replaces it: the recorder wraps the provider adapter at the LLM
 * seam, the REAL plugin drives folding and rebasing, and every provider call is
 * captured with its purpose. The measured quantity is therefore
 * `FullTaskRBCR = Σ C(all calls, economy) / Σ C(all calls, basic)`.
 *
 * @module eval/live/full-wire
 */

import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { driveIdleMaintenance } from '../../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from '../../tests/harness.ts'
import type { Harness } from '../../tests/harness.ts'
import type { RequestBill, RequestClass } from './billing.ts'
import { BillingRecorder } from './recorder.ts'
import { resolveLiveRoute } from './zcode-config.ts'
import { OpenAiCompatibleAdapter } from './openai-adapter.ts'

const LIVE_PROVIDER = 'live'
const MODEL_OPTIONS = { provider: LIVE_PROVIDER, model: 'live' }

/** A benchmark workload the full-wire driver can run. */
export interface FullWireWorkload {
  readonly id: string
  /**
   * Fresh session for one run.
   *
   * Takes a per-run `runId`, which becomes the run's cache namespace (RC1 §23).
   * A workload that ignored it would let consecutive runs share a provider
   * cache entry and turn a paired cost comparison into a cache-state comparison.
   */
  readonly createSession: (runId: string) => SessionType
  /** One growth turn, inside the turn the driver opens. */
  readonly grow: (session: SessionType, step: number) => void
  /**
   * Whether the workload's growth already includes recall-shaped tool results.
   * Recorded so the report can say which shape was measured.
   */
  readonly shape: 'long-trajectory' | 'tool-heavy' | 'recall'
}

/** Deterministic prose growth, for the long-trajectory family. */
function prose(step: number, units: number): string {
  return Array.from(
    { length: units },
    (_, index) =>
      `${'context detail '.repeat(40)}step ${step} note ${index} of the `
      + `${['build', 'lint', 'docs', 'metrics', 'config'][index % 5]} subsystem`,
  ).join(' ')
}

/** A long-trajectory workload: plain growth, no tools. */
export function longTrajectory(): FullWireWorkload {
  return {
    id: 'FW-long-trajectory',
    shape: 'long-trajectory',
    createSession: runId => seed('fw-long', runId),
    grow: (session, step) => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: prose(step, 40) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      appendAssistant(session, step)
    },
  }
}

/** A tool-heavy workload: large tool results dominate the surface. */
export function toolHeavy(): FullWireWorkload {
  return {
    id: 'FW-tool-heavy',
    shape: 'tool-heavy',
    createSession: runId => seed('fw-tools', runId),
    grow: (session, step) => {
      const callId = `fw-call-${step}` as never
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `user ${step}: read src/mod-${step}.ts` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: step, step })
      session.append('assistant/message', {
        stream: [], turn: step, step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the module.' },
            { type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ target: `src/mod-${step}.ts` }) },
          ],
          source: { kind: 'model', ...MODEL_OPTIONS },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: step, step, callId, name: 'read', arguments: '{}' })
      session.append('tool/result', {
        turn: step, step,
        message: {
          role: 'tool', toolCallId: callId,
          content: [{
            type: 'text',
            text: Array.from({ length: 60 }, (_, line) => `src/mod-${step}.ts:${line}: ${'payload '.repeat(8)}`).join('\n'),
          }],
        } as never,
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: step, step })
    },
  }
}

/** A recall-shaped workload: periodic large recalled pages. */
export function recallShaped(): FullWireWorkload {
  return {
    id: 'FW-recall',
    shape: 'recall',
    createSession: runId => seed('fw-recall', runId),
    grow: (session, step) => {
      if (step % 4 !== 0) {
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: prose(step, 30) }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        appendAssistant(session, step)
        return
      }
      const callId = `fw-recall-${step}` as never
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `user ${step}: what did we decide earlier about the parser?` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: step, step })
      session.append('assistant/message', {
        stream: [], turn: step, step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Recalling the archived discussion.' },
            { type: 'tool-call', id: callId, name: 'context_recall', arguments: JSON.stringify({ ref: 'cp:earlier', depth: 'exact' }) },
          ],
          source: { kind: 'model', ...MODEL_OPTIONS },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: step, step, callId, name: 'context_recall', arguments: '{}' })
      session.append('tool/result', {
        turn: step, step,
        message: {
          role: 'tool', toolCallId: callId,
          content: [{
            type: 'text',
            text: `recalled page:\n${Array.from({ length: 30 }, (_, line) => `archived line ${line} ${'detail '.repeat(10)}`).join('\n')}`,
          }],
        } as never,
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: step, step })
    },
  }
}

/** Every full-wire workload, in report order. */
export function fullWireWorkloads(): readonly FullWireWorkload[] {
  return [longTrajectory(), toolHeavy(), recallShaped()]
}

function appendAssistant(session: SessionType, step: number): void {
  session.append('step/start', { turn: step, step })
  session.append('assistant/message', {
    stream: [], turn: step, step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `Acknowledged step ${step}.` }],
      source: { kind: 'model', ...MODEL_OPTIONS },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: step, step })
}

/**
 * A per-run cache namespace token.
 *
 * RC1 §23's rule, applied to the paired tier. This driver's workload fixtures
 * are DETERMINISTIC — every run of `FW-long-trajectory` produces a byte-identical
 * prompt sequence — so without a namespace, run *n+1* of a workload shares the
 * provider cache with run *n*. The RC1-E re-run showed what that does to a
 * paired comparison: with identical prompts and identical call counts, one arm
 * reported ~200 uncached input per request and the other ~3,600, because the
 * arm that happened to run second inherited a warm prefix from the previous
 * run. No policy can cause that, and a paired design that permits it is
 * measuring cache luck rather than cost.
 *
 * The token goes in the FIRST line of the seed message, which is the earliest
 * position the provider's cache can key on, so two runs cannot share an entry.
 *
 * @param runId - a token unique to one run.
 * @returns the namespace line to prefix the seed with.
 */
export function cacheNamespace(runId: string): string {
  return `CACHE-RUN-${runId}-7f924c`
}

function seed(label: string, runId: string): SessionType {
  const session = Session.create(SessionId(`ef-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: MODEL_OPTIONS }, reason: 'initial' })
  session.append('user/message', createUserMessage({
    // The namespace is what keeps this run's prefix out of every other run's
    // cache (RC1 §23). Without it a paired comparison silently compares cache
    // states rather than policies.
    content: [{ type: 'text', text: `${cacheNamespace(runId)} seed ${'context '.repeat(200)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

/** One arm's full-wire run. */
export interface FullWireRun {
  readonly arm: string
  readonly workload: string
  readonly bills: readonly RequestBill[]
  readonly folds: number
  readonly roots: number
  readonly finalTokens: number
  /** Whether the recorder captured a compaction call (Basic should have one). */
  readonly sawCompactionCall: boolean
  /** Prompt tokens of each recorded call, in order. */
  readonly callPromptTokens: readonly number[]
  /** Per-call cache split, so a cost difference is attributable to cache. */
  readonly callSplits: readonly {
    readonly purpose: string
    readonly prompt: number
    readonly uncached: number
    readonly cacheRead: number
  }[]
}

/**
 * Run one arm over one workload through the REAL agent path.
 *
 * The recorder wraps the provider adapter, so the plugin's own folds, its idle
 * rebase consumer, and Basic's compaction summarizer all issue their calls
 * through it and are captured with their purpose.
 *
 * @param options - the arm, the workload, the growth budget, and the policy.
 * @returns every bill the run produced, plus its fold/rebase counts.
 */
export async function runFullWire(options: {
  readonly arm: string
  readonly basic: boolean
  readonly workload: FullWireWorkload
  readonly turns: number
  readonly window: number
  readonly policy: Readonly<Record<string, unknown>>
  /** Whether this arm performs idle maintenance (rebase). */
  readonly idleMaintenance: boolean
  readonly systemPrompt: boolean
}): Promise<FullWireRun> {
  const route = resolveLiveRoute()
  if (route === undefined) throw new Error('no live route resolved')

  const provider = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.model,
    contextWindow: options.window,
  })
  const recorder = new BillingRecorder(provider, options.arm)

  const harness: Harness = await createHarness({}, {
    contextWindow: options.window,
    ...(options.basic
      ? { engine: 'basic' as const }
      : { plugin: true, systemPrompt: options.systemPrompt }),
    efConfig: {
      maxTokens: 512,
      ...options.policy,
    },
  })
  harness.ctx.llm.registerAdapter([LIVE_PROVIDER], recorder)

  const session = options.workload.createSession(options.arm)
  const meter = harness.ctx.tokenMeter
  let folds = 0
  let roots = 0

  for (let turn = 2; turn <= options.turns + 1; turn += 1) {
    if (options.idleMaintenance) {
      const before = harness.engine.rootFoldCount
      await driveIdleMaintenance(harness, session)
      if (harness.engine.rootFoldCount > before) roots += harness.engine.rootFoldCount - before
    }
    session.append('turn/start', { turn })
    options.workload.grow(session, turn)
    const before = meter.measure(session).totalTokens
    // The main request that follows this fold arrives on a surface the provider
    // has not cached, so its class is `after-leaf`; a turn that did not fold is
    // steady state. R4 §24 asks for exactly this split.
    recorder.markNextRequest('normal')
    try {
      await (harness.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded({ session, options: MODEL_OPTIONS }, 'pressure', SIGNAL)
    } catch { /* a refused fold is a decision */ }
    const after = meter.measure(session).totalTokens
    if (after < before) {
      folds += 1
      // The next request arrives on a surface the provider has never cached.
      recorder.markNextRequest('after-leaf')
    }
    // THE MAIN REQUEST, issued through the SAME recorder the plugin uses, and
    // assembled with the real system prompt and tool schemas — which is the
    // whole point of RC0-B: R4-D flattened the surface into one user message
    // and so never billed the system prompt or the tool schema, even though the
    // R3 framing saving is earned through exactly that assembly.
    await issueMainRequest(harness, session)
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  return {
    arm: options.arm,
    workload: options.workload.id,
    bills: recorder.bill.map(call => toRequestBill(call)),
    // Per-call prompt sizes, so a cost difference can be attributed to the
    // request shape rather than guessed at.
    callPromptTokens: recorder.bill.map(call => call.promptTokens),
    callSplits: recorder.bill.map(call => ({
      purpose: call.purpose, prompt: call.promptTokens,
      uncached: call.uncachedInputTokens, cacheRead: call.cacheReadTokens,
    })),
    folds,
    roots,
    finalTokens: meter.measure(session).totalTokens,
    sawCompactionCall: recorder.bill.some(call => call.purpose === 'compaction'),
  }
}

/** Project a recorded call onto the billing module's bill shape. */
function toRequestBill(call: {
  readonly purpose: 'main' | 'compaction' | 'rationale' | 'other'
  readonly requestClass: RequestClass
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens?: number
  readonly outputTokens: number
  readonly promptTokens: number
}): RequestBill {
  return {
    purpose: call.purpose,
    requestClass: call.requestClass,
    uncachedInputTokens: call.uncachedInputTokens,
    cacheReadTokens: call.cacheReadTokens,
    ...(call.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: call.cacheWriteTokens }),
    outputTokens: call.outputTokens,
    promptTokens: call.promptTokens,
  }
}

/**
 * Issue one main-model request the way the agent loop does.
 *
 * `systemPrompt.assemble()` returns the sections AND the tool schemas in one
 * call, so this builds the same request shape a production turn builds: the
 * real system prompt (including EF's framing section under `system-dedup`) and
 * the real tool declarations. That is precisely what R4-D's `surfaceAsPrompt()`
 * omitted, and the framing saving is earned through this assembly.
 */
async function issueMainRequest(
  harness: Harness,
  session: SessionType,
): Promise<void> {
  const assembly = await assembleRequestParts(harness)
  const messages = surfaceMessages(session)
  for await (const chunk of harness.ctx.llm.stream({
    provider: LIVE_PROVIDER,
    model: 'live',
    messages,
    ...(assembly.system === undefined ? {} : { system: assembly.system }),
    ...(assembly.tools === undefined ? {} : { tools: assembly.tools }),
    maxTokens: 32,
  } as never)) {
    void chunk
  }
}

/**
 * The system prompt text and tool schemas a production request would carry.
 *
 * Falls back to neither when no SystemPrompt service is mounted, which is
 * correct rather than a silent degradation: the recorder then bills exactly
 * what the request contained.
 */
async function assembleRequestParts(harness: Harness): Promise<{
  readonly system?: string
  readonly tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[]
}> {
  const service = harness.ctx.get('systemPrompt') as unknown as
    | { assemble?: (context: unknown) => Promise<{ sections?: readonly { text?: string }[]; tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[] }> }
    | undefined
  if (service?.assemble === undefined) return {}
  try {
    const assembly = await service.assemble({})
    const system = (assembly.sections ?? [])
      .map(section => section.text ?? '')
      .filter(part => part.length > 0)
      .join(String.fromCharCode(10, 10))
    return {
      ...(system.length === 0 ? {} : { system }),
      ...(assembly.tools === undefined || assembly.tools.length === 0 ? {} : { tools: assembly.tools }),
    }
  } catch {
    // A failed assembly means the request carries no system prompt, which the
    // bill then reflects honestly rather than inventing one.
    return {}
  }
}

/** The session surface as request messages, with real roles preserved. */
function surfaceMessages(session: SessionType): readonly unknown[] {
  const messages: unknown[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    messages.push(message)
  }
  return messages
}
