#!/usr/bin/env node
/**
 * R34 live entry: real B1 / S / O1 / O2 arms over the frozen v2 dataset.
 *
 *   node eval/r33/live.mjs --check
 *   node eval/r33/live.mjs --self-test [--arms B1,S,O1,O2] [--cases A1,...]
 *   R33_LIVE=1 node eval/r33/live.mjs --run --manifest live-manifest.json
 *
 * `--check` resolves no credentials and makes no request. `--self-test` drives
 * the REAL DSH fold host and the REAL tool loop with a scripted adapter, so the
 * plumbing is verified without spending credits. `--run` refuses unless
 * R33_LIVE=1 AND an explicit manifest supplies positive limits, a per-request
 * output bound, and environment-variable NAMES for the route.
 *
 * ## Where reports go (EF-C1)
 *
 * `--out <dir>` (or `R33_OUT_DIR`) redirects every convenience report. A caller
 * that is not producing evidence — a test, a probe — uses it so the tracked
 * `eval/r33/out/` directory is left alone. A `--run` that the gate refuses is
 * recorded under `R33_RUN_ROOT` and never replaces the latest live report; the
 * convenience copy is written only when `R35_WRITE_LATEST=1` asks for it.
 *
 * ## The arms
 *
 *   B1  real EF off: the model's own compaction summary is the memory
 *   S   real EF active: writer -> validator -> journal -> working set -> fold
 *   O1  oracle deltas through the REAL semantic runtime (same fold, only the
 *       writer's proposal is replaced); labelled conditional when it reuses S's
 *       handoff instead of the frozen one
 *   O2  oracle visible context: the current gold facts, no semantic path
 *
 * ## What is deliberately not claimed
 *
 * The follow-up loop is a CUSTOM text-JSON tool loop, not the production DSH
 * agent loop. Tool results are user text, and `recall` searches the frozen
 * transcript rather than production `context_search`. Reports say so.
 *
 * @module eval/r33/live
 */

import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmRuntime,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import {
  HOLDOUT_ID,
  loadDataset,
  loadDatasetFrom,
  loadHoldoutDataset,
  verifyFrozen,
  verifyHoldout,
} from './src/dataset.mjs'
import { selectCases } from './src/selection.mjs'
import { splitFinishActions } from './src/action-order.mjs'
import { parseActions } from './src/tool-protocol.mjs'
import { analyzeTurn } from '../r37/src/tool-protocol-r37.mjs'
import { analyzeTurnStrict } from '../r37c/src/dsml-codec.mjs'
import {
  BudgetExhausted,
  BudgetLedger,
  STATUS_EXIT_CODE,
  loadLiveGate,
  providerAvailability,
  runQuality,
  runStatus,
  snapshotDelta,
  validateManifest,
} from './src/budget.mjs'
import {
  classifyOutcome,
  emptyFailures,
  outcomeCounts,
  providerFailureKind,
  providerFailureRecord,
} from './src/failures.mjs'
import {
  followUpSystemPrompt,
  fullHistory,
  goldFactsBlock,
  literalSummary,
  scriptedDecision,
  withTask,
} from './src/context.mjs'
import {
  ISOLATION_LEVEL,
  createReplicateLayout,
  listWorkspace,
  materialize,
  readVerification,
  readWorkspaceFile,
  runChecker,
  runVisibleTests,
  workspaceDigest,
  writeWorkspaceFile,
} from './src/workspace.mjs'
import {
  SCORER_VERSION,
  behaviourMetrics,
  extractionMetrics,
  sourceBindings,
} from './src/grade.mjs'

const { SEMANTIC_WRITER_INSTRUCTION_W0, SEMANTIC_WRITER_INSTRUCTION_W1 } =
  await import('../../lib/semantic/writer.js')

const WRITER_PROMPT_INSTRUCTIONS = {
  W0: SEMANTIC_WRITER_INSTRUCTION_W0,
  W1: SEMANTIC_WRITER_INSTRUCTION_W1,
}
const WRITER_PROMPT_VERSIONS = ['W0', 'W1']

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')

/**
 * Where convenience reports go.
 *
 * `eval/r33/out` is a TRACKED directory. Through EF-C0 the tests that spawn
 * this script wrote `live-check.json` and `live-report.json` there, so an
 * ordinary test run rewrote historical evidence. The default is unchanged for
 * the documented commands (they are explicit generators), but a caller that is
 * not producing evidence — a test, a probe — passes `--out <dir>` or sets
 * `R33_OUT_DIR` and leaves the repository alone.
 */
function outputDir() {
  const explicit = argValue('--out') ?? process.env.R33_OUT_DIR
  return explicit === undefined ? OUT : resolve(explicit)
}
const SIGNAL = new AbortController().signal
const ARMS = ['B1', 'S', 'O1', 'O2']
const FIXTURE_ARMS = { FP: 'F-P', FS: 'F-S', FN: 'F-N', FH: 'F-H' }
const ALL_ARMS = [...ARMS, 'F', 'N', 'OR', ...Object.keys(FIXTURE_ARMS)]
let TOOL_PROTOCOL = process.env.R37_TOOL_PROTOCOL ?? 'P3'
let TOOL_PROTOCOL_SOURCE = process.env.R37_TOOL_PROTOCOL === undefined ? 'default' : 'environment'
const FOLLOW_UP_TOOLS = ['read_file', 'write_file', 'list_dir', 'run_tests', 'recall', 'finish']
const STAGES = ['writer-only', 'continuation']
const FOLLOW_UP_MAX_TOKENS = 1024
const MAX_RAW_OUTPUT_CHARS = 512 * 1024

/**
 * The frozen manifest is the authority for the protocol. The environment may
 * select a protocol only when the manifest does not declare one; `loadLiveGate`
 * rejects a conflicting pair before this function is reached.
 */
function applyManifestProtocol(manifest) {
  if (manifest?.toolProtocol !== undefined) {
    TOOL_PROTOCOL = manifest.toolProtocol
    TOOL_PROTOCOL_SOURCE = 'manifest'
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function digestText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function isWriterCall(options) {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && typeof block.text === 'string'
    && block.text.startsWith('You are the SEMANTIC WRITER'))
}

function writerReply(handoff, deltas) {
  return `<handoff>\n${handoff}\n</handoff>\n<deltas>\n${JSON.stringify({ deltas })}\n</deltas>`
}

function estimateInputTokens(options) {
  let chars = (options.system ?? '').length
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'text') chars += block.text.length
      else chars += 64
    }
  }
  return Math.ceil(chars / 4) + 256
}

/** Every writer exchange for one replicate, including the oracle's. */
class WriterLog {
  constructor() {
    this.entries = []
  }

  record(entry) {
    this.entries.push(entry)
  }
}

/** Capture writer text and provider failures without changing the stream. */
class RecordingAdapter extends LlmAdapter {
  constructor(inner, log) {
    super()
    this.inner = inner
    this.log = log
    this.lastUsage = undefined
  }

  resolveModel(provider, model) {
    return this.inner.resolveModel(provider, model)
  }

  async *stream(options) {
    const writer = isWriterCall(options)
    let text = ''
    let usage
    let finish
    let thrown = false
    const started = Date.now()
    this.lastUsage = undefined
    try {
      for await (const chunk of this.inner.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') finish = chunk.reason
        yield chunk
      }
    } catch (error) {
      thrown = true
      // A budget refusal or a transport throw never becomes a finish chunk.
      // Record it here, before rethrowing, or a call the engine safely
      // degrades around would look like it was never attempted.
      this.log.record({
        kind: 'provider-failure',
        writer,
        purpose: options.purpose ?? null,
        code: error !== null && typeof error === 'object' && typeof error.code === 'string'
          ? error.code
          : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      this.lastUsage = usage
      this.log.record({
        kind: 'call',
        writer,
        purpose: options.purpose ?? null,
        success: thrown !== true && finish?.kind !== 'error',
        code: finish?.kind === 'error' ? finish.failure?.code ?? 'unknown' : thrown ? 'thrown' : null,
        maxTokens: options.maxTokens ?? null,
        durationMs: Date.now() - started,
      })
      if (finish?.kind === 'error') {
        this.log.record({
          kind: 'provider-failure',
          writer,
          purpose: options.purpose ?? null,
          code: finish.failure?.code ?? 'unknown',
          message: finish.failure?.message ?? '',
        })
      }
      if (writer) {
        // The full response is retained so the run artifact can prove what the
        // model actually wrote. The report carries a digest and a preview; a
        // trace copy is capped with an explicit truncation flag rather than
        // silently losing the tail.
        this.log.record({
          kind: 'writer-call',
          oracle: false,
          text,
          chars: text.length,
          usage: usage ?? null,
          finish: finish ?? null,
          failed: finish?.kind === 'error',
          maxTokens: options.maxTokens ?? null,
          purpose: options.purpose ?? null,
          durationMs: Date.now() - started,
        })
      }
    }
  }
}

/**
 * Select the frozen writer prompt for a controlled W0/W1 comparison.
 *
 * The production engine always appends the current instruction. This wrapper
 * replaces only that instruction block, and only for the writer call; the
 * conversation, model, route, limits, parser, and validator are untouched. W1
 * is a no-op wrapper, so the production path is byte-identical.
 */
class PromptVariantAdapter extends LlmAdapter {
  constructor(inner, version) {
    super()
    this.inner = inner
    this.version = version
    this.instruction = WRITER_PROMPT_INSTRUCTIONS[version]
  }

  resolveModel(provider, model) {
    return this.inner.resolveModel(provider, model)
  }

  get rateLimitTelemetry() {
    return this.inner.rateLimitTelemetry
  }

  get toolShapeRepairs() {
    return this.inner.toolShapeRepairs
  }

  get toolResultsSynthesised() {
    return this.inner.toolResultsSynthesised
  }

  get toolResultsDropped() {
    return this.inner.toolResultsDropped
  }

  async *stream(options) {
    if (this.version === 'W1') {
      yield* this.inner.stream(options)
      return
    }
    let replaced = false
    const messages = options.messages.map(message => {
      const content = message.content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block
        if (!block.text.startsWith('You are the SEMANTIC WRITER')) return block
        replaced = true
        return { ...block, text: this.instruction }
      })
      return replaced ? { ...message, content } : message
    })
    yield* this.inner.stream(replaced ? { ...options, messages } : options)
  }
}

/** Charge a scripted (non-HTTP) adapter through the same global ledger. */
class MeteredAdapter extends RecordingAdapter {
  constructor(inner, ledger, log) {
    super(inner, log)
    this.ledger = ledger
  }

  async *stream(options) {
    const reservation = this.ledger.reserve({
      inputTokens: estimateInputTokens(options),
      outputTokens: options.maxTokens ?? 1024,
    })
    try {
      yield* super.stream(options)
    } finally {
      this.ledger.recordStream({ usage: this.lastUsage, reservation })
    }
  }
}

/**
 * Replace the WRITER's proposal with the frozen gold, and nothing else.
 *
 * The follow-up agent still calls the real model, and the deltas still traverse
 * the real validator, planner, journal, working-set compiler, and fold. This is
 * a controlled intervention on one input, not a second delivery channel.
 */
class OracleWriterAdapter extends RecordingAdapter {
  constructor(inner, log, payload) {
    super(inner, log)
    this.payload = payload
  }

