#!/usr/bin/env node
/**
 * R37-C gates.
 *
 * A gate is computed from an artifact, not declared in prose. The report
 * separates:
 *
 *   evaluated   the artifact exists and was read
 *   passed      the criterion is satisfied
 *   eligible    every required gate passed
 *
 * Exit codes:
 *   0 all required gates passed
 *   1 a gate failed
 *   2 no failure, but a gate is partial/not-executed/blocked/gate-not-verifiable
 *
 * The Stage 1 admission gate is `gate-not-verifiable` because the historical
 * trace cap and the wrong metric prevent an exact reconstruction. That is a
 * property of the historical record, not a reason to call the stage passed.
 *
 * @module eval/r37c/gates
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readJson, writeJson } from '../r37/src/io.mjs'
import { exitCodeFor, gateEvaluation } from './src/gate-exit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'gate-status-r37c.json')

async function load(name, fallback = null) {
  const path = join(HERE, 'out', name)
  return await exists(path) ? await readJson(path) : fallback
}

const baseline = await load('evidence-integrity.json')
const inventory = await load('evidence-inventory.json')
const archive = await load('evidence-archive.json')
const funnel = await load('semantic-funnel-audit.json')
const measurement = await load('measurement-vs-pipeline.json')
const statistics = await load('statistics-audit.json')
const protocol = await load('protocol-admission.json')
const native = await load('native-smoke.json')
const h1v2 = await load('h1-v2-validity.json')
const c2 = await load('r37c-c2-results.json')
const c2analysis = await load('r37c-c2-analysis.json')
const tests = await load('r37c-tests.json')

const gates = []

gates.push({
  id: 'R37C-C0A',
  name: 'Evidence preservation',
  status: baseline?.status === 'passed'
    && archive?.status === 'archived'
    && baseline?.secrets?.findings === 0
    && baseline?.cellMatrix?.missing?.length === 0
    && baseline?.cellMatrix?.unexpected?.length === 0 ? 'passed' : 'failed',
  detail: `${inventory?.totals?.runs ?? 0} runs, ${inventory?.totals?.rows ?? 0} rows, `
    + `${inventory?.totals?.files ?? 0} files; cells ${baseline?.cellMatrix?.uniqueObserved ?? 0}/`
    + `${baseline?.cellMatrix?.expectedUnique ?? 0}; secrets ${baseline?.secrets?.findings ?? 'n/a'}; `
    + `archive ${archive?.archive?.sha256?.slice(0, 12) ?? 'missing'}…`,
  evidence: 'eval/r37c/out/evidence-integrity.json, eval/r37c/out/evidence-archive.json',
})

gates.push({
  id: 'R37C-C0B',
  name: 'Semantic funnel correction',
  status: funnel?.discrepancies?.count === 0
    && typeof funnel?.byPrompt?.W1?.funnel?.byStage?.committed === 'number'
    && funnel?.overall?.criticalRecallField?.missing === 0
    && funnel?.acceptedButNotCommitted?.rows === 14 ? 'passed' : 'failed',
  detail: `W1 accepted ${funnel?.byPrompt?.W1?.oldAcceptedRecall?.toFixed(3) ?? 'n/a'} vs committed `
    + `${funnel?.byPrompt?.W1?.funnel?.byStage?.committed?.toFixed(3) ?? 'n/a'}; `
    + `accepted-but-not-committed rows ${funnel?.acceptedButNotCommitted?.rows ?? 'n/a'}; `
    + `criticalRecall missing ${funnel?.overall?.criticalRecallField?.missing ?? 'n/a'}, `
    + `zero ${funnel?.overall?.criticalRecallField?.zeroValue ?? 'n/a'}`,
  evidence: 'eval/r37c/out/semantic-funnel-audit.json',
})

gates.push({
  id: 'R37C-C0C',
  name: 'Measurement vs pipeline',
  status: measurement?.recomputed?.providerInvalid === 2
    && measurement?.recomputed?.foldRefused === 9
    && (measurement?.assignedArm?.S?.rows ?? 0) > 0
    && (measurement?.assignedArm?.S?.pipeline?.['fold-refused'] ?? 0) > 0 ? 'passed' : 'failed',
  detail: `reported invalid ${measurement?.reportedInvalidMeasurements ?? 'n/a'}; `
    + `provider-invalid ${measurement?.recomputed?.providerInvalid ?? 'n/a'}; `
    + `fold-refused ${measurement?.recomputed?.foldRefused ?? 'n/a'}; `
    + `assigned-arm S rows ${measurement?.assignedArm?.S?.rows ?? 'n/a'}`,
  evidence: 'eval/r37c/out/measurement-vs-pipeline.json',
})

gates.push({
  id: 'R37C-C0D',
  name: 'Statistics audit',
  status: statistics?.contract?.mcnemar?.p === 0.021484375
    && statistics?.contract?.caseDirection?.negative === 5
    && statistics?.contract?.signTest?.p === 0.0625
    && statistics?.interpretation?.leaveOneCaseOutPRange?.[0] === 0.0078125
    && statistics?.interpretation?.leaveOneCaseOutPRange?.[1] === 0.0703125 ? 'passed' : 'failed',
  detail: `contract ${statistics?.contract?.rescue ?? 'n/a'}/${statistics?.contract?.damage ?? 'n/a'}, `
    + `p=${statistics?.contract?.mcnemar?.p ?? 'n/a'}; cases `
    + `${statistics?.contract?.caseDirection?.negative ?? 'n/a'} negative / `
    + `${statistics?.contract?.caseDirection?.flat ?? 'n/a'} flat; `
    + `sign p=${statistics?.contract?.signTest?.p ?? 'n/a'}; LOO p `
    + `${statistics?.interpretation?.leaveOneCaseOutPRange?.join('–') ?? 'n/a'}`,
  evidence: 'eval/r37c/out/statistics-audit.json',
})

gates.push({
  id: 'R37C-C1A',
  name: 'DSML byte fidelity',
  status: tests?.success === true && tests?.numPassedTests >= 55 ? 'passed' : 'failed',
  detail: `${tests?.numPassedTests ?? 0}/${tests?.numTotalTests ?? 0} R37-C tests passed; `
    + 'direct and parameter forms round-trip the fidelity corpus; ambiguous input is rejected',
  evidence: 'eval/r37c/out/r37c-tests.json, eval/r37c/src/dsml-codec.mjs',
})

gates.push({
  id: 'R37C-C1B',
  name: 'No-valid-action attribution',
  status: protocol?.stage2?.totals?.turns === 903
    && protocol?.stage2?.totals?.completedSteps === 819
    && protocol?.stage2?.totals?.storedNoValidTurns === 216
    && Object.keys(protocol?.stage2?.noAction?.byClass ?? {}).length >= 3 ? 'passed' : 'failed',
  detail: `model calls ${protocol?.stage2?.totals?.turns ?? 'n/a'}, completed steps `
    + `${protocol?.stage2?.totals?.completedSteps ?? 'n/a'}, stored no-valid `
    + `${protocol?.stage2?.totals?.storedNoValidTurns ?? 'n/a'}; classes `
    + `${JSON.stringify(protocol?.stage2?.noAction?.byClass ?? {})}`,
  evidence: 'eval/r37c/out/protocol-admission.json',
})

gates.push({
  id: 'R37C-C1C',
  name: 'Native lifecycle',
  status: native?.n0?.status === 'passed'
    && native?.n1?.status === 'passed'
    && native?.n2?.status === 'passed'
    && native?.n0?.counts?.repairs === 0
    && native?.n2?.native?.counts?.repairs === 0 ? 'passed' : 'failed',
  detail: `N0 ${native?.n0?.status ?? 'n/a'}, N1 ${native?.n1?.status ?? 'n/a'}, `
    + `N2 ${native?.n2?.status ?? 'n/a'}; root cause ${native?.rootCause?.symptom ?? 'n/a'} -> `
    + `${native?.rootCause?.fix ?? 'n/a'}`,
  evidence: 'eval/r37c/out/native-smoke.json',
})

gates.push({
  id: 'R37C-C1D',
  name: 'Stage 1 admission',
  status: protocol?.stage1?.admission?.status ?? 'not-executed',
  detail: `preregistered turn-level rejection <= 10%; implemented gate was unparsedTurnRate; `
    + `authoritative action rejection ${protocol?.stage1?.authoritative?.actionRejectionRate ?? 'n/a'}, `
    + `unparsed ${protocol?.stage1?.authoritative?.unparsedTurnRate ?? 'n/a'}; `
    + `status ${protocol?.stage1?.admission?.status ?? 'n/a'}`,
  evidence: 'eval/r37c/out/protocol-admission.json',
})

gates.push({
  id: 'R37C-C2',
  name: 'Bounded process pilot',
  status: c2?.status === 'complete' ? 'passed' : c2 === null ? 'not-executed' : 'partial',
  detail: c2 === null
    ? 'no C2 result artifact'
    : `${c2.results?.length ?? 0}/${c2.plan?.cells ?? 'n/a'} cells; status ${c2.status}; `
      + `stop ${c2.stopReason ?? 'none'}; usage ${JSON.stringify(c2.budget?.used ?? {})}; `
      + `analysis ${c2analysis === null ? 'missing' : 'present'}`,
  evidence: 'eval/r37c/out/r37c-c2-results.json, eval/r37c/out/r37c-c2-analysis.json',
})

gates.push({
  id: 'R37C-C3',
  name: 'Benchmark and next-stage readiness',
  status: h1v2?.certified === true
    && await exists(join(HERE, '..', '..', 'docs', 'semantic-continuity', 'R37C_NEXT_PREREGISTRATION.md'))
    ? 'passed' : 'failed',
  detail: `H1-v2 ${h1v2?.status ?? 'n/a'}; visible test names fact `
    + `${h1v2?.properties?.visibleTestDoesNotNameFact === true ? 'no' : 'yes'}; `
    + `reference ${h1v2?.runs?.reference?.visible?.exitCode ?? 'n/a'}/`
    + `${h1v2?.runs?.reference?.hidden?.exitCode ?? 'n/a'}; `
    + `counterfactual ${h1v2?.runs?.counterfactual?.visible?.exitCode ?? 'n/a'}/`
    + `${h1v2?.runs?.counterfactual?.hidden?.exitCode ?? 'n/a'}`,
  evidence: 'eval/r37c/out/h1-v2-validity.json, docs/semantic-continuity/R37C_NEXT_PREREGISTRATION.md',
})

const productDecision = 'deployment-hold'
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  status: gates.every(gate => gate.status === 'passed') ? 'complete' : 'attention',
  eligibility: gateEvaluation(gates),
  productDecision,
  productRationale: 'R37-B contract harm signal remains; R37-C corrected the metrics and found no Active benefit. '
    + 'The C2 guard pilot is exploratory and does not change the hold.',
  gates,
  notes: [
    'A gate-not-verifiable status is not a pass.',
    'A partial C2 pilot is not a product result.',
    'The Stage 1 admission deviation is historical and is not repaired by a new threshold.',
  ],
}
await writeJson(OUT, report)

for (const gate of gates) {
  process.stdout.write(`${gate.id} ${gate.status.toUpperCase()}: ${gate.name}\n   ${gate.detail}\n`)
}
process.stdout.write(`eligibility ${JSON.stringify(report.eligibility)}\n`)
process.exit(exitCodeFor(gates))
