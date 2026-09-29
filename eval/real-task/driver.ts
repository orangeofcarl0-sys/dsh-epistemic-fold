/**
 * RC2 §2: the real-task driver.
 *
 * Runs one real task across the four modes — `legacy` (Basic's own policy),
 * `economy`, `balanced`, `quality` — and records the three metrics per arm.
 *
 * ## What makes this a real DSH run rather than a synthetic benchmark
 *
 *  - The REAL `EpistemicFoldPlugin` is mounted, so the folds come from the
 *    production policy and the production idle-rebase consumer.
 *  - The REAL `ToolRuntime` executes the REAL workspace tools, so the artifact
 *    is produced by genuine tool calls against a genuine filesystem.
 *  - The REAL provider bills every call, so `Cost` is the provider's own number
 *    rather than a model of one.
 *  - The session crosses the fold threshold repeatedly, so the facts the task
 *    later needs have actually been folded away.
 *
 * ## Lifecycle scenarios (RC2 §2)
 *
 * `restart` and `model-switch` are modelled the way the runtime records them: a
 * `request/header` with reason `resume`, and the durable model-change notice.
 * Both are appended to the log so the mode's behaviour across them is measured
 * rather than assumed — a session that folds, restarts, and continues is the
 * case where a context runtime either holds its grip or does not.
 *
 * @module eval/real-task/driver
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createHarness, SIGNAL } from '../../tests/harness.ts'
import { assemble, safeParse, surfaceMessages } from '../../tests/recall-loop.ts'
import { OpenAiCompatibleAdapter } from '../live/openai-adapter.ts'
import { BillingRecorder } from '../live/recorder.ts'
import { realizedCost } from '../live/billing.ts'
import { resolveLiveRoute } from '../live/zcode-config.ts'
import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import { parseEconomicsProfile } from '../../src/economics-profile.ts'
import { resolvePreset } from '../../src/preset.ts'
import type { FoldModeName } from '../../src/preset.ts'
import { registerWorkspaceTools, resetWorkspace, WORKSPACE_TOOL_NAMES } from './workspace-tools.ts'
import { finishedState, measureSteadiness } from './metrics.ts'
import type { CostResult, TaskOutcomeKind, TaskRun } from './metrics.ts'
import type { RealTask } from './tasks.ts'
import { relative, sep } from 'node:path'

/** The live provider id these runs register. */
const LIVE_PROVIDER = 'live'

/** How many model rounds one task may take before it is cut off. */
const MAX_ROUNDS = Number(process.env.EF_TASK_ROUNDS ?? 14)

/** The context window these runs simulate, so folding is exercised. */
const TASK_WINDOW = Number(process.env.EF_TASK_WINDOW ?? 16_000)

/** How much output each model step may produce. */
const STEP_MAX_TOKENS = 900

/** Which lifecycle stress a run applies. */
export type LifecycleScenario = 'plain' | 'restart' | 'model-switch'

/** One arm's configuration for a task run. */
export interface ArmSpec {
  readonly mode: FoldModeName
  readonly label: string
}

/** The four arms, in ascending cost order with Basic's policy first. */
export const ARMS: readonly ArmSpec[] = [
  { mode: 'legacy', label: 'legacy' },
  { mode: 'economy', label: 'economy' },
  { mode: 'balanced', label: 'balanced' },
  { mode: 'quality', label: 'quality' },
]

/** List workspace files, relative and slash-separated. */
async function listWorkspaceFiles(root: string): Promise<readonly string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        found.push(`${rel}/`)
        await walk(full)
      } else {
        found.push(rel)
      }
    }
  }
  await walk(root)
  return found.sort()
}

/** Read one workspace file, or `undefined`. */
async function readWorkspaceFile(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), 'utf8')
  } catch {
    return undefined
  }
}

/** Load the routed model's economics profile from the shipped profile files. */
export function flashProfile(): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'profiles', 'economics', 'deepseek-flash-2026-09.json'), 'utf8'),
  ))
}

