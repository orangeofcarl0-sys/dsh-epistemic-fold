/**
 * EF-R3 — the Attempt ledger and the Unique Cell ledger.
 *
 * EF-R2's merge script treated a transport-failed ATTEMPT as an unfinished
 * CELL. Those are different objects. `T13-s1-B0-r2` failed once and then
 * succeeded on the resume; its cell is valid. `T13-s2-B0-r1` failed and was
 * never retried; its cell is unresolved. A ledger that counts both failed
 * attempts as "unexecuted" subtracts the first cell twice.
 *
 * The two ledgers here make the distinction explicit:
 *
 *   Attempt ledger   every executed try, keyed by (campaign, cell)
 *   Cell ledger      every pre-registered cell, one final state
 *
 * A cell can have many attempts. Only the earliest valid attempt decides its
 * outcome; later valid attempts are sensitivity evidence and never increase the
 * design's sample size.
 *
 * @module eval/r3/ledger
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolveTreatment } from './config-resolve.mjs'

const SHA256_RE = /^[0-9a-f]{64}$/u

export const CELL_STATUSES = ['valid', 'unresolved', 'never-started']
export const ATTEMPT_STATUSES = ['valid', 'transport-failed', 'runner-error']

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The stable identity of a pre-registered cell. */
export function cellKey(cell) {
  return `${cell.task}-${cell.arm}-r${cell.replicate}`
}

/** Parse an existing `T11-s1-E1-r2` identifier when a structured cell is absent. */
export function parseCellId(cellId) {
  const match = /^(?<task>.+)-(?<arm>B0|E0|E1)-r(?<replicate>\d+)$/u.exec(cellId)
  if (match === null) throw new Error(`cannot parse cell id: ${cellId}`)
  return {
    task: match.groups.task,
    arm: match.groups.arm,
    replicate: Number(match.groups.replicate),
  }
}

function sameCell(a, b) {
  return a.task === b.task && a.arm === b.arm && a.replicate === b.replicate
}

/**
 * Classify one executed report on the three independent eligibility axes.
 *
 * `taskOutcomeValid` asks whether the workspace/checker result can be read.
 * `treatmentValid` asks whether the compaction commit/exposure can be read.
 * `costValid` asks whether every model request reported usage. A cell can pass
 * its checker and still have an incomplete cost ledger.
 */
export function classifyReport({ result, report }) {
  if (report === null || report === undefined) {
    return {
      status: 'runner-error',
      taskOutcomeValid: false,
      treatmentValid: false,
      costValid: false,
      pass: result.checker === true,
      checker: result.checker ?? null,
      reasons: ['report-missing'],
      usage: result.usage ?? null,
      witnessSummary: null,
      termination: null,
    }
  }

  const usage = report.usage ?? {}
  const requests = Number(usage.requests ?? 0)
  const unknownUsage = Number(usage.unknownUsage ?? 0)
  const transportFailed = requests > 0 && unknownUsage === requests
  const partialUsage = unknownUsage > 0 && unknownUsage < requests
  const checkerKnown = typeof result.checker === 'boolean'
  const taskOutcomeValid = !transportFailed && checkerKnown && requests > 0
  const treatmentValid = taskOutcomeValid
    && Array.isArray(report.witnesses)
    && report.witnessSummary !== undefined
  const costValid = taskOutcomeValid && unknownUsage === 0

  const reasons = []
  if (transportFailed) reasons.push('provider-transport')
  if (partialUsage) reasons.push('partial-usage')
  if (!checkerKnown) reasons.push('checker-missing')
  if (requests === 0) reasons.push('no-requests')
  if (taskOutcomeValid && !treatmentValid) reasons.push('witness-missing')

  return {
    status: transportFailed ? 'transport-failed' : taskOutcomeValid ? 'valid' : 'runner-error',
    taskOutcomeValid,
    treatmentValid,
    costValid,
    pass: result.checker === true,
    checker: result.checker ?? null,
    reasons,
    usage: {
      requests,
      unknownUsage,
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
      auxiliaryRequests: Number(usage.auxiliary?.requests ?? 0),
    },
    witnessSummary: report.witnessSummary ?? null,
    termination: report.termination ?? null,
    reportPath: result.reportPath ?? null,
  }
}

/**
 * Build one attempt from one executed result.
 *
 * `campaignIndex` is the pre-registered campaign order. It is the ONLY input to
 * the "earliest valid attempt wins" rule; wall-clock time is not used, because a
 * resume can execute later in a different order.
 */
