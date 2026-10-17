/**
 * Recall reachability: a folded task statement is recoverable through the tools alone.
 *
 * ## What this reproduces
 *
 * A real LHTB fold archived its task instruction verbatim at message index 0, and the model
 * still could not reach it: `context_search` with a natural-language query returned an empty
 * hit list, and `context_recall` at the default depth returned the same 40-character marker the
 * surface already showed it. The archive was correct; the INTERFACE was not.
 *
 * The fixture here is the same SHAPE with none of the benchmark's content: a long user task
 * statement at index 0, tool turns behind it, folded with no semantic face so the checkpoint
 * has no digest. Every assertion is about behaviour a model would experience, not about a
 * field merely existing.
 *
 * The probe query is the real one from the failing cell. It is deliberately lexically disjoint
 * from the task statement, so the recovery path is exercised the way it actually failed.
 *
 * @module tests/recall-reachability
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createHarness, foldAgent, SIGNAL } from './harness.ts'
import { encodeCheckpointMarker } from '../src/checkpoint/checkpoint-marker.ts'
import {
  DETAIL_INVENTORY_LINES,
  DETAIL_PAGE_CHARS,
  recall,
  searchWithDiagnosis,
} from '../src/recall/recall.ts'
import type { CheckpointBundleV1, FoldBundleStore } from '../src/types.ts'

/**
 * A task statement with the real one's SHAPE and none of its text.
 *
 * It shares two words with the probe query under prefix matching (engine/engineer,
 * output/outputs) exactly as the real instruction did, so the partial-match path is
 * exercised rather than assumed.
 */
const TASK = [
  'You must RECOVER THE TRUE SEMANTICS of an undocumented event-log format and REPAIR a buggy',
  'record-normalisation engine so that it produces the correct canonical output on inputs you',
  'never see. You do this stage by stage, through the evt command-line tool, editing the',
  'engine file with your normal shell tools.',
  '',
  '## The job',
  '',
  'A service reads a raw legacy record and normalises it into a fixed canonical schema.',
].join('\n')