/** Everything one arm's run produced. */
export interface ArmRunResult extends TaskRun {
  readonly scenario: LifecycleScenario
}

/**
 * Run ONE task for ONE arm.
 *
 * @returns the three metrics plus the timeline the report reads.
 */
export async function runTaskArm(options: {
  readonly task: RealTask
  readonly arm: ArmSpec
  readonly replicate: number
  readonly scenario: LifecycleScenario
  readonly profile: ContextEconomicsProfile
  readonly workspaceRoot: string
}): Promise<ArmRunResult> {
  const { task, arm, replicate, scenario, profile, workspaceRoot } = options
  const route = resolveLiveRoute()
  if (route === undefined) throw new Error('no live route resolved')

  await resetWorkspace(workspaceRoot)

  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.model, contextWindow: TASK_WINDOW,
  })
  const recorder = new BillingRecorder(adapter, `${arm.label}-${task.id}-${replicate}`)

  const harness = await createHarness({ text: 'checkpoint digest' }, {
    contextWindow: TASK_WINDOW,
    plugin: true,
    systemPrompt: true,
    tools: true,
    efConfig: {
      // The arm IS the mode: everything else is held identical so a difference
      // is attributable to the mode rather than to the fixture.
      ...(arm.mode === 'legacy' ? {} : resolvePreset(arm.mode)),
      headroomTokens: 0,
      maxTokens: 1_500,
    },
    adapter: { provider: LIVE_PROVIDER, instance: recorder },
  })
  const disposeTools = registerWorkspaceTools(harness.ctx, workspaceRoot)

  const session = Session.create(SessionId(`rc2-${arm.label}-${task.id}-${Date.now()}-${replicate}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: LIVE_PROVIDER, model: 'live', maxTokens: STEP_MAX_TOKENS } },
    reason: 'initial',
  })

  const { system, tools } = await assemble(harness)
  const agent = { session, options: { provider: LIVE_PROVIDER, model: 'live' } } as never

  const timeline: string[] = []
  const toolCalls: Record<string, number> = {}
  let answer = ''
  let rounds = 0
  let providerCalls = 0
  let turn = 1

  /** Append a user turn and run the model to quiescence. */
  const runTurn = async (text: string): Promise<void> => {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      rounds += 1
      const isLast = round === MAX_ROUNDS - 1
      let stepText = ''
      const calls: Array<{ id: string; name: string; args: string }> = []

      providerCalls += 1
      for await (const chunk of harness.ctx.llm.stream({
        provider: LIVE_PROVIDER,
        model: 'live',
        messages: surfaceMessages(session),
        ...(system === undefined ? {} : { system }),
        ...(tools === undefined ? {} : { tools }),
        maxTokens: STEP_MAX_TOKENS,
      } as never)) {
        if (chunk.type === 'text-delta') stepText += chunk.text
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          calls.push({ id: chunk.block.id, name: chunk.block.name, args: chunk.block.arguments })
        }
      }
      if (stepText.length > 0) answer = stepText
      if (calls.length === 0) return
      if (isLast) return

      session.append('step/start', { turn, step: round + 1 })
      session.append('assistant/message', {
        stream: [], turn, step: round + 1,
        message: createMessage({
          role: 'assistant',
          content: [
            ...(stepText.length === 0 ? [] : [{ type: 'text' as const, text: stepText }]),
            ...calls.map(call => ({
              type: 'tool-call' as const,
              id: ToolCallId(call.id),
              name: call.name,
              arguments: call.args,
            })),
          ],
          source: { kind: 'model', provider: LIVE_PROVIDER, model: 'live' },
        }),
      }, { surfaceOp: 'append' })

      for (const call of calls) {
        const callId = ToolCallId(call.id)
        session.append('tool/call', { turn, step: round + 1, callId, name: call.name, arguments: call.args })
        toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1
        timeline.push(call.name)

        let content: ContentBlock[]
        let isError = false
        try {
          const result = await harness.ctx.tools.execute({
            callId, name: call.name, arguments: safeParse(call.args), agent, signal: SIGNAL,
          })
          content = result.content as ContentBlock[]
          isError = result.isError
        } catch (error: unknown) {
          isError = true
          content = [{
            type: 'text',
            text: `tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
          }]
        }
        session.append('tool/result', {
          turn, step: round + 1,
          message: createToolResultMessage({ callId, content, isError }),
        }, { surfaceOp: 'append' })
      }
      session.append('step/end', { turn, step: round + 1 })
    }
  }

  /** Fold the session to the point where the facts are archived. */
  const foldHard = async (): Promise<void> => {
    try {
      await (harness.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded({ session, options: { provider: LIVE_PROVIDER, model: 'live' } }, 'pressure', SIGNAL)
    } catch { /* a refused fold is a decision */ }
  }

  // --- The brief and the context turns. Each is folded after it lands, so the
  // facts are INSIDE checkpoints by the time the work needs them.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: task.brief }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  for (const [index, fact] of task.context.entries()) {
    turn += 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: fact }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    // Fold after each context turn: this is what pushes the early facts behind
    // the frontier, which is the condition the mode is being measured under.
    await foldHard()
    if (index === 0) {
      // --- Lifecycle: the restart / model-switch boundary lands AFTER the first
      // fact, so the session must carry it across the boundary.
      if (scenario === 'restart') {
        session.append('request/header', {
          header: { config: { provider: LIVE_PROVIDER, model: 'live', maxTokens: STEP_MAX_TOKENS } },
          reason: 'resume',
        })
      }
      if (scenario === 'model-switch') {
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text:
            '[model changed: assistant turns above this point were generated by live/live; '
            + 'the session continues with live/live-alt]' }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
      }
    }
  }

  // --- The work.
  for (const step of task.work) {
    turn += 1
    session.append('turn/start', { turn })
    await runTurn(step)
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })

  disposeTools()

  // --- Metrics. The recorder already carries the provider's own token split per
  // call, so the cost is realized rather than re-derived: `promptTokens` is what
  // the provider charged for, and `uncachedInputTokens` its own cache-miss part.
  // A call that returned nothing still cost money, so it is included whenever it
  // reported usage — and `failedCalls` records how many those were.
  let total = 0
  let uncachedInputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  for (const call of recorder.bill) {
    total += realizedCost([call], profile)
    uncachedInputTokens += call.uncachedInputTokens
    cacheReadTokens += call.cacheReadTokens
    outputTokens += call.outputTokens
  }
  const cost: CostResult = {
    total,
    calls: recorder.bill.length,
    failedCalls: recorder.failedCalls.length,
    uncachedInputTokens,
    cacheReadTokens,
    outputTokens,
  }

  const state = await finishedState(workspaceRoot, answer, listWorkspaceFiles)
  const qualityChecks = await Promise.all(task.quality.map(async check => ({
    id: check.id,
    passed: await check.passed({ read: path => readWorkspaceFile(workspaceRoot, path), files: state.files, answer }),
    detail: check.detail,
  })))
  const passed = qualityChecks.filter(check => check.passed).length
  const steadiness = await measureSteadiness(
    { ...state, read: path => readWorkspaceFile(workspaceRoot, path) },
    task.steadiness,
  )

  const outcome: TaskOutcomeKind = recorder.bill.length > 0 && recorder.bill.every(call => !call.success)
    ? 'transport-failed'
    : answer.length === 0 ? 'truncated' : 'answered'

  return {
    arm: arm.label,
    taskId: task.id,
    scenario,
    outcome,
    rounds,
    cost,
    quality: {
      passed,
      total: qualityChecks.length,
      score: qualityChecks.length === 0 ? 0 : passed / qualityChecks.length,
      checks: qualityChecks,
    },
    steadiness,
    toolCalls,
    timeline,
    answer: answer.replace(/\s+/gu, ' ').slice(0, 400),
  }
}

/** A fresh workspace directory for one run. */
export async function newWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ef-task-'))
}

/** The tool names a task run should expect to see, for a sanity check. */
export { WORKSPACE_TOOL_NAMES }
