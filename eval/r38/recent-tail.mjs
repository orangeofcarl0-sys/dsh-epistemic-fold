#!/usr/bin/env node
/**
 * R38-M0 WP5: recent-tail consistency cases.
 *
 * Each case is a projected state at semantic watermark 10 and a raw tail after
 * it. The assessment says which anchors may no longer be current, which are
 * safe, and why. It never writes the tail into state.
 *
 * Output: eval/r38/out/recent-tail-consistency.json
 *
 * @module eval/r38/recent-tail
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { emptyCurrentState, stateKeyText } from '../../src/state/state.ts'
import { canonicalHash } from '../../src/checkpoint/hash.ts'
import { assessRecentTail } from './src/recent-tail.ts'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'recent-tail-consistency.json')

function makeAnchor(options) {
  const anchorKind = options.semanticKind === 'finding' ? 'evidence' : options.semanticKind
  return {
    id: options.id,
    kind: anchorKind,
    stateKey: { namespace: 'semantic', entity: options.semanticKind, property: options.property },
    value: options.value,
    authority: options.authority,
    lifecycle: 'active',
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    sourceRefs: [{ seq: options.seq }],
  }
}

function stateWith(anchors) {
  const state = emptyCurrentState()
  for (const anchor of anchors) {
    state.stateHeads[stateKeyText(anchor.stateKey)] = anchor
    if (anchor.kind === 'decision') state.decisions[anchor.id] = anchor
    if (anchor.kind === 'evidence') state.evidence[anchor.id] = anchor
    if (anchor.kind === 'constraint') state.constraints[anchor.id] = anchor
  }
  return state
}

const ANCHORS = [
  makeAnchor({
    id: 'queue', semanticKind: 'decision', property: 'scheduler-queue',
    value: 'Use the in-memory queue.', authority: 'decision', seq: 10,
  }),
  makeAnchor({
    id: 'release', semanticKind: 'constraint', property: 'release-gate',
    value: 'Production deploys require a signed release.', authority: 'normative', seq: 10,
  }),
  makeAnchor({
    id: 'depth', semanticKind: 'finding', property: 'queue-depth',
    value: 'The scheduler queue depth is zero.', authority: 'empirical', seq: 10,
  }),
  makeAnchor({
    id: 'repo-a-gate', semanticKind: 'constraint', property: 'deploy-gate',
    value: 'Repository A deploys require a signed release.', authority: 'normative', seq: 10,
    scope: { workspace: 'repo-a' },
  }),
]

const REQUEST = 'Use the durable outbox for scheduler dispatch.'

const snapshot = (overrides = {}) => ({
  semanticCommitWatermark: 10,
  sessionEventWatermark: 12,
  archiveRevision: 'cp-1',
  taskFrameRevision: 'tf-1',
  ...overrides,
})

function runCase(caseData) {
  const state = stateWith(caseData.anchors ?? ANCHORS)
  const assessment = assessRecentTail({
    state,
    events: caseData.events,
    snapshot: caseData.snapshot ?? snapshot(),
    currentRequest: caseData.request ?? REQUEST,
  })
  const byAnchor = new Map(assessment.anchors.map(row => [row.anchorId, row]))
  return {
    id: caseData.id,
    description: caseData.description,
    snapshot: assessment.snapshot,
    frameStale: assessment.frameStale,
    snapshotDigest: assessment.snapshotDigest,
    anchors: assessment.anchors,
    safeAnchorIds: assessment.safeAnchorIds,
    unsafeAnchorIds: assessment.unsafeAnchorIds,
    warnings: assessment.warnings,
    verdictOf: Object.fromEntries([...byAnchor].map(([id, row]) => [id, row.verdict])),
  }
}

export function runCases() {
  const cases = []

  cases.push(runCase({
    id: 'no-tail-update',
    description: 'no event after the commit watermark; every anchor is safe',
    events: [],
  }))

  cases.push(runCase({
    id: 'explicit-user-revision',
    description: 'a later user message shares the subject and carries a revision cue',
    events: [{
      seq: 12,
      role: 'user',
      text: 'Switch the scheduler queue to the durable outbox instead.',
    }],
  }))

  cases.push(runCase({
    id: 'weak-task-signal',
    description: 'a later user message is task-relevant but shares no subject with the anchor',
    events: [{
      seq: 12,
      role: 'user',
      text: 'Approve the durable outbox for scheduler dispatch.',
    }],
  }))

  cases.push(runCase({
    id: 'tool-observation',
    description: 'a tool observation cannot revoke a constraint; it may update a finding',
    events: [{
      seq: 12,
      role: 'tool',
      text: 'Production deploy probe returned 200; the signed release was not checked. '
        + 'The scheduler queue depth is zero.',
    }],
  }))

  cases.push(runCase({
    id: 'assistant-hypothesis',
    description: 'an assistant proposal cannot override a user constraint',
    events: [{
      seq: 12,
      role: 'assistant',
      text: 'I think production deploys can skip the signed release.',
    }],
  }))

  cases.push(runCase({
    id: 'different-scope',
    description: 'a later user message in another workspace is not a conflict',
    events: [{
      seq: 12,
      role: 'user',
      text: 'Repo B deploys require a different gate.',
      scope: { workspace: 'repo-b' },
    }],
  }))

  cases.push(runCase({
    id: 'concurrent-advancement',
    description: 'the session advanced past the frame watermark',
    events: [{
      seq: 14,
      role: 'user',
      text: 'Approve the durable outbox for scheduler dispatch.',
    }],
    snapshot: snapshot({ sessionEventWatermark: 8 }),
  }))

  cases.push(runCase({
    id: 'no-evidence',
    description: 'an unrelated later event produces no warning',
    events: [{
      seq: 12,
      role: 'user',
      text: 'The logging format is ISO 8601.',
    }],
  }))

  return cases
}

/** Determinism: the same state, tail and snapshot give the same digest. */
export function runDeterminism() {
  const events = [{
    seq: 12,
    role: 'user',
    text: 'Switch the scheduler queue to the durable outbox instead.',
  }]
  const first = assessRecentTail({ state: stateWith(ANCHORS), events, snapshot: snapshot(), currentRequest: REQUEST })
  const second = assessRecentTail({ state: stateWith(ANCHORS), events, snapshot: snapshot(), currentRequest: REQUEST })
  const reordered = assessRecentTail({
    state: stateWith([...ANCHORS].reverse()),
    events,
    snapshot: snapshot(),
    currentRequest: REQUEST,
  })
  return {
    first: first.snapshotDigest,
    second: second.snapshotDigest,
    reordered: reordered.snapshotDigest,
    stable: first.snapshotDigest === second.snapshotDigest && first.snapshotDigest === reordered.snapshotDigest,
  }
}

