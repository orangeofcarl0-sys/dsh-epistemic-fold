#!/usr/bin/env node
/**
 * R32-D5 / R33 entry: a MINIMAL live-model semantic evaluation.
 *
 * This is not a benchmark and its keyword rubric is not a claim about semantic
 * quality. It exists to make the next round possible without changing the
 * scripted-writer tests: a real provider replaces the scripted adapter, a real
 * fold runs through the production plugin, and the report records the raw input,
 * route, provider usage, writer output, accepted/refused deltas, the visible
 * checkpoint, and one next-step answer.
 *
 * Usage:
 *   node eval/r32/live-semantic-eval.mjs --check
 *   EF_R32_LIVE=1 node eval/r32/live-semantic-eval.mjs --run [--out report.json]
 *
 * `--check` validates the entry point and scenario definitions WITHOUT resolving
 * credentials or calling a provider. `--run` refuses unless EF_R32_LIVE=1, so a
 * routine test run cannot silently spend credits. No key is ever logged.
 *
 * @module eval/r32/live-semantic-eval
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SIGNAL = new AbortController().signal

/** Four scenarios R33 will refine; each has a short, honest smoke rubric. */
const SCENARIOS = [
  {
    id: 'unanchored-constraint',
    description: 'A constraint stated once, never anchored, must survive a fold.',
    turns: [
      { user: 'Important: this deployment is air-gapped. Never propose a network install.' },
      { user: 'Continue the migration plan for the local database.' },
      { user: 'The plan looks good. Keep going.' },
    ],
    probe: 'What deployment constraint must shape the next step?',
    require: ['air-gapped'],
    forbid: [],
  },
  {
    id: 'negative-knowledge',
    description: 'A rejected approach and its reason must not be re-proposed.',
    turns: [
      { user: 'We tried Redis for the lease and rejected it: its lease semantics lost updates under partition.' },
      { user: 'Design the next coordination step.' },
      { user: 'Proceed with the revised design.' },
    ],
    probe: 'Which approach was rejected, and why?',
    require: ['redis', 'lease'],
    forbid: ['redis is the right choice'],
  },
  {
    id: 'validation-boundary',
    description: 'Written but not run must not become verified.',
    turns: [
      { user: 'The migration script is written but has not been run.', tool: 'migration dry run: 0 rows would change' },
      { user: 'Review the migration status.' },
      { user: 'What can we state about the migration?' },
    ],
    probe: 'Is the migration verified? State exactly what is known.',
    require: ['not run'],
    forbid: ['successfully ran', 'verified successfully'],
  },
  {
    id: 'cross-phase-dependency',
    description: 'A phase-1 artifact must be used by phase 2.',
    turns: [
      { user: 'Phase 1 produces schema-v2, which phase 2 must consume.' },
      { user: 'Phase 1 is complete; the artifact is schema-v2.' },
      { user: 'Start phase 2.' },
    ],
    probe: 'Which artifact must phase 2 consume?',
    require: ['schema-v2'],
    forbid: [],
  },
]

function usageText() {
  return [
    'usage:',
    '  node eval/r32/live-semantic-eval.mjs --check',
    '  EF_R32_LIVE=1 node eval/r32/live-semantic-eval.mjs --run [--out report.json]',
  ].join('\n')
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** A real user request message for the direct probe call. */
async function probeMessages(userText) {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  return [createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } })]
}

