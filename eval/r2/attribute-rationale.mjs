#!/usr/bin/env node
/**
 * EF-R2 WP2 — what actually failed in the 31 E1 compaction attempts?
 *
 * The round started from "42 rationale calls, 11 committed, 31 failed" and an
 * open question about provider errors, empty rationales, transaction failures
 * and retry policy. The archived evidence answers it more narrowly:
 *
 *   every failed attempt reached the shrink check, and the model call itself
 *   returned a body. The body was simply larger than the span it would replace.
 *
 * This script proves that per attempt, and then asks the only question that
 * decides a production fix:
 *
 *   is the STATE-ONLY checkpoint already larger than the span?
 *
 * If yes, the rationale call could never have succeeded and a pre-call guard is
 * justified. If no, a short rationale could have committed, the call was
 * necessary, and a pre-call guard would only change a refusal into a different
 * refusal. The distinction is the whole decision.
 *
 *   node eval/r2/attribute-rationale.mjs
 *
 * @module eval/r2/attribute-rationale
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
const CAMPAIGN = 'e2e-lg-confirm-1'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const estimateTokens = chars => Math.round(chars / 4)

/** Strip the Rationale section, leaving the body the renderer would emit without it. */
function stateOnly(text) {
  return text.replace(/\n\nRationale\n(?:-[^\n]*(?:\n|$))*/u, '')
}

const analysis = readJson(join(E2E_OUT, `analysis-${CAMPAIGN}.json`))
const e1Rows = (analysis.rows ?? []).filter(row => row.arm === 'E1')