/** The query from the failing cell, verbatim. */
const PROBE = 'task: reverse engineer hidden program CLI outputs'
function taskSession(turns: number, payloadChars = 200): Session {
  const session = Session.create(SessionId(`reach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: 'test-model', model: 'test-model' } },
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: TASK }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  for (let turn = 2; turn <= turns; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    const args = JSON.stringify({ command: `evt status --step ${turn}` })
    session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `probing step ${turn} of the normalisation engine` },
          { type: 'tool-call', id: callId, name: 'run_shell', arguments: args },
        ],
        source: { kind: 'model', provider: 'test-model', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'run_shell', arguments: args })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'step ' + turn + ' ok ' + 'payload '.repeat(Math.ceil(payloadChars / 8)) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
  }
  session.append('turn/end', { turn: turns, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** A folded session with NO semantic face, i.e. a checkpoint with no digest. */
async function folded(turns = 6, payloadChars = 200) {
  const { engine, store } = await createHarness()
  const session = taskSession(turns, payloadChars)
  const nodes = [...session.surface.nodes]
  await engine.compactRegion(nodes[0]!, nodes[nodes.length - 1]!, foldAgent(session), SIGNAL)
  const descriptors = await store.list(session.id)
  expect(descriptors.length).toBeGreaterThan(0)
  return { session, store, checkpointId: descriptors[0]!.checkpointId }
}

/** The concatenated text of one exact page's first message. */
function pageText(result: Awaited<ReturnType<typeof recall>>): string {
  const message = result?.page?.messages[0]
  if (message === undefined) return ''
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}
describe('recall reachability: the checkpoint itself is correct', () => {
  it('archives the task statement verbatim at message 0 of a marker-only checkpoint', async () => {
    const { store, session, checkpointId } = await folded()
    const bundle = await store.read(session.id, checkpointId)
    expect(bundle).not.toBeNull()
    // Marker-only: the checkpoint's whole view is its identity. This is the case that failed.
    const marker = encodeCheckpointMarker({ checkpointId, mode: bundle!.mode })
    // Marker-only: the checkpoint's view is its identity, optionally plus the compiler's
    // own "summary unavailable" boilerplate -- and NOTHING else. This is the case that failed.
    expect(bundle!.rendered.text).toContain(marker)
    expect(bundle!.semantic).toBeUndefined()
    const page = await recall({ store, sessionId: session.id, checkpointId, depth: 'exact', offset: 0, limit: 1 })
    expect(pageText(page)).toBe(TASK)
  })
})

describe('recall reachability: each depth means something different', () => {
  it('summary reports NO semantic summary instead of handing the marker back as content', async () => {
    const { store, session, checkpointId } = await folded()
    const result = await recall({ store, sessionId: session.id, checkpointId, depth: 'summary' })
    expect(result!.summaryAvailable).toBe(false)
    expect(result!.note).toMatch(/no semantic summary/)
  })

  it('detail returns a bounded, indexed inventory that reaches message 0', async () => {
    const { store, session, checkpointId } = await folded()
    const result = await recall({ store, sessionId: session.id, checkpointId, depth: 'detail' })
    const view = result!.descriptor
    expect(view).toBeDefined()
    expect(view!.entries.length).toBeGreaterThan(0)
    expect(view!.entries.length).toBeLessThanOrEqual(DETAIL_INVENTORY_LINES)
    const first = view!.entries[0]!
    expect(first.index).toBe(0)
    expect(first.offset).toBe(0)
    expect(first.role).toBe('user')
    expect(first.preview).toContain('RECOVER THE TRUE SEMANTICS')
    // Bounded: this payload is what replaces the fold, so it cannot undo it.
    expect(JSON.stringify(result).length).toBeLessThan(DETAIL_PAGE_CHARS + 600)
  })

  it('detail is NOT the marker: it carries strictly more than summary does', async () => {
    const { store, session, checkpointId } = await folded()
    const summary = await recall({ store, sessionId: session.id, checkpointId, depth: 'summary' })
    const detail = await recall({ store, sessionId: session.id, checkpointId, depth: 'detail' })
    expect(JSON.stringify(detail).length).toBeGreaterThan(JSON.stringify(summary).length * 3)
  })

  it('defaults to detail: neither the marker nor a 20-message exact page', async () => {
    const { store, session, checkpointId } = await folded()
    const result = await recall({ store, sessionId: session.id, checkpointId })
    expect(result!.depth).toBe('detail')
    expect(result!.descriptor).toBeDefined()
    expect(result!.page).toBeUndefined()
  })

  it('does not dump a long archived message at the default depth', async () => {
    const { store, session, checkpointId } = await folded(4, 40000)
    const result = await recall({ store, sessionId: session.id, checkpointId })
    const size = JSON.stringify(result).length
    expect(size).toBeLessThan(DETAIL_PAGE_CHARS + 600)
    // The bytes are still there, and still reachable when asked for explicitly.
    const page = await recall({ store, sessionId: session.id, checkpointId, depth: 'exact', offset: 0, limit: 20 })
    expect(JSON.stringify(page).length).toBeGreaterThan(size * 5)
  })
})
describe('recall reachability: search says what an empty answer means', () => {
  it('the real paraphrase query finds the task statement as a PARTIAL candidate', async () => {
    const { store, session } = await folded()
    const diagnosis = await searchWithDiagnosis({ store, sessionId: session.id, query: PROBE })
    // No phrase match exists, so this is never `hits`.
    expect(diagnosis.outcome).not.toBe('hits')
    // The token pass DOES find it, through the shared word prefixes: 'engineer' -> 'engine'
    // and 'outputs' -> 'output'. Both appear in the task statement and nowhere else in the
    // archive together, so the candidate is the statement itself -- and it is reported as
    // PARTIAL, because sharing two words is not the same claim as matching the query.
    expect(diagnosis.outcome).toBe('partial')
    expect(diagnosis.hits[0]!.confidence).toBe('partial')
    expect(diagnosis.hits[0]!.matchedMessageIndex).toBe(0)
    expect(diagnosis.candidates.length).toBeGreaterThan(0)
  })

  it('browse candidates list what each checkpoint holds, starting at its message 0', async () => {
    const { store, session } = await folded()
    const diagnosis = await searchWithDiagnosis({ store, sessionId: session.id, query: 'zzz nothing matches this zzz' })
    expect(diagnosis.outcome).toBe('browse')
    expect(diagnosis.hits).toEqual([])
    expect(diagnosis.candidates.length).toBeGreaterThan(0)
    expect(diagnosis.candidates[0]!.inventory[0]).toContain('RECOVER THE TRUE SEMANTICS')
    // The note must not let an empty hit list read as an absent fact.
    expect(diagnosis.note).toMatch(/does NOT mean/)
  })

  it('a literal query is still a VERIFIED hit with its original shape', async () => {
    const { store, session } = await folded()
    const diagnosis = await searchWithDiagnosis({ store, sessionId: session.id, query: 'RECOVER THE TRUE SEMANTICS' })
    expect(diagnosis.outcome).toBe('hits')
    const hit = diagnosis.hits[0]!
    expect(hit.confidence).toBe('verified')
    expect(hit.matchKind).toBe('message-text')
    expect(hit.matchedMessageIndex).toBe(0)
    expect(hit.excerpt).toContain('RECOVER THE TRUE SEMANTICS')
    expect(hit.archiveMessages).toBeGreaterThan(0)
  })

  it('a single shared word is NOT enough to report a partial candidate', async () => {
    const { store, session } = await folded()
    // 'engineer' is not literally in the archive; only its stem 'engine' is. One shared word
    // is a coincidence, not a candidate.
    const diagnosis = await searchWithDiagnosis({ store, sessionId: session.id, query: 'engineer' })
    expect(diagnosis.outcome).toBe('browse')
    expect(diagnosis.hits).toEqual([])
  })
})

describe('recall reachability: the whole path, without the subagent', () => {
  it('recovers the task statement via search then exact, using only the two main tools', async () => {
    const { store, session, checkpointId } = await folded()
    // 1. the model searches, in its own words
    const diagnosis = await searchWithDiagnosis({ store, sessionId: session.id, query: PROBE })
    // 2. it reads an inventory: a candidate's, or the checkpoint's own detail
    const fromCandidate = diagnosis.candidates[0]?.inventory ?? []
    const detail = await recall({ store, sessionId: session.id, checkpointId, depth: 'detail' })
    const entries = detail!.descriptor!.entries
    const fromDetail = entries.map(entry => entry.role + ': ' + entry.preview)
    const inventory = fromCandidate.length > 0 ? fromCandidate : fromDetail
    const at = inventory.findIndex(line => line.includes('RECOVER THE TRUE SEMANTICS'))
    expect(at).toBe(0)
    // 3. it opens that index, using the offset the inventory gave it
    const offset = fromCandidate.length > 0 ? at : entries[at]!.offset
    const page = await recall({ store, sessionId: session.id, checkpointId, depth: 'exact', offset, limit: 1 })
    expect(pageText(page)).toBe(TASK)
  })
})

describe('recall reachability: an empty answer is never a claim of absence', () => {
  it('distinguishes no-archive from a miss', async () => {
    const sessionId = SessionId('reach-empty')
    const diagnosis = await searchWithDiagnosis({ store: stubStore([]), sessionId, query: PROBE })
    expect(diagnosis.outcome).toBe('no-archive')
    expect(diagnosis.checkpoints).toBe(0)
    expect(diagnosis.note).toMatch(/no folded checkpoints/)
  })

  it('distinguishes unreadable from a miss', async () => {
    const sessionId = SessionId('reach-unreadable')
    const bundle = referentialBundle(sessionId, '11111111-2222-3333-4444-555555555555')
    const diagnosis = await searchWithDiagnosis({ store: stubStore([bundle]), sessionId, query: PROBE })
    expect(diagnosis.outcome).toBe('unreadable')
    expect(diagnosis.note).toMatch(/could be READ/)
    // A read failure is reported WITH the candidates, so the caller can still try.
    expect(diagnosis.candidates[0]!.inventory[0]).toMatch(/unreadable/)
  })
})

/**
 * A store holding exactly the given bundles.
 *
 * Only the fields the search scan reads are set, and the two bundles here exist to pin the two
 * outcome codes a real harness cannot cheaply produce: an empty session, and a referential
 * bundle with no source to resolve it against.
 */
function stubStore(bundles: readonly CheckpointBundleV1[]): FoldBundleStore {
  return {
    async list() {
      return bundles.map(bundle => ({
        checkpointId: bundle.checkpointId,
        sessionId: bundle.sessionId,
        mode: bundle.mode,
        createdAt: bundle.createdAt,
        bytes: 0,
      }))
    },
    async read(_sessionId, checkpointId) {
      return bundles.find(bundle => bundle.checkpointId === checkpointId) ?? null
    },
    async verify() { throw new Error('not used by the search path') },
    async write() { throw new Error('not used by the search path') },
    async remove() {},
    async recordCommit() {},
    async readCommitRecord() { return null },
  }
}

function referentialBundle(sessionId: ReturnType<typeof SessionId>, checkpointId: string): CheckpointBundleV1 {
  return {
    format: 'ef-checkpoint',
    formatVersion: 1,
    checkpointId,
    sessionId,
    createdAt: 1,
    mode: 'leaf',
    source: { orderedSurfaceSeqs: [2] as never, sourceDigest: 'stub' },
    archive: { refs: [{ seq: 2 as never, digest: 'stub' }], messageCount: 1 },
    rendered: { text: encodeCheckpointMarker({ checkpointId, mode: 'leaf' }) },
  } as unknown as CheckpointBundleV1
}