/**
 * RC9: the EF side of the tau2 bridge.
 *
 * ## Why a bridge at all
 *
 * tau2-Bench-Verified is Python; the Epistemic Fold is a TypeScript context
 * runtime for DSH. The two cannot be linked in-process. What makes the link
 * possible is that tau2's agent protocol is a clean seam:
 *
 *     agent.generate_next_message(message, state) -> AssistantMessage
 *
 * One call produces ONE assistant message, which is either text to the user or
 * a set of tool calls. The orchestrator executes the tools and calls back. So a
 * single round trip is all the bridge needs per turn.
 *
 * ## The rule that shapes the design
 *
 * **The model call must happen on the NODE side.** It would be far simpler to
 * let tau2 call the provider and only mirror the transcript across for
 * telemetry — but then the fold would happen AFTER the model had already seen
 * the unfolded context, and the thing under test would not be under test at all.
 * The whole point is that the model sees what the context runtime chose to show
 * it, so the request is built and issued here, from `surfaceMessages(session)`.
 *
 * ## Process shape
 *
 * One host process per episode, kept alive across turns so the session, the fold
 * state and the bundle store persist. Communication is newline-delimited JSON
 * over stdin/stdout, because it needs no port, no dependency, and leaves nothing
 * to clean up if the parent dies.
 *
 * Requests (parent -> host):
 *   {"op":"init",  "arm":{...}, "policy":"...", "tools":[...], "taskId":"..."}
 *   {"op":"turn",  "message":{...}}       // a user or tool message from tau2
 *   {"op":"close"}                        // episode over; report telemetry
 *
 * Responses (host -> parent), one line each:
 *   {"ok":true,  "assistant":{...}, "telemetry":{...}}
 *   {"ok":false, "error":"..."}
 *
 * @module eval/tau2/bridge-host
 */

import { Context } from '@deepseek-ai/cordis'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  LlmRuntime,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
// Production mounts this in `dsh-base`; see the mount site in `init` for why the
// harness must too. Imported from SOURCE like every other vendored module here.
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
// Imported from SOURCE, like every other module under `eval/` — not from
// `lib/*.js`. The build deliberately ships no `.d.ts` ("emitting declarations
// would create a SECOND artifact"), so a `lib/` import resolves to `any` and
// silently escapes typechecking: this file's `'auto'` trigger and a dead local
// both survived that way. `--experimental-transform-types` runs the `.ts`
// sources directly, so source imports are also what the process actually loads.
import { EpistemicFoldEngine } from '../../src/engine.ts'
import { EpistemicFoldPlugin } from '../../src/plugin.ts'
import { resolvePreset } from '../../src/preset.ts'
import type { FoldModeName } from '../../src/preset.ts'
import { OpenAiCompatibleAdapter } from '../live/openai-adapter.ts'
import { BillingRecorder } from '../live/recorder.ts'
import { realizedCost } from '../live/billing.ts'
import { resolveLiveRoute } from '../live/zcode-config.ts'
import { parseEconomicsProfile } from '../../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The provider id the harness registers the live adapter under. */
const LIVE_PROVIDER = 'live'

/**
 * Completion budget per model call.
 *
 * 900 is right for the tau2 lane, where a turn is one short customer-service
 * message, and that lane's recorded sweep was measured with it. It is too small
 * for LHTB: the agent writes multi-line shell scripts and heredocs, and a reply
 * cut off mid-tool-call arrives as `max-tokens` carrying nothing usable.
 *
 * So the budget is per-run rather than global. `EF_BRIDGE_MAX_TOKENS` is the
 * setting; the tau2 name is still honoured so an existing invocation does not
 * change behaviour.
 */
const STEP_MAX_TOKENS = Number(
  process.env.EF_BRIDGE_MAX_TOKENS ?? process.env.EF_TAU2_MAX_TOKENS ?? 900,
)

/** Context window the engine prices its fold threshold against. */
const TAU2_WINDOW = Number(process.env.EF_TAU2_WINDOW ?? 32_000)

/**
 * Wall-clock bound on ONE fold, including its summarization call.
 *
 * There was no bound at all before this: the fold's signal was an
 * `AbortController` that was created and never aborted, and the adapter forwards
 * the signal to `fetch` without setting a timeout of its own. A single
 * summarization therefore had no upper limit, which is how the Phase 7 run
 * stalled — 16 minutes with no progress, no error, and both Harbor and the
 * container still alive.
 *
 * 600s is chosen from measurement, not taste. At the 16384 budget the provider
 * returned a full 16384-token completion in 204s, so a legitimate large summary
 * has to fit; at 32768 the transport failed after 305s. 600s is roughly 3x the
 * observed legitimate worst case and still an order of magnitude below the
 * episode budget, so a genuine summary completes and a hang is cut. Override
 * with `EF_TAU2_FOLD_TIMEOUT_MS`; a value of 0 disables the bound.
 */
const FOLD_TIMEOUT_MS = Number(process.env.EF_TAU2_FOLD_TIMEOUT_MS ?? 600_000)

/**
 * What the bridge sends when the model produced neither text nor tool calls.
 *
 * tau2 rejects an empty assistant message, so the episode would abort on a turn
 * the model simply had nothing to say. A visible placeholder keeps the
 * conversation alive and makes the event legible in the transcript, rather than
 * hiding it behind a silent retry.
 */
const EMPTY_TURN_PLACEHOLDER = '(no response)'

/**
 * One tool, as tau2 describes it.
 *
 * `parameters` is the JSON Schema from `Tool.openai_schema`, passed through
 * unchanged so the model sees the benchmark's own tool definitions.
 */
interface TauTool {
  readonly name: string
  readonly description?: string
  readonly parameters?: Record<string, unknown>
}

/** The arm under test. `basic` mounts the real Basic engine, not an EF mode. */
interface ArmSpec {
  readonly label: string
  readonly engine: 'basic' | 'ef'
  readonly mode: FoldModeName
}

/** A tau2 message, reduced to what the bridge needs. */
interface TauMessage {
  readonly role: string
  readonly content?: string | null
  readonly tool_calls?: readonly { readonly id?: string; readonly name: string; readonly arguments?: Record<string, unknown> }[]
  readonly id?: string
  readonly error?: boolean
}

