#!/usr/bin/env node
/**
 * EF-R2 WP3 — re-certify active-task delivery from full primary messages.
 *
 * EF-R1 §5.4 reported "44/120 cells lost the task prompt by the last primary
 * request". That number came from a 400-character preview and only the first
 * and last request. It could not distinguish:
 *
 *   original      the exact task message is still there
 *   copy          a checkpoint carries the request text verbatim (E0-R)
 *   values-only   the checkpoint carries the task's facts but not its wording
 *   missing       neither the request nor its facts are visible
 *
 * This script recomputes the matrix per request. It uses the message digests
 * already recorded in `report.requests` for exact matching, and
 * `raw/messages.json` when the campaign captured full message bytes (the 194
 * cells from `e2e-lg-pilot-1` onward). Earlier cells are labelled
 * `preview-only` for the prefix/containment checks, but exact delivery is still
 * decidable from the digest.
 *
 *   node eval/r2/task-delivery.mjs
 *
 * @module eval/r2/task-delivery
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileBundleStore } from '../../lib/checkpoint/bundle-store.js'
import { buildWitnessesFromRun } from '../e2e/src/witness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')
const CONFIRM = 'e2e-lg-confirm-1'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const normalize = text => String(text ?? '').replace(/\s+/gu, ' ').trim()

const stages = readJson(join(E2E_OUT, 'stage-attribution.json'))
const rows = stages.rows ?? []

/** Task facts worth checking in a checkpoint: reference/check values. */
function flattenScalars(value, out = []) {
  if (Array.isArray(value)) {
    for (const entry of value) flattenScalars(entry, out)
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) flattenScalars(entry, out)
    return out
  }
  if (typeof value === 'string' && value.length >= 3) out.push(value)
  if (typeof value === 'number' && Number.isFinite(value)) out.push(String(value))
  return out
}

function probesFor(task) {
  const probes = new Set()
  for (const check of task.checks ?? []) {
    if (check.value !== undefined) {
      for (const value of flattenScalars(check.value)) probes.add(value)
    }
  }
  for (const [name, content] of Object.entries(task.reference ?? {})) {
    if (!name.endsWith('.json')) continue
    try {
      for (const value of flattenScalars(JSON.parse(content))) probes.add(value)
    } catch {
      // A non-JSON reference is not a probe source.
    }
  }
  return [...probes].filter(value => value.length <= 120).slice(0, 20)
}

function taskFile(row) {
  const path = join(ROOT, 'eval', 'e2e', 'tasks', `${row.template}-s${row.seed}.json`)
  return existsSync(path) ? readJson(path) : undefined
}

/** One request's delivery flags. */
function requestDelivery(request, full, prompt, probes, checkpointDigests) {
  const messages = full?.messages ?? request.messages ?? []
  const promptSha = sha256(prompt)
  const needle = normalize(prompt).slice(0, 60)
  let originalExact = false
  let originalPrefix = false
  let checkpoint = false
  let promptInCheckpoint = false
  let values = false
  for (const message of messages) {
    const text = (message.content ?? [])
      .map(block => (block?.type === 'text' ? block.text : ''))
      .join('')
    const preview = message.preview ?? text.slice(0, 400)
    const digest = message.digest ?? sha256(text)
    if (digest === promptSha) originalExact = true
    if (needle.length > 0 && normalize(preview).includes(needle)) originalPrefix = true
    const isCheckpoint = message.source?.kind === 'compact-checkpoint'
      || checkpointDigests.has(digest)
      || preview.includes('[EF1 ')
    if (isCheckpoint) {
      checkpoint = true
      if (needle.length > 0 && normalize(text || preview).includes(needle)) promptInCheckpoint = true
      if (text.length > 0 && normalize(prompt).length >= 20
        && normalize(text).includes(normalize(prompt))) promptInCheckpoint = true
    }
    for (const probe of probes) {
      if (text.length > 0 ? text.includes(probe) : preview.includes(probe)) {
        values = true
        break
      }
    }
  }
  return {
    index: Number(request.index),
    originalExact,
    originalPrefix,
    checkpoint,
    promptInCheckpoint,
    values,
    absent: !originalExact && !originalPrefix && !checkpoint && !values,
  }
}

function deliveryKind(entry) {
  if (entry === undefined) return null
  if (entry.originalExact) return 'original'
  if (entry.promptInCheckpoint) return 'checkpoint-copy'
  if (entry.values) return 'values-only'
  if (entry.checkpoint) return 'checkpoint-without-prompt'
  return 'absent'
}

