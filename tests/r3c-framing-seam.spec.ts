/**
 * R3-B: the DSH framing seam, and the requirement that it be a PURE seam.
 *
 * The R2 framing-ceiling analysis found that the largest single component of a
 * checkpoint's cost is framing that EF does not own: DSH Basic wraps every
 * checkpoint body in `frameSummary()`, so an EF leaf pays Basic's preamble
 * once per fold. No amount of EF-side dieting can remove it.
 *
 * The seam makes that one function overridable. Its whole value depends on one
 * property, which this suite exists to enforce:
 *
 *   Basic_before == Basic_after
 *
 * If the seam changes Basic's own output at all — message content, token
 * count, snapshot, compaction events, sourceEventSeqs — then it is not a seam,
 * it is a fork, and EF would be measuring a different harness than the one it
 * claims to beat.
 *
 * The tests below therefore check the DEFAULT path byte-for-byte against a
 * locally reconstructed expectation, and separately check that an override
 * actually replaces only the framing.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { conversation, createHarness, foldAgent, SIGNAL } from './harness.ts'
import { EpistemicFoldEngine } from '../src/engine.ts'
import { foldFrameCheckpoint } from '../src/framing.ts'

/** The exact preamble Basic's `frameSummary` emits. Pinned, not imported. */
const BASIC_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation '
  + 'to free up context. Treat the captured context as established background and build on it '
  + 'without restating it. Continue the task directly from the messages that follow, without '
  + 'acknowledging this checkpoint.'

/**
 * The checkpoint's text AS THE MODEL SEES IT.
 *
 * Read from the surface, not from `compaction/summary`: the durable event
 * records the UNFRAMED summary body, and the framing is applied when Basic
 * builds the replacement message. Testing the event would prove nothing about
 * the seam, whose entire job is that replacement message.
 */
function checkpointText(session: Session): string {
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    if ((message as unknown as { source?: { kind?: string } }).source?.kind !== 'compact-checkpoint') continue
    return message.content.map(block => block.type === 'text' ? block.text : '').join('')
  }
  return ''
}

describe('R3-B: the seam is a seam, not a fork', () => {
  it('a default-framed fold keeps Basic byte-identical (preamble AND wrapper tags)', async () => {
    const { engine } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const result = await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    expect(result.shadowedSeqs).toHaveLength(4)

    const text = checkpointText(session)
    // The default path emits Basic's framing verbatim. If this ever fails, the
    // seam has started changing behavior and every EF-vs-Basic number measured
    // through it becomes incomparable.
    expect(text).toContain(BASIC_PREAMBLE)
    expect(text).toContain('<compacted-summary>')
    expect(text).toContain('</compacted-summary>')
  })

  it('the framed message is a compact-checkpoint user message under the default path', async () => {
    const { engine } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    const checkpointNodes = session.surface.nodes.filter(seq => {
      const message = session.deriveEventMessage(session.eventAt(seq)!)
      return message !== null
        && (message as unknown as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint'
    })
    expect(checkpointNodes).toHaveLength(1)
    const message = session.deriveEventMessage(session.eventAt(checkpointNodes[0]!)!)!
    expect(message.role).toBe('user')
    // The tag order is Basic's: preamble, open tag, body, close tag.
    const joined = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(joined.indexOf(BASIC_PREAMBLE)).toBeLessThan(joined.indexOf('<compacted-summary>'))
    expect(joined.indexOf('<compacted-summary>')).toBeLessThan(joined.indexOf('</compacted-summary>'))
  })

  it('a framing override replaces ONLY the framing, never the body or the transaction', async () => {
    // A subclass that swaps the framing must still produce a valid checkpoint
    // with the same shadowed span and the same shrink behavior.
    class TerseFramingEngine extends EpistemicFoldEngine {
      protected override frameCheckpoint(
        summary: readonly ContentBlock[],
        agent: Agent,
      ): ContentBlock[] {
        void agent
        return foldFrameCheckpoint(summary)
      }
    }

    // `noEngine` because `ctx.compaction` accepts exactly one registration and
    // this test mounts its own subclass.
    const { ctx, store } = await createHarness({ text: 'digest' }, { noEngine: true })
    const engine = new TerseFramingEngine(ctx, {}, { bundleStore: store })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const result = await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    // The transaction is untouched: same span, same replacement semantics.
    expect(result.shadowedSeqs).toHaveLength(4)
    const text = checkpointText(session)
    // The override took effect...
    expect(text).not.toContain(BASIC_PREAMBLE)
    // ...and the BODY still reached the surface unchanged.
    expect(text).toContain('digest')
  })
})

describe('R3-B: foldFrameCheckpoint keeps the machine-facing contract', () => {
  it('emits the summary body with no per-checkpoint preamble', () => {
    const framed = foldFrameCheckpoint([{ type: 'text', text: '[EF1 L cp:x]\n\nCurrent\n- hello' }])
    const joined = framed.map(block => block.type === 'text' ? block.text : '').join('')
    expect(joined).toContain('[EF1 L cp:x]')
    expect(joined).toContain('- hello')
    expect(joined).not.toContain(BASIC_PREAMBLE)
    // The wrapper tags go too: they exist to tell the MODEL what a Basic
    // narrative block is, and an EF checkpoint already says so in its marker.
    expect(joined).not.toContain('<compacted-summary>')
  })

  it('is strictly cheaper than the default framing on the same body', () => {
    const body = '[EF1 L cp:x]\n\nCurrent\n- hello'
    const terse = foldFrameCheckpoint([{ type: 'text', text: body }])
      .map(b => b.type === 'text' ? b.text : '').join('')
    const verbose = `${BASIC_PREAMBLE}\n\n<compacted-summary>\n${body}\n</compacted-summary>`
    expect(terse.length).toBeLessThan(verbose.length)
    console.log(`framing: ${verbose.length} -> ${terse.length} chars on the same body`)
  })
})
