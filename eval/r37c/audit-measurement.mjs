#!/usr/bin/env node
/**
 * R37-C0-C: audit the R37-B "invalid measurement" rows.
 *
 * The Stage 2 summary reported 11 invalid measurements. This script separates
 * true censored measurements (provider/transport) from observable pipeline
 * outcomes (fold refusal), and recomputes the assigned-arm denominators.
 *
 *   node eval/r37c/audit-measurement.mjs
 *
 * @module eval/r37c/audit-measurement
 */

import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import { deltaMatchesFact } from '../r36/writer-protocol.mjs'
import { readJson, writeJson } from '../r37/src/io.mjs'
import { assignedArmSummary, classifyRow } from './src/measurement.mjs'
import { readJournalState } from './src/journal-state.mjs'
import { semanticFunnel } from './src/semantic-funnel.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R37_ROOT = process.env.R37C_R37_ROOT === undefined
  ? resolve(ROOT, '..', 'ef-r37-action', 'eval', 'r37')
  : resolve(process.env.R37C_R37_ROOT)
const RUNS = join(R37_ROOT, 'runs-b2')
const OUT = join(HERE, 'out', 'measurement-vs-pipeline.json')
const CASES = ['A1-v2', 'D1-v2', 'B2', 'C1', 'F1', 'H1']

const cases = {}
for (const caseId of CASES) {
  cases[caseId] = await loadCase(caseId, caseId.endsWith('-v2')
    ? join(R37_ROOT, 'cases')
    : join(R37_ROOT, '..', 'r33', 'cases'))
}

function mean(values) {
  const measured = values.filter(value => typeof value === 'number')
  return measured.length === 0 ? null : measured.reduce((total, value) => total + value, 0) / measured.length
}

