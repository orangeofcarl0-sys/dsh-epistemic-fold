#!/usr/bin/env node
/**
 * EF-R3 product-lane — new multi-compaction instances for the 32k window.
 *
 * The R2 T16 seed was designed for 16k. At 32k with retain 0.16, its final tool
 * result is larger than the retained tail, so the first fold commits and the
 * retry cannot reach the threshold. These instances use MANY medium logs
 * instead of one huge final log, so a first fold can reduce the surface and
 * stage B can trigger a second fold.
 *
 * The output is authored offline and is not executed here.
 *
 *   node eval/r3/generate-product-tasks.mjs
 *
 * @module eval/r3/generate-product-tasks
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(ROOT, 'eval', 'e2e', 'tasks-r3')

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

function serviceLog({ seed, lines = 110, facts = [], start = Date.UTC(2026, 9, 20, 9, 0, 0) }) {
  const random = prng(seed)
  const rows = []
  let at = start
  const factAt = Math.max(1, Math.floor(lines / 3))
  for (let index = 0; index < lines; index += 1) {
    at += 900 + Math.floor(random() * 30_000)
    if (index === factAt) rows.push(...facts)
    const status = random() < 0.04 ? 503 : 200
    rows.push(
      `${new Date(at).toISOString()} ${status === 200 ? 'INFO ' : 'ERROR'} [deploy] request `
      + `id=${hex(random, 8)} upstream=api-${1 + Math.floor(random() * 9)} status=${status} `
      + `latency_ms=${10 + Math.floor(random() * 900)} bytes=${100 + Math.floor(random() * 9000)}`,
    )
  }
  return rows.join('\n')
}

function multiCompactionProduct(seed) {
  const release = seed === 1 ? 'rel-p1' : 'rel-p2'
  const checksum = seed === 1 ? '9f2a7c14' : '3b8d6e05'
  const first = serviceLog({
    seed: 2600 + seed,
    facts: [
      `2026-10-20T02:00:00.000Z INFO  [release] id=${release} checksum=${checksum} status=published`,
      '2026-10-20T02:00:01.000Z INFO  [release] channel=production',
    ],
  })
  const logs = [first]
  for (let index = 2; index <= 6; index += 1) {
    logs.push(serviceLog({
      seed: 2600 + seed + index * 10,
      start: Date.UTC(2026, 9, 20 + index, 2, 0, 0),
    }))
  }
  const stageLogs = [1, 2, 3].map(index => serviceLog({
    seed: 2600 + seed + 100 + index,
    start: Date.UTC(2026, 9, 27 + index, 2, 0, 0),
  }))
  const history = [
    { role: 'user', text: 'Read the deployment logs over the release window. I need the earliest published release id and checksum for the postmortem.' },
  ]
  logs.forEach((log, index) => {
    history.push({
      role: 'tool',
      name: 'read_file',
      arguments: JSON.stringify({ path: `logs/deploy-${index + 1}.log` }),
      text: log,
    })
    if (index === 0) {
      history.push({ role: 'assistant', text: 'The earliest log carries the published release id and checksum; later logs add deployment noise.' })
    }
  })
  history.push({ role: 'user', text: 'Keep the earliest published values. Do not let a later retry change them.' })

  return {
    schemaVersion: 1,
    id: `T16-p${seed}`,
    template: 'T16',
    seed,
    category: 'multi-compaction',
    title: 'Recover the earliest release record across two folds',
    operationalBudgetTokens: 32_768,
    thresholdRatio: 0.5,
    seededHistory: true,
    workspace: {
      'README.md': '# Release record\n\nThe release id and checksum are in the earliest deployment log. The later logs add noise. Stage 2 adds more logs, so the continuation needs a second fold. Write `release.json` with the earliest published values.\n',
    },
    history,
    stageB: [
      { role: 'user', text: 'The deploy window moved and more logs arrived. Read them before you write the record.' },
      ...stageLogs.map((log, index) => ({
        role: 'tool',
        name: 'read_file',
        arguments: JSON.stringify({ path: `logs/deploy-stage-${index + 1}.log` }),
        text: log,
      })),
      { role: 'user', text: 'Write `release.json` with the `release` id and `checksum` from the earliest deployment log.' },
    ],
    task: 'Read the deployment logs and keep the earliest published release id and checksum for the record.',
    taskB: 'Stage 2: write `release.json` with the `release` id and `checksum` from the earliest deployment log.',
    reference: { 'release.json': `${JSON.stringify({ release, checksum }, null, 2)}\n` },
    counterfactual: { 'release.json': `${JSON.stringify({ release: 'rel-000', checksum: '00000000' }, null, 2)}\n` },
    checks: [{ kind: 'json_equals', path: 'release.json', value: { release, checksum } }],
    requires: { minCompactions: 2 },
    gold: { note: 'The earliest release facts exist only in the seeded history; later logs do not repeat them.' },
  }
}

const tasks = [multiCompactionProduct(1), multiCompactionProduct(2)]

// The R2 T11-T15 instances are content-valid at 32k, but their JSON still says
// 16,384. The live runner reads `task.operationalBudgetTokens`, not the
// manifest config, so the product pilot needs explicit p1 copies at 32,768.
// The history, workspace and checks are unchanged.
for (const template of ['T11', 'T12', 'T13', 'T14', 'T15']) {
  const source = JSON.parse(await readFile(join(ROOT, 'eval', 'e2e', 'tasks-r2', `${template}-s1.json`), 'utf8'))
  tasks.push({
    ...source,
    id: `${template}-p1`,
    seed: 1,
    operationalBudgetTokens: 32_768,
    gold: {
      ...(source.gold ?? {}),
      note: 'Product-lane copy of the R2 s1 instance at the 32,768 window; history, workspace and checks unchanged.',
    },
  })
}

await mkdir(OUT, { recursive: true })
for (const entry of tasks) {
  await writeFile(join(OUT, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
}
process.stdout.write(`wrote ${tasks.length} product tasks to ${OUT.replace(/\\/gu, '/')}\n`)
for (const entry of tasks) {
  const chars = entry.history.reduce((sum, item) => sum + (item.text?.length ?? 0), 0)
    + (entry.stageB ?? []).reduce((sum, item) => sum + (item.text?.length ?? 0), 0)
  process.stdout.write(`  ${entry.id} history+stageChars=${chars}\n`)
}