  async *stream(options) {
    if (!isWriterCall(options)) {
      yield* super.stream(options)
      return
    }
    const text = writerReply(this.payload.handoff, this.payload.deltas)
    this.log.record({
      kind: 'writer-call',
      oracle: true,
      basis: this.payload.basis,
      handoff: this.payload.handoff,
      deltas: this.payload.deltas,
      text,
      chars: text.length,
      usage: null,
      finish: { kind: 'stop' },
      maxTokens: options.maxTokens ?? null,
      purpose: options.purpose ?? null,
      durationMs: 0,
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Drive a fixed plan for --self-test; no network, no credential. */
class SelfTestAdapter extends LlmAdapter {
  constructor(model, caseData, plan, writerPayload) {
    super()
    this.model = model
    this.caseData = caseData
    this.plan = plan
    this.writerPayload = writerPayload
    this.calls = 0
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }

  async *stream(options) {
    let text
    if (isWriterCall(options)) {
      text = writerReply(this.writerPayload.handoff, this.writerPayload.deltas)
    } else if (options.purpose === 'compaction') {
      text = literalSummary(this.caseData.transcript)
    } else {
      this.calls += 1
      const action = this.plan[Math.min(this.calls - 1, this.plan.length - 1)]
      text = JSON.stringify(action)
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * A no-network adapter that CAPTURES the real call envelope.
 *
 * Preflight uses it to run the actual EF fold and record the exact
 * `GenerateOptions.maxTokens` the production path asks for. It must not be
 * mistaken for a measurement: it returns deterministic text, and the report
 * labels the preflight `dry-run`.
 */
class DryRunAdapter extends LlmAdapter {
  constructor(model, caseData, contextWindow) {
    super()
    this.model = model
    this.caseData = caseData
    this.contextWindow = contextWindow
    this.calls = []
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  async *stream(options) {
    const writer = isWriterCall(options)
    this.calls.push({
      writer,
      purpose: options.purpose ?? null,
      maxTokens: options.maxTokens ?? null,
      estimatedInputTokens: estimateInputTokens(options),
      contextWindow: this.contextWindow,
    })
    const text = writer
      ? writerReply(this.caseData.writer.handoff, this.caseData.writer.deltas)
      : `DRY-RUN preflight summary for ${this.caseData.id}; no provider call was made.`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ProviderFailure extends Error {
  constructor(code, message) {
    super(`provider call failed (${code}): ${message}`)
    this.name = 'ProviderFailure'
    this.code = code
  }
}

function lastSeq(session) {
  const events = session.snapshotEvents()
  return Number(events[events.length - 1]?.seq ?? -1)
}

function sessionOf(caseData) {
  const session = Session.create(SessionId(`r34-live-${caseData.id}-${randomUUID()}`))
  let turn = 0
  let step = 0
  let open = false
  const sourceEventSeqs = []
  const openTurn = () => {
    turn += 1
    session.append('turn/start', { turn })
    open = true
    step = 0
  }
  const closeTurn = () => {
    if (!open) return
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    open = false
  }
  for (const [index, entry] of caseData.transcript.entries()) {
    if (entry.role === 'user') {
      closeTurn()
      openTurn()
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      sourceEventSeqs[index] = lastSeq(session)
      continue
    }
    if (!open) openTurn()
    step += 1
    session.append('step/start', { turn, step })
    if (entry.role === 'assistant') {
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: entry.text }],
          source: { kind: 'model', provider: 'r33-frozen', model: 'r33-frozen' },
        }),
      }, { surfaceOp: 'append' })
      sourceEventSeqs[index] = lastSeq(session)
    } else {
      const callId = ToolCallId(`call-${turn}-${step}`)
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking the recorded state.' },
            { type: 'tool-call', id: callId, name: entry.name, arguments: '{}' },
          ],
          source: { kind: 'model', provider: 'r33-frozen', model: 'r33-frozen' },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step, callId, name: entry.name, arguments: '{}' })
      session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: entry.text }],
          isError: entry.isError === true,
        }),
      }, { surfaceOp: 'append' })
      sourceEventSeqs[index] = lastSeq(session)
    }
    session.append('step/end', { turn, step })
  }
  closeTurn()
  openTurn()
  return { session, sourceEventSeqs }
}

function visibleCheckpoint(session) {
  const nodes = [...session.surface.nodes]
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const message = session.deriveEventMessage(session.eventAt(nodes[index]))
    if (message === null || message.role !== 'user') continue
    if (!isCompactCheckpointSource(message.source)) continue
    return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  }
  return ''
}

function foldEvidence(session) {
  const events = session.snapshotEvents()
  const start = [...events].reverse().find(event => event.type === 'compaction/start')
  const summary = [...events].reverse().find(event => event.type === 'compaction/summary')
  const end = [...events].reverse().find(event => event.type === 'compaction/end')
  const replacement = [...events].reverse().find(event => {
    if (event.type !== 'user/message') return false
    const message = session.deriveEventMessage(event)
    return message !== null && isCompactCheckpointSource(message.source)
  })
  return {
    valid: start !== undefined && summary !== undefined && replacement !== undefined,
    startSeq: start === undefined ? undefined : Number(start.seq),
    summarySeq: summary === undefined ? undefined : Number(summary.seq),
    replacementSeq: replacement === undefined ? undefined : Number(replacement.seq),
    endSeq: end === undefined ? undefined : Number(end.seq),
  }
}

async function mountHost(adapter, model, layout, active) {
  const ctx = new Context()
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  ctx.llm.registerAdapter([model], adapter)
  const { default: EpistemicFoldPlugin } = await import('../../lib/plugin.js')
  const { locateFoldFrontier } = await import('../../lib/fold/frontier.js')
  const plugin = new EpistemicFoldPlugin(ctx, {
    auto: false,
    bundleRoot: layout.bundles,
    semanticRoot: layout.journal,
    semanticContinuity: active ? 'active' : 'off',
    semanticMode: 'rationale',
    semanticWorkingSetTokens: 2048,
    semanticCheckpointTokens: 8192,
  })
  return { ctx, plugin, locateFoldFrontier }
}

/** Replay the receipted journal into the state the follow-up could see. */
async function committedState(journalRoot, session) {
  const { FileSemanticJournal } = await import('../../lib/semantic/journal.js')
  const { validateSemanticCommit } = await import('../../lib/semantic/integrity.js')
  const { replayWithSemanticCommits } = await import('../../lib/semantic/replay.js')
  const { visibleAnchors } = await import('../../lib/semantic/plan.js')
  const { canonicalHash } = await import('../../lib/checkpoint/hash.js')
  const journal = new FileSemanticJournal(journalRoot)
  const read = await journal.list(session.id)
  const commits = []
  const validationStatuses = []
  for (const packet of read.packets) {
    if (packet.mode !== 'active') continue
    const receipt = read.receipts.get(packet.packetId)
    if (receipt === undefined) continue
    const validation = validateSemanticCommit({ session, packet, receipt })
    validationStatuses.push({ packetId: packet.packetId, status: validation.status })
    if (validation.status === 'valid') commits.push(validation.commit)
  }
  const replay = replayWithSemanticCommits(session, commits)
  return {
    packets: read.packets.length,
    receipts: read.receipts.size,
    commits: commits.length,
    validationStatuses,
    unplaced: replay.unplaced.length,
    stateDigest: canonicalHash(replay.state),
    anchors: visibleAnchors(replay.state).map(anchor => String(anchor.value)),
  }
}

/** The gold facts as proposals, with explicit supersession where declared. */
function deltaOf(fact, caseData) {
  const quotes = fact.oracleEvidence ?? [fact.quote]
  const groundedInTool = fact.sourceRefs.some(ref => caseData.transcript[ref]?.role === 'tool')
  return {
    kind: fact.kind,
    subjectKey: fact.subjectKey,
    statement: fact.statement,
    status: fact.kind === 'finding' || groundedInTool ? 'observed' : 'claimed',
    evidence: quotes.map(quote => ({ quote })),
    ...(fact.scope === undefined ? {} : { scope: fact.scope }),
  }
}

function oracleDeltas(caseData) {
  const current = caseData.gold.filter(fact => fact.current)
  const superseded = caseData.gold.filter(fact => !fact.current)
  const deltas = []
  for (const old of superseded) {
    const replacement = current.find(fact => fact.supersedesFactId === old.factId)
    if (replacement === undefined) continue
    deltas.push(deltaOf(old, caseData))
    deltas.push({ ...deltaOf(replacement, caseData), supersedes: [old.subjectKey] })
  }
  for (const fact of current) {
    if (!deltas.some(delta => delta.statement === fact.statement)) deltas.push(deltaOf(fact, caseData))
  }
  return deltas
}

async function foldCase(caseData, layout, host, model) {
  const { session, sourceEventSeqs } = sessionOf(caseData)
  const agent = { session, options: { provider: model, model } }
  const frontier = host.locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const started = Date.now()
  let foldRefused
  try {
    await host.plugin.engine.compactRegion(
      nodes[frontier.firstOpenPosition],
      nodes[nodes.length - 1],
      agent,
      SIGNAL,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A summary that is not smaller than the span is a real fold verdict, not
    // a broken harness: the writer answered, but its handoff cannot pay for
    // the span it replaces. Record it and keep the case measurable instead of
    // aborting every remaining case. The raw writer output is still in `log`.
    if (!message.includes('summary is not smaller than the shadowed content')) throw error
    foldRefused = { kind: 'summary-not-smaller', detail: message }
  }
  await host.plugin.engine.reconcileSemantics(session)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: caseData.task }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const foldElapsedMs = Date.now() - started
  // A refused fold leaves no compact checkpoint. Production continues with the
  // uncompressed history, so the follow-up must receive the transcript rather
  // than an empty string; the empty checkpoint would silently remove every
  // historical fact the task depends on.
  const checkpoint = foldRefused === undefined
    ? visibleCheckpoint(session)
    : fullHistory(caseData.transcript)
  const packet = host.plugin.engine.lastSemanticPacket
  return {
    session,
    sourceEventSeqs,
    checkpoint,
    fold: foldEvidence(session),
    foldElapsedMs,
    packet,
    writerObservation: host.plugin.engine.semanticWriterObservation,
    state: await committedState(layout.journal, session),
    ...(foldRefused === undefined ? {} : { foldRefused }),
  }
}

function recall(caseData, query) {
  const needle = String(query ?? '').toLowerCase()
  if (needle.length === 0) return { matches: 0, grounded: false, text: 'recall needs a non-empty query' }
  const goldRefs = new Set(caseData.gold.flatMap(fact => fact.sourceRefs))
  const matches = []
  for (const [index, entry] of caseData.transcript.entries()) {
    if (!entry.text.toLowerCase().includes(needle)) continue
    matches.push({ index, role: entry.role, name: entry.name, text: entry.text.slice(0, 500) })
    if (matches.length >= 3) break
  }
  return {
    matches: matches.length,
    grounded: matches.some(match => goldRefs.has(match.index)),
    text: matches.length === 0
      ? 'no matching history'
      : matches.map(entry => `[${entry.index}] ${entry.role}${entry.name === undefined ? '' : `:${entry.name}`}: ${entry.text}`).join('\n'),
  }
}

