/**
 * R33-0.3: the missing-receipt window, and what closes it.
 *
 * A fold can commit in the session log and crash before its receipt is written.
 * R31/R32 deliberately allow that window to be repaired: re-prove the log, then
 * write the receipt. The repair trusted the packet's `ops` because the packet
 * id binds the BODY and the source digest binds the ARCHIVE — but nothing
 * bound the operations to the state the checkpoint actually rendered.
 *
 * These tests construct the window exactly:
 *
 *   committed fold + prepared packet + no receipt + replaced legal ops
 *
 * and require the recovery to refuse it, while still repairing an untampered
 * missing receipt. The binding used is the bundle's `state.digest`, which
 * already exists for every structured fold.
 *
 * @module tests/r33-receipt-window
 */

import { describe, expect, it } from 'vitest'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { registerEpistemicFoldProjection } from '../src/state/projection.ts'
import { makeTemp } from '../eval/tmp.ts'
import { MODEL, SIGNAL, createHarness, foldAgent } from './harness.ts'
import type { Harness, Session as HarnessSession } from './harness.ts'

const CONSTRAINT = 'The public API must remain backward compatible in this release.'
const QUOTE = 'public API must remain backward compatible'

function isWriterCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are the SEMANTIC WRITER'))
}

function writerReply(): string {
  return [
    '<handoff>', 'Recorded the API constraint.', '</handoff>',
    '<deltas>', JSON.stringify({
      deltas: [{
        kind: 'constraint',
        subjectKey: 'api-compatibility',
        statement: CONSTRAINT,
        status: 'claimed',
        evidence: [{ quote: QUOTE }],
      }],
    }), '</deltas>',
  ].join('\n')
}

function constraintSession(): HarnessSession {
  const session = Session.create(SessionId(`r33-window-${Date.now()}-${Math.random().toString(16).slice(2)}`))
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: turn === 1 ? CONSTRAINT : `Follow-up ${turn} for the loader.` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Recorded. ${'padding '.repeat(240)}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 3 })
  return session as HarnessSession
}

interface Frame {
  readonly h: Harness
  readonly root: string
  readonly session: HarnessSession
  readonly packetId: string
  readonly packetPath: string
  readonly receiptPath: string
}

async function committedFrame(): Promise<Frame> {
  const root = await makeTemp('ef-r33-window-')
  const h = await createHarness(
    { textFor: options => isWriterCall(options) ? writerReply() : 'digest' },
    {
      efConfig: {
        semanticContinuity: 'active',
        semanticMode: 'rationale',
        semanticWorkingSetTokens: 512,
        bundleRoot: join(root, 'bundles'),
        semanticRoot: join(root, 'semantic'),
      },
    },
  )
  registerEpistemicFoldProjection(h.ctx)
  const session = constraintSession()
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('fixture has nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)

  const packet = h.engine.lastSemanticPacket!
  expect(packet.ops.length).toBeGreaterThan(0)
  expect(h.engine.publishedBundle?.state?.digest).toMatch(/[0-9a-f]{8}/u)
  const directory = join(root, 'semantic', String(session.id))
  return {
    h,
    root,
    session,
    packetId: packet.packetId,
    packetPath: join(directory, `${packet.packetId}.json`),
    receiptPath: join(directory, `${packet.packetId}.receipt.json`),
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false)
}

function bundlePath(frame: Frame): string {
  const packet = frame.h.engine.lastSemanticPacket!
  // `createHarness` passes an explicit FileBundleStore rooted at `h.root`, which
  // takes precedence over `efConfig.bundleRoot` in the engine constructor.
  return join(frame.h.root, String(frame.session.id), `bundle-${packet.checkpointId}.json`)
}

describe('missing-receipt recovery window', () => {
  it('still repairs a missing receipt when the operations are the committed ones', async () => {
    const frame = await committedFrame()
    await rm(frame.receiptPath)
    expect(await exists(frame.receiptPath)).toBe(false)

    const report = await frame.h.engine.reconcileSemantics(frame.session)
    expect(report.health).toBe('ready')
    expect(await exists(frame.receiptPath)).toBe(true)
    const receipt = JSON.parse(await readFile(frame.receiptPath, 'utf8'))
    expect(receipt.receipt.outcome).toBe('committed')
    expect(receipt.receipt.packetId).toBe(frame.packetId)
  })

  it('refuses to repair a packet whose operations were replaced after the fold', async () => {
    const frame = await committedFrame()
    await rm(frame.receiptPath)

    // Replace the packet's operations with a DIFFERENT legal operation set.
    // packetId, bodyDigest, sourceDigest, span and every receipt-identity field
    // are untouched — this is the exact shape a tamperer would produce.
    const stored = JSON.parse(await readFile(frame.packetPath, 'utf8'))
    const operations = stored.packet.ops
    expect(Array.isArray(operations)).toBe(true)
    expect(operations.length).toBeGreaterThan(0)
    operations[0].anchor.value = 'The public API may change without notice.'
    await writeFile(frame.packetPath, JSON.stringify(stored, null, 2), 'utf8')

    const report = await frame.h.engine.reconcileSemantics(frame.session)

    // No receipt was manufactured for the substituted operations.
    expect(await exists(frame.receiptPath)).toBe(false)
    expect(report.health).not.toBe('ready')
    expect(report.detail).toContain('operations that produce state')
    expect(frame.h.engine.semanticDiagnostics.health).not.toBe('ready')

    // The next fold is visibly blocked rather than writing on top of it.
    const notice = frame.h.engine.semanticDiagnostics.detail ?? ''
    expect(notice).toContain('operations that produce state')
  })

  it('fails closed when a missing receipt has no bundle state witness', async () => {
    const frame = await committedFrame()
    await rm(frame.receiptPath)
    // R33.1-D1: the committed fold, the prepared packet, and no receipt, but
    // the bundle that carried the rendered-state digest is gone too. The
    // packet's own ops are then the only description of the state, so the
    // repair must not promote them.
    await rm(bundlePath(frame))
    const report = await frame.h.engine.reconcileSemantics(frame.session)
    expect(await exists(frame.receiptPath)).toBe(false)
    expect(report.health).not.toBe('ready')
    expect(report.detail).toContain('no readable bundle state digest')
    expect(frame.h.engine.semanticDiagnostics.health).not.toBe('ready')
    expect(frame.h.engine.semanticDiagnostics.detail ?? '').toContain('independent witness')
  })

  it('fails closed when the bundle witness is corrupt rather than absent', async () => {
    const frame = await committedFrame()
    await rm(frame.receiptPath)
    await writeFile(bundlePath(frame), 'this is not a bundle envelope', 'utf8')
    const report = await frame.h.engine.reconcileSemantics(frame.session)
    expect(await exists(frame.receiptPath)).toBe(false)
    expect(report.health).not.toBe('ready')
    expect(report.detail).toContain('no readable bundle state digest')
  })
})
