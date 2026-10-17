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
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
// `SystemPrompt` and `ToolRuntime` are mounted by the shared helper
// (`eval/src/runtime-mount.ts`); only the ToolRuntime TYPE is needed here.
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
// The tool-result pruner is imported LAZILY inside the shared mount helper
// (`eval/src/runtime-mount.ts`), because a static import of a package that is
// not installed is a bridge that cannot start. See the mount site in `init`.
// Imported from SOURCE, like every other module under `eval/` — not from
// `lib/*.js`. The build deliberately ships no `.d.ts` ("emitting declarations
// would create a SECOND artifact"), so a `lib/` import resolves to `any` and
// silently escapes typechecking: this file's `'auto'` trigger and a dead local
// both survived that way. `--experimental-transform-types` runs the `.ts`
// sources directly, so source imports are also what the process actually loads.
import { EpistemicFoldEngine } from '../../src/engine.ts'
import { EpistemicFoldPlugin } from '../../src/plugin.ts'
import { resolvePreset } from '../../src/preset.ts'
import { taskRootDigest } from '../../src/task-root.ts'
import type { FoldModeName } from '../../src/preset.ts'
import { resetSummaryRetryStats, summaryRetryStats } from '../../src/summary-retry.ts'
import { resetSubagentRecallStats, subagentRecallStats } from '../../src/recall/subagent-recall.ts'
import { OpenAiCompatibleAdapter } from '../live/openai-adapter.ts'
import { BillingRecorder } from '../live/recorder.ts'
import { realizedCost, summarizeBill } from '../live/billing.ts'
import { DEFAULT_OUTPUT_RESERVE, RequestBudget, budgetLimitsFromEnv } from '../live/request-budget.ts'
import { assertRouteRoutable, resolveLiveRoute } from '../live/zcode-config.ts'
import { parseEconomicsProfile } from '../../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountRuntime, mountToolResultPruner } from '../src/runtime-mount.ts'

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

/**
 * Context window the engine prices its fold threshold against.
 *
 * ## This is a LANE constant, and that made it wrong for a bigger-window model
 *
 * The default of 32_000 was chosen for the tau2 lane (662d468) and inherited by LHTB,
 * so every fold in that lane was priced at `min(32000 x 0.5, 32000 - reserve) = 16_000`
 * tokens (`resolveEfCompactSpec`, `src/policy.ts:386-431`; `thresholdRatio` below).
 * Measured on the 4.1F round: the task's own working set is 16_471 tokens, so EVERY
 * fold evicted 7-11K tokens of material the agent had just read -- 50-109 folds per
 * cell against step-5's 2-17 on the same threshold, 489K-803K tokens evicted per
 * episode, and 10 of 11 cells never wrote the deliverable. See docs/65.
 *
 * The escape hatch is `EF_TAU2_WINDOW`, and it is set by the lane that knows its
 * model (`scripts/run-lhtb.sh`), deliberately NOT by changing this default: 32K is the
 * tau2 lane's recorded choice and RC9's null result was measured at it.
 *
 * ## The reply budget is NOT reserved, which is a second, latent incoherence
 *
 * `reservedCompletionTokens` (`src/policy.ts:49`) is
 * `session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0`, and this
 * lane's adapter publishes no `defaultMaxTokens` (`eval/live/openai-adapter.ts:234-241`
 * returns `context` only). So the reserve is 0 even while `EF_BRIDGE_MAX_TOKENS` asks
 * for a 32_768-token completion -- against a window of 32_000. It does not currently
 * bite, because measured replies are 204-2_804 output tokens per call, but a lane that
 * asks for a completion larger than its declared window should say so rather than rely
 * on the model declining to use the room.
 */
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
 * Bound on ONE main model call, in ms. 0 disables it.
 *
 * ## Why the fold's fix was not the whole fix
 *
 * The comment below on the fold explains that a summarization call stalled for 16 minutes
 * with Harbor and the container both alive and no error anywhere, and that a real deadline
 * is what turns that stall into a recorded failure the episode survives. That fix was
 * applied to the FOLD and not to the MAIN call, which is the one that runs hundreds of
 * times per episode rather than a handful.
 *
 * Measured on riscv-core-debug, which is the task that found it: two cells stopped
 * emitting transcript entries at 03:52:11 and 03:53:13, their containers idle at 0% CPU
 * with no simulation running, and nothing else in the system aware that anything was
 * wrong. They would have sat there until the 21600s episode timeout, having spent the
 * whole budget, and recorded a score of nothing with no error to explain it.
 *
 * 900s: roughly three times the slowest legitimate call observed (305s at a 32768-token
 * budget) and well below the episode budget, so a real answer completes and a hang is
 * cut. A cut call surfaces as an ordinary transport failure, which the LHTB agent already
 * counts, backs off from, and retries.
 */
const STEP_TIMEOUT_MS = Number(process.env.EF_TAU2_STEP_TIMEOUT_MS ?? 900_000)

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
  /**
   * Whether the host registers this episode's task instruction as an ACTIVE TASK ROOT.
   *
   * `off` is the default and preserves the old behaviour exactly. `exact` means the host
   * declares the instruction explicitly (see `registerTaskRootFromAppend`).
   *
   * NOT derived from `mode`: enabling protection is a decision about the EXPERIMENT, not a
   * property of a tier, and inferring it from the arm name would change what an existing
   * arm measures without anyone choosing it. `engine: 'basic'` is forced to `off` for the
   * same reason -- the baseline must stay the baseline.
   */
  readonly taskRootMode?: 'off' | 'exact'
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

/** One fold, with what it shadowed, so exposure is recoverable afterwards. */
interface FoldEvent {
  /** Which of the three mechanisms committed it, from the counter deltas. */
  readonly mechanism: 'leaf' | 'root' | 'emergency'
  /** The surface seqs it shadowed -- the range a fact's seq must fall in to count. */
  readonly shadowedSeqs: readonly number[]
  /** The seq of the summary that replaced them, which extends the lineage chain. */
  readonly summarySeq: number | null
  readonly shadowedTokenCount: number | null
  /** Surface tokens either side, so the fold's compression ratio is visible. */
  readonly tokensBefore: number
  readonly tokensAfter: number
}

/** Telemetry the EF side reports back; never part of the benchmark score. */
/**
 * What the fold was priced against, as the engine resolved it.
 *
 * Published so an archive can answer "what budget did this run have?" without a
 * second computation that could disagree with the engine, and without the forensic
 * dig that the 4.1F round required.
 */
