#!/usr/bin/env node
/**
 * R37-D WP5: native runtime extension.
 *
 * N3  multiple tool calls in one assistant turn, real ToolRuntime scheduling
 * N4  interrupted-session recovery using the runtime's real repair codes
 * N5  repeated EF folds with a semantic revision, then a native tool call
 *
 * N3/N4 use the real `@deepseek-ai/dsh-agent-loop`, `dsh-agent`, `dsh-tools`,
 * `dsh-session`, and JSONL persistence. The model is a scripted adapter. No
 * provider request is made.
 *
 * N5 mounts the real EF plugin and folds a synthetic session twice. If the
 * second fold cannot be constructed without inventing runtime behaviour, N5 is
 * recorded as blocked with the exact error; it is not replaced by a larger
 * model run.
 *
 * Output:
 *   eval/r37d/out/native-extended.json
 *
 * @module eval/r37d/native-extended
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import {
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { apply as applyJsonlPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { writeJson } from '../r37/src/io.mjs'
import { readJournalState } from '../r37c/src/journal-state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env['R37D_NATIVE_OUT'] ?? join(HERE, 'out', 'native-extended.json')
const MODEL = 'r37d-scripted-native'
const PROVIDER = 'r37d-scripted'

function toolCallBlock(index, id, name, args) {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: args },
    {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id, name, arguments: args },
    },
  ]
}

function textBlock(index, text) {
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
  ]
}

class MultiToolAdapter extends LlmAdapter {
  constructor() {
    super()
    this.calls = 0
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  async *stream() {
    this.calls += 1
    if (this.calls === 1) {
      const calls = [
        ['call-read-1', 'read_file', JSON.stringify({ path: 'src/queue.mjs' })],
        ['call-write-1', 'write_file', JSON.stringify({ path: 'src/queue.mjs', content: 'export const queue = "new"\n' })],
        ['call-test-1', 'run_tests', JSON.stringify({})],
        ['call-fail-1', 'fail_once', JSON.stringify({})],
        ['call-read-2', 'read_file', JSON.stringify({ path: 'src/queue.mjs' })],
      ]
      for (const [index, [id, name, args]] of calls.entries()) {
        yield* toolCallBlock(index, ToolCallId(id), name, args)
      }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* textBlock(0, 'Native multi-tool lifecycle complete.')
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function tools(workspace) {
  let failures = 0
  return [
    defineTool({
      name: 'read_file',
      description: 'Read one file from the native workspace.',
      parameters: { path: { type: 'string', description: 'file path' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) {
        try {
          return { path: args.path, content: await readFile(join(workspace, args.path), 'utf8') }
        } catch {
          return { path: args.path, missing: true }
        }
      },
      isConcurrencySafe: () => true,
    }),
    defineTool({
      name: 'write_file',
      description: 'Write one file in the native workspace.',
      parameters: {
        path: { type: 'string', description: 'file path' },
        content: { type: 'string', description: 'file content' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) {
        await mkdir(dirname(join(workspace, args.path)), { recursive: true })
        await writeFile(join(workspace, args.path), args.content, 'utf8')
        return { path: args.path, bytes: args.content.length }
      },
      isConcurrencySafe: () => false,
    }),
    defineTool({
      name: 'run_tests',
      description: 'Read the current source and report what the test observed.',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() {
        let content = null
        try {
          content = await readFile(join(workspace, 'src/queue.mjs'), 'utf8')
        } catch {
          content = null
        }
        return { content, sawWritten: content === 'export const queue = "new"\n' }
      },
      isConcurrencySafe: () => true,
    }),
    defineTool({
      name: 'fail_once',
      description: 'Throw exactly once to exercise tool-error persistence.',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() {
        failures += 1
        if (failures === 1) throw new Error('intentional tool failure')
        return { failures }
      },
      isConcurrencySafe: () => false,
    }),
  ]
}

async function mount({ persistenceRoot = null, adapter = null, ef = null } = {}) {
  const ctx = new Context()
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  new AgentRegistry(ctx)
  if (persistenceRoot !== null) {
    await applyJsonlPersistence(ctx, { root: persistenceRoot, compression: 'none' })
  }
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: createVolatile(1) })
  const chosen = adapter ?? new MultiToolAdapter()
  const errors = []
  ctx.on('agent/error', payload => {
    errors.push({
      name: payload?.error?.name ?? null,
      message: payload?.error?.message ?? String(payload?.error ?? ''),
      code: payload?.error?.code ?? null,
    })
  })
  ctx.llm.registerAdapter([PROVIDER], chosen)
  let plugin = null
  if (ef !== null) {
    const { default: EpistemicFoldPlugin } = await import('../../lib/plugin.js')
    plugin = new EpistemicFoldPlugin(ctx, {
      auto: false,
      bundleRoot: ef.bundleRoot,
      semanticRoot: ef.semanticRoot,
      semanticContinuity: 'active',
      semanticMode: 'rationale',
      semanticWorkingSetTokens: 2048,
      semanticCheckpointTokens: 8192,
    })
  }
  return { ctx, adapter: chosen, errors, plugin }
}

function eventSummary(events) {
  return events.map(event => ({
    seq: Number(event.seq),
    type: event.type,
    ...(event.type === 'tool/call' ? { name: event.data?.name, callId: event.data?.callId } : {}),
    ...(event.type === 'tool/result' ? {
      callId: event.data?.message?.source?.callId ?? event.data?.callId ?? null,
      error: event.data?.error?.code ?? null,
      text: event.data?.message?.content?.find?.(block => block.type === 'text')?.text ?? null,
    } : {}),
    ...(event.type === 'assistant/message' ? {
      toolCalls: (event.data?.message?.content ?? [])
        .filter(block => block.type === 'tool-call')
        .map(block => ({ id: block.id, name: block.name })),
    } : {}),
  }))
}

function resultText(event) {
  return event.data?.message?.content?.find?.(block => block.type === 'text')?.text ?? ''
}

function inspectToolEvents(events) {
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  // The runtime renders a thrown tool error as a text result. An explicit
  // `error` field is not guaranteed; the text and isError flag are both real.
  const errors = results.filter(event => event.data?.error !== undefined
    || event.data?.isError === true
    || /^Error:/u.test(resultText(event)))
  const order = []
  for (const event of events) {
    if (event.type === 'tool/call') order.push({ kind: 'call', callId: event.data?.callId, seq: Number(event.seq) })
    if (event.type === 'tool/result') order.push({ kind: 'result', callId: event.data?.message?.source?.callId ?? null, seq: Number(event.seq) })
  }
  const paired = order.every((entry, index) => entry.kind === 'call'
    ? order.slice(index + 1).some(later => later.kind === 'result' && later.callId === entry.callId)
    : true)
  return {
    events: eventSummary(events),
    counts: {
      toolCalls: calls.length,
      toolResults: results.length,
      errors: errors.length,
    },
    order,
    paired,
    errorCodes: errors.map(event => event.data?.error?.code ?? 'tool-threw'),
  }
}

async function runN3() {
  const workspace = await mkdtemp(join(tmpdir(), 'r37d-native-n3-'))
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src/queue.mjs'), 'export const queue = "old"\n', 'utf8')
  const { ctx, adapter, errors } = await mount()
  const sessionId = SessionId(`r37d-n3-${randomUUID()}`)
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: PROVIDER, model: MODEL },
    meta: { cwd: workspace },
    setup: agentCtx => { for (const tool of tools(workspace)) agentCtx.tools.register(tool) },
  })
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Exercise the multi-tool lifecycle.' }],
    source: { kind: 'user' },
  }))
  await handle.agent.whenIdle()
  const events = handle.agent.session.snapshotEvents()
  const inspected = inspectToolEvents(events)
  const results = events.filter(event => event.type === 'tool/result')
  const testResult = results.find(event => resultText(event).includes('sawWritten'))
  const testText = testResult === undefined ? '' : resultText(testResult)
  const sawWritten = testText.includes('"sawWritten":true')
  const failResult = results.find(event => /^Error:/u.test(resultText(event))
    || event.data?.error?.code !== undefined)
  const duplicateResults = results.filter(event => {
    const callId = event.data?.message?.source?.callId
    return callId === 'call-read-1' || callId === 'call-read-2'
  })
  await handle.dispose()
  await ctx.dispose?.()
  await rm(workspace, { recursive: true, force: true })
  const status = inspected.counts.toolCalls === 5
    && inspected.counts.toolResults === 5
    && inspected.paired
    && sawWritten
    && failResult !== undefined
    && duplicateResults.length === 2
    && inspected.counts.errors === 1 ? 'passed' : 'failed'
  return {
    status,
    adapterCalls: adapter.calls,
    sessionId: String(sessionId),
    counts: inspected.counts,
    paired: inspected.paired,
    sawWritten,
    duplicateResults: duplicateResults.length,
    failResult: failResult === undefined ? null : {
      callId: failResult.data?.message?.source?.callId ?? null,
      code: failResult.data?.error?.code ?? 'tool-threw',
      message: failResult.data?.error?.message ?? resultText(failResult),
    },
    errorCodes: inspected.errorCodes,
    errors,
    events: inspected.events,
  }
}

async function interruptedSession(ctx, workspace, kind) {
  const sessionId = SessionId(`r37d-n4-${kind}-${randomUUID()}`)
  // `ctx.sessions.create` does not take persistence ownership; the agent
  // factory does. Create through the factory, then append the interrupted
  // events and flush before disposing.
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: PROVIDER, model: MODEL },
    meta: { cwd: workspace },
    setup: () => {},
  })
  const session = handle.agent.session
  const callId = ToolCallId(`call-${kind}`)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Interrupted ${kind} tool call.` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"hello.txt"}' },
      ],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  if (kind === 'started') {
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'read_file', arguments: '{"path":"hello.txt"}' })
  }
  await ctx.sessions.flush(session)
  await handle.dispose()
  return sessionId
}

async function treeStats(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    files += 1
    try {
      bytes += (await stat(join(entry.parentPath ?? root, entry.name))).size
    } catch {
      // A file removed during the walk is not part of the count.
    }
  }
  return { files, bytes }
}

async function runN4Case(kind) {
  const workspace = await mkdtemp(join(tmpdir(), `r37d-native-n4-${kind}-`))
  const persistenceRoot = await mkdtemp(join(tmpdir(), `r37d-native-n4-${kind}-store-`))
  await writeFile(join(workspace, 'hello.txt'), 'native smoke: hello\n', 'utf8')
  const sessionId = await (async () => {
    const { ctx } = await mount({ persistenceRoot })
    const id = await interruptedSession(ctx, workspace, kind)
    await ctx.dispose?.()
    return id
  })()
  const persisted = await readFile(join(persistenceRoot, 'sessions.jsonl'), 'utf8').catch(() => '')
  const persistence = await treeStats(persistenceRoot)
  const { ctx, errors } = await mount({ persistenceRoot })
  let resumed = null
  let recoveryError = null
  try {
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: PROVIDER, model: MODEL },
      setup: agentCtx => { for (const tool of tools(workspace)) agentCtx.tools.register(tool) },
    })
    resumed = inspectToolEvents(handle.agent.session.snapshotEvents())
    await handle.dispose()
  } catch (error) {
    recoveryError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  await ctx.dispose?.()
  await rm(workspace, { recursive: true, force: true })
  await rm(persistenceRoot, { recursive: true, force: true })
  const synthetic = (resumed?.events ?? []).filter(event => event.type === 'tool/result')
  const expected = kind === 'started' ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED'
  const codes = synthetic.map(event => event.error)
  return {
    status: recoveryError === null && codes.includes(expected) ? 'passed' : 'failed',
    kind,
    expectedCode: expected,
    persistedBytes: persisted.length,
    persistence,
    recoveryError,
    syntheticResults: synthetic,
    codes,
    errors,
    events: resumed?.events ?? [],
  }
}

async function runN4() {
  const notStarted = await runN4Case('not-started')
  const started = await runN4Case('started')
  return {
    status: notStarted.status === 'passed' && started.status === 'passed' ? 'passed' : 'failed',
    notStarted,
    started,
  }
}

class ScriptedEfAdapter extends LlmAdapter {
  constructor(payload) {
    super()
    this.payload = payload
    this.calls = 0
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  async *stream(options) {
    const last = options?.messages?.[options.messages.length - 1]
    const writerCall = this.payload !== null && last?.content?.some(block =>
      block.type === 'text' && typeof block.text === 'string'
      && block.text.startsWith('You are the SEMANTIC WRITER'))
    if (writerCall) {
      const text = `<handoff>\n${this.payload.handoff}\n</handoff>\n`
        + `<deltas>\n${JSON.stringify({ deltas: this.payload.deltas })}\n</deltas>`
      yield* textBlock(0, text)
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.calls += 1
    if (this.calls === 1) {
      yield* toolCallBlock(0, ToolCallId('call-n5-read'), 'read_file', JSON.stringify({ path: 'hello.txt' }))
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* textBlock(0, 'N5 native continuation complete.')
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function transcriptSession(caseData) {
  const session = Session.create(SessionId(`r37d-native-${caseData.id}-${randomUUID()}`))
  let turn = 0
  let step = 0
  let open = false
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
  for (const entry of caseData.transcript) {
    if (entry.role === 'user') {
      closeTurn()
      openTurn()
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
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
          source: { kind: 'model', provider: PROVIDER, model: MODEL },
        }),
      }, { surfaceOp: 'append' })
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
          source: { kind: 'model', provider: PROVIDER, model: MODEL },
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
    }
    session.append('step/end', { turn, step })
  }
  closeTurn()
  openTurn()
  return session
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

function openTurnNumber(session) {
  let open = null
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') open = Number(event.data?.turn ?? 0)
    if (event.type === 'turn/end') open = null
  }
  return open
}

function appendRevisionTurn(session, text) {
  const open = openTurnNumber(session)
  const turns = session.snapshotEvents()
    .filter(event => event.type === 'turn/start')
    .map(event => Number(event.data?.turn ?? 0))
  const turn = open ?? (turns.length === 0 ? 1 : Math.max(...turns) + 1)
  if (open === null) session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Acknowledged. The scheduler now uses a durable outbox.' }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  return turn
}

function normalizeText(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/gu, ' ').trim()
}

async function runN5() {
  const caseData = JSON.parse(await readFile(join(HERE, '..', 'r33', 'cases', 'B2', 'case.json'), 'utf8'))
  const root = await mkdtemp(join(tmpdir(), 'r37d-native-n5-'))
  const workspace = join(root, 'workspace')
  const bundleRoot = join(root, 'bundles')
  const semanticRoot = join(root, 'journal')
  await mkdir(workspace, { recursive: true })
  await mkdir(bundleRoot, { recursive: true })
  await mkdir(semanticRoot, { recursive: true })
  await writeFile(join(workspace, 'hello.txt'), 'native smoke: hello\n', 'utf8')
  const firstPayload = { handoff: caseData.writer.handoff, deltas: caseData.writer.deltas }
  const revisionPayload = {
    handoff: 'The storage dependency is now available. Use a durable outbox for the scheduler, superseding the in-memory decision.',
    deltas: [{
      kind: 'decision',
      subjectKey: 'scheduler-queue',
      statement: 'The scheduler uses a durable outbox because the storage dependency is now available.',
      status: 'claimed',
      evidence: [{ quote: 'moves to a durable outbox' }],
      supersedes: ['scheduler-queue', 'scheduler-outbox'],
    }],
  }
  const revisionText = 'The storage dependency is now available. The scheduler moves to a durable outbox, superseding the in-memory decision. '
    + 'The deployment review confirmed that the storage service is reachable from the scheduler runtime, the outbox schema is '
    + 'already provisioned, and the retry policy has been exercised in staging. The in-memory queue is no longer the effective '
    + 'decision: it was chosen only because the storage dependency was unavailable. The migration plan is to switch the scheduler '
    + 'to a durable outbox, keep the existing FIFO ordering guarantees, and write each enqueued item to the outbox before '
    + 'acknowledging it. The rollback path remains the in-memory queue, but it is not active. The operational owner has approved '
    + 'the change, and the next deployment should use the durable outbox. This revision supersedes the earlier in-memory decision '
    + 'for the same scheduler queue coordinate. Use a durable outbox for the scheduler queue in the next deployment. '
    + 'The outbox writer will run in the same process as the scheduler, use the existing database connection pool, and preserve '
    + 'the current retry and dead-letter behaviour. The migration is reversible: if the outbox is unavailable, the scheduler falls '
    + 'back to the in-memory queue and records a degraded-mode warning. The on-call runbook has been updated with the new outbox '
    + 'health check, and the deployment checklist now requires a successful outbox smoke test before traffic is shifted.'
  const adapter = new ScriptedEfAdapter(firstPayload)
  const { ctx, errors, plugin } = await mount({
    adapter,
    ef: { bundleRoot, semanticRoot },
  })
  const session = transcriptSession(caseData)
  const signal = new AbortController().signal
  const { locateFoldFrontier } = await import('../../lib/fold/frontier.js')
  let foldError = null
  let firstCheckpoint = ''
  let firstState = null
  let firstDiagnostics = null
  let firstWriterStats = null
  let firstFoldResult = null
  let finalCheckpoint = ''
  let finalState = null
  let finalDiagnostics = null
  let revisionTurn = null
  try {
    let frontier = locateFoldFrontier(session)
    let nodes = [...session.surface.nodes]
    if (nodes[frontier.firstOpenPosition] === undefined) {
      throw new Error('first fold has no open region')
    }
    firstFoldResult = await plugin.engine.compactRegion(
      nodes[frontier.firstOpenPosition],
      nodes[nodes.length - 1],
      { session, options: { provider: PROVIDER, model: MODEL } },
      signal,
    )
    await plugin.engine.reconcileSemantics(session)
    firstCheckpoint = visibleCheckpoint(session)
    firstState = await plugin.engine.committedState?.(session) ?? null
    firstDiagnostics = plugin.engine.semanticDiagnostics ?? null
    firstWriterStats = plugin.engine.semanticWriterStats ?? null

    revisionTurn = appendRevisionTurn(session, revisionText)
    adapter.payload = revisionPayload
    frontier = locateFoldFrontier(session)
    nodes = [...session.surface.nodes]
    if (nodes[frontier.firstOpenPosition] === undefined) {
      throw new Error('second fold has no open region after the revision turn')
    }
    await plugin.engine.compactRegion(
      nodes[frontier.firstOpenPosition],
      nodes[nodes.length - 1],
      { session, options: { provider: PROVIDER, model: MODEL } },
      signal,
    )
    await plugin.engine.reconcileSemantics(session)
    finalCheckpoint = visibleCheckpoint(session)
    finalState = await plugin.engine.committedState?.(session) ?? null
    finalDiagnostics = plugin.engine.semanticDiagnostics ?? null
  } catch (error) {
    foldError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  const anchors = Array.isArray(finalState?.anchors) ? finalState.anchors : []
  const firstAnchors = Array.isArray(firstState?.anchors) ? firstState.anchors : []
  const finalOps = finalDiagnostics?.lastPacket?.ops ?? []
  const journal = await readJournalState(semanticRoot)
  const journalAnchors = journal.anchors ?? []
  const declaredNew = finalOps.some(op => op.op === 'declare'
    && normalizeText(op.anchor?.value).includes('durable outbox'))
  const retiredOld = finalOps.some(op => op.op === 'retire')
  const declaredOldActive = finalOps.some(op => op.op === 'declare'
    && normalizeText(op.anchor?.value).includes('in-memory queue')
    && op.anchor?.lifecycle === 'active')
  const oldActive = journalAnchors.some(anchor => normalizeText(anchor.value).includes('in-memory queue'))
  const newActive = journalAnchors.some(anchor => normalizeText(anchor.value).includes('durable outbox'))
  const staleRejectionActive = journalAnchors.some(anchor =>
    normalizeText(anchor.value).includes('durable outbox is rejected'))
  const firstHasOld = normalizeText(firstCheckpoint).includes('in-memory queue')
  const finalHasNew = normalizeText(finalCheckpoint).includes('durable outbox')
  const finalHasOld = normalizeText(finalCheckpoint).includes('in-memory queue')

  let native = null
  let nativeError = null
  try {
    adapter.calls = 0
    const nativeSessionId = SessionId(`r37d-n5-native-${randomUUID()}`)
    const handle = await ctx.agents.create({
      sessionId: nativeSessionId,
      agentOptions: { provider: PROVIDER, model: MODEL },
      meta: { cwd: workspace },
      setup: agentCtx => { for (const tool of tools(workspace)) agentCtx.tools.register(tool) },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `${finalCheckpoint}\n\nRead hello.txt with read_file.` }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    native = inspectToolEvents(handle.agent.session.snapshotEvents())
    await handle.dispose()
  } catch (error) {
    nativeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  await ctx.dispose?.()
  await rm(root, { recursive: true, force: true })

  const status = foldError === null
    && firstHasOld
    && newActive
    && !oldActive
    && !staleRejectionActive
    && finalHasNew
    && journal.proofValid === true
    && native !== null
    && native.counts.toolCalls === 1
    && native.counts.toolResults === 1
    && native.errorCodes.length === 0
    && nativeError === null ? 'passed' : 'failed'
  return {
    status,
    foldError,
    nativeError,
    revisionTurn,
    firstCheckpointChars: firstCheckpoint.length,
    finalCheckpointChars: finalCheckpoint.length,
    firstHasOld,
    finalHasNew,
    finalHasOld,
    firstAnchors,
    finalAnchors: anchors,
    oldActive,
    newActive,
    staleRejectionActive,
    retiredOld,
    declaredNew,
    finalOps,
    journal,
    firstState,
    finalState,
    firstDiagnostics,
    finalDiagnostics,
    firstWriterStats,
    firstFoldResult,
    native,
    errors,
  }
}

const n3 = await runN3()
const n4 = await runN4()
const n5 = await runN5()
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP5-native-extension',
  packages: {
    agentLoop: '0.2.1-rc.3',
    session: '0.2.1-rc.3',
    tools: '0.2.1-rc.3',
    llm: '0.2.1-rc.3',
    persistence: '0.2.1-rc.3',
  },
  n3,
  n4,
  n5,
  note: 'No provider request was made. The adapter is scripted; the tools are deterministic.',
}
await writeJson(OUT, report)
process.stdout.write(`R37-D native extension: ${OUT}\n`)
process.stdout.write(`N3 ${n3.status}; calls ${n3.counts.toolCalls}/${n3.counts.toolResults}; paired ${n3.paired}; `
  + `write-before-test ${n3.sawWritten}; errors ${n3.counts.errors}\n`)
process.stdout.write(`N4 ${n4.status}; not-started ${n4.notStarted.codes.join(',') || n4.notStarted.recoveryError}; `
  + `started ${n4.started.codes.join(',') || n4.started.recoveryError}\n`)
process.stdout.write(`N5 ${n5.status}: ${n5.reason ?? ''}\n`)
process.exit(n3.status === 'passed' && n4.status === 'passed' ? 0 : 1)
