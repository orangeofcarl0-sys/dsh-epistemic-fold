#!/usr/bin/env node
/**
 * EF-R2 WP1 — rebuild a per-attempt witness for every archived E2E cell.
 *
 * The 12 campaigns / 290 cells were run by different harness versions. This
 * script does not re-run them and does not rewrite them. It reads each cell's
 * report, raw requests, full primary messages (where the version captured
 * them) and bundle directory, then classifies every compaction attempt:
 *
 *   committed | refused | aborted | unverifiable
 *
 * with an evidence level:
 *
 *   verified    — a commit record + verified bundle (EF), or the live log
 *   inferred    — report/error/orphan bundle, link by order
 *   unverifiable— not enough evidence, never promoted
 *
 * The important output is the DISCREPANCY list: cells where the legacy
 * `error === null` fold count disagrees with the witness's committed count.
 *
 *   node eval/r2/reconstruct-witnesses.mjs
 *
 * @module eval/r2/reconstruct-witnesses
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildWitnessesFromRun,
  summarizeWitnesses,
} from '../e2e/src/witness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const stages = readJson(join(E2E_OUT, 'stage-attribution.json'))
const rows = stages.rows ?? []
const campaigns = [...new Set(rows.map(row => row.campaign))].sort()

function taskPromptOf(row) {
  const path = join(ROOT, 'eval', 'e2e', 'tasks', `${row.template}-s${row.seed}.json`)
  if (!existsSync(path)) return undefined
  try {
    return readJson(path).task
  } catch {
    return undefined
  }
}

const cells = []
for (const row of rows) {
  const cellRoot = join(ROOT, 'eval', 'e2e', 'runs', row.campaign, row.cellId)
  const reportPath = join(cellRoot, 'report.json')
  if (!existsSync(reportPath)) {
    cells.push({
      campaign: row.campaign,
      cellId: row.cellId,
      arm: row.arm,
      template: row.template,
      seed: row.seed,
      replicate: row.replicate,
      checkerPassed: row.checkerPassed,
      missing: 'report.json',
      legacy: null,
      witness: { attempts: 0, committed: 0, refused: 0, aborted: 0, unverifiable: 0, unverified: 0 },
      discrepancies: [],
      witnesses: [],
    })
    continue
  }
  const report = readJson(reportPath)
  const requestsPath = join(cellRoot, 'raw', 'requests.json')
  const messagesPath = join(cellRoot, 'raw', 'messages.json')
  const requests = existsSync(requestsPath) ? readJson(requestsPath) : []
  const fullMessages = existsSync(messagesPath) ? readJson(messagesPath) : []
  const built = await buildWitnessesFromRun({
    report,
    requests,
    fullMessages,
    bundleRoot: join(cellRoot, 'bundles'),
    taskPrompt: taskPromptOf(row),
    arm: row.arm,
  })
  const witness = summarizeWitnesses(built.witnesses)
  const legacyFolds = (report.compactions ?? []).filter(compaction => compaction.error === null).length
  const legacyFailures = (report.compactions ?? []).filter(compaction => compaction.error !== null).length
  const discrepancies = []
  if (legacyFolds !== witness.committed) {
    discrepancies.push({ kind: 'legacy-folds-not-committed', legacyFolds, witnessCommitted: witness.committed })
  }
  if ((report.compactions ?? []).length !== witness.attempts) {
    discrepancies.push({
      kind: 'attempt-count',
      legacyAttempts: (report.compactions ?? []).length,
      witnessAttempts: witness.attempts,
    })
  }
  cells.push({
    campaign: row.campaign,
    cellId: row.cellId,
    arm: row.arm,
    template: row.template,
    seed: row.seed,
    replicate: row.replicate,
    checkerPassed: row.checkerPassed,
    fullMessages: fullMessages.length,
    legacy: {
      attempts: (report.compactions ?? []).length,
      folds: legacyFolds,
      failures: legacyFailures,
      checkpoint: report.checkpoint !== null && report.checkpoint !== undefined,
      treatmentExposure: report.treatmentExposure ?? null,
    },
    witness,
    discrepancies,
    witnesses: built.witnesses,
    taskDelivery: built.taskDelivery,
  })
}

const byCampaign = campaigns.map(campaign => {
  const selected = cells.filter(cell => cell.campaign === campaign)
  const sum = key => selected.reduce((total, cell) => total + (cell.witness[key] ?? 0), 0)
  return {
    campaign,
    cells: selected.length,
    attempts: sum('attempts'),
    committed: sum('committed'),
    refused: sum('refused'),
    aborted: sum('aborted'),
    unverifiable: sum('unverifiable'),
    verified: sum('verified'),
    inferred: sum('inferred'),
    unverified: sum('unverified'),
    legacyFolds: selected.reduce((total, cell) => total + (cell.legacy?.folds ?? 0), 0),
    discrepancies: selected.reduce((total, cell) => total + cell.discrepancies.length, 0),
  }
})

const byArm = [...new Set(cells.map(cell => cell.arm))].sort().map(arm => {
  const selected = cells.filter(cell => cell.arm === arm)
  const sum = key => selected.reduce((total, cell) => total + (cell.witness[key] ?? 0), 0)
  return {
    arm,
    cells: selected.length,
    attempts: sum('attempts'),
    committed: sum('committed'),
    refused: sum('refused'),
    aborted: sum('aborted'),
    unverifiable: sum('unverifiable'),
    verified: sum('verified'),
    inferred: sum('inferred'),
    unverified: sum('unverified'),
    committedAndDelivered: sum('committedAndDelivered'),
    committedNotDelivered: sum('committedNotDelivered'),
    committedDeliveryUnverifiable: sum('committedDeliveryUnverifiable'),
    noFollowingRequest: sum('noFollowingRequest'),
  }
})

const totals = {
  cells: cells.length,
  campaigns: campaigns.length,
  attempts: cells.reduce((sum, cell) => sum + (cell.witness.attempts ?? 0), 0),
  committed: cells.reduce((sum, cell) => sum + (cell.witness.committed ?? 0), 0),
  refused: cells.reduce((sum, cell) => sum + (cell.witness.refused ?? 0), 0),
  aborted: cells.reduce((sum, cell) => sum + (cell.witness.aborted ?? 0), 0),
  unverifiable: cells.reduce((sum, cell) => sum + (cell.witness.unverifiable ?? 0), 0),
  verified: cells.reduce((sum, cell) => sum + (cell.witness.verified ?? 0), 0),
  inferred: cells.reduce((sum, cell) => sum + (cell.witness.inferred ?? 0), 0),
  unverified: cells.reduce((sum, cell) => sum + (cell.witness.unverified ?? 0), 0),
  legacyFolds: cells.reduce((sum, cell) => sum + (cell.legacy?.folds ?? 0), 0),
  cellsWithDiscrepancies: cells.filter(cell => cell.discrepancies.length > 0).length,
  missingReports: cells.filter(cell => cell.missing !== undefined).length,
}

const output = {
  schemaVersion: 1,
  work: 'EF-R2 WP1',
  generatedAt: new Date().toISOString(),
  sources: {
    stageAttribution: { path: 'eval/e2e/out/stage-attribution.json', sha256: sha256(join(E2E_OUT, 'stage-attribution.json')) },
    campaigns,
  },
  totals,
  byCampaign,
  byArm,
  discrepancies: cells
    .filter(cell => cell.discrepancies.length > 0)
    .map(cell => ({ campaign: cell.campaign, cellId: cell.cellId, arm: cell.arm, ...cell.legacy, witness: cell.witness, discrepancies: cell.discrepancies })),
  cells,
  note: 'Historical reconstruction. An attempt linked to an orphan bundle by order is inferred, never verified. Basic cells have no EF bundle and no per-attempt delivery evidence; they stay inferred. No historical report was modified.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'compaction-witnesses.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

process.stdout.write(`witnesses: ${totals.cells} cells, ${totals.attempts} attempts, ${totals.committed} committed, ${totals.refused} refused, ${totals.aborted} aborted, ${totals.unverifiable} unverifiable\n`)
process.stdout.write(`evidence: verified ${totals.verified}, inferred ${totals.inferred}, unverifiable ${totals.unverified}\n`)
process.stdout.write(`legacy folds ${totals.legacyFolds}; cells with discrepancies ${totals.cellsWithDiscrepancies}\n`)
for (const row of byCampaign) {
  process.stdout.write(`  ${row.campaign}: cells ${row.cells}, attempts ${row.attempts}, committed ${row.committed}, refused ${row.refused}, legacy ${row.legacyFolds}\n`)
}
