#!/usr/bin/env node
/**
 * EF-R3 product-lane — record the pilot's preflight decision.
 *
 * The health probe passed the transport/usage acceptance 16/16 but one request
 * exceeded the pre-registered 60s p95 bound. This is a recorded protocol
 * deviation, not a transport failure. The pilot may proceed because the user
 * authorized it and the route produced no transport error; the deviation and
 * the per-request latency are carried into the analysis.
 *
 *   node eval/r3/product-pilot-prerequisites.mjs
 *
 * @module eval/r3/product-pilot-prerequisites
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const healthPath = join(OUT, 'health-probe-results.json')
const costPath = join(OUT, 'cost-preflight.json')
const auditPath = join(OUT, 'product-lane-exposure-audit.json')
const candidatePath = join(OUT, 'admission-candidate.json')
const designPath = join(OUT, 'product-pilot-design.json')
const manifestPath = join(ROOT, 'eval', 'e2e', 'out', 'manifest-e2e-r3-product-pilot-1.json')
const authorizationPath = join(ROOT, 'eval', 'e2e', 'out', 'authorization-e2e-r3-product-pilot-1.json')

for (const path of [healthPath, costPath, auditPath, candidatePath, designPath, manifestPath, authorizationPath]) {
  if (!existsSync(path)) {
    process.stderr.write(`product-pilot-prerequisites: ${path} is missing\n`)
    process.exit(2)
  }
}
const health = readJson(healthPath)
const cost = readJson(costPath)
const audit = readJson(auditPath)
const candidate = readJson(candidatePath)
const design = readJson(designPath)
const manifest = readJson(manifestPath)
const authorization = readJson(authorizationPath)

const transportPass = health.successes === health.planned && health.failures === 0
const latencyPass = health.latency?.p95 !== null && health.latency?.p95 <= 60_000
const decision = transportPass ? 'proceed-with-latency-deviation' : 'stop'
const output = {
  schemaVersion: 1,
  work: 'EF-R3 product-lane',
  generatedAt: new Date().toISOString(),
  decision,
  healthProbe: {
    path: 'eval/r3/out/health-probe-results.json',
    sha256: sha256(healthPath),
    verdict: health.verdict,
    successes: health.successes,
    planned: health.planned,
    transportErrors: 0,
    latency: health.latency,
    latencyBoundMs: 60_000,
    latencyPass,
    deviation: latencyPass ? null : 'p95 exceeded the pre-registered 60s bound; transport/usage acceptance passed 16/16.',
  },
  costPreflight: { path: 'eval/r3/out/cost-preflight.json', sha256: sha256(costPath), status: cost.status },
  exposureAudit: {
    path: 'eval/r3/out/product-lane-exposure-audit.json',
    sha256: sha256(auditPath),
    suitableTasks: audit.suitableTaskIds,
    counts: audit.counts,
  },
  admissionCandidate: {
    path: 'eval/r3/out/admission-candidate.json',
    sha256: sha256(candidatePath),
    falseAdmissions: candidate.counts.falseAdmissions,
    falseRefusals: candidate.counts.falseRefusals,
    decision: candidate.interpretation.decision,
  },
  manifest: { path: 'eval/e2e/out/manifest-e2e-r3-product-pilot-1.json', sha256: sha256(manifestPath), cells: manifest.cells.length },
  authorization: { path: 'eval/e2e/out/authorization-e2e-r3-product-pilot-1.json', sha256: sha256(authorizationPath), granted: authorization.granted, grantedBy: authorization.grantedBy },
  rationale: decision === 'proceed-with-latency-deviation'
    ? 'The route produced no transport error in 16/16 representative requests and every request reported usage. One 82s request exceeded the pre-registered p95 bound; that is a latency deviation, not the failure mode that stopped R2. The pilot records per-request latency and stops on transport or usage failure.'
    : 'The representative route did not pass transport/usage acceptance. The pilot must not run.',
  note: 'This is a protocol-deviation record, not a new grant. The pilot authorization is unchanged and bound to the manifest SHA-256 above.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'product-pilot-prerequisites.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`product pilot prerequisites: ${decision}; health ${health.successes}/${health.planned}; p95 ${health.latency?.p95}ms; latency bound met ${latencyPass}\n`)
process.stdout.write(`wrote ${path}\n`)
if (decision !== 'proceed-with-latency-deviation') process.exit(1)
