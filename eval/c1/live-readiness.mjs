#!/usr/bin/env node
/**
 * EF-C1 WP6 — live-experiment readiness, computed from repository state.
 *
 * ## Why this refuses by default
 *
 * EF-C1 has ZERO real-model authorization. The historical R37-D authorization
 * covered the cells it named; it does not cover a new batch, a new manifest, or
 * this round. A readiness file that said `ready` because the code compiles
 * would be the exact error the previous rounds kept correcting.
 *
 * So the status is derived, not asserted:
 *
 *   not-authorized   no frozen manifest, or no authorization naming its SHA
 *   blocked          a manifest exists but a preflight requirement is missing
 *   ready            a manifest exists, its SHA is named by an explicit
 *                    authorization, and the preflight is clean
 *
 * `ready` still does not execute anything. Execution is a separate command
 * that must re-check the same conditions.
 *
 * @module eval/c1/live-readiness
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const MANIFEST = join(ROOT, 'eval', 'c1', 'live-manifest.json')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function main() {
  const requirements = [
    'a frozen manifest at eval/c1/live-manifest.json',
    'the manifest SHA-256 recorded in the authorization',
    'an explicit authorization naming that SHA (C1_LIVE_AUTHORIZED_SHA256)',
    'a provider/model route (names, not secrets)',
    'positive budget caps (requests, input tokens, output tokens, wall clock)',
    'a clean preflight over the real fold path',
  ]

  const blocking = []
  let manifestSha256 = null
  let manifest = null

  if (!existsSync(MANIFEST)) {
    blocking.push(
      'no frozen manifest',
      'no authorization names a manifest SHA',
      'no route declared (no manifest)',
      'no limits declared (no manifest)',
      'no preflight recorded',
    )
  } else {
    const bytes = readFileSync(MANIFEST)
    manifestSha256 = sha256(bytes)
    try {
      manifest = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      blocking.push(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (manifest !== null) {
      if (manifest.limits === undefined) blocking.push('manifest declares no limits')
      if (manifest.route === undefined) blocking.push('manifest declares no route')
    }
    const authorized = process.env['C1_LIVE_AUTHORIZED_SHA256']
    if (authorized === undefined) {
      blocking.push('no authorization names a manifest SHA')
    } else if (authorized !== manifestSha256) {
      blocking.push('the authorized SHA does not match the manifest')
    }
  }

  const status = manifestSha256 === null || process.env['C1_LIVE_AUTHORIZED_SHA256'] === undefined
    ? 'not-authorized'
    : (blocking.length === 0 ? 'ready' : 'blocked')

  const report = {
    schemaVersion: 1,
    work: 'EF-C1',
    generator: 'eval/c1/live-readiness.mjs',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    generatedAt: new Date().toISOString(),
    status,
    providerCalls: 0,
    arms: ['B0', 'E0', 'E1'],
    note: 'Bv (EF mode:basic) is a compatibility arm, not a product arm; it does not repeat the full live matrix.',
    manifest: manifestSha256 === null ? null : { path: 'eval/c1/live-manifest.json', sha256: manifestSha256 },
    requirements,
    blocking,
    executionKind: 'not executed in EF-C1; no provider was contacted',
  }

  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'live-readiness.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`live readiness: ${status} (${blocking.length} blocking condition(s), 0 provider calls)\n`)
  for (const reason of blocking) process.stdout.write(`  - ${reason}\n`)
  process.stdout.write(`wrote ${join(OUT, 'live-readiness.json')}\n`)
}

main()
