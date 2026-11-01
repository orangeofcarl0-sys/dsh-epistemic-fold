#!/usr/bin/env node
/**
 * R33 opt-in live entry.
 *
 *   node eval/r33/live.mjs --check
 *   node eval/r33/live.mjs --self-test
 *   R33_LIVE=1 node eval/r33/live.mjs --run --manifest live-manifest.json
 *
 * `--check` never resolves credentials and makes no request. `--self-test`
 * drives the REAL fold host and the REAL tool loop with a scripted adapter, so
 * the plumbing is verified without spending credits. `--run` refuses unless
 * R33_LIVE=1 AND an explicit manifest supplies positive request/input/output/
 * wall-clock limits; those limits are one global ledger shared by the writer
 * call, every follow-up turn, and every retry.
 *
 * The follow-up protocol is one JSON object per model turn:
 *
 *   {"tool":"read_file","path":"src/config.mjs"}
 *   {"tool":"write_file","path":"src/config.mjs","content":"..."}
 *   {"tool":"list_dir"}
 *   {"tool":"run_tests"}
 *   {"tool":"recall","query":"name of localStorage"}
 *   {"tool":"finish","summary":"..."}
 *
 * `recall` searches the FROZEN transcript. It exists in every arm and the
 * system prompt only says history is available; it never names the fact to
 * look for. That is what makes the trigger measurable.
 *
 * @module eval/r33/live
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
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
import { loadDataset, verifyFrozen } from './src/dataset.mjs'
import {
  BudgetExhausted,
  BudgetLedger,
  STATUS_EXIT_CODE,
  loadLiveGate,
  runStatus,
} from './src/budget.mjs'
import {
  fullHistory,
  goldFactsBlock,
  literalSummary,
  scriptedDecision,
  withTask,
} from './src/context.mjs'
import {
  materialize,
  readVerification,
  runChecker,
  runNode,
  runVisibleTests,
} from './src/workspace.mjs'
import { behaviourMetrics, extractionMetrics } from './src/grade.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const SIGNAL = new AbortController().signal

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
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

/** Count every provider call in ONE global ledger, including writer calls. */
class MeteredAdapter extends LlmAdapter {
  constructor(inner, ledger) {
    super()
    this.inner = inner
    this.ledger = ledger
  }

  resolveModel(provider, model) {
    return this.inner.resolveModel(provider, model)
  }

  async *stream(options) {
    const reservation = {
      inputTokens: estimateInputTokens(options),
      outputTokens: options.maxTokens ?? 1024,
    }
    this.ledger.reserve(reservation)
    let usage
    try {
      for await (const chunk of this.inner.stream(options)) {
        if (chunk.type === 'usage') usage = chunk.usage
        yield chunk
      }
    } finally {
      this.ledger.record({ usage, reservation })
    }
  }
}

/** Drive a fixed plan for --self-test; no network, no credential. */
class SelfTestAdapter extends LlmAdapter {
  constructor(model, caseData, plan) {
    super()
    this.model = model
    this.caseData = caseData
    this.plan = plan
    this.calls = 0
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }

