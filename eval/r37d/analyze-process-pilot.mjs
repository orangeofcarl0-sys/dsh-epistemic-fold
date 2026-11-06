#!/usr/bin/env node
/**
 * R37-D WP4 analysis: the fixed-context process-prompt pilot.
 *
 * The pilot is exploratory: three replicates per condition, one model, two
 * cases. This script reports descriptive differences, not significance.
 *
 * Output:
 *   eval/r37d/out/process-pilot-analysis.json
 *
 * @module eval/r37d/analyze-process-pilot
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, 'out', 'process-pilot-results.json')
const OUT = join(HERE, 'out', 'process-pilot-analysis.json')

const results = JSON.parse(await readFile(RESULTS, 'utf8'))
const executed = results.results.filter(entry => entry.status === 'executed' && entry.summary !== null)

function condition(caseId, arm, prompt) {
  return executed.filter(entry => entry.cell.caseId === caseId
    && entry.cell.arm === arm
    && entry.cell.condition === prompt)
}

function summarize(list) {
  return {
    cells: list.length,
    legacyContract: list.filter(entry => entry.summary.legacyContractSuccess).length,
    operational: list.filter(entry => entry.summary.operationalCompletion).length,
    strictFinish: list.filter(entry => entry.summary.operationalStrictFinish).length,
    testsExecuted: list.reduce((sum, entry) => sum + (entry.summary.testsExecuted ?? 0), 0),
    finishRequests: list.reduce((sum, entry) => sum + (entry.summary.finishRequests ?? 0), 0),
    stepLimit: list.filter(entry => entry.summary.stepLimitTermination).length,
    noValidActionCalls: list.reduce((sum, entry) => sum + (entry.summary.noValidActionCalls ?? 0), 0),
  }
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

function effect(a, b, key) {
  const left = summarize(a)
  const right = summarize(b)
  return {
    p0: left[key],
    p1: right[key],
    difference: right[key] - left[key],
    p0Rate: rate(left[key], left.cells),
    p1Rate: rate(right[key], right.cells),
    rateDifference: left.cells === 0 || right.cells === 0
      ? null
      : rate(right[key], right.cells) - rate(left[key], left.cells),
  }
}

const conditions = {}
for (const caseId of ['B2', 'D1-v2']) {
  for (const arm of ['B1', 'S']) {
    for (const prompt of ['P0', 'P1']) {
      conditions[`${caseId}/${arm}/${prompt}`] = summarize(condition(caseId, arm, prompt))
    }
  }
}

const effects = {
  promptUnderB1: {
    legacyContract: effect(condition('B2', 'B1', 'P0').concat(condition('D1-v2', 'B1', 'P0')),
      condition('B2', 'B1', 'P1').concat(condition('D1-v2', 'B1', 'P1')), 'legacyContract'),
    operational: effect(condition('B2', 'B1', 'P0').concat(condition('D1-v2', 'B1', 'P0')),
      condition('B2', 'B1', 'P1').concat(condition('D1-v2', 'B1', 'P1')), 'operational'),
  },
  promptUnderS: {
    legacyContract: effect(condition('B2', 'S', 'P0').concat(condition('D1-v2', 'S', 'P0')),
      condition('B2', 'S', 'P1').concat(condition('D1-v2', 'S', 'P1')), 'legacyContract'),
    operational: effect(condition('B2', 'S', 'P0').concat(condition('D1-v2', 'S', 'P0')),
      condition('B2', 'S', 'P1').concat(condition('D1-v2', 'S', 'P1')), 'operational'),
  },
  byCase: {},
}

for (const caseId of ['B2', 'D1-v2']) {
  for (const arm of ['B1', 'S']) {
    effects.byCase[`${caseId}/${arm}`] = {
      legacyContract: effect(condition(caseId, arm, 'P0'), condition(caseId, arm, 'P1'), 'legacyContract'),
      operational: effect(condition(caseId, arm, 'P0'), condition(caseId, arm, 'P1'), 'operational'),
    }
  }
}

const b1Operational = effects.promptUnderB1.operational.rateDifference
const sOperational = effects.promptUnderS.operational.rateDifference
const interaction = b1Operational === null || sOperational === null ? null : sOperational - b1Operational

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP4-process-pilot-analysis',
  source: RESULTS,
  status: results.status,
  stopReason: results.stopReason,
  executed: executed.length,
  planned: results.summary.cells,
  conditions,
  effects: {
    ...effects,
    interaction: {
      operationalRateDifference: interaction,
      note: 'Exploratory difference-in-differences. The pilot is not powered for an interaction test.',
    },
  },
  conclusions: [
    'The pilot is exploratory: three replicates per condition, one model, two cases.',
    'The fixed context is the frozen WP3 checkpoint; no writer was regenerated.',
    'The guard is off in every cell, so any difference is the process prompt, not the guard.',
    'No significance claim is made.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`R37-D process pilot analysis: ${OUT}\n`)
process.stdout.write(`executed ${executed.length}/${results.summary.cells}; status ${results.status}; stop ${results.stopReason ?? 'none'}\n`)
for (const [key, value] of Object.entries(conditions)) {
  process.stdout.write(`  ${key}  legacy ${value.legacyContract}/${value.cells}  operational ${value.operational}/${value.cells}  `
    + `tests ${value.testsExecuted}  finish ${value.finishRequests}  step-limit ${value.stepLimit}\n`)
}
process.stdout.write(`P1-P0 operational under B1 ${b1Operational}; under S ${sOperational}; interaction ${interaction}\n`)
