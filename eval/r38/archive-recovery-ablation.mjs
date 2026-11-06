#!/usr/bin/env node
/**
 * R38-M0 WP4: bounded archive-recovery ablation.
 *
 * S0 = production working set
 * S1 = task-aware selection
 * S2 = S1 + bounded archive recovery
 *
 * The archive is written through the REAL `FileBundleStore` and read through
 * the REAL `recall` (detail, then exact). The bundles are synthetic fixtures,
 * not engine output; the store and the recall path are production code.
 *
 * Retrieval terms come from the TASK FRAME, never from the answer. The check
 * `query-does-not-contain-the-gold` asserts that structurally.
 *
 * Output: eval/r38/out/archive-recovery-ablation.json
 *
 * @module eval/r38/archive-recovery-ablation
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { FileBundleStore } from '../../lib/checkpoint/bundle-store.js'
import { canonicalHash } from '../../src/checkpoint/hash.ts'
import { emptyCurrentState, stateKeyText } from '../../src/state/state.ts'
import { compileWorkingSet } from '../../src/semantic/working-set-compiler.ts'
import { selectTaskAwareContext } from './src/task-aware-selector.ts'
import { recoverFromArchive, DEFAULT_RECOVERY_BUDGET } from './src/archive-recovery.ts'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out', 'archive-recovery-ablation.json')
const SESSION = SessionId('r38-archive-session')
const estimate = text => Math.ceil(text.length / 4)

const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = text => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'fixture', model: 'fixture' },
})

/** A bundle that passes `FileBundleStore.verify` (logical and rendered digests). */
function bundleOf(options) {
  const renderedText = `[EF1 L cp:${options.checkpointId}]`
  return {
    format: 'ef-checkpoint',
    formatVersion: 1,
    checkpointId: options.checkpointId,
    sessionId: SESSION,
    createdAt: options.createdAt,
    mode: 'leaf',
    source: {
      orderedSurfaceSeqs: options.seqs,
      sourceDigest: canonicalHash(options.seqs),
    },
    archive: {
      shadowedMessages: options.messages,
      messageCount: options.messages.length,
      logicalHash: canonicalHash(options.messages),
      refs: options.seqs.map((seq, index) => ({
        seq,
        digest: canonicalHash(options.messages[index] ?? options.messages[0]),
      })),
    },
    rendered: { text: renderedText, digest: canonicalHash(renderedText) },
  }
}

function makeAnchor(options) {
  const anchorKind = options.semanticKind === 'finding' ? 'evidence' : options.semanticKind
  return {
    id: options.id,
    kind: anchorKind,
    stateKey: { namespace: 'semantic', entity: options.semanticKind, property: options.property },
    value: options.value,
    authority: options.authority,
    lifecycle: 'active',
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
    sessionId: String(SESSION),
    taskId: options.taskId,
    phase: 'editing',
    files: [],
    symbols: [],
    currentRequest: options.request,
    semanticStateRevision: 'r1',
    sessionEventWatermark: 100,
  }
}

/** The S2 body: the S1 selection plus the recovered passages, clearly labelled. */
function withRecovered(selection, recovery) {
  if (recovery.recovered.length === 0) return selection.renderedText
  const lines = recovery.recovered.map(passage =>
    `- [archive ${passage.checkpointId}:${passage.offset}] ${passage.excerpt}`)
  return `${selection.renderedText}\n\nRecovered from archive\n${lines.join('\n')}`
}

const cases = []

/** 1. H1-v2 shape: the production region is archive-only. */
{
  const checkpointOne = bundleOf({
    checkpointId: 'cp-h1-old', createdAt: 1, seqs: [1, 2],
    messages: [
      user('The production deployment region must be eu-west-2.'),
      assistant('Acknowledged.'),
    ],
  })
  const checkpointTwo = bundleOf({
    checkpointId: 'cp-h1-new', createdAt: 2, seqs: [3, 4],
    messages: [
      user('The staging region is us-east-1.'),
      assistant('Noted.'),
    ],
  })
  const anchors = [
    makeAnchor({ id: 'stale-region', semanticKind: 'decision', property: 'deploy-region', value: 'Deploy to us-east-1.', authority: 'decision', seq: 5 }),
    makeAnchor({ id: 'noise-region', semanticKind: 'finding', property: 'region-probe', value: 'The region probe returned 200.', authority: 'empirical', seq: 6 }),
  ]
  cases.push({
    id: 'h1-production-region',
    description: 'the correct production region was never extracted into state',
    bundles: [checkpointOne, checkpointTwo],
    anchors,
    frame: frameOf({ taskId: 'h1', request: 'Change the production deployment region.' }),
    terms: ['production', 'deployment', 'region'],
    criticalTerm: 'eu-west-2',
    forbiddenTerms: ['us-east-1'],
    requiredScopeTerm: 'production',
    budget: DEFAULT_RECOVERY_BUDGET,
  })
}

