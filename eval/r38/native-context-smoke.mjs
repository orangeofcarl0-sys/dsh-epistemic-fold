#!/usr/bin/env node
/**
 * R38-M0 WP6: native context delivery smoke (scripted adapter, no model).
 *
 * The overlay is delivered through the REAL DSH system-prompt context channel.
 * The DSH agent loop turns all contexts into a logged `user/message` with
 * `source.kind = 'runtime-context'` and re-emits it only when the text changes.
 * That is the cache-friendly, replayable injection path this smoke verifies.
 *
 * It does NOT rewrite the checkpoint, the journal, or the session log.
 *
 * N0 same state/frame -> stable digest and ONE snapshot
 * N1 task change       -> new overlay and a new snapshot
 * N2 recent tail       -> the old decision is marked unsafe to assert
 * N3 restart/resume    -> the same overlay is delivered after a real reload
 * N4 integrity warning -> the overlay carries the diagnostic
 * N5 archive recovery  -> the overlay carries the passage and its source ref
 *
 * Output: eval/r38/out/native-context-smoke.json
 *
 * @module eval/r38/native-context-smoke
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { LlmAdapter, LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { apply as applyJsonlPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { emptyCurrentState, stateKeyText } from '../../src/state/state.ts'
import { buildContextOverlay } from './src/context-overlay.ts'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env['R38_NATIVE_OUT'] ?? join(HERE, 'out', 'native-context-smoke.json')
const PROVIDER = 'r38-scripted'
const MODEL = 'r38-native-smoke'
const OVERLAY_NAME = 'epistemic-fold-overlay'

function textOf(message) {
  return (message.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

class RecordingAdapter extends LlmAdapter {
  constructor() {
    super()
    this.calls = []
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  async *stream(options) {
    this.calls.push(options.messages.map(message => ({
      role: message.role,
      source: message.source?.kind ?? null,
      text: textOf(message),
    })))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Acknowledged.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Acknowledged.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mount({ persistenceRoot = null, adapter }) {
  const ctx = new Context()
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  new AgentRegistry(ctx)
  if (persistenceRoot !== null) {
    await applyJsonlPersistence(ctx, { root: persistenceRoot, compression: 'none' })
  }
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: createVolatile(1) })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx }
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
    if (anchor.kind === 'constraint') state.constraints[anchor.id] = anchor
  }
  return state
}

const STATE = stateWith([
  makeAnchor({
    id: 'queue', semanticKind: 'decision', property: 'scheduler-queue',
    value: 'Use the in-memory queue.', authority: 'decision', seq: 10,
  }),
  makeAnchor({
    id: 'release', semanticKind: 'constraint', property: 'release-gate',
    value: 'Production deploys require a signed release.', authority: 'normative', seq: 10,
  }),
])

const WATERMARKS = {
  semanticCommitWatermark: 10,
  sessionEventWatermark: 12,
  archiveRevision: 'cp-1',
  taskFrameRevision: 'tf-1',
}

const EVENTS = [{
  seq: 12,
  role: 'user',
  text: 'Approve the durable outbox for scheduler dispatch.',
}]

const FRAME_ONE = {
  sessionId: 'native-smoke',
  taskId: 'frame-one',
  phase: 'editing',
  files: [],
  symbols: [],
  currentRequest: 'Modify the scheduler queue.',
  semanticStateRevision: 'r1',
  sessionEventWatermark: 12,
}

const FRAME_TWO = {
  sessionId: 'native-smoke',
  taskId: 'frame-two',
  phase: 'editing',
  files: [],
  symbols: [],
  currentRequest: 'Use the durable outbox for scheduler dispatch.',
  semanticStateRevision: 'r1',
  sessionEventWatermark: 12,
}

function contextMessages(agent) {
  return agent.session.snapshotEvents().filter(event => {
    if (event.type !== 'user/message') return false
    const message = event.data?.message ?? event.data
    return message?.source?.kind === 'runtime-context'
  })
}

function lastContextText(call) {
  const entries = call.filter(message => message.source === 'runtime-context')
  return entries.length === 0 ? '' : entries[entries.length - 1].text
}

function systemText(call) {
  const entry = call.find(message => message.role === 'system' || message.source === 'system-prompt')
  return entry === undefined ? '' : entry.text
}

async function runStep(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

export async function runSmoke() {
  const workspace = await mkdtemp(join(tmpdir(), 'r38-native-ctx-'))
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'r38-native-ctx-store-'))
  const sessionId = SessionId(`r38-native-${randomUUID()}`)
  const adapter = new RecordingAdapter()
  const box = { overlay: null }
  const observations = {}

  const overlayOne = buildContextOverlay({
    state: STATE, frame: FRAME_ONE, budgetTokens: 256, events: EVENTS, watermarks: WATERMARKS,
  })
  const overlayTwo = buildContextOverlay({
    state: STATE, frame: FRAME_TWO, budgetTokens: 256, events: EVENTS, watermarks: WATERMARKS,
    previousText: overlayOne.text,
  })
  const overlayIntegrity = buildContextOverlay({
    state: STATE, frame: FRAME_TWO, budgetTokens: 256, events: EVENTS, watermarks: WATERMARKS,
    integrityWarnings: ['stale-negative-knowledge: the rejected outbox is still active'],
    previousText: overlayTwo.text,
  })
  const overlayRecovered = buildContextOverlay({
    state: STATE, frame: FRAME_TWO, budgetTokens: 256, events: EVENTS, watermarks: WATERMARKS,
    recovered: [{
      checkpointId: 'cp-archive',
      offset: 3,
      role: 'user',
      excerpt: 'The production deployment region must be eu-west-2.',
      sourceRefs: [7],
    }],
    previousText: overlayIntegrity.text,
  })

  const first = await mount({ persistenceRoot, adapter })
  const systemPrompt = first.ctx.get('systemPrompt')
  systemPrompt.context({
    name: OVERLAY_NAME,
    order: 900,
    text: () => box.overlay?.text ?? '',
    interpolate: false,
  })
  const handle = await first.ctx.agents.create({
    sessionId,
    agentOptions: { provider: PROVIDER, model: MODEL },
    meta: { cwd: workspace },
    setup: () => {},
  })

  // N0 step 1.
  box.overlay = overlayOne
  await runStep(handle.agent, 'First step.')
  const callOne = adapter.calls.at(-1)
  observations.n0First = {
    overlayDelivered: lastContextText(callOne).includes('[EF context overlay]'),
    selectionDigestInMessage: lastContextText(callOne).includes(overlayOne.selectionDigest),
    systemHasOverlay: systemText(callOne).includes('[EF context overlay]'),
    contextEvents: contextMessages(handle.agent).length,
    systemText: systemText(callOne),
  }

  // N0 step 2: identical overlay must not create a second snapshot.
  await runStep(handle.agent, 'Second step.')
  const callTwo = adapter.calls.at(-1)
  observations.n0Second = {
    overlayDelivered: lastContextText(callTwo).includes('[EF context overlay]'),
    contextEvents: contextMessages(handle.agent).length,
    digestStable: overlayOne.renderedDigest === buildContextOverlay({
      state: STATE, frame: FRAME_ONE, budgetTokens: 256, events: EVENTS, watermarks: WATERMARKS,
    }).renderedDigest,
    prefixStable: systemText(callTwo) === systemText(callOne),
  }

  // N1: the task changes; the overlay changes and a new snapshot is emitted.
  box.overlay = overlayTwo
  await runStep(handle.agent, 'Third step.')
  const callThree = adapter.calls.at(-1)
  observations.n1 = {
    contextEvents: contextMessages(handle.agent).length,
    newSelectionDelivered: lastContextText(callThree).includes(overlayTwo.selectionDigest),
    digestChanged: overlayTwo.renderedDigest !== overlayOne.renderedDigest,
    changedBytes: overlayTwo.changedBytes,
    prefixStable: systemText(callThree) === systemText(callOne),
  }

  // N2: the tail warning marks the old decision unsafe to assert.
  observations.n2 = {
    warningPresent: overlayTwo.text.includes('reconcile queue'),
    unsafeLinePresent: overlayTwo.text.includes('unsafe-to-assert') && overlayTwo.text.includes('queue'),
    oldValuePresent: overlayTwo.text.includes('Use the in-memory queue.'),
  }

  // N4: an integrity finding travels in the overlay.
  box.overlay = overlayIntegrity
  await runStep(handle.agent, 'Fourth step.')
  const callFour = adapter.calls.at(-1)
  observations.n4 = {
    integrityWarningDelivered: lastContextText(callFour).includes('integrity: stale-negative-knowledge'),
    contextEvents: contextMessages(handle.agent).length,
  }

  // N5: an archive passage travels with its source ref.
  box.overlay = overlayRecovered
  await runStep(handle.agent, 'Fifth step.')
  const callFive = adapter.calls.at(-1)
  observations.n5 = {
    recoveredDelivered: lastContextText(callFive).includes('Recovered from archive'),
    sourceRefDelivered: lastContextText(callFive).includes('cp-archive:3 seq 7'),
    contextEvents: contextMessages(handle.agent).length,
  }

  const beforeRestartDigest = overlayTwo.renderedDigest
  await handle.dispose()
  await first.ctx.dispose?.()

  // N3: a real reload from JSONL persistence.
  const secondAdapter = new RecordingAdapter()
  const second = await mount({ persistenceRoot, adapter: secondAdapter })
  const secondPrompt = second.ctx.get('systemPrompt')
  secondPrompt.context({
    name: OVERLAY_NAME,
    order: 900,
    text: () => box.overlay?.text ?? '',
    interpolate: false,
  })
  box.overlay = overlayTwo
  let resumed = null
  let resumeError = null
  try {
    resumed = await second.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: PROVIDER, model: MODEL },
      setup: () => {},
    })
    await runStep(resumed.agent, 'After restart.')
    const call = secondAdapter.calls.at(-1)
    observations.n3 = {
      resumeError: null,
      overlayDelivered: lastContextText(call).includes('[EF context overlay]'),
      selectionDigestDelivered: lastContextText(call).includes(overlayTwo.selectionDigest),
      digestStable: buildContextOverlay({
        state: STATE, frame: FRAME_TWO, budgetTokens: 256, events: EVENTS, watermarks: WATERMARKS,
      }).renderedDigest === beforeRestartDigest,
      persistedContextEvents: contextMessages(resumed.agent).length,
    }
  } catch (error) {
    resumeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    observations.n3 = { resumeError, overlayDelivered: false }
  }
  if (resumed !== null) await resumed.dispose()
  await second.ctx.dispose?.()

  await rm(workspace, { recursive: true, force: true })
  await rm(persistenceRoot, { recursive: true, force: true })

  const checks = [
    {
      id: 'N0-stable-context',
      pass: observations.n0First.overlayDelivered
        && observations.n0First.selectionDigestInMessage
        && !observations.n0First.systemHasOverlay
        && observations.n0Second.contextEvents === 1
        && observations.n0Second.digestStable
        && observations.n0Second.prefixStable,
    },
    {
      id: 'N1-task-change',
      pass: observations.n1.contextEvents === 2
        && observations.n1.newSelectionDelivered
        && observations.n1.digestChanged
        && observations.n1.prefixStable,
    },
    {
      id: 'N2-recent-tail-warning',
      pass: observations.n2.warningPresent && observations.n2.unsafeLinePresent,
    },
    {
      id: 'N3-restart-replay',
      pass: observations.n3.resumeError === null
        && observations.n3.overlayDelivered
        && observations.n3.selectionDigestDelivered
        && observations.n3.digestStable,
    },
    {
      id: 'N4-integrity-warning',
      pass: observations.n4.integrityWarningDelivered,
    },
    {
      id: 'N5-archive-recovery',
      pass: observations.n5.recoveredDelivered && observations.n5.sourceRefDelivered,
    },
  ]
  const passed = checks.filter(check => check.pass).length
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'R38-M0',
    work: 'WP6-native-context-delivery',
    status: passed === checks.length ? 'passed' : 'failed',
    adapter: 'scripted',
    modelCalls: 0,
    providerCalls: 0,
    injection: 'systemPrompt.context -> runtime-context user/message',
    journalModified: false,
    checkpointRewritten: false,
    overlay: {
      one: { digest: overlayOne.renderedDigest, selection: overlayOne.selectionDigest, tokens: overlayOne.tokenEstimate },
      two: { digest: overlayTwo.renderedDigest, selection: overlayTwo.selectionDigest, tokens: overlayTwo.tokenEstimate, changedBytes: overlayTwo.changedBytes },
      integrity: { digest: overlayIntegrity.renderedDigest, warnings: overlayIntegrity.warnings },
      recovered: { digest: overlayRecovered.renderedDigest, passages: overlayRecovered.recoveredPassages },
    },
    summary: { checks: checks.length, passed, failed: checks.length - passed },
    checks,
    observations,
  }
  return report
}

async function main() {
  const report = await runSmoke()
  await writeJson(OUT, report)
  process.stdout.write(`R38 native context smoke: ${OUT}\n`)
  process.stdout.write(`status ${report.status}; ${report.summary.passed}/${report.summary.checks} checks passed\n`)
  for (const check of report.checks) process.stdout.write(`  ${check.pass ? 'PASS' : 'FAIL'} ${check.id}\n`)
  process.exit(report.status === 'passed' ? 0 : 1)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) await main()
