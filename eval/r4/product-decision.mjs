#!/usr/bin/env node
/**
 * EF-R4 — the product decision, kept inside the evidence.
 *
 * R4 selected a research candidate (bounded replay of the exact task source)
 * from a correlation in 18 R3 cells. That is not a product candidate: the
 * mechanism has no live test, no cost-valid 16-step run, and no second model or
 * route. Deployment Hold remains.
 *
 *   node eval/r4/product-decision.mjs
 *
 * @module eval/r4/product-decision
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const candidatePath = join(OUT, 'candidate-decision.json')
const budgetPath = join(OUT, 'budget-sensitivity-design.json')
for (const path of [candidatePath, budgetPath]) {
  if (!existsSync(path)) {
    process.stderr.write(`product-decision: ${path} is missing\n`)
    process.exit(2)
  }
}
const candidate = readJson(candidatePath)
const budget = readJson(budgetPath)
const livePath = join(OUT, 'live-attempts-r4.json')
const live = existsSync(livePath) ? readJson(livePath) : null
const campaignPath = join(OUT, 'budget-campaign-e2e-r4-budget-sensitivity-3.json')
const campaign = existsSync(campaignPath) ? readJson(campaignPath) : null
const measured = campaign?.byArmBudget ?? null
const e1b8 = measured?.['E1-8'] ?? null
const b0b8 = measured?.['B0-8'] ?? null
const e1b16 = measured?.['E1-16'] ?? null

const output = {
  schemaVersion: 1,
  work: 'EF-R4 product decision',
  generatedAt: new Date().toISOString(),
  productCandidate: null,
  deploymentHold: true,
  expandTo72: false,
  researchCandidate: candidate.selected,
  researchCandidateWired: false,
  measuredBestArm: e1b8 === null ? null : 'E1@8',
  routeQualification: live === null ? null : {
    attempts: live.count,
    decision: live.decision,
    successes: live.successes,
    planned: live.planned,
  },
  liveEvidence: campaign === null ? null : {
    campaign: campaign.campaign,
    status: campaign.status,
    executed: campaign.executed,
    planned: campaign.planned,
    taskCorrect: e1b8 === null ? null : {
      'B0@8': b0b8?.taskCorrect ?? null,
      'E1@8': e1b8?.taskCorrect ?? null,
      'E1@16': e1b16?.taskCorrect ?? null,
    },
    requests: { 'B0@8': b0b8?.requests ?? null, 'E1@8': e1b8?.requests ?? null },
    inputTokens: { 'B0@8': b0b8?.inputTokens ?? null, 'E1@8': e1b8?.inputTokens ?? null },
    outputTokens: { 'B0@8': b0b8?.outputTokens ?? null, 'E1@8': e1b8?.outputTokens ?? null },
    e1VsB0At8: campaign.comparisons?.find(row => row.id === 'E1-vs-B0@8') ?? null,
    e1SixteenVsEight: campaign.comparisons?.find(row => row.id === 'E1-16-vs-8') ?? null,
  },
  reasons: [
    'The clean 36-cell campaign completed, but there is one replicate per cell and only six tasks.',
    'E1@8 is 6/6 versus B0@8 4/6, but the paired exact McNemar p is 0.5; the interval is wide.',
    'E1@16 is 4/6: doubling the step budget did not improve E1, and it lost T15/T16 relative to E1@8.',
    'E0 remains weak at both budgets (1/6 at 8, 2/6 at 16), so EF Minimal is not the product candidate.',
    'The route changed from the R3 local proxy to Omnigate/opencode; R3 and R4 results are not directly comparable.',
    'The active-task-delivery candidate was not tested in this campaign; E1@8 passed without it.',
    'No held-out task set, second route or second model exists; no USD price is claimed.',
  ],
  nextStep: {
    campaign: 'e4-confirm-e1-8-vs-b0-8',
    executionAuthorized: false,
    description: 'A confirmatory E1@8 vs B0@8 campaign with more tasks/replicates and a second route; 16-step expansion only if the confirmatory result justifies it.',
  },
  decisionRules: {
    productCandidateRequires: [
      'a confirmatory live result with complete usage',
      'the task outcome separated from mechanism exposure',
      'a paired comparison against B0 on the same tasks',
      'a cost and latency bound with complete usage',
      'a second route or model, and a held-out task set',
    ],
    holdUntil: 'those conditions are met; the 72-cell lane is not authorized.',
  },
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'product-decision-r4.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`product-decision: no product candidate; deploymentHold=true; researchCandidate=${candidate.selected}; next=${budget.campaign} (authorized=${budget.executionAuthorized})\n`)
process.stdout.write(`wrote ${path}\n`)
