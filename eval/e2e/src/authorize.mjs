#!/usr/bin/env node
/**
 * Bind one frozen manifest to the delegated execution envelope.
 *
 * The work package's §2.4 delegation: the user authorizes the ENVELOPE, the
 * agent freezes the concrete manifest, a program checks that the manifest does
 * not exceed the envelope, and only then is the runner's authorization hash
 * set. This is not a claim that the user approved a hash that did not exist.
 *
 *   node eval/e2e/src/authorize.mjs --manifest eval/e2e/out/manifest-e2e-core-1.json
 *
 * @module eval/e2e/src/authorize
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = join(ROOT, 'eval', 'e2e')

const argv = process.argv.slice(2)
const at = argv.indexOf('--manifest')
const manifestPath = at === -1 ? join(OUT, 'out', 'manifest-e2e-core-1.json') : resolve(argv[at + 1])

const ENVELOPE = {
  continuationCells: 72,
  httpAttempts: 2200,
  inputTokens: 18_000_000,
  outputTokens: 1_000_000,
  wallClockMs: 8 * 60 * 60 * 1000,
}

const text = await readFile(manifestPath, 'utf8')
const manifest = JSON.parse(text)
const digest = createHash('sha256').update(text, 'utf8').digest('hex')

const problems = []
if (manifest.cells.length > ENVELOPE.continuationCells) {
  problems.push(`cells ${manifest.cells.length} > ${ENVELOPE.continuationCells}`)
}
for (const key of ['httpAttempts', 'inputTokens', 'outputTokens', 'wallClockMs']) {
  if (!(manifest.limits[key] > 0) || manifest.limits[key] > ENVELOPE[key]) {
    problems.push(`limit ${key} ${manifest.limits[key]} outside (0, ${ENVELOPE[key]}]`)
  }
}
if (problems.length > 0) {
  process.stderr.write(`authorize: manifest exceeds the envelope:\n${problems.join('\n')}\n`)
  process.exit(2)
}

const authorization = {
  granted: true,
  grantedAt: new Date().toISOString(),
  manifestSha256: digest,
  campaign: manifest.campaign,
  cells: manifest.cells.length,
  statement: 'Delegated authorization under the EF-E2E work package: the envelope is authorized, '
    + 'this manifest is inside it, and the run may not exceed the manifest limits.',
  envelope: ENVELOPE,
}
await mkdir(OUT, { recursive: true })
await writeFile(join(OUT, 'authorization.json'), `${JSON.stringify(authorization, null, 2)}\n`, 'utf8')
process.stdout.write(`authorized ${manifest.campaign}: ${manifest.cells.length} cell(s), manifest ${digest.slice(0, 12)}…\n`)
