#!/usr/bin/env node
/**
 * Offline DSML protocol attribution on the R36 saved traces.
 *
 * Three questions are kept separate:
 *
 *   offline protocol recovery     a layer recognizes an action in saved text
 *   deterministic dispatch recovery  applying the recognized write produces a
 *                                 parseable module in an isolated workspace
 *   live behavioral recovery      not run in R37-A
 *
 * The script reads traces and reports only; it never calls a provider and never
 * writes into an R36 run directory.
 *
 * @module eval/r37/protocol-ablation
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeTurn, LAYERS, scanEmitted } from './src/tool-protocol-r37.mjs'
import { exists, readJson, sha256File, writeJson } from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R36 = process.env.R36_WORKTREE === undefined
  ? resolve(ROOT, '..', 'ef-r36-interface')
  : resolve(process.env.R36_WORKTREE)
const RUNS = join(R36, 'eval', 'r36', 'runs')
const OUT = join(HERE, 'out', 'protocol-ablation.json')
const relR36 = path => relative(R36, path).split(sep).join('/')

function conditionOf(runId) {
  if (runId.startsWith('r36-h0-o2')) return 'H0'
  if (runId.startsWith('r36-h-step-o2')) return 'H-step'
  if (runId.startsWith('r36-h-output-o2')) return 'H-output'
  if (runId.startsWith('r36-h-finish-o2')) return 'H-finish'
  if (runId.startsWith('r36-h-combined-o2')) return 'H-combined'
  if (runId.startsWith('r36-h-protocol-step-o2')) return 'H-protocol-step'
  if (runId.startsWith('r36-h-protocol-o2')) return 'H-protocol'
  if (runId.startsWith('r36-causal-')) return 'H-protocol-causal'
  return 'other'
}

function emptyLayer() {
  return {
    turns: 0,
    emitted: 0,
    recognized: 0,
    valid: 0,
    invalid: 0,
    ambiguous: 0,
    dispatchable: 0,
    multipleActionTurns: 0,
    turnsWithNoAction: 0,
    forms: { json: 0, 'dsml-parameter': 0, 'dsml-direct': 0 },
    invalidReasons: {},
  }
}

function addLayer(target, analysis, turn) {
  target.turns += 1
  target.emitted += analysis.emitted.emitted
  target.recognized += analysis.actions.length + analysis.invalid.length
  target.valid += analysis.actions.length
  target.invalid += analysis.invalid.length
  target.dispatchable += analysis.actions.length
  if (analysis.actions.length + analysis.invalid.length > 1) target.multipleActionTurns += 1
  if (analysis.actions.length === 0 && analysis.invalid.length === 0) target.turnsWithNoAction += 1
  for (const action of analysis.actions) target.forms[action.form] = (target.forms[action.form] ?? 0) + 1
  for (const action of analysis.invalid) {
    for (const reason of action.reasons) {
      target.invalidReasons[reason.reason] = (target.invalidReasons[reason.reason] ?? 0) + 1
      if (reason.reason === 'truncated-invoke' || reason.reason === 'unparsed-invoke'
        || reason.reason === 'missing-parameter' || reason.reason === 'parameter-type') {
        target.ambiguous += 1
      }
    }
  }
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.reason === 'unparsed-invoke' || diagnostic.reason === 'truncated-invoke') {
      target.ambiguous += 1
    }
  }
}

async function traceFiles() {
  const files = []
  async function walk(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.name === 'record.json' && /trace[\\/]record\.json$/u.test(absolute)) files.push(absolute)
    }
  }
  await walk(RUNS)
  return files.sort()
}

async function deterministicB2() {
  const sourceRun = join(RUNS, 'r36-causal-B2')
  const finalPath = join(sourceRun, 'B2', 'S', 'r1', 'workspace', 'src', 'scheduler.mjs')
  const initialRoot = join(ROOT, 'eval', 'r33', 'cases', 'B2', 'workspace')
  if (!await exists(finalPath)) {
    return { status: 'unavailable', reason: 'the B2 S final workspace is absent' }
  }
  const stored = await readFile(finalPath, 'utf8')
  const decoded = stored.split('\\`').join('`').split('\\${').join('${')
  const root = await mkdtemp(join(tmpdir(), 'r37-b2-dispatch-'))
  const results = {}
  try {
    for (const [name, content] of [['P3', stored], ['P3e', decoded]]) {
      const workspace = join(root, name)
      await cp(initialRoot, workspace, { recursive: true })
      await writeFile(join(workspace, 'src', 'scheduler.mjs'), content, 'utf8')
      const syntax = spawnSync(process.execPath, ['--check', join(workspace, 'src', 'scheduler.mjs')], {
        encoding: 'utf8',
      })
      const checker = spawnSync(process.execPath, [join(ROOT, 'eval', 'r33', 'cases', 'B2', 'check.mjs')], {
        encoding: 'utf8',
        env: { ...process.env, R33_WORKSPACE: workspace },
      })
      results[name] = {
        syntaxPass: syntax.status === 0,
        syntaxExit: syntax.status,
        syntaxError: syntax.status === 0
          ? null
          : String(syntax.stderr).split(root).join('<temp>').split(/\r?\n/u).slice(0, 4).join('\n'),
        checkerExit: checker.status,
        checkerPass: checker.status === 0,
        checkerStdout: String(checker.stdout).trim(),
      }
    }
    return {
      status: 'executed',
      caseId: 'B2',
      runId: 'r36-causal-B2',
      arm: 'S',
      source: relR36(finalPath),
      sourceSha256: await sha256File(finalPath),
      storedHasLiteralBackslashBacktick: stored.includes('\\`'),
      storedHasLiteralBackslashDollarBrace: stored.includes('\\${'),
      decodedHasLiteralBackslashBacktick: decoded.includes('\\`'),
      semanticMarkerPresent: decoded.includes("mode: 'memory'"),
      P3: results.P3,
      P3e: results.P3e,
      note: 'The saved final workspace is the actual dispatch result. P3 is the stored bytes; P3e applies DSML attribute unescaping. '
        + 'This is deterministic dispatch recovery in an isolated copy, not a live rerun.',
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const files = await traceFiles()
const byRun = new Map()
const totals = Object.fromEntries(LAYERS.map(layer => [layer, emptyLayer()]))
const turns = []

for (const file of files) {
  const runId = file.split(/[\\/]runs[\\/]/u)[1]?.split(/[\\/]/u)[0] ?? 'unknown'
  const trace = await readJson(file)
  if (!Array.isArray(trace.followTrace) || trace.followTrace.length === 0) continue
  const runRoot = join(RUNS, runId)
  const report = await exists(join(runRoot, 'report.json')) ? await readJson(join(runRoot, 'report.json')) : null
  const row = report?.rows?.find(candidate => candidate.arm === trace.arm)
  const key = `${runId}/${trace.caseId}/${trace.arm}`
  if (!byRun.has(key)) {
    byRun.set(key, {
      key,
      runId,
      caseId: trace.caseId,
      arm: trace.arm,
      condition: conditionOf(runId),
      reported: row?.behaviourDetail?.harness ?? null,
      turns: 0,
      layers: Object.fromEntries(LAYERS.map(layer => [layer, emptyLayer()])),
    })
  }
  const run = byRun.get(key)
  for (const turn of trace.followTrace) {
    const text = String(turn.text ?? '')
    const scan = scanEmitted(text)
    run.turns += 1
    turns.push({
      key,
      step: turn.step,
      chars: text.length,
      outputTokens: turn.usage?.outputTokens ?? null,
      emitted: scan,
    })
    for (const layer of LAYERS) {
      const analysis = analyzeTurn(text, layer, 'model')
      addLayer(run.layers[layer], analysis, turn)
      addLayer(totals[layer], analysis, turn)
    }
  }
}

const byCondition = {}
for (const run of byRun.values()) {
  if (byCondition[run.condition] === undefined) {
    byCondition[run.condition] = {
      condition: run.condition,
      runs: 0,
      turns: 0,
      layers: Object.fromEntries(LAYERS.map(layer => [layer, emptyLayer()])),
    }
  }
  const condition = byCondition[run.condition]
  condition.runs += 1
  condition.turns += run.turns
  for (const layer of LAYERS) {
    const target = condition.layers[layer]
    const source = run.layers[layer]
    for (const key of ['turns', 'emitted', 'recognized', 'valid', 'invalid', 'ambiguous', 'dispatchable', 'multipleActionTurns', 'turnsWithNoAction']) {
      target[key] += source[key]
    }
    for (const [form, count] of Object.entries(source.forms)) target.forms[form] = (target.forms[form] ?? 0) + count
    for (const [reason, count] of Object.entries(source.invalidReasons)) {
      target.invalidReasons[reason] = (target.invalidReasons[reason] ?? 0) + count
    }
  }
}

const delta = {
  P0_to_P1: totals.P1.valid - totals.P0.valid,
  P1_to_P2: totals.P2.valid - totals.P1.valid,
  P2_to_P3: totals.P3.valid - totals.P2.valid,
  P3_to_P3e: totals.P3e.valid - totals.P3.valid,
  P3e_to_P4: totals.P4.valid - totals.P3e.valid,
  note: 'Valid action count by layer. P3e does not add actions; it changes attribute content. P4 is experimental.',
}

const comparisons = []
for (const run of byRun.values()) {
  if (run.reported === null) continue
  comparisons.push({
    key: run.key,
    reportedValidActions: run.reported.validActions,
    p3RecognizedActions: run.layers.P3.recognized,
    p3ValidActions: run.layers.P3.valid,
    reportedInvalidActions: run.reported.invalidActions,
    p3TurnsWithNoAction: run.layers.P3.turnsWithNoAction,
    matches: run.reported.validActions === run.layers.P3.recognized
      && run.reported.invalidActions === run.layers.P3.turnsWithNoAction,
    note: run.reported.validActions === run.layers.P3.recognized
      && run.reported.invalidActions === run.layers.P3.turnsWithNoAction
      ? null
      : 'the saved trace is capped at 1000 characters per turn; a turn that parsed live may not parse offline',
  })
}

const b2 = await deterministicB2()
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpus: {
    runs: [...new Set([...byRun.values()].map(run => run.runId))].length,
    traceRows: byRun.size,
    turns: turns.length,
    files: files.map(file => relR36(file)),
  },
  layers: {
    P0: 'one JSON object per turn (original H0)',
    P1: 'P0 + complete DSML invoke with <parameter>',
    P2: 'P1 + short direct-attribute DSML inside an invoke',
    P3: 'P2 + multiple actions per turn (R36 parser)',
    P3e: 'P3 + DSML attribute unescaping (proposed correction)',
    P4: 'P3e + raw-body write_file content (experimental, not production)',
  },
  totals,
  byCondition,
  byRun: [...byRun.values()].sort((left, right) => left.key.localeCompare(right.key)),
  delta,
  comparisons,
  comparisonSummary: {
    rows: comparisons.length,
    match: comparisons.filter(row => row.matches).length,
    mismatch: comparisons.filter(row => !row.matches).length,
  },
  deterministicDispatch: b2,
  notes: [
    'Offline protocol recovery is not live behavioral recovery. A recovered action changes the next model input only in a live run.',
    'The saved trace text is capped at 1000 characters. Turns at the cap are reported as truncated, not as model failures.',
    'P0 is expected to false-positive on JSON code inside a DSML content body; that is one reason DSML must take precedence.',
    'P4 is an ablation only. Guessing that a residual body is content is not adopted as production behavior.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`protocol ablation: ${OUT}\n`)
process.stdout.write(`corpus: ${report.corpus.runs} runs, ${report.corpus.traceRows} trace rows, ${report.corpus.turns} turns\n`)
for (const layer of LAYERS) {
  process.stdout.write(`${layer}: valid ${totals[layer].valid}, invalid ${totals[layer].invalid}, turns-without-action ${totals[layer].turnsWithNoAction}, multi ${totals[layer].multipleActionTurns}\n`)
}
process.stdout.write(`delta: ${JSON.stringify(delta)}\n`)
process.stdout.write(`reported-vs-P3: ${report.comparisonSummary.match}/${report.comparisonSummary.rows} rows match\n`)
process.stdout.write(`B2 deterministic: ${JSON.stringify({
  P3: b2.P3 && { syntax: b2.P3.syntaxPass, checker: b2.P3.checkerPass },
  P3e: b2.P3e && { syntax: b2.P3e.syntaxPass, checker: b2.P3e.checkerPass },
})}\n`)
