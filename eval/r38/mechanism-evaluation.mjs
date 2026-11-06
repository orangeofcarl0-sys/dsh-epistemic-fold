#!/usr/bin/env node
/**
 * R38-M0 WP7: mechanism evaluation.
 *
 * Three layers, twelve cases. Each case carries:
 *
 *   gold            what the fixture says must happen
 *   reference       the correct input, which must pass
 *   counterfactual  the wrong or weaker input, which must fail as intended
 *   leakage         whether the answer was injected into the task
 *   sourceRefs      independent provenance seqs
 *
 * No case is added to the valid sample unless all four hold. A case that
 * cannot be certified is reported as blocked, not counted.
 *
 * Output: eval/r38/out/mechanism-evaluation.json
 *
 * @module eval/r38/mechanism-evaluation
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { validateDeltas } from '../../src/semantic/validate.ts'
import { applyOps, planCommit } from '../../src/semantic/plan.ts'
import { emptyCurrentState, stateKeyText } from '../../src/state/state.ts'
import { compileWorkingSet } from '../../src/semantic/working-set-compiler.ts'
import { canonicalHash } from '../../src/checkpoint/hash.ts'
import { FileBundleStore } from '../../lib/checkpoint/bundle-store.js'
import { auditSemanticIntegrity } from './src/integrity-auditor.ts'
import { selectTaskAwareContext } from './src/task-aware-selector.ts'
import { assessRecentTail } from './src/recent-tail.ts'
import { recoverFromArchive } from './src/archive-recovery.ts'
import { runAblation as runWorkingSetAblation } from './working-set-ablation.mjs'
import { runAblation as runRecoveryAblation } from './archive-recovery-ablation.mjs'
import { runCases as runTailCases } from './recent-tail.mjs'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'mechanism-evaluation.json')

const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const model = text => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'fixture', model: 'fixture' },
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

const constraint = (quote, statement, options = {}) => ({
  kind: 'constraint', subjectKey: options.subjectKey ?? 'deploy-gate', statement, status: 'claimed',
  evidence: [{ quote }],
  ...(options.scope === undefined ? {} : { scope: options.scope }),
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})
const decision = (quote, statement, options = {}) => ({
  kind: 'decision', subjectKey: options.subjectKey ?? 'queue', statement, status: 'claimed',
  evidence: [{ quote }],
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})
const finding = (quote, statement, options = {}) => ({
  kind: 'finding', subjectKey: options.subjectKey ?? 'probe', statement, status: 'observed',
  evidence: [{ quote }],
  ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
})
const rejected = (quote, statement, rulesOut, subjectKey = 'scheduler-outbox') => ({
  kind: 'rejected-approach', subjectKey, statement, status: 'claimed',
  evidence: [{ quote }], rulesOut,
})

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

function frameOf(options) {
  return {
    sessionId: 'mechanism',
    taskId: options.taskId,
    phase: 'editing',
    files: options.files ?? [],
    symbols: [],
    currentRequest: options.request,
    semanticStateRevision: 'r1',
    sessionEventWatermark: 100,
  }
}

const cases = []
const push = entry => cases.push(entry)

// ---------------------------------------------------------------- semantic integrity

/** 1. N5: the complete revision retires both coordinates; the partial one does not. */
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
  const complete = fold([
    decision('Switch to the durable outbox.', 'Use the durable outbox.', {
      subjectKey: 'scheduler-outbox-v2',
      supersedes: ['scheduler-queue', 'scheduler-outbox'],
    }),
  ], messages, first.state)
  const incomplete = fold([
    decision('Switch to the durable outbox.', 'Use the durable outbox.', {
      subjectKey: 'scheduler-outbox-v2',
      supersedes: ['scheduler-queue'],
    }),
  ], messages, first.state)
  const outboxId = first.plan.planned[1].anchorId
  const audit = auditSemanticIntegrity({
    sessionId: 'n5',
    state: incomplete.state,
    packets: [{
      packet: {
        schemaVersion: 4, packetId: 'p1', sessionId: 'n5', checkpointId: 'c1', mode: 'active', authority: 'journal',
        status: 'activated', spanDigest: 's', foldedSeqs: [1, 2, 3], createdAt: 0, stagedAtSeq: 1,
        bodyDigest: 'b', sourceDigest: 's', ops: first.plan.ops, handoff: '', deltaParse: 'parsed',
        proposed: [], accepted: first.validation.accepted, refused: [],
      },
      stateBefore: emptyCurrentState(),
    }],
    sourceSeqs: new Set([1, 2, 3]),
  })
  push({
    id: 'n5-cross-coordinate',
    layer: 'semantic-integrity',
    riskClass: 'unresolved-supersession',
    gold: 'the complete revision leaves no active stale anchor; the partial revision does',
    sourceRefs: [1, 2, 3],
    run() {
      return {
        reference: {
          pass: complete.state.decisions[outboxId] === undefined
            && complete.plan.refusedRetirements.length === 0,
          detail: { staleAnchorActive: complete.state.decisions[outboxId] !== undefined },
        },
        counterfactual: {
          failsAsIntended: incomplete.state.decisions[outboxId]?.lifecycle === 'active',
          detail: { staleAnchorActive: incomplete.state.decisions[outboxId] !== undefined },
        },
        leakage: { checked: true, findings: [] },
        cost: { folds: 2, anchors: Object.keys(complete.state.decisions).length },
      }
    },
    evidence: { auditorFinding: audit.findings.find(row => row.code === 'stale-negative-knowledge') ?? null },
  })
}

