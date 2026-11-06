#!/usr/bin/env node
/**
 * R38-M0 gates.
 *
 * G0 repository / baseline integrity
 * G1 relation authorization safety
 * G2 commit / supersession integrity
 * G3 integrity auditor validity
 * G4 task-aware selection validity
 * G5 archive recovery validity
 * G6 recent-tail / native delivery
 * G7 product / experiment decision
 *
 * Exit codes follow R37-C:
 *   0 all required gates passed
 *   1 a gate failed
 *   2 no failure, but a gate is partial/not-executed/blocked
 *
 * A safety gate that cannot be verified is NOT a pass. The product decision is
 * reported separately from the stage readiness.
 *
 * @module eval/r38/gates
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readJson, writeJson } from '../r37/src/io.mjs'
import { exitCodeFor, gateEvaluation } from '../r37c/src/gate-exit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'gate-status.json')
const DOCS = join(HERE, '..', '..', 'docs', 'semantic-continuity')

async function load(name, fallback = null) {
  const path = join(HERE, 'out', name)
  return await exists(path) ? await readJson(path) : fallback
}

const baseline = await load('baseline-manifest.json')
const relation = await load('relation-security-audit.json')
const idempotency = await load('revision-idempotency.json')
const integrity = await load('integrity-audit.json')
const workingSet = await load('working-set-ablation.json')
const recovery = await load('archive-recovery-ablation.json')
const tail = await load('recent-tail-consistency.json')
const native = await load('native-context-smoke.json')
const mechanism = await load('mechanism-evaluation.json')
const r38Tests = await load('r38-tests.json')

const r37cGates = await exists(join(HERE, '..', 'r37c', 'out', 'gate-status-r37c.json'))
  ? await readJson(join(HERE, '..', 'r37c', 'out', 'gate-status-r37c.json'))
  : null
const r37dGates = await exists(join(HERE, '..', 'r37d', 'out', 'gate-status-r37d.json'))
  ? await readJson(join(HERE, '..', 'r37d', 'out', 'gate-status-r37d.json'))
  : null

const caseOf = id => mechanism?.cases?.find(row => row.id === id) ?? null
const caseCertified = id => caseOf(id)?.status === 'certified'

const gates = []

gates.push({
  id: 'R38-G0',
  name: 'Repository and baseline integrity',
  status: baseline?.status === 'passed'
    && baseline?.historicalEvidence?.r37bArchive?.match === true
    && (baseline?.git?.trackedChanges ?? ['missing']).length === 0
    && (baseline?.testBaseline?.total ?? 0) > 0 ? 'passed' : 'failed',
  detail: `base ${baseline?.git?.base?.slice(0, 7) ?? 'n/a'} -> head ${baseline?.git?.head?.slice(0, 7) ?? 'n/a'}; `
    + `tracked changes ${baseline?.git?.trackedChanges?.length ?? 'n/a'}; `
    + `archive ${baseline?.historicalEvidence?.r37bArchive?.sha256?.slice(0, 12) ?? 'missing'}…; `
    + `tests ${baseline?.testBaseline?.passed ?? 'n/a'}/${baseline?.testBaseline?.total ?? 'n/a'}`,
  evidence: 'eval/r38/out/baseline-manifest.json, eval/r38/out/baseline-tests.json',
})

gates.push({
  id: 'R38-G1',
  name: 'Relation authorization safety',
  status: relation?.status === 'passed'
    && relation?.summary?.passed === relation?.summary?.total
    && idempotency?.status === 'passed'
    && caseCertified('relation-authority-attack') ? 'passed' : 'failed',
  detail: `relation ${relation?.summary?.passed ?? 'n/a'}/${relation?.summary?.total ?? 'n/a'}; `
    + `idempotency ${idempotency?.summary?.passed ?? 'n/a'}/${idempotency?.summary?.total ?? 'n/a'}; `
    + `attack case ${caseOf('relation-authority-attack')?.status ?? 'missing'}`,
  evidence: 'eval/r38/out/relation-security-audit.json, eval/r38/out/revision-idempotency.json, eval/r38/out/mechanism-evaluation.json',
})

gates.push({
  id: 'R38-G2',
  name: 'Commit and supersession integrity',
  status: idempotency?.status === 'passed'
    && (integrity?.cases ?? []).find(row => row.id === 'n5-incomplete')?.pass === true
    && (integrity?.cases ?? []).find(row => row.id === 'n5-complete')?.pass === true
    && caseCertified('n5-cross-coordinate') ? 'passed' : 'failed',
  detail: `idempotency ${idempotency?.summary?.passed ?? 'n/a'}/${idempotency?.summary?.total ?? 'n/a'}; `
    + `N5 incomplete ${(integrity?.cases ?? []).find(row => row.id === 'n5-incomplete')?.pass ?? 'n/a'}, `
    + `complete ${(integrity?.cases ?? []).find(row => row.id === 'n5-complete')?.pass ?? 'n/a'}; `
    + `multi-fold ${caseOf('n5-cross-coordinate')?.status ?? 'missing'}`,
  evidence: 'eval/r38/out/revision-idempotency.json, eval/r38/out/integrity-audit.json',
})

gates.push({
  id: 'R38-G3',
  name: 'Integrity auditor validity',
  status: integrity?.status === 'passed'
    && integrity?.summary?.passed === integrity?.summary?.total
    && (integrity?.cases ?? []).find(row => row.id === 'n5-incomplete')
      ?.findings?.some(row => row.code === 'stale-negative-knowledge' && row.severity === 'requires-review') === true
    ? 'passed' : 'failed',
  detail: `auditor ${integrity?.summary?.passed ?? 'n/a'}/${integrity?.summary?.total ?? 'n/a'} cases; `
    + `N5 finding ${(integrity?.cases ?? []).find(row => row.id === 'n5-incomplete')
      ?.findings?.find(row => row.code === 'stale-negative-knowledge')?.severity ?? 'missing'}`,
  evidence: 'eval/r38/out/integrity-audit.json',
})

gates.push({
  id: 'R38-G4',
  name: 'Task-aware selection validity',
  status: workingSet?.status === 'passed'
    && workingSet?.summary?.passed === workingSet?.summary?.checks
    && (workingSet?.checks ?? []).find(row => row.id === 'greedy-rescues-smaller-candidate')?.pass === true
    && (workingSet?.checks ?? []).find(row => row.id === 'sets-are-disjoint-and-complete')?.pass === true
    && caseCertified('b2-v2-implementation-sensitive') ? 'passed' : 'failed',
  detail: `ablation ${workingSet?.summary?.passed ?? 'n/a'}/${workingSet?.summary?.checks ?? 'n/a'}; `
    + `greedy ${(workingSet?.checks ?? []).find(row => row.id === 'greedy-rescues-smaller-candidate')?.pass ?? 'n/a'}; `
    + `invariants ${(workingSet?.checks ?? []).find(row => row.id === 'sets-are-disjoint-and-complete')?.pass ?? 'n/a'}; `
    + `b2-v2 ${caseOf('b2-v2-implementation-sensitive')?.status ?? 'missing'}`,
  evidence: 'eval/r38/out/working-set-ablation.json',
})

gates.push({
  id: 'R38-G5',
  name: 'Archive recovery validity',
  status: recovery?.status === 'passed'
    && recovery?.summary?.passed === recovery?.summary?.checks
    && (recovery?.cases ?? []).find(row => row.id === 'archive-miss')?.recovery?.status === 'not-found-in-checked-scope'
    && (recovery?.cases ?? []).find(row => row.id === 'descriptor-budget')?.recovery?.status === 'coverage-not-assessed'
    && caseCertified('h1-production-region')
    && caseCertified('s1-authority-scope') ? 'passed' : 'failed',
  detail: `recovery ${recovery?.summary?.passed ?? 'n/a'}/${recovery?.summary?.checks ?? 'n/a'}; `
    + `miss ${(recovery?.cases ?? []).find(row => row.id === 'archive-miss')?.recovery?.status ?? 'n/a'}; `
    + `bound ${(recovery?.cases ?? []).find(row => row.id === 'descriptor-budget')?.recovery?.status ?? 'n/a'}; `
    + `H1 ${caseOf('h1-production-region')?.status ?? 'missing'}, S1 ${caseOf('s1-authority-scope')?.status ?? 'missing'}`,
  evidence: 'eval/r38/out/archive-recovery-ablation.json',
})

gates.push({
  id: 'R38-G6',
  name: 'Recent-tail and native delivery',
  status: tail?.status === 'passed'
    && tail?.summary?.passed === tail?.summary?.checks
    && native?.status === 'passed'
    && native?.summary?.passed === native?.summary?.checks
    && native?.journalModified === false
    && native?.checkpointRewritten === false ? 'passed' : 'failed',
  detail: `tail ${tail?.summary?.passed ?? 'n/a'}/${tail?.summary?.checks ?? 'n/a'}; `
    + `native ${native?.summary?.passed ?? 'n/a'}/${native?.summary?.checks ?? 'n/a'}; `
    + `journal modified ${native?.journalModified ?? 'n/a'}; checkpoint rewritten ${native?.checkpointRewritten ?? 'n/a'}`,
  evidence: 'eval/r38/out/recent-tail-consistency.json, eval/r38/out/native-context-smoke.json',
})

const m1Ready = existsSync(join(DOCS, 'R38_M1_PREREGISTRATION.md'))
gates.push({
  id: 'R38-G7',
  name: 'Product and experiment decision',
  status: mechanism?.status === 'passed'
    && mechanism?.summary?.certified === mechanism?.summary?.cases
    && mechanism?.summary?.unauthorizedRetirementObserved === 0
    && mechanism?.liveModelCalls === 0
    && r38Tests?.success === true
    && r38Tests?.numFailedTests === 0
    && m1Ready ? 'passed' : 'failed',
  detail: `mechanism ${mechanism?.summary?.certified ?? 'n/a'}/${mechanism?.summary?.cases ?? 'n/a'} certified; `
    + `safety blockers ${mechanism?.summary?.safetyBlockers ?? 'n/a'}, observed ${mechanism?.summary?.unauthorizedRetirementObserved ?? 'n/a'}; `
    + `live calls ${mechanism?.liveModelCalls ?? 'n/a'}; `
    + `tests ${r38Tests?.numPassedTests ?? 'n/a'}/${r38Tests?.numTotalTests ?? 'n/a'}; M1 prereg ${m1Ready}`,
  evidence: 'eval/r38/out/mechanism-evaluation.json, eval/r38/out/r38-tests.json, docs/semantic-continuity/R38_M1_PREREGISTRATION.md',
})

const eligibility = gateEvaluation(gates)
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R38-M0',
  status: eligibility.failed > 0 ? 'failed' : eligibility.eligible ? 'complete' : 'attention',
  eligibility,
  historicalEvidenceStatus: {
    r37bProductDecision: r37dGates?.productDecision ?? 'deployment-hold',
    r37cStage1Admission: r37cGates?.gates?.find(gate => gate.id === 'R37C-C1D')?.status ?? null,
    note: 'Historical status is not repaired by R38-M0.',
  },
  productDecision: 'deployment-hold',
  deploymentEligible: false,
  mechanismOutcome: 'safety-gate-passed; offline coverage improved; ready for a bounded live experiment',
  gates,
  notes: [
    'R38-M0 made no live model call.',
    'A safety gate that cannot be verified is not a pass.',
    'Offline coverage is not a product benefit.',
    'EF Active remains on deployment hold.',
  ],
}
await writeJson(OUT, report)

for (const gate of gates) {
  process.stdout.write(`${gate.id} ${gate.status.toUpperCase()}: ${gate.name}\n   ${gate.detail}\n`)
}
process.stdout.write(`eligibility ${JSON.stringify(eligibility)}\n`)
process.stdout.write(`product ${report.productDecision}; deploymentEligible ${report.deploymentEligible}\n`)
process.exit(exitCodeFor(gates))