/** Several tool results delivered together, after parallel tool calls. */
interface TauMultiTool {
  readonly role: string
  readonly tool_messages?: readonly TauMessage[]
}

/**
 * Whether an incoming message is a BATCH of tool results rather than one message.
 *
 * A type predicate rather than a bare `.role === 'tool'` test, because both
 * shapes declare `role: string` and a multi-tool carries no `content`. Without
 * the predicate the union does not narrow, so every later `message.content` /
 * `message.id` read is a compile error — which is exactly what an unchecked
 * `lib/*.js` import was hiding.
 *
 * @param message - one line's decoded message.
 * @returns true when the message is the batch shape.
 */
function isMultiTool(message: TauMessage | TauMultiTool): message is TauMultiTool {
  return Array.isArray((message as TauMultiTool).tool_messages)
}

/** Telemetry the EF side reports back; never part of the benchmark score. */
interface Telemetry {
  readonly folds: number
  readonly roots: number
  /**
   * Emergency rebases (provider-overflow recovery). Counted separately from
   * `roots` because the two are different events with the same surface effect:
   * a root is deferred maintenance at idle, an emergency rebase happens inside
   * a live turn because the provider already refused the request.
   */
  readonly emergencies: number
  readonly modelCalls: number
  readonly promptTokensLast: number
  readonly surfaceNodesLast: number
  /**
   * Bundles this engine has successfully written — a MONOTONIC engine counter,
   * not `bundleStore.list().length`.
   *
   * `list()` reports files still present, so a removed bundle, a cleaned
   * session directory and a never-folded session all read the same, and an
   * unreadable store root reads as `0` if the caller swallows the error. That
   * conflation is what made a 11-fold trial report `archived=0`.
   */
  readonly bundleWrites: number
  /**
   * Bundles currently present in the store, or `null` when the store could not
   * be read. `null` is deliberately distinct from `0`: "the store is
   * unreadable" is not "there are no bundles".
   */
  readonly bundlesPresent: number | null
  /** Outstanding pending-rebase intents (a non-zero value at episode end is a leak). */
  readonly pendingIntents: number
  /**
   * Maintenance calls that THREW, counted for the whole episode.
   *
   * NOT "folds that threw", which is what this was called and what made it
   * unreadable. The call it counts is `compactIfNeeded`, which each mode
   * implements differently: on an EF arm it is a fold, and on the `basic` arm it
   * is Basic's own summarization. So a basic cell legitimately reports
   * `folds: 0` alongside a non-zero count here — the two fields measure
   * different subsystems and only the LABEL suggested otherwise.
   *
   * A failed call no longer ends the episode (see `foldIfNeeded`), so without a
   * counter it would be invisible. Monotonic, like the engine's own counters.
   */
  readonly compactionFailures: number
  /**
   * Those failures split by KIND, so the mix survives the run.
   *
   * A count alone was not enough to read a result from: the first Phase 7 basic
   * arm showed 8 failures on one cell from a summarization budget error and 2 on
   * another from a provider HTTP 500, and because only the LAST message was kept,
   * the two were indistinguishable after the fact. Keys are
   * `truncated` | `provider-http` | `provider-transport` |
   * `unsupported-content` | `timeout` | `other`.
   */
  readonly compactionFailureKinds: Readonly<Record<string, number>>
  /**
   * The most recent failure's message, or `null` when none has occurred.
   *
   * Kept separate from the count so a report can say WHAT failed rather than
   * only how often. Redacted like every other error path, because a provider
   * failure can echo a request that carries the credential.
   */
  readonly lastCompactionError: string | null
  /**
   * Model calls that failed AT THE PROVIDER (429, 5xx, transport), and the last
   * message.
   *
   * Separate from `modelCalls` because such a call is not a model turn: it
   * produces no text, no tool calls, and no surface node. Reported so a report
   * can subtract provider load from mode quality — the two were previously
   * indistinguishable, because a failed call reached the agent as an ordinary
   * empty reply and was attributed to the model.
   */
  readonly providerFailures: number
  readonly lastProviderError: string | null
  /** The pressure regime the last automatic fold decision resolved. */
  readonly pressureRegime: string
  readonly costTotal: number
  /**
   * How the most recent model call finished.
   *
   * `error:...` means the call failed in transport, so an empty reply is NOT the
   * model declining to act. Without this, a dead proxy and a finished task look
   * identical to the caller.
   */
  readonly lastFinishReason: string
}

let ctx: Context | undefined
let engine: EpistemicFoldEngine | undefined
/** The mounted plugin, kept so its idle consumer can be driven and awaited. */
let plugin: EpistemicFoldPlugin | undefined
let session: Session | undefined
let recorder: BillingRecorder | undefined
let systemText: string | undefined
let tools: readonly TauTool[] = []
let turnCounter = 0
let stepCounter = 0
/** Whether the current turn already carries a message, so it can be closed. */
let turnHasContent = false
let folds = 0
let roots = 0
let emergencies = 0
/** Failed maintenance calls, split by kind, and the last message. See `Telemetry`. */
let compactionFailures = 0
let compactionFailureKinds: Record<string, number> = {}
let lastCompactionError: string | null = null
let modelCalls = 0
/**
 * Model calls that FAILED at the provider, and the last failure message.
 *
 * Counted separately from `modelCalls` because a provider failure is not a model
 * turn: it produces no text, no tool calls, and no surface node. Without this the
 * only trace of a 429 was the agent's own "empty response" anomaly, which reads
 * as the model declining to act — the misattribution that made provider load
 * indistinguishable from mode quality.
 */
let providerFailures = 0
let lastProviderError: string | null = null
/** How the last model call finished, so an empty reply can be attributed. */
let lastFinishReason = 'unknown'
let promptTokensLast = 0
let surfaceNodesLast = 0
let costTotal = 0
let profile: ContextEconomicsProfile | undefined

/** Load the economics profile once, for pricing the realized bill. */
function loadProfile(): ContextEconomicsProfile {
  const path = join(import.meta.dirname, '..', '..', 'profiles', 'economics', 'deepseek-flash-2026-09.json')
  return parseEconomicsProfile(JSON.parse(readFileSync(path, 'utf8')))
}

