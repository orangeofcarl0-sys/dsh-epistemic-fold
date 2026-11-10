#!/usr/bin/env node
/**
 * EF-R2 WP1 — per-attempt compaction witnesses.
 *
 * ## Why a witness, not a fold count
 *
 * `compaction/end.error === null` is not a commit. An attempt can end without a
 * close marker and still have replaced the surface; it can write a durable
 * bundle and be refused by Basic's shrink check before any summary lands; and a
 * successful fold can leave the final surface later, when a second fold
 * replaces it. The old harness read the LAST resident checkpoint and counted
 * `end.error === null` as a fold, so all four cases were collapsed into one
 * number.
 *
 * This module separates them:
 *
 *   attempt   — a `compaction/start`, regardless of outcome
 *   produced  — a summary and/or a durable bundle exists
 *   committed — a surface replacement landed (replacement event, or a commit
 *               record written after it); `compaction/end` is not the commit
 *   delivered — a later PRIMARY request actually carried the checkpoint body
 *
 * It is deliberately read-only: it never writes a bundle, applies an op, or
 * changes a session. The live builder reads the session log after the cell has
 * finished; the archived builder reads the report, raw requests and the bundle
 * directory. Both produce the same schema.
 *
 * @module eval/e2e/src/witness
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FileBundleStore } from '../../../lib/checkpoint/bundle-store.js'
import { parseCheckpointMarker } from '../../../lib/checkpoint/checkpoint-marker.js'
import { canonicalHash } from '../../../lib/checkpoint/hash.js'

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

/** Normalize whitespace for the legacy prefix metric only. */
const normalize = text => String(text ?? '').replace(/\s+/gu, ' ').trim()

