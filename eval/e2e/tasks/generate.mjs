#!/usr/bin/env node
/**
 * Generate the twelve frozen task instances (six templates × two seeds).
 *
 * The output is checked in. This script exists so the instances are
 * reproducible and their differences are auditable: the templates are here,
 * the values vary by seed, and nothing is hand-edited afterwards.
 *
 * ## What a task file is
 *
 *   workspace       files materialized for the agent (the ONLY readable state)
 *   history         SEEDED session entries, replayed as a real DSH log
 *   task            the continuation message after the fold
 *   reference       files that make every check pass (certified offline)
 *   counterfactual  files that look plausible and fail at least one check
 *   checks          workspace claims, never transcript claims
 *   gold            analysis-only facts; never materialized
 *
 * @module eval/e2e/tasks/generate
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

/** Deterministic 32-bit PRNG: the same seed always produces the same files. */
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

function pick(random, values) {
  return values[Math.floor(random() * values.length)]
}

function hex(random, length) {
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += '0123456789abcdef'[Math.floor(random() * 16)]
  }
  return out
}

/** A service log long enough to be real context, with facts embedded. */
function serviceLog({ seed, count, lines }) {
  const random = prng(seed)
  const rows = []
  let at = Date.UTC(2026, 9, 14, 9, 12, 4, 318)
  for (let index = 0; index < count; index += 1) {
    at += 1_000 + Math.floor(random() * 40_000)
    const stamp = new Date(at).toISOString()
    rows.push(lines(random, index, stamp))
  }
  return rows.join('\n')
}