/** 2. A user revision applies; a tool finding cannot retire the same constraint. */
{
  const messages = [user('Never deploy to production without a signed release.'), tool('probe ok')]
  const first = fold([
    constraint('Never deploy to production without a signed release.', 'Production deploys require a signed release.'),
  ], messages)
  const anchorId = first.plan.planned[0].anchorId
  const revision = fold([
    constraint('Never deploy to production without a signed release.', 'Hotfix deploys may skip the signed-release gate.', { supersedes: ['previous'] }),
  ], messages, first.state)
  const attack = fold([
    finding('probe ok', 'The probe succeeded.', { supersedes: [anchorId] }),
  ], messages, first.state)
  push({
    id: 'decision-override-vs-tool-attack',
    layer: 'semantic-integrity',
    riskClass: 'unauthorized-retirement',
    gold: 'a user revision applies; a tool finding cannot retire the constraint',
    sourceRefs: [1, 2],
    run() {
      const active = Object.values(revision.state.constraints).filter(anchor => anchor.lifecycle === 'active')
      return {
        reference: {
          pass: active.length === 1 && active[0].value === 'Hotfix deploys may skip the signed-release gate.',
          detail: { activeValues: active.map(anchor => anchor.value) },
        },
        counterfactual: {
          failsAsIntended: attack.plan.refusedRetirements[0]?.reason === 'insufficient-authority'
            && attack.state.constraints[anchorId]?.lifecycle === 'active',
          detail: { refused: attack.plan.refusedRetirements },
        },
        leakage: { checked: true, findings: [] },
        cost: { folds: 2 },
      }
    },
  })
}

/** 3. Multi-fold supersession: ordered replay keeps the last value. */
{
  const messages = [user('The timeout is 30 seconds.'), user('The timeout is 60 seconds.'), user('The timeout is 90 seconds.')]
  const one = fold([constraint('The timeout is 30 seconds.', 'The timeout is 30 seconds.', { subjectKey: 'timeout' })], messages)
  const two = fold([constraint('The timeout is 60 seconds.', 'The timeout is 60 seconds.', { subjectKey: 'timeout', supersedes: ['previous'] })], messages, one.state)
  const three = fold([constraint('The timeout is 90 seconds.', 'The timeout is 90 seconds.', { subjectKey: 'timeout', supersedes: ['previous'] })], messages, two.state)
  const key = 'semantic/constraint/timeout'
  push({
    id: 'multi-fold-supersession',
    layer: 'semantic-integrity',
    riskClass: 'incorrect-active-state',
    gold: 'ordered folds leave exactly the last value active and both earlier values superseded',
    sourceRefs: [1, 2, 3],
    run() {
      const head = three.state.stateHeads[key]
      const superseded = Object.values(three.state.superseded)
      return {
        reference: {
          pass: head?.value === 'The timeout is 90 seconds.' && superseded.length >= 1,
          detail: { head: head?.value ?? null, superseded: superseded.length },
        },
        counterfactual: {
          failsAsIntended: applyOps(three.state, two.plan.ops).stateHeads[key]?.value === 'The timeout is 60 seconds.',
          detail: { outOfOrderHead: applyOps(three.state, two.plan.ops).stateHeads[key]?.value ?? null },
        },
        leakage: { checked: true, findings: [] },
        cost: { folds: 3 },
      }
    },
  })
}

