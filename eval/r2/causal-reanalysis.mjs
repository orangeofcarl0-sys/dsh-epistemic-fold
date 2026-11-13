#!/usr/bin/env node
/**
 * EF-R2 WP4 — the E1 re-analysis: ITT, transaction reliability, continuity.
 *
 * The 120-cell confirm's ITT numbers do not change. What changes is what they
 * are allowed to mean:
 *
 *   - 42 E1 "folds" were 42 ATTEMPTS; 11 committed, 31 were refused by the
 *     shrink check after paying for a rationale call;
 *   - the 11 committed checkpoints were delivered to a later primary request,
 *     so T2/T4's 8/8 is a genuinely post-fold result;
 *   - the 13 no-fold E1 cells kept the raw history and 9 still passed, which is
 *     why an ITT rate alone cannot separate "rationale helped" from "no
 *     compression happened".
 *
 * No cell is dropped and no historical result is rewritten. The committed/
 * refused split is descriptive, not a post-hoc randomized comparison.
 *
 *   node eval/r2/causal-reanalysis.mjs
 *
 * @module eval/r2/causal-reanalysis
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')
const CAMPAIGN = 'e2e-lg-confirm-1'

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Two-sided exact McNemar; b and c are the discordant counts. */
function exactMcNemar(b, c) {
  const n = b + c
  if (n === 0) return 1
  let tail = 0
  let term = 1
  for (let k = 0; k <= Math.min(b, c); k += 1) {
    if (k > 0) term = (term * (n - k + 1)) / k
    tail += term
  }
  return Math.min(1, 2 * tail * 0.5 ** n)
}

const results = readJson(join(E2E_OUT, `results-${CAMPAIGN}.json`))
const analysis = readJson(join(E2E_OUT, `analysis-${CAMPAIGN}.json`))
const witnessDoc = readJson(join(OUT, 'compaction-witnesses.json'))
const deliveryDoc = readJson(join(OUT, 'active-task-delivery.json'))
const r1ExcludingT10 = readJson(join(ROOT, 'eval', 'ef-r1', 'out', 'ablation-analysis-excluding-t10.json'))

const witnessByCell = new Map(witnessDoc.cells
  .filter(cell => cell.campaign === CAMPAIGN)
  .map(cell => [cell.cellId, cell]))
const deliveryByCell = new Map(deliveryDoc.rows
  .filter(cell => cell.campaign === CAMPAIGN)
  .map(cell => [cell.cellId, cell]))
const analysisByCell = new Map(analysis.rows.map(row => [row.cellId, row]))

const cells = results.results.map(row => {
  const witness = witnessByCell.get(row.cellId)
  const delivery = deliveryByCell.get(row.cellId)
  return {
    cellId: row.cellId,
    task: row.cell.task,
    template: row.cell.task.replace(/-s\d$/u, ''),
    seed: Number(row.cell.task.slice(-1)),
    arm: row.cell.arm,
    replicate: row.cell.replicate,
    key: `${row.cell.task}-r${row.cell.replicate}`,
    pass: row.checker === true,
    requests: row.usage.requests,
    inputTokens: row.usage.inputTokens,
    outputTokens: row.usage.outputTokens,
    attempts: witness?.witness.attempts ?? null,
    committed: witness?.witness.committed ?? null,
    refused: witness?.witness.refused ?? null,
    delivered: witness?.witness.committedAndDelivered ?? null,
    deliveryAtEnd: delivery?.atEnd ?? null,
    probesVisible: analysisByCell.get(row.cellId)?.checkpoint?.probesVisible ?? null,
  }
})

const ARMS = ['E0', 'E0-L', 'E0-G', 'E0-LG', 'E1']
const withoutT10 = cells.filter(cell => cell.template !== 'T10')

function byArm(subset) {
  return Object.fromEntries(ARMS.map(arm => {
    const rows = subset.filter(cell => cell.arm === arm)
    const committedRows = rows.filter(cell => (cell.committed ?? 0) > 0)
    const noFoldRows = rows.filter(cell => (cell.committed ?? 0) === 0)
    return [arm, {
      cells: rows.length,
      passed: rows.filter(cell => cell.pass).length,
      rate: rows.length === 0 ? null : Number((rows.filter(cell => cell.pass).length / rows.length).toFixed(3)),
      attempts: rows.reduce((sum, cell) => sum + (cell.attempts ?? 0), 0),
      committedFolds: rows.reduce((sum, cell) => sum + (cell.committed ?? 0), 0),
      committedCells: committedRows.length,
      refusedAttempts: rows.reduce((sum, cell) => sum + (cell.refused ?? 0), 0),
      passedWithCommit: committedRows.filter(cell => cell.pass).length,
      passedWithoutCommit: noFoldRows.filter(cell => cell.pass).length,
      deliveredCommits: rows.reduce((sum, cell) => sum + (cell.delivered ?? 0), 0),
      requests: rows.reduce((sum, cell) => sum + cell.requests, 0),
      inputTokens: rows.reduce((sum, cell) => sum + cell.inputTokens, 0),
      outputTokens: rows.reduce((sum, cell) => sum + cell.outputTokens, 0),
    }]
  }))
}