/** Write one protocol line to stdout. */
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** Report a failure without ever leaking a credential into the message. */
function emitError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  emit({ ok: false, error: message.replace(/sk-[A-Za-z0-9_-]{16,}/gu, '[redacted]') })
}

/**
 * Render a tau2 tool result as text the session can store.
 *
 * DSH's session rejects any event carrying a value that does not survive a
 * lossless JSON round trip — specifically `-0` and the non-finite numbers, both
 * of which tau2's tool output can contain (a price difference of `-0.0` is
 * ordinary in the retail and airline databases). The tool result is therefore
 * carried as its JSON TEXT, which is also the honest representation: that string
 * is exactly what the model is shown.
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content ?? '', (_, value) =>
      typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
        ? 0
        : value) ?? ''
  } catch {
    return String(content ?? '')
  }
}
/**
 * Map a tau2 message onto the DSH event the session expects.
 *
 * The token meter and the fold frontier both read the DSH event grammar, so the
 * mapping is not cosmetic: a tool result must arrive as `tool/result` and a user
 * turn as `user/message`, or the engine cannot see the history it is meant to
 * manage.
 */
function appendIncoming(message: TauMessage | TauMultiTool): void {
  const active = session!
  // tau2 bundles several tool results into one message when the model issued
  // parallel calls. Each result is a separate DSH event, so they are expanded
  // rather than collapsed — the fold frontier reasons per event.
  if (isMultiTool(message)) {
    for (const inner of message.tool_messages ?? []) appendIncoming(inner)
    return
  }
  if (message.role === 'user') {
    active.append('user/message', createUserMessage({
      content: [{ type: 'text', text: message.content ?? '' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    return
  }
  if (message.role === 'tool') {
    // tau2 delivers a tool result as its own message carrying the originating
    // call id. DSH wraps it in a turn/step envelope, so the current step is
    // reused rather than a new one opened: the result belongs to the call the
    // model already made.
    //
    // The content must be a TEXT block, not an array of parsed values: the
    // session serializes its events, and tau2's tool output is arbitrary JSON
    // that may contain values the serializer rejects. Keeping it as the raw
    // string is also the honest representation — that string is exactly what
    // the model would have been shown.
    active.append('tool/result', {
      turn: turnCounter,
      step: Math.max(1, stepCounter),
      message: createToolResultMessage({
        callId: ToolCallId(message.id ?? ''),
        content: [{ type: 'text', text: toolResultText(message.content) }],
        // Must be an explicit boolean. Omitting it leaves the property
        // `undefined`, and the session rejects any event carrying a value that
        // does not survive a lossless JSON round trip — `undefined` included.
        // The error surfaced as "non-JSON-serializable data" on the whole event,
        // which pointed at the payload rather than at this one absent field.
        isError: message.error === true,
      }),
    }, { surfaceOp: 'append' })
    return
  }
  throw new Error(`bridge: unsupported incoming role "${message.role}"`)
}

/** Close the current turn and open the next one, if it carries content. */
function rotateTurn(): void {
  if (turnHasContent) {
    closeTurn()
    openTurn()
  }
  turnHasContent = true
}

/** Open a turn, so automatic compaction has an enclosing turn (EF requires one). */
function openTurn(): void {
  turnCounter += 1
  session!.append('turn/start', { turn: turnCounter })
}

/** Close the current turn. */
function closeTurn(): void {
  session!.append('turn/end', { turn: turnCounter, reason: { kind: 'completed' } })
}

/** The message history the model should see, as the engine currently exposes it. */
function surface(): readonly Message[] {
  const active = session!
  const messages: Message[] = []
  for (const seq of active.surface.nodes) {
    const event = active.eventAt(seq)
    if (event === undefined) continue
    const derived = active.deriveEventMessage(event)
    if (derived !== null) messages.push(derived as Message)
  }
  return messages
}

/**
 * Ask the engine to fold if the surface has outgrown its budget.
 *
 * Called BEFORE every model call, which is the only placement that makes the
 * measurement meaningful: the fold must be able to change what this very request
 * contains.
 *
 * The fold counts come from the ENGINE's own lifetime counters, read as deltas
 * around the call. This host used to classify the returned `CompactionResult` by
 * substring-matching its JSON for `"kind":"root"`, which could never fire:
 * `CompactionResult` has no `kind` field (its shape is `compactionId`,
 * `startSeq`, `summarySeq`, `endSeq`, `summary`, `shadowedRange`,
 * `shadowedSeqs`, `shadowedTokenCount`), and the summary block it does carry is
 * tagged `type`, not `kind`. A real root fold therefore read as `roots=0` while
 * the engine's counter said otherwise, and any checkpoint body that happened to
 * contain the literal text `rootFold` would have counted as a root.
 */
/**
 * Classify a failed maintenance call, so the KIND survives the run.
 *
 * Structured detection first. Basic tags a truncated summary `MAX_TOKENS` and the
 * adapter tags its own failures on the `LlmError`, so neither has to be
 * recognised from prose. Message matching is only a fallback, because the message
 * is redacted and clipped before it is stored — and a class read off a message
 * that has already been rewritten is exactly the kind of number that cannot mean
 * what it claims.
 *
 * `aborted` wins: the deadline fired, and whatever the underlying error was, the
 * bound is what ended the call.
 */
function classifyCompactionFailure(error: unknown, aborted: boolean): string {
  if (aborted) return 'timeout'
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code === 'MAX_TOKENS') return 'truncated'
  if (code === 'LIVE_HTTP') return 'provider-http'
  if (code === 'LIVE_TRANSPORT') return 'provider-transport'
  if (code === 'UNSUPPORTED_CONTENT') return 'unsupported-content'
  const message = error instanceof Error ? error.message : String(error)
  if (/truncated at the token cap/u.test(message)) return 'truncated'
  if (/HTTP [0-9]{3}/u.test(message)) return 'provider-http'
  return 'other'
}

async function foldIfNeeded(): Promise<void> {
  const active = engine!
  // ## A fold that fails must not end the episode
  //
  // This call used to be unguarded, and that made the harness report a failed
  // FOLD as a failed TASK. Production does not behave that way: Basic registers
  // `agent/pre-step` and wraps its own `compactIfNeeded` in a try/catch that logs
  // `step compaction failed: …; continuing the turn` and calls `next()`. A
  // truncated summary in a real DSH session is a missed fold the agent works
  // through.
  //
  // In this harness the error instead propagated out of `modelTurn`, became
  // `{ok:false}`, raised `BridgeError` in the Python client, and left
  // `ef_lhtb_agent.run()` — killing the trial at reward 0. The Phase 7 basic arm
  // died exactly that way at turn 62, after 62 real model calls, and the report
  // read it as evidence about Basic's summarization quality. It was evidence
  // about this file.
  //
  // So the failure is CONTAINED and RECORDED rather than swallowed or rethrown.
  // `compactionFailures` is monotonic, `compactionFailureKinds` splits it, and
  // `lastCompactionError` carries the message, because an invisible degradation
  // would be worse than the crash it replaces: a report must be able to say
  // "this arm folded 15 times, failed twice, and both were provider 5xx" rather
  // than quote one number that means two different things.
  const deadline = new AbortController()
  const timer = FOLD_TIMEOUT_MS > 0 ? setTimeout(() => deadline.abort(), FOLD_TIMEOUT_MS) : undefined
  const agent = {
    session: session!,
    options: { provider: LIVE_PROVIDER, model: 'live' },
    // The signal is a REAL deadline, and there is no second controller.
    //
    // This used to be `new AbortController().signal` — created and never
    // aborted — so nothing bounded the summarization call. The adapter forwards
    // `options.signal` to `fetch` but sets no timeout of its own, which is how a
    // single fold stalled for 16 minutes with Harbor and the container both
    // alive and no error anywhere. A bound is what turns that stall into a
    // recorded fold failure the episode survives.
    //
    // The first fix left the dead controller in place inside `AbortSignal.any`,
    // which is harmless at runtime but wrong to read: it kept the exact
    // expression being fixed on the exact line being fixed, so grepping for the
    // defect hit the fix. Passed directly, so what the code says and what it
    // does are the same thing.
    runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      task(deadline.signal),
  } as never
  // The counters are LIFETIME totals on the engine, so they are read absolutely
  // rather than as deltas around the call. That is deliberate: a delta would be
  // lost if `compactIfNeeded` threw after a partial fold, whereas the engine's
  // own totals survive the throw and still report what actually committed.
  // `'pressure'`, which is the trigger production DSH actually passes at the
  // step boundary (`src/basic/index.ts` registers it on `agent/pre-step`).
  //
  // This used to be the literal `'auto'`, which is NOT a `CompactionTrigger` —
  // the union is `'pressure' | 'context-overflow'`. It went unnoticed because
  // this host is outside every tsconfig and the agent object is cast `as never`,
  // so no compiler ever checked the argument. The EF arm absorbed it (an
  // unrecognised trigger simply falls through to the pressure path), but Basic
  // has an `assertNever` on the same switch, so the moment the `basic` arm was
  // fixed to construct a real Basic engine it would have thrown
  // `unreachable variant in compaction trigger: "auto"` on its first fold.
  try {
    await active.compactIfNeeded(agent, 'pressure', deadline.signal)
  } catch (error: unknown) {
    compactionFailures += 1
    const kind = classifyCompactionFailure(error, deadline.signal.aborted)
    compactionFailureKinds[kind] = (compactionFailureKinds[kind] ?? 0) + 1
    const raw = error instanceof Error ? error.message : String(error)
    // The same redaction every other error path uses: a provider failure can
    // echo the request, and the request carries the credential.
    lastCompactionError = raw.replace(/sk-[A-Za-z0-9_-]{16,}/gu, '[redacted]').slice(0, 300)
    if (deadline.signal.aborted) {
      lastCompactionError = `exceeded ${FOLD_TIMEOUT_MS}ms: ${lastCompactionError}`
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const counters = foldCounters(active)
  folds = counters.leaves + counters.roots + counters.emergencies
  roots = counters.roots
  emergencies = counters.emergencies
  surfaceNodesLast = session!.surface.nodes.length
}

/**
 * Drive the production idle-maintenance edge, so a pending rebase is DRAINED.
 *
 * ## Why this exists
 *
 * The pressure path hands a frozen-bound surface off as a pending intent rather
 * than rebasing inline, because a rebase needs an idle agent and the pressure
 * turn runs inside an open turn. The plugin's consumer drains that intent on
 * `agent/status = idle`. A harness that never emits the transition therefore
 * never drains it: the surface stops folding and never converges, which is not a
 * configuration that can ship — it is the I3 violation, and it is what the old
 * `roots = 0` column was really reporting.
 *
 * ## The turn must be CLOSED first
 *
 * This is the part that is easy to get wrong and silent when you do. An idle
 * root is a MANUAL compaction (`owner: null`), and `compactSurfaceRegion`
 * refuses one while a turn is open — "manual compaction: the session already has
 * an open turn". This host keeps a turn open across model calls, so emitting
 * idle without closing it first makes every rebase attempt FAIL while the
 * telemetry still shows the intent being recorded and consumed.
 *
 * The failure is invisible in the counters: `pendingRebaseIntentCount` returns
 * to 0 (the intent IS consumed), `roots` stays 0, and the run looks like a
 * rebase that was never justified. Measured: 50 consecutive frozen-bound rounds,
 * every one reporting `outcome: "failed"` for exactly this reason.
 *
 * In the real loop the order is: turn ends → `agent/status = idle` → consumer.
 * The close/emit/reopen below reproduces that ordering, which is what makes the
 * benchmark path the production path rather than an approximation of it.
 */
async function drainIdleRebase(): Promise<void> {
  const mounted = plugin
  if (mounted === undefined || session === undefined) return
  // `mode: basic` returns early from the plugin, so there is no consumer and no
  // rebase concept to drain. Skipping keeps the Basic arm's event log identical
  // to a deployment where EF is not installed.
  if (mounted.engine.basicMode) return

  // Close the turn so the manual (idle) transaction is admissible. `openTurn`
  // below restores the enclosing turn the automatic fold path requires.
  const wasOpen = turnHasContent
  if (wasOpen) closeTurn()

  let busy = false
  const idleAgent = {
    session,
    options: { provider: LIVE_PROVIDER, model: 'live' },
    get status(): string {
      return busy ? 'running' : 'idle'
    },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (busy) throw new Error(`agent "${String(session!.id)}" already has active work`)
      busy = true
      // The idle rebase SUMMARIZES, so it needs the same bound the pressure fold
      // has. Without it this path was unbounded even after the fold was fixed:
      // `compactNow` builds `AbortSignal.any([agentSignal, signal])` from the
      // signal handed to it here, so bounding this one bounds the operation.
      //
      // Leaving it open would have made "each fold is bounded" false — the
      // rebase is a fold, and a stalled one is what the Phase 7 run hit.
      const deadline = new AbortController()
      const timer = FOLD_TIMEOUT_MS > 0 ? setTimeout(() => deadline.abort(), FOLD_TIMEOUT_MS) : undefined
      return (async () => {
        try {
          return await task(deadline.signal)
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          busy = false
        }
      })()
    },
  } as never

  ctx!.emit('agent/status', { agent: idleAgent, status: 'idle' })
  // Await the consumer's own settle handle rather than polling: the listener is
  // deliberately non-blocking, so this is the only race-free way to know the
  // drain finished before the next model call measures the surface.
  await mounted.idleRebase?.settled()

  if (wasOpen) openTurn()

  const counters = foldCounters(engine!)
  folds = counters.leaves + counters.roots + counters.emergencies
  roots = counters.roots
  emergencies = counters.emergencies
  surfaceNodesLast = session.surface.nodes.length
}

/** The engine's lifetime fold counters, as one snapshot. */
function foldCounters(target: EpistemicFoldEngine): { leaves: number; roots: number; emergencies: number } {
  return {
    leaves: target.leafFoldCount,
    roots: target.rootFoldCount,
    emergencies: target.emergencyRebaseCount,
  }
}

/**
 * Dispatch one EF tool call against the mounted ToolRuntime.
 *
 * The recall tools live on `ctx.tools`, registered by the plugin. Calling
 * through the runtime — rather than invoking `registerRecallTools`' internals —
 * means the benchmark exercises the same dispatch path a real agent loop uses:
 * the same argument validation, the same wrappers, the same rendering.
 *
 * A failure is returned as TEXT rather than thrown, because that is what the
 * model must see: a tool error is data for the next turn, not a reason to abort
 * a multi-hour episode. Throwing here would end the run on a malformed query.
 *
 * @param name - the tool name the model called.
 * @param args - the parsed arguments.
 * @param callId - the originating call id.
 * @returns the tool's rendered text.
 */
async function callEfTool(name: string, args: unknown, callId: string): Promise<string> {
  const runtime = toolsRuntime()
  if (runtime === undefined) {
    return JSON.stringify({ error: `no ToolRuntime mounted; cannot run ${name}` })
  }
  try {
    const result = await runtime.execute({
      callId: ToolCallId(callId === '' ? `ef-${Date.now()}` : callId),
      name,
      arguments: args ?? {},
      ...(session === undefined ? {} : { agent: { session } as never }),
      signal: new AbortController().signal,
    })
    const text = result.content
      .map(block => (block.type === 'text' ? block.text ?? '' : ''))
      .join('')
    if (result.isError) {
      // The tool reported a structured failure: surface it as content so the
      // model can correct its query rather than aborting the episode.
      return text === '' ? JSON.stringify({ error: 'tool failed', tool: name }) : text
    }
    return text
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      tool: name,
    })
  }
}

/** Render the tool schemas in the shape the live adapter sends upstream. */
/**
 * The tool schemas the provider receives: the benchmark's own, plus EF's recall.
 *
 * ## Why EF's tools are added here
 *
 * `registerRecallTools` puts `context_search` and `context_recall` on
 * `ctx.tools`, but nothing automatically forwards them to a provider — this host
 * owns the tool list it sends. Before this, the model saw only `run_shell`, so
 * LHTB measured checkpoint-surface continuation and never once exercised exact
 * recall of folded history. That is half of EF's claim: the tiers are supposed
 * to buy retrievability, and a run that cannot call the retrieval tool cannot
 * show it.
 *
 * ## The schema is the tool's own, not a hand-copy
 *
 * `ctx.tools.schemas()` is the runtime's published list, so the description and
 * JSON schema are exactly what a real DSH host would send. A hand-written copy
 * here would drift from the tool it describes, and the drift would be invisible
 * — the model would be told about parameters that no longer exist.
 */
function toolSchemas(): readonly { name: string; description: string; parameters: Record<string, unknown> }[] {
  const benchmarkTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }))
  const runtime = toolsRuntime()
  const efTools = (runtime?.schemas() ?? []).map(schema => ({
    name: schema.name,
    description: schema.description ?? '',
    parameters: schema.parameters ?? { type: 'object', properties: {} },
  }))
  return [...benchmarkTools, ...efTools]
}

