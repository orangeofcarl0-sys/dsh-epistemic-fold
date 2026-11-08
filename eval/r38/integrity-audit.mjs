#!/usr/bin/env node
/**
 * R38-M0 WP2: integrity-audit cases and runner.
 *
 * Builds the permanent regression cases — N5 incomplete and complete revisions,
 * scope separation, retired claims, shared-keyword false positives, a
 * historical unauthorized retirement, a missing source ref, an unresolved
 * dependency and a withheld revision — runs the read-only auditor, and writes
 * `eval/r38/out/integrity-audit.json`.
 *
 * `buildCases` is exported so `tests/r38-integrity-auditor.spec.ts` asserts the
 * same rows instead of maintaining a second copy.
 *
 * @module eval/r38/integrity-audit
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { validateDeltas } from '../../src/semantic/validate.ts'
import { applyOps, planCommit } from '../../src/semantic/plan.ts'
import { emptyCurrentState } from '../../src/state/state.ts'
import { auditSemanticIntegrity } from './src/integrity-auditor.ts'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env['R38_INTEGRITY_OUT'] ?? join(HERE, 'out', 'integrity-audit.json')

const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const model = text => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'audit', model: 'audit' },
})
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

function packetOf(options) {
  return {
    schemaVersion: 4,
    packetId: options.packetId,
    sessionId: 'audit-session',
    checkpointId: options.checkpointId ?? `checkpoint-${options.packetId}`,
    mode: 'active',
    authority: 'journal',
    status: 'activated',
    spanDigest: 'span',
    foldedSeqs: [1],
    createdAt: 0,
    stagedAtSeq: 1,
    bodyDigest: 'body',
    sourceDigest: 'source',
    ops: options.ops,
    handoff: '',
    deltaParse: 'parsed',
    proposed: [],
    accepted: options.accepted,
    refused: [],
    ...(options.retirement === undefined ? {} : { retirement: options.retirement }),
  }
}

const constraint = (quote, statement, options = {}) => ({
  kind: 'constraint',
  subjectKey: options.subjectKey ?? 'deploy-gate',
  statement,
  status: 'claimed',
  evidence: [{ quote }],
  ...(options.scope === undefined ? {} : { scope: options.scope }),
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})
const decision = (quote, statement, options = {}) => ({
  kind: 'decision',
  subjectKey: options.subjectKey ?? 'queue',
  statement,
  status: 'claimed',
  evidence: [{ quote }],
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})
const rejected = (quote, statement, rulesOut, subjectKey = 'scheduler-outbox') => ({
  kind: 'rejected-approach',
  subjectKey,
  statement,
  status: 'claimed',
  evidence: [{ quote }],
  rulesOut,
})

/** One audit case with the codes it must produce and must NOT produce. */
export function buildCases() {
  const cases = []

  // N5: an incomplete revision leaves the rejected approach active.
  {
    const messages = [
      user('Use the in-memory queue for now.'),
      user('We rejected the durable outbox because the lease semantics were wrong.'),
      user('Switch to the durable outbox.'),
    ]
    const first = fold([
      decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'scheduler-queue' }),
      rejected('We rejected the durable outbox because the lease semantics were wrong.', 'The durable outbox was rejected.', ['durable outbox']),
    ], messages)
    const p1 = packetOf({ packetId: 'n5-p1', ops: first.plan.ops, accepted: first.validation.accepted })
    const second = fold([
      decision('Switch to the durable outbox.', 'Use the durable outbox.', {
        subjectKey: 'scheduler-outbox-v2',
        supersedes: ['scheduler-queue'],
      }),
    ], messages, first.state)
    const p2 = packetOf({
      packetId: 'n5-p2',
      ops: second.plan.ops,
      accepted: second.validation.accepted,
      ...(second.plan.withheld.length === 0 && second.plan.refusedRetirements.length === 0
        ? {}
        : { retirement: { withheld: second.plan.withheld, refused: second.plan.refusedRetirements } }),
    })
    const audit = auditSemanticIntegrity({
      sessionId: 'n5-incomplete',
      state: second.state,
      packets: [
        { packet: p1, stateBefore: emptyCurrentState() },
        { packet: p2, stateBefore: first.state },
      ],
      sourceSeqs: new Set([1, 2, 3]),
    })
    cases.push({
      id: 'n5-incomplete',
      description: 'a revision that supersedes only the queue leaves the rejected outbox active',
      audit,
      expectCodes: ['stale-negative-knowledge'],
      forbidCodes: ['unauthorized-retirement', 'missing-source-evidence'],
      expectSeverity: { 'stale-negative-knowledge': 'requires-review' },
    })
  }

  // N5: the complete revision retires both coordinates.
  {
    const messages = [
      user('Use the in-memory queue for now.'),
      user('We rejected the durable outbox because the lease semantics were wrong.'),
      user('Switch to the durable outbox.'),
    ]
    const first = fold([
      decision('Use the in-memory queue for now.', 'Use the in-memory queue.', { subjectKey: 'scheduler-queue' }),
      rejected('We rejected the durable outbox because the lease semantics were wrong.', 'The durable outbox was rejected.', ['durable outbox']),
    ], messages)
    const p1 = packetOf({ packetId: 'n5c-p1', ops: first.plan.ops, accepted: first.validation.accepted })
    const second = fold([
      decision('Switch to the durable outbox.', 'Use the durable outbox.', {
        subjectKey: 'scheduler-outbox-v2',
        supersedes: ['scheduler-queue', 'scheduler-outbox'],
      }),
    ], messages, first.state)
    const p2 = packetOf({ packetId: 'n5c-p2', ops: second.plan.ops, accepted: second.validation.accepted })
    const audit = auditSemanticIntegrity({
      sessionId: 'n5-complete',
      state: second.state,
      packets: [
        { packet: p1, stateBefore: emptyCurrentState() },
        { packet: p2, stateBefore: first.state },
      ],
      sourceSeqs: new Set([1, 2, 3]),
    })
    cases.push({
      id: 'n5-complete',
      description: 'the complete revision retires both coordinates and leaves no conflict',
      audit,
      expectCodes: [],
      forbidCodes: ['stale-negative-knowledge', 'unauthorized-retirement'],
    })
  }

  // Opposite claims in DIFFERENT scopes are a candidate, not a conflict.
  {
    const messages = [user('Repo A: use the durable outbox.'), user('Repo B: avoid the durable outbox.')]
    const first = fold([
      constraint('Repo A: use the durable outbox.', 'Use the durable outbox.', { subjectKey: 'outbox', scope: { workspace: 'repo-a' } }),
      constraint('Repo B: avoid the durable outbox.', 'Avoid the durable outbox.', { subjectKey: 'outbox', scope: { workspace: 'repo-b' } }),
    ], messages)
    const p1 = packetOf({ packetId: 'scope-p1', ops: first.plan.ops, accepted: first.validation.accepted })
    const audit = auditSemanticIntegrity({
      sessionId: 'cross-scope',
      state: first.state,
      packets: [{ packet: p1, stateBefore: emptyCurrentState() }],
      sourceSeqs: new Set([1, 2]),
    })
    cases.push({
      id: 'cross-scope-opposites',
      description: 'opposite values in different scopes are informational, never blocking',
      audit,
      expectCodes: ['cross-scope-conflict-candidate'],
      forbidCodes: ['conflicting-active-anchors', 'unauthorized-retirement'],
      expectSeverity: { 'cross-scope-conflict-candidate': 'informational' },
    })
  }

  // The same opposition in one scope is a review candidate.
  {
    const messages = [user('Use the durable outbox.'), user('Avoid the durable outbox.')]
    const first = fold([
      constraint('Use the durable outbox.', 'Use the durable outbox.', { subjectKey: 'outbox-a' }),
      constraint('Avoid the durable outbox.', 'Avoid the durable outbox.', { subjectKey: 'outbox-b' }),
    ], messages)
    const p1 = packetOf({ packetId: 'same-p1', ops: first.plan.ops, accepted: first.validation.accepted })
    const audit = auditSemanticIntegrity({
      sessionId: 'same-scope',
      state: first.state,
      packets: [{ packet: p1, stateBefore: emptyCurrentState() }],
      sourceSeqs: new Set([1, 2]),
    })
    cases.push({
      id: 'same-scope-opposites',
      description: 'opposite values in one scope are a requires-review candidate',
      audit,
      expectCodes: ['conflicting-active-anchors'],
      forbidCodes: ['unauthorized-retirement'],
      expectSeverity: { 'conflicting-active-anchors': 'requires-review' },
    })
  }

  // A shared keyword with no polarity and no rulesOut is NOT a conflict.
  {
    const messages = [
      user('The scheduler uses a durable outbox.'),
      user('The scheduler retries three times.'),
    ]
    const first = fold([
      constraint('The scheduler uses a durable outbox.', 'The scheduler uses a durable outbox.', { subjectKey: 'scheduler-outbox' }),
      constraint('The scheduler retries three times.', 'The scheduler retries three times.', { subjectKey: 'scheduler-retry' }),
    ], messages)
    const p1 = packetOf({ packetId: 'kw-p1', ops: first.plan.ops, accepted: first.validation.accepted })
    const audit = auditSemanticIntegrity({
      sessionId: 'shared-keyword',
      state: first.state,
      packets: [{ packet: p1, stateBefore: emptyCurrentState() }],
      sourceSeqs: new Set([1, 2]),
    })
    cases.push({
      id: 'shared-keyword-only',
      description: 'two unrelated facts sharing a keyword produce no finding',
      audit,
      expectCodes: [],
      forbidCodes: ['conflicting-active-anchors', 'stale-negative-knowledge', 'cross-scope-conflict-candidate'],
    })
  }

  // A historical packet that retired a normative anchor from tool evidence.
  {
    const messages = [
      user('Never deploy to production without a signed release.'),
      tool('probe ok: staging=200 production=200'),
    ]
    const first = fold([
      constraint('Never deploy to production without a signed release.', 'Production deploys require a signed release.'),
    ], messages)
    const constraintId = first.plan.planned[0].anchorId
    const second = fold([
      {
        kind: 'finding',
        subjectKey: 'probe',
        statement: 'The probe succeeded.',
        status: 'observed',
        evidence: [{ quote: 'probe ok: staging=200 production=200' }],
        supersedes: [constraintId],
      },
    ], messages, first.state)
    // Simulate a PRE-FIX journal: the retire op exists even though the planner
    // now refuses it.
    const historicalDelta = second.validation.accepted[0]
    const p1 = packetOf({ packetId: 'hist-p1', ops: first.plan.ops, accepted: first.validation.accepted })
    const p2 = packetOf({
      packetId: 'hist-p2',
      ops: [{ op: 'retire', anchorId: constraintId }],
      accepted: [historicalDelta],
    })
    const historicalState = applyOps(first.state, [{ op: 'retire', anchorId: constraintId }])
    const audit = auditSemanticIntegrity({
      sessionId: 'historical-unauthorized',
      state: historicalState,
      packets: [
        { packet: p1, stateBefore: emptyCurrentState() },
        { packet: p2, stateBefore: first.state },
      ],
      sourceSeqs: new Set([1, 2]),
    })
    cases.push({
      id: 'historical-unauthorized-retirement',
      description: 'a pre-fix journal that retired a user constraint is flagged blocking',
      audit,
      expectCodes: ['unauthorized-retirement'],
      forbidCodes: [],
      expectSeverity: { 'unauthorized-retirement': 'blocking' },
    })
  }

  // A dependency that does not resolve.
  {
    const messages = [user('Switch to the durable outbox.')]
    const first = fold([
      {
        ...decision('Switch to the durable outbox.', 'Use the durable outbox.', { subjectKey: 'scheduler-outbox' }),
        dependsOn: ['scheduler-queue'],
      },
    ], messages)
    const p1 = packetOf({ packetId: 'dep-p1', ops: first.plan.ops, accepted: first.validation.accepted })
    const audit = auditSemanticIntegrity({
      sessionId: 'unresolved-dependency',
      state: first.state,
      packets: [{ packet: p1, stateBefore: emptyCurrentState() }],
      sourceSeqs: new Set([1]),
    })
    cases.push({
      id: 'unresolved-dependency',
      description: 'a declared dependency on an absent coordinate is reported',
      audit,
      expectCodes: ['unresolved-dependency'],
      forbidCodes: ['unauthorized-retirement'],
      expectSeverity: { 'unresolved-dependency': 'requires-review' },
    })
  }

  // A withheld revision, as the planner records it.
  {
    const messages = [user('Switch to the durable outbox.'), tool('probe ok')]
    const first = fold([
      decision('Switch to the durable outbox.', 'Use the durable outbox.', { subjectKey: 'scheduler-outbox' }),
    ], messages)
    const p1 = packetOf({ packetId: 'with-p1', ops: first.plan.ops, accepted: first.validation.accepted })
    const second = fold([
      {
        kind: 'finding',
        subjectKey: 'probe',
        statement: 'The probe succeeded.',
        status: 'observed',
        evidence: [{ quote: 'probe ok' }],
        supersedes: ['semantic-00000000000000000000000000000000'],
      },
    ], messages, first.state)
    const p2 = packetOf({
      packetId: 'with-p2',
      ops: second.plan.ops,
      accepted: second.validation.accepted,
      retirement: { withheld: second.plan.withheld, refused: second.plan.refusedRetirements },
    })
    const audit = auditSemanticIntegrity({
      sessionId: 'withheld-revision',
      state: second.state,
      packets: [
        { packet: p1, stateBefore: emptyCurrentState() },
        { packet: p2, stateBefore: first.state },
      ],
      sourceSeqs: new Set([1, 2]),
    })
    cases.push({
      id: 'withheld-revision',
      description: 'an unresolved target is reported as an unresolved supersession',
      audit,
      expectCodes: ['unresolved-supersession'],
      forbidCodes: ['unauthorized-retirement'],
      expectSeverity: { 'unresolved-supersession': 'requires-review' },
    })
  }

  // A source ref the log does not contain.
  {
    const anchor = {
      id: 'semantic-missing-source',
      kind: 'constraint',
      stateKey: { namespace: 'semantic', entity: 'constraint', property: 'ghost' },
      value: 'A claim with no log evidence.',
      authority: 'normative',
      lifecycle: 'active',
      sourceRefs: [{ seq: 99 }],
    }
    const state = {
      ...emptyCurrentState(),
      constraints: { [anchor.id]: anchor },
      stateHeads: { 'semantic/constraint/ghost': anchor },
    }
    const audit = auditSemanticIntegrity({
      sessionId: 'missing-source',
      state,
      packets: [],
      sourceSeqs: new Set([1]),
    })
    cases.push({
      id: 'missing-source-evidence',
      description: 'an anchor citing an absent seq is blocking',
      audit,
      expectCodes: ['missing-source-evidence'],
      forbidCodes: [],
      expectSeverity: { 'missing-source-evidence': 'blocking' },
    })
  }

  return cases
}