export interface CompactBudget {
  /** The window the fold threshold is a fraction of. */
  readonly contextWindow: number
  /** The pressure threshold: at or above this the engine folds. */
  readonly thresholdTokens: number
  /** `contextWindow - reservedCompletionTokens`: the largest surface that fits. */
  readonly hardCapacityTokens: number
  /** Tokens of recent tail kept verbatim across a fold. */
  readonly retainTokens: number
  /** Completion tokens the engine deducted from the window. */
  readonly reservedCompletionTokens: number
}

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
  /**
   * One entry per fold, so a fact's exposure can be computed after the run.
   *
   * `exposure(f)` -- how many folds had f inside the shadowed region -- is the
   * quantity `docs/62_MEMORY_PRESSURE_TASK_DESIGN.md` section 7 needs, and it
   * cannot be recovered from the lifetime counters: `folds` says how many folds
   * happened, not which seqs each one shadowed.
   *
   * `CompactionResult` carries `shadowedSeqs` and `summarySeq`, and this host
   * discarded the result entirely -- it read only the engine's counters around
   * the call. Recording it is therefore a PURE ADDITION: no behaviour changes,
   * only what is reported, which is why it can be added while a measurement lane
   * is still running.
   *
   * `mechanism` is derived from the counter deltas rather than from the result,
   * because `CompactionResult` has no `kind` field -- something this file
   * already learned when it tried substring-matching the JSON for one.
   */
  readonly foldLineage: readonly FoldEvent[]
  /**
   * The task-root residency state for this episode.
   *
   * A status and three identifiers, NEVER the instruction: this block is archived with the
   * transcript and a full instruction in telemetry would put benchmark content into every
   * cell's record. `surfacePosition` is enough to check the contract was honoured, and the
   * content can be read from the session itself.
   */
  /** The provider budget as it stands, so a report reconciles against the provider's own log. */
  readonly budget?: {
    readonly requests: number
    /** CHARGED totals: measured plus reserved. What admission compares. */
    readonly promptTokens: number
    readonly outputTokens: number
    /** Provider-reported. Never includes a reserve. */
    readonly observedPromptTokens: number
    readonly observedOutputTokens: number
    /** Conservatively reserved for requests whose true cost is unknown. */
    readonly reservedPromptTokens: number
    readonly reservedOutputTokens: number
    readonly unknownUsageRequests: number
    readonly partialUsageRequests: number
    readonly elapsedMs: number
    readonly refusals: number
    readonly limit: {
      readonly requests: number
      readonly promptTokens: number
      readonly outputTokens: number
      readonly wallClockMs: number
    }
  }
  readonly taskRoot: {
    /** The host's declared mode for this arm. */
    readonly mode: 'off' | 'exact'
    /** `unregistered` when the mode is off, or the engine's own status once registered. */
    readonly status: 'unregistered' | 'registered' | 'resident' | 'absent'
    /** The session seq of the declared instruction, when one was declared. */
    readonly sourceSeq?: number
    /** Whether the engine re-derived the event and matched the host's digest. */
    readonly digestVerified: boolean
    /** The surface position the engine reports as protected, when resident. */
    readonly surfacePosition?: number
    /** Why registration did not happen, or why the root is absent. */
    readonly reason?: string
  } | undefined
  /**
   * The window and budgets the folds were actually priced against, read off the
   * engine that priced them.
   *
   * ## The defect this closes
   *
   * A round archived `folds`, `promptTokensLast` and the whole fold lineage but NOT
   * the budget behind them, so "this arm folded 50-109 times" and "this arm folded
   * 2-17 times" could not be explained from the archive — the threshold had to be
   * recovered by decompressing a bundle and re-deriving
   * `min(contextWindow x thresholdRatio, window - reserve)` by hand. When that was
   * done the answer was that the window was 32_000 tokens while the task's own
   * working set was 16_471, so every fold evicted material the agent had just read.
   *
   * `null` means no pressure check ever resolved a spec, which is a different fact
   * from "the budget was zero".
   */
  readonly compactBudget: CompactBudget | null
  /**
   * Subagent recall (docs/67), when the experiment is on.
   *
   * `gated` is the reading that decides whether the experiment was EXERCISED at all: it
   * counts direct recalls refused for size. A run with `gated: 0` and `invocations: 0`
   * tells you nothing about the feature, however many turns it took.
   */
  /**
   * Derived retrieval answers RETIRED at fold time (docs/67).
   *
   * Read with `subagentRecall.invocations`: answers produced but none retired means no fold
   * has covered one yet, which is a different fact from the rule never firing.
   */
  readonly derivedAnswersRetired: number
  readonly subagentRecall: {
    readonly gated: number
    readonly invocations: number
    readonly surveyInvocations: number
    readonly planCalls: number
    readonly answerCalls: number
    readonly fetches: number
    readonly fetchedChars: number
    readonly answerChars: number
    readonly failures: number
    readonly lastError: string | null
  }
  /** Whether the automatic fold was enabled at the moment of this snapshot. */
  readonly compactionEnabled: boolean
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
   * The engine's own verdict on the last leaf decision, or null before any fold.
   *
   * Emitted since 08b3b5e and DECLARED NOWHERE until 2026-10-18 -- `tsc -p tsconfig.eval.json`
   * reported `'lastLeafDecision' does not exist in type 'Telemetry'`, and no local command ran
   * that project, so it went unseen while CI ran red.
   */
  readonly lastLeafDecision: string | null
  /**
   * Summarization attempts a truncation forced to be retried, the attempts made in
   * total, and the attempts that truncated on EVERY try.
   *
   * A zero `truncated` count means one of two different things: nothing truncated at
   * all, or the retry absorbed what did. Those are different facts about the provider,
   * and without these counters they read identically after the run.
   */
  readonly summarizationAttempts: number
  readonly rationaleAttempts: number
  readonly rationaleFailures: number
  readonly rationaleFailureReason: string | null
  readonly rationaleChars: number
  readonly summarizationRetries: number
  readonly summarizationRetryExhausted: number
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
  /**
   * The wall-clock decomposition of the model-call loop, in milliseconds.
   *
   * `callMs` is the provider's share, `turnMs` is the fold and rebase drain that run before
   * the request, and `gapMs` is everything between the end of one call and the start of the
   * next -- the agent's own work plus the task's graded-sample pacing floor.
   *
   * Read the three against the cell's age: they are what turns `calls` into calls per hour.
   */
  readonly timing: {
    readonly calls: number
    readonly callMsTotal: number
    readonly callMsMax: number
    readonly callMsLast: number
    readonly turnMsTotal: number
    readonly turnMsMax: number
    readonly gapMsTotal: number
    readonly gapMsMax: number
    readonly gapMsLast: number
    /** The last 40 calls as `{ c: callMs, t: turnMs, g: gapMs }`, so a snapshot shows the shape. */
    readonly series: readonly { readonly c: number; readonly t: number; readonly g: number }[]
  }
  readonly lastProviderError: string | null
  /**
   * Whether the tool-result pruner mounted, and why not when it did not.
   *
   * Production mounts it and EF reads it, so a run without it is measuring a
   * configuration that cannot ship -- the defect RC28 removed. `null` means the
   * episode never reached the mount, which is not the same as "it was absent".
   */
  readonly prunerMounted: boolean | null
  readonly prunerError: string | null
  /**
   * Whether the provider was offered EF's `context_search` / `context_recall`.
   *
   * `toolSchemas()` forwards `ctx.tools.schemas()` to the provider UNCONDITIONALLY —
   * it has no notion of the arm — so the only thing keeping EF's retrieval tools out
   * of the `basic` baseline is the plugin returning before it registers them, in a
   * different file. That is a single line of defence for a measurement-integrity
   * invariant, so the OUTCOME is recorded per episode rather than trusted: a
   * `basic` cell reporting `true` here is a contaminated baseline, and a run can be
   * audited for it without re-reading the source.
   */
  readonly efToolsOffered: boolean
  /** The pressure regime the last automatic fold decision resolved. */
  readonly pressureRegime: string
  readonly costTotal: number
  /**
   * Tokens the whole episode spent, from the all-call bill.
   *
   * ## Why tokens and not seconds
   *
   * Wall clock is not a measure of work. It moves with machine load, container
   * contention, provider latency, and how many other runs are on the host, so
   * the same episode scores differently on the same code. A token count is a
   * property of the episode alone, and it is the quantity EF's entire claim is
   * about, which is what makes an efficiency figure possible at all:
   * correctness per token rather than correctness per hour.
   *
   * These are the provider's own counters, summed over every call by the
   * all-call recorder -- main turns, compaction, and rationale alike -- so an
   * arm cannot look cheap by hiding its auxiliary work.
   *
   * `null` when no bill was recorded, never 0: "nothing was measured" and
   * "nothing was spent" are different facts.
   */
  readonly tokensPrompt: number | null
  readonly tokensUncachedInput: number | null
  readonly tokensCacheRead: number | null
  readonly tokensOutput: number | null
  /** prompt + output. The denominator of every efficiency figure. */
  readonly tokensTotal: number | null
  /** Provider calls the bill saw, including failed ones. */
  readonly billedCalls: number | null
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
/**
 * Whether a turn is currently OPEN on the session.
 *
 * `turnHasContent` answers "may I close the current turn?", which is a different
 * question, and conflating the two is what let them drift apart: a provider
 * failure closes the empty turn and clears `turnHasContent`, and the next
 * `rotateTurn` then skipped opening one, because it only opened inside the
 * `if (turnHasContent)` branch. The step then ran with NO open turn.
 *
 * Basic's automatic compaction refuses exactly that state
 * (`compactRegion: no open turn — automatic compaction events must be enclosed
 * in a turn`), and `src/basic/region.ts` is vendored byte-for-byte from
 * `@deepseek-ai/dsh-compaction-basic`, so the refusal is correct and this host
 * is what was wrong. Production never reaches it: Basic's `compactIfNeeded` runs
 * on `agent/pre-step`, inside a turn the agent loop owns.
 *
 * Measured before the fix: every `basic` cell reported double-digit compaction
 * failures (unknown-config 21/33, riscv 26/41 and 26/45, commit0 13/36) while
 * every EF arm reported 0 — because `drainIdleRebase` incidentally repaired the
 * invariant for EF arms and returns early for `mode: basic`.
 */
