import { it } from 'vitest'
import { conversation, createHarness, foldAgent, SIGNAL } from './harness.ts'
import { flakyStore } from './stores.ts'

it('flaky probe', async () => {
  const { store, real } = await flakyStore(1)
  const { engine } = await createHarness({ text: 'digest' }, { bundleStore: store })
  const session = conversation(4)
  const nodes = [...session.surface.nodes]
  try {
    const result = await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    console.log('UNEXPECTED RESOLVE, endSeq:', result.endSeq)
  } catch (error) {
    console.log('expected reject:', error instanceof Error ? error.message : error)
  }
  const commits = await real.list(session.id)
  console.log('bundles:', commits.length)
  const rec = await real.readCommitRecord(session.id, commits[0]?.checkpointId ?? 'none')
  console.log('commit record exists:', rec !== null, 'mode:', rec?.mode)
}, 15_000)
