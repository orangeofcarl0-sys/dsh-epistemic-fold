#!/usr/bin/env node
/**
 * R36 completion gates, without pretending a blocked live phase ran.
 *
 *   G0  R35 evidence closed                  audit JSON exists and has 17 attempts
 *   G1  benchmark valid                      certification passed; scorer v3 is temporal
 *   G2  writer experiment                    offline W0/P1 complete; W1-P0 live blocked
 *   G3  agent identifiability                offline guard/diagnostics complete; live blocked
 *   G4  real causal comparison               blocked (no R36 authorization and G3 not passed)
 *   G5  product decision                     written from the evidence that exists
 *
 * The script validates every manifest's shape, verifies the frozen dataset, and
 * reads no credential. It never calls a provider.
 *
 * @module eval/r36/gates
 */

import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../r33/src/budget.mjs'
import { verifyFrozen } from '../r33/src/dataset.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT = join(HERE, 'out')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

const conditions = await json(join(OUT, 'conditions.json'))
const audit = await json(join(HERE, 'evidence', 'r35', 'writer-audit.json'))
const ablation = await json(join(OUT, 'parser-ablation.json'))
const certification = await json(join(OUT, 'case-certification.json'))
const dataset = await verifyFrozen()

const manifestDir = join(HERE, 'manifests')
const manifestFiles = (await readdir(manifestDir)).filter(file => file.endsWith('.json')).sort()
const manifests = []
for (const file of manifestFiles) {
  const manifest = await json(join(manifestDir, file))
  const verdict = validateManifest(manifest)
  manifests.push({
    file,
    id: manifest.id,
    phase: manifest.phase,
    execution: manifest.execution,
    status: manifest.status,
    requiresAuthorization: manifest.requiresAuthorization,
    valid: verdict.ok,
    reason: verdict.ok ? null : verdict.reason,
    promptVersion: manifest.promptVersion ?? null,
    parser: manifest.parser ?? null,
    arms: manifest.arms ?? null,
    stage: manifest.stage ?? null,
    runtime: manifest.runtime ?? null,
  })
}
const manifestsValid = manifests.every(entry => entry.valid)
const authorized = process.env.R36_LIVE_AUTHORIZED === '1'

const g0 = audit.writerAttempts?.total === 17
  && audit.writerAttempts?.scoreable === 16
  && audit.writerAttempts?.lostRows === 1
  && typeof audit.writerAttempts?.categories === 'object'
  && Array.isArray(audit.factFunnel?.perAttempt)
const g1 = certification.allPassed === true
  && certification.cases?.length === 7
  && conditions.scorer?.version === 3
  && dataset.ok === true
const g2Offline = ablation.summary?.p0?.parsed === 10
  && ablation.summary?.p1?.structurallyAvailable === 15
  && ablation.summary?.p1?.contentPreserved === true
  && conditions.writer?.prompts?.W0?.digest === '1d13166dfaba145986af0d183d1739ed2835aca76668774dada15f0aaf937abc'
const g2LiveBlocked = manifests
  .filter(entry => entry.phase === 'B' && entry.execution === 'live')
  .every(entry => entry.status === 'blocked')
const g3Offline = await exists(join(ROOT, 'tests', 'r36-agent-calibration.spec.ts'))
  && await exists(join(ROOT, 'tests', 'r36-benchmark-validity.spec.ts'))
const g3LiveBlocked = manifests
  .filter(entry => entry.phase === 'C')
  .every(entry => entry.status === 'blocked')
const g4Blocked = manifests
  .filter(entry => entry.phase === 'D')
  .every(entry => entry.status === 'blocked')
  && !authorized
const g5 = await exists(join(ROOT, 'docs', 'semantic-continuity', 'R36_DECISION.md'))

const gates = [
  {
    id: 'G0',
    name: 'R35 Evidence Closed',
    status: g0 ? 'passed' : 'failed',
    evidence: 'eval/r36/evidence/r35/writer-audit.json',
    detail: `${audit.writerAttempts?.total} attempts, ${audit.writerAttempts?.scoreable} scoreable, `
      + `${audit.writerAttempts?.lostRows} lost; categories ${JSON.stringify(audit.writerAttempts?.categories)}`,
  },
  {
    id: 'G1',
    name: 'Benchmark Valid',
    status: g1 ? 'passed' : 'failed',
    evidence: 'eval/r36/out/case-certification.json, tests/r36-benchmark-validity.spec.ts',
    detail: `${certification.cases?.filter(row => row.visible?.passed && row.hidden?.passed && row.historical?.passed).length}/7 cases certified; `
      + `dataset ${dataset.ok ? 'verified' : 'FAILED'}; scorer v${conditions.scorer?.version}`,
  },
  {
    id: 'G2',
    name: 'Writer Experiment',
    status: g2Offline && g2LiveBlocked ? (authorized ? 'partial' : 'blocked') : 'failed',
    evidence: 'eval/r36/out/parser-ablation.json, eval/r36/evidence/r35/writer-audit.json',
    detail: `offline W0-P0/P1 ${g2Offline ? 'complete' : 'incomplete'}; W1-P0 live is ${g2LiveBlocked ? 'blocked' : 'not blocked'}`
      + `${authorized ? '; authorization present, live run still not executed in this session' : ' (no R36 authorization)'}`,
  },
  {
    id: 'G3',
    name: 'Agent Identifiability',
    status: g3Offline && g3LiveBlocked ? (authorized ? 'partial' : 'blocked') : 'failed',
    evidence: 'tests/r36-agent-calibration.spec.ts, eval/r36/manifests/h-*.json',
    detail: `offline H0/H-step/H-output/H-finish diagnostics ${g3Offline ? 'implemented and tested' : 'incomplete'}; `
      + `H-native implemented=false; live calibration ${g3LiveBlocked ? 'blocked' : 'not blocked'}`,
  },
  {
    id: 'G4',
    name: 'Real Causal Comparison',
    status: g4Blocked ? 'blocked' : 'failed',
    evidence: 'eval/r36/manifests/b1-s-o1-o2-frozen.json',
    detail: g4Blocked
      ? 'No R36 authorization; writer and harness interventions are not independently measured yet. No B1/S result is claimed.'
      : 'A live causal run is not permitted by this gate state.',
  },
  {
    id: 'G5',
    name: 'Product Decision',
    status: g5 ? 'insufficient-evidence' : 'failed',
    evidence: 'docs/semantic-continuity/R36_DECISION.md',
    detail: 'The decision is limited to the offline evidence; it does not claim Active > Off.',
  },
]

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  conditions,
  dataset: { ok: dataset.ok, reason: dataset.ok ? null : dataset.reason },
  manifests,
  manifestsValid,
  authorization: authorized ? 'granted-by-environment' : 'not-granted-in-this-session',
  gates,
  note: 'No provider request was made. A blocked gate is not a failed experiment; it is an experiment that was not run.',
}
await writeFile(join(OUT, 'gate-status.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

for (const gate of gates) {
  process.stdout.write(`${gate.id} ${gate.status.toUpperCase()}: ${gate.name}\n   ${gate.detail}\n`)
}
process.stdout.write(`manifests: ${manifests.filter(entry => entry.valid).length}/${manifests.length} valid\n`)
process.stdout.write(`authorization: ${report.authorization}\n`)
process.stdout.write(`${join(OUT, 'gate-status.json')}\n`)
process.exit(gates.some(gate => gate.status === 'failed') ? 1 : 0)
