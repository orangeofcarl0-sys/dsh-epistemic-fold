#!/usr/bin/env node
/**
 * EF-R3 product-lane — per-cell trajectory and model-behaviour analysis.
 *
 * The aggregate pilot table says WHAT happened. This script says HOW: the live
 * tool sequence, the checkpoint text, the final workspace, the step-limit
 * boundary and the recall→fold loop. It is an analysis artifact, not a runner.
 *
 *   node eval/r3/product-pilot-trajectory-analysis.mjs
 *
 * @module eval/r3/product-pilot-trajectory-analysis
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const CAMPAIGN = 'e2e-r3-product-pilot-1'
const RUNS = join(ROOT, 'eval', 'e2e', 'runs', CAMPAIGN)
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const manifest = readJson(join(E2E_OUT, `manifest-${CAMPAIGN}.json`))
const results = readJson(join(E2E_OUT, `results-${CAMPAIGN}.json`))
const tasks = new Map(manifest.tasks.map(task => [task.id, task]))

function taskBody(taskId) {
  const entry = tasks.get(taskId)
  return entry === undefined ? null : readJson(join(ROOT, entry.file))
}

function textChars(message) {
  return (message.content ?? []).reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
}

function preview(text, length = 240) {
  if (typeof text !== 'string') return null
  return text.length <= length ? text : `${text.slice(0, length)}…`
}

function liveStartIndex(trajectory, task) {
  const prompt = task?.task ?? ''
  const exact = trajectory.findIndex(event => event.type === 'user'
    && typeof event.text === 'string'
    && (event.text === prompt || event.text.startsWith(prompt.slice(0, 40))))
  if (exact !== -1) return exact
  const firstCompaction = trajectory.findIndex(event => event.type === 'compaction/start')
  if (firstCompaction !== -1) {
    for (let index = firstCompaction; index >= 0; index -= 1) {
      if (trajectory[index].type === 'user') return index
    }
  }
  return 0
}

function toolCounts(events) {
  const counts = {}
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    counts[event.name ?? 'unknown'] = (counts[event.name ?? 'unknown'] ?? 0) + 1
  }
  return counts
}

function writtenFiles(task, cellId) {
  const dir = join(RUNS, cellId, 'workspace')
  if (!existsSync(dir)) return []
  const initial = new Set(Object.keys(task?.workspace ?? {}))
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => !initial.has(name))
    .map(name => {
      const path = join(dir, name)
      let content = null
      try {
        const text = readFileSync(path, 'utf8')
        content = preview(text, 600)
      } catch {
        content = null
      }
      return { name, bytes: statSync(path).size, content }
    })
}

function classify(cell) {
  if (cell.pass) {
    if (cell.arm === 'E0') return 'pass-retained-tail'
    return 'pass-direct-write'
  }
  if (cell.arm === 'B0') return 'finish-wrong-schema-and-compactions'
  if (cell.arm === 'E1' && cell.cellId === 'T11-p1-E1-r1') return 'wrong-source-value'
  if (cell.arm === 'E1') return 'step-limit-rationale-without-answer'
  return 'step-limit-empty-checkpoint-recall'
}

const cells = []
for (const result of results.results) {
  if (result.status !== 'executed') continue
  const report = readJson(result.reportPath)
  const task = taskBody(report.task.id)
  const start = liveStartIndex(report.trajectory, task)
  const live = report.trajectory.slice(start)
  const counts = toolCounts(live)
  const recallCalls = (counts.context_recall ?? 0) + (counts.context_search ?? 0)
  const writeCalls = (counts.write_file ?? 0) + (counts.edit_file ?? 0)
  const readCalls = (counts.read_file ?? 0) + (counts.list_dir ?? 0)
  const assistant = live.filter(event => event.type === 'assistant')
  const checkpoints = live.filter(event => event.type === 'compaction/start').length
  const cell = {
    cellId: report.cellId,
    task: report.task.id,
    arm: report.arm,
    pass: report.checker.pass,
    termination: report.termination.kind,
    durationMs: report.termination.durationMs,
    stepLimit: report.termination.kind === 'step-limit',
    liveStart: start,
    liveEvents: live.length,
    assistantMessages: assistant.length,
    toolCounts: counts,
    recallCalls,
    readCalls,
    writeCalls,
    foldsStarted: checkpoints,
    witness: report.witnessSummary,
    activeDelivery: report.activeDelivery,
    checkpoint: report.checkpoint === null ? null : {
      seq: report.checkpoint.seq,
      chars: report.checkpoint.chars,
      text: report.checkpoint.text,
    },
    checker: report.checker,
    finalText: report.behaviour.finalText,
    writtenFiles: writtenFiles(task, report.cellId),
    probe: report.leafSpanProbe,
    lastEvents: live.slice(-8).map(event => ({
      seq: event.seq,
      type: event.type,
      name: event.name ?? null,
      args: event.args?.text ? preview(event.args.text, 180) : null,
      text: event.text ? preview(event.text, 240) : null,
      toolCalls: event.toolCalls ?? null,
      error: event.error ?? null,
    })),
    toolSequence: live
      .filter(event => event.type === 'tool/call')
      .map(event => ({
        name: event.name,
        args: event.args?.text ? preview(event.args.text, 180) : null,
      })),
    assistantTexts: assistant
      .filter(event => typeof event.text === 'string' && event.text.length > 0)
      .map(event => preview(event.text, 300)),
  }
  cell.class = classify(cell)
  cells.push(cell)
}

const byClass = cells.reduce((groups, cell) => {
  groups[cell.class] = (groups[cell.class] ?? 0) + 1
  return groups
}, {})

const output = {
  schemaVersion: 1,
  work: 'EF-R3 product-lane trajectory analysis',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  method: {
    liveBoundary: 'first user message carrying the task prompt; stage B is included after it',
    counts: 'tool calls in the live portion only; seed history is excluded',
    checkpoint: 'the final checkpoint on the surface at report time',
  },
  byClass,
  cells,
  patterns: {
    stepLimitCells: cells.filter(cell => cell.stepLimit).length,
    stepLimitWithNoWrite: cells.filter(cell => cell.stepLimit && cell.writeCalls === 0).length,
    stepLimitByArm: Object.fromEntries(['B0', 'E0', 'E1'].map(arm => [
      arm,
      cells.filter(cell => cell.arm === arm && cell.stepLimit).length,
    ])),
    recallByClass: Object.fromEntries([...new Set(cells.map(cell => cell.class))].map(name => [
      name,
      cells.filter(cell => cell.class === name).map(cell => cell.recallCalls),
    ])),
    note: 'Step-limit failures spend live steps on read_file/list_dir and context_recall/search; most never reach write_file.',
  },
}

mkdirSync(OUT, { recursive: true })
const jsonPath = join(OUT, 'product-pilot-trajectory-analysis.json')
writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R3 product-lane pilot — trajectory and model behaviour')
md.push('')
md.push('## Method')
md.push('')
md.push('The live portion starts at the user message carrying the task prompt; the seeded history is excluded. Tool counts are live `tool/call` events. The checkpoint is the final checkpoint on the surface at report time. Step-limit cells are those whose termination is `step-limit`.')
md.push('')
md.push('## Cell table')
md.push('')
md.push('| Cell | Arm | Pass | Termination | Live tools | Recall/search | Read/list | Write/edit | Folds | Checkpoint chars |')
md.push('|---|---|---|---|---|---|---|---|---|---|')
for (const cell of cells) {
  md.push(`| ${cell.cellId} | ${cell.arm} | ${cell.pass ? 'pass' : 'fail'} | ${cell.termination} | ${Object.entries(cell.toolCounts).map(([name, count]) => `${name}:${count}`).join(', ')} | ${cell.recallCalls} | ${cell.readCalls} | ${cell.writeCalls} | ${cell.foldsStarted} | ${cell.checkpoint?.chars ?? '—'} |`)
}
md.push('')
md.push('## Per-cell reading')
md.push('')
for (const cell of cells) {
  md.push(`### ${cell.cellId} — ${cell.arm} — ${cell.class}`)
  md.push('')
  md.push(`- Outcome: **${cell.pass ? 'pass' : 'fail'}**, termination \`${cell.termination}\`, ${cell.durationMs} ms.`)
  md.push(`- Live shape: ${cell.assistantMessages} assistant messages, ${cell.foldsStarted} folds, ${cell.recallCalls} recall/search, ${cell.readCalls} read/list, ${cell.writeCalls} write/edit.`)
  md.push(`- Checker: ${cell.checker.checks.map(check => `${check.kind}=${check.pass ? 'pass' : 'fail'} (${check.detail})`).join('; ')}`)
  if (cell.checkpoint !== null) {
    md.push(`- Checkpoint (${cell.checkpoint.chars} chars): ${preview(cell.checkpoint.text, 500)}`)
  }
  if (cell.writtenFiles.length > 0) {
    md.push(`- New workspace files: ${cell.writtenFiles.map(file => `${file.name} (${file.bytes}B): ${file.content ?? 'binary'}`).join('; ')}`)
  } else {
    md.push('- New workspace files: none')
  }
  if (cell.finalText.length > 0) {
    md.push(`- Final text: ${preview(cell.finalText, 500)}`)
  } else {
    md.push('- Final text: empty')
  }
  md.push(`- Last events: ${cell.lastEvents.map(event => `${event.type}${event.name ? `:${event.name}` : ''}${event.text ? ` “${preview(event.text, 100)}”` : ''}`).join(' | ')}`)
  md.push('')
}
md.push('## Cross-cell model behaviour')
md.push('')
md.push(`- Step-limit cells: **${output.patterns.stepLimitCells}**; **${output.patterns.stepLimitWithNoWrite}** of them made no write/edit call.`)
md.push(`- Step-limit by arm: B0 ${output.patterns.stepLimitByArm.B0}, E0 ${output.patterns.stepLimitByArm.E0}, E1 ${output.patterns.stepLimitByArm.E1}.`)
md.push('- The E0 failures are dominated by `context_recall`/`context_search` on marker-only checkpoints; the recall page reports `summaryAvailable:false`, the model searches again, and another fold starts.')
md.push('- The E1 T15/T16 failures are different: the rationale is methodological prose, not the concrete value. The model recalls checkpoint pages, lists or reads `logs/...` that are not in the workspace (ENOENT), and folds again before writing.')
md.push('- E1 T11 is the clearest trust failure: its checkpoint explicitly says “Report 3 failures … not the count of visible ERROR lines”, but the model ran the **current** test suite (1 failure), wrote `{"failed":1}`, fixed the code and called `finish`. The checkpoint was correct and delivered; the model preferred live tool output over folded evidence.')
md.push('- E1 T12/T13/T14 pass because the checkpoint carries the exact fact and the model writes directly. E0 T14 is the only E0 pass: the fact survives in the retained tail or a single search, so no recall loop starts.')
md.push('- B0 T16 fails differently: Basic’s summary is truncated at the 1024-token cap four times (4 aborted compactions); it commits one fold, writes `{"id":…}` instead of `{"release":…}`, and misses the task’s `minCompactions:2` mechanism check. This is a Basic config/task-schema failure, not an EF checkpoint failure.')
md.push('')
md.push('## Recall → fold loop')
md.push('')
md.push('The live traces show `context_recall`/`context_search` followed by a new `compaction/start` in the same step. The retrieved messages are added to the surface, the surface crosses the threshold, the fold replaces the retrieved evidence with a new checkpoint, and the model recalls again. This is visible in E0 T11/T12/T13/T15/T16 and E1 T15/T16. The model is not merely “slow”; it is in a non-convergent retrieval/compaction loop. The 8-step limit is the proximate stop, not the cause.')
md.push('')
md.push('## What the pilot result means')
md.push('')
md.push('- B0 5/6 vs E1 3/6 is the observed harness result, but it is **not** a clean product-quality comparison.')
md.push('- 8/12 EF cells are step-limited; most never write. The EF quality is censored, not measured at its natural step budget.')
md.push('- The seeded logs live in the conversation, not in the workspace. Models try `read_file`/`list_dir` on `logs/...`, get ENOENT, and spend steps; this penalises the arms that fold the logs away.')
md.push('- Basic’s 1024-token summary cap causes T16 aborts; the B0 arm is not fully product-representative at 32k.')
md.push('- T16’s `minCompactions:2` is an EF mechanism check; applying it to B0 conflates task correctness with mechanism exposure.')
md.push('- E1’s commits/deliveries are healthy (13/13); the failures are checkpoint content and model behaviour, not delivery failure.')
md.push('')
md.push('The pilot therefore supports **no product candidate** and **no expansion**, but it also does not prove that native Basic is better. The next experiment must separate step budget, task-log placement and mechanism checks before any quality comparison.')
md.push('')
const mdPath = join(OUT, 'product-pilot-trajectory-analysis.md')
writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`trajectory analysis: ${cells.length} cells; classes ${JSON.stringify(byClass)}\n`)
process.stdout.write(`  step-limit ${output.patterns.stepLimitCells}, no-write ${output.patterns.stepLimitWithNoWrite}; by arm ${JSON.stringify(output.patterns.stepLimitByArm)}\n`)
process.stdout.write(`wrote ${jsonPath}, ${mdPath}\n`)
