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
import { access, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  loadHoldoutDataset,
  verifyFrozen,
  verifyHoldout,
} from './src/dataset.mjs'
import {
  BudgetExhausted,
  BudgetLedger,
  STATUS_EXIT_CODE,
  loadLiveGate,
  runQuality,
  runStatus,
  snapshotDelta,
} from './src/budget.mjs'
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
  writeWorkspaceFile,
} from './src/workspace.mjs'
import {
  SCORER_VERSION,
  behaviourMetrics,
  extractionMetrics,
  sourceBindings,
} from './src/grade.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const SIGNAL = new AbortController().signal
const ARMS = ['B1', 'S', 'O1', 'O2']
const ALL_ARMS = [...ARMS, 'F', 'N', 'OR']
const FOLLOW_UP_TOOLS = ['read_file', 'write_file', 'list_dir', 'run_tests', 'recall', 'finish']

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
    this.lastUsage = undefined
    try {
      for await (const chunk of this.inner.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') finish = chunk.reason
        yield chunk
      }
    } finally {
      this.lastUsage = usage
      if (finish?.kind === 'error') {
        this.log.record({
          kind: 'provider-failure',
          writer,
          code: finish.failure?.code ?? 'unknown',
          message: finish.failure?.message ?? '',
        })
      }
      if (writer) {
        this.log.record({
          kind: 'writer-call',
          oracle: false,
          text: text.slice(0, 20_000),
          chars: text.length,
          usage: usage ?? null,
          maxTokens: options.maxTokens ?? null,
        })
      }
    }
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
      text: text.slice(0, 20_000),
      chars: text.length,
      usage: null,
      maxTokens: options.maxTokens ?? null,
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
  await host.plugin.engine.compactRegion(
    nodes[frontier.firstOpenPosition],
    nodes[nodes.length - 1],
    agent,
    SIGNAL,
  )
  await host.plugin.engine.reconcileSemantics(session)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: caseData.task }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const foldElapsedMs = Date.now() - started
  const checkpoint = visibleCheckpoint(session)
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

