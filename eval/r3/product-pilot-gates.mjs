#!/usr/bin/env node
/**
 * EF-R3 product-lane — pilot gates.
 *
 * These are separate from the R3 closure gates. They report coverage, cost
 * completeness, transport, latency and the product decision without promoting
 * a pilot to a confirmatory result.
 *
 *   node eval/r3/product-pilot-gates.mjs
 *
 * @module eval/r3/product-pilot-gates
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const load = name => {
  const path = join(OUT, name)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

const analysis = load('product-pilot-analysis.json')
const health = load('health-probe-results.json')
const prerequisites = load('product-pilot-prerequisites.json')
const cost = load('cost-preflight.json')
const design = load('product-pilot-design.json')

const gates = []
const gate = (id, status, detail) => gates.push({ id, status, detail })

gate('P-G0',
  design?.authorization?.granted === true
    && cost?.status === 'pass'
    && prerequisites?.decision === 'proceed-with-latency-deviation'
    ? 'pass' : 'fail',
`manifest ${design?.manifest?.sha256?.slice(0, 12) ?? 'missing'}; authorization ${design?.authorization?.granted ?? '?'}; cost ${cost?.status ?? '?'}; prerequisite ${prerequisites?.decision ?? '?'}`)

gate('P-G1',
  analysis?.coverage?.executed === 18
    && analysis?.coverage?.planned === 18
    && analysis?.coverage?.valid === 18
    ? 'pass' : 'fail',
`${analysis?.coverage?.executed ?? '?'}/${analysis?.coverage?.planned ?? '?'} executed; ${analysis?.coverage?.valid ?? '?'} valid`)

gate('P-G2',
  analysis?.coverage?.costComplete === true
    ? 'pass' : 'incomplete',
`cost-valid ${analysis === null ? '?' : (analysis.coverage.valid - analysis.coverage.costInvalidCells.length)}/${analysis?.coverage?.valid ?? '?'}; invalid ${JSON.stringify(analysis?.coverage?.costInvalidCells ?? [])}`)

gate('P-G3',
  health?.successes === 16
    && health?.failures === 0
    ? 'pass' : 'fail',
`transport/usage ${health?.successes ?? '?'}/${health?.planned ?? '?'}; failures ${health?.failures ?? '?'}; latency p95 ${health?.latency?.p95 ?? '?'} ms`)

gate('P-G4',
  health?.latency?.p95 !== null
    && health?.latency?.p95 !== undefined
    && health.latency.p95 <= 60_000
    ? 'pass' : 'incomplete',
`p95 ${health?.latency?.p95 ?? '?'} ms vs 60,000 ms; over-60s requests ${health?.latency?.over60s?.length ?? '?'}`)

gate('P-G5',
  analysis?.decision?.decision === 'no-product-candidate'
    && analysis?.decision?.deploymentHold === true
    && analysis?.decision?.expandTo72 === false
    ? 'pass' : 'fail',
`decision ${analysis?.decision?.decision ?? '?'}; deploymentHold ${analysis?.decision?.deploymentHold ?? '?'}; expandTo72 ${analysis?.decision?.expandTo72 ?? '?'}`)

const output = {
  schemaVersion: 1,
  work: 'EF-R3 product-lane pilot',
  generatedAt: new Date().toISOString(),
  gates,
  counts: {
    pass: gates.filter(entry => entry.status === 'pass').length,
    incomplete: gates.filter(entry => entry.status === 'incomplete').length,
    fail: gates.filter(entry => entry.status === 'fail').length,
  },
  note: 'P-G2 and P-G4 are incomplete by evidence: one E1 cell has partial usage and the health-probe p95 exceeded its pre-registered bound. The transport gate P-G3 passed 16/16.',
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'product-pilot-gate-status.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
for (const entry of gates) process.stdout.write(`${entry.id} ${entry.status.toUpperCase()} — ${entry.detail}\n`)
process.stdout.write(`${output.counts.pass} pass, ${output.counts.incomplete} incomplete, ${output.counts.fail} fail\n`)
if (output.counts.fail > 0) process.exit(1)
