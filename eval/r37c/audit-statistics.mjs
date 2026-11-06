#!/usr/bin/env node
/**
 * R37-C0-D: case-level audit of the R37-B Stage 2 statistics.
 *
 * The original exact McNemar test is preserved. This audit adds the analyses
 * the brief requires: per-case effects, leave-one-case-out, a case-level sign
 * test, and sensitivity to the benchmark cases that carry known confounds.
 *
 *   node eval/r37c/audit-statistics.mjs
 *
 * @module eval/r37c/audit-statistics
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson } from '../r37/src/io.mjs'
import { leaveOneCaseOut, perCase, summarize } from './src/stats.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R37_ROOT = process.env.R37C_R37_ROOT === undefined
  ? resolve(ROOT, '..', 'ef-r37-action', 'eval', 'r37')
  : resolve(process.env.R37C_R37_ROOT)
const OUT = join(HERE, 'out', 'statistics-audit.json')

const results = await readJson(join(R37_ROOT, 'out', 'r37b-stage2-results.json'))
const authoritative = await readJson(join(R37_ROOT, 'out', 'r37b-stage2-statistics.json'))
const pairs = (results.e2e?.pairsDetail ?? []).filter(pair => pair.valid === true)
const contractSelector = pair => pair.treatment.contract === true
const baselineContractSelector = pair => pair.baseline.contract === true
const taskSelector = pair => pair.treatment.task === true
const baselineTaskSelector = pair => pair.baseline.task === true

const identity = value => value === true

function paired(pair, selector, baselineSelector) {
  return {
    caseId: pair.caseId,
    treatment: selector(pair),
    baseline: baselineSelector(pair),
  }
}

function summarizeSelector(selector, baselineSelector) {
  return summarize(
    pairs.map(pair => paired(pair, selector, baselineSelector)),
    identity,
  )
}

const contract = summarizeSelector(contractSelector, baselineContractSelector)
const task = summarizeSelector(taskSelector, baselineTaskSelector)
const contractLoo = leaveOneCaseOut(
  pairs.map(pair => paired(pair, contractSelector, baselineContractSelector)),
  identity,
)
const taskLoo = leaveOneCaseOut(
  pairs.map(pair => paired(pair, taskSelector, baselineTaskSelector)),
  identity,
)

function sensitivity(label, excludedCases) {
  const selected = pairs.filter(pair => !excludedCases.includes(pair.caseId))
  return {
    label,
    excludedCases,
    contract: summarize(
      selected.map(pair => paired(pair, contractSelector, baselineContractSelector)),
      identity,
    ),
    task: summarize(
      selected.map(pair => paired(pair, taskSelector, baselineTaskSelector)),
      identity,
    ),
  }
}

const sensitivities = [
  sensitivity('exclude-versioned-execution-controls', ['A1-v2', 'D1-v2']),
  sensitivity('exclude-C1-implementation-floor', ['C1']),
  sensitivity('exclude-H1-operationalization-case', ['H1']),
  sensitivity('exclude-A1-v2-only', ['A1-v2']),
  sensitivity('exclude-D1-v2-only', ['D1-v2']),
]

const comparison = {
  contract: {
    authoritativeP: authoritative.contract?.p ?? null,
    recomputedP: contract.mcnemar.p,
    authoritativeDifference: authoritative.contract?.difference ?? null,
    recomputedDifference: contract.difference,
    authoritativeCi95: authoritative.contract?.bootstrap?.ci95 ?? null,
    recomputedCi95: contract.bootstrap.ci95,
    match: authoritative.contract?.p === contract.mcnemar.p
      && Math.abs((authoritative.contract?.difference ?? 0) - contract.difference) < 1e-12,
  },
  task: {
    authoritativeP: authoritative.task?.p ?? null,
    recomputedP: task.mcnemar.p,
    authoritativeDifference: authoritative.task?.difference ?? null,
    recomputedDifference: task.difference,
    match: authoritative.task?.p === task.mcnemar.p
      && Math.abs((authoritative.task?.difference ?? 0) - task.difference) < 1e-12,
  },
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C0-D',
  source: {
    results: 'eval/r37/out/r37b-stage2-results.json',
    statistics: 'eval/r37/out/r37b-stage2-statistics.json',
    pairs: pairs.length,
    cases: [...new Set(pairs.map(pair => pair.caseId))].length,
    replicatesPerCase: pairs.length / [...new Set(pairs.map(pair => pair.caseId))].length,
  },
  contract,
  task,
  leaveOneCaseOut: {
    contract: contractLoo,
    task: taskLoo,
  },
  sensitivities,
  comparison,
  interpretation: {
    originalTest: 'exact McNemar on 36 correlated pairs; arithmetically correct, dependency not modeled',
    caseDirection: contract.caseDirection,
    caseSignTestP: contract.signTest.p,
    leaveOneCaseOutPRange: [
      Math.min(...contractLoo.map(entry => entry.p)),
      Math.max(...contractLoo.map(entry => entry.p)),
    ],
    conclusion: 'The direction is consistently negative across five of six cases; the case-level sign test is p=0.0625. '
      + 'The original p=0.0215 is not replaced, but it should not be read as a population-level precision claim.',
  },
  notes: [
    'Six cases are the sampling unit; six replicates per case are not six independent experiments.',
    'The case-clustered bootstrap is descriptive, not a population confidence interval.',
    'Leave-one-case-out shows how much the exact McNemar result depends on one case; it is a sensitivity analysis, not a new primary test.',
    'No threshold was changed after seeing the result.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`R37-C statistics audit: ${OUT}\n`)
process.stdout.write(`contract: S ${(contract.sRate * 100).toFixed(1)}% vs B1 ${(contract.b1Rate * 100).toFixed(1)}%; `
  + `diff ${(contract.difference * 100).toFixed(1)} pp; McNemar ${contract.rescue}/${contract.damage} p=${contract.mcnemar.p}; `
  + `sign ${contract.caseDirection.negative} negative/${contract.caseDirection.positive} positive, p=${contract.signTest.p}\n`)
process.stdout.write(`task: diff ${(task.difference * 100).toFixed(1)} pp; p=${task.mcnemar.p}\n`)
for (const entry of contractLoo) {
  process.stdout.write(`  exclude ${entry.excluded}: ${entry.rescue}/${entry.damage}, p=${entry.p}, diff ${(entry.difference * 100).toFixed(1)} pp\n`)
}
for (const entry of sensitivities) {
  process.stdout.write(`  ${entry.label}: contract ${entry.contract.rescue}/${entry.contract.damage}, p=${entry.contract.mcnemar.p}, `
    + `diff ${(entry.contract.difference * 100).toFixed(1)} pp\n`)
}