function armContext(arm, caseData, checkpoint) {
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

function parseAction(text) {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  for (let end = text.length; end > start; end -= 1) {
    if (text[end - 1] !== '}') continue
    try {
      return JSON.parse(text.slice(start, end))
    } catch {
      // keep shrinking
    }
  }
  return undefined
}

async function followUp({ adapter, model, caseData, arm, checkpoint, workspaceRoot, maxSteps }) {
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: `${armContext(arm, caseData, checkpoint)}\n\nBEGIN THE TASK.` }],
  }]
  const system = systemPrompt()
  let toolCalls = 0
  let testsExecuted = 0
  let testRuns = []
  let recallAttempts = 0
  let recallSuccess = 0
  let recallGrounded = 0
  let steps = 0
  let finished = false
  let summary = ''
  const trace = []
  for (; steps < maxSteps; steps += 1) {
    let text = ''
    let usage
    let finishReason
    try {
      for await (const chunk of adapter.stream({
        provider: model,
        model,
        system,
        messages,
        maxTokens: 1024,
        signal: SIGNAL,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') finishReason = chunk.reason
      }
    } catch (error) {
      if (error instanceof BudgetExhausted) throw error
      return {
        steps, toolCalls, testsExecuted, testRuns, recallAttempts, recallSuccess, recallGrounded,
        finished, summary, trace,
        providerFailure: error instanceof ProviderFailure
          ? { code: error.code, message: error.message }
          : { code: 'unknown', message: error instanceof Error ? error.message : String(error) },
      }
    }
    if (finishReason?.kind === 'error') {
      if (finishReason.failure?.code === 'BUDGET_EXHAUSTED') {
        throw new BudgetExhausted(finishReason.failure?.message ?? 'provider refused by the ledger')
      }
      return {
        steps, toolCalls, testsExecuted, testRuns, recallAttempts, recallSuccess, recallGrounded,
        finished, summary, trace,
        providerFailure: {
          code: finishReason.failure?.code ?? 'unknown',
          message: finishReason.failure?.message ?? 'provider returned an error finish',
        },
      }
    }
    trace.push({ step: steps, text: text.slice(0, 1000), usage, finishReason })
    const action = parseAction(text)
    if (action === undefined || typeof action.tool !== 'string') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Reply with exactly one JSON tool object.' }] })
      continue
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    if (action.tool === 'finish') {
      finished = true
      summary = String(action.summary ?? '')
      break
    }
    toolCalls += 1
    if (action.tool === 'read_file') {
      const result = await readWorkspaceFile(workspaceRoot, action.path)
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: result.ok
            ? `TOOL RESULT read_file:\n${result.content ?? ''}`
            : `TOOL RESULT read_file: ${result.reason ?? 'failed'}`,
        }],
      })
      continue
    }
    if (action.tool === 'write_file') {
      const result = await writeWorkspaceFile(workspaceRoot, action.path, action.content)
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: result.ok
            ? `TOOL RESULT write_file: wrote ${action.path}`
            : `TOOL RESULT write_file: failed: ${result.reason ?? 'unknown error'}`,
        }],
      })
      continue
    }
    if (action.tool === 'list_dir') {
      const listing = await listWorkspace(workspaceRoot)
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `TOOL RESULT list_dir:\n${listing.text}` }],
      })
      continue
    }
    if (action.tool === 'run_tests') {
      testsExecuted += 1
      const result = await runVisibleTests(workspaceRoot)
      testRuns.push({
        exitCode: result.exitCode,
        passed: result.passed,
        timedOut: result.timedOut,
        truncated: result.outputTruncated,
      })
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: `TOOL RESULT run_tests (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}):\n`
            + `${result.stdout.slice(-8_000)}\n${result.stderr.slice(-2_000)}`,
        }],
      })
      continue
    }
    if (action.tool === 'recall') {
      recallAttempts += 1
      const result = recall(caseData, action.query)
      if (result.matches > 0) recallSuccess += 1
      if (result.grounded) recallGrounded += 1
      messages.push({ role: 'user', content: [{ type: 'text', text: `TOOL RESULT recall:\n${result.text}` }] })
      continue
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: `TOOL RESULT: unknown tool ${action.tool}` }] })
  }
  return {
    steps, toolCalls, testsExecuted, testRuns, recallAttempts, recallSuccess, recallGrounded,
    finished, summary, trace,
  }
}

