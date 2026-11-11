#!/usr/bin/env node
/**
 * EF-R3 — the round's gates, evaluated from artifacts only.
 *
 * A gate is a claim about evidence, not a checkbox. No unknown is promoted to a
 * pass. R3-G2 and R3-G5 are `incomplete` in the offline phase: route stability
 * is not verified and the confirm is not complete. They can only become pass
 * under a new live authorization.
 *
 *   EF_R3_CI_STATUS=success node eval/r3/gates.mjs
 *
 * @module eval/r3/gates
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const load = name => {
  const path = join(OUT, name)
  return existsSync(path) ? readJson(path) : null
}
const has = path => existsSync(join(ROOT, path))

const baseline = load('baseline-r3.json')
const reconciliation = load('live-confirm-reconciliation.json')
const ledgerContract = load('ledger-contract.json')
const transport = load('transport-diagnosis.json')
const transportContract = load('transport-contract.json')
const healthProbe = load('transport-health-probe.json')
const span = load('span-economics.json')
const frontier = load('product-frontier.json')
const decision = load('product-decision.json')
const configHistorical = load('config-preflight.json')
const configForwarded = load('config-preflight-forwarded.json')
const presetEvidence = load('preset-evidence.json')
const completion = load('completion-design-r3.json')
const termination = load('confirm-termination.json')
const productLane = load('product-lane-design-r3.json')
const archivePointer = load('research-archive-r2-live.json')
const archiveVerify = load('archive-verification-r2-live.json')
const archiveCopyVerify = load('archive-verification-r2-live-copy.json')
const zeroLive = load('zero-live-audit.json')
const claims = load('evidence-claims.json')

const ciStatus = process.env.EF_R3_CI_STATUS ?? 'pending'
const gates = []
const gate = (id, status, detail) => gates.push({ id, status, detail })

const corrected = reconciliation?.corrected ?? null
const missingByTemplate = corrected?.missingByTemplate ?? null
const pilotComparison = frontier?.pilot?.comparisons?.find(entry => entry.left === 'E1' && entry.right === 'B0') ?? null
const confirmComparison = frontier?.confirm?.comparisons?.find(entry => entry.left === 'E1' && entry.right === 'B0') ?? null
const pilotMatches = frontier?.userNumberVerification?.pilot?.matches ?? null
const confirmMatches = frontier?.userNumberVerification?.confirm?.matches ?? null
const allTrue = value => value !== null && Object.values(value).every(Boolean)

gate('R3-G0',
  baseline !== null
    && baseline.immutableMissing?.length === 0
    && baseline.immutable?.length === 22
    && archiveVerify?.verdict === 'archive-verified'
    && archiveCopyVerify?.verdict === 'archive-verified'
    ? 'pass' : 'fail',
`baseline ${baseline?.git?.head?.slice(0, 8) ?? 'missing'}; immutable ${baseline?.immutable?.length ?? '?'} (${baseline?.immutableMissing?.length ?? '?'} missing); archive ${archiveVerify?.verdict ?? 'missing'}; copy ${archiveCopyVerify?.verdict ?? 'missing'}`)

gate('R3-G1',
  corrected?.valid === 23
    && corrected?.unresolved === 1
    && corrected?.neverStarted === 30
    && corrected?.noValidOutcome === 31
    && corrected?.attempts === 25
    && corrected?.transportFailedAttempts === 2
    && corrected?.uniqueCellsStarted === 24
    && missingByTemplate?.T13 === 4
    && missingByTemplate?.T14 === 9
    && missingByTemplate?.T15 === 9
    && missingByTemplate?.T16 === 9
    && ledgerContract?.passed === 19
    ? 'pass' : 'fail',
`${corrected?.valid ?? '?'} valid, ${corrected?.unresolved ?? '?'} unresolved, ${corrected?.neverStarted ?? '?'} never-started, ${corrected?.noValidOutcome ?? '?'} no-valid-outcome; attempts ${corrected?.attempts ?? '?'} (${corrected?.transportFailedAttempts ?? '?'} transport); missing ${JSON.stringify(missingByTemplate ?? {})}; contract ${ledgerContract?.passed ?? '?'}/${ledgerContract?.checks?.length ?? '?'}`)

gate('R3-G2',
  transport?.failureCount === 2
    && transport?.classification?.retriedSuccessfully === 1
    && transport?.classification?.unresolved === 1
    && transport?.classification?.immediate === true
    && transportContract?.passed === 13
    && healthProbe?.executionAuthorized === false
    ? 'incomplete' : 'fail',
`${transport?.failureCount ?? '?'} transport failures, ${transport?.classification?.retriedSuccessfully ?? '?'} retried, ${transport?.classification?.unresolved ?? '?'} unresolved; contract ${transportContract?.passed ?? '?'}/${transportContract?.checks?.length ?? '?'}; health probe authorized ${healthProbe?.executionAuthorized ?? '?'}; live stability not verified`)

gate('R3-G3',
  span?.summary?.cases === 60
    && span?.summary?.byRetainRatio?.['0.04']?.medianGap === 516
    && span?.summary?.byRetainRatio?.['0.16']?.medianGap === 2064
    && span?.summary?.byRetainRatio?.['0.24']?.medianGap === 3096
    && span?.summary?.floorSensitivityFalseAdmissions === 3
    && span?.findings?.gapIsSystematic === true
    && has('src/policy/leaf-span-probe.ts')
    && has('tests/r3-leaf-span-probe.spec.ts')
    ? 'pass' : 'fail',
`${span?.summary?.cases ?? '?'} cases; median gap ${span?.summary?.gaps?.median ?? '?'}; by retain ${JSON.stringify(span?.summary?.byRetainRatio ?? {})}; floor-sensitivity false admissions ${span?.summary?.floorSensitivityFalseAdmissions ?? '?'}; probe ${has('src/policy/leaf-span-probe.ts') ? 'present' : 'missing'}`)

gate('R3-G4',
  allTrue(pilotMatches)
    && allTrue(confirmMatches)
    && frontier?.confirm?.eligibility?.costInvalid === 3
    && frontier?.pilot?.eligibility?.costInvalid === 3
    && confirmComparison?.costValid?.pairs === 5
    && pilotComparison?.costValid?.pairs === 4
    && (frontier?.limits?.length ?? 0) > 0
    ? 'pass' : 'fail',
`user numbers pilot ${JSON.stringify(pilotMatches)} confirm ${JSON.stringify(confirmMatches)}; cost-invalid cells confirm ${frontier?.confirm?.eligibility?.costInvalid ?? '?'}, pilot ${frontier?.pilot?.eligibility?.costInvalid ?? '?'}; cost-valid pairs confirm ${confirmComparison?.costValid?.pairs ?? '?'}, pilot ${pilotComparison?.costValid?.pairs ?? '?'}`)

gate('R3-G5',
  termination?.decision === 'terminated-partial'
    && termination?.furtherLiveCalls === false
    && termination?.counts?.valid === 23
    && termination?.counts?.unresolved === 1
    && termination?.counts?.neverStarted === 30
    && termination?.counts?.noValidOutcome === 31
    && completion?.executionAuthorized === false
    && completion?.counts?.completionCells === 31
    ? 'pass' : 'fail',
`confirm ${termination?.decision ?? '?'}: ${termination?.counts?.valid ?? '?'} valid, ${termination?.counts?.unresolved ?? '?'} unresolved, ${termination?.counts?.neverStarted ?? '?'} never-started; further live calls ${termination?.furtherLiveCalls ?? '?'}; completion design ${completion?.counts?.completionCells ?? '?'} cells, authorized ${completion?.executionAuthorized ?? '?'}`)

gate('R3-G6',
  configHistorical?.status === 'drift-detected'
    && configHistorical?.mismatches?.some(mismatch => mismatch.key === 'rationaleHintTokens'
      && mismatch.declared === 800
      && mismatch.effective === 400)
    && configForwarded?.status === 'pass'
    && frontier?.stressVsProduct?.stress?.rationaleHintTokensEffective === 400
    && frontier?.stressVsProduct?.productPresets?.dataStatus === 'not-executed'
    && presetEvidence?.counts?.measuredButNotApplicable === 0
    && presetEvidence?.counts?.hypothesis === 3
    ? 'pass' : 'fail',
`historical preflight ${configHistorical?.status ?? '?'} (${JSON.stringify(configHistorical?.mismatches ?? [])}); forwarded ${configForwarded?.status ?? '?'}; stress hint ${frontier?.stressVsProduct?.stress?.rationaleHintTokensEffective ?? '?'}; preset ${presetEvidence?.counts?.hypothesis ?? '?'} hypothesis`)

gate('R3-G7',
  ciStatus === 'success'
    && zeroLive?.status === 'pass'
    && (claims?.missing?.length ?? 1) === 0
    && has('docs/convergence/EF_R3.md')
    ? 'pass'
    : ciStatus === 'pending' ? 'pending' : 'fail',
`CI ${ciStatus}; zero-live ${zeroLive?.status ?? 'missing'}; claims missing ${claims?.missing?.length ?? '?'}; EF_R3.md ${has('docs/convergence/EF_R3.md') ? 'present' : 'missing'}`)

gate('R3-G8',
  decision?.decision === 'no-product-candidate'
    && decision?.deploymentHold === true
    && (decision?.reasons?.length ?? 0) >= 5
    && productLane?.executionAuthorized === false
    ? 'pass' : 'fail',
`decision ${decision?.decision ?? '?'}; deploymentHold ${decision?.deploymentHold ?? '?'}; reasons ${decision?.reasons?.length ?? '?'}; product lane authorized ${productLane?.executionAuthorized ?? '?'}`)

const output = {
  schemaVersion: 1,
  work: 'EF-R3',
  generatedAt: new Date().toISOString(),
  gates,
  counts: {
    pass: gates.filter(entry => entry.status === 'pass').length,
    pending: gates.filter(entry => entry.status === 'pending').length,
    incomplete: gates.filter(entry => entry.status === 'incomplete').length,
    fail: gates.filter(entry => entry.status === 'fail').length,
  },
  sources: {
    baseline: 'eval/r3/out/baseline-r3.json',
    reconciliation: 'eval/r3/out/live-confirm-reconciliation.json',
    ledgerContract: 'eval/r3/out/ledger-contract.json',
    transport: 'eval/r3/out/transport-diagnosis.json',
    transportContract: 'eval/r3/out/transport-contract.json',
    healthProbe: 'eval/r3/out/transport-health-probe.json',
    span: 'eval/r3/out/span-economics.json',
    frontier: 'eval/r3/out/product-frontier.json',
    decision: 'eval/r3/out/product-decision.json',
    configHistorical: 'eval/r3/out/config-preflight.json',
    configForwarded: 'eval/r3/out/config-preflight-forwarded.json',
    presetEvidence: 'eval/r3/out/preset-evidence.json',
    completion: 'eval/r3/out/completion-design-r3.json',
    productLane: 'eval/r3/out/product-lane-design-r3.json',
    archivePointer: 'eval/r3/out/research-archive-r2-live.json',
    zeroLive: 'eval/r3/out/zero-live-audit.json',
    claims: 'eval/r3/out/evidence-claims.json',
  },
  ci: {
    status: ciStatus,
    note: 'Set EF_R3_CI_STATUS after the supported-lane run. The master probe remains non-blocking.',
  },
  note: 'A gate is evaluated from the artifact it names. incomplete is not fail, and no unknown is promoted to pass.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'gate-status.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
for (const entry of gates) process.stdout.write(`${entry.id} ${entry.status.toUpperCase()} — ${entry.detail}\n`)
process.stdout.write(`${output.counts.pass} pass, ${output.counts.pending} pending, ${output.counts.incomplete} incomplete, ${output.counts.fail} fail\n`)
if (output.counts.fail > 0) process.exit(1)
