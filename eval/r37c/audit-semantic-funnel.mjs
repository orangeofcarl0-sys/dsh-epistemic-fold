#!/usr/bin/env node
/**
 * R37-C0-B: recompute the writer funnel from raw traces and journals.
 *
 * R37-B's `commitRecall` is accepted-delta matching. This audit reports it
 * separately from committed recall, which requires a committed receipt and an
 * active anchor at the accepted delta's state key.
 *
 *   node eval/r37c/audit-semantic-funnel.mjs
 *
 * @module eval/r37c/audit-semantic-funnel
 */

import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import { deltaMatchesFact, normalize } from '../r36/writer-protocol.mjs'
import { readJson, writeJson } from '../r37/src/io.mjs'
import { aggregateFunnels, semanticFunnel } from './src/semantic-funnel.mjs'
import { readJournalState } from './src/journal-state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R37_ROOT = process.env.R37C_R37_ROOT === undefined
  ? resolve(ROOT, '..', 'ef-r37-action', 'eval', 'r37')
  : resolve(process.env.R37C_R37_ROOT)
const RUNS = join(R37_ROOT, 'runs-b2')
const OUT = join(HERE, 'out', 'semantic-funnel-audit.json')
const CASES = ['A1-v2', 'D1-v2', 'B2', 'C1', 'F1', 'H1']
const WEIGHT = { high: 3, medium: 2, low: 1 }

const cases = {}
for (const caseId of CASES) {
  cases[caseId] = await loadCase(caseId, caseId.endsWith('-v2')
    ? join(R37_ROOT, 'cases')
    : join(R37_ROOT, '..', 'r33', 'cases'))
}

function scopeText(scope) {
  if (scope === undefined || scope === null) return ''
  return Object.keys(scope).sort().map(key => `${key}=${scope[key]}`).join('&')
}

function exactStatementRecall(caseData, accepted) {
  const gold = new Map()
  for (const fact of caseData.gold) {
    gold.set(`${fact.kind}|${fact.subjectKey}|${scopeText(fact.scope)}|${normalize(fact.statement)}`, fact)
  }
  const used = new Set()
  let matchedWeight = 0
  for (const delta of accepted ?? []) {
    const key = `${delta.kind}|${delta.subjectKey}|${scopeText(delta.scope)}|${normalize(delta.statement)}`
    const fact = gold.get(key)
    if (fact === undefined || used.has(fact.factId)) continue
    used.add(fact.factId)
    matchedWeight += WEIGHT[fact.criticality] ?? 0
  }
  const totalWeight = caseData.gold.reduce((total, fact) => total + (WEIGHT[fact.criticality] ?? 0), 0)
  return totalWeight === 0 ? null : matchedWeight / totalWeight
}

function oldAcceptedRecall(caseData, accepted) {
  const matched = caseData.gold.filter(fact =>
    (accepted ?? []).some(delta => deltaMatchesFact(delta, fact) !== undefined))
  return caseData.gold.length === 0 ? null : matched.length / caseData.gold.length
}

