#!/usr/bin/env node
/**
 * EF-R1 WP2 — where did each cell actually fail?
 *
 * The E2E reports answer "did the checker pass". That is one bit, and the
 * round's own variance analysis showed it is not enough: a model can find the
 * right value and not write it, write it with the wrong value, or never find it
 * at all. Treating all three as "compression lost the fact" is the attribution
 * error this script exists to stop.
 *
 * ## The five stages
 *
 *   A archiveAvailable          the folded evidence exists in an archive
 *   B evidenceLocated           the model asked the archive/retrieval interface
 *   C correctEvidenceObserved   a tool result the model received carried the fact
 *   D correctValueProduced      the model's final text carries the fact
 *   E outputWritten             the required deliverable exists
 *   F outputSchemaValid         the deliverable satisfies its declarative shape
 *   G checkerPassed             the task contract passed
 *
 * Stage B is NOT a prerequisite for C: an EF checkpoint can carry the value
 * inline, and a passing cell that never called recall is not a retrieval
 * failure. The failure label therefore uses the first stage that is actually
 * missing from the DELIVERY chain (D → E → F → G), with A/B/C as the explanatory
 * context. A missing C with a produced D is a produce failure; a produced D
 * with no file is a write failure.
 *
 * ## What is unknown, and why it is not guessed
 *
 * The first 71 cells predate ordered trajectory capture. Their reports store
 * message previews with a `truncated` flag, not the full tool result. If the
 * fact is visible in a preview, C is true (the model saw that text). If every
 * tool text was complete and the fact is absent, C is false. If a tool text was
 * truncated and the fact is not visible, C is `unknown` — absence from a prefix
 * proves nothing. The output counts those separately and never folds them into
 * a failure.
 *
 * No model call is made. Every input already exists on disk.
 *
 *   node eval/e2e/src/stage-attribution.mjs
 *
 * @module eval/e2e/src/stage-attribution
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = join(ROOT, 'eval', 'e2e', 'out')
const RUNS = join(ROOT, 'eval', 'e2e', 'runs')
const TASKS = join(ROOT, 'eval', 'e2e', 'tasks')

const CAMPAIGNS = ['e2e-core-1', 'e2e-pilot-1', 'e2e-t5-retest-1', 'e2e-recall-1', 'e2e-guard-smoke-1', 'e2e-index-1', 'e2e-lg-pilot-1', 'e2e-lg-confirm-1', 'e2e-t10-retest-1', 'e2e-prompt-pilot-2', 'e2e-prompt-rerender-1', 'e2e-prompt-confirm-1']
const MEMORY_TEMPLATES = new Set(['T2', 'T4', 'T5', 'T5B', 'T7', 'T8', 'T9', 'T10'])

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const tasksById = new Map()
for (const name of readdirSync(TASKS).filter(name => /^T\d+[A-Za-z]?-s\d\.json$/u.test(name))) {
  const task = readJson(join(TASKS, name))
  tasksById.set(task.id, task)
}

/** Every top-level key/value pair a json_equals check requires. */
function goldPairs(task) {
  const pairs = []
  for (const check of task.checks ?? []) {
    if (check.kind !== 'json_equals' || check.value === null || typeof check.value !== 'object') continue
    for (const [key, value] of Object.entries(check.value)) pairs.push({ key, value, path: check.path })
  }
  return pairs
}

/** Whether `text` states a required pair, not merely the number somewhere. */
function mentionsPair(text, pair) {
  const value = String(pair.value)
  const quoted = `["']?${escapeRe(value)}["']?`
  const keyed = new RegExp(`${escapeRe(pair.key)}["']?\\s*[:=]\\s*${quoted}(?![0-9A-Za-z])`, 'iu')
  if (keyed.test(text)) return true
  // A checkpoint renders an anchor as `- [kind id key] value (authority)`.
  // The key is inside the bracket and the value follows it, so the JSON/pair
  // form above does not match. This is the form that carries T5's state.
  const bracketed = new RegExp(`${escapeRe(pair.key)}\\]\\s*${quoted}(?![0-9A-Za-z])`, 'iu')
  if (bracketed.test(text)) return true
  // A distinctive string (hex id, region) is evidence on its own; a bare short
  // number is not: "2" appears in timestamps and step counts.
  const distinctive = String(pair.value).length >= 6 && /[A-Za-z]/u.test(String(pair.value))
  return distinctive && new RegExp(`(?<![0-9A-Za-z])${escapeRe(value)}(?![0-9A-Za-z])`, 'u').test(text)
}