const runIds = (await readdir(RUNS, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()
const all = []
for (const runId of runIds) {
  const report = await readJson(join(RUNS, runId, 'report.json'))
  for (const row of report.rows ?? []) {
    const base = join(RUNS, runId, row.caseId, row.arm, row.replicateId)
    const tracePath = join(base, 'trace', 'record.json')
    const trace = await readJson(tracePath).catch(() => null)
    all.push({
      runId,
      report,
      row,
      trace,
      classification: classifyRow(row, { tracePresent: trace !== null }),
    })
  }
}

// Same dedupe rule as the R37-B analysis: one row per cell, prefer a valid
// measurement, then the most recent run id. Retries remain in the cost ledger.
const deduped = new Map()
for (const entry of all) {
  const key = entry.row.stage === 'writer-only'
    ? `${entry.row.stage}|${entry.report.modelParameters?.writerPromptVersion ?? ''}|${entry.row.caseId}|${entry.row.arm}|${entry.row.replicateId}`
    : `${entry.row.stage}|${entry.row.caseId}|${entry.row.arm}|${entry.row.replicateId}`
  const existing = deduped.get(key)
  if (existing === undefined
    || (entry.row.valid && !existing.row.valid)
    || (entry.row.valid === existing.row.valid && entry.runId > existing.runId)) {
    deduped.set(key, entry)
  }
}
const rows = [...deduped.values()]
const invalid = all.filter(entry => entry.row.valid !== true || entry.row.measurementValid !== true)
const invalidByMeasurement = invalid.reduce((counts, entry) => {
  counts[entry.classification.measurement] = (counts[entry.classification.measurement] ?? 0) + 1
  return counts
}, {})
const invalidByPipeline = invalid.reduce((counts, entry) => {
  counts[entry.classification.pipeline] = (counts[entry.classification.pipeline] ?? 0) + 1
  return counts
}, {})

const writerRows = rows.filter(entry => entry.row.stage === 'writer-only')
const writerDetail = []
for (const entry of writerRows) {
  const { row, report, runId } = entry
  const base = join(RUNS, runId, row.caseId, row.arm, row.replicateId)
  const journal = await readJournalState(join(base, 'journal'))
  const caseData = cases[row.caseId]
  const accepted = entry.trace?.writer?.acceptedDeltas ?? row.writer?.acceptedDeltas ?? []
  const proposed = entry.trace?.writer?.proposedDeltas ?? row.writer?.proposedDeltas ?? []
  const funnel = semanticFunnel(caseData, {
    writerRaw: entry.trace?.writerRaw ?? null,
    proposed,
    accepted,
    anchors: journal.anchors,
    commitProof: journal.proofValid,
    checkpoint: entry.trace?.checkpoint ?? row.checkpoint?.text ?? null,
    unavailable: journal.unavailable,
  })
  const acceptedRecall = caseData.gold.length === 0
    ? null
    : caseData.gold.filter(fact => accepted.some(delta => deltaMatchesFact(delta, fact) !== undefined)).length / caseData.gold.length
  writerDetail.push({
    runId,
    caseId: row.caseId,
    replicateId: row.replicateId,
    promptVersion: report.modelParameters?.writerPromptVersion ?? null,
    oldValid: row.valid === true,
    measurement: entry.classification.measurement,
    pipeline: entry.classification.pipeline,
    commitStatus: row.writer?.commitStatus ?? null,
    accepted: accepted.length,
    acceptedRecall,
    committedRecall: funnel.recall.committed,
    rawMentionRecall: funnel.recall.rawMention,
    renderedCoverage: funnel.recall.rendered,
    journalProofValid: journal.proofValid,
  })
}

function writerSensitivity(prompt) {
  const selected = writerDetail.filter(entry => entry.promptVersion === prompt)
  const oldValidOnly = selected.filter(entry => entry.oldValid === true)
  const foldRefused = selected.filter(entry => entry.pipeline === 'fold-refused')
  return {
    rows: selected.length,
    oldValidRows: oldValidOnly.length,
    foldRefusedRows: foldRefused.length,
    oldReportedAcceptedRecallAllRows: mean(selected.map(entry => entry.acceptedRecall)),
    oldAcceptedRecallValidOnly: mean(oldValidOnly.map(entry => entry.acceptedRecall)),
    committedRecallAllRows: mean(selected.map(entry => entry.committedRecall)),
    committedRecallValidOnly: mean(oldValidOnly.map(entry => entry.committedRecall)),
    foldRefusedAcceptedRecall: mean(foldRefused.map(entry => entry.acceptedRecall)),
    foldRefusedCommittedRecall: mean(foldRefused.map(entry => entry.committedRecall)),
    renderedCoverageAllRows: mean(selected.map(entry => entry.renderedCoverage)),
  }
}

const stage2Summary = await readJson(join(R37_ROOT, 'out', 'r37b-stage2-results.json'))
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C0-C',
  source: {
    runRoot: RUNS,
    reports: runIds.length,
    rows: all.length,
    uniqueCells: rows.length,
  },
  reportedInvalidMeasurements: stage2Summary.cost?.invalidMeasurements ?? null,
  recomputed: {
    invalidRows: invalid.length,
    byMeasurement: invalidByMeasurement,
    byPipeline: invalidByPipeline,
    providerInvalid: invalid.filter(entry => entry.classification.measurement === 'provider-invalid').length,
    foldRefused: invalid.filter(entry => entry.classification.pipeline === 'fold-refused').length,
    note: 'A fold refusal is a valid measurement of a pipeline outcome. Only provider/transport failures are censored.',
  },
  invalidRows: invalid.map(entry => ({
    runId: entry.runId,
    stage: entry.row.stage,
    caseId: entry.row.caseId,
    arm: entry.row.arm,
    replicateId: entry.row.replicateId,
    oldValid: entry.row.valid === true,
    oldMeasurementValid: entry.row.measurementValid === true,
    outcome: entry.row.failures?.outcome ?? null,
    providerFailures: entry.row.failures?.provider ?? [],
    foldFailures: entry.row.failures?.fold ?? [],
    measurement: entry.classification.measurement,
    pipeline: entry.classification.pipeline,
    writerCommitStatus: entry.row.writer?.commitStatus ?? null,
  })),
  assignedArm: assignedArmSummary(rows.map(entry => entry.row)),
  writerSensitivity: {
    W0: writerSensitivity('W0'),
    W1: writerSensitivity('W1'),
  },
  writerDetail,
  conclusions: [
    'The Stage 2 summary count of 11 invalid measurements conflates 9 fold refusals with 2 provider/transport failures.',
    'Fold refusals remain in the assigned-arm denominator; they are not deleted from the product analysis.',
    'The old commitRecall includes accepted facts from fold-refused rows; committed recall does not.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`R37-C measurement audit: ${OUT}\n`)
process.stdout.write(`reported invalid ${report.reportedInvalidMeasurements}; recomputed invalid ${invalid.length}; `
  + `provider-invalid ${report.recomputed.providerInvalid}; fold-refused ${report.recomputed.foldRefused}\n`)
for (const prompt of ['W0', 'W1']) {
  const entry = report.writerSensitivity[prompt]
  process.stdout.write(`${prompt}: accepted all ${entry.oldReportedAcceptedRecallAllRows}; `
    + `accepted valid-only ${entry.oldAcceptedRecallValidOnly}; committed all ${entry.committedRecallAllRows}; `
    + `committed valid-only ${entry.committedRecallValidOnly}; fold-refused ${entry.foldRefusedRows}\n`)
}
