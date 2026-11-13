#!/usr/bin/env node
/**
 * EF-R3 — the ledger contract.
 *
 * Six synthetic campaigns over a throwaway directory. The point is the identity
 * rule, not a model: a failed attempt must not become an unresolved cell when a
 * later attempt succeeds, and a partial usage record must not erase a valid
 * checker result.
 *
 *   node eval/r3/contracts/ledger-contract.mjs
 *
 * @module eval/r3/contracts/ledger-contract
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildLedgers, summarizeLedger } from '../ledger.mjs'

const MANIFEST_CONFIG = {
  leafAdmission: 'economic',
  rootPolicy: 'economics',
  framingMode: 'legacy',
  semanticContinuity: 'off',
  rationaleHintTokens: 800,
  thresholdRatio: 0.5,
  operationalBudgetTokens: 16_384,
  maxSteps: 8,
  retainRatio: 0.04,
  headroomTokens: 512,
}

const checks = []
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail })
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}\n`)
}

function writeReport(root, campaign, cellId, { usage, checker, witness = true }) {
  const dir = join(root, campaign, cellId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'report.json')
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    campaign,
    cellId,
    usage,
    checker: { pass: checker, checks: [] },
    witnesses: witness ? [] : undefined,
    witnessSummary: witness
      ? { attempts: 1, committed: 1, committedAndDelivered: 0 }
      : undefined,
    termination: { kind: 'finish', error: null },
  }, null, 2)}\n`, 'utf8')
  return path
}

function resultFor(cell, { checker, usage, reportPath }) {
  return {
    cell,
    status: 'executed',
    cellId: `${cell.task}-${cell.arm}-r${cell.replicate}`,
    checker,
    usage,
    reportPath,
  }
}

function descriptor({ campaign, campaignIndex, cells }) {
  const sha = String(campaignIndex + 1).repeat(64).slice(0, 64)
  return {
    campaign,
    campaignIndex,
    manifest: { config: MANIFEST_CONFIG },
    manifestSha: sha,
    results: { manifestSha256: sha, results: cells },
  }
}

function runCase(root, name, { planned, campaigns }) {
  const ledgers = buildLedgers({ campaigns, plannedCells: planned, planCampaign: campaigns[0] })
  const summary = summarizeLedger({
    planned: ledgers.planned,
    attempts: ledgers.attempts,
    cells: ledgers.cells,
    campaign: name,
    unplannedAttempts: ledgers.unplannedAttempts,
  })
  return { ledgers, summary, cell: ledgers.cells[0] }
}

function main() {
  const root = mkdtempSync(join(tmpdir(), 'ef-r3-ledger-'))
  const T1 = { task: 'T1-s1', arm: 'B0', replicate: 1 }
  const T2 = { task: 'T2-s1', arm: 'B0', replicate: 1 }
  const plannedT1 = [T1]

  try {
    // 1. A transport failure followed by a successful retry is ONE valid cell.
    {
      const failedPath = writeReport(root, 'campaign-a', 'T1-s1-B0-r1', {
        usage: { requests: 2, inputTokens: 0, outputTokens: 0, unknownUsage: 2 },
        checker: false,
        witness: false,
      })
      const validPath = writeReport(root, 'campaign-b', 'T1-s1-B0-r1', {
        usage: { requests: 4, inputTokens: 100, outputTokens: 10, unknownUsage: 0 },
        checker: true,
      })
      const { cell, summary } = runCase(root, 'failed-then-valid', {
        planned: plannedT1,
        campaigns: [
          descriptor({ campaign: 'campaign-a', campaignIndex: 0, cells: [
            resultFor(T1, { checker: false, usage: { requests: 2, unknownUsage: 2 }, reportPath: failedPath }),
          ] }),
          descriptor({ campaign: 'campaign-b', campaignIndex: 1, cells: [
            resultFor(T1, { checker: true, usage: { requests: 4, unknownUsage: 0 }, reportPath: validPath }),
          ] }),
        ],
      })
      check('failed-then-valid.status', cell.status === 'valid', `status=${cell.status}`)
      check('failed-then-valid.attempts', cell.attempts.length === 2, `attempts=${cell.attempts.length}`)
      check('failed-then-valid.valid', cell.validAttempts.length === 1, `valid=${cell.validAttempts.length}`)
      check('failed-then-valid.transport', cell.transportFailedAttempts.length === 1, `transport=${cell.transportFailedAttempts.length}`)
      check('failed-then-valid.counts', summary.unresolved === 0 && summary.neverStarted === 0 && summary.valid === 1, JSON.stringify({ valid: summary.valid, unresolved: summary.unresolved, neverStarted: summary.neverStarted }))
    }

    // 2. A transport failure with no retry is an unresolved cell, not a task failure.
    {
      const failedPath = writeReport(root, 'campaign-c', 'T1-s1-B0-r1', {
        usage: { requests: 2, inputTokens: 0, outputTokens: 0, unknownUsage: 2 },
        checker: false,
        witness: false,
      })
      const { cell, summary } = runCase(root, 'failed-unresolved', {
        planned: plannedT1,
        campaigns: [
          descriptor({ campaign: 'campaign-c', campaignIndex: 0, cells: [
            resultFor(T1, { checker: false, usage: { requests: 2, unknownUsage: 2 }, reportPath: failedPath }),
          ] }),
        ],
      })
      check('failed-unresolved.status', cell.status === 'unresolved', `status=${cell.status}`)
      check('failed-unresolved.pass', cell.pass === null, `pass=${cell.pass}`)
      check('failed-unresolved.counts', summary.unresolved === 1 && summary.valid === 0, JSON.stringify({ valid: summary.valid, unresolved: summary.unresolved }))
    }

    // 3. Two valid attempts: the earliest campaign wins; the later one is sensitivity.
    {
      const firstPath = writeReport(root, 'campaign-d', 'T1-s1-B0-r1', {
        usage: { requests: 4, inputTokens: 100, outputTokens: 10, unknownUsage: 0 },
        checker: true,
      })
      const laterPath = writeReport(root, 'campaign-e', 'T1-s1-B0-r1', {
        usage: { requests: 4, inputTokens: 100, outputTokens: 10, unknownUsage: 0 },
        checker: false,
      })
      const { cell } = runCase(root, 'duplicate-valid', {
        planned: plannedT1,
        campaigns: [
          descriptor({ campaign: 'campaign-d', campaignIndex: 0, cells: [
            resultFor(T1, { checker: true, usage: { requests: 4, unknownUsage: 0 }, reportPath: firstPath }),
          ] }),
          descriptor({ campaign: 'campaign-e', campaignIndex: 1, cells: [
            resultFor(T1, { checker: false, usage: { requests: 4, unknownUsage: 0 }, reportPath: laterPath }),
          ] }),
        ],
      })
      check('duplicate-valid.chosen', cell.pass === true, `pass=${cell.pass}`)
      check('duplicate-valid.sensitivity', cell.sensitivityAttempts.length === 1, `sensitivity=${cell.sensitivityAttempts.length}`)
    }

    // 4. Partial usage invalidates cost validity, not the task outcome.
    {
      const partialPath = writeReport(root, 'campaign-f', 'T1-s1-B0-r1', {
        usage: { requests: 10, inputTokens: 100, outputTokens: 10, unknownUsage: 2 },
        checker: true,
      })
      const { cell } = runCase(root, 'partial-usage', {
        planned: plannedT1,
        campaigns: [
          descriptor({ campaign: 'campaign-f', campaignIndex: 0, cells: [
            resultFor(T1, { checker: true, usage: { requests: 10, unknownUsage: 2 }, reportPath: partialPath }),
          ] }),
        ],
      })
      check('partial-usage.status', cell.status === 'valid', `status=${cell.status}`)
      check('partial-usage.taskOutcome', cell.taskOutcomeValid === true, `taskOutcomeValid=${cell.taskOutcomeValid}`)
      check('partial-usage.cost', cell.costValid === false, `costValid=${cell.costValid}`)
    }

    // 5. A planned cell with no executed result is never-started.
    {
      const NotExecuted = { ...T1 }
      const { cell, summary } = runCase(root, 'never-started', {
        planned: plannedT1,
        campaigns: [
          descriptor({ campaign: 'campaign-g', campaignIndex: 0, cells: [
            { cell: NotExecuted, status: 'not-executed', cellId: 'T1-s1-B0-r1' },
          ] }),
        ],
      })
      check('never-started.status', cell.status === 'never-started', `status=${cell.status}`)
      check('never-started.observations', cell.notExecutedIn.includes('campaign-g'), `notExecutedIn=${JSON.stringify(cell.notExecutedIn)}`)
      check('never-started.counts', summary.neverStarted === 1 && summary.unresolved === 0, JSON.stringify({ unresolved: summary.unresolved, neverStarted: summary.neverStarted }))
    }

    // 6. A result for an unplanned cell does not enter the denominator.
    {
      const extraPath = writeReport(root, 'campaign-h', 'T2-s1-B0-r1', {
        usage: { requests: 4, inputTokens: 100, outputTokens: 10, unknownUsage: 0 },
        checker: true,
      })
      const { cell, summary, ledgers } = runCase(root, 'manifest-mismatch', {
        planned: plannedT1,
        campaigns: [
          descriptor({ campaign: 'campaign-h', campaignIndex: 0, cells: [
            resultFor(T2, { checker: true, usage: { requests: 4, unknownUsage: 0 }, reportPath: extraPath }),
          ] }),
        ],
      })
      check('manifest-mismatch.planned', cell.status === 'never-started', `planned cell status=${cell.status}`)
      check('manifest-mismatch.unplanned', ledgers.unplannedAttempts.length === 1, `unplanned=${JSON.stringify(ledgers.unplannedAttempts)}`)
      check('manifest-mismatch.denominator', summary.planned === 1 && summary.valid === 0, JSON.stringify({ planned: summary.planned, valid: summary.valid }))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const passed = checks.filter(entry => entry.pass).length
  const failed = checks.length - passed
  const output = {
    schemaVersion: 1,
    work: 'EF-R3 WP1',
    generatedAt: new Date().toISOString(),
    checks,
    passed,
    failed,
    verdict: failed === 0 ? 'contract-pass' : 'contract-fail',
  }
  const outDir = join(process.cwd(), 'eval', 'r3', 'out')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'ledger-contract.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`${passed}/${checks.length} checks passed\n`)
  if (failed > 0) process.exit(1)
}

main()
