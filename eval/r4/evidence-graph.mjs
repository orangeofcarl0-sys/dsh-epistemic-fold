#!/usr/bin/env node
/**
 * EF-R4 WP2 — reconstruct the R3 recall-to-fold evidence lifecycle.
 *
 * The question is not "did the model call recall often". It is:
 *
 *   resultSeq(R) ∈ shadowedSeqs(F)  ->  is R still in the next primary request?
 *
 * Every edge below is derived from an event seq or a content digest. A text
 * substring never proves identity; it is recorded as `equivalent-inferred`.
 * Missing trace is `unknown`, not a guess.
 *
 *   node eval/r4/evidence-graph.mjs
 *
 * @module eval/r4/evidence-graph
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ROOT,
  buildRequestIndex,
  checkpointTextOf,
  isCheckpointText,
  liveStartSeqOf,
  loadCampaign,
  loadCell,
  pairToolCalls,
  requiredArtifactsOf,
  textOfContent,
} from './shared/audit.mjs'

const CAMPAIGN = 'e2e-r3-product-pilot-1'
const OUT = join(ROOT, 'eval', 'r4', 'out')
const RECALL_TOOLS = new Set(['context_recall', 'context_search'])

export function markerOnly(text) {
  if (typeof text !== 'string') return false
  const lines = text.trim().split(/\r?\n/).filter(line => line.trim().length > 0)
  return lines.length <= 1 && isCheckpointText(lines[0] ?? '')
}

export function evidenceKeyOf(tool, parsed, args = null) {
  if (tool === 'context_recall') {
    const checkpointId = parsed?.checkpointId
      ?? (typeof args?.ref === 'string' ? args.ref.replace(/^cp:/u, '') : 'unknown')
    const depth = parsed?.depth ?? args?.depth ?? 'detail'
    if (depth === 'exact') {
      const messages = parsed?.page?.messages ?? []
      const ids = messages.map(message => message?.id).filter(id => typeof id === 'string')
      return `cp:${checkpointId}#exact:${parsed?.page?.offset ?? args?.offset ?? 0}#${ids[0] ?? 'none'}:${messages.length}`
    }
    const offset = parsed?.page?.offset
      ?? args?.offset
      ?? parsed?.descriptor?.entries?.[0]?.offset
      ?? 0
    return `cp:${checkpointId}#${depth}:${offset}`
  }
  if (tool === 'context_search') {
    const query = parsed?.query ?? args?.query ?? '?'
    const hits = parsed?.hits ?? []
    const keys = hits.map(hit => `${hit.checkpointId}:${hit.earliestMatchedMessageIndex ?? hit.matchedMessageIndex ?? '?'}`)
    return `search:${query}#${keys.join(',') || 'no-hit'}`
  }
  return `${tool}:unknown`
}

/**
 * Eligibility for the "did the model fail to use delivered evidence" class.
 * A parse failure or an explicitly unavailable archive is a localization
 * problem, not a working-set problem.
 */
export function mislocalizedOf(tool, parsed, parseError) {
  if (parseError !== null && parseError !== undefined) return true
  if (parsed === null || parsed === undefined) return true
  if (typeof parsed.unavailable === 'string' && parsed.unavailable.length > 0) return true
  if (tool === 'context_recall' && parsed.depth === 'exact') {
    const messages = parsed?.page?.messages
    return !Array.isArray(messages) || messages.length === 0
  }
  if (tool === 'context_search') return parsed.outcome === 'no-archive'
  return false
}

/**
 * The visibility decision is a small, testable table. `folded` means a later
 * fold's shadowedSeqs contains the result event; `delivered` means a following
 * primary request carries that fold's checkpoint.
 */
export function visibilityOf({ folded, delivered, visible, checkpointText, equivalent }) {
  if (delivered === false) return 'no-following-request'
  if (visible === true) return 'visible'
  if (checkpointText === null || checkpointText === undefined) {
    return folded === true ? 'invisible-after-fold' : 'absent'
  }
  if (markerOnly(checkpointText)) return 'marker-only'
  if (equivalent === true) return 'equivalent-inferred'
  return folded === true ? 'invisible-after-fold' : 'absent'
}