function writerSummary(log, packet, observation, arm) {
  const writerEntries = log.entries.filter(entry => entry.kind === 'writer-call')
  const providerEntries = log.entries.filter(entry => entry.kind === 'provider-failure')
  if (arm === 'B1' || arm === 'O2' || arm === 'F' || arm === 'N' || arm === 'OR') {
    return { applicable: false, reason: 'this arm has no semantic writer', providerFailures: providerEntries }
  }
  const entry = writerEntries[writerEntries.length - 1]
  return {
    applicable: true,
    call: observation?.call ?? (entry === undefined ? 'not-attempted' : 'success'),
    protocol: observation?.protocol ?? packet?.deltaParse ?? 'not-called',
    integrity: observation?.integrity ?? null,
    coverage: observation?.coverage ?? 'not-assessed',
    proposed: packet?.proposed?.length ?? observation?.proposed ?? null,
    accepted: packet?.accepted?.length ?? observation?.accepted ?? null,
    refused: packet?.refused?.length ?? observation?.refused ?? null,
    limitExceeded: observation?.limitExceeded ?? null,
    refusals: observation?.refusals ?? null,
    detail: observation?.detail ?? null,
    handoff: packet?.handoff ?? null,
    rawOutput: entry?.text ?? null,
    rawOutputChars: entry?.chars ?? 0,
    oracle: entry?.oracle ?? false,
    oracleBasis: entry?.basis ?? null,
    acceptedDeltas: packet?.accepted ?? null,
    refusedDeltas: packet?.refused ?? null,
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

function baseAdapter({ live, inner, ledger, log, caseData, plan, writerPayload }) {
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
  const log = new WriterLog()
  const base = baseAdapter({ live, inner, ledger, log, caseData, plan, writerPayload })
  const adapter = adapterForRun({ base, arm, caseData, ledger, log, o1Handoff })
  const host = await mountHost(adapter, manifest.model, layout, arm === 'S' || arm === 'O1')
  const before = ledger.snapshot()
  const folded = await foldCase(caseData, layout, host, manifest.model)
  const writer = writerSummary(log, folded.packet, folded.writerObservation, arm)
  const currentFacts = caseData.gold.filter(fact => fact.current)
  let follow
  let checker = {
    status: 'not-run',
    checks: [],
    claims: {},
    exitCode: null,
    timedOut: false,
    detail: 'the fold did not happen',
  }
  let behaviour
  let extraction = extractionMetrics(caseData, {
    accepted: undefined,
    refused: undefined,
    writer: undefined,
    checkpoint: folded.checkpoint,
    anchorValues: [],
    transcript: caseData.transcript,
  })
  if (folded.fold.valid) {
    follow = await followUp({
      adapter,
      model: manifest.model,
      caseData,
      arm,
      checkpoint: folded.checkpoint,
      workspaceRoot: layout.workspace,
      maxSteps: manifest.followUpSteps ?? 8,
    })
    checker = await runChecker(caseData, layout.workspace)
    const verification = await readVerification(layout.workspace)
    behaviour = behaviourMetrics(caseData, {
      checker,
      decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
      verification,
      testsExecuted: follow.testsExecuted,
    })
    const active = arm === 'S' || arm === 'O1'
    extraction = extractionMetrics(caseData, {
      accepted: active ? (folded.packet?.accepted ?? []) : undefined,
      refused: active ? (folded.packet?.refused ?? []) : undefined,
      writer: active ? (folded.writerObservation ?? writer) : undefined,
      checkpoint: folded.checkpoint,
      anchorValues: active ? folded.state.anchors : [],
      transcript: caseData.transcript,
    })
  }
  const after = ledger.snapshot()
  const cost = snapshotDelta(before, after)
  cost.caseDurationMs = Date.now() - caseStarted
  cost.runElapsedMs = after.elapsedMs
  const valid = folded.fold.valid
    && follow?.providerFailure === undefined
    && checker.status === 'executed'
  const reason = folded.fold.valid
    ? follow?.providerFailure !== undefined
      ? `provider-failure: ${follow.providerFailure.code}`
      : checker.status !== 'executed'
        ? `checker-${checker.status}`
        : undefined
    : 'no-fold'
  const row = {
    schemaVersion: 2,
    caseId: caseData.id,
    riskClass: caseData.riskClass,
    family: caseData.counterfactual?.pair ?? caseData.id,
    arm,
    mode,
    runId,
    replicateId,
    valid,
    ...(reason === undefined ? {} : { reason }),
    fold: folded.fold,
    foldElapsedMs: folded.foldElapsedMs,
    checkpoint: {
      digest: digestText(folded.checkpoint),
      chars: folded.checkpoint.length,
      text: folded.checkpoint.slice(0, 8_000),
      truncated: folded.checkpoint.length > 8_000,
    },
    writer,
    state: folded.state,
    sourceBindings: sourceBindings(caseData, folded.sourceEventSeqs),
    extraction,
    behaviour: behaviour ?? {
      taskSuccess: false,
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
    mode,
    writerRaw: writer.rawOutput,
    acceptedDeltas: writer.acceptedDeltas,
    refusedDeltas: writer.refusedDeltas,
    checkpoint: folded.checkpoint,
    followTrace: follow?.trace ?? [],
    checker,
    extraction,
    behaviour: row.behaviour,
    state: folded.state,
  }), 'utf8')
  return row
}

async function writeReport(name, report) {
  await mkdir(OUT, { recursive: true })
  const path = join(OUT, name)
  await writeFile(path, json(report), 'utf8')
  return path
}

function selectCases(cases, requested) {
  if (requested === undefined || requested.length === 0) return cases
  const ids = String(requested).split(',').map(id => id.trim()).filter(Boolean)
  return cases.filter(entry => ids.includes(entry.id))
}

function selectArms(requested) {
  if (requested === undefined || requested.length === 0) return [...ARMS]
  const arms = String(requested).split(',').map(arm => arm.trim()).filter(Boolean)
  for (const arm of arms) {
    if (!ALL_ARMS.includes(arm)) throw new Error(`unknown arm ${arm}; expected one of ${ALL_ARMS.join(', ')}`)
  }
  return arms
}

function newRunId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)
  return `${prefix}-${stamp}-${randomUUID().slice(0, 8)}`
}

