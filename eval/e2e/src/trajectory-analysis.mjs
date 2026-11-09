#!/usr/bin/env node
/**
 * Trajectory and behaviour analysis over the executed campaigns.
 *
 * The E2E reports already carry counts. This script answers the next question:
 * WHAT did the model actually do, and which differences explain a cell flipping
 * between campaigns?
 *
 * Two evidence sources, and the difference matters:
 *
 *   report.json `trajectory`   ordered, real log events (new cells only)
 *   report.json `requests`     the request deltas (every cell)
 *
 * The 71 pre-trajectory cells have no ordered event list, so their action
 * sequence is reconstructed from the request deltas and the tool counts. That
 * is stated in the output, not hidden.
 *
 *   node eval/e2e/src/trajectory-analysis.mjs
 *
 * @module eval/e2e/src/trajectory-analysis
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = join(ROOT, 'eval', 'e2e', 'out')
const RUNS = join(ROOT, 'eval', 'e2e', 'runs')

const CAMPAIGNS = ['e2e-core-1', 'e2e-pilot-1', 'e2e-t5-retest-1', 'e2e-recall-1', 'e2e-guard-smoke-1', 'e2e-index-1']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function toolCount(report, name) {
  return report.tools?.byName?.[name] ?? 0
}

/** A coarse action list from the request deltas, for pre-trajectory cells. */
function reconstructedActions(report) {
  const actions = []
  let previous = 0
  for (const request of report.requests ?? []) {
    const messages = request.messages ?? []
    if (messages.length <= previous) continue
    for (const message of messages.slice(previous)) {
      if (message.role === 'tool' || message.toolCalls === true) {
        const preview = String(message.preview ?? '').replace(/\s+/gu, ' ').slice(0, 120)
        actions.push({ role: message.role, toolCall: message.toolCalls === true, preview })
      }
    }
    previous = messages.length
  }
  return actions
}

const rows = []
for (const campaign of CAMPAIGNS) {
  const analysisPath = join(OUT, `analysis-${campaign}.json`)
  if (!existsSync(analysisPath)) continue
  const analysis = readJson(analysisPath)
  for (const row of analysis.rows) {
    if (row.status !== 'executed') continue
    const reportPath = join(RUNS, campaign, row.cellId, 'report.json')
    if (!existsSync(reportPath)) continue
    const report = readJson(reportPath)
    rows.push({
      campaign,
      cellId: row.cellId,
      template: row.template,
      seed: row.seed,
      arm: row.arm,
      pass: row.checkerPass,
      failureClass: row.failureClass ?? null,
      folds: row.folds,
      foldFailures: row.foldFailures,
      requests: row.requests,
      recallCalls: row.recallCalls,
      writes: toolCount(report, 'write_file') + toolCount(report, 'edit_file'),
      writeFileCalls: toolCount(report, 'write_file'),
      editCalls: toolCount(report, 'edit_file'),
      readCalls: toolCount(report, 'read_file'),
      testCalls: toolCount(report, 'run_tests'),
      finishCalls: toolCount(report, 'finish'),
      toolErrors: report.tools?.errors ?? 0,
      guardAttempts: report.completionGuard?.attempts ?? 0,
      guardMissingAtEnd: report.completionGuard?.missingAtEnd ?? null,
      finalText: String(report.behaviour?.finalText ?? '').slice(0, 240),
      hasTrajectory: Array.isArray(report.trajectory) && report.trajectory.length > 0,
      trajectory: report.trajectory ?? null,
      actions: report.trajectory === undefined ? reconstructedActions(report) : null,
    })
  }
}

const outputTasks = rows.filter(row => ['T2', 'T4', 'T5', 'T5B'].includes(row.template))
const crossTab = {
  cells: outputTasks.length,
  wroteAndPassed: outputTasks.filter(row => row.writes > 0 && row.pass).length,
  wroteAndFailed: outputTasks.filter(row => row.writes > 0 && !row.pass).length,
  noWriteAndPassed: outputTasks.filter(row => row.writes === 0 && row.pass).length,
  noWriteAndFailed: outputTasks.filter(row => row.writes === 0 && !row.pass).length,
  recalledAndPassed: outputTasks.filter(row => row.recallCalls > 0 && row.pass).length,
  recalledAndFailed: outputTasks.filter(row => row.recallCalls > 0 && !row.pass).length,
  noRecallAndPassed: outputTasks.filter(row => row.recallCalls === 0 && row.pass).length,
  noRecallAndFailed: outputTasks.filter(row => row.recallCalls === 0 && !row.pass).length,
}

/** Cells that ran more than once with the same task + arm. */
const groups = new Map()
for (const row of rows) {
  const key = `${row.template}:${row.seed}:${row.arm}`
  const bucket = groups.get(key) ?? []
  bucket.push(row)
  groups.set(key, bucket)
}
const repeats = []
for (const [key, bucket] of groups) {
  if (bucket.length < 2) continue
  const outcomes = new Set(bucket.map(row => row.pass ? 'pass' : `fail:${row.failureClass ?? 'other'}`))
  if (outcomes.size < 2) continue
  repeats.push({
    key,
    runs: bucket.map(row => ({
      campaign: row.campaign,
      pass: row.pass,
      failureClass: row.failureClass,
      folds: row.folds,
      requests: row.requests,
      recallCalls: row.recallCalls,
      writes: row.writes,
      tests: row.testCalls,
      finalText: row.finalText.slice(0, 160),
    })),
  })
}

