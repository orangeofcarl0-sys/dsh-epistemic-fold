#!/usr/bin/env node
/**
 * EF-R3 product-lane — analyze the 18-cell pilot.
 *
 * The pilot ran 18/18 cells under the shipped economy preset at 32k. It is a
 * feasibility/quality/cost pilot, not a confirmatory campaign. This script
 * separates coverage (18/18), task outcome, treatment exposure, cost validity,
 * step-limit censoring and the exact-span probe, and records a conservative
 * decision.
 *
 *   node eval/r3/product-pilot-analysis.mjs
 *
 * @module eval/r3/product-pilot-analysis
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLedgers, summarizeLedger } from './ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const CAMPAIGN = 'e2e-r3-product-pilot-1'
const manifestPath = join(E2E_OUT, `manifest-${CAMPAIGN}.json`)
const resultsPath = join(E2E_OUT, `results-${CAMPAIGN}.json`)
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const exists = path => existsSync(path)

for (const path of [manifestPath, resultsPath]) {
  if (!exists(path)) {
    process.stderr.write(`product-pilot-analysis: ${path} is missing\n`)
    process.exit(2)
  }
}
const manifest = readJson(manifestPath)
const results = readJson(resultsPath)

function exactMcNemar(b, c) {
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

const sum = values => values.reduce((total, value) => total + value, 0)
function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const ledgers = buildLedgers({
  campaigns: [{
    campaign: CAMPAIGN,
    campaignIndex: 0,
    manifestPath,
    manifest,
    results,
  }],
  plannedCells: manifest.cells,
  planCampaign: { manifest },
})
const summary = summarizeLedger({
  planned: ledgers.planned,
  attempts: ledgers.attempts,
  cells: ledgers.cells,
  campaign: CAMPAIGN,
  unplannedAttempts: ledgers.unplannedAttempts,
})

function enrich(cell) {
  const report = cell.reportPath !== null && exists(cell.reportPath) ? readJson(cell.reportPath) : null
  const witness = cell.witnessSummary ?? report?.witnessSummary ?? null
  const usage = cell.usage ?? report?.usage ?? null
  const probe = report?.leafSpanProbe ?? null
  return {
    cellId: cell.cellId,
    task: cell.task,
    template: cell.task.replace(/-p\d$/u, ''),
    arm: cell.arm,
    replicate: cell.replicate,
    key: `${cell.task}-r${cell.replicate}`,
    status: cell.status,
    pass: cell.pass === true,
    costValid: cell.costValid === true,
    reasons: cell.reasons ?? [],
    requests: usage?.requests ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    auxiliaryRequests: usage?.auxiliaryRequests ?? 0,
    unknownUsage: usage?.unknownUsage ?? 0,
    attempts: witness?.attempts ?? 0,
    committed: witness?.committed ?? 0,
    refused: witness?.refused ?? 0,
    aborted: witness?.aborted ?? 0,
    delivered: witness?.committedAndDelivered ?? 0,
    termination: report?.termination?.kind ?? cell.termination?.kind ?? null,
    error: report?.termination?.error ?? null,
    durationMs: report?.termination?.durationMs ?? cell.termination?.durationMs ?? null,
    checksPassed: (report?.checker?.checks ?? []).filter(check => check.pass).length,
    checksTotal: (report?.checker?.checks ?? []).length,
    stepLimited: (report?.termination?.kind ?? cell.termination?.kind) === 'step-limit',
    probe: probe === null ? null : {
      widestTokens: probe.widest?.tokens ?? null,
      executedTokens: probe.executed?.tokens ?? null,
      gapTokens: probe.gapTokens,
      estimatedCheckpointTokens: probe.estimatedCheckpointTokens,
      admissionWouldAdmit: probe.admissionWouldAdmit,
      executionWouldAdmit: probe.executionWouldAdmit,
      falseAdmission: probe.falseAdmission,
      committed: probe.committed,
      actualCheckpointTokens: probe.actual?.checkpointTokens ?? null,
      actualReclaimTokens: probe.actual?.reclaimTokens ?? null,
      surfaceDeltaTokens: probe.actual?.surfaceDeltaTokens ?? null,
      reconciled: probe.actual?.reconciled ?? false,
    },
    reportPath: cell.reportPath,
  }
}

const cells = ledgers.cells.filter(cell => cell.status === 'valid').map(enrich)
const arms = [...new Set(cells.map(cell => cell.arm))].sort()

function aggregate(subset) {
  const passed = subset.filter(cell => cell.pass).length
  const probes = subset.map(cell => cell.probe).filter(probe => probe !== null)
  return {
    cells: subset.length,
    passed,
    rate: subset.length === 0 ? null : Number((passed / subset.length).toFixed(3)),
    costValid: subset.filter(cell => cell.costValid).length,
    costInvalid: subset.filter(cell => !cell.costValid).length,
    attempts: sum(subset.map(cell => cell.attempts)),
    committed: sum(subset.map(cell => cell.committed)),
    refused: sum(subset.map(cell => cell.refused)),
    aborted: sum(subset.map(cell => cell.aborted)),
    delivered: sum(subset.map(cell => cell.delivered)),
    cellsWithCommit: subset.filter(cell => cell.committed > 0).length,
    cellsWithDelivery: subset.filter(cell => cell.delivered > 0).length,
    requests: sum(subset.map(cell => cell.requests)),
    inputTokens: sum(subset.map(cell => cell.inputTokens)),
    outputTokens: sum(subset.map(cell => cell.outputTokens)),
    cacheReadTokens: sum(subset.map(cell => cell.cacheReadTokens)),
    cacheWriteTokens: sum(subset.map(cell => cell.cacheWriteTokens)),
    auxiliaryRequests: sum(subset.map(cell => cell.auxiliaryRequests)),
    unknownUsage: sum(subset.map(cell => cell.unknownUsage)),
    stepLimited: subset.filter(cell => cell.stepLimited).length,
    errors: subset.filter(cell => cell.error !== null).length,
    durationMs: {
      median: median(subset.map(cell => cell.durationMs).filter(value => typeof value === 'number')),
      max: subset.map(cell => cell.durationMs).filter(value => typeof value === 'number').length === 0
        ? null
        : Math.max(...subset.map(cell => cell.durationMs).filter(value => typeof value === 'number')),
    },
    terminationKinds: subset.reduce((counts, cell) => {
      const kind = cell.termination ?? 'unknown'
      counts[kind] = (counts[kind] ?? 0) + 1
      return counts
    }, {}),
    checksPassed: sum(subset.map(cell => cell.checksPassed)),
    checksTotal: sum(subset.map(cell => cell.checksTotal)),
    probe: {
      cells: probes.length,
      widestTokensMedian: median(probes.map(probe => probe.widestTokens).filter(value => value !== null)),
      executedTokensMedian: median(probes.map(probe => probe.executedTokens).filter(value => value !== null)),
      gapTokensMedian: median(probes.map(probe => probe.gapTokens).filter(value => value !== null)),
      actualCheckpointTokensMedian: median(probes.map(probe => probe.actualCheckpointTokens).filter(value => value !== null)),
      actualReclaimTokensMedian: median(probes.map(probe => probe.actualReclaimTokens).filter(value => value !== null)),
      reconciled: probes.filter(probe => probe.reconciled).length,
      falseAdmissions: probes.filter(probe => probe.falseAdmission).length,
    },
  }
}

const byArm = Object.fromEntries(arms.map(arm => [arm, aggregate(cells.filter(cell => cell.arm === arm))]))

function pair(leftArm, rightArm) {
  const byKey = new Map(cells.map(cell => [`${cell.key}:${cell.arm}`, cell]))
  const rows = []
  for (const key of new Set(cells.map(cell => cell.key))) {
    const left = byKey.get(`${key}:${leftArm}`)
    const right = byKey.get(`${key}:${rightArm}`)
    if (left === undefined || right === undefined) continue
    rows.push({
      key,
      left: left.cellId,
      right: right.cellId,
      leftPass: left.pass,
      rightPass: right.pass,
      leftCostValid: left.costValid,
      rightCostValid: right.costValid,
      leftTermination: left.termination,
      rightTermination: right.termination,
      delta: {
        pass: Number(left.pass) - Number(right.pass),
        requests: left.requests - right.requests,
        inputTokens: left.inputTokens - right.inputTokens,
        cacheReadTokens: left.cacheReadTokens - right.cacheReadTokens,
        outputTokens: left.outputTokens - right.outputTokens,
      },
    })
  }
  const both = rows.filter(row => row.leftPass && row.rightPass).length
  const neither = rows.filter(row => !row.leftPass && !row.rightPass).length
  const leftOnly = rows.filter(row => row.leftPass && !row.rightPass).length
  const rightOnly = rows.filter(row => !row.leftPass && row.rightPass).length
  const costRows = rows.filter(row => row.leftCostValid && row.rightCostValid)
  const delta = (subset, field) => sum(subset.map(row => row.delta[field]))
  return {
    left: leftArm,
    right: rightArm,
    pairs: rows.length,
    both,
    neither,
    leftOnly,
    rightOnly,
    mcnemarP: Number(exactMcNemar(leftOnly, rightOnly).toFixed(4)),
    recorded: {
      pass: delta(rows, 'pass'),
      requests: delta(rows, 'requests'),
      inputTokens: delta(rows, 'inputTokens'),
      cacheReadTokens: delta(rows, 'cacheReadTokens'),
      outputTokens: delta(rows, 'outputTokens'),
    },
    costValid: {
      pairs: costRows.length,
      pass: delta(costRows, 'pass'),
      requests: delta(costRows, 'requests'),
      inputTokens: delta(costRows, 'inputTokens'),
      cacheReadTokens: delta(costRows, 'cacheReadTokens'),
      outputTokens: delta(costRows, 'outputTokens'),
    },
    rows,
  }
}

const comparisons = []
for (const [left, right] of [['E1', 'B0'], ['E1', 'E0'], ['E0', 'B0']]) {
  if (arms.includes(left) && arms.includes(right)) comparisons.push(pair(left, right))
}

const byTemplate = Object.fromEntries([...new Set(cells.map(cell => cell.template))].sort().map(template => [
  template,
  Object.fromEntries(arms.map(arm => {
    const subset = cells.filter(cell => cell.template === template && cell.arm === arm)
    return [arm, subset.length === 0 ? null : {
      cells: subset.length,
      passed: subset.filter(cell => cell.pass).length,
      committed: sum(subset.map(cell => cell.committed)),
      delivered: sum(subset.map(cell => cell.delivered)),
      stepLimited: subset.filter(cell => cell.stepLimited).length,
      costValid: subset.filter(cell => cell.costValid).length,
    }]
  })),
]))

const healthPath = join(OUT, 'health-probe-results.json')
const prerequisitesPath = join(OUT, 'product-pilot-prerequisites.json')
const health = exists(healthPath) ? readJson(healthPath) : null
const prerequisites = exists(prerequisitesPath) ? readJson(prerequisitesPath) : null

const b0 = byArm.B0
const e0 = byArm.E0
const e1 = byArm.E1
const e1b0 = comparisons.find(entry => entry.left === 'E1' && entry.right === 'B0')
const e1e0 = comparisons.find(entry => entry.left === 'E1' && entry.right === 'E0')
const e0b0 = comparisons.find(entry => entry.left === 'E0' && entry.right === 'B0')

const output = {
  schemaVersion: 1,
  work: 'EF-R3 product-lane pilot',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  manifest: {
    path: `eval/e2e/out/manifest-${CAMPAIGN}.json`,
    sha256: results.manifestSha256,
    cells: manifest.cells.length,
    config: manifest.config,
  },
  coverage: {
    planned: results.planned,
    executed: results.executed,
    valid: summary.valid,
    unresolved: summary.unresolved,
    neverStarted: summary.neverStarted,
    status: results.status,
    stopReason: results.stopReason,
    coverageComplete: results.executed === results.planned && summary.valid === results.planned,
    costComplete: summary.costInvalidCells.length === 0,
    costInvalidCells: summary.costInvalidCells,
  },
  byArm: { B0: b0, E0: e0, E1: e1 },
  comparisons,
  byTemplate,
  healthProbe: health === null ? null : {
    verdict: health.verdict,
    successes: health.successes,
    planned: health.planned,
    p95DurationMs: health.latency?.p95 ?? null,
    over60s: health.latency?.over60s ?? [],
  },
  prerequisites,
  decision: {
    decision: 'no-product-candidate',
    deploymentHold: true,
    expandTo72: false,
    pilotOnly: true,
    reasons: [
      `B0 passed ${b0.passed}/${b0.cells}, E1 passed ${e1.passed}/${e1.cells}, E0 passed ${e0.passed}/${e0.cells}; E1 has ${e1b0?.leftOnly ?? 0} E1-only pass(es) against B0, B0 has ${e1b0?.rightOnly ?? 0} B0-only pass(es).`,
      `The EF arms hit step-limit in ${e0.stepLimited}/${e0.cells} E0 cells and ${e1.stepLimited}/${e1.cells} E1 cells; B0 hit step-limit in ${b0.stepLimited}/${b0.cells}. The pilot therefore does not give a clean quality comparison.`,
      `E1 uses more uncached input than B0 in the recorded pairs (${e1b0?.recorded.inputTokens ?? '?'} tokens), and the cost-valid subset is smaller (${e1b0?.costValid.pairs ?? 0}/6 pairs).`,
      `One E1 cell (T16-p1-E1-r1) reported one unknown usage; strictUsage stopped the campaign after all 18 cells. Cost-valid cells: ${summary.valid - summary.costInvalidCells.length}/${summary.valid}.`,
      `The representative health probe passed transport/usage 16/16 but one 82s request exceeded the pre-registered 60s p95 bound. Latency is a recorded caveat.`,
      'The pilot is n=6 per arm and is not confirmatory; it is not pooled with the R2 pilot or confirm.',
    ],
    nextStep: 'Do not expand to the 72-cell lane. Diagnose the EF step-limit/quality gap under the shipped preset: a step-limit sensitivity campaign (same tasks, maxSteps 12/16, all arms) or an offline step-budget analysis. A new live authorization is required.',
  },
  limits: [
    '6 tasks x 3 arms x 1 replicate; exploratory only.',
    'Four EF cells hit the 8-step harness limit; the quality comparison is censored, not a clean loss.',
    'One E1 cell has partial usage; the strictUsage rule stopped the campaign after all cells executed.',
    'One health-probe request exceeded the 60s p95 bound; route stability passed 16/16.',
    'One model, one local route, one machine. No USD price; no product claim.',
  ],
  note: 'Pilot result. The product candidate decision remains no candidate. The primary finding is the EF step-limit/quality gap, not a confirmed E1 advantage.',
}

mkdirSync(OUT, { recursive: true })
const jsonPath = join(OUT, 'product-pilot-analysis.json')
writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R3 product-lane pilot — 18 cells at 32k')
md.push('')
md.push(`Coverage: **${results.executed}/${results.planned} executed**, ${summary.valid} valid. Cost-valid cells: **${summary.valid - summary.costInvalidCells.length}/${summary.valid}**.`)
md.push('')
md.push('| Arm | Pass | Committed | Delivered | Step-limited | Requests | Uncached input | Output | Cost-valid |')
md.push('|---|---|---|---|---|---|---|---|---|')
for (const [arm, row] of Object.entries({ B0: b0, E0: e0, E1: e1 })) {
  md.push(`| ${arm} | ${row.passed}/${row.cells} | ${row.committed} | ${row.delivered} | ${row.stepLimited} | ${row.requests} | ${row.inputTokens} | ${row.outputTokens} | ${row.costValid}/${row.cells} |`)
}
md.push('')
md.push('## Paired E1 − B0')
md.push('')
if (e1b0 !== undefined) {
  md.push(`Pairs: **${e1b0.pairs}**. Both pass ${e1b0.both}, neither ${e1b0.neither}, E1 only ${e1b0.leftOnly}, B0 only ${e1b0.rightOnly}; exact McNemar p=${e1b0.mcnemarP}.`)
  md.push('')
  md.push(`Recorded deltas: pass ${e1b0.recorded.pass}, requests ${e1b0.recorded.requests}, input ${e1b0.recorded.inputTokens}, cache read ${e1b0.recorded.cacheReadTokens}, output ${e1b0.recorded.outputTokens}.`)
  md.push('')
  md.push(`Cost-valid pairs: **${e1b0.costValid.pairs}**; input ${e1b0.costValid.inputTokens}, output ${e1b0.costValid.outputTokens}.`)
}
md.push('')
md.push('## Per template')
md.push('')
md.push('| Template | B0 | E0 | E1 |')
md.push('|---|---|---|---|')
for (const [template, row] of Object.entries(byTemplate)) {
  const cell = armRow => armRow === null ? '—' : `${armRow.passed}/${armRow.cells} (step ${armRow.stepLimited})`
  md.push(`| ${template} | ${cell(row.B0)} | ${cell(row.E0)} | ${cell(row.E1)} |`)
}
md.push('')
md.push('## Exact-span probe')
md.push('')
md.push('| Arm | Cells with probe | Widest median | Executed median | Gap median | Actual checkpoint median | Actual reclaim median | Reconciled | False admissions |')
md.push('|---|---|---|---|---|---|---|---|---|')
for (const [arm, row] of Object.entries({ B0: b0, E0: e0, E1: e1 })) {
  const probe = row.probe
  md.push(`| ${arm} | ${probe.cells} | ${probe.widestTokensMedian ?? '—'} | ${probe.executedTokensMedian ?? '—'} | ${probe.gapTokensMedian ?? '—'} | ${probe.actualCheckpointTokensMedian ?? '—'} | ${probe.actualReclaimTokensMedian ?? '—'} | ${probe.reconciled} | ${probe.falseAdmissions} |`)
}
md.push('')
md.push('## Health probe')
md.push('')
if (health === null) {
  md.push('Health-probe artifact missing.')
} else {
  md.push(`${health.successes}/${health.planned} transport/usage successes; p95 ${health.latency?.p95 ?? '?'} ms; over 60s: ${health.latency?.over60s?.length ?? 0}. The p95 bound was not met; this is a recorded latency caveat.`)
}
md.push('')
md.push('## Decision')
md.push('')
md.push('**No product candidate; Deployment Hold remains. Do not expand to the 72-cell lane.**')
md.push('')
for (const reason of output.decision.reasons) md.push(`- ${reason}`)
md.push('')
md.push(`Next: ${output.decision.nextStep}`)
md.push('')
md.push('This is a pilot, not a confirmatory result. The main finding is the EF step-limit/quality gap under the shipped preset, not a confirmed E1 advantage.')
md.push('')
const mdPath = join(OUT, 'product-pilot-analysis.md')
writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`product pilot: ${results.executed}/${results.planned} executed, ${summary.valid} valid, ${summary.costInvalidCells.length} cost-invalid\n`)
for (const [arm, row] of Object.entries({ B0: b0, E0: e0, E1: e1 })) {
  process.stdout.write(`  ${arm}: pass ${row.passed}/${row.cells}, committed ${row.committed}, delivered ${row.delivered}, step-limited ${row.stepLimited}, req ${row.requests}, in ${row.inputTokens}, out ${row.outputTokens}\n`)
}
if (e1b0 !== undefined) process.stdout.write(`  E1-B0: pairs ${e1b0.pairs}, E1 only ${e1b0.leftOnly}, B0 only ${e1b0.rightOnly}, pass ${e1b0.recorded.pass}, input ${e1b0.recorded.inputTokens}, output ${e1b0.recorded.outputTokens}; cost-valid pairs ${e1b0.costValid.pairs}\n`)
process.stdout.write(`  decision: no-product-candidate; expandTo72=${output.decision.expandTo72}\n`)
process.stdout.write(`wrote ${jsonPath}, ${mdPath}\n`)