  async *stream(options) {
    let text
    if (isWriterCall(options)) {
      text = writerReply(this.caseData.writer.handoff, this.caseData.writer.deltas)
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

function sessionOf(caseData) {
  const session = Session.create(SessionId(`r33-live-${caseData.id}-${randomUUID()}`))
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
          source: { kind: 'model', provider: 'r33-frozen', model: 'r33-frozen' },
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

async function mountHost(adapter, model, root, arm) {
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
    bundleRoot: join(root, 'bundles'),
    semanticRoot: join(root, 'semantic'),
    // Only the S arm exercises the live Semantic Writer. O2/F are the
    // oracle-visible and full-history controls and must not acquire a second
    // semantic path that the corresponding offline arm does not have.
    semanticContinuity: arm === 'S' ? 'active' : 'off',
    semanticMode: 'rationale',
    semanticWorkingSetTokens: 2048,
    semanticCheckpointTokens: 8192,
  })
  return { ctx, plugin, locateFoldFrontier }
}

async function foldCase(caseData, workspaceRoot, host, model) {
  const session = sessionOf(caseData)
  const agent = { session, options: { provider: model, model } }
  const frontier = host.locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
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
  return { session, checkpoint: visibleCheckpoint(session), fold: foldEvidence(session) }
}

function armContext(arm, caseData, checkpoint) {
  if (arm === 'O2') return withTask(goldFactsBlock(caseData.gold), caseData.task)
  if (arm === 'F') return withTask(fullHistory(caseData.transcript), caseData.task)
  return withTask(checkpoint, caseData.task)
}

function systemPrompt(caseData, arm) {
  return [
    'You are continuing a software task after a context compaction.',
    `Risk under evaluation: ${caseData.riskClass}.`,
    'Your memory of the earlier conversation is the context below.',
    'You may use these tools by replying with EXACTLY ONE JSON object per turn:',
    '  {"tool":"read_file","path":"..."}',
    '  {"tool":"write_file","path":"...","content":"..."}',
    '  {"tool":"list_dir"}',
    '  {"tool":"run_tests"}',
    '  {"tool":"recall","query":"..."}',
    '  {"tool":"finish","summary":"..."}',
    'The workspace is the current directory. `run_tests` runs the visible suite.',
    '`recall` searches the original pre-compaction history, in case the answer you need is not in the context. Use it when you notice a gap.',
    'Do not claim a test was run unless you ran it. Finish only when the task is done.',
    arm === 'O2' ? 'The facts above were provided directly by the evaluation.' : '',
  ].filter(line => line.length > 0).join('\n')
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

function safePath(root, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return undefined
  return join(root, ...path.split('/'))
}

async function listWorkspace(root) {
  const result = await runNode(['-e', 'const fs=require("fs");function w(d,p){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==="node_modules")continue;const f=p?p+"/"+e.name:e.name;if(e.isDirectory())w(d+"/"+e.name,f);else console.log(f)}}w(process.cwd(),"")'], {
    cwd: root,
    timeoutMs: 10_000,
  })
  return result.stdout.trim()
}

function recall(caseData, query) {
  const needle = String(query ?? '').toLowerCase()
  if (needle.length === 0) return { matches: 0, text: 'recall needs a non-empty query' }
  const matches = []
  for (const [index, entry] of caseData.transcript.entries()) {
    if (!entry.text.toLowerCase().includes(needle)) continue
    matches.push({ index, role: entry.role, name: entry.name, text: entry.text.slice(0, 500) })
    if (matches.length >= 3) break
  }
  return {
    matches: matches.length,
    text: matches.length === 0
      ? 'no matching history'
      : matches.map(entry => `[${entry.index}] ${entry.role}${entry.name === undefined ? '' : `:${entry.name}`}: ${entry.text}`).join('\n'),
  }
}

async function followUp({ adapter, model, caseData, arm, checkpoint, workspaceRoot, maxSteps, ledger }) {
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: `${armContext(arm, caseData, checkpoint)}\n\nBEGIN THE TASK.` }],
  }]
  const system = systemPrompt(caseData, arm)
  let toolCalls = 0
  let testsExecuted = 0
  let recallAttempts = 0
  let recallSuccess = 0
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
      trace.push({ step: steps, error: error instanceof Error ? error.message : String(error) })
      return { steps, toolCalls, testsExecuted, recallAttempts, recallSuccess, finished, summary, trace }
    }
    trace.push({ step: steps, text: text.slice(0, 1000), usage, finishReason })
    const action = parseAction(text)
    if (action === undefined || typeof action.tool !== 'string') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Reply with exactly one JSON tool object.' }] })
      continue
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    toolCalls += 1
    if (action.tool === 'finish') {
      finished = true
      summary = String(action.summary ?? '')
      break
    }
    if (action.tool === 'read_file') {
      const target = safePath(workspaceRoot, action.path)
      let content
      try {
        content = target === undefined ? 'invalid path' : await readFile(target, 'utf8')
      } catch (error) {
        content = `read failed: ${error instanceof Error ? error.message : String(error)}`
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: `TOOL RESULT read_file:\n${content.slice(0, 12_000)}` }] })
      continue
    }
    if (action.tool === 'write_file') {
      const target = safePath(workspaceRoot, action.path)
      try {
        if (target === undefined) throw new Error('invalid path')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, String(action.content ?? ''), 'utf8')
        messages.push({ role: 'user', content: [{ type: 'text', text: `TOOL RESULT write_file: wrote ${action.path}` }] })
      } catch (error) {
        messages.push({ role: 'user', content: [{ type: 'text', text: `TOOL RESULT write_file: failed: ${error instanceof Error ? error.message : String(error)}` }] })
      }
      continue
    }
    if (action.tool === 'list_dir') {
      messages.push({ role: 'user', content: [{ type: 'text', text: `TOOL RESULT list_dir:\n${await listWorkspace(workspaceRoot)}` }] })
      continue
    }
    if (action.tool === 'run_tests') {
      testsExecuted += 1
      const result = await runVisibleTests(workspaceRoot)
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `TOOL RESULT run_tests (exit ${result.exitCode}):\n${result.stdout.slice(-8_000)}\n${result.stderr.slice(-2_000)}` }],
      })
      continue
    }
    if (action.tool === 'recall') {
      recallAttempts += 1
      const result = recall(caseData, action.query)
      if (result.matches > 0) recallSuccess += 1
      messages.push({ role: 'user', content: [{ type: 'text', text: `TOOL RESULT recall:\n${result.text}` }] })
      continue
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: `TOOL RESULT: unknown tool ${action.tool}` }] })
  }
  return { steps, toolCalls, testsExecuted, recallAttempts, recallSuccess, finished, summary, trace, ledger: ledger.snapshot() }
}

