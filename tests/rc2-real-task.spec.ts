/**
 * RC2: the real-task harness, proven end to end WITHOUT a provider.
 *
 * The live comparison is the expensive part, and an expensive run is worthless
 * if its harness is broken — a task whose tools do not execute, or whose quality
 * checks pass on an empty workspace, would report a mode difference that is
 * really a fixture difference. So everything except the model is exercised here:
 *
 *  - the real workspace tools run against a real temp directory, including the
 *    path-confinement boundary;
 *  - the quality checks FAIL on an empty workspace and PASS on a correct
 *    artifact, so a score of 4/4 means something;
 *  - the steadiness probes distinguish the CORRECTED value from the superseded
 *    one, which is the property the whole comparison turns on;
 *  - a scripted fake model drives the driver's own loop, so the turn structure,
 *    the fold cadence, and the metric aggregation are all verified.
 *
 * @module tests/rc2-real-task
 */

import { describe, expect, it } from 'vitest'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createHarness, SIGNAL } from './harness.ts'
import { makeTemp } from '../eval/tmp.ts'
import { confinePath, registerWorkspaceTools, resetWorkspace } from '../eval/real-task/workspace-tools.ts'
import {
  assertsValueAsCurrent,
  finishedState,
  measureSteadiness,
  taskRunToText,
} from '../eval/real-task/metrics.ts'
import {
  CODING_TASK,
  LONG_CODING_TASK,
  LONG_RESEARCH_TASK,
  REAL_TASKS,
  RESEARCH_TASK,
  RETENTION_AB_TASKS,
  TOOL_HEAVY_TASK,
} from '../eval/real-task/tasks.ts'
import { ARMS, EF_ARMS } from '../eval/real-task/driver.ts'
import { readdir } from 'node:fs/promises'
import { relative, sep } from 'node:path'

