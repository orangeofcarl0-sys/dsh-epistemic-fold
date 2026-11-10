#!/usr/bin/env node
/**
 * EF-R2 — live campaign analysis (pilot and confirm).
 *
 * Reads one campaign's results, analysis and per-cell reports. It reports the
 * three things the round separates:
 *
 *   ITT                 checker pass per arm, with exact McNemar on pairs
 *   transaction         attempts / committed / refused / aborted
 *   delivery            committed checkpoints that reached a later request
 *
 * It does not pool the pilot and confirm as independent samples: they use
 * different instances on purpose. The two are printed side by side.
 *
 *   EF_E2E_TASKS_DIR=eval/e2e/tasks-r2 \
 *     node eval/r2/live-analysis.mjs --campaign e2e-r2-pilot-1 --out live-pilot-analysis
 *
 * @module eval/r2/live-analysis
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}
const campaign = value('campaign', 'e2e-r2-pilot-1')
const outName = value('out', campaign === 'e2e-r2-pilot-1' ? 'live-pilot-analysis' : 'live-confirm-analysis')
const ledgerPath = value('ledger', null)

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

// EF-R3: an optional corrected-denominator view. This reads the Attempt/Unique
// Cell ledger instead of re-deriving counts from the historical merged results.
// The default path below is unchanged, so the R2 artifacts stay reproducible.
if (ledgerPath !== null) {
  const ledger = readJson(ledgerPath)
  const section = campaign.startsWith('e2e-r2-pilot') ? ledger.pilot : ledger.confirm
  if (section === undefined) {
    process.stderr.write(`live-analysis: ${campaign} is not in ${ledgerPath}\n`)
    process.exit(2)
  }
  const output = {
    schemaVersion: 1,
    work: 'EF-R3',
    generatedAt: new Date().toISOString(),
    campaign,
    source: 'ledger',
    ledger: { path: ledgerPath, sha256: sha256(ledgerPath) },
    summary: section.summary,
    cells: section.cells,
    note: 'Corrected denominator view. Transport-failed attempts are not arm outcomes; cost validity is separate from task outcome.',
  }
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `${outName}-ledger.json`), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`${campaign} (ledger): ${section.summary.valid}/${section.summary.planned} valid, ${section.summary.unresolved} unresolved, ${section.summary.neverStarted} never-started, ${section.summary.noValidOutcome} no-valid-outcome\n`)
  process.exit(0)
}

const resultsPath = join(E2E_OUT, `results-${campaign}.json`)
const analysisPath = join(E2E_OUT, `analysis-${campaign}.json`)
if (!existsSync(resultsPath)) {
  process.stderr.write(`live-analysis: ${resultsPath} is missing\n`)
  process.exit(2)
}
const results = readJson(resultsPath)
const analysis = existsSync(analysisPath) ? readJson(analysisPath) : null
const analysisByCell = new Map((analysis?.rows ?? []).map(row => [row.cellId, row]))

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

const cells = []
for (const result of results.results) {
  if (result.status !== 'executed') continue
  const reportPath = result.reportPath
  const report = existsSync(reportPath) ? readJson(reportPath) : null
  const witness = report?.witnessSummary ?? null
  const attempts = (report?.witnesses ?? []).map(entry => ({
    status: entry.status,
    reason: entry.reason,
    rationale: entry.rationale ?? null,
    delivery: entry.delivery ?? null,
  }))
  const failed = attempts.filter(entry => entry.status !== 'committed')
  cells.push({
    cellId: result.cellId,
    task: result.cell.task,
    template: result.cell.task.replace(/-s\d$/u, ''),
    seed: Number(result.cell.task.slice(-1)),
    arm: result.cell.arm,
    replicate: result.cell.replicate,
    key: `${result.cell.task}-r${result.cell.replicate}`,
    pass: result.checker === true,
    termination: report?.termination?.kind ?? null,
    requests: report?.usage.requests ?? result.usage.requests,
    inputTokens: report?.usage.inputTokens ?? result.usage.inputTokens,
    outputTokens: report?.usage.outputTokens ?? result.usage.outputTokens,
    auxiliaryRequests: report?.usage.auxiliary?.requests ?? result.usage.auxiliary?.requests ?? 0,
    attempts: witness?.attempts ?? report?.compactions?.length ?? 0,
    committed: witness?.committed ?? analysisByCell.get(result.cellId)?.folds ?? 0,
    refused: witness?.refused ?? 0,
    aborted: witness?.aborted ?? 0,
    unverifiable: witness?.unverifiable ?? 0,
    delivered: witness?.committedAndDelivered ?? 0,
    noFollowingRequest: witness?.noFollowingRequest ?? 0,
    failedCallInput: failed.reduce((sum, entry) => sum + (entry.rationale?.inputTokens ?? 0), 0),
    failedCallOutput: failed.reduce((sum, entry) => sum + (entry.rationale?.outputTokens ?? 0), 0),
    reasons: failed.reduce((counts, entry) => {
      counts[entry.reason ?? 'unknown'] = (counts[entry.reason ?? 'unknown'] ?? 0) + 1
      return counts
    }, {}),
  })
}

const ARMS = [...new Set(cells.map(cell => cell.arm))].sort()
const byArm = Object.fromEntries(ARMS.map(arm => {
  const subset = cells.filter(cell => cell.arm === arm)
  const sum = key => subset.reduce((total, cell) => total + cell[key], 0)
  return [arm, {
    cells: subset.length,
    passed: subset.filter(cell => cell.pass).length,
    rate: subset.length === 0 ? null : Number((subset.filter(cell => cell.pass).length / subset.length).toFixed(3)),
    attempts: sum('attempts'),
    committed: sum('committed'),
    refused: sum('refused'),
    aborted: sum('aborted'),
    unverifiable: sum('unverifiable'),
    delivered: sum('delivered'),
    cellsWithCommit: subset.filter(cell => cell.committed > 0).length,
    cellsWithDelivery: subset.filter(cell => cell.delivered > 0).length,
    cellsWithoutCommit: subset.filter(cell => cell.committed === 0).length,
    requests: sum('requests'),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    auxiliaryRequests: sum('auxiliaryRequests'),
    failedCallInput: sum('failedCallInput'),
    failedCallOutput: sum('failedCallOutput'),
    inputPerPass: subset.filter(cell => cell.pass).length === 0
      ? null
      : Math.round(sum('inputTokens') / subset.filter(cell => cell.pass).length),
  }]
}))

function paired(leftArm, rightArm) {
  const byKey = new Map(cells.map(cell => [`${cell.key}:${cell.arm}`, cell]))
  let both = 0
  let neither = 0
  let leftOnly = 0
  let rightOnly = 0
  for (const key of new Set(cells.map(cell => cell.key))) {
    const left = byKey.get(`${key}:${leftArm}`)
    const right = byKey.get(`${key}:${rightArm}`)
    if (left === undefined || right === undefined) continue
    if (left.pass && right.pass) both += 1
    else if (!left.pass && !right.pass) neither += 1
    else if (left.pass) leftOnly += 1
    else rightOnly += 1
  }
  return {
    left: leftArm,
    right: rightArm,
    pairs: both + neither + leftOnly + rightOnly,
    both,
    neither,
    leftOnly,
    rightOnly,
    mcnemarP: Number(exactMcNemar(leftOnly, rightOnly).toFixed(4)),
  }
}

const comparisons = []
if (ARMS.includes('E1') && ARMS.includes('E0')) comparisons.push(paired('E1', 'E0'))
if (ARMS.includes('E1') && ARMS.includes('B0')) comparisons.push(paired('E1', 'B0'))
if (ARMS.includes('E0') && ARMS.includes('B0')) comparisons.push(paired('E0', 'B0'))

const byTemplateArm = {}
for (const template of [...new Set(cells.map(cell => cell.template))].sort()) {
  byTemplateArm[template] = {}
  for (const arm of ARMS) {
    const subset = cells.filter(cell => cell.template === template && cell.arm === arm)
    if (subset.length === 0) continue
    byTemplateArm[template][arm] = {
      cells: subset.length,
      passed: subset.filter(cell => cell.pass).length,
      committed: subset.reduce((sum, cell) => sum + cell.committed, 0),
      delivered: subset.reduce((sum, cell) => sum + cell.delivered, 0),
    }
  }
}

const e1 = byArm.E1 ?? null
const feasibility = {
  e1Cells: e1?.cells ?? 0,
  e1CellsWithCommit: e1?.cellsWithCommit ?? 0,
  e1CellsWithDelivery: e1?.cellsWithDelivery ?? 0,
  e1CellsWithoutCommit: e1?.cellsWithoutCommit ?? 0,
  e1Refused: e1?.refused ?? 0,
  e1Aborted: e1?.aborted ?? 0,
  note: 'A pilot is healthy when every E1 cell commits and delivers; a confirm additionally reports the ITT comparison.',
}

const output = {
  schemaVersion: 1,
  work: 'EF-R2 live',
  generatedAt: new Date().toISOString(),
  campaign,
  status: results.status,
  executed: results.executed,
  planned: results.planned,
  budget: results.budget,
  byArm,
  comparisons,
  byTemplateArm,
  feasibility,
  cells,
  sources: {
    results: { path: `eval/e2e/out/results-${campaign}.json`, sha256: sha256(resultsPath) },
    ...(analysis === null ? {} : { analysis: { path: `eval/e2e/out/analysis-${campaign}.json`, sha256: sha256(analysisPath) } }),
    route: results.route ?? null,
  },
  note: 'One model, one route, one machine. The pilot and confirm use different instances and are not pooled. A committed fold is delivered only when a later primary request carried the checkpoint.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, `${outName}.json`), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push(`# EF-R2 — ${campaign}`)
md.push('')
md.push(`Executed ${results.executed}/${results.planned}; requests ${results.budget.used.requests}, input ${results.budget.used.inputTokens}, output ${results.budget.used.outputTokens}.`)
md.push('')
md.push('| Arm | Pass | Attempts | Committed | Refused | Aborted | Unverifiable | Delivered | Cells with commit | Input | Output | Aux |')
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const arm of ARMS) {
  const row = byArm[arm]
  md.push(`| ${arm} | ${row.passed}/${row.cells} | ${row.attempts} | ${row.committed} | ${row.refused} | ${row.aborted} | ${row.unverifiable} | ${row.delivered} | ${row.cellsWithCommit} | ${row.inputTokens} | ${row.outputTokens} | ${row.auxiliaryRequests} |`)
}
md.push('')
md.push('## Paired ITT')
md.push('')
md.push('| Left | Right | Pairs | Left only | Right only | Exact McNemar p |')
md.push('|---|---|---|---|---|---|')
for (const row of comparisons) md.push(`| ${row.left} | ${row.right} | ${row.pairs} | ${row.leftOnly} | ${row.rightOnly} | ${row.mcnemarP} |`)
md.push('')
md.push('## Feasibility')
md.push('')
md.push(`E1: ${feasibility.e1CellsWithCommit}/${feasibility.e1Cells} cells committed, ${feasibility.e1CellsWithDelivery}/${feasibility.e1Cells} delivered, ${feasibility.e1CellsWithoutCommit} without a commit, ${feasibility.e1Refused} refused, ${feasibility.e1Aborted} aborted.`)
md.push('')
md.push('No product claim: one model, one route, one machine; the pilot and confirm are separate instance sets.')
md.push('')
writeFileSync(join(OUT, `${outName}.md`), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`${campaign}: ${cells.length} cells\n`)
for (const arm of ARMS) {
  const row = byArm[arm]
  process.stdout.write(`  ${arm}: pass ${row.passed}/${row.cells}, attempts ${row.attempts}, commits ${row.committed}, refused ${row.refused}, aborted ${row.aborted}, delivered ${row.delivered}\n`)
}
for (const row of comparisons) process.stdout.write(`  ${row.left} vs ${row.right}: ${row.leftOnly}/${row.rightOnly}, p=${row.mcnemarP}\n`)
process.stdout.write(`E1 feasibility: ${feasibility.e1CellsWithCommit}/${feasibility.e1Cells} commit, ${feasibility.e1CellsWithDelivery}/${feasibility.e1Cells} delivered\n`)