async function runScriptedSelfTest(cases, arms) {
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
        mode: 'self-test',
        live: false,
        inner: undefined,
        ledger,
        runRoot,
        runId,
        replicateId: 'r1',
        manifest: { model: 'r34-self-test', followUpSteps: 12 },
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
  const quality = runQuality(rows)
  const status = runStatus({ executed: true, cases: rows, invalid: rows.length === 0 })
  return {
    schemaVersion: 2,
    status,
    executionKind: 'self-test (scripted adapter; verifies plumbing, not model behavior)',
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
    ledger: ledger.snapshot(),
    rows,
    notes: [
      'No provider request was made.',
      'The follow-up loop is the custom evaluation harness loop, not the production DSH agent loop.',
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
  const inner = new OpenAiCompatibleAdapter({
    baseUrl,
    apiKey,
    model: manifest.model,
    contextWindow: manifest.route?.contextWindow ?? 131_072,
    ...(route.headers === undefined ? {} : { headers: route.headers }),
    // The global ledger IS the adapter's budget. `admit` runs immediately
    // before every HTTP attempt, including a 429 resend.
    budget: ledger,
  })
  return { inner }
}

function reportEnvelope({ status, executionKind, manifest, arms, runId, rows, ledger, inner, dataset, notes }) {
  const quality = runQuality(rows)
  return {
    schemaVersion: 2,
    status,
    executionKind,
    generatedAt: new Date().toISOString(),
    runId,
    dataset,
    model: manifest.model,
    route: {
      baseUrlEnv: manifest.route?.baseUrlEnv ?? null,
      apiKeyEnv: manifest.route?.apiKeyEnv ?? null,
      headerNames: Object.keys(manifest.route?.headers ?? {}),
      contextWindow: manifest.route?.contextWindow ?? 131_072,
    },
    limits: manifest.limits,
    maxOutputTokens: manifest.maxOutputTokens,
    arms,
    isolation: ISOLATION_LEVEL,
    quality,
    ledger: ledger.snapshot(),
    provider: liveProvider(inner),
    rows,
    notes,
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
  const frozen = await verifyFrozen()
  if (!frozen.ok) {
    process.stderr.write(`invalid benchmark: ${frozen.reason}\n`)
    process.exit(STATUS_EXIT_CODE['invalid-benchmark'])
  }
  const { cases, errors, datasetDigest } = await loadDataset()
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
      followUpTools: FOLLOW_UP_TOOLS,
      isolation: ISOLATION_LEVEL,
      executionKinds: {
        scripted: 'self-test / offline pipeline measurement',
        customToolLoop: 'live custom text-JSON loop (not the production DSH agent loop)',
        productionLoop: 'not implemented in this round; live is blocked without authorization',
      },
      runRequires: [
        'R33_LIVE=1',
        '--manifest with positive requests/inputTokens/outputTokens/wallClockMs',
        'manifest.maxOutputTokens (per-request bound)',
        'manifest.route.baseUrlEnv and manifest.route.apiKeyEnv (names, not secrets)',
      ],
      note: '--check resolves no credentials and makes no request.',
    }
    const path = await writeReport('live-check.json', audience)
    process.stdout.write(`${JSON.stringify(audience, null, 2)}\n${path}\n`)
    process.exit(0)
  }

  if (selfTest) {
    const selected = selectCases(cases, argValue('--cases'))
    const arms = selectArms(argValue('--arms'))
    const report = await runScriptedSelfTest(selected, arms)
    const path = await writeReport('self-test-report.json', report)
    process.stdout.write(`${report.status}: ${report.quality.taskSuccesses}/${report.quality.validCases} valid cases passed\n${path}\n`)
    process.exit(STATUS_EXIT_CODE[report.status] ?? 7)
  }

  const gate = await loadLiveGate(argValue('--manifest'), process.env)
  if (!gate.ok) {
    const report = {
      schemaVersion: 2,
      status: 'not-executed',
      reason: gate.reason,
      dataset,
      cases: cases.length,
      generatedAt: new Date().toISOString(),
      note: 'No provider request was attempted.',
    }
    const path = await writeReport('live-report.json', report)
    process.stdout.write(`${report.status}: ${report.reason}\n${path}\n`)
    process.exit(STATUS_EXIT_CODE['not-executed'])
  }
  const manifest = gate.manifest
  const ledger = new BudgetLedger(manifest.limits, { maxRequestOutputTokens: manifest.maxOutputTokens })
  const runtime = await runtimeFromManifest(manifest, ledger)
  if (runtime.unavailable !== undefined) {
    const report = {
      schemaVersion: 2,
      status: 'provider-unavailable',
      reason: runtime.unavailable,
      dataset,
      generatedAt: new Date().toISOString(),
      note: 'No provider request was attempted.',
    }
    const path = await writeReport('live-report.json', report)
    process.stdout.write(`${report.status}: ${report.reason}\n${path}\n`)
    process.exit(STATUS_EXIT_CODE['provider-unavailable'])
  }

  const selected = selectCases(cases, manifest.cases ?? argValue('--cases'))
  const arms = selectArms(manifest.arms ?? argValue('--arms'))
  const runId = manifest.runId ?? newRunId('live')
  const runRoot = process.env.R33_RUN_ROOT ?? join(homedir(), '.r33-runs')
  const rows = []
  let budgetExhausted = false
  let providerFailureCount = 0
  for (const caseData of selected) {
    const handoffs = new Map()
    for (const arm of arms) {
      if (budgetExhausted) break
      try {
        const row = await runOne({
          caseData,
          arm,
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
        if (row.behaviourDetail?.providerFailure !== undefined) providerFailureCount += 1
        rows.push(row)
      } catch (error) {
        if (error instanceof BudgetExhausted) {
          budgetExhausted = true
          break
        }
        rows.push({
          schemaVersion: 2,
          caseId: caseData.id,
          arm,
          mode: 'live',
          valid: false,
          reason: error instanceof Error ? error.message : String(error),
          behaviour: { taskSuccess: false },
          providerFailures: error instanceof ProviderFailure ? [error.code] : [],
          cost: { attempts: 0, inputTokens: 0, outputTokens: 0, caseDurationMs: 0 },
        })
      }
    }
    if (budgetExhausted) break
  }
  const telemetry = runtime.inner?.rateLimitTelemetry
  if (telemetry !== undefined) {
    for (let index = 0; index < (telemetry.retries ?? 0); index += 1) ledger.noteRetry()
  }
  const providerUnavailable = rows.length > 0
    && rows.every(row => row.valid !== true && row.providerFailures?.length > 0)
  const status = runStatus({
    executed: true,
    cases: rows,
    budgetExhausted,
    providerUnavailable,
    invalid: false,
  })
  const report = reportEnvelope({
    status,
    executionKind: 'live custom text-JSON tool loop (not the production DSH agent loop)',
    manifest,
    arms,
    runId,
    rows,
    ledger,
    inner: runtime.inner,
    dataset,
    notes: [
      `provider failures observed: ${providerFailureCount}`,
      'Custom tool loop: tool results are user text; recall searches the frozen transcript, not production context_search.',
      'The hidden checker runs outside the agent workspace; the environment is allowlisted.',
      'Same-user code is not sandboxed by the OS; see isolation.osSandbox.',
      'No currency is reported: no trusted price profile was supplied.',
    ],
  })
  const path = await writeReport('live-report.json', report)
  process.stdout.write(`${status}: ${report.quality.taskSuccesses}/${report.quality.validCases} valid cases passed\n${path}\n`)
  process.exit(STATUS_EXIT_CODE[status] ?? 7)
}

await main()
