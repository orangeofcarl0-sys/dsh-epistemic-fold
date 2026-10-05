/**
 * The benchmark harness exposes EF's recall tools to the model, and routes them.
 *
 * ## The defect this exists for
 *
 * `registerRecallTools` puts `context_search` and `context_recall` on
 * `ctx.tools`, but nothing forwards them to a provider — the bridge owns the
 * tool list it sends. Two things were missing:
 *
 * 1. **No ToolRuntime.** The host mounted no `ctx.tools`, and the plugin
 *    registers the recall tools only when that service exists (a compaction-only
 *    deployment is supported and mounts cleanly without it). So the tools were
 *    never registered at all.
 * 2. **No routing.** The LHTB agent sent EVERY tool call to `run_shell`, so a
 *    `context_search` would have been executed in the container as a shell
 *    command named after its arguments.
 *
 * Together these meant the model saw only `run_shell`, and LHTB measured
 * checkpoint-surface continuation while never once exercising exact recall of
 * folded history. That is half of EF's claim: the tiers are supposed to buy
 * retrievability, and a run that cannot call the retrieval tool cannot show it.
 *
 * ## What is asserted
 *
 * The registration and the EXECUTION are both pinned, through the real
 * `ToolRuntime` rather than a stub — a test that only checked the schema list
 * would pass with a tool that throws when called.
 *
 * @module tests/harness-recall-tools
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createHarness, conversation, idleAgent, SIGNAL } from './harness.ts'

const ROOT = join(import.meta.dirname, '..')
const BRIDGE = join(ROOT, 'eval', 'tau2', 'bridge-host.ts')
const LHTB_AGENT = join(ROOT, 'eval', 'lhtb', 'ef_lhtb_agent.py')

/** A harness with a ToolRuntime, which the recall tools require. */
async function toolsHarness(): Promise<{
  ctx: Awaited<ReturnType<typeof createHarness>>['ctx']
  engine: Awaited<ReturnType<typeof createHarness>>['engine']
}> {
  const created = await createHarness({ text: 'digest' }, {
    contextWindow: 2_000,
    plugin: true,
    tools: true,
    // `ToolRuntime` requires `ctx.systemPrompt` to be mounted first: it registers
    // a system-prompt section in its constructor.
    systemPrompt: true,
    efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 100 },
  })
  return { ctx: created.ctx, engine: created.engine }
}

/** The mounted runtime, obtained through the sanctioned inject callback. */
async function runtimeOf(ctx: Awaited<ReturnType<typeof createHarness>>['ctx']): Promise<ToolRuntime> {
  let runtime: ToolRuntime | undefined
  // Awaited: the callback does not run synchronously, and reading the captured
  // reference without awaiting yields `undefined`.
  await ctx.inject(['tools'], toolsCtx => {
    runtime = toolsCtx.tools
    return () => {}
  })
  if (runtime === undefined) throw new Error('no ToolRuntime was captured')
  return runtime
}

describe('the harness exposes EF recall tools', () => {
  it('bridge-host mounts a ToolRuntime and captures it through inject', () => {
    // Source-level for the mounting, because the host is a script: importing it
    // starts the stdin protocol loop.
    const source = readFileSync(BRIDGE, 'utf8')
    expect(source, 'the host must mount a ToolRuntime or the recall tools never register')
      .toContain('new ToolRuntime(ctx)')
    expect(
      source,
      'the runtime must be read through `inject`; `ctx.get` throws for a service outside inject',
    ).toContain("ctx.inject(['tools']")
    // Ordering: ToolRuntime registers a system-prompt section in its constructor.
    const systemAt = source.indexOf('new SystemPrompt(ctx, {})')
    const toolsAt = source.indexOf('new ToolRuntime(ctx)')
    expect(systemAt, 'SystemPrompt must be mounted').toBeGreaterThan(-1)
    expect(toolsAt, 'ToolRuntime must be mounted').toBeGreaterThan(-1)
    expect(
      systemAt,
      'SystemPrompt must precede ToolRuntime, which registers a section on it',
    ).toBeLessThan(toolsAt)
  })

  it('bridge-host adds the EF tool schemas to the provider tool list', () => {
    const source = readFileSync(BRIDGE, 'utf8')
    const schemas = source.slice(source.indexOf('function toolSchemas'))
    expect(
      schemas,
      'the provider tool list must include the runtime schemas, not only the benchmark tools',
    ).toContain('schemas()')
  })

  it('bridge-host dispatches a tool op through the runtime', () => {
    const source = readFileSync(BRIDGE, 'utf8')
    expect(source, "the host must handle an 'tool' op").toContain("op === 'tool'")
    expect(source).toContain('runtime.execute(')
  })

  it('the LHTB agent routes by tool NAME rather than sending everything to the shell', () => {
    // The routing defect: `command = arguments["command"]` for every call, so a
    // recall call was sent to the container as a shell command.
    const source = readFileSync(LHTB_AGENT, 'utf8')
    expect(source, 'the agent must read the call name').toContain('call.get("name")')
    expect(
      source,
      'the agent must branch on the name; sending every call to run_shell means recall never runs',
    ).toContain('name == SHELL_TOOL')
    expect(source, 'EF tools must go to the bridge').toContain('call_tool(')
  })

  it('the bridge client exposes call_tool', () => {
    const client = readFileSync(join(ROOT, 'eval', 'bridge', 'ef_bridge_client.py'), 'utf8')
    expect(client).toContain('def call_tool(')
    expect(client).toContain('"op": "tool"')
  })
})

describe('the recall tools register and actually execute', () => {
  it('both tools appear in the runtime schema list', async () => {
    const { ctx } = await toolsHarness()
    const names = (await runtimeOf(ctx)).schemas().map(schema => schema.name)
    expect(names, `registered tools: ${names.join(', ')}`).toContain('context_search')
    expect(names, `registered tools: ${names.join(', ')}`).toContain('context_recall')
  }, 300_000)

  it('context_search returns archived history through the real runtime', async () => {
    // The execution assertion. A schema-only check would pass with a tool that
    // throws when called, which is exactly the failure mode a missing runtime
    // dependency produces.
    const { ctx, engine } = await toolsHarness()
    const runtime = await runtimeOf(ctx)
    const session = conversation(6)
    await engine.compactIfNeeded(idleAgent(session) as never, 'pressure', SIGNAL)
    expect(engine.leafFoldCount, 'the fixture folded nothing, so there is no archive to search')
      .toBeGreaterThan(0)

    const result = await runtime.execute({
      callId: ToolCallId('recall-probe'),
      name: 'context_search',
      arguments: { query: 'fixture' },
      agent: { session } as never,
      signal: SIGNAL,
    })
    const text = result.content
      .map(block => (block.type === 'text' ? block.text ?? '' : ''))
      .join('')
    expect(result.isError, 'context_search failed when executed').toBe(false)
    expect(text.length, 'context_search returned nothing').toBeGreaterThan(0)
    // The result is JSON the model can read, not a bare string.
    expect(() => JSON.parse(text) as unknown).not.toThrow()
  }, 300_000)

  it('a compaction-only deployment still mounts cleanly without the tools', async () => {
    // The optionality the plugin documents: recall tools need `ctx.tools`, and a
    // deployment without one must not fail. Asserted so the mounting fix above
    // cannot be mistaken for making the runtime mandatory.
    const created = await createHarness({ text: 'digest' }, {
      contextWindow: 8_000,
      plugin: true,
    })
    expect(created.engine).toBeDefined()
  }, 300_000)
})
