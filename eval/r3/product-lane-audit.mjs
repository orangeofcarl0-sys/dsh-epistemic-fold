#!/usr/bin/env node
/**
 * EF-R3 product-lane — offline task exposure audit at the proposed 32k window.
 *
 * The R2 tasks were designed for 16k. Before a product-lane pilot, this script
 * asks a narrower question than task quality: at 32k, under the shipped economy
 * preset, does the seeded history cross the fold threshold and reach the fold
 * path at all? It uses a scripted summarizer and makes no provider request.
 *
 *   node eval/r3/product-lane-audit.mjs
 *
 * @module eval/r3/product-lane-audit
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createSeededAgent, disposeHost, mountHost } from '../e2e/src/host.mjs'
import { buildSeed } from '../e2e/src/seed.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const SIGNAL = new AbortController().signal
const CONTEXT_WINDOW = 32_768
const THRESHOLD_RATIO = 0.5
const RETAIN_RATIO = 0.16
const MAX_TOKENS = 1_024

const TASK_FILES = [
  'T11-p1',
  'T12-p1',
  'T13-p1',
  'T14-p1',
  'T15-p1',
  'T16-p1',
  'T16-s1',
  'T16-s2',
]
const taskPath = taskId => taskId.endsWith('-p1') || taskId.endsWith('-p2')
  ? join(ROOT, 'eval', 'e2e', 'tasks-r3', `${taskId}.json`)
  : join(ROOT, 'eval', 'e2e', 'tasks-r2', `${taskId}.json`)

class ScriptedSummaryAdapter extends LlmAdapter {
  constructor(text, contextWindow) {
    super()
    this.text = text
    this.contextWindow = contextWindow
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
    if (options.purpose === 'compaction') {
      const text = this.text
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const CHECKPOINT_TEXT = `## Primary Request\n- product-lane exposure audit\n\n## Key Technical Concepts\n- ${'x'.repeat(1_600)}\n`

function productConfig(arm) {
  return {
    mode: 'economy',
    semanticMode: arm === 'E1' ? 'rationale' : 'none',
    framingMode: 'system-dedup',
    leafAdmission: 'economic',
    rootPolicy: 'economics',
    semanticContinuity: 'off',
    rationaleHintTokens: 400,
    retainRatio: RETAIN_RATIO,
    headroomTokens: 512,
    maxTokens: MAX_TOKENS,
  }
}

async function auditCase(task, arm) {
  const workRoot = mkdtempSync(join(tmpdir(), `ef-r3-pl-audit-${task.id}-${arm}-`))
  const workspace = join(workRoot, 'workspace')
  const roots = { bundleRoot: join(workRoot, 'bundles'), semanticRoot: join(workRoot, 'semantic') }
  mkdirSync(workspace, { recursive: true })
  mkdirSync(roots.bundleRoot, { recursive: true })
  mkdirSync(roots.semanticRoot, { recursive: true })
  const adapter = new ScriptedSummaryAdapter(CHECKPOINT_TEXT, CONTEXT_WINDOW)
  let host = null
  let handle = null
  try {
    host = await mountHost({
      arm,
      adapter,
      model: 'audit-model',
      workspace,
      roots,
      persistenceRoot: null,
      thresholdRatio: THRESHOLD_RATIO,
      efConfig: productConfig(arm),
    })
    const sessionId = `ef-r3-pl-audit-${task.id}-${arm}`
    const seed = buildSeed(task.history, {
      provider: host.provider,
      model: 'audit-model',
      maxTokens: MAX_TOKENS,
      sessionId: `seed-${sessionId}`,
    })
    ;({ handle } = await createSeededAgent(host, {
      sessionId,
      seed,
      workspace,
      maxSteps: 8,
    }))
    // The seed ends with a closed turn. Automatic compaction appends its
    // transaction events inside an open turn, so open one with the task
    // request WITHOUT starting the agent loop. This is the same surface the
    // live runner has after the task prompt is accepted.
    let turn = 0
    for (const event of handle.agent.session.snapshotEvents()) {
      if (event.type === 'turn/start') turn = Math.max(turn, event.data.turn)
    }
    turn += 1
    handle.agent.session.append('turn/start', { turn })
    handle.agent.session.append('step/start', { turn, step: 1 })
    handle.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: task.task }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const before = host.ctx.tokenMeter.measure(handle.agent.session)
    let outcome = 'returned'
    let error = null
    try {
      const result = await host.plugin.engine.compactIfNeeded(handle.agent, 'pressure', SIGNAL)
      outcome = result === null ? 'returned-null' : 'returned-result'
    } catch (caught) {
      outcome = 'threw'
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const after = host.ctx.tokenMeter.measure(handle.agent.session)
    return {
      taskId: task.id,
      template: task.template,
      seedInstance: task.seed,
      arm,
      contextWindow: CONTEXT_WINDOW,
      thresholdTokens: Math.floor(CONTEXT_WINDOW * THRESHOLD_RATIO),
      seedTokens: before.totalTokens,
      afterTokens: after.totalTokens,
      aboveThreshold: before.totalTokens >= Math.floor(CONTEXT_WINDOW * THRESHOLD_RATIO),
      outcome,
      error,
      leafFolds: host.plugin.engine.leafFoldCount,
      lastLeafDecision: host.plugin.engine.lastLeafDecision,
      admission: host.plugin.engine.lastLeafAdmission ?? null,
      probe: host.plugin.engine.lastLeafSpanProbe ?? null,
    }
  } finally {
    if (handle !== null) await handle.dispose().catch(() => {})
    if (host !== null) await disposeHost(host)
    rmSync(workRoot, { recursive: true, force: true })
  }
}

async function main() {
  const cases = []
  for (const taskId of TASK_FILES) {
    const task = readJson(taskPath(taskId))
    for (const arm of ['E0', 'E1']) {
      cases.push(await auditCase(task, arm))
    }
  }
  const foldAttempts = cases.filter(entry => entry.probe !== null || entry.leafFolds > 0)
  const committed = cases.filter(entry => entry.leafFolds > 0)
  const refused = cases.filter(entry => entry.outcome === 'threw')
  const below = cases.filter(entry => entry.aboveThreshold === false)
  const byTask = Object.fromEntries(TASK_FILES.map(taskId => {
    const subset = cases.filter(entry => entry.taskId === taskId)
    return [taskId, {
      cases: subset.length,
      seedTokens: subset.map(entry => entry.seedTokens),
      foldAttempts: subset.filter(entry => entry.probe !== null || entry.leafFolds > 0).length,
      committed: subset.filter(entry => entry.leafFolds > 0).length,
      refused: subset.filter(entry => entry.outcome === 'threw').length,
      belowThreshold: subset.filter(entry => entry.aboveThreshold === false).length,
    }]
  }))
  const suitableTaskIds = TASK_FILES.filter(taskId => {
    const subset = cases.filter(entry => entry.taskId === taskId)
    return subset.length > 0
      && subset.every(entry => entry.aboveThreshold)
      && subset.some(entry => entry.leafFolds > 0)
  })
  const unsuitableTaskIds = TASK_FILES.filter(taskId => !suitableTaskIds.includes(taskId))
  const output = {
    schemaVersion: 1,
    work: 'EF-R3 product-lane',
    generatedAt: new Date().toISOString(),
    contextWindow: CONTEXT_WINDOW,
    thresholdTokens: Math.floor(CONTEXT_WINDOW * THRESHOLD_RATIO),
    retainRatio: RETAIN_RATIO,
    framingMode: 'system-dedup',
    arms: ['E0', 'E1'],
    tasks: TASK_FILES,
    counts: {
      cases: cases.length,
      aboveThreshold: cases.filter(entry => entry.aboveThreshold).length,
      belowThreshold: below.length,
      foldAttempts: foldAttempts.length,
      committed: committed.length,
      refused: refused.length,
      suitableTasks: suitableTaskIds.length,
      unsuitableTasks: unsuitableTaskIds.length,
    },
    byTask,
    suitableTaskIds,
    unsuitableTaskIds,
    cases,
    conclusion: {
      tasksSuitableForPilot: suitableTaskIds.length >= 6,
      note: suitableTaskIds.length >= 6
        ? 'At least six audited tasks cross the 32k threshold and commit a fold. The pilot can use them.'
        : 'Fewer than six audited tasks commit a fold at 32k. Generate or adjust instances before the pilot.',
    },
    note: 'Keyless audit. The summarizer returns a fixed checkpoint text; this measures exposure and the fold path, not task quality or model behaviour.',
  }
  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, 'product-lane-exposure-audit.json')
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`product-lane audit: ${cases.length} cases; ${output.counts.aboveThreshold} above threshold, ${output.counts.foldAttempts} fold attempts, ${output.counts.committed} committed, ${output.counts.refused} refused\n`)
  for (const [taskId, row] of Object.entries(byTask)) {
    process.stdout.write(`  ${taskId}: seed ${row.seedTokens.join('/')} tokens; folds ${row.foldAttempts}, commits ${row.committed}, refused ${row.refused}\n`)
  }
  process.stdout.write(`  suitable=${output.conclusion.tasksSuitableForPilot}; suitable tasks: ${suitableTaskIds.join(', ')}\n`)
  process.stdout.write(`  unsuitable tasks: ${unsuitableTaskIds.join(', ') || '(none)'}\n`)
  process.stdout.write(`wrote ${path}\n`)
}

main().catch(error => {
  process.stderr.write(`product-lane audit failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
