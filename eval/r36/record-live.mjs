#!/usr/bin/env node
/**
 * Record the authorized R36 live results from the run artifacts.
 *
 * This reads the run-scoped reports and the two semantic analysis files. It
 * makes no provider call. Monetary cost is not reported because there is no
 * trusted price profile.
 *
 * @module eval/r36/record-live
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNS = join(HERE, 'runs')
const OUT = join(HERE, 'out', 'live-results.json')

const writer = JSON.parse(await readFile(join(HERE, 'out', 'live-writer-analysis.json'), 'utf8'))
const harness = JSON.parse(await readFile(join(HERE, 'out', 'harness-calibration.json'), 'utf8'))
let causal = null
try {
  causal = JSON.parse(await readFile(join(HERE, 'out', 'causal-comparison.json'), 'utf8'))
} catch {
  // No B1/S run yet.
}

const runIds = (await readdir(RUNS)).sort()
const runs = []
const total = { attempts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownUsage: 0, retries: 0 }
const byStage = { 'writer-only': { ...total }, continuation: { ...total }, other: { ...total } }
for (const runId of runIds) {
  let report
  try {
    report = JSON.parse(await readFile(join(RUNS, runId, 'report.json'), 'utf8'))
  } catch {
    continue
  }
  const used = report.ledger?.used ?? {}
  const cost = {
    attempts: used.attempts ?? 0,
    input: used.inputTokens ?? 0,
    output: used.outputTokens ?? 0,
    cacheRead: used.cacheReadTokens ?? 0,
    cacheWrite: used.cacheWriteTokens ?? 0,
    unknownUsage: used.unknownUsageRequests ?? 0,
    retries: used.retries ?? 0,
  }
  const bucket = byStage[report.stage] ?? byStage.other
  for (const key of Object.keys(total)) {
    total[key] += cost[key]
    bucket[key] += cost[key]
  }
  runs.push({
    runId,
    status: report.status,
    stage: report.stage ?? null,
    arms: report.arms ?? null,
    promptVersion: report.modelParameters?.writerPromptVersion ?? null,
    followUpSteps: report.modelParameters?.followUpSteps ?? null,
    followUpMaxTokens: report.modelParameters?.followUpMaxTokens ?? null,
    finishGuard: report.modelParameters?.finishGuard ?? null,
    validRows: report.quality?.validCases ?? null,
    taskSuccesses: report.quality?.taskSuccesses ?? null,
    contractSuccesses: report.quality?.contractSuccesses ?? null,
    providerAvailability: report.providerAvailability ?? null,
    cost,
  })
}

const writerRuns = writer.runs.map(run => ({
  runId: run.runId,
  promptVersion: run.promptVersion,
  promptDigest: run.promptDigest,
  status: run.status,
  summary: run.summary,
  perCase: run.rows.map(row => ({
    caseId: row.caseId,
    protocol: row.protocol,
    category: row.category,
    proposed: row.proposed,
    accepted: row.accepted,
    refused: row.refused,
    refusalReasons: row.refusalReasons,
    commitStatus: row.commitStatus,
    rates: row.rates,
    exactScorer: row.exactScorer,
  })),
  cost: run.ledger?.used ?? null,
}))

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  authorization: {
    status: 'granted',
    basis: 'The user explicitly granted R36 spend on 2026-11-05.',
    model: 'deepseek-v4.1-flash',
    provider: 'zcode local proxy (provider c15ab109-97b8-4de1-a647-9857a635be38)',
    route: 'http://127.0.0.1:7866/v1',
    directOpenCode: 'three direct /zen/go/v1 keys answered HTTP 401 api_key_expired and were not used',
    key: 'read from the ZCode config at runtime; never written to a report',
  },
  writer: {
    status: 'executed (one replicate, six certified cases)',
    comparison: 'W0-P0 vs W1-P0, same model, route, dataset, limits, and six cases',
    runs: writerRuns,
    note: 'Semantic rates use the documented funnel matcher, not the exact-statement scorer. The exact scorer reports 0 for both prompts because the writer paraphrases.',
  },
  harness: {
    status: 'executed (O2 calibration)',
    conditions: harness.conditions.map(condition => ({
      condition: condition.condition,
      runIds: condition.runIds,
      summary: condition.summary,
      perCase: condition.rows.map(row => ({
        caseId: row.caseId,
        valid: row.valid,
        taskSuccess: row.taskSuccess,
        contractSuccess: row.contractSuccess,
        processViolation: row.processViolation,
        falseVerificationClaim: row.falseVerificationClaim,
        testsExecuted: row.testsExecuted,
        steps: row.steps,
        finished: row.finished,
        guardRejections: row.guardRejections,
        failedChecks: row.failedChecks,
        finalVerificationStatus: row.finalVerificationStatus,
      })),
    })),
    note: 'H-combined is exploratory: 16 steps plus the finish guard, selected after the single-factor results. It is not a pre-registered arm.',
  },
  causal: causal === null
    ? {
      status: 'not-run',
      gate: 'G4 blocked',
      reason: 'No B1/S run.',
      b1sRows: 0,
    }
    : {
      status: 'executed',
      gate: 'G4 partial (exploratory)',
      harness: causal.harness,
      replicates: causal.replicates,
      cases: causal.cases,
      contract: causal.contract,
      task: causal.task,
      byReplicate: causal.byReplicate,
      byCase: causal.byCase,
      oracle: causal.oracle,
      b1sRows: causal.contract.pairs,
      reason: 'Exploratory mixed result: 1 rescue, 3 damage, 4 both, 4 neither over 12 valid pairs. '
        + 'The damage is not a clean memory-loss signal: A1\'s S checkpoint contains the compatibility constraint but the agent kept the old string shape, '
        + 'B2\'s S checkpoint contains the in-memory decision but the agent wrote a broken module or skipped tests, and C1\'s rescue appears only when the fold commits. '
        + 'Small n and one model/route: not an equivalence or superiority claim.',
    },
  cost: {
    total,
    byStage,
    runs: runs.length,
    note: 'Every HTTP attempt, including the failed transport attempts, is counted. Unknown usage is not zero. No currency is reported.',
  },
  runs,
}
await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write(`live results: ${OUT}\n`)
process.stdout.write(`runs ${runs.length}; HTTP attempts ${total.attempts}; input ${total.input}; output ${total.output}; cache read ${total.cacheRead}; unknown ${total.unknownUsage}\n`)
process.stdout.write(`writer: W0 ${writer.runs[0]?.summary.commitRecall} commit; W1 ${writer.runs[1]?.summary.commitRecall} commit\n`)
for (const condition of harness.conditions) {
  process.stdout.write(`${condition.condition}: ${condition.summary.contractSuccesses}/${condition.summary.valid} contract, ${condition.summary.taskSuccesses}/${condition.summary.valid} task\n`)
}