async function loadFixtureContext(caseData, arm) {
  const variant = FIXTURE_ARMS[arm]
  if (variant === undefined) return undefined
  const fileName = `${caseData.id}-${variant}`
  const root = process.env.R37_FIXTURE_ROOT ?? join(HERE, '..', 'r37', 'fixtures')
  const path = join(root, fileName, 'fixture.json')
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  const contextText = String(parsed.contextText ?? '')
  if (contextText.length === 0) throw new Error(`fixture ${fileName} has an empty contextText`)
  return {
    fileName,
    variant,
    label: parsed.label ?? null,
    contextText,
    chars: contextText.length,
    digest: digestText(contextText),
    path: `eval/r37/fixtures/${fileName}/fixture.json`,
  }
}

function armContext(arm, caseData, checkpoint, fixtureContext) {
  if (FIXTURE_ARMS[arm] !== undefined) {
    if (typeof fixtureContext !== 'string') {
      throw new Error(`fixture arm ${arm} has no fixture context for ${caseData.id}`)
    }
    return withTask(fixtureContext, caseData.task)
  }
  if (arm === 'O2') return withTask(goldFactsBlock(caseData.gold), caseData.task)
  if (arm === 'F') return withTask(fullHistory(caseData.transcript), caseData.task)
  if (arm === 'OR') return withTask(goldFactsBlock(caseData.gold), caseData.task)
  if (arm === 'N') return caseData.task
  return withTask(checkpoint, caseData.task)
}

function systemPrompt() {
  return [
    followUpSystemPrompt(),
    'The workspace is the current directory. You may use these tools by replying with EXACTLY ONE JSON object per turn:',
    '  {"tool":"read_file","path":"..."}',
    '  {"tool":"write_file","path":"...","content":"..."}',
    '  {"tool":"list_dir"}',
    '  {"tool":"run_tests"}',
    '  {"tool":"recall","query":"..."}',
    '  {"tool":"finish","summary":"..."}',
    '`recall` searches the original pre-compaction history. Use it when the context does not contain what you need.',
    'Do not claim a test was run unless you ran it. Finish only when the task is done.',
  ].join('\n')
}

function parseLiveActions(text) {
  if (TOOL_PROTOCOL === 'P3s') {
    const analysis = analyzeTurnStrict(text, 'model')
    return {
      actions: analysis.actions.map(action => ({ ...action.params, tool: action.tool })),
      invalid: analysis.invalid,
      diagnostics: analysis.diagnostics,
      protocol: 'P3s',
    }
  }
  if (TOOL_PROTOCOL === 'P3e') {
    const analysis = analyzeTurn(text, 'P3e', 'model')
    return {
      actions: analysis.actions.map(action => ({ ...action.params, tool: action.tool })),
      invalid: analysis.invalid,
      diagnostics: analysis.diagnostics,
      protocol: 'P3e',
    }
  }
  return { actions: parseActions(text), invalid: [], diagnostics: [], protocol: 'P3' }
}

export async function followUp({
  adapter,
  model,
  caseData,
  arm,
  checkpoint,
  fixtureContext,
  workspaceRoot,
  maxSteps,
  maxTokens = FOLLOW_UP_MAX_TOKENS,
  finishGuard = false,
  runtime = 'custom-json-loop',
}) {
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: `${armContext(arm, caseData, checkpoint, fixtureContext)}\n\nBEGIN THE TASK.` }],
  }]
  const system = systemPrompt()
  const guardEnabled = finishGuard === true || finishGuard === 'tests-required'
  let toolCalls = 0
  let testsExecuted = 0
  const testRuns = []
  let recallAttempts = 0
  let recallSuccess = 0
  let recallGrounded = 0
  let steps = 0
  let modelCalls = 0
  let finished = false
  let summary = ''
  let lastModification = null
  let lastPassingTest = null
  let validActions = 0
  let invalidActions = 0
  let rejectedActions = 0
  let unknownTools = 0
  let truncatedTurns = 0
  const protocolDiagnostics = []
  const invalidActionDetails = []
  let finishRequests = 0
  let prematureFinishRequests = 0
  let finishRejections = 0
  let guardAssistedFinish = false
  let lastFinishCheck = null
  const finishChecks = []
  const toolCounts = Object.fromEntries(FOLLOW_UP_TOOLS.map(tool => [tool, 0]))
  const finishReasonCounts = {}
  const trace = []
  const finalize = async (extra = {}) => {
    const final = await workspaceDigest(workspaceRoot)
    const verifiedCurrentCode = lastPassingTest !== null && lastPassingTest.digest === final.digest
    const providerFailed = extra.providerFailure !== undefined
    return {
      steps,
      modelCalls,
      toolCalls,
      testsExecuted,
      testRuns,
      recallAttempts,
      recallSuccess,
      recallGrounded,
      finished,
      summary,
      trace,
      requestedMaxTokens: maxTokens,
      harness: {
        version: TOOL_PROTOCOL === 'P3s'
          ? 'H-protocol-s'
          : TOOL_PROTOCOL === 'P3e' ? 'H-protocol-e' : 'H0-custom-json-loop',
        runtime,
        tools: [...FOLLOW_UP_TOOLS],
        maxSteps,
        maxTokens,
        toolProtocol: TOOL_PROTOCOL,
        validActions,
        invalidActions,
        rejectedActions,
        protocolDiagnostics: protocolDiagnostics.slice(0, 50),
        invalidActionDetails: invalidActionDetails.slice(0, 50),
        unknownTools,
        toolCounts: { ...toolCounts },
        finishReasonCounts: { ...finishReasonCounts },
        truncatedTurns,
        stepLimitTermination: !finished && !providerFailed && steps >= maxSteps,
        providerFailure: extra.providerFailure ?? null,
        note: 'Custom text-JSON tool loop, not the production DSH Agent/Tool Runtime.',
      },
      finishGuard: {
        enabled: guardEnabled,
        policy: guardEnabled ? 'reject-finish-without-fresh-passing-test' : 'none',
        requiredTests: caseData.requiresTests === true,
        finishRequests,
        prematureFinishRequests,
        rejections: finishRejections,
        assistedCompletion: guardAssistedFinish,
        lastCheck: lastFinishCheck,
        checks: finishChecks.map(check => ({ ...check })),
        note: guardEnabled
          ? 'The guard rejects a finish request; it never runs a test, edits code, or writes verification.'
          : 'No finish guard was configured.',
      },
      verificationFreshness: {
        currentDigest: final.digest,
        files: final.files,
        lastModification,
        lastPassingTest,
        verifiedCurrentCode,
        sourceDigestAtLastTest: lastPassingTest?.digest ?? null,
        sourceDigestAtFinish: final.digest,
        testRuns: testRuns.map(run => ({ ...run })),
        note: verifiedCurrentCode
          ? 'the last passing visible test ran on the current source digest'
          : lastPassingTest === null
            ? 'no visible test passed; there is no fresh verification'
            : 'the source changed after the last passing test; that run is historical evidence only',
      },
      ...extra,
    }
  }
  const executeAction = async action => {
    toolCalls += 1
    if (action.tool === 'read_file') {
      toolCounts.read_file += 1
      const result = await readWorkspaceFile(workspaceRoot, action.path)
      return result.ok
        ? `TOOL RESULT read_file:\n${result.content ?? ''}`
        : `TOOL RESULT read_file: ${result.reason ?? 'failed'}`
    }
    if (action.tool === 'write_file') {
      toolCounts.write_file += 1
      const result = await writeWorkspaceFile(workspaceRoot, action.path, action.content)
      if (result.ok) {
        const digest = await workspaceDigest(workspaceRoot)
        lastModification = {
          step: steps,
          tool: 'write_file',
          path: String(action.path),
          digest: digest.digest,
        }
      }
      return result.ok
        ? `TOOL RESULT write_file: wrote ${action.path}`
        : `TOOL RESULT write_file: failed: ${result.reason ?? 'unknown error'}`
    }
    if (action.tool === 'list_dir') {
      toolCounts.list_dir += 1
      const listing = await listWorkspace(workspaceRoot)
      return `TOOL RESULT list_dir:\n${listing.text}`
    }
    if (action.tool === 'run_tests') {
      toolCounts.run_tests += 1
      testsExecuted += 1
      const result = await runVisibleTests(workspaceRoot)
      const digest = await workspaceDigest(workspaceRoot)
      if (result.passed) {
        lastPassingTest = {
          step: steps,
          digest: digest.digest,
          exitCode: result.exitCode,
        }
      }
      testRuns.push({
        exitCode: result.exitCode,
        passed: result.passed,
        timedOut: result.timedOut,
        truncated: result.outputTruncated,
        digest: digest.digest,
      })
      return `TOOL RESULT run_tests (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}):\n`
        + `${result.stdout.slice(-8_000)}\n${result.stderr.slice(-2_000)}`
    }
    if (action.tool === 'recall') {
      toolCounts.recall += 1
      recallAttempts += 1
      const result = recall(caseData, action.query)
      if (result.matches > 0) recallSuccess += 1
      if (result.grounded) recallGrounded += 1
      return `TOOL RESULT recall:\n${result.text}`
    }
    unknownTools += 1
    return `TOOL RESULT: unknown tool ${action.tool}`
  }
  for (; steps < maxSteps; steps += 1) {
    let text = ''
    let usage
    let finishReason
    modelCalls += 1
    try {
      for await (const chunk of adapter.stream({
        provider: model,
        model,
        system,
        messages,
        maxTokens,
        signal: SIGNAL,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') finishReason = chunk.reason
      }
    } catch (error) {
      if (error instanceof BudgetExhausted) throw error
      return finalize({
        providerFailure: error instanceof ProviderFailure
          ? { code: error.code, message: error.message }
          : { code: 'unknown', message: error instanceof Error ? error.message : String(error) },
      })
    }
    const finishKind = finishReason?.kind ?? 'none'
    finishReasonCounts[finishKind] = (finishReasonCounts[finishKind] ?? 0) + 1
    if (finishKind === 'max-tokens' || finishKind === 'length') truncatedTurns += 1
    if (finishReason?.kind === 'error') {
      if (finishReason.failure?.code === 'BUDGET_EXHAUSTED') {
        throw new BudgetExhausted(finishReason.failure?.message ?? 'provider refused by the ledger')
      }
      return finalize({
        providerFailure: {
          code: finishReason.failure?.code ?? 'unknown',
          message: finishReason.failure?.message ?? 'provider returned an error finish',
        },
      })
    }
    trace.push({ step: steps, text: text.slice(0, 1000), usage, finishReason })
    const parsedActions = parseLiveActions(text)
    const actions = parsedActions.actions
    rejectedActions += parsedActions.invalid.length
    for (const bad of parsedActions.invalid) {
      invalidActionDetails.push({
        tool: bad.tool,
        reasons: bad.reasons,
        form: bad.form,
      })
    }
    for (const diagnostic of parsedActions.diagnostics) protocolDiagnostics.push(diagnostic)
    const rejection = parsedActions.invalid.length > 0
      ? 'TOOL PROTOCOL REJECTED:\n'
        + parsedActions.invalid.map(bad => `- ${bad.tool}: ${bad.reasons.map(reason => `${reason.reason}: ${reason.detail}`).join('; ')}`).join('\n')
        + '\nReply with a valid action; no rejected action was executed.'
      : 'Reply with one JSON tool object or one DSML invoke block. Use one protocol per turn.'
    if (actions.length === 0) {
      invalidActions += 1
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
      messages.push({ role: 'user', content: [{ type: 'text', text: rejection }] })
      continue
    }
    validActions += actions.length
    messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    if (parsedActions.invalid.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: rejection }] })
    }
    const { nonFinish, finish: finishAction } = splitFinishActions(actions)
    for (const action of nonFinish) {
      const result = await executeAction(action)
      messages.push({ role: 'user', content: [{ type: 'text', text: result }] })
    }
    if (finishAction !== null) {
      finishRequests += 1
      toolCounts.finish += 1
      const current = await workspaceDigest(workspaceRoot)
      const fresh = lastPassingTest !== null && lastPassingTest.digest === current.digest
      lastFinishCheck = {
        step: steps,
        requiresTests: caseData.requiresTests === true,
        testsExecuted,
        lastPassingTest,
        currentDigest: current.digest,
        fresh,
      }
      finishChecks.push(lastFinishCheck)
      // The guard only applies when the task REQUIRES tests and it is enabled.
      // It rejects the request and returns control to the model; it does not
      // run the tests or repair the workspace.
      if (guardEnabled && caseData.requiresTests === true && !fresh) {
        finishRejections += 1
        prematureFinishRequests += 1
        const why = testsExecuted === 0
          ? 'No test run has been recorded.'
          : lastPassingTest === null
            ? 'No test run has passed.'
            : 'The source changed after the last passing test.'
        messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: `FINISH REJECTED: this task requires a fresh passing test run on the current source. ${why} `
              + 'Run the tests and finish only after they pass on the final code.',
          }],
        })
        continue
      }
      finished = true
      summary = String(finishAction.summary ?? '')
      if (finishRejections > 0) guardAssistedFinish = true
      break
    }
  }
  return finalize()
}

