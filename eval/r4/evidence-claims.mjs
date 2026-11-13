#!/usr/bin/env node
/**
 * EF-R4 — evidence claims, each bound to an artifact hash and a commit.
 *
 * A claim that cannot name its artifact, hash and limitation is not a claim.
 * The numbers below are read from the generated artifacts, not typed by hand.
 *
 *   node eval/r4/evidence-claims.mjs
 *
 * @module eval/r4/evidence-claims
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()

function load(name) {
  const path = join(OUT, name)
  if (!existsSync(path)) {
    process.stderr.write(`evidence-claims: ${name} is missing\n`)
    process.exit(2)
  }
  return { path, sha256: sha256(path), json: readJson(path) }
}

const baseline = load('baseline-r4.json')
const rescore = load('rescored-r3.json')
const lifecycle = load('evidence-lifecycle.json')
const continuity = load('task-continuity.json')
const workingSet = load('working-set.json')
const candidate = load('candidate-decision.json')
const budget = load('budget-sensitivity-design.json')
const budgetManifest = load('budget-manifest.json')
const budgetPreflight = load('budget-manifest-preflight.json')
const liveAttempt = load('live-attempt-r4-1.json')
const productDecision = load('product-decision-r4.json')
const zeroLive = load('zero-live-audit.json')

const head = git('rev-parse', 'HEAD')
const short = head.slice(0, 8)
const artifact = entry => ({ path: entry.path.slice(ROOT.length + 1).replaceAll('\\', '/'), sha256: entry.sha256 })

const claims = []
function claim(id, statement, artifacts, limitation) {
  claims.push({ id, statement, commit: short, artifacts, limitation })
}

const hist = rescore.json.historical
const re = rescore.json.rescored
const pair = rescore.json.comparisons.find(entry => entry.left === 'E1' && entry.right === 'B0')
claim('R4-BASELINE',
  `R4 started from ${baseline.json.git.headShort} with ${baseline.json.immutable.length - baseline.json.immutableMissing.length}/${baseline.json.immutable.length} immutable R3 artifacts present and ${baseline.json.immutableMissing.length} missing.`,
  [artifact(baseline)],
  'A commit is a hand-off point, not proof that every future run used this tree.')

claim('R4-SCORING-SPLIT',
  `Historical R3 passes are B0 ${hist.B0.historicalPass}/6, E0 ${hist.E0.historicalPass}/6, E1 ${hist.E1.historicalPass}/6. The rescored task outcome is B0 ${re.B0.taskCorrect}/6, E0 ${re.E0.taskCorrect}/6, E1 ${re.E1.taskCorrect}/6; E1 vs B0 has both ${pair.both}, neither ${pair.neither}, E1-only ${pair.leftOnly}, B0-only ${pair.rightOnly}. Mechanism exposure is reported separately.`,
  [artifact(rescore)],
  'The rescore is a re-reading of the same 18 cells, not a new benchmark. It does not change the historical score.')

const lt = lifecycle.json.totals
claim('R4-EVIDENCE-LIFECYCLE',
  `Across 18 pilot cells there are ${lt.recallCalls} recall/search calls; ${lt.folded} results are shadowed by a later fold; ${lt.refolded} do not carry the payload verbatim into the next request (${lt.markerOnly} marker-only, ${lt.invisibleAfterFold} invisible-after-fold, ${lt.noFollowingRequest} no-following-request); ${lt.visible} are visible and ${lt.equivalentInferred} are inferred equivalent.`,
  [artifact(lifecycle)],
  'Visibility is the exact toolCallId/content at the next primary request. A checkpoint paraphrase without an exact substring is not counted as equivalent.')

claim('R4-TASK-CONTINUITY',
  `Of the ${candidate.json.evidence.failedEfCells.length} failed EF cells, ${candidate.json.evidence.failedWithLoss.length} lose the exact task source; ${continuity.json.cells.filter(cell => cell.arm !== 'B0' && cell.taskSourceLostWithNoWrite).length} of them make no write. None of the ${candidate.json.evidence.passedEfCells.length} passing EF cells lose it (${candidate.json.evidence.passedWithLoss.length} with loss).`,
  [artifact(continuity)],
  'Exact prompt absence is not proof that no paraphrase existed; the artifact path and checkpoint text are reported separately.')

const t16e0 = workingSet.json.cells.find(cell => cell.cellId === 'T16-p1-E0-r1')
const t16e1 = workingSet.json.cells.find(cell => cell.cellId === 'T16-p1-E1-r1')
claim('R4-FAILURE-PROJECTION',
  `T16 E0 carries ${t16e0?.failureProjection.openFailureCount ?? '?'} open failures (${t16e0?.failureProjection.duplicateSignatures ?? '?'} duplicate signatures, ${t16e0?.failureProjection.share === null ? '?' : (t16e0.failureProjection.share * 100).toFixed(1)}% of checkpoint chars); T16 E1 carries ${t16e1?.failureProjection.openFailureCount ?? '?'} (${t16e1?.failureProjection.duplicateSignatures ?? '?'} duplicate, ${t16e1?.failureProjection.share === null ? '?' : (t16e1.failureProjection.share * 100).toFixed(1)}%).`,
  [artifact(workingSet)],
  'The final checkpoint is the only checkpoint stored verbatim; the join from anchor to tool/path is inferred and can be unknown.')

const w = workingSet.json.byArm
claim('R4-WORKING-SET',
  `Character-level context balance is B0 ${w.B0.netChars}, E0 ${w.E0.netChars}, E1 ${w.E1.netChars}; repeated recall ${workingSet.json.totals.repeatedRecallCount}; recall payloads re-folded ${workingSet.json.totals.recallResultReFoldCount}; exact-task requests lost ${workingSet.json.totals.taskInstructionLostRequests}.`,
  [artifact(workingSet)],
  'These are characters, not provider tokens. R3 has no per-step TokenMeter snapshot; the E0 positive balance is a research signal, not a billing result.')

const sim = candidate.json.simulation
claim('R4-CANDIDATE',
  `The pre-registered rules select ${candidate.json.selected} (contract only, not wired). The offline simulation adds ${sim.addedChars} exact prompt chars across ${sim.cells.length} failed cells, bounded to two deliveries per cell.`,
  [artifact(candidate)],
  'A correlation in 18 cells is not a causal effect. The simulation does not prove the model would act on the replayed source.')

claim('R4-BUDGET-DESIGN',
  `The budget-sensitivity design has ${budget.json.design.cells} cells (6 tasks x 3 arms x 2 budgets), validated as ${budget.json.design.validation.uniqueTaskArmBudget} unique combinations with balanced blocks; executionAuthorized is ${budget.json.executionAuthorized}.`,
  [artifact(budget)],
  'A design is not an authorization. The proposed envelope is an estimate from R3, not a spend approval.')

claim('R4-BUDGET-MANIFEST',
  `The runnable manifest is frozen at SHA-256 ${budgetManifest.json.manifest.sha256} with ${budgetManifest.json.manifest.cells} cells; authorization granted=${budgetManifest.json.authorization.granted}; preflight ${budgetPreflight.json.verdict} (${budgetPreflight.json.checks.filter(check => check.pass).length}/${budgetPreflight.json.checks.length} checks).`,
  [artifact(budgetManifest), artifact(budgetPreflight)],
  'A frozen manifest and a passing preflight are not a live authorization; providerCalls is 0 and executionAuthorized is false.')

claim('R4-LIVE-ATTEMPT',
  `The authorized health probe was attempted once and failed before the first model response: ${liveAttempt.json.probe.firstFailure.finish.failure.message} (${liveAttempt.json.probe.firstFailure.finish.failure.code}) after ${liveAttempt.json.probe.firstFailure.durationMs} ms; ${liveAttempt.json.probe.successes}/${liveAttempt.json.probe.planned} requests succeeded and the 36-cell campaign was not started.`,
  [artifact(liveAttempt)],
  'This is an environment/route blocker at the local proxy, not task-quality evidence. No automatic retry; the campaign requires a restored route and a re-frozen manifest.')

claim('R4-PRODUCT-DECISION',
  `No product candidate is proposed; Deployment Hold is ${productDecision.json.deploymentHold}; expandTo72 is ${productDecision.json.expandTo72}; the research candidate remains unwired.`,
  [artifact(productDecision)],
  'The decision is bounded by one model, one route, one machine and a step-limit-censored 8-step lane.')

claim('R4-ZERO-LIVE',
  `The zero-live audit scanned ${zeroLive.json.scripts.length} R4 scripts, found ${zeroLive.json.violations.length} provider/live entry points and ${zeroLive.json.r4Campaigns.length} R4 campaign artifacts; providerCalls is ${zeroLive.json.providerCalls}.`,
  [artifact(zeroLive)],
  'The audit checks the R4 scripts and output directories; it is not a network monitor for the whole machine.')

const output = {
  schemaVersion: 1,
  work: 'EF-R4 evidence claims',
  generatedAt: new Date().toISOString(),
  head,
  claims,
  counts: { claims: claims.length, artifacts: new Set(claims.flatMap(entry => entry.artifacts.map(a => a.path))).size },
  method: 'Each claim names its artifact, SHA-256, commit and limitation. A missing artifact stops generation.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'evidence-claims.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`claims: ${claims.length}; artifacts ${output.counts.artifacts}; head ${short}\n`)
process.stdout.write(`wrote ${path}\n`)