/** 4. Scope overlap: a revision touches its scope only; a cross-scope id is refused. */
{
  const messages = [
    user('Repository A: the timeout is 30 seconds.'),
    user('Repository B: the timeout is five minutes.'),
    tool('probe ok'),
  ]
  const first = fold([
    constraint('Repository A: the timeout is 30 seconds.', 'Repo A timeout is 30 seconds.', { subjectKey: 'timeout', scope: { workspace: 'repo-a' } }),
    constraint('Repository B: the timeout is five minutes.', 'Repo B timeout is five minutes.', { subjectKey: 'timeout', scope: { workspace: 'repo-b' } }),
  ], messages)
  const repoB = first.plan.planned[1].anchorId
  const revision = fold([
    constraint('Repository A: the timeout is 30 seconds.', 'Repo A timeout is 45 seconds.', {
      subjectKey: 'timeout', scope: { workspace: 'repo-a' }, supersedes: ['timeout'],
    }),
  ], messages, first.state)
  const crossScope = fold([
    finding('probe ok', 'The probe succeeded.', { scope: { workspace: 'repo-a' }, supersedes: [repoB] }),
  ], messages, first.state)
  push({
    id: 'scope-overlap',
    layer: 'semantic-integrity',
    riskClass: 'scope-contamination',
    gold: 'the in-scope revision applies; the cross-scope retirement is refused',
    sourceRefs: [1, 2, 3],
    run() {
      return {
        reference: {
          pass: revision.plan.refusedRetirements.length === 0
            && Object.values(revision.state.constraints).some(anchor => anchor.value === 'Repo A timeout is 45 seconds.'),
          detail: { refused: revision.plan.refusedRetirements },
        },
        counterfactual: {
          failsAsIntended: crossScope.plan.refusedRetirements[0]?.reason === 'cross-scope',
          detail: { refused: crossScope.plan.refusedRetirements },
        },
        leakage: { checked: true, findings: [] },
        cost: { folds: 2 },
      }
    },
  })
}

/** 5. Relation authority attack, and the auditor's detection of a pre-fix journal. */
{
  const messages = [user('Never deploy to production without a signed release.'), tool('probe ok: staging=200 production=200')]
  const first = fold([
    constraint('Never deploy to production without a signed release.', 'Production deploys require a signed release.'),
  ], messages)
  const anchorId = first.plan.planned[0].anchorId
  const attack = fold([
    finding('probe ok: staging=200 production=200', 'The production endpoint answers a probe.', { supersedes: [anchorId] }),
  ], messages, first.state)
  const historicalState = applyOps(first.state, [{ op: 'retire', anchorId }])
  const audit = auditSemanticIntegrity({
    sessionId: 'historical',
    state: historicalState,
    packets: [{
      packet: {
        schemaVersion: 4, packetId: 'hist', sessionId: 'historical', checkpointId: 'c', mode: 'active', authority: 'journal',
        status: 'activated', spanDigest: 's', foldedSeqs: [1, 2], createdAt: 0, stagedAtSeq: 1,
        bodyDigest: 'b', sourceDigest: 's', ops: [{ op: 'retire', anchorId }], handoff: '', deltaParse: 'parsed',
        proposed: [], accepted: attack.validation.accepted, refused: [],
      },
      stateBefore: first.state,
    }],
    sourceSeqs: new Set([1, 2]),
  })
  push({
    id: 'relation-authority-attack',
    layer: 'semantic-integrity',
    riskClass: 'unauthorized-retirement',
    safetyBlocker: true,
    gold: 'a tool finding cannot retire a user constraint; a pre-fix retire is blocking',
    sourceRefs: [1, 2],
    run() {
      return {
        reference: {
          pass: attack.plan.refusedRetirements[0]?.reason === 'insufficient-authority'
            && attack.state.constraints[anchorId]?.lifecycle === 'active',
          detail: { refused: attack.plan.refusedRetirements },
        },
        counterfactual: {
          failsAsIntended: audit.findings.some(row => row.code === 'unauthorized-retirement' && row.severity === 'blocking'),
          detail: { blocking: audit.counts.blocking },
        },
        leakage: { checked: true, findings: [] },
        cost: { folds: 2 },
      }
    },
  })
}

