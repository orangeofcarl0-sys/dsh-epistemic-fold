#!/usr/bin/env node
/**
 * EF-R4 WP1 — rescore the R3 product pilot without changing its history.
 *
 * R3's `checker.pass` mixed two different claims:
 *   1. the workspace answer is correct (task checks);
 *   2. the cell actually exercised the required number of folds (mechanism).
 *
 * This script keeps the recorded R3 value as `historical` and computes a
 * separate `rescored` value. It never writes into eval/r3 or eval/e2e.
 *
 *   node eval/r4/score.mjs
 *
 * @module eval/r4/score
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const CAMPAIGN = 'e2e-r3-product-pilot-1'
const ARMS = ['B0', 'E0', 'E1']

export const SCORER_VERSION = 'r4-scoring-v1'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

export function exactMcNemar(b, c) {
  const n = b + c
  if (n === 0) return 1
  let tail = 0
  let term = 1
  for (let k = 0; k <= Math.min(b, c); k += 1) {
    if (k > 0) term = (term * (n - k + 1)) / k
    tail += term
  }
  return Math.min(1, 2 * tail * 0.5 ** n)
}

/**
 * The task outcome is independent of treatment exposure.
 *
 *   correct    — every task check passed.
 *   incorrect  — the cell called `finish` and the task checks failed.
 *   incomplete — the cell was censored (step limit, timeout, error) or stopped
 *                without a definitive finish, so a wrong answer is not proved.
 */
export function taskOutcomeOf({ taskPass, finishCalled }) {
  if (taskPass === true) return 'correct'
  if (finishCalled === true) return 'incorrect'
  return 'incomplete'
}

/** Strict cost completeness: a usage object with null fields is not a cost. */
export function usageCompleteOf(requests) {
  if (!Array.isArray(requests)) return false
  return requests.every(entry =>
    entry?.usage !== null
    && entry?.usage !== undefined
    && Number.isFinite(entry.usage.inputTokens)
    && Number.isFinite(entry.usage.outputTokens))
}

function taskChecksOf(report) {
  const checks = report?.checker?.checks ?? []
  // v1 reports carry the injected `compactions` row. v2 reports do not.
  return checks.filter(check => check.kind !== 'compactions')
}

export function scoreReport({ report, task, historicalPass, fallback = {} }) {
  const version = report?.schemaVersion ?? 1
  const checks = taskChecksOf(report)
  const taskPass = checks.every(check => check.pass === true)
  const finishCalled = report?.scoring?.termination?.finishCalled
    ?? report?.termination?.finishCalled
    ?? report?.termination?.finished
    ?? false
  const outcome = report?.scoring?.taskOutcome ?? taskOutcomeOf({ taskPass, finishCalled })
  const required = task?.requires?.minCompactions
  const committed = report?.witnessSummary?.committed ?? fallback.committed ?? null
  const mechanism = report?.mechanism !== undefined && report?.mechanism !== null
    ? report.mechanism
    : required === undefined || committed === null
      ? null
      : {
          requiredCompactions: required,
          committedCompactions: committed,
          pass: committed >= required,
          requiredFoldCountMet: committed >= required,
        }
  const usage = report?.usage ?? {}
  const usageCompleteR3 = usage.unknownUsage === 0
  const usageCompleteR4 = report?.scoring?.cost?.usageCompleteR4
    ?? usageCompleteOf(report?.requests ?? [])
  const termination = report?.termination ?? {}
  return {
    reportSchemaVersion: version,
    taskChecks: { pass: taskPass, checks },
    taskOutcome: outcome,
    historicalPass: historicalPass === true,
    mechanism: mechanism === null
      ? null
      : {
          requiredCompactions: mechanism.requiredCompactions ?? required ?? null,
          committedCompactions: mechanism.committedCompactions ?? committed ?? null,
          requiredFoldCountMet: mechanism.requiredFoldCountMet ?? mechanism.pass ?? null,
        },
    termination: {
      kind: termination.kind ?? null,
      finishCalled,
      stepLimitStage: termination.stepLimitStage ?? null,
      stepsUsed: termination.stepsUsed ?? null,
    },
    cost: {
      usageCompleteR3,
      usageCompleteR4,
      unknownUsage: usage.unknownUsage ?? null,
      requests: usage.requests ?? null,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    },
  }
}

