#!/usr/bin/env node
/**
 * Semantic analysis of a live writer run.
 *
 * The production scorer is exact-statement/coordinate based, so a paraphrasing
 * writer scores 0 even when it captured the fact. That is deliberate for the
 * scorer, but it is not the right instrument for comparing W0 and W1. This
 * script applies the same documented semantic matcher used by the R35 funnel:
 * kind-family plus evidence quote, visible needle, subject, or sufficiently
 * shared statement vocabulary. It is an analysis layer, not the benchmark
 * scorer.
 *
 *   node eval/r36/analyze-live.mjs r36-writer-w0-r1 r36-writer-w1-r1
 *
 * @module eval/r36/analyze-live
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDataset } from '../r33/src/dataset.mjs'
import {
  classifyWriterFailure,
  deltaMatchesFact,
  normalize,
  parseWriterOutput,
  tokens,
} from './writer-protocol.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNS = join(HERE, 'runs')
const OUT = join(HERE, 'out', 'live-writer-analysis.json')

const runIds = process.argv.slice(2)
if (runIds.length === 0) {
  process.stderr.write('usage: node eval/r36/analyze-live.mjs <runId> [<runId> ...]\n')
  process.exit(2)
}

const { cases, errors } = await loadDataset()
if (errors.length > 0) throw new Error(`dataset errors: ${JSON.stringify(errors)}`)
const caseById = new Map(cases.map(entry => [entry.id, entry]))

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

function mean(values) {
  const present = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0) / present.length
}

function textSimilar(left, right) {
  const a = tokens(left)
  const b = tokens(right)
  if (a.size === 0 || b.size === 0) return false
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  if (shared < 2) return false
  const leftContain = shared / a.size
  let bShared = 0
  for (const token of b) if (a.has(token)) bShared += 1
  const rightContain = bShared / b.size
  return normalize(left) === normalize(right) || leftContain >= 0.45 || rightContain >= 0.45
}

function rawMention(text, fact) {
  if (text === null) return null
  const lower = text.toLowerCase()
  return lower.includes(fact.quote.toLowerCase()) || lower.includes(fact.visibleNeedle.toLowerCase())
}

function factLevels(caseData, row, raw, parsed) {
  const proposed = parsed?.deltaParse === 'parsed' ? parsed.proposed : []
  const accepted = Array.isArray(row.writer.acceptedDeltas) ? row.writer.acceptedDeltas : []
  const anchors = Array.isArray(row.state?.anchors) ? row.state.anchors : []
  const checkpoint = row.checkpoint?.text ?? ''
  return caseData.gold.map(fact => {
    const proposalMatch = proposed.map(delta => deltaMatchesFact(delta, fact)).find(Boolean)
    const acceptedMatch = accepted.map(delta => deltaMatchesFact(delta, fact)).find(Boolean)
    const visible = checkpoint.includes(fact.visibleNeedle)
      || anchors.some(anchor => anchor.includes(fact.visibleNeedle))
      || accepted.some(delta => deltaMatchesFact(delta, fact) !== undefined
        && (checkpoint.includes(delta.statement) || anchors.some(anchor => anchor.includes(delta.statement))))
    return {
      factId: fact.factId,
      current: fact.current === true,
      raw: rawMention(raw, fact),
      proposed: proposalMatch !== undefined,
      proposedBasis: proposalMatch ?? null,
      accepted: acceptedMatch !== undefined,
      acceptedBasis: acceptedMatch ?? null,
      committed: row.writer.commitStatus === 'committed' && acceptedMatch !== undefined,
      visible,
    }
  })
}

function exposure(row, caseData) {
  const anchors = Array.isArray(row.state?.anchors) ? row.state.anchors : []
  const checkpoint = row.checkpoint?.text ?? ''
  const handoff = row.writer.handoff ?? ''
  const parsed = row.writer.rawOutput === null ? undefined : parseWriterOutput(row.writer.rawOutput)
  const proposed = parsed?.deltaParse === 'parsed' ? parsed.proposed : []
  const out = []
  for (const refusal of row.writer.refusedDeltas ?? []) {
    const original = proposed[refusal.index]
    const statement = refusal.statement ?? original?.statement ?? ''
    if (statement.length === 0) continue
    const inMachine = anchors.some(anchor => textSimilar(anchor, statement))
    const inHandoff = textSimilar(handoff, statement)
    const inCheckpoint = textSimilar(checkpoint, statement)
    out.push({
      reason: refusal.reason,
      statement,
      inMachineState: inMachine,
      inHandoff,
      inCheckpoint,
      exposure: inMachine ? 'machine-state' : (inHandoff || inCheckpoint) ? 'narrative-only' : 'not-visible',
    })
  }
  return out
}

async function analyzeRun(runId) {
  const report = JSON.parse(await readFile(join(RUNS, runId, 'report.json'), 'utf8'))
  const rows = []
  for (const row of report.rows) {
    if (row.arm !== 'S' || row.writer?.applicable !== true) continue
    const caseData = caseById.get(row.caseId)
    if (caseData === undefined) continue
    const trace = JSON.parse(await readFile(join(RUNS, runId, row.caseId, row.arm, row.replicateId, 'trace', 'record.json'), 'utf8'))
    const raw = trace.writerRaw ?? row.writer.rawOutput ?? null
    const parsed = raw === null ? undefined : parseWriterOutput(raw)
    const classification = classifyWriterFailure(raw, parsed)
    const facts = factLevels(caseData, row, raw, parsed)
    const current = facts.filter(fact => fact.current)
    rows.push({
      caseId: row.caseId,
      valid: row.valid,
      foldValid: row.fold?.valid === true,
      commitStatus: row.writer.commitStatus,
      call: row.writer.call,
      protocol: row.writer.protocol,
      category: classification.category,
      categoryDetail: classification.detail,
      proposed: parsed?.deltaParse === 'parsed' ? parsed.proposed.length : 0,
      accepted: row.writer.accepted,
      refused: row.writer.refused,
      refusalReasons: row.writer.refusalReasons ?? [],
      rawChars: raw?.length ?? null,
      rawDigest: row.writer.rawOutputDigest,
      exactScorer: row.extraction
        ? {
          criticalRecall: row.extraction.criticalRecall,
          coordinateRecall: row.extraction.coordinateRecall,
          claimCorrectness: row.extraction.claimCorrectness,
          currentStateAccuracy: row.extraction.currentStateAccuracy,
        }
        : null,
      facts,
      rates: {
        rawRecall: rate(facts.filter(fact => fact.raw === true).length, facts.length),
        proposalRecall: rate(facts.filter(fact => fact.proposed).length, facts.length),
        acceptedRecall: rate(facts.filter(fact => fact.accepted).length, facts.length),
        commitRecall: rate(facts.filter(fact => fact.committed).length, facts.length),
        directVisibility: rate(current.filter(fact => fact.visible).length, current.length),
      },
      exposure: exposure(row, caseData),
      cost: row.cost,
    })
  }
  const categories = {}
  for (const row of rows) categories[row.category] = (categories[row.category] ?? 0) + 1
  return {
    runId,
    promptVersion: report.modelParameters?.writerPromptVersion ?? null,
    promptDigest: report.modelParameters?.writerPromptDigest ?? null,
    status: report.status,
    model: report.model,
    generatedAt: report.generatedAt,
    ledger: report.ledger,
    rows,
    summary: {
      attempts: rows.length,
      validRows: rows.filter(row => row.valid).length,
      foldValidRows: rows.filter(row => row.foldValid).length,
      parsed: rows.filter(row => row.protocol === 'parsed').length,
      categories,
      accepted: rows.reduce((total, row) => total + (row.accepted ?? 0), 0),
      refused: rows.reduce((total, row) => total + (row.refused ?? 0), 0),
      rawRecall: mean(rows.map(row => row.rates.rawRecall)),
      proposalRecall: mean(rows.map(row => row.rates.proposalRecall)),
      acceptedRecall: mean(rows.map(row => row.rates.acceptedRecall)),
      commitRecall: mean(rows.map(row => row.rates.commitRecall)),
      directVisibility: mean(rows.map(row => row.rates.directVisibility)),
      machineStateExposures: rows.flatMap(row => row.exposure).filter(entry => entry.inMachineState).length,
      narrativeExposures: rows.flatMap(row => row.exposure).filter(entry => entry.exposure === 'narrative-only').length,
    },
  }
}

const analyses = []
for (const runId of runIds) analyses.push(await analyzeRun(runId))
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  note: 'Semantic analysis layer, not the benchmark exact scorer. No new provider call.',
  runs: analyses,
}
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
for (const analysis of analyses) {
  process.stdout.write(`\n${analysis.runId} (${analysis.promptVersion}): ${analysis.status}\n`)
  for (const row of analysis.rows) {
    process.stdout.write(
      `  ${row.caseId}: ${row.protocol}/${row.category} proposed=${row.proposed} accepted=${row.accepted} refused=${row.refused} `
      + `commit=${row.commitStatus} raw=${row.rates.rawRecall} proposal=${row.rates.proposalRecall} `
      + `accepted=${row.rates.acceptedRecall} commit=${row.rates.commitRecall} visible=${row.rates.directVisibility}\n`,
    )
  }
  process.stdout.write(`  summary ${JSON.stringify(analysis.summary)}\n`)
}
process.stdout.write(`\n${OUT}\n`)
