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
const ARMS = ['E0', 'E0-P']

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
  const e0 = byKey.get(`${task}:E0`)
  const p = byKey.get(`${task}:E0-P`)
  if (e0 === undefined || p === undefined) continue
  pairs.push({
    task,
    e0Pass: e0.pass,
    pPass: p.pass,
    e0PromptLost: e0.promptLost,
    pPromptLost: p.promptLost,
  })
}

const byArm = { E0: perArm('E0'), 'E0-P': perArm('E0-P') }
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
    improved: pairs.filter(pair => pair.pPass && !pair.e0Pass).length,
    worsened: pairs.filter(pair => !pair.pPass && pair.e0Pass).length,
    tied: pairs.filter(pair => pair.pPass === pair.e0Pass).length,
    promptLostBefore: pairs.filter(pair => pair.e0PromptLost === true).length,
    promptLostAfter: pairs.filter(pair => pair.pPromptLost === true).length,
  },
  sources: {
    results: `eval/e2e/out/results-${CAMPAIGN}.json`,
    resultsSha256: sha256(join(OUT, `results-${CAMPAIGN}.json`)),
    stageAttributionSha256: sha256(join(OUT, 'stage-attribution.json')),
  },
  note: 'n=4 pairs; a direction check, not a powered estimate.',
}
writeFileSync(join(MY_OUT, 'prompt-pilot-analysis.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

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
md.push('| Task | E0 pass | E0-P pass | E0 prompt lost | E0-P prompt lost |')
md.push('|---|---|---|---|---|')
for (const pair of pairs) {
  md.push(`| ${pair.task} | ${pair.e0Pass ? 'yes' : 'no'} | ${pair.pPass ? 'yes' : 'no'} | ${pair.e0PromptLost ? 'yes' : 'no'} | ${pair.pPromptLost ? 'yes' : 'no'} |`)
}
md.push('')
md.push(`Improved **${output.paired.improved}**, worsened **${output.paired.worsened}**, tied **${output.paired.tied}**. `
  + `Prompt lost E0 **${output.paired.promptLostBefore}**, E0-P **${output.paired.promptLostAfter}**. n=4 pairs; a direction check.`)
md.push('')
md.push('## The caveat that decides the reading')
md.push('')
md.push('**Every E0-P cell was an economic refusal, not a fold around the prompt.** The span after the active request was ~133 tokens and the checkpoint ~530, so the admission refused it; the cell retained the full ~18–19k surface. The pass rate is therefore a comparison of **no-fold vs fold**, not of "prompt protected during a fold" vs fold. Starting the leaf after the request is not a viable protection: it disables compression on this workload. The next design must fold normally and re-render the active request verbatim in the checkpoint (or re-pin it after the fold), not block the span.')
writeFileSync(join(MY_OUT, 'prompt-pilot-analysis.md'), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`prompt pilot: ${cells.length} cells\n`)
for (const arm of ARMS) {
  process.stdout.write(`  ${arm}: pass ${byArm[arm].passed}/${byArm[arm].cells}, prompt lost ${byArm[arm].promptLost}\n`)
}
process.stdout.write(`  paired improved ${output.paired.improved}, worsened ${output.paired.worsened}, tied ${output.paired.tied}\n`)
