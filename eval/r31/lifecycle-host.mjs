#!/usr/bin/env node
/**
 * R31-D1: a real two-process JSONL lifecycle for Semantic Continuity.
 *
 * This is NOT a `Session.create()` simulation. Each mode mounts the real DSH
 * runtime + JSONL persistence, creates/opens a stored session, performs a real
 * Basic compaction through the EF engine, flushes through the host's
 * `session/flush` barrier, closes the write handle, and exits. The second mode
 * starts a NEW OS process, reopens the same artifact, replays the EF journal,
 * folds again, and exercises exact recall through `ctx.tools`.
 *
 * Usage:
 *   node eval/r31/lifecycle-host.mjs write <root> <sessionId>
 *   node eval/r31/lifecycle-host.mjs read  <root> <sessionId>
 *
 * Environment:
 *   EF_NO_RECEIPT=1   inject a receipt-write failure in process A (the
 *                     cross-store crash: session committed, receipt missing)
 *
 * @module eval/r31/lifecycle-host
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readdir, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmRuntime,
  createMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyJsonl } from '@deepseek-ai/dsh-session-persistence-jsonl'
import EpistemicFoldPlugin from '../../lib/plugin.js'
import { locateFoldFrontier } from '../../lib/fold/frontier.js'
import { FileSemanticJournal } from '../../lib/semantic/journal.js'

const MODEL = 'r31-scripted-model'
const SIGNAL = new AbortController().signal
const FILLER = 'durable context padding '.repeat(90)

const mode = process.argv[2]
const root = process.argv[3]
const sessionId = process.argv[4]
if (mode === undefined || root === undefined || sessionId === undefined) {
  console.error('usage: lifecycle-host.mjs <write|read> <root> <sessionId>')
  process.exit(2)
}

/** Scripted provider: a real adapter on the real LLM seam, not a mocked engine. */
class ScriptedAdapter extends LlmAdapter {
  constructor() {
    super()
    this.reply = undefined
    this.writerCalls = 0
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000_000 },
    })
  }

  async *stream(options) {
    if (options.purpose !== 'compaction') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const last = options.messages[options.messages.length - 1]
    const isWriter = last?.content?.some(block =>
      block.type === 'text' && block.text.startsWith('You are the SEMANTIC WRITER')) === true
    if (!isWriter) {
      const text = '[EF1 L cp:unused]\n\ndigest'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.writerCalls += 1
    const text = this.reply ?? [
      '<handoff>', 'Continuing with the recorded state.', '</handoff>',
      '<deltas>', JSON.stringify({ deltas: [] }), '</deltas>',
    ].join('\n')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const writerReply = (handoff, deltas) => [
  '<handoff>', handoff, '</handoff>',
  '<deltas>', JSON.stringify({ deltas }), '</deltas>',
].join('\n')

function userMessage(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function conversation(session, turns) {
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', userMessage(`Task phase ${turn}: ${FILLER} user ${turn}`), {
      surfaceOp: 'append',
    })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Acknowledged phase ${turn}. ${FILLER}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
}

/**
 * The session's open turn/step, or the next turn when the tail is closed.
 *
 * A forked child ends with the fork's synthetic `turn/end`; a restored parent
 * may end inside an open turn. Hard-coding a turn number is what made the first
 * fork run write `step/start` without a matching `turn/start`.
 */
function turnState(session) {
  let turn = 0
  let open = false
  let step = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') {
      turn = Number(event.data.turn)
      open = true
      step = 0
    } else if (event.type === 'step/start') {
      step = Number(event.data.step)
    } else if (event.type === 'step/end') {
      step = 0
    } else if (event.type === 'turn/end') {
      open = false
    }
  }
  return { turn: open ? turn : turn + 1, step: step + 1, open }
}