function writerSummary(log, packet, observation, arm, state) {
  const writerEntries = log.entries.filter(entry => entry.kind === 'writer-call')
  const providerEntries = log.entries.filter(entry => entry.kind === 'provider-failure')
  if (arm === 'B1' || arm === 'O2' || arm === 'F' || arm === 'N' || arm === 'OR'
    || FIXTURE_ARMS[arm] !== undefined) {
    return {
      applicable: false,
      reason: 'this arm has no semantic writer',
      call: 'not-attempted',
      callStatus: 'not-attempted',
      protocol: 'not-called',
      protocolStatus: 'not-called',
      commitStatus: 'not-applicable',
      providerFailure: null,
      rawOutput: null,
      rawOutputChars: 0,
      rawOutputDigest: null,
      actualProviderUsage: null,
      providerFailures: providerEntries,
    }
  }
  const entry = writerEntries[writerEntries.length - 1]
  const writerProviderFailure = providerEntries.find(candidate => candidate.writer === true) ?? null
  const raw = entry?.text ?? null
  const rawDigest = raw === null ? null : digestText(raw)
  const accepted = packet?.accepted?.length ?? observation?.accepted ?? null
  const refused = packet?.refused?.length ?? observation?.refused ?? null
  const commitStatus = packet === undefined
    ? 'no-packet'
    : packet.deltaParse !== 'parsed'
      ? 'protocol-not-parsed'
      : (accepted ?? 0) > 0 && (state?.commits ?? 0) > 0
        ? 'committed'
        : (accepted ?? 0) > 0
          ? 'accepted-but-not-committed'
          : 'nothing-accepted'
  const refusalReasons = Array.isArray(packet?.refused)
    ? packet.refused.map(refusal => refusal.reason ?? 'unknown')
    : null
  return {
    applicable: true,
    call: observation?.call
      ?? (entry?.failed === true ? 'failed' : entry !== undefined ? 'success' : writerProviderFailure !== null ? 'failed' : 'not-attempted'),
    callStatus: observation?.call
      ?? (entry?.failed === true ? 'failed' : entry !== undefined ? 'success' : writerProviderFailure !== null ? 'failed' : 'not-attempted'),
    protocol: observation?.protocol ?? packet?.deltaParse ?? 'not-called',
    protocolStatus: observation?.protocol ?? packet?.deltaParse ?? 'not-called',
    integrity: observation?.integrity ?? null,
    coverage: observation?.coverage ?? 'not-assessed',
    proposed: packet?.proposed?.length ?? observation?.proposed ?? null,
    proposedDeltas: packet?.proposed ?? null,
    accepted,
    acceptedDeltas: packet?.accepted ?? null,
    refused,
    refusedDeltas: packet?.refused ?? null,
    refusalReasons,
    limitExceeded: observation?.limitExceeded ?? null,
    refusals: observation?.refusals ?? null,
    detail: observation?.detail ?? null,
    handoff: packet?.handoff ?? entry?.handoff ?? null,
    handoffChars: typeof (packet?.handoff ?? entry?.handoff) === 'string'
      ? (packet?.handoff ?? entry?.handoff).length
      : 0,
    rawOutput: raw === null ? null : raw.slice(0, 4_000),
    rawOutputChars: entry?.chars ?? 0,
    rawOutputDigest: rawDigest,
    rawOutputTruncatedInReport: raw !== null && raw.length > 4_000,
    rawOutputStoredInTrace: raw !== null,
    actualProviderUsage: entry?.usage ?? null,
    durationMs: entry?.durationMs ?? null,
    maxTokens: entry?.maxTokens ?? null,
    oracle: entry?.oracle ?? false,
    oracleBasis: entry?.basis ?? null,
    providerFailure: writerProviderFailure,
    commitStatus,
    renderedCheckpointDigest: null, // filled by runOne from the actual checkpoint
    stateDigest: state?.stateDigest ?? null,
    workingSet: packet?.workingSet ?? null,
    providerFailures: providerEntries,
  }
}

function adapterForRun({ base, arm, caseData, ledger, log, o1Handoff }) {
  if (arm === 'O1') {
    const payload = {
      handoff: o1Handoff ?? caseData.writer.handoff,
      deltas: oracleDeltas(caseData),
      basis: o1Handoff === undefined ? 'frozen-dataset' : 's-conditional',
    }
    return new OracleWriterAdapter(base, log, payload)
  }
  return base
}

export function baseAdapter({ live, inner, ledger, log, caseData, plan, writerPayload }) {
  if (live) return new RecordingAdapter(inner, log)
  const scripted = new SelfTestAdapter('r34-self-test', caseData, plan, writerPayload)
  return new MeteredAdapter(scripted, ledger, log)
}

function selfTestPlan(caseData) {
  const correct = scriptedDecision(caseData, goldFactsBlock(caseData.gold))
  const action = caseData.actions[correct.action]
  const readTarget = Object.keys(caseData.workspace.files).find(path => path.startsWith('src/'))
  return [
    { tool: 'list_dir' },
    readTarget === undefined ? { tool: 'list_dir' } : { tool: 'read_file', path: readTarget },
    ...Object.entries(action.files ?? {}).map(([path, content]) => ({ tool: 'write_file', path, content })),
    { tool: 'run_tests' },
    { tool: 'finish', summary: 'self-test complete' },
  ]
}