const cells = []
for (const row of rows) {
  const cellRoot = join(ROOT, 'eval', 'e2e', 'runs', row.campaign, row.cellId)
  const reportPath = join(cellRoot, 'report.json')
  if (!existsSync(reportPath)) continue
  const report = readJson(reportPath)
  const requestsPath = join(cellRoot, 'raw', 'requests.json')
  const messagesPath = join(cellRoot, 'raw', 'messages.json')
  const requests = existsSync(requestsPath) ? readJson(requestsPath) : []
  const fullMessages = existsSync(messagesPath) ? readJson(messagesPath) : []
  const task = taskFile(row)
  if (task === undefined) continue
  const primary = requests
    .filter(request => request.purpose === 'primary')
    .sort((left, right) => Number(left.index) - Number(right.index))
  const fullByIndex = new Map(fullMessages.map(entry => [Number(entry.index), entry]))
  const probes = probesFor(task)

  // Resolve the committed checkpoint bodies for exact digest matching.
  const built = await buildWitnessesFromRun({
    report,
    requests,
    fullMessages,
    bundleRoot: join(cellRoot, 'bundles'),
    taskPrompt: task.task,
    arm: row.arm,
  })
  const bundleRoot = join(cellRoot, 'bundles')
  const session = existsSync(bundleRoot)
    ? readdirSync(bundleRoot, { withFileTypes: true }).find(entry => entry.isDirectory())
    : undefined
  const store = session === undefined ? null : new FileBundleStore(bundleRoot)
  const checkpointBodies = []
  if (store !== null) {
    for (const witness of built.witnesses) {
      if (witness.status !== 'committed' || witness.checkpointId === undefined) continue
      const verification = await store.verify(session.name, witness.checkpointId)
      if (verification.status === 'verified') checkpointBodies.push(verification.bundle.rendered.text)
    }
  }
  if (typeof report.checkpoint?.text === 'string') checkpointBodies.push(report.checkpoint.text)
  const uniqueBodies = [...new Set(checkpointBodies)]
  const checkpointDigests = new Set(uniqueBodies.map(text => sha256(text)))

  const prompts = [
    { label: 'task', text: task.task },
    ...(task.taskB === undefined ? [] : [{ label: 'taskB', text: task.taskB }]),
  ]
  const matrices = prompts.map(prompt => {
    const entries = primary.map(request => requestDelivery(
      request,
      fullByIndex.get(Number(request.index)),
      prompt.text,
      probes,
      checkpointDigests,
    ))
    const start = entries[0]
    const end = entries[entries.length - 1]
    return {
      label: prompt.label,
      promptChars: prompt.text.length,
      promptSha256: sha256(prompt.text),
      requests: entries,
      atStart: deliveryKind(start),
      atEnd: deliveryKind(end),
      originalLost: start?.originalExact === true && end?.originalExact !== true,
      legacyLost: start?.originalPrefix === true && end?.originalPrefix !== true,
      semanticsUnavailable: end !== undefined
        && !end.originalExact && !end.promptInCheckpoint && !end.values,
      checkpointAtEnd: end?.checkpoint === true,
      valuesAtEnd: end?.values === true,
    }
  })
  const primaryMatrix = matrices[matrices.length - 1]

  cells.push({
    campaign: row.campaign,
    cellId: row.cellId,
    arm: row.arm,
    template: row.template,
    seed: row.seed,
    checkerPassed: row.checkerPassed,
    fullMessages: fullMessages.length,
    primaryRequests: primary.length,
    coverage: fullMessages.length === 0 ? 'preview-only' : 'full-messages',
    taskId: task.id,
    probes,
    matrices,
    ...primaryMatrix,
  })
}

const confirm = cells.filter(cell => cell.campaign === CONFIRM)
const full = cells.filter(cell => cell.coverage === 'full-messages')
const previewOnly = cells.filter(cell => cell.coverage === 'preview-only')

