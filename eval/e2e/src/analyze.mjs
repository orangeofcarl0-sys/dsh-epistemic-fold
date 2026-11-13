#!/usr/bin/env node
/**
 * Aggregate one campaign.
 *
 * The unit of analysis is the CELL. A template is a group, not a sample: the
 * two seeds of one template are the same task shape, and pooling them as
 * independent tasks would overstate the evidence. The report says so, and the
 * tables are per template.
 *
 * @module eval/e2e/src/analyze
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = join(ROOT, 'eval', 'e2e', 'out')
// A later round's instances live in their own directory; the default keeps
// every existing command pointed at the frozen EF-E2E set.
const TASKS = process.env.EF_E2E_TASKS_DIR === undefined
  ? join(ROOT, 'eval', 'e2e', 'tasks')
  : resolve(ROOT, process.env.EF_E2E_TASKS_DIR)

const argv = process.argv.slice(2)
const at = argv.indexOf('--campaign')
const campaign = at === -1 ? 'e2e-core-1' : argv[at + 1]

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

/**
 * The fact a task is about, for "was it visible after the fold?".
 *
 * Derived from the REFERENCE answer, never from the model's output: the point
 * is whether the checkpoint or a recall result carried the value the task
 * needed, not whether the model happened to produce it.
 */
function probesFor(task) {
  const reference = task.reference ?? {}
  if (task.template === 'T2') {
    const answer = JSON.parse(reference['answer.json'] ?? '{}')
    return [answer.build, String(answer.timeout_ms)].filter(value => typeof value === 'string')
  }
  if (task.template === 'T4') {
    const answer = JSON.parse(reference['deploy.plan.json'] ?? '{}')
    return [answer.region, String(answer.replicas)].filter(value => typeof value === 'string')
  }
  if (task.template === 'T5' || task.template === 'T5B') {
    const answer = JSON.parse(reference['final.json'] ?? '{}')
    return [String(answer.max_attempts), String(answer.window_seconds)].filter(value => typeof value === 'string')
  }
  if (task.template === 'T6') {
    return ['250', 'four']
  }
  return []
}

/** Flatten a JSON value to path → scalar, for a value-presence comparison. */
function flatten(value, prefix = '', out = {}) {
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) flatten(entry, `${prefix}${prefix === '' ? '' : '.'}${key}`, out)
  } else {
    out[prefix] = value
  }
  return out
}

/**
 * Why a checker failed.
 *
 * A missing file, a nested answer and a wrong value are three different
 * failures, and only the last is a claim about the model's memory or quality.
 * Reporting them as one "checker fail" would overstate the mechanism result.
 */
function classifyFailure(task, workspace) {
  const jsonChecks = (task.checks ?? []).filter(check => check.kind === 'json_equals')
  if (jsonChecks.length === 0) return { failureClass: null, failureDetail: null }
  for (const check of jsonChecks) {
    const file = join(workspace, check.path)
    if (!existsSync(file)) return { failureClass: 'missing-output', failureDetail: check.path }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return { failureClass: 'wrong-shape', failureDetail: `${check.path} is not JSON` }
    }
    if (JSON.stringify(parsed) === JSON.stringify(check.value)) continue
    const produced = Object.values(flatten(parsed))
    const expected = Object.values(flatten(check.value))
    const valuesPresent = expected.every(value => produced.includes(value))
    return {
      failureClass: valuesPresent ? 'shape-mismatch' : 'wrong-value',
      failureDetail: `${check.path} = ${JSON.stringify(parsed).slice(0, 200)}`,
    }
  }
  return { failureClass: null, failureDetail: null }
}

function countByName(report, names) {
  return Object.entries(report.tools.byName ?? {})
    .filter(([name]) => names.includes(name))
    .reduce((sum, [, count]) => sum + count, 0)
}