async function runOne({
  caseData,
  arm,
  stage = 'continuation',
  mode,
  live,
  inner,
  ledger,
  runRoot,
  runId,
  replicateId,
  manifest,
  o1Handoff,
  plan,
  writerPayload,
}) {
  const caseStarted = Date.now()
  const layout = await createReplicateLayout({
    root: runRoot,
    runId,
    caseId: caseData.id,
    arm,
    replicateId,
  })
  // `createReplicateLayout` already created a NEW directory and failed on a
  // collision; materialize only fills it.
  await materialize(caseData.workspace.files, layout.workspace)
  const fixture = await loadFixtureContext(caseData, arm)
  const log = new WriterLog()
  const base = baseAdapter({ live, inner, ledger, log, caseData, plan, writerPayload })
  const adapter = adapterForRun({ base, arm, caseData, ledger, log, o1Handoff })
  const host = fixture === undefined
    ? await mountHost(adapter, manifest.model, layout, arm === 'S' || arm === 'O1')
    : undefined
  const before = ledger.snapshot()
  const folded = fixture === undefined
    ? await foldCase(caseData, layout, host, manifest.model)
    : {
      session: null,
      sourceEventSeqs: [],
      checkpoint: fixture.contextText,
      fold: { valid: true, synthetic: true },
      foldElapsedMs: 0,
      packet: undefined,
      writerObservation: undefined,
      state: {
        packets: 0,
        receipts: 0,
        commits: 0,
        validationStatuses: [],
        unplaced: 0,
        stateDigest: digestText(''),
        anchors: [],
        synthetic: true,
      },
      syntheticFixture: true,
    }
  const writer = writerSummary(log, folded.packet, folded.writerObservation, arm, folded.state)
  if (folded.foldRefused !== undefined) writer.commitStatus = 'fold-refused'
  writer.renderedCheckpointDigest = digestText(folded.checkpoint)
  let follow
  let checker = {
    status: 'not-run',
    checks: [],
    claims: {},
    exitCode: null,
    timedOut: false,
    detail: stage === 'writer-only' ? 'writer-only stage: no follow-up or checker' : 'the fold did not happen',
  }
  let behaviour = stage === 'writer-only'
    ? {
      applicable: false,
      reason: 'writer-only stage: no follow-up agent ran, so no task outcome exists',
      checkerStatus: 'not-run',
      taskSuccess: null,
      functionalSuccess: null,
      historicalConstraintCompliance: null,
      processCompliance: null,
      contractSuccess: null,
      failedChecks: [],
      processViolation: false,
      falseVerificationClaim: false,
    }
    : undefined
  const activeArm = arm === 'S' || arm === 'O1'
  let extraction
  if (activeArm) {
    // Writer-only has a real extraction to score. R34.1 computed this only
    // inside the continuation branch, so every writer-only row reported
    // "this arm commits no semantic deltas" even when it had committed four.
    const protocol = folded.packet?.deltaParse ?? folded.writerObservation?.protocol ?? 'not-called'
    const parsed = protocol === 'parsed'
    extraction = extractionMetrics(caseData, {
      accepted: parsed ? (folded.packet?.accepted ?? []) : undefined,
      refused: parsed ? (folded.packet?.refused ?? []) : undefined,
      writer: folded.writerObservation ?? writer,
      checkpoint: folded.checkpoint,
      anchorValues: folded.state.anchors,
      transcript: caseData.transcript,
    })
    if (!parsed || folded.foldRefused !== undefined) {
      extraction = {
        ...extraction,
        applicable: false,
        reason: folded.foldRefused !== undefined
          ? `fold refused the checkpoint (${folded.foldRefused.kind}); no deltas were committed`
          : `writer protocol ${protocol}; no deltas were accepted`,
      }
    }
  } else {
    extraction = extractionMetrics(caseData, {
      accepted: undefined,
      refused: undefined,
      writer: undefined,
      checkpoint: folded.checkpoint,
      anchorValues: [],
      transcript: caseData.transcript,
    })
  }
  if (fixture !== undefined) {
    extraction = {
      ...extraction,
      applicable: false,
      reason: 'controlled fixture arm: the context is an oracle-facts fixture, not a semantic checkpoint',
    }
  }
  // A refused fold is a compression outcome, not a reason to cancel the task.
  // Production keeps the full history when compaction declines; the follow-up
  // must run in that condition or the B1/O2 baseline silently disappears on
  // small transcripts. The row records the refusal and the fallback.
  const foldFallback = stage === 'continuation' && folded.foldRefused !== undefined
  if ((folded.fold.valid || foldFallback) && stage === 'continuation') {
    follow = await followUp({
      adapter,
      model: manifest.model,
      caseData,
      arm,
      checkpoint: folded.checkpoint,
      fixtureContext: fixture?.contextText,
      workspaceRoot: layout.workspace,
      maxSteps: manifest.followUpSteps ?? 8,
      maxTokens: manifest.followUpMaxTokens ?? FOLLOW_UP_MAX_TOKENS,
      finishGuard: manifest.finishGuard ?? false,
      runtime: manifest.runtime ?? 'custom-json-loop',
    })
    checker = await runChecker(caseData, layout.workspace)
    const verification = await readVerification(layout.workspace)
    behaviour = behaviourMetrics(caseData, {
      checker,
      decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
      verification,
      testsExecuted: follow.testsExecuted,
      verificationFreshness: follow.verificationFreshness,
      finishGuard: follow.finishGuard,
      harness: follow.harness,
    })
  }
  const after = ledger.snapshot()
  const cost = snapshotDelta(before, after)
  cost.caseDurationMs = Date.now() - caseStarted
  cost.runElapsedMs = after.elapsedMs
  // Per-CASE request cost, not the run's cumulative attempt count. R35 wrote
  // `after.used.attempts` here, so one row could report httpAttempts 8 and
  // modelRequests 58 and both were presented as this case's request cost.
  cost.modelRequests = cost.attempts

  // ONE failure record, built from the actual call log and the actual checker
  // state. `valid` is measurement validity, never the task outcome.
  const failures = emptyFailures()
  const seenProvider = new Set()
  const addProvider = (record) => {
    const key = `${record.kind}|${record.code}|${record.stage}|${record.writer}|${record.message}`
    if (seenProvider.has(key)) return
    seenProvider.add(key)
    failures.provider.push(record)
  }
  const callEntries = log.entries.filter(candidate => candidate.kind === 'call')
  const providerCalls = {
    attempted: callEntries.length,
    succeeded: callEntries.filter(entry => entry.success === true).length,
    failed: callEntries.filter(entry => entry.success !== true).length,
  }
  for (const entry of log.entries.filter(candidate => candidate.kind === 'provider-failure')) {
    const record = providerFailureRecord({
      code: entry.code,
      message: entry.message,
      stage: entry.writer ? 'fold-writer' : entry.purpose === 'compaction' ? 'fold' : 'follow-up',
      writer: entry.writer === true,
    })
    if (record.kind === 'budget-exhausted') {
      failures.budget.push({ ...record, message: entry.message })
    } else {
      addProvider(record)
    }
  }
  if (follow?.providerFailure !== undefined) {
    const record = providerFailureRecord({
      code: follow.providerFailure.code,
      message: follow.providerFailure.message,
      stage: 'follow-up',
    })
    if (record.kind === 'budget-exhausted') {
      failures.budget.push({ ...record, message: follow.providerFailure.message })
    } else {
      addProvider(record)
    }
  }
  if (!folded.fold.valid) {
    failures.fold.push(folded.foldRefused === undefined
      ? { kind: 'fold-invalid', detail: 'no complete compaction transaction was observed' }
      : {
        kind: 'fold-refused',
        reason: folded.foldRefused.kind,
        detail: folded.foldRefused.detail,
        ...(foldFallback ? { fallback: 'full-history' } : {}),
      })
  }
  if (checker.status !== 'executed' && checker.status !== 'not-run') {
    failures.checker.push({
      kind: checker.status,
      detail: checker.detail ?? null,
      timedOut: checker.timedOut === true,
    })
  }
  if (behaviour !== undefined && stage === 'continuation'
    && follow?.providerFailure === undefined && checker.status === 'executed') {
    failures.task = {
      assessed: true,
      functionalFailure: behaviour.functionalSuccess === false,
      historicalConstraintViolation: behaviour.constraintViolation === true
        || behaviour.obsoleteRevival === true
        || behaviour.rejectedRetrial === true,
      processViolation: behaviour.processViolation === true,
      falseVerificationClaim: behaviour.falseVerificationClaim === true,
    }
  }
  const valid = stage === 'writer-only'
    ? folded.fold.valid && failures.budget.length === 0
    : (folded.fold.valid || foldFallback)
      && failures.budget.length === 0
      && follow !== undefined
      && follow.providerFailure === undefined
      && checker.status === 'executed'
  const fatalProviderFailure = (stage === 'continuation' && follow?.providerFailure !== undefined)
    || (!folded.fold.valid && !foldFallback && failures.provider.length > 0)
  const outcome = classifyOutcome({
    stage,
    valid,
    foldValid: folded.fold.valid || foldFallback,
    providerFailures: failures.provider,
    fatalProviderFailure,
    budgetExhausted: failures.budget.length > 0,
    checkerStatus: checker.status,
    behaviour,
  })
  failures.outcome = outcome
  const reason = outcome === 'valid-task-success' || outcome === 'valid-task-failure'
    || outcome === 'writer-only-measured'
    ? undefined
    : outcome
  const rawWriterText = log.entries.find(entry => entry.kind === 'writer-call')?.text ?? null
  const row = {
    schemaVersion: 3,
    caseId: caseData.id,
    riskClass: caseData.riskClass,
    family: caseData.counterfactual?.pair ?? caseData.id,
    arm,
    stage,
    mode,
    runId,
    replicateId,
    valid,
    measurementValid: valid,
    ...(reason === undefined ? {} : { reason }),
    failures,
    providerCalls,
    fold: folded.fold,
    ...(foldFallback ? { foldFallback: 'full-history' } : {}),
    foldElapsedMs: folded.foldElapsedMs,
    checkpoint: {
      digest: digestText(folded.checkpoint),
      chars: folded.checkpoint.length,
      text: folded.checkpoint.slice(0, 8_000),
      truncated: folded.checkpoint.length > 8_000,
    },
    ...(fixture === undefined ? {} : {
      fixture: {
        variant: fixture.variant,
        label: fixture.label,
        digest: fixture.digest,
        chars: fixture.chars,
        path: fixture.path,
      },
    }),
    writer,
    state: folded.state,
    sourceBindings: sourceBindings(caseData, folded.sourceEventSeqs),
    extraction,
    behaviour: behaviour ?? {
      applicable: false,
      taskSuccess: null,
      checkerStatus: checker.status,
      failedChecks: [],
      processViolation: false,
    },
    behaviourDetail: follow ?? null,
    checker: {
      status: checker.status,
      exitCode: checker.exitCode ?? null,
      timedOut: checker.timedOut === true,
      checks: checker.checks,
      claims: checker.claims,
      spoofMarkers: checker.spoofMarkers ?? 0,
    },
    cost,
    tracePath: `runs/${runId}/${caseData.id}/${arm}/${replicateId}/trace/record.json`,
  }
  await writeFile(join(layout.trace, 'record.json'), json({
    caseId: caseData.id,
    arm,
    stage,
    mode,
    writerRaw: rawWriterText === null ? null : rawWriterText.slice(0, MAX_RAW_OUTPUT_CHARS),
    writerRawChars: rawWriterText?.length ?? 0,
    writerRawDigest: rawWriterText === null ? null : digestText(rawWriterText),
    writerRawTruncated: rawWriterText !== null && rawWriterText.length > MAX_RAW_OUTPUT_CHARS,
    writer: {
      call: writer.call,
      protocol: writer.protocol,
      handoff: writer.handoff,
      acceptedDeltas: writer.acceptedDeltas,
      refusedDeltas: writer.refusedDeltas,
      refusalReasons: writer.refusalReasons,
      commitStatus: writer.commitStatus,
      stateDigest: writer.stateDigest,
      actualProviderUsage: writer.actualProviderUsage,
    },
    checkpoint: folded.checkpoint,
    ...(fixture === undefined ? {} : {
      fixture: {
        variant: fixture.variant,
        label: fixture.label,
        digest: fixture.digest,
        chars: fixture.chars,
        path: fixture.path,
      },
    }),
    followTrace: follow?.trace ?? [],
    verificationFreshness: follow?.verificationFreshness ?? null,
    checker,
    extraction,
    behaviour: row.behaviour,
    failures,
    state: folded.state,
  }), 'utf8')
  return row
}

async function writeReport(name, report, directory = outputDir()) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, json(report), 'utf8')
  return path
}

/**
 * Persist the AUTHORITATIVE report under the run.
 *
 * R34 wrote only the convenience copy, so a later run silently replaced the
 * record of an earlier one. The run-scoped report is the experiment record.
 *
 * Two EF-C1 changes:
 *
 *  - A run-scoped report is never overwritten. Re-using a runId used to replace
 *    the previous experiment's record with no trace; it now refuses unless
 *    `R33_ALLOW_RERUN=1` is set explicitly.
 *  - The convenience copy is OPT-IN. It used to be written unless
 *    `R35_WRITE_LATEST=0`, which meant a refused or unavailable run replaced
 *    the latest real result by default. A convenience copy is only written
 *    when `R35_WRITE_LATEST=1` asks for it.
 */
