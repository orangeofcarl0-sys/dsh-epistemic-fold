#!/usr/bin/env node
/**
 * Aggregate the O2 harness-calibration runs without pooling invalid rows.
 *
 * Conditions:
 *   H0         8 steps / 1024 output tokens / no guard
 *   H-step     16 steps / 1024 / no guard
 *   H-output   8 steps / 4096 / no guard
 *   H-finish   8 steps / 1024 / guard
 *   H-combined 16 steps / 1024 / guard (exploratory, selected after the singles)
 *
 * H-step was split per case after the local proxy reset connections; each
 * condition therefore names its exact run ids. An invalid row is reported as
 * invalid, never as a task failure.
 *
 * @module eval/r36/analyze-harness
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNS = join(HERE, 'runs')
const OUT = join(HERE, 'out', 'harness-calibration.json')

const CONDITIONS = {
  H0: ['r36-h0-o2-r2'],
  'H-step': [
    'r36-h-step-o2-A1',
    'r36-h-step-o2-B2',
    'r36-h-step-o2-C1b',
    'r36-h-step-o2-D1b',
    'r36-h-step-o2-F1',
    'r36-h-step-o2-H1',
  ],
  'H-output': [
    'r36-h-output-o2-A1',
    'r36-h-output-o2-B2',
    'r36-h-output-o2-C1',
    'r36-h-output-o2-D1',
    'r36-h-output-o2-F1',
    'r36-h-output-o2-H1',
  ],
  'H-finish': [
    'r36-h-finish-o2-A1',
    'r36-h-finish-o2-B2',
    'r36-h-finish-o2-C1',
    'r36-h-finish-o2-D1',
    'r36-h-finish-o2-F1',
    'r36-h-finish-o2-H1',
  ],
  'H-combined': [
    'r36-h-combined-o2-A1',
    'r36-h-combined-o2-B2',
    'r36-h-combined-o2-C1',
    'r36-h-combined-o2-D1',
    'r36-h-combined-o2-F1',
    'r36-h-combined-o2-H1',
  ],
}

const conditions = []
for (const [name, runIds] of Object.entries(CONDITIONS)) {
  const rows = []
  const invalidRuns = []
  for (const runId of runIds) {
    const report = JSON.parse(await readFile(join(RUNS, runId, 'report.json'), 'utf8'))
    if (report.status === 'provider-unavailable' || report.status === 'not-executed') {
      invalidRuns.push({ runId, status: report.status, reason: report.reason })
      continue
    }
    for (const row of report.rows) {
      if (row.arm !== 'O2') continue
      const detail = row.behaviourDetail ?? {}
      const harness = detail.harness ?? {}
      const guard = detail.finishGuard ?? {}
      rows.push({
        runId,
        caseId: row.caseId,
        valid: row.valid === true,
        invalidReason: row.valid === true ? null : row.reason ?? row.failures?.outcome ?? 'invalid',
        taskSuccess: row.behaviour?.taskSuccess === true,
        contractSuccess: row.behaviour?.contractSuccess === true,
        functionalSuccess: row.behaviour?.functionalSuccess === true,
        processViolation: row.behaviour?.processViolation === true,
        falseVerificationClaim: row.behaviour?.falseVerificationClaim === true,
        testsExecuted: detail.testsExecuted ?? 0,
        steps: detail.steps ?? null,
        finished: detail.finished === true,
        stepLimitTermination: harness.stepLimitTermination === true,
        truncatedTurns: harness.truncatedTurns ?? 0,
        invalidActions: harness.invalidActions ?? 0,
        guardRejections: guard.rejections ?? 0,
        guardAssisted: guard.assistedCompletion === true,
        failedChecks: row.behaviour?.failedChecks ?? [],
        finalVerificationStatus: row.behaviour?.finalVerificationStatus ?? null,
      })
    }
  }
  const valid = rows.filter(row => row.valid)
  const count = predicate => valid.filter(predicate).length
  conditions.push({
    condition: name,
    runIds,
    rows,
    invalidRuns,
    summary: {
      cases: rows.length,
      valid: valid.length,
      invalid: rows.length - valid.length,
      taskSuccesses: count(row => row.taskSuccess),
      contractSuccesses: count(row => row.contractSuccess),
      functionalFailures: count(row => !row.functionalSuccess),
      processViolations: count(row => row.processViolation),
      falseVerificationClaims: count(row => row.falseVerificationClaim),
      testsExecuted: valid.reduce((total, row) => total + row.testsExecuted, 0),
      stepLimitTerminations: count(row => row.stepLimitTermination),
      truncatedTurns: valid.reduce((total, row) => total + row.truncatedTurns, 0),
      invalidActions: valid.reduce((total, row) => total + row.invalidActions, 0),
      guardRejections: valid.reduce((total, row) => total + row.guardRejections, 0),
      guardAssisted: count(row => row.guardAssisted),
      taskSuccessRate: valid.length === 0 ? null : count(row => row.taskSuccess) / valid.length,
      contractSuccessRate: valid.length === 0 ? null : count(row => row.contractSuccess) / valid.length,
    },
  })
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  note: 'O2 oracle-visible calibration. The combined condition is exploratory and was chosen after the single-factor results; it is not a pre-registered arm.',
  conditions,
}
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
for (const condition of conditions) {
  process.stdout.write(`\n${condition.condition}: ${JSON.stringify(condition.summary)}\n`)
  for (const row of condition.rows) {
    process.stdout.write(
      `  ${row.caseId}: valid=${row.valid} task=${row.taskSuccess} contract=${row.contractSuccess} `
      + `tests=${row.testsExecuted} steps=${row.steps} finish=${row.finished} `
      + `guardRej=${row.guardRejections} failed=${JSON.stringify(row.failedChecks)}\n`,
    )
  }
}
process.stdout.write(`\n${OUT}\n`)
