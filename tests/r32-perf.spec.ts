/**
 * R32-D3: measure BEFORE optimizing.
 *
 * `proveFoldCommit` rescans the session log for every packet. Reconciliation
 * over N commits is therefore at least N scans; the question is whether the
 * constant is small enough that no shared index is justified. This harness is
 * skipped by default because it writes thousands of small journal files; run it
 * explicitly:
 *
 *   EF_R32_PERF=1 npx vitest run tests/r32-perf.spec.ts
 *
 * It records duration, proof calls (= history scans), source re-derivations,
 * journal bytes, heap delta, and the event count. No number is inferred or
 * estimated.
 *
 * @module tests/r32-perf
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { makeTemp } from '../eval/tmp.ts'
import { FileSemanticJournal, opsDigestOf } from '../src/semantic/journal.ts'
import { proveFoldCommit } from '../src/semantic/proof.ts'
import { SEMANTIC_SCHEMA_VERSION } from '../src/semantic/types.ts'
import type { SemanticPacket, SemanticReceipt } from '../src/semantic/types.ts'
import { createHarness } from './harness.ts'
import { packetFor, userMessage } from './r32-fixtures.ts'

const ENABLED = process.env['EF_R32_PERF'] === '1'

interface Built {
  readonly session: Session
  readonly packets: readonly SemanticPacket[]
  readonly receipts: readonly SemanticReceipt[]
  readonly journal: FileSemanticJournal
  readonly root: string
}

async function buildCorpus(folds: number): Promise<Built> {
  const root = await makeTemp('ef-r32-perf-')
  const journal = new FileSemanticJournal(join(root, 'semantic'))
  const session = Session.create(SessionId(`perf-${randomUUID()}`))
  session.append('user/message', userMessage('fixture user 0'), { surfaceOp: 'append' })
  session.append('user/message', userMessage('fixture user 1'), { surfaceOp: 'append' })
  const packets: SemanticPacket[] = []
  const receipts: SemanticReceipt[] = []

  for (let index = 0; index < folds; index += 1) {
    const span = [...session.surface.nodes].map(Number)
    const first = span[0]
    const last = span[span.length - 1]
    if (first === undefined || last === undefined) throw new Error('no surface span')
    const body = `[EF1 L cp:cp-${index}]\n\nfold ${index}`
    const compactionId = CompactionId(randomUUID())
    const lifecycle = { compactionId, turn: null }
    const start = session.append('compaction/start', lifecycle)
    const summary = session.append('compaction/summary', {
      ...lifecycle,
      summary: [{ type: 'text', text: body }],
      shadowedRange: { start: SessionSeq(first), end: SessionSeq(last) },
      shadowedSeqs: span.map(seq => SessionSeq(seq)),
      shadowedTokenCount: 50,
      provider: 'test',
      model: 'test',
    } as never)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: body }],
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(first), endSeq: SessionSeq(last) },
      sourceEventSeqs: [start.seq, summary.seq, ...span.map(seq => SessionSeq(seq))],
    })
    session.append('compaction/end', lifecycle)

    const packet = packetFor({
      session,
      span,
      body,
      stagedAtSeq: Number(start.seq),
      checkpointId: `cp-${index}`,
    })
    const proof = proveFoldCommit(packet, session)
    if (proof.status !== 'committed') {
      throw new Error(`perf fixture fold ${index} did not prove: ${proof.status} ${proof.detail}`)
    }
    packets.push(packet)
    receipts.push({
      kind: 'receipt',
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      packetId: packet.packetId,
      sessionId: packet.sessionId,
      checkpointId: packet.checkpointId,
      outcome: 'committed',
      proof: proof.proof,
      opsDigest: opsDigestOf(packet),
      decidedAt: 1,
    })
    if (index < folds - 1) {
      session.append('user/message', userMessage(`next phase ${index}`), { surfaceOp: 'append' })
    }
  }

  for (const [index, packet] of packets.entries()) {
    await journal.write(packet)
    await journal.writeReceipt(receipts[index]!)
  }
  return { session, packets, receipts, journal, root }
}

async function journalBytes(root: string, sessionId: string): Promise<number> {
  const dir = join(root, 'semantic', sessionId)
  let total = 0
  for (const file of await readdir(dir)) {
    total += (await stat(join(dir, file))).size
  }
  return total
}

describe.skipIf(!ENABLED)('R32-D3: reconciliation cost over a long journal', () => {
  it('measures 30 / 100 / 300 commits without inventing an index', async () => {
    const results: unknown[] = []
    for (const folds of [30, 100, 300]) {
      const built = await buildCorpus(folds)
      // Instrument only the measured pass: fixture construction is excluded.
      let scans = 0
      let derivations = 0
      const originalSnapshot = built.session.snapshotEvents.bind(built.session)
      const originalDerive = built.session.deriveEventMessage.bind(built.session)
      ;(built.session as unknown as { snapshotEvents: typeof originalSnapshot }).snapshotEvents = (
        ...args: Parameters<typeof originalSnapshot>
      ) => {
        scans += 1
        return originalSnapshot(...args)
      }
      ;(built.session as unknown as {
        deriveEventMessage: typeof originalDerive
      }).deriveEventMessage = (...args: Parameters<typeof originalDerive>) => {
        derivations += 1
        return originalDerive(...args)
      }

      const h = await createHarness({}, {
        efConfig: {
          semanticContinuity: 'active',
          semanticMode: 'rationale',
          bundleRoot: join(built.root, 'bundles'),
          semanticRoot: join(built.root, 'semantic'),
        },
        semanticJournal: built.journal,
        projection: true,
      })
      const heapBefore = process.memoryUsage().heapUsed
      const started = performance.now()
      const report = await h.engine.reconcileSemantics(built.session)
      const durationMs = performance.now() - started
      const heapAfter = process.memoryUsage().heapUsed
      expect(report.health).toBe('ready')

      const bytes = await journalBytes(built.root, String(built.session.id))
      const events = originalSnapshot().length
      results.push({
        commits: folds,
        events,
        journalBytes: bytes,
        durationMs: Number(durationMs.toFixed(1)),
        proofCalls: scans,
        historyScans: scans,
        sourceReDerivations: derivations,
        heapDeltaBytes: heapAfter - heapBefore,
        scanned: report.scanned,
        activated: report.activated,
      })
    }
    console.log(`R32_PERF ${JSON.stringify(results)}`)
  }, 600_000)
})