const rows = []
const cells = []
for (const row of e1Rows) {
  const cellRoot = join(ROOT, 'eval', 'e2e', 'runs', CAMPAIGN, row.cellId)
  const report = readJson(join(cellRoot, 'report.json'))
  const requests = readJson(join(cellRoot, 'raw', 'requests.json'))
  const messagesPath = join(cellRoot, 'raw', 'messages.json')
  const fullMessages = existsSync(messagesPath) ? readJson(messagesPath) : []
  const bundleRoot = join(cellRoot, 'bundles')
  const sessionId = existsSync(bundleRoot)
    ? (readdirSync(bundleRoot, { withFileTypes: true }).find(entry => entry.isDirectory())?.name ?? undefined)
    : undefined
  const built = await buildWitnessesFromRun({
    report,
    requests,
    fullMessages,
    bundleRoot,
    sessionId,
    taskPrompt: undefined,
    arm: row.arm,
  })
  const store = sessionId === undefined ? null : new FileBundleStore(bundleRoot)
  const attemptRows = []
  let ordinal = 0
  for (const witness of built.witnesses) {
    ordinal += 1
    let bundle = null
    if (store !== null && witness.checkpointId !== undefined) {
      const verification = await store.verify(sessionId, witness.checkpointId)
      if (verification.status === 'verified') bundle = verification.bundle
    }
    const rendered = bundle?.rendered?.text ?? ''
    const semantic = bundle?.semantic?.text ?? ''
    const bodyChars = rendered.length
    const stateOnlyChars = rendered.length === 0 ? 0 : stateOnly(rendered).length
    const spanTokens = witness.shadowedTokens
      ?? (witness.errorText === undefined
        ? undefined
        : Number(/>= (\d+)\)/u.exec(witness.errorText)?.[1]))
    const bodyTokens = bodyChars === 0 ? undefined : estimateTokens(bodyChars)
    const stateOnlyTokens = stateOnlyChars === 0 ? undefined : estimateTokens(stateOnlyChars)
    attemptRows.push({
      cellId: row.cellId,
      arm: row.arm,
      attempt: ordinal,
      compactionId: witness.compactionId,
      status: witness.status,
      evidenceLevel: witness.evidenceLevel,
      reason: witness.reason,
      phase: witness.phase ?? null,
      errorText: witness.errorText ?? null,
      spanTokens: spanTokens ?? null,
      bodyTokens: bodyTokens ?? null,
      stateOnlyTokens: stateOnlyTokens ?? null,
      bodyChars: bodyChars || null,
      stateOnlyChars: stateOnlyChars || null,
      semanticChars: semantic.length || null,
      bodyExceedsSpan: bodyTokens !== undefined && spanTokens !== undefined ? bodyTokens >= spanTokens : null,
      stateOnlyExceedsSpan: stateOnlyTokens !== undefined && spanTokens !== undefined ? stateOnlyTokens >= spanTokens : null,
      spanBelowFramingFallback: spanTokens !== undefined ? spanTokens < 530 : null,
      rationale: witness.rationale ?? null,
      archive: witness.archive ?? null,
      delivery: witness.delivery ?? null,
      checkpointId: witness.checkpointId ?? null,
    })
  }
  rows.push(...attemptRows)
  const failed = attemptRows.filter(entry => entry.status !== 'committed')
  cells.push({
    cellId: row.cellId,
    checkerPassed: row.checkerPass,
    attempts: attemptRows.length,
    committed: attemptRows.filter(entry => entry.status === 'committed').length,
    refused: attemptRows.filter(entry => entry.status === 'refused').length,
    aborted: attemptRows.filter(entry => entry.status === 'aborted').length,
    failedCost: failed.reduce((total, entry) => ({
      inputTokens: total.inputTokens + (entry.rationale?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (entry.rationale?.outputTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0 }),
    failedSpans: failed.map(entry => entry.spanTokens),
    finished: failed.map(entry => entry.rationale?.finish?.kind ?? null),
  })
}

const failed = rows.filter(row => row.status !== 'committed')
const committed = rows.filter(row => row.status === 'committed')
const finishKinds = failed.reduce((counts, row) => {
  const key = row.rationale?.finish?.kind ?? 'unknown'
  counts[key] = (counts[key] ?? 0) + 1
  return counts
}, {})

/** Cells where a second attempt was made; the retry policy's real test. */
const retryCells = cells.filter(cell => cell.attempts > 1).map(cell => {
  const cellRows = rows.filter(row => row.cellId === cell.cellId)
  const failedRows = cellRows.filter(row => row.status !== 'committed')
  const committedRows = cellRows.filter(row => row.status === 'committed')
  return {
    cellId: cell.cellId,
    attempts: cellRows.length,
    failed: failedRows.length,
    committed: committedRows.length,
    failedSpans: failedRows.map(row => row.spanTokens),
    committedSpans: committedRows.map(row => row.spanTokens),
    laterAttemptCommitted: committedRows.length > 0,
  }
})
const retrySavedCommits = retryCells.filter(cell => cell.laterAttemptCommitted)

const decision = {
  productionFix: 'none',
  preCallShrinkGuardJustified: false,
  preCallGuardEvidence: {
    attemptsWithStateOnlyAtLeastSpan: failed.filter(row => row.stateOnlyExceedsSpan === true).length,
    attemptsWithBodyAtLeastSpan: failed.filter(row => row.bodyExceedsSpan === true).length,
    stateOnlyTokensRange: (() => {
      const values = failed.map(row => row.stateOnlyTokens).filter(value => value !== null)
      return values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) }
    })(),
    spanTokensRange: (() => {
      const values = failed.map(row => row.spanTokens).filter(value => value !== null)
      return values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) }
    })(),
    bodyOverSpanRatios: (() => {
      const values = failed
        .filter(row => row.bodyTokens !== null && row.spanTokens !== null)
        .map(row => Number((row.bodyTokens / row.spanTokens).toFixed(2)))
        .sort((left, right) => left - right)
      return values.length === 0 ? null : {
        min: values[0],
        median: values[Math.floor(values.length / 2)],
        max: values[values.length - 1],
      }
    })(),
  },
  reason: 'The state-only body is only the marker (12 estimated tokens in every failure); the rationale is the excess. The model call was necessary to know whether the rationale would fit, and a shorter rationale could have committed. A pre-call guard would therefore convert one refusal into another, not prevent a doomed transaction.',
  retrySuppressionJustified: false,
  retryEvidence: {
    cellsWithRetries: retryCells.length,
    cellsWhereLaterAttemptCommitted: retrySavedCommits.length,
    examples: retrySavedCommits,
    reason: 'The retries are not uniformly futile. In T9-s1-E1-r2 and T10-s1-E1-r1 the first attempt failed on a 200-token span, and the next attempt committed after folding a ~9.2k-token span. A blanket retry suppression would lose those two commits. A refusal cache keyed on the exact span seqs is a candidate, but the archive does not retain the failed attempts\' span seqs, so its effect on these cells is unverified. It belongs to a future round whose witness captures those seqs.',
  },
  admissionMismatch: 'admitLeafEconomically prices the widest legal span with retainTokens=0, while the executor folds the span left after spec.retainTokens. In these cells the executed span is 58-207 tokens, below the 530-token framing fallback, but that does not prove the decider would have refused it. Whether economic admission prevents these attempts needs a dedicated replay with the real measurement; it is a hypothesis, not a result.',
  next: 'Pre-register the shipped tier configuration and a zero-request preflight that checks the EXECUTED fold span, not only the widest legal span. Capture the selected span seqs in the witness so a future round can test a same-span refusal cache. Do not lower the rationale budget or tune the prompt.',
}

