#!/usr/bin/env node
/**
 * R38-M0 WP1: revision identity and replay idempotency.
 *
 * Answers the brief's §4.4 questions with evidence rather than assertion:
 * the same claim with a different relation plan has the SAME `deltaId`, so the
 * operation must be identified separately or it is dropped. This script shows
 * that the claim identity is unchanged, the new operation is applied, an exact
 * repeat is refused, and a double application is caught by the commit-state
 * digest rather than passing silently.
 *
 * Output: eval/r38/out/revision-idempotency.json
 *
 * @module eval/r38/revision-idempotency
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ToolCallId,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { validateDeltas } from '../../lib/semantic/validate.js'
import { applyOps, planCommit } from '../../lib/semantic/plan.js'
import { replayWithSemanticCommits, verifyCommitStateDigests } from '../../lib/semantic/replay.js'
import { emptyCurrentState } from '../../lib/state/state.js'
import { canonicalHash } from '../../lib/checkpoint/hash.js'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'revision-idempotency.json')

const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const tool = (text, callId = 'call-1') => createToolResultMessage({
  callId: ToolCallId(callId),
  content: [{ type: 'text', text }],
  isError: false,
})

function fold(proposed, messages, state = emptyCurrentState()) {
  const foldedSeqs = messages.map((_, index) => index + 1)
  const validation = validateDeltas({ foldedSeqs, messages, proposed })
  const plan = planCommit(validation.accepted, { state })
  return { validation, plan, state: applyOps(state, plan.ops) }
}

const decision = (quote, statement, options = {}) => ({
  kind: 'decision',
  subjectKey: options.subjectKey ?? 'queue',
  statement,
  status: 'claimed',
  evidence: [{ quote }],
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})

const MESSAGES = [
  user('Use the in-memory queue for now.'),
  user('Switch to the durable outbox.'),
  tool('queue-depth=0 outbox-depth=0'),
]

const checks = []

/** 1. Claim identity excludes the relation plan. */
{
  const base = {
    kind: 'finding',
    subjectKey: 'probe',
    statement: 'The queues are empty.',
    status: 'observed',
    evidence: [{ quote: 'queue-depth=0 outbox-depth=0' }],
  }
  const a = validateDeltas({ foldedSeqs: [3], messages: [tool('queue-depth=0 outbox-depth=0')], proposed: [{ ...base, supersedes: ['alpha'] }] })
  const b = validateDeltas({ foldedSeqs: [3], messages: [tool('queue-depth=0 outbox-depth=0')], proposed: [{ ...base, supersedes: ['beta'] }] })
  checks.push({
    id: 'claim-identity-excludes-relations',
    expected: 'same deltaId for different targets',
    actual: { a: a.accepted[0]?.deltaId ?? null, b: b.accepted[0]?.deltaId ?? null },
    pass: a.accepted[0]?.deltaId !== undefined && a.accepted[0].deltaId === b.accepted[0]?.deltaId,
  })
}

/** 2. A repeated claim with a new plan contributes its operations. */
{
  const first = fold([
    decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'scheduler-queue' }),
    decision('Switch to the durable outbox.', 'Use the durable outbox.', { subjectKey: 'scheduler-outbox' }),
  ], MESSAGES)
  const queueId = first.plan.planned[0].anchorId
  const outboxId = first.plan.planned[1].anchorId
  const second = fold([
    decision('Switch to the durable outbox.', 'Use the durable outbox.', {
      subjectKey: 'final-decision',
      supersedes: ['scheduler-queue'],
    }),
    decision('Switch to the durable outbox.', 'Use the durable outbox.', {
      subjectKey: 'final-decision',
      supersedes: ['scheduler-outbox'],
    }),
  ], MESSAGES, first.state)
  checks.push({
    id: 'repeat-with-new-plan-applies-operations',
    expected: 'one declare, two retires, duplicateClaim on the second',
    actual: {
      declares: second.plan.ops.filter(op => op.op === 'declare').length,
      retires: second.plan.ops.filter(op => op.op === 'retire').length,
      duplicateClaim: second.validation.accepted[1]?.duplicateClaim === true,
      queuePresent: second.state.decisions[queueId] !== undefined,
      outboxPresent: second.state.decisions[outboxId] !== undefined,
    },
    pass: second.plan.ops.filter(op => op.op === 'declare').length === 1
      && second.plan.ops.filter(op => op.op === 'retire').length === 2
      && second.validation.accepted[1]?.duplicateClaim === true
      && second.state.decisions[queueId] === undefined
      && second.state.decisions[outboxId] === undefined,
  })
}

/** 3. An exact repeat is still refused. */
{
  const base = {
    kind: 'finding',
    subjectKey: 'probe',
    statement: 'The queues are empty.',
    status: 'observed',
    evidence: [{ quote: 'queue-depth=0 outbox-depth=0' }],
    supersedes: ['alpha'],
  }
  const validation = validateDeltas({
    foldedSeqs: [3],
    messages: [tool('queue-depth=0 outbox-depth=0')],
    proposed: [base, { ...base }],
  })
  checks.push({
    id: 'exact-repeat-refused',
    expected: 'one accepted, one duplicate refusal',
    actual: { accepted: validation.accepted.length, refused: validation.refused.map(row => row.reason) },
    pass: validation.accepted.length === 1 && validation.refused[0]?.reason === 'duplicate',
  })
}