async function runOne({ caseData, arm, mode, adapter, model, root, manifest, ledger }) {
  const workspaceRoot = join(root, `${caseData.id}-${arm}`, 'workspace')
  await materialize(caseData.workspace.files, workspaceRoot)
  const host = await mountHost(adapter, model, join(root, `${caseData.id}-${arm}`, 'host'), arm)
  const started = ledger.snapshot()
  const { checkpoint, fold } = await foldCase(caseData, workspaceRoot, host, model)
  if (!fold.valid) {
    return {
      caseId: caseData.id,
      arm,
      mode,
      valid: false,
      reason: 'no-fold',
      fold,
      taskSuccess: false,
    }
  }
  const follow = await followUp({
    adapter,
    model,
    caseData,
    arm,
    checkpoint,
    workspaceRoot,
    maxSteps: manifest?.followUpSteps ?? 8,
    ledger,
  })
  const checker = await runChecker(caseData, workspaceRoot)
  const verification = await readVerification(workspaceRoot)
  const behaviour = behaviourMetrics(caseData, {
    checker,
    decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
    verification,
    testsExecuted: follow.testsExecuted,
  })
  const after = ledger.snapshot()
  return {
    caseId: caseData.id,
    arm,
    mode,
    valid: checker.status === 'executed',
    fold,
    checkpointChars: checkpoint.length,
    extraction: extractionMetrics(caseData, {
      accepted: undefined,
      refused: undefined,
      writer: undefined,
      checkpoint,
      anchorValues: [],
    }),
    behaviour: {
      ...behaviour,
      toolCalls: follow.toolCalls,
      steps: follow.steps,
      finished: follow.finished,
      summary: follow.summary,
      recallAttempts: follow.recallAttempts,
      recallSuccess: follow.recallSuccess,
      checkerChecks: checker.checks,
      trace: follow.trace,
    },
    cost: {
      modelRequests: after.used.requests - started.used.requests,
      inputTokens: after.used.inputTokens - started.used.inputTokens,
      outputTokens: after.used.outputTokens - started.used.outputTokens,
      cacheReadTokens: after.used.cacheReadTokens - started.used.cacheReadTokens,
      cacheWriteTokens: after.used.cacheWriteTokens - started.used.cacheWriteTokens,
      unknownUsage: after.used.unknownUsage - started.used.unknownUsage,
      wallClockMs: ledger.elapsedMs(),
    },
  }
}