/** Candidate exact quotes from a recall payload; a substring is only inferred. */
export function quoteCandidates(text, parsed) {
  const source = Array.isArray(parsed?.page?.messages)
    ? parsed.page.messages.map(message => textOfContent(message.content)).join('\n')
    : (typeof parsed?.text === 'string' ? parsed.text : String(text ?? ''))
  const candidates = []
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length < 24 || trimmed.length > 240) continue
    if (!/[0-9]|\/|cp:|id=|status=|concurrency|release|checksum/iu.test(trimmed)) continue
    candidates.push(trimmed)
    if (candidates.length >= 20) break
  }
  return candidates
}

export function progressAfter(trajectory, resultSeq) {
  const nextFold = trajectory.find(event => event.type === 'compaction/start' && event.seq > resultSeq)
  const limit = nextFold?.seq ?? Number.POSITIVE_INFINITY
  const calls = trajectory.filter(event =>
    event.type === 'tool/call'
    && event.seq > resultSeq
    && event.seq < limit)
  const names = calls.map(call => call.name)
  if (names.some(name => name === 'write_file' || name === 'edit_file')) return 'write'
  if (names.includes('run_tests')) return 'test-run'
  if (names.includes('finish')) return 'finish'
  return 'none'
}

function parseResult(text) {
  try {
    return { parsed: JSON.parse(text), parseError: null }
  } catch (error) {
    return { parsed: null, parseError: error instanceof Error ? error.message : String(error) }
  }
}