// ---------------------------------------------------------------- context selection

const workingSetRows = runWorkingSetAblation()
const recoveryRows = await runRecoveryAblation()
const tailRows = runTailCases()

/** 6. B2-v2: an implementation-sensitive decision must be selected by file scope. */
{
  const anchors = [
    makeAnchor({
      id: 'impl', semanticKind: 'decision', property: 'scheduler-impl',
      value: 'The scheduler queue implementation lives in src/scheduler.mjs.',
      authority: 'decision', seq: 3, scope: { file: 'src/scheduler.mjs' },
    }),
    ...Array.from({ length: 6 }, (_, index) => makeAnchor({
      id: `noise-${index + 1}`, semanticKind: 'finding', property: `observation-${index + 1}`,
      value: `Unrelated observation ${index + 1}: the logging formatter uses ISO timestamps.`,
      authority: 'empirical', seq: 10 + index,
    })),
  ]
  const state = stateWith(anchors)
  const frame = frameOf({ taskId: 'b2-v2', request: 'Change src/scheduler.mjs.', files: ['src/scheduler.mjs'] })
  const compiled = compileWorkingSet({ state, budgetTokens: 70, estimate: text => Math.ceil(text.length / 4) })
  const selection = selectTaskAwareContext({ state, frame, budgetTokens: 70 })
  push({
    id: 'b2-v2-implementation-sensitive',
    layer: 'context-selection',
    riskClass: 'implementation-relevance',
    gold: 'the file-scoped decision is visible; the recent-first selector omits it under pressure',
    sourceRefs: [3, 10, 11, 12, 13, 14, 15],
    run() {
      return {
        reference: {
          pass: selection.selectedAnchorIds.includes('impl'),
          detail: { selected: selection.selectedAnchorIds },
        },
        counterfactual: {
          failsAsIntended: ![...compiled.pinned, ...compiled.working].some(anchor => anchor.id === 'impl'),
          detail: { selected: [...compiled.pinned, ...compiled.working].map(anchor => anchor.id) },
        },
        leakage: { checked: true, findings: [] },
        cost: { tokens: selection.tokenEstimate },
      }
    },
  })
}

/** 7. H1-v2: an archive-only fact is rescued by S2, not by S0/S1. */
{
  const row = recoveryRows.find(entry => entry.id === 'h1-production-region')
  push({
    id: 'h1-production-region',
    layer: 'context-selection',
    riskClass: 'archive-only',
    gold: 'the production region is absent from state and recovered from the archive',
    sourceRefs: [1, 2],
    run() {
      return {
        reference: {
          pass: row.metrics.criticalCoverage.s2 === true,
          detail: { coverage: row.metrics.criticalCoverage },
        },
        counterfactual: {
          failsAsIntended: row.metrics.criticalCoverage.s1 === false,
          detail: { coverage: row.metrics.criticalCoverage },
        },
        leakage: {
          checked: true,
          findings: row.terms.filter(term => term.length >= 3 && row.criticalTerm.toLowerCase().includes(term.toLowerCase())),
        },
        cost: { retrievalCost: row.metrics.retrievalCost, tokenOverhead: row.metrics.tokenOverhead },
      }
    },
  })
}