async function writeReport(name, report) {
  await mkdir(OUT, { recursive: true })
  const path = join(OUT, name)
  await writeFile(path, json(report), 'utf8')
  return path
}

function selectCases(cases, requested) {
  if (requested === undefined || requested.length === 0) return cases
  const ids = requested.split(',').map(id => id.trim()).filter(Boolean)
  return cases.filter(entry => ids.includes(entry.id))
}

async function runScriptedSelfTest(cases) {
  const rows = []
  for (const caseData of cases) {
    const correct = scriptedDecision(caseData, goldFactsBlock(caseData.gold))
    const action = caseData.actions[correct.action]
    const readTarget = Object.keys(caseData.workspace.files).find(path => path.startsWith('src/'))
    const plan = [
      { tool: 'list_dir' },
      readTarget === undefined ? { tool: 'list_dir' } : { tool: 'read_file', path: readTarget },
      ...Object.entries(action.files ?? {}).map(([path, content]) => ({ tool: 'write_file', path, content })),
      { tool: 'run_tests' },
      { tool: 'finish', summary: 'self-test complete' },
    ]
    const adapter = new SelfTestAdapter('r33-self-test', caseData, plan)
    const ledger = new BudgetLedger({ requests: 1000, inputTokens: 10_000_000, outputTokens: 1_000_000, wallClockMs: 600_000 })
    const row = await runOne({
      caseData,
      arm: 'O2',
      mode: 'self-test',
      adapter,
      model: 'r33-self-test',
      root: join(HERE, 'out', 'self-test-work'),
      manifest: { followUpSteps: 12 },
      ledger,
    })
    rows.push(row)
  }
  const valid = rows.filter(row => row.valid)
  const success = valid.filter(row => row.behaviour.taskSuccess)
  return {
    schemaVersion: 1,
    status: rows.length > 0 && success.length === rows.length ? 'executed-success'
      : valid.length === 0 ? 'executed-failed' : 'executed-partial',
    executionKind: 'self-test (scripted adapter; verifies plumbing, not model behavior)',
    generatedAt: new Date().toISOString(),
    rows,
    summary: { cases: rows.length, valid: valid.length, success: success.length },
  }
}

