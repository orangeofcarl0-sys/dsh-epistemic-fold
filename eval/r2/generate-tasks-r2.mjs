#!/usr/bin/env node
/**
 * EF-R2 WP6 — the next confirmation set, authored offline.
 *
 * Six action-diverse archetypes, two fresh instances each. None of them is a
 * T7-T10 rerun under a new id: each has its own workspace, its own folded
 * facts, and a checker that reads the workspace rather than the transcript.
 *
 * The output is NOT executed. `eval/e2e/tasks-r2/` is certified offline by the
 * same checker used for the original set; a live run needs a new, explicit
 * model-call authorization.
 *
 *   node eval/r2/generate-tasks-r2.mjs
 *
 * @module eval/r2/generate-tasks-r2
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(ROOT, 'eval', 'e2e', 'tasks-r2')

function prng(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

const hex = (random, length) => {
  let out = ''
  for (let index = 0; index < length; index += 1) out += '0123456789abcdef'[Math.floor(random() * 16)]
  return out
}

/**
 * A long, plausible service log. `facts` are inserted at roughly one third so
 * they are inside the first span a fold is likely to archive.
 */
function serviceLog({ seed, lines = 650, facts = [], start = Date.UTC(2026, 9, 14, 9, 0, 0) }) {
  const random = prng(seed)
  const rows = []
  let at = start
  const factAt = Math.max(1, Math.floor(lines / 3))
  for (let index = 0; index < lines; index += 1) {
    at += 900 + Math.floor(random() * 30_000)
    if (index === factAt) rows.push(...facts)
    const status = random() < 0.04 ? 503 : 200
    rows.push(
      `${new Date(at).toISOString()} ${status === 200 ? 'INFO ' : 'ERROR'} [gateway] request `
      + `id=${hex(random, 8)} upstream=api-${1 + Math.floor(random() * 9)} status=${status} `
      + `latency_ms=${10 + Math.floor(random() * 900)} bytes=${100 + Math.floor(random() * 9000)}`,
    )
  }
  return rows.join('\n')
}

function task({
  id,
  template,
  seed,
  category,
  title,
  workspace,
  history,
  stageB,
  prompt,
  taskB,
  reference,
  counterfactual,
  checks,
  requires,
}) {
  return {
    schemaVersion: 1,
    id,
    template,
    seed,
    category,
    title,
    operationalBudgetTokens: 16_384,
    thresholdRatio: 0.5,
    seededHistory: true,
    workspace,
    history,
    ...(stageB === undefined ? {} : { stageB }),
    task: prompt,
    ...(taskB === undefined ? {} : { taskB }),
    reference,
    counterfactual,
    checks,
    ...(requires === undefined ? {} : { requires }),
    gold: { note: 'Facts exist only in the seeded history; the workspace does not contain them.' },
  }
}

const packageJson = name => `{\n  "name": "${name}",\n  "type": "module",\n  "private": true\n}\n`