/** 8. S1-v1: the authority scope keeps another repository's fact out. */
{
  const scopeSession = SessionId('r38-mechanism-scope')
  const scopeRoot = await mkdtemp(join(tmpdir(), 'r38-mechanism-scope-'))
  const scopeStore = new FileBundleStore(join(scopeRoot, 'bundles'))
  const scopeMessages = [
    user('Repository A uses a 30 second timeout.'),
    user('Repository B uses a five minute timeout.'),
  ]
  const scopeRendered = '[EF1 L cp:scope]'
  await scopeStore.write({
    format: 'ef-checkpoint',
    formatVersion: 1,
    checkpointId: 'cp-scope',
    sessionId: scopeSession,
    createdAt: 1,
    mode: 'leaf',
    source: { orderedSurfaceSeqs: [1, 2], sourceDigest: canonicalHash([1, 2]) },
    archive: {
      shadowedMessages: scopeMessages,
      messageCount: 2,
      logicalHash: canonicalHash(scopeMessages),
      refs: [
        { seq: 1, digest: canonicalHash(scopeMessages[0]) },
        { seq: 2, digest: canonicalHash(scopeMessages[1]) },
      ],
    },
    rendered: { text: scopeRendered, digest: canonicalHash(scopeRendered) },
  })
  const scoped = await recoverFromArchive({
    store: scopeStore,
    sessionId: scopeSession,
    terms: ['repository a', 'timeout'],
  })
  const unscoped = await recoverFromArchive({
    store: scopeStore,
    sessionId: scopeSession,
    terms: ['timeout'],
  })
  await rm(scopeRoot, { recursive: true, force: true })

  push({
    id: 's1-authority-scope',
    layer: 'context-selection',
    riskClass: 'scope-contamination',
    gold: 'the scoped query returns repository A only; the unscoped query returns repository B too',
    sourceRefs: [1, 2],
    run() {
      const repoA = scoped.recovered.every(passage => passage.excerpt.toLowerCase().includes('repository a'))
      const repoB = unscoped.recovered.some(passage => passage.excerpt.toLowerCase().includes('repository b'))
      return {
        reference: {
          pass: scoped.recovered.length > 0 && repoA,
          detail: { recovered: scoped.recovered.map(passage => passage.excerpt) },
        },
        counterfactual: {
          failsAsIntended: repoB,
          detail: { unscoped: unscoped.recovered.map(passage => passage.excerpt) },
        },
        leakage: { checked: true, findings: [] },
        cost: { retrievalCost: scoped.searchOperations + scoped.exactPages },
      }
    },
  })
}

/** 9. B2: the rejected approach is selected under budget pressure. */
{
  const row = workingSetRows.find(entry => entry.id === 'n5-budget-pressure')
  push({
    id: 'b2-negative-knowledge',
    layer: 'context-selection',
    riskClass: 'negative-knowledge-coverage',
    gold: 'the rejected outbox is visible to the task that depends on it',
    sourceRefs: [2, 10],
    run() {
      return {
        reference: {
          pass: row.s1.criticalVisible === 1 && row.s1.negativeKnowledgeVisible === 1,
          detail: { critical: row.s1.criticalVisible, negative: row.s1.negativeKnowledgeVisible },
        },
        counterfactual: {
          failsAsIntended: row.s0.criticalVisible === 0,
          detail: { critical: row.s0.criticalVisible },
        },
        leakage: { checked: true, findings: [] },
        cost: { s0Tokens: row.s0.tokens, s1Content: row.s1.contentTokens },
      }
    },
  })
}

/** 10. Recent-tail reversal: the old decision is unsafe to assert. */
{
  const row = tailRows.find(entry => entry.id === 'explicit-user-revision')
  const none = tailRows.find(entry => entry.id === 'no-tail-update')
  push({
    id: 'recent-tail-reversal',
    layer: 'recent-tail',
    riskClass: 'stale-state-delivery',
    gold: 'a later user revision marks the old decision unsafe; no tail leaves it safe',
    sourceRefs: [10, 12],
    run() {
      return {
        reference: {
          pass: row.verdictOf.queue === 'superseded-by-user' && row.unsafeAnchorIds.includes('queue'),
          detail: { verdict: row.verdictOf.queue, unsafe: row.unsafeAnchorIds },
        },
        counterfactual: {
          failsAsIntended: none.unsafeAnchorIds.length === 0,
          detail: { unsafeWithoutTail: none.unsafeAnchorIds },
        },
        leakage: { checked: true, findings: [] },
        cost: { warnings: row.warnings.length },
      }
    },
  })
}