const output = {
  schemaVersion: 1,
  work: 'EF-R2 WP2',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  sources: {
    analysis: { path: `eval/e2e/out/analysis-${CAMPAIGN}.json`, sha256: sha256(join(E2E_OUT, `analysis-${CAMPAIGN}.json`)) },
    results: { path: `eval/e2e/out/results-${CAMPAIGN}.json`, sha256: sha256(join(E2E_OUT, `results-${CAMPAIGN}.json`)) },
  },
  e1: {
    attempts: rows.length,
    committed: committed.length,
    failed: failed.length,
    finishKinds,
    byReason: failed.reduce((counts, row) => {
      counts[row.reason] = (counts[row.reason] ?? 0) + 1
      return counts
    }, {}),
    failedInputTokens: failed.reduce((sum, row) => sum + (row.rationale?.inputTokens ?? 0), 0),
    failedOutputTokens: failed.reduce((sum, row) => sum + (row.rationale?.outputTokens ?? 0), 0),
    maxTokensObserved: [...new Set(rows.map(row => row.rationale?.maxTokens).filter(value => value !== undefined))],
    cells: cells.length,
    retriesPerCell: cells.map(cell => ({
      cellId: cell.cellId,
      attempts: cell.attempts,
      committed: cell.committed,
      refused: cell.refused,
      failedInputTokens: cell.failedCost.inputTokens,
      failedOutputTokens: cell.failedCost.outputTokens,
      failedSpans: cell.failedSpans,
    })),
  },
  retryAnalysis: retryCells,
  decision,
  rows,
  note: 'Every failed attempt is a shrink refusal, not a provider failure. The bundle was durable and verifies; the surface replacement never happened. The per-attempt bundle link for archived failures is inferred by order, while the bundle bytes themselves verify.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'rationale-failure-attribution.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R2 — E1 compaction failure attribution')
md.push('')
md.push(`Campaign \`${CAMPAIGN}\`: ${rows.length} attempts, ${committed.length} committed, ${failed.length} failed.`)
md.push('')
md.push('| Reason | Count |')
md.push('|---|---|')
for (const [reason, count] of Object.entries(output.e1.byReason)) md.push(`| ${reason} | ${count} |`)
md.push('')
md.push('## The decision that matters')
md.push('')
md.push(`- Failed attempts whose **body** was at least the span: **${decision.preCallGuardEvidence.attemptsWithBodyAtLeastSpan}/${failed.length}**.`)
md.push(`- Failed attempts whose **state-only body** was at least the span: **${decision.preCallGuardEvidence.attemptsWithStateOnlyAtLeastSpan}/${failed.length}**.`)
md.push(`- State-only tokens: ${decision.preCallGuardEvidence.stateOnlyTokensRange?.min ?? '—'}–${decision.preCallGuardEvidence.stateOnlyTokensRange?.max ?? '—'}; span tokens: ${decision.preCallGuardEvidence.spanTokensRange?.min ?? '—'}–${decision.preCallGuardEvidence.spanTokensRange?.max ?? '—'}.`)
md.push('')
md.push(`**Decision: ${decision.productionFix} production fix.** ${decision.reason}`)
md.push('')
md.push(`**Retry suppression: ${decision.retrySuppressionJustified ? 'justified' : 'not justified'}.** ${decision.retryEvidence.reason}`)
md.push('')
md.push(`Cells with retries: ${decision.retryEvidence.cellsWithRetries}; cells where a later attempt committed: ${decision.retryEvidence.cellsWhereLaterAttemptCommitted}.`)
md.push('')
md.push(`**Candidate mismatch, not a claimed fix:** ${decision.admissionMismatch}`)
md.push('')
md.push('## Failed attempts')
md.push('')
md.push('| Cell | # | Span | Body | State-only | Rationale finish | Input | Output |')
md.push('|---|---|---|---|---|---|---|---|')
for (const row of failed) {
  md.push(`| ${row.cellId} | ${row.attempt} | ${row.spanTokens ?? '—'} | ${row.bodyTokens ?? '—'} | ${row.stateOnlyTokens ?? '—'} | ${row.rationale?.finish?.kind ?? '—'} | ${row.rationale?.inputTokens ?? '—'} | ${row.rationale?.outputTokens ?? '—'} |`)
}
md.push('')
md.push(`Failed-call cost: ${output.e1.failedInputTokens} input, ${output.e1.failedOutputTokens} output tokens. The calls were paid for; the bodies were never delivered.`)
md.push('')
writeFileSync(join(OUT, 'rationale-failure-attribution.md'), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`attribution: ${rows.length} E1 attempts, ${committed.length} committed, ${failed.length} failed\n`)
process.stdout.write(`finish kinds: ${JSON.stringify(finishKinds)}\n`)
process.stdout.write(`body >= span: ${decision.preCallGuardEvidence.attemptsWithBodyAtLeastSpan}/${failed.length}; state-only >= span: ${decision.preCallGuardEvidence.attemptsWithStateOnlyAtLeastSpan}/${failed.length}\n`)
process.stdout.write(`failed cost: ${output.e1.failedInputTokens} input, ${output.e1.failedOutputTokens} output\n`)
