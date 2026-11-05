#!/usr/bin/env node
/**
 * B2/C1 behavioral forensics and controlled representation fixtures.
 *
 * The forensic part reports observable actions, not inferred mental states:
 * files read, files changed, tests requested, tests observed, the earliest
 * divergence supported by the bytes, and the sufficient cause supported by the
 * checker. The fixture part builds plain/structured/withheld contexts from the
 * original transcript and labels every one as a controlled oracle-facts
 * intervention, never as an EF writer output.
 *
 * No provider request is made.
 *
 * @module eval/r37/forensics
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import { fullHistory } from '../r33/src/context.mjs'
import { sha256, readJson, sha256File, writeJson } from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out', 'forensics.json')
const FIXTURE_INDEX = join(HERE, 'out', 'representation-fixtures.json')
const FIXTURES = join(HERE, 'fixtures')
const RECONSTRUCTION = join(HERE, 'out', 'r36-evidence-reconstruction.json')
const R36 = process.env.R36_WORKTREE === undefined
  ? resolve(ROOT, '..', 'ef-r36-interface')
  : resolve(process.env.R36_WORKTREE)
const RUNS = join(R36, 'eval', 'r36', 'runs')
const relRoot = path => relative(ROOT, path).split(sep).join('/')

function tokenEstimate(text) {
  // A deterministic estimate, not a provider token count. It is labelled as
  // such everywhere it is reported.
  return Math.ceil(String(text ?? '').length / 4)
}

function initialWorkspace(caseData) {
  const files = {}
  for (const [path, content] of Object.entries(caseData.workspace.files)) files[path] = sha256(content)
  return files
}

async function finalWorkspace(row) {
  const files = row.workspace.files
  return { files, digest: row.workspace.finalDigest }
}

function diffWorkspace(initial, finalFiles) {
  const changed = []
  const added = []
  const removed = []
  for (const [path, hash] of Object.entries(finalFiles)) {
    if (initial[path] === undefined) added.push({ path, sha256: hash })
    else if (initial[path] !== hash) changed.push({ path, sha256: hash })
  }
  for (const path of Object.keys(initial)) if (finalFiles[path] === undefined) removed.push(path)
  return { changed, added, removed, modified: changed.length + added.length + removed.length > 0 }
}

function workspaceRootOf(row) {
  return /^[A-Za-z]:[\\/]/u.test(row.workspace.root) || row.workspace.root.startsWith('/')
    ? row.workspace.root
    : join(R36, row.workspace.root)
}

async function readChangedCode(row, diff) {
  const produced = []
  const root = workspaceRootOf(row)
  for (const entry of [...diff.changed, ...diff.added]) {
    if (!/\.(mjs|cjs|js|ts|json)$/u.test(entry.path)) continue
    const text = await readFile(join(root, entry.path), 'utf8').catch(() => null)
    if (text === null) continue
    produced.push({
      path: entry.path,
      sha256: entry.sha256,
      chars: text.length,
      text: text.length <= 4_000 ? text : `${text.slice(0, 4_000)}\n[truncated in report]`,
      truncated: text.length > 4_000,
    })
  }
  return produced
}

function actionPaths(replay, tool) {
  return replay.actions.filter(action => action.tool === tool && action.path !== null).map(action => action.path)
}

function truncationNotes(replay) {
  const notes = []
  if (replay.truncatedSteps.length > 0) {
    notes.push(`trace text is capped at 1000 chars on steps ${replay.truncatedSteps.join(', ')}`)
  }
  if (replay.unclosedInvokeSteps.length > 0) {
    notes.push(`unclosed invoke prefix on steps ${replay.unclosedInvokeSteps.join(', ')}; not classified as a parse failure`)
  }
  return notes
}

function factView(rows, caseData) {
  return rows.map(row => ({
    arm: row.arm,
    delivery: row.actualDelivery,
    checkpointDigest: row.deliveryEvidence.checkpointDigest,
    factVisible: row.funnel.facts.map(fact => ({
      factId: fact.factId,
      rendered: fact.rendered,
      committed: fact.committed,
      accepted: fact.accepted,
    })),
    checkpointChars: row.context.bodyChars,
  }))
}

async function forensicRun(row, caseData, initial) {
  const replay = row.tool.replay
  const diff = diffWorkspace(initial, row.workspace.files)
  return {
    runId: row.runId,
    replicateId: row.replicateId,
    arm: row.arm,
    assignedArm: row.assignedArm,
    actualDelivery: row.actualDelivery,
    fold: row.deliveryEvidence.fold,
    foldFallback: row.deliveryEvidence.foldFallback,
    writer: row.writer,
    factsAvailable: {
      sourceFacts: caseData.gold.map(fact => ({
        factId: fact.factId,
        kind: fact.kind,
        statement: fact.statement,
        authority: fact.sourceRefs.map(ref => caseData.transcript[ref]?.role ?? 'unknown'),
        sourceRefs: fact.sourceRefs,
      })),
      rendered: row.funnel.facts.map(fact => ({ factId: fact.factId, rendered: fact.rendered, committed: fact.committed })),
      checkpointChars: row.context.bodyChars,
      checkpointDigest: row.deliveryEvidence.checkpointDigest,
    },
    instructions: {
      task: caseData.task,
      requiresTests: caseData.requiresTests === true,
      harness: row.tool.reported ?? null,
      finishGuard: row.tool.finishGuard ?? null,
    },
    filesRead: actionPaths(replay, 'read_file'),
    filesModified: diff.changed,
    filesAdded: diff.added,
    filesRemoved: diff.removed,
    workspaceChanged: diff.modified,
    codeProduced: await readChangedCode(row, diff),
    testsRequested: replay.testActions.map(action => action.step),
    testsObserved: {
      testsExecuted: row.verification.testsExecuted,
      testRuns: row.verification.testRuns,
      lastPassingTest: row.verification.lastPassingTest,
      verifiedCurrentCode: row.verification.verifiedCurrentCode,
    },
    verificationArtifact: row.workspace.verificationJson === null
      ? null
      : {
        path: row.workspace.verificationJson.path,
        bytes: row.workspace.verificationJson.bytes,
        parsed: row.workspace.verificationJson.parsed,
        parseError: row.workspace.verificationJson.parseError,
      },
    earliestObservableDivergence: row.failure?.first ?? null,
    sufficientCause: row.failure?.sufficientCause ?? null,
    unresolvedHypotheses: row.failure?.unresolved ?? [],
    outcome: row.outcome,
    traceNotes: truncationNotes(replay),
    evidenceRefs: row.refs,
  }
}

function decisionConsistency(run, caseData, arm) {
  if (!run.workspaceChanged) return 'no-observed-action'
  const text = run.codeProduced.map(entry => entry.text).join('\n')
  if (caseData.id === 'B2') {
    const memory = /mode:\s*['"]memory['"]/u.test(text) || /in-memory/iu.test(text)
    const storageUse = /(import\s+[^\n]*?(sqlite|postgres|redis)|require\(['"](sqlite|postgres|redis)|new\s+[A-Za-z]*?(Outbox|Database))/iu.test(text)
    if (memory && !storageUse) return 'action-consistent'
    if (storageUse) return 'action-inconsistent'
  }
  if (caseData.id === 'C1') {
    const polling = /readdir|setInterval|poll/iu.test(text)
    const watchOnly = /fs\.watch\(/u.test(text) && !polling
    if (polling && !watchOnly) return 'action-consistent'
    if (watchOnly) return 'action-inconsistent'
  }
  return 'unattributed'
}

function classifyRun(run, caseData) {
  if (run.outcome.contractSuccess) return 'contract-success'
  if (run.earliestObservableDivergence?.kind === 'validation-refusal') return 'fold-refusal-then-implementation'
  if (run.earliestObservableDivergence?.kind === 'tool-parameter-corruption'
    || run.earliestObservableDivergence?.kind === 'tool-parameter-loss') return 'harness-protocol'
  if (run.sufficientCause?.kind === 'verification-artifact-missing'
    || run.sufficientCause?.kind === 'verification-artifact-invalid') return 'verification-process'
  if (run.sufficientCause?.kind === 'implementation-failure') return 'implementation-correctness'
  if (run.sufficientCause?.kind === 'action-inconsistent') return 'decision-consistency'
  return 'unattributed'
}

function fixtureBase({ caseId, variant, label, facts, contextText, sourceRefs, authority, scope, superseded, negativeKnowledge }) {
  return {
    schemaVersion: 1,
    fixtureId: `${caseId}-${variant}`,
    caseId,
    variant,
    representationLabel: label,
    label: 'controlled/oracle-facts intervention',
    note: 'This text is constructed by the evaluation from the frozen transcript. It is not an EF writer output and must not be reported as one.',
    criticalFacts: facts,
    contextText,
    tokenEstimate: tokenEstimate(contextText),
    tokenEstimateMethod: 'ceil(chars/4); deterministic estimate, not a provider token count',
    contextDigest: sha256(contextText),
    provenance: {
      sourceRefs,
      authority,
      scope,
      supersededDecisions: superseded ?? [],
      negativeKnowledge: negativeKnowledge ?? [],
    },
  }
}

function semanticEquivalence(left, right, facts) {
  const covered = facts.map(fact => ({
    factId: fact.factId,
    inLeft: left.includes(fact.needle),
    inRight: right.includes(fact.needle),
  }))
  return {
    factIds: facts.map(fact => fact.factId),
    covered,
    equivalent: covered.every(entry => entry.inLeft && entry.inRight),
    note: 'Presence of the same critical fact ids, not proof that a model interprets them identically.',
  }
}

const reconstruction = await readJson(RECONSTRUCTION)
const b2Case = await loadCase('B2')
const c1Case = await loadCase('C1')
const rowsFor = (caseId, arm) => reconstruction.runs.filter(row => row.caseId === caseId && row.arm === arm)
const b2Initial = initialWorkspace(b2Case)
const c1Initial = initialWorkspace(c1Case)

const b2Runs = []
for (const row of rowsFor('B2', 'S')) {
  const run = await forensicRun(row, b2Case, b2Initial)
  run.decisionConsistency = decisionConsistency(run, b2Case, 'S')
  run.classification = classifyRun(run, b2Case)
  b2Runs.push(run)
}
const c1Runs = []
for (const row of rowsFor('C1', 'S')) {
  const run = await forensicRun(row, c1Case, c1Initial)
  run.decisionConsistency = decisionConsistency(run, c1Case, 'S')
  run.classification = classifyRun(run, c1Case)
  c1Runs.push(run)
}
// B1 is retained only as a contrast; it is not the object of the forensic claim.
const b2Baseline = await Promise.all(rowsFor('B2', 'B1').map(row => forensicRun(row, b2Case, b2Initial)))
const c1Baseline = await Promise.all(rowsFor('C1', 'B1').map(row => forensicRun(row, c1Case, c1Initial)))

// B2 controlled representations.
const b2Facts = [
  {
    factId: 'B2-memory',
    needle: 'in-memory queue',
    kind: 'decision',
    subjectKey: 'scheduler-queue',
    statement: 'The scheduler keeps an in-memory queue.',
    authority: 'user',
    sourceRefs: [0, 2],
    scope: { branch: 'scheduler' },
    status: 'claimed',
  },
  {
    factId: 'B2-outbox-rejected',
    needle: 'durable outbox',
    kind: 'rejected-approach',
    subjectKey: 'scheduler-outbox',
    statement: 'A durable outbox is rejected because the storage dependency is unavailable in this deployment.',
    authority: 'user',
    sourceRefs: [2],
    scope: { branch: 'scheduler', deployment: 'current' },
    status: 'claimed',
    rulesOut: ['durable-outbox'],
  },
]
const b2Plain = [
  'The scheduler keeps an in-memory queue.',
  'A durable outbox was rejected because the storage dependency is unavailable in this deployment.',
  'Do not add a storage dependency or retry the rejected outbox without new evidence.',
].join('\n')
const b2Structured = JSON.stringify({
  facts: b2Facts.map(fact => ({
    factId: fact.factId,
    kind: fact.kind,
    subjectKey: fact.subjectKey,
    statement: fact.statement,
    status: fact.status,
    authority: fact.authority,
    sourceRefs: fact.sourceRefs,
    scope: fact.scope,
    ...(fact.rulesOut === undefined ? {} : { rulesOut: fact.rulesOut }),
  })),
}, null, 2)
const b2Fixtures = [
  fixtureBase({
    caseId: 'B2', variant: 'F-P', label: 'plain-language facts', facts: b2Facts,
    contextText: b2Plain, sourceRefs: [0, 2], authority: ['user'], scope: ['scheduler'],
    negativeKnowledge: ['durable outbox rejected: storage dependency unavailable'],
  }),
  fixtureBase({
    caseId: 'B2', variant: 'F-S', label: 'structured semantic facts', facts: b2Facts,
    contextText: b2Structured, sourceRefs: [0, 2], authority: ['user'], scope: ['scheduler'],
    negativeKnowledge: ['durable outbox rejected: storage dependency unavailable'],
  }),
  fixtureBase({
    caseId: 'B2', variant: 'F-N', label: 'critical fact withheld', facts: b2Facts,
    contextText: 'No historical decision is provided for this run.',
    sourceRefs: [0, 2], authority: ['user'], scope: ['scheduler'],
    negativeKnowledge: [],
  }),
]
b2Fixtures[0].semanticEquivalence = semanticEquivalence(b2Plain, b2Structured, b2Facts)
b2Fixtures[1].semanticEquivalence = b2Fixtures[0].semanticEquivalence
b2Fixtures[2].withheldFactIds = b2Facts.map(fact => fact.factId)
b2Fixtures[2].semanticEquivalence = {
  factIds: b2Facts.map(fact => fact.factId),
  covered: b2Facts.map(fact => ({ factId: fact.factId, inLeft: false, inRight: false })),
  equivalent: false,
  note: 'F-N intentionally withholds every critical fact; it is the negative control.',
}

// C1 controlled representations.
const c1Facts = [
  {
    factId: 'C1-fs-watch-rejected',
    needle: 'fs.watch',
    kind: 'rejected-approach',
    subjectKey: 'watcher-backend',
    statement: 'Using fs.watch is rejected: it lost 12 of 40 events on the target platform.',
    authority: 'tool',
    sourceRefs: [2],
    scope: { platform: 'target', backend: 'fs.watch' },
    status: 'observed',
    rulesOut: ['fs.watch'],
  },
  {
    factId: 'C1-no-missed-changes',
    needle: 'must not miss changes',
    kind: 'objective',
    subjectKey: 'watcher-reliability',
    statement: 'The file watcher must not miss changes.',
    authority: 'user',
    sourceRefs: [0],
    scope: { platform: 'target' },
    status: 'claimed',
  },
]
const c1Plain = [
  'The file watcher must not miss changes.',
  'The canary injected 40 events on the target platform; fs.watch delivered 28 and lost 12.',
  'Use directory polling. Do not rely on fs.watch on this platform without new evidence.',
].join('\n')
const c1Structured = JSON.stringify({
  facts: c1Facts.map(fact => ({
    factId: fact.factId,
    kind: fact.kind,
    subjectKey: fact.subjectKey,
    statement: fact.statement,
    status: fact.status,
    authority: fact.authority,
    sourceRefs: fact.sourceRefs,
    scope: fact.scope,
    ...(fact.rulesOut === undefined ? {} : { rulesOut: fact.rulesOut }),
  })),
}, null, 2)
const c1Full = fullHistory(c1Case.transcript)
const c1Fixtures = [
  fixtureBase({
    caseId: 'C1', variant: 'F-H', label: 'full historical context', facts: c1Facts,
    contextText: c1Full, sourceRefs: [0, 2], authority: ['user', 'tool'], scope: ['target platform'],
    negativeKnowledge: ['fs.watch rejected after 12/40 lost events'],
  }),
  fixtureBase({
    caseId: 'C1', variant: 'F-P', label: 'plain-language fact representation', facts: c1Facts,
    contextText: c1Plain, sourceRefs: [0, 2], authority: ['user', 'tool'], scope: ['target platform'],
    negativeKnowledge: ['fs.watch rejected after 12/40 lost events'],
  }),
  fixtureBase({
    caseId: 'C1', variant: 'F-S', label: 'structured semantic representation', facts: c1Facts,
    contextText: c1Structured, sourceRefs: [0, 2], authority: ['user', 'tool'], scope: ['target platform'],
    negativeKnowledge: ['fs.watch rejected after 12/40 lost events'],
  }),
]
for (const fixture of c1Fixtures) {
  fixture.semanticEquivalence = semanticEquivalence(
    fixture.variant === 'F-H' ? c1Full : c1Plain,
    c1Structured,
    c1Facts,
  )
}

for (const fixture of [...b2Fixtures, ...c1Fixtures]) {
  await writeJson(join(FIXTURES, fixture.fixtureId, 'fixture.json'), fixture)
}

const fixtureIndex = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: 'ready',
  label: 'controlled/oracle-facts intervention',
  note: 'These contexts are evaluation fixtures. They are not EF writer outputs and are not live model evidence.',
  fixtures: [...b2Fixtures, ...c1Fixtures].map(fixture => ({
    fixtureId: fixture.fixtureId,
    caseId: fixture.caseId,
    variant: fixture.variant,
    label: fixture.label,
    contextChars: fixture.contextText.length,
    tokenEstimate: fixture.tokenEstimate,
    contextDigest: fixture.contextDigest,
    semanticEquivalence: fixture.semanticEquivalence,
  })),
}
await writeJson(FIXTURE_INDEX, fixtureIndex)

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    reconstruction: relRoot(RECONSTRUCTION),
    reconstructionSha256: await sha256File(RECONSTRUCTION),
    r36Worktree: relRoot(R36),
  },
  cases: {
    B2: {
      transcriptFacts: b2Case.gold,
      runs: b2Runs,
      baselineContrast: b2Baseline,
      conclusion: [
        'r1 S: the checkpoint contained the in-memory decision; the model wrote code that kept it; the stored file failed only because DSML attribute escapes were not decoded. Unescaping the saved file makes the hidden checker pass. This is a harness-protocol failure, not a decision-consistency failure.',
        'r2 S: the checkpoint contained the decision, but the agent read files for eight steps and never wrote or tested. The workspace is byte-identical to the initial workspace. This is an implementation/process failure, not a memory failure.',
      ],
    },
    C1: {
      transcriptFacts: c1Case.gold,
      runs: c1Runs,
      baselineContrast: c1Baseline,
      conclusion: [
        'r1 S: the fold was refused (packet status aborted) and the agent continued on the full transcript. The fact was present in the fallback context. The agent never wrote code and failed the visible behavior. This is a fallback-plus-implementation failure, not a semantic-checkpoint delivery failure.',
        'r2 S: the fold committed with the rejected-approach anchor and the agent wrote a polling watcher that passed. B1 failed without a write. This is the only candidate memory signal in the two cases, and n=1.',
      ],
    },
  },
  fixtures: {
    indexPath: FIXTURE_INDEX,
    cases: {
      B2: b2Fixtures.map(fixture => fixture.fixtureId),
      C1: c1Fixtures.map(fixture => fixture.fixtureId),
    },
    note: 'F-P/F-S are intended to be semantically equivalent; F-N withholds the critical facts; F-H is the full transcript.',
  },
  warnings: [
    'No claim that the model understood or forgot a fact is made from visibility alone.',
    'B2 r1 and r2 both had the fact in the checkpoint; the observed failures differ, so the representation is not a sufficient explanation.',
    'C1 r1 is a fallback run and must not be pooled with semantic-checkpoint delivery.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`forensics: ${OUT}\n`)
for (const caseId of ['B2', 'C1']) {
  process.stdout.write(`${caseId}:\n`)
  for (const run of report.cases[caseId].runs) {
    process.stdout.write(`  ${run.runId} ${run.arm}: delivery=${run.actualDelivery} changed=${run.workspaceChanged} `
      + `tests=${run.testsObserved.testsExecuted} classification=${run.classification} consistency=${run.decisionConsistency} `
      + `first=${run.earliestObservableDivergence?.kind ?? '-'} sufficient=${run.sufficientCause?.kind ?? '-'}\n`)
  }
}
process.stdout.write(`fixtures: ${fixtureIndex.fixtures.map(fixture => fixture.fixtureId).join(', ')}\n`)
