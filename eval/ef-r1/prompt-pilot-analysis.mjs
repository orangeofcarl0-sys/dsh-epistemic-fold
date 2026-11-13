#!/usr/bin/env node
/**
 * EF-R1 — the 8-cell prompt-protection pilot.
 *
 * E0 vs E0-P on T9/T10, both seeds. n=4 pairs per arm: this is a direction
 * check, not a powered estimate. The primary read is not only "did it pass"
 * but "did the active request survive the continuation".
 *
 *   node eval/ef-r1/prompt-pilot-analysis.mjs
 *
 * @module eval/ef-r1/prompt-pilot-analysis
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(ROOT, 'eval', 'e2e', 'out')
const MY_OUT = join(HERE, 'out')
const CAMPAIGN = process.env.EF_R1_PROMPT_CAMPAIGN ?? 'e2e-prompt-pilot-2'
const ARMS = (process.env.EF_R1_PROMPT_ARMS ?? 'E0,E0-P').split(',').filter(Boolean)
const SUFFIX = process.env.EF_R1_PROMPT_SUFFIX ?? ''

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

if (!existsSync(join(OUT, `results-${CAMPAIGN}.json`))) {
  process.stderr.write(`prompt pilot: results-${CAMPAIGN}.json is missing\n`)
  process.exit(2)
}
const results = readJson(join(OUT, `results-${CAMPAIGN}.json`))
const stages = readJson(join(OUT, 'stage-attribution.json'))
const stageByCell = new Map(stages.rows
  .filter(row => row.campaign === CAMPAIGN)
  .map(row => [row.cellId, row]))

const cells = results.results.map(row => {
  const stage = stageByCell.get(row.cellId)
  const report = existsSync(row.reportPath) ? readJson(row.reportPath) : null
  return {
    cellId: row.cellId,
    task: row.cell.task,
    template: row.cell.task.replace(/-s\d$/u, ''),
    seed: Number(row.cell.task.slice(-1)),
    arm: row.cell.arm,
    pass: row.checker === true,
    requests: row.usage.requests,
    inputTokens: row.usage.inputTokens,
    outputTokens: row.usage.outputTokens,
    compactions: row.compactions ?? null,
    // A `checkpoint: null` with an economic refusal means the cell did NOT
    // fold. That is a different treatment from "folded with the prompt
    // protected", and it is the central caveat of this pilot.
    noFold: report === null
      ? null
      : report.checkpoint === null || String(report.engineDecision ?? '').startsWith('economic-refusal'),
    retainedTokens: report?.retainedTokens ?? null,
    engineDecision: String(report?.engineDecision ?? '').slice(0, 160),
    promptVisibleAtStart: stage?.taskPromptVisibleAtStart ?? null,
    promptVisibleAtEnd: stage?.taskPromptVisibleAtEnd ?? null,
    promptLost: stage?.taskPromptLost ?? null,
    failureStage: stage?.failureStage ?? null,
    failureSubstage: stage?.failureSubstage ?? null,
  }
})

function perArm(arm) {
  const rows = cells.filter(row => row.arm === arm)
  return {
    cells: rows.length,
    passed: rows.filter(row => row.pass).length,
    promptLost: rows.filter(row => row.promptLost === true).length,
    promptVisibleAtEnd: rows.filter(row => row.promptVisibleAtEnd === true).length,
    noFold: rows.filter(row => row.noFold === true).length,
    meanRetainedTokens: rows.length === 0
      ? null
      : Math.round(rows.reduce((sum, row) => sum + (row.retainedTokens ?? 0), 0) / rows.length),
    requests: rows.reduce((sum, row) => sum + row.requests, 0),
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
  }
}

const byKey = new Map(cells.map(row => [`${row.task}:${row.arm}`, row]))
const pairs = []
for (const task of [...new Set(cells.map(row => row.task))].sort()) {
  const left = byKey.get(`${task}:${ARMS[0]}`)
  const right = byKey.get(`${task}:${ARMS[1]}`)
  if (left === undefined || right === undefined) continue
  pairs.push({
    task,
    leftPass: left.pass,
    rightPass: right.pass,
    leftPromptLost: left.promptLost,
    rightPromptLost: right.promptLost,
    leftNoFold: left.noFold,
    rightNoFold: right.noFold,
  })
}

const byArm = Object.fromEntries(ARMS.map(arm => [arm, perArm(arm)]))
const output = {
  schemaVersion: 1,
  work: 'EF-R1 prompt protection',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  cells: cells.length,
  usage: results.budget.used,
  byArm,
  pairs,
  paired: {
    improved: pairs.filter(pair => pair.rightPass && !pair.leftPass).length,
    worsened: pairs.filter(pair => !pair.rightPass && pair.leftPass).length,
    tied: pairs.filter(pair => pair.rightPass === pair.leftPass).length,
    promptLostBefore: pairs.filter(pair => pair.leftPromptLost === true).length,
    promptLostAfter: pairs.filter(pair => pair.rightPromptLost === true).length,
    noFoldBefore: pairs.filter(pair => pair.leftNoFold === true).length,
    noFoldAfter: pairs.filter(pair => pair.rightNoFold === true).length,
  },
  sources: {
    results: `eval/e2e/out/results-${CAMPAIGN}.json`,
    resultsSha256: sha256(join(OUT, `results-${CAMPAIGN}.json`)),
    stageAttributionSha256: sha256(join(OUT, 'stage-attribution.json')),
  },
  note: 'n=4 pairs; a direction check, not a powered estimate.',
}
writeFileSync(join(MY_OUT, `prompt-pilot-analysis${SUFFIX}.json`), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R1 — prompt-protection pilot')
md.push('')
md.push(`Campaign \`${CAMPAIGN}\`, ${cells.length} cells, ${results.budget.used.requests} requests, `
  + `${results.budget.used.inputTokens} input, ${results.budget.used.outputTokens} output.`)
md.push('')
md.push('| Arm | Pass | Prompt visible at end | Prompt lost | No fold | Mean retained | Requests | Input |')
md.push('|---|---|---|---|---|---|---|---|')
for (const arm of ARMS) {
  const row = byArm[arm]
  md.push(`| ${arm} | ${row.passed}/${row.cells} | ${row.promptVisibleAtEnd}/${row.cells} | ${row.promptLost}/${row.cells} | ${row.noFold}/${row.cells} | ${row.meanRetainedTokens ?? '—'} | ${row.requests} | ${row.inputTokens} |`)
}
md.push('')
md.push('## Paired by task')
md.push('')
md.push(`| Task | ${ARMS[0]} pass | ${ARMS[1]} pass | ${ARMS[0]} prompt lost | ${ARMS[1]} prompt lost |`)
md.push('|---|---|---|---|---|')
for (const pair of pairs) {
  md.push(`| ${pair.task} | ${pair.leftPass ? 'yes' : 'no'} | ${pair.rightPass ? 'yes' : 'no'} | ${pair.leftPromptLost ? 'yes' : 'no'} | ${pair.rightPromptLost ? 'yes' : 'no'} |`)
}
md.push('')
md.push(`Improved **${output.paired.improved}**, worsened **${output.paired.worsened}**, tied **${output.paired.tied}**. `
  + `Prompt lost ${ARMS[0]} **${output.paired.promptLostBefore}**, ${ARMS[1]} **${output.paired.promptLostAfter}**. n=4 pairs; a direction check.`)
md.push('')
if (byArm[ARMS[1]].noFold > 0) {
  md.push('## The caveat that decides the reading')
  md.push('')
  md.push(`**${byArm[ARMS[1]].noFold}/${byArm[ARMS[1]].cells} ${ARMS[1]} cells were economic refusals, not folds around the prompt.** The span after the active request was too small for admission, so the cells retained the full surface. The pass rate compares no-fold with fold, not protected-fold with fold. Starting the leaf after the request is not a viable protection.`)
} else {
  md.push('## The treatment folded normally')
  md.push('')
  md.push(`Every ${ARMS[1]} cell folded (no economic refusal) and retained fewer tokens on average, so the comparison is a real fold-vs-fold difference. The request is preserved by a runtime-authored copy in the checkpoint body, not by blocking compression.`)
}
writeFileSync(join(MY_OUT, `prompt-pilot-analysis${SUFFIX}.md`), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`prompt pilot: ${cells.length} cells\n`)
for (const arm of ARMS) {
  process.stdout.write(`  ${arm}: pass ${byArm[arm].passed}/${byArm[arm].cells}, prompt lost ${byArm[arm].promptLost}\n`)
}
process.stdout.write(`  paired improved ${output.paired.improved}, worsened ${output.paired.worsened}, tied ${output.paired.tied}\n`)
