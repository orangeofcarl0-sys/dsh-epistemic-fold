#!/usr/bin/env node
/**
 * R37-D WP0: audit the R37-C state before any R37-D code is written.
 *
 * This script never writes into the R37-C worktree. It reads:
 *
 *   the real R37-C git objects (branch, head, commit chain, diff stat)
 *   the immutable R37-B evidence archive (bytes + SHA-256)
 *   the 24 frozen C2 manifests (sha256 + field agreement)
 *   the 24 C2 report.json files (raw rows, not the R37-C aggregate)
 *   the 24 C2 trace records
 *   the R37-C analysis and trajectory artifacts
 *   the native smoke source and its installed package versions
 *
 * and recomputes the headline counts independently. A mismatch becomes a
 * `discrepancy`, never a silently corrected number.
 *
 * Outputs:
 *   eval/r37d/out/baseline.json
 *   eval/r37d/out/r37c-audit.json
 *
 * @module eval/r37d/audit-r37c
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

const R37C = process.env.R37C_WORKTREE ?? 'F:/Codex_Work_Space/DSH plugin/ef-r37c-closure'
const R37B = process.env.R37B_WORKTREE ?? 'F:/Codex_Work_Space/DSH plugin/ef-r37-action'
const ARCHIVE = process.env.R37B_ARCHIVE
  ?? 'F:/Codex_Work_Space/DSH plugin/ef-r37c-evidence-archive/r37b-raw-evidence-20261106.tar.gz'

const EXPECTED = {
  r37cBranch: 'rc37c-measurement-closure',
  r37cHead: '045cccf275132ffda8c76a9fbdc8620338af6164',
  r37bHead: '5ef67814a4ec8fd8bcca362b89ad338acd0a8ae0',
  archiveSha256: 'de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92',
  archiveBytes: 3_763_962,
  cells: 24,
  contractSuccesses: 19,
  taskSuccesses: 22,
  finishRequests: 13,
  guardTriggered: 4,
  guardAssisted: 1,
  contractFailures: 5,
  contractFailuresNoFinish: 5,
}

const discrepancies = []

function discrepancy(area, detail) {
  discrepancies.push({ area, detail })
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 1. Git baseline
// ---------------------------------------------------------------------------

const baseline = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP0-baseline',
  repository: {
    root: REPO,
    branch: git(['branch', '--show-current'], REPO),
    head: git(['rev-parse', 'HEAD'], REPO),
    status: git(['status', '--porcelain'], REPO),
  },
  r37c: {
    worktree: R37C,
    branch: git(['branch', '--show-current'], R37C),
    head: git(['rev-parse', 'HEAD'], R37C),
    status: git(['status', '--porcelain'], R37C),
    base: EXPECTED.r37bHead,
    commits: git(['log', '--format=%H%x09%s', `${EXPECTED.r37bHead}..HEAD`], R37C)
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha, subject] = line.split('\t')
        return { sha, subject }
      }),
  },
  r37b: {
    worktree: R37B,
    branch: git(['branch', '--show-current'], R37B),
    head: git(['rev-parse', 'HEAD'], R37B),
    status: git(['status', '--porcelain'], R37B),
  },
  archive: null,
  evidence: null,
}

const numstat = git(['diff', '--numstat', `${EXPECTED.r37bHead}..HEAD`], R37C)
  .split('\n')
  .filter(Boolean)
  .map(line => {
    const [insertions, deletions, path] = line.split('\t')
    return { path, insertions: Number(insertions), deletions: Number(deletions) }
  })
baseline.r37c.diff = {
  files: numstat.length,
  insertions: numstat.reduce((sum, entry) => sum + entry.insertions, 0),
  deletions: numstat.reduce((sum, entry) => sum + entry.deletions, 0),
}
baseline.r37c.diffCheck = git(['diff', '--check', `${EXPECTED.r37bHead}..HEAD`], R37C)

baseline.r37c.worktrees = git(['worktree', 'list', '--porcelain'], REPO)
  .split('\n\n')
  .filter(Boolean)
  .map(block => Object.fromEntries(
    block.split('\n').map(line => {
      const index = line.indexOf(' ')
      return index === -1 ? [line, true] : [line.slice(0, index), line.slice(index + 1)]
    }),
  ))

if (baseline.r37c.branch !== EXPECTED.r37cBranch) {
  discrepancy('git', `R37-C branch is ${baseline.r37c.branch}, expected ${EXPECTED.r37cBranch}`)
}
if (baseline.r37c.head !== EXPECTED.r37cHead) {
  discrepancy('git', `R37-C head is ${baseline.r37c.head}, expected ${EXPECTED.r37cHead}`)
}
if (baseline.r37b.head !== EXPECTED.r37bHead) {
  discrepancy('git', `R37-B head is ${baseline.r37b.head}, expected ${EXPECTED.r37bHead}`)
}
if (baseline.r37b.status !== '') {
  discrepancy('git', 'R37-B worktree is not clean')
}
if (baseline.r37c.diffCheck !== '') {
  discrepancy('git', 'git diff --check reported whitespace errors')
}

// ---------------------------------------------------------------------------
// 2. Evidence archive and R37-C integrity artifact
// ---------------------------------------------------------------------------

if (await exists(ARCHIVE)) {
  const info = await stat(ARCHIVE)
  const digest = await sha256(ARCHIVE)
  baseline.archive = {
    path: ARCHIVE,
    bytes: info.size,
    sha256: digest,
    bytesMatch: info.size === EXPECTED.archiveBytes,
    sha256Match: digest === EXPECTED.archiveSha256,
  }
  if (!baseline.archive.bytesMatch) {
    discrepancy('archive', `archive is ${info.size} bytes, expected ${EXPECTED.archiveBytes}`)
  }
  if (!baseline.archive.sha256Match) {
    discrepancy('archive', `archive sha256 is ${digest}, expected ${EXPECTED.archiveSha256}`)
  }
} else {
  baseline.archive = { path: ARCHIVE, missing: true }
  discrepancy('archive', 'evidence archive is missing')
}

const integrityPath = join(R37C, 'eval', 'r37c', 'out', 'evidence-integrity.json')
const inventoryPath = join(R37C, 'eval', 'r37c', 'out', 'evidence-inventory.json')
baseline.evidence = {
  integrity: await exists(integrityPath) ? await readJson(integrityPath) : null,
  inventory: await exists(inventoryPath) ? await readJson(inventoryPath) : null,
}
if (baseline.evidence.integrity?.status !== 'passed') {
  discrepancy('evidence', 'R37-C evidence-integrity status is not passed')
}

// ---------------------------------------------------------------------------
// 3. C2 manifests: frozen, unique, and agreeing with the results
// ---------------------------------------------------------------------------

const manifestsDir = join(R37C, 'eval', 'r37c', 'manifests-c2')
const manifestFiles = (await exists(manifestsDir))
  ? (await readdir(manifestsDir)).filter(name => name.endsWith('.json')).sort()
  : []
const manifests = []
for (const name of manifestFiles) {
  const path = join(manifestsDir, name)
  const manifest = await readJson(path)
  manifests.push({
    file: name,
    sha256: await sha256(path),
    manifest,
  })
}

const resultsPath = join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-results.json')
const c2 = await readJson(resultsPath)
const resultsByRun = new Map(c2.results.map(entry => [entry.runId, entry]))

const manifestChecks = []
for (const { file, sha256: digest, manifest } of manifests) {
  const result = resultsByRun.get(manifest.runId)
  const problems = []
  if (result === undefined) problems.push('no result row for manifest runId')
  else {
    if (result.cell.caseId !== manifest.cases) problems.push('case mismatch')
    if (result.cell.arm !== manifest.arms) problems.push('arm mismatch')
    if (result.cell.replicateId !== manifest.replicateId) problems.push('replicate mismatch')
    if (result.cell.finishGuard !== manifest.finishGuard) problems.push('guard mismatch')
    if (manifest.toolProtocol !== 'P3s') problems.push(`protocol ${manifest.toolProtocol}`)
    if (manifest.followUpSteps !== 8) problems.push(`steps ${manifest.followUpSteps}`)
    if (manifest.followUpMaxTokens !== 1024) problems.push(`follow-up output ${manifest.followUpMaxTokens}`)
    if (manifest.runtime !== 'custom-json-loop') problems.push(`runtime ${manifest.runtime}`)
    if (manifest.harnessVersion !== 'H-protocol-s') problems.push(`harness ${manifest.harnessVersion}`)
    if (manifest.model !== c2.model) problems.push('model drift')
    if (typeof manifest.route?.baseUrlEnv !== 'string') problems.push('manifest has no baseUrlEnv')
    if (typeof manifest.route?.apiKeyEnv !== 'string') problems.push('manifest has no apiKeyEnv')
    if (typeof c2.route?.baseUrl !== 'string' || c2.route.baseUrl === '') {
      problems.push('result route has no resolved baseUrl')
    }
  }
  if (problems.length > 0) {
    discrepancy('manifest', `${file}: ${problems.join(', ')}`)
  }
  manifestChecks.push({
    file,
    runId: manifest.runId,
    sha256: digest,
    caseId: manifest.cases,
    arm: manifest.arms,
    guard: manifest.finishGuard,
    replicateId: manifest.replicateId,
    toolProtocol: manifest.toolProtocol,
    followUpSteps: manifest.followUpSteps,
    followUpMaxTokens: manifest.followUpMaxTokens,
    problems,
  })
}

const uniqueManifestRuns = new Set(manifests.map(entry => entry.manifest.runId))
if (manifests.length !== EXPECTED.cells) {
  discrepancy('manifest', `${manifests.length} manifests, expected ${EXPECTED.cells}`)
}
if (uniqueManifestRuns.size !== manifests.length) {
  discrepancy('manifest', 'duplicate manifest runId')
}

// ---------------------------------------------------------------------------
// 4. Recompute the C2 aggregates from the raw reports
// ---------------------------------------------------------------------------

const cells = []
for (const entry of c2.results) {
  if (entry.status !== 'executed') {
    discrepancy('c2', `${entry.runId} status is ${entry.status}`)
    continue
  }
  if (!(await exists(entry.reportPath))) {
    discrepancy('c2', `${entry.runId} report is missing`)
    continue
  }
  const report = await readJson(entry.reportPath)
  const row = report.rows?.[0]
  if (row === undefined) {
    discrepancy('c2', `${entry.runId} report has no row`)
    continue
  }
  const detail = row.behaviourDetail ?? {}
  const guard = detail.finishGuard ?? {}
  const harness = detail.harness ?? {}
  const behaviour = row.behaviour ?? {}
  const base = join(
    dirname(entry.reportPath),
    entry.cell.caseId,
    entry.cell.arm,
    entry.cell.replicateId,
  )
  const tracePath = join(base, 'trace', 'record.json')
  const workspacePath = join(base, 'workspace')
  const verificationPath = join(workspacePath, 'verification.json')
  let verificationArtifact = null
  if (await exists(verificationPath)) {
    try {
      verificationArtifact = await readJson(verificationPath)
    } catch {
      verificationArtifact = { parseError: true }
    }
  }
  const testRuns = Array.isArray(detail.testRuns) ? detail.testRuns : []
  const lastTest = testRuns.length === 0 ? null : testRuns[testRuns.length - 1]
  const lastPassingTest = detail.verificationFreshness?.lastPassingTest ?? null
  const verifiedCurrentCode = detail.verificationFreshness?.verifiedCurrentCode === true
  const finishRequests = guard.finishRequests ?? 0
  const finishRejections = guard.rejections ?? 0

  if (guard.enabled !== entry.cell.finishGuard) {
    discrepancy('c2', `${entry.runId} report guard ${guard.enabled} != manifest ${entry.cell.finishGuard}`)
  }
  if (harness.toolProtocol !== 'P3s') {
    discrepancy('c2', `${entry.runId} tool protocol ${harness.toolProtocol}`)
  }
  if (harness.maxSteps !== 8) {
    discrepancy('c2', `${entry.runId} maxSteps ${harness.maxSteps}`)
  }
  if (harness.maxTokens !== 1024) {
    discrepancy('c2', `${entry.runId} follow-up output ${harness.maxTokens}`)
  }
  if ((detail.modelCalls ?? 0) < (detail.steps ?? 0)) {
    discrepancy('c2', `${entry.runId} modelCalls < steps`)
  }

  cells.push({
    runId: entry.runId,
    cellId: entry.cell.cellId,
    caseId: entry.cell.caseId,
    arm: entry.cell.arm,
    guard: entry.cell.guard,
    finishGuard: entry.cell.finishGuard,
    replicateId: entry.cell.replicateId,
    contract: behaviour.contractSuccess === true,
    task: behaviour.taskSuccess === true,
    failedChecks: behaviour.failedChecks ?? [],
    testsExecuted: detail.testsExecuted ?? 0,
    steps: detail.steps ?? 0,
    modelCalls: detail.modelCalls ?? 0,
    finishRequests,
    finishRejections,
    guardAssisted: guard.assistedCompletion === true,
    validActions: harness.validActions ?? 0,
    rejectedActions: harness.rejectedActions ?? 0,
    invalidActions: harness.invalidActions ?? 0,
    truncatedTurns: harness.truncatedTurns ?? 0,
    finishReasonCounts: harness.finishReasonCounts ?? {},
    toolCounts: harness.toolCounts ?? {},
    stepLimitTermination: harness.stepLimitTermination === true,
    providerFailure: harness.providerFailure ?? null,
    delivery: detail.delivery ?? entry.delivery ?? null,
    finalVerificationStatus: behaviour.finalVerificationStatus ?? null,
    verifiedCurrentCode,
    lastPassingTest: lastPassingTest === null ? null : {
      step: lastPassingTest.step,
      digest: lastPassingTest.digest,
    },
    lastTest: lastTest === null ? null : {
      passed: lastTest.passed === true,
      exitCode: lastTest.exitCode,
      digest: lastTest.digest,
    },
    verificationArtifact: verificationArtifact === null ? null : {
      claim: verificationArtifact.claim ?? null,
      testsRun: verificationArtifact.testsRun ?? null,
      testsPassed: verificationArtifact.testsPassed ?? null,
      parseError: verificationArtifact.parseError === true,
    },
    tracePresent: await exists(tracePath),
    workspacePresent: await exists(workspacePath),
    reportPath: entry.reportPath,
  })
}

if (cells.length !== EXPECTED.cells) {
  discrepancy('c2', `${cells.length} executable cells, expected ${EXPECTED.cells}`)
}

const cellKeys = new Set(cells.map(cell => `${cell.caseId}/${cell.arm}/${cell.guard}/${cell.replicateId}`))
if (cellKeys.size !== cells.length) {
  discrepancy('c2', 'duplicate cell key in the raw reports')
}

const conditionCounts = {}
for (const cell of cells) {
  const key = `${cell.caseId}/${cell.arm}/${cell.guard}`
  conditionCounts[key] = (conditionCounts[key] ?? 0) + 1
}
for (const [key, count] of Object.entries(conditionCounts)) {
  if (count !== 3) discrepancy('c2', `${key} has ${count} replicates, expected 3`)
}

const summary = {
  cells: cells.length,
  contractSuccesses: cells.filter(cell => cell.contract).length,
  taskSuccesses: cells.filter(cell => cell.task).length,
  finishRequests: cells.filter(cell => cell.finishRequests > 0).length,
  noFinishRequests: cells.filter(cell => cell.finishRequests === 0).length,
  guardTriggered: cells.filter(cell => cell.finishRejections > 0).length,
  guardAssisted: cells.filter(cell => cell.guardAssisted).length,
  contractFailures: cells.filter(cell => !cell.contract).length,
  contractFailuresNoFinish: cells.filter(cell => !cell.contract && cell.finishRequests === 0).length,
  contractFailuresGuardTriggered: cells.filter(cell => !cell.contract && cell.finishRejections > 0).length,
  tracesPresent: cells.filter(cell => cell.tracePresent).length,
  workspacesPresent: cells.filter(cell => cell.workspacePresent).length,
  totalModelCalls: cells.reduce((sum, cell) => sum + cell.modelCalls, 0),
  totalSteps: cells.reduce((sum, cell) => sum + cell.steps, 0),
  totalTests: cells.reduce((sum, cell) => sum + cell.testsExecuted, 0),
  totalRejectedActions: cells.reduce((sum, cell) => sum + cell.rejectedActions, 0),
  totalInvalidTurns: cells.reduce((sum, cell) => sum + cell.invalidActions, 0),
  providerFailures: cells.filter(cell => cell.providerFailure !== null).length,
}

for (const key of [
  'cells',
  'contractSuccesses',
  'taskSuccesses',
  'finishRequests',
  'guardTriggered',
  'guardAssisted',
  'contractFailures',
  'contractFailuresNoFinish',
]) {
  if (summary[key] !== EXPECTED[key]) {
    discrepancy('c2', `${key} is ${summary[key]}, expected ${EXPECTED[key]}`)
  }
}

// The legacy scorer does not require a fresh passing test. Count how often that
// gap matters in the C2 sample; WP1 turns this into a separate metric.
const legacyContractWithoutFreshVerification = cells.filter(cell => cell.contract && !cell.verifiedCurrentCode)
const legacyContractWithoutAnyPassingTest = cells.filter(cell => cell.contract && cell.lastPassingTest === null)
const legacyContractWithFailedLastTest = cells.filter(cell => cell.contract
  && cell.lastTest !== null
  && cell.lastTest.passed === false)

// Cross-check the R37-C aggregate artifacts.
const analysisPath = join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-analysis.json')
const trajectoriesPath = join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-trajectories.json')
const analysis = await exists(analysisPath) ? await readJson(analysisPath) : null
const trajectories = await exists(trajectoriesPath) ? await readJson(trajectoriesPath) : null
const aggregateAgreement = {
  analysisPresent: analysis !== null,
  trajectoriesPresent: trajectories !== null,
  analysisContract: analysis?.byArmGuard ?? null,
  trajectorySummary: trajectories?.summary ?? null,
  trajectoryArchetypes: trajectories?.byArchetype ?? null,
  agrees: trajectories?.summary?.contractSuccesses === summary.contractSuccesses
    && trajectories?.summary?.taskSuccesses === summary.taskSuccesses
    && trajectories?.summary?.finishRequests === summary.finishRequests
    && trajectories?.summary?.guardTriggered === summary.guardTriggered
    && trajectories?.summary?.contractFailures === summary.contractFailures
    && trajectories?.summary?.contractFailuresNoFinish === summary.contractFailuresNoFinish,
}
if (!aggregateAgreement.agrees) {
  discrepancy('c2', 'R37-C trajectory aggregate does not match the raw reports')
}

// ---------------------------------------------------------------------------
// 5. Metric basis and native smoke provenance
// ---------------------------------------------------------------------------

const funnelPath = join(R37C, 'eval', 'r37c', 'out', 'semantic-funnel-audit.json')
const funnel = await exists(funnelPath) ? await readJson(funnelPath) : null
const metricBasis = {
  funnelPresent: funnel !== null,
  journalProof: funnel?.overall?.journalProof ?? null,
  commitStatus: funnel?.overall?.commitStatus ?? null,
  committedStage: funnel?.overall?.funnel?.byStage?.committed ?? null,
  sourceHashes: {},
}
for (const relative of [
  'eval/r37c/src/semantic-funnel.mjs',
  'eval/r37c/src/journal-state.mjs',
  'eval/r37c/audit-semantic-funnel.mjs',
]) {
  const path = join(R37C, relative)
  metricBasis.sourceHashes[relative] = await exists(path) ? await sha256(path) : null
}
if (funnel === null) discrepancy('metric', 'semantic funnel artifact is missing')
if (funnel !== null && (funnel.overall?.journalProof?.valid ?? 0) === 0) {
  discrepancy('metric', 'no committed row has a journal proof')
}

const nativeSourcePath = join(R37C, 'eval', 'r37c', 'native-smoke.mjs')
const nativeSource = await exists(nativeSourcePath) ? await readFile(nativeSourcePath, 'utf8') : ''
const nativeArtifactPath = join(R37C, 'eval', 'r37c', 'out', 'native-smoke.json')
const nativeArtifact = await exists(nativeArtifactPath) ? await readJson(nativeArtifactPath) : null
const packageVersions = {}
for (const name of [
  'dsh-agent',
  'dsh-agent-loop',
  'dsh-tools',
  'dsh-session',
  'dsh-llm',
  'dsh-compaction',
  'dsh-session-persistence-jsonl',
]) {
  const path = join(R37C, 'node_modules', '@deepseek-ai', name, 'package.json')
  packageVersions[name] = await exists(path) ? (await readJson(path)).version : null
}
const native = {
  artifactPresent: nativeArtifact !== null,
  statuses: {
    n0: nativeArtifact?.n0?.status ?? null,
    n1: nativeArtifact?.n1?.status ?? null,
    n2: nativeArtifact?.n2?.status ?? null,
  },
  sourceSha256: nativeSource === '' ? null : createHash('sha256').update(nativeSource).digest('hex'),
  importsRealLoop: nativeSource.includes("from '@deepseek-ai/dsh-agent-loop'"),
  importsRealTools: nativeSource.includes("from '@deepseek-ai/dsh-tools'"),
  importsRealSession: nativeSource.includes("from '@deepseek-ai/dsh-session'"),
  importsRealPersistence: nativeSource.includes("from '@deepseek-ai/dsh-session-persistence-jsonl'"),
  usesVolatile: nativeSource.includes('createVolatile(1)'),
  packageVersions,
}
if (nativeArtifact === null) {
  discrepancy('native', 'native smoke artifact is missing')
}
for (const phase of ['n0', 'n1', 'n2']) {
  if (native.statuses[phase] !== 'passed') {
    discrepancy('native', `${phase} is ${native.statuses[phase]}, expected passed`)
  }
}
if (!native.importsRealLoop || !native.importsRealTools || !native.importsRealSession) {
  discrepancy('native', 'native smoke does not import the real DSH runtime packages')
}

// ---------------------------------------------------------------------------
// 6. Write the artifacts
// ---------------------------------------------------------------------------

const passed = discrepancies.length === 0
baseline.status = passed ? 'passed' : 'attention'
baseline.discrepancies = discrepancies
await writeFile(join(OUT, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')

const audit = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP0-r37c-audit',
  status: passed ? 'passed' : 'attention',
  source: {
    r37cHead: baseline.r37c.head,
    r37cBase: baseline.r37c.base,
    archive: baseline.archive,
  },
  expected: EXPECTED,
  manifests: {
    count: manifests.length,
    unique: uniqueManifestRuns.size,
    checks: manifestChecks,
  },
  c2: {
    summary,
    conditions: conditionCounts,
    cells,
  },
  legacyCompletionGap: {
    legacyContractSuccesses: summary.contractSuccesses,
    contractWithoutFreshVerification: legacyContractWithoutFreshVerification.length,
    contractWithoutAnyPassingTest: legacyContractWithoutAnyPassingTest.length,
    contractWithFailedLastTest: legacyContractWithFailedLastTest.length,
    cells: legacyContractWithoutFreshVerification.map(cell => ({
      cellId: cell.cellId,
      testsExecuted: cell.testsExecuted,
      lastTestPassed: cell.lastTest?.passed ?? null,
      lastPassingTest: cell.lastPassingTest !== null,
      verifiedCurrentCode: cell.verifiedCurrentCode,
      finalVerificationStatus: cell.finalVerificationStatus,
      verificationArtifact: cell.verificationArtifact,
      finishRequests: cell.finishRequests,
    })),
  },
  aggregateAgreement,
  metricBasis,
  native,
  discrepancies,
  notes: [
    'The raw reports are read from the R37-C worktree by absolute path; the R37-C worktree is never modified.',
    'A legacy contract success does not imply a fresh passing test on the final source.',
    'Trace records are capped at 1,000 characters per turn; per-turn accounting in WP2 must label that limit.',
  ],
}
await writeFile(join(OUT, 'r37c-audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8')

process.stdout.write(`R37-D WP0 baseline: ${join(OUT, 'baseline.json')}\n`)
process.stdout.write(`R37-D WP0 audit:    ${join(OUT, 'r37c-audit.json')}\n`)
process.stdout.write(`git ${baseline.r37c.branch}@${baseline.r37c.head.slice(0, 7)}; `
  + `diff ${baseline.r37c.diff.files} files +${baseline.r37c.diff.insertions}/-${baseline.r37c.diff.deletions}\n`)
process.stdout.write(`archive ${baseline.archive?.sha256?.slice(0, 12) ?? 'missing'}…; `
  + `bytes ${baseline.archive?.bytes ?? 'n/a'}\n`)
process.stdout.write(`C2 ${summary.cells} cells; contract ${summary.contractSuccesses}; task ${summary.taskSuccesses}; `
  + `finish ${summary.finishRequests}; guard ${summary.guardTriggered}; failures ${summary.contractFailures} `
  + `(no finish ${summary.contractFailuresNoFinish})\n`)
process.stdout.write(`legacy contract without fresh verification: ${legacyContractWithoutFreshVerification.length}; `
  + `without any passing test: ${legacyContractWithoutAnyPassingTest.length}; `
  + `with a failed last test: ${legacyContractWithFailedLastTest.length}\n`)
process.stdout.write(`discrepancies: ${discrepancies.length}\n`)
process.exit(passed ? 0 : 1)
