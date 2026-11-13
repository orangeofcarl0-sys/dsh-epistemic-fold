#!/usr/bin/env node
/**
 * EF-R4 WP6 — analyze a step-budget campaign, partial or complete.
 *
 * The runner stops on the first unknown usage or transport failure. A partial
 * campaign is still readable: executed cells are scored, never-started cells
 * are reported as missing, and a local `BUDGET_EXHAUSTED` auxiliary call is
 * counted separately from a model result.
 *
 *   node eval/r4/analyze-budget-campaign.mjs --campaign e2e-r4-budget-sensitivity-1
 *
 * @module eval/r4/analyze-budget-campaign
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadCampaign, loadCell } from './shared/audit.mjs'
import { exactMcNemar, scoreReport } from './score.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const ARMS = ['B0', 'E0', 'E1']
const BUDGETS = [8, 16]
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

function campaignFromArgv() {
  const at = process.argv.indexOf('--campaign')
  return at === -1 || process.argv[at + 1] === undefined
    ? process.env.EF_R4_CAMPAIGN ?? 'e2e-r4-budget-sensitivity-1'
    : process.argv[at + 1]
}

function budgetAbortsOf(report) {
  return (report?.requests ?? []).filter(request =>
    request.finish?.failure?.code === 'BUDGET_EXHAUSTED'
    || request.finish?.kind === 'error' && request.finish?.failure?.code === 'BUDGET_EXHAUSTED').length
}

function aggregate(cells) {
  const byArmBudget = {}
  for (const arm of ARMS) {
    for (const budget of BUDGETS) {
      const subset = cells.filter(cell => cell.arm === arm && cell.budget === budget)
      byArmBudget[`${arm}-${budget}`] = {
        cells: subset.length,
        taskCorrect: subset.filter(cell => cell.taskOutcome === 'correct').length,
        taskIncorrect: subset.filter(cell => cell.taskOutcome === 'incorrect').length,
        taskIncomplete: subset.filter(cell => cell.taskOutcome === 'incomplete').length,
        stepLimited: subset.filter(cell => cell.termination === 'step-limit').length,
        mechanismMet: subset.filter(cell => cell.mechanism === true).length,
        costValid: subset.filter(cell => cell.costValid === true).length,
        requests: subset.reduce((sum, cell) => sum + (cell.requests ?? 0), 0),
        inputTokens: subset.reduce((sum, cell) => sum + (cell.inputTokens ?? 0), 0),
        outputTokens: subset.reduce((sum, cell) => sum + (cell.outputTokens ?? 0), 0),
        budgetAborts: subset.reduce((sum, cell) => sum + cell.budgetAborts, 0),
      }
    }
  }
  return byArmBudget
}

function pair(cells, left, right) {
  const key = cell => `${cell.task}-r${cell.replicate}`
  const rightByKey = new Map(cells
    .filter(cell => cell.arm === right.arm && cell.budget === right.budget)
    .map(cell => [key(cell), cell]))
  const rows = cells
    .filter(cell => cell.arm === left.arm && cell.budget === left.budget)
    .map(cell => {
      const other = rightByKey.get(key(cell))
      if (other === undefined) return null
      const leftPass = cell.taskOutcome === 'correct'
      const rightPass = other.taskOutcome === 'correct'
      return { leftPass, rightPass, both: leftPass && rightPass, neither: !leftPass && !rightPass, leftOnly: leftPass && !rightPass, rightOnly: !leftPass && rightPass }
    })
    .filter(row => row !== null)
  return {
    pairs: rows.length,
    both: rows.filter(row => row.both).length,
    neither: rows.filter(row => row.neither).length,
    leftOnly: rows.filter(row => row.leftOnly).length,
    rightOnly: rows.filter(row => row.rightOnly).length,
    mcnemarP: exactMcNemar(rows.filter(row => row.leftOnly).length, rows.filter(row => row.rightOnly).length),
  }
}

function main() {
  const campaign = campaignFromArgv()
  const loaded = loadCampaign({ campaign })
  const results = loaded.results
  const executed = (results.results ?? []).filter(row => row.status === 'executed')
  const cells = []
  for (const row of executed) {
    const cell = loadCell({ root: ROOT, row, tasks: loaded.tasks })
    if (cell.report === null) continue
    const score = scoreReport({
      report: cell.report,
      task: cell.task,
      historicalPass: row.checker === true,
    })
    cells.push({
      cellId: row.cellId,
      task: row.cell?.task ?? cell.taskId,
      arm: row.cell?.arm ?? cell.arm,
      replicate: row.cell?.replicate ?? cell.replicate,
      budget: row.cell?.maxSteps ?? null,
      taskOutcome: score.taskOutcome,
      historicalPass: score.historicalPass,
      mechanism: score.mechanism?.requiredFoldCountMet ?? null,
      termination: score.termination.kind,
      stepLimitStage: score.termination.stepLimitStage,
      costValid: score.cost.usageCompleteR4,
      requests: score.cost.requests,
      inputTokens: score.cost.inputTokens,
      outputTokens: score.cost.outputTokens,
      budgetAborts: budgetAbortsOf(cell.report),
    })
  }

  const plannedCells = (results.results ?? [])
    .filter(row => row.status !== 'executed')
    .map(row => ({
      task: row.cell?.task ?? null,
      arm: row.cell?.arm ?? null,
      budget: row.cell?.maxSteps ?? null,
      reason: row.reason ?? null,
    }))

  const comparisons = []
  for (const arm of ARMS) {
    comparisons.push({
      id: `${arm}-16-vs-8`,
      left: `${arm}@16`,
      right: `${arm}@8`,
      ...pair(cells, { arm, budget: 16 }, { arm, budget: 8 }),
    })
  }
  for (const budget of BUDGETS) {
    comparisons.push({
      id: `E1-vs-B0@${budget}`,
      left: `E1@${budget}`,
      right: `B0@${budget}`,
      ...pair(cells, { arm: 'E1', budget }, { arm: 'B0', budget }),
    })
  }

  const output = {
    schemaVersion: 1,
    work: 'EF-R4 budget-sensitivity campaign',
    generatedAt: new Date().toISOString(),
    campaign,
    status: results.status,
    stopReason: results.stopReason,
    planned: results.planned,
    executed: results.executed,
    partial: results.executed !== results.planned,
    budgetAborts: cells.reduce((sum, cell) => sum + cell.budgetAborts, 0),
    cellsWithBudgetAborts: cells.filter(cell => cell.budgetAborts > 0).map(cell => cell.cellId),
    byArmBudget: aggregate(cells),
    comparisons,
    cells,
    notExecuted: plannedCells,
    limits: [
      'A local BUDGET_EXHAUSTED auxiliary call is an envelope defect, not a model outcome; it is counted separately.',
      'A partial campaign does not support a budget-effect claim.',
      'The campaign is one model, one route and one host.',
    ],
  }

  mkdirSync(OUT, { recursive: true })
  const jsonPath = join(OUT, `budget-campaign-${campaign}.json`)
  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  const md = []
  md.push(`# EF-R4 budget-sensitivity campaign — ${campaign}`)
  md.push('')
  md.push(`Status: **${results.status}**, stop: \`${results.stopReason ?? 'none'}\`, executed **${results.executed}/${results.planned}**.`)
  md.push('')
  md.push('| Arm | Budget | Cells | Correct | Incorrect | Incomplete | Step-limited | Mechanism | Cost-valid | Budget aborts | Requests | Input | Output |')
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const arm of ARMS) {
    for (const budget of BUDGETS) {
      const row = output.byArmBudget[`${arm}-${budget}`]
      md.push(`| ${arm} | ${budget} | ${row.cells} | ${row.taskCorrect} | ${row.taskIncorrect} | ${row.taskIncomplete} | ${row.stepLimited} | ${row.mechanismMet} | ${row.costValid} | ${row.budgetAborts} | ${row.requests} | ${row.inputTokens} | ${row.outputTokens} |`)
    }
  }
  md.push('')
  md.push('## Paired comparisons')
  md.push('')
  md.push('| Comparison | Pairs | Both | Neither | Left only | Right only | p |')
  md.push('|---|---|---|---|---|---|---|')
  for (const row of comparisons) {
    md.push(`| ${row.id} | ${row.pairs} | ${row.both} | ${row.neither} | ${row.leftOnly} | ${row.rightOnly} | ${row.mcnemarP} |`)
  }
  md.push('')
  if (output.budgetAborts > 0) {
    md.push(`**Budget aborts:** ${output.budgetAborts} in ${output.cellsWithBudgetAborts.join(', ')}. These are local \`BUDGET_EXHAUSTED\` auxiliary calls, not model outcomes.`)
    md.push('')
  }
  md.push('## Per-cell')
  md.push('')
  md.push('| Cell | Arm | Budget | Outcome | Mechanism | Termination | Cost-valid | Budget aborts |')
  md.push('|---|---|---|---|---|---|---|---|')
  for (const cell of cells.sort((left, right) => left.cellId.localeCompare(right.cellId))) {
    md.push(`| ${cell.cellId} | ${cell.arm} | ${cell.budget} | ${cell.taskOutcome} | ${cell.mechanism === null ? '—' : cell.mechanism ? 'met' : 'miss'} | ${cell.termination} | ${cell.costValid ? 'valid' : 'invalid'} | ${cell.budgetAborts} |`)
  }
  md.push('')
  const mdPath = join(OUT, `budget-campaign-${campaign}.md`)
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

  process.stdout.write(`budget campaign ${campaign}: ${results.status}; ${results.executed}/${results.planned}; budget aborts ${output.budgetAborts}\n`)
  process.stdout.write(`wrote ${jsonPath}, ${mdPath}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('analyze-budget-campaign.mjs')) main()
