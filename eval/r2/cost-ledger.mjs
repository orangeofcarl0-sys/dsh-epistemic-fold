#!/usr/bin/env node
/**
 * EF-R2 WP4 — the cost ledger.
 *
 * Three numbers were conflated in EF-R1's E1 discussion: the cost of the whole
 * arm, the cost of the calls that produced a delivered checkpoint, and the cost
 * of calls that produced a body the shrink check refused. This ledger keeps
 * them separate, per cell and per arm, and reconciles the sums with the
 * campaign's own budget record.
 *
 * No USD price is invented: the manifests record that no verifiable per-token
 * price exists. The ledger reports tokens, requests, bytes and wall clock.
 *
 *   node eval/r2/cost-ledger.mjs
 *
 * @module eval/r2/cost-ledger
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')
const CAMPAIGN = 'e2e-lg-confirm-1'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const results = readJson(join(E2E_OUT, `results-${CAMPAIGN}.json`))
const manifest = readJson(join(E2E_OUT, `manifest-${CAMPAIGN}.json`))
const witnessDoc = readJson(join(OUT, 'compaction-witnesses.json'))
const attribution = readJson(join(OUT, 'rationale-failure-attribution.json'))
const witnessByCell = new Map(witnessDoc.cells
  .filter(cell => cell.campaign === CAMPAIGN)
  .map(cell => [cell.cellId, cell]))

const rows = []
for (const result of results.results) {
  const cellRoot = join(ROOT, 'eval', 'e2e', 'runs', CAMPAIGN, result.cellId)
  const reportPath = join(cellRoot, 'report.json')
  if (!existsSync(reportPath)) continue
  const report = readJson(reportPath)
  const witness = witnessByCell.get(result.cellId)
  const auxiliary = report.usage.auxiliary
  const primary = report.usage.primary
  const rationaleRequests = (report.requests ?? []).filter(request => request.purpose === 'rationale')
  const maxOutput = Math.max(0, ...(report.requests ?? []).map(request => request.usage?.outputTokens ?? 0))
  const bundleBytes = (witness?.witnesses ?? []).reduce((sum, entry) => sum + (entry.archive?.bytes ?? 0), 0)
  rows.push({
    cellId: result.cellId,
    arm: result.cell.arm,
    template: result.cell.task.replace(/-s\d$/u, ''),
    pass: result.checker === true,
    requests: report.usage.requests,
    inputTokens: report.usage.inputTokens,
    outputTokens: report.usage.outputTokens,
    cacheReadTokens: report.usage.cacheReadTokens ?? 0,
    primaryRequests: primary.requests,
    primaryInputTokens: primary.inputTokens,
    primaryOutputTokens: primary.outputTokens,
    auxiliaryRequests: auxiliary.requests,
    auxiliaryInputTokens: auxiliary.inputTokens,
    auxiliaryOutputTokens: auxiliary.outputTokens,
    rationaleCalls: rationaleRequests.length,
    rationaleMaxTokens: [...new Set(rationaleRequests.map(request => request.maxTokens))],
    rationaleOutputTokens: rationaleRequests.reduce((sum, request) => sum + (request.usage?.outputTokens ?? 0), 0),
    maxSingleRequestOutput: maxOutput,
    attempts: witness?.witness.attempts ?? 0,
    committed: witness?.witness.committed ?? 0,
    refused: witness?.witness.refused ?? 0,
    delivered: witness?.witness.committedAndDelivered ?? 0,
    bundleBytes,
    wallClockMs: report.termination.durationMs,
  })
}

const ARMS = ['E0', 'E0-L', 'E0-G', 'E0-LG', 'E1']
const byArm = Object.fromEntries(ARMS.map(arm => {
  const subset = rows.filter(row => row.arm === arm)
  const passed = subset.filter(row => row.pass).length
  return [arm, {
    cells: subset.length,
    passed,
    requests: subset.reduce((sum, row) => sum + row.requests, 0),
    inputTokens: subset.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: subset.reduce((sum, row) => sum + row.outputTokens, 0),
    cacheReadTokens: subset.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    auxiliaryRequests: subset.reduce((sum, row) => sum + row.auxiliaryRequests, 0),
    auxiliaryInputTokens: subset.reduce((sum, row) => sum + row.auxiliaryInputTokens, 0),
    auxiliaryOutputTokens: subset.reduce((sum, row) => sum + row.auxiliaryOutputTokens, 0),
    rationaleCalls: subset.reduce((sum, row) => sum + row.rationaleCalls, 0),
    rationaleOutputTokens: subset.reduce((sum, row) => sum + row.rationaleOutputTokens, 0),
    attempts: subset.reduce((sum, row) => sum + row.attempts, 0),
    committed: subset.reduce((sum, row) => sum + row.committed, 0),
    refused: subset.reduce((sum, row) => sum + row.refused, 0),
    delivered: subset.reduce((sum, row) => sum + row.delivered, 0),
    bundleBytes: subset.reduce((sum, row) => sum + row.bundleBytes, 0),
    wallClockMs: subset.reduce((sum, row) => sum + row.wallClockMs, 0),
    inputPerPassingCell: passed === 0 ? null : Math.round(subset.reduce((sum, row) => sum + row.inputTokens, 0) / passed),
    outputPerPassingCell: passed === 0 ? null : Math.round(subset.reduce((sum, row) => sum + row.outputTokens, 0) / passed),
  }]
}))

const e1Failed = attribution.rows.filter(row => row.status !== 'committed')
const e1FailedCost = {
  calls: e1Failed.length,
  inputTokens: e1Failed.reduce((sum, row) => sum + (row.rationale?.inputTokens ?? 0), 0),
  outputTokens: e1Failed.reduce((sum, row) => sum + (row.rationale?.outputTokens ?? 0), 0),
}
const byCell = new Map()
for (const row of attribution.rows) {
  const list = byCell.get(row.cellId) ?? []
  list.push(row)
  byCell.set(row.cellId, list)
}
let repeatedFailedCost = { calls: 0, inputTokens: 0, outputTokens: 0 }
let firstAttemptCost = { calls: 0, inputTokens: 0, outputTokens: 0 }
for (const list of byCell.values()) {
  const ordered = [...list].sort((left, right) => left.attempt - right.attempt)
  for (const row of ordered) {
    if (row.status === 'committed') continue
    const bucket = row.attempt === 1 ? firstAttemptCost : repeatedFailedCost
    bucket.calls += 1
    bucket.inputTokens += row.rationale?.inputTokens ?? 0
    bucket.outputTokens += row.rationale?.outputTokens ?? 0
  }
}
const e1 = byArm.E1
const e1Committed = e1.committed
const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0)
const totalInput = rows.reduce((sum, row) => sum + row.inputTokens, 0)
const totalOutput = rows.reduce((sum, row) => sum + row.outputTokens, 0)
const used = results.budget.used
const perCellOutputCap = manifest.perCell?.outputTokens ?? null
const designOutputPerRequest = manifest.design?.outputTokensPerRequest ?? null
const observedMaxRationaleMax = Math.max(0, ...attribution.rows.map(row => row.rationale?.maxTokens ?? 0))
const observedMaxSingleRequestOutput = Math.max(0, ...rows.map(row => row.maxSingleRequestOutput))

const output = {
  schemaVersion: 1,
  work: 'EF-R2 WP4',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  units: {
    tokens: 'provider-reported input/output tokens',
    bytes: 'bundle file bytes on disk',
    wallClockMs: 'sum of per-cell termination durations',
    usd: null,
    note: 'No verifiable per-token price was recorded; no USD figure is invented.',
  },
  byArm,
  rationale: {
    calls: attribution.rows.length,
    maxTokensObserved: [...new Set(attribution.rows.map(row => row.rationale?.maxTokens).filter(value => value !== undefined))],
    finishKinds: e1Failed.reduce((counts, row) => {
      const key = row.rationale?.finish?.kind ?? 'unknown'
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
    failedCalls: e1FailedCost,
    firstAttemptFailedCalls: firstAttemptCost,
    repeatedFailedCalls: repeatedFailedCost,
    note: 'A failed call is paid for but produced no delivered checkpoint. The first attempt per cell is the probe; later failed attempts are repeats. The two retries that committed (T9-s1-E1-r2, T10-s1-E1-r1) are counted as committed calls, not failed repeats.',
  },
  e1Economics: {
    totalInputTokens: e1.inputTokens,
    totalOutputTokens: e1.outputTokens,
    committedFolds: e1Committed,
    inputPerCommittedFold: e1Committed === 0 ? null : Math.round(e1.inputTokens / e1Committed),
    outputPerCommittedFold: e1Committed === 0 ? null : Math.round(e1.outputTokens / e1Committed),
    inputPerPassingCell: e1.inputPerPassingCell,
    outputPerPassingCell: e1.outputPerPassingCell,
    failedCallShareOfOutput: e1.outputTokens === 0 ? null : Number((e1FailedCost.outputTokens / e1.outputTokens).toFixed(3)),
    note: 'These are observed costs, not a counterfactual. Avoiding the failed calls would not automatically preserve the two retry commits.',
  },
  caps: {
    perCellOutputTokens: perCellOutputCap,
    designOutputTokensPerRequest: designOutputPerRequest,
    rationaleMaxTokensObserved: observedMaxRationaleMax,
    observedMaxSingleRequestOutput,
    rationaleShareOfCellCap: perCellOutputCap === null || observedMaxRationaleMax === 0
      ? null
      : Number((observedMaxRationaleMax / perCellOutputCap).toFixed(3)),
    note: 'The manifest default 1,024 is the adapter default for ordinary requests, not the rationale cap. A single rationale request may reserve 16,384 output tokens against a 20,000-token per-cell cap; observed output remained far below either bound.',
  },
  reconciliation: {
    campaignUsed: used,
    perCellSums: { requests: totalRequests, inputTokens: totalInput, outputTokens: totalOutput },
    matches: used.requests === totalRequests
      && used.inputTokens === totalInput
      && used.outputTokens === totalOutput,
  },
  rows,
  sources: {
    results: { path: `eval/e2e/out/results-${CAMPAIGN}.json`, sha256: sha256(join(E2E_OUT, `results-${CAMPAIGN}.json`)) },
    manifest: { path: `eval/e2e/out/manifest-${CAMPAIGN}.json`, sha256: sha256(join(E2E_OUT, `manifest-${CAMPAIGN}.json`)) },
    witnesses: { path: 'eval/r2/out/compaction-witnesses.json', sha256: sha256(join(OUT, 'compaction-witnesses.json')) },
    attribution: { path: 'eval/r2/out/rationale-failure-attribution.json', sha256: sha256(join(OUT, 'rationale-failure-attribution.json')) },
  },
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'cost-ledger.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R2 — cost ledger')
md.push('')
md.push('| Arm | Cells | Pass | Requests | Input | Output | Aux calls | Rationale calls | Attempts | Commits | Refused | Delivered | Bundle bytes |')
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const arm of ARMS) {
  const row = byArm[arm]
  md.push(`| ${arm} | ${row.cells} | ${row.passed} | ${row.requests} | ${row.inputTokens} | ${row.outputTokens} | ${row.auxiliaryRequests} | ${row.rationaleCalls} | ${row.attempts} | ${row.committed} | ${row.refused} | ${row.delivered} | ${row.bundleBytes} |`)
}
md.push('')
md.push(`E1 failed calls: ${e1FailedCost.calls} calls, ${e1FailedCost.inputTokens} input, ${e1FailedCost.outputTokens} output (${output.e1Economics.failedCallShareOfOutput === null ? '—' : `${(output.e1Economics.failedCallShareOfOutput * 100).toFixed(1)}%`} of E1 output).`)
md.push('')
md.push(`Repeated failed calls: ${repeatedFailedCost.calls} calls, ${repeatedFailedCost.inputTokens} input, ${repeatedFailedCost.outputTokens} output. First-attempt failed calls: ${firstAttemptCost.calls}, ${firstAttemptCost.inputTokens} input, ${firstAttemptCost.outputTokens} output.`)
md.push('')
md.push(`Reconciliation: ${output.reconciliation.matches ? 'matches' : 'MISMATCH'} (campaign ${used.requests}/${used.inputTokens}/${used.outputTokens}).`)
md.push('')
md.push(`Caps: per-cell output ${perCellOutputCap}; rationale max observed ${observedMaxRationaleMax}; observed max single-request output ${observedMaxSingleRequestOutput}.`)
md.push('')
writeFileSync(join(OUT, 'cost-ledger.md'), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`cost: reconciliation ${output.reconciliation.matches}; E1 failed ${e1FailedCost.calls} calls ${e1FailedCost.inputTokens} in / ${e1FailedCost.outputTokens} out; repeated ${repeatedFailedCost.calls} calls ${repeatedFailedCost.inputTokens}/${repeatedFailedCost.outputTokens}\n`)
for (const arm of ARMS) {
  const row = byArm[arm]
  process.stdout.write(`  ${arm}: req ${row.requests}, in ${row.inputTokens}, out ${row.outputTokens}, aux ${row.auxiliaryRequests}, attempts ${row.attempts}, commits ${row.committed}, delivered ${row.delivered}\n`)
}