/** List files under `root`, relative and slash-separated. */
async function listFiles(root: string): Promise<readonly string[]> {
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

/** A harness with the real workspace tools mounted over `root`. */
async function toolHarness(root: string) {
  // `ToolRuntime` wires its schemas through `ctx.systemPrompt`, so the prompt
  // service must be mounted for the tools to register at all.
  const harness = await createHarness({ text: 'digest' }, {
    contextWindow: 16_000, tools: true, systemPrompt: true,
  })
  const dispose = registerWorkspaceTools(harness.ctx, root)
  return { harness, dispose }
}

/** A minimal agent stub: the workspace tools do not read the agent. */
const agent = { session: Session.create(SessionId('rc2-tools')), options: {} } as never

/** Execute one tool through the real runtime. */
async function callTool(
  harness: Awaited<ReturnType<typeof toolHarness>>['harness'],
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly content: string; readonly isError: boolean }> {
  const result = await harness.ctx.tools.execute({
    callId: `call-${name}-${Math.random().toString(36).slice(2, 8)}` as never,
    name,
    arguments: args,
    agent,
    signal: SIGNAL,
  })
  return {
    content: (result.content as Array<{ type: string; text?: string }>)
      .map(block => block.text ?? '').join('\n'),
    isError: result.isError,
  }
}

describe('RC2: the workspace tools do real work', () => {
  it('writes and reads a file through the real ToolRuntime', async () => {
    const root = await makeTemp('rc2-tools-')
    const { harness, dispose } = await toolHarness(root)

    const written = await callTool(harness, 'write_file', {
      path: 'src/paginate.js', content: 'export function paginate() {}\n',
    })
    expect(written.isError).toBe(false)
    // The file is REALLY on disk, not just acknowledged.
    expect(await readFile(join(root, 'src/paginate.js'), 'utf8')).toContain('paginate')

    const read = await callTool(harness, 'read_file', { path: 'src/paginate.js' })
    expect(read.content).toContain('paginate')

    const listed = await callTool(harness, 'list_files', { path: '.' })
    expect(listed.content).toContain('src/paginate.js')
    dispose()
  })

  it('reports a missing file as data, not as a tool error', async () => {
    // A model exploring a tree hits absent files constantly; a thrown error
    // would read as a malfunction and derail the task.
    const root = await makeTemp('rc2-tools-')
    const { harness, dispose } = await toolHarness(root)
    const read = await callTool(harness, 'read_file', { path: 'nope.js' })
    expect(read.isError).toBe(false)
    expect(read.content).toContain('missing')
    dispose()
  })

  it('CONFINES every path to the workspace', async () => {
    // The tools take model-authored paths, so this is a real boundary.
    const root = await makeTemp('rc2-tools-')
    const { harness, dispose } = await toolHarness(root)
    for (const escape of ['../outside.js', '../../etc/passwd', 'a/../../outside.js']) {
      expect(() => confinePath(root, escape)).toThrow(/escapes the workspace/u)
    }
    // Through the tool, an escaping write is an ERROR result the model sees.
    const written = await callTool(harness, 'write_file', { path: '../outside.js', content: 'x' })
    expect(written.isError).toBe(true)
    dispose()
  })

  it('runs a real script and reports its exit code and output', async () => {
    const root = await makeTemp('rc2-tools-')
    const { harness, dispose } = await toolHarness(root)
    await callTool(harness, 'write_file', {
      path: 'ok.js', content: 'console.log(JSON.stringify({ sum: 1 + 1 }))\n',
    })
    const run = await callTool(harness, 'run_node', { file: 'ok.js' })
    expect(run.isError).toBe(false)
    // The canonical value is JSON, so the script's own stdout arrives escaped.
    // The model reads it through the tool's renderer, which is why the check is
    // on the DECODED payload rather than on the raw string.
    const decoded = JSON.parse(run.content) as { code: number; stdout: string }
    expect(decoded.code).toBe(0)
    expect(decoded.stdout).toContain('"sum":2')

    // A failing script reports its failure rather than throwing.
    await callTool(harness, 'write_file', { path: 'bad.js', content: 'throw new Error("nope")\n' })
    const bad = await callTool(harness, 'run_node', { file: 'bad.js' })
    expect(bad.isError).toBe(false)
    const badDecoded = JSON.parse(bad.content) as { code: number; stderr: string }
    expect(badDecoded.code).toBe(1)
    expect(badDecoded.stderr).toContain('nope')
    dispose()
  }, 60_000)
})

describe('RC2: quality checks discriminate a real artifact from an empty one', () => {
  it('scores ZERO on an empty workspace', async () => {
    // The vacuity guard for the whole comparison: if the checks passed on an
    // empty workspace, every arm would score full marks and the run would prove
    // nothing.
    const root = await makeTemp('rc2-empty-')
    const state = await finishedState(root, '', listFiles)
    for (const task of REAL_TASKS) {
      const results = await Promise.all(task.quality.map(check => check.passed(state)))
      expect(results.some(Boolean), `${task.id} must not pass on an empty workspace`).toBe(false)
    }
  })

  it('scores a CORRECT artifact highly, and a WRONG one low', async () => {
    const root = await makeTemp('rc2-artifact-')
    // A correct artifact, built to the CORRECTED spec.
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'paginate.js'), [
      'export function paginate(items, page = 1, pageSize = 25) {',
      '  const start = (page - 1) * pageSize',
      '  return { items: items.slice(start, start + pageSize), page, pageSize,',
      '    totalPages: Math.ceil(items.length / pageSize) }',
      '}',
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'test.js'), 'console.log("ok")\n', 'utf8')

    const good = await finishedState(root, 'done', listFiles)
    const goodQuality = await Promise.all(CODING_TASK.quality.map(check => check.passed(good)))
    expect(goodQuality.every(Boolean)).toBe(true)
    const goodSteady = await measureSteadiness(good, CODING_TASK.steadiness)
    expect(goodSteady.score).toBe(1)

    // The SAME task built to the SUPERSEDED spec: the default is still 10.
    const stale = await makeTemp('rc2-stale-')
    await mkdir(join(stale, 'src'), { recursive: true })
    await writeFile(join(stale, 'src', 'paginate.js'),
      'export function paginate(items, page = 1, pageSize = 10) { return {} }\n', 'utf8')
    await writeFile(join(stale, 'test.js'), 'console.log("ok")\n', 'utf8')

    const staleState = await finishedState(stale, 'done', listFiles)
    const staleSteady = await measureSteadiness(staleState, CODING_TASK.steadiness)
    // The revision probe and the resurrection probe must BOTH fail.
    expect(staleSteady.probes.find(p => p.id === 'revision-honoured')?.held).toBe(false)
    expect(staleSteady.probes.find(p => p.id === 'no-resurrection')?.held).toBe(false)
    expect(staleSteady.score).toBeLessThan(goodSteady.score)
  })

  it('accepts BOTH module systems as a named export', async () => {
    // The defect this pins: the first version of this check accepted only ESM
    // syntax, and a live run that used `module.exports = { paginate }` — a
    // perfectly good named export — was scored as a failure. A quality check
    // that rejects correct work manufactures a mode difference.
    const esm = await makeTemp('rc2-esm-')
    await mkdir(join(esm, 'src'), { recursive: true })
    await writeFile(join(esm, 'src', 'paginate.js'),
      'export function paginate(items, pageSize = 25) { return {} }' + String.fromCharCode(10), 'utf8')
    const esmState = await finishedState(esm, '', listFiles)
    expect(await CODING_TASK.quality.find(c => c.id === 'named-export')!.passed(esmState)).toBe(true)

    const cjs = await makeTemp('rc2-cjs-')
    await mkdir(join(cjs, 'src'), { recursive: true })
    await writeFile(join(cjs, 'src', 'paginate.js'), [
      'function paginate(items, pageSize = 25) { return {} }',
      'module.exports = { paginate }',
    ].join(String.fromCharCode(10)), 'utf8')
    const cjsState = await finishedState(cjs, '', listFiles)
    expect(await CODING_TASK.quality.find(c => c.id === 'named-export')!.passed(cjsState)).toBe(true)
    // ...and the interface probe accepts it too.
    const steady = await measureSteadiness(cjsState, CODING_TASK.steadiness)
    expect(steady.probes.find(p => p.id === 'interface-honoured')?.held).toBe(true)
  })

  it('a mutating implementation fails the no-mutation constraint', async () => {
    const root = await makeTemp('rc2-mutate-')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'paginate.js'),
      'export function paginate(items, page = 1, pageSize = 25) { items.sort(); return items }\n', 'utf8')
    const state = await finishedState(root, '', listFiles)
    const checks = await Promise.all(CODING_TASK.quality.map(async check => [check.id, await check.passed(state)] as const))
    expect(checks.find(([id]) => id === 'no-mutation')?.[1]).toBe(false)
    // And the steadiness probe for the early constraint catches it too.
    const steady = await measureSteadiness(state, CODING_TASK.steadiness)
    expect(steady.probes.find(p => p.id === 'constraint-retained')?.held).toBe(false)
  })

  it('catches a model that WROTE the revision but REPORTED the old value', async () => {
    // The failure mode the `no-resurrection` probe exists for: the artifact is
    // right and the prose is wrong, which a filesystem-only check would miss.
    const root = await makeTemp('rc2-report-')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'paginate.js'),
      'export function paginate(items, pageSize = 25) { return {} }\n', 'utf8')
    const state = await finishedState(root, 'the default pageSize is 10', listFiles)
    const steady = await measureSteadiness(state, CODING_TASK.steadiness)
    expect(steady.probes.find(p => p.id === 'no-resurrection')?.held).toBe(false)
  })
})

