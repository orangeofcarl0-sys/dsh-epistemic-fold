#!/usr/bin/env node
/**
 * EF-R4 — grant the transport health probe.
 *
 * The design is immutable. This writes a separate authorization bound to the
 * design SHA-256. It does not modify the design and does not start a request.
 *
 *   node eval/r4/authorize-health-probe.mjs
 *
 * @module eval/r4/authorize-health-probe
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const designPath = join(OUT, 'transport-health-probe.json')
if (!existsSync(designPath)) {
  process.stderr.write('authorize-health-probe: freeze-health-probe.mjs has not run\n')
  process.exit(2)
}
const design = JSON.parse(readFileSync(designPath, 'utf8'))
const designSha256 = createHash('sha256').update(readFileSync(designPath)).digest('hex')
if (design.executionAuthorized !== false) {
  process.stderr.write('authorize-health-probe: the design is already marked authorized; refusing to rewrite it\n')
  process.exit(2)
}

const authorization = {
  schemaVersion: 1,
  work: 'EF-R4 transport health probe authorization',
  probeId: design.probeId,
  design: 'eval/r4/out/transport-health-probe.json',
  designSha256,
  granted: true,
  grantedAt: new Date().toISOString(),
  grantedBy: 'user instruction: "均授权，继续" (2026-11-14)',
  basis: 'The user authorized the representative transport health probe and the 36-cell budget-sensitivity campaign after the offline preflight.',
  limits: design.envelope,
  stopConditions: design.stopConditions,
  note: 'This grant is bound to the design SHA-256 above. A changed design needs a new grant. It does not authorize the campaign by itself.',
}

const path = join(OUT, 'health-probe-authorization.json')
writeFileSync(path, `${JSON.stringify(authorization, null, 2)}\n`, 'utf8')
process.stdout.write(`health-probe authorization: granted; design ${designSha256.slice(0, 12)}…; requests ${design.envelope.requests}\n`)
process.stdout.write(`wrote ${path}\n`)
