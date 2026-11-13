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
const value = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const manifestPath = value('manifest') === undefined
  ? join(OUT, 'out', 'manifest-e2e-core-1.json')
  : resolve(value('manifest'))
const authorizationPath = value('out') === undefined
  ? join(OUT, 'authorization.json')
  : resolve(value('out'))

/**
 * The authorized envelopes, by name.
 *
 * A later round must not silently inherit the largest grant: the caller names
 * the envelope, and the check below uses THAT grant. The EF-R1 pilot is a
 * separate 32-cell cap; the original 72-cell envelope is closed.
 */
const ENVELOPES = {
  original: {
    continuationCells: 72,
    httpAttempts: 2200,
    inputTokens: 18_000_000,
    outputTokens: 1_000_000,
    wallClockMs: 8 * 60 * 60 * 1000,
  },
  'lg-pilot': {
    continuationCells: 32,
    httpAttempts: 800,
    inputTokens: 4_000_000,
    outputTokens: 150_000,
    wallClockMs: 2 * 60 * 60 * 1000,
  },
  'lg-confirm': {
    continuationCells: 138,
    httpAttempts: 4_200,
    inputTokens: 30_000_000,
    outputTokens: 1_200_000,
    wallClockMs: 6 * 60 * 60 * 1000,
  },
  'prompt-repair': {
    continuationCells: 8,
    httpAttempts: 200,
    inputTokens: 1_000_000,
    outputTokens: 40_000,
    wallClockMs: 30 * 60 * 1000,
  },
  'prompt-confirm': {
    continuationCells: 24,
    httpAttempts: 720,
    inputTokens: 6_000_000,
    outputTokens: 250_000,
    wallClockMs: 3 * 60 * 60 * 1000,
  },
  'prompt-rerender': {
    continuationCells: 8,
    httpAttempts: 200,
    inputTokens: 1_000_000,
    outputTokens: 40_000,
    wallClockMs: 30 * 60 * 1000,
  },
  // EF-R2 pilot: 18 cells (six seed-1 instances x B0/E0/E1). Separate from the
  // 72-cell design grant so a pilot cannot silently consume the confirm budget.
  'r2-live-pilot': {
    continuationCells: 18,
    httpAttempts: 600,
    inputTokens: 5_000_000,
    outputTokens: 400_000,
    wallClockMs: 2 * 60 * 60 * 1000,
  },
  // EF-R2 confirm: the remaining 54 cells inside the 72-cell design envelope.
  'r2-live': {
    continuationCells: 72,
    httpAttempts: 2_000,
    inputTokens: 20_000_000,
    outputTokens: 1_500_000,
    wallClockMs: 6 * 60 * 60 * 1000,
  },
}
const envelopeName = value('envelope') ?? 'original'
const ENVELOPE = ENVELOPES[envelopeName]
if (ENVELOPE === undefined) {
  process.stderr.write(`authorize: unknown envelope ${JSON.stringify(envelopeName)}; expected ${Object.keys(ENVELOPES).join(', ')}\n`)
  process.exit(2)
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
  statement: 'Delegated authorization under the EF-E2E work package: the user authorized this '
    + 'envelope, the manifest is inside it, and the run may not exceed the manifest limits.',
  envelopeName,
  envelope: ENVELOPE,
}
await mkdir(dirname(authorizationPath), { recursive: true })
await writeFile(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`, 'utf8')
process.stdout.write(`authorized ${manifest.campaign} under ${envelopeName}: ${manifest.cells.length} cell(s), `
  + `manifest ${digest.slice(0, 12)}…\n`)
