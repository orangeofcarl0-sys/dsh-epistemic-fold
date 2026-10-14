/**
 * The LHTB host declares its task root THROUGH THE REAL BRIDGE.
 *
 * ## Why this drives a process instead of calling the engine
 *
 * The wiring under test is the host's: an `init`, a flagged `append`, and the ops in between.
 * A test that called `engine.registerActiveTaskRoot` directly would verify the engine (already
 * covered elsewhere) and say nothing about whether the benchmark lane ever declares anything --
 * which is the entire gap this round closes.
 *
 * The provider is a local HTTP server answering OpenAI-compatible JSON, so the run is keyless
 * while still exercising the real adapter, the real session, the real fold transaction and the
 * real telemetry path.
 *
 * ## What is observable from outside
 *
 * `foldLineage[i].shadowedSeqs` is the fold's own record of what it took. A task root that
 * survives is a seq that appears in NO shadowed span -- an assertion about what actually
 * happened, rather than about a flag the host set.
 *
 * @module tests/task-root-bridge
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const HOST = join(ROOT, 'eval', 'tau2', 'bridge-host.ts')

/** A provider that answers every request with one canned assistant message. */
async function fakeProvider(): Promise<{ server: Server; url: string; calls: () => number; lastBody: () => string }> {
  let calls = 0
  let lastBody = ''
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      calls += 1
      // The ASSEMBLED request, which is the only place the model-visible task text can be
      // counted directly instead of inferred from the surface.
      lastBody = body
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'fake-1',
        object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'working on it' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, url: `http://127.0.0.1:${port}`, calls: () => calls, lastBody: () => lastBody }
}

/** One bridge process, spoken to over its JSON-line protocol. */
class BridgeProcess {
  private buffer = ''
  private readonly pending: ((line: Record<string, unknown>) => void)[] = []
  private readonly child

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, ['--experimental-transform-types', HOST], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.ingest(chunk))
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const at = this.buffer.indexOf('\n')
      if (at < 0) return
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (line.length === 0) continue
      const next = this.pending.shift()
      if (next !== undefined) next(JSON.parse(line) as Record<string, unknown>)
    }
  }

  send(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      this.pending.push(resolve)
      this.child.stdin.write(JSON.stringify(request) + '\n')
    })
  }

  stop(): void {
    this.child.kill()
  }
}

const INSTRUCTION = [
  'You must RECOVER THE TRUE SEMANTICS of an undocumented event-log format and REPAIR a buggy',
  'record-normalisation engine so that it produces the correct canonical output. Work stage by',
  'stage through the evt command-line tool.',
].join('\n') + '\n' + 'detail '.repeat(600)

interface TelemetryBlock {
  readonly taskRoot?: {
    readonly mode: string
    readonly status: string
    readonly sourceSeq?: number
    readonly digestVerified: boolean
    readonly surfacePosition?: number
    readonly reason?: string
  }
  readonly folds: number
  readonly summarizationAttempts?: number
  readonly summarizationRetries?: number
  readonly providerFailures?: number
  readonly lastFinishReason?: string
  readonly budget?: {
    readonly requests: number
    readonly promptTokens: number
    readonly outputTokens: number
    readonly observedPromptTokens: number
    readonly reservedPromptTokens: number
    readonly refusals: number
  }
  readonly foldLineage: readonly {
    readonly mechanism: string
    readonly shadowedSeqs: readonly number[]
  }[]
}

function telemetryOf(reply: Record<string, unknown>): TelemetryBlock {
  return reply['telemetry'] as TelemetryBlock
}

/** Every seq any fold in this episode shadowed. */
function shadowed(telemetry: TelemetryBlock): number[] {
  return telemetry.foldLineage.flatMap(entry => [...entry.shadowedSeqs])
}

