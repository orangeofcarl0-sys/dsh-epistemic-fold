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
async function fakeProvider(): Promise<{ server: Server; url: string; calls: () => number }> {
  let calls = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      calls += 1
      void body
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
  return { server, url: `http://127.0.0.1:${port}`, calls: () => calls }
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
  readonly foldLineage: readonly { readonly shadowedSeqs: readonly number[] }[]
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

async function start(options: { readonly taskRootMode: 'off' | 'exact'; readonly engine?: 'basic' | 'ef' }) {
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

  it('documents the harness limit on FORCED roots, and shows it is Basic parity', async () => {
    // A manual root fold is the one EF path the bridge cannot drive, for a reason that has
    // nothing to do with task roots: `compactNow` passes a durability barrier
    // (`ctx.sessions.flush`), and this harness creates a bare in-memory session that the store
    // has never seen. Basic's own `compactNow` passes the SAME barrier, so the limit is the
    // harness's and not this change's -- which is what makes it a parity fact rather than an
    // excuse. Verified for EF below and asserted for Basic in the next test.
    const { bridge } = await start({ taskRootMode: 'exact' })
    await bridge.send({ op: 'append', message: { role: 'user', content: INSTRUCTION }, taskRoot: true })
    for (let turn = 0; turn < 4; turn += 1) {
      await bridge.send({ op: 'append', message: { role: 'user', content: `filler ${turn} ` + 'f'.repeat(3_000) } })
    }
    const root = await bridge.send({ op: 'rootCompact' })
    expect(root['refusal']).toContain('not live in this store')
    expect(root['committed'], 'nothing committed').toBe(0)
    // And the declaration is UNHARMED: the root is still resident after the declined root fold.
    expect(telemetryOf(root).taskRoot).toMatchObject({ status: 'resident' })
  })

  it('the SAME forced-root limit applies to the basic arm, so it is not this change', async () => {
    const { bridge } = await start({ taskRootMode: 'exact', engine: 'basic' })
    await bridge.send({ op: 'append', message: { role: 'user', content: INSTRUCTION }, taskRoot: true })
    for (let turn = 0; turn < 4; turn += 1) {
      await bridge.send({ op: 'append', message: { role: 'user', content: `filler ${turn} ` + 'f'.repeat(3_000) } })
    }
    const root = await bridge.send({ op: 'rootCompact' })
    expect(root['refusal'], 'the identical durability barrier').toContain('not live in this store')
    expect(root['committed']).toBe(0)
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