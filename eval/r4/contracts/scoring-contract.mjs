#!/usr/bin/env node
/**
 * EF-R4 WP1 contract — the scoring split is deterministic and does not
 * reinterpret treatment exposure as a task failure.
 *
 *   node eval/r4/contracts/scoring-contract.mjs
 *
 * These are synthetic fixtures. They exercise the pure functions only; no
 * report, workspace or provider is touched.
 *
 * @module eval/r4/contracts/scoring-contract
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { scoreReport, taskOutcomeOf, usageCompleteOf, exactMcNemar } from '../score.mjs'

const OUT = new URL('../out/', import.meta.url)

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  process.stdout.write(`  ok ${name}\n`)
}

const v1 = ({ checks: rows, termination = {}, committed = 0 }) => ({
  schemaVersion: 1,
  checker: { pass: rows.every(row => row.pass), checks: rows },
  termination: { kind: 'finish', finished: false, ...termination },
  witnessSummary: { committed },
  usage: { unknownUsage: 0, requests: 1, inputTokens: 10, outputTokens: 2 },
  requests: [{ usage: { inputTokens: 10, outputTokens: 2 } }],
})

check('task pass + mechanism miss is a correct task and a failed mechanism', () => {
  const report = v1({
    checks: [
      { kind: 'json_equals', pass: true, detail: 'ok' },
      { kind: 'compactions', pass: false, detail: '1 committed, required 2' },
    ],
    committed: 1,
  })
  const score = scoreReport({
    report,
    task: { requires: { minCompactions: 2 } },
    historicalPass: false,
  })
  assert.equal(score.taskChecks.pass, true)
  assert.equal(score.taskOutcome, 'correct')
  assert.equal(score.mechanism.requiredFoldCountMet, false)
  assert.equal(score.historicalPass, false)
})

check('step-limit with no finish and a failed check is incomplete', () => {
  const report = v1({
    checks: [{ kind: 'json_equals', pass: false, detail: 'missing' }],
    termination: { kind: 'step-limit', finished: false },
  })
  const score = scoreReport({ report, task: {}, historicalPass: false })
  assert.equal(score.taskOutcome, 'incomplete')
})

check('finish called with a failed check is incorrect', () => {
  const report = v1({
    checks: [{ kind: 'json_equals', pass: false, detail: 'wrong value' }],
    termination: { kind: 'finish', finished: true },
  })
  const score = scoreReport({ report, task: {}, historicalPass: false })
  assert.equal(score.taskOutcome, 'incorrect')
})

check('step-limit with all checks passing is still a correct task', () => {
  const report = v1({
    checks: [{ kind: 'json_equals', pass: true, detail: 'ok' }],
    termination: { kind: 'step-limit', finished: false },
  })
  const score = scoreReport({ report, task: {}, historicalPass: true })
  assert.equal(score.taskOutcome, 'correct')
  assert.equal(score.termination.kind, 'step-limit')
})

check('a partial usage object is not a complete cost', () => {
  assert.equal(usageCompleteOf([{ usage: { inputTokens: 1, outputTokens: 2 } }]), true)
  assert.equal(usageCompleteOf([{ usage: { inputTokens: null, outputTokens: 2 } }]), false)
  assert.equal(usageCompleteOf([{ usage: null }]), false)
})

check('v2 scoring is read directly', () => {
  const report = {
    schemaVersion: 2,
    checker: { pass: false, checks: [{ kind: 'tests', pass: false, detail: 'red' }] },
    mechanism: {
      requiredCompactions: 2,
      committedCompactions: 2,
      pass: true,
      requiredFoldCountMet: true,
    },
    scoring: {
      taskOutcome: 'incomplete',
      termination: { finishCalled: false, kind: 'timeout' },
      cost: { usageCompleteR4: false, usageCompleteR3: true },
    },
    termination: { kind: 'timeout', stepLimitStage: null },
    usage: { unknownUsage: 0 },
    requests: [],
    witnessSummary: { committed: 2 },
  }
  const score = scoreReport({ report, task: { requires: { minCompactions: 2 } }, historicalPass: false })
  assert.equal(score.taskOutcome, 'incomplete')
  assert.equal(score.mechanism.requiredFoldCountMet, true)
  assert.equal(score.cost.usageCompleteR4, false)
  assert.equal(score.cost.usageCompleteR3, true)
})

check('taskOutcome precedence is explicit', () => {
  assert.equal(taskOutcomeOf({ taskPass: true, finishCalled: false }), 'correct')
  assert.equal(taskOutcomeOf({ taskPass: false, finishCalled: true }), 'incorrect')
  assert.equal(taskOutcomeOf({ taskPass: false, finishCalled: false }), 'incomplete')
})

check('McNemar is 1 for no discordant pairs and symmetric', () => {
  assert.equal(exactMcNemar(0, 0), 1)
  assert.equal(exactMcNemar(0, 2), exactMcNemar(2, 0))
  assert.ok(exactMcNemar(2, 0) < 1)
})

process.stdout.write(`scoring-contract: ${checks}/${checks} pass\n`)
mkdirSync(OUT, { recursive: true })
writeFileSync(new URL('scoring-contract.json', OUT), `${JSON.stringify({
  schemaVersion: 1,
  work: 'EF-R4 WP1 scoring contract',
  generatedAt: new Date().toISOString(),
  checks,
  passed: checks,
  failures: 0,
}, null, 2)}\n`)