const T1 = {
  id: 'T1',
  category: 'implementation',
  title: 'Finish the excerpt truncation fix',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace(seed) {
    return {
      'package.json': '{\n  "name": "excerpt-service",\n  "type": "module",\n  "private": true\n}\n',
      'src/text.js': `/**
 * Excerpt helpers for the activity feed.
 */

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
}

export function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}
`,
      'test/text.test.js': `import assert from 'node:assert/strict'
import test from 'node:test'
import { slugify, truncate } from '../src/text.js'

test('slugify joins words with one dash', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
})

test('short text is unchanged', () => {
  assert.equal(truncate('abc', 5), 'abc')
})

test('the result never exceeds max, ellipsis included', () => {
  assert.equal(truncate('abcdef', 4).length <= 4, true)
})

test('a surrogate pair is never split', () => {
  const text = 'a😀b'
  const out = truncate(text, 2)
  assert.equal(out, 'a…')
  assert.equal(out.includes('\\uD83D'), false)
})
`,
    }
  },
  reference(seed) {
    return {
      'src/text.js': `/**
 * Excerpt helpers for the activity feed.
 */

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
}

export function truncate(text, max) {
  if (max <= 0) return ''
  if (text.length <= max) return text
  let cut = max - 1
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return text.slice(0, cut) + '…'
}
`,
    }
  },
  counterfactual() {
    return {
      'src/text.js': `export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
}

export function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}
`,
    }
  },
  checks: [
    { kind: 'tests' },
    { kind: 'external_script', path: 'eval/e2e/checkers/T1.mjs' },
  ],
  history(seed) {
    const random = prng(seed * 101)
    const build = hex(random, 8)
    const log = serviceLog({
      seed: seed * 7,
      count: 450,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [feed] excerpt batch=${hex(r, 6)} items=${10 + Math.floor(r() * 90)} truncated=${Math.floor(r() * 9)}`,
        `${stamp} WARN  [feed] excerpt retry batch=${hex(r, 6)} reason=length_overflow attempt=${1 + Math.floor(r() * 3)}`,
        `${stamp} INFO  [feed] render card=${hex(r, 8)} glyphs=${20 + Math.floor(r() * 300)} bytes=${100 + Math.floor(r() * 900)}`,
        `${stamp} DEBUG [feed] cache hit=${r() > 0.4} key=excerpt:${hex(r, 10)}`,
        `${stamp} INFO  [feed] worker=${1 + (i % 4)} queue=${Math.floor(r() * 40)} drained=${Math.floor(r() * 12)}`,
      ]),
    })
    return [
      { role: 'user', text: `The activity feed is cutting emoji in half. The excerpt helper is in src/text.js. We ship build ${build}. I want the fix finished today, not another investigation.` },
      { role: 'assistant', text: 'I will read the helper and its tests first, then fix the truncation boundary. The rule I am working to: the returned string must never exceed max, and it must never split a UTF-16 surrogate pair. The ellipsis counts toward max.' },
      // The long log is EARLY on purpose. A history whose only large content is
      // the most recent tool result leaves Basic almost nothing it may fold
      // (it retains the recent tail), so its summary is larger than the
      // foldable span and it refuses every compaction. Real long tasks
      // accumulate large evidence throughout, and the seed must do the same.
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/feed.log"}', text: log },
      { role: 'tool', name: 'read_file', arguments: '{"path":"src/text.js"}', text: 'export function truncate(text, max) {\n  if (text.length <= max) return text\n  return text.slice(0, max) + "…"\n}\n' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"test/text.test.js"}', text: 'test("the result never exceeds max, ellipsis included", ...)\ntest("a surrogate pair is never split", ...)\n' },
      { role: 'assistant', text: `The failures are consistent with a boundary bug, not a rendering bug: build ${build} logs length_overflow retries whenever a card ends on an emoji. I have the helper and the failing assertions in context. Next step is the edit, then node --test.` },
      // A LATE large block. Basic retains the recent tail by TOKENS: if the
      // only large content is early, it becomes the retention boundary and
      // almost nothing before it is foldable. Real long tasks keep producing
      // evidence, so the seed does too.
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/feed-late.log"}', text: serviceLog({ seed: seed * 71, count: 320, lines: (r, i, stamp) => `${stamp} INFO  [feed] window=${i} batch=${hex(r, 6)} items=${10 + Math.floor(r() * 90)} truncated=${Math.floor(r() * 9)} glyphs=${20 + Math.floor(r() * 300)}` }) },
      { role: 'user', text: 'Continue. Run the tests yourself and only report what they actually say.' },
    ]
  },
  task: 'Continue the excerpt fix in src/text.js. Run `node --test` and make every test pass. When it passes, reply with a short summary and no further tool calls.',
  gold: { rule: 'result length <= max; no split surrogate pair; ellipsis counts' },
}

const T2 = {
  id: 'T2',
  category: 'exact-recall',
  title: 'Record the incident build and timeout exactly',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace() {
    return {
      'package.json': '{\n  "name": "incident-record",\n  "type": "module",\n  "private": true\n}\n',
      'README.md': '# Incident record\n\nThe rotated incident log is no longer in this workspace. Write `answer.json` with the two values the reviewer asked for: `build` and `timeout_ms`.\n',
    }
  },
  reference(seed) {
    const values = seed === 1
      ? { build: '7f3c9a1e', timeout_ms: 1847 }
      : { build: 'c41d08b7', timeout_ms: 2311 }
    return { 'answer.json': `${JSON.stringify(values, null, 2)}\n` }
  },
  counterfactual(seed) {
    const values = seed === 1
      ? { build: '7f3c9a1e', timeout_ms: 1800 }
      : { build: 'c41d08b7', timeout_ms: 2300 }
    return { 'answer.json': `${JSON.stringify(values, null, 2)}\n` }
  },
  checks: [
    { kind: 'json_equals', path: 'answer.json', value: seed => seed === 1
      ? { build: '7f3c9a1e', timeout_ms: 1847 }
      : { build: 'c41d08b7', timeout_ms: 2311 } },
  ],
  history(seed) {
    const values = seed === 1
      ? { build: '7f3c9a1e', timeout_ms: 1847 }
      : { build: 'c41d08b7', timeout_ms: 2311 }
    const log = [
      '2026-10-11T02:14:03.001Z INFO  [gateway] boot build=' + values.build + ' pid=4821',
      '2026-10-11T02:14:03.004Z INFO  [gateway] config retry_timeout_ms=' + values.timeout_ms,
      ...serviceLog({
        seed: seed * 13,
        count: 460,
        lines: (r, i, stamp) => pick(r, [
          `${stamp} INFO  [gateway] request id=${hex(r, 10)} route=/v1/items status=200 ms=${10 + Math.floor(r() * 400)}`,
          `${stamp} WARN  [gateway] upstream slow id=${hex(r, 10)} ms=${values.timeout_ms + Math.floor(r() * 50)} retry=1`,
          `${stamp} INFO  [gateway] retry id=${hex(r, 10)} attempt=${1 + Math.floor(r() * 3)} budget_ms=${values.timeout_ms}`,
          `${stamp} DEBUG [gateway] pool active=${Math.floor(r() * 32)} idle=${Math.floor(r() * 8)}`,
          `${stamp} INFO  [gateway] health ok=${r() > 0.05}`,
        ]),
      }),
      '2026-10-11T02:19:41.552Z INFO  [gateway] shutdown build=' + values.build + ' reason=deploy',
    ].join('\n')
    return [
      { role: 'user', text: 'Read the gateway log from the incident window. I need the exact build id and the retry timeout that was live, for the postmortem. Do not round anything.' },
      { role: 'assistant', text: 'Reading the log now. I will take the values from the boot line and the config line, not from the summary at the end.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/gateway-2026-10-11.log"}', text: log },
      { role: 'assistant', text: `The boot line says build=${values.build}. The config line says retry_timeout_ms=${values.timeout_ms}. The later retry lines reuse the same budget, which is consistent. I will record both verbatim.` },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/gateway-late.log"}', text: serviceLog({ seed: seed * 73, count: 340, lines: (r, i, stamp) => `${stamp} INFO  [gateway] request id=${hex(r, 10)} route=/v1/items status=${r() > 0.1 ? 200 : 503} ms=${10 + Math.floor(r() * 400)} pool=${Math.floor(r() * 32)}` }) },
      { role: 'user', text: 'The log has been rotated out of the workspace for retention reasons. Write answer.json with the build and timeout_ms you just read. If you do not have them, say so instead of guessing.' },
    ]
  },
  task: 'Write `answer.json` with exactly two fields: `build` (string) and `timeout_ms` (number), using the values from the incident log you inspected. The log is no longer available. Then reply with the values and no further tool calls.',
  gold: { note: 'values exist only in the seeded tool observation' },
}

const T3 = {
  id: 'T3',
  category: 'decision-revision',
  title: 'Follow the revised cache decision',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace() {
    return {
      'package.json': '{\n  "name": "cache-service",\n  "type": "module",\n  "private": true\n}\n',
      'src/cache.js': `/**
 * Session cache. The first design used a Map.
 */
export function createCache() {
  const store = new Map()
  return {
    set(key, value) { store.set(key, value) },
    get(key) { return store.get(key) },
    snapshot() { return store },
  }
}
`,
      'test/cache.test.js': `import assert from 'node:assert/strict'
import test from 'node:test'
import { createCache } from '../src/cache.js'

test('stores and reads a value', () => {
  const cache = createCache()
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
})

test('snapshot survives JSON serialization', () => {
  const cache = createCache()
  cache.set('a', 1)
  const round = JSON.parse(JSON.stringify(cache.snapshot()))
  assert.deepEqual(round, { a: 1 })
})
`,
    }
  },
  reference() {
    return {
      'src/cache.js': `/**
 * Session cache. Plain object by the final decision: it must serialize.
 */
export function createCache() {
  let store = Object.create(null)
  return {
    set(key, value) { store[key] = value },
    get(key) { return store[key] },
    snapshot() { return { ...store } },
  }
}
`,
    }
  },
  counterfactual() {
    return {
      'src/cache.js': `/**
 * Session cache. Keeps the Map and adds a serializer.
 */
export function createCache() {
  const store = new Map()
  return {
    set(key, value) { store.set(key, value) },
    get(key) { return store.get(key) },
    snapshot() {
      const out = {}
      for (const [key, value] of store) out[key] = value
      return out
    },
  }
}
`,
    }
  },
  checks: [
    { kind: 'tests' },
    { kind: 'file_not_contains', path: 'src/cache.js', needle: 'new Map(' },
    { kind: 'external_script', path: 'eval/e2e/checkers/T3.mjs' },
  ],
  history(seed) {
    const log = serviceLog({
      seed: seed * 17,
      count: 500,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [cache] set key=session:${hex(r, 8)} bytes=${20 + Math.floor(r() * 400)}`,
        `${stamp} INFO  [cache] persist snapshot bytes=${200 + Math.floor(r() * 2000)} ok=${r() > 0.1}`,
        `${stamp} WARN  [cache] serialize empty snapshot keys=${Math.floor(r() * 5)}`,
        `${stamp} DEBUG [cache] evict key=session:${hex(r, 8)} age_s=${Math.floor(r() * 900)}`,
      ]),
    })
    return [
      { role: 'user', text: 'Use a Map for the cache. It is faster for the hot path and we do not need to serialize it today.' },
      { role: 'assistant', text: 'Implemented with a Map. set/get are O(1), snapshot returns the Map itself.' },
      // The log is early so the fold has a real span to summarize; the
      // REVISION stays in the recent tail, because recalling it is the task.
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/cache.log"}', text: log },
      { role: 'user', text: 'Correction, and this supersedes the Map instruction: the cache must survive JSON.stringify for the persistence layer. Do not use a Map anywhere in src/cache.js. Use a plain object, and snapshot must return a plain object.' },
      { role: 'assistant', text: 'Understood. The final decision is a plain object. The current src/cache.js is still the Map version, so it will fail the serialization test until I revise it.' },
      { role: 'assistant', text: 'The persistence failures in the log are all empty snapshots, which is what a Map serializes to. That is consistent with the revision.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/cache-late.log"}', text: serviceLog({ seed: seed * 79, count: 330, lines: (r, i, stamp) => `${stamp} INFO  [cache] persist key=session:${hex(r, 8)} bytes=${200 + Math.floor(r() * 2000)} ok=${r() > 0.1} mode=${r() > 0.5 ? 'json' : 'memory'}` }) },
      { role: 'user', text: 'Finish it per the final decision. Run the tests.' },
    ]
  },
  task: 'Finish `src/cache.js` according to our final decision. Run `node --test` and make every test pass. Then reply with a short summary and no further tool calls.',
  gold: { decision: 'plain object, no Map, snapshot returns a plain object' },
}