async function runtimeFromManifest(manifest) {
  const { OpenAiCompatibleAdapter } = await import('../live/openai-adapter.ts')
  const route = manifest.route ?? {}
  const baseUrl = route.baseUrlEnv === undefined ? undefined : process.env[route.baseUrlEnv]
  const apiKey = route.apiKeyEnv === undefined ? undefined : process.env[route.apiKeyEnv]
  if (baseUrl === undefined || baseUrl.length === 0 || apiKey === undefined || apiKey.length === 0) {
    return { unavailable: 'route env vars are not set; expected manifest.route.baseUrlEnv and apiKeyEnv' }
  }
  const inner = new OpenAiCompatibleAdapter({
    baseUrl,
    apiKey,
    model: manifest.model,
    ...(route.headers === undefined ? {} : { headers: route.headers }),
  })
  return { inner }
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

  if (checkOnly) {
    const audience = {
      status: 'interface-ok',
      datasetDigest,
      cases: cases.length,
      caseIds: cases.map(entry => entry.id),
      arms: ['S', 'O2'],
      followUpTools: ['read_file', 'write_file', 'list_dir', 'run_tests', 'recall', 'finish'],
      runRequires: ['R33_LIVE=1', '--manifest with positive requests/inputTokens/outputTokens/wallClockMs'],
      note: '--check resolves no credentials and makes no request.',
    }
    const path = await writeReport('live-check.json', audience)
    process.stdout.write(`${JSON.stringify(audience, null, 2)}\n${path}\n`)
    process.exit(0)
  }

  if (selfTest) {
    const report = await runScriptedSelfTest(cases)
    const path = await writeReport('self-test-report.json', report)
    process.stdout.write(`${report.status}: ${report.summary.success}/${report.summary.cases} cases passed\n${path}\n`)
    process.exit(STATUS_EXIT_CODE[report.status] ?? 7)
  }

  const gate = await loadLiveGate(argValue('--manifest'), process.env)
  if (!gate.ok) {
    const report = {
      schemaVersion: 1,
      status: 'not-executed',
      reason: gate.reason,
      datasetDigest,
      cases: cases.length,
      generatedAt: new Date().toISOString(),
      note: 'No provider request was attempted.',
    }
    const path = await writeReport('live-report.json', report)
    process.stdout.write(`${report.status}: ${report.reason}\n${path}\n`)
    process.exit(STATUS_EXIT_CODE['not-executed'])
  }
  const manifest = gate.manifest
  const runtime = await runtimeFromManifest(manifest)
  if (runtime.unavailable !== undefined) {
    const report = {
      schemaVersion: 1,
      status: 'provider-unavailable',
      reason: runtime.unavailable,
      datasetDigest,
      generatedAt: new Date().toISOString(),
      note: 'No provider request was attempted.',
    }
    const path = await writeReport('live-report.json', report)
    process.stdout.write(`${report.status}: ${report.reason}\n${path}\n`)
    process.exit(STATUS_EXIT_CODE['provider-unavailable'])
  }

  const selected = selectCases(cases, manifest.cases ?? argValue('--cases'))
  const arms = (manifest.arms ?? argValue('--arms') ?? 'S,O2').split(',').map(arm => arm.trim())
  const ledger = new BudgetLedger(manifest.limits)
  const adapter = new MeteredAdapter(runtime.inner, ledger)
  const rows = []
  let budgetExhausted = false
  for (const caseData of selected) {
    for (const arm of arms) {
      try {
        rows.push(await runOne({
          caseData,
          arm,
          mode: 'live',
          adapter,
          model: manifest.model,
          root: join(HERE, 'out', 'live-work'),
          manifest,
          ledger,
        }))
      } catch (error) {
        if (error instanceof BudgetExhausted) {
          budgetExhausted = true
          break
        }
        rows.push({
          caseId: caseData.id,
          arm,
          mode: 'live',
          valid: false,
          reason: error instanceof Error ? error.message : String(error),
          taskSuccess: false,
        })
      }
    }
    if (budgetExhausted) break
  }
  const status = runStatus({
    executed: true,
    cases: rows,
    budgetExhausted,
    providerUnavailable: rows.length === 0,
    invalid: false,
  })
  const report = {
    schemaVersion: 1,
    status,
    datasetDigest,
    generatedAt: new Date().toISOString(),
    model: manifest.model,
    routeEnv: manifest.route ?? null,
    limits: manifest.limits,
    ledger: ledger.snapshot(),
    rows,
    summary: {
      cases: rows.length,
      valid: rows.filter(row => row.valid).length,
      success: rows.filter(row => row.behaviour?.taskSuccess).length,
    },
  }
  const path = await writeReport('live-report.json', report)
  process.stdout.write(`${status}: ${report.summary.success}/${report.summary.cases} cases passed\n${path}\n`)
  process.exit(STATUS_EXIT_CODE[status] ?? 7)
}

await main()