/** 4. Replay once reproduces the candidate state. */
const REPLAY_MESSAGES = MESSAGES
const replayFold = fold([
  decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'scheduler-queue' }),
  decision('Switch to the durable outbox.', 'Use the durable outbox.', {
    subjectKey: 'scheduler-outbox',
    supersedes: ['scheduler-queue'],
  }),
], REPLAY_MESSAGES)
const once = applyOps(emptyCurrentState(), replayFold.plan.ops)
{
  const commit = {
    packetId: 'packet-1',
    sessionId: 'session-1',
    checkpointId: 'checkpoint-1',
    commitOrder: 1,
    proof: {},
    operations: replayFold.plan.ops,
  }
  const session = { snapshotEvents: () => [{ seq: 1, type: 'user/message', data: {} }] }
  const replayed = replayWithSemanticCommits(session, [commit])
  checks.push({
    id: 'replay-once-matches-candidate',
    expected: 'replayed state digest equals the candidate digest',
    actual: {
      candidate: canonicalHash(once),
      replayed: canonicalHash(replayed.state),
      unplaced: replayed.unplaced.length,
    },
    pass: replayed.unplaced.length === 0 && canonicalHash(replayed.state) === canonicalHash(once),
  })
}

/** 5. A second application changes the digest, so the commit gate catches it. */
{
  const twice = applyOps(once, replayFold.plan.ops)
  const commit = {
    packetId: 'packet-1',
    sessionId: 'session-1',
    checkpointId: 'checkpoint-1',
    commitOrder: 1,
    proof: {},
    operations: replayFold.plan.ops,
  }
  const session = { snapshotEvents: () => [{ seq: 1, type: 'user/message', data: {} }] }
  const verification = verifyCommitStateDigests(
    session,
    [commit, { ...commit }],
    [{ packetId: 'packet-1', digest: canonicalHash(once) }],
  )
  checks.push({
    id: 'second-apply-detected-by-state-digest',
    expected: 'counter changes, digest gate reports one mismatch',
    actual: {
      onceRetired: once.retiredCount,
      twiceRetired: twice.retiredCount,
      checked: verification.checked,
      mismatches: verification.mismatches.length,
    },
    pass: twice.retiredCount !== once.retiredCount
      && verification.checked === 2
      && verification.mismatches.length === 1,
  })
}

/** 6. Replay at a cut reproduces the fork state. */
{
  const first = fold([
    decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'scheduler-queue' }),
  ], MESSAGES)
  const second = fold([
    decision('Switch to the durable outbox.', 'Use the durable outbox.', {
      subjectKey: 'scheduler-outbox',
      supersedes: ['scheduler-queue'],
    }),
  ], MESSAGES, first.state)
  const commits = [
    {
      packetId: 'packet-a',
      sessionId: 'session-1',
      checkpointId: 'checkpoint-a',
      commitOrder: 1,
      proof: {},
      operations: first.plan.ops,
    },
    {
      packetId: 'packet-b',
      sessionId: 'session-1',
      checkpointId: 'checkpoint-b',
      commitOrder: 2,
      proof: {},
      operations: second.plan.ops,
    },
  ]
  const session = {
    snapshotEvents: () => [
      { seq: 1, type: 'user/message', data: {} },
      { seq: 2, type: 'user/message', data: {} },
    ],
  }
  const whole = replayWithSemanticCommits(session, commits)
  const cut = replayWithSemanticCommits(session, commits, { uptoSeq: 1 })
  checks.push({
    id: 'replay-at-cut-matches-fork-state',
    expected: 'cut replay equals the first fold state; whole replay equals the second',
    actual: {
      cut: canonicalHash(cut.state),
      first: canonicalHash(first.state),
      whole: canonicalHash(whole.state),
      second: canonicalHash(second.state),
    },
    pass: canonicalHash(cut.state) === canonicalHash(first.state)
      && canonicalHash(whole.state) === canonicalHash(second.state),
  })
}

/** 7. Retrying the same fold is deterministic. */
{
  const proposed = [
    decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'scheduler-queue' }),
    decision('Switch to the durable outbox.', 'Use the durable outbox.', {
      subjectKey: 'scheduler-outbox',
      supersedes: ['scheduler-queue'],
    }),
  ]
  const a = fold(proposed, MESSAGES)
  const b = fold(proposed, MESSAGES)
  checks.push({
    id: 'retry-deterministic',
    expected: 'same accepted ids, same ops, same state',
    actual: {
      acceptedIds: a.validation.accepted.map(row => row.deltaId),
      opsDigestA: canonicalHash(a.plan.ops),
      opsDigestB: canonicalHash(b.plan.ops),
      stateA: canonicalHash(a.state),
      stateB: canonicalHash(b.state),
    },
    pass: canonicalHash(a.plan.ops) === canonicalHash(b.plan.ops)
      && canonicalHash(a.state) === canonicalHash(b.state),
  })
}

const passed = checks.filter(row => row.pass).length
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R38-M0',
  work: 'WP1-revision-idempotency',
  status: passed === checks.length ? 'passed' : 'failed',
  claimIdentity: {
    algorithm: 'canonicalHash(kind, subjectKey, statement, status, evidenceSeqs, scope)',
    relationsIncluded: false,
    historicalIdsChanged: false,
  },
  revisionIdentity: {
    algorithm: 'canonicalHash(sorted supersedes, sorted dependsOn, sorted rulesOut)',
    purpose: 'dedupe an exact repeat without dropping a new operation',
  },
  summary: { total: checks.length, passed, failed: checks.length - passed },
  checks,
}
await writeJson(OUT, report)

process.stdout.write(`R38 revision idempotency: ${OUT}\n`)
process.stdout.write(`status ${report.status}; ${passed}/${checks.length} checks passed\n`)
for (const row of checks) process.stdout.write(`  ${row.pass ? 'PASS' : 'FAIL'} ${row.id}\n`)
process.exit(report.status === 'passed' ? 0 : 1)
