/** One-off probe: token accounting for the automatic-pressure test fixture. */
import { conversation, createHarness, foldAgent, SIGNAL } from '../tests/harness.ts'
import { EpistemicFoldEngine } from '../src/engine.ts'
import { locateFoldFrontier } from '../src/frontier.ts'
import type { Session } from '@deepseek-ai/dsh-session'

const { engine, ctx } = await createHarness(
  { text: 'auto digest' },
  { contextWindow: 1_600, efConfig: { thresholdRatio: 0.3, headroomTokens: 0, retainTokens: 0, maxTokens: 512 } },
)
const session: Session = conversation(4)
const meter = ctx.tokenMeter

console.log('initial total:', meter.measure(session).totalTokens)
const first = await engine.compactIfNeeded(foldAgent(session), 'pressure', SIGNAL)
console.log('first fold:', first?.shadowedSeqs.length, 'nodes shadowed')
const m1 = meter.measure(session)
console.log('after first:', m1.totalTokens, 'nodes:', [...session.surface.nodes].length)
const frontier = locateFoldFrontier(session)
console.log('frontier:', frontier.firstOpenPosition, 'frozen:', frontier.frozenCount)
console.log('checkpoint node tokens:', m1.nodes.map(n => n.tokens))

for (let extra = 1; extra <= 4; extra += 1) {
  session.append('user/message', {
    role: 'user',
    content: [{ type: 'text', text: `extra pressure ${extra} ${'fixture '.repeat(80).trim()}` }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
}
const m2 = meter.measure(session)
console.log('after appends:', m2.totalTokens, 'nodes:', [...session.surface.nodes].length)
console.log('node tokens:', m2.nodes.map(n => n.tokens))
try {
  const second = await engine.compactIfNeeded(foldAgent(session), 'pressure', SIGNAL)
  console.log('second fold:', second?.shadowedSeqs.length)
  console.log('after second:', meter.measure(session).totalTokens)
} catch (error) {
  console.log('second fold FAILED:', error instanceof Error ? error.message : error)
}
void engine
process.exit(0)