function buildCell(cell) {
  const report = cell.report
  const task = cell.task
  const trajectory = report?.trajectory ?? []
  const liveStartSeq = liveStartSeqOf(trajectory, task)
  const messages = cell.messages ?? []
  const { requests, requestByToolCallId } = buildRequestIndex(messages)
  const calls = pairToolCalls(trajectory)
    .filter(call => RECALL_TOOLS.has(call.name))
    .filter(call => call.callSeq >= liveStartSeq)

  const folds = (report?.witnesses ?? []).map(witness => {
    const delivered = requests.find(request =>
      typeof witness.checkpointSha256 === 'string'
      && request.textDigests.has(witness.checkpointSha256))
    return {
      compactionId: witness.compactionId ?? null,
      checkpointId: witness.checkpointId ?? null,
      status: witness.status ?? null,
      phase: (witness.startSeq ?? 0) < liveStartSeq ? 'seed' : 'live',
      startSeq: witness.startSeq ?? null,
      summarySeq: witness.summarySeq ?? null,
      replacementSeq: witness.replacementSeq ?? null,
      endSeq: witness.endSeq ?? null,
      shadowedSeqs: Array.isArray(witness.shadowedSeqs) ? witness.shadowedSeqs.map(Number) : [],
      checkpointChars: witness.checkpointChars ?? null,
      checkpointSha256: witness.checkpointSha256 ?? null,
      deliveredAtRequest: delivered?.index ?? null,
    }
  })

  const evidence = []
  for (const call of calls) {
    const fullText = call.callId === null
      ? call.resultPreview
      : (requestByToolCallId.has(call.callId)
          ? requests.find(request => request.index === requestByToolCallId.get(call.callId))
              ?.toolCallIdText.get(call.callId) ?? call.resultPreview
          : call.resultPreview)
    const { parsed, parseError } = parseResult(fullText)
    let args = null
    try {
      args = call.argsText.length === 0 ? null : JSON.parse(call.argsText)
    } catch {
      args = null
    }
    const key = evidenceKeyOf(call.name, parsed, args)
    const resultRequestIndex = call.callId === null ? null : requestByToolCallId.get(call.callId) ?? null
    const foldedBy = folds
      .filter(fold => fold.startSeq !== null && fold.startSeq > call.resultSeq && fold.shadowedSeqs.includes(call.resultSeq))
      .sort((left, right) => left.startSeq - right.startSeq)[0] ?? null

    let visibilityRequest = null
    let delivered = null
    if (foldedBy !== null) {
      delivered = foldedBy.deliveredAtRequest !== null
      visibilityRequest = delivered
        ? requests.find(request => request.index === foldedBy.deliveredAtRequest) ?? null
        : null
    } else {
      visibilityRequest = resultRequestIndex === null
        ? null
        : requests.find(request => request.index === resultRequestIndex) ?? null
      delivered = visibilityRequest !== null
    }
    const visible = visibilityRequest !== null
      && call.callId !== null
      && visibilityRequest.toolCallIds.has(call.callId)
    const checkpointText = foldedBy === null
      ? null
      : checkpointTextOf(visibilityRequest, foldedBy.checkpointSha256)
    const equivalent = checkpointText !== null
      && quoteCandidates(fullText, parsed).some(line => checkpointText.includes(line))
    const visibility = visibilityOf({
      folded: foldedBy !== null,
      delivered,
      visible,
      checkpointText,
      equivalent,
    })
    const mislocalized = mislocalizedOf(call.name, parsed, parseError)
    const progress = progressAfter(trajectory, call.resultSeq)
    const taskFailed = report?.scoring?.taskOutcome !== undefined
      ? report.scoring.taskOutcome !== 'correct'
      : report?.checker?.pass !== true
    const classes = []
    if (mislocalized) classes.push('recall-mislocalization')
    if (foldedBy !== null && visibility !== 'visible' && visibility !== 'equivalent-inferred') {
      classes.push('recall-refolding')
    }
    if (visibility === 'visible' && taskFailed && progress === 'none') {
      classes.push('recall-non-utilization')
    }
    if (classes.length === 0) classes.push('unknown')

    evidence.push({
      evidenceId: `${cell.cellId}:r${call.resultSeq}`,
      key,
      tool: call.name,
      callSeq: call.callSeq,
      resultSeq: call.resultSeq,
      callId: call.callId,
      requestIndex: resultRequestIndex,
      argsTruncated: call.argsTruncated,
      checkpointId: parsed?.checkpointId ?? null,
      depth: parsed?.depth ?? args?.depth ?? null,
      offset: parsed?.page?.offset ?? args?.offset ?? parsed?.descriptor?.entries?.[0]?.offset ?? null,
      query: call.name === 'context_search' ? (args?.query ?? null) : null,
      ref: call.name === 'context_recall' ? (args?.ref ?? null) : null,
      messageIds: Array.isArray(parsed?.page?.messages)
        ? parsed.page.messages.map(message => message?.id).filter(id => typeof id === 'string')
        : [],
      summaryAvailable: parsed?.summaryAvailable ?? null,
      unavailable: parsed?.unavailable ?? null,
      parseError,
      foldedBy: foldedBy === null ? null : {
        compactionId: foldedBy.compactionId,
        checkpointId: foldedBy.checkpointId,
        phase: foldedBy.phase,
        startSeq: foldedBy.startSeq,
      },
      deliveredAtRequest: foldedBy?.deliveredAtRequest ?? null,
      visibilityRequest: visibilityRequest?.index ?? null,
      visibility,
      evidenceLevel: visibility === 'visible' ? 'verified'
        : visibility === 'equivalent-inferred' ? 'inferred' : 'unknown',
      progressAfter: progress,
      classes,
    })
  }

  // Repetition is a property of the whole cell, not of one call.
  const counts = new Map()
  for (const item of evidence) counts.set(item.key, (counts.get(item.key) ?? 0) + 1)
  const repeatedKeys = new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key))
  for (const item of evidence) {
    if (repeatedKeys.has(item.key)) {
      item.repeated = true
      if (!item.classes.includes('repeated-recall')) item.classes.push('repeated-recall')
    } else {
      item.repeated = false
    }
  }

  const summary = {
    recallCalls: calls.length,
    evidenceInstances: evidence.length,
    folded: evidence.filter(item => item.foldedBy !== null).length,
    visible: evidence.filter(item => item.visibility === 'visible').length,
    markerOnly: evidence.filter(item => item.visibility === 'marker-only').length,
    equivalentInferred: evidence.filter(item => item.visibility === 'equivalent-inferred').length,
    invisibleAfterFold: evidence.filter(item => item.visibility === 'invisible-after-fold').length,
    noFollowingRequest: evidence.filter(item => item.visibility === 'no-following-request').length,
    unknown: evidence.filter(item => item.visibility === 'unknown' || item.classes.includes('unknown')).length,
    refolded: evidence.filter(item => item.classes.includes('recall-refolding')).length,
    repeated: evidence.filter(item => item.repeated === true).length,
    mislocalized: evidence.filter(item => item.classes.includes('recall-mislocalization')).length,
    nonUtilization: evidence.filter(item => item.classes.includes('recall-non-utilization')).length,
  }

  const relations = evidence
    .filter(item => item.foldedBy !== null)
    .map(item => ({
      cellId: cell.cellId,
      arm: cell.arm,
      task: cell.taskId,
      evidenceId: item.evidenceId,
      resultSeq: item.resultSeq,
      compactionId: item.foldedBy.compactionId,
      checkpointId: item.foldedBy.checkpointId,
      phase: item.foldedBy.phase,
      nextRequest: item.visibilityRequest,
      visibility: item.visibility,
      evidenceLevel: item.evidenceLevel,
    }))

  return {
    cellId: cell.cellId,
    task: cell.taskId,
    arm: cell.arm,
    liveStartSeq,
    requests: requests.length,
    folds,
    evidence,
    relations,
    summary,
  }
}

