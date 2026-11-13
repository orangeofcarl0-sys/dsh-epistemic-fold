#!/usr/bin/env node
/**
 * EF-R2 — merge the valid confirm cells after a provider transport failure.
 *
 * The confirm ran 21/54 and stopped when the local route reset a socket; the
 * resume ran 4/34 and stopped the same way. This script keeps the cells that
 * reported usage, drops the transport-failed cells, and records the route
 * incident. The result is explicitly PARTIAL: it is not a 54-cell confirm and
 * must not be reported as one.
 *
 * ## Superseded count (EF-R3)
 *
 * The original `unexecutedCells` formula subtracted `excluded.length`, but an
 * excluded ATTEMPT and an unresolved CELL are different objects. `T13-s1-B0-r2`
 * failed once and then succeeded on the resume, so it is in both `byCell` and
 * `excluded`; subtracting both counted it twice. The corrected arithmetic is
 * `54 - valid - unresolvedCells`, where `unresolvedCells` contains only excluded
 * cells that never produced a valid result. The historical artifact is
 * immutable; the authoritative correction is
 * `eval/r3/out/live-confirm-reconciliation.json`.
 *
 *   node eval/r2/merge-confirm.mjs
 *
 * @module eval/r2/merge-confirm
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const ATTEMPTS = ['e2e-r2-confirm-1', 'e2e-r2-confirm-resume-1']
const loaded = []
for (const campaign of ATTEMPTS) {
  const resultsPath = join(E2E_OUT, `results-${campaign}.json`)
  if (!existsSync(resultsPath)) {
    process.stderr.write(`merge-confirm: ${resultsPath} is missing\n`)
    process.exit(2)
  }
  loaded.push({ campaign, results: readJson(resultsPath), sha256: sha256(resultsPath) })
}

const byCell = new Map()
const incident = []
const excluded = []
for (const { campaign, results } of loaded) {
  const attempt = {
    campaign,
    status: results.status,
    stopReason: results.stopReason,
    planned: results.planned,
    executed: results.executed,
    used: results.budget?.used ?? null,
    transportFailures: [],
    valid: 0,
  }
  for (const result of results.results ?? []) {
    if (result.status !== 'executed') continue
    const report = existsSync(result.reportPath) ? readJson(result.reportPath) : null
    if (report === null) continue
    const usage = report.usage
    const transportFailed = usage.requests > 0 && usage.unknownUsage === usage.requests
    const failures = (report.requests ?? [])
      .filter(request => request.finish?.kind === 'error')
      .map(request => ({
        index: request.index,
        purpose: request.purpose,
        code: request.finish.failure?.code ?? null,
        message: request.finish.failure?.message ?? null,
      }))
    if (transportFailed) {
      attempt.transportFailures.push({ cellId: result.cellId, failures })
      excluded.push({ campaign, cellId: result.cellId, reason: 'provider-transport', failures })
      continue
    }
    attempt.valid += 1
    // The resume wins for a re-run cell; later attempts overwrite.
    byCell.set(result.cellId, {
      ...result,
      campaign,
      // Provenance for the merged row.
      mergedFrom: campaign,
    })
  }
  incident.push(attempt)
}

const merged = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  campaign: 'e2e-r2-confirm-merged',
  status: 'partial',
  stopReason: 'provider-transport-instability',
  planned: 54,
  executed: byCell.size,
  budget: {
    used: {
      requests: loaded.reduce((sum, entry) => sum + (entry.results.budget?.used?.requests ?? 0), 0),
      inputTokens: loaded.reduce((sum, entry) => sum + (entry.results.budget?.used?.inputTokens ?? 0), 0),
      outputTokens: loaded.reduce((sum, entry) => sum + (entry.results.budget?.used?.outputTokens ?? 0), 0),
      wallClockMs: loaded.reduce((sum, entry) => sum + (entry.results.budget?.used?.wallClockMs ?? 0), 0),
    },
    limits: loaded[0].results.budget?.limits ?? null,
  },
  route: loaded[0].results.route ?? null,
  model: loaded[0].results.model ?? null,
  results: [...byCell.values()],
  provenance: {
    attempts: loaded.map(entry => ({
      campaign: entry.campaign,
      results: `eval/e2e/out/results-${entry.campaign}.json`,
      resultsSha256: entry.sha256,
      status: entry.results.status,
      stopReason: entry.results.stopReason,
      planned: entry.results.planned,
      executed: entry.results.executed,
      used: entry.results.budget?.used ?? null,
    })),
    incident,
    excluded,
    note: 'Transport-failed cells are excluded; valid cells from both attempts are merged by cellId, with the resume winning a re-run. 23 of 54 cells are valid; this is not a confirmatory result.',
  },
}
const mergedPath = join(E2E_OUT, 'results-e2e-r2-confirm-merged.json')
writeFileSync(mergedPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

// An excluded attempt is not an unresolved cell. Only an excluded cell that
// never produced a valid result belongs in the unresolved count.
const unresolvedCellIds = new Set(
  excluded.filter(entry => !byCell.has(entry.cellId)).map(entry => entry.cellId),
)
const unexecutedCells = 54 - byCell.size - unresolvedCellIds.size

const incidentDoc = {
  schemaVersion: 1,
  work: 'EF-R2 live',
  generatedAt: new Date().toISOString(),
  campaign: 'e2e-r2-confirm-merged',
  planned: 54,
  validCells: byCell.size,
  invalidCells: unresolvedCellIds.size,
  unresolvedCells: [...unresolvedCellIds],
  unexecutedCells,
  noValidOutcomeCells: 54 - byCell.size,
  attempts: incident,
  excluded,
  route: merged.route,
  diagnosis: 'The local provider route reset sockets (ECONNRESET / UND_ERR_SOCKET / LIVE_TRANSPORT) on every request in two cells. The runner stopped on provider-usage-missing. The transport-failed cells are not arm outcomes.',
  decision: 'No further live calls until the route is stable. The confirm is partial and is not pooled with the pilot as a powered estimate.',
  envelope: {
    pilot: { cells: 18, used: { requests: 173, inputTokens: 2364910, outputTokens: 62224 } },
    confirmAttempt1: incident[0]?.used ?? null,
    confirmResume: incident[1]?.used ?? null,
  },
}
writeFileSync(join(OUT, 'live-route-incident.json'), `${JSON.stringify(incidentDoc, null, 2)}\n`, 'utf8')

process.stdout.write(`merged confirm: ${byCell.size} valid cells, ${excluded.length} transport-failed, ${54 - byCell.size - excluded.length} unexecuted\n`)
for (const attempt of incident) {
  process.stdout.write(`  ${attempt.campaign}: ${attempt.executed}/${attempt.planned} executed, ${attempt.valid} valid, ${attempt.transportFailures.length} transport failure(s), stop ${attempt.stopReason}\n`)
}
process.stdout.write(`merged ${mergedPath}\n`)