export function aggregate(cells) {
  const byArm = {}
  for (const arm of ARMS) {
    const subset = cells.filter(cell => cell.arm === arm)
    byArm[arm] = {
      cells: subset.length,
      taskCorrect: subset.filter(cell => cell.taskOutcome === 'correct').length,
      taskIncorrect: subset.filter(cell => cell.taskOutcome === 'incorrect').length,
      taskIncomplete: subset.filter(cell => cell.taskOutcome === 'incomplete').length,
      historicalPass: subset.filter(cell => cell.historicalPass).length,
      mechanismPass: subset.filter(cell => cell.mechanism?.requiredFoldCountMet === true).length,
      costValidR3: subset.filter(cell => cell.cost.usageCompleteR3).length,
      costValidR4: subset.filter(cell => cell.cost.usageCompleteR4).length,
      stepLimited: subset.filter(cell => cell.termination.kind === 'step-limit').length,
      terminations: subset.reduce((counts, cell) => {
        const kind = cell.termination.kind ?? 'unknown'
        counts[kind] = (counts[kind] ?? 0) + 1
        return counts
      }, {}),
    }
  }
  return byArm
}

export function pair(cells, left, right) {
  const key = cell => `${cell.task}-r${cell.replicate}`
  const rightByKey = new Map(cells.filter(cell => cell.arm === right).map(cell => [key(cell), cell]))
  const rows = cells
    .filter(cell => cell.arm === left)
    .map(cell => {
      const other = rightByKey.get(key(cell))
      if (other === undefined) return null
      const leftPass = cell.taskOutcome === 'correct'
      const rightPass = other.taskOutcome === 'correct'
      return {
        key: key(cell),
        [left]: leftPass,
        [right]: rightPass,
        both: leftPass && rightPass,
        neither: !leftPass && !rightPass,
        leftOnly: leftPass && !rightPass,
        rightOnly: !leftPass && rightPass,
        costValid: cell.cost.usageCompleteR4 && other.cost.usageCompleteR4,
      }
    })
    .filter(row => row !== null)
  return {
    pairs: rows.length,
    both: rows.filter(row => row.both).length,
    neither: rows.filter(row => row.neither).length,
    leftOnly: rows.filter(row => row.leftOnly).length,
    rightOnly: rows.filter(row => row.rightOnly).length,
    costValidPairs: rows.filter(row => row.costValid).length,
    mcnemarP: exactMcNemar(rows.filter(row => row.leftOnly).length, rows.filter(row => row.rightOnly).length),
  }
}

function listTopLevelFiles(dir) {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort()
  } catch {
    return []
  }
}

