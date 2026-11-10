#!/usr/bin/env node
/**
 * EF-R2 — the round's gates, evaluated from artifacts only.
 *
 * A gate is a claim about evidence, not a checkbox. Each check reads a file
 * that another script produced; none of them trusts a summary string.
 *
 *   EF_R2_CI_STATUS=success node eval/r2/gates.mjs
 *
 * @module eval/r2/gates
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const has = path => existsSync(join(ROOT, path))
const load = name => {
  const path = join(OUT, name)
  return existsSync(path) ? readJson(path) : null
}

const baseline = load('baseline.json')
const contract = load('witness-contract.json')
const witnesses = load('compaction-witnesses.json')
const attribution = load('rationale-failure-attribution.json')
const delivery = load('active-task-delivery.json')
const causal = load('causal-reanalysis.json')
const cost = load('cost-ledger.json')
const authority = load('authority-closure.json')
const design = load('live-design-r2.json')
const livePilot = load('live-pilot-analysis.json')
const liveConfirm = load('live-confirm-analysis.json')
const routeIncident = load('live-route-incident.json')
const claims = load('evidence-claims.json')
const archive = has('eval/r2/out/research-archive-r2.json') ? readJson(join(ROOT, 'eval', 'r2', 'out', 'research-archive-r2.json')) : null
const archiveVerify = has('eval/r2/out/archive-verification-r2.json') ? readJson(join(ROOT, 'eval', 'r2', 'out', 'archive-verification-r2.json')) : null
const archiveCopy = has('eval/r2/out/archive-verification-r2-copy.json') ? readJson(join(ROOT, 'eval', 'r2', 'out', 'archive-verification-r2-copy.json')) : null

const ciStatus = process.env.EF_R2_CI_STATUS ?? 'pending'
const gates = []
const gate = (id, status, detail) => gates.push({ id, status, detail })

gate('R2-G0', baseline !== null && baseline.git?.head !== null && archive !== null && archiveVerify?.verdict === 'archive-verified'
  ? 'pass' : 'fail',
`baseline ${baseline?.git?.head?.slice(0, 8) ?? 'missing'}; R1 pointer ${baseline?.pointers?.r1Archive ? 'present' : 'missing'}; R2 archive ${archiveVerify?.verdict ?? 'missing'}`)

gate('R2-G1', contract?.pass === true && witnesses !== null
  ? 'pass' : 'fail',
`witness contract ${contract?.passed ?? '?'}/${contract?.checks ?? '?'}; history ${witnesses?.totals?.cells ?? '?'} cells, ${witnesses?.totals?.attempts ?? '?'} attempts, ${witnesses?.totals?.committed ?? '?'} committed; ${witnesses?.totals?.cellsWithDiscrepancies ?? '?'} discrepancy cells`)

gate('R2-G2',
  attribution?.e1?.failed === 31
    && attribution?.e1?.byReason?.['shrink-refusal'] === 31
    && (attribution?.e1?.finishKinds?.stop ?? 0) === 31
    && Object.keys(attribution?.e1?.byReason ?? {}).length === 1
    ? 'pass' : 'fail',
`${attribution?.e1?.failed ?? '?'} failed; ${attribution?.e1?.byReason?.['shrink-refusal'] ?? '?'} shrink; finishes ${JSON.stringify(attribution?.e1?.finishKinds ?? {})}`)

gate('R2-G2.5',
  attribution?.decision?.productionFix === 'none'
    && attribution?.decision?.preCallShrinkGuardJustified === false
    && attribution?.decision?.retrySuppressionJustified === false
    ? 'pass' : 'fail',
`production fix ${attribution?.decision?.productionFix ?? '?'}; pre-call guard ${attribution?.decision?.preCallShrinkGuardJustified ?? '?'}; retry suppression ${attribution?.decision?.retrySuppressionJustified ?? '?'}`)

gate('R2-G3',
  delivery?.legacyConfirm?.reproduced === true
    && delivery?.coverage?.fullMessages > 0
    && delivery?.recertifiedConfirm !== undefined
    ? 'pass' : 'fail',
`legacy ${delivery?.legacyConfirm?.taskPromptLost ?? '?'}/120 reproduced ${delivery?.legacyConfirm?.reproduced ?? '?'}; full messages ${delivery?.coverage?.fullMessages ?? '?'}; exact lost ${delivery?.recertifiedConfirm?.originalLost ?? '?'}; values unavailable ${delivery?.recertifiedConfirm?.semanticsUnavailable ?? '?'}`)

gate('R2-G4',
  cost?.reconciliation?.matches === true
    && cost?.rationale?.calls === 42
    && cost?.caps?.rationaleMaxTokensObserved === 16_384
    ? 'pass' : 'fail',
`reconciliation ${cost?.reconciliation?.matches ?? '?'}; rationale calls ${cost?.rationale?.calls ?? '?'}; failed cost ${cost?.rationale?.failedCalls?.inputTokens ?? '?'} in / ${cost?.rationale?.failedCalls?.outputTokens ?? '?'} out`)

gate('R2-G5',
  authority?.mixedOrigin?.oldLogic?.verdict === 'allowed'
    && authority?.mixedOrigin?.newLogic?.verdict === 'refused'
    && authority?.mixedOrigin?.newLogic?.sourceAuthority === 'assistant'
    && authority?.mixedOrigin?.regressionGate?.tests === 12
    && authority?.anchorService?.suppliedUserLabelWithAssistantEvidence !== null
    && authority?.anchorService?.omittedLabelDerived === 'assistant'
    && (authority?.retireAudit?.retireReferences?.length ?? 0) === 0
    ? 'pass' : 'fail',
`old ${authority?.mixedOrigin?.oldLogic?.verdict ?? '?'} -> new ${authority?.mixedOrigin?.newLogic?.verdict ?? '?'}; tests ${authority?.mixedOrigin?.regressionGate?.tests ?? '?'}; retire refs ${authority?.retireAudit?.retireReferences?.length ?? '?'}`)

gate('R2-G6', ciStatus === 'success' ? 'pass' : ciStatus === 'pending' ? 'pending' : 'fail',
`supported CI ${ciStatus}; the master probe remains non-blocking by design`)

gate('R2-G7',
  has('docs/convergence/EF_R2.md')
    && (claims?.missing?.length ?? 1) === 0
    && design?.executionAuthorized === false
    ? 'pass' : 'fail',
`EF_R2.md ${has('docs/convergence/EF_R2.md') ? 'present' : 'missing'}; claims missing ${claims?.missing?.length ?? '?'}; live authorized ${design?.executionAuthorized ?? '?'}`)

gate('R2-G8',
  livePilot?.executed === 18
    && livePilot?.feasibility?.e1CellsWithCommit === 6
    && livePilot?.feasibility?.e1CellsWithDelivery === 6
    && livePilot?.feasibility?.e1Refused === 0
    && livePilot?.feasibility?.e1Aborted === 0
    ? 'pass' : 'fail',
`pilot ${livePilot?.executed ?? '?'}/18; E1 commit ${livePilot?.feasibility?.e1CellsWithCommit ?? '?'}/6, delivered ${livePilot?.feasibility?.e1CellsWithDelivery ?? '?'}/6, refused ${livePilot?.feasibility?.e1Refused ?? '?'}, aborted ${livePilot?.feasibility?.e1Aborted ?? '?'}`)

gate('R2-G9',
  liveConfirm?.executed === routeIncident?.validCells
    && routeIncident?.validCells !== undefined
    && routeIncident.validCells < 54
    ? 'incomplete' : 'fail',
`confirm ${routeIncident?.validCells ?? '?'}/54 valid; ${routeIncident?.invalidCells ?? '?'} transport-failed, ${routeIncident?.unexecutedCells ?? '?'} unexecuted; no further live calls until the route is stable`)

const output = {
  schemaVersion: 1,
  work: 'EF-R2',
  generatedAt: new Date().toISOString(),
  gates,
  counts: {
    pass: gates.filter(entry => entry.status === 'pass').length,
    pending: gates.filter(entry => entry.status === 'pending').length,
    incomplete: gates.filter(entry => entry.status === 'incomplete').length,
    fail: gates.filter(entry => entry.status === 'fail').length,
  },
  sources: {
    baseline: 'eval/r2/out/baseline.json',
    contract: 'eval/r2/out/witness-contract.json',
    witnesses: 'eval/r2/out/compaction-witnesses.json',
    attribution: 'eval/r2/out/rationale-failure-attribution.json',
    delivery: 'eval/r2/out/active-task-delivery.json',
    causal: 'eval/r2/out/causal-reanalysis.json',
    cost: 'eval/r2/out/cost-ledger.json',
    authority: 'eval/r2/out/authority-closure.json',
    design: 'eval/r2/out/live-design-r2.json',
    claims: 'eval/r2/out/evidence-claims.json',
  },
  ci: {
    status: ciStatus,
    note: 'Set EF_R2_CI_STATUS after the supported-lane run. The master probe is non-blocking and is not a gate.',
  },
  note: 'A gate is evaluated from the artifact it names. No unknown is promoted to a pass.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'gate-status.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
for (const entry of gates) process.stdout.write(`${entry.id} ${entry.status.toUpperCase()} — ${entry.detail}\n`)
process.stdout.write(`${output.counts.pass} pass, ${output.counts.pending} pending, ${output.counts.incomplete} incomplete, ${output.counts.fail} fail\n`)
if (output.counts.fail > 0) process.exit(1)
