#!/usr/bin/env node
/**
 * R37-C2: analyze the bounded process-causal pilot.
 *
 * This is descriptive. The pilot has 24 continuation cells at most; it cannot
 * support a significance claim or a product-level benefit claim. It reports:
 *
 *   guard effect under B1
 *   guard effect under S
 *   B1/S difference with the guard disabled
 *   B1/S difference with the guard enabled
 *   an exploratory guard x Active interaction
 *
 * @module eval/r37c/analyze-process-pilot
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readJson, writeJson } from '../r37/src/io.mjs'
import { actualDelivery } from '../r37/src/evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = process.env.R37C_C2_RESULTS === undefined
  ? join(HERE, 'out', 'r37c-c2-results.json')
  : process.env.R37C_C2_RESULTS
const OUT = join(HERE, 'out', 'r37c-c2-analysis.json')

const results = await readJson(RESULTS)
// The pilot's first cells were written before the finishRequests field name was
// corrected. Read the report's finishGuard block so the analysis does not
// inherit a null from the summary row.
for (const entry of results.results ?? []) {
  if (entry.reportPath === undefined || !await exists(entry.reportPath)) continue
  try {
    const report = await readJson(entry.reportPath)
    const row = report.rows?.[0]
    if (row !== undefined && entry.row !== null) {
      entry.row.finishRequests = row.behaviourDetail?.finishGuard?.finishRequests ?? entry.row.finishRequests
      entry.row.finishRejections = row.behaviourDetail?.finishGuard?.rejections ?? entry.row.finishRejections
      entry.row.guardAssistedCompletion = row.behaviourDetail?.finishGuard?.assistedCompletion ?? entry.row.guardAssistedCompletion
      entry.row.testsExecuted = row.behaviourDetail?.testsExecuted ?? entry.row.testsExecuted
      entry.row.steps = row.behaviourDetail?.steps ?? entry.row.steps
      entry.row.modelCalls = row.behaviourDetail?.modelCalls ?? entry.row.modelCalls
      entry.delivery = actualDelivery(row)
    }
  } catch {
    // A missing report is already represented by the pilot's status.
  }
}
const cells = (results.results ?? [])
  .filter(entry => entry.status === 'executed' && entry.row !== null)
  .map(entry => ({
    ...entry.cell,
    runId: entry.runId,
    valid: entry.row.valid === true && entry.row.measurementValid === true,
    outcome: entry.row.outcome,
    contract: entry.row.contractSuccess === true,
    task: entry.row.taskSuccess === true,
    testsExecuted: entry.row.testsExecuted ?? 0,
    steps: entry.row.steps ?? null,
    modelCalls: entry.row.modelCalls ?? null,
    finishRequests: entry.row.finishRequests ?? 0,
    finishRejections: entry.row.finishRejections ?? 0,
    assistedCompletion: entry.row.guardAssistedCompletion === true,
    failedChecks: entry.row.failedChecks ?? [],
    delivery: entry.delivery ?? entry.row.writerCommitStatus ?? null,
    fallback: entry.row.foldFallback ?? null,
    validActions: entry.row.validActions ?? 0,
    rejectedActions: entry.row.rejectedActions ?? 0,
    invalidActionTurns: entry.row.invalidActionTurns ?? 0,
  }))

function rate(part, total) {
  return total === 0 ? null : part / total
}

function summarize(selected) {
  return {
    cells: selected.length,
    valid: selected.filter(cell => cell.valid).length,
    contractSuccesses: selected.filter(cell => cell.contract).length,
    taskSuccesses: selected.filter(cell => cell.task).length,
    contractRate: rate(selected.filter(cell => cell.contract).length, selected.length),
    taskRate: rate(selected.filter(cell => cell.task).length, selected.length),
    testsExecuted: selected.reduce((total, cell) => total + cell.testsExecuted, 0),
    finishRequests: selected.reduce((total, cell) => total + cell.finishRequests, 0),
    finishRejections: selected.reduce((total, cell) => total + cell.finishRejections, 0),
    assistedCompletions: selected.filter(cell => cell.assistedCompletion).length,
    invalidActionTurns: selected.reduce((total, cell) => total + cell.invalidActionTurns, 0),
    rejectedActions: selected.reduce((total, cell) => total + cell.rejectedActions, 0),
    stepLimitCells: selected.filter(cell => cell.steps !== null && cell.steps >= 8 && !cell.contract).length,
    delivery: selected.reduce((counts, cell) => {
      const key = cell.delivery ?? 'unknown'
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
  }
}

function byKey(keys, selector) {
  const result = {}
  for (const key of keys) {
    const selected = cells.filter(cell => selector(cell, key))
    result[key] = summarize(selected)
  }
  return result
}

const arms = [...new Set(cells.map(cell => cell.arm))].sort()
const guards = [...new Set(cells.map(cell => cell.guard))].sort()
const cases = [...new Set(cells.map(cell => cell.caseId))].sort()
const cellsByArmGuard = {}
for (const arm of arms) {
  cellsByArmGuard[arm] = {}
  for (const guard of guards) {
    cellsByArmGuard[arm][guard] = summarize(cells.filter(cell => cell.arm === arm && cell.guard === guard))
  }
}
const byCase = {}
for (const caseId of cases) {
  byCase[caseId] = {}
  for (const arm of arms) {
    byCase[caseId][arm] = {}
    for (const guard of guards) {
      byCase[caseId][arm][guard] = summarize(cells.filter(cell =>
        cell.caseId === caseId && cell.arm === arm && cell.guard === guard))
    }
  }
}

function difference(treatment, baseline, key) {
  const left = treatment?.[key]
  const right = baseline?.[key]
  if (typeof left !== 'number' || typeof right !== 'number') return null
  return left - right
}

const effects = {
  guardUnderB1: {
    contract: difference(cellsByArmGuard.B1?.G1, cellsByArmGuard.B1?.G0, 'contractRate'),
    task: difference(cellsByArmGuard.B1?.G1, cellsByArmGuard.B1?.G0, 'taskRate'),
  },
  guardUnderS: {
    contract: difference(cellsByArmGuard.S?.G1, cellsByArmGuard.S?.G0, 'contractRate'),
    task: difference(cellsByArmGuard.S?.G1, cellsByArmGuard.S?.G0, 'taskRate'),
  },
  activeUnderG0: {
    contract: difference(cellsByArmGuard.S?.G0, cellsByArmGuard.B1?.G0, 'contractRate'),
    task: difference(cellsByArmGuard.S?.G0, cellsByArmGuard.B1?.G0, 'taskRate'),
  },
  activeUnderG1: {
    contract: difference(cellsByArmGuard.S?.G1, cellsByArmGuard.B1?.G1, 'contractRate'),
    task: difference(cellsByArmGuard.S?.G1, cellsByArmGuard.B1?.G1, 'taskRate'),
  },
}
effects.interaction = {
  contract: effects.guardUnderS.contract !== null && effects.guardUnderB1.contract !== null
    ? effects.guardUnderS.contract - effects.guardUnderB1.contract
    : null,
  task: effects.guardUnderS.task !== null && effects.guardUnderB1.task !== null
    ? effects.guardUnderS.task - effects.guardUnderB1.task
    : null,
  note: 'Exploratory difference-in-differences; the pilot is not powered for an interaction test.',
}

// Paired B1/S outcomes per case, replicate, and guard.
const pairs = []
for (const caseId of cases) {
  const replicates = [...new Set(cells.filter(cell => cell.caseId === caseId).map(cell => cell.replicateId))].sort()
  for (const replicateId of replicates) {
    for (const guard of guards) {
      const baseline = cells.find(cell => cell.caseId === caseId && cell.replicateId === replicateId
        && cell.guard === guard && cell.arm === 'B1')
      const treatment = cells.find(cell => cell.caseId === caseId && cell.replicateId === replicateId
        && cell.guard === guard && cell.arm === 'S')
      if (baseline === undefined || treatment === undefined) continue
      pairs.push({
        caseId,
        replicateId,
        guard,
        baseline: { contract: baseline.contract, task: baseline.task, valid: baseline.valid },
        treatment: { contract: treatment.contract, task: treatment.task, valid: treatment.valid },
        contractOutcome: treatment.contract === baseline.contract
          ? 'tie'
          : treatment.contract ? 'rescue' : 'damage',
        taskOutcome: treatment.task === baseline.task
          ? 'tie'
          : treatment.task ? 'rescue' : 'damage',
      })
    }
  }
}
const pairSummary = {}
for (const guard of guards) {
  const selected = pairs.filter(pair => pair.guard === guard)
  pairSummary[guard] = {
    pairs: selected.length,
    contract: {
      rescue: selected.filter(pair => pair.contractOutcome === 'rescue').length,
      damage: selected.filter(pair => pair.contractOutcome === 'damage').length,
      ties: selected.filter(pair => pair.contractOutcome === 'tie').length,
    },
    task: {
      rescue: selected.filter(pair => pair.taskOutcome === 'rescue').length,
      damage: selected.filter(pair => pair.taskOutcome === 'damage').length,
      ties: selected.filter(pair => pair.taskOutcome === 'tie').length,
    },
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C2',
  status: results.status,
  stopReason: results.stopReason ?? null,
  design: {
    cases,
    arms,
    guards,
    cells: cells.length,
    planned: results.plan?.cells ?? null,
    replicates: results.plan?.replicates ?? null,
    protocol: results.protocol ?? null,
    harness: results.harness ?? null,
    model: results.model ?? null,
  },
  usage: results.budget ?? null,
  byArmGuard: cellsByArmGuard,
  byCase,
  effects,
  pairs,
  pairSummary,
  conclusions: [
    'The pilot is descriptive; no significance or product-level benefit claim is made.',
    'A guard effect is a change in contract or task success between G0 and G1 within one arm.',
    'The interaction is exploratory and is not a powered test.',
    'A fold refusal or fallback remains in the assigned-arm denominator.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`R37-C C2 analysis: ${OUT}\n`)
for (const arm of arms) {
  for (const guard of guards) {
    const entry = cellsByArmGuard[arm][guard]
    process.stdout.write(`${arm}/${guard}: ${entry.contractSuccesses}/${entry.cells} contract, `
      + `${entry.taskSuccesses}/${entry.cells} task, tests ${entry.testsExecuted}, `
      + `finish ${entry.finishRequests}/${entry.finishRejections}, assisted ${entry.assistedCompletions}\n`)
  }
}
process.stdout.write(`effects ${JSON.stringify(effects)}\n`)