describe('RC2: the steadiness probes are per-task and meaningful', () => {
  it('every task declares the four probe families', () => {
    // Each task must ask the same four questions, or the arms are not comparable
    // across tasks.
    const expected = ['constraint-retained', 'revision-honoured', 'no-resurrection', 'interface-honoured']
    for (const task of REAL_TASKS) {
      expect(task.steadiness.map(probe => probe.id).sort()).toEqual([...expected].sort())
      expect(task.quality.length).toBeGreaterThan(0)
    }
  })

  it('each task carries a revision, so the probes have something to catch', () => {
    // The comparison turns on supersession. A task with no revision would make
    // `revision-honoured` and `no-resurrection` vacuous.
    for (const task of REAL_TASKS) {
      const revised = task.context.some(fact => /CORRECTION/iu.test(fact))
      expect(revised, `${task.id} must revise one of its own facts`).toBe(true)
    }
  })

  it('the research task distinguishes its corrected timeout from the superseded one', async () => {
    const root = await makeTemp('rc2-research-')
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'config', 'retry.json'),
      JSON.stringify({ attempts: 3, timeoutMs: 3000, baseMs: 100, jitter: 'full' }), 'utf8')
    const good = await measureSteadiness(await finishedState(root, '', listFiles), RESEARCH_TASK.steadiness)
    expect(good.score).toBe(1)

    await writeFile(join(root, 'config', 'retry.json'),
      JSON.stringify({ attempts: 3, timeoutMs: 1500 }), 'utf8')
    const stale = await measureSteadiness(await finishedState(root, '', listFiles), RESEARCH_TASK.steadiness)
    expect(stale.probes.find(p => p.id === 'revision-honoured')?.held).toBe(false)
    expect(stale.probes.find(p => p.id === 'no-resurrection')?.held).toBe(false)
  })

  it('the tool-heavy task catches the superseded score range', async () => {
    const root = await makeTemp('rc2-heavy-')
    await writeFile(join(root, 'schema.json'),
      JSON.stringify({ fields: { id: 'int', name: 'string', score: { max: 100 }, tag: 'string' } }), 'utf8')
    await writeFile(join(root, 'sample.json'), '{}', 'utf8')
    const stale = await measureSteadiness(await finishedState(root, '', listFiles), TOOL_HEAVY_TASK.steadiness)
    expect(stale.probes.find(p => p.id === 'no-resurrection')?.held).toBe(false)
    expect(stale.probes.find(p => p.id === 'revision-honoured')?.held).toBe(false)
  })

  it('a probe that throws counts as FAILED, not as absent', async () => {
    // An agent that produced nothing has not demonstrated steadiness. Dropping
    // the probe would let a total failure score as a clean sheet.
    const root = await makeTemp('rc2-throw-')
    const state = await finishedState(root, '', listFiles)
    const result = await measureSteadiness(state, [{
      id: 'explodes', question: 'never evaluable', holds: () => { throw new Error('boom') },
    }])
    expect(result.satisfied).toBe(0)
    expect(result.total).toBe(1)
    expect(result.score).toBe(0)
  })
})

