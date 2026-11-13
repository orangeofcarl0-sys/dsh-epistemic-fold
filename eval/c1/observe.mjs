#!/usr/bin/env node
/**
 * EF-C1 WP0 — measure what a command actually writes.
 *
 * ## Why a harness instead of a claim
 *
 * "The tests do not touch historical evidence" is a property that has to be
 * MEASURED, not asserted. EF-C0 discovered the opposite by accident: a full
 * suite run left `docs/12_R1_EVALUATION_REPORT.md` rewritten, and a later
 * `git status` looked clean only because the files had been restored by hand.
 *
 * This script takes a content snapshot of every protected artifact, runs one
 * command, takes the snapshot again, and records the difference. It does not
 * restore anything: the caller decides what to do with a drift, and the
 * observation stays in `eval/c1/out/` as the record.
 *
 * ## Usage
 *
 *   node eval/c1/observe.mjs --id npm-ci -- npm ci
 *   node eval/c1/observe.mjs --id full-suite -- npx vitest run
 *
 * The exit code is the command's own exit code, so a failing trigger is not
 * silently turned into a passing observation.
 *
 * @module eval/c1/observe
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const REGISTRY = join(OUT, 'protected-artifacts.json')

function arg(flag) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

function commandAfterDoubleDash() {
  const at = process.argv.indexOf('--')
  return at === -1 ? [] : process.argv.slice(at + 1)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Hash every protected path that exists on disk, LF-normalized. */
function snapshot() {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const hashes = {}
  for (const entry of registry.entries) {
    const full = join(ROOT, entry.path)
    if (!existsSync(full)) { hashes[entry.path] = null; continue }
    const bytes = readFileSync(full)
    const normalized = Buffer.from(bytes.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8')
    hashes[entry.path] = sha256(normalized)
  }
  return hashes
}

function main() {
  if (!existsSync(REGISTRY)) {
    process.stderr.write(`missing ${REGISTRY}; run node eval/c1/protected-artifacts.mjs first\n`)
    process.exit(1)
  }
  const id = arg('--id')
  const command = commandAfterDoubleDash()
  if (id === undefined || command.length === 0) {
    process.stderr.write('usage: node eval/c1/observe.mjs --id <name> -- <command...>\n')
    process.exit(1)
  }

  const before = snapshot()
  const startedAt = Date.now()
  const child = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  })
  const durationMs = Date.now() - startedAt
  const after = snapshot()

  const drift = Object.keys(before)
    .filter(path => before[path] !== after[path])
    .map(path => ({ path, before: before[path], after: after[path] }))

  const observation = {
    schemaVersion: 1,
    work: 'EF-C1',
    generator: 'eval/c1/observe.mjs',
    id,
    command,
    exitCode: child.status ?? -1,
    durationMs,
    observedAt: new Date().toISOString(),
    protectedArtifacts: Object.keys(before).length,
    drifted: drift.length,
    drift,
  }

  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, `observation-${id}.json`)
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`, 'utf8')
  process.stdout.write(`\n[observe ${id}] exit ${observation.exitCode}, ${drift.length} protected artifact(s) changed\n`)
  for (const row of drift) process.stdout.write(`  ${row.path}\n`)
  process.stdout.write(`[observe ${id}] wrote ${path}\n`)
  process.exit(child.status ?? 1)
}

main()