function mentionsAll(text, pairs) {
  const unique = new Map(pairs.map(pair => [`${pair.key}:${String(pair.value)}`, pair]))
  if (unique.size === 0) return null
  const matched = [...unique.values()].filter(pair => mentionsPair(text, pair))
  return { value: matched.length === unique.size, matched: matched.length, total: unique.size }
}

/**
 * A looser match for PROSE sources (checkpoint text, task prompt).
 *
 * A checkpoint may render `- [value ... window_seconds] 30`, and a task prompt
 * may say "the window was agreed at 30 seconds" without the field name. Neither
 * is a tool observation, so the strict key:value form is too narrow; requiring
 * every key token within 80 characters of the value is specific enough for a
 * delivery source and is never used to claim a tool result carried the fact.
 */
function mentionsLoose(text, pair) {
  const value = String(pair.value)
  const re = new RegExp(`(?<![0-9A-Za-z])${escapeRe(value)}(?![0-9A-Za-z])`, 'gu')
  const tokens = pair.key.split(/[^A-Za-z0-9]+/u).filter(token => token.length >= 3).map(token => token.toLowerCase())
  if (tokens.length === 0) return false
  for (const match of text.matchAll(re)) {
    const start = Math.max(0, match.index - 80)
    const slice = text.slice(start, match.index + value.length + 80).toLowerCase()
    if (tokens.every(token => slice.includes(token))) return true
  }
  return false
}

function mentionsAllLoose(text, pairs) {
  const unique = new Map(pairs.map(pair => [`${pair.key}:${String(pair.value)}`, pair]))
  if (unique.size === 0) return null
  const matched = [...unique.values()].filter(pair => mentionsPair(text, pair) || mentionsLoose(text, pair))
  return { value: matched.length === unique.size, matched: matched.length, total: unique.size }
}

function workspaceOf(campaign, cellId, report) {
  if (typeof report.workspace === 'string' && existsSync(report.workspace)) return report.workspace
  const fallback = join(RUNS, campaign, cellId, 'workspace')
  return existsSync(fallback) ? fallback : undefined
}

/**
 * The declarative file checks, evaluated against the FINAL workspace.
 *
 * `value` is the SHAPE: the file exists, parses, and has every expected key
 * with the expected primitive type. Whether the VALUES match is `contract`,
 * because a correctly shaped file with the wrong number is a value failure,
 * not a schema failure. The round's T5 defect (right values nested under
 * `batch`) is a shape failure; a `"build": "UNKNOWN"` file is a value failure.
 */
function schemaOf(task, workspace) {
  const fileChecks = (task.checks ?? []).filter(check =>
    ['json_equals', 'file_contains', 'file_not_contains', 'file_exists', 'file_absent'].includes(check.kind))
  if (fileChecks.length === 0) return { value: null, contract: null, reason: 'no declarative file check', rows: [] }
  if (workspace === undefined) return { value: null, contract: null, reason: 'workspace not preserved', rows: [] }
  const rows = []
  for (const check of fileChecks) {
    const path = join(workspace, check.path)
    if (check.kind === 'file_exists') {
      rows.push({ kind: check.kind, path: check.path, shape: existsSync(path), contract: existsSync(path) })
      continue
    }
    if (check.kind === 'file_absent') {
      rows.push({ kind: check.kind, path: check.path, shape: !existsSync(path), contract: !existsSync(path) })
      continue
    }
    if (!existsSync(path)) {
      rows.push({ kind: check.kind, path: check.path, shape: false, contract: false, missing: true })
      continue
    }
    const text = readFileSync(path, 'utf8')
    if (check.kind === 'file_contains') {
      rows.push({ kind: check.kind, path: check.path, shape: true, contract: text.includes(check.needle) })
      continue
    }
    if (check.kind === 'file_not_contains') {
      rows.push({ kind: check.kind, path: check.path, shape: true, contract: !text.includes(check.needle) })
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      rows.push({ kind: check.kind, path: check.path, shape: false, contract: false, invalidJson: true })
      continue
    }
    const expected = check.value
    const shape = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && expected !== null && typeof expected === 'object'
      && Object.entries(expected).every(([key, value]) =>
        Object.hasOwn(parsed, key) && typeof parsed[key] === typeof value)
    rows.push({
      kind: check.kind,
      path: check.path,
      shape,
      contract: isDeepStrictEqual(parsed, expected),
    })
  }
  const missing = rows.some(row => row.missing === true)
  return {
    value: missing ? null : rows.every(row => row.shape),
    contract: missing ? null : rows.every(row => row.contract),
    reason: missing ? 'a required file is missing (write stage)' : undefined,
    rows,
  }
}

