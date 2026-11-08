/**
 * One experimental cell: materialize, seed, fold through the REAL automatic
 * trigger, continue with the native loop, score the workspace.
 *
 * The fold is never called directly. The compaction backend is mounted with
 * `auto: true`, and the host's own `agent/pre-step` pressure path decides. If
 * the seed does not exceed the threshold, the cell records
 * `treatmentExposure: 'no-fold'` — that is a measurement, not a failure, and it
 * is never silently dropped.
 *
 * @module eval/e2e/src/cell
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { BudgetLedger } from '../../r33/src/budget.mjs'
import { runChecks } from './checker.mjs'
import {
  createSeededAgent,
  disposeHost,
  mountHost,
  resumeAgent,
} from './host.mjs'
import { appendEntriesToSession, buildSeed } from './seed.mjs'

const MAX_STEPS = 8
const OUTPUT_TOKENS = 1024
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export async function materialize(files, workspace) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(workspace, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
}

/** Classify one request by the auxiliary prompt it carries, if any. */
function purposeOf(options) {
  // A one-shot auxiliary call may put its instruction in `system` rather than
  // in the message list; both are the provider-visible request, so both count.
  const text = [
    options.system ?? '',
    ...(options.messages ?? []).map(message =>
      (message.content ?? []).map(block => block.type === 'text' ? block.text : '').join('')),
  ].join('\n')
  if (text.includes('You are the SEMANTIC WRITER')) return 'writer'
  if (text.includes('RATIONALE writer for a checkpoint')) return 'rationale'
  if (text.includes('You are now acting as a compaction engine for this AI coding assistant.')) return 'summary'
  return 'primary'
}

function messageSummary(message) {
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  return {
    role: message.role ?? message.source?.kind ?? 'unknown',
    chars: text.length,
    digest: sha256(text),
    preview: text.slice(0, 400),
    truncated: text.length > 400,
    ...(message.content.some(block => block.type === 'tool-call') ? { toolCalls: true } : {}),
  }
}

/**
 * Record every request and every chunk, and hand the SAME stream to the host.
 *
 * The wrapper never inspects or rewrites the stream: it observes. A harness
 * that could alter the response would be measuring itself.
 */
export class RecordingAdapter extends LlmAdapter {
  constructor(inner, log, { defaultMaxTokens = 1024 } = {}) {
    super()
    this.inner = inner
    this.log = log
    this.defaultMaxTokens = defaultMaxTokens
  }

  providerInfo(provider) {
    return this.inner.providerInfo(provider)
  }

  providerRetryPolicy(provider) {
    return this.inner.providerRetryPolicy?.(provider)
  }

  async resolveModel(provider, model) {
    const info = await this.inner.resolveModel(provider, model)
    // The native loop does not invent an output cap. Without one the budget
    // ledger cannot reserve an upper bound and refuses the request as
    // `unknown-output-bound` BEFORE it is sent. Declaring the cap here makes it
    // part of the resolved model and the logged header, so every arm and every
    // auxiliary call carries the same bound.
    return { ...info, defaultMaxTokens: this.defaultMaxTokens }
  }

  async *stream(options) {
    const effective = options.maxTokens === undefined || options.maxTokens === null
      ? { ...options, maxTokens: this.defaultMaxTokens }
      : options
    const entry = {
      index: this.log.requests.length,
      at: new Date().toISOString(),
      purpose: purposeOf(effective),
      maxTokens: effective.maxTokens ?? null,
      system: effective.system === undefined ? null : {
        chars: effective.system.length,
        digest: sha256(effective.system),
        preview: effective.system.slice(0, 400),
        truncated: effective.system.length > 400,
      },
      messages: (effective.messages ?? []).map(messageSummary),
      tools: (effective.tools ?? []).map(tool => tool.name ?? tool.function?.name ?? 'unknown'),
      usage: null,
      finish: null,
      durationMs: null,
    }
    const started = Date.now()
    this.log.requests.push(entry)
    for await (const chunk of this.inner.stream(effective)) {
      if (chunk.type === 'usage') entry.usage = chunk.usage
      if (chunk.type === 'finish') entry.finish = chunk.reason
      yield chunk
    }
    entry.durationMs = Date.now() - started
  }
}

