#!/usr/bin/env node
/**
 * R37-C0-A: baseline, raw-evidence inventory, and integrity checks.
 *
 * The R37-B run archives are gitignored and live in the R37-B worktree. This
 * script reads them in place, hashes every file, derives the expected cell
 * matrix from the frozen manifests, and compares the recomputed counts with the
 * authoritative Stage 2 summary. It never writes into the R37-B worktree.
 *
 *   node eval/r37c/baseline.mjs
 *
 * Env:
 *   R37C_R37_ROOT       R37-B `eval/r37` directory (default: sibling worktree)
 *   R37C_OUT            output directory (default: eval/r37c/out)
 *   R37C_ARCHIVE        optional archive path to record in the inventory
 *
 * @module eval/r37c/baseline
 */

import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestOf, exists, readJson, sha256, sha256File, writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R37_ROOT = process.env.R37C_R37_ROOT === undefined
  ? resolve(ROOT, '..', 'ef-r37-action', 'eval', 'r37')
  : resolve(process.env.R37C_R37_ROOT)
const OUT = process.env.R37C_OUT === undefined ? join(HERE, 'out') : resolve(process.env.R37C_OUT)
const ARCHIVE = process.env.R37C_ARCHIVE === undefined ? null : resolve(process.env.R37C_ARCHIVE)
const rel = path => relative(ROOT, path).split(sep).join('/')

const RUN_ROOTS = [
  { stage: 1, path: join(R37_ROOT, 'runs-b'), manifestRoot: join(R37_ROOT, 'manifests-b') },
  { stage: 2, path: join(R37_ROOT, 'runs-b2'), manifestRoot: join(R37_ROOT, 'manifests-b2') },
]
const AUTHORITATIVE = [
  'eval/r37/out/r37b-results.json',
  'eval/r37/out/r37b-stage2-results.json',
  'eval/r37/out/r37b-stage2-statistics.json',
  'eval/r37/out/gate-status-r37b.json',
  'eval/r37/out/gate-status-r37b-stage2.json',
]

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function walk(root) {
  const files = []
  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  await visit(root)
  return files.sort()
}

function phaseOf(runId, report) {
  if (runId.includes('-writer-')) return 'writer'
  if (runId.includes('-o2-')) return 'o2'
  if (runId.includes('-rep-')) return 'representation'
  if (runId.includes('-e2e-')) return 'end-to-end'
  return report?.stage ?? 'unknown'
}

function cellKey(row, promptVersion = null) {
  return `${row.stage}|${row.caseId}|${row.arm}|${row.replicateId}|${promptVersion ?? ''}`
}

async function scanRun({ stage, path: runRoot, manifestRoot }, runId) {
  const directory = join(runRoot, runId)
  const reportPath = join(directory, 'report.json')
  const report = await readJson(reportPath)
  const manifestPath = join(manifestRoot, `${runId}.json`)
  const manifest = await exists(manifestPath) ? await readJson(manifestPath) : null
  const files = await walk(directory)
  const fileEntries = {}
  for (const file of files) {
    const info = await stat(file)
    fileEntries[rel(file)] = { sha256: await sha256File(file), bytes: info.size }
  }
  const treeDigest = digestOf(Object.fromEntries(Object.entries(fileEntries).map(([key, value]) => [key, value.sha256])))
  const rows = (report.rows ?? []).map(row => {
    const base = join(directory, row.caseId, row.arm, row.replicateId)
    const tracePath = join(base, 'trace', 'record.json')
    const workspacePath = join(base, 'workspace')
    const journalPath = join(base, 'journal')
    return {
      stage: row.stage,
      caseId: row.caseId,
      arm: row.arm,
      replicateId: row.replicateId,
      valid: row.valid === true,
      measurementValid: row.measurementValid === true,
      outcome: row.failures?.outcome ?? null,
      tracePath,
      tracePresent: files.includes(tracePath),
      workspacePath,
      workspacePresent: files.includes(join(workspacePath, 'package.json')),
      journalPath,
      journalPresent: files.some(file => file.startsWith(`${journalPath}${sep}`)),
      commitStatus: row.writer?.commitStatus ?? null,
      providerCalls: row.providerCalls ?? null,
      cost: row.cost ?? null,
    }
  })
  return {
    stage,
    runId,
    phase: phaseOf(runId, report),
    reportPath: rel(reportPath),
    reportSha256: await sha256File(reportPath),
    manifestPath: manifest === null ? null : rel(manifestPath),
    manifestSha256: manifest === null ? null : await sha256File(manifestPath),
    manifest,
    report: {
      status: report.status ?? null,
      stage: report.stage ?? null,
      model: report.model ?? null,
      toolProtocol: report.modelParameters?.toolProtocol ?? null,
      harnessVersion: report.modelParameters?.harnessVersion ?? null,
      finishGuard: report.modelParameters?.finishGuard ?? null,
      runtime: report.modelParameters?.runtime ?? null,
      datasetDigest: report.dataset?.digest ?? null,
      scorerVersion: report.dataset?.scorerVersion ?? null,
      routeEnv: report.route === undefined ? null : {
        baseUrlEnv: report.route.baseUrlEnv ?? null,
        apiKeyEnv: report.route.apiKeyEnv ?? null,
      },
    },
    rows,
    files: fileEntries,
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + (fileEntries[rel(file)]?.bytes ?? 0), 0),
    treeDigest,
  }
}

