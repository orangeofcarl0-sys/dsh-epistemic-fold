#!/usr/bin/env node
/**
 * EF-R2 WP6 — zero-request preflight for the 72-cell design.
 *
 * 12 new instances × {B0, E0, E1}. The scripted adapter makes NO provider
 * call: it answers the compaction/rationale prompts deterministically and
 * writes the reference files. What the preflight proves is wiring and
 * feasibility, not model behaviour:
 *
 *   - the seed crosses the pressure threshold;
 *   - the fold forms a legal span and commits;
 *   - the checkpoint is delivered to a later primary request;
 *   - the checker passes on the reference answer;
 *   - T16 reaches its two committed folds.
 *
 * A task that cannot pass this preflight must not be shipped into the live
 * manifest: it would measure a broken fixture, not the mechanism.
 *
 *   node eval/r2/live-preflight.mjs
 *
 * @module eval/r2/live-preflight
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RecordingAdapter, ScriptedSolverAdapter, runCell } from '../e2e/src/cell.mjs'
import { summarizeWitnesses } from '../e2e/src/witness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const TASKS = join(ROOT, 'eval', 'e2e', 'tasks-r2')
const RUNS = join(ROOT, 'eval', 'e2e', 'runs', 'ef-r2-preflight')
const OUT = join(HERE, 'out')

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const taskFiles = readdirSync(TASKS)
  .filter(name => /^T\d+-s\d\.json$/u.test(name))
  .sort()
const ARMS = ['B0', 'E0', 'E1']

mkdirSync(RUNS, { recursive: true })
const rows = []
for (const name of taskFiles) {
  const task = readJson(join(TASKS, name))
  for (const arm of ARMS) {
    const outRoot = join(RUNS, `${task.id}-${arm}`)
    if (!existsSync(outRoot)) mkdirSync(outRoot, { recursive: true })
    let report
    try {
      report = await runCell({
        campaign: 'ef-r2-preflight',
        task,
        arm,
        replicate: 1,
        mode: 'self-test',
        makeAdapter: ({ task: cellTask, log }) => {
          const inner = new ScriptedSolverAdapter(cellTask)
          // Match the live route's operational window, not the scripted
          // default: the task's threshold is derived from this number.
          inner.resolveModel = (provider, id) => Promise.resolve({
            provider,
            id,
            name: id,
            context: { contextWindow: cellTask.operationalBudgetTokens },
          })
          return new RecordingAdapter(inner, log, { defaultMaxTokens: 1024 })
        },
        guard: false,
        outRoot,
        provider: 'ef-e2e',
        model: 'scripted',
        cellLimits: { requests: 20, inputTokens: 200_000, outputTokens: 20_000, wallClockMs: 120_000 },
        // The design's EF arms use the corrected admission; B0 is native Basic.
        efConfig: arm === 'B0'
          ? {}
          : { leafAdmission: 'economic', rootPolicy: 'economics' },
      })
    } catch (error) {
      rows.push({
        task: task.id,
        template: task.template,
        seed: task.seed,
        arm,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        pass: false,
      })
      continue
    }
    const summary = report.witnessSummary ?? summarizeWitnesses(report.witnesses ?? [])
    const required = task.requires?.minCompactions ?? 1
    const foldOk = summary.committed >= required
    const deliveryOk = summary.committedAndDelivered >= 1
    const checkerOk = report.checker.pass === true
    rows.push({
      task: task.id,
      template: task.template,
      seed: task.seed,
      category: task.category,
      arm,
      mode: report.mode,
      checker: checkerOk,
      attempts: summary.attempts,
      committed: summary.committed,
      refused: summary.refused,
      aborted: summary.aborted,
      unverifiable: summary.unverifiable,
      delivered: summary.committedAndDelivered,
      noFollowingRequest: summary.noFollowingRequest,
      requiredCommits: required,
      foldOk,
      deliveryOk,
      pass: checkerOk && foldOk && deliveryOk,
      termination: report.termination.kind,
      retainedTokens: report.retainedTokens,
      reportPath: join('eval', 'e2e', 'runs', 'ef-r2-preflight', `${task.id}-${arm}`, `${task.id}-${arm}-r1`, 'report.json').replace(/\\/gu, '/'),
      reportSha256: (() => {
        const path = join(outRoot, `${task.id}-${arm}-r1`, 'report.json')
        return existsSync(path) ? sha256(path) : null
      })(),
    })
  }
}

const failed = rows.filter(row => !row.pass)
const byArm = Object.fromEntries(ARMS.map(arm => {
  const subset = rows.filter(row => row.arm === arm)
  return [arm, {
    cells: subset.length,
    pass: subset.filter(row => row.pass).length,
    attempts: subset.reduce((sum, row) => sum + (row.attempts ?? 0), 0),
    committed: subset.reduce((sum, row) => sum + (row.committed ?? 0), 0),
    delivered: subset.reduce((sum, row) => sum + (row.delivered ?? 0), 0),
  }]
}))

const output = {
  schemaVersion: 1,
  work: 'EF-R2 WP6',
  generatedAt: new Date().toISOString(),
  requests: 0,
  note: 'Zero-request preflight. The scripted adapter is not a model and no result here is evidence about model behaviour.',
  tasks: taskFiles.length,
  arms: ARMS,
  cells: rows.length,
  passed: rows.length - failed.length,
  failed: failed.length,
  byArm,
  rows,
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'preflight-r2.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

process.stdout.write(`preflight: ${output.passed}/${output.cells} cells pass; requests ${output.requests}\n`)
for (const arm of ARMS) {
  const row = byArm[arm]
  process.stdout.write(`  ${arm}: ${row.pass}/${row.cells} pass, attempts ${row.attempts}, commits ${row.committed}, delivered ${row.delivered}\n`)
}
for (const row of failed) {
  process.stdout.write(`  FAIL ${row.task}/${row.arm}: ${row.error ?? `checker=${row.checker} commits=${row.committed}/${row.requiredCommits} delivered=${row.delivered}`}\n`)
}
if (failed.length > 0) process.exit(1)