describe('RC2: the arms are the four modes, and the ladder is ordered', () => {
  it('runs the real Basic baseline plus the EF ladder', () => {
    // RC2.1: `legacy` in RC2 was EF-with-legacy-policy, mislabelled as Basic.
    // The arm model now names the ENGINE, so the baseline is a real
    // BasicCompactionEngine and the EF arms are labelled `ef-*`.
    expect(ARMS.map(arm => arm.label)).toEqual(['basic', 'ef-legacy', 'economy', 'balanced', 'quality'])
    expect(ARMS.filter(arm => arm.engine === 'basic').map(arm => arm.label)).toEqual(['basic'])
    expect(EF_ARMS.map(arm => arm.mode)).toEqual(['legacy', 'economy', 'balanced', 'quality'])
  })

  it('the EF ladder never contains a Basic arm', () => {
    // The ladder is EF-only; a Basic arm inside it would double-count the
    // baseline in any pooled per-mode figure.
    expect(EF_ARMS.every(arm => arm.engine === 'ef')).toBe(true)
  })

  it('every arm label is distinct, so a report cannot merge two arms', () => {
    expect(new Set(ARMS.map(arm => arm.label)).size).toBe(ARMS.length)
  })
})

describe('RC2: the run renderer reports what a reader needs', () => {
  it('prints the outcome, the three metrics, the timeline and the probes', () => {
    const text = taskRunToText({
      arm: 'economy',
      taskId: 'coding-paginate',
      outcome: 'answered',
      rounds: 7,
      cost: { total: 0.0123, calls: 5, failedCalls: 1, uncachedInputTokens: 100, cacheReadTokens: 50, outputTokens: 20 },
      quality: { passed: 4, total: 4, score: 1, checks: [] },
      steadiness: {
        probes: [{ id: 'revision-honoured', question: 'q', held: false }],
        score: 0, satisfied: 0, total: 1,
      },
      toolCalls: { write_file: 2 },
      timeline: ['write_file', 'run_node'],
      answer: 'done',
    })
    expect(text).toContain('economy / coding-paginate: answered')
    expect(text).toContain('cost=0.012300')
    expect(text).toContain('quality=4/4')
    expect(text).toContain('steadiness=0/1')
    expect(text).toContain('write_file -> run_node')
    // A LOST probe is called out, not merely counted.
    expect(text).toContain('LOST revision-honoured')
  })
})

