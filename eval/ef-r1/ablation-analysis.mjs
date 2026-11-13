#!/usr/bin/env node
/**
 * EF-R1 — the pre-registered analysis of the 120-cell L×G campaign.
 *
 * The unit is the task instance (template + seed), not the cell. Two paired
 * replicates exist per instance; the cell-level McNemar is reported as a
 * descriptive paired count, and the 12 instance-level differences are reported
 * separately so a reader can see whether the effect is broad or carried by one
 * template.
 *
 * The task-prompt covariate is not optional: at the 16k operational budget the
 * active request itself is sometimes folded (WP2 measured this), and a cell
 * that lost its instruction is not a retrieval failure. Every arm is split by
 * `taskPromptLost` from the stage attribution.
 *
 * No provider request is made.
 *
 *   node eval/ef-r1/ablation-analysis.mjs
 *
 * @module eval/ef-r1/ablation-analysis
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(ROOT, 'eval', 'e2e', 'out')
const MY_OUT = join(HERE, 'out')
const CAMPAIGN = 'e2e-lg-confirm-1'
const ARMS = ['E0', 'E0-L', 'E0-G', 'E0-LG', 'E1']
/**
 * Templates excluded from a SECONDARY run only.
 *
 * T10 is not excluded because it failed; it is excluded because the pilot
 * exposed a fixture defect: its random log contained concurrency values that
 * contradicted the changelog, so a model answering from the log could be
 * defensibly right and fail the checker. The confirm was frozen before the fix,
 * so its T10 cells are reported separately and never used as the primary
 * estimate.
 */
const EXCLUDE = new Set((process.env.EF_R1_EXCLUDE_TEMPLATES ?? '').split(',').filter(Boolean))

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const results = readJson(join(OUT, `results-${CAMPAIGN}.json`))
const stages = readJson(join(OUT, 'stage-attribution.json'))
const stageByCell = new Map(stages.rows
  .filter(row => row.campaign === CAMPAIGN)
  .map(row => [row.cellId, row]))

const cells = results.results.map(row => {
  const stage = stageByCell.get(row.cellId)
  return {
    cellId: row.cellId,
    task: row.cell.task,
    template: row.cell.task.replace(/-s\d$/u, ''),
    seed: Number(row.cell.task.slice(-1)),
    arm: row.cell.arm,
    replicate: row.cell.replicate,
    pass: row.checker === true,
    requests: row.usage.requests,
    inputTokens: row.usage.inputTokens,
    outputTokens: row.usage.outputTokens,
    failureStage: stage?.failureStage ?? null,
    taskPromptLost: stage?.taskPromptLost ?? null,
    key: `${row.cell.task}-r${row.cell.replicate}`,
  }
}).filter(row => !EXCLUDE.has(row.template))

const count = (list, predicate) => list.filter(predicate).length

