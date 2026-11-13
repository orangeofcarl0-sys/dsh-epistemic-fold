#!/usr/bin/env node
/**
 * EF-R4 WP6 — freeze the 36-cell step-budget sensitivity design.
 *
 * This file is a DESIGN. It does not authorize a provider call. The campaign
 * remains `executionAuthorized:false` until a new, explicit grant binds the
 * final manifest SHA and the budget envelope.
 *
 *   node eval/r4/freeze-budget-sensitivity.mjs
 *
 * Design: 6 tasks x 3 arms x 2 budgets = 36 cells, in six blocks of six. Each
 * block contains every task once, every arm twice and every budget three times;
 * across six blocks each task x arm x budget combination appears exactly once.
 * The mapping is a Latin square, not a random draw, so it is reproducible.
 *
 * @module eval/r4/freeze-budget-sensitivity
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const SOURCE_CAMPAIGN = 'e2e-r3-product-pilot-1'
const CAMPAIGN = 'e2e-r4-budget-sensitivity-1'
const ARMS = ['B0', 'E0', 'E1']
const TASKS = ['T11-p1', 'T12-p1', 'T13-p1', 'T14-p1', 'T15-p1', 'T16-p1']
const TREATMENTS = [
  { arm: 'B0', maxSteps: 8 },
  { arm: 'E0', maxSteps: 16 },
  { arm: 'E1', maxSteps: 8 },
  { arm: 'B0', maxSteps: 16 },
  { arm: 'E0', maxSteps: 8 },
  { arm: 'E1', maxSteps: 16 },
]

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function main() {
  const manifestPath = join(ROOT, 'eval', 'e2e', 'out', `manifest-${SOURCE_CAMPAIGN}.json`)
  const resultsPath = join(ROOT, 'eval', 'e2e', 'out', `results-${SOURCE_CAMPAIGN}.json`)
  for (const path of [manifestPath, resultsPath]) {
    if (!existsSync(path)) {
      process.stderr.write(`freeze-budget-sensitivity: ${path} is missing\n`)
      process.exit(2)
    }
  }
  const sourceManifest = readJson(manifestPath)
  const sourceResults = readJson(resultsPath)

  const cells = []
  for (let block = 0; block < 6; block += 1) {
    for (let position = 0; position < 6; position += 1) {
      const task = TASKS[position]
      const treatment = TREATMENTS[(position + block) % 6]
      cells.push({
        block: `r4-budget-${block + 1}`,
        task,
        arm: treatment.arm,
        replicate: 1,
        maxSteps: treatment.maxSteps,
        maxStepsSource: 'cell',
      })
    }
  }

  const combos = new Set(cells.map(cell => `${cell.task}:${cell.arm}:${cell.maxSteps}`))
  const blockBalanced = [...new Set(cells.map(cell => cell.block))].every(block => {
    const subset = cells.filter(cell => cell.block === block)
    const arms = ARMS.map(arm => subset.filter(cell => cell.arm === arm).length)
    const budgets = [8, 16].map(budget => subset.filter(cell => cell.maxSteps === budget).length)
    return subset.length === 6 && arms.every(count => count === 2) && budgets.every(count => count === 3)
  })
  if (cells.length !== 36 || combos.size !== 36 || !blockBalanced) {
    process.stderr.write(`freeze-budget-sensitivity: invalid design cells=${cells.length} unique=${combos.size} blockBalanced=${blockBalanced}\n`)
    process.exit(1)
  }

  const observed = (sourceResults.results ?? [])    .filter(row => row.status === 'executed')
    .map(row => ({
      cellId: row.cellId,
      requests: row.usage?.requests ?? 0,
      inputTokens: row.usage?.inputTokens ?? 0,
      outputTokens: row.usage?.outputTokens ?? 0,
    }))
  const durations = (sourceResults.results ?? [])
    .filter(row => row.status === 'executed')
    .map(row => {
      const reportPath = row.reportPath === undefined ? null : resolve(ROOT, row.reportPath)
      const report = reportPath !== null && existsSync(reportPath) ? readJson(reportPath) : null
      return report?.termination?.durationMs ?? 0
    })
    .filter(value => value > 0)

  const medianRow = {
    requests: median(observed.map(row => row.requests)),
    inputTokens: median(observed.map(row => row.inputTokens)),
    outputTokens: median(observed.map(row => row.outputTokens)),
    durationMs: median(durations),
  }
  const maxRow = {
    requests: Math.max(...observed.map(row => row.requests)),
    inputTokens: Math.max(...observed.map(row => row.inputTokens)),
    outputTokens: Math.max(...observed.map(row => row.outputTokens)),
    durationMs: Math.max(...durations),
  }

  const design = {
    schemaVersion: 1,
    work: 'EF-R4 WP6 step-budget sensitivity design',
    generatedAt: new Date().toISOString(),
    campaign: CAMPAIGN,
    status: 'design-frozen',
    executionAuthorized: false,
    authorizationState: 'not-requested',
    authorizationSha256: null,
    source: {
      campaign: SOURCE_CAMPAIGN,
      manifest: { path: `eval/e2e/out/manifest-${SOURCE_CAMPAIGN}.json`, sha256: sha256(manifestPath) },
      results: { path: `eval/e2e/out/results-${SOURCE_CAMPAIGN}.json`, sha256: sha256(resultsPath) },
      note: 'The R3 8-step cells are not reused as strict pairs for the 16-step cells. This campaign includes its own 8-step cells.',
    },
    code: {
      worktree: ROOT,
      head: git('rev-parse', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      note: 'The design is frozen against this tree. Any later code change invalidates the design digest.',
    },
    design: {
      blocks: 6,
      cellsPerBlock: 6,
      tasks: TASKS,
      arms: ARMS,
      budgets: [8, 16],
      method: 'Latin square: block b, position i -> task[i], treatment[(i+b)%6]',
      maxStepsSemantics: 'per agent loop; stage A and stage B each receive the cell budget, and the report records total steps',
      cells: 36,
      validation: {
        uniqueTaskArmBudget: combos.size,
        blockBalanced,
      },
    },
    config: {
      ...sourceManifest.config,
      maxSteps: 8,
      note: 'Copied from the R3 product pilot; each cell overrides maxSteps. The effective value is written into every report.',
    },
    arms: sourceManifest.arms,
    tasks: sourceManifest.tasks.filter(task => TASKS.includes(task.id)),
    cells,
    originalOrder: cells.map(cell => `${cell.task}-${cell.arm}-b${cell.maxSteps}`),
    executionOrder: cells.map(cell => `${cell.task}-${cell.arm}-b${cell.maxSteps}`),
    mechanism: {
      taskOutcome: 'task checks only; correct / incorrect / incomplete',
      exposure: 'manifested, committed, delivered, requiredFoldCountMet',
      requirement: 'T16-p1 requires minCompactions:2; it is a mechanism result, not a task pass condition',
    },
    budgetEstimate: {
      sourceCells: observed.length,
      median: medianRow,
      max: maxRow,
      estimated36: {
        requests: Math.ceil((medianRow.requests ?? 0) * 36),
        inputTokens: Math.ceil((medianRow.inputTokens ?? 0) * 36),
        outputTokens: Math.ceil((medianRow.outputTokens ?? 0) * 36),
        wallClockMs: Math.ceil((medianRow.durationMs ?? 0) * 36),
      },
      proposedLimits: {
        requests: Math.ceil((maxRow.requests ?? 0) * 36 * 1.2),
        inputTokens: Math.ceil((maxRow.inputTokens ?? 0) * 36 * 1.2),
        outputTokens: Math.ceil((maxRow.outputTokens ?? 0) * 36 * 1.2),
        wallClockMs: Math.ceil((maxRow.durationMs ?? 0) * 36 * 1.2),
        note: 'A proposal only. A live grant must set the real envelope; this file does not authorize spend.',
      },
      perCell: {
        requests: Math.ceil((maxRow.requests ?? 0) * 1.5),
        inputTokens: Math.ceil((maxRow.inputTokens ?? 0) * 1.5),
        outputTokens: Math.ceil((maxRow.outputTokens ?? 0) * 1.5),
        wallClockMs: Math.ceil((maxRow.durationMs ?? 0) * 1.5),
      },
    },
    preconditions: [
      'R4-G1 scoring separation passes.',
      'R4-G2 evidence graph is reproducible.',
      'A representative transport health probe passes under the new route.',
      'A new, explicit live authorization binds this manifest SHA and the budget envelope.',
      'The worktree is clean and the source tree digest matches the design.',
    ],
    stopConditions: [
      'transport failure or reset',
      'unknown provider usage (strictUsage)',
      'budget exhausted',
      'provider failure that invalidates the route',
    ],
    workloadFamilies: {
      'archive-only': {
        status: 'designed',
        note: 'The six existing tasks; the fact is recoverable only from history/archive.',
        tasks: TASKS,
      },
      'workspace-readable': {
        status: 'design-only',
        note: 'A separate task family where the fact still exists in the workspace. It is not generated here and must not be pooled with archive-only results.',
        tasks: [],
      },
    },
    note: 'No provider call was made. This campaign cannot start from this file alone.',
  }

  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, 'budget-sensitivity-design.json')
  writeFileSync(path, `${JSON.stringify(design, null, 2)}\n`, 'utf8')

  const md = []
  md.push('# EF-R4 — step-budget sensitivity design')
  md.push('')
  md.push('**Design frozen; execution not authorized.** No provider call was made.')
  md.push('')
  md.push(`- Campaign: \`${CAMPAIGN}\``)
  md.push('- 36 cells = 6 tasks x 3 arms x 2 budgets (8, 16)')
  md.push('- Six blocks of six; every block has each task once, each arm twice, each budget three times')
  md.push('- The 8-step cells are new; they are not paired with R3 history')
  md.push('')
  md.push('## Execution order')
  md.push('')
  md.push('| # | Block | Task | Arm | maxSteps |')
  md.push('|---|---|---|---|---|')
  cells.forEach((cell, index) => {
    md.push(`| ${index + 1} | ${cell.block} | ${cell.task} | ${cell.arm} | ${cell.maxSteps} |`)
  })
  md.push('')
  md.push('## Budget estimate (from R3)')
  md.push('')
  md.push(`- Median per cell: ${JSON.stringify(medianRow)}`)
  md.push(`- Max per cell: ${JSON.stringify(maxRow)}`)
  md.push(`- Estimated 36 cells: ${JSON.stringify(design.budgetEstimate.estimated36)}`)
  md.push(`- Proposed limits: ${JSON.stringify(design.budgetEstimate.proposedLimits)}`)
  md.push('')
  md.push('A live grant must set the real envelope; the proposal is not an authorization.')
  md.push('')
  const mdPath = join(OUT, 'budget-sensitivity-design.md')
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

  process.stdout.write(`budget design: ${cells.length} cells; campaign ${CAMPAIGN}; executionAuthorized=false\n`)
  process.stdout.write(`wrote ${path}, ${mdPath}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('freeze-budget-sensitivity.mjs')) main()