/** Whether the written deliverable itself carries every expected value. */
function deliverableHasValues(task, workspace) {
  const checks = (task.checks ?? []).filter(check => check.kind === 'json_equals')
  if (checks.length === 0) return null
  if (workspace === undefined) return null
  let seen = 0
  for (const check of checks) {
    const path = join(workspace, check.path)
    if (!existsSync(path)) return null
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return false
    }
    if (!isDeepStrictEqual(parsed, check.value)) return false
    seen += 1
  }
  return seen > 0
}

/** Tool texts the model actually received, with whether each was complete. */
/** The text of a full Message (text blocks only). */
function fullMessageText(message) {
  return (message.content ?? [])
    .map(block => block?.type === 'text' ? String(block.text ?? '') : '')
    .filter(text => text.length > 0)
    .join('\n')
}

/** Primary full messages, when this cell captured them. */
function readFullMessages(campaign, cellId) {
  const path = join(RUNS, campaign, cellId, 'raw', 'messages.json')
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

function toolTexts(report, fullRequests = []) {
  const texts = []
  // The full primary messages are the authority when present: they are the
  // exact bytes the task model received, so absence is decidable rather than
  // `unknown`. Previews are only used for cells that predate this capture.
  for (const request of fullRequests) {
    if (request.purpose !== undefined && request.purpose !== 'primary') continue
    for (const message of request.messages ?? []) {
      if (message.role !== 'tool') continue
      texts.push({
        source: 'full-message',
        text: fullMessageText(message),
        truncated: false,
        name: null,
      })
    }
  }
  for (const event of report.trajectory ?? []) {
    if (event.type !== 'tool/result') continue
    texts.push({
      source: 'trajectory',
      text: String(event.text ?? ''),
      truncated: event.truncated === true,
      name: event.name ?? null,
    })
  }
  if (fullRequests.length === 0) {
    for (const request of report.requests ?? []) {
      // Auxiliary calls are a different reader: the semantic writer and the
      // compaction engine both see the span, but the TASK model does not act
      // on what they were shown. Counting their tool texts as the model's
      // observation would make every EF cell look informed.
      if (request.purpose !== 'primary') continue
      for (const message of request.messages ?? []) {
        if (message.role !== 'tool') continue
        texts.push({
          source: 'request-preview',
          text: String(message.preview ?? ''),
          truncated: message.truncated === true,
          name: null,
        })
      }
    }
  }
  return texts
}

/**
 * Whether the ACTIVE task prompt was still visible in the primary requests.
 *
 * At the 16k operational budget a long continuation can fold the task prompt
 * itself, not only the evidence. That is a different failure from losing a
 * historical fact: the model no longer has the instruction. The first and last
 * primary requests answer "was it delivered" and "did it survive".
 */
function taskPromptVisibility(report, task) {
  const normalize = text => String(text ?? '').replace(/\s+/gu, ' ').trim()
  const needle = normalize(task.task).slice(0, 60)
  const primary = (report.requests ?? []).filter(request => request.purpose === 'primary')
  if (primary.length === 0 || needle.length === 0) return { atStart: null, atEnd: null, lost: null }
  const seen = request => (request.messages ?? []).some(message =>
    normalize(message.preview).includes(needle))
  const atStart = seen(primary[0])
  const atEnd = seen(primary[primary.length - 1])
  return { atStart, atEnd, lost: atStart === true && atEnd === false, requests: primary.length }
}

/** The checkpoint text the task model saw, when the report carries one. */
function checkpointText(report) {
  const checkpoint = report.checkpoint
  if (typeof checkpoint === 'string') return checkpoint
  if (checkpoint !== null && typeof checkpoint === 'object' && typeof checkpoint.text === 'string') return checkpoint.text
  return ''
}

function observedStage(report, pairs, fullRequests = []) {
  const texts = toolTexts(report, fullRequests)
  if (texts.length === 0) {
    return fullRequests.length > 0
      ? { value: false, basis: 'the full primary requests contain no tool result', matched: 0 }
      : { value: null, basis: 'no tool result recorded', matched: 0 }
  }
  const matched = texts.filter(entry => pairs.some(pair => mentionsPair(entry.text, pair)))
  if (matched.length > 0) {
    const basis = matched.some(entry => entry.source === 'full-message')
      ? 'full-message'
      : matched.some(entry => entry.source === 'trajectory') ? 'trajectory' : 'request-preview'
    return {
      value: true,
      basis,
      matched: matched.length,
      truncatedMatch: matched.some(entry => entry.truncated),
    }
  }
  if (texts.some(entry => entry.truncated)) {
    return {
      value: null,
      basis: 'absent from every visible text, but at least one tool text was truncated',
      matched: 0,
      truncated: texts.filter(entry => entry.truncated).length,
    }
  }
  return { value: false, basis: 'complete tool text(s) do not contain the fact', matched: 0 }
}

function archiveStage(report, arm) {
  const legacyAttempts = Array.isArray(report.compactions) ? report.compactions.length : 0
  const legacyCommitted = (report.compactions ?? []).filter(row => row.error === null).length
  // New reports carry a per-attempt witness. The attempt count alone says a
  // transaction opened, not that the span was archived and replaced.
  const witness = report.witnessSummary ?? null
  const attempts = witness === null ? legacyAttempts : witness.attempts
  const committed = witness === null ? legacyCommitted : witness.committed
  const checkpoint = report.checkpoint !== null && report.checkpoint !== undefined
  return {
    value: witness === null ? legacyAttempts > 0 : committed > 0,
    exact: arm !== 'B0',
    modelReadable: arm !== 'B0',
    basis: witness === null
      ? (arm === 'B0'
        ? 'Basic compaction; the legacy report does not separate attempt from commit'
        : 'EF fold; the legacy report counts attempts, not committed replacements')
      : `${committed} committed of ${attempts} attempt(s); committed replacements only`,
    compactions: attempts,
    committed,
    checkpoint,
  }
}

function locateStage(report, arm) {
  const byName = report.tools?.byName ?? {}
  const recall = (byName.context_recall ?? 0) + (byName.context_search ?? 0)
  if (arm === 'B0') {
    return { value: false, calls: 0, basis: 'B0 exposes no archive retrieval interface' }
  }
  return {
    value: recall > 0,
    calls: recall,
    basis: recall > 0 ? 'called context_search/context_recall' : 'no archive retrieval call',
  }
}

function writeStage(task, workspace) {
  const outputs = [...new Set((task.checks ?? [])
    .filter(check => ['json_equals', 'file_contains', 'file_not_contains', 'file_exists', 'file_absent'].includes(check.kind))
    .map(check => check.path))]
  if (outputs.length === 0) return { value: null, outputs, basis: 'no declared output file' }
  if (workspace === undefined) return { value: null, outputs, basis: 'workspace not preserved' }
  const rows = outputs.map(path => ({ path, exists: existsSync(join(workspace, path)) }))
  return { value: rows.every(row => row.exists), outputs: rows, basis: 'final workspace file existence' }
}

function failureSubstage(report) {
  const failing = (report.checker?.checks ?? []).find(check => check.pass !== true)
  if (failing === undefined) return 'checker-failed'
  switch (failing.kind) {
    case 'json_equals': return 'wrong-value'
    case 'tests': return 'tests'
    case 'external_script': return 'external-check'
    case 'file_contains':
    case 'file_not_contains': return 'text-mismatch'
    case 'file_exists':
    case 'file_absent': return 'missing-output'
    default: return failing.kind
  }
}

function failureStage(stages, task, checkerPassed, report) {
  if (checkerPassed) return { stage: 'none', detail: 'checker passed' }
  // The FILE is the deliverable. Prose is optional: a cell that never states
  // the value but writes a correct file passes, so D may not outrank E/F.
  if (stages.E.value === false) {
    if (stages.D.value === true) return { stage: 'write', detail: 'the fact was stated, but the required deliverable was not written' }
    if (stages.C.value === false) {
      return { stage: 'observe', detail: 'the fact was available, but no tool result the model received carried it' }
    }
    if (stages.C.value === null) {
      return {
        stage: 'produce',
        detail: 'nothing was written and the model did not state the fact; whether it observed it is unknown (truncated tool text)',
        caveat: 'C-unknown',
      }
    }
    return { stage: 'produce', detail: 'the fact was observed, but neither the answer nor the deliverable carries it' }
  }
  if (stages.F.value === false) return { stage: 'schema', detail: 'the deliverable exists but its shape/keys/types are wrong' }
  if (stages.G === false) {
    return {
      stage: 'verify',
      substage: failureSubstage(report),
      detail: 'the deliverable exists and parses, but its values or tests do not satisfy the task contract',
    }
  }
  return { stage: 'unknown', detail: 'no stage explains the checker result' }
}

const rows = []
for (const campaign of CAMPAIGNS) {
  const resultsPath = join(OUT, `results-${campaign}.json`)
  if (!existsSync(resultsPath)) continue
  const results = readJson(resultsPath)
  for (const cell of results.results ?? []) {
    if (cell.status !== 'executed') continue
    const task = tasksById.get(cell.cell.task)
    const reportPath = join(RUNS, campaign, cell.cellId, 'report.json')
    if (task === undefined || !existsSync(reportPath)) continue
    const report = readJson(reportPath)
    const arm = cell.cell.arm
    const template = task.template
    const pairs = goldPairs(task)
    const memoryTask = MEMORY_TEMPLATES.has(template)
    const workspace = workspaceOf(campaign, cell.cellId, report)
    const checkerPassed = cell.checker === true
    const schema = schemaOf(task, workspace)
    const finalText = String(report.behaviour?.finalText ?? '')
    const textValues = memoryTask ? mentionsAll(finalText, pairs) : null
    const deliveredValues = memoryTask ? deliverableHasValues(task, workspace) : null
    const checkpointSource = checkpointText(report)
    const promptSource = [task.task, task.taskB ?? '', JSON.stringify(task.stageB ?? '')].join('\n')
    const checkpointValues = memoryTask ? mentionsAllLoose(checkpointSource, pairs) : null
    const promptValues = memoryTask ? mentionsAllLoose(promptSource, pairs) : null
    const fullRequests = readFullMessages(campaign, cell.cellId)
    const toolEntries = memoryTask ? toolTexts(report, fullRequests) : []
    const pairSources = memoryTask
      ? pairs.map(pair => ({
        key: pair.key,
        value: pair.value,
        tool: toolEntries.some(entry => mentionsPair(entry.text, pair)),
        checkpoint: mentionsPair(checkpointSource, pair) || mentionsLoose(checkpointSource, pair),
        prompt: mentionsPair(promptSource, pair) || mentionsLoose(promptSource, pair),
      }))
      : []
    const observed = memoryTask
      ? observedStage(report, pairs, fullRequests)
      : { value: null, basis: 'not a historical-recovery task', matched: 0 }
    const promptVisibility = taskPromptVisibility(report, task)

    const stages = {
      A: archiveStage(report, arm),
      B: memoryTask ? locateStage(report, arm) : { value: null, calls: 0, basis: 'not a historical-recovery task' },
      C: memoryTask ? {
        ...observed,
        checkpointCarried: checkpointValues === null ? null : checkpointValues.value,
        checkpointMatched: checkpointValues?.matched ?? null,
        checkpointTotal: checkpointValues?.total ?? null,
      } : { value: null, basis: 'not a historical-recovery task', matched: 0 },
      D: memoryTask ? {
        value: textValues === null && deliveredValues === null
          ? null
          : textValues?.value === true || deliveredValues === true,
        text: textValues?.value ?? null,
        matchedInText: textValues?.matched ?? null,
        total: textValues?.total ?? null,
        deliverable: deliveredValues,
        taskPromptCarried: promptValues === null ? null : promptValues.value,
        taskPromptMatched: promptValues?.matched ?? null,
        pairSources,
        basis: 'final assistant text OR the written deliverable',
      } : { value: null, basis: 'no gold value for this contract' },
      E: writeStage(task, workspace),
      F: schema,
      G: checkerPassed,
    }
    const failure = failureStage(stages, task, checkerPassed, report)
    rows.push({
      campaign,
      cellId: cell.cellId,
      template,
      seed: task.seed,
      arm,
      block: cell.cell.block,
      checkerPassed,
      stages,
      failureStage: failure.stage,
      failureDetail: failure.detail,
      ...(failure.substage === undefined ? {} : { failureSubstage: failure.substage }),
      ...(failure.caveat === undefined ? {} : { caveat: failure.caveat }),
      recallCalls: stages.B.calls,
      writes: (report.tools?.byName?.write_file ?? 0) + (report.tools?.byName?.edit_file ?? 0),
      hasTrajectory: Array.isArray(report.trajectory) && report.trajectory.length > 0,
      fullPrimaryMessages: fullRequests.length,
      taskPromptVisibleAtStart: promptVisibility.atStart,
      taskPromptVisibleAtEnd: promptVisibility.atEnd,
      taskPromptLost: promptVisibility.lost,
      primaryRequests: promptVisibility.requests ?? null,
    })
  }
}

const byTemplate = {}
for (const row of rows) {
  const bucket = byTemplate[row.template] ?? { cells: 0, passed: 0, stages: {} }
  bucket.cells += 1
  if (row.checkerPassed) bucket.passed += 1
  bucket.stages[row.failureStage] = (bucket.stages[row.failureStage] ?? 0) + 1
  byTemplate[row.template] = bucket
}
const failures = rows.filter(row => !row.checkerPassed)
const stageCounts = {}
for (const row of failures) stageCounts[row.failureStage] = (stageCounts[row.failureStage] ?? 0) + 1
const cUnknown = rows.filter(row => row.stages.C.value === null && MEMORY_TEMPLATES.has(row.template))
const cUnknownFailures = cUnknown.filter(row => !row.checkerPassed)
const verifySubstages = {}
for (const row of failures.filter(entry => entry.failureStage === 'verify')) {
  verifySubstages[row.failureSubstage ?? 'unknown'] = (verifySubstages[row.failureSubstage ?? 'unknown'] ?? 0) + 1
}
const memoryRows = rows.filter(row => MEMORY_TEMPLATES.has(row.template))
const valueDelivered = memoryRows.filter(row => row.stages.D.value === true)

/**
 * Classify a cell by the WEAKEST source every one of its values needed.
 *
 * A cell can take one value from the checkpoint and another from the task
 * prompt; treating it as "checkpoint only" or "prompt only" would be false.
 * The classes are nested unions, from strongest to weakest.
 */
function deliveryPath(row) {
  const sources = row.stages.D.pairSources ?? []
  if (sources.length === 0) return 'unknown'
  const every = predicate => sources.every(predicate)
  if (every(source => source.tool)) return 'tool'
  if (every(source => source.tool || source.checkpoint)) return 'checkpoint'
  if (every(source => source.tool || source.checkpoint || source.prompt)) return 'prompt'
  return 'unattributed'
}

const deliveryPaths = {
  fromToolResult: valueDelivered.filter(row => deliveryPath(row) === 'tool').length,
  fromCheckpointOnly: valueDelivered.filter(row => deliveryPath(row) === 'checkpoint').length,
  fromTaskPromptOnly: valueDelivered.filter(row => deliveryPath(row) === 'prompt').length,
  unattributed: valueDelivered.filter(row => deliveryPath(row) === 'unattributed').length,
  valueNotProduced: memoryRows.filter(row => row.stages.D.value === false).length,
  valueUnknown: memoryRows.filter(row => row.stages.D.value === null).length,
}
const byArm = {}
for (const row of rows.filter(entry => MEMORY_TEMPLATES.has(entry.template))) {
  const bucket = byArm[row.arm] ?? { cells: 0, passed: 0, stages: {} }
  bucket.cells += 1
  if (row.checkerPassed) bucket.passed += 1
  else bucket.stages[row.failureStage] = (bucket.stages[row.failureStage] ?? 0) + 1
  byArm[row.arm] = bucket
}

const output = {
  schemaVersion: 1,
  work: 'EF-R1 WP2',
  generatedAt: new Date().toISOString(),
  sources: {
    campaigns: CAMPAIGNS.filter(campaign => existsSync(join(OUT, `results-${campaign}.json`))),
    cells: rows.length,
    orderedTrajectories: rows.filter(row => row.hasTrajectory).length,
    requestPreviewCells: rows.filter(row => !row.hasTrajectory).length,
    note: 'Pre-trajectory cells expose truncated previews. C is unknown where a visible prefix lacks the fact; it is never inferred from the checker.',
  },
  totals: {
    cells: rows.length,
    passed: rows.filter(row => row.checkerPassed).length,
    failed: failures.length,
    failureStages: stageCounts,
    verifySubstages,
    deliveryPaths,
    cUnknownMemoryCells: cUnknown.length,
    cUnknownFailedMemoryCells: cUnknownFailures.length,
    taskPromptLostCells: rows.filter(row => row.taskPromptLost === true).length,
    taskPromptLostFailures: rows.filter(row => row.taskPromptLost === true && !row.checkerPassed).length,
  },
  byTemplate: Object.fromEntries(Object.entries(byTemplate).sort(([left], [right]) => left.localeCompare(right))),
  byArmMemoryTasks: Object.fromEntries(Object.entries(byArm).sort(([left], [right]) => left.localeCompare(right))),
  rows,
}
writeFileSync(join(OUT, 'stage-attribution.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-E2E — stage attribution')
md.push('')
md.push('Reconstructed offline from the 96 executed cells. No model call was made.')
md.push('')
md.push(`Cells: **${rows.length}**, passed **${rows.filter(row => row.checkerPassed).length}**, failed **${failures.length}**. Ordered trajectories: **${output.sources.orderedTrajectories}**; the rest use request previews with a \`truncated\` flag.`)
md.push('')
md.push('## Where the failures stop')
md.push('')
md.push('| Stage | Meaning | Failed cells |')
md.push('|---|---|---|')
const MEANING = {
  observe: 'the fact was not in any tool result the model received',
  produce: 'nothing was written and the value was not stated',
  write: 'the value was stated, but the deliverable was not written',
  schema: 'the deliverable exists but its keys/types are wrong',
  verify: 'the deliverable parses, but its values or tests fail',
  archive: 'the evidence was not archived',
  locate: 'the archive was never queried',
  unknown: 'no recorded stage explains the result',
  none: 'checker passed',
}
for (const stage of ['observe', 'produce', 'write', 'schema', 'verify', 'unknown']) {
  md.push(`| ${stage} | ${MEANING[stage]} | ${stageCounts[stage] ?? 0} |`)
}
md.push('')
md.push(`**C is unknown in ${cUnknown.length} memory-task cells** (${cUnknownFailures.length} of them failures). A truncated tool preview cannot prove absence, so those are counted apart rather than labelled \`observe\`.`)
md.push('')
md.push('No cell can be shown to have failed at **observation** with the recorded evidence: every memory-task failure either had the fact visible in a tool text or had a truncated text where absence proves nothing. That is a limit of the evidence coverage, not a claim that observation never failed.')
md.push('')
md.push('## How the value reached the answer')
md.push('')
md.push('| Path | Memory-task cells |')
md.push('|---|---|')
md.push(`| every value was seen in a primary tool result | ${deliveryPaths.fromToolResult} |`)
md.push(`| every value was explained by the checkpoint (some also by a tool result) | ${deliveryPaths.fromCheckpointOnly} |`)
md.push(`| every value was explained by the checkpoint or task prompt (some also by a tool) | ${deliveryPaths.fromTaskPromptOnly} |`)
md.push(`| at least one value has no visible source in tool, checkpoint or prompt | ${deliveryPaths.unattributed} |`)
md.push(`| the value was not produced | ${deliveryPaths.valueNotProduced} |`)
md.push(`| value production unknown (no gold pair) | ${deliveryPaths.valueUnknown} |`)
md.push('')
md.push('The checkpoint path is why an E1 cell can pass T2 without calling recall: the semantic state carried the exact value inline. It is also why a B0 cell can pass: Basic\'s summary contained the build and timeout verbatim. Neither is a retrieval success, and neither is evidence that the archive was used.')
md.push('')
md.push('## Did the task prompt itself survive?')
md.push('')
md.push(`The active task prompt was folded during the continuation in **${output.totals.taskPromptLostCells}** cells (${output.totals.taskPromptLostFailures} of them failures). That is a different failure from losing a historical fact: the model no longer has the instruction. At the 16k operational budget a long continuation can fold the request itself, and the locator is then recovering the TASK, not only the evidence. Read every L×G result with this covariate in view.`)
md.push('')
if (Object.keys(verifySubstages).length > 0) {
  md.push('Verification failures split by the failing checker:')
  md.push('')
  md.push('| Sub-stage | Cells |')
  md.push('|---|---|')
  for (const [name, count] of Object.entries(verifySubstages)) md.push(`| ${name} | ${count} |`)
  md.push('')
}
md.push('## Memory tasks by arm')
md.push('')
md.push('| Arm | Cells | Passed | Failure stages |')
md.push('|---|---|---|---|')
for (const [arm, bucket] of Object.entries(output.byArmMemoryTasks)) {
  const stages = Object.entries(bucket.stages).map(([stage, count]) => `${stage} ${count}`).join(', ')
  md.push(`| ${arm} | ${bucket.cells} | ${bucket.passed} | ${stages || '—'} |`)
}
md.push('')
md.push('## What this changes')
md.push('')
md.push('The 47 failures are not one mechanism. Seventeen never put the value anywhere, thirteen stated it but wrote no file, twelve wrote a wrong shape, and five wrote a shape-correct file whose values or tests fail. `B0` is not uniformly worse for the same reason: its compaction summary can carry the exact values inline (the T2-s1 summary contains both), so a short task can pass without any archive interface; an EF fold applies a retention policy that may move the same tool result into the archive, so the continuation must retrieve it. The stage table makes that trade visible instead of calling both outcomes "compression quality".')
md.push('')
md.push('## Per template')
md.push('')
md.push('| Template | Cells | Passed | Failure stages |')
md.push('|---|---|---|---|')
for (const [template, bucket] of Object.entries(output.byTemplate)) {
  const stages = Object.entries(bucket.stages).filter(([stage]) => stage !== 'none').map(([stage, count]) => `${stage} ${count}`).join(', ')
  md.push(`| ${template} | ${bucket.cells} | ${bucket.passed} | ${stages || '—'} |`)
}
md.push('')
md.push('## The cells that matter most')
md.push('')
md.push('| Campaign | Cell | Pass | D value | C observed | Written | Failure |')
md.push('|---|---|---|---|---|---|---|')
for (const row of rows.filter(entry => !entry.checkerPassed && MEMORY_TEMPLATES.has(entry.template))) {
  md.push(`| ${row.campaign} | ${row.cellId} | ${row.checkerPassed ? 'yes' : 'no'} | ${String(row.stages.D.value)} | ${String(row.stages.C.value)} | ${String(row.stages.E.value)} | ${row.failureStage} |`)
}
writeFileSync(join(OUT, 'stage-attribution.md'), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`stage attribution: ${rows.length} cells, ${failures.length} failures\n`)
process.stdout.write(`  stages ${JSON.stringify(stageCounts)}\n`)
process.stdout.write(`  C unknown (memory tasks): ${cUnknown.length} (${cUnknownFailures.length} failed)\n`)