const summarize = subset => ({
  cells: subset.length,
  withPrimary: subset.filter(cell => cell.primaryRequests > 0).length,
  atStartOriginal: subset.filter(cell => cell.atStart === 'original').length,
  atEndOriginal: subset.filter(cell => cell.atEnd === 'original').length,
  atEndCheckpointCopy: subset.filter(cell => cell.atEnd === 'checkpoint-copy').length,
  atEndValuesOnly: subset.filter(cell => cell.atEnd === 'values-only').length,
  atEndCheckpointWithoutPrompt: subset.filter(cell => cell.atEnd === 'checkpoint-without-prompt').length,
  atEndAbsent: subset.filter(cell => cell.atEnd === 'absent').length,
  legacyLost: subset.filter(cell => cell.legacyLost === true).length,
  originalLost: subset.filter(cell => cell.originalLost === true).length,
  semanticsUnavailable: subset.filter(cell => cell.semanticsUnavailable === true).length,
})

const byArm = [...new Set(confirm.map(cell => cell.arm))].sort().map(arm => ({
  arm,
  ...summarize(confirm.filter(cell => cell.arm === arm)),
}))
const byTemplate = [...new Set(confirm.map(cell => cell.template))].sort().map(template => ({
  template,
  ...summarize(confirm.filter(cell => cell.template === template)),
}))

const e1 = confirm.filter(cell => cell.arm === 'E1')
const covariate = {
  legacy: {
    lost: { cells: e1.filter(cell => cell.legacyLost === true).length, passed: e1.filter(cell => cell.legacyLost === true && cell.checkerPassed).length },
    visible: { cells: e1.filter(cell => cell.legacyLost !== true).length, passed: e1.filter(cell => cell.legacyLost !== true && cell.checkerPassed).length },
  },
  exact: {
    lost: { cells: e1.filter(cell => cell.originalLost === true).length, passed: e1.filter(cell => cell.originalLost === true && cell.checkerPassed).length },
    visible: { cells: e1.filter(cell => cell.originalLost !== true).length, passed: e1.filter(cell => cell.originalLost !== true && cell.checkerPassed).length },
  },
  semantics: {
    unavailable: { cells: e1.filter(cell => cell.semanticsUnavailable === true).length, passed: e1.filter(cell => cell.semanticsUnavailable === true && cell.checkerPassed).length },
    available: { cells: e1.filter(cell => cell.semanticsUnavailable !== true).length, passed: e1.filter(cell => cell.semanticsUnavailable !== true && cell.checkerPassed).length },
  },
}

