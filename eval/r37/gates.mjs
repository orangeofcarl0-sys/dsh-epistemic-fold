#!/usr/bin/env node
/**
 * R37-A gates. A gate is computed from artifacts, not declared in prose.
 *
 * G0 Baseline Integrity
 * G1 Evidence Reconstruction
 * G2 Protocol Attribution
 * G3 Benchmark Validity
 * G4 Behavioral Identifiability
 * G5 Live Experiment Readiness
 * G6 Product Decision
 *
 * A blocked/not-executed live phase is reported as `ready-not-authorized`, not
 * as passed. A product decision with insufficient evidence is reported as
 * `insufficient-evidence`, not as a win.
 *
 * @module eval/r37/gates
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readJson, writeJson } from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out', 'gate-status.json')

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function existsText(path) {
  return await exists(path) ? await readFile(path, 'utf8') : ''
}

const baseline = await json(join(HERE, 'out', 'baseline-manifest.json'))
const reconstruction = await json(join(HERE, 'out', 'r36-evidence-reconstruction.json'))
const discrepancies = await json(join(HERE, 'out', 'r36-evidence-discrepancies.json'))
const protocol = await json(join(HERE, 'out', 'protocol-ablation.json'))
const validity = await json(join(HERE, 'out', 'benchmark-validity.json'))
const forensics = await json(join(HERE, 'out', 'forensics.json'))
const fixtureIndex = await json(join(HERE, 'out', 'representation-fixtures.json'))
const prereg = await existsText(join(ROOT, 'docs', 'semantic-continuity', 'R37_B_PREREGISTRATION.md'))
const decision = await existsText(join(ROOT, 'docs', 'semantic-continuity', 'R37_DECISION.md'))

const historical = Object.values(baseline.historicalEvidence.files)
const archiveRuns = baseline.historicalEvidence.runArchive.runs
const testCommands = baseline.tests.commands
const fullSuite = testCommands.find(command => command.command === 'npm run test')

const g0 = baseline.repository.baseCommit === 'b8274bba8b2a974e9c75af283e415e61a650295e'
  && baseline.dataset.matches === true
  && baseline.dataset.digest === '407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f'
  && historical.length === 32
  && historical.every(file => file.present === true)
  && archiveRuns.length === 12
  && archiveRuns.every(run => run.present === true)
  && fullSuite?.vitest?.passed === 1476
  && fullSuite?.vitest?.failed === 12
  && fullSuite?.vitest?.skipped === 70

const g1 = reconstruction.summary.contract.pairs === 12
  && reconstruction.summary.contract.rescue === 1
  && reconstruction.summary.contract.damage === 3
  && reconstruction.summary.contract.both === 4
  && reconstruction.summary.contract.neither === 4
  && reconstruction.summary.task.pairs === 12
  && reconstruction.summary.task.rescue === 1
  && reconstruction.summary.task.damage === 2
  && reconstruction.summary.task.both === 5
  && reconstruction.summary.task.neither === 4
  && reconstruction.summary.integrity.rows === 36
  && reconstruction.summary.integrity.ok === 36
  && discrepancies.status === 'no-discrepancy'

const dispatch = protocol.deterministicDispatch
const g2 = protocol.corpus?.turns >= 700
  && protocol.totals?.P0 !== undefined
  && protocol.totals?.P1 !== undefined
  && protocol.totals?.P2 !== undefined
  && protocol.totals?.P3 !== undefined
  && protocol.totals?.P3e !== undefined
  && protocol.totals?.P4 !== undefined
  && dispatch?.status === 'executed'
  && dispatch.P3?.syntaxPass === false
  && dispatch.P3?.checkerPass === false
  && dispatch.P3e?.syntaxPass === true
  && dispatch.P3e?.checkerPass === true

const g3 = validity.status === 'passed'
  && validity.cases.length === 2
  && validity.cases.every(entry => entry.certified === true)
  && validity.historicalPreservation.oldCasesUnchanged === true

const b2r1 = forensics.cases.B2.runs.find(run => run.runId === 'r36-causal-B2')
const b2r2 = forensics.cases.B2.runs.find(run => run.runId === 'r36-causal-r2-B2')
const c1r1 = forensics.cases.C1.runs.find(run => run.runId === 'r36-causal-C1')
const c1r2 = forensics.cases.C1.runs.find(run => run.runId === 'r36-causal-r2-C1')
const g4 = b2r1?.sufficientCause?.kind === 'tool-parameter-corruption'
  && b2r1?.decisionConsistency === 'action-consistent'
  && b2r2?.workspaceChanged === false
  && b2r2?.decisionConsistency === 'no-observed-action'
  && c1r1?.actualDelivery === 'full-history-fallback'
  && c1r1?.workspaceChanged === false
  && c1r2?.actualDelivery === 'semantic-committed'
  && c1r2?.classification === 'contract-success'
  && fixtureIndex.status === 'ready'
  && fixtureIndex.fixtures.length === 6

const preregRequired = [
  'End-to-end product effect',
  'Controlled representation effect',
  'H1',
  'H2',
  'H3',
  'H4',
  'Stop or pause rules',
  'Analysis plan',
]
const g5 = prereg.length > 0
  && preregRequired.every(section => prereg.includes(section))
  && g1 && g2 && g3 && g4
const g6 = decision.includes('insufficient evidence')

const gates = [
  {
    id: 'G0',
    name: 'Baseline Integrity',
    status: g0 ? 'passed' : 'failed',
    evidence: 'eval/r37/out/baseline-manifest.json',
    detail: `base ${baseline.repository.baseCommit?.slice(0, 7)}; dataset ${baseline.dataset.digest?.slice(0, 12)}…; `
      + `${historical.filter(file => file.present).length}/${historical.length} R36 files; `
      + `${archiveRuns.filter(run => run.present).length}/${archiveRuns.length} causal runs; `
      + `full suite ${fullSuite?.vitest?.passed} passed / ${fullSuite?.vitest?.failed} failed / ${fullSuite?.vitest?.skipped} skipped`,
  },
  {
    id: 'G1',
    name: 'Evidence Reconstruction',
    status: g1 ? 'passed' : 'failed',
    evidence: 'eval/r37/out/r36-evidence-reconstruction.json, eval/r37/out/r36-evidence-discrepancies.json',
    detail: `${reconstruction.summary.contract.pairs} pairs: ${reconstruction.summary.contract.rescue} rescue, `
      + `${reconstruction.summary.contract.damage} damage, ${reconstruction.summary.contract.both} both, `
      + `${reconstruction.summary.contract.neither} neither; ${reconstruction.summary.integrity.ok}/36 rows consistent; `
      + `discrepancies ${discrepancies.discrepancies.length}`,
  },
  {
    id: 'G2',
    name: 'Protocol Attribution',
    status: g2 ? 'passed' : 'failed',
    evidence: 'eval/r37/out/protocol-ablation.json',
    detail: `${protocol.corpus?.turns} turns; valid actions P0 ${protocol.totals?.P0?.valid} → P1 ${protocol.totals?.P1?.valid} `
      + `→ P2 ${protocol.totals?.P2?.valid} → P3 ${protocol.totals?.P3?.valid}; `
      + `B2 deterministic P3 syntax/checker ${dispatch?.P3?.syntaxPass}/${dispatch?.P3?.checkerPass}, `
      + `P3e ${dispatch?.P3e?.syntaxPass}/${dispatch?.P3e?.checkerPass}`,
  },
  {
    id: 'G3',
    name: 'Benchmark Validity',
    status: g3 ? 'passed' : 'failed',
    evidence: 'eval/r37/out/benchmark-validity.json, eval/r37/cases/A1-v2, eval/r37/cases/D1-v2',
    detail: `A1-v2/D1-v2 ${validity.cases?.filter(entry => entry.certified).length}/2 certified; `
      + `old cases unchanged ${validity.historicalPreservation?.oldCasesUnchanged}`,
  },
  {
    id: 'G4',
    name: 'Behavioral Identifiability',
    status: g4 ? 'passed' : 'failed',
    evidence: 'eval/r37/out/forensics.json, eval/r37/out/representation-fixtures.json',
    detail: `B2 r1 ${b2r1?.sufficientCause?.kind}; B2 r2 ${b2r2?.decisionConsistency}; `
      + `C1 r1 ${c1r1?.actualDelivery}; C1 r2 ${c1r2?.classification}; `
      + `${fixtureIndex.fixtures?.length} controlled fixtures`,
  },
  {
    id: 'G5',
    name: 'Live Experiment Readiness',
    status: g5 ? 'ready-not-authorized' : 'failed',
    evidence: 'docs/semantic-continuity/R37_B_PREREGISTRATION.md',
    detail: g5
      ? 'Preregistration frozen and offline prerequisites pass. No R37-B provider request was made; '
        + 'explicit spend authorization is required. H-native remains blocked.'
      : 'Preregistration is missing a required section or an offline prerequisite failed.',
  },
  {
    id: 'G6',
    name: 'Product Decision',
    status: g6 ? 'insufficient-evidence' : 'failed',
    evidence: 'docs/semantic-continuity/R37_DECISION.md',
    detail: g6
      ? 'Active vs Off remains insufficient evidence; R37-A identifies harness and benchmark confounds, not a product effect.'
      : 'The decision document is missing or does not state the evidence limit.',
  },
]

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-A',
  authorization: {
    r37aProviderRequests: 0,
    r37b: 'not-granted',
    note: 'R37-A is offline. R37-B requires a new explicit authorization.',
  },
  gates,
  liveExecution: {
    executed: false,
    status: 'not-executed',
    reason: 'R37-A prohibits provider calls; G5 is readiness, not a live result.',
    hNative: 'blocked',
  },
  artifacts: {
    baseline: 'eval/r37/out/baseline-manifest.json',
    reconstruction: 'eval/r37/out/r36-evidence-reconstruction.json',
    discrepancies: 'eval/r37/out/r36-evidence-discrepancies.json',
    protocol: 'eval/r37/out/protocol-ablation.json',
    benchmarkValidity: 'eval/r37/out/benchmark-validity.json',
    forensics: 'eval/r37/out/forensics.json',
    fixtures: 'eval/r37/out/representation-fixtures.json',
    preregistration: 'docs/semantic-continuity/R37_B_PREREGISTRATION.md',
    decision: 'docs/semantic-continuity/R37_DECISION.md',
  },
  note: 'A gate is computed from the artifacts above. A blocked or not-executed live phase is not a pass.',
}
await writeJson(OUT, report)

for (const gate of gates) {
  process.stdout.write(`${gate.id} ${gate.status.toUpperCase()}: ${gate.name}\n   ${gate.detail}\n`)
}
process.stdout.write(`live execution: ${report.liveExecution.status}\n`)
process.exit(gates.some(gate => gate.status === 'failed') ? 1 : 0)
