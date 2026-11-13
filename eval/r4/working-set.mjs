#!/usr/bin/env node
/**
 * EF-R4 WP4 — quantify the working-set dynamics that R3 only described.
 *
 * The input is the two R4 artifacts above (`evidence-lifecycle.json` and
 * `task-continuity.json`). This script adds the projection side: how many OPEN
 * failures a checkpoint carries, whether they are duplicates, how much of the
 * checkpoint they occupy, and a character-level context balance.
 *
 * Character counts are not provider tokens. The R4 report says so; a future run
 * with `report.contextTrace` can use one TokenMeter snapshot per request.
 *
 *   node eval/r4/working-set.mjs
 *
 * @module eval/r4/working-set
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT,
  loadCampaign,
  loadCell,
  pairToolCalls,
  toolCallInfoIndex,
  toolMessageTextIndex,
} from './shared/audit.mjs'
import { progressAfter } from './evidence-graph.mjs'

const CAMPAIGN = 'e2e-r3-product-pilot-1'
const OUT = join(ROOT, 'eval', 'r4', 'out')
const ARMS = ['B0', 'E0', 'E1']
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export function sectionOf(text, header) {
  if (typeof text !== 'string') return ''
  const blocks = text.split(/\n\s*\n/u)
  return blocks.find(block => block.trimStart().split(/\r?\n/u)[0]?.trim() === header) ?? ''
}

export function failureRows(checkpointText) {
  const open = sectionOf(checkpointText, 'Open')
  const rows = []
  for (const line of open.split(/\r?\n/u)) {
    const match = line.match(/^- \[failure\] (failure:[\w:.-]+) \(([^)]+)\): (.*)$/u)
    if (match === null) continue
    let callId = match[1].replace(/^failure:/u, '')
    try {
      const value = JSON.parse(match[3])
      if (typeof value.callId === 'string' && value.callId.length > 0) callId = value.callId
    } catch {
      // The rendered value may be prose; the id remains the fallback.
    }
    rows.push({ id: match[1], state: match[2], value: match[3], callId })
  }
  return { open, rows }
}

export function pathOf(argsText) {
  if (typeof argsText !== 'string' || argsText.length === 0) return null
  try {
    const args = JSON.parse(argsText)
    for (const key of ['path', 'file', 'query', 'ref']) {
      if (typeof args[key] === 'string') return args[key]
    }
    return null
  } catch {
    return null
  }
}

export function errorClassOf(text) {
  if (typeof text !== 'string' || text.length === 0) return 'unknown'
  const patterns = ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNRESET', 'timeout', 'no such file', 'not found']
  for (const pattern of patterns) {
    if (text.toLowerCase().includes(pattern.toLowerCase())) return pattern
  }
  return 'tool-error'
}

function charIndex(trajectory) {
  const chars = new Map()
  for (const event of trajectory) {
    if (typeof event.chars === 'number') chars.set(event.seq, event.chars)
  }
  return chars
}

function buildCell(cell, lifecycleCell, continuityCell) {
  const report = cell.report
  const messages = cell.messages ?? []
  const trajectory = report?.trajectory ?? []
  const checkpointText = report?.checkpoint?.text ?? ''
  const { open, rows } = failureRows(checkpointText)
  const callInfo = toolCallInfoIndex(messages)
  const toolText = toolMessageTextIndex(messages)
  const signatures = new Set()
  const failures = rows.map(row => {
    const info = callInfo.get(row.callId)
    const path = pathOf(info?.argsText ?? '')
    const errorClass = errorClassOf(toolText.get(row.callId) ?? '')
    const signature = `${info?.name ?? 'unknown'}:${path ?? 'unknown'}:${errorClass}`
    signatures.add(signature)
    return {
      id: row.id,
      callId: row.callId,
      state: row.state,
      tool: info?.name ?? null,
      path,
      errorClass,
      signature,
    }
  })
  const duplicateSignatures = failures.length - signatures.size

  const witnesses = report?.witnesses ?? []
  const chars = charIndex(trajectory)
  const shadowedSeqs = new Set()
  for (const witness of witnesses) {
    for (const seq of witness.shadowedSeqs ?? []) shadowedSeqs.add(Number(seq))
  }
  let reclaimedChars = 0
  for (const seq of shadowedSeqs) reclaimedChars += chars.get(seq) ?? 0

  const calls = pairToolCalls(trajectory)
  const recallCalls = calls.filter(call => call.name === 'context_recall' || call.name === 'context_search')
  const recallChars = recallCalls.reduce((sum, call) =>
    sum + (call.callId === null ? call.resultPreview.length : (toolText.get(call.callId)?.length ?? call.resultPreview.length)), 0)
  const toolChars = [...toolText.values()].reduce((sum, text) => sum + text.length, 0)
  const checkpointCharsAdded = witnesses.reduce((sum, witness) => sum + (witness.checkpointChars ?? 0), 0)
  const netChars = recallChars + toolChars + checkpointCharsAdded - reclaimedChars

  const progress = recallCalls.reduce((counts, call) => {
    const kind = progressAfter(trajectory, call.resultSeq)
    counts[kind] = (counts[kind] ?? 0) + 1
    return counts
  }, {})

  const evidence = lifecycleCell ?? { summary: {}, evidence: [] }
  const continuity = continuityCell ?? { labels: [], artifactTimeline: [] }
  const taskRow = continuity.labels?.find(row => row.label === 'task') ?? null
  const repeatedRecallCount = evidence.summary?.repeated ?? 0
  const uniqueEvidenceRecovered = new Set((evidence.evidence ?? []).map(item => item.key)).size
  const recallResultReFoldCount = evidence.summary?.refolded ?? 0
  const taskInstructionLostCount = taskRow?.lostRequests?.length ?? 0
  const deliveryContractLostCount = continuity.firstContractLostRequest === null
    || continuity.firstContractLostRequest === undefined
    ? 0
    : (continuity.artifactTimeline ?? [])
        .filter(row => continuity.contractStartRequest !== null && row.index >= continuity.contractStartRequest && row.missing.length > 0)
        .length

  return {
    cellId: cell.cellId,
    task: cell.taskId,
    arm: cell.arm,
    taskOutcome: report?.scoring?.taskOutcome
      ?? (report?.checker?.pass === true ? 'correct' : report?.termination?.finished === true ? 'incorrect' : 'incomplete'),
    recall: {
      calls: recallCalls.length,
      evidenceInstances: evidence.summary?.evidenceInstances ?? 0,
      repeatedRecallCount,
      uniqueEvidenceRecovered,
      recallResultReFoldCount,
      markerOnly: evidence.summary?.markerOnly ?? 0,
      visible: evidence.summary?.visible ?? 0,
      invisibleAfterFold: evidence.summary?.invisibleAfterFold ?? 0,
    },
    continuity: {
      instructionLostRequests: taskInstructionLostCount,
      firstLostRequest: taskRow?.firstLostRequest ?? null,
      deliveryContractLostRequests: deliveryContractLostCount,
      firstContractLostRequest: continuity.firstContractLostRequest ?? null,
      lostWithNoWrite: continuity.taskSourceLostWithNoWrite === true,
    },
    failureProjection: {
      openFailureCount: failures.length,
      uniqueSignatures: signatures.size,
      duplicateSignatures,
      projectionChars: open.length,
      checkpointChars: checkpointText.length,
      share: checkpointText.length === 0 ? null : open.length / checkpointText.length,
      failures,
    },
    context: {
      unit: 'chars',
      recallResultChars: recallChars,
      toolResultChars: toolChars,
      checkpointCharsAdded,
      reclaimedChars,
      netChars,
      note: 'character-level approximation for R3; use report.contextTrace token snapshots for a future live run',
    },
    compress: {
      grossShadowedTokens: witnesses.reduce((sum, witness) => sum + (witness.spanTokens ?? 0), 0),
      probeReclaimTokens: report?.leafSpanProbe?.actual?.reclaimTokens ?? null,
      probeCheckpointTokens: report?.leafSpanProbe?.actual?.checkpointTokens ?? null,
    },
    progressBeforeNextFold: progress,
  }
}

function main() {
  const lifecyclePath = join(OUT, 'evidence-lifecycle.json')
  const continuityPath = join(OUT, 'task-continuity.json')
  for (const path of [lifecyclePath, continuityPath]) {
    if (!existsSync(path)) {
      process.stderr.write(`working-set: ${path} is missing; run evidence-graph and task-continuity first\n`)
      process.exit(2)
    }
  }
  const lifecycle = readJson(lifecyclePath)
  const continuity = readJson(continuityPath)
  const lifecycleByCell = new Map(lifecycle.cells.map(cell => [cell.cellId, cell]))
  const continuityByCell = new Map(continuity.cells.map(cell => [cell.cellId, cell]))

  const campaign = loadCampaign({ campaign: CAMPAIGN })
  const cells = []
  for (const row of campaign.results.results ?? []) {
    if (row.status !== 'executed') continue
    const cell = loadCell({ root: campaign.root, row, tasks: campaign.tasks })
    if (cell.report === null) continue
    cells.push(buildCell(cell, lifecycleByCell.get(cell.cellId), continuityByCell.get(cell.cellId)))
  }

  const byArm = {}
  for (const arm of ARMS) {
    const subset = cells.filter(cell => cell.arm === arm)
    byArm[arm] = {
      cells: subset.length,
      correct: subset.filter(cell => cell.taskOutcome === 'correct').length,
      repeatedRecallCount: subset.reduce((total, cell) => total + cell.recall.repeatedRecallCount, 0),
      recallResultReFoldCount: subset.reduce((total, cell) => total + cell.recall.recallResultReFoldCount, 0),
      taskInstructionLostRequests: subset.reduce((total, cell) => total + cell.continuity.instructionLostRequests, 0),
      deliveryContractLostRequests: subset.reduce((total, cell) => total + cell.continuity.deliveryContractLostRequests, 0),
      openFailureCount: subset.reduce((total, cell) => total + cell.failureProjection.openFailureCount, 0),
      duplicateFailureSignatures: subset.reduce((total, cell) => total + cell.failureProjection.duplicateSignatures, 0),
      projectionChars: subset.reduce((total, cell) => total + cell.failureProjection.projectionChars, 0),
      netChars: subset.reduce((total, cell) => total + cell.context.netChars, 0),
    }
  }

  const totals = {
    cells: cells.length,
    repeatedRecallCount: cells.reduce((sum, cell) => sum + cell.recall.repeatedRecallCount, 0),
    recallResultReFoldCount: cells.reduce((sum, cell) => sum + cell.recall.recallResultReFoldCount, 0),
    taskInstructionLostRequests: cells.reduce((sum, cell) => sum + cell.continuity.instructionLostRequests, 0),
    deliveryContractLostRequests: cells.reduce((sum, cell) => sum + cell.continuity.deliveryContractLostRequests, 0),
    openFailureCount: cells.reduce((sum, cell) => sum + cell.failureProjection.openFailureCount, 0),
    duplicateFailureSignatures: cells.reduce((sum, cell) => sum + cell.failureProjection.duplicateSignatures, 0),
    cellsWithDuplicateFailures: cells.filter(cell => cell.failureProjection.duplicateSignatures > 0).length,
    cellsWithOpenFailures: cells.filter(cell => cell.failureProjection.openFailureCount > 0).length,
  }

  const output = {
    schemaVersion: 1,
    work: 'EF-R4 WP4 working-set dynamics',
    generatedAt: new Date().toISOString(),
    campaign: CAMPAIGN,
    method: {
      recall: 'from evidence-lifecycle.json; repeated keys and shadowed payloads',
      task: 'from task-continuity.json; exact-source loss and delivery-contract loss',
      failure: 'Open section of the final checkpoint, joined to tool call and result text by callId',
      context: 'character counts; provider tokens are reported only where the probe recorded them',
      progress: 'tool calls between a recall result and the next compaction/start',
    },
    totals,
    byArm,
    cells,
    limits: [
      'The final checkpoint is the only checkpoint text stored verbatim in the report; earlier folds are represented by their digests.',
      'A failure signature is inferred from the tool name, the argument path and the error class; an unjoinable anchor is unknown.',
      'Chars are not provider tokens; the R3 traces have no per-step TokenMeter snapshot.',
      'No failure was retired and no projection was changed: this is measurement only.',
    ],
  }

  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, 'working-set.json')
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`working-set: ${cells.length} cells; re-fold ${totals.recallResultReFoldCount}; repeated ${totals.repeatedRecallCount}; task-lost ${totals.taskInstructionLostRequests}; open failures ${totals.openFailureCount}; duplicate ${totals.duplicateFailureSignatures}\n`)
  process.stdout.write(`wrote ${path}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('working-set.mjs')) main()