function deliveryTimeline(cell) {
  const report = cell.report
  const messages = cell.messages ?? []
  const { requests } = buildRequestIndex(messages)
  const required = requiredArtifactsOf(cell.task)
  const folds = (report?.witnesses ?? []).map(witness => {
    const delivered = requests.find(request =>
      typeof witness.checkpointSha256 === 'string'
      && request.textDigests.has(witness.checkpointSha256))
    return { checkpointId: witness.checkpointId ?? null, deliveredAtRequest: delivered?.index ?? null }
  })
  const deliveryByLabel = new Map((report?.activeDelivery ?? []).map(entry => [entry.label, entry]))
  const labels = [...deliveryByLabel.keys()]
  const timeline = requests.map(request => {
    const row = { request: request.index, at: request.at, labels: {} }
    for (const label of labels) {
      const delivery = deliveryByLabel.get(label)?.requests?.find(entry => entry.index === request.index)
      row.labels[label] = delivery === undefined
        ? { status: 'unknown' }
        : delivery.originalExact || delivery.originalPrefix
          ? { status: 'exact' }
          : delivery.checkpointMarker
            ? { status: 'marker-only' }
            : delivery.absent
              ? { status: 'absent' }
              : { status: 'unknown' }
    }
    row.requiredArtifacts = required.map(path => ({
      path,
      present: request.userText.includes(path),
    }))
    row.foldDelivered = folds
      .filter(fold => fold.deliveredAtRequest !== null && fold.deliveredAtRequest <= request.index)
      .map(fold => fold.checkpointId)
    return row
  })
  return {
    cellId: cell.cellId,
    task: cell.taskId,
    arm: cell.arm,
    labels,
    requiredArtifacts: required,
    timeline,
  }
}