/** One direct model call through the same live adapter the fold uses. */
async function ask(adapter, model, system, userText, maxTokens) {
  let text = ''
  let usage
  for await (const chunk of adapter.stream({
    provider: model,
    model,
    system,
    messages: await probeMessages(userText),
    maxTokens,
    signal: SIGNAL,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop') {
      const reason = chunk.reason?.kind ?? 'unknown'
      throw new Error(`probe call finished with ${reason}`)
    }
  }
  return { text, usage }
}

/** Mount the production plugin and run one scripted conversation through it. */
async function runScenario(scenario, route) {
  const { mountRuntime } = await import('../src/runtime-mount.ts')
  const { Context } = await import('@deepseek-ai/cordis')
  const {
    createMessage,
    createUserMessage,
    createToolResultMessage,
    ToolCallId,
  } = await import('@deepseek-ai/dsh-llm')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const { default: EpistemicFoldPlugin } = await import('../../lib/plugin.js')
  const { locateFoldFrontier } = await import('../../lib/fold/frontier.js')
  const { OpenAiCompatibleAdapter } = await import('../live/openai-adapter.ts')
  const { RequestBudget } = await import('../live/request-budget.ts')

  const ctx = new Context()
  mountRuntime(ctx, { systemPrompt: true, tools: true })
  const root = await mkdtemp(join(tmpdir(), 'ef-r32-live-'))
  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    ...(route.headers === undefined ? {} : { headers: route.headers }),
    budget: new RequestBudget({ requests: 12, promptTokens: 0, outputTokens: 0, wallClockMs: 600_000 }),
  })
  ctx.llm.registerAdapter([route.model], adapter)
  const config = {
    auto: false,
    bundleRoot: join(root, 'bundles'),
    semanticRoot: join(root, 'semantic'),
    semanticContinuity: 'active',
    semanticMode: 'rationale',
    semanticWorkingSetTokens: 512,
    semanticCheckpointTokens: 4096,
  }
  const plugin = new EpistemicFoldPlugin(ctx, config)
  const session = ctx.sessions.create(SessionId(`r32-live-${randomUUID()}`), { meta: { cwd: root } })
  const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const assistant = text => createMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: route.model, model: route.model },
  })

  let turn = 0
  for (const entry of scenario.turns) {
    turn += 1
    session.append('turn/start', { turn })
    session.append('user/message', user(entry.user), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (entry.tool !== undefined) {
      const callId = ToolCallId(`call-${turn}`)
      session.append('assistant/message', {
        stream: [],
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking the recorded state.' },
            { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
          ],
          source: { kind: 'model', provider: route.model, model: route.model },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
      session.append('tool/result', {
        turn,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: entry.tool }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
    } else {
      session.append('assistant/message', {
        stream: [],
        turn,
        step: 1,
        message: assistant(`Acknowledged phase ${turn}.`),
      }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turn + 1 })

  const agent = { session, options: { provider: route.model, model: route.model } }
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('scenario has no foldable span')
  await plugin.engine.compactRegion(start, end, agent, SIGNAL)
  await plugin.engine.reconcileSemantics(session)

  const packet = plugin.engine.lastSemanticPacket
  const checkpoint = plugin.engine.publishedBundle?.rendered?.text ?? ''
  const writer = packet?.writer
  const accepted = (packet?.accepted ?? []).map(delta => ({
    kind: delta.kind,
    subjectKey: delta.subjectKey,
    statement: delta.statement,
    grantedStatus: delta.grantedStatus,
    authority: delta.authority,
    evidenceSeqs: delta.evidence.map(entry => entry.seq),
  }))
  const refused = (packet?.refused ?? []).map(refusal => ({
    reason: refusal.reason,
    detail: refusal.detail,
  }))

  const probe = await ask(
    adapter,
    route.model,
    'You are continuing a long task. Answer ONLY from the checkpoint below. Be concise.',
    `${checkpoint}\n\nQuestion: ${scenario.probe}`,
    512,
  )
  const answer = probe.text.toLowerCase()
  const missing = scenario.require.filter(token => !answer.includes(token.toLowerCase()))
  const forbidden = scenario.forbid.filter(token => answer.includes(token.toLowerCase()))
  return {
    id: scenario.id,
    description: scenario.description,
    rawInput: scenario.turns,
    provider: route.model,
    model: route.model,
    routeOrigin: route.origin,
    writer,
    accepted,
    refused,
    checkpoint,
    probe: { question: scenario.probe, answer: probe.text, usage: probe.usage },
    score: {
      rubric: 'keyword-smoke (R33 must replace this with task outcomes)',
      required: scenario.require,
      forbidden: scenario.forbid,
      missing,
      forbiddenHit: forbidden,
      passed: missing.length === 0 && forbidden.length === 0,
    },
  }
}

async function runLive() {
  if (process.env['EF_R32_LIVE'] !== '1') {
    return {
      status: 'not-executed',
      reason: 'EF_R32_LIVE is not 1; refusing to spend provider credits. '
        + 'Set EF_R32_LIVE=1 deliberately, with a resolved live route.',
      scenarios: SCENARIOS.map(scenario => ({ id: scenario.id, probe: scenario.probe })),
    }
  }
  const { resolveLiveRoute, redactSecret } = await import('../live/zcode-config.ts')
  const route = resolveLiveRoute({ model: argValue('--model') })
  if (route === undefined) {
    return {
      status: 'not-executed',
      reason: 'no live route resolved; provide EF_LIVE_BASE_URL/EF_LIVE_API_KEY or a ZCode provider config',
      scenarios: SCENARIOS.map(scenario => ({ id: scenario.id, probe: scenario.probe })),
    }
  }
  const reports = []
  for (const scenario of SCENARIOS) {
    try {
      reports.push(await runScenario(scenario, route))
    } catch (error) {
      reports.push({
        id: scenario.id,
        error: redactSecret(error instanceof Error ? error.message : String(error), route.apiKey),
        rawInput: scenario.turns,
        provider: route.model,
        model: route.model,
        routeOrigin: route.origin,
      })
    }
  }
  return {
    status: 'executed',
    generatedAt: new Date().toISOString(),
    provider: route.model,
    model: route.model,
    routeOrigin: route.origin,
    reports,
  }
}

async function main() {
  if (process.argv.includes('--check')) {
    process.stdout.write(`${JSON.stringify({
      status: 'interface-ok',
      scenarios: SCENARIOS.map(scenario => ({
        id: scenario.id,
        description: scenario.description,
        turns: scenario.turns.length,
        probe: scenario.probe,
        required: scenario.require,
        forbidden: scenario.forbid,
      })),
      reportFields: [
        'id', 'rawInput', 'provider', 'model', 'routeOrigin', 'writer',
        'accepted', 'refused', 'checkpoint', 'probe', 'score',
      ],
      note: 'Live execution is opt-in with EF_R32_LIVE=1; --check never resolves credentials.',
    }, null, 2)}\n`)
    return 0
  }
  if (!process.argv.includes('--run')) {
    process.stderr.write(`${usageText()}\n`)
    return 2
  }
  const report = await runLive()
  const out = argValue('--out')
  if (out !== undefined) {
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`${out}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  return 0
}

process.exitCode = await main()
