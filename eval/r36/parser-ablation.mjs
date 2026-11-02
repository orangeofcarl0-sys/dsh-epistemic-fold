#!/usr/bin/env node
/**
 * R36-C3: the P1 bounded-envelope recovery ablation.
 *
 * This replays the 16 scoreable R35 writer responses through two parsers:
 *
 *   P0  the production strict parser
 *   P1  a bounded envelope recovery that may wrap a bare array, a bare delta
 *       object, or a complete sequence of objects
 *
 * Every recovered proposal then goes through the REAL `validateDeltas` with the
 * REAL transcript and authority model. P1 is not a production parser and does
 * not commit anything. The report distinguishes:
 *
 *   structurally recovered   the envelope was unambiguous
 *   validator accepted      the recovered delta passed all four checks
 *   projected commit        NOT measured here: no journal/fold was run
 *
 * It never rewrites a fact, kind, status, subjectKey, quote, or evidence list.
 * The two syntax-damaged outputs (H1 r2 and, by construction, any truncated
 * output) are left unrecovered rather than guessed at.
 *
 * @module eval/r36/parser-ablation
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { loadDataset } from '../r33/src/dataset.mjs'
import {
  deltaMatchesFact,
  parseWriterOutput,
  recoverWriterOutput,
} from './writer-protocol.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(HERE, 'evidence', 'r35')
const REPORTS = join(EVIDENCE, 'reports')
const RAW = join(EVIDENCE, 'raw-writer')
const OUT = join(HERE, 'out', 'parser-ablation.json')

const validatorModule = await import('../../lib/semantic/validate.js')
  .catch(() => import('../../src/semantic/validate.ts'))
const { validateDeltas } = validatorModule

function messagesOf(transcript) {
  return transcript.map((entry, index) => {
    if (entry.role === 'user') {
      return createUserMessage({
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'user' },
      })
    }
    if (entry.role === 'assistant') {
      return createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'model', provider: 'r36-replay', model: 'r36-replay' },
      })
    }
    return createToolResultMessage({
      callId: ToolCallId(`r36-replay-${index}`),
      content: [{ type: 'text', text: entry.text }],
      isError: entry.isError === true,
    })
  })
}

function validateProposals(caseData, proposed) {
  return validateDeltas({
    foldedSeqs: caseData.transcript.map((_, index) => index),
    messages: messagesOf(caseData.transcript),
    proposed,
  })
}

function factRecall(caseData, accepted) {
  const matched = caseData.gold.filter(fact =>
    accepted.some(delta => deltaMatchesFact(delta, fact) !== undefined))
  return {
    matched: matched.length,
    gold: caseData.gold.length,
    recall: caseData.gold.length === 0 ? null : matched.length / caseData.gold.length,
    matchedIds: matched.map(fact => fact.factId),
  }
}

function rawFactRecall(caseData, text) {
  if (text === null) return null
  const lower = text.toLowerCase()
  const matched = caseData.gold.filter(fact =>
    lower.includes(fact.quote.toLowerCase()) || lower.includes(fact.visibleNeedle.toLowerCase()))
  return {
    matched: matched.length,
    gold: caseData.gold.length,
    recall: caseData.gold.length === 0 ? null : matched.length / caseData.gold.length,
  }
}

function acceptedByKind(accepted) {
  const counts = {}
  for (const delta of accepted) counts[delta.kind] = (counts[delta.kind] ?? 0) + 1
  return counts
}

function refusedByReason(refused) {
  const counts = {}
  for (const refusal of refused) counts[refusal.reason] = (counts[refusal.reason] ?? 0) + 1
  return counts
}

async function rawTextFor(runId, caseId) {
  try {
    return await readFile(join(RAW, runId, `${caseId}.raw.txt`), 'utf8')
  } catch {
    return null
  }
}

function mean(values) {
  const present = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0) / present.length
}

const { cases, errors } = await loadDataset()
if (errors.length > 0) throw new Error(`dataset errors: ${JSON.stringify(errors)}`)
const caseById = new Map(cases.map(entry => [entry.id, entry]))

const reportFiles = (await readdir(REPORTS)).filter(file => file.endsWith('.json')).sort()
const rows = []
for (const file of reportFiles) {
  const report = JSON.parse(await readFile(join(REPORTS, file), 'utf8'))
  if (report.stage !== 'writer-only') continue
  for (const row of report.rows.filter(entry => entry.arm === 'S' && entry.writer !== undefined && entry.writer !== null)) {
    const caseData = caseById.get(row.caseId)
    if (caseData === undefined) continue
    const raw = (await rawTextFor(report.runId, row.caseId)) ?? row.writer.rawOutput ?? null
    if (raw === null) {
      rows.push({
        runId: report.runId,
        caseId: row.caseId,
        rawAvailable: false,
        p0: null,
        p1: null,
        note: 'raw output was lost with the pre-fix row; P1 cannot replay it',
      })
      continue
    }
    const p0 = parseWriterOutput(raw)
    const p0Proposals = p0.deltaParse === 'parsed' ? p0.proposed : []
    const p0Validation = validateProposals(caseData, p0Proposals)

    const recovery = recoverWriterOutput(raw)
    const p1Proposals = recovery.deltas ?? []
    const p1Validation = validateProposals(caseData, p1Proposals)
    const p1ContentEqual = JSON.stringify(p0Proposals) === JSON.stringify(p1Proposals)

    rows.push({
      runId: report.runId,
      replicateId: row.replicateId,
      caseId: row.caseId,
      rawAvailable: true,
      rawDigest: (await import('node:crypto')).createHash('sha256').update(raw, 'utf8').digest('hex'),
      rawChars: raw.length,
      rawFactRecall: rawFactRecall(caseData, raw),
      p0: {
        protocolStatus: p0.deltaParse,
        proposed: p0Proposals.length,
        validatorAccepted: p0Validation.accepted.length,
        validatorRefused: p0Validation.refused.length,
        acceptedByKind: acceptedByKind(p0Validation.accepted),
        refusedByReason: refusedByReason(p0Validation.refused),
        acceptedFactRecall: factRecall(caseData, p0Validation.accepted),
      },
      p1: {
        status: recovery.status,
        category: recovery.category,
        recovery: recovery.recovery ?? null,
        detail: recovery.detail ?? null,
        proposed: p1Proposals.length,
        validatorAccepted: p1Validation.accepted.length,
        validatorRefused: p1Validation.refused.length,
        acceptedByKind: acceptedByKind(p1Validation.accepted),
        refusedByReason: refusedByReason(p1Validation.refused),
        acceptedFactRecall: factRecall(caseData, p1Validation.accepted),
        contentPreserved: recovery.contentPreserved ?? false,
        equalsP0Proposals: p1ContentEqual,
      },
      actualRun: {
        writerProtocol: row.writer.protocol,
        commitStatus: row.writer.commitStatus,
        accepted: row.writer.accepted,
        refused: row.writer.refused,
        foldValid: row.fold?.valid === true,
      },
      projectedCommit: 'not-measured: P1 did not run the journal/fold transaction',
    })
  }
}

const p0Rows = rows.filter(row => row.p0 !== null)
const p1Recovered = p0Rows.filter(row => row.p1?.status === 'recovered')
const p1Unrecovered = p0Rows.filter(row => row.p1?.status === 'unrecovered')
const p1P0 = p0Rows.filter(row => row.p1?.status === 'parsed-p0')
const summary = {
  scoreableAttempts: p0Rows.length,
  lostAttempts: rows.length - p0Rows.length,
  p0: {
    parsed: p0Rows.filter(row => row.p0.protocolStatus === 'parsed').length,
    proposed: p0Rows.reduce((total, row) => total + row.p0.proposed, 0),
    validatorAccepted: p0Rows.reduce((total, row) => total + row.p0.validatorAccepted, 0),
    validatorRefused: p0Rows.reduce((total, row) => total + row.p0.validatorRefused, 0),
    acceptedFactRecallMean: mean(p0Rows.map(row => row.p0.acceptedFactRecall.recall)),
    categories: p0Rows.reduce((counts, row) => {
      const category = row.p0.protocolStatus
      counts[category] = (counts[category] ?? 0) + 1
      return counts
    }, {}),
  },
  p1: {
    structurallyAvailable: p1P0.length + p1Recovered.length,
    recovered: p1Recovered.length,
    alreadyParsed: p1P0.length,
    unrecovered: p1Unrecovered.length,
    recoveryKinds: p1Recovered.reduce((counts, row) => {
      counts[row.p1.recovery] = (counts[row.p1.recovery] ?? 0) + 1
      return counts
    }, {}),
    proposed: p0Rows.reduce((total, row) => total + row.p1.proposed, 0),
    validatorAccepted: p0Rows.reduce((total, row) => total + row.p1.validatorAccepted, 0),
    validatorRefused: p0Rows.reduce((total, row) => total + row.p1.validatorRefused, 0),
    acceptedFactRecallMean: mean(p0Rows.map(row => row.p1.acceptedFactRecall.recall)),
    contentPreserved: p1Recovered.every(row => row.p1.contentPreserved === true),
    contentChanged: p1Recovered.filter(row => row.p1.contentPreserved !== true).length,
    refusedByReason: p0Rows.reduce((counts, row) => {
      for (const [reason, count] of Object.entries(row.p1.refusedByReason)) {
        counts[reason] = (counts[reason] ?? 0) + count
      }
      return counts
    }, {}),
  },
  deltas: {
    structurallyRecovered: p1Recovered.length,
    validatorAcceptedDelta: p1Recovered.reduce((total, row) => total + row.p1.validatorAccepted, 0),
    validatorRefusedDelta: p1Recovered.reduce((total, row) => total + row.p1.validatorRefused, 0),
    contentChanged: p1Recovered.filter(row => row.p1.contentPreserved !== true).length,
  },
  note: 'P1 is an ablation. It does not commit, and projectedCommit is deliberately not measured. '
    + 'Every recovered delta passed through the real validator; syntax-damaged or truncated output is not repaired.',
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dataset: { id: 'r33-semantic-continuity-v2' },
  rows,
  summary,
}
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`P0: ${summary.p0.parsed}/${summary.scoreableAttempts} parsed, `
  + `${summary.p0.validatorAccepted} accepted, accepted-fact recall ${summary.p0.acceptedFactRecallMean}\n`)
process.stdout.write(`P1: ${summary.p1.structurallyAvailable}/${summary.scoreableAttempts} structurally available `
  + `(${summary.p1.recovered} recovered, ${summary.p1.unrecovered} unrecovered), `
  + `${summary.p1.validatorAccepted} accepted, accepted-fact recall ${summary.p1.acceptedFactRecallMean}\n`)
process.stdout.write(`recovery kinds: ${JSON.stringify(summary.p1.recoveryKinds)}\n`)
process.stdout.write(`content preserved: ${summary.p1.contentPreserved} (changed ${summary.p1.contentChanged})\n`)
process.stdout.write(`p1 refusals: ${JSON.stringify(summary.p1.refusedByReason)}\n`)
process.stdout.write(`${OUT}\n`)
