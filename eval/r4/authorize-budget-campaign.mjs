#!/usr/bin/env node
/**
 * EF-R4 — grant the 36-cell budget-sensitivity campaign.
 *
 * Refuses unless the frozen manifest is ready, the authorization template is
 * still ungranted and bound to the current manifest SHA, and the representative
 * health probe has passed (a latency caveat is allowed and stays recorded).
 *
 *   node eval/r4/authorize-budget-campaign.mjs
 *
 * @module eval/r4/authorize-budget-campaign
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(ROOT, 'eval', 'r4', 'out')
const CAMPAIGN = process.env.EF_R4_CAMPAIGN ?? 'e2e-r4-budget-sensitivity-1'
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const manifestPath = join(E2E_OUT, `manifest-${CAMPAIGN}.json`)
const authorizationPath = join(E2E_OUT, `authorization-${CAMPAIGN}.json`)
const preflightPath = join(OUT, 'budget-manifest-preflight.json')
const probePath = join(OUT, 'health-probe-results.json')
for (const path of [manifestPath, authorizationPath, preflightPath, probePath]) {
  if (!existsSync(path)) {
    process.stderr.write(`authorize-budget-campaign: ${path} is missing\n`)
    process.exit(2)
  }
}
const manifest = readJson(manifestPath)
const authorization = readJson(authorizationPath)
const preflight = readJson(preflightPath)
const probe = readJson(probePath)
const manifestSha256 = sha256(manifestPath)

if (manifest.executionAuthorized !== false) {
  process.stderr.write('authorize-budget-campaign: manifest is already marked authorized\n')
  process.exit(2)
}
if (authorization.granted !== false) {
  process.stderr.write('authorize-budget-campaign: authorization is already granted\n')
  process.exit(2)
}
if (authorization.manifestSha256 !== manifestSha256) {
  process.stderr.write(`authorize-budget-campaign: authorization names ${authorization.manifestSha256}, manifest is ${manifestSha256}\n`)
  process.exit(2)
}
if (preflight.verdict !== 'ready-for-authorization') {
  process.stderr.write(`authorize-budget-campaign: preflight is ${preflight.verdict}\n`)
  process.exit(2)
}
if (probe.verdict !== 'pass' && probe.verdict !== 'pass-with-latency-caveat') {
  process.stderr.write(`authorize-budget-campaign: health probe is ${probe.verdict}; do not run the campaign\n`)
  process.exit(2)
}

authorization.granted = true
authorization.grantedAt = new Date().toISOString()
authorization.grantedBy = 'user instruction: "均授权，继续" (2026-11-14)'
authorization.basis = 'The user authorized the representative health probe and the 36-cell step-budget sensitivity campaign. The health probe passed; the campaign preflight is ready.'
authorization.healthProbe = {
  path: 'eval/r4/out/health-probe-results.json',
  sha256: sha256(probePath),
  verdict: probe.verdict,
  p95DurationMs: probe.latency?.p95 ?? null,
}
authorization.preflight = { path: 'eval/r4/out/budget-manifest-preflight.json', sha256: sha256(preflightPath), verdict: preflight.verdict }
authorization.note = 'This grant is bound to the manifest SHA-256 above and the listed envelope. A changed manifest needs a new grant.'

writeFileSync(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`, 'utf8')
process.stdout.write(`campaign authorization: granted; manifest ${manifestSha256.slice(0, 12)}…; probe ${probe.verdict}; 36 cells\n`)
process.stdout.write(`wrote ${authorizationPath}\n`)