const guard = rows.find(row => row.campaign === 'e2e-guard-smoke-1')
const guardCase = guard === undefined ? null : {
  cellId: guard.cellId,
  pass: guard.pass,
  failureClass: guard.failureClass,
  guardAttempts: guard.guardAttempts,
  guardMissingAtEnd: guard.guardMissingAtEnd,
  trajectory: guard.trajectory,
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work: 'EF-E2E',
  sources: {
    orderedTrajectories: rows.filter(row => row.hasTrajectory).map(row => `${row.campaign}/${row.cellId}`),
    reconstructed: rows.filter(row => !row.hasTrajectory).length,
    note: 'Pre-trajectory cells expose request deltas and tool counts, not an ordered event log. The 71 original cells predate trajectory capture.',
  },
  crossTab,
  repeats,
  guardCase,
  rows,
}
writeFileSync(join(OUT, 'trajectory-analysis.json'), `${JSON.stringify(report, null, 2)}\n`)

const md = []
md.push('# EF-E2E — trajectory and variance attribution')
md.push('')
md.push(`Executed cells analysed: **${rows.length}**. Ordered trajectories: **${report.sources.orderedTrajectories.length}**; the rest use request deltas + tool counts.`)
md.push('')
md.push('## Output-file tasks: what separates a pass from a failure')
md.push('')
md.push('| Behaviour | Pass | Fail |')
md.push('|---|---|---|')
md.push(`| wrote an output (write_file/edit_file) | ${crossTab.wroteAndPassed} | ${crossTab.wroteAndFailed} |`)
md.push(`| wrote nothing | ${crossTab.noWriteAndPassed} | ${crossTab.noWriteAndFailed} |`)
md.push(`| called recall | ${crossTab.recalledAndPassed} | ${crossTab.recalledAndFailed} |`)
md.push(`| never called recall | ${crossTab.noRecallAndPassed} | ${crossTab.noRecallAndFailed} |`)
md.push('')
md.push('## Repeat-run flips (same task + seed + arm, different campaign)')
md.push('')
for (const repeat of repeats) {
  md.push(`### ${repeat.key}`)
  md.push('')
  md.push('| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |')
  md.push('|---|---|---|---|---|---|---|')
  for (const run of repeat.runs) {
    md.push(`| ${run.campaign} | ${run.pass ? 'pass' : `fail (${run.failureClass})`} | ${run.folds} | ${run.requests} | ${run.recallCalls} | ${run.writes} | ${run.finalText.replace(/\|/gu, '\\|')} |`)
  }
  md.push('')
}
if (guardCase !== null) {
  md.push('## The guard smoke: a full ordered trajectory')
  md.push('')
  md.push(`Cell \`${guardCase.cellId}\`: pass=${guardCase.pass}, failure=${guardCase.failureClass}, guard attempts=${guardCase.guardAttempts}, missing at end=${JSON.stringify(guardCase.guardMissingAtEnd)}.`)
  md.push('')
  md.push('| Seq | Event | What it shows |')
  md.push('|---|---|---|')
  for (const event of guardCase.trajectory) {
    const detail = event.type === 'tool/call'
      ? `${event.name} ${String(event.args?.text ?? '').slice(0, 120)}`
      : event.type === 'tool/result'
        ? String(event.text ?? '').replace(/\s+/gu, ' ').slice(0, 160)
        : event.type === 'assistant'
          ? String(event.text ?? '').replace(/\s+/gu, ' ').slice(0, 160)
          : event.type === 'user'
            ? `source=${event.sourceKind} ${String(event.text ?? '').replace(/\s+/gu, ' ').slice(0, 120)}`
            : `${event.id ?? ''} ${event.error ?? ''}`
    md.push(`| ${event.seq} | ${event.type} | ${detail.replace(/\|/gu, '\\|')} |`)
  }
  md.push('')
}
md.push('## Attribution')
md.push('')
md.push('The flip is not a fold-policy difference: the same task, seed, budget and arm produce different tool persistence. The failing T4 run stopped after two recall calls with the correct values in prose and no write; the passing run recalled seven times, corrected itself, wrote the file, and passed. In the guard smoke the model had the correct log in the folded history, read only the later distractor log in the live turn, concluded the value was unknown, and wrote an UNKNOWN answer after the guard. The guard fixes the missing FILE; it cannot fix the missing RETRIEVAL CUE.')
writeFileSync(join(OUT, 'trajectory-analysis.md'), `${md.join('\n')}\n`)

process.stdout.write(`trajectory analysis: ${rows.length} cell(s), ${report.sources.orderedTrajectories.length} full trajectory/trajectories, ${repeats.length} flip(s)\n`)
for (const repeat of repeats) {
  process.stdout.write(`  ${repeat.key}: ${repeat.runs.map(run => run.pass ? 'pass' : run.failureClass).join(' / ')}\n`)
}