/** 2. S1-v1 shape: the production timeout exists only in the archive. */
{
  const checkpoint = bundleOf({
    checkpointId: 'cp-s1', createdAt: 1, seqs: [1, 2, 3, 4],
    messages: [
      user('Production timeouts must stay at 30 seconds.'),
      assistant('Understood.'),
      user('Staging timeouts may be 5 seconds.'),
      assistant('Noted.'),
    ],
  })
  const anchors = [
    makeAnchor({ id: 'staging-timeout', semanticKind: 'decision', property: 'timeout', value: 'Staging timeouts are 5 seconds.', authority: 'decision', seq: 5 }),
  ]
  cases.push({
    id: 's1-production-timeout',
    description: 'the production timeout is archive-only while staging is in state',
    bundles: [checkpoint],
    anchors,
    frame: frameOf({ taskId: 's1', request: 'Check the production timeout before release.' }),
    terms: ['production', 'timeout'],
    criticalTerm: '30 seconds',
    forbiddenTerms: [],
    requiredScopeTerm: 'production',
    budget: DEFAULT_RECOVERY_BUDGET,
  })
}

/** 3. A genuine miss: the fact is in neither state nor archive. */
{
  const checkpoint = bundleOf({
    checkpointId: 'cp-miss', createdAt: 1, seqs: [1],
    messages: [user('The logging format is ISO 8601.')],
  })
  cases.push({
    id: 'archive-miss',
    description: 'a fact present in neither state nor archive is reported as not found in the checked scope',
    bundles: [checkpoint],
    anchors: [],
    frame: frameOf({ taskId: 'miss', request: 'Check the production timeout.' }),
    terms: ['production', 'timeout'],
    criticalTerm: '30 seconds',
    forbiddenTerms: [],
    requiredScopeTerm: 'production',
    budget: DEFAULT_RECOVERY_BUDGET,
  })
}

/** 4. The descriptor bound stops before the checkpoint that holds the fact. */
{
  const old = bundleOf({
    checkpointId: 'cp-budget-old', createdAt: 1, seqs: [1],
    messages: [user('The production deployment region must be eu-west-2.')],
  })
  const recent = bundleOf({
    checkpointId: 'cp-budget-new', createdAt: 2, seqs: [2],
    messages: [user('The staging region is us-east-1.')],
  })
  cases.push({
    id: 'descriptor-budget',
    description: 'one descriptor is inspected; the answer is in the skipped checkpoint',
    bundles: [old, recent],
    anchors: [],
    frame: frameOf({ taskId: 'budget', request: 'Change the production deployment region.' }),
    terms: ['production', 'deployment', 'region'],
    criticalTerm: 'eu-west-2',
    forbiddenTerms: [],
    requiredScopeTerm: 'production',
    budget: { ...DEFAULT_RECOVERY_BUDGET, maxArchiveDescriptors: 1 },
  })
}

/** 5. Scope terms keep another repository's fact out of the result. */
{
  const checkpoint = bundleOf({
    checkpointId: 'cp-scope', createdAt: 1, seqs: [1, 2],
    messages: [
      user('Repository A uses a 30 second timeout.'),
      user('Repository B uses a five minute timeout.'),
    ],
  })
  cases.push({
    id: 'scope-mismatch',
    description: 'the query names repository A; repository B must not be returned',
    bundles: [checkpoint],
    anchors: [],
    frame: frameOf({ taskId: 'scope', request: 'Check repository A timeout.' }),
    terms: ['repository a', 'timeout'],
    criticalTerm: '30 second',
    forbiddenTerms: ['repository b'],
    requiredScopeTerm: 'repository a',
    budget: DEFAULT_RECOVERY_BUDGET,
  })
}

