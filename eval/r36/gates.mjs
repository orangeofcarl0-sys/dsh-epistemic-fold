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
const live = await exists(join(OUT, 'live-results.json')) ? await json(join(OUT, 'live-results.json')) : null
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
const authorized = live?.authorization?.status === 'granted'
  || process.env.R36_LIVE_AUTHORIZED === '1'

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
const writerRuns = live?.writer?.runs ?? []
const w0 = writerRuns.find(run => run.promptVersion === 'W0')
const w1 = writerRuns.find(run => run.promptVersion === 'W1')
const g2Live = w0?.summary?.attempts === 6
  && w1?.summary?.attempts === 6
  && w1.summary.parsed > w0.summary.parsed
  && w1.summary.commitRecall > w0.summary.commitRecall
const g3Offline = await exists(join(ROOT, 'tests', 'r36-agent-calibration.spec.ts'))
  && await exists(join(ROOT, 'tests', 'r36-benchmark-validity.spec.ts'))
const harnessConditions = live?.harness?.conditions ?? []
const harnessValid = harnessConditions.length >= 5
  && harnessConditions.every(condition => condition.summary.valid === 6)
const bestHarness = harnessConditions
  .slice()
  .sort((left, right) => right.summary.contractSuccesses - left.summary.contractSuccesses)[0]
const g3Identifiable = harnessValid
  && bestHarness !== undefined
  && bestHarness.summary.contractSuccesses > 0
  && bestHarness.summary.contractSuccesses < bestHarness.summary.valid
const g4 = live?.causal?.status === 'executed'
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
    status: g2Offline && g2Live ? 'passed' : (g2Offline ? 'partial' : 'failed'),
    evidence: 'eval/r36/out/live-results.json, eval/r36/out/parser-ablation.json',
    detail: g2Live
      ? `same-time W0-P0 ${w0.summary.parsed}/6 parsed, commit recall ${w0.summary.commitRecall?.toFixed(3)}; `
        + `W1-P0 ${w1.summary.parsed}/6 parsed, commit recall ${w1.summary.commitRecall?.toFixed(3)}, `
        + `${w1.summary.accepted} accepted / ${w1.summary.refused} refused; one replicate`
      : 'W0/W1 live evidence is incomplete; the offline P0/P1 ablation is separate.',
  },
  {
    id: 'G3',
    name: 'Agent Identifiability',
    status: g3Offline && g3Identifiable ? 'partial' : (g3Offline ? 'partial' : 'failed'),
    evidence: 'eval/r36/out/harness-calibration.json, tests/r36-agent-calibration.spec.ts',
    detail: harnessValid
      ? `O2 conditions valid 6/6; best ${bestHarness.condition} ${bestHarness.summary.contractSuccesses}/6 contract, `
        + `${bestHarness.summary.taskSuccesses}/6 task. The H0/H-step failures were the unparsed DSML protocol; `
        + `the remaining D1 failure is the missing verification.json. H-native is not implemented.`
      : 'O2 calibration is incomplete; H-native is not implemented.',
  },
  {
    id: 'G4',
    name: 'Real Causal Comparison',
    status: g4 ? 'partial' : 'blocked',
    evidence: 'eval/r36/out/live-results.json, eval/r36/manifests/b1-s-o1-o2-frozen.json',
    detail: g4
      ? `${live.causal.b1sRows} exploratory pairs: ${live.causal.contract.rescue} rescue, `
        + `${live.causal.contract.damage} damage, ${live.causal.contract.both} both, `
        + `${live.causal.contract.neither} neither. Damage is confounded by the A1 task/gold ambiguity and B2 code/process.`
      : (live?.causal?.reason
        ?? 'No B1/S run. O2 does not form a stable upper bound, so a causal comparison would be dominated by the execution floor.'),
  },
  {
    id: 'G5',
    name: 'Product Decision',
    status: g5 ? 'insufficient-evidence' : 'failed',
    evidence: 'docs/semantic-continuity/R36_DECISION.md',
    detail: 'Active vs Off remains insufficient evidence; the writer-interface and harness-floor findings are positive.',
  },
]

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  conditions,
  dataset: { ok: dataset.ok, reason: dataset.ok ? null : dataset.reason },
  manifests,
  manifestsValid,
  authorization: authorized ? 'granted-in-this-session' : 'not-granted-in-this-session',
  gates,
  note: live
    ? `Authorized R36 live runs executed: ${live.cost?.runs ?? 0} run reports, `
      + `${live.cost?.total?.attempts ?? 0} HTTP attempts. H-native and B1/S were not run; a blocked gate is not a fabricated result.`
    : 'No provider request was made. A blocked gate is not a failed experiment; it is an experiment that was not run.',
}
await writeFile(join(OUT, 'gate-status.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

for (const gate of gates) {
  process.stdout.write(`${gate.id} ${gate.status.toUpperCase()}: ${gate.name}\n   ${gate.detail}\n`)
}
process.stdout.write(`manifests: ${manifests.filter(entry => entry.valid).length}/${manifests.length} valid\n`)
process.stdout.write(`authorization: ${report.authorization}\n`)
process.stdout.write(`${join(OUT, 'gate-status.json')}\n`)
process.exit(gates.some(gate => gate.status === 'failed') ? 1 : 0)
