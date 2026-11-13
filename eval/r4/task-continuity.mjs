#!/usr/bin/env node
/**
 * EF-R4 WP3 — certify task continuity from the R3 product pilot.
 *
 * R3 recorded `activeDelivery` for every primary request, so the exact source
 * question is already answerable without a new model call. This audit adds:
 *
 *   - the event seq of the canonical task source (and stage-B source);
 *   - whether a fold's `shadowedSeqs` contains that source;
 *   - the first request where the source is absent;
 *   - whether the required artifact path is still visible;
 *   - whether the loss happened before the first write.
 *
 * It deliberately does not replay a synthetic surface into the engine. A
 * shadowed range is exact; a guessed reconstruction is not.
 *
 *   node eval/r4/task-continuity.mjs
 *
 * @module eval/r4/task-continuity
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT,
  buildRequestIndex,
  firstRequestWithTool,
  liveStartOf,
  loadCampaign,
  loadCell,
  requiredArtifactsOf,
  sha256,
} from './shared/audit.mjs'

const CAMPAIGN = 'e2e-r3-product-pilot-1'
const OUT = join(ROOT, 'eval', 'r4', 'out')
const ARMS = ['B0', 'E0', 'E1']

function statusAt(delivery, index) {
  const row = delivery?.requests?.find(entry => entry.index === index)
  if (row === undefined) return 'unknown'
  if (row.originalExact === true || row.originalPrefix === true) return 'exact'
  if (row.checkpointMarker === true) return 'marker-only'
  if (row.absent === true) return 'absent'
  return 'unknown'
}

function sourceSeqOf(trajectory, prompt, fromSeq = 0) {
  if (typeof prompt !== 'string' || prompt.length === 0) return null
  const event = trajectory.find(candidate =>
    candidate.type === 'user'
    && candidate.seq >= fromSeq
    && typeof candidate.text === 'string'
    && (candidate.text === prompt || candidate.text.startsWith(prompt.slice(0, 40))))
  return event?.seq ?? null
}

function outcomeOf(report) {
  if (report?.scoring?.taskOutcome !== undefined) return report.scoring.taskOutcome
  if (report?.checker?.pass === true) return 'correct'
  if (report?.termination?.finished === true) return 'incorrect'
  return 'incomplete'
}

function auditLabel({ label, delivery, prompt, trajectory, requestIndex, sourceSeq, folds, surfaceTail }) {
  const requests = requestIndex.requests.map(request => ({
    index: request.index,
    status: statusAt(delivery, request.index),
  }))
  const firstExact = requests.find(row => row.status === 'exact')?.index ?? null
  const lostRows = firstExact === null
    ? []
    : requests.filter(row => row.index > firstExact && row.status === 'absent')
  const firstLost = lostRows.length === 0 ? null : lostRows[0].index
  const shadowedBy = sourceSeq === null
    ? []
    : folds.filter(fold => fold.shadowedSeqs.includes(sourceSeq)).map(fold => fold.compactionId)
  const residentAtEnd = sourceSeq !== null && surfaceTail.includes(sourceSeq)
  return {
    label,
    promptChars: typeof prompt === 'string' ? prompt.length : 0,
    promptSha256: typeof prompt === 'string' ? sha256(prompt) : null,
    sourceSeq,
    firstExactRequest: firstExact,
    firstLostRequest: firstLost,
    lostRequests: lostRows.map(row => row.index),
    shadowedBy,
    residency: sourceSeq === null
      ? 'unknown'
      : residentAtEnd
        ? 'resident-at-end'
        : shadowedBy.length > 0 ? 'absent-by-shadow-range' : 'unknown',
    requests,
  }
}

function buildCell(cell) {
  const report = cell.report
  const task = cell.task
  const trajectory = report?.trajectory ?? []
  const messages = cell.messages ?? []
  const { requests } = buildRequestIndex(messages)
  const liveStart = liveStartOf(trajectory, task)
  const taskPrompt = task?.task ?? ''
  const taskB = task?.taskB
  const taskSeq = sourceSeqOf(trajectory, taskPrompt)
  const taskBSeq = sourceSeqOf(trajectory, taskB, (taskSeq ?? liveStart) + 1)

  const folds = (report?.witnesses ?? []).map(witness => {
    const delivered = requests.find(request =>
      typeof witness.checkpointSha256 === 'string'
      && request.textDigests.has(witness.checkpointSha256))
    return {
      compactionId: witness.compactionId ?? null,
      checkpointId: witness.checkpointId ?? null,
      startSeq: witness.startSeq ?? null,
      phase: (witness.startSeq ?? 0) < (trajectory[liveStart]?.seq ?? 0) ? 'seed' : 'live',
      shadowedSeqs: Array.isArray(witness.shadowedSeqs) ? witness.shadowedSeqs.map(Number) : [],
      deliveredAtRequest: delivered?.index ?? null,
    }
  })
  const surfaceTail = (report?.surfaceTail ?? []).map(node => node.seq)
  const deliveryByLabel = new Map((report?.activeDelivery ?? []).map(entry => [entry.label, entry]))
  const labels = []
  if (deliveryByLabel.has('task')) {
    labels.push(auditLabel({
      label: 'task',
      delivery: deliveryByLabel.get('task'),
      prompt: taskPrompt,
      trajectory,
      requestIndex: { requests },
      sourceSeq: taskSeq,
      folds,
      surfaceTail,
    }))
  }
  if (deliveryByLabel.has('taskB')) {
    labels.push(auditLabel({
      label: 'taskB',
      delivery: deliveryByLabel.get('taskB'),
      prompt: taskB,
      trajectory,
      requestIndex: { requests },
      sourceSeq: taskBSeq,
      folds,
      surfaceTail,
    }))
  }

  const requiredArtifacts = requiredArtifactsOf(task)
  const artifactTimeline = requests.map(request => ({
    index: request.index,
    present: requiredArtifacts.filter(path => request.userText.includes(path)),
    missing: requiredArtifacts.filter(path => !request.userText.includes(path)),
  }))
  const finalLabel = taskB === undefined ? 'task' : 'taskB'
  const finalRow = labels.find(row => row.label === finalLabel) ?? null
  const contractStart = finalRow?.firstExactRequest ?? null
  const firstContractLost = contractStart === null
    ? null
    : artifactTimeline.find(row => row.index >= contractStart && row.missing.length > 0)?.index ?? null
  const writeRequest = firstRequestWithTool(messages, ['write_file', 'edit_file'])

  const taskRow = labels.find(row => row.label === 'task') ?? null
  const taskBLost = labels.find(row => row.label === 'taskB') ?? null
  const lostBeforeWrite = taskRow?.firstLostRequest !== null
    && taskRow?.firstLostRequest !== undefined
    && writeRequest !== null
    && taskRow.firstLostRequest < writeRequest

  return {
    cellId: cell.cellId,
    task: cell.taskId,
    arm: cell.arm,
    taskOutcome: outcomeOf(report),
    termination: report?.termination?.kind ?? null,
    liveStartSeq: trajectory[liveStart]?.seq ?? null,
    labels,
    requiredArtifacts,
    artifactTimeline,
    contractStartRequest: contractStart,
    firstContractLostRequest: firstContractLost,
    firstWriteRequest: writeRequest,
    taskSourceLostBeforeWrite: lostBeforeWrite,
    taskSourceLostWithNoWrite: taskRow !== null
      && taskRow.firstLostRequest !== null
      && writeRequest === null,
    stageB: taskB === undefined
      ? null
      : {
          taskBSeq,
          taskBFirstExactRequest: taskBLost?.firstExactRequest ?? null,
          taskBFirstLostRequest: taskBLost?.firstLostRequest ?? null,
          taskStillVisibleAtEnd: taskRow?.requests?.at(-1)?.status === 'exact',
          bothVisibleRequests: (taskRow?.requests ?? [])
            .filter(row => row.status === 'exact')
            .map(row => row.index)
            .filter(index => statusAt(deliveryByLabel.get('taskB'), index) === 'exact'),
          report: report?.stageB ?? null,
        },
    folds,
  }
}

function main() {
  const campaign = loadCampaign({ campaign: CAMPAIGN })
  const cells = []
  for (const row of campaign.results.results ?? []) {
    if (row.status !== 'executed') continue
    const cell = loadCell({ root: campaign.root, row, tasks: campaign.tasks })
    if (cell.report === null) continue
    cells.push(buildCell(cell))
  }

  const byArm = {}
  for (const arm of ARMS) {
    const subset = cells.filter(cell => cell.arm === arm)
    const taskRows = subset.map(cell => cell.labels.find(row => row.label === 'task')).filter(row => row !== undefined)
    byArm[arm] = {
      cells: subset.length,
      taskSourceLost: taskRows.filter(row => row.firstLostRequest !== null).length,
      taskSourceShadowed: taskRows.filter(row => row.shadowedBy.length > 0).length,
      lostBeforeWrite: subset.filter(cell => cell.taskSourceLostBeforeWrite).length,
      lostWithNoWrite: subset.filter(cell => cell.taskSourceLostWithNoWrite).length,
      contractLost: subset.filter(cell => cell.firstContractLostRequest !== null).length,
      correct: subset.filter(cell => cell.taskOutcome === 'correct').length,
    }
  }

  const stageBCells = cells.filter(cell => cell.stageB !== null)
  const output = {
    schemaVersion: 1,
    work: 'EF-R4 WP3 task continuity',
    generatedAt: new Date().toISOString(),
    campaign: CAMPAIGN,
    method: {
      source: 'the event seq of the first user message carrying the exact task prompt',
      delivery: 'report.activeDelivery exact/prefix/marker/absent per primary request',
      shadow: 'a fold is a source loss only when its shadowedSeqs contains the source seq',
      residency: 'absent-by-shadow-range is exact; resident-at-end requires the source seq in surfaceTail; everything else is unknown',
      artifact: 'each path declared by a task check is searched verbatim in the user/checkpoint bytes; a tool listing does not count',
    },
    byArm,
    stageB: {
      cells: stageBCells.length,
      taskBPresent: stageBCells.filter(cell => cell.stageB.taskBFirstExactRequest !== null).length,
      taskAAbsentAfterB: stageBCells.filter(cell => cell.stageB.taskStillVisibleAtEnd === false).length,
      details: stageBCells.map(cell => ({
        cellId: cell.cellId,
        arm: cell.arm,
        taskBFirstExactRequest: cell.stageB.taskBFirstExactRequest,
        taskBFirstLostRequest: cell.stageB.taskBFirstLostRequest,
        bothVisibleRequests: cell.stageB.bothVisibleRequests,
        taskStillVisibleAtEnd: cell.stageB.taskStillVisibleAtEnd,
      })),
    },
    cells,
    limits: [
      'Only stage-B cells persist a session log; for other cells the exact surface at each fold is not replayed.',
      'Exact prompt absence does not prove that no paraphrase was present; the artifact path and the checkpoint text are reported separately.',
      'No task root was registered and no surface was pinned: this is a read-only audit of the recorded delivery.',
    ],
  }

  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, 'task-continuity.json')
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`task-continuity: ${cells.length} cells; lost ${ARMS.map(arm => `${arm} ${byArm[arm].taskSourceLost}/${byArm[arm].cells}`).join(', ')}; before-write ${cells.filter(cell => cell.taskSourceLostBeforeWrite).length}; contract-lost ${cells.filter(cell => cell.firstContractLostRequest !== null).length}\n`)
  process.stdout.write(`wrote ${path}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('task-continuity.mjs')) main()
