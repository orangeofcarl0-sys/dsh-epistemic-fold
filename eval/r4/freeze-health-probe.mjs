#!/usr/bin/env node
/**
 * EF-R4 — freeze the transport health-probe design for the budget campaign.
 *
 * The probe is the same representative long-payload shape used in R3: four
 * profiles, four attempts each, 16 requests. It is not a "hello" check. The
 * design itself stays `executionAuthorized:false`; a separate authorization
 * file is the grant.
 *
 *   node eval/r4/freeze-health-probe.mjs
 *
 * Zero provider calls.
 *
 * @module eval/r4/freeze-health-probe
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const CAMPAIGN = 'e2e-r4-budget-sensitivity-1'
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const manifestPath = join(E2E_OUT, `manifest-${CAMPAIGN}.json`)
const r3DesignPath = join(ROOT, 'eval', 'r3', 'out', 'transport-health-probe.json')
const taskPath = join(ROOT, 'eval', 'e2e', 'tasks-r2', 'T13-s1.json')
for (const path of [manifestPath, r3DesignPath, taskPath]) {
  if (!existsSync(path)) {
    process.stderr.write(`freeze-health-probe: ${path} is missing\n`)
    process.exit(2)
  }
}
const manifest = readJson(manifestPath)
const r3Design = readJson(r3DesignPath)

const payloadProfiles = (r3Design.payloadProfiles ?? []).map(profile => ({ ...profile }))
if (payloadProfiles.length !== 4) {
  process.stderr.write(`freeze-health-probe: expected 4 profiles, got ${payloadProfiles.length}\n`)
  process.exit(2)
}
const attemptsPerProfile = 4
const totalRequests = payloadProfiles.length * attemptsPerProfile

const design = {
  schemaVersion: 1,
  work: 'EF-R4 transport health probe',
  probeId: 'r4-transport-health-1',
  campaign: CAMPAIGN,
  generatedAt: new Date().toISOString(),
  status: 'design-frozen',
  executionAuthorized: false,
  authorizationState: 'not-requested',
  model: manifest.model,
  route: {
    source: 'resolved-at-run',
    baseUrlFrom: 'resolved-at-run',
    note: 'Resolve the live route at execution time; do not hard-code a proxy port into a committed artifact.',
  },
  why: 'The R3 route failure was on long summary/primary payloads. This probe replays that shape and the successful upper range before the 36-cell campaign.',
  payloadProfiles,
  attemptsPerProfile,
  totalRequests,
  acceptance: {
    httpSuccess: `${totalRequests}/${totalRequests}`,
    usagePresent: `${totalRequests}/${totalRequests}`,
    transportErrors: 0,
    nullUsage: 0,
    p95DurationMsMax: 60_000,
    modelMustMatch: manifest.model,
  },
  stopConditions: [
    'Any LIVE_TRANSPORT or ECONNRESET/UND_ERR_SOCKET stops the probe immediately.',
    'Any response without usage stops the probe immediately.',
    'Any HTTP status outside 200 stops the probe immediately.',
    'No automatic retry after a transport failure.',
    'A failed probe does not authorize the 36-cell campaign.',
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
    campaignManifest: { path: `eval/e2e/out/manifest-${CAMPAIGN}.json`, sha256: sha256(manifestPath) },
    r3Design: { path: 'eval/r3/out/transport-health-probe.json', sha256: sha256(r3DesignPath) },
    task: { path: 'eval/e2e/tasks-r2/T13-s1.json', sha256: sha256(taskPath) },
  },
  decision: 'The 36-cell campaign may start only after this probe passes (transport/usage) under a separate grant. A latency caveat is recorded, not hidden.',
  limits: [
    'The probe is model calls and requires the explicit grant in health-probe-authorization.json.',
    'It measures route stability for these payload shapes, not task quality.',
    'It does not pool with R3 and does not change the R3 ledger.',
  ],
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'transport-health-probe.json')
writeFileSync(path, `${JSON.stringify(design, null, 2)}\n`, 'utf8')
process.stdout.write(`health probe design: ${totalRequests} requests; campaign ${CAMPAIGN}; manifest ${sha256(manifestPath).slice(0, 12)}…\n`)
process.stdout.write(`wrote ${path}\n`)