const T4 = {
  id: 'T4',
  category: 'tool-dependency',
  title: 'Use the observed deploy values, not the decoy',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace() {
    return {
      'package.json': '{\n  "name": "deploy-plan",\n  "type": "module",\n  "private": true\n}\n',
      'config/deploy.json': '{\n  "region": "us-east-1",\n  "replicas": 5,\n  "release": "stable",\n  "_note": "migration decoy; not the observed config"\n}\n',
      'README.md': '# Deploy plan\n\nWrite `deploy.plan.json` with the region and replica count you actually observed in the pre-rotation config.\n',
    }
  },
  reference(seed) {
    const values = seed === 1
      ? { region: 'eu-west-3', replicas: 3 }
      : { region: 'ap-south-1', replicas: 4 }
    return { 'deploy.plan.json': `${JSON.stringify(values, null, 2)}\n` }
  },
  counterfactual() {
    return { 'deploy.plan.json': '{\n  "region": "us-east-1",\n  "replicas": 5\n}\n' }
  },
  checks: [
    { kind: 'json_equals', path: 'deploy.plan.json', value: seed => seed === 1
      ? { region: 'eu-west-3', replicas: 3 }
      : { region: 'ap-south-1', replicas: 4 } },
  ],
  history(seed) {
    const values = seed === 1
      ? { region: 'eu-west-3', replicas: 3 }
      : { region: 'ap-south-1', replicas: 4 }
    const log = serviceLog({
      seed: seed * 19,
      count: 480,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [deploy] reconcile region=${values.region} replicas=${values.replicas} ready=${values.replicas}`,
        `${stamp} INFO  [deploy] rollout step=${1 + Math.floor(r() * 5)} healthy=${values.replicas}`,
        `${stamp} WARN  [deploy] node drain region=${values.region} id=${hex(r, 6)}`,
        `${stamp} DEBUG [deploy] quota region=${values.region} used=${Math.floor(r() * 40)}`,
      ]),
    })
    return [
      { role: 'user', text: 'Read config/deploy.json and tell me the live region and replica count before we plan the migration.' },
      { role: 'assistant', text: 'I will check the deploy log first, then read the live config.' },
      // The long log is early and the observed config follows it, so the
      // OBSERVATION is inside the foldable span rather than in the retained
      // tail. That is what makes this task a test of the fold.
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/deploy.log"}', text: log },
      { role: 'tool', name: 'read_file', arguments: '{"path":"config/deploy.json"}', text: `{\n  "region": "${values.region}",\n  "replicas": ${values.replicas},\n  "release": "canary"\n}` },
      { role: 'assistant', text: `Observed region=${values.region}, replicas=${values.replicas}, release=canary.` },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/deploy-late.log"}', text: serviceLog({ seed: seed * 83, count: 340, lines: (r, i, stamp) => `${stamp} INFO  [deploy] reconcile region=${values.region} step=${i} ready=${values.replicas} nodes=${Math.floor(r() * 12)}` }) },
      { role: 'user', text: 'The config file was rotated after you read it. The copy now in the workspace is a migration decoy, not the config you observed. Write deploy.plan.json from the values you actually saw, and do not use the decoy.' },
    ]
  },
  task: 'Write `deploy.plan.json` with exactly `region` and `replicas` from the pre-rotation config you inspected. Do not read or copy the decoy. Then reply with the values and no further tool calls.',
  gold: { note: 'observed values exist only in the seeded tool result' },
}

const T5 = {
  id: 'T5',
  category: 'multi-fold',
  title: 'Two folds, no stale revival',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace() {
    return {
      'package.json': '{\n  "name": "batch-policy",\n  "type": "module",\n  "private": true\n}\n',
      'README.md': '# Batch policy record\n\nStage 1: write `state.json` with the current batch retry limit.\nStage 2: write `final.json` with the batch retry limit and the batch window.\n',
    }
  },
  reference(seed) {
    const values = seed === 1 ? { retry: 2, window: 30 } : { retry: 2, window: 45 }
    return {
      'state.json': `${JSON.stringify({ max_attempts: values.retry }, null, 2)}\n`,
      'final.json': `${JSON.stringify({ max_attempts: values.retry, window_seconds: values.window }, null, 2)}\n`,
    }
  },
  counterfactual(seed) {
    const values = seed === 1 ? { retry: 5, window: 30 } : { retry: 5, window: 45 }
    return {
      'state.json': `${JSON.stringify({ max_attempts: values.retry }, null, 2)}\n`,
      'final.json': `${JSON.stringify({ max_attempts: values.retry, window_seconds: values.window }, null, 2)}\n`,
    }
  },
  checks: [
    { kind: 'json_equals', path: 'state.json', value: { max_attempts: 2 } },
    { kind: 'json_equals', path: 'final.json', value: seed => seed === 1
      ? { max_attempts: 2, window_seconds: 30 }
      : { max_attempts: 2, window_seconds: 45 } },
  ],
  history(seed) {
    const window = seed === 1 ? 30 : 45
    const log = serviceLog({
      seed: seed * 23,
      count: 470,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [batch] attempt=${1 + Math.floor(r() * 5)} max_attempts=5 window_s=${window}`,
        `${stamp} WARN  [batch] retry storm job=${hex(r, 6)} attempts=${1 + Math.floor(r() * 5)}`,
        `${stamp} INFO  [batch] commit job=${hex(r, 6)} rows=${100 + Math.floor(r() * 900)}`,
      ]),
    })
    return [
      { role: 'user', text: 'The platform spec says a batch job may attempt five times. That is the baseline.' },
      { role: 'assistant', text: 'Recorded: max_attempts=5 for the general path. I will read the batch log before changing anything.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/batch.log"}', text: log },
      { role: 'user', text: 'Revision for the batch path only: cap it at two attempts. Five caused the retry storm. This revision supersedes the spec for batch jobs.' },
      { role: 'assistant', text: 'Batch path: max_attempts=2. The general path keeps five.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/batch-late-a.log"}', text: serviceLog({ seed: seed * 89, count: 330, lines: (r, i, stamp) => `${stamp} INFO  [batch] attempt=${1 + Math.floor(r() * 2)} job=${hex(r, 6)} rows=${100 + Math.floor(r() * 900)} window_s=${window}` }) },
    ]
  },
  stageB(seed) {
    const window = seed === 1 ? 30 : 45
    return [
      { role: 'user', text: 'Stage 2. The window was agreed at ' + window + ' seconds. The old spec document still says five attempts; it is stale and must not be used for the batch path.' },
      {
        role: 'tool',
        name: 'read_file',
        arguments: '{"path":"logs/batch-late.log"}',
        text: serviceLog({
          seed: seed * 29,
          count: 380,
          lines: (r, i, stamp) => pick(r, [
            `${stamp} INFO  [batch] window_s=${window} drain=${Math.floor(r() * 20)}`,
            `${stamp} INFO  [batch] attempt=${1 + Math.floor(r() * 2)} budget=2`,
            `${stamp} DEBUG [batch] checkpoint job=${hex(r, 6)} rows=${Math.floor(r() * 500)}`,
          ]),
        }),
      },
      { role: 'user', text: 'Stage 2 task: write final.json with max_attempts for the batch path and window_seconds. The superseded five must not appear.' },
    ]
  },
  task: 'Stage 1: write `state.json` with `max_attempts` for the batch path. Then reply with the value and no further tool calls.',
  taskB: 'Stage 2: write `final.json` with `max_attempts` for the batch path and `window_seconds` from the agreed window. Then reply with the values and no further tool calls.',
  requires: { minCompactions: 2 },
  gold: { revision: 'batch max_attempts=2', stale: 5, window: 'seed-dependent' },
}

