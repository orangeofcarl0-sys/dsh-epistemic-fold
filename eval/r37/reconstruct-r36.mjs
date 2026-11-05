#!/usr/bin/env node
/**
 * Reconstruct the R36 B1/S/O1/O2 runs from their persisted reports and traces.
 *
 * R36's aggregate JSON is treated as a claim to be checked, not as evidence.
 * The reconstruction reads the report row and the trace/workspace bytes, then
 * recomputes the 12 pair outcomes with its own rules. A difference is written
 * to `r36-evidence-discrepancies.json`; the R36 report is never edited.
 *
 * No provider request is made.
 *
 * @module eval/r37/reconstruct-r36
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import {
  actualDelivery,
  digestText,
  factFunnel,
  firstObservableFailure,
  outcomeClass,
  pairOutcome,
  renderedContext,
  replayToolTurns,
} from './src/evidence.mjs'
import {
  digestOf,
  exists,
  readJson,
  sha256File,
  treeManifest,
  writeJson,
} from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R36 = process.env.R36_WORKTREE === undefined
  ? resolve(ROOT, '..', 'ef-r36-interface')
  : resolve(process.env.R36_WORKTREE)
const RUNS = join(R36, 'eval', 'r36', 'runs')
const OUT = join(HERE, 'out', 'r36-evidence-reconstruction.json')
const DISCREPANCIES = join(HERE, 'out', 'r36-evidence-discrepancies.json')
const AUTHORITATIVE = join(R36, 'eval', 'r36', 'out', 'causal-comparison.json')
const CASES = ['A1', 'B2', 'C1', 'D1', 'F1', 'H1']
const relR36 = path => relative(R36, path).split(sep).join('/')
const relRoot = path => relative(ROOT, path).split(sep).join('/')
const REPLICATES = [
  { replicateId: 'r1', prefix: 'r36-causal-' },
  { replicateId: 'r2', prefix: 'r36-causal-r2-' },
]

function contentTreeDigest(files) {
  const entries = {}
  for (const [path, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    entries[path] = digestText(content)
  }
  return digestOf(entries)
}

async function verificationArtifact(workspaceRoot) {
  const path = join(workspaceRoot, 'verification.json')
  if (!await exists(path)) return null
  const text = await readFile(path, 'utf8')
  let parsed = null
  let parseError = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }
  return { path: relR36(path), sha256: digestText(text), bytes: text.length, parsed, parseError }}

async function journalProof(armRoot, packetIds) {
  const root = join(armRoot, 'journal')
  if (!await exists(root)) return null
  const tree = await treeManifest(root)
  const files = Object.keys(tree.files)
  const proofs = packetIds.map(packetId => {
    const packet = files.find(file => file.endsWith(`/${packetId}.json`))
    const receipt = files.find(file => file.endsWith(`/${packetId}.receipt.json`))
    return {
      packetId,
      packetFile: packet ?? null,
      packetSha256: packet === undefined ? null : tree.files[packet],
      receiptFile: receipt ?? null,
      receiptSha256: receipt === undefined ? null : tree.files[receipt],
    }
  })
  return { digest: tree.digest, fileCount: tree.fileCount, proofs }
}

async function bundleProof(armRoot) {
  const root = join(armRoot, 'bundles')
  if (!await exists(root)) return null
  const tree = await treeManifest(root)
  return { digest: tree.digest, fileCount: tree.fileCount, files: tree.files }
}

function integrity(row, trace, checkpointDigest, workspaceReport, verification) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  add('report-row-arm', typeof row.arm === 'string', row.arm)
  add('trace-arm', trace.arm === row.arm, `${trace.arm} vs ${row.arm}`)
  add('trace-case', trace.caseId === row.caseId, `${trace.caseId} vs ${row.caseId}`)
  add('checkpoint-digest', row.checkpoint?.digest === checkpointDigest,
    `${row.checkpoint?.digest} vs ${checkpointDigest}`)
  add('rendered-checkpoint-digest',
    row.writer?.renderedCheckpointDigest === undefined
      || row.writer.renderedCheckpointDigest === checkpointDigest,
    `${row.writer?.renderedCheckpointDigest} vs ${checkpointDigest}`)
  add('state-digest', row.state?.stateDigest === trace.state?.stateDigest,
    `${row.state?.stateDigest} vs ${trace.state?.stateDigest}`)
  add('writer-state-digest',
    row.writer?.stateDigest === undefined || row.writer.stateDigest === trace.state?.stateDigest,
    `${row.writer?.stateDigest} vs ${trace.state?.stateDigest}`)
  add('writer-raw-digest',
    trace.writerRaw === null
      || row.writer?.rawOutputDigest === trace.writerRawDigest,
    `${row.writer?.rawOutputDigest} vs ${trace.writerRawDigest}`)
  add('writer-raw-chars',
    trace.writerRaw === null || String(trace.writerRaw).length === trace.writerRawChars,
    `${String(trace.writerRaw ?? '').length} vs ${trace.writerRawChars}`)
  add('verification-artifact', true, verification === null
    ? 'absent'
    : verification.parseError ?? 'valid JSON')
  add('workspace-files', workspaceReport.fileCount > 0, String(workspaceReport.fileCount))
  return checks
}

function pairAnalysis({ baseline, treatment, rows, caseData }) {
  const contractOutcome = pairOutcome(baseline, treatment, row => row.outcome.contractSuccess)
  const taskOutcome = pairOutcome(baseline, treatment, row => row.outcome.taskSuccess)
  const confounds = []
  if (baseline.actualDelivery === 'full-history-fallback' || treatment.actualDelivery === 'full-history-fallback') {
    confounds.push({
      kind: 'fallback-delivery',
      detail: 'at least one arm continued on the full transcript, not a semantic checkpoint',
    })
  }
  if ((baseline.actualDelivery === 'unknown' || treatment.actualDelivery === 'unknown'
    || baseline.actualDelivery === 'commit-missing' || treatment.actualDelivery === 'commit-missing')) {
    confounds.push({ kind: 'unknown-delivery', detail: 'actual delivered context is not fully determined' })
  }
  if (caseData.id === 'A1') {
    const failed = [...(baseline.outcome.failedChecks ?? []), ...(treatment.outcome.failedChecks ?? [])]
    if (failed.includes('constraint.legacy-string-api')) {
      confounds.push({
        kind: 'task-gold-ambiguity',
        detail: 'the hidden string-form retries:2 requirement is absent from the task text and visible tests',
      })
    }
  }
  if (caseData.id === 'B2') {
    const protocol = rows.some(row => (row.failure?.candidates ?? [])
      .some(candidate => candidate.kind === 'tool-parameter-loss' || candidate.kind === 'tool-parameter-corruption'))
    if (protocol) {
      confounds.push({
        kind: 'tool-protocol',
        detail: 'the S write was parsed with a missing or escape-corrupted content parameter',
      })
    }
  }
  if (caseData.id === 'D1' && rows.some(row => row.workspace?.verificationJson === null)) {
    confounds.push({
      kind: 'verification-artifact-process',
      detail: 'verification.json was not written by at least one arm; both arms failed the same checker',
    })
  }
  if (baseline.outcome.contractSuccess === true && treatment.outcome.contractSuccess === true) {
    confounds.push({ kind: 'ceiling', detail: 'both arms reached contract success; no discrimination' })
  }
  let memoryAttribution = 'none'
  let attributionNote = 'the pair is confounded or uninformative for memory'
  if (confounds.length === 0 && treatment.actualDelivery === 'semantic-committed'
    && baseline.outcome.contractSuccess !== true && treatment.outcome.contractSuccess === true) {
    memoryAttribution = 'candidate'
    attributionNote = 'only the S arm received the semantic checkpoint and it reached contract success; n=1'
  } else if (confounds.length === 0) {
    memoryAttribution = 'unresolved'
    attributionNote = 'no confound was identified, but this single pair does not identify a memory effect'
  }
  return {
    contractOutcome,
    taskOutcome,
    memoryAttribution,
    attributionNote,
    confounds,
    baselineDelivery: baseline.actualDelivery,
    treatmentDelivery: treatment.actualDelivery,
  }
}

const causal = await readJson(AUTHORITATIVE)
const caseData = {}
for (const id of CASES) caseData[id] = await loadCase(id)

const runs = []
const rowsByRun = []
for (const replicate of REPLICATES) {
  for (const caseId of CASES) {
    const runId = `${replicate.prefix}${caseId}`
    const reportPath = join(RUNS, runId, 'report.json')
    if (!await exists(reportPath)) {
      rowsByRun.push({ runId, caseId, replicateId: replicate.replicateId, missing: true })
      continue
    }
    const report = await readJson(reportPath)
    const rows = []
    for (const arm of ['B1', 'S', 'O1', 'O2']) {
      const row = report.rows.find(candidate => candidate.arm === arm)
      if (row === undefined) {
        rowsByRun.push({
          runId,
          caseId,
          replicateId: replicate.replicateId,
          arm,
          notInReport: true,
          note: replicate.replicateId === 'r2'
            ? 'the r2 causal run selected B1 and S only; O1/O2 were not executed in this replicate'
            : 'the arm is absent from the report',
        })
        continue
      }
      const armRoot = join(RUNS, runId, caseId, arm, row.replicateId ?? 'r1')
      const tracePath = join(armRoot, 'trace', 'record.json')
      const trace = await exists(tracePath) ? await readJson(tracePath) : null
      if (trace === null) {
        rowsByRun.push({ runId, caseId, replicateId: replicate.replicateId, arm, missingTrace: true })
        continue
      }
      const checkpoint = String(trace.checkpoint ?? '')
      const checkpointDigest = digestText(checkpoint)
      const renderedMessage = `${renderedContext(arm, caseData[caseId], checkpoint)}\n\nBEGIN THE TASK.`
      const workspaceRoot = join(armRoot, 'workspace')
      const workspaceReport = await treeManifest(workspaceRoot)
      const verification = await verificationArtifact(workspaceRoot)
      const replay = replayToolTurns(trace)
      const escapedContentFiles = []
      for (const relativePath of Object.keys(workspaceReport.files)) {
        if (!/\.(mjs|cjs|js|ts|json)$/u.test(relativePath)) continue
        const text = await readFile(join(workspaceRoot, relativePath), 'utf8').catch(() => '')
        if (text.includes('\\`') || text.includes('\\${')) escapedContentFiles.push(relativePath)
      }
      const workspace = {
        root: relR36(workspaceRoot),
        initialDigest: contentTreeDigest(caseData[caseId].workspace.files),
        finalDigest: workspaceReport.digest,
        fileCount: workspaceReport.fileCount,
        files: workspaceReport.files,
        verificationJson: verification,
        escapedContentFiles,
        changed: contentTreeDigest(caseData[caseId].workspace.files) !== workspaceReport.digest,
      }
      const delivery = actualDelivery(row)
      const outcome = outcomeClass(row)
      const funnel = factFunnel(caseData[caseId], row, trace)
      const failure = row.behaviour?.contractSuccess === true
        ? null
        : firstObservableFailure({ caseData: caseData[caseId], row, trace, replay, workspace })
      const checks = integrity(row, trace, checkpointDigest, workspaceReport, verification)
      const packetIds = (row.state?.validationStatuses ?? []).map(entry => entry.packetId)
      const reconstructed = {
        runId,
        caseId,
        replicateId: replicate.replicateId,
        runnerReplicateId: row.replicateId ?? null,
        arm,
        assignedArm: arm,
        actualDelivery: delivery,
        valid: row.valid === true,
        outcome: {
          taskSuccess: row.behaviour?.taskSuccess === true,
          functionalSuccess: row.behaviour?.functionalSuccess === true,
          historicalConstraintCompliance: row.behaviour?.historicalConstraintCompliance === true,
          processCompliance: row.behaviour?.processCompliance === true,
          contractSuccess: row.behaviour?.contractSuccess === true,
          failedChecks: row.behaviour?.failedChecks ?? [],
          processViolation: row.behaviour?.processViolation === true,
          falseVerificationClaim: row.behaviour?.falseVerificationClaim === true,
          classification: outcome.classification,
          actionConsistency: outcome.actionConsistency,
        },
        deliveryEvidence: {
          fold: row.fold ?? null,
          foldFallback: row.foldFallback ?? null,
          commits: row.state?.commits ?? null,
          validationStatuses: row.state?.validationStatuses ?? [],
          checkpointDigest,
          stateDigest: row.state?.stateDigest ?? null,
          writerCommitStatus: row.writer?.commitStatus ?? null,
          writerProtocol: row.writer?.protocol ?? null,
        },
        context: {
          source: arm === 'O2' ? 'oracle-gold-facts' : 'trace.checkpoint',
          bodyDigest: checkpointDigest,
          bodyChars: checkpoint.length,
          bodyTruncatedInTrace: false,
          renderedMessageDigest: digestText(renderedMessage),
          renderedMessageChars: renderedMessage.length,
          note: arm === 'O2'
            ? 'the harness rendered the gold-facts block plus the task; the trace checkpoint is not that block'
            : 'the trace stores the complete checkpoint body; the task and BEGIN THE TASK marker are appended by the harness',
        },
        workspace,
        verification: {
          testsExecuted: row.behaviourDetail?.testsExecuted ?? 0,
          testRuns: row.behaviourDetail?.verificationFreshness?.testRuns ?? [],
          lastPassingTest: row.behaviourDetail?.verificationFreshness?.lastPassingTest ?? null,
          verifiedCurrentCode: row.behaviourDetail?.verificationFreshness?.verifiedCurrentCode === true,
          finalStatus: row.behaviour?.finalVerificationStatus ?? null,
          basis: row.behaviour?.verificationBasis ?? null,
          artifact: verification,
        },
        tool: {
          replay,
          reported: row.behaviourDetail?.harness ?? null,
          finishGuard: row.behaviourDetail?.finishGuard ?? null,
          steps: row.behaviourDetail?.steps ?? null,
          finished: row.behaviourDetail?.finished === true,
          summary: row.behaviourDetail?.summary ?? null,
        },
        writer: {
          call: row.writer?.call ?? null,
          protocol: row.writer?.protocol ?? null,
          commitStatus: row.writer?.commitStatus ?? null,
          accepted: row.writer?.accepted ?? 0,
          refused: row.writer?.refused ?? 0,
          rawDigest: trace.writerRawDigest ?? null,
          rawChars: trace.writerRawChars ?? null,
          rawTruncated: trace.writerRawTruncated === true,
          acceptedDeltaIds: (trace.writer?.acceptedDeltas ?? []).map(delta => delta.deltaId),
        },
        journal: await journalProof(armRoot, packetIds),
        bundles: await bundleProof(armRoot),
        funnel,
        failure,
        integrity: {
          ok: checks.every(check => check.ok),
          checks,
        },
        refs: {
          report: relR36(reportPath),
          trace: relR36(tracePath),
          workspace: relR36(workspaceRoot),
          journal: relR36(join(armRoot, 'journal')),
          bundles: relR36(join(armRoot, 'bundles')),
          case: relRoot(join(ROOT, 'eval', 'r33', 'cases', caseId)),
        },
      }
      rows.push(reconstructed)
      runs.push(reconstructed)
    }
    rowsByRun.push({
      runId,
      caseId,
      replicateId: replicate.replicateId,
      report: reportPath,
      generatedAt: report.generatedAt,
      arms: rows.map(row => row.arm),
      rows,
    })
  }
}

const pairs = []
for (const run of rowsByRun.filter(entry => Array.isArray(entry.rows))) {
  const baseline = run.rows.find(row => row.arm === 'B1')
  const treatment = run.rows.find(row => row.arm === 'S')
  if (baseline === undefined || treatment === undefined) {
    pairs.push({
      caseId: run.caseId,
      replicateId: run.replicateId,
      runId: run.runId,
      valid: false,
      reason: 'B1 or S row missing',
    })
    continue
  }
  const analysis = pairAnalysis({
    baseline,
    treatment,
    rows: run.rows,
    caseData: caseData[run.caseId],
  })
  pairs.push({
    caseId: run.caseId,
    replicateId: run.replicateId,
    runId: run.runId,
    valid: baseline.valid && treatment.valid,
    baseline: {
      contractSuccess: baseline.outcome.contractSuccess,
      taskSuccess: baseline.outcome.taskSuccess,
      delivery: baseline.actualDelivery,
      classification: baseline.outcome.classification,
      failedChecks: baseline.outcome.failedChecks,
    },
    treatment: {
      contractSuccess: treatment.outcome.contractSuccess,
      taskSuccess: treatment.outcome.taskSuccess,
      delivery: treatment.actualDelivery,
      classification: treatment.outcome.classification,
      failedChecks: treatment.outcome.failedChecks,
      firstFailure: treatment.failure?.first ?? null,
      sufficientCause: treatment.failure?.sufficientCause ?? null,
    },
    ...analysis,
  })
}

const count = (list, key, value) => list.filter(entry => entry[key] === value).length
const validPairs = pairs.filter(pair => pair.valid === true)
const contract = {
  pairs: validPairs.length,
  rescue: count(validPairs, 'contractOutcome', 'rescue'),
  damage: count(validPairs, 'contractOutcome', 'damage'),
  both: count(validPairs, 'contractOutcome', 'both'),
  neither: count(validPairs, 'contractOutcome', 'neither'),
  invalid: pairs.filter(pair => pair.valid !== true).length,
}
const task = {
  pairs: validPairs.length,
  rescue: count(validPairs, 'taskOutcome', 'rescue'),
  damage: count(validPairs, 'taskOutcome', 'damage'),
  both: count(validPairs, 'taskOutcome', 'both'),
  neither: count(validPairs, 'taskOutcome', 'neither'),
}
const byReplicate = REPLICATES.map(({ replicateId }) => {
  const rows = validPairs.filter(pair => pair.replicateId === replicateId)
  return {
    replicateId,
    pairs: rows.length,
    rescue: count(rows, 'contractOutcome', 'rescue'),
    damage: count(rows, 'contractOutcome', 'damage'),
    both: count(rows, 'contractOutcome', 'both'),
    neither: count(rows, 'contractOutcome', 'neither'),
  }
})
const byCase = CASES.map(caseId => {
  const rows = validPairs.filter(pair => pair.caseId === caseId)
  return {
    caseId,
    pairs: rows.length,
    contract: {
      rescue: count(rows, 'contractOutcome', 'rescue'),
      damage: count(rows, 'contractOutcome', 'damage'),
      both: count(rows, 'contractOutcome', 'both'),
      neither: count(rows, 'contractOutcome', 'neither'),
    },
    task: {
      rescue: count(rows, 'taskOutcome', 'rescue'),
      damage: count(rows, 'taskOutcome', 'damage'),
      both: count(rows, 'taskOutcome', 'both'),
      neither: count(rows, 'taskOutcome', 'neither'),
    },
    confounds: [...new Set(rows.flatMap(row => row.confounds.map(entry => entry.kind)))].sort(),
  }
})
const deliveryCounts = {}
for (const row of runs) {
  const key = `${row.arm}:${row.actualDelivery}`
  deliveryCounts[key] = (deliveryCounts[key] ?? 0) + 1
}
const failureClasses = {}
for (const row of runs) {
  const key = row.failure?.sufficientCause?.kind ?? (row.outcome.contractSuccess ? 'none' : 'unattributed')
  failureClasses[key] = (failureClasses[key] ?? 0) + 1
}
const funnelTotals = (() => {
  const applicable = runs.filter(row => row.arm === 'S' && row.funnel.applicable)
  const sum = key => applicable.reduce((total, row) => total + (row.funnel[key] ?? 0), 0)
  const denominator = applicable.reduce((total, row) => total + row.funnel.denominator, 0)
  return {
    rows: applicable.length,
    factDenominator: denominator,
    sourceVisible: sum('sourceVisible'),
    writerMentioned: sum('writerMentioned'),
    proposed: sum('proposed'),
    accepted: sum('accepted'),
    committed: sum('committed'),
    rendered: sum('rendered'),
    recall: denominator === 0 ? null : {
      source: sum('sourceVisible') / denominator,
      writerMentioned: sum('writerMentioned') / denominator,
      accepted: sum('accepted') / denominator,
      committed: sum('committed') / denominator,
      rendered: sum('rendered') / denominator,
    },
  }
})()

const reconstruction = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    r36Worktree: relRoot(R36),
    authoritativeReport: relR36(AUTHORITATIVE),
    authoritativeSha256: await sha256File(AUTHORITATIVE),
    reports: rowsByRun.filter(entry => typeof entry.report === 'string').map(entry => relR36(entry.report)),
    note: 'Report rows and trace/workspace bytes are read directly. The R36 aggregate is used only for the discrepancy check.',
  },
  cases: CASES,
  replicates: REPLICATES.map(entry => entry.replicateId),
  runs,
  pairs,
  summary: {
    contract,
    task,
    byReplicate,
    byCase,
    deliveryCounts,
    failureClasses,
    funnel: funnelTotals,
    integrity: {
      rows: runs.length,
      ok: runs.filter(row => row.integrity.ok).length,
      failed: runs.filter(row => !row.integrity.ok).length,
    },
  },
  evidenceNotes: runs
    .filter(row => row.workspace.verificationJson !== null
      && row.workspace.verificationJson.parseError !== null)
    .map(row => ({
      runId: row.runId,
      arm: row.arm,
      kind: 'verification-artifact-parse-error',
      detail: row.workspace.verificationJson.parseError,
      bytes: row.workspace.verificationJson.bytes,
    })),
  note: 'Action consistency is a checker-and-observable-action classification. It is not evidence that the model understood or forgot a fact.',
}
await writeJson(OUT, reconstruction)

const discrepancies = []
const compare = (path, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    discrepancies.push({ kind: 'r36-summary-mismatch', path, actual, expected })
  }
}
for (const key of ['pairs', 'rescue', 'damage', 'both', 'neither', 'invalid']) {
  compare(`contract.${key}`, contract[key], causal.contract?.[key])
}
for (const key of ['pairs', 'rescue', 'damage', 'both', 'neither']) {
  compare(`task.${key}`, task[key], causal.task?.[key])
}
for (const replicate of byReplicate) {
  const expected = causal.byReplicate?.find(entry => entry.replicateId === replicate.replicateId)
  if (expected !== undefined) {
    for (const key of ['pairs', 'rescue', 'damage', 'both', 'neither']) {
      compare(`byReplicate.${replicate.replicateId}.${key}`, replicate[key], expected[key])
    }
  }
}
for (const caseRow of byCase) {
  const expected = causal.byCase?.find(entry => entry.caseId === caseRow.caseId)
  if (expected !== undefined) {
    for (const key of ['rescue', 'damage', 'both', 'neither']) {
      compare(`byCase.${caseRow.caseId}.contract.${key}`, caseRow.contract[key], expected.contract?.[key])
      compare(`byCase.${caseRow.caseId}.task.${key}`, caseRow.task[key], expected.task?.[key])
    }
  }
}
for (const row of runs) {
  for (const check of row.integrity.checks.filter(entry => !entry.ok)) {
    discrepancies.push({
      kind: 'evidence-integrity',
      runId: row.runId,
      arm: row.arm,
      check: check.name,
      detail: check.detail,
    })
  }
}
const notes = rowsByRun
  .filter(entry => entry.notInReport === true)
  .map(entry => ({
    kind: 'arm-not-run',
    runId: entry.runId,
    caseId: entry.caseId,
    replicateId: entry.replicateId,
    arm: entry.arm,
    note: entry.note,
  }))

const discrepancyReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: discrepancies.length === 0 ? 'no-discrepancy' : 'discrepancy',
  r36Authoritative: {
    path: AUTHORITATIVE,
    sha256: await sha256File(AUTHORITATIVE),
    contract: causal.contract,
    task: causal.task,
    byReplicate: causal.byReplicate,
    byCase: causal.byCase,
  },
  reconstructed: { contract, task, byReplicate, byCase },
  discrepancies,
  notes,
  note: discrepancies.length === 0
    ? 'The R36 pair counts reproduce from the report rows and trace bytes. This is a reproduction, not a new result.'
    : 'R36 was not edited. Each difference is listed with its source; no value was adjusted to match the expected count.',
}
await writeJson(DISCREPANCIES, discrepancyReport)

process.stdout.write(`reconstruction: ${OUT}\n`)
process.stdout.write(`contract: ${JSON.stringify(contract)}\n`)
process.stdout.write(`task: ${JSON.stringify(task)}\n`)
for (const replicate of byReplicate) process.stdout.write(`${replicate.replicateId}: ${JSON.stringify(replicate)}\n`)
for (const caseRow of byCase) {
  process.stdout.write(`${caseRow.caseId}: contract ${JSON.stringify(caseRow.contract)} confounds=${caseRow.confounds.join(',') || '-'}\n`)
}
process.stdout.write(`delivery: ${JSON.stringify(deliveryCounts)}\n`)
process.stdout.write(`failure classes: ${JSON.stringify(failureClasses)}\n`)
process.stdout.write(`funnel: ${JSON.stringify(funnelTotals.recall)}\n`)
process.stdout.write(`integrity: ${reconstruction.summary.integrity.ok}/${runs.length} rows ok\n`)
process.stdout.write(`discrepancies: ${discrepancies.length} (${discrepancyReport.status})\n`)