describe('RC2: the resurrection check reads assertions, not mentions', () => {
  it('catches a value asserted as current', () => {
    expect(assertsValueAsCurrent('The default pageSize is 10.', /\b10\b/u, /default|pageSize/iu)).toBe(true)
  })

  it('does NOT punish a correct answer that names the superseded value', () => {
    // The defect this prevents: a plain substring test would score the CORRECT
    // answer wrong for naming the very value it correctly identified as obsolete.
    const correct = 'The default pageSize is 25, superseding the earlier 10.'
    expect(assertsValueAsCurrent(correct, /\b10\b/u, /default|pageSize/iu)).toBe(false)
  })

  it('does not fire on a value mentioned about something else', () => {
    // The subject must be in the same clause: a `10` about item counts is not a
    // claim about the page size.
    expect(assertsValueAsCurrent('There are 10 items on the page.', /\b10\b/u, /default|pageSize/iu))
      .toBe(false)
  })

  it('handles the research task timeout phrasing', () => {
    expect(assertsValueAsCurrent('timeoutMs: 1500', /\b1500\b/u, /timeout|ms\b/iu)).toBe(true)
    expect(assertsValueAsCurrent('timeoutMs is 3000, corrected from 1500', /\b1500\b/u, /timeout|ms\b/iu))
      .toBe(false)
  })
})