function appendClosedTurn(session, userText, assistantText) {
  const state = turnState(session)
  if (!state.open) session.append('turn/start', { turn: state.turn })
  session.append('user/message', userMessage(`${userText} ${FILLER}`), { surfaceOp: 'append' })
  session.append('step/start', { turn: state.turn, step: state.step })
  session.append('assistant/message', {
    stream: [],
    turn: state.turn,
    step: state.step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `${assistantText} ${FILLER}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: state.turn, step: state.step })
  session.append('turn/end', { turn: state.turn, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: state.turn + 1 })
}

async function mount() {
  const ctx = new Context()
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  await applyJsonl(ctx, { root: join(root, 'sessions') })
  return ctx
}

const config = {
  mode: 'legacy',
  semanticContinuity: 'active',
  semanticMode: 'rationale',
  semanticWorkingSetTokens: 512,
  bundleRoot: join(root, 'bundles'),
  semanticRoot: join(root, 'semantic'),
}

async function fold(plugin, session, agent, signal) {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('nothing to fold')
  await plugin.engine.compactRegion(start, end, agent, signal)
  await plugin.engine.reconcileSemantics(session)
  return plugin.engine.publishedBundle?.rendered?.text ?? ''
}

async function outcome(payload) {
  const path = join(root, `outcome-${mode}.json`)
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
  process.stdout.write(`${path}\n`)
}

async function journalView(id) {
  const viewed = await new FileSemanticJournal(join(root, 'semantic')).list(SessionId(id))
  return {
    state: viewed.state,
    packets: viewed.packets.map(packet => ({
      packetId: packet.packetId,
      checkpointId: packet.checkpointId,
      status: packet.status,
      sourceDigest: packet.sourceDigest,
      legacyPacketId: packet.legacyPacketId,
    })),
    receipts: [...viewed.receipts.values()].map(receipt => ({
      packetId: receipt.packetId,
      outcome: receipt.outcome,
      replacementSeq: receipt.proof?.replacementSeq,
      commitOrder: receipt.proof?.commitOrder,
    })),
    legacy: viewed.legacy.length,
    orphans: viewed.orphans,
    rejectedReceipts: [...viewed.rejectedReceipts.keys()],
    invalid: viewed.invalid,
  }
}

if (mode === 'write') {
  if (process.env.EF_NO_RECEIPT === '1') {
    FileSemanticJournal.prototype.writeReceipt = async () => {
      throw new Error('injected receipt-write failure')
    }
  }
  const ctx = await mount()
  const createdAt = Date.now()
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(sessionId),
    createdAt,
    isSeeded: false,
    cwd: root,
  }
  const handle = await ctx.sessionPersistence.create(header)
  const session = ctx.sessions.create(SessionId(sessionId), { meta: { cwd: root, createdAt } })
  conversation(session, 2)
  const plugin = new EpistemicFoldPlugin(ctx, config)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter([MODEL], adapter)
  const agent = { session, options: { provider: MODEL, model: MODEL } }
  adapter.reply = writerReply('We chose a lease; the timeout is 30 seconds.', [{
    kind: 'constraint',
    subjectKey: 'timeout',
    statement: 'The timeout is 30 seconds.',
    status: 'claimed',
    evidence: [{ quote: 'Task phase 1' }],
  }])
  const body = await fold(plugin, session, agent, SIGNAL)

  // The real durability barrier. `session/flush` is the host's one checkpoint;
  // the journal packet was already written atomically before the commit.
  await ctx.sessions.flush(session)
  await handle.flush()
  const diagnostics = plugin.engine.semanticDiagnostics
  await outcome({
    mode,
    sessionSeq: session.seq,
    surfaceNodes: [...session.surface.nodes],
    body,
    diagnostics: {
      health: diagnostics.health,
      detail: diagnostics.detail,
      committed: diagnostics.committed,
      mode: diagnostics.mode,
    },
    journal: await journalView(sessionId),
    receiptPath: join(root, 'semantic', sessionId),
  })
  await handle.close()
  process.exit(0)
}

if (mode === 'read') {
  const ctx = await mount()
  const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'write')
  const stored = await handle.read(0)
  const header = handle.header
  // The OFFICIAL resume shape: the stored log is the seed, the inherited cut
  // travels beside it, and the lineage fields survive. Dropping `isSeeded`,
  // `parentSession`, or `inheritedEventCount` here would make a forked child
  // look like an unrelated session with a copied prefix.
  const session = ctx.sessions.create(SessionId(sessionId), {
    seed: [...stored.events],
    meta: {
      cwd: root,
      createdAt: header.createdAt,
      isSeeded: header.isSeeded,
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    },
    inheritedEventCount: Number(handle.inheritedEventCount),
  })
  // DSH's restored Session appends a local `session/end-seed` marker during
  // construction, before the store's publication hooks exist. The persistence
  // handle still expects the next stored seq to be that marker, so persist it
  // through the real handle API before any live append. Without this bridge the
  // first live batch starts one seq late and the backend rejects it — which is
  // the installable-package gap this test makes visible, not a bypass of it.
  const localSeedEvents = session.snapshotEvents().slice(stored.events.length)
  if (localSeedEvents.length > 0) await handle.append([...localSeedEvents])
  const plugin = new EpistemicFoldPlugin(ctx, config)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter([MODEL], adapter)
  const agent = { session, options: { provider: MODEL, model: MODEL } }

  const reconcile = await plugin.engine.reconcileSemantics(session)
  const diagnosticsBefore = plugin.engine.semanticDiagnostics
  if (process.env.EF_DEBUG_HOST === '1') {
    console.error('EVENTS', stored.events.length, Number(stored.events[stored.events.length - 1]?.seq), 'session', session.seq)
    console.error('EV17', JSON.stringify(session.eventAt(17)?.type), JSON.stringify(session.eventAt(17)?.data)?.slice(0, 200))
    ctx.on('session/event', (_session, event) => console.error('EV', event.seq, event.type))
  }
  appendClosedTurn(session, 'Second phase starts here. Keep the timeout.', 'Noted.')
  adapter.reply = writerReply('Carrying the recorded state into the second phase.', [{
    kind: 'decision',
    subjectKey: 'phase-two',
    statement: 'The second phase keeps the 30 second timeout.',
    status: 'claimed',
    evidence: [{ quote: 'Second phase starts here' }],
  }])
  const body = await fold(plugin, session, agent, SIGNAL)

  const view = await journalView(sessionId)
  const committed = view.receipts
    .filter(receipt => receipt.outcome === 'committed')
    .sort((left, right) => (left.commitOrder ?? 0) - (right.commitOrder ?? 0))[0]
  const firstPacket = view.packets.find(packet => packet.packetId === committed?.packetId)
  const recall = firstPacket === undefined
    ? { skipped: 'no committed checkpoint' }
    : await ctx.tools.execute({
        callId: `call-${randomUUID()}`,
        name: 'context_recall',
        arguments: {
          ref: `cp:${firstPacket.checkpointId}`,
          depth: 'exact',
          offset: 0,
          limit: 1,
        },
        agent,
        signal: SIGNAL,
      })
  await ctx.sessions.flush(session)
  await handle.flush()
  const diagnosticsAfter = plugin.engine.semanticDiagnostics
  await outcome({
    mode,
    replayedEvents: stored.events.length,
    storedHeader: {
      id: String(header.id),
      version: header.version,
      createdAt: header.createdAt,
      isSeeded: header.isSeeded,
      parentSession: header.parentSession === undefined ? undefined : String(header.parentSession),
      inheritedEventCount: Number(handle.inheritedEventCount),
    },
    reconcile,
    diagnosticsBefore: {
      health: diagnosticsBefore.health,
      committed: diagnosticsBefore.committed,
      reconciled: diagnosticsBefore.reconciled,
      detail: diagnosticsBefore.detail,
      blockedNotice: body.includes('SEMANTIC STATE INCOMPLETE'),
    },
    body,
    surfaceNodes: [...session.surface.nodes],
    diagnosticsAfter: {
      health: diagnosticsAfter.health,
      committed: diagnosticsAfter.committed,
      reconciled: diagnosticsAfter.reconciled,
      detail: diagnosticsAfter.detail,
    },
    journal: view,
    recall: recall === undefined
      ? { unavailable: true }
      : {
          isError: recall.isError,
          content: recall.content,
        },
    files: await readdir(join(root, 'semantic', sessionId)).catch(() => []),
  })
  await handle.close()
  process.exit(0)
}

if (mode === 'fork') {
  const childId = process.argv[5]
  if (childId === undefined) {
    console.error('usage: lifecycle-host.mjs fork <root> <parentId> <childId> [boundary]')
    process.exit(2)
  }
  const ctx = await mount()
  const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'write')
  const stored = await handle.read(0)
  const header = handle.header
  const parent = ctx.sessions.create(SessionId(sessionId), {
    seed: [...stored.events],
    meta: {
      cwd: root,
      createdAt: header.createdAt,
      isSeeded: header.isSeeded,
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    },
    inheritedEventCount: Number(handle.inheritedEventCount),
  })
  const localSeedEvents = parent.snapshotEvents().slice(stored.events.length)
  if (localSeedEvents.length > 0) await handle.append([...localSeedEvents])
  // Mounting the plugin is what makes the parent journal reachable to a child
  // through the same engine that will later reconcile it.
  void new EpistemicFoldPlugin(ctx, config)
  // `seq` is the NEXT append position; a fork boundary is an inclusive seq.
  const boundary = process.argv[6] === undefined ? Number(parent.seq) - 1 : Number(process.argv[6])
  const child = ctx.sessions.fork(parent, boundary, SessionId(childId))
  const childHandle = await ctx.sessionPersistence.create(child.header, {
    inheritedEventCount: Number(child.inheritedEventCount),
  })
  await childHandle.append([...child.snapshotEvents()])
  await childHandle.flush()
  await childHandle.close()
  await ctx.sessions.flush(parent)
  await handle.flush()
  await handle.close()
  await outcome({
    mode,
    parent: sessionId,
    child: childId,
    boundary,
    inheritedEventCount: Number(child.inheritedEventCount),
    childSeq: Number(child.seq),
    childEvents: child.snapshotEvents().length,
    journal: await journalView(sessionId),
  })
  process.exit(0)
}

console.error(`unknown mode ${mode}`)
process.exit(2)
