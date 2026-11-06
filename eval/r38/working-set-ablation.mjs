#!/usr/bin/env node
/**
 * R38-M0 WP3: working-set ablation, S0 (production) vs S1 (task-aware shadow).
 *
 * Both selectors run on the SAME state, the SAME budget and the SAME frame.
 * The task frame is derived from the request and files, never from a case's
 * gold: `criticalIds` and `negativeKnowledgeIds` are used only to score the
 * result, never to build the selection.
 *
 * Output: eval/r38/out/working-set-ablation.json
 *
 * @module eval/r38/working-set-ablation
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileWorkingSet } from '../../src/semantic/working-set-compiler.ts'
import { emptyCurrentState, stateKeyText } from '../../src/state/state.ts'
import { canonicalHash } from '../../src/checkpoint/hash.ts'
import { renderAnchorLine, renderFailureLine } from '../../src/checkpoint/renderer.ts'
import { selectTaskAwareContext } from './src/task-aware-selector.ts'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'working-set-ablation.json')

const estimate = text => Math.ceil(text.length / 4)
const lineOf = anchor => anchor.kind === 'failure' ? renderFailureLine(anchor) : renderAnchorLine(anchor)

/** One synthetic anchor with a semantic kind distinct from the anchor kind. */
function makeAnchor(options) {
  const anchorKind = options.semanticKind === 'rejected-approach'
    ? 'decision'
    : options.semanticKind === 'finding'
      ? 'evidence'
      : options.semanticKind
  const entity = options.scope === undefined
    ? options.semanticKind
    : `${options.semanticKind}#${canonicalHash(options.scope)}`
  return {
    id: options.id,
    kind: anchorKind,
    stateKey: { namespace: 'semantic', entity, property: options.property },
    value: options.value,
    authority: options.authority,
    lifecycle: 'active',
    ...(options.failureState === undefined ? {} : { failureState: options.failureState }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    sourceRefs: [{ seq: options.seq }],
  }
}

function stateWith(anchors) {
  const state = emptyCurrentState()
  for (const anchor of anchors) {
    state.stateHeads[stateKeyText(anchor.stateKey)] = anchor
    switch (anchor.kind) {
      case 'constraint': state.constraints[anchor.id] = anchor; break
      case 'decision': state.decisions[anchor.id] = anchor; break
      case 'evidence': state.evidence[anchor.id] = anchor; break
      case 'obligation': state.openObligations[anchor.id] = anchor; break
      case 'failure': state.openFailures[anchor.id] = anchor; break
      case 'objective': state.objective = anchor; break
      default: break
    }
  }
  return state
}

function frameOf(options) {
  return {
    sessionId: 'ablation-session',
    taskId: options.taskId,
    phase: options.phase ?? 'editing',
    workspace: options.workspace,
    branch: options.branch,
    files: options.files ?? [],
    symbols: options.symbols ?? [],
    operation: options.operation,
    currentRequest: options.request,
    semanticStateRevision: 'r1',
    sessionEventWatermark: 100,
  }
}

function selectedOfCompiled(compiled) {
  return [...compiled.pinned, ...compiled.working].map(anchor => anchor.id)
}

function scopeMatches(anchor, frame) {
  if (anchor.scope === undefined) return true
  if (anchor.scope.workspace !== undefined && frame.workspace !== anchor.scope.workspace) return false
  if (anchor.scope.file !== undefined && !frame.files.includes(anchor.scope.file)) return false
  if (anchor.scope.symbol !== undefined && !frame.symbols.includes(anchor.scope.symbol)) return false
  return true
}

function metrics(caseData, selectedIds) {
  const selected = new Set(selectedIds)
  const anchorById = new Map(caseData.anchors.map(anchor => [anchor.id, anchor]))
  const critical = caseData.criticalIds.filter(id => selected.has(id))
  const negative = caseData.negativeKnowledgeIds.filter(id => selected.has(id))
  const unrelated = [...selected].filter(id => caseData.unrelatedIds.includes(id))
  const unrelatedTokens = unrelated.reduce((sum, id) => {
    const anchor = anchorById.get(id)
    return sum + (anchor === undefined ? 0 : estimate(lineOf(anchor)))
  }, 0)
  const workingSelected = [...selected].filter(id => {
    const anchor = anchorById.get(id)
    return anchor !== undefined && !(anchor.kind === 'constraint' || anchor.kind === 'objective' || anchor.kind === 'obligation')
  })
  const scoped = workingSelected.filter(id => {
    const anchor = anchorById.get(id)
    return anchor !== undefined && scopeMatches(anchor, caseData.frame)
  })
  return {
    selected: [...selected].sort(),
    selectedCount: selected.size,
    criticalVisible: critical.length,
    criticalTotal: caseData.criticalIds.length,
    criticalIds: critical.sort(),
    negativeKnowledgeVisible: negative.length,
    negativeKnowledgeTotal: caseData.negativeKnowledgeIds.length,
    negativeKnowledgeIds: negative.sort(),
    unrelatedSelected: unrelated.length,
    unrelatedTokens,
    scopePrecision: workingSelected.length === 0 ? 1 : scoped.length / workingSelected.length,
  }
}

function invariants(caseData, selection) {
  const eligible = caseData.anchors.filter(anchor => {
    const pinned = anchor.kind === 'constraint' || anchor.kind === 'objective' || anchor.kind === 'obligation'
    const failure = anchor.kind === 'failure' && (anchor.failureState === 'open' || anchor.failureState === 'investigating')
    return !pinned && !failure && scopeMatches(anchor, caseData.frame)
  }).map(anchor => anchor.id)
  const selected = new Set(selection.selectedAnchorIds)
  const omitted = new Set(selection.omittedAnchorIds)
  const disjoint = [...selected].every(id => !omitted.has(id))
  const complete = eligible.every(id => selected.has(id) || omitted.has(id))
  const pinnedAllSelected = caseData.anchors
    .filter(anchor => anchor.kind === 'constraint' || anchor.kind === 'objective' || anchor.kind === 'obligation')
    .every(anchor => selected.has(anchor.id))
  return { disjoint, complete, pinnedAllSelected }
}

const cases = []

/** 1. A relevant older rejection must survive a budget full of newer noise. */
{
  const constraint = makeAnchor({
    id: 'semantic-constraint-signed', semanticKind: 'constraint', property: 'release-gate',
    value: 'Production deploys require a signed release.', authority: 'normative', seq: 1,
  })
  const rejectedOutbox = makeAnchor({
    id: 'semantic-rejected-outbox', semanticKind: 'rejected-approach', property: 'scheduler-outbox',
    value: 'rejected: The durable outbox was rejected. (rules out: durable outbox)',
    authority: 'decision', seq: 2, scope: { file: 'src/scheduler.mjs' },
  })
  const queue = makeAnchor({
    id: 'semantic-decision-queue', semanticKind: 'decision', property: 'scheduler-queue',
    value: 'Use the in-memory queue for dispatch.', authority: 'decision', seq: 3,
  })
  const noise = Array.from({ length: 8 }, (_, index) => makeAnchor({
    id: `semantic-noise-${index + 1}`, semanticKind: 'finding', property: `observation-${index + 1}`,
    value: `Unrelated observation ${index + 1}: the logging formatter uses ISO timestamps and a stable field order.`,
    authority: 'empirical', seq: 10 + index,
  }))
  const anchors = [constraint, rejectedOutbox, queue, ...noise]
  const frame = frameOf({
    taskId: 'n5-budget',
    request: 'Modify src/scheduler.mjs to use the durable outbox.',
    files: ['src/scheduler.mjs'],
    phase: 'editing',
  })
  cases.push({
    id: 'n5-budget-pressure',
    description: 'an older relevant rejection versus eight newer unrelated findings',
    anchors,
    frame,
    budget: 120,
    criticalIds: [rejectedOutbox.id],
    negativeKnowledgeIds: [rejectedOutbox.id],
    unrelatedIds: noise.map(anchor => anchor.id),
  })
}

/** 2. Scope separation: same subject, two workspaces, one task. */
{
  const repoA = makeAnchor({
    id: 'semantic-decision-repo-a', semanticKind: 'decision', property: 'timeout',
    value: 'Repository A uses a 30 second timeout.', authority: 'decision', seq: 1,
    scope: { workspace: 'repo-a' },
  })
  const repoB = makeAnchor({
    id: 'semantic-decision-repo-b', semanticKind: 'decision', property: 'timeout',
    value: 'Repository B uses a five minute timeout.', authority: 'decision', seq: 2,
    scope: { workspace: 'repo-b' },
  })
  const shared = makeAnchor({
    id: 'semantic-decision-shared', semanticKind: 'decision', property: 'timeout-default',
    value: 'The default timeout is 30 seconds.', authority: 'decision', seq: 3,
  })
  const anchors = [repoA, repoB, shared]
  const frame = frameOf({
    taskId: 'scope',
    workspace: 'repo-a',
    request: 'Change the timeout in repository A.',
    files: [],
  })
  cases.push({
    id: 'scope-separation',
    description: 'only the in-scope decision should be selected; the other scope is explicit',
    anchors,
    frame,
    budget: 200,
    criticalIds: [repoA.id],
    negativeKnowledgeIds: [],
    unrelatedIds: [repoB.id],
  })
}

/** 3. The greedy case: A fits, B does not, C does. */
{
  const a = makeAnchor({
    id: 'semantic-greedy-a', semanticKind: 'decision', property: 'scheduler-outbox',
    value: 'Use the durable scheduler outbox dispatch.', authority: 'decision', seq: 3,
  })
  const b = makeAnchor({
    id: 'semantic-greedy-b', semanticKind: 'decision', property: 'scheduler-outbox-policy',
    value: 'The durable outbox has a bounded redelivery budget, a dead-letter drain interval, '
      + 'and an operator runbook for the backlog.',
    authority: 'decision', seq: 2,
  })
  const c = makeAnchor({
    id: 'semantic-greedy-c', semanticKind: 'decision', property: 'scheduler-retry',
    value: 'The scheduler is retried three times.', authority: 'decision', seq: 1,
  })
  const anchors = [a, b, c]
  const frame = frameOf({
    taskId: 'greedy',
    request: 'scheduler outbox queue dispatch retry',
    files: [],
  })
  // Pick a budget where A+C fit and A+B do not.
  const pinned = 0
  const section = lines => ['Working', ...lines].join('\n')
  const aTokens = estimate(section([lineOf(a)]))
  const abTokens = estimate(section([lineOf(a), lineOf(b)]))
  const acTokens = estimate(section([lineOf(a), lineOf(c)]))
  const budget = Math.max(aTokens, acTokens) + 1
  cases.push({
    id: 'greedy-skip',
    description: 'the production prefix selector breaks at B; the task-aware selector skips it and keeps C',
    anchors,
    frame,
    budget,
    criticalIds: [c.id],
    negativeKnowledgeIds: [],
    unrelatedIds: [b.id],
    greedy: { aTokens, abTokens, acTokens, pinned },
  })
}

/** 4. Pinned overflow: a contract larger than the budget is still rendered. */
{
  const longConstraint = makeAnchor({
    id: 'semantic-constraint-long', semanticKind: 'constraint', property: 'security',
    value: 'Never send credentials, tokens, session identifiers, or production data to an external service. '
      + 'All network calls must be reviewed, logged, and scoped to the staging environment.',
    authority: 'normative', seq: 1,
  })
  const decision = makeAnchor({
    id: 'semantic-decision-staging', semanticKind: 'decision', property: 'staging',
    value: 'Use the staging endpoint for probes.', authority: 'decision', seq: 2,
  })
  const anchors = [longConstraint, decision]
  const frame = frameOf({
    taskId: 'pinned-overflow',
    request: 'Probe the staging endpoint.',
    files: [],
  })
  cases.push({
    id: 'pinned-overflow',
    description: 'pinned state alone exceeds the budget and is still shown in full',
    anchors,
    frame,
    budget: 20,
    criticalIds: [longConstraint.id],
    negativeKnowledgeIds: [],
    unrelatedIds: [],
  })
}

/** Run S0 and S1 on one case. */
function runCase(caseData) {
  const state = stateWith(caseData.anchors)
  const reversed = stateWith([...caseData.anchors].reverse())
  const compiled = compileWorkingSet({ state, budgetTokens: caseData.budget, estimate })
  const compiledReversed = compileWorkingSet({ state: reversed, budgetTokens: caseData.budget, estimate })
  const selection = selectTaskAwareContext({ state, frame: caseData.frame, budgetTokens: caseData.budget })
  const selectionReversed = selectTaskAwareContext({ state: reversed, frame: caseData.frame, budgetTokens: caseData.budget })

  const s0Selected = selectedOfCompiled(compiled)
  const s1Selected = selection.selectedAnchorIds
  const s0 = {
    ...metrics(caseData, s0Selected),
    tokens: compiled.tokens,
    bodyOverBudget: compiled.tokens > caseData.budget,
    pinnedOverflow: compiled.overflow,
    omitted: compiled.omitted.length,
    stable: compiled.working.map(anchor => anchor.id).join(',')
      === compiledReversed.working.map(anchor => anchor.id).join(','),
  }
  const s1 = {
    ...metrics(caseData, s1Selected),
    tokens: selection.tokenEstimate,
    contentTokens: selection.contentTokens,
    bodyOverBudget: selection.bodyOverBudget,
    pinnedOverflow: selection.pinnedOverflow,
    omitted: selection.omittedAnchorIds.length,
    stable: selection.selectionDigest === selectionReversed.selectionDigest,
    unresolvedCoverage: selection.unresolvedCoverage,
    scores: selection.scores,
    reasons: selection.reasons,
    retrievalCandidates: selection.retrievalCandidates.length,
  }
  return {
    id: caseData.id,
    description: caseData.description,
    budget: caseData.budget,
    anchors: caseData.anchors.length,
    greedy: caseData.greedy ?? null,
    s0,
    s1,
    invariants: invariants(caseData, selection),
    delta: {
      criticalVisible: s1.criticalVisible - s0.criticalVisible,
      negativeKnowledgeVisible: s1.negativeKnowledgeVisible - s0.negativeKnowledgeVisible,
      unrelatedTokens: s1.unrelatedTokens - s0.unrelatedTokens,
      scopePrecision: Number((s1.scopePrecision - s0.scopePrecision).toFixed(4)),
    },
  }
}

export function runAblation() {
  return cases.map(runCase)
}

async function main() {
  const rows = runAblation()
  const greedy = rows.find(row => row.id === 'greedy-skip')
  const checks = [
    {
      id: 'greedy-rescues-smaller-candidate',
      pass: greedy !== undefined
        && !greedy.s0.selected.includes('semantic-greedy-c')
        && greedy.s1.selected.includes('semantic-greedy-c'),
      detail: greedy === undefined ? 'missing case' : {
        s0: greedy.s0.selected,
        s1: greedy.s1.selected,
      },
    },
    {
      id: 'sets-are-disjoint-and-complete',
      pass: rows.every(row => row.invariants.disjoint && row.invariants.complete && row.invariants.pinnedAllSelected),
      detail: rows.map(row => ({ id: row.id, ...row.invariants })),
    },
    {
      id: 'pinned-overflow-is-reported-not-hidden',
      pass: rows.find(row => row.id === 'pinned-overflow')?.s1.pinnedOverflow === true
        && rows.find(row => row.id === 'pinned-overflow')?.s1.criticalVisible === 1,
    },
    {
      id: 'selected-content-fits-budget',
      pass: rows.every(row => row.s1.contentTokens <= row.budget || row.s1.pinnedOverflow),
      detail: rows.map(row => ({ id: row.id, content: row.s1.contentTokens, budget: row.budget, pinnedOverflow: row.s1.pinnedOverflow })),
    },
    {
      id: 'selection-is-stable',
      pass: rows.every(row => row.s1.stable),
    },
  ]
  const passed = checks.filter(check => check.pass).length
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'R38-M0',
    work: 'WP3-task-aware-selection',
    status: passed === checks.length ? 'passed' : 'failed',
    mode: 'shadow',
    productionDefaultChanged: false,
    estimator: 'chars-per-4',
    summary: {
      cases: rows.length,
      checks: checks.length,
      passed,
      failed: checks.length - passed,
    },
    checks,
    cases: rows,
  }
  await writeJson(OUT, report)
  process.stdout.write(`R38 working-set ablation: ${OUT}\n`)
  process.stdout.write(`status ${report.status}; ${passed}/${checks.length} checks passed\n`)
  for (const row of rows) {
    process.stdout.write(`  ${row.id}: S0 critical ${row.s0.criticalVisible}/${row.s0.criticalTotal} `
      + `tokens ${row.s0.tokens}; S1 critical ${row.s1.criticalVisible}/${row.s1.criticalTotal} tokens ${row.s1.tokens}\n`)
  }
  process.exit(report.status === 'passed' ? 0 : 1)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) await main()