let turnOpen = false
let folds = 0
/** Every fold this episode, in order. See `Telemetry.foldLineage`. */
let foldLineage: FoldEvent[] = []
/** The arm for the running episode, so later ops can read its host-facing switches. */
let arm: ArmSpec | undefined
/** What the host declared about the task root, and what the engine did with it. */
let taskRootState: Telemetry['taskRoot'] = undefined
/** The episode's provider budget, when the experiment sets one. See `eval/live/request-budget.ts`. */
let budget: RequestBudget | undefined
/**
 * Whether the automatic fold runs before a model call.
 *
 * The memory-pressure task measures a state, so the probe turn must not change one: a fold
 * landing before the probes would measure the state after a compression the caller did not ask
 * for, and one landing between them is impossible only if the whole probe set is a single turn
 * AND no fold can precede it (docs/62 section 5.4).
 *
 * It is also what makes the injection arms sound. Injecting a document adds tokens, and tokens
 * can trigger a fold -- which would compress the very document just injected, so arm B would be
 * measured on a state the injection itself changed.
 *
 * A measurement choice, not a claim about production, and recorded as one.
 */
let compactionEnabled = true
let roots = 0
let emergencies = 0
/** Failed maintenance calls, split by kind, and the last message. See `Telemetry`. */
let compactionFailures = 0
let compactionFailureKinds: Record<string, number> = {}
let lastCompactionError: string | null = null
/** Whether the tool-result pruner mounted, and why not when it did not. */
let prunerMounted: boolean | null = null
let prunerError: string | null = null
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
/**
 * The wall-clock decomposition, in milliseconds.
 *
 * ## Why this exists
 *
 * A cell's turns per hour is set by how long it takes to get from one model call to the
 * next, and every attempt to explain that from OUTSIDE the process was wrong: the provider
 * answers in 2.5s even at a 24K-token prompt, `docker exec` costs ~110ms, and the model
 * emits at 89 tok/s -- yet one call costs ~100s of wall clock. Those measurements EXHAUST
 * the cheap explanations and leave most of the time unattributed, which is the same class
 * of blind spot as the 160-character error cut that hid the `reasoning_content` 400.
 *
 * So the bridge times its own side of the loop:
 *
 *   callMs   the `ctx.llm.stream` loop -- provider latency, including its own retries
 *   turnMs   the fold and idle-rebase drain that run BEFORE the request is measured
 *   gapMs    from the END of the previous call to the START of this one: the agent parsing
 *            the reply, running the tool in the container, appending the transcript, and
 *            the graded-sample pacing floor, all together
 *
 * `gapMs` is deliberately coarse. Splitting it further needs the tool timings, which the
 * Python agent records on its side and carries into the transcript.
 */
const timing = { calls: 0, callMsTotal: 0, callMsMax: 0, turnMsTotal: 0, turnMsMax: 0,
  gapMsTotal: 0, gapMsMax: 0, lastCallMs: 0, lastTurnMs: 0, lastGapMs: 0,
  series: [] as { c: number; t: number; g: number }[] }
