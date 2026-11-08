/**
 * EF-C1 WP5 — the EF Core offline baseline: B0 / Bv / E0 / E1.
 *
 * ## The four arms, and why they are four
 *
 *   B0  native Basic — the installed `@deepseek-ai/dsh-compaction-basic`
 *   Bv  EF `mode: basic` — EF's own copy of Basic, standing aside
 *   E0  EF minimal — `semanticMode: none`, `semanticContinuity: off`
 *   E1  EF rationale — `semanticMode: rationale`, `semanticContinuity: off`
 *
 * E1 is NOT Semantic Continuity Active. It adds the visible rationale call to
 * the same fold; it writes no semantic journal and commits no delta. Conflating
 * the two would make a cheap arm look like the expensive one.
 *
 * ## What is certified
 *
 * The fold policy is shared and frozen: every EF arm uses the same threshold,
 * retention and budget, so a difference in auxiliary calls is the ONLY
 * difference between E0 and E1. The test records, per arm:
 *
 *   auxiliary calls, by kind    (writer / rationale / summary)
 *   legal span                  (the frontier the fold was allowed to take)
 *   checkpoints                 (count and size)
 *   retained tokens             (post-fold context)
 *   prefix fingerprint          (the stable prefix the fold produced)
 *   archive writes              (EF bundles)
 *
 * No model is called: the adapter is scripted. These are deterministic
 * mechanism results, not product economics. The historical 1/17 cost claim is
 * NOT transferable to this configuration, and this file makes no cost claim.
 *
 * @module tests/c1-core-baseline
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import type { EpistemicFoldConfig } from '../src/config/policy.ts'
import { createHarness, conversation, foldAgent, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { makeTemp } from '../eval/tmp.ts'

/** Frozen for every arm: a fold that lands, with room for one checkpoint. */
const SHARED = {
  thresholdRatio: 0.15,
  headroomTokens: 0,
  retainTokens: 300,
  maxTokens: 3_000,
} as const

const WRITER_REPLY = [
  '<handoff>', 'A terse handoff.', '</handoff>',
  '<deltas>', '{"deltas":[]}', '</deltas>',
].join('\n')

function isWriterCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are the SEMANTIC WRITER'))
}

function isRationaleCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are acting as the RATIONALE writer'))
}

interface ArmResult {
  readonly arm: string
  readonly calls: number
  readonly writerCalls: number
  readonly rationaleCalls: number
  readonly summaryCalls: number
  readonly legalSpan: { readonly start: number; readonly end: number }
  readonly checkpoints: number
  readonly checkpointChars: number
  readonly checkpointBody: string | null
  readonly retainedTokens: number
  readonly surfaceNodes: number
  readonly prefixFingerprint: string | null
  readonly archiveWrites: number
  readonly bundled: boolean
  readonly semanticMode: string
  readonly semanticContinuity: string
}

function checkpointBody(session: SessionType): string | null {
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message !== null && isCompactCheckpointSource(message.source)) {
      return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    }
  }
  return null
}

function countCheckpoints(session: SessionType): number {
  let count = 0
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message !== null && isCompactCheckpointSource(message.source)) count += 1
  }
  return count
}

function countFiles(directory: string): number {
  if (!existsSync(directory)) return 0
  return readdirSync(directory, { recursive: true })
    .filter(name => String(name).endsWith('.json'))
    .length
}

async function measureArm(arm: string, config: EpistemicFoldConfig, basic: boolean): Promise<ArmResult> {
  const root = await makeTemp(`ef-c1-${arm}-`)
  const h: Harness = await createHarness(
    { textFor: call => (isWriterCall(call) ? WRITER_REPLY : 'digest') },
    {
      ...(basic ? { engine: 'basic' as const } : { plugin: true }),
      projection: true,
      systemPrompt: true,
      efConfig: basic
        // Native Basic validates its config and rejects EF-only keys. The
        // bundle/semantic roots belong to EF, not to the host engine.
        ? { ...config }
        : {
            bundleRoot: join(root, 'bundles'),
            semanticRoot: join(root, 'semantic'),
            ...config,
          },
    },
  )
  const session = conversation(2)
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('fixture has nothing to fold')

  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  if (!basic) await h.engine.reconcileSemantics(session)

  const calls = h.control.calls.map(call => call.options)
  const body = checkpointBody(session)
  return {
    arm,
    calls: calls.length,
    writerCalls: calls.filter(isWriterCall).length,
    rationaleCalls: calls.filter(isRationaleCall).length,
    summaryCalls: calls.filter(call => !isWriterCall(call) && !isRationaleCall(call)).length,
    legalSpan: { start, end },
    checkpoints: countCheckpoints(session),
    checkpointChars: body?.length ?? 0,
    checkpointBody: body,
    retainedTokens: h.ctx.tokenMeter.measure(session).totalTokens,
    surfaceNodes: session.surface.nodes.length,
    prefixFingerprint: body === null
      ? null
      : createHash('sha256').update(body).digest('hex'),
    archiveWrites: countFiles(join(root, 'bundles')),
    bundled: h.engine.publishedBundle !== undefined,
    semanticMode: config.semanticMode ?? 'n/a',
    semanticContinuity: config.semanticContinuity ?? 'off',
  }
}