/**
 * The mounted ToolRuntime, or `undefined` when none is present.
 *
 * `ctx.get('tools')` THROWS unless `tools` is in the context's `inject` list —
 * RC3 found that the hard way ("cannot get property \"tools\" without inject"),
 * and every test harness had pre-mounted a runtime so the broken probe was never
 * exercised. The sanctioned accessor is the callback form
 * `ctx.inject(['tools'], cb)`, which runs `cb` only once the service exists.
 *
 * The reference is cached because the injection callback is the only way to
 * reach it and it fires once per context: the tool list is needed on every model
 * call, and re-injecting per call would be both wasteful and racy.
 */
let toolsRuntimeRef: ToolRuntime | undefined

/**
 * Capture the ToolRuntime once it is available.
 *
 * `ctx.inject` returns a FIBER that must be awaited: the callback does not run
 * synchronously, so reading the captured reference immediately after the call
 * yields `undefined`. `init` awaits this before the first model call, which is
 * why the tool list is complete by the time `toolSchemas()` reads it.
 *
 * @returns a promise that settles once the runtime is captured (or immediately
 *   when no runtime is mounted, which is a supported configuration).
 */
async function captureToolsRuntime(): Promise<void> {
  if (ctx === undefined) return
  await ctx.inject(['tools'], toolsCtx => {
    toolsRuntimeRef = toolsCtx.tools
    return () => {
      toolsRuntimeRef = undefined
    }
  })
}