function main() {
  const manifestPath = join(ROOT, 'eval', 'e2e', 'out', `manifest-${CAMPAIGN}.json`)
  const resultsPath = join(ROOT, 'eval', 'e2e', 'out', `results-${CAMPAIGN}.json`)
  for (const path of [manifestPath, resultsPath]) {
    if (!existsSync(path)) {
      process.stderr.write(`score: ${path} is missing\n`)
      process.exit(2)
    }
  }
  const manifest = readJson(manifestPath)
  const results = readJson(resultsPath)
  const tasks = new Map((manifest.tasks ?? []).map(task => [task.id, task]))

  const cells = []
  for (const row of results.results ?? []) {
    if (row.status !== 'executed') continue
    const reportPath = row.reportPath === undefined || row.reportPath === null
      ? null
      : resolve(ROOT, row.reportPath)
    const report = reportPath !== null && existsSync(reportPath) ? readJson(reportPath) : null
    const taskId = row.cell?.task ?? row.cellId?.split('-').slice(0, 2).join('-')
    const taskEntry = tasks.get(taskId)
    const task = taskEntry !== undefined && existsSync(join(ROOT, taskEntry.file))
      ? readJson(join(ROOT, taskEntry.file))
      : null
    const scored = scoreReport({
      report,
      task,
      historicalPass: row.checker === true,
      fallback: { committed: row.mechanism?.committedCompactions ?? null },
    })
    cells.push({
      cellId: row.cellId ?? `${taskId}-${row.cell?.arm}-r${row.cell?.replicate}`,
      task: taskId,
      arm: row.cell?.arm ?? null,
      replicate: row.cell?.replicate ?? null,
      reportPath: reportPath === null ? null : reportPath.slice(ROOT.length + 1).replaceAll('\\', '/'),
      reportSha256: reportPath !== null && existsSync(reportPath) ? sha256(reportPath) : null,
      ...scored,
    })
  }

  const historical = aggregate(cells.map(cell => ({ ...cell, taskOutcome: cell.historicalPass ? 'correct' : 'incorrect' })))
  const rescored = aggregate(cells)
  const comparisons = [
    ['E1', 'B0'],
    ['E1', 'E0'],
    ['E0', 'B0'],
  ].map(([left, right]) => ({ left, right, ...pair(cells, left, right) }))

  const assertions = [
    {
      name: 'historical-pilot-counts',
      expected: { B0: 5, E0: 1, E1: 3 },
      actual: Object.fromEntries(ARMS.map(arm => [arm, historical[arm].historicalPass])),
    },
    {
      name: 'rescored-task-counts',
      expected: { B0: 5, E0: 1, E1: 3 },
      actual: Object.fromEntries(ARMS.map(arm => [arm, rescored[arm].taskCorrect])),
    },
    {
      name: 'rescored-e1-b0-pair',
      expected: { both: 3, neither: 1, leftOnly: 0, rightOnly: 2 },
      actual: (() => {
        const row = comparisons.find(entry => entry.left === 'E1' && entry.right === 'B0')
        return { both: row.both, neither: row.neither, leftOnly: row.leftOnly, rightOnly: row.rightOnly }
      })(),
    },
  ].map(assertion => ({
    ...assertion,
    pass: JSON.stringify(assertion.expected) === JSON.stringify(assertion.actual),
  }))

  const byTemplate = {}
  for (const cell of cells) {
    const template = cell.task.replace(/-p\d$/u, '')
    byTemplate[template] ??= {}
    byTemplate[template][cell.arm] ??= { taskOutcome: null, mechanism: null, costValid: null }
    byTemplate[template][cell.arm] = {
      taskOutcome: cell.taskOutcome,
      mechanism: cell.mechanism?.requiredFoldCountMet ?? null,
      costValid: cell.cost.usageCompleteR4,
      termination: cell.termination.kind,
    }
  }

  const output = {
    schemaVersion: 1,
    work: 'EF-R4 WP1 rescore',
    generatedAt: new Date().toISOString(),
    campaign: CAMPAIGN,
    scorerVersion: SCORER_VERSION,
    inputs: {
      manifest: { path: `eval/e2e/out/manifest-${CAMPAIGN}.json`, sha256: sha256(manifestPath) },
      results: { path: `eval/e2e/out/results-${CAMPAIGN}.json`, sha256: sha256(resultsPath) },
    },
    method: {
      historical: 'the value recorded by R3: result.checker, including the injected mechanism row',
      rescored: 'task checks only; mechanism reported separately',
      taskOutcome: 'correct = all task checks pass; incorrect = finish called and checks fail; incomplete = censored before a definitive answer',
      cost: 'usageCompleteR4 requires numeric input/output on every request; no imputation',
      pairing: 'task x replicate; exact McNemar on taskOutcome=correct',
    },
    historical,
    rescored,
    comparisons,
    assertions,
    byTemplate,
    cells,
    limits: [
      'The R3 pilot is one model, one route and one machine.',
      'The rescored value does not replace the historical benchmark; both are reported.',
      'A mechanism miss is not a wrong answer and is not counted in taskOutcome.',
    ],
  }

  mkdirSync(OUT, { recursive: true })
  const jsonPath = join(OUT, 'rescored-r3.json')
  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  const md = []
  md.push('# EF-R4 — R3 pilot rescore')
  md.push('')
  md.push(`Scorer: \`${SCORER_VERSION}\`. Historical score is the recorded R3 value; the rescored value separates task checks from mechanism exposure.`)
  md.push('')
  md.push('## Arm summary')
  md.push('')
  md.push('| Arm | Cells | Historical pass | Task correct | Incorrect | Incomplete | Mechanism met | Cost-valid R3 | Cost-valid R4 | Step-limited |')
  md.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const arm of ARMS) {
    const row = rescored[arm]
    md.push(`| ${arm} | ${row.cells} | ${historical[arm].historicalPass}/${row.cells} | ${row.taskCorrect}/${row.cells} | ${row.taskIncorrect} | ${row.taskIncomplete} | ${row.mechanismPass} | ${row.costValidR3} | ${row.costValidR4} | ${row.stepLimited} |`)
  }
  md.push('')
  md.push('## Paired comparisons (taskOutcome=correct)')
  md.push('')
  md.push('| Left vs Right | Pairs | Both | Neither | Left only | Right only | p | Cost-valid pairs |')
  md.push('|---|---|---|---|---|---|---|---|')
  for (const row of comparisons) {
    md.push(`| ${row.left} vs ${row.right} | ${row.pairs} | ${row.both} | ${row.neither} | ${row.leftOnly} | ${row.rightOnly} | ${row.mcnemarP} | ${row.costValidPairs} |`)
  }
  md.push('')
  md.push('## Assertions')
  md.push('')
  for (const assertion of assertions) {
    md.push(`- \`${assertion.name}\`: ${assertion.pass ? 'pass' : 'FAIL'} — expected ${JSON.stringify(assertion.expected)}, actual ${JSON.stringify(assertion.actual)}`)
  }
  md.push('')
  md.push('## Per-cell')
  md.push('')
  md.push('| Cell | Arm | Historical | Task outcome | Mechanism | Cost R4 | Termination |')
  md.push('|---|---|---|---|---|---|---|')
  for (const cell of cells.sort((left, right) => left.cellId.localeCompare(right.cellId))) {
    md.push(`| ${cell.cellId} | ${cell.arm} | ${cell.historicalPass ? 'pass' : 'fail'} | ${cell.taskOutcome} | ${cell.mechanism === null ? '—' : cell.mechanism.requiredFoldCountMet ? 'met' : 'miss'} | ${cell.cost.usageCompleteR4 ? 'valid' : 'invalid'} | ${cell.termination.kind} |`)
  }
  md.push('')
  const mdPath = join(OUT, 'rescored-r3.md')
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

  process.stdout.write(`rescore: ${cells.length} cells; historical ${ARMS.map(arm => `${arm} ${historical[arm].historicalPass}/${historical[arm].cells}`).join(', ')}\n`)
  process.stdout.write(`rescored task ${ARMS.map(arm => `${arm} ${rescored[arm].taskCorrect}/${rescored[arm].cells}`).join(', ')}\n`)
  const failed = assertions.filter(assertion => !assertion.pass)
  for (const assertion of failed) process.stderr.write(`ASSERTION FAILED ${assertion.name}: ${JSON.stringify(assertion.actual)}\n`)
  process.stdout.write(`wrote ${jsonPath}, ${mdPath}\n`)
  if (failed.length > 0) process.exit(1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
