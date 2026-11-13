#!/usr/bin/env node
/**
 * EF-R4 — record a live attempt without starting another one.
 *
 * The health probe is the gate for the 36-cell campaign. If it fails, the
 * campaign must not start. This artifact preserves the failure, the route and
 * the fact that the campaign was not executed.
 *
 *   node eval/r4/record-live-attempt.mjs
 *
 * @module eval/r4/record-live-attempt
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const CAMPAIGN = 'e2e-r4-budget-sensitivity-1'
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const resultsPath = join(OUT, 'health-probe-results.json')
const designPath = join(OUT, 'transport-health-probe.json')
const authorizationPath = join(OUT, 'health-probe-authorization.json')
const manifestPath = join(E2E_OUT, `manifest-${CAMPAIGN}.json`)
const campaignAuthorizationPath = join(E2E_OUT, `authorization-${CAMPAIGN}.json`)
for (const path of [resultsPath, designPath, authorizationPath, manifestPath, campaignAuthorizationPath]) {
  if (!existsSync(path)) {
    process.stderr.write(`record-live-attempt: ${path} is missing\n`)
    process.exit(2)
  }
}
const results = readJson(resultsPath)
const design = readJson(designPath)
const authorization = readJson(authorizationPath)
const manifest = readJson(manifestPath)
const campaignAuthorization = readJson(campaignAuthorizationPath)

const firstFailure = results.results?.find(entry => entry.usage === null
  || entry.error !== null
  || (entry.finish?.kind !== 'stop' && entry.finish?.kind !== 'max-tokens')) ?? null
const routeUnreachable = firstFailure?.finish?.failure?.message?.includes('ECONNREFUSED') === true
  || firstFailure?.diagnostics?.some(entry => entry.error?.message?.includes('ECONNREFUSED')) === true

const attempt = {
  schemaVersion: 1,
  work: 'EF-R4 live attempt 1',
  generatedAt: new Date().toISOString(),
  attempt: 1,
  date: '2026-11-14',
  probe: {
    design: { path: 'eval/r4/out/transport-health-probe.json', sha256: sha256(designPath) },
    authorization: {
      path: 'eval/r4/out/health-probe-authorization.json',
      sha256: sha256(authorizationPath),
      grantedBy: authorization.grantedBy,
    },
    verdict: results.verdict,
    planned: results.planned,
    attempted: results.attempted,
    successes: results.successes,
    failures: results.failures,
    firstFailure,
    route: results.route,
  },
  campaign: {
    campaign: CAMPAIGN,
    manifest: { path: `eval/e2e/out/manifest-${CAMPAIGN}.json`, sha256: sha256(manifestPath) },
    authorization: {
      path: `eval/e2e/out/authorization-${CAMPAIGN}.json`,
      sha256: sha256(campaignAuthorizationPath),
      granted: campaignAuthorization.granted,
    },
    started: false,
    reason: 'health-probe-failed',
  },
  providerCalls: 0,
  httpAttempts: results.attempted ?? 0,
  modelResponses: results.successes ?? 0,
  decision: routeUnreachable ? 'blocked-route-unreachable' : 'blocked-health-probe',
  next: routeUnreachable
    ? 'Restore the local proxy at the configured base URL, then re-freeze the manifest and retry the probe. No automatic retry.'
    : 'Do not run the campaign. A new explicit authorization is required for another probe.',
  note: 'The probe stopped on the first transport failure. The 36-cell campaign was not started. No retry was made.',
}

const path = join(OUT, 'live-attempt-r4-1.json')
writeFileSync(path, `${JSON.stringify(attempt, null, 2)}\n`, 'utf8')
process.stdout.write(`live attempt: ${attempt.decision}; probe ${results.successes}/${results.planned}; campaign started=${attempt.campaign.started}\n`)
process.stdout.write(`wrote ${path}\n`)