const runIds = (await readdir(RUNS, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && entry.name.includes('-writer-'))
  .map(entry => entry.name)
  .sort()

const rows = []
for (const runId of runIds) {
  const report = await readJson(join(RUNS, runId, 'report.json'))
  for (const row of report.rows ?? []) {
    const base = join(RUNS, runId, row.caseId, row.arm, row.replicateId)
    const trace = await readJson(join(base, 'trace', 'record.json'))
    const journal = await readJournalState(join(base, 'journal'))
    const caseData = cases[row.caseId]
    const proposed = trace.writer?.proposedDeltas ?? row.writer?.proposedDeltas ?? null
    const accepted = trace.writer?.acceptedDeltas ?? row.writer?.acceptedDeltas ?? null
    const funnel = semanticFunnel(caseData, {
      writerRaw: trace.writerRaw ?? null,
      proposed,
      accepted,
      anchors: journal.anchors,
      commitProof: journal.proofValid,
      checkpoint: trace.checkpoint ?? row.checkpoint?.text ?? null,
      unavailable: journal.unavailable,
    })
    const extraction = row.extraction ?? null
    const exact = exactStatementRecall(caseData, accepted)
    rows.push({
      runId,
      caseId: row.caseId,
      replicateId: row.replicateId,
      promptVersion: report.modelParameters?.writerPromptVersion ?? null,
      valid: row.valid === true,
      measurementValid: row.measurementValid === true,
      outcome: row.failures?.outcome ?? null,
      writerProtocol: row.writer?.protocol ?? null,
      commitStatus: row.writer?.commitStatus ?? null,
      acceptedCount: Array.isArray(accepted) ? accepted.length : null,
      proposedCount: Array.isArray(proposed) ? proposed.length : null,
      oldAcceptedRecall: oldAcceptedRecall(caseData, accepted),
      exactStatementRecall: exact,
      extractionPresent: extraction !== null,
      criticalRecall: extraction?.criticalRecall ?? null,
      criticalRecallFieldPresent: extraction !== null
        && Object.prototype.hasOwnProperty.call(extraction, 'criticalRecall'),
      directVisibility: extraction?.directVisibility ?? null,
      funnel,
      journal: {
        found: journal.journalFound,
        packets: journal.packets,
        receipts: journal.receipts,
        committedPackets: journal.committedPackets,
        proofValid: journal.proofValid,
        errors: journal.errors,
      },
    })
  }
}

function mean(values) {
  const measured = values.filter(value => typeof value === 'number')
  return measured.length === 0 ? null : measured.reduce((total, value) => total + value, 0) / measured.length
}

function summarize(selected) {
  const funnels = selected.map(row => row.funnel)
  return {
    rows: selected.length,
    oldAcceptedRecall: mean(selected.map(row => row.oldAcceptedRecall)),
    exactStatementRecall: mean(selected.map(row => row.exactStatementRecall)),
    criticalRecall: mean(selected.map(row => row.criticalRecall)),
    funnel: aggregateFunnels(funnels),
    commitStatus: selected.reduce((counts, row) => {
      const key = row.commitStatus ?? 'unknown'
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
    journalProof: selected.reduce((counts, row) => {
      const key = row.journal.proofValid === true ? 'valid'
        : row.journal.proofValid === false ? 'invalid-or-aborted'
          : 'no-journal'
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
    criticalRecallField: {
      present: selected.filter(row => row.criticalRecallFieldPresent).length,
      missing: selected.filter(row => !row.criticalRecallFieldPresent).length,
      nullValue: selected.filter(row => row.criticalRecall === null).length,
      zeroValue: selected.filter(row => row.criticalRecall === 0).length,
      nonzeroValue: selected.filter(row => typeof row.criticalRecall === 'number' && row.criticalRecall !== 0).length,
    },
    acceptedButNotCommitted: funnels.flatMap(funnel => funnel.acceptedButNotCommitted).length,
    committedButNotRendered: funnels.flatMap(funnel => funnel.committedButNotRendered).length,
  }
}

const byPrompt = {}
for (const prompt of ['W0', 'W1']) {
  byPrompt[prompt] = summarize(rows.filter(row => row.promptVersion === prompt))
}
const overall = summarize(rows)
const discrepancies = []
for (const row of rows) {
  if (row.criticalRecall !== null && row.exactStatementRecall !== null
    && Math.abs(row.criticalRecall - row.exactStatementRecall) > 1e-9) {
    discrepancies.push({
      runId: row.runId,
      caseId: row.caseId,
      replicateId: row.replicateId,
      criticalRecall: row.criticalRecall,
      exactStatementRecall: row.exactStatementRecall,
    })
  }
}
const acceptedButNotCommittedRows = rows.filter(row => row.funnel.acceptedButNotCommitted.length > 0)
const committedButNotRenderedRows = rows.filter(row => row.funnel.committedButNotRendered.length > 0)

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C0-B',
  source: {
    runRoot: RUNS,
    stage: 2,
    writerRows: rows.length,
    definition: {
      oldCommitRecall: 'mean over rows of accepted-delta matches / gold facts',
      committedFactRecall: 'accepted delta matched to a gold fact, with an active anchor at the delta state key and a committed receipt',
      renderedFactCoverage: 'lexical checkpoint coverage; semantic validity is not claimed',
    },
  },
  byPrompt,
  overall,
  discrepancies: {
    count: discrepancies.length,
    detail: discrepancies,
  },
  acceptedButNotCommitted: {
    rows: acceptedButNotCommittedRows.length,
    detail: acceptedButNotCommittedRows.map(row => ({
      runId: row.runId,
      caseId: row.caseId,
      replicateId: row.replicateId,
      promptVersion: row.promptVersion,
      commitStatus: row.commitStatus,
      accepted: row.funnel.accepted,
      committed: row.funnel.committed,
      facts: row.funnel.acceptedButNotCommitted.map(fact => ({
        factId: fact.factId,
        reason: fact.anchorPresentButNotCommitted?.reason ?? 'no-active-anchor',
      })),
    })),
  },
  committedButNotRendered: {
    rows: committedButNotRenderedRows.length,
    detail: committedButNotRenderedRows.map(row => ({
      runId: row.runId,
      caseId: row.caseId,
      replicateId: row.replicateId,
      promptVersion: row.promptVersion,
      facts: row.funnel.committedButNotRendered.map(fact => fact.factId),
    })),
  },
  rows,
  conclusions: [
    'The old commitRecall is an accepted-fact proxy. It counts fold-refused rows as if the facts were committed.',
    'Committed recall requires a committed receipt and an active anchor at the accepted delta state key.',
    'strictCriticalRecall is a real zero where the field is present: it is exact-statement weighted recall, not accepted matching.',
    'A missing extraction field is reported as missing; it is not imputed as zero.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`R37-C semantic funnel audit: ${OUT}\n`)
for (const prompt of ['W0', 'W1']) {
  const entry = byPrompt[prompt]
  process.stdout.write(`${prompt}: rows ${entry.rows}; old accepted ${entry.oldAcceptedRecall}; `
    + `committed ${entry.funnel.byStage.committed}; rendered ${entry.funnel.byStage.rendered}; `
    + `status ${JSON.stringify(entry.commitStatus)}; proof ${JSON.stringify(entry.journalProof)}\n`)
}
process.stdout.write(`accepted-but-not-committed rows: ${acceptedButNotCommittedRows.length}; `
  + `committed-but-not-rendered rows: ${committedButNotRenderedRows.length}\n`)
process.stdout.write(`criticalRecall field: ${JSON.stringify(overall.criticalRecallField)}; `
  + `discrepancies ${discrepancies.length}\n`)
