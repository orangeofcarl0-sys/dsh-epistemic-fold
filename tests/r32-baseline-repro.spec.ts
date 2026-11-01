/**
 * R32 baseline reproductions.
 *
 * These assertions describe the CORRECT behavior. Run against the R31 tree they
 * fail in the specific ways recorded in R32_SOURCE_AUDIT; run against R32 they
 * pass. They deliberately import only modules that exist in BOTH trees (plus
 * structural casts for fields R32 adds), so the same file can be copied to a
 * clean R31 worktree.
 *
 * @module tests/r32-baseline-repro
 */

import { describe, expect, it } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { makeTemp } from '../eval/tmp.ts'
import { FileSemanticJournal } from '../src/semantic/journal.ts'
import { classifyPacket } from '../src/semantic/commit.ts'
import { proveFoldCommit } from '../src/semantic/proof.ts'
import { applyOps, planCommit } from '../src/semantic/plan.ts'
import { validateDeltas } from '../src/semantic/validate.ts'
import { emptyCurrentState, stateKeyText } from '../src/state/state.ts'
import { committedFixture, commitFold, packetFor, sessionWithSpan } from './r32-fixtures.ts'
import type { FoldCurrentState } from '../src/state/state.ts'

function bodyAt(session: ReturnType<typeof sessionWithSpan>, summarySeq: number): string {
  const data = session.eventAt(summarySeq as never)?.data as {
    summary?: readonly { readonly text?: string }[]
  } | undefined
  return data?.summary?.map(block => block.text ?? '').join('\n') ?? ''
}

describe('R32 baseline: Packet/Receipt integrity', () => {
  it('does not count a receipt whose opsDigest disagrees with the packet', async () => {
    const fixture = committedFixture()
    const journal = new FileSemanticJournal(await makeTemp('ef-r32-repro-'))
    await journal.write(fixture.packet)
    await journal.writeReceipt(fixture.receipt)
    const dir = join(journal.root, String(fixture.session.id))
    const path = join(dir, `${fixture.packet.packetId}.json`)
    const parsed = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as {
      packet: Record<string, unknown>
    }
    await writeFile(path, JSON.stringify({
      ...parsed,
      packet: { ...parsed.packet, ops: [{ op: 'retire', anchorId: 'injected' }] },
    }, null, 2), 'utf8')

    const read = await journal.list(fixture.session.id)
    // R31 reported the receipt as valid (size 1); R32 rejects the pairing.
    expect(read.receipts.size).toBe(0)
  })

  it('does not count an orphan receipt as a committed packet', async () => {
    const fixture = committedFixture()
    const journal = new FileSemanticJournal(await makeTemp('ef-r32-repro-'))
    await journal.write(fixture.packet)
    await journal.writeReceipt(fixture.receipt)
    await rm(join(journal.root, String(fixture.session.id), `${fixture.packet.packetId}.json`))
    const read = await journal.list(fixture.session.id)
    // R31 exposed the receipt with no packet to apply it to.
    expect(read.receipts.size).toBe(0)
  })

  it('distinguishes an unreadable journal directory from a new session', async () => {
    const root = await makeTemp('ef-r32-repro-')
    const id = 'unreadable-repro'
    await writeFile(join(root, id), 'not a directory', 'utf8')
    const read = await new FileSemanticJournal(root).list(SessionId(id))
    // R31 returned an empty journal on every error; R32 classifies it.
    const state = (read as unknown as { state?: string }).state
    expect(state).toBe('unreadable')
  })
})

describe('R32 baseline: historical proof fields', () => {
  it('rejects a replacement whose range is not the summary range', () => {
    const session = sessionWithSpan()
    const seqs = commitFold(session, { wrongRange: true })
    const packet = packetFor({ session, span: [0, 1], body: bodyAt(session, seqs.summarySeq) })
    // R31's includes()-based check accepted this.
    expect(proveFoldCommit(packet, session).status).toBe('aborted')
  })

  it('rejects a replacement whose source citations are out of order', () => {
    const session = sessionWithSpan()
    const seqs = commitFold(session, { wrongSourceOrder: true })
    const packet = packetFor({ session, span: [0, 1], body: bodyAt(session, seqs.summarySeq) })
    expect(proveFoldCommit(packet, session).status).toBe('aborted')
  })

  it('settles an in-flight fold that already recorded a terminal failure', () => {
    const session = sessionWithSpan()
    const seqs = commitFold(session, { omitReplacement: true, endError: 'shrink check failed' })
    const packet = packetFor({ session, span: [0, 1], body: bodyAt(session, seqs.summarySeq) })
    // R31 returned `unresolved` forever because the in-process marker won.
    expect(proveFoldCommit(packet, session, { inFlight: true }).status).toBe('aborted')
    expect(classifyPacket(packet, session, { inFlight: true }).status).toBe('archived-only')
  })
})

describe('R32 baseline: semantic scope', () => {
  it('keeps two workspaces that both name timeout as separate coordinates', () => {
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: 'Repository A: the timeout is 30 seconds.' }],
        source: { kind: 'user' },
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'Repository B: the timeout is five minutes.' }],
        source: { kind: 'user' },
      }),
    ]
    const result = validateDeltas({
      foldedSeqs: [1, 2],
      messages: [...messages],
      proposed: [
        {
          kind: 'constraint',
          subjectKey: 'timeout',
          statement: 'The timeout is 30 seconds.',
          status: 'claimed',
          evidence: [{ quote: 'Repository A: the timeout is 30 seconds.' }],
          scope: { workspace: 'repo-a' },
        },
        {
          kind: 'constraint',
          subjectKey: 'timeout',
          statement: 'The timeout is five minutes.',
          status: 'claimed',
          evidence: [{ quote: 'Repository B: the timeout is five minutes.' }],
          scope: { workspace: 'repo-b' },
        },
      ],
    })
    expect(result.refused).toHaveLength(0)
    expect(result.accepted).toHaveLength(2)
    const plan = planCommit(result.accepted, { state: emptyCurrentState() })
    const state: FoldCurrentState = applyOps(emptyCurrentState(), plan.ops)
    // R31 folded both onto one coordinate, so only one survived.
    expect(Object.values(state.constraints)).toHaveLength(2)
    expect(state.retiredCount).toBe(0)
    expect(stateKeyText(result.accepted[0]!.stateKey!))
      .not.toBe(stateKeyText(result.accepted[1]!.stateKey!))
  })
})