const running: BridgeProcess[] = []
const dirs: string[] = []
afterEach(() => {
  while (running.length > 0) running.pop()!.stop()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

interface BudgetEnv {
  readonly requests?: number
  readonly promptTokens?: number
  readonly outputTokens?: number
  readonly wallMs?: number
}

async function start(options: {
  readonly taskRootMode: 'off' | 'exact'
  readonly engine?: 'basic' | 'ef'
  /** When set, the episode runs under a REAL budget gate. See docs/84. */
  readonly budget?: BudgetEnv
}) {
  const provider = await fakeProvider()
  const bundleRoot = mkdtempSync(join(tmpdir(), 'ef-taskroot-bridge-'))
  dirs.push(bundleRoot)
  const bridge = new BridgeProcess({
    EF_LIVE_BASE_URL: provider.url,
    EF_LIVE_API_KEY: 'keyless-test',
    EF_LIVE_MODEL: 'test-model',
    EF_TAU2_BUNDLE_ROOT: bundleRoot,
    // A small window makes a leaf fold affordable to force; the threshold is half of it.
    EF_TAU2_WINDOW: '8192',
    // `REQUIRED=1` refuses to start unless every limit is armed, so a test cannot pass by
    // accidentally running with the budget switched off.
    ...(options.budget === undefined
      ? {}
      : {
          EF_LHTB_BUDGET_REQUIRED: '1',
          EF_LHTB_BUDGET_REQUESTS: String(options.budget.requests ?? 50),
          EF_LHTB_BUDGET_PROMPT_TOKENS: String(options.budget.promptTokens ?? 5_000_000),
          EF_LHTB_BUDGET_OUTPUT_TOKENS: String(options.budget.outputTokens ?? 1_000_000),
          EF_LHTB_BUDGET_WALL_MS: String(options.budget.wallMs ?? 600_000),
        }),
  })
  running.push(bridge)
  const init = await bridge.send({
    op: 'init',
    arm: { label: 'economy', engine: options.engine ?? 'ef', mode: 'economy', taskRootMode: options.taskRootMode },
    policy: 'You are a careful engineer.',
    tools: [],
    taskId: 'task-root-bridge',
    domain: 'lhtb',
  })
  expect(init['ok']).toBe(true)
  return { bridge, provider }
}

describe('the LHTB host declares its task root through the bridge', () => {
  it('registers the flagged instruction and keeps it out of a real leaf fold', async () => {
    const { bridge, provider } = await start({ taskRootMode: 'exact' })

    const appended = await bridge.send({
      op: 'append',
      message: { role: 'user', content: INSTRUCTION },
      taskRoot: true,
    })
    const afterAppend = telemetryOf(appended)
    expect(afterAppend.taskRoot, 'the host declaration is reported').toMatchObject({
      mode: 'exact',
      status: 'resident',
      digestVerified: true,
      surfacePosition: 0,
    })
    const rootSeq = afterAppend.taskRoot!.sourceSeq
    expect(rootSeq, 'and it names the real session seq').toBeTypeOf('number')
    const instructionSeq = (appended['seqs'] as number[])[0]!
    expect(rootSeq, 'the declared seq IS the instruction event').toBe(instructionSeq)

    for (let turn = 0; turn < 4; turn += 1) {
      await bridge.send({ op: 'append', message: { role: 'user', content: `work item ${turn} ` + 'w'.repeat(3_000) } })
    }

    await bridge.send({ op: 'step' })
    expect(provider.calls(), 'the model really was called').toBeGreaterThan(0)

    const leaf = await bridge.send({ op: 'compact' })
    const afterLeaf = telemetryOf(leaf)
    expect(afterLeaf.folds, 'a fold committed').toBeGreaterThan(0)
    expect(shadowed(afterLeaf), 'the task root was NOT shadowed by the leaf').not.toContain(rootSeq)
    expect(afterLeaf.taskRoot).toMatchObject({ status: 'resident', sourceSeq: rootSeq, digestVerified: true })

    await bridge.send({ op: 'step' })
  })

  it('runs Leaf, Leaf, PROTECTED ROOT, Leaf through the real bridge', async () => {
    const { bridge, provider } = await start({ taskRootMode: 'exact' })

    const appended = await bridge.send({
      op: 'append',
      message: { role: 'user', content: INSTRUCTION },
      taskRoot: true,
    })
    const declared = telemetryOf(appended)
    expect(declared.taskRoot).toMatchObject({
      mode: 'exact', status: 'resident', digestVerified: true, surfacePosition: 0,
    })
    const rootSeq = declared.taskRoot!.sourceSeq!
    expect(rootSeq, 'the declared seq IS the instruction event').toBe((appended['seqs'] as number[])[0])

    /** Push the surface over the threshold and commit one real automatic fold. */
    const forceLeaf = async (round: number) => {
      for (let index = 0; index < 6; index += 1) {
        await bridge.send({ op: 'append', message: { role: 'user', content: `filler ${round}-${index} ` + 'f'.repeat(6_000) } })
      }
      return telemetryOf(await bridge.send({ op: 'compact' }))
    }

    const leaf1 = await forceLeaf(1)
    expect(leaf1.folds, 'leaf 1 committed').toBeGreaterThanOrEqual(1)
    const leaf2 = await forceLeaf(2)
    expect(leaf2.folds, 'leaf 2 committed').toBeGreaterThanOrEqual(2)
    expect(shadowed(leaf2), 'two leaves never touched the task root').not.toContain(rootSeq)
    expect(leaf2.taskRoot).toMatchObject({ status: 'resident', sourceSeq: rootSeq })

    // The idle gap: a manual compaction requires no open turn, which is exactly what the
    // bridge's `rootCompact` arranges around the call.
    const root = await bridge.send({ op: 'rootCompact' })
    expect(root['committed'], `one protected root committed: ${JSON.stringify(root['refusal'])}`).toBe(1)
    const afterRoot = telemetryOf(root)
    expect(afterRoot.foldLineage.filter(entry => entry.mechanism === 'root').length, 'exactly ONE root').toBe(1)
    expect(afterRoot.foldLineage.filter(entry => entry.mechanism === 'emergency').length).toBe(0)
    expect(shadowed(afterRoot), 'and the root span excluded the task root').not.toContain(rootSeq)
    expect(afterRoot.taskRoot).toMatchObject({ status: 'resident', sourceSeq: rootSeq, digestVerified: true })
    // The protected node holds at position 0, so the root fold left it where it was.
    expect(afterRoot.taskRoot!.surfacePosition).toBe(0)

    const leaf3 = await forceLeaf(3)
    expect(leaf3.folds, 'leaf 3 committed after the root').toBeGreaterThanOrEqual(1)
    expect(shadowed(leaf3), 'nor did the post-root leaf').not.toContain(rootSeq)
    expect(leaf3.taskRoot).toMatchObject({ status: 'resident', sourceSeq: rootSeq, digestVerified: true })
    // A leaf fold succeeding AFTER a root is the practical proof the frontier is still legal:
    // `compactRegion` refuses a leaf that starts before `firstOpenPosition`.

    // The assembled model request is the only place the model-visible task text can be
    // counted directly. Exactly once, after two leaves and a root.
    await bridge.send({ op: 'step' })
    const body = provider.lastBody()
    expect(body.length, 'the last request was captured').toBeGreaterThan(0)
    expect(
      body.split('You must RECOVER THE TRUE SEMANTICS').length - 1,
      'the task text is in the next model request EXACTLY once',
    ).toBe(1)
  })
  it('executes context_search and an EXACT context_recall through the real ToolRuntime', async () => {
    const { bridge } = await start({ taskRootMode: 'exact' })

    // The task root, registered and NOT to be folded -- so it cannot serve as the archived sentinel.
    await bridge.send({ op: 'append', message: { role: 'user', content: INSTRUCTION }, taskRoot: true })
    // A SEPARATE message, carrying a nonce nothing else in the session contains.
    const SENTINEL = 'zqxjvbnonce'
    await bridge.send({
      op: 'append',
      message: { role: 'user', content: `recovered evidence: the format family is ${SENTINEL}.` },
    })
    for (let i = 0; i < 6; i += 1) {
      await bridge.send({ op: 'append', message: { role: 'user', content: `filler ${i} ` + 'f'.repeat(6_000) } })
    }
    const leaf = await bridge.send({ op: 'compact' })
    const folded = telemetryOf(leaf)
    expect(folded.folds, 'the fixtures folded nothing, so there is no archive to search').toBeGreaterThan(0)
    expect(shadowed(folded).length, 'and the fold archived real messages').toBeGreaterThan(0)

    /** Dispatch one real tool call through the bridge's ToolRuntime. */
    const callTool = async (name: string, args: Record<string, unknown>, callId: string) => {
      const reply = await bridge.send({ op: 'tool', name, arguments: args, callId })
      expect(reply['ok'], `${name} dispatch failed`).toBe(true)
      return String(reply['content'])
    }

    // 1. SEARCH. Dispatched, not simulated: `callEfTool` runs it on the host's own ToolRuntime.
    const searched = await callTool('context_search', { query: `format family ${SENTINEL}` }, 'call-search')
    expect(() => JSON.parse(searched) as unknown, 'the tool returns JSON the model can read').not.toThrow()
    const search = JSON.parse(searched) as Record<string, unknown>
    expect(JSON.stringify(search)).toContain('cp:')

    // Every `cp:` the search surfaced, so the exact page can be opened by REFERENCE rather than by
    // guessing a checkpoint id out of band.
    const refs = [...new Set(searched.match(/cp:[A-Za-z0-9_-]+/gu) ?? [])]
    expect(refs.length, 'the search surfaced at least one checkpoint reference').toBeGreaterThan(0)

    // 2. EXACT RECALL. Walk the refs until the archived page contains the nonce, which is the
    // assertion that matters: the bytes came back, not a promise that they could.
    let recovered = ''
    for (const ref of refs) {
      const page = await callTool('context_recall', { ref, depth: 'exact', offset: 0, limit: 20 }, `call-exact-${ref}`)
      recovered += page
      if (page.includes(SENTINEL)) break
    }
    expect(recovered, 'exact recall returned the ORIGINAL archived message, nonce and all').toContain(SENTINEL)
    expect(recovered, 'and not a summary of it').toContain('recovered evidence')
  })
  it('MEASURES whether this fixture exercises the summarization path at all', async () => {
    // Gate A's precondition. "The summarization shares the budget" cannot be tested against a
    // fixture whose folds never call the model -- and this one's do not: a fold commits with ZERO
    // extra HTTP requests, because EF takes its fallback checkpoint instead of a semantic summary.
    // Recorded as the reason Gate A is BLOCKED rather than dressed up as a passing integration.
    const { bridge, provider } = await start({ taskRootMode: 'exact', budget: { requests: 50 } })
    await bridge.send({ op: 'append', message: { role: 'user', content: INSTRUCTION }, taskRoot: true })
    for (let i = 0; i < 6; i += 1) {
      await bridge.send({ op: 'append', message: { role: 'user', content: `filler ${i} ` + 'f'.repeat(6_000) } })
    }
    const before = provider.calls()
    const folded = telemetryOf(await bridge.send({ op: 'compact' }))
    const delta = provider.calls() - before
    expect(folded.folds, 'a fold really committed').toBeGreaterThan(0)
    expect(delta, 'and it cost NO provider request, so no summary was asked for').toBe(0)
    expect(folded.summarizationAttempts ?? 0, 'the summarizer was never invoked').toBe(0)
    // The gate is therefore not exercised here; the request count still reconciles.
    expect(folded.budget?.requests, 'the gate counted what actually left').toBe(provider.calls())
  })

  it('still refuses the main model call once a spent budget has no requests left', async () => {
    // The request limit is real even though this fixture's folds are free: the task call must be
    // refused BEFORE it leaves.
    const { bridge, provider } = await start({ taskRootMode: 'exact', budget: { requests: 1 } })
    await bridge.send({ op: 'append', message: { role: 'user', content: INSTRUCTION }, taskRoot: true })
    for (let i = 0; i < 6; i += 1) {
      await bridge.send({ op: 'append', message: { role: 'user', content: `filler ${i} ` + 'f'.repeat(6_000) } })
    }
    await bridge.send({ op: 'compact' })
    expect(provider.calls(), 'the free fold spent nothing').toBe(0)

    const stepped = telemetryOf(await bridge.send({ op: 'step' }))
    expect(provider.calls(), 'the first real request was allowed').toBe(1)
    const second = telemetryOf(await bridge.send({ op: 'step' }))
    expect(provider.calls(), 'and the next one was refused').toBe(1)
    expect(second.lastFinishReason).toBe('budget-exhausted')
    expect(second.providerFailures, 'a spent budget is not a provider failure').toBe(0)
    expect(second.budget?.refusals).toBeGreaterThan(0)
    expect(stepped.taskRoot, 'the task root is untouched throughout').toMatchObject({ status: 'resident' })
  })
  it('FAILS CLOSED when exact mode never got a registration, before any request', async () => {
    // The host is the only party that can tell `exact` from `off`: to the engine both are just an
    // empty registry. So a host that forgets to flag the instruction would silently lose the
    // protection the arm was configured to provide, while telemetry still said `exact`. The guard
    // refuses BEFORE `drainIdleRebase()`, so no fold or rebase commits against that state either.
    const { bridge, provider } = await start({ taskRootMode: 'exact' })
    await bridge.send({ op: 'append', message: { role: 'user', content: INSTRUCTION } })
    for (let i = 0; i < 3; i += 1) {
      await bridge.send({ op: 'append', message: { role: 'user', content: `filler ${i} ` + 'f'.repeat(2_000) } })
    }

    const before = provider.calls()
    const stepped = telemetryOf(await bridge.send({ op: 'step' }))
    expect(provider.calls(), 'no provider request was made').toBe(before)
    expect(stepped.lastFinishReason, 'its own reason, not an error:').toBe('task-root-contract')
    expect(stepped.providerFailures, 'and not a provider failure').toBe(0)
    expect(stepped.folds, 'and no fold ran against the unverified state').toBe(0)
    expect(stepped.taskRoot?.status).toBe('absent')
    expect(stepped.taskRoot?.reason).toContain('contract failure')
  })

  it('does NOT block the same setup when the arm is off, which is a legal configuration', async () => {
    const { bridge, provider } = await start({ taskRootMode: 'off' })
    await bridge.send({ op: 'append', message: { role: 'user', content: INSTRUCTION } })
    const before = provider.calls()
    const stepped = telemetryOf(await bridge.send({ op: 'step' }))
    expect(provider.calls(), 'the model call went out as before').toBe(before + 1)
    expect(stepped.lastFinishReason).not.toBe('task-root-contract')
    // Nothing was DECLARED, so there is no root state to report -- and no block either.
    expect(stepped.taskRoot).toBeUndefined()
  })

  it('registers NOTHING when the arm says off, and the instruction IS then folded away', async () => {
    const { bridge } = await start({ taskRootMode: 'off' })
    const appended = await bridge.send({
      op: 'append',
      message: { role: 'user', content: INSTRUCTION },
      taskRoot: true,
    })
    expect(telemetryOf(appended).taskRoot).toMatchObject({ mode: 'off', status: 'unregistered' })
    const instructionSeq = (appended['seqs'] as number[])[0]!

    for (let turn = 0; turn < 4; turn += 1) {
      await bridge.send({ op: 'append', message: { role: 'user', content: `filler ${turn} ` + 'f'.repeat(3_000) } })
    }
    const leaf = await bridge.send({ op: 'compact' })
    const after = telemetryOf(leaf)
    expect(after.folds, 'a fold committed').toBeGreaterThan(0)
    // THIS is what the `exact` arm above is buying: with no declaration the instruction is
    // inside the folded span, and the two arms must therefore not be pooled.
    expect(shadowed(after), 'unprotected, the instruction IS shadowed').toContain(instructionSeq)
  })
  it('forces the switch off on the basic arm, whatever the config says', async () => {
    const { bridge } = await start({ taskRootMode: 'exact', engine: 'basic' })
    const appended = await bridge.send({
      op: 'append',
      message: { role: 'user', content: INSTRUCTION },
      taskRoot: true,
    })
    expect(telemetryOf(appended).taskRoot).toMatchObject({
      mode: 'off',
      status: 'unregistered',
      reason: 'basic-arm-never-protects',
    })
  })
})