async function runCase(caseData, store, root) {
  for (const bundle of caseData.bundles) await store.write(bundle)
  const state = stateWith(caseData.anchors)
  const stateDigestBefore = canonicalHash(state)
  const compiled = compileWorkingSet({ state, budgetTokens: 256, estimate })
  const selection = selectTaskAwareContext({ state, frame: caseData.frame, budgetTokens: 256 })
  const recovery = await recoverFromArchive({
    store,
    sessionId: SESSION,
    terms: caseData.terms,
    activeText: selection.renderedText,
    budget: caseData.budget,
  })
  const s2Text = withRecovered(selection, recovery)
  const stateDigestAfter = canonicalHash(state)

  const s0Text = compiled.text
  const s1Text = selection.renderedText
  const contains = (text, term) => text.toLowerCase().includes(term.toLowerCase())
  const critical = term => ({
    s0: contains(s0Text, term),
    s1: contains(s1Text, term),
    s2: contains(s2Text, term),
  })
  const falseRetrieval = recovery.recovered.filter(passage =>
    caseData.forbiddenTerms.some(term => contains(passage.excerpt, term))).length
  const scopeCorrect = recovery.recovered.filter(passage =>
    contains(passage.excerpt, caseData.requiredScopeTerm)).length

  // Remove the bundles so the next case starts from an empty archive.
  for (const bundle of caseData.bundles) await store.remove(SESSION, bundle.checkpointId).catch(() => {})

  return {
    id: caseData.id,
    description: caseData.description,
    terms: caseData.terms,
    criticalTerm: caseData.criticalTerm,
    coverage: critical(caseData.criticalTerm),
    recovery: {
      status: recovery.status,
      recovered: recovery.recovered.length,
      inspectedCheckpoints: recovery.inspectedCheckpoints,
      searchOperations: recovery.searchOperations,
      exactPages: recovery.exactPages,
      returnedChars: recovery.returnedChars,
      returnedTokens: recovery.returnedTokens,
      truncated: recovery.truncated,
      notes: recovery.notes,
    },
    metrics: {
      criticalCoverage: critical(caseData.criticalTerm),
      archiveOnlyRescue: recovery.recovered.length > 0 && !critical(caseData.criticalTerm).s1,
      falseRetrieval,
      scopeCorrect,
      scopeCorrectness: recovery.recovered.length === 0 ? 1 : scopeCorrect / recovery.recovered.length,
      tokenOverhead: estimate(s2Text) - estimate(s1Text),
      s0Tokens: estimate(s0Text),
      s1Tokens: estimate(s1Text),
      s2Tokens: estimate(s2Text),
      retrievalCost: recovery.searchOperations + recovery.exactPages,
    },
    bounds: {
      withinDescriptors: recovery.inspectedCheckpoints.length <= caseData.budget.maxArchiveDescriptors,
      withinSearch: recovery.searchOperations <= caseData.budget.maxSearchOperations,
      withinExact: recovery.exactPages <= caseData.budget.maxExactPages,
      withinChars: recovery.returnedChars <= caseData.budget.maxReturnedChars,
      withinTokens: recovery.returnedTokens <= caseData.budget.maxReturnedTokens,
    },
    authority: {
      recoveredIsArchive: recovery.recovered.every(passage => passage.checkpointId.length > 0),
      stateDigestUnchanged: stateDigestBefore === stateDigestAfter,
      stateUnchangedFlag: recovery.stateUnchanged === true,
    },
    root,
  }
}

export async function runAblation() {
  const root = await mkdtemp(join(tmpdir(), 'ef-r38-archive-'))
  const store = new FileBundleStore(join(root, 'bundles'))
  const rows = []
  try {
    for (const caseData of cases) rows.push(await runCase(caseData, store, root))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
  return rows
}

async function main() {
  const rows = await runAblation()
  const byId = new Map(rows.map(row => [row.id, row]))
  const checks = [
    {
      id: 'archive-only-rescue',
      pass: byId.get('h1-production-region')?.metrics.archiveOnlyRescue === true
        && byId.get('s1-production-timeout')?.metrics.archiveOnlyRescue === true,
      detail: rows.map(row => ({ id: row.id, rescue: row.metrics.archiveOnlyRescue })),
    },
    {
      id: 'honest-not-found',
      pass: byId.get('archive-miss')?.recovery.status === 'not-found-in-checked-scope',
    },
    {
      id: 'honest-coverage-not-assessed',
      pass: byId.get('descriptor-budget')?.recovery.status === 'coverage-not-assessed',
    },
    {
      id: 'no-false-retrieval',
      pass: rows.every(row => row.metrics.falseRetrieval === 0),
    },
    {
      id: 'scope-correct',
      pass: rows.every(row => row.metrics.scopeCorrectness === 1),
    },
    {
      id: 'state-not-modified',
      pass: rows.every(row => row.authority.stateDigestUnchanged && row.authority.stateUnchangedFlag),
    },
    {
      id: 'bounds-enforced',
      pass: rows.every(row => Object.values(row.bounds).every(Boolean)),
    },
    {
      id: 'query-does-not-contain-the-gold',
      pass: rows.every(row => row.terms.every(term => !row.criticalTerm.toLowerCase().includes(term.toLowerCase())
        || term.length < 3)),
      detail: rows.map(row => ({ id: row.id, terms: row.terms, critical: row.criticalTerm })),
    },
  ]
  const passed = checks.filter(check => check.pass).length
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'R38-M0',
    work: 'WP4-archive-recovery',
    status: passed === checks.length ? 'passed' : 'failed',
    store: 'FileBundleStore',
    recall: 'recall(detail) -> recall(exact)',
    embeddingBackend: false,
    summary: { cases: rows.length, checks: checks.length, passed, failed: checks.length - passed },
    checks,
    cases: rows,
  }
  await writeJson(OUT, report)
  process.stdout.write(`R38 archive recovery: ${OUT}\n`)
  process.stdout.write(`status ${report.status}; ${passed}/${checks.length} checks passed\n`)
  for (const row of rows) {
    process.stdout.write(`  ${row.id}: ${row.recovery.status}; S0 ${row.coverage.s0} S1 ${row.coverage.s1} S2 ${row.coverage.s2}; `
      + `cost ${row.metrics.retrievalCost}; overhead ${row.metrics.tokenOverhead}\n`)
  }
  process.exit(report.status === 'passed' ? 0 : 1)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) await main()