function historicalTest(seed) {
  const failures = seed === 1 ? 3 : 5
  const suiteId = seed === 1 ? 'retry-suite-a' : 'retry-suite-b'
  const log = serviceLog({
    seed: 1100 + seed,
    facts: [
      `2026-10-14T09:12:04.318Z INFO  [retry-suite] suite=${suiteId} run=baseline total=9 failed=${failures}`,
      '2026-10-14T09:12:04.319Z ERROR [retry] test "batch path caps attempts" expected 2 received 5',
      '2026-10-14T09:12:04.320Z ERROR [retry] test "general path stays at 5" expected 5 received 5',
      `2026-10-14T09:12:04.321Z INFO  [retry-suite] summary: # fail ${failures}`,
    ],
  })
  // A second long observation AFTER the baseline run. It is not needed for the
  // answer; it keeps the retained tail long enough that the first run is the
  // span a fold selects. One long log alone is retained verbatim.
  const lateLog = serviceLog({
    seed: 1100 + seed + 20,
    lines: 320,
    start: Date.UTC(2026, 9, 15, 9, 0, 0),
  })
  const failingSource = `export function attemptsFor(path) {\n  return 5\n}\n`
  const fixedSource = `export function attemptsFor(path) {\n  return path === 'batch' ? 2 : 5\n}\n`
  const testFile = `import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { attemptsFor } from '../src/retry.js'\n\ntest('batch path caps at 2', () => {\n  assert.equal(attemptsFor('batch'), 2)\n})\n\ntest('general path stays at 5', () => {\n  assert.equal(attemptsFor('general'), 5)\n})\n`
  return task({
    id: `T11-s${seed}`,
    template: 'T11',
    seed,
    category: 'historical-test',
    title: 'Fix the retry cap from the pre-change test run',
    workspace: {
      'package.json': packageJson('retry-fix'),
      'src/retry.js': failingSource,
      'test/retry.test.js': testFile,
      'README.md': '# Retry fix\n\nThe suite failed before any change. The baseline failure count is in the folded run, not in this workspace. Fix the batch path and write `result.json` with `{"failed": <pre-change count>}`.\n',
    },
    history: [
      { role: 'user', text: 'Run the retry suite BEFORE changing anything and report the failure count from that run for the incident review.' },
      { role: 'assistant', text: 'Running the pre-change suite now; the count must come from this baseline run.' },
      { role: 'tool', name: 'run_tests', arguments: '{}', text: log },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/retry-late.log"}', text: lateLog },
      { role: 'user', text: 'The batch path must cap at two attempts. The general path stays at five.' },
      { role: 'assistant', text: 'Understood: batch caps at two, general remains five. I will fix the source and write the pre-change count.' },
    ],
    prompt: 'Fix the batch retry cap, run the suite, and write `result.json` with `{"failed": <the failure count from the pre-change run>}`.',
    reference: {
      'src/retry.js': fixedSource,
      'result.json': `${JSON.stringify({ failed: failures }, null, 2)}\n`,
    },
    counterfactual: {
      'src/retry.js': failingSource,
      'result.json': `${JSON.stringify({ failed: failures + 2 }, null, 2)}\n`,
    },
    checks: [
      { kind: 'tests' },
      { kind: 'json_equals', path: 'result.json', value: { failed: failures } },
    ],
  })
}

function revisedConstraint(seed) {
  const baseline = 5
  const revised = seed === 1 ? 2 : 3
  const log = serviceLog({
    seed: 1200 + seed,
    facts: [
      `2026-10-10T08:00:00.000Z INFO  [spec] retry.max_attempts=${baseline} scope=all-jobs`,
      '2026-10-10T08:00:01.000Z INFO  [spec] revision=1 status=active',
    ],
  })
  const lateLog = serviceLog({ seed: 1200 + seed + 20, lines: 320, start: Date.UTC(2026, 9, 15, 8, 0, 0) })
  return task({
    id: `T12-s${seed}`,
    template: 'T12',
    seed,
    category: 'revised-constraint',
    title: 'Apply the latest batch retry revision',
    workspace: {
      'README.md': '# Retry policy\n\nThe baseline spec is in the folded history. A later user revision applies to the batch path only. Write `config.json` with `{"batch": <latest>, "general": <baseline>}`.\n',
    },
    history: [
      { role: 'user', text: 'The platform spec says a batch job may attempt five times. That is the baseline.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/policy.log"}', text: log },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/policy-late.log"}', text: lateLog },
      { role: 'assistant', text: 'Recorded the baseline: max_attempts=5 for all jobs.' },
      { role: 'user', text: `Revision for the batch path only: cap it at ${revised} attempts. Five caused the retry storm. This revision supersedes the spec for batch jobs.` },
      { role: 'assistant', text: `Acknowledged: batch path max_attempts=${revised}; general path stays at ${baseline}.` },
    ],
    prompt: 'Write `config.json` with the latest effective `batch` and `general` max-attempt values.',
    reference: {
      'config.json': `${JSON.stringify({ batch: revised, general: baseline }, null, 2)}\n`,
    },
    counterfactual: {
      'config.json': `${JSON.stringify({ batch: baseline, general: baseline }, null, 2)}\n`,
    },
    checks: [{ kind: 'json_equals', path: 'config.json', value: { batch: revised, general: baseline } }],
  })
}

