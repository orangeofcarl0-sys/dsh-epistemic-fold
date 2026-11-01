#!/usr/bin/env node
/**
 * Record the scorer v1 -> v2 change instead of overwriting it.
 *
 * R33's published numbers remain in `eval/r33/frozen/v1/reports/`. This script
 * compares that report with the current v2 report and writes every changed arm
 * and case, with the reason the interpretation changed. It is an audit record,
 * not a re-scoring: the old report is never modified.
 *
 * @module eval/r33/compare-scores
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCORER_VERSION } from './src/grade.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OLD = join(HERE, 'frozen', 'v1', 'reports', 'offline-report.json')
const NEW = join(HERE, 'out', 'offline-report.json')
const OUT = join(HERE, 'out', 'scorer-comparison.json')

const oldReport = JSON.parse(await readFile(OLD, 'utf8'))
const newReport = JSON.parse(await readFile(NEW, 'utf8'))

const metricNames = [
  'success',
  'damage',
  'meanCriticalRecall',
  'meanGroundedPrecision',
  'meanFalseNormativeRate',
  'meanCurrentStateAccuracy',
  'meanDirectVisibility',
]

function byArm(report) {
  return new Map(report.arms.map(entry => [entry.arm, entry]))
}

function rowsByCaseArm(report) {
  return new Map(report.rows.map(row => [`${row.caseId}:${row.arm}`, row]))
}

const oldArms = byArm(oldReport)
const newArms = byArm(newReport)
const oldRows = rowsByCaseArm(oldReport)
const newRows = rowsByCaseArm(newReport)
const changed = []
for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
  const before = oldRows.get(key)
  const after = newRows.get(key)
  if (before === undefined || after === undefined) continue
  const beforeRecall = before.extraction?.criticalRecall ?? null
  const afterRecall = after.extraction?.criticalRecall ?? null
  const beforeSuccess = before.behaviour?.taskSuccess === true
  const afterSuccess = after.behaviour?.taskSuccess === true
  const beforeCurrent = before.extraction?.currentStateAccuracy ?? null
  const afterCurrent = after.extraction?.currentStateAccuracy ?? null
  if (beforeRecall === afterRecall && beforeSuccess === afterSuccess && beforeCurrent === afterCurrent) continue
  const [caseId, arm] = key.split(':')
  let reason = 'scorer v2 interpretation'
  if (beforeRecall !== afterRecall) {
    reason = 'v2 requires an exact gold statement; v1 fell back to the same coordinate. '
      + 'A same-subject counter-claim or a wrong verification state is now requires-review, not correct.'
  } else if ((arm === 'O2' || arm === 'OR') && beforeSuccess !== afterSuccess) {
    reason = 'oracle-visible context now shows CURRENT gold facts only; v1 included superseded facts'
  } else if (beforeCurrent !== afterCurrent) {
    reason = 'current-state accuracy now resolves the v2 gold/citation set'
  } else if (beforeSuccess !== afterSuccess) {
    reason = 'task outcome changed after the v2 dataset/citation correction'
  }
  changed.push({
    caseId,
    arm,
    before: {
      taskSuccess: beforeSuccess,
      criticalRecall: beforeRecall,
      currentStateAccuracy: beforeCurrent,
    },
    after: {
      taskSuccess: afterSuccess,
      criticalRecall: afterRecall,
      currentStateAccuracy: afterCurrent,
    },
    reason,
  })
}

const arms = [...new Set([...oldArms.keys(), ...newArms.keys()])].sort().map(arm => {
  const before = oldArms.get(arm)
  const after = newArms.get(arm)
  return {
    arm,
    before: Object.fromEntries(metricNames.map(name => [name, before?.[name] ?? null])),
    after: Object.fromEntries(metricNames.map(name => [name, after?.[name] ?? null])),
  }
})

const comparison = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  old: {
    scorerVersion: oldReport.scorerVersion ?? 1,
    datasetId: oldReport.datasetId ?? 'r33-semantic-continuity-v1',
    datasetDigest: oldReport.datasetDigest,
    report: 'frozen/v1/reports/offline-report.json',
  },
  new: {
    scorerVersion: SCORER_VERSION,
    datasetId: newReport.datasetId,
    datasetDigest: newReport.datasetDigest,
    report: 'out/offline-report.json',
  },
  arms,
  changed,
  note: 'The old report is preserved verbatim. This record explains every changed number; it does not replace the old one.',
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8')
process.stdout.write(`scorer comparison: ${changed.length} changed case/arm row(s)\n${OUT}\n`)