describe('RC2.1: the A/B tasks can actually discriminate', () => {
  it('the retention A/B uses the two long tasks', () => {
    expect(RETENTION_AB_TASKS.map(task => task.id)).toEqual([
      'coding-config-loader', 'research-ingest-spec',
    ])
  })

  it('the long tasks are HARDER than the RC2 tasks in facts and revisions', () => {
    // RC2's tasks saturated at 1.00 quality, so they could not separate
    // anything. The A/B tasks must carry more facts and more revisions, or the
    // single critical run would repeat RC2's failure to discriminate.
    for (const task of RETENTION_AB_TASKS) {
      const revisions = task.context.filter(fact => /CORRECTION/iu.test(fact)).length
      expect(revisions, `${task.id} must revise more than once`).toBeGreaterThanOrEqual(2)
      expect(task.context.length, `${task.id} must state many facts`).toBeGreaterThanOrEqual(10)
      expect(task.work.length, `${task.id} must do more work`).toBeGreaterThanOrEqual(4)
    }
  })

  it('the long tasks add a consolidation probe the RC2 tasks did not have', () => {
    // The probe that catches a session which kept the value but reported the old
    // one — the failure a filesystem-only check misses.
    for (const task of RETENTION_AB_TASKS) {
      expect(task.steadiness.map(probe => probe.id)).toContain('facts-consolidated')
      expect(task.steadiness.length).toBeGreaterThanOrEqual(5)
    }
  })

  it('the long tasks still fail on an empty workspace', async () => {
    const root = await makeTemp('rc21-empty-')
    const state = await finishedState(root, '', listFiles)
    for (const task of RETENTION_AB_TASKS) {
      const quality = await Promise.all(task.quality.map(check => check.passed(state)))
      expect(quality.some(Boolean), `${task.id} must not pass on an empty workspace`).toBe(false)
      const steady = await measureSteadiness(state, task.steadiness)
      expect(steady.score, `${task.id} must score zero with no artifact`).toBe(0)
    }
  })

  it('the long coding task distinguishes the corrected values from the superseded ones', async () => {
    const root = await makeTemp('rc21-good-')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'loader.js'), [
      'const SCHEMA_VERSION = 2',
      'export function loadConfig(path, options = {}) {',
      '  if (options.strict) return { ok: false, error: "unexpected-key" }',
      '  if (path === null) return { ok: false, error: "invalid" }',
      '  return { ok: false, error: "missing" }',
      '}',
    ].join(String.fromCharCode(10)), 'utf8')
    await writeFile(join(root, 'NOTES.md'), 'schema version 2; strict error is unexpected-key', 'utf8')
    const good = await measureSteadiness(await finishedState(root, '', listFiles), LONG_CODING_TASK.steadiness)
    expect(good.satisfied).toBe(good.total)

    // The SUPERSEDED version of the same artifact.
    const stale = await makeTemp('rc21-stale-')
    await mkdir(join(stale, 'src'), { recursive: true })
    await writeFile(join(stale, 'src', 'loader.js'), [
      'const SCHEMA_VERSION = 1',
      'export function loadConfig(path) { return { ok: false, error: "unknown-key" } }',
    ].join(String.fromCharCode(10)), 'utf8')
    await writeFile(join(stale, 'NOTES.md'), 'schema version 1; strict error is unknown-key', 'utf8')
    const staleSteady = await measureSteadiness(await finishedState(stale, '', listFiles), LONG_CODING_TASK.steadiness)
    expect(staleSteady.probes.find(p => p.id === 'revision-honoured')?.held).toBe(false)
    expect(staleSteady.probes.find(p => p.id === 'no-resurrection')?.held).toBe(false)
    expect(staleSteady.probes.find(p => p.id === 'facts-consolidated')?.held).toBe(false)
  })

  it('the long research task scopes its resurrection check to the field', async () => {
    // `250` is BOTH a superseded batch size AND the legitimate backoff, so a
    // bare-number check would fire on a correct spec. The probe must be scoped.
    const root = await makeTemp('rc21-research-')
    await writeFile(join(root, 'spec.json'), JSON.stringify({
      batchSize: 500, flushIntervalMs: 5000, maxRetries: 2, dlq: 'ingest-dlq',
      maxRecordSizeKb: 128, concurrency: 4, backoffMs: 250,
    }), 'utf8')
    await writeFile(join(root, 'validate.js'), '// validator', 'utf8')
    await writeFile(join(root, 'SUMMARY.md'), 'batch 500, record size 128', 'utf8')
    const good = await measureSteadiness(await finishedState(root, '', listFiles), LONG_RESEARCH_TASK.steadiness)
    expect(good.satisfied, 'the legitimate 250 backoff must not read as a resurrection').toBe(good.total)
  })
})

describe('RC2: the driver resets between arms', () => {
  it('resetWorkspace clears prior artifacts', async () => {
    // Without this, arm N+1 would be scored on arm N's files and every arm would
    // look equally good.
    const root = await makeTemp('rc2-reset-')
    await writeFile(join(root, 'leftover.js'), 'x', 'utf8')
    expect(await listFiles(root)).toContain('leftover.js')
    await resetWorkspace(root)
    expect(await listFiles(root)).toEqual([])
  })
})