/**
 * A deterministic solver for `--self-test`.
 *
 * It writes the reference files, runs the tests, and finishes. It is not a
 * model and no result from it is evidence about a model; it exists to prove the
 * host, the tools, the fold and the checker are wired together.
 */
class ScriptedSolverAdapter extends LlmAdapter {
  constructor(task) {
    super()
    this.task = task
    this.calls = 0
    this.written = new Set()
    this.stage = 0
    this.files = task.reference
    this.log = { requests: [] }
  }

  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 4096 } })
  }

  async *stream(options) {
    const text = [
      options?.system ?? '',
      ...(options?.messages ?? []).map(message =>
        (message.content ?? []).map(block => block.type === 'text' ? block.text : '').join('')),
    ].join('\n')
    // Auxiliary calls must answer in the shape the caller parses. A scripted
    // solver that answered a summary request with a tool call would make the
    // self-test fail for a reason that belongs to the script, not the host.
    if (text.includes('You are now acting as a compaction engine for this AI coding assistant.')) {
      yield* this.emitText('Checkpoint: continue the task in the workspace; run the tests and report the result.')
      return
    }
    if (text.includes('RATIONALE writer for a checkpoint')) {
      yield* this.emitText('The user asked for the implementation to be finished and verified against the tests.')
      return
    }
    this.calls += 1
    const pending = Object.entries(this.files).filter(([path]) => !this.written.has(path))
    if (pending.length > 0) {
      const [path, content] = pending[0]
      this.written.add(path)
      yield* this.emitToolCall(`self-${this.calls}`, 'write_file', JSON.stringify({ path, content }))
      return
    }
    if (this.stage === 0) {
      this.stage = 1
      yield* this.emitToolCall(`self-${this.calls}`, 'run_tests', '{}')
      return
    }
    yield* this.emitText('Self-test complete.')
  }

  async *emitToolCall(id, name, args) {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: args }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args },
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  async *emitText(text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { text, type: 'text' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function summarizeEvents(events) {
  const compactions = []
  const open = new Map()
  const toolCalls = []
  const toolResults = []
  const assistant = []
  for (const event of events) {
    const seq = Number(event.seq)
    if (event.type === 'compaction/start') {
      const row = { id: String(event.data.compactionId), startSeq: seq, endSeq: null, error: null }
      open.set(row.id, row)
      compactions.push(row)
    } else if (event.type === 'compaction/end') {
      const row = open.get(String(event.data.compactionId))
      if (row !== undefined) {
        row.endSeq = seq
        row.error = event.data.error?.message ?? event.data.error ?? null
        open.delete(String(event.data.compactionId))
      }
    } else if (event.type === 'tool/call') {
      toolCalls.push({ seq, name: event.data.name, callId: String(event.data.callId) })
    } else if (event.type === 'tool/result') {
      toolResults.push({
        seq,
        callId: String(event.data.message?.source?.callId ?? event.data.callId ?? ''),
        isError: event.data.error !== undefined,
        errorCode: event.data.error?.code ?? null,
      })
    } else if (event.type === 'assistant/message') {
      assistant.push({
        seq,
        text: (event.data.message?.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n'),
        toolCalls: (event.data.message?.content ?? []).filter(block => block.type === 'tool-call').length,
      })
    }
  }
  return { compactions, toolCalls, toolResults, assistant }
}

function checkpointOf(session) {
  const nodes = [...session.surface.nodes]
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const message = session.deriveEventMessage(session.eventAt(nodes[index]))
    if (message === null || message.role !== 'user') continue
    if (!isCompactCheckpointSource(message.source)) continue
    return {
      seq: Number(nodes[index]),
      source: 'surface',
      text: message.content.map(block => block.type === 'text' ? block.text : '').join('\n'),
    }
  }
  // A replacement can leave the checkpoint event in the log but not in the
  // derived surface (for example when the fold was followed by a second
  // replacement). The log is the authority for WHAT was written; the surface
  // says what the model can still see. Record the difference rather than
  // reporting "no checkpoint" for a fold that clearly produced one.
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const message = event.data.message
    // A user/message event without a source is not a checkpoint; passing
    // `undefined` to the predicate throws instead of answering false.
    if (message?.source === undefined) continue
    if (!isCompactCheckpointSource(message.source)) continue
    return {
      seq: Number(event.seq),
      source: 'log-only',
      text: (message.content ?? []).map(block => block.type === 'text' ? block.text : '').join('\n'),
    }
  }
  return null
}

function foldMode(checkpoint) {
  if (checkpoint === null) return null
  const match = /\[EF1 ([LREG]) /u.exec(checkpoint.text)
  // No EF marker means the checkpoint came from DSH Basic (or from a build
  // that predates the marker). The report also carries the arm, so the two
  // facts together identify the producer; the label stays honest about what
  // the text alone proves.
  if (match === null) return 'unmarked'
  return { L: 'leaf', R: 'root', E: 'emergency', G: 'generation-merge' }[match[1]]
}

function sumUsage(requests) {
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unknownUsage: 0 }
  for (const entry of requests) {
    totals.requests += 1
    if (entry.usage === null || entry.usage === undefined) {
      totals.unknownUsage += 1
      continue
    }
    totals.inputTokens += entry.usage.inputTokens ?? 0
    totals.outputTokens += entry.usage.outputTokens ?? 0
    totals.cacheReadTokens += entry.usage.cacheReadTokens ?? 0
    totals.cacheWriteTokens += entry.usage.cacheWriteTokens ?? 0
  }
  return totals
}

async function waitIdle(agent, timeoutMs) {
  let timer
  const timeout = new Promise(resolvePromise => {
    timer = setTimeout(() => resolvePromise('timeout'), timeoutMs)
  })
  const idle = agent.whenIdle().then(() => 'idle')
  const outcome = await Promise.race([idle, timeout])
  clearTimeout(timer)
  if (outcome === 'timeout') {
    agent.cancel({ kind: 'user' })
    await agent.whenIdle().catch(() => {})
  }
  return outcome
}

/**
 * Run one cell.
 *
 * @param options.task - a frozen task instance.
 * @param options.arm - B0 / Bv / E0 / E1.
 * @param options.mode - 'live' or 'self-test'.
 * @param options.makeAdapter - factory `(task, ledger, log) => adapter`.
 * @param options.outRoot - campaign directory.
 */
export async function runCell({
  campaign,
  task,
  arm,
  replicate,
  mode,
  makeAdapter,
  outRoot,
  provider,
  model,
  cellLimits,
}) {
  const cellId = `${task.id}-${arm}-r${replicate}`
  const cellRoot = join(outRoot, cellId)
  await mkdir(cellRoot, { recursive: false })
  const workspace = join(cellRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  await materialize(task.workspace, workspace)

  const roots = { bundleRoot: join(cellRoot, 'bundles'), semanticRoot: join(cellRoot, 'semantic') }
  const persistenceRoot = join(cellRoot, 'persistence')
  const ledger = new BudgetLedger(cellLimits)
  const log = { requests: [] }
  const adapter = makeAdapter({ task, ledger, log })

  const sessionId = `ef-e2e-${cellId}-${randomUUID().slice(0, 8)}`
  const seed = buildSeed(task.history, {
    provider, model, maxTokens: OUTPUT_TOKENS, sessionId: `seed-${sessionId}`,
  })
  const seedDigest = sha256(JSON.stringify(task.history))

  const started = Date.now()
  let host = null
  let handle = null
  let toolState = null
  let stepLimit = false
  let idleOutcome = 'idle'
  let error = null
  let stageB = null

  try {
    host = await mountHost({
      arm,
      adapter,
      model,
      workspace,
      roots,
      persistenceRoot: task.stageB === undefined ? null : persistenceRoot,
      thresholdRatio: task.thresholdRatio,
    })
    ;({ handle, toolState } = await createSeededAgent(host, {
      sessionId,
      seed,
      workspace,
      maxSteps: MAX_STEPS,
    }))
    host.ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      if (step > MAX_STEPS) {
        stepLimit = true
        agent.cancel({ kind: 'user' })
      }
      return next()
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: task.task }],
      source: { kind: 'user' },
    }))
    idleOutcome = await waitIdle(handle.agent, cellLimits.wallClockMs)

    if (task.stageB !== undefined && idleOutcome === 'idle') {
      const first = summarizeEvents(handle.agent.session.snapshotEvents())
      const firstCheckpoint = checkpointOf(handle.agent.session)
      await handle.dispose()
      handle = null
      await disposeHost(host)
      host = await mountHost({
        arm,
        adapter,
        model,
        workspace,
        roots,
        persistenceRoot,
        thresholdRatio: task.thresholdRatio,
      })
      const resumed = await resumeAgent(host, { sessionId, workspace, maxSteps: MAX_STEPS })
      handle = resumed.handle
      toolState = { ...resumed.toolState, writes: toolState.writes, testRuns: toolState.testRuns }
      host.ctx.on('agent/pre-step', async ({ agent, step }, next) => {
        if (step > MAX_STEPS) {
          stepLimit = true
          agent.cancel({ kind: 'user' })
        }
        return next()
      })
      appendEntriesToSession(handle.agent.session, task.stageB, { provider, model })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: task.taskB }],
        source: { kind: 'user' },
      }))
      const secondIdle = await waitIdle(handle.agent, cellLimits.wallClockMs)
      stageB = {
        firstCompactions: first.compactions.length,
        firstCheckpointChars: firstCheckpoint?.text.length ?? 0,
        firstCheckpointMode: foldMode(firstCheckpoint),
        idle: secondIdle,
      }
      if (secondIdle === 'timeout') idleOutcome = 'timeout'
    }
  } catch (thrown) {
    error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
  }

  const events = handle === null ? [] : handle.agent.session.snapshotEvents()
  const session = handle?.agent.session ?? null
  const checkpoint = session === null ? null : checkpointOf(session)
  // Diagnostic for the checkpoint reader: the last surface nodes with their
  // source kind. If a fold produced a checkpoint the reader cannot see, this
  // says whether the message is missing, mis-sourced or outside the surface.
  const surfaceTail = session === null ? [] : [...session.surface.nodes].slice(-8).map(seq => {
    const event = session.eventAt(seq)
    const message = session.deriveEventMessage(event)
    return {
      seq: Number(seq),
      type: event.type,
      role: message?.role ?? null,
      sourceKind: message?.source?.kind ?? null,
    }
  })
  const userMessages = events.filter(event => event.type === 'user/message').slice(-10).map(event => ({
    seq: Number(event.seq),
    sourceKind: event.data.message?.source?.kind ?? null,
    chars: (event.data.message?.content ?? []).reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0),
  }))
  const summary = summarizeEvents(events)
  const surfaceNodes = session === null ? 0 : session.surface.nodes.length
  const retainedTokens = session === null ? null : (host?.ctx.tokenMeter.measure(session).totalTokens ?? null)
  const engineDecision = host?.plugin?.engine?.lastLeafDecision ?? null
  const thresholdTokens = host?.plugin?.engine?.telemetry?.thresholdTokens ?? null

  if (handle !== null) await handle.dispose()
  if (host !== null) await disposeHost(host)

  const checker = await runChecks(task.checks, { workspace, repoRoot: ROOT })
  // A mechanism requirement is a cell-level claim, not a workspace claim: T5
  // only measures multi-fold continuity if the cell actually folded twice.
  if (task.requires?.minCompactions !== undefined) {
    const count = summary.compactions.length
    const pass = count >= task.requires.minCompactions
    checker.checks.push({
      kind: 'compactions',
      pass,
      detail: `${count} compaction transaction(s), required ${task.requires.minCompactions}`,
    })
    checker.pass = checker.pass && pass
  }
  const usage = sumUsage(log.requests)
  const primaryUsage = sumUsage(log.requests.filter(entry => entry.purpose === 'primary'))
  const auxiliaryUsage = sumUsage(log.requests.filter(entry => entry.purpose !== 'primary'))
  const durationMs = Date.now() - started
  const finalText = summary.assistant.length === 0 ? '' : summary.assistant[summary.assistant.length - 1].text

  const compactions = summary.compactions.length
  const exposure = compactions > 0 ? 'fold' : 'no-fold'
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    campaign,
    cellId,
    task: {
      id: task.id,
      template: task.template,
      seed: task.seed,
      category: task.category,
      budgetTokens: task.operationalBudgetTokens,
      thresholdRatio: task.thresholdRatio,
      seedDigest,
    },
    arm,
    mode,
    model,
    provider,
    route: mode === 'live' ? { origin: 'resolved-at-run' } : { origin: 'scripted' },
    workspace: {
      files: Object.keys(task.workspace).sort(),
      finalFiles: Object.keys(task.workspace).sort(),
    },
    treatmentExposure: exposure,
    compactions: summary.compactions,
    checkpoint: checkpoint === null ? null : {
      seq: checkpoint.seq,
      source: checkpoint.source,
      chars: checkpoint.text.length,
      mode: foldMode(checkpoint),
      text: checkpoint.text,
      digest: sha256(checkpoint.text),
    },
    surfaceNodes,
    surfaceTail,
    userMessages,
    retainedTokens,
    engineDecision,
    thresholdTokens,
    termination: {
      idle: idleOutcome,
      stepLimit,
      finished: toolState?.finished === true,
      finishSummary: toolState?.finishSummary ?? null,
      error,
      durationMs,
      // A stop after a final assistant text with no tool calls is the native
      // loop's normal end; a step limit is a censored cell.
      kind: error !== null ? 'error' : stepLimit ? 'step-limit' : idleOutcome === 'timeout' ? 'timeout' : 'finish',
    },
    tools: {
      calls: summary.toolCalls.length,
      byName: summary.toolCalls.reduce((counts, call) => {
        counts[call.name] = (counts[call.name] ?? 0) + 1
        return counts
      }, {}),
      results: summary.toolResults.length,
      errors: summary.toolResults.filter(result => result.isError || result.errorCode !== null).length,
      testsExecuted: toolState?.testsExecuted ?? 0,
      lastTestExit: toolState?.lastTest?.exitCode ?? null,
      writes: toolState?.writes ?? 0,
    },
    usage: {
      ...usage,
      primary: primaryUsage,
      auxiliary: auxiliaryUsage,
      note: usage.unknownUsage > 0
        ? `${usage.unknownUsage} request(s) reported no usage; they are counted as unknown, not zero`
        : 'every request reported usage',
    },
    checker: {
      pass: checker.pass,
      checks: checker.checks.map(row => ({ kind: row.kind, pass: row.pass, detail: row.detail })),
    },
    behaviour: {
      finalText,
      assistantMessages: summary.assistant.length,
      claimedSuccess: /\b(done|complete|passing|passed|all tests pass)\b/iu.test(finalText),
      falseVerification: checker.pass === false && /\b(pass|passing|done|complete)\b/iu.test(finalText),
    },
    stageB,
    requests: log.requests.map(entry => ({
      index: entry.index,
      purpose: entry.purpose,
      maxTokens: entry.maxTokens,
      messages: entry.messages,
      tools: entry.tools,
      usage: entry.usage,
      finish: entry.finish,
      durationMs: entry.durationMs,
    })),
  }

  await mkdir(join(cellRoot, 'raw'), { recursive: true })
  await writeFile(join(cellRoot, 'raw', 'requests.json'), `${JSON.stringify(log.requests, null, 2)}\n`, 'utf8')
  await writeFile(join(cellRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

export { ScriptedSolverAdapter }