function main() {
  const campaign = loadCampaign({ campaign: CAMPAIGN })
  const cells = []
  const timelines = []
  for (const row of campaign.results.results ?? []) {
    if (row.status !== 'executed') continue
    const cell = loadCell({ root: campaign.root, row, tasks: campaign.tasks })
    if (cell.report === null) continue
    cells.push(buildCell(cell))
    timelines.push(deliveryTimeline(cell))
  }

  const totals = cells.reduce((sum, cell) => {
    for (const [key, value] of Object.entries(cell.summary)) {
      sum[key] = (sum[key] ?? 0) + value
    }
    return sum
  }, {})

  const repeated = cells.map(cell => {
    const groups = new Map()
    for (const item of cell.evidence) {
      if (!groups.has(item.key)) groups.set(item.key, [])
      groups.get(item.key).push(item)
    }
    return {
      cellId: cell.cellId,
      arm: cell.arm,
      repeatedKeys: [...groups.entries()]
        .filter(([, items]) => items.length > 1)
        .map(([key, items]) => ({
          key,
          count: items.length,
          resultSeqs: items.map(item => item.resultSeq),
          visibilities: items.map(item => item.visibility),
          requests: items.map(item => item.visibilityRequest),
        })),
    }
  })

  const output = {
    schemaVersion: 1,
    work: 'EF-R4 WP2 evidence lifecycle',
    generatedAt: new Date().toISOString(),
    campaign: CAMPAIGN,
    method: {
      liveBoundary: 'first user message carrying the task prompt; seed folds are marked phase=seed',
      identity: 'resultSeq is the tool/result event seq; fold identity is the compaction/summary shadowedSeqs',
      visibility: 'the first primary request carrying the fold checkpoint; exact toolCallId match means visible',
      equivalence: 'a >=24-char exact substring of the payload in the checkpoint is inferred, never verified',
      unknown: 'missing request, missing payload or missing fold is unknown, not a negative result',
    },
    totals,
    cells,
    repeated,
    limits: [
      'The R3 raw traces are complete for the 18 product-pilot cells; this is one model, one route and one host.',
      'A checkpoint paraphrase without an exact substring is not counted as equivalent evidence.',
      'R3 did not record per-step token snapshots; this graph is about visibility and identity, not cost.',
    ],
  }

  mkdirSync(OUT, { recursive: true })
  const lifecyclePath = join(OUT, 'evidence-lifecycle.json')
  writeFileSync(lifecyclePath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  const relationsPath = join(OUT, 'recall-fold-relations.json')
  writeFileSync(relationsPath, `${JSON.stringify({
    schemaVersion: 1,
    work: 'EF-R4 WP2 recall-to-fold relations',
    generatedAt: output.generatedAt,
    campaign: CAMPAIGN,
    relations: cells.flatMap(cell => cell.relations),
  }, null, 2)}\n`, 'utf8')
  const timelinePath = join(OUT, 'task-delivery-timeline.json')
  writeFileSync(timelinePath, `${JSON.stringify({
    schemaVersion: 1,
    work: 'EF-R4 WP2 task delivery timeline',
    generatedAt: output.generatedAt,
    campaign: CAMPAIGN,
    cells: timelines,
  }, null, 2)}\n`, 'utf8')
  const repeatedPath = join(OUT, 'repeated-evidence-access.json')
  writeFileSync(repeatedPath, `${JSON.stringify({
    schemaVersion: 1,
    work: 'EF-R4 WP2 repeated evidence access',
    generatedAt: output.generatedAt,
    campaign: CAMPAIGN,
    cells: repeated,
    totals: {
      cellsWithRepetition: repeated.filter(cell => cell.repeatedKeys.length > 0).length,
      repeatedKeys: repeated.reduce((sum, cell) => sum + cell.repeatedKeys.length, 0),
    },
  }, null, 2)}\n`, 'utf8')

  process.stdout.write(`evidence-graph: ${cells.length} cells; calls ${totals.recallCalls}; folded ${totals.folded}; refolded ${totals.refolded}; visible ${totals.visible}; marker-only ${totals.markerOnly}; invisible ${totals.invisibleAfterFold}; unknown ${totals.unknown}\n`)
  process.stdout.write(`wrote ${lifecyclePath}, ${relationsPath}, ${timelinePath}, ${repeatedPath}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
