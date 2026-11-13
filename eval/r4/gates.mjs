#!/usr/bin/env node
/**
 * EF-R4 — gates evaluated from artifacts only.
 *
 * An `incomplete` gate is not a failure and is never promoted to pass. In the
 * offline stage R4-G6 is incomplete by design: no live budget-sensitivity run
 * is authorized. R4-G7 becomes pass only when the supported-lane CI reports
 * success.
 *
 *   EF_R4_CI_STATUS=success node eval/r4/gates.mjs
 *
 * @module eval/r4/gates
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const load = name => {
  const path = join(OUT, name)
  return existsSync(path) ? readJson(path) : null
}

const baseline = load('baseline-r4.json')
const scoringContract = load('scoring-contract.json')
const rescore = load('rescored-r3.json')
const evidenceContract = load('evidence-graph-contract.json')
const lifecycle = load('evidence-lifecycle.json')
const continuity = load('task-continuity.json')
const workingSet = load('working-set.json')
const candidate = load('candidate-decision.json')
const budget = load('budget-sensitivity-design.json')
const budgetPreflight = load('budget-manifest-preflight.json')
const liveAttempt = load('live-attempts-r4.json')
const budgetCampaign = load('budget-campaign-e2e-r4-budget-sensitivity-3.json')
const productDecision = load('product-decision-r4.json')
const zeroLive = load('zero-live-audit.json')
const claims = load('evidence-claims.json')

const ciStatus = process.env.EF_R4_CI_STATUS ?? 'pending'
const gates = []
const gate = (id, status, detail) => gates.push({ id, status, detail })

const unknownRate = lifecycle === null || lifecycle.totals.evidenceInstances === 0
  ? null
  : lifecycle.totals.unknown / lifecycle.totals.evidenceInstances
const stageBCells = continuity?.stageB?.cells ?? null
const candidateSelected = candidate?.selected ?? null
const selectedContractExists = candidateSelected === null || candidateSelected === 'none'
  ? true
  : existsSync(join(ROOT, 'eval', 'r4', 'candidate', `${candidateSelected}.mjs`))

gate('R4-G0',
  baseline !== null
    && baseline.immutableMissing?.length === 0
    && baseline.immutable?.length === 70
    && typeof baseline.git?.head === 'string'
    && baseline.git.head.length === 40
    ? 'pass' : 'fail',
`handoff ${baseline?.git?.headShort ?? 'missing'}; immutable ${baseline?.immutable?.length ?? '?'} (${baseline?.immutableMissing?.length ?? '?'} missing); R4 delta dirty at baseline generation ${baseline?.git?.worktreeClean === true ? 'no' : 'yes'}`)

gate('R4-G1',
  scoringContract?.passed === 8
    && rescore !== null
    && rescore.cells?.length === 18
    && rescore.assertions?.every(assertion => assertion.pass === true)
    && rescore.rescored?.B0?.taskCorrect === 5
    && rescore.rescored?.E0?.taskCorrect === 1
    && rescore.rescored?.E1?.taskCorrect === 3
    ? 'pass' : 'fail',
`contract ${scoringContract?.passed ?? '?'}/8; historical ${JSON.stringify(rescore?.historical ? Object.fromEntries(Object.entries(rescore.historical).map(([arm, row]) => [arm, row.historicalPass])) : null)}; rescored ${JSON.stringify(rescore?.rescored ? Object.fromEntries(Object.entries(rescore.rescored).map(([arm, row]) => [arm, row.taskCorrect])) : null)}`)

gate('R4-G2',
  evidenceContract?.passed === 11
    && lifecycle !== null
    && lifecycle.cells?.length === 18
    && lifecycle.totals?.evidenceInstances > 0
    && unknownRate !== null
    && unknownRate <= 0.25
    ? 'pass' : (evidenceContract?.passed === 11 && lifecycle !== null ? 'incomplete' : 'fail'),
`contract ${evidenceContract?.passed ?? '?'}/11; calls ${lifecycle?.totals?.recallCalls ?? '?'}; folded ${lifecycle?.totals?.folded ?? '?'}; refolded ${lifecycle?.totals?.refolded ?? '?'}; unknown ${lifecycle?.totals?.unknown ?? '?'} (${unknownRate === null ? '?' : (unknownRate * 100).toFixed(1)}%)`)

gate('R4-G3',
  continuity !== null
    && continuity.cells?.length === 18
    && stageBCells === 3
    && continuity.stageB?.taskBPresent === 3
    && candidate?.evidence?.passedWithLoss?.length === 0
    && candidate?.evidence?.failedWithLoss?.length >= 2
    ? 'pass' : 'fail',
`cells ${continuity?.cells?.length ?? '?'}; stageB ${stageBCells ?? '?'} (taskB present ${continuity?.stageB?.taskBPresent ?? '?'}); failed-with-loss ${candidate?.evidence?.failedWithLoss?.length ?? '?'}; passed-with-loss ${candidate?.evidence?.passedWithLoss?.length ?? '?'}`)

gate('R4-G4',
  workingSet !== null
    && workingSet.cells?.length === 18
    && workingSet.totals?.cells === 18
    && workingSet.cells.every(cell => cell.failureProjection !== null && cell.context !== null)
    ? 'pass' : 'fail',
`cells ${workingSet?.cells?.length ?? '?'}; repeated ${workingSet?.totals?.repeatedRecallCount ?? '?'}; re-fold ${workingSet?.totals?.recallResultReFoldCount ?? '?'}; task-lost ${workingSet?.totals?.taskInstructionLostRequests ?? '?'}; open failures ${workingSet?.totals?.openFailureCount ?? '?'}; duplicate ${workingSet?.totals?.duplicateFailureSignatures ?? '?'}`)

gate('R4-G5',
  candidate !== null
    && typeof candidate.selected === 'string'
    && candidate.contractOnly === true
    && candidate.notWired === true
    && selectedContractExists
    ? 'pass' : 'fail',
`selected ${candidateSelected ?? 'missing'}; contractOnly ${candidate?.contractOnly ?? '?'}; notWired ${candidate?.notWired ?? '?'}; contract ${selectedContractExists ? 'present' : 'missing'}`)

gate('R4-G6',
  budgetCampaign?.status === 'complete' && budgetCampaign?.executed === 36
    ? 'pass'
    : budget !== null && budget.executionAuthorized === false && budget.design?.cells === 36 ? 'incomplete' : 'fail',
`campaign ${budgetCampaign?.campaign ?? 'missing'}; status ${budgetCampaign?.status ?? 'missing'}; executed ${budgetCampaign?.executed ?? '?'}/${budgetCampaign?.planned ?? '?'}; stop ${budgetCampaign?.stopReason ?? 'none'}; tasks E1@8 ${budgetCampaign?.byArmBudget?.['E1-8']?.taskCorrect ?? '?'}/6, B0@8 ${budgetCampaign?.byArmBudget?.['B0-8']?.taskCorrect ?? '?'}/6`)

gate('R4-G7',
  ciStatus === 'success'
    && zeroLive?.verdict === 'zero-live-verified'
    && (claims?.claims?.length ?? 0) >= 10
    ? 'pass' : 'incomplete',
`ci ${ciStatus}; zero-live ${zeroLive?.verdict ?? 'missing'}; claims ${claims?.claims?.length ?? '?'}`)

gate('R4-G8',
  productDecision !== null
    && productDecision.productCandidate === null
    && productDecision.deploymentHold === true
    && productDecision.expandTo72 === false
    && productDecision.researchCandidateWired === false
    ? 'pass' : 'fail',
`productCandidate ${productDecision?.productCandidate === null ? 'null' : (productDecision?.productCandidate ?? 'missing')}; hold ${productDecision?.deploymentHold ?? '?'}; expand72 ${productDecision?.expandTo72 ?? '?'}; research ${productDecision?.researchCandidate ?? '?'} (wired ${productDecision?.researchCandidateWired ?? '?'})`)

const counts = {
  pass: gates.filter(entry => entry.status === 'pass').length,
  incomplete: gates.filter(entry => entry.status === 'incomplete').length,
  fail: gates.filter(entry => entry.status === 'fail').length,
}

const output = {
  schemaVersion: 1,
  work: 'EF-R4',
  generatedAt: new Date().toISOString(),
  head: baseline?.git?.head ?? null,
  ci: ciStatus,
  budgetPreflight: budgetPreflight === null ? null : {
    verdict: budgetPreflight.verdict,
    manifestSha256: budgetPreflight.manifest?.sha256 ?? null,
    providerCalls: budgetPreflight.providerCalls,
  },
  liveAttempt: liveAttempt === null ? null : {
    decision: liveAttempt.decision,
    attempts: liveAttempt.count,
    successes: liveAttempt.successes,
    planned: liveAttempt.planned,
    campaignStarted: liveAttempt.campaign?.started ?? null,
  },
  budgetCampaign: budgetCampaign === null ? null : {
    campaign: budgetCampaign.campaign,
    status: budgetCampaign.status,
    executed: budgetCampaign.executed,
    planned: budgetCampaign.planned,
    taskCorrect: {
      'B0@8': budgetCampaign.byArmBudget?.['B0-8']?.taskCorrect ?? null,
      'E1@8': budgetCampaign.byArmBudget?.['E1-8']?.taskCorrect ?? null,
      'E1@16': budgetCampaign.byArmBudget?.['E1-16']?.taskCorrect ?? null,
    },
  },
  gates,
  counts,
  note: 'incomplete is not fail. R4-G6 is pass only when the clean 36-cell campaign is complete; R4-G7 becomes pass only on a successful supported-lane CI run.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'gate-status.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`gates: ${counts.pass} pass, ${counts.incomplete} incomplete, ${counts.fail} fail\n`)
for (const entry of gates) process.stdout.write(`  ${entry.id} ${entry.status} — ${entry.detail}\n`)
if (counts.fail > 0) process.exit(1)