export function attemptFromResult({
  campaign,
  campaignIndex,
  manifest,
  manifestSha,
  result,
  sequence,
}) {
  const cell = result.cell ?? parseCellId(result.cellId)
  const cellId = cellKey(cell)
  const reportPath = result.reportPath ?? null
  const report = reportPath !== null && existsSync(reportPath)
    ? readJson(reportPath)
    : null
  const classification = classifyReport({ result, report })
  const treatment = resolveTreatment({ arm: cell.arm, manifestConfig: manifest.config })

  return {
    attemptId: `${campaign}:${cellId}`,
    campaign,
    campaignIndex,
    sequence,
    manifestSha,
    cell,
    cellKey: cellId,
    status: classification.status,
    taskOutcomeValid: classification.taskOutcomeValid,
    treatmentValid: classification.treatmentValid,
    costValid: classification.costValid,
    pass: classification.pass,
    checker: classification.checker,
    reasons: classification.reasons,
    usage: classification.usage,
    witnessSummary: classification.witnessSummary,
    termination: classification.termination,
    reportPath,
    treatment,
  }
}

/**
 * Build both ledgers from already-loaded campaign descriptors.
 *
 * A descriptor is:
 *   { campaign, campaignIndex, manifest, manifestSha, results }
 *
 * The function is pure apart from reading each result's report. It does not
 * write anything and does not modify the inputs.
 */
export function buildLedgers({ campaigns, plannedCells, planCampaign }) {
  const attempts = []
  const observations = []
  let sequence = 0

  for (const entry of campaigns) {
    const manifestSha = entry.manifestSha ?? entry.results.manifestSha256
    if (entry.manifestPath !== undefined) {
      const actual = sha256File(entry.manifestPath)
      if (actual !== entry.results.manifestSha256) {
        throw new Error(
          `${entry.campaign}: manifest hash ${actual} does not match results ${entry.results.manifestSha256}`,
        )
      }
    }
    if (manifestSha !== undefined && !SHA256_RE.test(manifestSha)) {
      throw new Error(`${entry.campaign}: invalid manifest SHA-256 ${manifestSha}`)
    }

    for (const result of entry.results.results ?? []) {
      const cell = result.cell ?? parseCellId(result.cellId)
      const cellId = cellKey(cell)
      if (result.status !== 'executed') {
        observations.push({
          campaign: entry.campaign,
          campaignIndex: entry.campaignIndex,
          cell,
          cellId,
          status: result.status,
        })
        continue
      }
      sequence += 1
      attempts.push(attemptFromResult({
        campaign: entry.campaign,
        campaignIndex: entry.campaignIndex,
        manifest: entry.manifest,
        manifestSha,
        result,
        sequence,
      }))
    }
  }

  const planned = plannedCells.map(cell => ({ ...cell, cellId: cellKey(cell) }))
  const cells = planned.map(cell => {
    const key = cellKey(cell)
    const forCell = attempts
      .filter(attempt => attempt.cellKey === key)
      .sort((a, b) => a.campaignIndex - b.campaignIndex || a.sequence - b.sequence)
    const valid = forCell.filter(attempt => attempt.status === 'valid')
    const chosen = valid[0] ?? null
    const first = forCell[0] ?? null
    const treatment = chosen?.treatment ?? first?.treatment ?? resolveTreatment({
      arm: cell.arm,
      manifestConfig: planCampaign.manifest.config,
    })
    const status = chosen !== null
      ? 'valid'
      : forCell.length > 0 ? 'unresolved' : 'never-started'
    const notExecutedIn = observations
      .filter(observation => observation.cellId === key)
      .map(observation => observation.campaign)

    return {
      cellId: key,
      cell,
      task: cell.task,
      arm: cell.arm,
      replicate: cell.replicate,
      status,
      pass: chosen?.pass ?? null,
      checker: chosen?.checker ?? null,
      taskOutcomeValid: chosen?.taskOutcomeValid ?? false,
      treatmentValid: chosen?.treatmentValid ?? false,
      costValid: chosen?.costValid ?? false,
      reasons: chosen?.reasons ?? forCell.flatMap(attempt => attempt.reasons),
      attempts: forCell.map(attempt => attempt.attemptId),
      validAttempts: valid.map(attempt => attempt.attemptId),
      sensitivityAttempts: valid.slice(1).map(attempt => attempt.attemptId),
      transportFailedAttempts: forCell
        .filter(attempt => attempt.status === 'transport-failed')
        .map(attempt => attempt.attemptId),
      notExecutedIn,
      reportPath: chosen?.reportPath ?? null,
      usage: chosen?.usage ?? null,
      witnessSummary: chosen?.witnessSummary ?? null,
      termination: chosen?.termination ?? null,
      treatmentId: treatment.treatmentId,
      configDigest: treatment.configDigest,
      configMismatch: treatment.configMismatch,
      inertKeys: treatment.inertKeys ?? [],
      configSource: chosen !== null ? 'executed' : first !== null ? 'attempt' : 'planned',
      effectiveConfigSummary: treatment.effectiveConfigSummary,
      declaredConfigSummary: treatment.declaredConfigSummary,
    }
  })

  const plannedKeys = new Set(planned.map(cell => cell.cellId))
  const unplannedAttempts = attempts
    .filter(attempt => !plannedKeys.has(attempt.cellKey))
    .map(attempt => attempt.attemptId)

  return { planned, attempts, observations, cells, unplannedAttempts }
}

