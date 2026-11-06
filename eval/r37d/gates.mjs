#!/usr/bin/env node
/**
 * R37-D gates.
 *
 * D0 repository/evidence integrity
 * D1 operational metric validity
 * D2 protocol/action attribution
 * D3 fixed-context certification
 * D4 native runtime smoke
 * D5 process pilot readiness
 * D6 process pilot executed
 * D7 product decision
 *
 * Exit codes follow R37-C:
 *   0 all required gates passed
 *   1 a gate failed
 *   2 no failure, but a gate is partial/not-executed/ready-for-authorization
 *
 * The historical R37-B/R37-C status is reported separately from the current
 * stage readiness. A historical `gate-not-verifiable` does not become a pass,
 * and a current `ready-for-authorization` is not an execution.
 *
 * @module eval/r37d/gates
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readJson, writeJson } from '../r37/src/io.mjs'
import { exitCodeFor, gateEvaluation, machineProductOutcome } from '../r37c/src/gate-exit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'gate-status-r37d.json')

async function load(name, fallback = null) {
  const path = join(HERE, 'out', name)
  return await exists(path) ? await readJson(path) : fallback
}

const baseline = await load('baseline.json')
const audit = await load('r37c-audit.json')
const operational = await load('operational-completion.json')
const actionAccounting = await load('action-accounting.json')
const protocol = await load('protocol-efficiency.json')
const forensics = await load('b2-d1-action-forensics.json')
const fixed = await load('fixed-context-manifest.json')
const native = await load('native-extended.json')
const manifest = await load('process-pilot-manifest.json')
const preflight = await load('process-pilot-preflight.json')
const h1 = await load('h1-v2-audit.json')
const s1 = await load('s1-v1-validity.json')
const heldOut = await load('held-out-plan.json')
const tests = await load('r37d-tests.json')
const r37cGates = await exists(join(HERE, '..', 'r37c', 'out', 'gate-status-r37c.json'))
  ? await readJson(join(HERE, '..', 'r37c', 'out', 'gate-status-r37c.json'))
  : null
const r37bGates = await exists(join(HERE, '..', 'r37', 'out', 'gate-status-r37b-stage2.json'))
  ? await readJson(join(HERE, '..', 'r37', 'out', 'gate-status-r37b-stage2.json'))
  : null

const gates = []

gates.push({
  id: 'R37D-D0',
  name: 'Repository and evidence integrity',
  status: baseline?.status === 'passed'
    && baseline?.archive?.sha256Match === true
    && baseline?.archive?.bytesMatch === true
    && audit?.status === 'passed'
    && audit?.discrepancies?.length === 0
    && baseline?.evidence?.integrityStatus === 'passed' ? 'passed' : 'failed',
  detail: `R37-C ${baseline?.r37c?.branch ?? 'n/a'}@${baseline?.r37c?.head?.slice(0, 7) ?? 'n/a'}; `
    + `archive ${baseline?.archive?.sha256?.slice(0, 12) ?? 'missing'}…; `
    + `C2 ${audit?.c2?.summary?.cells ?? 'n/a'} cells; discrepancies ${audit?.discrepancies?.length ?? 'n/a'}`,
  evidence: 'eval/r37d/out/baseline.json, eval/r37d/out/r37c-audit.json',
})

gates.push({
  id: 'R37D-D1',
  name: 'Operational metric validity',
  status: operational?.c2?.summary?.rows === 24
    && operational?.c2?.summary?.legacyContractSuccesses === 19
    && operational?.c2?.summary?.operationalCompletions === 16
    && operational?.c2?.summary?.transitions?.legacyPassOperationalFail === 3
    && operational?.discrepancies?.length === 0 ? 'passed' : 'failed',
  detail: `C2 legacy contract ${operational?.c2?.summary?.legacyContractSuccesses ?? 'n/a'}, `
    + `operational ${operational?.c2?.summary?.operationalCompletions ?? 'n/a'}, `
    + `legacy-pass/operational-fail ${operational?.c2?.summary?.transitions?.legacyPassOperationalFail ?? 'n/a'}; `
    + `R37-B continuation ${operational?.r37bStage2?.summary?.rows ?? 'n/a'} rows, `
    + `legacy ${operational?.r37bStage2?.summary?.legacyContractSuccesses ?? 'n/a'}, `
    + `operational ${operational?.r37bStage2?.summary?.operationalCompletions ?? 'n/a'}`,
  evidence: 'eval/r37d/out/operational-completion.json',
})

gates.push({
  id: 'R37D-D2',
  name: 'Protocol and action attribution',
  status: actionAccounting?.cells?.length === 24
    && protocol?.overall?.modelCalls === 163
    && protocol?.overall?.noValidActionCalls === 46
    && Object.keys(protocol?.overall?.noValidActionClasses ?? {}).length >= 4
    && forensics?.D1?.summary?.failurePhase?.['tool-request-rejected'] === 1
    && forensics?.D1?.summary?.failurePhase?.['budget-exhausted-before-request'] === 1
    && typeof protocol?.multiActionSemantics?.policy === 'string' ? 'passed' : 'failed',
  detail: `model calls ${protocol?.overall?.modelCalls ?? 'n/a'}, no-valid ${protocol?.overall?.noValidActionCalls ?? 'n/a'}; `
    + `classes ${JSON.stringify(protocol?.overall?.noValidActionClasses ?? {})}; `
    + `D1 phases ${JSON.stringify(forensics?.D1?.summary?.failurePhase ?? {})}`,
  evidence: 'eval/r37d/out/action-accounting.json, eval/r37d/out/protocol-efficiency.json, eval/r37d/out/b2-d1-action-forensics.json',
})

gates.push({
  id: 'R37D-D3',
  name: 'Fixed-context certification',
  status: fixed?.verification?.fixtures === 4
    && fixed?.verification?.distinctCheckpointDigests === 4
    && fixed?.verification?.allSelectedAreG0R1 === true
    && fixed?.verification?.allCandidatesRecorded === true
    && fixed?.verification?.secretFindings === 0
    && fixed?.verification?.workspaceDigestsPresent === true ? 'passed' : 'failed',
  detail: `fixtures ${fixed?.verification?.fixtures ?? 'n/a'}, `
    + `distinct digests ${fixed?.verification?.distinctCheckpointDigests ?? 'n/a'}, `
    + `G0/r1 ${fixed?.verification?.allSelectedAreG0R1 ?? 'n/a'}, `
    + `candidates ${fixed?.verification?.allCandidatesRecorded ?? 'n/a'}, `
    + `secrets ${fixed?.verification?.secretFindings ?? 'n/a'}`,
  evidence: 'eval/r37d/out/fixed-context-manifest.json',
})

gates.push({
  id: 'R37D-D4',
  name: 'Native runtime extension',
  status: native?.n3?.status === 'passed'
    && native?.n4?.status === 'passed'
    && (native?.n4?.notStarted?.codes ?? []).includes('TOOL_NOT_STARTED')
    && (native?.n4?.started?.codes ?? []).includes('TOOL_OUTCOME_UNKNOWN')
    && native?.n5?.status === 'passed'
    && native?.n5?.journal?.proofValid === true ? 'passed' : 'failed',
  detail: `N3 ${native?.n3?.status ?? 'n/a'} (${native?.n3?.counts?.toolCalls ?? 'n/a'} calls); `
    + `N4 ${native?.n4?.status ?? 'n/a'} (${(native?.n4?.notStarted?.codes ?? []).join(',') || 'n/a'}, `
    + `${(native?.n4?.started?.codes ?? []).join(',') || 'n/a'}); `
    + `N5 ${native?.n5?.status ?? 'n/a'} (journal ${native?.n5?.journal?.committedPackets ?? 'n/a'} commits, `
    + `proof ${native?.n5?.journal?.proofValid ?? 'n/a'})`,
  evidence: 'eval/r37d/out/native-extended.json',
})

const d5Status = preflight === null
  ? 'not-executed'
  : preflight.status === 'passed' ? 'passed'
    : preflight.status === 'ready-for-authorization' ? 'ready-for-authorization'
      : 'failed'
gates.push({
  id: 'R37D-D5',
  name: 'Process pilot readiness',
  status: d5Status,
  detail: `${manifest?.cells?.length ?? 0}/24 cells; `
    + `authorization ${manifest?.authorization?.granted === true ? 'granted' : 'not granted'}; `
    + `runner ${preflight?.runner?.status ?? 'n/a'}; `
    + `failed checks ${(preflight?.checks ?? []).filter(check => check.status === 'failed').length}`,
  evidence: 'eval/r37d/out/process-pilot-manifest.json, eval/r37d/out/process-pilot-preflight.json',
})

gates.push({
  id: 'R37D-D6',
  name: 'Process pilot executed',
  status: await exists(join(HERE, 'out', 'process-pilot-results.json')) ? 'passed' : 'not-executed',
  detail: await exists(join(HERE, 'out', 'process-pilot-results.json'))
    ? 'a live result artifact exists'
    : 'no live result artifact; the batch is ready-for-authorization',
  evidence: 'eval/r37d/out/process-pilot-results.json',
})

const statistics = await exists(join(HERE, '..', 'r37c', 'out', 'statistics-audit.json'))
  ? await readJson(join(HERE, '..', 'r37c', 'out', 'statistics-audit.json'))
  : null
const product = machineProductOutcome({
  rescue: statistics?.contract?.rescue ?? 0,
  damage: statistics?.contract?.damage ?? 0,
  p: statistics?.contract?.mcnemar?.p ?? 1,
  deliveryRate: 0.8,
})
gates.push({
  id: 'R37D-D7',
  name: 'Product decision',
  status: product === 'active-benefit-signal' ? 'failed' : 'passed',
  detail: `EF Active deployment hold; machine outcome ${product}; `
    + `R37-B contract ${statistics?.contract?.rescue ?? 'n/a'}/${statistics?.contract?.damage ?? 'n/a'} `
    + `p=${statistics?.contract?.mcnemar?.p ?? 'n/a'}`,
  evidence: 'eval/r37c/out/statistics-audit.json',
})

const eligibility = gateEvaluation(gates)
const r37cAdmission = r37cGates?.gates?.find(gate => gate.id === 'R37C-C1D')?.status ?? null
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  status: eligibility.failed > 0 ? 'failed' : eligibility.eligible ? 'complete' : 'attention',
  eligibility,
  historicalEvidenceStatus: {
    r37bProductDecision: r37bGates?.productDecision ?? 'deployment-hold',
    r37cStage1Admission: r37cAdmission,
    note: 'Historical status is not repaired by R37-D.',
  },
  currentStageReadiness: {
    d5: d5Status,
    d6: gates.find(gate => gate.id === 'R37D-D6')?.status ?? 'unknown',
    note: 'The process batch is ready for authorization, not executed.',
  },
  productDecision: 'deployment-hold',
  machineProductOutcome: product,
  productRationale: 'R37-B contract harm remains; the R37-C metric correction found no Active benefit; '
    + 'the C2 guard had no opportunity in any failing cell; the R37-D process batch is not executed.',
  tests: {
    total: tests?.numTotalTests ?? 0,
    passed: tests?.numPassedTests ?? 0,
    failed: tests?.numFailedTests ?? 0,
    success: tests?.success === true,
  },
  benchmark: {
    h1v2: h1?.status ?? null,
    s1v1: s1?.status ?? null,
    heldOutCertified: heldOut?.counts?.certified ?? null,
    heldOutSpecified: heldOut?.counts?.specified ?? null,
  },
  gates,
  notes: [
    'A gate-not-verifiable status is not a pass.',
    'A ready-for-authorization batch is not an execution.',
    'The historical R37-B/R37-C conclusions are not rewritten.',
  ],
}
await writeJson(OUT, report)

for (const gate of gates) {
  process.stdout.write(`${gate.id} ${gate.status.toUpperCase()}: ${gate.name}\n   ${gate.detail}\n`)
}
process.stdout.write(`eligibility ${JSON.stringify(eligibility)}\n`)
process.stdout.write(`product ${report.productDecision}; machine ${product}; tests ${report.tests.passed}/${report.tests.total}\n`)
process.exit(exitCodeFor(gates))