/**
 * T5b: the same multi-fold task with the JSON SHAPE stated explicitly.
 *
 * The core T5 runs produced the right values nested under `batch` in every
 * arm; the checker required a flat object. That is a task-contract defect, not
 * a model failure, so the affected cells are re-run under a new template and a
 * new campaign instead of being reinterpreted after the fact.
 */
const T5B = {
  ...T5,
  id: 'T5B',
  title: 'Two folds, no stale revival (explicit output contract)',
  task: 'Stage 1: write `state.json` as a FLAT JSON object with exactly one top-level field, `max_attempts` (number), for the batch path. Do not nest it under another key. Then reply with the value and no further tool calls.',
  taskB: 'Stage 2: write `final.json` as a FLAT JSON object with exactly two top-level fields, `max_attempts` (number) and `window_seconds` (number). Do not nest them under another key. Then reply with the values and no further tool calls.',
}

const T6 = {
  id: 'T6',
  category: 'cache-pressure',
  title: 'Implement the retry contract under a stable long prefix',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace(seed) {
    const base = seed === 1 ? 100 : 150
    return {
      'package.json': '{\n  "name": "retry-policy",\n  "type": "module",\n  "private": true\n}\n',
      'src/retry.js': `export const MAX_ATTEMPTS = 3
export const BASE_MS = ${base}

export function delayFor(attempt) {
  return BASE_MS * attempt
}
`,
      'test/retry.test.js': `import assert from 'node:assert/strict'
import test from 'node:test'
import { BASE_MS, MAX_ATTEMPTS, delayFor } from '../src/retry.js'

test('the contract allows four attempts', () => {
  assert.equal(MAX_ATTEMPTS, 4)
})

test('the backoff base is 250ms', () => {
  assert.equal(BASE_MS, 250)
})

test('the first retry waits one base', () => {
  assert.equal(delayFor(1), 250)
})
`,
    }
  },
  reference() {
    return {
      'src/retry.js': `export const MAX_ATTEMPTS = 4
export const BASE_MS = 250

export function delayFor(attempt) {
  return BASE_MS * attempt
}
`,
    }
  },
  counterfactual(seed) {
    const base = seed === 1 ? 100 : 150
    return {
      'src/retry.js': `export const MAX_ATTEMPTS = 3
export const BASE_MS = ${base}

export function delayFor(attempt) {
  return BASE_MS * attempt
}
`,
    }
  },
  checks: [
    { kind: 'tests' },
    { kind: 'file_contains', path: 'src/retry.js', needle: 'MAX_ATTEMPTS = 4' },
    { kind: 'file_contains', path: 'src/retry.js', needle: 'BASE_MS = 250' },
  ],
  history(seed) {
    const contract = [
      '# Platform retry contract v4',
      '',
      'This contract is stable across the services in the platform. It is the',
      'authority for retry behaviour; local defaults that disagree are wrong.',
      '',
      '## Rules',
      '',
      '1. A request may be attempted at most FOUR times (the initial attempt plus',
      '   three retries). The earlier three-attempt value is retired.',
      '2. The backoff base is 250 ms. Backoff is linear in the attempt number.',
      '3. A retry must reuse the same idempotency key.',
      '4. The client must surface the final failure, not swallow it.',
      '',
      '## Why four',
      '',
      'The three-attempt limit produced a 0.4% failure rate on the ingest path',
      'during the October load test. The fourth attempt recovered 92% of those',
      'requests within the 2 s budget. Five attempts was rejected because it',
      'exceeded the budget for the p99 path.',
      '',
      '## Migration notes',
      '',
      '- Services on the old default (3 attempts, 100 ms) must update both values.',
      '- The window is unchanged; only the attempt cap and the base moved.',
      '- Do not infer the values from the log lines in this document; the rules',
      '  above are the contract. Logs show what happened, not what is required.',
      '',
      ...Array.from({ length: 60 }, (_, index) => `- advisory ${String(index + 1).padStart(2, '0')}: retry semantics are idempotent by key; see rule 3.`),
    ].join('\n')
    const log = serviceLog({
      seed: seed * 31,
      count: 410,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [retry] attempt=${1 + Math.floor(r() * 4)} max_attempts=4 base_ms=250`,
        `${stamp} WARN  [retry] exhausted id=${hex(r, 8)} attempts=4`,
        `${stamp} DEBUG [retry] sleep ms=${250 * (1 + Math.floor(r() * 4))} id=${hex(r, 8)}`,
      ]),
    })
    return [
      { role: 'user', text: 'Read the platform retry contract. The retry service must match it exactly; do not use the old defaults.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"docs/platform-retry.md"}', text: contract },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/retry.log"}', text: log },
      { role: 'assistant', text: 'The contract requires four attempts and a 250 ms base. The current src/retry.js still has the old defaults, so its tests fail.' },
      { role: 'user', text: 'Implement the contract in src/retry.js. Run the tests.' },
    ]
  },
  task: 'Implement the platform retry contract in `src/retry.js`. Run `node --test` and make every test pass. Then reply with a short summary and no further tool calls.',
  gold: { max_attempts: 4, base_ms: 250 },
}

/**
 * T7 — a HISTORICAL TEST RESULT.
 *
 * The question is not "do the tests pass now" but "how many failed in the run
 * before the fix". The workspace carries a newer, passing run; the incident
 * count exists only in the archived tool result.
 */
const T7 = {
  id: 'T7',
  category: 'historical-test-result',
  title: 'Recover the failure count from the pre-fix test run',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace(seed) {
    const suite = seed === 1 ? 'retry' : 'billing'
    return {
      'README.md': '# Test history\n\nThe latest run is in `test-results-latest.txt`. It is NOT the run the reviewer asked about.\n',
      'test-results-latest.txt': `suite: ${suite}\n# tests 42\n# pass 42\n# fail 0\n`,
    }
  },
  reference(seed) {
    const failed = seed === 1 ? 3 : 5
    const suite = seed === 1 ? 'retry' : 'billing'
    return { 'test-history.json': `${JSON.stringify({ failed, suite }, null, 2)}\n` }
  },
  counterfactual(seed) {
    const suite = seed === 1 ? 'retry' : 'billing'
    return { 'test-history.json': `${JSON.stringify({ failed: 0, suite }, null, 2)}\n` }
  },
  checks: [
    { kind: 'json_equals', path: 'test-history.json', value: seed => seed === 1
      ? { failed: 3, suite: 'retry' }
      : { failed: 5, suite: 'billing' } },
  ],
  history(seed) {
    const failed = seed === 1 ? 3 : 5
    const suite = seed === 1 ? 'retry' : 'billing'
    const passed = 42 - failed
    const log = serviceLog({
      seed: seed * 17,
      count: 560,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [${suite}] case ${hex(r, 6)} started`,
        `${stamp} WARN  [${suite}] retry attempt=${1 + Math.floor(r() * 3)} id=${hex(r, 8)}`,
        `${stamp} INFO  [${suite}] request id=${hex(r, 10)} status=${r() > 0.1 ? 200 : 503}`,
        `${stamp} DEBUG [${suite}] queue depth=${Math.floor(r() * 40)}`,
      ]),
    })
    return [
      { role: 'user', text: `Run the ${suite} suite before we change anything. I need the failure count from THIS run for the incident review.` },
      { role: 'assistant', text: `Running the ${suite} suite now. I will record the summary line verbatim.` },
      {
        role: 'tool',
        name: 'run_tests',
        arguments: JSON.stringify({ suite }),
        text: `# ${suite} suite\n# tests 42\n# pass ${passed}\n# fail ${failed}\n${log}`,
      },
      { role: 'assistant', text: `The pre-fix run failed ${failed} of 42 tests in the ${suite} suite. I will report that exact count.` },
      { role: 'user', text: 'We have since fixed the suite. The old run output is no longer in the workspace; the latest file is a different run.' },
    ]
  },
  task: 'Write `test-history.json` with `failed` (number) and `suite` (string) from the PRE-FIX run you inspected, not from `test-results-latest.txt`. Then reply with the values and no further tool calls.',
  gold: { note: 'the failure count exists only in the archived run_tests result' },
}

/**
 * T8 — a CONFIGURATION THAT WAS IN EFFECT AND HAS SINCE CHANGED.
 *
 * The workspace holds the new value. The question is what was live during the
 * incident, which is a historical observation.
 */
const T8 = {
  id: 'T8',
  category: 'expired-configuration',
  title: 'Recover the timeout that was in effect during the incident',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace(seed) {
    const current = seed === 1 ? 900 : 1200
    return {
      'README.md': '# Service configuration\n\n`config/service.yaml` is the CURRENT configuration. It was changed after the incident.\n',
      'config/service.yaml': `service: checkout\nretry:\n  timeout_ms: ${current}\n  attempts: 4\n`,
      'CHANGELOG.md': '# Changelog\n\n## After the incident\n- retry.timeout_ms changed. The incident review needs the value that was live during the incident.\n',
    }
  },
  reference(seed) {
    const timeout = seed === 1 ? 1847 : 2311
    return { 'incident-config.json': `${JSON.stringify({ timeout_ms: timeout }, null, 2)}\n` }
  },
  counterfactual(seed) {
    const current = seed === 1 ? 900 : 1200
    return { 'incident-config.json': `${JSON.stringify({ timeout_ms: current }, null, 2)}\n` }
  },
  checks: [
    { kind: 'json_equals', path: 'incident-config.json', value: seed => seed === 1
      ? { timeout_ms: 1847 }
      : { timeout_ms: 2311 } },
  ],
  history(seed) {
    const timeout = seed === 1 ? 1847 : 2311
    const config = `service: checkout\nretry:\n  timeout_ms: ${timeout}\n  attempts: 4\n  backoff: exponential\n# this file is the configuration the incident ran with\n`
    const log = serviceLog({
      seed: seed * 29,
      count: 470,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [checkout] retry budget_ms=${timeout} attempt=${1 + Math.floor(r() * 3)} id=${hex(r, 8)}`,
        `${stamp} WARN  [checkout] upstream slow ms=${timeout + Math.floor(r() * 30)} retry=1`,
        `${stamp} INFO  [checkout] request id=${hex(r, 10)} status=${r() > 0.1 ? 200 : 503}`,
      ]),
    })
    return [
      { role: 'user', text: 'Read the checkout service configuration before we change it. I need the timeout that is live right now for the incident timeline.' },
      { role: 'assistant', text: 'Reading the configuration file now.' },
      {
        role: 'tool',
        name: 'read_file',
        arguments: '{"path":"config/service.yaml"}',
        text: `${config}${log}`,
      },
      { role: 'assistant', text: `The live retry timeout is ${timeout} ms. Recording it verbatim.` },
      { role: 'user', text: 'After the incident we changed the timeout. The workspace now holds the new file; the old value is only in the conversation.' },
    ]
  },
  task: 'Write `incident-config.json` with `timeout_ms` (number) that was in effect during the incident, not the current value in `config/service.yaml`. Then reply with the value and no further tool calls.',
  gold: { note: 'the incident value exists only in the archived configuration read' },
}

/**
 * T9 — CROSS-FILE EVIDENCE.
 *
 * The answer needs a service name from one historical read and a release id
 * from another. Both files have since been redeployed, so the workspace carries
 * two decoys and neither half can be taken from it.
 */
const T9 = {
  id: 'T9',
  category: 'cross-file-recovery',
  title: 'Assemble the incident deploy from two archived reads',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace(seed) {
    const tag = seed === 1 ? 'v2.8.0' : 'v1.9.5'
    const release = seed === 1 ? 'rel-a81d' : 'rel-77bb'
    return {
      'README.md': '# Deploy records\n\n`deploy/app.yaml` and `deploy/release.json` describe the CURRENT deploy, not the one that caused the incident.\n',
      'deploy/app.yaml': `service: ${seed === 1 ? 'checkout' : 'billing'}\nimage: registry/${seed === 1 ? 'checkout' : 'billing'}:${tag}\n`,
      'deploy/release.json': `${JSON.stringify({ release, tag }, null, 2)}\n`,
    }
  },
  reference(seed) {
    const values = seed === 1
      ? { service: 'checkout', release: 'rel-9f2c', tag: 'v2.7.1' }
      : { service: 'billing', release: 'rel-4d71', tag: 'v1.9.4' }
    return { 'incident-deploy.json': `${JSON.stringify(values, null, 2)}\n` }
  },
  counterfactual(seed) {
    const values = seed === 1
      ? { service: 'checkout', release: 'rel-a81d', tag: 'v2.8.0' }
      : { service: 'billing', release: 'rel-77bb', tag: 'v1.9.5' }
    return { 'incident-deploy.json': `${JSON.stringify(values, null, 2)}\n` }
  },
  checks: [
    { kind: 'json_equals', path: 'incident-deploy.json', value: seed => seed === 1
      ? { service: 'checkout', release: 'rel-9f2c', tag: 'v2.7.1' }
      : { service: 'billing', release: 'rel-4d71', tag: 'v1.9.4' } },
  ],
  history(seed) {
    const values = seed === 1
      ? { service: 'checkout', release: 'rel-9f2c', tag: 'v2.7.1' }
      : { service: 'billing', release: 'rel-4d71', tag: 'v1.9.4' }
    const app = `service: ${values.service}\nimage: registry/${values.service}:${values.tag}\nreplicas: 3\n`
    const release = JSON.stringify({ release: values.release, tag: values.tag, created: '2026-10-11T02:10:00Z' }, null, 2)
    const log = serviceLog({
      seed: seed * 41,
      count: 520,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [deploy] image=${values.service}:${values.tag} release=${values.release}`,
        `${stamp} INFO  [deploy] pod ready id=${hex(r, 8)}`,
        `${stamp} WARN  [deploy] rollout paused revision=${1 + Math.floor(r() * 9)}`,
      ]),
    })
    return [
      { role: 'user', text: 'Read the deploy manifest and the release record for the incident window. I need the service, release id and image tag that were deployed then.' },
      { role: 'assistant', text: 'Reading both files; they identify different halves of the same deploy.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"deploy/app.yaml"}', text: app },
      { role: 'tool', name: 'read_file', arguments: '{"path":"deploy/release.json"}', text: release },
      { role: 'assistant', text: `The deployed service is ${values.service}, release ${values.release}, tag ${values.tag}. Both files agree.` },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/deploy.log"}', text: log },
      { role: 'user', text: 'The deploy has been replaced since; both workspace files now describe the current deploy. The incident deploy exists only in the conversation.' },
    ]
  },
  task: 'Write `incident-deploy.json` with exactly `service` (string), `release` (string) and `tag` (string) from the INCIDENT deploy you inspected, not from the current workspace files. Then reply with the values and no further tool calls.',
  gold: { note: 'the answer requires one fact from each of two archived reads' },
}