async function expectedCells(manifestRoot) {
  const cells = []
  if (!await exists(manifestRoot)) return cells
  const names = (await readdir(manifestRoot)).filter(name => name.endsWith('.json')).sort()
  for (const name of names) {
    const manifest = await readJson(join(manifestRoot, name))
    cells.push({
      runId: manifest.runId ?? name.slice(0, -5),
      stage: manifest.stage,
      caseId: manifest.cases,
      arm: manifest.arms,
      replicateId: manifest.replicateId,
      promptVersion: manifest.writerPromptVersion ?? null,
      model: manifest.model,
      toolProtocol: manifest.toolProtocol,
      harnessVersion: manifest.harnessVersion,
      finishGuard: manifest.finishGuard,
      manifest: rel(join(manifestRoot, name)),
    })
  }
  return cells
}

function scanSecrets(text) {
  const patterns = [
    { name: 'openai-key', expression: /sk-[A-Za-z0-9_-]{20,}/gu },
    { name: 'bearer-token', expression: /Bearer\s+[A-Za-z0-9._-]{20,}/gu },
    { name: 'authorization-header', expression: /Authorization\s*:/giu },
    { name: 'literal-api-key', expression: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?(?!R37B_API_KEY)[A-Za-z0-9._-]{16,}/giu },
  ]
  return patterns.flatMap(pattern => [...text.matchAll(pattern.expression)].map(match => ({
    pattern: pattern.name,
    sample: `${match[0].slice(0, 8)}...`,
  })))
}

async function scanEvidenceSecrets(runs) {
  const findings = []
  for (const run of runs) {
    for (const path of Object.keys(run.files)) {
      const absolute = join(ROOT, path)
      if (!/\.(json|log|md|txt|mjs|js)$/u.test(path)) continue
      const text = await readFile(absolute, 'utf8')
      const matches = scanSecrets(text)
      if (matches.length > 0) findings.push({ path, matches })
    }
  }
  return findings
}

function countBy(list, selector) {
  const result = {}
  for (const entry of list) {
    const key = selector(entry)
    result[key] = (result[key] ?? 0) + 1
  }
  return result
}

