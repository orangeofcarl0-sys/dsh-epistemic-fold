#!/usr/bin/env node
/**
 * EF-R3 WP4 — run the deterministic span-economics matrix.
 *
 * The matrix lives as a Vitest spec because it needs the real engine harness
 * and a scripted compaction adapter. This wrapper runs that one spec and prints
 * the artifact summary; it makes no provider request.
 *
 *   node eval/r3/span-economics.mjs
 *
 * @module eval/r3/span-economics
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const artifact = join(HERE, 'out', 'span-economics.json')

execFileSync(process.execPath, [
  join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  'tests/r3-span-economics.spec.ts',
], {
  cwd: ROOT,
  stdio: 'inherit',
})

if (!existsSync(artifact)) {
  process.stderr.write('span-economics: the matrix did not write its artifact\n')
  process.exit(1)
}
const result = JSON.parse(readFileSync(artifact, 'utf8'))
process.stdout.write(`span economics: ${result.summary.cases} cases\n`)
process.stdout.write(`  widest ${JSON.stringify(result.summary.widestObserved)}\n`)
process.stdout.write(`  executed ${JSON.stringify(result.summary.executedObserved)}\n`)
process.stdout.write(`  gap ${JSON.stringify(result.summary.gaps)}\n`)
process.stdout.write(`  false admissions at default floors: ${result.summary.falseAdmissions}; floor sensitivity: ${result.summary.floorSensitivityFalseAdmissions}\n`)
process.stdout.write(`  committed ${result.summary.engineCommitted}, refused ${result.summary.engineRefused}\n`)