/**
 * T10 — ONE IDENTIFIER REVISED MULTIPLE TIMES.
 *
 * Three reads of the same file show three values. The question names a time,
 * so the model must pick the version that was in effect then, not the first,
 * the latest, or the workspace's current value.
 */
const T10 = {
  id: 'T10',
  category: 'multi-revision-history',
  title: 'Recover the value in effect at a named time',
  operationalBudgetTokens: 16384,
  thresholdRatio: 0.5,
  workspace(seed) {
    const versions = seed === 1 ? [4, 8, 12] : [3, 6, 9]
    return {
      'README.md': '# Flag history\n\n`config/flags.json` is the CURRENT value. It is not the value at 10:00.\n',
      'config/flags.json': `${JSON.stringify({ concurrency: versions[2] }, null, 2)}\n`,
      'CHANGELOG.md': `# Flag changes\n\n- 09:41 concurrency set to ${versions[0]}.\n- 09:56 raised to ${versions[1]}.\n- 10:11 raised to ${versions[2]}.\n`,
    }
  },
  reference(seed) {
    const at10 = seed === 1 ? 8 : 6
    return { 'flag-at-10.json': `${JSON.stringify({ concurrency: at10 }, null, 2)}\n` }
  },
  counterfactual(seed) {
    const current = seed === 1 ? 12 : 9
    return { 'flag-at-10.json': `${JSON.stringify({ concurrency: current }, null, 2)}\n` }
  },
  checks: [
    { kind: 'json_equals', path: 'flag-at-10.json', value: seed => seed === 1
      ? { concurrency: 8 }
      : { concurrency: 6 } },
  ],
  history(seed) {
    const versions = seed === 1 ? [4, 8, 12] : [3, 6, 9]
    // At the boundary times: 09:56 is the first minute of the middle value,
    // 10:11 the first minute of the last. The task asks for 10:00, which is
    // unambiguously inside the middle window.
    const stamps = ['09:41', '09:56', '10:11']
    const versionAt = stamp => {
      const clock = stamp.slice(11, 16)
      if (clock < '09:56') return versions[0]
      if (clock < '10:11') return versions[1]
      return versions[2]
    }
    const log = serviceLog({
      seed: seed * 53,
      count: 560,
      lines: (r, i, stamp) => pick(r, [
        `${stamp} INFO  [flags] concurrency=${versionAt(stamp)} reader=${hex(r, 6)}`,
        `${stamp} DEBUG [flags] reload generation=${1 + Math.floor(r() * 5)}`,
        `${stamp} INFO  [flags] request id=${hex(r, 10)} status=${r() > 0.1 ? 200 : 503}`,
      ]),
    })
    return [
      { role: 'user', text: 'Track the concurrency flag through today. Read it at each change; the incident review needs the value at 10:00 exactly.' },
      { role: 'assistant', text: 'Reading the flag file after each change and recording the time.' },
      { role: 'tool', name: 'read_file', arguments: '{"path":"config/flags.json"}', text: `${JSON.stringify({ concurrency: versions[0] }, null, 2)}\n# observed at ${stamps[0]}` },
      { role: 'tool', name: 'read_file', arguments: '{"path":"config/flags.json"}', text: `${JSON.stringify({ concurrency: versions[1] }, null, 2)}\n# observed at ${stamps[1]}` },
      { role: 'tool', name: 'read_file', arguments: '{"path":"config/flags.json"}', text: `${JSON.stringify({ concurrency: versions[2] }, null, 2)}\n# observed at ${stamps[2]}` },
      { role: 'tool', name: 'read_file', arguments: '{"path":"logs/flags.log"}', text: log },
      { role: 'user', text: 'The current file has moved past the incident time. The 10:00 value exists only in the conversation.' },
    ]
  },
  task: 'Write `flag-at-10.json` with `concurrency` (number) that was in effect at 10:00, not the first value and not the current one. Then reply with the value and no further tool calls.',
  gold: { note: 'the middle revision is the only correct value; first and last are decoys' },
}