/**
 * The captured runtime, or `undefined` for a compaction-only deployment.
 *
 * @returns the runtime, or undefined.
 */
function toolsRuntime(): ToolRuntime | undefined {
  return toolsRuntimeRef
}

/** One assistant message, as tau2 expects to receive it. */
interface TauAssistant {
  readonly role: 'assistant'
  readonly content: string | null
  readonly tool_calls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]
  /**
   * Set when the provider call FAILED, so the caller can tell a failed call from
   * a model that produced nothing.
   *
   * This is the distinction the LHTB agent needs and did not have: without it,
   * `content: null` from an HTTP 429 and `content: null` from a genuinely silent
   * model are the same message, and the agent treated both as an empty reply to
   * be nudged — which counted a provider failure as the agent's own fault and
   * could end the episode after `MAX_EMPTY_STREAK`.
   */
  readonly error?: string
}

/**
 * Run one model call against the current surface and return tau2's message.
 *
 * Text and tool calls are kept mutually exclusive, which is tau2's protocol
 * rule: a message with both is rejected by the orchestrator.
 */
async function modelTurn(): Promise<TauAssistant> {
  await foldIfNeeded()
  // Immediately after the fold, and BEFORE the request is measured and sent.
  //
  // The placement is load-bearing: a rebase handed off by the pressure fold can
  // only affect this request if it runs before the surface is read. Draining it
  // later would leave the model looking at the pre-rebase surface while the
  // telemetry claimed a rebase had landed.
  await drainIdleRebase()

  const messages = surface()
  promptTokensLast = ctx!.tokenMeter.measure(session!).totalTokens
  modelCalls += 1

  let text = ''
  const calls: { id: string; name: string; args: string }[] = []
  let finishReason = 'unknown'
  for await (const chunk of ctx!.llm.stream({
    provider: LIVE_PROVIDER,
    model: 'live',
    messages,
    ...(systemText === undefined ? {} : { system: systemText }),
    tools: toolSchemas(),
    maxTokens: STEP_MAX_TOKENS,
  } as never)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      calls.push({ id: chunk.block.id, name: chunk.block.name, args: chunk.block.arguments })
    }
    if (chunk.type === 'finish') {
      finishReason = chunk.reason.kind === 'error'
        ? `error:${String((chunk.reason as { failure?: { message?: string } }).failure?.message ?? '').slice(0, 160)}`
        : chunk.reason.kind
    }
  }
  // An empty reply is ambiguous on its own: the model may have said nothing, or
  // the call may have failed in transport. The finish reason separates them, and
  // a caller that sees only "no tool calls" would misread a dead connection as a
  // finished task. That ambiguity cost a full LHTB probe run, so it is reported.
  lastFinishReason = finishReason
  // Cost is computed from the WHOLE bill at report time rather than accumulated
  // per turn: `realizedCost` prices the full log, so adding its result each turn
  // would count every earlier call again.

  // ## A FAILED call must not write a turn into the durable surface
  //
  // This used to append the assistant message unconditionally, before knowing
  // whether the call had succeeded. So an HTTP 429 wrote an EMPTY assistant turn
  // into the session — which is not a cosmetic artifact: that node is metered,
  // foldable, and read back to the model as its own prior output, and the agent
  // separately counted it toward its empty-reply streak. The provider's rate
  // limit therefore changed the conversation history and could end the episode,
  // which makes any arm comparison uninterpretable: a cell's reward would depend
  // on provider load rather than on the mode.
  //
  // `error:` is set by the adapter for `LIVE_HTTP` and `LIVE_TRANSPORT`, so the
  // finish reason is the signal. On failure the turn is closed EMPTY and nothing
  // is appended — the transcript keeps the failure in telemetry, and the model is
  // never shown a turn it did not produce.
  if (finishReason.startsWith('error:')) {
    providerFailures += 1
    lastProviderError = finishReason.slice('error:'.length)
    // Close the turn that `rotateTurn` opened, so the lifecycle stays balanced.
    // An empty turn is legal; an unclosed one is not.
    if (turnHasContent) {
      closeTurn()
      turnHasContent = false
    }
    return { role: 'assistant', content: null, error: lastProviderError }
  }

  // Record what the model said, so the next turn's surface includes it. The
  // engine folds THIS history, so it must be appended exactly as it happened.
  stepCounter += 1
  session!.append('step/start', { turn: turnCounter, step: stepCounter })
  session!.append('assistant/message', {
    stream: [],
    turn: turnCounter,
    step: stepCounter,
    message: createMessage({
      role: 'assistant',
      content: [
        ...(text.length === 0 ? [] : [{ type: 'text' as const, text }]),
        ...calls.map(call => ({
          type: 'tool-call' as const,
          id: ToolCallId(call.id),
          name: call.name,
          arguments: call.args,
        })),
      ],
      source: { kind: 'model', provider: LIVE_PROVIDER, model: 'live' },
    }),
  }, { surfaceOp: 'append' })
  session!.append('step/end', { turn: turnCounter, step: stepCounter })

  // tau2 forbids a message with both text and tool calls. When the model emits
  // both, the tool calls win: the work is the point, and dropping text is the
  // smaller distortion. This is recorded in telemetry rather than hidden.
  if (calls.length > 0) {
    for (const call of calls) {
      session!.append('tool/call', {
        turn: turnCounter, step: stepCounter,
        callId: ToolCallId(call.id), name: call.name, arguments: call.args,
      })
    }
    return {
      role: 'assistant',
      content: null,
      tool_calls: calls.map(call => ({ id: call.id, name: call.name, arguments: call.args })),
    }
  }
  // tau2 requires a message to carry EITHER text or tool calls, and treats a
  // whitespace-only string as empty (`has_text_content` strips before testing).
  // A model that emits nothing at all would therefore produce an invalid
  // message and abort the episode, so a placeholder is substituted and the
  // substitution is reported rather than silently absorbed.
  const finalText = text.trim().length === 0 ? EMPTY_TURN_PLACEHOLDER : text
  return { role: 'assistant', content: finalText }
}

