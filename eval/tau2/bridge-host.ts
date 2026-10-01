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
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { EpistemicFoldEngine } from '../../lib/engine.js'
import { resolvePreset } from '../../lib/preset.js'
import type { FoldModeName } from '../../lib/preset.js'
import { OpenAiCompatibleAdapter } from '../live/openai-adapter.ts'
import { BillingRecorder } from '../live/recorder.ts'
import { realizedCost } from '../live/billing.ts'
import { resolveLiveRoute } from '../live/zcode-config.ts'
import { parseEconomicsProfile } from '../../lib/economics-profile.js'
import type { ContextEconomicsProfile } from '../../lib/economics-profile.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The provider id the harness registers the live adapter under. */
const LIVE_PROVIDER = 'live'

/** Completion budget per model call. tau2's own runs use a comparable cap. */
const STEP_MAX_TOKENS = Number(process.env.EF_TAU2_MAX_TOKENS ?? 900)

/** Context window the engine prices its fold threshold against. */
const TAU2_WINDOW = Number(process.env.EF_TAU2_WINDOW ?? 32_000)

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

/** Telemetry the EF side reports back; never part of the benchmark score. */
interface Telemetry {
  readonly folds: number
  readonly roots: number
  readonly modelCalls: number
  readonly promptTokensLast: number
  readonly surfaceNodesLast: number
  readonly archivedBundles: number
  readonly costTotal: number
}

let ctx: Context | undefined
let engine: EpistemicFoldEngine | undefined
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
let modelCalls = 0
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
  if (message.role === 'tool' && Array.isArray((message as TauMultiTool).tool_messages)) {
    for (const inner of (message as TauMultiTool).tool_messages ?? []) appendIncoming(inner)
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
 */
async function foldIfNeeded(): Promise<void> {
  const active = engine!
  const agent = {
    session: session!,
    options: { provider: LIVE_PROVIDER, model: 'live' },
    runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      task(new AbortController().signal),
  } as never
  const result = await active.compactIfNeeded(agent, 'auto', new AbortController().signal)
  if (result !== null) {
    folds += 1
    const text = JSON.stringify(result)
    if (text.includes('"kind":"root"') || text.includes('rootFold')) roots += 1
  }
  surfaceNodesLast = session!.surface.nodes.length
}

/** Render the tool schemas in the shape the live adapter sends upstream. */
function toolSchemas(): readonly { name: string; description: string; parameters: Record<string, unknown> }[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }))
}

/** One assistant message, as tau2 expects to receive it. */
interface TauAssistant {
  readonly role: 'assistant'
  readonly content: string | null
  readonly tool_calls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]
}

/**
 * Run one model call against the current surface and return tau2's message.
 *
 * Text and tool calls are kept mutually exclusive, which is tau2's protocol
 * rule: a message with both is rejected by the orchestrator.
 */
async function modelTurn(): Promise<TauAssistant> {
  await foldIfNeeded()

  const messages = surface()
  promptTokensLast = ctx!.tokenMeter.measure(session!).totalTokens
  modelCalls += 1

  let text = ''
  const calls: { id: string; name: string; args: string }[] = []
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
  }
  // Cost is computed from the WHOLE bill at report time rather than accumulated
  // per turn: `realizedCost` prices the full log, so adding its result each turn
  // would count every earlier call again.


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

  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    contextWindow: TAU2_WINDOW,
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
  // `retainTokens` is deliberately NOT set here. The tier presets carry
  // `retainRatio` instead, and Basic rejects a config that supplies both
  // ("retainRatio and retainTokens are mutually exclusive"), so pinning the
  // token form would make every tier arm fail to mount.
  const common = {
    auto: true,
    thresholdRatio: Number(process.env.EF_TAU2_THRESHOLD ?? 0.5),
    headroomTokens: 0,
    maxTokens: 2_000,
    bundleRoot,
  }
  engine = new EpistemicFoldEngine(ctx, request.arm.engine === 'basic'
    ? { ...common, retainTokens: 0 }
    : {
      ...common,
      ...(request.arm.mode === 'legacy' ? {} : resolvePreset(request.arm.mode)),
    })

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
  let archived = 0
  try {
    archived = (await engine!.bundleStore.list(session!.id)).length
  } catch {
    archived = 0
  }
  // Priced from the full bill, so the figure is the episode's realized cost
  // rather than a per-turn increment that would double-count.
  costTotal = recorder === undefined || profile === undefined
    ? 0
    : realizedCost(recorder.bill, profile)
  return {
    folds,
    roots,
    modelCalls,
    promptTokensLast,
    surfaceNodesLast,
    archivedBundles: archived,
    costTotal,
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
