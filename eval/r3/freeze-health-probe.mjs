#!/usr/bin/env node
/**
 * EF-R3 WP3 — freeze the transport health-probe DESIGN (not an execution).
 *
 * The R2 failures were long summary/primary requests. A short "hello" probe
 * would not exercise the payload shape that failed. This design replays the
 * T13 task seed through the normal summary and primary paths, plus a larger
 * summary profile derived from the archived successful range.
 *
 * `executionAuthorized` is false. Running it needs a new manifest hash and a
 * new explicit grant; unused R2 envelope capacity is not permission.
 *
 *   node eval/r3/freeze-health-probe.mjs
 *
 * @module eval/r3/freeze-health-probe
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const diagnosisPath = join(OUT, 'transport-diagnosis.json')
if (!existsSync(diagnosisPath)) {
  process.stderr.write('freeze-health-probe: run eval/r3/transport-diagnose.mjs first\n')
  process.exit(2)
}
const diagnosis = readJson(diagnosisPath)
const tasksPath = join(ROOT, 'eval', 'e2e', 'tasks-r2', 'T13-s1.json')
const tasks = existsSync(tasksPath) ? readJson(tasksPath) : null

const failedSummarySizes = diagnosis.failures
  .flatMap(failure => failure.requests)
  .filter(request => request.purpose === 'summary')
  .map(request => request.messageChars)
const failedPrimarySizes = diagnosis.failures
  .flatMap(failure => failure.requests)
  .filter(request => request.purpose === 'primary')
  .map(request => request.messageChars)
const successfulSummaryMax = diagnosis.b0Baseline.summaryMessageChars.max

const payloadProfiles = [
  {
    id: 't13-summary-failed-shape',
    purpose: 'summary',
    taskInstance: 'T13-s1',
    messageChars: failedSummarySizes[0] ?? 75_603,
    maxMessageChars: 73_468,
    why: 'The exact summary shape of the first transport-failed T13 cell. It is not a short prompt.',
  },
  {
    id: 't13-summary-failed-shape-s2',
    purpose: 'summary',
    taskInstance: 'T13-s2',
    messageChars: failedSummarySizes[1] ?? failedSummarySizes[0] ?? 75_608,
    maxMessageChars: 73_473,
    why: 'The second failed T13 cell used the same 73k-character tool result and a 1.8k-character summary instruction.',
  },
  {
    id: 't13-primary-failed-shape',
    purpose: 'primary',
    taskInstance: 'T13-s1',
    messageChars: failedPrimarySizes[0] ?? 76_000,
    maxMessageChars: 73_468,
    why: 'The primary request carries the same long history; the failure was not confined to the auxiliary call.',
  },
  {
    id: 'summary-successful-upper-range',
    purpose: 'summary',
    taskInstance: 'T13-s1',
    messageChars: successfulSummaryMax ?? 149_073,
    maxMessageChars: successfulSummaryMax ?? 149_073,
    why: 'The largest successful B0 summary in the archive. It covers the payload range above the failed requests.',
  },
]

const attemptsPerProfile = 4
const totalRequests = payloadProfiles.length * attemptsPerProfile
const design = {
  schemaVersion: 1,
  work: 'EF-R3 WP3',
  probeId: 'r3-transport-health-1',
  generatedAt: new Date().toISOString(),
  status: 'design-frozen',
  executionAuthorized: false,
  authorizationState: 'not-requested',
  model: 'deepseek-v4.1-flash',
  route: {
    source: 'zcode config local proxy',
    baseUrlFrom: 'resolved-at-run',
    note: 'Resolve the route at execution time; do not hard-code the proxy port into a committed manifest.',
  },
  why: 'A short health check cannot exercise the long summary/primary payload that failed. These profiles replay the T13 shape and the successful upper range.',
  payloadProfiles,
  attemptsPerProfile,
  totalRequests,
  acceptance: {
    httpSuccess: `${totalRequests}/${totalRequests}`,
    usagePresent: `${totalRequests}/${totalRequests}`,
    transportErrors: 0,
    nullUsage: 0,
    p95DurationMsMax: 60_000,
    modelMustMatch: 'deepseek-v4.1-flash',
  },
  stopConditions: [
    'Any LIVE_TRANSPORT or ECONNRESET/UND_ERR_SOCKET stops the probe immediately.',
    'Any response without usage stops the probe immediately.',
    'Any HTTP status outside 200 stops the probe immediately.',
    'No automatic retry after a transport failure.',
    'A failed probe does not authorize the confirm completion.',
  ],
  envelope: {
    requests: totalRequests,
    inputTokens: 2_000_000,
    outputTokens: 100_000,
    wallClockMs: 30 * 60 * 1000,
    paidConcurrency: 1,
    monetaryUsd: null,
    monetaryNote: 'No verifiable per-token price is recorded.',
  },
  inputs: {
    diagnosis: { path: 'eval/r3/out/transport-diagnosis.json', sha256: sha256(diagnosisPath) },
    task: { path: 'eval/e2e/tasks-r2/T13-s1.json', sha256: existsSync(tasksPath) ? sha256(tasksPath) : null },
    r2ConfirmManifest: existsSync(join(E2E_OUT, 'manifest-e2e-r2-confirm-1.json'))
      ? { path: 'eval/e2e/out/manifest-e2e-r2-confirm-1.json', sha256: sha256(join(E2E_OUT, 'manifest-e2e-r2-confirm-1.json')) }
      : null,
  },
  decision: 'Do not run the confirm completion until this probe passes under a new authorization. If it fails, keep the confirm partial and stop consuming; do not retry indefinitely.',
  limits: [
    'The probe is model calls, so it requires a new explicit grant and budget.',
    'It measures route stability for these payload shapes, not task quality.',
    'The probe does not pool with the pilot or confirm and does not change either ledger.',
  ],
  taskAvailable: tasks !== null,
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'transport-health-probe.json')
writeFileSync(path, `${JSON.stringify(design, null, 2)}\n`, 'utf8')
process.stdout.write(`health probe design: ${totalRequests} requests across ${payloadProfiles.length} profiles; executionAuthorized=${design.executionAuthorized}\n`)
process.stdout.write(`profiles: ${payloadProfiles.map(profile => `${profile.id}=${profile.messageChars}ch`).join(', ')}\n`)
process.stdout.write(`wrote ${path}\n`)