function paired(subset, leftArm, rightArm) {
  const byKey = new Map(subset.map(cell => [`${cell.key}:${cell.arm}`, cell]))
  let both = 0
  let neither = 0
  let leftOnly = 0
  let rightOnly = 0
  for (const key of new Set(subset.map(cell => cell.key))) {
    const left = byKey.get(`${key}:${leftArm}`)
    const right = byKey.get(`${key}:${rightArm}`)
    if (left === undefined || right === undefined) continue
    if (left.pass && right.pass) both += 1
    else if (!left.pass && !right.pass) neither += 1
    else if (left.pass) leftOnly += 1
    else rightOnly += 1
  }
  return {
    left: leftArm,
    right: rightArm,
    pairs: both + neither + leftOnly + rightOnly,
    both,
    neither,
    leftOnly,
    rightOnly,
    riskDifference: Number(((leftOnly - rightOnly) / Math.max(1, both + neither + leftOnly + rightOnly)).toFixed(3)),
    mcnemarP: Number(exactMcNemar(leftOnly, rightOnly).toFixed(4)),
  }
}

const comparisonsFull = [
  paired(cells, 'E1', 'E0'),
  paired(cells, 'E0-LG', 'E0'),
]
const comparisonsNoT10 = [
  paired(withoutT10, 'E1', 'E0'),
  paired(withoutT10, 'E0-LG', 'E0'),
  paired(withoutT10, 'E0-L', 'E0'),
  paired(withoutT10, 'E0-G', 'E0'),
  paired(withoutT10, 'E0-LG', 'E0-L'),
  paired(withoutT10, 'E0-LG', 'E0-G'),
]
const r1Reported = r1ExcludingT10.comparisons.map(row => ({
  left: row.left,
  right: row.right,
  pairs: row.pairs,
  leftOnly: row.leftOnly,
  rightOnly: row.rightOnly,
  mcnemarP: row.mcnemarP,
}))

const e1 = cells.filter(cell => cell.arm === 'E1')
const e0 = cells.filter(cell => cell.arm === 'E0')
const e1Committed = e1.filter(cell => (cell.committed ?? 0) > 0)
const e1NoFold = e1.filter(cell => (cell.committed ?? 0) === 0)
const t2t4 = cells.filter(cell => cell.template === 'T2' || cell.template === 'T4')
const t2t4E1 = t2t4.filter(cell => cell.arm === 'E1')
const t2t4E0 = t2t4.filter(cell => cell.arm === 'E0')

const continuity = {
  e1: {
    committedCells: e1Committed.length,
    committedPassed: e1Committed.filter(cell => cell.pass).length,
    committedDelivered: e1Committed.reduce((sum, cell) => sum + (cell.delivered ?? 0), 0),
    noFoldCells: e1NoFold.length,
    noFoldPassed: e1NoFold.filter(cell => cell.pass).length,
    note: 'Descriptive split. The cells were not randomized to commit/refuse; the refusal is a property of the span and the rationale body.',
  },
  e0: {
    cells: e0.length,
    committedFolds: e0.reduce((sum, cell) => sum + (cell.committed ?? 0), 0),
    passed: e0.filter(cell => cell.pass).length,
  },
  t2t4: {
    e1: {
      cells: t2t4E1.length,
      committedFolds: t2t4E1.reduce((sum, cell) => sum + (cell.committed ?? 0), 0),
      passed: t2t4E1.filter(cell => cell.pass).length,
      probesTwoOfTwo: t2t4E1.filter(cell => (cell.probesVisible?.length ?? 0) === 2).length,
      delivered: t2t4E1.reduce((sum, cell) => sum + (cell.delivered ?? 0), 0),
    },
    e0: {
      cells: t2t4E0.length,
      passed: t2t4E0.filter(cell => cell.pass).length,
      probesTwoOfTwo: t2t4E0.filter(cell => (cell.probesVisible?.length ?? 0) === 2).length,
    },
    note: 'All eight E1 cells folded once, committed, and delivered the checkpoint to a later primary request; the checkpoint carried both probes in all eight. The pass rate is a post-fold result, not an ITT estimate.',
  },
}