function toolEvidence(seed) {
  const build = seed === 1 ? '7f3c9a1e' : 'c41d08b7'
  const channel = seed === 1 ? 'beta' : 'canary'
  const signer = seed === 1 ? 'ops-key-a' : 'ops-key-b'
  const manifestLog = serviceLog({
    seed: 1300 + seed,
    facts: [
      `2026-10-12T04:00:00.000Z INFO  [manifest] channel=${channel} build=${build} signer=${signer}`,
      '2026-10-12T04:00:01.000Z INFO  [manifest] schema=2 status=published',
    ],
  })
  const rotated = serviceLog({ seed: 1300 + seed + 50, lines: 240, start: Date.UTC(2026, 9, 16, 4, 0, 0) })
  return task({
    id: `T13-s${seed}`,
    template: 'T13',
    seed,
    category: 'historical-tool-evidence',
    title: 'Recover the published build from the rotated manifest',
    workspace: {
      'README.md': '# Build record\n\nThe manifest was rotated away. The published `channel` and `build` are in the earlier folded tool result. Write `build.json`.\n',
    },
    history: [
      { role: 'user', text: 'Read the build manifest and tell me the published channel and build id.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/build-manifest.log"}', text: manifestLog },
      { role: 'assistant', text: 'The manifest was published; I have the channel and build id from that read.' },
      { role: 'user', text: 'The file is rotated now. I still need the channel and build from the version you read before the rotation.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/build-manifest-late.log"}', text: rotated },
    ],
    prompt: 'Write `build.json` with the `channel` and `build` from the manifest read before the rotation.',
    reference: { 'build.json': `${JSON.stringify({ channel, build }, null, 2)}\n` },
    counterfactual: { 'build.json': `${JSON.stringify({ channel: 'stable', build: '00000000' }, null, 2)}\n` },
    checks: [{ kind: 'json_equals', path: 'build.json', value: { channel, build } }],
  })
}

function longMultiStep(seed) {
  const initial = 10
  const rejected = 8
  const corrected = seed === 1 ? 4 : 6
  const log = serviceLog({
    seed: 1400 + seed,
    facts: [
      `2026-10-13T11:00:00.000Z INFO  [capacity] limit=${initial} review=baseline`,
      `2026-10-13T15:00:00.000Z WARN  [capacity] limit=${rejected} review=rejected capacity_headroom=0`,
    ],
  })
  const lateLog = serviceLog({ seed: 1400 + seed + 20, lines: 320, start: Date.UTC(2026, 9, 15, 11, 0, 0) })
  return task({
    id: `T14-s${seed}`,
    template: 'T14',
    seed,
    category: 'long-multi-step',
    title: 'Apply the corrected capacity limit',
    workspace: {
      'package.json': packageJson('limit-fix'),
      'src/limit.js': `export const LIMIT = ${initial}\n`,
      'test/limit.test.js': `import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { LIMIT } from '../src/limit.js'\n\ntest('the capacity limit is the corrected value', () => {\n  assert.equal(LIMIT, ${corrected})\n})\n`,
      'README.md': '# Capacity limit\n\nThe first revision was rejected. Apply the later correction from the folded history, then run the tests.\n',
    },
    history: [
      { role: 'user', text: `First set the limit to ${rejected}.` },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/capacity.log"}', text: log },
      { role: 'assistant', text: `Setting the limit to ${rejected}.` },
      { role: 'user', text: `Correction: use ${corrected}, not ${rejected}. ${rejected} was rejected by the capacity review.` },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/capacity-late.log"}', text: lateLog },
      { role: 'assistant', text: `Understood: the corrected limit is ${corrected}; the earlier ${rejected} is rejected.` },
    ],
    prompt: 'Apply the corrected capacity limit and run the tests.',
    reference: { 'src/limit.js': `export const LIMIT = ${corrected}\n` },
    counterfactual: { 'src/limit.js': `export const LIMIT = ${rejected}\n` },
    checks: [
      { kind: 'tests' },
      { kind: 'file_contains', path: 'src/limit.js', needle: `LIMIT = ${corrected}` },
    ],
  })
}

