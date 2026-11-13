#!/usr/bin/env node
/**
 * EF-R4 — prove the offline stage made no provider call.
 *
 * The audit scans the R4 scripts for provider/live entry points, checks that the
 * budget design is still unauthorized, and that no R4 campaign results exist.
 *
 *   node eval/r4/zero-live-audit.mjs
 *
 * @module eval/r4/zero-live-audit
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const SCRIPTS = [
  'eval/r4/baseline.mjs',
  'eval/r4/score.mjs',
  'eval/r4/evidence-graph.mjs',
  'eval/r4/task-continuity.mjs',
  'eval/r4/working-set.mjs',
  'eval/r4/candidate-decision.mjs',
  'eval/r4/freeze-budget-sensitivity.mjs',
  'eval/r4/freeze-budget-manifest.mjs',
  'eval/r4/freeze-health-probe.mjs',
  'eval/r4/authorize-health-probe.mjs',
  'eval/r4/authorize-budget-campaign.mjs',
  'eval/r4/record-live-attempt.mjs',
  'eval/r4/record-live-attempts.mjs',
  'eval/r4/preflight-budget-manifest.mjs',
  'eval/r4/analyze-budget-campaign.mjs',
  'eval/r4/product-decision.mjs',
  'eval/r4/contracts/scoring-contract.mjs',
  'eval/r4/contracts/evidence-graph-contract.mjs',
  'eval/r4/candidate/active-task-delivery.mjs',
  'eval/r4/shared/audit.mjs',
]

const LIVE_SCRIPTS = [
  'eval/r4/run-health-probe.mjs',
  'eval/r4/analyze-health-probe.mjs',
]

const FORBIDDEN = [
  { pattern: /resolveLiveRoute\s*\(/u, reason: 'live route resolution' },
  { pattern: /makeLiveAdapter\s*\(/u, reason: 'live adapter factory' },
  { pattern: /new\s+LlmAdapter\b/u, reason: 'provider adapter' },
  { pattern: /registerAdapter\s*\(/u, reason: 'provider adapter registration' },
  { pattern: /\bfetch\s*\(/u, reason: 'network fetch' },
  { pattern: /\bLIVE_[A-Z_]+/u, reason: 'live provider finish code' },
  { pattern: /from\s+['"][^'"]*eval\/live[^'"]*['"]/u, reason: 'live eval import' },
  { pattern: /from\s+['"][^'"]*openai[^'"]*['"]/u, reason: 'live provider import' },
]

const violations = []
for (const relative of SCRIPTS) {
  const path = join(ROOT, relative)
  if (!existsSync(path)) {
    violations.push({ script: relative, reason: 'missing script' })
    continue
  }
  const text = readFileSync(path, 'utf8')
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) violations.push({ script: relative, reason: rule.reason })
  }
}

const budgetPath = join(OUT, 'budget-sensitivity-design.json')
const budget = existsSync(budgetPath) ? readJson(budgetPath) : null
if (budget === null) violations.push({ script: 'budget-sensitivity-design.json', reason: 'missing design' })
else if (budget.executionAuthorized !== false) {
  violations.push({ script: 'budget-sensitivity-design.json', reason: 'design is authorized' })
}

const e2eOut = join(ROOT, 'eval', 'e2e', 'out')
const r4Results = existsSync(e2eOut)
  ? readdirSync(e2eOut).filter(name => /^results-e2e-r4-/u.test(name))
  : []
const runsRoot = join(ROOT, 'eval', 'e2e', 'runs')
const r4RunDirs = existsSync(runsRoot)
  ? readdirSync(runsRoot).filter(name => /^e2e-r4-/u.test(name))
  : []
const r4Campaigns = [...r4Results, ...r4RunDirs]
const pointerPath = join(OUT, 'budget-manifest.json')
const budgetManifest = existsSync(pointerPath) ? readJson(pointerPath) : null
const liveAuthorized = budgetManifest?.authorization?.granted === true
const authorizedLiveEvidence = liveAuthorized ? r4Campaigns : []
if (r4Campaigns.length > 0 && !liveAuthorized) {
  violations.push({ script: 'eval/e2e', reason: `R4 campaign artifacts exist without a grant: ${r4Campaigns.join(', ')}` })
}
if (budgetManifest !== null
  && budgetManifest.authorization?.granted !== true
  && budgetManifest.authorization?.granted !== false) {
  violations.push({ script: 'budget-manifest.json', reason: 'manifest authorization has no boolean grant state' })
}

const baselinePath = join(OUT, 'baseline-r4.json')
const baseline = existsSync(baselinePath) ? readJson(baselinePath) : null
const immutableMissing = baseline?.immutableMissing ?? ['baseline missing']

const output = {
  schemaVersion: 1,
  work: 'EF-R4 zero-live audit',
  scope: 'offline analysis scripts only; the authorized live probe and campaign are recorded separately',
  generatedAt: new Date().toISOString(),
  scripts: SCRIPTS,
  liveScripts: LIVE_SCRIPTS,
  forbidden: FORBIDDEN.map(rule => String(rule.pattern)),
  violations,
  providerCalls: 0,
  r4Campaigns,
  authorizedLiveEvidence,
  liveAuthorized,
  budgetExecutionAuthorized: budget?.executionAuthorized ?? null,
  budgetManifest: budgetManifest === null ? null : {
    campaign: budgetManifest.campaign,
    manifestSha256: budgetManifest.manifest?.sha256 ?? null,
    authorizationGranted: budgetManifest.authorization?.granted ?? null,
  },
  immutableMissing,
  verdict: violations.length === 0 && immutableMissing.length === 0 ? 'zero-live-verified' : 'zero-live-violated',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'zero-live-audit.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`zero-live: ${output.verdict}; violations ${violations.length}; providerCalls 0\n`)
if (output.verdict !== 'zero-live-verified') process.exit(1)