const output = {
  schemaVersion: 1,
  work: 'EF-R2 WP4',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  r1Reproduction: {
    byArm: byArm(cells),
    excludingT10: byArm(withoutT10),
    comparisonsFull,
    comparisonsExcludingT10: comparisonsNoT10,
    r1Reported,
    matchesR1: r1Reported.every(row => {
      const ours = comparisonsNoT10.find(entry => entry.left === row.left && entry.right === row.right)
      return ours !== undefined && ours.leftOnly === row.leftOnly && ours.rightOnly === row.rightOnly
        && ours.mcnemarP === row.mcnemarP
    }),
  },
  r2Reading: {
    reliability: byArm(cells),
    continuity,
    e1Itt: {
      cells: e1.length,
      passed: e1.filter(cell => cell.pass).length,
      committedCells: e1Committed.length,
      refusedAttempts: e1.reduce((sum, cell) => sum + (cell.refused ?? 0), 0),
      attempts: e1.reduce((sum, cell) => sum + (cell.attempts ?? 0), 0),
      note: 'The 18/24 ITT pass rate includes 13 no-fold cells (9 passed) and 11 committed cells (9 passed). The 31 refused attempts are paid calls that did not compress the history.',
    },
    promptCorrection: {
      legacyLost: deliveryDoc.legacyConfirm.taskPromptLost,
      exactOriginalLost: deliveryDoc.recertifiedConfirm.originalLost,
      valuesUnavailable: deliveryDoc.recertifiedConfirm.semanticsUnavailable,
      checkpointCopy: deliveryDoc.recertifiedConfirm.atEndCheckpointCopy,
      valuesOnly: deliveryDoc.recertifiedConfirm.atEndValuesOnly,
      note: 'The 44/120 preview metric overstates information loss: 43 of the 45 exact-loss cells still carry the task facts in a checkpoint (5 copies, 38 values-only); only 2 have neither. The two E1 exact-loss cells still carried the task values, so their 0/2 pass is not explained by absent facts. n=2.',
    },
  },
  sources: {
    results: { path: `eval/e2e/out/results-${CAMPAIGN}.json`, sha256: sha256(join(E2E_OUT, `results-${CAMPAIGN}.json`)) },
    analysis: { path: `eval/e2e/out/analysis-${CAMPAIGN}.json`, sha256: sha256(join(E2E_OUT, `analysis-${CAMPAIGN}.json`)) },
    witnesses: { path: 'eval/r2/out/compaction-witnesses.json', sha256: sha256(join(OUT, 'compaction-witnesses.json')) },
    delivery: { path: 'eval/r2/out/active-task-delivery.json', sha256: sha256(join(OUT, 'active-task-delivery.json')) },
  },
  note: 'ITT is unchanged and no cell is excluded. The committed/refused split is descriptive. The E1 T2/T4 result is a genuine post-fold result because all eight checkpoints were delivered; it is not a product-level causal claim.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'causal-reanalysis.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R2 — causal re-analysis')
md.push('')
md.push(`R1 reproduction matches: **${output.r1Reproduction.matchesR1}**.`)
md.push('')
md.push('| Arm | ITT pass | Attempts | Committed folds | Refused | Pass with commit | Pass without commit | Delivered commits |')
md.push('|---|---|---|---|---|---|---|---|')
for (const arm of ARMS) {
  const row = output.r2Reading.reliability[arm]
  md.push(`| ${arm} | ${row.passed}/${row.cells} | ${row.attempts} | ${row.committedFolds} | ${row.refusedAttempts} | ${row.passedWithCommit} | ${row.passedWithoutCommit} | ${row.deliveredCommits} |`)
}
md.push('')
md.push('## E1 continuity')
md.push('')
md.push(`Committed: ${continuity.e1.committedCells} cells, ${continuity.e1.committedPassed} passed, ${continuity.e1.committedDelivered} checkpoint deliveries. No-fold: ${continuity.e1.noFoldCells} cells, ${continuity.e1.noFoldPassed} passed.`)
md.push('')
md.push(`T2/T4: E1 ${continuity.t2t4.e1.passed}/${continuity.t2t4.e1.cells}, ${continuity.t2t4.e1.committedFolds} commits, ${continuity.t2t4.e1.delivered} deliveries, ${continuity.t2t4.e1.probesTwoOfTwo}/8 with both probes. E0 ${continuity.t2t4.e0.passed}/${continuity.t2t4.e0.cells}.`)
md.push('')
md.push('## Prompt-loss correction')
md.push('')
md.push(`Legacy 44/120; exact original lost ${output.r2Reading.promptCorrection.exactOriginalLost}/120; values unavailable ${output.r2Reading.promptCorrection.valuesUnavailable}/120 (${output.r2Reading.promptCorrection.checkpointCopy} copies, ${output.r2Reading.promptCorrection.valuesOnly} values-only).`)
md.push('')
writeFileSync(join(OUT, 'causal-reanalysis.md'), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`causal: R1 reproduction matches ${output.r1Reproduction.matchesR1}\n`)
for (const arm of ARMS) {
  const row = output.r2Reading.reliability[arm]
  process.stdout.write(`  ${arm}: ITT ${row.passed}/${row.cells}, attempts ${row.attempts}, commits ${row.committedFolds}, refused ${row.refusedAttempts}, delivered ${row.deliveredCommits}\n`)
}
process.stdout.write(`E1 committed ${continuity.e1.committedCells} (${continuity.e1.committedPassed} pass), no-fold ${continuity.e1.noFoldCells} (${continuity.e1.noFoldPassed} pass)\n`)
