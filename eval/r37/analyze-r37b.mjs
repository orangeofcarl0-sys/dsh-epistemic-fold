#!/usr/bin/env node
/**
 * Aggregate the R37-B Stage 1 reports.
 *
 * This is an exploratory analysis. It separates the writer pilot, O2 floor,
 * controlled representation cells, and assigned-arm B1/S pairs. It does not
 * pool Stage 1 with R36 and it does not present a pilot p-value as confirmatory.
 *
 * @module eval/r37/analyze-r37b
 */

import { readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import { deltaMatchesFact } from '../r36/writer-protocol.mjs'
import { actualDelivery, pairOutcome } from './src/evidence.mjs'
import { exists, readJson, writeJson } from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const RUNS = process.env.R37B_RUNS === undefined ? join(HERE, 'runs-b') : resolve(process.env.R37B_RUNS)
const OUT = process.env.R37B_OUT === undefined ? join(HERE, 'out', 'r37b-results.json') : resolve(process.env.R37B_OUT)
const relRoot = path => relative(ROOT, path).split(sep).join('/')
const CASES = ['A1-v2', 'D1-v2', 'B2', 'C1', 'F1', 'H1']
const cases = {}
for (const caseId of CASES) {
  cases[caseId] = await loadCase(caseId, caseId.endsWith('-v2')
    ? join(HERE, 'cases')
    : join(HERE, '..', 'r33', 'cases'))
}

function count(list, predicate) {
  return list.filter(predicate).length
}

function rate(part, total) {
  return total === 0 ? null : part / total
}

function pairAnalysis(baseline, treatment) {
  const contractOutcome = pairOutcome(baseline, treatment, row => row.contractSuccess)
  const taskOutcome = pairOutcome(baseline, treatment, row => row.taskSuccess)
  const confounds = []
  if (baseline.delivery === 'full-history-fallback' || treatment.delivery === 'full-history-fallback') {
    confounds.push({ kind: 'fallback-delivery' })
  }
  if (baseline.delivery === 'semantic-committed-empty'
    || treatment.delivery === 'semantic-committed-empty') {
    confounds.push({ kind: 'empty-semantic-commit' })
  }
  if (baseline.delivery === 'unknown' || treatment.delivery === 'unknown'
    || baseline.delivery === 'commit-missing' || treatment.delivery === 'commit-missing') {
    confounds.push({ kind: 'unknown-delivery' })
  }
  if (baseline.contractSuccess === true && treatment.contractSuccess === true) {
    confounds.push({ kind: 'ceiling' })
  }
  if ((baseline.fixture !== undefined && baseline.fixture !== null)
    || (treatment.fixture !== undefined && treatment.fixture !== null)) {
    confounds.push({ kind: 'controlled-representation' })
  }
  let memoryAttribution = 'none'
  if (confounds.length === 0 && treatment.delivery === 'semantic-committed'
    && baseline.contractSuccess !== true && treatment.contractSuccess === true) {
    memoryAttribution = 'candidate'
  } else if (confounds.length === 0) {
    memoryAttribution = 'unresolved'
  }
  return { contractOutcome, taskOutcome, confounds, memoryAttribution }
}

const runDirs = (await readdir(RUNS, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => !name.includes('-smoke'))
  .sort()

const reports = []
for (const runId of runDirs) {
  const reportPath = join(RUNS, runId, 'report.json')
  if (!await exists(reportPath)) continue
  const report = await readJson(reportPath)
  reports.push({ runId, report })
}

const rowsAll = []
for (const { runId, report } of reports) {
  for (const row of report.rows ?? []) {
    rowsAll.push({
      runId,
      reportPath: relRoot(join(RUNS, runId, 'report.json')),
      phase: report.modelParameters?.toolProtocol === 'P3e' ? 'P3e' : 'P3',
      promptVersion: report.modelParameters?.writerPromptVersion ?? null,
      stage: row.stage,
      caseId: row.caseId,
      arm: row.arm,
      replicateId: row.replicateId,
      valid: row.valid === true,
      taskSuccess: row.behaviour?.taskSuccess === true,
      contractSuccess: row.behaviour?.contractSuccess === true,
      processViolation: row.behaviour?.processViolation === true,
      finalVerification: row.behaviour?.finalVerificationStatus ?? null,
      failedChecks: row.behaviour?.failedChecks ?? [],
      delivery: actualDelivery(row.row ?? row),
      foldValid: row.fold?.valid === true,
      foldSynthetic: row.fold?.synthetic === true,
      foldFallback: row.foldFallback ?? null,
      writerProtocol: row.writer?.protocol ?? null,
      writerAccepted: row.writer?.accepted ?? null,
      writerRefused: row.writer?.refused ?? null,
      writerCommitStatus: row.writer?.commitStatus ?? null,
      writerAcceptedDeltas: row.writer?.acceptedDeltas ?? [],
      extraction: row.extraction ?? null,
      fixture: row.fixture ?? null,
      testsExecuted: row.behaviourDetail?.testsExecuted ?? 0,
      steps: row.behaviourDetail?.steps ?? null,
      toolProtocol: row.behaviourDetail?.harness?.toolProtocol ?? null,
      validActions: row.behaviourDetail?.harness?.validActions ?? 0,
      rejectedActions: row.behaviourDetail?.harness?.rejectedActions ?? 0,
      invalidActions: row.behaviourDetail?.harness?.invalidActions ?? 0,
      invalidActionDetails: row.behaviourDetail?.harness?.invalidActionDetails ?? [],
      protocolDiagnostics: row.behaviourDetail?.harness?.protocolDiagnostics ?? [],
      cost: row.cost ?? null,
      row,
    })
  }
}

// A transport-invalid attempt is retried under a new run id. Keep both in the
// raw cost ledger, but use one row per cell for outcome metrics: prefer a valid
// row, then the most recent run id.
const deduped = new Map()
for (const row of rowsAll) {
  const key = row.stage === 'writer-only'
    ? `${row.stage}|${row.promptVersion}|${row.caseId}|${row.arm}|${row.replicateId}`
    : `${row.stage}|${row.caseId}|${row.arm}|${row.replicateId}`
  const existing = deduped.get(key)
  if (existing === undefined
    || (row.valid && !existing.valid)
    || (row.valid === existing.valid && row.runId > existing.runId)) {
    deduped.set(key, row)
  }
}
const rows = [...deduped.values()]
const invalidMeasurements = rowsAll.filter(row => !row.valid)

const writerRows = rows.filter(row => row.stage === 'writer-only' && row.arm === 'S')
function writerRecall(row) {
  const caseData = cases[row.caseId]
  if (caseData === undefined) return null
  const accepted = Array.isArray(row.writerAcceptedDeltas) ? row.writerAcceptedDeltas : []
  const matched = caseData.gold.filter(fact => accepted.some(delta => deltaMatchesFact(delta, fact) !== undefined))
  return caseData.gold.length === 0 ? null : matched.length / caseData.gold.length
}
for (const row of writerRows) row.matchedFactRecall = writerRecall(row)
const writerByPrompt = {}
for (const prompt of ['W0', 'W1']) {
  const selected = writerRows.filter(row => row.promptVersion === prompt)
  const parsed = selected.filter(row => row.writerProtocol === 'parsed')
  writerByPrompt[prompt] = {
    attempts: selected.length,
    parsed: parsed.length,
    malformed: selected.filter(row => row.writerProtocol !== 'parsed').length,
    accepted: selected.reduce((total, row) => total + (row.writerAccepted ?? 0), 0),
    refused: selected.reduce((total, row) => total + (row.writerRefused ?? 0), 0),
    commitRecall: selected.length === 0
      ? null
      : selected.reduce((total, row) => total + (row.matchedFactRecall ?? 0), 0) / selected.length,
    strictCriticalRecall: selected.length === 0
      ? null
      : selected.reduce((total, row) => total + (row.extraction?.criticalRecall ?? 0), 0) / selected.length,
    directVisibility: selected.length === 0
      ? null
      : selected.reduce((total, row) => total + (row.extraction?.directVisibility ?? 0), 0) / selected.length,
    rows: selected.map(row => ({
      caseId: row.caseId,
      replicateId: row.replicateId,
      valid: row.valid,
      protocol: row.writerProtocol,
      accepted: row.writerAccepted,
      refused: row.writerRefused,
      commitStatus: row.writerCommitStatus,
      matchedFactRecall: row.matchedFactRecall,
      criticalRecall: row.extraction?.criticalRecall ?? null,
      directVisibility: row.extraction?.directVisibility ?? null,
    })),
  }
}

const o2Rows = rows.filter(row => row.stage === 'continuation' && row.arm === 'O2')
const o2 = {
  rows: o2Rows.length,
  valid: count(o2Rows, row => row.valid),
  contractSuccesses: count(o2Rows, row => row.contractSuccess),
  taskSuccesses: count(o2Rows, row => row.taskSuccess),
  byCase: CASES.map(caseId => {
    const selected = o2Rows.filter(row => row.caseId === caseId)
    return {
      caseId,
      rows: selected.length,
      valid: count(selected, row => row.valid),
      contract: count(selected, row => row.contractSuccess),
      task: count(selected, row => row.taskSuccess),
    }
  }),
  rowsDetail: o2Rows.map(row => ({
    caseId: row.caseId,
    replicateId: row.replicateId,
    valid: row.valid,
    contract: row.contractSuccess,
    task: row.taskSuccess,
    failedChecks: row.failedChecks,
    delivery: row.delivery,
  })),
}

const e2eRows = rows.filter(row => row.stage === 'continuation' && (row.arm === 'B1' || row.arm === 'S')
  && row.fixture === null)
const pairs = []
for (const caseId of CASES) {
  const replicates = [...new Set(e2eRows.filter(row => row.caseId === caseId).map(row => row.replicateId))]
  for (const replicateId of replicates.sort()) {
    const baseline = e2eRows.find(row => row.caseId === caseId && row.replicateId === replicateId && row.arm === 'B1')
    const treatment = e2eRows.find(row => row.caseId === caseId && row.replicateId === replicateId && row.arm === 'S')
    if (baseline === undefined || treatment === undefined) {
      pairs.push({ caseId, replicateId, valid: false, reason: 'B1 or S missing' })
      continue
    }
    pairs.push({
      caseId,
      replicateId,
      valid: baseline.valid && treatment.valid,
      baseline: {
        valid: baseline.valid,
        contract: baseline.contractSuccess,
        task: baseline.taskSuccess,
        delivery: baseline.delivery,
        failedChecks: baseline.failedChecks,
      },
      treatment: {
        valid: treatment.valid,
        contract: treatment.contractSuccess,
        task: treatment.taskSuccess,
        delivery: treatment.delivery,
        failedChecks: treatment.failedChecks,
        foldValid: treatment.foldValid,
        testsExecuted: treatment.testsExecuted,
        steps: treatment.steps,
      },
      ...pairAnalysis(baseline, treatment),
    })
  }
}
const validPairs = pairs.filter(pair => pair.valid === true)
const e2e = {
  pairs: validPairs.length,
  contract: {
    rescue: count(validPairs, pair => pair.contractOutcome === 'rescue'),
    damage: count(validPairs, pair => pair.contractOutcome === 'damage'),
    both: count(validPairs, pair => pair.contractOutcome === 'both'),
    neither: count(validPairs, pair => pair.contractOutcome === 'neither'),
    invalid: pairs.filter(pair => pair.valid !== true).length,
  },
  task: {
    rescue: count(validPairs, pair => pair.taskOutcome === 'rescue'),
    damage: count(validPairs, pair => pair.taskOutcome === 'damage'),
    both: count(validPairs, pair => pair.taskOutcome === 'both'),
    neither: count(validPairs, pair => pair.taskOutcome === 'neither'),
  },
  byCase: CASES.map(caseId => {
    const selected = validPairs.filter(pair => pair.caseId === caseId)
    return {
      caseId,
      pairs: selected.length,
      rescue: count(selected, pair => pair.contractOutcome === 'rescue'),
      damage: count(selected, pair => pair.contractOutcome === 'damage'),
      both: count(selected, pair => pair.contractOutcome === 'both'),
      neither: count(selected, pair => pair.contractOutcome === 'neither'),
      confounds: [...new Set(selected.flatMap(pair => pair.confounds.map(entry => entry.kind)))],
    }
  }),
  pairsDetail: pairs,
}

const representationArms = ['FP', 'FS', 'FN', 'FH']
const representationRows = rows.filter(row => row.stage === 'continuation' && representationArms.includes(row.arm))
const representation = {
  rows: representationRows.length,
  byCase: {},
  cells: {},
}
for (const caseId of ['B2', 'C1']) {
  const selected = representationRows.filter(row => row.caseId === caseId)
  representation.byCase[caseId] = {
    rows: selected.length,
    valid: count(selected, row => row.valid),
    byArm: {},
  }
  for (const arm of representationArms) {
    const armRows = selected.filter(row => row.arm === arm)
    const cell = {
      arm,
      fixture: armRows[0]?.fixture ?? null,
      rows: armRows.length,
      valid: count(armRows, row => row.valid),
      contract: count(armRows, row => row.contractSuccess),
      task: count(armRows, row => row.taskSuccess),
      delivery: armRows.map(row => row.delivery),
      failedChecks: armRows.flatMap(row => row.failedChecks),
      rowsDetail: armRows.map(row => ({
        replicateId: row.replicateId,
        valid: row.valid,
        contract: row.contractSuccess,
        task: row.taskSuccess,
        testsExecuted: row.testsExecuted,
        steps: row.steps,
        failedChecks: row.failedChecks,
      })),
    }
    representation.byCase[caseId].byArm[arm] = cell
    representation.cells[`${caseId}-${arm}`] = cell
  }
}

const contrasts = [
  { caseId: 'B2', treatment: 'FS', baseline: 'FP' },
  { caseId: 'B2', treatment: 'FN', baseline: 'FP' },
  { caseId: 'C1', treatment: 'FS', baseline: 'FP' },
  { caseId: 'C1', treatment: 'FH', baseline: 'FP' },
]
representation.paired = contrasts.map(contrast => {
  const rows = representationRows.filter(row => row.caseId === contrast.caseId)
  const replicates = [...new Set(rows.map(row => row.replicateId))].sort()
  const outcomes = []
  for (const replicateId of replicates) {
    const treatment = rows.find(row => row.replicateId === replicateId && row.arm === contrast.treatment)
    const baseline = rows.find(row => row.replicateId === replicateId && row.arm === contrast.baseline)
    if (treatment === undefined || baseline === undefined) continue
    outcomes.push({
      replicateId,
      treatmentContract: treatment.contractSuccess,
      baselineContract: baseline.contractSuccess,
      outcome: treatment.contractSuccess === baseline.contractSuccess
        ? 'tie'
        : treatment.contractSuccess ? 'win' : 'loss',
    })
  }
  return {
    caseId: contrast.caseId,
    treatment: contrast.treatment,
    baseline: contrast.baseline,
    pairs: outcomes.length,
    wins: outcomes.filter(entry => entry.outcome === 'win').length,
    losses: outcomes.filter(entry => entry.outcome === 'loss').length,
    ties: outcomes.filter(entry => entry.outcome === 'tie').length,
    outcomes,
  }
})

const cost = {
  reports: reports.length,
  rows: rowsAll.length,
  uniqueRows: rows.length,
  attempts: rowsAll.reduce((total, row) => total + (row.cost?.attempts ?? 0), 0),
  inputTokens: rowsAll.reduce((total, row) => total + (row.cost?.observedInputTokens ?? 0), 0),
  outputTokens: rowsAll.reduce((total, row) => total + (row.cost?.observedOutputTokens ?? 0), 0),
  cacheReadTokens: rowsAll.reduce((total, row) => total + (row.cost?.cacheReadTokens ?? 0), 0),
  unknownUsageRequests: rowsAll.reduce((total, row) => total + (row.cost?.unknownUsageRequests ?? 0), 0),
  retries: rowsAll.reduce((total, row) => total + (row.cost?.httpRetries ?? 0), 0),
  invalidMeasurements: invalidMeasurements.length,
}

const protocol = {
  rows: rows.length,
  toolProtocols: [...new Set(rows.map(row => row.toolProtocol).filter(Boolean))],
  modelTurns: rows.reduce((total, row) => total + (row.steps ?? 0), 0),
  validActions: rows.reduce((total, row) => total + row.validActions, 0),
  rejectedActions: rows.reduce((total, row) => total + row.rejectedActions, 0),
  invalidActionTurns: rows.reduce((total, row) => total + row.invalidActions, 0),
  rowsWithRejections: rows.filter(row => row.rejectedActions > 0).length,
  rejectionRate: (() => {
    const valid = rows.reduce((total, row) => total + row.validActions, 0)
    const rejected = rows.reduce((total, row) => total + row.rejectedActions, 0)
    return valid + rejected === 0 ? null : rejected / (valid + rejected)
  })(),
  noValidActionTurnRate: (() => {
    const turns = rows.reduce((total, row) => total + (row.steps ?? 0), 0)
    const invalid = rows.reduce((total, row) => total + row.invalidActions, 0)
    return turns === 0 ? null : invalid / turns
  })(),
  rejectedReasons: (() => {
    const counts = {}
    for (const row of rows) {
      for (const detail of row.invalidActionDetails) {
        for (const reason of detail.reasons ?? []) {
          counts[reason.reason] = (counts[reason.reason] ?? 0) + 1
        }
      }
    }
    return counts
  })(),
  diagnostics: rows.flatMap(row => row.protocolDiagnostics).reduce((counts, diagnostic) => {
    counts[diagnostic.reason] = (counts[diagnostic.reason] ?? 0) + 1
    return counts
  }, {}),
}
protocol.unparsedTurns = protocol.diagnostics['truncated-invoke'] ?? 0
protocol.unparsedTurnRate = protocol.modelTurns === 0 ? null : protocol.unparsedTurns / protocol.modelTurns

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: process.env.R37B_STAGE === 'stage2' ? 'confirmatory-stage-2' : 'exploratory-stage-1',
  stage: process.env.R37B_STAGE ?? 'stage1',
  replicates: Number(process.env.R37B_STAGE_REPLICATES ?? 4),
  source: { runRoot: relRoot(RUNS), reports: reports.length },
  writer: { byPrompt: writerByPrompt },
  o2,
  e2e,
  representation,
  protocol,
  cost,
  notes: [
    'Stage 1 is exploratory under R37_B_PREREGISTRATION_AMENDMENT A1; it is not a confirmatory product result.',
    'The B1/S pairs are assigned-arm pairs; S fallback rows remain in the denominator.',
    'Representation rows are controlled oracle-facts interventions, not EF writer output.',
    'A1-v2/D1-v2 are versioned cases; old A1/D1 are not pooled.',
  ],
}
await writeJson(OUT, result)

process.stdout.write(`R37-B analysis: ${OUT}\n`)
process.stdout.write(`reports ${reports.length}; rows ${rows.length}\n`)
for (const prompt of ['W0', 'W1']) {
  const entry = writerByPrompt[prompt]
  process.stdout.write(`writer ${prompt}: ${entry.parsed}/${entry.attempts} parsed, ${entry.accepted} accepted, ${entry.refused} refused, commit recall ${entry.commitRecall}\n`)
}
process.stdout.write(`O2: ${o2.contractSuccesses}/${o2.rows} contract, ${o2.taskSuccesses}/${o2.rows} task\n`)
process.stdout.write(`E2E contract: ${JSON.stringify(e2e.contract)}\n`)
process.stdout.write(`E2E task: ${JSON.stringify(e2e.task)}\n`)
for (const caseId of CASES) {
  process.stdout.write(`  ${caseId}: ${JSON.stringify(e2e.byCase.find(entry => entry.caseId === caseId))}\n`)
}
for (const [key, cell] of Object.entries(representation.cells)) {
  process.stdout.write(`rep ${key}: ${cell.contract}/${cell.rows} contract, ${cell.task}/${cell.rows} task\n`)
}
process.stdout.write(`protocol: ${JSON.stringify(protocol)}\n`)
process.stdout.write(`cost: ${JSON.stringify(cost)}\n`)