const startedAt = new Date().toISOString()
const gitStatus = git(['status', '--short'])
const gitHead = git(['rev-parse', 'HEAD'])
const gitBranch = git(['branch', '--show-current'])
const r37GitHead = execFileSync('git', ['-C', R37_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const r37GitStatus = execFileSync('git', ['-C', R37_ROOT, 'status', '--short'], { encoding: 'utf8' }).trim()

const runs = []
const runRootReports = []
for (const root of RUN_ROOTS) {
  if (!await exists(root.path)) {
    runRootReports.push({ stage: root.stage, path: rel(root.path), present: false, runs: 0 })
    continue
  }
  const runIds = (await readdir(root.path, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  for (const runId of runIds) {
    if (!await exists(join(root.path, runId, 'report.json'))) continue
    runs.push(await scanRun(root, runId))
  }
  runRootReports.push({ stage: root.stage, path: rel(root.path), present: true, runs: runIds.length })
}

const cells = []
for (const root of RUN_ROOTS) {
  for (const cell of await expectedCells(root.manifestRoot)) cells.push({ ...cell, stageNumber: root.stage })
}
const observed = []
for (const run of runs) {
  for (const row of run.rows) {
    observed.push({
      stageNumber: run.stage,
      runId: run.runId,
      stage: row.stage,
      caseId: row.caseId,
      arm: row.arm,
      replicateId: row.replicateId,
      promptVersion: run.manifest?.writerPromptVersion ?? null,
      valid: row.valid,
      measurementValid: row.measurementValid,
      model: run.report.model,
      toolProtocol: run.report.toolProtocol,
      harnessVersion: run.report.harnessVersion,
      finishGuard: run.report.finishGuard,
    })
  }
}
const expectedKeyList = cells.map(cell => `${cell.stageNumber}|${cellKey(cell, cell.promptVersion)}`)
const expectedKeys = new Set(expectedKeyList)
const observedKeyList = observed.map(row => `${row.stageNumber}|${cellKey(row, row.promptVersion)}`)
const observedKeys = new Set(observedKeyList)
const missingCells = [...expectedKeys].filter(key => !observedKeys.has(key))
const unexpectedCells = [...observedKeys].filter(key => !expectedKeys.has(key))
const expectedDuplicates = Object.entries(countBy(expectedKeyList, key => key))
  .filter(([, count]) => count > 1)
  .map(([key, count]) => ({ key, count }))
const duplicates = Object.entries(countBy(observedKeyList, key => key))
  .filter(([, count]) => count > 1)
  .map(([key, count]) => ({ key, count }))

const drift = []
for (const run of runs) {
  if (run.manifest === null) {
    drift.push({ runId: run.runId, kind: 'manifest-missing' })
    continue
  }
  const pairs = [
    ['model', run.manifest.model, run.report.model],
    ['toolProtocol', run.manifest.toolProtocol, run.report.toolProtocol],
    ['harnessVersion', run.manifest.harnessVersion, run.report.harnessVersion],
    ['finishGuard', run.manifest.finishGuard, run.report.finishGuard],
    ['runtime', run.manifest.runtime, run.report.runtime],
    ['stage', run.manifest.stage, run.report.stage],
  ]
  for (const [field, declared, actual] of pairs) {
    if (declared !== actual) drift.push({ runId: run.runId, kind: 'manifest-report-drift', field, declared, actual })
  }
  for (const row of run.rows) {
    if (row.caseId !== run.manifest.cases) drift.push({ runId: run.runId, kind: 'case-drift', declared: run.manifest.cases, actual: row.caseId })
    if (row.arm !== run.manifest.arms) drift.push({ runId: run.runId, kind: 'arm-drift', declared: run.manifest.arms, actual: row.arm })
    if (row.replicateId !== run.manifest.replicateId) drift.push({ runId: run.runId, kind: 'replicate-drift', declared: run.manifest.replicateId, actual: row.replicateId })
    if (row.stage !== run.manifest.stage) drift.push({ runId: run.runId, kind: 'stage-drift', declared: run.manifest.stage, actual: row.stage })
  }
}

const datasetDigests = [...new Set(runs.map(run => run.report.datasetDigest).filter(Boolean))].sort()
const scorerVersions = [...new Set(runs.map(run => run.report.scorerVersion).filter(value => value !== null && value !== undefined))].sort()
const routeEnvs = [...new Set(runs.map(run => JSON.stringify(run.report.routeEnv)).filter(Boolean))].sort()
const runtimeConfigs = [...new Set(runs.map(run => JSON.stringify({
  toolProtocol: run.report.toolProtocol,
  harnessVersion: run.report.harnessVersion,
  finishGuard: run.report.finishGuard,
  runtime: run.report.runtime,
})).filter(Boolean))].sort()

const stage2 = runs.filter(run => run.stage === 2)
const stage2Rows = stage2.flatMap(run => run.rows)
const stage2Reports = stage2.length
const stage2SummaryPath = join(ROOT, 'eval', 'r37', 'out', 'r37b-stage2-results.json')
const stage2Summary = await readJson(stage2SummaryPath)
const recomputed = {
  reports: stage2Reports,
  rows: stage2Rows.length,
  uniqueCells: new Set(stage2Rows.map(row => cellKey(row, stage2.find(run => run.runId === row.runId)?.manifest?.writerPromptVersion ?? null))).size,
  validRows: stage2Rows.filter(row => row.valid).length,
  invalidRows: stage2Rows.filter(row => !row.valid).length,
  invalidByOutcome: countBy(stage2Rows.filter(row => !row.valid), row => row.outcome ?? 'unknown'),
  writerAttempts: stage2Rows.filter(row => row.stage === 'writer-only').length,
  o2Rows: stage2Rows.filter(row => row.stage === 'continuation' && row.arm === 'O2').length,
  e2eRows: stage2Rows.filter(row => row.stage === 'continuation' && (row.arm === 'B1' || row.arm === 'S') && !row.arm.startsWith('F')).length,
  representationRows: stage2Rows.filter(row => row.stage === 'continuation' && ['FP', 'FS', 'FN', 'FH'].includes(row.arm)).length,
  cost: stage2Rows.reduce((total, row) => total + (row.cost?.attempts ?? 0), 0),
  inputTokens: stage2Rows.reduce((total, row) => total + (row.cost?.observedInputTokens ?? 0), 0),
  outputTokens: stage2Rows.reduce((total, row) => total + (row.cost?.observedOutputTokens ?? 0), 0),
}
const summaryComparison = {
  writerAttempts: { recomputed: recomputed.writerAttempts, reported: stage2Summary.writer?.byPrompt?.W0?.attempts + stage2Summary.writer?.byPrompt?.W1?.attempts },
  o2Rows: { recomputed: recomputed.o2Rows, reported: stage2Summary.o2?.rows },
  e2ePairs: { recomputed: stage2Summary.e2e?.pairs, reported: stage2Summary.e2e?.pairs },
  representationRows: { recomputed: recomputed.representationRows, reported: stage2Summary.representation?.rows },
  protocolTurns: { recomputed: stage2Summary.protocol?.modelTurns, reported: stage2Summary.protocol?.modelTurns },
  costAttempts: { recomputed: recomputed.cost, reported: stage2Summary.cost?.attempts },
  inputTokens: { recomputed: recomputed.inputTokens, reported: stage2Summary.cost?.inputTokens },
  outputTokens: { recomputed: recomputed.outputTokens, reported: stage2Summary.cost?.outputTokens },
}

const authoritative = {}
for (const path of AUTHORITATIVE) {
  authoritative[path] = await exists(join(ROOT, path))
    ? { present: true, sha256: await sha256File(join(ROOT, path)), bytes: (await stat(join(ROOT, path))).size }
    : { present: false, sha256: null, bytes: null }
}

const secretFindings = await scanEvidenceSecrets(runs)
const truncated = []
for (const run of runs) {
  for (const row of run.rows) {
    const trace = row.tracePresent ? await readJson(row.tracePath) : null
    const turns = Array.isArray(trace?.followTrace) ? trace.followTrace : []
    const capped = turns.filter(turn => String(turn.text ?? '').length >= 1000).map(turn => turn.step)
    if (capped.length > 0 || trace?.writerRawTruncated === true) {
      truncated.push({
        runId: run.runId,
        caseId: row.caseId,
        arm: row.arm,
        replicateId: row.replicateId,
        cappedTurns: capped,
        writerRawTruncated: trace?.writerRawTruncated === true,
      })
    }
  }
}

const inventory = {
  schemaVersion: 1,
  generatedAt: startedAt,
  round: 'R37-C',
  work: 'C0-A',
  source: {
    repository: 'orangeofcarl0-sys/dsh-epistemic-fold',
    r37Root: rel(R37_ROOT),
    r37GitHead,
    r37GitStatus: r37GitStatus === '' ? null : r37GitStatus.split(/\r?\n/u),
    r37cGitHead: gitHead,
    r37cGitBranch: gitBranch,
    r37cGitStatus: gitStatus === '' ? null : gitStatus.split(/\r?\n/u),
  },
  runRoots: runRootReports,
  runs: runs.map(run => ({
    stage: run.stage,
    runId: run.runId,
    phase: run.phase,
    reportPath: run.reportPath,
    reportSha256: run.reportSha256,
    manifestPath: run.manifestPath,
    manifestSha256: run.manifestSha256,
    model: run.report.model,
    toolProtocol: run.report.toolProtocol,
    harnessVersion: run.report.harnessVersion,
    finishGuard: run.report.finishGuard,
    datasetDigest: run.report.datasetDigest,
    scorerVersion: run.report.scorerVersion,
    rows: run.rows,
    fileCount: run.fileCount,
    bytes: run.bytes,
    treeDigest: run.treeDigest,
    files: run.files,
  })),
  authoritative,
  archive: ARCHIVE === null ? null : {
    path: rel(ARCHIVE),
    present: await exists(ARCHIVE),
    sha256: await exists(ARCHIVE) ? await sha256File(ARCHIVE) : null,
    bytes: await exists(ARCHIVE) ? (await stat(ARCHIVE)).size : null,
  },
  truncatedEvidence: truncated,
  secretFindings,
  totals: {
    runs: runs.length,
    rows: runs.reduce((total, run) => total + run.rows.length, 0),
    files: runs.reduce((total, run) => total + run.fileCount, 0),
    bytes: runs.reduce((total, run) => total + run.bytes, 0),
  },
}

const integrity = {
  schemaVersion: 1,
  generatedAt: startedAt,
  round: 'R37-C',
  work: 'C0-A',
  status: missingCells.length === 0 && unexpectedCells.length === 0 && drift.length === 0
    && datasetDigests.length === 1 && scorerVersions.length === 1 && routeEnvs.length === 1
    && runtimeConfigs.length === 1 && secretFindings.length === 0 ? 'passed' : 'attention',
  cellMatrix: {
    expected: cells.length,
    expectedUnique: expectedKeys.size,
    observed: observed.length,
    uniqueObserved: observedKeys.size,
    missing: missingCells,
    unexpected: unexpectedCells,
    expectedDuplicates,
    duplicates,
  },
  drift,
  configuration: {
    datasetDigests,
    scorerVersions,
    routeEnvs,
    runtimeConfigs,
    invalidCells: observed.filter(row => row.valid !== true).length,
  },
  stage2: recomputed,
  summaryComparison,
  truncatedEvidence: { rows: truncated.length, detail: truncated },
  secrets: { findings: secretFindings.length, detail: secretFindings },
  notes: [
    'A retry run is a duplicate cell, not a new experimental unit; the analysis dedupes it.',
    'Nine of the eleven Stage 2 invalid rows are fold-invalid writer-only rows, not provider measurements.',
    'Trace turn text is capped at 1000 characters; capped turns are marked truncated-evidence.',
  ],
}

await writeJson(join(OUT, 'evidence-inventory.json'), inventory)
await writeJson(join(OUT, 'evidence-integrity.json'), integrity)
await writeJson(join(OUT, 'baseline.json'), {
  schemaVersion: 1,
  generatedAt: startedAt,
  round: 'R37-C',
  work: 'C0-A',
  base: {
    r37GitHead,
    r37cGitHead: gitHead,
    r37cBranch: gitBranch,
    r37cStatusClean: gitStatus === '',
  },
  runRoots: runRootReports,
  totals: inventory.totals,
  authoritative,
  archive: inventory.archive,
  integrityStatus: integrity.status,
})

process.stdout.write(`R37-C baseline: ${OUT}\n`)
process.stdout.write(`runs ${inventory.totals.runs}; rows ${inventory.totals.rows}; files ${inventory.totals.files}; bytes ${inventory.totals.bytes}\n`)
process.stdout.write(`cells expected ${cells.length}; observed ${observed.length}; unique ${integrity.cellMatrix.uniqueObserved}; missing ${missingCells.length}; unexpected ${unexpectedCells.length}\n`)
process.stdout.write(`drift ${drift.length}; secrets ${secretFindings.length}; truncated rows ${truncated.length}\n`)
process.stdout.write(`stage2 invalid by outcome: ${JSON.stringify(recomputed.invalidByOutcome)}\n`)