async function main() {
  const rows = runCases()
  const byId = new Map(rows.map(row => [row.id, row]))
  const determinism = runDeterminism()
  const checks = [
    {
      id: 'no-tail-no-warning',
      pass: byId.get('no-tail-update')?.warnings.length === 0
        && byId.get('no-tail-update')?.unsafeAnchorIds.length === 0,
    },
    {
      id: 'explicit-user-revision-detected',
      pass: byId.get('explicit-user-revision')?.verdictOf.queue === 'superseded-by-user'
        && byId.get('explicit-user-revision')?.unsafeAnchorIds.includes('queue') === true,
    },
    {
      id: 'weak-signal-is-not-a-revision',
      pass: byId.get('weak-task-signal')?.verdictOf.queue === 'requires-reconciliation'
        && byId.get('weak-task-signal')?.unsafeAnchorIds.includes('queue') === true,
    },
    {
      id: 'tool-cannot-revoke-normative',
      pass: byId.get('tool-observation')?.verdictOf.release === 'no-effect'
        && byId.get('tool-observation')?.verdictOf.depth === 'requires-reconciliation',
    },
    {
      id: 'assistant-cannot-override-user',
      pass: byId.get('assistant-hypothesis')?.verdictOf.release === 'no-effect'
        && byId.get('assistant-hypothesis')?.unsafeAnchorIds.includes('release') === false,
    },
    {
      id: 'different-scope-not-a-conflict',
      pass: byId.get('different-scope')?.verdictOf['repo-a-gate'] === 'scope-different'
        && byId.get('different-scope')?.unsafeAnchorIds.length === 0,
    },
    {
      id: 'stale-frame-reported',
      pass: byId.get('concurrent-advancement')?.frameStale === true
        && (byId.get('concurrent-advancement')?.warnings ?? []).some(line => line.startsWith('frame-stale')),
    },
    {
      id: 'no-false-warning',
      pass: byId.get('no-evidence')?.warnings.length === 0,
    },
    {
      id: 'restart-deterministic',
      pass: determinism.stable,
    },
  ]
  const passed = checks.filter(check => check.pass).length
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'R38-M0',
    work: 'WP5-recent-tail',
    status: passed === checks.length ? 'passed' : 'failed',
    writesState: false,
    summary: { cases: rows.length, checks: checks.length, passed, failed: checks.length - passed },
    determinism,
    checks,
    cases: rows,
  }
  await writeJson(OUT, report)
  process.stdout.write(`R38 recent-tail consistency: ${OUT}\n`)
  process.stdout.write(`status ${report.status}; ${passed}/${checks.length} checks passed\n`)
  for (const row of rows) {
    process.stdout.write(`  ${row.id}: unsafe ${JSON.stringify(row.unsafeAnchorIds)} staleFrame ${row.frameStale}\n`)
  }
  process.exit(report.status === 'passed' ? 0 : 1)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) await main()