/** Run every case and attach its verdict. */
export function runCases() {
  return buildCases().map(entry => {
    const codes = entry.audit.findings.map(finding => finding.code)
    const missing = entry.expectCodes.filter(code => !codes.includes(code))
    const forbidden = entry.forbidCodes.filter(code => codes.includes(code))
    const wrongSeverity = Object.entries(entry.expectSeverity ?? {}).filter(([code, severity]) => {
      const finding = entry.audit.findings.find(row => row.code === code)
      return finding !== undefined && finding.severity !== severity
    })
    return {
      id: entry.id,
      description: entry.description,
      expectedCodes: entry.expectCodes,
      forbiddenCodes: entry.forbidCodes,
      actualCodes: codes,
      counts: entry.audit.counts,
      anchors: entry.audit.anchors,
      activeAnchors: entry.audit.activeAnchors,
      relations: entry.audit.relations,
      findings: entry.audit.findings,
      pass: missing.length === 0 && forbidden.length === 0 && wrongSeverity.length === 0,
      missing,
      forbidden,
      wrongSeverity: wrongSeverity.map(([code, severity]) => ({ code, expected: severity })),
    }
  })
}

async function main() {
  const results = runCases()
  const passed = results.filter(row => row.pass).length
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'R38-M0',
    work: 'WP2-integrity-auditor',
    status: passed === results.length ? 'passed' : 'failed',
    readOnly: true,
    severities: ['blocking', 'requires-review', 'informational'],
    summary: { total: results.length, passed, failed: results.length - passed },
    cases: results,
  }
  await writeJson(OUT, report)
  process.stdout.write(`R38 integrity audit: ${OUT}\n`)
  process.stdout.write(`status ${report.status}; ${passed}/${results.length} cases passed\n`)
  for (const row of results) {
    process.stdout.write(`  ${row.pass ? 'PASS' : 'FAIL'} ${row.id} -> ${row.actualCodes.join(',') || '(none)'}\n`)
  }
  process.exit(report.status === 'passed' ? 0 : 1)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) await main()