const ARMS = {
  B0: { config: SHARED, basic: true },
  Bv: { config: { ...SHARED, mode: 'basic' as const }, basic: false },
  E0: {
    config: { ...SHARED, mode: 'quality' as const, semanticMode: 'none' as const, semanticContinuity: 'off' as const },
    basic: false,
  },
  E1: {
    config: { ...SHARED, mode: 'quality' as const, semanticMode: 'rationale' as const, semanticContinuity: 'off' as const },
    basic: false,
  },
} as const

describe('EF-C1 core baseline: B0 / Bv / E0 / E1', () => {
  it('E0 makes no auxiliary call; E1 makes exactly the rationale call', async () => {
    const e0 = await measureArm('E0', ARMS.E0.config, ARMS.E0.basic)
    const e1 = await measureArm('E1', ARMS.E1.config, ARMS.E1.basic)

    expect(e0.calls, 'E0 must be zero-LLM').toBe(0)
    expect(e1.calls, 'E1 adds exactly one call').toBe(1)
    expect(e1.rationaleCalls, 'the one call is the visible rationale call').toBe(1)
    expect(e1.writerCalls, 'E1 is not semantic continuity active: no writer call').toBe(0)
  }, 300_000)

  it('B0 and Bv are the same fold, byte for byte', async () => {
    const b0 = await measureArm('B0', ARMS.B0.config, ARMS.B0.basic)
    const bv = await measureArm('Bv', ARMS.Bv.config, ARMS.Bv.basic)

    // Vacuity guard: both arms must fold.
    expect(b0.checkpoints, 'native Basic must fold').toBe(1)
    expect(bv.checkpoints, 'EF mode:basic must fold').toBe(1)
    expect(bv.checkpointBody).toBe(b0.checkpointBody)
    expect(bv.bundled, 'mode:basic publishes no EF bundle').toBe(false)
    expect(bv.archiveWrites).toBe(0)
    // Basic's summary call is the only call either arm makes.
    expect(b0.calls).toBe(1)
    expect(bv.calls).toBe(1)
    expect(b0.rationaleCalls + bv.rationaleCalls).toBe(0)
  }, 300_000)

  it('E0 and E1 share one fold policy: same legal span, same retention, same checkpoint count', async () => {
    const e0 = await measureArm('E0', ARMS.E0.config, ARMS.E0.basic)
    const e1 = await measureArm('E1', ARMS.E1.config, ARMS.E1.basic)

    expect(e0.legalSpan).toEqual(e1.legalSpan)
    expect(e0.checkpoints).toBe(1)
    expect(e1.checkpoints).toBe(1)
    // The rationale is ADDED to the same fold; the fold itself is not re-chosen.
    expect(e1.checkpointChars).toBeGreaterThan(e0.checkpointChars)
    // Both publish an EF bundle: the archive contract is the same.
    expect(e0.bundled).toBe(true)
    expect(e1.bundled).toBe(true)
    expect(e0.archiveWrites).toBe(e1.archiveWrites)
    // Retention is a property of the fold: the same raw tail survives. The
    // token TOTAL differs because E1's checkpoint carries the rationale text,
    // which is the intervention, not a different retention policy.
    expect(e0.surfaceNodes).toBe(e1.surfaceNodes)
  }, 300_000)

  it('the four arms are recorded in one machine-readable baseline', async () => {
    const results = [
      await measureArm('B0', ARMS.B0.config, ARMS.B0.basic),
      await measureArm('Bv', ARMS.Bv.config, ARMS.Bv.basic),
      await measureArm('E0', ARMS.E0.config, ARMS.E0.basic),
      await measureArm('E1', ARMS.E1.config, ARMS.E1.basic),
    ]
    const report = {
      schemaVersion: 1,
      work: 'EF-C1',
      generator: 'tests/c1-core-baseline.spec.ts',
      generatedAt: new Date().toISOString(),
      executionKind: 'scripted adapter; deterministic mechanism measurement, not a model result',
      sharedPolicy: SHARED,
      arms: results.map(({ checkpointBody: _body, ...rest }) => rest),
      note: 'No provider was called. Token counts are prompt-side estimates, not billing.',
    }
    const out = process.env['EF_C1_BASELINE_OUT']
    if (out !== undefined) {
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'core-baseline.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
    expect(results).toHaveLength(4)
    expect(results.every(result => result.checkpoints === 1)).toBe(true)
  }, 600_000)
})