async function main() {
  const results = await readJson(join(OUT, `results-${campaign}.json`))
  const taskCache = new Map()
  const rows = []
  const evidence = []

  for (const result of results.results) {
    if (result.status !== 'executed') {
      rows.push({
        cellId: `${result.cell.task}-${result.cell.arm}-r${result.cell.replicate}`,
        block: result.cell.block,
        status: result.status,
        reason: result.reason,
      })
      continue
    }
    const reportPath = result.reportPath
    const report = await readJson(reportPath)
    const taskId = report.task.id
    if (!taskCache.has(taskId)) taskCache.set(taskId, await readJson(join(TASKS, `${taskId}.json`)))
    const task = taskCache.get(taskId)
    const probes = probesFor(task)
    const checkpointText = report.checkpoint?.text ?? ''
    // `error === null` is not a commit: an open attempt has no error either.
    // New reports carry the per-attempt witness; older reports keep the legacy
    // count and are labelled as such rather than silently re-interpreted.
    const legacySuccessfulFolds = (report.compactions ?? []).filter(row => row.error === null).length
    const legacyFailedFolds = (report.compactions ?? []).filter(row => row.error !== null).length
    const witness = report.witnessSummary ?? null
    const successfulFolds = witness === null ? legacySuccessfulFolds : witness.committed
    const failedFolds = witness === null
      ? legacyFailedFolds
      : (witness.refused ?? 0) + (witness.aborted ?? 0)
    const row = {
      cellId: report.cellId,
      block: result.cell.block,
      template: report.task.template,
      seed: report.task.seed,
      arm: report.arm,
      replicate: result.cell.replicate,
      status: 'executed',
      exposure: report.treatmentExposure,
      committedExposure: report.committedExposure ?? null,
      folds: successfulFolds,
      legacyFolds: legacySuccessfulFolds,
      witness: witness !== null,
      foldAttempts: witness === null ? (report.compactions ?? []).length : witness.attempts,
      foldFailures: failedFolds,
      refusedAttempts: witness === null ? null : (witness.refused ?? 0),
      unverifiableAttempts: witness === null ? null : (witness.unverifiable ?? 0),
      checkpoint: report.checkpoint === null ? null : {
        chars: report.checkpoint.chars,
        mode: report.checkpoint.mode,
        source: report.checkpoint.source,
        probesVisible: probes.filter(probe => checkpointText.includes(probe)),
      },
      probes,
      recallCalls: countByName(report, ['context_search', 'context_recall']),
      checkerPass: report.checker.pass,
      ...(report.checker.pass
        ? { failureClass: null, failureDetail: null }
        : classifyFailure(task, join(dirname(reportPath), 'workspace'))),
      checks: report.checker.checks,
      termination: report.termination.kind,
      stepLimit: report.termination.stepLimit,
      requests: report.usage.requests,
      auxiliaryRequests: report.usage.auxiliary.requests,
      inputTokens: report.usage.inputTokens,
      outputTokens: report.usage.outputTokens,
      cacheReadTokens: report.usage.cacheReadTokens,
      cacheWriteTokens: report.usage.cacheWriteTokens,
      unknownUsage: report.usage.unknownUsage,
      testsExecuted: report.tools.testsExecuted,
      lastTestExit: report.tools.lastTestExit,
      toolErrors: report.tools.errors,
      falseVerification: report.behaviour.falseVerification,
      finalText: report.behaviour.finalText.slice(0, 600),
      reportPath: reportPath.slice(ROOT.length + 1),
      reportSha256: sha256(await readFile(reportPath, 'utf8')),
      engineDecision: report.engineDecision,
      thresholdTokens: report.thresholdTokens,
      retainedTokens: report.retainedTokens,
    }
    rows.push(row)
    evidence.push({ cellId: row.cellId, path: row.reportPath, sha256: row.reportSha256 })
  }

  const executed = rows.filter(row => row.status === 'executed')
  const mean = values => values.length === 0 ? null : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3))
  const aggregate = (subset) => ({
    cells: subset.length,
    checkerPasses: subset.filter(row => row.checkerPass).length,
    passRate: subset.length === 0 ? null : Number((subset.filter(row => row.checkerPass).length / subset.length).toFixed(3)),
    folds: subset.reduce((sum, row) => sum + row.folds, 0),
    legacyFolds: subset.reduce((sum, row) => sum + (row.legacyFolds ?? 0), 0),
    foldedWithWitness: subset.filter(row => row.witness === true).length,
    foldFailures: subset.reduce((sum, row) => sum + row.foldFailures, 0),
    noFold: subset.filter(row => row.folds === 0).length,
    recallCells: subset.filter(row => row.recallCalls > 0).length,
    requests: subset.reduce((sum, row) => sum + row.requests, 0),
    auxiliaryRequests: subset.reduce((sum, row) => sum + row.auxiliaryRequests, 0),
    inputTokens: subset.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: subset.reduce((sum, row) => sum + row.outputTokens, 0),
    cacheReadTokens: subset.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    unknownUsage: subset.reduce((sum, row) => sum + row.unknownUsage, 0),
    testsExecuted: subset.reduce((sum, row) => sum + row.testsExecuted, 0),
    falseVerifications: subset.filter(row => row.falseVerification).length,
    failureClasses: subset.filter(row => !row.checkerPass).reduce((counts, row) => {
      const key = row.failureClass ?? 'other'
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {}),
    meanRequests: mean(subset.map(row => row.requests)),
    meanInputTokens: mean(subset.map(row => row.inputTokens)),
    meanOutputTokens: mean(subset.map(row => row.outputTokens)),
    meanFolds: mean(subset.map(row => row.folds)),
  })

  const byTemplateArm = {}
  for (const template of [...new Set(executed.map(row => row.template))].sort()) {
    byTemplateArm[template] = {}
    for (const arm of ['B0', 'E0', 'E0a', 'E0i', 'E0ai', 'E0-L', 'E0-G', 'E0-LG', 'E0-P', 'E0-R', 'E1', 'S']) {
      byTemplateArm[template][arm] = aggregate(executed.filter(row => row.template === template && row.arm === arm))
    }
  }
  const byArm = {}
  for (const arm of ['B0', 'E0', 'E0a', 'E0i', 'E0ai', 'E0-L', 'E0-G', 'E0-LG', 'E0-P', 'E0-R', 'E1', 'S']) byArm[arm] = aggregate(executed.filter(row => row.arm === arm))
  const byBlock = {}
  for (const block of ['calibration', 'core']) byBlock[block] = aggregate(executed.filter(row => row.block === block))

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    campaign,
    status: results.status,
    budget: results.budget,
    model: results.model,
    route: results.route,
    units: {
      cell: 'one continuation of one task instance under one arm',
      template: 'a task shape; its two seeds are NOT independent tasks',
      note: 'pass rates are descriptive; no significance test is claimed',
    },
    byArm,
    byBlock,
    byTemplateArm,
    rows,
    evidence,
  }
  await writeFile(join(OUT, `analysis-${campaign}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(join(OUT, `evidence-index-${campaign}.json`), `${JSON.stringify({
    schemaVersion: 1,
    campaign,
    note: 'Raw cell directories are gitignored; these hashes pin the reports that were analysed.',
    files: evidence,
  }, null, 2)}\n`, 'utf8')

  const md = []
  md.push(`# EF-E2E core campaign — ${campaign}`)
  md.push('')
  md.push(`Status: **${results.status}**. ${results.executed}/${results.planned} cells executed.`)
  md.push('')
  md.push('| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |')
  md.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const arm of ['B0', 'E0', 'E0a', 'E0i', 'E0ai', 'E0-L', 'E0-G', 'E0-LG', 'E0-P', 'E0-R', 'E1', 'S']) {
    const row = byArm[arm]
    md.push(`| ${arm} | ${row.cells} | ${row.checkerPasses} | ${row.passRate} | ${row.folds} | ${row.noFold} | ${row.recallCells} | ${row.requests} | ${row.auxiliaryRequests} | ${row.inputTokens} | ${row.outputTokens} |`)
  }
  md.push('')
  md.push('| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |')
  md.push('|---|---|---|---|---|---|---|---|---|')
  for (const [template, arms] of Object.entries(byTemplateArm)) {
    for (const arm of ['B0', 'E0', 'E0a', 'E0i', 'E0ai', 'E0-L', 'E0-G', 'E0-LG', 'E0-P', 'E0-R', 'E1', 'S']) {
      const row = arms[arm]
      md.push(`| ${template} | ${arm} | ${row.checkerPasses}/${row.cells} | ${row.passRate} | ${row.meanFolds} | ${row.meanRequests} | ${row.auxiliaryRequests} | ${row.meanInputTokens} | ${row.meanOutputTokens} |`)
    }
  }
  md.push('')
  md.push('## Per-cell')
  md.push('')
  md.push('| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |')
  md.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const row of executed) {
    md.push(`| ${row.cellId} | ${row.block} | ${row.exposure} | ${row.folds} (${row.foldFailures}) | ${row.checkerPass ? 'pass' : 'fail'} | ${row.recallCalls} | ${row.requests} (${row.auxiliaryRequests}) | ${row.inputTokens} | ${row.outputTokens} | ${row.checkpoint === null ? '—' : `${row.checkpoint.probesVisible.length}/${row.probes.length}`} |`)
  }
  md.push('')
  md.push('## What this table does not say')
  md.push('')
  md.push('- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.')
  md.push('- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.')
  md.push('- `inputTokens` is the provider\'s uncached input. Cache reads are reported in the JSON, not folded into this column.')
  md.push('- No cost in currency is claimed: this route has no verifiable per-token price.')
  await writeFile(join(OUT, `analysis-${campaign}.md`), `${md.join('\n')}\n`, 'utf8')

  process.stdout.write(`analysis ${campaign}: ${executed.length} executed cell(s)\n`)
  for (const arm of ['B0', 'E0', 'E0a', 'E0i', 'E0ai', 'E0-L', 'E0-G', 'E0-LG', 'E0-P', 'E0-R', 'E1', 'S']) {
    const row = byArm[arm]
    process.stdout.write(`  ${arm}: pass ${row.checkerPasses}/${row.cells}, folds ${row.folds}, aux ${row.auxiliaryRequests}, `
      + `in ${row.inputTokens}, out ${row.outputTokens}, recall cells ${row.recallCells}\n`)
  }
}

await main()
