#!/usr/bin/env node
/**
 * EF-R3 WP4 — compare a manifest's DECLARED config with the config the host
 * actually resolves.
 *
 * The R2 E1 arm declared `rationaleHintTokens: 800`, but `eval/e2e/src/host.mjs`
 * forwarded only leafAdmission/rootPolicy/framingMode. The economy preset filled
 * the missing key with 400, so the archived E1 cells ran a different treatment
 * than the manifest named. This preflight makes that visible and prevents a
 * future campaign from repeating it.
 *
 *   node eval/r3/config-preflight.mjs --manifest eval/e2e/out/manifest-e2e-r2-confirm-1.json --historical
 *   node eval/r3/config-preflight.mjs --manifest eval/e2e/out/manifest-e2e-r2-confirm-1.json --forwarded
 *
 * `--historical` reproduces the R2 host. `--forwarded` is the R3 contract: every
 * declared key reaches resolveEfConfig.
 *
 * @module eval/r3/config-preflight
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEfConfig } from '../../lib/config/policy.js'
import {
  declaredOptions,
  forwardedOptions,
  r2EffectiveOptions,
} from './config-resolve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}
const manifestPath = resolve(value('manifest', join(ROOT, 'eval', 'e2e', 'out', 'manifest-e2e-r2-confirm-1.json')))
if (!existsSync(manifestPath)) {
  process.stderr.write(`config-preflight: ${manifestPath} is missing\n`)
  process.exit(2)
}
const historical = argv.includes('--historical')
const forwarded = argv.includes('--forwarded') || !historical
const outName = value('out', historical ? 'config-preflight.json' : 'config-preflight-forwarded.json')
const manifest = readJson(manifestPath)

const KEYS = [
  'leafAdmission',
  'rootPolicy',
  'framingMode',
  'semanticContinuity',
  'rationaleHintTokens',
  'thresholdRatio',
  'retainRatio',
  'headroomTokens',
  'minReclaimTokens',
  'minReclaimRatio',
]

function summarize(config) {
  return {
    backend: config.backend,
    mode: config.mode ?? null,
    semanticMode: config.semanticMode ?? null,
    semanticContinuity: config.semanticContinuity ?? null,
    leafAdmission: config.leafAdmission ?? null,
    rootPolicy: typeof config.rootPolicy === 'object' && config.rootPolicy !== null
      ? config.rootPolicy.mode
      : config.rootPolicy ?? null,
    framingMode: config.framingMode ?? null,
    rationaleHintTokens: config.rationaleHintTokens ?? null,
    thresholdRatio: config.thresholdRatio ?? null,
    retainRatio: config.retainRatio ?? null,
    headroomTokens: config.headroomTokens ?? null,
    minReclaimTokens: config.minReclaimTokens ?? null,
    minReclaimRatio: config.minReclaimRatio ?? null,
  }
}

function compare(declared, effective, arm) {
  const mismatches = []
  const inert = []
  for (const key of KEYS) {
    if (manifest.config[key] === undefined) continue
    if (key === 'rationaleHintTokens' && arm !== 'E1') {
      inert.push(key)
      continue
    }
    const declaredValue = key === 'rootPolicy'
      ? (typeof declared.rootPolicy === 'object' ? declared.rootPolicy.mode : declared.rootPolicy)
      : declared[key]
    const effectiveValue = key === 'rootPolicy'
      ? (typeof effective.rootPolicy === 'object' ? effective.rootPolicy.mode : effective.rootPolicy)
      : effective[key]
    if (declaredValue !== effectiveValue) {
      mismatches.push({ key, declared: declaredValue, effective: effectiveValue })
    }
  }
  return { mismatches, inert }
}

const arms = ['E0', 'E1'].map(arm => {
  const semanticMode = arm === 'E1' ? 'rationale' : 'none'
  const declared = resolveEfConfig(declaredOptions({ arm, semanticMode, manifestConfig: manifest.config }))
  const effectiveOptions = historical
    ? r2EffectiveOptions({ arm, semanticMode, manifestConfig: manifest.config })
    : forwardedOptions({ arm, semanticMode, manifestConfig: manifest.config })
  const effective = resolveEfConfig(effectiveOptions)
  const { mismatches, inert } = compare(declared, effective, arm)
  return {
    arm,
    declared: summarize(declared),
    effective: summarize(effective),
    mismatches,
    inert,
    status: mismatches.length === 0 ? 'match' : 'drift',
  }
})

const mismatches = arms.flatMap(entry => entry.mismatches.map(mismatch => ({ arm: entry.arm, ...mismatch })))
const output = {
  schemaVersion: 1,
  work: 'EF-R3 WP4',
  generatedAt: new Date().toISOString(),
  manifest: {
    path: manifestPath.replace(/\//gu, '/'),
    sha256: sha256(manifestPath),
  },
  mode: historical ? 'historical-r2-host' : 'forwarded-manifest',
  forwarded,
  arms,
  mismatches,
  status: mismatches.length === 0 ? 'pass' : 'drift-detected',
  note: historical
    ? 'Reproduces the R2 host: it forwarded leafAdmission/rootPolicy/framingMode only and hard-coded retainRatio/headroomTokens. The E1 hint mismatch is the treatment-identity finding.'
    : 'R3 contract: every declared key reaches resolveEfConfig. A future live campaign must pass this preflight before it runs.',
}

mkdirSync(OUT, { recursive: true })
const outPath = join(OUT, outName)
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`config preflight: ${output.mode}; ${output.status}\n`)
for (const entry of arms) {
  process.stdout.write(`  ${entry.arm}: ${entry.status}; declared hint ${entry.declared.rationaleHintTokens}; effective hint ${entry.effective.rationaleHintTokens}; mismatches ${JSON.stringify(entry.mismatches)}\n`)
}
process.stdout.write(`wrote ${outPath}\n`)
if (historical && output.status !== 'drift-detected') {
  process.stderr.write('config-preflight: historical mode expected the known 800/400 drift; the finding is no longer reproduced\n')
  process.exit(1)
}
if (!historical && output.status !== 'pass') process.exit(1)