/** When the previous call's stream loop returned; 0 before the first call. */
let lastCallEndedAt = 0
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
function appendIncoming(message: TauMessage | TauMultiTool): number[] {
  const active = session!
  // ## The seqs this append created, returned rather than inferred
  //
  // Exposure is "how many folds had this fact inside their shadowed range" (docs/62 section 7.2),
  // and the fold lineage records the shadowed SEQS. Without a fact -> seq mapping the lineage
  // cannot be joined to a probe at all, so the exposure covariate -- the whole point of section 7
  // -- is unreachable. The first version of this function returned nothing and the mapping had no
  // source.
  //
  // The seqs are the surface nodes that did not exist before the append, which is exact rather
  // than assumed: nothing here presumes they are contiguous, or that a seq equals an index.
  const before = new Set(active.surface.nodes)
  // tau2 bundles several tool results into one message when the model issued
  // parallel calls. Each result is a separate DSH event, so they are expanded
  // rather than collapsed — the fold frontier reasons per event.
  if (isMultiTool(message)) {
    const all: number[] = []
    for (const inner of message.tool_messages ?? []) all.push(...appendIncoming(inner))
    return all
  }
  if (message.role === 'user') {
    active.append('user/message', createUserMessage({
      content: [{ type: 'text', text: message.content ?? '' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    return active.surface.nodes.filter(s => !before.has(s))
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
    return active.surface.nodes.filter(s => !before.has(s))
  }
  throw new Error(`bridge: unsupported incoming role "${message.role}"`)
}

/**
 * Close the current turn and open the next one.
 *
 * The invariant this must uphold is that a turn is OPEN whenever the model is
 * called, because automatic compaction requires an enclosing turn. The recovery
 * is written as `if (!turnOpen) openTurn()` rather than folded into the
 * `turnHasContent` branch, so it also runs after a step that closed the turn
 * without producing content — which is exactly the provider-failure path.
 */
function rotateTurn(): void {
  if (turnHasContent) closeTurn()
  if (!turnOpen) openTurn()
  turnHasContent = true
}

/** Open a turn, so automatic compaction has an enclosing turn (EF requires one). */
function openTurn(): void {
  turnCounter += 1
  session!.append('turn/start', { turn: turnCounter })
  turnOpen = true
}

/**
 * Close the current turn.
 *
 * Guarded on `turnOpen` so it can never emit an unbalanced `turn/end`: an
 * unclosed turn is illegal, and so is closing one twice.
 */
function closeTurn(): void {
  if (!turnOpen) return
  session!.append('turn/end', { turn: turnCounter, reason: { kind: 'completed' } })
  turnOpen = false
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
  // The engine's own code for "a fold committed and the surface is still over
  // threshold". Tagged structurally rather than matched on prose, because the
  // message is redacted and clipped before it is stored.
  //
  // This branch was MISSING from the first version of the reachability work: the
  // engine set the code, but the classifier here never learned it, so the failure
  // fell into `other` — the exact conflation this classifier exists to end, and
  // the reason PR #3 split the kind out in the first place. Caught by re-reading
  // this function against the engine rather than by a test, so a test now pins it.
  if (code === 'PRESSURE_UNRESOLVED') return 'pressure-unresolved'
  if (code === 'PRESSURE_UNREACHABLE') return 'pressure-unreachable'
  if (code === 'LIVE_HTTP') return 'provider-http'
  if (code === 'LIVE_TRANSPORT') return 'provider-transport'
  if (code === 'UNSUPPORTED_CONTENT') return 'unsupported-content'
  const message = error instanceof Error ? error.message : String(error)
  if (/truncated at the token cap/u.test(message)) return 'truncated'
  // Prose fallback, for the vendored `src/basic/index.ts` wording, which cannot be
  // tagged: that tree is a byte-identical copy of the upstream package.
  if (/still above threshold after/u.test(message)) return 'pressure-unresolved'
  if (/no fold can reach the threshold/u.test(message)) return 'pressure-unreachable'
  if (/HTTP [0-9]{3}/u.test(message)) return 'provider-http'
  return 'other'
}

async function foldIfNeeded(): Promise<void> {
  const active = engine!
  // Disabled for the probe turn (see `compactionEnabled`). The fold is skipped rather than
  // faked: nothing is recorded, so `folds` and `foldLineage` keep describing what the engine
  // actually did.
  if (!compactionEnabled) return
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
  // Read the counters BEFORE the call: the mechanism is the delta, because
  // `CompactionResult` carries no `kind` field to read it from.
  const countersBefore = foldCounters(active)
  // Measured through the same meter the rest of the host uses; `session` has no
  // meter of its own, and an earlier draft of this line read one from it and
  // typechecked only because `session!` is loosely typed.
  const tokensBefore = ctx!.tokenMeter.measure(session!).totalTokens
  let committed: unknown = null
  try {
    committed = await active.compactIfNeeded(agent, 'pressure', deadline.signal)
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
  // ## The surface size, published here and not only on a model call
  //
  // promptTokensLast was set ONLY inside the model-call path. A bridge that had ingested documents
  // but not yet called the model therefore reported ZERO, and the memory driver reads this field as
  // BOTH the ingested size and the surface size -- so its calibration measured nothing and then
  // reported "reached the target", because zero is less than the target. A false green of exactly
  // the kind that benchmark exists to detect, and it survived because the path had never been run.
  //
  // The meter is already used two lines up for the lineage; it simply was not published.
  promptTokensLast = ctx!.tokenMeter.measure(session!).totalTokens

  // ## Record the lineage, not only the count
  //
  // A count cannot answer "how many times was THIS fact folded", which is the
  // quantity the memory-pressure design needs (docs/62, section 7). The result
  // carries the shadowed seqs, so recording it is what makes exposure
  // recoverable -- and it is a pure addition, since the result was discarded.
  //
  // A fold that threw commits nothing and is already counted by
  // `compactionFailures`; recording it here as well would double-count it as an
  // event that shadowed nothing.
  if (committed !== null && committed !== undefined) {
    recordFoldLineage(countersBefore, counters, committed, tokensBefore)
  }
}

/**
 * Record one COMMITTED fold in the lineage. ONE place, so every fold path agrees.
 *
 * The mechanism is derived from the engine's own counters rather than from the caller's
 * intent: a path that believed it was performing a root and committed a leaf must read as a
 * leaf, or the lineage would describe the caller instead of the engine.
 *
 * @param countersBefore - fold counters taken before the transaction.
 * @param countersAfter - fold counters taken after it.
 * @param result - the committed result, whose `shadowedSeqs` are the archive's own record.
 * @param tokensBefore - surface tokens before the fold.
 */
function recordFoldLineage(
  countersBefore: { readonly leaves: number; readonly roots: number; readonly emergencies: number },
  countersAfter: { readonly leaves: number; readonly roots: number; readonly emergencies: number },
  result: { readonly shadowedSeqs?: readonly number[]; readonly summarySeq?: number; readonly shadowedTokenCount?: number },
  tokensBefore: number,
): void {
  const dEmergencies = countersAfter.emergencies - countersBefore.emergencies
  const dRoots = countersAfter.roots - countersBefore.roots
  foldLineage.push({
    mechanism: dEmergencies > 0 ? 'emergency' : dRoots > 0 ? 'root' : 'leaf',
    shadowedSeqs: [...(result.shadowedSeqs ?? [])],
    summarySeq: result.summarySeq ?? null,
    shadowedTokenCount: result.shadowedTokenCount ?? null,
    tokensBefore,
    tokensAfter: ctx!.tokenMeter.measure(session!).totalTokens,
  })
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
  // Asks whether a turn is OPEN, not whether it carries content: the close/reopen
  // below is about the lifecycle, and using the content flag here is what let a
  // provider-failed step leave the session with no enclosing turn.
  const wasOpen = turnOpen
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
  // Published for the same reason as in the append path: a fold changes the surface size, and a
  // reader that only sees it after the NEXT model call is reading a stale value.
  promptTokensLast = ctx!.tokenMeter.measure(session).totalTokens
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
  // ## An explicitly EMPTY list means "no tools", and it is honoured (fixed 2026-10-17)
  //
  // This merged `ctx.tools.schemas()` unconditionally, so a caller that passed `[]` still received
  // the runtime's recall tools. Measured: the memory bench passes `[]` (run_cell.py:250,298) and was
  // offered context_search/context_recall anyway; the model called one, the bench answers no tool
  // calls anywhere (zero `call_tool` sites in eval/memory), and the unanswered call left an assistant
  // message with no tool result. The provider rejects that shape, so 19 of 20 probe batches failed
  // and every run scored 0/204 at every tier.
  //
  // The list is NOT simply forwarded, and that distinction is load-bearing: `ef_lhtb_agent.py:444`
  // passes a NON-empty list (its shell tool) and DEPENDS on the runtime tools being merged -- the
  // recall tools are executed by the DSH ToolRuntime, not by the lane. Forwarding the list verbatim
  // would silently strip recall from the lane. So: empty means none, non-empty means these plus the
  // runtime's. Both callers get what they asked for, and neither gets a silent behaviour change.
  if (benchmarkTools.length === 0) return []
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
async function modelTurn(maxTokens?: number): Promise<TauAssistant> {
  const turnStartedAt = performance.now()
  const gapMs = lastCallEndedAt === 0 ? 0 : turnStartedAt - lastCallEndedAt
  // ## `exact` must not silently degrade into Unpinned -- checked FIRST, before any fold
  //
  // This guard used to sit AFTER `foldIfNeeded()`, which defeated it: a fold could commit against
  // the very state the guard exists to refuse. It is now the first thing `modelTurn` does, so the
  // refusal precedes the fold, the rebase and the request rather than merely the request.
  //
  // `protectedRootGuard` refuses a ROOT fold whose registered source has gone missing, but the
  // engine cannot distinguish "this arm runs `exact` and the host never registered" from "this arm
  // runs `off`" -- both are simply an empty registry. The MODE lives here, in the host, so the
  // fail-closed check for the missing-registration case belongs here too. Without it a host bug
  // removes the protection the arm was configured to provide, and every fold then runs
  // unprotected while the telemetry still says `exact`.
  //
  // Checked BEFORE `drainIdleRebase()`, so the refusal precedes any fold or rebase that could
  // commit against an unverified task state -- not merely the provider call that follows.
  if (arm !== undefined && arm.engine !== 'basic' && arm.taskRootMode === 'exact') {
    const status = engine!.taskRootStatus(session!)
    if (status.status !== 'resident') {
      lastFinishReason = 'task-root-contract'
      taskRootState = {
        mode: 'exact',
        status: 'absent',
        digestVerified: false,
        reason: `contract failure before the model call: ${status.status}`,
      }
      return { role: 'assistant', content: null, error: 'task root contract failure' }
    }
  }
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
  // A REAL deadline on the main call, exactly as the fold has. Without it a hung
  // provider call blocks this process forever: the agent's readline() on the other end of
  // the pipe has no timeout either, so nothing in the system can notice or recover.
  const deadline = new AbortController()
  const timer = STEP_TIMEOUT_MS > 0 ? setTimeout(() => deadline.abort(), STEP_TIMEOUT_MS) : undefined
  // After the fold and the drain, so `callMs` is the PROVIDER's share and `turnMs` is the
  // fold's. `gapMs` already includes both, because it starts when the last call ended.
  const callStartedAt = performance.now()
  try {
    for await (const chunk of ctx!.llm.stream({
      provider: LIVE_PROVIDER,
      model: 'live',
      messages,
      ...(systemText === undefined ? {} : { system: systemText }),
      tools: toolSchemas(),
      signal: deadline.signal,
      maxTokens: maxTokens ?? STEP_MAX_TOKENS,
    } as never)) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        calls.push({ id: chunk.block.id, name: chunk.block.name, args: chunk.block.arguments })
      }
      if (chunk.type === 'finish') {
        // ## Why the recorded failure is not truncated to a glance
        //
        // This was `.slice(0, 160)`, and that cut cost a whole wave its diagnosis. The
        // adapter already keeps 300 characters of the provider's RESPONSE BODY
        // (`openai-adapter.ts:466`), which is where an `invalid_request_error` names the
        // offending field -- and 160 landed mid-word at
        // `Upstream request failed: [invalid_reques`, so a run that failed 50-73% of its
        // calls recorded only that SOMETHING was rejected, never WHAT.
        //
        // The bound is now generous rather than tight. A failure message is written once per
        // failed call and is the only evidence a post-mortem has; a transcript that is a few
        // KB larger is a rounding error next to re-running a multi-hour wave blind.
        // A budget refusal is its OWN finish reason, not an `error:`. `providerFailures` counts
        // only `error:` (below), so a spent budget cannot be reported as a provider fault, and
        // the agent can terminate with a reason that says which of the two happened.
        const failure = (chunk.reason as { failure?: { message?: string; code?: string } }).failure
        finishReason = chunk.reason.kind !== 'error'
          ? chunk.reason.kind
          : failure?.code === 'BUDGET_EXHAUSTED'
            ? 'budget-exhausted'
            : `error:${String(failure?.message ?? '').slice(0, 2_000)}`
      }
    }
  } finally {
    if (timer) clearTimeout(timer)
    // Recorded in `finally` so a FAILED call is timed too: a provider timeout is exactly
    // the case this instrumentation exists to separate from tool time.
    const endedAt = performance.now()
    const callMs = endedAt - callStartedAt
    const turnMs = callStartedAt - turnStartedAt
    timing.calls += 1
    timing.callMsTotal += callMs
    timing.callMsMax = Math.max(timing.callMsMax, callMs)
    timing.turnMsTotal += turnMs
    timing.turnMsMax = Math.max(timing.turnMsMax, turnMs)
    timing.lastCallMs = callMs
    timing.lastTurnMs = turnMs
    if (gapMs > 0) {
      timing.gapMsTotal += gapMs
      timing.gapMsMax = Math.max(timing.gapMsMax, gapMs)
      timing.lastGapMs = gapMs
    }
    lastCallEndedAt = endedAt
    if (timing.series.length >= 40) timing.series.shift()
    timing.series.push({ c: Math.round(callMs), t: Math.round(turnMs), g: Math.round(gapMs) })
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
  // The budget stop: the turn is closed empty, nothing is appended, and it is NOT counted as a
  // provider failure because the provider was never asked.
  if (finishReason === 'budget-exhausted') {
    if (turnHasContent) {
      closeTurn()
      turnHasContent = false
    }
    return { role: 'assistant', content: null, error: 'episode budget exhausted' }
  }
  if (finishReason.startsWith('error:')) {
    providerFailures += 1
    // ## Redacted at the STORAGE point, not only upstream
    //
    // `lastCompactionError` has been redacted here since it was written (see the sibling line
    // below). `lastProviderError` was not, and it started reaching every result artifact only
    // after the memory bench's telemetry whitelist was widened from 9 keys to 22. The adapter
    // redacts its own messages, so the value was probably clean -- but "probably clean" is not a
    // property to rest a credential on, and the whitelist change is what made it reachable.
    // Redacting where it is STORED means a future adapter change cannot silently undo it.
    lastProviderError = finishReason.slice('error:'.length)
      .replace(/sk-[A-Za-z0-9_-]{16,}/gu, '[redacted]')
      .replace(/(authorization|api[-_]?key)["'\s:=]+[^"'\s,}]+/giu, '$1=[redacted]')
      .slice(0, 400)
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
  // Fail HERE, not on the third model call. See `assertRouteRoutable`.
  assertRouteRoutable(route)
  // Fail HERE, not on the third model call. See `assertRouteRoutable`.
  assertRouteRoutable(route)
  profile = loadProfile()

  tools = request.tools
  systemText = request.policy
  turnCounter = 0
  stepCounter = 0
  turnHasContent = false
  turnOpen = false
  folds = 0
  foldLineage = []
  arm = request.arm
  // Reset per episode. The state is a module-level binding because the ops are dispatched from
  // one readline loop, and a value left over from a previous episode would report that episode's
  // task root as this one's.
  taskRootState = undefined
  compactionEnabled = true
  roots = 0
  emergencies = 0
  compactionFailures = 0
  compactionFailureKinds = {}
  lastCompactionError = null
  prunerMounted = null
  prunerError = null
  providerFailures = 0
  lastProviderError = null
  // Per-episode, like every other counter: a bridge process can outlive one episode, and an
  // accumulated timing series would report the previous cell's wall clock as this one's.
  timing.calls = 0
  timing.callMsTotal = 0
  timing.callMsMax = 0
  timing.turnMsTotal = 0
  timing.turnMsMax = 0
  timing.gapMsTotal = 0
  timing.gapMsMax = 0
  timing.lastCallMs = 0
  timing.lastTurnMs = 0
  timing.lastGapMs = 0
  timing.series.length = 0
  lastCallEndedAt = 0
  modelCalls = 0
  promptTokensLast = 0
  surfaceNodesLast = 0
  costTotal = 0
  // Process-lifetime totals in EF's own module, so zeroed per episode like the rest:
  // the bridge process outlives one episode only by accident of how Harbor runs it.
  resetSummaryRetryStats()
  // Same reason as the summary counters: the bridge process can outlive one episode, so a
  // per-episode reading must be zeroed per episode rather than accumulated by accident.
  resetSubagentRecallStats()

  const bundleRoot = process.env.EF_TAU2_BUNDLE_ROOT
  if (bundleRoot === undefined) throw new Error('bridge: EF_TAU2_BUNDLE_ROOT is not set')

  ctx = new Context()
  // The shared DSH runtime mount (docs/68 B-6): the same core sequence as the
  // tests and the paired runner.
  // SystemPrompt and ToolRuntime come from the SAME helper as the core sequence.
  //
  // They were explicit here because `tests/harness-recall-tools.spec.ts` grepped
  // THIS FILE'S SOURCE TEXT for both constructors and their order — the D4
  // anti-pattern docs/68 records. That order is an invariant of `mountRuntime`, so
  // it is pinned there and this file is pinned to using it, which is the same
  // guarantee asserted at the site that can actually break it.
  mountRuntime(ctx, { systemPrompt: true, tools: true })
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
  //
  // ## Mounted LAZILY, and its absence is recorded rather than fatal
  //
  // This was a static import, and a static import of a package that is in neither
  // package.json nor node_modules is not a degradation -- it is a bridge that
  // cannot start. Every LHTB run died with
  // `BridgeError: bridge host closed the stream ... ERR_MODULE_NOT_FOUND` in about
  // twenty seconds, and nothing in the suite noticed, because no test imports the
  // bridge's module graph. A gate that cannot see the entry point is not a gate.
  //
  // The dynamic import now lives in the shared mount helper, so the laziness and
  // the production budgets are the same on every harness that mounts it.
  //
  // The pruner still matters -- it is what makes an oversized tool result
  // foldable, and LHTB's oversized node IS shell output -- so when it is absent
  // that fact goes into the telemetry. A run that measured a configuration
  // without it must be identifiable from its own archive rather than inferred
  // from a failure mode.
  try {
    await mountToolResultPruner(ctx)
    prunerMounted = true
    prunerError = null
  } catch (error: unknown) {
    prunerMounted = false
    prunerError = error instanceof Error ? error.message : String(error)
    // Loud, because the run is now measuring a configuration production does not
    // have, and that is exactly the defect RC28 set out to remove.
    process.stderr.write(
      `[bridge] tool-result pruner NOT mounted: ${prunerError}\n`
      + '[bridge] oversized tool results will be un-foldable; this run measures a '
      + 'configuration production does not ship\n',
    )
  }
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
  // this service during construction. The mount itself is the shared call above.
  // Capture the runtime through the sanctioned `inject` callback: `ctx.get`
  // throws for a service outside `inject`, and `tools` is optional here. Awaited
  // because the callback does not run synchronously.
  await captureToolsRuntime()

  // ## The episode's hard provider budget
  //
  // `EF_LHTB_MAX_TURNS` bounds the AGENT's turns, which is not a bound on provider requests: the
  // fold's summarization goes through this same adapter, and a 429 retry is another request. The
  // gate therefore lives in the adapter, where every request passes, and it is checked BEFORE the
  // request so an exhausted budget prevents traffic instead of describing it. Zero disables a
  // limit, so an unconfigured lane behaves exactly as before.
  // `budgetLimitsFromEnv` refuses a SET BUT INVALID value instead of letting it disable the
  // check, and refuses a run that asked for enforcement and did not get it. See the module.
  // The reserve is what an UNKNOWN-cost request is charged: a full context window plus a generous
  // output allowance, because the fold's summarization has its own `maxTokens` and reserving the
  // main model's smaller reply budget would under-charge exactly the requests the reserve exists
  // for. It is a reservation, never reported as a measurement -- `telemetry.budget` keeps
  // `observed` and `reserved` apart.
  budget = new RequestBudget(budgetLimitsFromEnv(), {
    promptTokens: TAU2_WINDOW,
    outputTokens: DEFAULT_OUTPUT_RESERVE,
  })
  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    contextWindow: TAU2_WINDOW,
    budget,
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
  // ## A STORE-MANAGED session, not a detached one
  //
  // `Session.create` builds a detached session: it appends and derives messages, but the
  // store has never seen it, so `ctx.sessions.flush` rejects it with
  // `session "..." is not live in this store`. That is invisible to the automatic leaf path,
  // which never calls flush, and fatal to the MANUAL path -- `compactNow` passes a durability
  // barrier -- so the protected-root acceptance could never run through this bridge.
  //
  // `ctx.sessions.create` prepares, enters and announces the session, which is what makes it
  // live: `ctx.sessions.get(id) === session`, publication hooks are installed, and the store
  // owns the lifecycle. The session id is unchanged, so nothing downstream rekeys.
  session = ctx.sessions.create(SessionId(`tau2-${request.arm.label}-${request.domain}-${request.taskId}-${unique}`))

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
  // 8192 was a deliberate headroom multiple rather than a measured minimum, and it
  // is now known to be TOO SMALL -- not as a multiple, but because the budget it
  // multiplies is spent differently by a reasoning model.
  //
  // `max_tokens` caps reasoning AND content together. Measured on step-5-preview-free
  // summarising a 127K-token transcript:
  //
  //     cap= 2048  finish=length  reasoning=1467  contentLen= 1539
  //     cap= 4096  finish=length  reasoning=3920  contentLen=  666
  //     cap= 8192  finish=length  reasoning=1639  contentLen=19131   <- still truncated
  //     cap=32768  finish=stop    reasoning=1928  contentLen= 3631
  //
  // At 8192 the model produced nineteen thousand characters and still hit the cap,
  // which Basic reports as `summarization truncated at the token cap` and fails the
  // fold closed. That is the failure this value was raised to 8192 to prevent; it
  // prevented it only for the OUTPUT sizes a non-reasoning model produced.
  //
  // The model is also wildly variable, and that is the honest reason no value is
  // guaranteed: the SAME input at cap 16384 returned a 46,034-character summary and
  // truncated at 16384, while cap 8192 and 32768 both stopped early. A larger budget
  // lowers the probability rather than removing it, and 32768 is chosen for the same
  // asymmetry 8192 was -- a truncated summary is a FAILED fold.
  const common = {
    auto: true,
    thresholdRatio: Number(process.env.EF_TAU2_THRESHOLD ?? 0.5),
    headroomTokens: 0,
    maxTokens: Number(process.env.EF_TAU2_SUMMARY_MAX_TOKENS ?? 32_768),
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

/**
 * Register the host's declared task instruction as an ACTIVE TASK ROOT.
 *
 * ## Why the host has to say WHICH message
 *
 * Nothing here infers the task from the conversation. The host flags the append that carries
 * the instruction (`taskRoot: true`), because it is the only party that knows -- the first
 * user message is a guess, and a benchmark whose protection depended on that guess would be
 * protecting whatever the fixture happened to send first.
 *
 * ## What is refused rather than approximated
 *
 * * `taskRootMode: 'off'` (the default) -- nothing is registered and nothing changes.
 * * `engine: 'basic'` -- forced off. The baseline stays the baseline.
 * * an append that created more or fewer than ONE surface node -- a task root is one event;
 *   declaring a batch is a host bug and is reported as one.
 *
 * The content is never copied, re-worded or re-roled: the engine protects the USER event at
 * that seq, and the digest it verifies is over that event's own message.
 *
 * @param seqs - the surface seqs the flagged append created.
 */
async function registerTaskRootFromAppend(seqs: readonly number[]): Promise<void> {
  const mode = arm?.engine === 'basic' ? 'off' : arm?.taskRootMode ?? 'off'
  if (mode !== 'exact') {
    taskRootState = { mode: 'off', status: 'unregistered', digestVerified: false,
      ...(arm?.engine === 'basic' && arm.taskRootMode === 'exact'
        ? { reason: 'basic-arm-never-protects' }
        : {}) }
    return
  }
  if (seqs.length !== 1) {
    taskRootState = { mode, status: 'absent', digestVerified: false,
      reason: `append-created-${seqs.length}-nodes` }
    return
  }
  const sourceSeq = seqs[0]!
  const event = session!.eventAt(SessionSeq(sourceSeq))
  const message = event === undefined ? null : session!.deriveEventMessage(event)
  if (message === null) {
    taskRootState = { mode, status: 'absent', sourceSeq, digestVerified: false, reason: 'no-message' }
    return
  }
  const sourceDigest = taskRootDigest(message)
  const outcome = engine!.registerActiveTaskRoot({
    sessionId: session!.id,
    sourceSeq: SessionSeq(sourceSeq),
    sourceDigest,
    generation: 0,
  })
  // Verified by RE-DERIVING it, not by trusting the registration: `taskRootStatus` resolves the
  // event again, checks the role and re-computes the digest against what was registered.
  const status = engine!.taskRootStatus(session!)
  taskRootState = status.status === 'resident'
    ? { mode, status: 'resident', sourceSeq, digestVerified: true, surfacePosition: status.position }
    : { mode, status: 'absent', sourceSeq, digestVerified: false, reason: status.status === 'absent' ? status.reason : outcome.status }
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
  // The same bill, kept as TOKENS rather than priced into dollars. The price
  // depends on a profile that is a modelling choice; the token count is what the
  // provider actually charged for, and it is comparable across routes in a way a
  // dollar figure on a free route is not.
  const bill = recorder === undefined || profile === undefined
    ? undefined
    : summarizeBill(recorder.bill, profile)
  // The budget, read off the engine that acted on it. `lastCompactSpec` is the same
  // value `lastThresholdTokens` reports one field of, so the two cannot disagree.
  const spec = engine!.lastCompactSpec
  const compactBudget: CompactBudget | null = spec === undefined ? null : {
    contextWindow: spec.contextWindow,
    thresholdTokens: spec.thresholdTokens,
    hardCapacityTokens: spec.hardCapacityTokens,
    retainTokens: spec.retainTokens,
    reservedCompletionTokens: spec.contextWindow - spec.hardCapacityTokens,
  }
  return {
    folds,
    roots,
    emergencies,
    foldLineage,
    taskRoot: taskRootState,
    // The raw count, so a report can be reconciled against the provider's own request log rather
    // than trusting a derived figure. Spread rather than set to `undefined`, because
    // `exactOptionalPropertyTypes` distinguishes the two.
    ...(budget === undefined ? {} : { budget: budget.snapshot() }),
    compactBudget,
    derivedAnswersRetired: engine!.derivedAnswersRetired,
    subagentRecall: { ...subagentRecallStats },
    compactionEnabled,
    modelCalls,
    promptTokensLast,
    surfaceNodesLast,
    bundleWrites: engine!.bundleWriteCount,
    bundlesPresent,
    pendingIntents: engine!.pendingRebaseIntentCount,
    compactionFailures,
    compactionFailureKinds,
    lastCompactionError,
    lastLeafDecision: engine!.lastLeafDecision ?? null,
    summarizationAttempts: summaryRetryStats.attempts,
    summarizationRetries: summaryRetryStats.retries,
    summarizationRetryExhausted: summaryRetryStats.exhausted,
    // ## The rationale's own outcome, which nothing recorded before
    //
    // Measured 2026-10-18: a `quality` cell produced a checkpoint whose whole text was the
    // 47-character marker `[EF1 L cp:...]` -- no anchors, no rationale -- while `billedCalls`
    // showed its auxiliary call HAD been made. `summarizationAttempts` stayed 0 because it
    // counts Basic's summarizer, not EF's rationale. So `quality` and `none` were
    // indistinguishable in every artifact we hold.
    rationaleAttempts: engine!.rationaleAttempts,
    rationaleFailures: engine!.rationaleFailures,
    rationaleFailureReason: engine!.rationaleFailureReason ?? null,
    rationaleChars: engine!.rationaleChars,    providerFailures,
    lastProviderError,
    timing: {
      calls: timing.calls,
      callMsTotal: Math.round(timing.callMsTotal),
      callMsMax: Math.round(timing.callMsMax),
      callMsLast: Math.round(timing.lastCallMs),
      turnMsTotal: Math.round(timing.turnMsTotal),
      turnMsMax: Math.round(timing.turnMsMax),
      gapMsTotal: Math.round(timing.gapMsTotal),
      gapMsMax: Math.round(timing.gapMsMax),
      gapMsLast: Math.round(timing.lastGapMs),
      series: timing.series,
    },
    prunerMounted,
    prunerError,
    efToolsOffered: (toolsRuntime()?.schemas() ?? [])
      .some(schema => schema.name.startsWith('context_')),
    pressureRegime: engine!.lastPressureRegime ?? 'none',
    costTotal,
    tokensPrompt: bill?.promptTokens ?? null,
    tokensUncachedInput: bill?.uncachedInputTokens ?? null,
    tokensCacheRead: bill?.cacheReadTokens ?? null,
    tokensOutput: bill?.outputTokens ?? null,
    tokensTotal: bill === undefined ? null : bill.promptTokens + bill.outputTokens,
    billedCalls: bill?.requestCount ?? null,
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
          // The seqs the append created, so a caller can build a fact -> seq map and join it to
          // the fold lineage. Without them `exposure` -- section 7's covariate -- is unreachable.
          const appendedSeqs = appendIncoming(request.message as TauMessage)
          // The host flagged THIS append as the episode's task instruction. Registration
          // happens here -- after the event exists, so its seq and digest are real, and
          // BEFORE any model call, so the very first request already runs under the
          // protection the arm was configured to provide.
          if ((request as { taskRoot?: boolean }).taskRoot === true) {
            await registerTaskRootFromAppend(appendedSeqs)
          }
            // ## Publish the surface size, because this operation does NOT call the model
            //
            // promptTokensLast was set ONLY inside the model-call path, so an append-only bridge
            // reported ZERO on every append. That is exactly what the memory driver is: it ingests
            // the whole corpus before folding, so it read an ingested size of zero, then folded to
            // a surface of zero, then reported "reached the target" -- because zero is less than
            // the target. It measured nothing and said it had succeeded.
            //
            // A false green of precisely the kind that benchmark exists to detect, and it survived
            // because the path had never been executed: the endpoint answered 429 for the whole
            // session in which the driver was written.
            promptTokensLast = ctx!.tokenMeter.measure(session!).totalTokens
            surfaceNodesLast = session!.surface.nodes.length
          emit({ ok: true, seqs: appendedSeqs, telemetry: await telemetry() })
        } else if (op === 'step') {
          // One model call on the current surface, with a fresh turn boundary.
          //
          // `maxTokens` is the caller's REPLY budget for this call. It is optional
          // because the default is right most of the time, and it exists because a
          // reasoning model can spend the whole default on reasoning and answer with
          // nothing — a truncation the caller can only recover from by asking again
          // with more room.
          rotateTurn()
          const assistant = await modelTurn(
            typeof request.maxTokens === 'number' ? request.maxTokens : undefined,
          )
          emit({ ok: true, assistant, telemetry: await telemetry() })
        } else if (op === 'turn') {
          // Append and call, for callers whose protocol delivers exactly one
          // message per exchange (tau2's orchestrator).
          rotateTurn()
          appendIncoming(request.message as TauMessage)
          const assistant = await modelTurn(
            typeof request.maxTokens === 'number' ? request.maxTokens : undefined,
          )
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
        } else if (op === 'compaction') {
          // Turn the automatic fold on or off. See `compactionEnabled`.
          compactionEnabled = request.enabled !== false
          emit({ ok: true, compactionEnabled, telemetry: await telemetry() })
        } else if (op === 'compact') {
          // ## One requested fold, and an honest report of whether it happened
          //
          // This is the independent variable for the memory-pressure task. Natural
          // pressure cannot supply one: the fold count would depend on the corpus,
          // the threshold and the provider, so it would vary per cell and no curve
          // could be drawn (docs/62_MEMORY_PRESSURE_TASK_DESIGN.md section 4). The
          // op turns depth into a number the driver ASKS for.
          //
          // It reports `committed` rather than asserting it. `compactIfNeeded`
          // legitimately declines when nothing qualifies -- there is no pressure, or
          // no safe range -- and a caller that counted its own calls as depth would
          // record a depth the engine never reached. The driver counts commits.
          //
          // The fold itself goes through `foldIfNeeded`, so it inherits the fold
          // deadline, the failure containment and the lineage capture rather than
          // duplicating them.
          const before = foldCounters(engine!)
          // ## Both measurements, at the SAME instant, because they disagreed by 51x
          //
          // Measured 2026-10-17: the host reported 3,330,304 tokens after this op while the engine
          // decided `below-threshold 65192<129024` inside it. Both call
          // `ctx.tokenMeter.measure(session).totalTokens`. Recording them together is the only way
          // to tell a shared-session disagreement from a stale-reference one.
          const hostMeasure = ctx!.tokenMeter.measure(session!).totalTokens
          const hostNodes = session!.surface.nodes.length
          // `engine.ctx` is `protected` on the base Service class, so this reaches through a
          // public accessor instead of a cast. The comparison it exists for is real: it tells
          // a shared-session disagreement from a stale-reference one.
          const engineMeasure = engine!.tokenMeterFor(session!).totalTokens
          const engineNodes = session!.surface.nodes.length
          // ## The turn must be closed around a MANUAL fold, exactly as `rootCompact` does
          //
          // This is the defect that made arms B and C unmeasurable. `compactIfNeeded` opens with
          // `assertNoActiveCompaction(agent.session)` (src/engine.ts:1099), whose contract is an
          // IDLE session, so with the tau2 turn still open every one of the memory driver's 20
          // per-batch folds threw `busy` before it reached the threshold check. The bridge caught
          // each one, counted `compactionFailures`, and classified it `other` because `busy`
          // carries no error code -- so twenty identical faults read as twenty unrelated ones,
          // `folds` stayed at 1, and `lastLeafDecision` kept a stale value from the earlier
          // fold-to-depth. The injected history therefore never folded, grew to 3,330,304 tokens,
          // and the provider answered HTTP 413.
          //
          // The turn is the harness's own bookkeeping for the tau2 exchange, not the session's,
          // so closing it for the duration of a manual command is the accurate thing to do
          // rather than weakening the engine's check. `rootCompact` has done exactly this since
          // it was written; `compact` was the one path that had not.
          // ## A manual fold needs an OPEN turn, and this is the defect that cost arms B and C
          //
          // `lastCompactionError` named it exactly: "compactRegion: no open turn -- automatic
          // compaction events must be enclosed in a turn". The memory driver folds once per probe
          // batch, and by then the tau2 turn had been closed, so all 20 folds threw before they
          // reached the span selection. The bridge caught each, counted `compactionFailures`, and
          // classified it `other` because the message carries no error code -- twenty identical
          // faults read as twenty unrelated ones, `folds` stayed at 1, and the injected history
          // never folded: 3,330,304 tokens to the provider, HTTP 413.
          //
          // The first attempt at this closed the turn instead, on the theory that
          // `assertNoActiveCompaction` was rejecting a busy session. That made it strictly worse
          // (folds 1 -> 0, prompt 3.33M -> 4.35M) because the requirement is the OPPOSITE of the
          // theory. **The error message was in the artifact the whole time; reading it first would
          // have replaced a guess with a fact.**
          const opened = !turnOpen
          if (opened) openTurn()
          await foldIfNeeded()
          if (opened) closeTurn()
          const after = foldCounters(engine!)
          const committed = (after.leaves - before.leaves)
            + (after.roots - before.roots)
            + (after.emergencies - before.emergencies)
          emit({ ok: true, committed, telemetry: await telemetry(),
            measure: { hostMeasure, engineMeasure, hostNodes, engineNodes, compactionEnabled,
              engineSessionSame: (engine as unknown as { ctx?: unknown }).ctx === ctx } })
        } else if (op === 'rootCompact') {
          // FORCE one ROOT fold, so a harness can exercise that path on demand.
          //
          // ## Why the turn is closed and reopened around it
          //
          // `compactNow` is the MANUAL command path: its contract is an idle session, and it
          // throws `busy` while a turn is open (region.ts:205-207). The turn here is the
          // harness's own bookkeeping for the tau2 exchange, not the session's, so closing it
          // for the duration of a manual command is the accurate thing to do rather than
          // weakening the check.
          //
          // The result is reported rather than assumed, for the same reason `compact` does: a
          // root that DECLINES -- no safe range, or a registered task root the span cannot
          // exclude -- must not be counted as depth by the caller.
          const before = foldCounters(engine!)
          const tokensBefore = ctx!.tokenMeter.measure(session!).totalTokens
          closeTurn()
          let refusal: string | undefined
          let result: CompactionResult | null = null
          try {
            const deadline = new AbortController()
            const timer = FOLD_TIMEOUT_MS > 0 ? setTimeout(() => deadline.abort(), FOLD_TIMEOUT_MS) : undefined
            try {
              result = await engine!.compactNow({
                session: session!,
                options: { provider: LIVE_PROVIDER, model: 'live' },
                runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(deadline.signal),
              } as never, deadline.signal)
            } finally {
              if (timer !== undefined) clearTimeout(timer)
            }
          } catch (error) {
            // A refusal is a RESULT here, not a crash: the op exists to drive a fold and report
            // what happened, and `busy`/`summary` from the transaction are outcomes a caller
            // compares.
            // The CAUSE too. The manual path wraps whatever went wrong in a `busy`
            // ManualCompactionError (Basic does the same), so the outer message says only
            // "requires an idle agent" for every failure mode there is.
            const chain: string[] = []
            let node: unknown = error
            while (node instanceof Error && chain.length < 4) {
              chain.push(node.message)
              node = node.cause
            }
            refusal = chain.length === 0 ? String(error) : chain.join(' | caused by: ')
          } finally {
            openTurn()
          }
          const after = foldCounters(engine!)
          const committed = (after.leaves - before.leaves)
            + (after.roots - before.roots)
            + (after.emergencies - before.emergencies)
          // The lineage, recorded by the SAME function the automatic path uses. Without this a
          // committed root was counted but unrecorded: `rootFoldCount` moved while
          // `foldLineage` stayed silent, so exposure -- which joins facts to shadowed SEQS --
          // could not see a root at all, and a reader checking the commit lineage would
          // conclude no root had happened.
          if (committed > 0 && result !== null) recordFoldLineage(before, after, result, tokensBefore)
          emit({
            ok: true,
            committed,
            ...(refusal === undefined ? {} : { refusal }),
            ...(engine!.lastRootRefusal === undefined ? {} : { rootRefusal: engine!.lastRootRefusal }),
            telemetry: await telemetry(),
          })
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