/** Aggregate the cell ledger. No unknown is counted as a pass. */
export function summarizeLedger({ planned, attempts, cells, campaign, unplannedAttempts = [] }) {
  const byStatus = Object.fromEntries(CELL_STATUSES.map(status => [
    status,
    cells.filter(cell => cell.status === status).length,
  ]))
  const byAttemptStatus = Object.fromEntries(ATTEMPT_STATUSES.map(status => [
    status,
    attempts.filter(attempt => attempt.status === status).length,
  ]))
  const valid = cells.filter(cell => cell.status === 'valid')
  const unresolved = cells.filter(cell => cell.status === 'unresolved')
  const neverStarted = cells.filter(cell => cell.status === 'never-started')
  const started = cells.filter(cell => cell.attempts.length > 0)

  const arms = [...new Set(planned.map(cell => cell.arm))].sort()
  const byArm = Object.fromEntries(arms.map(arm => {
    const armCells = cells.filter(cell => cell.cell.arm === arm)
    const armValid = armCells.filter(cell => cell.status === 'valid')
    return [arm, {
      planned: armCells.length,
      valid: armValid.length,
      passed: armValid.filter(cell => cell.pass).length,
      unresolved: armCells.filter(cell => cell.status === 'unresolved').length,
      neverStarted: armCells.filter(cell => cell.status === 'never-started').length,
      costValid: armValid.filter(cell => cell.costValid).length,
      costInvalid: armValid.filter(cell => !cell.costValid).length,
      cellsWithCommit: armValid.filter(cell => (cell.witnessSummary?.committed ?? 0) > 0).length,
      cellsWithDelivery: armValid
        .filter(cell => (cell.witnessSummary?.committedAndDelivered ?? 0) > 0).length,
      configMismatchCells: armCells.filter(cell => cell.configMismatch.length > 0).length,
    }]
  }))

  const templates = [...new Set(planned.map(cell => cell.task.replace(/-s\d+$/u, '')))].sort()
  const missingByTemplate = Object.fromEntries(templates.map(template => [
    template,
    cells.filter(cell => cell.task.replace(/-s\d+$/u, '') === template && cell.status !== 'valid').length,
  ]))

  const configMismatchKeys = {}
  for (const cell of cells) {
    for (const mismatch of cell.configMismatch) {
      configMismatchKeys[mismatch.key] = (configMismatchKeys[mismatch.key] ?? 0) + 1
    }
  }

  return {
    campaign,
    planned: planned.length,
    valid: byStatus.valid,
    unresolved: byStatus.unresolved,
    neverStarted: byStatus['never-started'],
    noValidOutcome: byStatus.unresolved + byStatus['never-started'],
    uniqueCellsStarted: started.length,
    attempts: attempts.length,
    unplannedAttempts,
    validAttempts: byAttemptStatus.valid,
    transportFailedAttempts: byAttemptStatus['transport-failed'],
    runnerErrorAttempts: byAttemptStatus['runner-error'],
    costInvalidCells: valid
      .filter(cell => !cell.costValid)
      .map(cell => ({
        cellId: cell.cellId,
        usage: cell.usage,
        reasons: cell.reasons,
      })),
    configMismatchCells: cells
      .filter(cell => cell.configMismatch.length > 0)
      .map(cell => ({ cellId: cell.cellId, mismatch: cell.configMismatch })),
    configMismatchByKey: configMismatchKeys,
    byArm,
    missingByTemplate,
    cells: byStatus,
    missingCellIds: cells.filter(cell => cell.status !== 'valid').map(cell => cell.cellId),
    note: 'A transport-failed attempt is not an arm outcome. A cell is valid only when at least one attempt produced a readable checker result; cost validity is a separate axis.',
  }
}
