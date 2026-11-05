#!/usr/bin/env node
/**
 * Aggregate the R36 B1/S causal pairs under the H-protocol harness.
 *
 * The causal runs were executed after the DSML direct-attribute fix, with the
 * same 8 steps / 1024 output tokens / no guard as the H-protocol O2 floor. Two
 * B1/S replicates cover six cases. O1/O2 are recorded for attribution but are
 * not part of the B1/S pair count.
 *
 * Pair outcomes use contract success as the primary outcome and task success as
 * the secondary. A case with an invalid measurement is reported as invalid, not
 * as a failure.
 *
 * @module eval/r36/analyze-causal
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNS = join(HERE, 'runs')
const OUT = join(HERE, 'out', 'causal-comparison.json')
const CASES = ['A1', 'B2', 'C1', 'D1', 'F1', 'H1']
const REPLICATES = [
  { replicateId: 'r1', runPrefix: 'r36-causal-' },
  { replicateId: 'r2', runPrefix: 'r36-causal-r2-' },
]

function outcome(baseline, treatment) {
  if (!baseline.valid || !treatment.valid) return 'invalid'
  if (treatment.success && !baseline.success) return 'rescue'
  if (!treatment.success && baseline.success) return 'damage'
  return treatment.success ? 'both' : 'neither'
}

const pairs = []
const arms = []
for (const { replicateId, runPrefix } of REPLICATES) {
  for (const caseId of CASES) {
    const runId = `${runPrefix}${caseId}`
    let report
    try {
      report = JSON.parse(await readFile(join(RUNS, runId, 'report.json'), 'utf8'))
    } catch {
      pairs.push({ caseId, replicateId, runId, invalid: true, reason: 'run report missing' })
      continue
    }
    const byArm = new Map(report.rows.map(row => [row.arm, row]))
    for (const arm of ['B1', 'S', 'O1', 'O2']) {
      const row = byArm.get(arm)
      if (row === undefined) continue
      arms.push({
        caseId,
        replicateId,
        runId,
        arm,
        valid: row.valid === true,
        taskSuccess: row.behaviour?.taskSuccess === true,
        contractSuccess: row.behaviour?.contractSuccess === true,
        processViolation: row.behaviour?.processViolation === true,
        falseVerificationClaim: row.behaviour?.falseVerificationClaim === true,
        testsExecuted: row.behaviourDetail?.testsExecuted ?? 0,
        steps: row.behaviourDetail?.steps ?? null,
        finished: row.behaviourDetail?.finished === true,
        failedChecks: row.behaviour?.failedChecks ?? [],
        foldValid: row.fold?.valid === true,
        foldFallback: row.foldFallback ?? null,
        checkpointChars: row.checkpoint?.chars ?? null,
        writerProtocol: row.writer?.protocol ?? null,
        writerCommitStatus: row.writer?.commitStatus ?? null,
        writerRefusalReasons: row.writer?.refusalReasons ?? [],
      })
    }
    const baseline = byArm.get('B1')
    const treatment = byArm.get('S')
    if (baseline === undefined || treatment === undefined) {
      pairs.push({ caseId, replicateId, runId, invalid: true, reason: 'B1 or S row missing' })
      continue
    }
    const baselineContract = {
      valid: baseline.valid === true,
      success: baseline.behaviour?.contractSuccess === true,
    }
    const treatmentContract = {
      valid: treatment.valid === true,
      success: treatment.behaviour?.contractSuccess === true,
    }
    const baselineTask = {
      valid: baseline.valid === true,
      success: baseline.behaviour?.taskSuccess === true,
    }
    const treatmentTask = {
      valid: treatment.valid === true,
      success: treatment.behaviour?.taskSuccess === true,
    }
    pairs.push({
      caseId,
      replicateId,
      runId,
      valid: baselineContract.valid && treatmentContract.valid,
      contractOutcome: outcome(baselineContract, treatmentContract),
      taskOutcome: outcome(baselineTask, treatmentTask),
      baseline: {
        contract: baselineContract.success,
        task: baselineTask.success,
        processViolation: baseline.behaviour?.processViolation === true,
        testsExecuted: baseline.behaviourDetail?.testsExecuted ?? 0,
        failedChecks: baseline.behaviour?.failedChecks ?? [],
        foldValid: baseline.fold?.valid === true,
        checkpointChars: baseline.checkpoint?.chars ?? null,
      },
      treatment: {
        contract: treatmentContract.success,
        task: treatmentTask.success,
        processViolation: treatment.behaviour?.processViolation === true,
        testsExecuted: treatment.behaviourDetail?.testsExecuted ?? 0,
        failedChecks: treatment.behaviour?.failedChecks ?? [],
        foldValid: treatment.fold?.valid === true,
        foldFallback: treatment.foldFallback ?? null,
        checkpointChars: treatment.checkpoint?.chars ?? null,
        writerProtocol: treatment.writer?.protocol ?? null,
        writerCommitStatus: treatment.writer?.commitStatus ?? null,
      },
    })
  }
}

const count = (rows, key, value) => rows.filter(row => row[key] === value).length
const validPairs = pairs.filter(pair => pair.valid === true)
const contract = {
  pairs: validPairs.length,
  rescue: count(validPairs, 'contractOutcome', 'rescue'),
  damage: count(validPairs, 'contractOutcome', 'damage'),
  both: count(validPairs, 'contractOutcome', 'both'),
  neither: count(validPairs, 'contractOutcome', 'neither'),
  invalid: pairs.filter(pair => pair.valid !== true).length,
}
const task = {
  pairs: validPairs.length,
  rescue: count(validPairs, 'taskOutcome', 'rescue'),
  damage: count(validPairs, 'taskOutcome', 'damage'),
  both: count(validPairs, 'taskOutcome', 'both'),
  neither: count(validPairs, 'taskOutcome', 'neither'),
}
const byReplicate = REPLICATES.map(({ replicateId }) => {
  const rows = validPairs.filter(pair => pair.replicateId === replicateId)
  return {
    replicateId,
    pairs: rows.length,
    rescue: count(rows, 'contractOutcome', 'rescue'),
    damage: count(rows, 'contractOutcome', 'damage'),
    both: count(rows, 'contractOutcome', 'both'),
    neither: count(rows, 'contractOutcome', 'neither'),
  }
})
const byCase = CASES.map(caseId => {
  const rows = validPairs.filter(pair => pair.caseId === caseId)
  return {
    caseId,
    pairs: rows.length,
    contract: {
      rescue: count(rows, 'contractOutcome', 'rescue'),
      damage: count(rows, 'contractOutcome', 'damage'),
      both: count(rows, 'contractOutcome', 'both'),
      neither: count(rows, 'contractOutcome', 'neither'),
    },
    task: {
      rescue: count(rows, 'taskOutcome', 'rescue'),
      damage: count(rows, 'taskOutcome', 'damage'),
      both: count(rows, 'taskOutcome', 'both'),
      neither: count(rows, 'taskOutcome', 'neither'),
    },
  }
})
const oracle = arms.filter(row => row.arm === 'O1' || row.arm === 'O2')
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  harness: 'H-protocol: 8 steps / 1024 output tokens / no finish guard; DSML and JSON tool parsing',
  replicates: REPLICATES.map(entry => entry.replicateId),
  cases: CASES,
  contract,
  task,
  byReplicate,
  byCase,
  oracle: {
    O1: {
      rows: oracle.filter(row => row.arm === 'O1').length,
      valid: oracle.filter(row => row.arm === 'O1' && row.valid).length,
      contractSuccesses: oracle.filter(row => row.arm === 'O1' && row.contractSuccess).length,
    },
    O2: {
      rows: oracle.filter(row => row.arm === 'O2').length,
      valid: oracle.filter(row => row.arm === 'O2' && row.valid).length,
      contractSuccesses: oracle.filter(row => row.arm === 'O2' && row.contractSuccess).length,
    },
  },
  pairs,
  arms,
  note: 'Exploratory: six cases, two replicates, one model/route. The contract outcome is the primary pair. '
    + 'Damage is not automatically a memory failure; the per-case failed checks and checkpoint sizes are retained for attribution.',
}
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`contract: ${JSON.stringify(contract)}\n`)
process.stdout.write(`task: ${JSON.stringify(task)}\n`)
for (const replicate of byReplicate) process.stdout.write(`${replicate.replicateId}: ${JSON.stringify(replicate)}\n`)
for (const caseRow of byCase) process.stdout.write(`${caseRow.caseId}: ${JSON.stringify(caseRow)}\n`)
process.stdout.write(`oracle: ${JSON.stringify(report.oracle)}\n`)
process.stdout.write(`${OUT}\n`)
