#!/usr/bin/env node
/**
 * R37-C1-C: native DSH agent/tool lifecycle smoke.
 *
 * N0 uses the REAL `@deepseek-ai/dsh-agent-loop` driver, the REAL AgentRegistry,
 * the REAL ToolRuntime, a scripted model adapter, and one deterministic
 * read-only tool. It makes no provider request and mounts no EF plugin.
 *
 * N1 repeats N0 with JSONL session persistence, disposes the first host,
 * resumes the same session, and verifies the tool call/result pair and the
 * absence of a synthetic TOOL_NOT_STARTED repair.
 *
 * N2 (EF integration) is only attempted when N0 and N1 pass; otherwise it is
 * recorded as blocked with the exact lower-layer failure.
 *
 *   node eval/r37c/native-smoke.mjs
 *
 * @module eval/r37c/native-smoke
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { TOOL_RUNTIME_SCHEDULER, ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { apply as applyJsonlPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env['R37C_NATIVE_OUT'] ?? join(HERE, 'out', 'native-smoke.json')
const MODEL = 'r37c-scripted-native'
const PROVIDER = 'r37c-scripted'

class ScriptedToolAdapter extends LlmAdapter {
  constructor(writerPayload = null) {
    super()
    this.calls = 0
    this.writerPayload = writerPayload
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
    })
  }

  async *stream(options) {
    const last = options?.messages?.[options.messages.length - 1]
    const writerCall = this.writerPayload !== null && last?.content?.some(block =>
      block.type === 'text' && typeof block.text === 'string'
      && block.text.startsWith('You are the SEMANTIC WRITER'))
    if (writerCall) {
      const text = `<handoff>\n${this.writerPayload.handoff}\n</handoff>\n`
        + `<deltas>\n${JSON.stringify({ deltas: this.writerPayload.deltas })}\n</deltas>`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.calls += 1
    if (this.calls === 1) {
      const id = ToolCallId('call-read-1')
      const args = JSON.stringify({ path: 'hello.txt' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'read_file', argumentsDelta: args }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'read_file', arguments: args },
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'Native tool lifecycle complete.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function readTool() {
  return defineTool({
    name: 'read_file',
    description: 'Read one deterministic file from the smoke workspace.',
    parameters: { path: { type: 'string', description: 'file path' } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { path: args.path, content: 'native smoke: hello', bytes: 20 }
    },
    isConcurrencySafe: () => true,
  })
}

async function mount({ persistenceRoot = null, ef = null, writerPayload = null } = {}) {
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
  const adapter = new ScriptedToolAdapter(writerPayload)
  const errors = []
  ctx.on('agent/error', payload => {
    errors.push({
      turn: payload?.turn ?? null,
      step: payload?.step ?? null,
      name: payload?.error?.name ?? null,
      message: payload?.error?.message ?? String(payload?.error ?? ''),
      code: payload?.error?.code ?? null,
      stack: payload?.error?.stack ?? null,
    })
    if (process.env.R37C_NATIVE_DEBUG === '1') {
      process.stderr.write(`native-debug agent/error: ${payload?.error?.stack ?? String(payload?.error)}\n`)
    }
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  if (process.env.R37C_NATIVE_DEBUG === '1') {
    for (const method of ['executionMode', 'register', 'prepare']) {
      const original = ctx.tools[method]?.bind(ctx.tools)
      if (original === undefined) continue
      ctx.tools[method] = (...args) => {
        try {
          return original(...args)
        } catch (error) {
          process.stderr.write(`native-debug ${method}: ${error instanceof Error ? error.stack : String(error)}\n`)
          throw error
        }
      }
    }
    const requireInitiator = ctx.agents.requireInitiator.bind(ctx.agents)
    ctx.agents.requireInitiator = () => {
      try {
        return requireInitiator()
      } catch (error) {
        process.stderr.write(`native-debug requireInitiator: ${error instanceof Error ? error.stack : String(error)}\n`)
        throw error
      }
    }
    const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
    for (const method of ['prepare', 'dispatch', 'finish', 'finalize']) {
      const original = scheduler?.[method]?.bind(scheduler)
      if (original === undefined) continue
      scheduler[method] = (...args) => {
        try {
          const value = original(...args)
          if (value instanceof Promise) {
            return value.catch(error => {
              process.stderr.write(`native-debug scheduler.${method}: ${error instanceof Error ? error.stack : String(error)}\n`)
              throw error
            })
          }
          return value
        } catch (error) {
          process.stderr.write(`native-debug scheduler.${method}: ${error instanceof Error ? error.stack : String(error)}\n`)
          throw error
        }
      }
    }
  }
  return { ctx, adapter, errors, plugin }
}

function eventSummary(events) {
  return events.map(event => ({
    seq: Number(event.seq),
    type: event.type,
    ...(event.type === 'tool/call' ? { name: event.data?.name, callId: event.data?.callId } : {}),
    ...(event.type === 'tool/result' ? { callId: event.data?.message?.source?.callId ?? event.data?.callId } : {}),
    ...(event.type === 'tool/result' && event.data?.error !== undefined ? { error: event.data.error } : {}),
    ...(event.type === 'assistant/message' ? { blocks: event.data?.message?.content ?? null } : {}),
  }))
}

function inspect(events) {
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  const assistant = events.filter(event => event.type === 'assistant/message')
  const repairs = results.filter(event =>
    event.data?.error?.code === 'TOOL_NOT_STARTED'
    || event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN')
  return {
    events: eventSummary(events),
    counts: {
      toolCalls: calls.length,
      toolResults: results.length,
      assistantMessages: assistant.length,
      repairs: repairs.length,
    },
    ordering: calls.length === 1 && results.length === 1
      ? Number(calls[0].seq) < Number(results[0].seq)
      : false,
    repairCodes: repairs.map(event => event.data?.error?.code ?? null),
  }
}

async function runN0() {
  const workspace = await mkdtemp(join(tmpdir(), 'r37c-native-n0-'))
  const { ctx, adapter, errors } = await mount()
  const sessionId = SessionId(`r37c-n0-${randomUUID()}`)
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: PROVIDER, model: MODEL },
    meta: { cwd: workspace },
    setup: agentCtx => { agentCtx.tools.register(readTool()) },
  })
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Read hello.txt with read_file, then finish.' }],
    source: { kind: 'user' },
  }))
  await handle.agent.whenIdle()
  const events = handle.agent.session.snapshotEvents()
  const result = inspect(events)
  await handle.dispose()
  await ctx.dispose?.()
  await rm(workspace, { recursive: true, force: true })
  return {
    status: result.counts.toolCalls === 1 && result.counts.toolResults === 1
      && result.ordering && result.counts.repairs === 0 ? 'passed' : 'failed',
    adapterCalls: adapter.calls,
    sessionId: String(sessionId),
    errors,
    ...result,
  }
}

async function runN1() {
  const workspace = await mkdtemp(join(tmpdir(), 'r37c-native-n1-'))
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'r37c-native-n1-store-'))
  const sessionId = SessionId(`r37c-n1-${randomUUID()}`)
  let first
  {
    const { ctx } = await mount({ persistenceRoot })
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: PROVIDER, model: MODEL },
      meta: { cwd: workspace },
      setup: agentCtx => { agentCtx.tools.register(readTool()) },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Read hello.txt with read_file, then finish.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    first = inspect(handle.agent.session.snapshotEvents())
    await handle.dispose()
    await ctx.dispose?.()
  }
  let second
  {
    const { ctx } = await mount({ persistenceRoot })
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: PROVIDER, model: MODEL },
      setup: agentCtx => { agentCtx.tools.register(readTool()) },
    })
    second = inspect(handle.agent.session.snapshotEvents())
    await handle.dispose()
    await ctx.dispose?.()
  }
  const files = await readFile(join(persistenceRoot, 'sessions.jsonl'), 'utf8').catch(() => null)
  await rm(workspace, { recursive: true, force: true })
  await rm(persistenceRoot, { recursive: true, force: true })
  return {
    status: first.counts.toolCalls === 1 && first.counts.toolResults === 1
      && second.counts.toolCalls === 1 && second.counts.toolResults === 1
      && second.counts.repairs === 0 && second.ordering ? 'passed' : 'failed',
    first,
    second,
    persistedBytes: files === null ? 0 : files.length,
  }
}

function transcriptSession(caseData) {
  const session = Session.create(SessionId(`r37c-native-${caseData.id}-${randomUUID()}`))
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
          source: { kind: 'model', provider: 'r37c-native', model: 'r37c-native' },
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
          source: { kind: 'model', provider: 'r37c-native', model: 'r37c-native' },
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

async function runN2() {
  const caseData = JSON.parse(await readFile(join(HERE, '..', 'r33', 'cases', 'B2', 'case.json'), 'utf8'))
  const root = await mkdtemp(join(tmpdir(), 'r37c-native-n2-'))
  const bundleRoot = join(root, 'bundles')
  const semanticRoot = join(root, 'journal')
  await mkdir(bundleRoot, { recursive: true })
  await mkdir(semanticRoot, { recursive: true })
  const { ctx, errors, plugin } = await mount({
    ef: { bundleRoot, semanticRoot },
    writerPayload: { handoff: caseData.writer.handoff, deltas: caseData.writer.deltas },
  })
  const session = transcriptSession(caseData)
  const { locateFoldFrontier } = await import('../../lib/fold/frontier.js')
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const signal = new AbortController().signal
  let foldError = null
  try {
    await plugin.engine.compactRegion(
      nodes[frontier.firstOpenPosition],
      nodes[nodes.length - 1],
      { session, options: { provider: PROVIDER, model: MODEL } },
      signal,
    )
  } catch (error) {
    foldError = error instanceof Error ? error.message : String(error)
  }
  await plugin.engine.reconcileSemantics(session)
  const checkpoint = visibleCheckpoint(session)
  const factVisible = checkpoint.includes('in-memory queue')
  const state = await plugin.engine.committedState?.(session) ?? null
  const sessionId = SessionId(`r37c-n2-native-${randomUUID()}`)
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: PROVIDER, model: MODEL },
    setup: agentCtx => { agentCtx.tools.register(readTool()) },
  })
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: `${checkpoint}\n\nRead hello.txt with read_file, then finish.` }],
    source: { kind: 'user' },
  }))
  await handle.agent.whenIdle()
  const native = inspect(handle.agent.session.snapshotEvents())
  await handle.dispose()
  await ctx.dispose?.()
  await rm(root, { recursive: true, force: true })
  return {
    status: foldError === null && factVisible && native.counts.toolCalls === 1
      && native.counts.toolResults === 1 && native.counts.repairs === 0 ? 'passed' : 'failed',
    foldError,
    checkpointChars: checkpoint.length,
    factVisible,
    state,
    native,
    errors,
  }
}

const n0 = await runN0()
const n1 = n0.status === 'passed' ? await runN1() : { status: 'blocked', reason: 'N0 failed' }
const n2 = n0.status === 'passed' && n1.status === 'passed'
  ? await runN2()
  : { status: 'blocked', reason: 'N2 requires N0 and N1 to pass first' }
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C1-C',
  packages: {
    agentLoop: '0.2.1-rc.3',
    session: '0.2.1-rc.3',
    tools: '0.2.1-rc.3',
    llm: '0.2.1-rc.3',
    persistence: '0.2.1-rc.3',
  },
  rootCause: {
    symptom: 'TOOL_NOT_STARTED',
    diagnosis: 'AgentLoop was constructed with a plain number for maxParallelToolCalls. '
      + 'The service reads ctx.agentLoop.config.maxParallelToolCalls.get(); a manual host must '
      + 'pass a volatile cell, not a bare number.',
    fix: 'createVolatile(1) from @deepseek-ai/cosmokit',
    scope: 'native host construction, not the tool runtime or the EF integration',
  },
  n0,
  n1,
  n2,
  note: 'No provider request was made. The adapter is scripted; the tools are deterministic.',
}
await writeJson(OUT, report)
process.stdout.write(`R37-C native smoke: ${OUT}\n`)
process.stdout.write(`N0 ${n0.status}; calls ${n0.adapterCalls}; tool ${n0.counts.toolCalls}/${n0.counts.toolResults}; repairs ${n0.counts.repairs}\n`)
process.stdout.write(`N1 ${n1.status}; ${n1.reason ?? `first ${JSON.stringify(n1.first?.counts)} second ${JSON.stringify(n1.second?.counts)}`}\n`)
process.stdout.write(`N2 ${n2.status}: ${n2.reason}\n`)
process.exit(n0.status === 'passed' ? 0 : 1)