function perArm(list) {
  const out = {}
  for (const arm of ARMS) {
    const rows = list.filter(row => row.arm === arm)
    out[arm] = {
      cells: rows.length,
      passed: count(rows, row => row.pass),
      rate: rows.length === 0 ? null : Number((count(rows, row => row.pass) / rows.length).toFixed(3)),
      requests: rows.reduce((sum, row) => sum + row.requests, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    }
  }
  return out
}

/** Two-sided exact McNemar: b and c are the discordant counts. */
function exactMcNemar(b, c) {
  const n = b + c
  if (n === 0) return 1
  let tail = 0
  let term = 1
  for (let k = 0; k <= Math.min(b, c); k += 1) {
    if (k > 0) term = (term * (n - k + 1)) / k
    tail += term
  }
  return Math.min(1, 2 * tail * 0.5 ** n)
}

function paired(leftArm, rightArm) {
  const byKey = new Map(cells.map(row => [`${row.key}:${row.arm}`, row]))
  let both = 0
  let neither = 0
  let leftOnly = 0
  let rightOnly = 0
  const instance = new Map()
  for (const key of new Set(cells.map(row => row.key))) {
    const left = byKey.get(`${key}:${leftArm}`)
    const right = byKey.get(`${key}:${rightArm}`)
    if (left === undefined || right === undefined) continue
    if (left.pass && right.pass) both += 1
    else if (!left.pass && !right.pass) neither += 1
    else if (left.pass) leftOnly += 1
    else rightOnly += 1
    const task = left.task
    const entry = instance.get(task) ?? { task, left: 0, right: 0, n: 0 }
    entry.left += left.pass ? 1 : 0
    entry.right += right.pass ? 1 : 0
    entry.n += 1
    instance.set(task, entry)
  }
  const instances = [...instance.values()].map(entry => ({
    ...entry,
    difference: Number(((entry.left - entry.right) / entry.n).toFixed(3)),
  }))
  return {
    left: leftArm,
    right: rightArm,
    pairs: both + neither + leftOnly + rightOnly,
    both,
    neither,
    leftOnly,
    rightOnly,
    riskDifference: Number(((leftOnly - rightOnly) / Math.max(1, both + neither + leftOnly + rightOnly)).toFixed(3)),
    mcnemarP: Number(exactMcNemar(leftOnly, rightOnly).toFixed(4)),
    instances,
    instancesFavoringLeft: instances.filter(entry => entry.difference > 0).length,
    instancesFavoringRight: instances.filter(entry => entry.difference < 0).length,
    instancesTied: instances.filter(entry => entry.difference === 0).length,
  }
}

const byTemplate = {}
for (const template of [...new Set(cells.map(row => row.template))].sort()) {
  byTemplate[template] = perArm(cells.filter(row => row.template === template))
}
const lost = cells.filter(row => row.taskPromptLost === true)
const visible = cells.filter(row => row.taskPromptLost !== true)
const failureStages = {}
for (const arm of ARMS) {
  const bucket = {}
  for (const row of cells.filter(entry => entry.arm === arm && !entry.pass)) {
    bucket[row.failureStage ?? 'unknown'] = (bucket[row.failureStage ?? 'unknown'] ?? 0) + 1
  }
  failureStages[arm] = bucket
}

const comparisons = [
  paired('E0-L', 'E0'),
  paired('E0-G', 'E0'),
  paired('E0-LG', 'E0'),
  paired('E0-LG', 'E0-L'),
  paired('E0-LG', 'E0-G'),
  paired('E1', 'E0'),
]

const output = {
  schemaVersion: 1,
  work: 'EF-R1 ablation',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  design: results.manifestSha256,
  excludedTemplates: [...EXCLUDE],
  cells: cells.length,
  usage: results.budget.used,
  byArm: perArm(cells),
  byTemplate,
  comparisons,
  taskPrompt: {
    lostCells: lost.length,
    visibleCells: visible.length,
    byArmLost: perArm(lost),
    byArmVisible: perArm(visible),
  },
  failureStages,
  sources: {
    results: `eval/e2e/out/results-${CAMPAIGN}.json`,
    resultsSha256: sha256(join(OUT, `results-${CAMPAIGN}.json`)),
    stageAttribution: 'eval/e2e/out/stage-attribution.json',
    stageAttributionSha256: sha256(join(OUT, 'stage-attribution.json')),
  },
  note: 'Cell-level McNemar is descriptive; the 12 task-instance differences are the primary grouping. The task-prompt split is a covariate, not a post-hoc exclusion.',
}
const suffix = EXCLUDE.size === 0 ? '' : `-excluding-${[...EXCLUDE].join('-').toLowerCase()}`
writeFileSync(join(MY_OUT, `ablation-analysis${suffix}.json`), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R1 — 120-cell L×G analysis')
md.push('')
md.push(`Campaign \`${CAMPAIGN}\`, ${cells.length} cells, ${results.budget.used.requests} requests, `
  + `${results.budget.used.inputTokens} input, ${results.budget.used.outputTokens} output.`)
md.push('')
md.push('| Arm | Pass | Rate | Requests | Input | Output |')
md.push('|---|---|---|---|---|---|')
for (const arm of ARMS) {
  const row = output.byArm[arm]
  md.push(`| ${arm} | ${row.passed}/${row.cells} | ${row.rate} | ${row.requests} | ${row.inputTokens} | ${row.outputTokens} |`)
}
md.push('')
md.push('## Paired comparisons (same task instance + replicate)')
md.push('')
md.push('| Left | Right | Left only | Right only | McNemar p | Risk difference | Instances L/R/tied |')
md.push('|---|---|---|---|---|---|---|')
for (const row of comparisons) {
  md.push(`| ${row.left} | ${row.right} | ${row.leftOnly} | ${row.rightOnly} | ${row.mcnemarP} | ${row.riskDifference} | ${row.instancesFavoringLeft}/${row.instancesFavoringRight}/${row.instancesTied} |`)
}
md.push('')
md.push('## Task-prompt covariate')
md.push('')
md.push(`The active task prompt was folded in ${lost.length} of ${cells.length} cells. This is not an exclusion: it is a separate failure mode.`)
md.push('')
md.push('| Arm | Pass (prompt lost) | Pass (prompt visible) |')
md.push('|---|---|---|')
for (const arm of ARMS) {
  const a = output.taskPrompt.byArmLost[arm]
  const b = output.taskPrompt.byArmVisible[arm]
  md.push(`| ${arm} | ${a.passed}/${a.cells} | ${b.passed}/${b.cells} |`)
}
md.push('')
md.push('## Failure stages by arm')
md.push('')
md.push('| Arm | Stages |')
md.push('|---|---|')
for (const arm of ARMS) {
  const stagesText = Object.entries(failureStages[arm]).map(([stage, count]) => `${stage} ${count}`).join(', ')
  md.push(`| ${arm} | ${stagesText || '—'} |`)
}
md.push('')
md.push('## Per template')
md.push('')
md.push('| Template | E0 | E0-L | E0-G | E0-LG | E1 |')
md.push('|---|---|---|---|---|---|')
for (const [template, arms] of Object.entries(byTemplate)) {
  md.push(`| ${template} | ${arms.E0.passed}/${arms.E0.cells} | ${arms['E0-L'].passed}/${arms['E0-L'].cells} | ${arms['E0-G'].passed}/${arms['E0-G'].cells} | ${arms['E0-LG'].passed}/${arms['E0-LG'].cells} | ${arms.E1.passed}/${arms.E1.cells} |`)
}
writeFileSync(join(MY_OUT, `ablation-analysis${suffix}.md`), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`ablation analysis: ${cells.length} cells\n`)
for (const arm of ARMS) process.stdout.write(`  ${arm}: ${output.byArm[arm].passed}/${output.byArm[arm].cells}\n`)
for (const row of comparisons) {
  process.stdout.write(`  ${row.left} vs ${row.right}: +${row.leftOnly}/-${row.rightOnly}, p=${row.mcnemarP}, instances ${row.instancesFavoringLeft}/${row.instancesFavoringRight}/${row.instancesTied}\n`)
}
process.stdout.write(`  task prompt lost: ${lost.length}/${cells.length}\n`)