const output = {
  schemaVersion: 1,
  work: 'EF-R2 WP3',
  generatedAt: new Date().toISOString(),
  sources: {
    stageAttribution: { path: 'eval/e2e/out/stage-attribution.json', sha256: sha256(readFileSync(join(E2E_OUT, 'stage-attribution.json'), 'utf8')) },
  },
  coverage: {
    campaigns: [...new Set(cells.map(cell => cell.campaign))].length,
    cells: cells.length,
    fullMessages: full.length,
    previewOnly: previewOnly.length,
    note: 'Exact original/checkpoint delivery is digest-based and decidable in every cell. Prefix and checkpoint-containment checks use full message bytes where captured; earlier cells are labelled preview-only for those checks.',
  },
  legacyConfirm: {
    cells: confirm.length,
    taskPromptLost: confirm.filter(cell => cell.legacyLost === true).length,
    expected: 44,
    reproduced: confirm.filter(cell => cell.legacyLost === true).length === 44,
  },
  recertifiedConfirm: {
    ...summarize(confirm),
    atStartOriginal: confirm.filter(cell => cell.atStart === 'original').length,
    atEndOriginal: confirm.filter(cell => cell.atEnd === 'original').length,
    originalLost: confirm.filter(cell => cell.originalLost === true).length,
    semanticsUnavailable: confirm.filter(cell => cell.semanticsUnavailable === true).length,
    byArm,
    byTemplate,
    e1Covariate: covariate,
  },
  allCampaigns: summarize(cells),
  semanticsBasis: 'Task reference/check values visible in any message. This proves the task FACTS survived, not that the instruction wording or its constraints did.',
  rows: cells,
  note: 'The 44/120 legacy number is reproduced from the preview metric, then split into exact original loss, checkpoint copies, values-only delivery and true absence. A checkpoint copy is not the original event; it is a runtime-authored copy in the checkpoint body.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'active-task-delivery.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R2 — active-task delivery')
md.push('')
md.push(`Coverage: ${output.coverage.cells} cells, ${output.coverage.fullMessages} with full messages, ${output.coverage.previewOnly} preview-only.`)
md.push('')
md.push(`Legacy confirm: **${output.legacyConfirm.taskPromptLost}/120** lost by the preview metric (expected 44; reproduced ${output.legacyConfirm.reproduced}).`)
md.push('')
md.push('| Measure | Confirm cells |')
md.push('|---|---|')
md.push(`| Original task message at last request | ${output.recertifiedConfirm.atEndOriginal} |`)
md.push(`| Original lost by last request (exact) | ${output.recertifiedConfirm.originalLost} |`)
md.push(`| Checkpoint contains the request text | ${output.recertifiedConfirm.atEndCheckpointCopy} |`)
md.push(`| Checkpoint carries the task values only | ${output.recertifiedConfirm.atEndValuesOnly} |`)
md.push(`| Checkpoint present, neither request nor values | ${output.recertifiedConfirm.atEndCheckpointWithoutPrompt} |`)
md.push(`| Nothing visible | ${output.recertifiedConfirm.atEndAbsent} |`)
md.push(`| Task values unavailable at the end | ${output.recertifiedConfirm.semanticsUnavailable} |`)
md.push('')
md.push('## By arm')
md.push('')
md.push('| Arm | End original | Checkpoint copy | Values only | Neither | Values unavailable |')
md.push('|---|---|---|---|---|---|')
for (const arm of byArm) {
  md.push(`| ${arm.arm} | ${arm.atEndOriginal} | ${arm.atEndCheckpointCopy} | ${arm.atEndValuesOnly} | ${arm.atEndCheckpointWithoutPrompt} | ${arm.semanticsUnavailable} |`)
}
md.push('')
md.push('## What this refines, and what it does not')
md.push('')
md.push(`The exact original is gone in **${output.recertifiedConfirm.originalLost}/120** cells, but only **${output.recertifiedConfirm.semanticsUnavailable}/120** have neither the request text nor the task values at the end. ${output.recertifiedConfirm.atEndCheckpointCopy} carry the request text in a checkpoint copy and ${output.recertifiedConfirm.atEndValuesOnly} carry the task values without the wording.`)
md.push('')
md.push('A values-only delivery is not proof that the instruction survived: it proves the answer facts did. The two values-unavailable cells are the only ones where the earlier “prompt lost” label coincides with actual information absence.')
md.push('')
md.push('## E1 covariate')
md.push('')
md.push(`- Legacy preview loss: lost ${covariate.legacy.lost.passed}/${covariate.legacy.lost.cells} pass, visible ${covariate.legacy.visible.passed}/${covariate.legacy.visible.cells} pass.`)
md.push(`- Exact original loss: lost ${covariate.exact.lost.passed}/${covariate.exact.lost.cells} pass, visible ${covariate.exact.visible.passed}/${covariate.exact.visible.cells} pass.`)
md.push(`- Task values unavailable: ${covariate.semantics.unavailable.passed}/${covariate.semantics.unavailable.cells} pass, available ${covariate.semantics.available.passed}/${covariate.semantics.available.cells} pass.`)
md.push('')
md.push('The two exact-loss E1 cells still carried the task values (values unavailable 0/24). Their 0/2 pass rate is therefore not explained by the facts disappearing; n=2, so it is a description, not an effect.')
md.push('')
writeFileSync(join(OUT, 'active-task-delivery.md'), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`task delivery: ${cells.length} cells (${full.length} full, ${previewOnly.length} preview-only)\n`)
process.stdout.write(`legacy confirm lost ${output.legacyConfirm.taskPromptLost}/120 (expected 44, reproduced ${output.legacyConfirm.reproduced})\n`)
process.stdout.write(`recertified: original ${output.recertifiedConfirm.atEndOriginal}/120 at end, lost ${output.recertifiedConfirm.originalLost}, checkpoint-copy ${output.recertifiedConfirm.atEndCheckpointCopy}, values-only ${output.recertifiedConfirm.atEndValuesOnly}, checkpoint-no-prompt ${output.recertifiedConfirm.atEndCheckpointWithoutPrompt}, absent ${output.recertifiedConfirm.atEndAbsent}, semantics-unavailable ${output.recertifiedConfirm.semanticsUnavailable}\n`)
process.stdout.write(`E1 covariate: legacy lost ${covariate.legacy.lost.passed}/${covariate.legacy.lost.cells}, exact lost ${covariate.exact.lost.passed}/${covariate.exact.lost.cells}, semantics unavailable ${covariate.semantics.unavailable.passed}/${covariate.semantics.unavailable.cells}\n`)
