#!/usr/bin/env node
/**
 * EF-R3 — reconcile the R2 confirm against its immutable artifacts.
 *
 * This script does not rewrite `results-e2e-r2-confirm-merged.json` or
 * `live-route-incident.json`. It reads the original manifests, results and
 * reports, builds the Attempt and Unique Cell ledgers, and records the exact
 * fields the old merge got wrong.
 *
 *   node eval/r3/reconcile-confirm.mjs
 *
 * @module eval/r3/reconcile-confirm
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLedgers, readJson, sha256File, summarizeLedger } from './ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const R2_OUT = join(ROOT, 'eval', 'r2', 'out')
const OUT = join(HERE, 'out')

const CONFIRM_CAMPAIGNS = [
  {
    campaign: 'e2e-r2-confirm-1',
    campaignIndex: 0,
    manifestPath: join(E2E_OUT, 'manifest-e2e-r2-confirm-1.json'),
    resultsPath: join(E2E_OUT, 'results-e2e-r2-confirm-1.json'),
  },
  {
    campaign: 'e2e-r2-confirm-resume-1',
    campaignIndex: 1,
    manifestPath: join(E2E_OUT, 'manifest-e2e-r2-confirm-resume-1.json'),
    resultsPath: join(E2E_OUT, 'results-e2e-r2-confirm-resume-1.json'),
  },
]

const PILOT_CAMPAIGNS = [
  {
    campaign: 'e2e-r2-pilot-1',
    campaignIndex: 0,
    manifestPath: join(E2E_OUT, 'manifest-e2e-r2-pilot-1.json'),
    resultsPath: join(E2E_OUT, 'results-e2e-r2-pilot-1.json'),
  },
]

function loadCampaigns(descriptors) {
  return descriptors.map(descriptor => ({
    ...descriptor,
    manifest: readJson(descriptor.manifestPath),
    results: readJson(descriptor.resultsPath),
  }))
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function writeJson(name, value) {
  const path = join(OUT, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { path: `eval/r3/out/${name}`, sha256: sha256File(path) }
}

function main() {
  mkdirSync(OUT, { recursive: true })

  const confirmCampaigns = loadCampaigns(CONFIRM_CAMPAIGNS)
  const pilotCampaigns = loadCampaigns(PILOT_CAMPAIGNS)
  const confirmPlan = confirmCampaigns[0]
  const pilotPlan = pilotCampaigns[0]

  const confirm = buildLedgers({
    campaigns: confirmCampaigns,
    plannedCells: confirmPlan.manifest.cells,
    planCampaign: confirmPlan,
  })
  const pilot = buildLedgers({
    campaigns: pilotCampaigns,
    plannedCells: pilotPlan.manifest.cells,
    planCampaign: pilotPlan,
  })

  const confirmSummary = summarizeLedger({
    planned: confirm.planned,
    attempts: confirm.attempts,
    cells: confirm.cells,
    campaign: 'e2e-r2-confirm-merged',
    unplannedAttempts: confirm.unplannedAttempts,
  })
  const pilotSummary = summarizeLedger({
    planned: pilot.planned,
    attempts: pilot.attempts,
    cells: pilot.cells,
    campaign: 'e2e-r2-pilot-1',
    unplannedAttempts: pilot.unplannedAttempts,
  })

  const oldIncidentPath = join(R2_OUT, 'live-route-incident.json')
  const oldMergedPath = join(E2E_OUT, 'results-e2e-r2-confirm-merged.json')
  const oldIncident = existsSync(oldIncidentPath) ? readJson(oldIncidentPath) : null
  const oldMerged = existsSync(oldMergedPath) ? readJson(oldMergedPath) : null
  const oldMergedUniqueCells = oldMerged === null
    ? null
    : new Set((oldMerged.results ?? []).map(result => result.cellId)).size

  const t13s1B0r2 = confirm.cells.find(cell => cell.cellId === 'T13-s1-B0-r2')
  const t13s2B0r1 = confirm.cells.find(cell => cell.cellId === 'T13-s2-B0-r1')

  const configMismatch = {
    key: 'rationaleHintTokens',
    declared: confirmPlan.manifest.config.rationaleHintTokens,
    effective: t13s1B0r2?.effectiveConfigSummary?.rationaleHintTokens
      ?? confirm.cells.find(cell => cell.cell.arm === 'E1')?.effectiveConfigSummary?.rationaleHintTokens
      ?? null,
    cells: confirmSummary.configMismatchByKey.rationaleHintTokens ?? 0,
    note: 'eval/e2e/src/host.mjs did not forward rationaleHintTokens; E1 resolved the economy preset value 400. The manifest declared 800.',
  }

  const confirmReconciliation = {
    schemaVersion: 1,
    work: 'EF-R3 WP1',
    generatedAt: new Date().toISOString(),
    campaign: 'e2e-r2-confirm-merged',
    status: 'partial',
    immutableInputs: [
      ...CONFIRM_CAMPAIGNS.flatMap(descriptor => [
        {
          path: `eval/e2e/out/${descriptor.manifestPath.split(/[\\/]/u).pop()}`,
          sha256: sha256File(descriptor.manifestPath),
        },
        {
          path: `eval/e2e/out/${descriptor.resultsPath.split(/[\\/]/u).pop()}`,
          sha256: sha256File(descriptor.resultsPath),
        },
      ]),
      {
        path: 'eval/r2/out/live-route-incident.json',
        sha256: existsSync(oldIncidentPath) ? sha256File(oldIncidentPath) : null,
      },
      {
        path: 'eval/e2e/out/results-e2e-r2-confirm-merged.json',
        sha256: existsSync(oldMergedPath) ? sha256File(oldMergedPath) : null,
      },
    ],
    observed: {
      oldIncident: oldIncident === null ? null : {
        validCells: oldIncident.validCells,
        invalidCells: oldIncident.invalidCells,
        unexecutedCells: oldIncident.unexecutedCells,
        attempts: oldIncident.attempts,
      },
      oldMerged: oldMerged === null ? null : {
        executed: oldMerged.executed,
        planned: oldMerged.planned,
        uniqueCellIds: oldMergedUniqueCells,
        status: oldMerged.status,
        stopReason: oldMerged.stopReason,
      },
    },
    corrected: {
      planned: confirmSummary.planned,
      valid: confirmSummary.valid,
      unresolved: confirmSummary.unresolved,
      neverStarted: confirmSummary.neverStarted,
      noValidOutcome: confirmSummary.noValidOutcome,
      uniqueCellsStarted: confirmSummary.uniqueCellsStarted,
      attempts: confirmSummary.attempts,
      validAttempts: confirmSummary.validAttempts,
      transportFailedAttempts: confirmSummary.transportFailedAttempts,
      byArm: confirmSummary.byArm,
      missingByTemplate: confirmSummary.missingByTemplate,
      costInvalidCells: confirmSummary.costInvalidCells,
      configMismatch,
    },
    corrects: [
      {
        artifact: 'eval/r2/out/live-route-incident.json',
        field: 'invalidCells',
        old: oldIncident?.invalidCells ?? null,
        new: confirmSummary.unresolved,
        reason: 'T13-s1-B0-r2 was transport-failed and then successfully retried on the resume. The failed attempt is not a distinct unresolved cell; only T13-s2-B0-r1 is unresolved.',
      },
      {
        artifact: 'eval/r2/out/live-route-incident.json',
        field: 'unexecutedCells',
        old: oldIncident?.unexecutedCells ?? null,
        new: confirmSummary.neverStarted,
        reason: 'Subtracting both excluded attempts double-counted T13-s1-B0-r2, which is valid in the merged results. The correct never-started count is 30.',
      },
      {
        artifact: 'eval/e2e/out/results-e2e-r2-confirm-merged.json',
        field: 'executed',
        old: oldMerged?.executed ?? null,
        new: confirmSummary.valid,
        reason: 'The old field counted valid cells, not started cells. 24 unique cells were started and 25 attempts were executed; 23 cells are valid.',
      },
    ],
    specificCells: {
      'T13-s1-B0-r2': t13s1B0r2 === undefined ? null : {
        status: t13s1B0r2.status,
        attempts: t13s1B0r2.attempts,
        validAttempts: t13s1B0r2.validAttempts,
        transportFailedAttempts: t13s1B0r2.transportFailedAttempts,
      },
      'T13-s2-B0-r1': t13s2B0r1 === undefined ? null : {
        status: t13s2B0r1.status,
        attempts: t13s2B0r1.attempts,
        validAttempts: t13s2B0r1.validAttempts,
        transportFailedAttempts: t13s2B0r1.transportFailedAttempts,
      },
    },
    note: 'The old artifacts are immutable. This file is the R3 correction and must be cited instead of re-deriving counts from the old incident.',
  }

  const files = {}
  files.attemptLedger = writeJson('attempt-ledger.json', {
    schemaVersion: 1,
    work: 'EF-R3 WP1',
    generatedAt: new Date().toISOString(),
    confirm: {
      campaign: 'e2e-r2-confirm-merged',
      planned: confirm.planned,
      attempts: confirm.attempts,
      observations: confirm.observations,
      summary: confirmSummary,
    },
    pilot: {
      campaign: 'e2e-r2-pilot-1',
      planned: pilot.planned,
      attempts: pilot.attempts,
      observations: pilot.observations,
      summary: pilotSummary,
    },
    note: 'Attempt identity is campaign:cell. A cell may have more than one attempt; only the earliest valid attempt decides its outcome.',
  })
  files.cellLedger = writeJson('cell-ledger.json', {
    schemaVersion: 1,
    work: 'EF-R3 WP1',
    generatedAt: new Date().toISOString(),
    confirm: {
      campaign: 'e2e-r2-confirm-merged',
      planned: confirm.planned,
      cells: confirm.cells,
      summary: confirmSummary,
    },
    pilot: {
      campaign: 'e2e-r2-pilot-1',
      planned: pilot.planned,
      cells: pilot.cells,
      summary: pilotSummary,
    },
    note: 'One row per pre-registered cell. status=valid requires a readable checker result; unresolved means executed with no valid attempt; never-started means no attempt was executed.',
  })
  files.confirmReconciliation = writeJson('live-confirm-reconciliation.json', confirmReconciliation)
  files.liveLedgerSummary = writeJson('live-ledger-summary.json', {
    schemaVersion: 1,
    work: 'EF-R3 WP1',
    generatedAt: new Date().toISOString(),
    confirm: confirmSummary,
    pilot: pilotSummary,
    keyFindings: {
      confirm: {
        planned: 54,
        valid: confirmSummary.valid,
        unresolved: confirmSummary.unresolved,
        neverStarted: confirmSummary.neverStarted,
        noValidOutcome: confirmSummary.noValidOutcome,
        missingByTemplate: confirmSummary.missingByTemplate,
        transportFailedAttempts: confirmSummary.transportFailedAttempts,
        uniqueCellsStarted: confirmSummary.uniqueCellsStarted,
        costInvalidCells: confirmSummary.costInvalidCells.length,
        configMismatchCells: confirmSummary.configMismatchCells.length,
      },
      pilot: {
        planned: 18,
        valid: pilotSummary.valid,
        unresolved: pilotSummary.unresolved,
        neverStarted: pilotSummary.neverStarted,
        transportFailedAttempts: pilotSummary.transportFailedAttempts,
        costInvalidCells: pilotSummary.costInvalidCells.length,
        configMismatchCells: pilotSummary.configMismatchCells.length,
      },
      configMismatch,
    },
    note: 'Pilot and confirm use different instance sets and are not pooled. Counts are derived from immutable manifests/results/reports.',
  })

  process.stdout.write('EF-R3 ledger reconciliation\n')
  process.stdout.write(`  confirm: ${confirmSummary.valid} valid, ${confirmSummary.unresolved} unresolved, ${confirmSummary.neverStarted} never-started, ${confirmSummary.noValidOutcome} no-valid-outcome\n`)
  process.stdout.write(`  confirm attempts: ${confirmSummary.attempts} (${confirmSummary.validAttempts} valid, ${confirmSummary.transportFailedAttempts} transport-failed); unique cells started ${confirmSummary.uniqueCellsStarted}\n`)
  process.stdout.write(`  missing by template: ${JSON.stringify(confirmSummary.missingByTemplate)}\n`)
  process.stdout.write(`  pilot: ${pilotSummary.valid} valid, ${pilotSummary.attempts} attempts, ${pilotSummary.costInvalidCells.length} cost-invalid\n`)
  process.stdout.write(`  config mismatch: E1 rationaleHintTokens declared ${configMismatch.declared}, effective ${configMismatch.effective}, cells ${configMismatch.cells}\n`)
  process.stdout.write(`  wrote ${Object.values(files).map(file => file.path).join(', ')}\n`)
}

main()
