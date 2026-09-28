/**
 * R2-D: checkpoint surface diet.
 *
 * The measured framing cost is the largest single component of a leaf
 * checkpoint, and most of it is fixed boilerplate repeated once per fold. R2-D
 * omits a section entirely when it carries nothing, instead of spending tokens
 * announcing that it has nothing.
 *
 * The correctness constraint is absolute: identity (the marker) and
 * reachability (the recall pointer) are never omitted. Trading either for
 * tokens is exactly the trade R2 forbids.
 */

import { describe, expect, it } from 'vitest'
import { renderStructuredCheckpoint } from '../src/renderer.ts'
import { emptyCurrentState } from '../src/state.ts'
import type { FoldCurrentState } from '../src/state.ts'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'
import { splitLeafCheckpointText } from '../eval/src/token-attribution.ts'

/** Price one rendered checkpoint body as a model-visible user message. */
function priceOf(text: string): number {
  return estimateMessage({
    id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
  } as never)
}

function stateWith(constraints: FoldCurrentState['constraints']): FoldCurrentState {
  return { ...emptyCurrentState(), constraints }
}

describe('R2-D: empty sections are omitted, identity and recall are not', () => {
  it('emits only the marker and recall pointer for a checkpoint with no content', () => {
    const rendered = renderStructuredCheckpoint(emptyCurrentState(), 'cp-bare')
    expect(rendered).toContain('[EF checkpoint v1 mode=leaf id=cp-bare]')
    expect(rendered).toContain('- cp:cp-bare')
    // No placeholders, no empty headers.
    expect(rendered).not.toContain('- (none)')
    for (const header of ['Current', 'Evidence', 'Open', 'Rationale']) {
      expect(rendered).not.toContain(header)
    }
  })

  it('saves real tokens on the empty case', () => {
    const dieted = renderStructuredCheckpoint(emptyCurrentState(), 'cp-bare')
    const verbose = [
      '[EF checkpoint v1 mode=leaf id=cp-bare]', '', 'Current', '- (none)',
      '', 'Evidence', '- (none)', '', 'Open', '- (none)',
      '', 'Rationale', '- (none)', '', 'Recall', '- cp:cp-bare',
    ].join('\n')
    const saved = priceOf(verbose) - priceOf(dieted)
    console.log(`diet: ${priceOf(verbose)} -> ${priceOf(dieted)} tokens (saved ${saved})`)
    expect(priceOf(dieted)).toBeLessThan(priceOf(verbose))
  })

  it('emits a section when it HAS content, and only then', () => {
    const state = stateWith({
      c1: {
        id: 'c1', kind: 'constraint', value: 'no public API change',
        authority: 'normative', lifecycle: 'active', sourceRefs: [],
        stateKey: { namespace: 'scope', entity: 'work', property: 'api' },
      },
    })
    const rendered = renderStructuredCheckpoint(state, 'cp-x')
    expect(rendered).toContain('Current')
    expect(rendered).toContain('no public API change')
    // Evidence/Open/Rationale carry nothing and must stay absent.
    expect(rendered).not.toContain('Evidence')
    expect(rendered).not.toContain('Open')
    expect(rendered).not.toContain('Rationale')
  })

  it('keeps the rationale section when a rationale exists', () => {
    const rendered = renderStructuredCheckpoint(emptyCurrentState(), 'cp-y', 'we folded here')
    expect(rendered).toContain('Rationale')
    expect(rendered).toContain('- we folded here')
  })

  it('omits the rationale section when semanticMode produced nothing', () => {
    // semanticMode=none yields no rationale text; the section must not appear.
    expect(renderStructuredCheckpoint(emptyCurrentState(), 'cp-z', undefined)).not.toContain('Rationale')
    expect(renderStructuredCheckpoint(emptyCurrentState(), 'cp-z', '   ')).not.toContain('Rationale')
  })
})

describe('R2-D: the attribution splitter still reads dieted checkpoints', () => {
  it('splits a checkpoint with no state sections at all', () => {
    // A fold with no declared anchors is a valid leaf; rejecting it would
    // misclassify it as a root and silently misattribute its cost.
    const rendered = renderStructuredCheckpoint(emptyCurrentState(), 'cp-bare')
    const split = splitLeafCheckpointText(rendered)
    expect(split).not.toBeNull()
    expect(split!.state).toBe('')
    expect(split!.rationale).toBe('')
    expect(split!.framing).toContain('[EF checkpoint v1')
    expect(split!.framing).toContain('cp:cp-bare')
  })

  it('splits state and rationale when both are present', () => {
    const state = stateWith({
      c1: {
        id: 'c1', kind: 'constraint', value: 'value-here',
        authority: 'normative', lifecycle: 'active', sourceRefs: [],
      },
    })
    const split = splitLeafCheckpointText(renderStructuredCheckpoint(state, 'cp-q', 'reason-here'))!
    expect(split.state).toContain('value-here')
    expect(split.rationale).toContain('reason-here')
  })

  it('returns null for text that is not a structured checkpoint', () => {
    expect(splitLeafCheckpointText('plain prose with no recall anchor')).toBeNull()
  })
})