/** Build the session, engine and adapter for one episode. */
async function init(request: {
  readonly arm: ArmSpec
  readonly policy: string
  readonly tools: readonly TauTool[]
  readonly taskId: string
  readonly domain: string
}): Promise<void> {
  const route = resolveLiveRoute()
  if (route === undefined) throw new Error('bridge: no live route resolved')
  profile = loadProfile()

  tools = request.tools
  systemText = request.policy
  turnCounter = 0
  stepCounter = 0
  turnHasContent = false
  folds = 0
  roots = 0
  emergencies = 0
  compactionFailures = 0
  compactionFailureKinds = {}
  lastCompactionError = null
  providerFailures = 0
  lastProviderError = null
  modelCalls = 0
  promptTokensLast = 0
  surfaceNodesLast = 0
  costTotal = 0

  const bundleRoot = process.env.EF_TAU2_BUNDLE_ROOT
  if (bundleRoot === undefined) throw new Error('bridge: EF_TAU2_BUNDLE_ROOT is not set')

  ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  void new SystemPrompt(ctx, {})
  // ## The tool-result pruner, which production mounts and this harness did not
  //
  // `dsh-base`'s own preset mounts `@deepseek-ai/dsh-compaction-tool-result-pruner`
  // with `{ thresholdChars: 8192, headChars: 4096, tailChars: 1024 }`, and the EF
  // engine READS it (`ctx.get('toolResultPruner')` in `compactIfNeeded`) to prune
  // before deciding on a fold. This harness mounted nothing, so the pruner was
  // `undefined` on every run and the prune step was skipped entirely.
  //
  // That omission is not cosmetic. A single tool result larger than the fold
  // threshold is UN-FOLDABLE by construction: the retention walk in
  // `selectCompactableRange` accumulates from the tail and breaks on the first
  // iteration at `retainTokens = 0`, so the last node is retained whatever the
  // setting — and `selectLeafSpan` has the identical walk. Measured on a
  // 66K-token surface whose last node was a 60K tool result:
  //
  //   without the pruner  before=66116 after=60136  leaves=1  THREW
  //                       ("still above threshold after 2 leaf fold attempts")
  //   with the pruner     before=66116 after=7406   leaves=0  converged
  //
  // So the `pressure-unresolved` failures the Phase 7 two-pass run reported were
  // measured on a configuration that cannot ship: LHTB's oversized node IS shell
  // output, which is exactly what the pruner targets, and the mechanism that
  // handles it was absent. The config is production's, deliberately — a different
  // threshold would be a different experiment.
  //
  // Note what this does NOT fix: the pruner only collects `event.type ===
  // 'tool/result'`. An oversized USER or ASSISTANT message is not prunable and
  // the retention walk still protects it, which is why the engine also gained a
  // pre-flight (see `compactIfNeeded`).
  new ToolResultPruner(ctx, { thresholdChars: 8_192, headChars: 4_096, tailChars: 1_024 })
  // The ToolRuntime is what makes the EF recall tools REGISTER.
  //
  // `registerRecallTools` runs only when `ctx.tools` exists — a compaction-only
  // deployment mounts cleanly without it — so a harness that omits the runtime
  // gets an EF whose `context_search` / `context_recall` are absent from the
  // model's tool list. LHTB would then measure checkpoint-surface continuation
  // alone, which is half of what EF claims: exact recall of folded history is
  // the mechanism the tiers are supposed to buy.
  //
  // Mounted BEFORE the plugin, because the plugin registers its tools against
  // this service during construction.
  void new ToolRuntime(ctx)
  // Capture the runtime through the sanctioned `inject` callback: `ctx.get`
  // throws for a service outside `inject`, and `tools` is optional here. Awaited
  // because the callback does not run synchronously.
  await captureToolsRuntime()

  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    contextWindow: TAU2_WINDOW,
    // Carried by the route. `/zen/go/v1` needs `x-opencode-session` on every
    // call; without it every request is a 400 that reads like a route fault.
    ...(route.headers === undefined ? {} : { headers: route.headers }),
  })
  recorder = new BillingRecorder(adapter, `${request.arm.label}-${request.domain}-${request.taskId}`)
  ctx.llm.registerAdapter([LIVE_PROVIDER], recorder)

  // The suffix must be unique across CONCURRENT cells: two episodes of the same
  // (arm, domain, task) starting in the same millisecond would otherwise share a
  // session id, and therefore a bundle namespace and a fold history.
  const unique = `${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`
  session = Session.create(SessionId(`tau2-${request.arm.label}-${request.domain}-${request.taskId}-${unique}`))

  // The arm IS the mode. `basic` mounts the real Basic engine — no EF surface,
  // no projection, no recall tools — so a report can say "versus DSH Basic" and
  // mean it. Everything else is held identical so a difference is attributable
  // to the mode rather than to the fixture.
  //
  // `retainTokens` is deliberately NOT set for ANY arm.
  //
  // Setting it to 0 for `basic` looked like a neutral "use the library default"
  // choice and was the opposite: DSH Basic's own default is `retainRatio 0.16`
  // (DEFAULT_RETAIN_RATIO), so pinning the token form to zero made every fold
  // retain nothing. The agent then re-read the same files again and again — the
  // first LHTB run read `spec.md` seven times across 101 shell calls — which is
  // a property of this configuration, not of the mode under test.
  //
  // The tier presets carry `retainRatio`, and Basic rejects a config supplying
  // both ("retainRatio and retainTokens are mutually exclusive"), so omitting
  // the field is the only setting that leaves each engine on its own default.
  //
  // ## `maxTokens` is the SUMMARIZATION budget, and 2000 was too small
  //
  // This field is not the agent's reply budget (that is `EF_BRIDGE_MAX_TOKENS`);
  // it is what the engine passes to its own checkpoint call — `summarize()` uses
  // `config.maxTokens`, and Basic's full-checkpoint format is far larger than
  // EF's marker-only body. At 2000 the summary hit the cap and Basic failed the
  // fold closed:
  //
  //   summarization truncated at the token cap (incomplete checkpoint)
  //
  // That error ended a real LHTB trial (BridgeError, reward 0) — the agent had
  // done nine substantive shell calls against the task and died on a budget, not
  // on the task. It surfaced only once the `basic` arm was fixed to construct a
  // real Basic engine: the EF arms use marker-only checkpoints that fit in 2000,
  // so the too-small budget was invisible for as long as every arm was EF.
  //
  // 8192 is a deliberate headroom multiple rather than a measured minimum: the
  // cost is paid once per fold on the summarization call, and a truncated
  // summary is a FAILED fold, which is far more expensive than the tokens.
  const common = {
    auto: true,
    thresholdRatio: Number(process.env.EF_TAU2_THRESHOLD ?? 0.5),
    headroomTokens: 0,
    maxTokens: Number(process.env.EF_TAU2_SUMMARY_MAX_TOKENS ?? 8_192),
    bundleRoot,
  }
  // ## Mounted through the PLUGIN, not constructed directly
  //
  // Phase 1 made this mandatory rather than tidier. A frozen-bound surface now
  // hands off to a rebase instead of folding a leaf, and the rebase is performed
  // by the PRODUCTION idle consumer — which the plugin registers on
  // `agent/status = idle`. A directly-constructed engine has no consumer, so its
  // pending intents are never drained: the surface stops folding and never
  // converges, and the run measures a configuration that cannot ship. (Measured
  // on the in-process R1 generator, which had the same defect: W3-tool-heavy's
  // EF token total went from 322K to 1.4M once the loop closed, purely because
  // nothing drained the handoff.)
  //
  // Mounting the plugin also gives the harness the production capability set
  // rather than an approximation of it: the same engine configuration, the same
  // consumer, the same lifecycle events, and — when a ToolRuntime is present —
  // the same recall tools. Under `mode: 'basic'` the plugin returns early after
  // providing `ctx.compaction`, so the Basic arm still mounts nothing of EF.
  //
  // `common` carries no `mode`, and the engine defaults to `legacy`; passing it
  // alone produced an EF-legacy engine wearing a `basic` label. It folded with
  // EF's frontier invariants, wrote EF bundles — the LHTB table's `archived`
  // column read 3 and 4 for the `basic` arm, which real Basic cannot be, since
  // it has no bundle store at all — and stamped EF checkpoints. Every "basic"
  // number in those reports described EF-legacy.
  plugin = new EpistemicFoldPlugin(ctx, {
    ...common,
    ...(request.arm.engine === 'basic'
      ? { mode: 'basic' as const }
      : request.arm.mode === 'legacy' ? {} : resolvePreset(request.arm.mode)),
  })
  engine = plugin.engine

  // tau2's opening move is the agent greeting the user, so the first turn opens
  // here and stays open until the episode closes.
  openTurn()
  session.append('request/header', {
    header: { config: { provider: LIVE_PROVIDER, model: 'live' } },
    reason: 'initial',
  })
}