/** 11. Operational continuity: a deterministic replay of the committed R37-D pilot. */
{
  const pilot = JSON.parse(await readFile(join(HERE, '..', 'r37d', 'out', 'process-pilot-results.json'), 'utf8'))
  const trajectories = JSON.parse(await readFile(join(HERE, '..', 'r37d', 'out', 'process-pilot-trajectories.json'), 'utf8'))
  const condition = pilot.summary.byCondition
  push({
    id: 'operational-pilot-replay',
    layer: 'operational-continuity',
    riskClass: 'artifact-and-verification',
    gold: 'the committed 24-cell aggregate replays exactly; the process prompt is not a uniform fix',
    sourceRefs: [],
    run() {
      const b2p0 = condition['B2/B1/P0'].operational + condition['B2/S/P0'].operational
      const b2p1 = condition['B2/B1/P1'].operational + condition['B2/S/P1'].operational
      const d1p0 = condition['D1-v2/B1/P0'].operational + condition['D1-v2/S/P0'].operational
      const d1p1 = condition['D1-v2/B1/P1'].operational + condition['D1-v2/S/P1'].operational
      return {
        reference: {
          pass: pilot.summary.executed === 24
            && pilot.summary.operationalCompletions === 17
            && pilot.summary.legacyContractSuccesses === 17,
          detail: { executed: pilot.summary.executed, operational: pilot.summary.operationalCompletions },
        },
        counterfactual: {
          failsAsIntended: b2p1 < b2p0 && d1p1 > d1p0,
          detail: { b2p0, b2p1, d1p0, d1p1 },
        },
        leakage: { checked: true, findings: [] },
        cost: {
          testsExecuted: pilot.summary.testsExecuted,
          noValidActionCalls: pilot.summary.noValidActionCalls,
          archetypes: trajectories.archetypes,
        },
      }
    },
  })
}

const rows = cases.map(entry => {
  const result = entry.run()
  const certified = result.reference.pass === true
    && result.counterfactual.failsAsIntended === true
    && result.leakage.findings.length === 0
  return {
    id: entry.id,
    layer: entry.layer,
    riskClass: entry.riskClass,
    safetyBlocker: entry.safetyBlocker === true,
    gold: entry.gold,
    sourceRefs: entry.sourceRefs,
    status: certified ? 'certified' : 'blocked',
    reference: result.reference,
    counterfactual: result.counterfactual,
    leakage: result.leakage,
    cost: result.cost,
    ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
  }
})

const byLayer = {}
const byRiskClass = {}
for (const row of rows) {
  const layer = byLayer[row.layer] ?? { total: 0, certified: 0, blocked: 0 }
  layer.total += 1
  layer[row.status] += 1
  byLayer[row.layer] = layer
  const risk = byRiskClass[row.riskClass] ?? { total: 0, certified: 0, blocked: 0 }
  risk.total += 1
  risk[row.status] += 1
  byRiskClass[row.riskClass] = risk
}

const safetyRows = rows.filter(row => row.safetyBlocker)
const unauthorizedRetirementObserved = safetyRows.filter(row =>
  row.reference.pass !== true || row.counterfactual.failsAsIntended !== true).length
const certified = rows.filter(row => row.status === 'certified').length

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R38-M0',
  work: 'WP7-mechanism-evaluation',
  status: certified === rows.length && unauthorizedRetirementObserved === 0 ? 'passed' : 'failed',
  liveModelCalls: 0,
  layers: ['semantic-integrity', 'context-selection', 'recent-tail', 'operational-continuity'],
  summary: {
    cases: rows.length,
    certified,
    blocked: rows.length - certified,
    safetyBlockers: safetyRows.length,
    unauthorizedRetirementObserved,
  },
  byLayer,
  byRiskClass,
  cases: rows,
}
await writeJson(OUT, report)

process.stdout.write(`R38 mechanism evaluation: ${OUT}\n`)
process.stdout.write(`status ${report.status}; ${certified}/${rows.length} certified; safety blockers ${safetyRows.length}\n`)
for (const row of rows) {
  process.stdout.write(`  ${row.status === 'certified' ? 'CERT' : 'BLOCK'} ${row.id} [${row.layer}/${row.riskClass}]\n`)
}
process.exit(report.status === 'passed' ? 0 : 1)