async function writeRunReport({ runRoot, runId, report, latestName }) {
  const directory = join(runRoot, runId)
  const reportPath = join(directory, 'report.json')
  if (await pathExists(reportPath) && process.env.R33_ALLOW_RERUN !== '1') {
    throw new Error(
      `run ${runId} already has a report at ${reportPath}; refusing to overwrite it. `
      + 'Set R33_ALLOW_RERUN=1 only when replacing it is intended.',
    )
  }
  await mkdir(directory, { recursive: true })
  await writeFile(reportPath, json(report), 'utf8')
  const latestPath = latestName === undefined || process.env.R35_WRITE_LATEST !== '1'
    ? undefined
    : await writeReport(latestName, report)
  return { reportPath, latestPath }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** What a preflight can prove locally, and what still needs a provider. */
async function buildAvailability() {
  const lib = fileURLToPath(new URL('../../lib/plugin.js', import.meta.url))
  const frontier = fileURLToPath(new URL('../../lib/fold/frontier.js', import.meta.url))
  const adapter = fileURLToPath(new URL('../live/dist/openai-adapter.js', import.meta.url))
  return {
    plugin: await pathExists(lib),
    frontier: await pathExists(frontier),
    liveAdapter: await pathExists(adapter),
    pluginPath: lib,
    frontierPath: frontier,
    liveAdapterPath: adapter,
  }
}

/**
 * R34.1-B: a zero-request budget preflight over the REAL fold call path.
 *
 * It runs each selected case/arm through the real DSH host and EF fold with a
 * `DryRunAdapter`, recording the exact `GenerateOptions.maxTokens` the
 * production writer/rationale path asks for. It reads no route credential and
 * opens no connection.
 *
 * The result names, per case/arm, whether the manifest can actually admit the
 * requests the fold will make. `unknown-model-capability` is not a pass: it
 * says the manifest declares no model output ceiling, so only the provider can
 * confirm the bound.
 */
async function runPreflight({ manifest, manifestPath, cases, arms, stage, runRoot }) {
  const build = await buildAvailability()
  const contextWindow = manifest.route?.contextWindow ?? 131_072
  const runId = manifest.runId ?? newRunId('preflight')
  const runDirectory = join(runRoot, runId)
  const collision = await pathExists(runDirectory)
  const declaredModelMax = manifest.route?.maxOutputTokens
  const followUpSteps = manifest.followUpSteps ?? 8
  const followUpMaxTokens = manifest.followUpMaxTokens ?? FOLLOW_UP_MAX_TOKENS
  const results = []
  const warnings = []

  if (!build.plugin || !build.frontier) {
    return {
      schemaVersion: 1,
      status: 'preflight-invalid',
      generatedAt: new Date().toISOString(),
      manifest: manifestPath,
      build,
      error: 'the built plugin is missing; run `npm run build` before preflight',
      providerRequests: 0,
      routeCredentials: 'not-read',
      runId,
      runIdSource: manifest.runId === undefined ? 'generated' : 'manifest',
      runDirectory,
      collision,
      cases,
      arms,
      stage,
      results,
      warnings,
    }
  }

  const scratch = join(tmpdir(), `r35-preflight-${randomUUID()}`)
  try {
    for (const caseData of cases) {
      for (const arm of arms) {
        const layout = await createReplicateLayout({
          root: scratch,
          runId: 'preflight',
          caseId: caseData.id,
          arm,
          replicateId: 'r1',
        })
        await materialize(caseData.workspace.files, layout.workspace)
        const dry = new DryRunAdapter(manifest.model, caseData, contextWindow)
        const log = new WriterLog()
        const adapter = adapterForRun({ base: dry, arm, caseData, ledger: undefined, log, o1Handoff: undefined })
        const host = await mountHost(adapter, manifest.model, layout, arm === 'S' || arm === 'O1')
        const folded = await foldCase(caseData, layout, host, manifest.model)
        const foldCalls = dry.calls
        const foldMax = foldCalls.reduce((max, call) => Math.max(max, call.maxTokens ?? 0), 0)
        const followUpCalls = stage === 'continuation' ? followUpSteps : 0
        const plannedCalls = foldCalls.length + followUpCalls
        const perRequestBound = Math.max(foldMax, followUpCalls > 0 ? followUpMaxTokens : 0)
        const reasons = []
        if (manifest.maxOutputTokens < perRequestBound) {
          reasons.push({
            axis: 'per-request-output',
            detail: `manifest.maxOutputTokens=${manifest.maxOutputTokens} is below the fold's actual maxTokens=${foldMax}`,
          })
        }
        if (manifest.limits.inputTokens < contextWindow) {
          reasons.push({
            axis: 'input-reserve',
            detail: `limits.inputTokens=${manifest.limits.inputTokens} is below one request's conservative input reserve=${contextWindow}`,
          })
        }
        if (manifest.limits.outputTokens < perRequestBound) {
          reasons.push({
            axis: 'output-reserve',
            detail: `limits.outputTokens=${manifest.limits.outputTokens} is below one request's output bound=${perRequestBound}`,
          })
        }
        if (plannedCalls > manifest.limits.requests) {
          reasons.push({
            axis: 'requests',
            detail: `limits.requests=${manifest.limits.requests} is below the ${plannedCalls} planned calls`,
          })
        }
        const modelCapability = declaredModelMax === undefined
          ? 'unknown-model-capability'
          : declaredModelMax >= perRequestBound
            ? 'declared-compatible'
            : 'declared-incompatible'
        if (modelCapability === 'declared-incompatible') {
          reasons.push({
            axis: 'model-capability',
            detail: `route.maxOutputTokens=${declaredModelMax} is below the fold's actual maxTokens=${foldMax}`,
          })
        }
        const worstCaseOutput = foldCalls.length * foldMax + followUpCalls * followUpMaxTokens
        const retryCovered = manifest.limits.requests >= plannedCalls * 4
        if (manifest.limits.outputTokens < worstCaseOutput) {
          warnings.push({
            caseId: caseData.id,
            arm,
            axis: 'worst-case-output',
            detail: `worst-case output charge ${worstCaseOutput} exceeds limits.outputTokens=${manifest.limits.outputTokens}; known usage can still complete, unknown usage will exhaust`,
          })
        }
        if (!retryCovered) {
          warnings.push({
            caseId: caseData.id,
            arm,
            axis: 'retry-headroom',
            detail: `limits.requests=${manifest.limits.requests} does not cover worst-case 429 retries (${plannedCalls * 4})`,
          })
        }
        const writerEntry = log.entries.find(entry => entry.kind === 'writer-call')
        const dryWriter = foldCalls.some(call => call.writer === true)
        results.push({
          caseId: caseData.id,
          arm,
          verdict: reasons.length > 0
            ? 'infeasible'
            : modelCapability === 'unknown-model-capability'
              ? 'unknown-model-capability'
              : 'feasible',
          reasons,
          foldValid: folded.fold.valid,
          foldCalls: foldCalls.length,
          foldCallsDetail: foldCalls,
          followUpMaxRequests: followUpCalls,
          plannedRequests: plannedCalls,
          requestsWithWorstCaseRetries: plannedCalls * 4,
          perRequestOutputBound: perRequestBound,
          actualFoldMaxTokens: foldMax,
          inputReservePerRequest: contextWindow,
          worstCaseInputCharge: plannedCalls * contextWindow,
          worstCaseOutputCharge: worstCaseOutput,
          modelCapability,
          declaredModelMaxOutputTokens: declaredModelMax ?? null,
          writerCallStatus: writerEntry?.oracle === true
            ? 'oracle-conditional (no provider call)'
            : writerEntry !== undefined || dryWriter
              ? 'dry-run response'
              : 'not-attempted',
          providerCalls: foldCalls.length,
          writerProtocol: folded.packet?.deltaParse ?? 'not-called',
          checkpointChars: folded.checkpoint.length,
          stateDigest: folded.state.stateDigest,
        })
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  const infeasible = results.filter(entry => entry.verdict === 'infeasible')
  const unknownCapability = results.filter(entry => entry.verdict === 'unknown-model-capability')
  const totalPlannedRequests = results.reduce((total, entry) => total + entry.plannedRequests, 0)
  const totalWorstCaseRequests = results.reduce((total, entry) => total + entry.requestsWithWorstCaseRetries, 0)
  const totalWorstCaseInput = results.reduce((total, entry) => total + entry.worstCaseInputCharge, 0)
  const totalWorstCaseOutput = results.reduce((total, entry) => total + entry.worstCaseOutputCharge, 0)
  const blocking = []
  if (collision) {
    blocking.push({
      axis: 'run-directory',
      detail: `the run directory already exists: ${runDirectory}; a run is never resumed by reusing its directory`,
    })
  }
  if (totalPlannedRequests > manifest.limits.requests) {
    blocking.push({
      axis: 'total-requests',
      detail: `the selected plan needs ${totalPlannedRequests} calls but limits.requests=${manifest.limits.requests}`,
    })
  }
  if (blocking.length === 0) {
    if (totalWorstCaseInput > manifest.limits.inputTokens) {
      warnings.push({
        axis: 'total-worst-case-input',
        detail: `worst-case input charge ${totalWorstCaseInput} exceeds limits.inputTokens=${manifest.limits.inputTokens}; known usage can still complete`,
      })
    }
    if (totalWorstCaseOutput > manifest.limits.outputTokens) {
      warnings.push({
        axis: 'total-worst-case-output',
        detail: `worst-case output charge ${totalWorstCaseOutput} exceeds limits.outputTokens=${manifest.limits.outputTokens}; known usage can still complete`,
      })
    }
    if (totalWorstCaseRequests > manifest.limits.requests) {
      warnings.push({
        axis: 'retry-headroom',
        detail: `limits.requests=${manifest.limits.requests} does not cover worst-case 429 retries (${totalWorstCaseRequests})`,
      })
    }
  }
  const status = infeasible.length > 0 || blocking.length > 0 ? 'preflight-infeasible' : 'preflight-ok'
  return {
    schemaVersion: 1,
    status,
    generatedAt: new Date().toISOString(),
    manifest: manifestPath,
    manifestModel: manifest.model,
    manifestMaxOutputTokens: manifest.maxOutputTokens,
    limits: manifest.limits,
    stage,
    runId,
    runIdSource: manifest.runId === undefined ? 'generated' : 'manifest',
    runDirectory,
    collision,
    dataset: {
      id: 'r33-semantic-continuity-v2',
      digest: (await loadDataset()).datasetDigest,
      cases: cases.length,
      scorerVersion: SCORER_VERSION,
    },
    cases: cases.map(entry => entry.id),
    arms,
    build,
    providerRequests: 0,
    routeCredentials: 'not-read',
    isolation: ISOLATION_LEVEL,
    results,
    blocking,
    summary: {
      feasible: results.filter(entry => entry.verdict === 'feasible').length,
      infeasible: infeasible.length,
      unknownModelCapability: unknownCapability.length,
      blocking: blocking.length,
      warnings: warnings.length,
      totalPlannedRequests,
      totalWorstCaseRequests,
      totalWorstCaseInputCharge: totalWorstCaseInput,
      totalWorstCaseOutputCharge: totalWorstCaseOutput,
    },
    warnings,
    unverified: [
      ...(unknownCapability.length > 0
        ? ['model output capability and context window (no provider request was made)']
        : []),
      'provider latency, availability, and billing',
    ],
    note: 'Dry-run: the real DSH fold and EF writer/rationale paths ran with a local adapter. No provider request was made, no credential value was read, and no result here is a model measurement.',
  }
}

function selectArms(requested, stage = 'continuation') {
  if (requested === undefined || requested.length === 0) {
    return stage === 'writer-only' ? ['S', 'O1'] : [...ARMS]
  }
  const arms = String(requested).split(',').map(arm => arm.trim()).filter(Boolean)
  for (const arm of arms) {
    if (!ALL_ARMS.includes(arm)) throw new Error(`unknown arm ${arm}; expected one of ${ALL_ARMS.join(', ')}`)
  }
  return arms
}

function selectStage(requested) {
  const stage = requested ?? 'continuation'
  if (!STAGES.includes(stage)) {
    throw new Error(`unknown stage ${stage}; expected one of ${STAGES.join(', ')}`)
  }
  return stage
}

function newRunId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)
  return `${prefix}-${stamp}-${randomUUID().slice(0, 8)}`
}

async function runScriptedSelfTest(cases, arms, stage = 'continuation') {
  const runId = newRunId('self-test')
  const runRoot = join(OUT, 'self-test-runs')
  const ledger = new BudgetLedger(
    { requests: 100_000, inputTokens: 1_000_000_000, outputTokens: 100_000_000, wallClockMs: 3_600_000 },
    { maxRequestOutputTokens: 100_000 },
  )
  const rows = []
  for (const caseData of cases) {
    let sHandoff
    for (const arm of arms) {
      const writerPayload = arm === 'S'
        ? { handoff: caseData.writer.handoff, deltas: caseData.writer.deltas }
        : { handoff: caseData.writer.handoff, deltas: [] }
      const row = await runOne({
        caseData,
        arm,
        stage,
        mode: 'self-test',
        live: false,
        inner: undefined,
        ledger,
        runRoot,
        runId,
        replicateId: 'r1',
        manifest: { model: 'r34-self-test', followUpSteps: 12, stage },
        // When S ran first, O1 reuses S's handoff: the controlled intervention
        // replaces only the deltas, and the report labels the basis.
        o1Handoff: arm === 'O1' ? sHandoff : undefined,
        plan: selfTestPlan(caseData),
        writerPayload,
      })
      rows.push(row)
      if (arm === 'S' && typeof row.writer?.handoff === 'string') sHandoff = row.writer.handoff
    }
  }
  const quality = runQuality(rows, stage)
  const status = runStatus({ executed: true, cases: rows, invalid: rows.length === 0, stage })
  return {
    schemaVersion: 3,
    status,
    stage,
    executionKind: stage === 'writer-only'
      ? 'writer-only self-test (scripted adapter; verifies the fold/writer/commit chain, not model behavior)'
      : 'self-test (scripted adapter; verifies plumbing, not model behavior)',
    generatedAt: new Date().toISOString(),
    runId,
    dataset: {
      id: 'r33-semantic-continuity-v2',
      digest: (await loadDataset()).datasetDigest,
      cases: cases.length,
      scorerVersion: SCORER_VERSION,
    },
    arms,
    quality,
    outcomes: outcomeCounts(rows),
    ledger: ledger.snapshot(),
    runElapsedMs: ledger.snapshot().elapsedMs,
    rows,
    notes: [
      'No provider request was made.',
      stage === 'writer-only'
        ? 'Writer-only: the fold, writer, validator, journal, working set, and checkpoint ran; no agent tool loop ran.'
        : 'The follow-up loop is the custom evaluation harness loop, not the production DSH agent loop.',
      'The hidden checkers are real, and the folds are real DSH compaction transactions.',
    ],
  }
}

async function runtimeFromManifest(manifest, ledger) {
  const route = manifest.route ?? {}
  const baseUrl = route.baseUrlEnv === undefined ? undefined : process.env[route.baseUrlEnv]
  const apiKey = route.apiKeyEnv === undefined ? undefined : process.env[route.apiKeyEnv]
  if (baseUrl === undefined || baseUrl.length === 0 || apiKey === undefined || apiKey.length === 0) {
    return { unavailable: 'route environment variables are not set; refusing to guess a credential' }
  }
  const built = new URL('../live/dist/openai-adapter.js', import.meta.url)
  try {
    await access(built)
  } catch {
    return {
      unavailable: 'the eval TypeScript adapter is not built; run `npm run eval:build` first '
        + '(plain Node cannot execute the adapter\'s non-erasable TypeScript)',
    }
  }
  const { OpenAiCompatibleAdapter } = await import('../live/dist/openai-adapter.js')
  const base = new OpenAiCompatibleAdapter({
    baseUrl,
    apiKey,
    model: manifest.model,
    contextWindow: manifest.route?.contextWindow ?? 131_072,
    ...(route.headers === undefined ? {} : { headers: route.headers }),
    // The global ledger IS the adapter's budget. `admit` runs immediately
    // before every HTTP attempt, including a 429 resend.
    budget: ledger,
  })
  const promptVersion = manifest.writerPromptVersion ?? 'W1'
  const inner = promptVersion === 'W1' ? base : new PromptVariantAdapter(base, promptVersion)
  return { inner }
}

function reportEnvelope({ status, executionKind, stage, manifest, arms, runId, rows, ledger, inner, dataset, notes }) {
  const quality = runQuality(rows, stage)
  const snapshot = ledger.snapshot()
  return {
    schemaVersion: 3,
    status,
    stage,
    executionKind,
    generatedAt: new Date().toISOString(),
    runId,
    dataset,
    model: manifest.model,
    modelParameters: {
      temperature: manifest.temperature ?? null,
      maxOutputTokens: manifest.maxOutputTokens,
      followUpMaxTokens: manifest.followUpMaxTokens ?? FOLLOW_UP_MAX_TOKENS,
      followUpSteps: manifest.followUpSteps ?? 8,
      finishGuard: manifest.finishGuard ?? false,
      runtime: manifest.runtime ?? 'custom-json-loop',
      harnessVersion: manifest.harnessVersion ?? 'H0-custom-json-loop',
      toolProtocol: TOOL_PROTOCOL,
      toolProtocolSource: TOOL_PROTOCOL_SOURCE,
      writerPromptVersion: manifest.writerPromptVersion ?? 'W1',
      writerPromptDigest: digestText(
        WRITER_PROMPT_INSTRUCTIONS[manifest.writerPromptVersion ?? 'W1'] ?? SEMANTIC_WRITER_INSTRUCTION_W1,
      ),
      contextWindow: manifest.route?.contextWindow ?? 131_072,
      reasoningSettings: manifest.reasoning ?? null,
    },
    route: {
      baseUrlEnv: manifest.route?.baseUrlEnv ?? null,
      apiKeyEnv: manifest.route?.apiKeyEnv ?? null,
      headerNames: Object.keys(manifest.route?.headers ?? {}),
      contextWindow: manifest.route?.contextWindow ?? 131_072,
      maxOutputTokens: manifest.route?.maxOutputTokens ?? null,
    },
    limits: manifest.limits,
    maxOutputTokens: manifest.maxOutputTokens,
    arms,
    isolation: ISOLATION_LEVEL,
    quality,
    outcomes: outcomeCounts(rows),
    ledger: snapshot,
    runElapsedMs: snapshot.elapsedMs,
    retryAccounting: retryAccounting(inner, snapshot),
    provider: liveProvider(inner),
    rows,
    notes,
  }
}

/**
 * Reconcile the adapter's own 429 counter with the ledger's, without adding
 * one to the other.
 *
 * The ledger is the authority: its `retry()` runs inside the adapter at the
 * moment a throttled attempt is abandoned, so it counts every retry exactly
 * once. The adapter counter is a cross-check. R34 added the adapter's count to
 * the ledger AGAIN at the end of the run, which turned two retries into four.
 */
function retryAccounting(inner, snapshot) {
  if (inner === undefined) {
    return { authority: 'ledger', adapter: null, ledgerRetries: snapshot.used.retries, consistent: null }
  }
  const telemetry = typeof inner.rateLimitTelemetry === 'object'
    ? inner.rateLimitTelemetry
    : { retries: 0, exhausted: 0 }
  const adapterExpected = (telemetry.retries ?? 0) + (telemetry.exhausted ?? 0)
  return {
    authority: 'ledger',
    adapter: {
      retries: telemetry.retries ?? 0,
      exhausted: telemetry.exhausted ?? 0,
      expectedLedgerRetries: adapterExpected,
    },
    ledgerRetries: snapshot.used.retries,
    consistent: snapshot.used.retries === adapterExpected,
    note: 'The ledger counts each throttled HTTP attempt once. The adapter counter is a cross-check only; it is never added to the ledger.',
  }
}

function liveProvider(inner) {
  if (inner === undefined) return null
  const telemetry = typeof inner.rateLimitTelemetry === 'object'
    ? inner.rateLimitTelemetry
    : { retries: 0, exhausted: 0 }
  return {
    adapter: 'openai-compatible',
    rateLimitRetries: telemetry.retries ?? 0,
    rateLimitExhausted: telemetry.exhausted ?? 0,
    toolShapeRepairs: inner.toolShapeRepairs ?? 0,
    toolResultsSynthesised: inner.toolResultsSynthesised ?? 0,
    toolResultsDropped: inner.toolResultsDropped ?? 0,
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check')
  const selfTest = process.argv.includes('--self-test')
  const preflight = process.argv.includes('--preflight')
  const externalCasesRoot = process.env.R37_CASES_ROOT
  const frozen = externalCasesRoot === undefined
    ? await verifyFrozen()
    : { ok: true, manifest: { datasetId: 'r37-b-cases' } }
  if (!frozen.ok) {
    process.stderr.write(`invalid benchmark: ${frozen.reason}\n`)
    process.exit(STATUS_EXIT_CODE['invalid-benchmark'])
  }
  let loaded
  try {
    loaded = externalCasesRoot === undefined
      ? await loadDataset()
      : await loadDatasetFrom(externalCasesRoot, 'r37-b-cases')
  } catch (error) {
    process.stderr.write(`invalid benchmark: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(STATUS_EXIT_CODE['invalid-benchmark'])
  }
  const { cases, errors, datasetDigest } = loaded
  if (errors.length > 0) {
    process.stderr.write(`invalid benchmark: ${json(errors)}\n`)
    process.exit(STATUS_EXIT_CODE['invalid-benchmark'])
  }
  const dataset = {
    id: frozen.manifest.datasetId,
    digest: datasetDigest,
    cases: cases.length,
    scorerVersion: SCORER_VERSION,
  }
  const runRoot = process.env.R33_RUN_ROOT ?? join(homedir(), '.r33-runs')

  if (checkOnly) {
    const holdoutFrozen = await verifyHoldout()
    const holdout = await loadHoldoutDataset()
    const audience = {
      status: 'interface-ok',
      dataset,
      holdout: {
        id: HOLDOUT_ID,
        verified: holdoutFrozen.ok,
        digest: holdout.datasetDigest,
        cases: holdout.cases.map(entry => entry.id),
        executed: false,
        note: 'frozen for a future blind run; no model has seen it',
      },
      caseIds: cases.map(entry => entry.id),
      arms: ARMS,
      allArms: ALL_ARMS,
      stages: STAGES,
      defaultArms: {
        'writer-only': ['S', 'O1'],
        continuation: ARMS,
      },
      followUpTools: FOLLOW_UP_TOOLS,
      isolation: ISOLATION_LEVEL,
      executionKinds: {
        scripted: 'self-test / offline pipeline measurement',
        writerOnly: 'live writer-only: real EF fold + writer + validator + journal + working set + checkpoint, no follow-up',
        customToolLoop: 'live custom text-JSON loop (not the production DSH agent loop)',
        productionLoop: 'not implemented in this round; live is blocked without authorization',
      },
      runRequires: [
        'R33_LIVE=1',
        '--manifest with positive requests/inputTokens/outputTokens/wallClockMs',
        'manifest.maxOutputTokens (per-request bound)',
        'manifest.route.baseUrlEnv and manifest.route.apiKeyEnv (names, not secrets)',
        'manifest.stage = writer-only | continuation (optional; default continuation)',
      ],
      preflight: {
        command: 'node eval/r33/live.mjs --preflight --manifest <path>',
        requiresProvider: false,
        note: 'Runs the real fold with a dry-run adapter and records actual maxTokens; reads no credential and makes no request.',
      },
      note: '--check resolves no credentials and makes no request.',
    }
    const path = await writeReport('live-check.json', audience)
    process.stdout.write(`${JSON.stringify(audience, null, 2)}\n${path}\n`)
    process.exit(0)
  }

  if (preflight) {
    const manifestPath = argValue('--manifest')
    const invalid = async (reason) => {
      const report = {
        schemaVersion: 1,
        status: 'preflight-invalid',
        reason,
        manifest: manifestPath ?? null,
        dataset,
        generatedAt: new Date().toISOString(),
        providerRequests: 0,
        routeCredentials: 'not-read',
        note: 'No provider request was attempted.',
      }
      const path = await writeReport('preflight-report.json', report)
      process.stdout.write(`${report.status}: ${reason}\n${path}\n`)
      process.exit(6)
    }
    if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
      await invalid('no --manifest path was provided')
    }
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      await invalid(`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const validated = validateManifest(manifest)
    if (!validated.ok) await invalid(validated.reason)
    if (manifest.toolProtocol !== undefined
      && process.env.R37_TOOL_PROTOCOL !== undefined
      && manifest.toolProtocol !== process.env.R37_TOOL_PROTOCOL) {
      await invalid(`protocol-manifest-mismatch: manifest declares ${manifest.toolProtocol}, `
        + `runtime environment requests ${process.env.R37_TOOL_PROTOCOL}`)
    }
    applyManifestProtocol(manifest)
    const stage = selectStage(argValue('--stage') ?? manifest.stage)
    const selected = selectCases(cases, argValue('--cases') ?? manifest.cases)
    const arms = selectArms(argValue('--arms') ?? manifest.arms, stage)
    const report = await runPreflight({
      manifest,
      manifestPath,
      cases: selected,
      arms,
      stage,
      runRoot,
    })
    const path = await writeReport('preflight-report.json', report)
    process.stdout.write(`${report.status}: ${report.summary.feasible} feasible, `
      + `${report.summary.infeasible} infeasible, ${report.summary.unknownModelCapability} unknown-capability, `
      + `${report.summary.blocking} blocking\n${path}\n`)
    process.exit(report.status === 'preflight-ok' ? 0 : 2)
  }

  if (selfTest) {
    const stage = selectStage(argValue('--stage'))
    const selected = selectCases(cases, argValue('--cases'))
    const arms = selectArms(argValue('--arms'), stage)
    const report = await runScriptedSelfTest(selected, arms, stage)
    const path = await writeReport('self-test-report.json', report)
    const writer = report.quality.writerMeasurements
    const summary = stage === 'writer-only'
      ? `${writer.callSucceeded}/${writer.realWriterRows} scripted writer call(s) completed; `
        + `${writer.oracleControls} oracle control(s); ${report.quality.validCases}/${report.rows.length} fold measurement(s) valid`
      : `${report.quality.taskSuccesses}/${report.quality.validCases} valid cases passed`
    process.stdout.write(`${report.status}: ${summary}\n${path}\n`)
    process.exit(STATUS_EXIT_CODE[report.status] ?? 7)
  }

  const gate = await loadLiveGate(argValue('--manifest'), process.env)
  if (!gate.ok) {
    const report = {
      schemaVersion: 3,
      status: 'not-executed',
      reason: gate.reason,
      dataset,
      cases: cases.length,
      stage: argValue('--stage') ?? 'continuation',
      generatedAt: new Date().toISOString(),
      providerRequests: 0,
      note: 'No provider request was attempted.',
    }
    // A refusal is not an experiment. It gets its own run-scoped record and
    // NEVER replaces the latest live report: before EF-C1 this path wrote
    // `out/live-report.json` unconditionally, so running the gate test erased
    // the record of the last real run.
    const refusalId = newRunId('refused')
    const paths = await writeRunReport({ runRoot, runId: refusalId, report })
    process.stdout.write(`${report.status}: ${report.reason}\n${paths.reportPath}\n`)
    process.exit(STATUS_EXIT_CODE['not-executed'])
  }
  const manifest = gate.manifest
  applyManifestProtocol(manifest)
  const stage = selectStage(argValue('--stage') ?? manifest.stage)
  const selected = selectCases(cases, argValue('--cases') ?? manifest.cases)
  const arms = selectArms(argValue('--arms') ?? manifest.arms, stage)
  const runId = manifest.runId ?? newRunId('live')
  if (manifest.runtime === 'dsh-agent') {
    const report = {
      schemaVersion: 3,
      status: 'not-executed',
      reason: 'H-native requested the real DSH Agent/Tool Runtime, which this custom evaluation harness '
        + 'does not implement. No provider request was attempted and no result is claimed.',
      dataset,
      stage,
      runId,
      generatedAt: new Date().toISOString(),
      providerRequests: 0,
      harness: {
        requestedRuntime: 'dsh-agent',
        implementedRuntime: 'custom-json-loop',
        condition: 'H-native',
        status: 'blocked',
      },
      note: 'H-native is a declared calibration condition, not an executed measurement.',
    }
    const paths = await writeRunReport({ runRoot, runId, report, latestName: 'live-report.json' })
    process.stdout.write(`${report.status}: ${report.reason}\n${paths.reportPath}\n`)
    process.exit(STATUS_EXIT_CODE['not-executed'])
  }
  const ledger = new BudgetLedger(manifest.limits, { maxRequestOutputTokens: manifest.maxOutputTokens })
  const runtime = await runtimeFromManifest(manifest, ledger)
  if (runtime.unavailable !== undefined) {
    const report = {
      schemaVersion: 3,
      status: 'provider-unavailable',
      reason: runtime.unavailable,
      dataset,
      stage,
      runId,
      generatedAt: new Date().toISOString(),
      providerRequests: 0,
      note: 'No provider request was attempted.',
    }
    const paths = await writeRunReport({ runRoot, runId, report, latestName: 'live-report.json' })
    process.stdout.write(`${report.status}: ${report.reason}\n${paths.reportPath}\n`)
    process.exit(STATUS_EXIT_CODE['provider-unavailable'])
  }

  const runStarted = Date.now()
  const rows = []
  let budgetExhausted = false
  let stopReason = null
  let harnessError = null
  try {
    for (const caseData of selected) {
      const handoffs = new Map()
      for (const arm of arms) {
        if (budgetExhausted) break
        const beforeCase = ledger.snapshot()
        const caseStarted = Date.now()
        try {
          const row = await runOne({
            caseData,
            arm,
            stage,
            mode: 'live',
            live: true,
            inner: runtime.inner,
            ledger,
            runRoot,
            runId,
            replicateId: manifest.replicateId ?? 'r1',
            manifest,
            o1Handoff: arm === 'O1' ? handoffs.get('S') : undefined,
            plan: undefined,
            writerPayload: { handoff: caseData.writer.handoff, deltas: caseData.writer.deltas },
          })
          if (arm === 'S' && row.writer?.handoff !== null) handoffs.set('S', row.writer.handoff)
          rows.push(row)
          if (row.failures?.budget?.length > 0 || row.cost?.budgetRefusals > 0) {
            budgetExhausted = true
            stopReason = row.failures?.budget?.[0]?.message ?? 'budget refusal observed inside a safely degraded call'
            break
          }
        } catch (error) {
          // The case boundary keeps the truth even when the case threw. R34
          // wrote zero cost here, hiding requests that had already happened.
          const afterCase = ledger.snapshot()
          const cost = snapshotDelta(beforeCase, afterCase)
          cost.caseDurationMs = Date.now() - caseStarted
          cost.runElapsedMs = afterCase.elapsedMs
          cost.modelRequests = cost.attempts
          const failures = emptyFailures()
          let outcome
          if (error instanceof BudgetExhausted) {
            budgetExhausted = true
            failures.budget.push({
              kind: 'budget-exhausted',
              reason: error.reason ?? 'unknown',
              message: error.message,
            })
            outcome = 'budget-exhausted'
            stopReason = `budget-exhausted: ${error.reason ?? error.message}`
          } else {
            const code = error instanceof ProviderFailure
              ? error.code
              : typeof error === 'object' && error !== null && typeof error.code === 'string'
                ? error.code
                : 'harness-error'
            const kind = code === 'harness-error' ? 'harness-error' : providerFailureKind(code)
            if (kind === 'budget-exhausted') {
              budgetExhausted = true
              failures.budget.push({ kind: 'budget-exhausted', message: String(error?.message ?? error) })
              outcome = 'budget-exhausted'
              stopReason = `budget-exhausted: ${String(error?.message ?? error)}`
            } else if (kind.startsWith('provider-')) {
              failures.provider.push(providerFailureRecord({
                code,
                message: error instanceof Error ? error.message : String(error),
                stage: 'case-boundary',
              }))
              outcome = kind
            } else {
              failures.harness.push({
                kind: 'harness-error',
                message: error instanceof Error ? error.stack ?? error.message : String(error),
              })
              outcome = 'harness-error'
            }
          }
          failures.outcome = outcome
          rows.push({
            schemaVersion: 3,
            caseId: caseData.id,
            arm,
            stage,
            mode: 'live',
            runId,
            replicateId: manifest.replicateId ?? 'r1',
            valid: false,
            measurementValid: false,
            reason: outcome,
            failures,
            providerCalls: {
              attempted: cost.httpAttempts,
              succeeded: null,
              failed: null,
            },
            behaviour: {
              applicable: false,
              taskSuccess: null,
              functionalSuccess: null,
              contractSuccess: null,
              processViolation: false,
              falseVerificationClaim: false,
            },
            cost,
          })
          if (budgetExhausted) break
          if (outcome === 'harness-error') {
            harnessError = failures.harness[0]?.message ?? 'harness error'
            stopReason = harnessError
            break
          }
        }
      }
      if (budgetExhausted || harnessError !== null) break
    }
  } catch (error) {
    harnessError = error instanceof Error ? error.stack ?? error.message : String(error)
    stopReason = harnessError
  }
  const validRows = rows.filter(row => row.valid === true)
  // Oracle controls answer from the frozen dataset without a provider call.
  // They are measurements, but counting them as route health is exactly how a
  // run whose every real writer call returned 401 was reported as a success.
  const availability = providerAvailability(rows, { budgetExhausted })
  const status = runStatus({
    executed: true,
    cases: rows,
    budgetExhausted,
    providerUnavailable: availability.unavailable,
    invalid: false,
    stage,
  })
  const report = reportEnvelope({
    status,
    executionKind: stage === 'writer-only'
      ? 'live writer-only: real EF fold, writer, validator, journal, working set, and checkpoint; no follow-up agent'
      : 'live custom text-JSON tool loop (not the production DSH agent loop)',
    stage,
    manifest,
    arms,
    runId,
    rows,
    ledger,
    inner: runtime.inner,
    dataset,
    notes: [
      `stage: ${stage}`,
      `provider calls: ${availability.successes}/${availability.attempts} succeeded over ${availability.attemptedRows} provider row(s)`,
      ...(availability.unavailable
        ? [`provider-unavailable: all ${availability.attempts} attempted call(s) failed at the provider; oracle controls are not route evidence`]
        : []),
      `provider failures observed: ${rows.filter(row => row.failures?.provider?.length > 0).length}`,
      ...(stopReason === null ? [] : [`stop reason: ${stopReason}`]),
      ...(harnessError === null ? [] : [`harness error: ${harnessError}`]),
      'Custom tool loop: tool results are user text; recall searches the frozen transcript, not production context_search.',
      'The hidden checker runs outside the agent workspace; the environment is allowlisted.',
      'Same-user code is not sandboxed by the OS; see isolation.osSandbox.',
      'No currency is reported: no trusted price profile was supplied.',
    ],
  })
  report.runElapsedMs = Date.now() - runStarted
  report.stopReason = stopReason
  report.harnessError = harnessError
  report.providerAvailability = availability
  const paths = await writeRunReport({ runRoot, runId, report, latestName: 'live-report.json' })
  const writer = report.quality.writerMeasurements
  const summary = stage === 'writer-only'
    ? `${availability.successes}/${availability.attempts} real provider call(s) succeeded; `
      + `${writer.callSucceeded}/${writer.realWriterRows} real writer call(s) completed; `
      + `${writer.oracleControls} oracle control(s); ${validRows.length}/${rows.length} fold measurement(s) valid`
    : `${report.quality.taskSuccesses}/${report.quality.validCases} valid cases passed`
  process.stdout.write(`${status}: ${summary}\n${paths.reportPath}\n`)
  process.exit(STATUS_EXIT_CODE[status] ?? 7)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    // A refused overwrite is an operator error, not a crash. Say what happened
    // and exit non-zero without a stack trace.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
