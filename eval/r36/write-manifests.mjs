#!/usr/bin/env node
/**
 * Write the R36 condition manifests. No model request is made.
 *
 * A manifest describes the inputs to a run, not a result. The live manifests
 * are intentionally marked `blocked` because R36 has no model-spend
 * authorization in this session. The replay manifest is `ready`: it reads the
 * frozen R35 responses and makes no provider call.
 *
 * @module eval/r36/write-manifests
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, 'manifests')

const ROUTE = {
  baseUrlEnv: 'OPENCODE_BASE_URL',
  apiKeyEnv: 'OPENCODE_API_KEY',
  contextWindow: 131_072,
  maxOutputTokens: 32_768,
}

const LIMITS = {
  requests: 60,
  inputTokens: 32_000_000,
  outputTokens: 1_000_000,
  wallClockMs: 1_800_000,
}

const LARGE_LIMITS = {
  requests: 400,
  inputTokens: 200_000_000,
  outputTokens: 5_000_000,
  wallClockMs: 3_600_000,
}

const MODEL = 'deepseek-v4.1-flash'

function base(id, overrides) {
  return {
    schemaVersion: 1,
    id,
    conditionsRef: 'eval/r36/out/conditions.json',
    model: MODEL,
    provider: 'opencode',
    route: ROUTE,
    maxOutputTokens: 16_384,
    ...overrides,
  }
}

const manifests = {
  'w0-p0-replay.json': base('w0-p0-replay', {
    phase: 'A',
    execution: 'offline-replay',
    status: 'ready',
    requiresAuthorization: false,
    promptVersion: 'W0',
    parser: 'P0',
    validator: 'unchanged',
    input: 'frozen R35 writer-only raw outputs',
    script: 'eval/r36/parser-ablation.mjs',
    limits: { requests: 1, inputTokens: 1, outputTokens: 1, wallClockMs: 1 },
    maxOutputTokens: 1,
    providerRequests: 0,
    note: 'No model call. P0 is the production strict parser. The positive limits satisfy the manifest schema and are never used.',
  }),
  'w0-p1-replay.json': base('w0-p1-replay', {
    phase: 'A',
    execution: 'offline-replay',
    status: 'ready',
    requiresAuthorization: false,
    promptVersion: 'W0',
    parser: 'P1',
    validator: 'unchanged',
    input: 'frozen R35 writer-only raw outputs',
    script: 'eval/r36/parser-ablation.mjs',
    limits: { requests: 1, inputTokens: 1, outputTokens: 1, wallClockMs: 1 },
    maxOutputTokens: 1,
    providerRequests: 0,
    note: 'No model call. P1 is an eval ablation and does not commit. The positive limits satisfy the manifest schema and are never used.',
  }),
  'w1-p0-live.json': base('w1-p0-live', {
    phase: 'B',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'No explicit R36 model-spend authorization in this session.',
    requiresAuthorization: true,
    stage: 'writer-only',
    arms: 'S',
    cases: 'A1,B2,C1,D1,F1,H1',
    promptVersion: 'W1',
    parser: 'P0',
    validator: 'unchanged',
    limits: LIMITS,
    note: 'Real model calls. Compares against the same-time W0-P0 control, not only against R35.',
  }),
  'w0-p0-live-control.json': base('w0-p0-live-control', {
    phase: 'B',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'No explicit R36 model-spend authorization in this session.',
    requiresAuthorization: true,
    stage: 'writer-only',
    arms: 'S',
    cases: 'A1,B2,C1,D1,F1,H1',
    promptVersion: 'W0',
    parser: 'P0',
    validator: 'unchanged',
    limits: LIMITS,
    note: 'Same-time control for W1-P0. Do not reuse R35 numbers as if they were contemporaneous.',
  }),
  'h0-o2.json': base('h0-o2', {
    phase: 'C',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'No explicit R36 model-spend authorization in this session.',
    requiresAuthorization: true,
    stage: 'continuation',
    arms: 'O2',
    cases: 'A1,B2,C1,D1,F1,H1',
    followUpSteps: 8,
    followUpMaxTokens: 1024,
    finishGuard: false,
    harnessVersion: 'H0-custom-json-loop',
    runtime: 'custom-json-loop',
    limits: LARGE_LIMITS,
    note: 'Oracle-visible facts. The question is whether the agent can complete a certified task at all.',
  }),
  'h-step-o2.json': base('h-step-o2', {
    phase: 'C',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'No explicit R36 model-spend authorization in this session.',
    requiresAuthorization: true,
    stage: 'continuation',
    arms: 'O2',
    cases: 'A1,B2,C1,D1,F1,H1',
    followUpSteps: 16,
    followUpMaxTokens: 1024,
    finishGuard: false,
    harnessVersion: 'H0-custom-json-loop',
    runtime: 'custom-json-loop',
    limits: LARGE_LIMITS,
    note: 'Single-factor step-budget change against H0.',
  }),
  'h-output-o2.json': base('h-output-o2', {
    phase: 'C',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'No explicit R36 model-spend authorization in this session.',
    requiresAuthorization: true,
    stage: 'continuation',
    arms: 'O2',
    cases: 'A1,B2,C1,D1,F1,H1',
    followUpSteps: 8,
    followUpMaxTokens: 4096,
    finishGuard: false,
    harnessVersion: 'H0-custom-json-loop',
    runtime: 'custom-json-loop',
    limits: LARGE_LIMITS,
    note: 'Single-factor output-budget change against H0.',
  }),
  'h-finish-o2.json': base('h-finish-o2', {
    phase: 'C',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'No explicit R36 model-spend authorization in this session.',
    requiresAuthorization: true,
    stage: 'continuation',
    arms: 'O2',
    cases: 'A1,B2,C1,D1,F1,H1',
    followUpSteps: 8,
    followUpMaxTokens: 1024,
    finishGuard: true,
    harnessVersion: 'H0-custom-json-loop',
    runtime: 'custom-json-loop',
    limits: LARGE_LIMITS,
    note: 'Finish guard only. Guard-assisted success must be reported separately from unguided compliance.',
  }),
  'h-combined-o2.json': base('h-combined-o2', {
    phase: 'C',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'Exploratory condition selected after the single-factor results.',
    requiresAuthorization: true,
    stage: 'continuation',
    arms: 'O2',
    cases: 'A1,B2,C1,D1,F1,H1',
    followUpSteps: 16,
    followUpMaxTokens: 1024,
    finishGuard: true,
    harnessVersion: 'H0-custom-json-loop',
    runtime: 'custom-json-loop',
    limits: LARGE_LIMITS,
    note: 'Exploratory combination of H-step and H-finish. Not a pre-registered single-factor arm.',
  }),
  'h-native-o2.json': base('h-native-o2', {
    phase: 'C',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'The real DSH Agent/Tool Runtime is not implemented in this harness; the live runner refuses it without a request.',
    requiresAuthorization: true,
    stage: 'continuation',
    arms: 'O2',
    cases: 'A1,B2',
    followUpSteps: 8,
    followUpMaxTokens: 1024,
    finishGuard: true,
    harnessVersion: 'H-native',
    runtime: 'dsh-agent',
    limits: LARGE_LIMITS,
    note: 'Declared condition. Not executed; no result is claimed.',
  }),
  'b1-s-o1-o2-frozen.json': base('b1-s-o1-o2-frozen', {
    phase: 'D',
    execution: 'live',
    status: 'blocked',
    blockedReason: 'Writer, harness, scorer, and dataset conditions are not all frozen/passed yet; G3 is blocked.',
    requiresAuthorization: true,
    stage: 'continuation',
    arms: 'B1,S,O1,O2',
    cases: 'A1,B2,C1,D1,F1,H1',
    followUpSteps: 8,
    followUpMaxTokens: 1024,
    finishGuard: false,
    harnessVersion: 'H0-custom-json-loop',
    runtime: 'custom-json-loop',
    limits: LARGE_LIMITS,
    note: 'Draft only. Do not run until the independent writer and harness interventions have evidence.',
  }),
}

await mkdir(DIR, { recursive: true })
const EXECUTED = {
  'w0-p0-live-control.json': {
    runIds: ['r36-writer-w0-r1'],
    note: 'Executed on 2026-11-05: 2/6 protocol parsed, commit recall 0.167.',
  },
  'w1-p0-live.json': {
    runIds: ['r36-writer-w1-r1'],
    note: 'Executed on 2026-11-05: 6/6 protocol parsed, commit recall 0.917.',
  },
  'h0-o2.json': {
    runIds: ['r36-h0-o2-r1', 'r36-h0-o2-r2'],
    note: 'r1 had transport-invalid rows; r2 is the complete 6-case calibration.',
  },
  'h-step-o2.json': {
    runIds: [
      'r36-h-step-o2-r1',
      'r36-h-step-o2-A1',
      'r36-h-step-o2-B2',
      'r36-h-step-o2-C1',
      'r36-h-step-o2-C1b',
      'r36-h-step-o2-D1',
      'r36-h-step-o2-D1b',
      'r36-h-step-o2-F1',
      'r36-h-step-o2-H1',
    ],
    note: 'Split per case after transport resets; C1b/D1b are the valid reruns.',
  },
  'h-output-o2.json': {
    runIds: [
      'r36-h-output-o2-A1', 'r36-h-output-o2-B2', 'r36-h-output-o2-C1',
      'r36-h-output-o2-D1', 'r36-h-output-o2-F1', 'r36-h-output-o2-H1',
    ],
    note: 'Executed per case on 2026-11-05.',
  },
  'h-finish-o2.json': {
    runIds: [
      'r36-h-finish-o2-A1', 'r36-h-finish-o2-B2', 'r36-h-finish-o2-C1',
      'r36-h-finish-o2-D1', 'r36-h-finish-o2-F1', 'r36-h-finish-o2-H1',
    ],
    note: 'Executed per case; the guard fired once (D1) and did not by itself produce a contract success.',
  },
  'h-combined-o2.json': {
    runIds: [
      'r36-h-combined-o2-A1', 'r36-h-combined-o2-B2', 'r36-h-combined-o2-C1',
      'r36-h-combined-o2-D1', 'r36-h-combined-o2-F1', 'r36-h-combined-o2-H1',
    ],
    note: 'Exploratory 16-step + guard condition: 4/6 task, 3/6 contract success.',
  },
}
for (const [name, record] of Object.entries(EXECUTED)) {
  const manifest = manifests[name]
  manifest.status = 'executed'
  manifest.runIds = record.runIds
  manifest.executedAt = '2026-11-05'
  manifest.executionNote = record.note
  delete manifest.blockedReason
}
manifests['b1-s-o1-o2-frozen.json'].blockedReason =
  'Authorized, but not run: the O2 calibration floor is not stable (best 3/6 contract success). '
  + 'A B1/S comparison would be dominated by A1/C1 code failures and B2 test omission.'

for (const [name, manifest] of Object.entries(manifests)) {
  await writeFile(join(DIR, name), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}
process.stdout.write(`wrote ${Object.keys(manifests).length} manifests to ${DIR}\n`)
for (const [name, manifest] of Object.entries(manifests)) {
  process.stdout.write(`  ${name}: ${manifest.status} (${manifest.execution})\n`)
}
