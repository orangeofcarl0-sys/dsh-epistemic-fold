#!/usr/bin/env node
/**
 * R37-B Stage 2 statistics.
 *
 * Reports the preregistered paired contrast:
 *   - exact McNemar on discordant B1/S pairs
 *   - case-clustered bootstrap of the contract-success difference
 *
 * The bootstrap resamples CASES, not rows, because the six cases are the
 * sampling unit. It is descriptive: six cases cannot support a precise
 * population interval, and the report says so.
 *
 * @module eval/r37/stats-r37b
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson } from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'r37b-stage2-statistics.json')
const results = await readJson(join(HERE, 'out', 'r37b-stage2-results.json'))

function combinations(n, k) {
  if (k < 0 || k > n) return 0
  let value = 1
  for (let index = 1; index <= k; index += 1) value = value * (n - k + index) / index
  return value
}

function exactMcNemar(wins, losses) {
  const n = wins + losses
  if (n === 0) return { n: 0, p: null, note: 'no discordant pairs' }
  const tail = Math.min(wins, losses)
  let probability = 0
  for (let index = 0; index <= tail; index += 1) {
    probability += combinations(n, index) / (2 ** n)
  }
  return {
    wins,
    losses,
    n,
    p: Math.min(1, 2 * probability),
    method: 'two-sided exact binomial on discordant pairs',
  }
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return null
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

function clusterBootstrap(pairs, treatmentSelector, baselineSelector, iterations = 10_000, seed = 3701) {
  const byCase = new Map()
  for (const pair of pairs) {
    if (!byCase.has(pair.caseId)) byCase.set(pair.caseId, [])
    byCase.get(pair.caseId).push(pair)
  }
  const cases = [...byCase.keys()].sort()
  if (cases.length === 0) return { iterations, cases: 0, difference: null, ci95: null }
  const random = mulberry32(seed)
  const observedTreatment = pairs.reduce((total, pair) => total + (treatmentSelector(pair) ? 1 : 0), 0) / pairs.length
  const observedBaseline = pairs.reduce((total, pair) => total + (baselineSelector(pair) ? 1 : 0), 0) / pairs.length
  const observedDifference = observedTreatment - observedBaseline
  const differences = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = []
    for (let draw = 0; draw < cases.length; draw += 1) {
      const caseId = cases[Math.floor(random() * cases.length)]
      sample.push(...byCase.get(caseId))
    }
    const treatment = sample.reduce((total, pair) => total + (treatmentSelector(pair) ? 1 : 0), 0) / sample.length
    const baseline = sample.reduce((total, pair) => total + (baselineSelector(pair) ? 1 : 0), 0) / sample.length
    differences.push(treatment - baseline)
  }
  differences.sort((left, right) => left - right)
  return {
    iterations,
    cases: cases.length,
    observedTreatment,
    observedBaseline,
    difference: observedDifference,
    ci95: [quantile(differences, 0.025), quantile(differences, 0.975)],
    note: 'Case-clustered bootstrap of the S-minus-B1 rate difference; six cases make it descriptive, not a population estimate.',
  }
}

const contractPairs = results.e2e.pairsDetail.filter(pair => pair.valid === true)
const contract = exactMcNemar(
  contractPairs.filter(pair => pair.contractOutcome === 'rescue').length,
  contractPairs.filter(pair => pair.contractOutcome === 'damage').length,
)
const task = exactMcNemar(
  contractPairs.filter(pair => pair.taskOutcome === 'rescue').length,
  contractPairs.filter(pair => pair.taskOutcome === 'damage').length,
)
const sContract = contractPairs.reduce((total, pair) => total + (pair.treatment.contract ? 1 : 0), 0) / contractPairs.length
const b1Contract = contractPairs.reduce((total, pair) => total + (pair.baseline.contract ? 1 : 0), 0) / contractPairs.length
const sTask = contractPairs.reduce((total, pair) => total + (pair.treatment.task ? 1 : 0), 0) / contractPairs.length
const b1Task = contractPairs.reduce((total, pair) => total + (pair.baseline.task ? 1 : 0), 0) / contractPairs.length

const representation = (results.representation?.paired ?? []).map(contrast => ({
  caseId: contrast.caseId,
  treatment: contrast.treatment,
  baseline: contrast.baseline,
  wins: contrast.wins,
  losses: contrast.losses,
  ties: contrast.ties,
  ...exactMcNemar(contrast.wins, contrast.losses),
}))

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  stage: 2,
  source: 'eval/r37/out/r37b-stage2-results.json',
  pairs: contractPairs.length,
  contract: {
    sRate: sContract,
    b1Rate: b1Contract,
    difference: sContract - b1Contract,
    ...contract,
    bootstrap: clusterBootstrap(
      contractPairs,
      pair => pair.treatment.contract,
      pair => pair.baseline.contract,
    ),
  },
  task: {
    sRate: sTask,
    b1Rate: b1Task,
    difference: sTask - b1Task,
    ...task,
    bootstrap: clusterBootstrap(
      contractPairs,
      pair => pair.treatment.task,
      pair => pair.baseline.task,
    ),
  },
  representation,
  warnings: [
    'Stage 2 has six cases; the cluster bootstrap is descriptive, not a population interval.',
    'A difference here is an assigned-arm effect under one model, one route, and one harness.',
    'Eight of the nine contract damages are implementation/process; H1 is the only fact-visible action-inconsistent case.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`Stage 2 statistics: ${OUT}\n`)
process.stdout.write(`contract S ${(sContract * 100).toFixed(1)}% vs B1 ${(b1Contract * 100).toFixed(1)}%; `
  + `difference ${((sContract - b1Contract) * 100).toFixed(1)} pp; McNemar p=${contract.p}\n`)
process.stdout.write(`task S ${(sTask * 100).toFixed(1)}% vs B1 ${(b1Task * 100).toFixed(1)}%; p=${task.p}\n`)
for (const entry of representation) {
  process.stdout.write(`representation ${entry.caseId} ${entry.treatment} vs ${entry.baseline}: `
    + `${entry.wins} wins / ${entry.losses} losses / ${entry.ties} ties; p=${entry.p}\n`)
}