/** Collect the telemetry block for one response. */
async function telemetry(): Promise<Telemetry> {
  // `null` means the store could not be read. It must not collapse to 0: "the
  // store is unreadable" and "there are no bundles" are different facts, and
  // conflating them is what made an 11-fold trial report `archived=0`.
  let bundlesPresent: number | null = null
  try {
    bundlesPresent = (await engine!.bundleStore.list(session!.id)).length
  } catch {
    bundlesPresent = null
  }
  // Priced from the full bill, so the figure is the episode's realized cost
  // rather than a per-turn increment that would double-count.
  costTotal = recorder === undefined || profile === undefined
    ? 0
    : realizedCost(recorder.bill, profile)
  return {
    folds,
    roots,
    emergencies,
    modelCalls,
    promptTokensLast,
    surfaceNodesLast,
    bundleWrites: engine!.bundleWriteCount,
    bundlesPresent,
    pendingIntents: engine!.pendingRebaseIntentCount,
    compactionFailures,
    compactionFailureKinds,
    lastCompactionError,
    providerFailures,
    lastProviderError,
    pressureRegime: engine!.lastPressureRegime ?? 'none',
    costTotal,
    lastFinishReason,
  }
}

/** Read newline-delimited JSON requests and answer each in order. */
async function main(): Promise<void> {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      let request: Record<string, unknown>
      try {
        request = JSON.parse(line) as Record<string, unknown>
      } catch {
        emitError(new Error('bridge: malformed request line'))
        continue
      }
      try {
        const op = String(request.op)
        if (op === 'init') {
          await init(request as never)
          emit({ ok: true, telemetry: await telemetry() })
        } else if (op === 'append') {
          // Append WITHOUT calling the model.
          //
          // This exists because a model may emit SEVERAL tool calls in one
          // message, and every result must be in the history before the next
          // model call. Folding the two operations together forced one model
          // call per result, which would show the model a transcript with some
          // of its own tool calls still unanswered.
          appendIncoming(request.message as TauMessage)
          emit({ ok: true, telemetry: await telemetry() })
        } else if (op === 'step') {
          // One model call on the current surface, with a fresh turn boundary.
          rotateTurn()
          const assistant = await modelTurn()
          emit({ ok: true, assistant, telemetry: await telemetry() })
        } else if (op === 'turn') {
          // Append and call, for callers whose protocol delivers exactly one
          // message per exchange (tau2's orchestrator).
          rotateTurn()
          appendIncoming(request.message as TauMessage)
          const assistant = await modelTurn()
          emit({ ok: true, assistant, telemetry: await telemetry() })
        } else if (op === 'tool') {
          // One EF tool call, dispatched against the host's own ToolRuntime.
          //
          // The recall tools read the bundle store, which lives in this process,
          // so the Python side cannot answer them. Routing through the SAME
          // runtime a real DSH agent loop uses is what keeps the benchmark's
          // tool path identical to production — reimplementing the search in
          // Python would measure a different implementation.
          const content = await callEfTool(
            String(request.name),
            request.arguments,
            String(request.callId ?? ''),
          )
          emit({ ok: true, content, telemetry: await telemetry() })
        } else if (op === 'close') {
          closeTurn()
          emit({ ok: true, telemetry: await telemetry() })
          process.exit(0)
        } else {
          throw new Error(`bridge: unknown op "${op}"`)
        }
      } catch (error) {
        emitError(error)
      }
    }
  }
}

void main()