function timeVersion(seed) {
  const revisions = seed === 1
    ? [{ day: '10', value: 4 }, { day: '14', value: 6 }, { day: '18', value: 9 }]
    : [{ day: '10', value: 3 }, { day: '14', value: 7 }, { day: '18', value: 8 }]
  const effective = revisions[1].value
  const later = revisions[2].value
  const log = serviceLog({
    seed: 1500 + seed,
    facts: revisions.map(revision =>
      `2026-10-${revision.day}T00:00:00.000Z INFO  [config] concurrency=${revision.value} status=active`),
    start: Date.UTC(2026, 9, 9, 0, 0, 0),
  })
  const lateLog = serviceLog({ seed: 1500 + seed + 20, lines: 320, start: Date.UTC(2026, 9, 16, 0, 0, 0) })
  return task({
    id: `T15-s${seed}`,
    template: 'T15',
    seed,
    category: 'time-version',
    title: 'Select the concurrency in force at the review time',
    workspace: {
      'README.md': '# Effective configuration\n\nThe concurrency changed three times. Write `effective.json` with the value in force at `2026-10-15T00:00:00Z`.\n',
    },
    history: [
      { role: 'user', text: 'The platform had several concurrency revisions this month. Do not guess; use the timestamps.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/config-history.log"}', text: log },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/config-late.log"}', text: lateLog },
      { role: 'assistant', text: 'The history has three active concurrency values with their timestamps.' },
    ],
    prompt: 'Write `effective.json` with the `concurrency` in force at `2026-10-15T00:00:00Z`.',
    reference: { 'effective.json': `${JSON.stringify({ concurrency: effective }, null, 2)}\n` },
    counterfactual: { 'effective.json': `${JSON.stringify({ concurrency: later }, null, 2)}\n` },
    checks: [{ kind: 'json_equals', path: 'effective.json', value: { concurrency: effective } }],
  })
}

function multiCompaction(seed) {
  const release = seed === 1 ? 'rel-4c1' : 'rel-9a2'
  const checksum = seed === 1 ? 'a4f9c2e1' : 'd7b3e8f0'
  const first = serviceLog({
    seed: 1600 + seed,
    facts: [
      `2026-10-11T02:00:00.000Z INFO  [release] id=${release} checksum=${checksum} status=published`,
      '2026-10-11T02:00:01.000Z INFO  [release] channel=production',
    ],
  })
  const second = serviceLog({ seed: 1600 + seed + 10, start: Date.UTC(2026, 9, 12, 2, 0, 0) })
  const stageLog = serviceLog({ seed: 1600 + seed + 20, lines: 420, start: Date.UTC(2026, 9, 13, 2, 0, 0) })
  return task({
    id: `T16-s${seed}`,
    template: 'T16',
    seed,
    category: 'multi-compaction',
    title: 'Recover the release id after two folds',
    workspace: {
      'README.md': '# Release record\n\nThe release id and checksum are in the earliest deployment log. A second stage adds more logs, so the continuation needs a second fold. Write `release.json`.\n',
    },
    history: [
      { role: 'user', text: 'Read the first deployment log and the follow-up log. I need the release id and checksum for the postmortem.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/deploy-early.log"}', text: first },
      { role: 'assistant', text: 'I have the published release id and checksum from the early log.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/deploy-late.log"}', text: second },
      { role: 'assistant', text: 'The later log adds no new release id; the early published values stand.' },
    ],
    stageB: [
      { role: 'user', text: 'The deploy window moved and another log arrived. Read it before you write the record.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/deploy-stage.log"}', text: stageLog },
      { role: 'user', text: 'Write `release.json` with the `release` id and `checksum` from the earliest deployment log.' },
    ],
    prompt: 'Read the deployment logs and keep the published release id and checksum for the record.',
    taskB: 'Stage 2: write `release.json` with the `release` id and `checksum` from the earliest deployment log.',
    reference: { 'release.json': `${JSON.stringify({ release, checksum }, null, 2)}\n` },
    counterfactual: { 'release.json': `${JSON.stringify({ release: 'rel-000', checksum: '00000000' }, null, 2)}\n` },
    checks: [{ kind: 'json_equals', path: 'release.json', value: { release, checksum } }],
    requires: { minCompactions: 2 },
  })
}

const tasks = []
for (const seed of [1, 2]) {
  tasks.push(historicalTest(seed))
  tasks.push(revisedConstraint(seed))
  tasks.push(toolEvidence(seed))
  tasks.push(longMultiStep(seed))
  tasks.push(timeVersion(seed))
  tasks.push(multiCompaction(seed))
}

await mkdir(OUT, { recursive: true })
for (const entry of tasks) {
  await writeFile(join(OUT, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
}
process.stdout.write(`wrote ${tasks.length} tasks to ${OUT.replace(/\\/gu, '/')}\n`)
for (const entry of tasks) {
  const chars = entry.history.reduce((sum, item) => sum + (item.text?.length ?? 0), 0)
  process.stdout.write(`  ${entry.id} ${entry.category} historyChars=${chars}\n`)
}