const TEMPLATES = { T1, T2, T3, T4, T5, T5B, T6, T7, T8, T9, T10 }

function resolveValue(value, seed) {
  return typeof value === 'function' ? value(seed) : value
}

function materialize(template, seed) {
  const checks = template.checks.map(check => {
    if (check.kind !== 'json_equals') return check
    return { ...check, value: resolveValue(check.value, seed) }
  })
  return {
    schemaVersion: 1,
    id: `${template.id}-s${seed}`,
    template: template.id,
    seed,
    category: template.category,
    title: template.title,
    operationalBudgetTokens: template.operationalBudgetTokens,
    thresholdRatio: template.thresholdRatio,
    seededHistory: true,
    workspace: template.workspace(seed),
    history: template.history(seed),
    ...(template.stageB === undefined ? {} : { stageB: template.stageB(seed) }),
    task: template.task,
    ...(template.taskB === undefined ? {} : { taskB: template.taskB }),
    ...(template.requires === undefined ? {} : { requires: template.requires }),
    reference: template.reference(seed),
    counterfactual: template.counterfactual(seed),
    checks,
    gold: template.gold,
  }
}

async function main() {
  const written = []
  for (const template of Object.values(TEMPLATES)) {
    for (const seed of [1, 2]) {
      const task = materialize(template, seed)
      const path = join(HERE, `${task.id}.json`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
      written.push(path)
    }
  }
  process.stdout.write(`wrote ${written.length} task instance(s)\n`)
  for (const path of written) process.stdout.write(`  ${path.slice(ROOT.length + 1)}\n`)
}

await main()
