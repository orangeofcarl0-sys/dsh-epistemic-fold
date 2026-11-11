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

const output = {
  schemaVersion: 1,
  work: 'EF-R4 product decision',
  generatedAt: new Date().toISOString(),
  productCandidate: null,
  deploymentHold: true,
  expandTo72: false,
  researchCandidate: candidate.selected,
  researchCandidateWired: false,
  reasons: [
    'The R4 candidate is a correlation from 18 R3 cells, not a live-tested mechanism.',
    'There is no 16-step measurement yet; the 8-step EF cells are step-limit censored.',
    'The R3 pilot is one model, one route and one machine; no replication exists.',
    'The candidate adds exact prompt bytes, but whether the model acts on them is unmeasured.',
    'The failure projection is also inflated in T16, so one mechanism cannot explain every failure.',
    'No USD price is claimed; R3 usage is incomplete on one E1 cell and has no per-step token snapshots.',
  ],
  nextStep: {
    campaign: budget.campaign,
    executionAuthorized: budget.executionAuthorized,
    description: 'A step-budget sensitivity campaign (36 cells) under a new, explicit live authorization.',
  },
  decisionRules: {
    productCandidateRequires: [
      'a live budget-sensitivity result with complete usage',
      'the task outcome separated from mechanism exposure',
      'a paired comparison against B0 on the same tasks',
      'a cost and latency bound with complete usage',
    ],
    holdUntil: 'those conditions are met; the 72-cell lane is not authorized.',
  },
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'product-decision-r4.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`product-decision: no product candidate; deploymentHold=true; researchCandidate=${candidate.selected}; next=${budget.campaign} (authorized=${budget.executionAuthorized})\n`)
process.stdout.write(`wrote ${path}\n`)