/** Join message content blocks into the text a request/message carries. */
export function textOfContent(content) {
  return (content ?? [])
    .map(block => (block?.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

/** One attempt's error, in the vocabulary the round reasons about. */
export function classifyCompactionError(text) {
  const value = String(text ?? '')
  if (/summary is not smaller than the shadowed content/u.test(value)) {
    const match = /\((\d+) estimated framed tokens >= (\d+)\)/u.exec(value)
    return {
      reason: 'shrink-refusal',
      phase: 'summary-before-commit',
      framedTokens: match === null ? null : Number(match[1]),
      shadowedTokens: match === null ? null : Number(match[2]),
    }
  }
  if (/economic|reclaim_below|ratio_below|MRR /iu.test(value)) {
    return { reason: 'economic-refusal', phase: 'admission' }
  }
  if (/abort|cancel/iu.test(value)) {
    return { reason: 'aborted', phase: 'transaction' }
  }
  if (/provider|http|adapter|LlmError|UNSUPPORTED_CONTENT|finish=/iu.test(value)) {
    return { reason: 'provider-error', phase: 'auxiliary-call' }
  }
  if (/bundle|archive|logical hash|read-back|persist/iu.test(value)) {
    return { reason: 'bundle-error', phase: 'publish' }
  }
  if (/surface changed|selected span|surface does not match/iu.test(value)) {
    return { reason: 'surface-changed', phase: 'stability' }
  }
  if (/PRESSURE_UNRESOLVED|still above threshold/iu.test(value)) {
    return { reason: 'pressure-unresolved', phase: 'pressure' }
  }
  if (/no routed target|no context capacity|resolved model/iu.test(value)) {
    return { reason: 'configuration', phase: 'resolve' }
  }
  return { reason: 'other', phase: 'unknown' }
}

/** Whether the arm is an EF arm (a bundle can exist) or DSH Basic. */
export function isEfArm(arm) {
  return arm !== 'B0'
}

/** Read the session directories under one cell's bundle root. */
function bundleSessions(bundleRoot) {
  if (bundleRoot === null || bundleRoot === undefined || !existsSync(bundleRoot)) return []
  try {
    return readdirSync(bundleRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/** Every bundle and commit record for a session, with verification. */
async function loadBundles(bundleRoot, sessionId) {
  if (bundleRoot === null || bundleRoot === undefined || sessionId === null || sessionId === undefined) return []
  const store = new FileBundleStore(bundleRoot)
  let descriptors = []
  try {
    descriptors = await store.list(sessionId)
  } catch {
    return []
  }
  const out = []
  for (const descriptor of descriptors) {
    const verification = await store.verify(sessionId, descriptor.checkpointId)
    const commit = await store.readCommitRecord(sessionId, descriptor.checkpointId)
    out.push({
      checkpointId: descriptor.checkpointId,
      createdAt: descriptor.createdAt,
      bytes: descriptor.bytes,
      mode: descriptor.mode,
      verification,
      commit,
      bundle: verification.status === 'verified' ? verification.bundle : null,
    })
  }
  return out.sort((left, right) => left.createdAt - right.createdAt)
}

/** Parse the session log into ordered compaction attempts. */
function attemptsFromEvents(events) {
  const attempts = []
  const byId = new Map()
  for (const event of events) {
    const seq = Number(event.seq)
    const time = typeof event.time === 'number' ? event.time : undefined
    if (event.type === 'compaction/start') {
      const row = {
        compactionId: String(event.data.compactionId),
        startSeq: seq,
        startTime: time,
        sourceCommandId: event.data.sourceCommandId === undefined ? null : String(event.data.sourceCommandId),
        summarySeq: undefined,
        summaryTime: undefined,
        replacementSeq: undefined,
        replacementTime: undefined,
        endSeq: undefined,
        endTime: undefined,
        summary: undefined,
        error: null,
        checkpointId: undefined,
        replacementText: undefined,
      }
      byId.set(row.compactionId, row)
      attempts.push(row)
      continue
    }
    if (event.type === 'compaction/summary') {
      const row = byId.get(String(event.data.compactionId))
      if (row === undefined) continue
      const text = textOfContent(event.data.summary)
      const marker = parseCheckpointMarker(text)
      row.summarySeq = seq
      row.summaryTime = time
      row.summary = {
        shadowedRange: event.data.shadowedRange,
        shadowedSeqs: event.data.shadowedSeqs,
        shadowedTokenCount: event.data.shadowedTokenCount,
        provider: event.data.provider,
        model: event.data.model,
        maxTokens: event.data.maxTokens,
        usage: event.data.usage,
        chars: text.length,
      }
      if (marker !== undefined) row.checkpointId = marker.checkpointId
      continue
    }
    if (event.type === 'compaction/end') {
      const row = byId.get(String(event.data.compactionId))
      if (row === undefined) continue
      row.endSeq = seq
      row.endTime = time
      row.error = event.data.error === undefined ? null : String(event.data.error)
      continue
    }
    if (event.type === 'user/message' && event.surfaceOp?.op === 'replace') {
      // `surfaceOp.startSeq` is the SHADOWED SPAN's first seq, not the
      // compaction/start event seq. The replacement identifies its transaction
      // through `sourceEventSeqs = [start.seq, summary.seq, ...shadowedSeqs]`,
      // and the checkpoint source may carry the compactionId directly.
      const sourceSeqs = (event.sourceEventSeqs ?? []).map(Number)
      const sourceCompactionId = (event.data.message ?? event.data)?.source?.compactionId
      const row = (sourceCompactionId === undefined
        ? undefined
        : byId.get(String(sourceCompactionId)))
        ?? attempts.find(candidate => candidate.startSeq === sourceSeqs[0])
      if (row === undefined) continue
      // A user/message stores the UserMessage DIRECTLY as `data`; assistant
      // and tool results nest theirs under `message`.
      const message = event.data.message ?? event.data
      const text = textOfContent(message?.content)
      const marker = parseCheckpointMarker(text)
      row.replacementSeq = seq
      row.replacementTime = time
      row.replacementText = text
      if (marker !== undefined) row.checkpointId = marker.checkpointId
      row.replacementSources = sourceSeqs
    }
  }
  return attempts
}

/** Parse the report's compaction rows when the log is not available. */
function attemptsFromReport(report) {
  return (report.compactions ?? []).map((row, index) => ({
    compactionId: String(row.id),
    attemptIndex: index,
    startSeq: Number(row.startSeq),
    startTime: undefined,
    sourceCommandId: null,
    summarySeq: undefined,
    summaryTime: undefined,
    replacementSeq: undefined,
    replacementTime: undefined,
    endSeq: row.endSeq === null ? undefined : Number(row.endSeq),
    endTime: undefined,
    summary: undefined,
    error: row.error === null ? null : String(row.error),
    checkpointId: undefined,
    replacementText: undefined,
  }))
}

/** The auxiliary request that belongs to one attempt. */
function auxiliaryFor(attempt, auxiliary, attemptOrdinal, attemptsWithAux) {
  if (auxiliary.length === 0) return undefined
  // Live: the call's timestamp falls between start and summary/end.
  if (attempt.startTime !== undefined) {
    const after = auxiliary.filter(entry => typeof entry.at === 'string'
      && Date.parse(entry.at) >= attempt.startTime)
    const before = after.find(entry => {
      const time = Date.parse(entry.at)
      const bound = attempt.summaryTime ?? attempt.endTime ?? attempt.replacementTime
      return bound === undefined || time <= bound
    })
    if (before !== undefined) return before
    if (after.length > 0) return after[0]
  }
  // Archived: one auxiliary call per attempt in order, when the counts agree.
  if (attemptsWithAux === auxiliary.length) return auxiliary[attemptOrdinal]
  return undefined
}

/** Delivery of one checkpoint body through the primary requests after commit. */
function deliveryFor({
  attempt,
  primary,
  fullMessages,
  checkpointText,
  checkpointSha,
  checkpointShaConcatenated,
  auxiliary,
  committed,
}) {
  // A body that never replaced the surface was never delivered, even when its
  // orphan bundle is verifiable.
  if (committed !== true) return null
  if (checkpointText === undefined || checkpointText === '') return null
  const marker = `[EF1`
  let after
  let basis
  if (attempt.commitTime !== undefined) {
    after = primary.filter(request => typeof request.at === 'string'
      && Date.parse(request.at) >= attempt.commitTime)
    basis = 'commit-time'
  } else if (auxiliary !== undefined) {
    // Archived Basic: no commit record, so the first primary request after the
    // summary call is the first one that could have seen the replacement.
    after = primary.filter(request => Number(request.index) > Number(auxiliary.index))
    basis = 'aux-call-index'
  } else {
    return {
      firstPrimaryRequestAfterCommit: null,
      checkpointDelivered: false,
      requests: [],
      basis: 'unknown-commit-time',
      note: 'no commit time and no auxiliary call; delivery cannot be placed',
    }
  }
  if (after.length === 0) {
    return {
      firstPrimaryRequestAfterCommit: null,
      checkpointDelivered: false,
      requests: [],
      basis,
      note: 'no primary request follows the commit',
    }
  }
  const fullByIndex = new Map((fullMessages ?? []).map(entry => [Number(entry.index), entry]))
  const requests = after.map(request => {
    const index = Number(request.index)
    const full = fullByIndex.get(index)
    const messages = full?.messages ?? request.messages ?? []
    const texts = messages.map(message => textOfContent(message.content))
    const digests = messages.map(message => message.digest ?? sha256(textOfContent(message.content)))
    const exact = (checkpointSha !== undefined && digests.includes(checkpointSha))
      || (checkpointShaConcatenated !== undefined && digests.includes(checkpointShaConcatenated))
    const markerVisible = texts.some(text => text.includes(marker))
    return { index, exact, marker: markerVisible, absent: !exact && !markerVisible }
  })
  return {
    firstPrimaryRequestAfterCommit: requests[0]?.index ?? null,
    checkpointDelivered: requests.some(entry => entry.exact),
    requests,
    basis: fullMessages === undefined || fullMessages.length === 0 ? `${basis}/digests` : `${basis}/full-messages`,
  }
}

/** Delivery of the active task prompt through every primary request. */
export function buildTaskDelivery({ primary, fullMessages, taskPrompt }) {
  const needle = normalize(taskPrompt).slice(0, 60)
  const taskSha = taskPrompt === undefined ? undefined : sha256(taskPrompt)
  const fullByIndex = new Map((fullMessages ?? []).map(entry => [Number(entry.index), entry]))
  const requests = primary.map(request => {
    const index = Number(request.index)
    const full = fullByIndex.get(index)
    const messages = full?.messages ?? request.messages ?? []
    const texts = messages.map(message => textOfContent(message.content))
    const digests = messages.map(message => message.digest ?? sha256(textOfContent(message.content)))
    return {
      index,
      originalExact: taskSha !== undefined && digests.includes(taskSha),
      originalPrefix: needle.length > 0 && texts.some(text => normalize(text).includes(needle)),
      checkpointMarker: texts.some(text => text.includes('[EF1')),
      absent: !(taskSha !== undefined && digests.includes(taskSha))
        && !texts.some(text => normalize(text).includes(needle)),
    }
  })
  return {
    taskPromptChars: taskPrompt?.length ?? 0,
    taskPromptSha256: taskSha ?? null,
    requests,
  }
}

/**
 * Assemble the shared witness schema from parsed attempts plus bundle facts.
 *
 * @param {object} options
 * @param {object[]} options.attempts
 * @param {object[]} options.bundles
 * @param {object[]} options.requests - report.requests / raw requests
 * @param {object[]} [options.fullMessages]
 * @param {string} [options.taskPrompt]
 * @param {string} options.arm
 * @param {string} options.sessionId
 * @param {'live'|'archived'} options.basis
 * @returns {object[]}
 */
export function assembleWitnesses({
  attempts,
  bundles,
  requests,
  fullMessages,
  taskPrompt,
  arm,
  sessionId,
  basis,
}) {
  const primary = requests
    .filter(request => request.purpose === 'primary')
    .sort((left, right) => Number(left.index) - Number(right.index))
  const auxiliary = requests
    .filter(request => request.purpose !== 'primary')
    .sort((left, right) => Number(left.index) - Number(right.index))
  // An archived committed attempt has neither an error nor a summary event in
  // the report, but it did make the auxiliary call. `endSeq` is the report's
  // evidence that the transaction closed; count it for the order link.
  const attemptsWithAux = attempts.filter(attempt =>
    attempt.error !== null || attempt.summarySeq !== undefined || attempt.endSeq !== undefined).length

  // Commit records identify the attempt they belong to; that link is exact.
  const commitByCompaction = new Map()
  const commitByStart = new Map()
  for (const bundle of bundles) {
    if (bundle.commit === null) continue
    commitByCompaction.set(String(bundle.commit.compactionId), bundle)
    commitByStart.set(Number(bundle.commit.startSeq), bundle)
  }
  const used = new Set()
  const linked = attempts.map(attempt => {
    const bundle = commitByCompaction.get(attempt.compactionId)
      ?? commitByStart.get(attempt.startSeq)
    if (bundle !== undefined) used.add(bundle.checkpointId)
    return { attempt, bundle, link: bundle === undefined ? 'none' : 'commit-record' }
  })

  // A bundle without a commit record is a PRODUCED body that never committed.
  // The archived link is by order; the live log already has the attempt's own
  // checkpoint id, so no guessing is needed there.
  const orphans = bundles.filter(bundle => !used.has(bundle.checkpointId)
    && bundle.commit === null)
  const needBundle = linked.filter(entry => entry.bundle === undefined
    && (entry.attempt.summarySeq !== undefined || entry.attempt.error !== null))
  for (let index = 0; index < needBundle.length && index < orphans.length; index += 1) {
    needBundle[index].bundle = orphans[index]
    needBundle[index].link = 'inferred-order'
  }

  return linked.map(({ attempt, bundle, link }, ordinal) => {
    const aux = auxiliaryFor(attempt, auxiliary, ordinal, attemptsWithAux)
    const checkpointText = attempt.replacementText ?? bundle?.bundle?.rendered?.text
    const checkpointSha = checkpointText === undefined ? undefined : sha256(checkpointText)
    const checkpointDigest = checkpointText === undefined
      ? undefined
      : (bundle?.bundle?.rendered?.digest ?? canonicalHash(checkpointText))
    const commit = bundle?.commit ?? null
    // A closed attempt with no error is the report's evidence that the
    // transaction completed. It is weaker than a commit record, so it yields
    // `committed` + `inferred`, never `verified`.
    const reportCommitted = attempt.error === null && attempt.endSeq !== undefined
    const committed = attempt.replacementSeq !== undefined || commit !== null || reportCommitted
    const error = attempt.error === null ? null : classifyCompactionError(attempt.error)
    const mode = commit?.mode ?? bundle?.mode ?? (arm === 'B0' ? 'basic' : 'unknown')
    const commitTime = commit?.committedAt
      ?? (attempt.replacementTime === undefined ? undefined : attempt.replacementTime)
    const withCommitTime = { ...attempt, commitTime }
    const delivery = deliveryFor({
      attempt: withCommitTime,
      primary,
      fullMessages,
      checkpointText,
      checkpointSha,
      auxiliary: aux,
      committed,
    })
    const summaryTokens = attempt.summary?.shadowedTokenCount
      ?? error?.shadowedTokens
      ?? (bundle?.bundle?.archive?.shadowedMessages === undefined
        ? undefined
        : Math.round(bundle.bundle.archive.shadowedMessages
          .reduce((sum, message) => sum + textOfContent(message.content).length, 0) / 4))
    const rationaleLanded = bundle?.bundle?.semantic?.text !== undefined
      && String(bundle.bundle.semantic.text).trim().length > 0
    const rationaleAttempted = aux !== undefined
    const status = committed
      ? 'committed'
      : error === null && attempt.summarySeq === undefined && attempt.error === null
        ? 'unverifiable'
        : error === null
          ? 'aborted'
          : error.reason === 'shrink-refusal' || error.reason === 'economic-refusal'
            ? 'refused'
            : 'aborted'
    // A verified bundle is not a verified ATTEMPT when the only link is
    // order. The archive's own bytes are verified (`archive.fileStatus`), but
    // "this bundle came from this attempt" needs the commit record or the
    // live summary's checkpoint id. Anything less is inferred.
    const exactBundleLink = link === 'commit-record'
      || (attempt.checkpointId !== undefined
        && bundle?.checkpointId === attempt.checkpointId)
    const evidenceLevel = committed
      ? (bundle?.verification?.status === 'verified'
        && (commit !== null || (basis === 'live' && exactBundleLink))
        ? 'verified'
        : 'inferred')
      : bundle?.verification?.status === 'verified' && exactBundleLink
        ? 'verified'
        : bundle !== undefined || attempt.error !== null
          ? 'inferred'
          : 'unverifiable'
    return {
      schemaVersion: 1,
      basis,
      sessionId,
      arm,
      compactionId: attempt.compactionId,
      mode,
      trigger: attempt.sourceCommandId === null ? 'pressure-or-unknown' : 'manual',
      startSeq: attempt.startSeq,
      ...(attempt.summarySeq === undefined ? {} : { summarySeq: attempt.summarySeq }),
      ...(attempt.replacementSeq === undefined ? {} : { replacementSeq: attempt.replacementSeq }),
      ...(attempt.endSeq === undefined ? {} : { endSeq: attempt.endSeq }),
      status,
      evidenceLevel,
      reason: committed
        ? (attempt.endSeq === undefined ? 'unclosed' : 'committed')
        : error?.reason ?? (attempt.summarySeq === undefined ? 'no-summary' : 'no-replacement'),
      ...(error === null ? {} : {
        phase: error.phase,
        ...(error.framedTokens === undefined ? {} : { framedTokens: error.framedTokens }),
        ...(error.shadowedTokens === undefined ? {} : { shadowedTokens: error.shadowedTokens }),
      }),
      ...(attempt.error === null ? {} : { errorText: attempt.error }),
      ...(attempt.checkpointId === undefined && bundle?.checkpointId === undefined
        ? {}
        : { checkpointId: attempt.checkpointId ?? bundle.checkpointId }),
      ...(checkpointText === undefined ? {} : {
        checkpointChars: checkpointText.length,
        checkpointDigest,
        checkpointSha256: checkpointSha,
      }),
      ...(attempt.summary?.shadowedSeqs === undefined ? {} : { shadowedSeqs: attempt.summary.shadowedSeqs }),
      ...(summaryTokens === undefined ? {} : { shadowedTokens: summaryTokens, spanTokens: summaryTokens }),
      archive: {
        bundlePresent: bundle !== undefined,
        link,
        ...(bundle === undefined ? {} : {
          checkpointId: bundle.checkpointId,
          bytes: bundle.bytes,
          fileStatus: bundle.verification?.status ?? 'unknown',
          ...(bundle.verification?.reason === undefined ? {} : { reason: bundle.verification.reason }),
          ...(bundle.bundle?.archive?.logicalHash === undefined
            ? {}
            : { logicalHash: bundle.bundle.archive.logicalHash }),
          ...(bundle.bundle?.archive?.messageCount === undefined
            ? {}
            : { messageCount: bundle.bundle.archive.messageCount }),
          ...(commit === null ? {} : { commitRecord: true }),
        }),
      },
      surfaceReplacementVerified: committed
        && (basis === 'live' || commit !== null),
      rationale: {
        attempted: rationaleAttempted,
        link: aux === undefined
          ? 'none'
          : (attempt.startTime === undefined ? 'order' : 'time'),
        ...(aux === undefined ? {} : {
          purpose: aux.purpose,
          callIndex: aux.index,
          maxTokens: aux.maxTokens,
          finish: aux.finish,
          ...(aux.usage === null || aux.usage === undefined ? {} : {
            inputTokens: aux.usage.inputTokens ?? null,
            outputTokens: aux.usage.outputTokens ?? null,
          }),
        }),
        landed: rationaleLanded,
        ...(bundle?.bundle?.semantic?.text === undefined
          ? {}
          : { outputChars: String(bundle.bundle.semantic.text).length }),
      },
      delivery,
      cost: aux?.usage === null || aux?.usage === undefined
        ? null
        : {
          inputTokens: aux.usage.inputTokens ?? null,
          outputTokens: aux.usage.outputTokens ?? null,
        },
    }
  })
}

/** Live: build witnesses from the session log plus the bundle store. */
export async function buildWitnessesFromEvents({
  sessionId,
  events,
  bundleRoot,
  requests,
  fullMessages,
  taskPrompt,
  arm,
}) {
  const attempts = attemptsFromEvents(events)
  const bundles = await loadBundles(bundleRoot, sessionId)
  return {
    witnesses: assembleWitnesses({
      attempts,
      bundles,
      requests,
      fullMessages,
      taskPrompt,
      arm,
      sessionId,
      basis: 'live',
    }),
    taskDelivery: buildTaskDelivery({
      primary: requests.filter(request => request.purpose === 'primary'),
      fullMessages,
      taskPrompt,
    }),
    bundleCount: bundles.length,
    commitCount: bundles.filter(bundle => bundle.commit !== null).length,
  }
}

/**
 * Archived: rebuild witnesses from one cell's report + raw files + bundles.
 *
 * The report carries attempts and errors; the bundle directory carries the
 * bodies and commit records. A Basic cell has no bundle, so its committed
 * attempts are `inferred` from the report and checkpoint, never `verified`.
 */
export async function buildWitnessesFromRun({
  report,
  requests,
  fullMessages,
  bundleRoot,
  sessionId,
  taskPrompt,
  arm,
}) {
  const attempts = attemptsFromReport(report)
  let resolvedSession = sessionId
  if (resolvedSession === undefined || resolvedSession === null) {
    const sessions = bundleSessions(bundleRoot)
    resolvedSession = sessions.length === 1 ? sessions[0] : undefined
  }
  const bundles = await loadBundles(bundleRoot, resolvedSession)
  // Basic has no EF bundle and no commit record. The report's single
  // `checkpoint` is the LAST resident body, not each attempt's body, so
  // attaching it to every committed row would invent delivery evidence for
  // earlier folds. Basic archived attempts stay `committed`/`inferred` with
  // delivery `null`; only a live Basic log can prove per-attempt delivery.
  return {
    witnesses: assembleWitnesses({
      attempts,
      bundles,
      requests,
      fullMessages,
      taskPrompt,
      arm,
      sessionId: resolvedSession ?? null,
      basis: 'archived',
    }),
    taskDelivery: buildTaskDelivery({
      primary: requests.filter(request => request.purpose === 'primary'),
      fullMessages,
      taskPrompt,
    }),
    bundleCount: bundles.length,
    commitCount: bundles.filter(bundle => bundle.commit !== null).length,
  }
}

/** Roll the per-attempt witnesses into the counts a report can quote. */
export function summarizeWitnesses(witnesses) {
  return {
    attempts: witnesses.length,
    committed: witnesses.filter(witness => witness.status === 'committed').length,
    refused: witnesses.filter(witness => witness.status === 'refused').length,
    aborted: witnesses.filter(witness => witness.status === 'aborted').length,
    unverifiable: witnesses.filter(witness => witness.status === 'unverifiable').length,
    verified: witnesses.filter(witness => witness.evidenceLevel === 'verified').length,
    inferred: witnesses.filter(witness => witness.evidenceLevel === 'inferred').length,
    unverified: witnesses.filter(witness => witness.evidenceLevel === 'unverifiable').length,
    committedAndDelivered: witnesses.filter(witness =>
      witness.status === 'committed' && witness.delivery?.checkpointDelivered === true).length,
    committedNotDelivered: witnesses.filter(witness =>
      witness.status === 'committed' && witness.delivery?.checkpointDelivered === false).length,
    committedDeliveryUnverifiable: witnesses.filter(witness =>
      witness.status === 'committed' && witness.delivery === null).length,
    noFollowingRequest: witnesses.filter(witness =>
      witness.status === 'committed'
      && witness.delivery !== null
      && witness.delivery?.firstPrimaryRequestAfterCommit === null).length,
    byReason: witnesses.reduce((counts, witness) => {
      counts[witness.reason] = (counts[witness.reason] ?? 0) + 1
      return counts
    }, {}),
  }
}
