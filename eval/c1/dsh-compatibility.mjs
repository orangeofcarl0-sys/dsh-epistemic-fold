#!/usr/bin/env node
/**
 * EF-C1 WP3 — the DSH compatibility fingerprint.
 *
 * ## Why this is a measurement, not a table
 *
 * Three different DSH identities are in play, and the repository's own
 * documentation conflates them:
 *
 *   vendored   the gitignored `vendor/deepseek-harness` checkout that tests
 *              resolve `@deepseek-ai/*` against
 *   installed  the npm packages `package-lock.json` puts in `node_modules`,
 *              which plain-Node scripts import
 *   declared   the version range `package.json` says it supports
 *
 * This script records what each one actually IS on this machine. It never
 * claims a version from a package name: the vendored tree has no git metadata
 * in a worktree, so its commit SHA is `not-verifiable` and only its package
 * version is measurable.
 *
 * ## What it probes
 *
 * The installed packages are real ES modules, so their exports can be imported
 * and inspected. The vendored tree is TypeScript source; Node cannot import it,
 * so its API surface is `not-tested` here and is covered by the typecheck
 * project instead. Saying so is the point: an untested surface is not an
 * available one.
 *
 * @module eval/c1/dsh-compatibility
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const VENDOR = join(ROOT, 'vendor', 'deepseek-harness')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const exists = (path) => existsSync(path)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Every `@deepseek-ai/dsh-*` peer, with its declared range and installed version. */
function packages() {
  const pkg = readJson(join(ROOT, 'package.json'))
  const rows = []
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    const installedPath = join(ROOT, 'node_modules', name, 'package.json')
    rows.push({
      name,
      declaredRange: range,
      installed: exists(installedPath) ? readJson(installedPath).version : null,
    })
  }
  return rows
}

/** A dynamic import probe; a missing export is `unavailable`, not a crash. */
async function probe(module, names) {
  try {
    const loaded = await import(module)
    const missing = names.filter(name => loaded[name] === undefined && loaded.default?.[name] === undefined)
    return missing.length === 0
      ? { status: 'available', detail: `${names.join(', ')} exported` }
      : { status: 'unavailable', detail: `missing ${missing.join(', ')}` }
  } catch (error) {
    return { status: 'incompatible', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A probe that accepts any one of several export groups.
 *
 * The agent API is the reason: 0.1.x exported an `Agent` class, 0.2.x replaced
 * it with `AgentRegistry` + `agentCarrier`. Both are "the agent API exists";
 * naming which one is present is the useful fact.
 */
async function probeAny(module, groups) {
  try {
    const loaded = await import(module)
    for (const names of groups) {
      const missing = names.filter(name => loaded[name] === undefined && loaded.default?.[name] === undefined)
      if (missing.length === 0) return { status: 'available', detail: `${names.join(', ')} exported` }
    }
    return {
      status: 'unavailable',
      detail: `none of ${groups.map(group => group.join('+')).join(' | ')} exported`,
    }
  } catch (error) {
    return { status: 'incompatible', detail: error instanceof Error ? error.message : String(error) }
  }
}

function packageManagerVersion() {
  const agent = process.env['npm_config_user_agent']
  const fromAgent = agent === undefined ? null : /npm\/\S+/u.exec(agent)?.[0] ?? null
  if (fromAgent !== null) return fromAgent
  try {
    return `npm ${execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8' }).trim()}`
  } catch {
    return 'not-verifiable'
  }
}

async function main() {
  const pkg = readJson(join(ROOT, 'package.json'))
  const lockPath = join(ROOT, 'package-lock.json')
  const vendorPkgPath = join(VENDOR, 'package.json')
  const vendorPresent = exists(vendorPkgPath)
  const vendorPkg = vendorPresent ? readJson(vendorPkgPath) : undefined

  const vendoredBasicHeader = (() => {
    const path = join(ROOT, 'src', 'basic', 'config.ts')
    if (!exists(path)) return null
    const first = readFileSync(path, 'utf8').split('\n').slice(0, 4).join('\n')
    const match = /Vendored from DeepSeek Harness (\S+)/u.exec(first)
    return match?.[1] ?? 'unparsed'
  })()

  const installedVersions = [...new Set(packages().map(row => row.installed).filter(Boolean))]
  const declaredLines = [...new Set(packages()
    .map(row => row.declaredRange.replace(/^[\^~>=<]+/u, '').replace(/[<>=].*$/u, '')))]
  const vendorPaths = exists(join(ROOT, 'scripts', 'vendor-paths.json'))
    ? readJson(join(ROOT, 'scripts', 'vendor-paths.json'))
    : {}
  const aliasTargets = Object.values(vendorPaths).flat()
  const aliasTargetsPresent = aliasTargets.filter(target => exists(resolve(ROOT, target))).length

  const libDir = join(ROOT, 'lib')
  const libModules = exists(libDir)
    ? readdirSync(libDir, { recursive: true }).filter(name => String(name).endsWith('.js')).length
    : 0

  const checks = [
    {
      id: 'node',
      status: 'available',
      detail: process.version,
    },
    {
      id: 'package-manager',
      status: packageManagerVersion() === 'not-verifiable' ? 'not-verifiable' : 'available',
      detail: packageManagerVersion(),
    },
    {
      id: 'dependency-lock',
      status: exists(lockPath) ? 'available' : 'unavailable',
      detail: exists(lockPath) ? sha256(readFileSync(lockPath)) : 'package-lock.json absent',
    },
    {
      id: 'dsh-source-sha',
      status: vendorPresent ? 'not-verifiable' : 'unavailable',
      detail: vendorPresent
        ? 'the vendored tree carries no git metadata; only its package version is measurable'
        : 'no vendor/deepseek-harness checkout in this worktree',
    },
    {
      id: 'vendored-dsh-version',
      status: vendorPresent ? 'available' : 'unavailable',
      detail: vendorPresent ? vendorPkg.version : 'no vendor checkout',
    },
    {
      id: 'declared-dsh-line',
      status: declaredLines.length === 1 ? 'available' : 'incompatible',
      detail: declaredLines.join(', '),
    },
    {
      id: 'installed-dsh-versions',
      status: installedVersions.length === 1 ? 'available' : 'incompatible',
      detail: installedVersions.join(', ') || 'none installed',
    },
    {
      id: 'vendored-basic-provenance',
      status: vendoredBasicHeader === null ? 'unavailable' : 'available',
      detail: vendoredBasicHeader ?? 'src/basic/config.ts absent',
    },
    {
      id: 'typescript-path-aliases',
      status: Object.keys(vendorPaths).length === 0
        ? 'unavailable'
        : (aliasTargetsPresent === aliasTargets.length ? 'available' : 'incompatible'),
      detail: `${Object.keys(vendorPaths).length} aliases, ${aliasTargetsPresent}/${aliasTargets.length} targets present`,
    },
    {
      id: 'build-output',
      status: libModules > 0 ? 'available' : 'unavailable',
      detail: `${libModules} built module(s) under lib/`,
    },
    {
      id: 'compaction-api',
      ...(await probe('@deepseek-ai/dsh-compaction', ['CompactionEngine', 'isCompactCheckpointSource'])),
    },
    {
      id: 'basic-frame-checkpoint',
      // The seam is EF's own. No released DSH ships `frameCheckpoint`; that is
      // why `src/basic/` exists. A host that HAS it is compatible too, so this
      // check reports the fact rather than failing on it.
      ...(await (async () => {
        try {
          const basic = await import('@deepseek-ai/dsh-compaction-basic')
          return {
            status: 'available',
            detail: typeof basic.default?.prototype?.frameCheckpoint === 'undefined'
              ? 'installed Basic has no frameCheckpoint; EF src/basic supplies the seam'
              : 'installed Basic ships frameCheckpoint',
          }
        } catch (error) {
          return {
            status: 'incompatible',
            detail: `not measurable: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      })()),
    },
    { id: 'agent-api', ...(await probeAny('@deepseek-ai/dsh-agent', [['Agent'], ['AgentRegistry']])) },
    { id: 'session-api', ...(await probe('@deepseek-ai/dsh-session', ['Session', 'SessionStore'])) },
    { id: 'tool-runtime-api', ...(await probe('@deepseek-ai/dsh-tools', ['ToolRuntime'])) },
    { id: 'llm-api', ...(await probe('@deepseek-ai/dsh-llm', ['LlmAdapter', 'LlmRuntime'])) },
    { id: 'session-projection-api', ...(await probe('@deepseek-ai/dsh-session-projection', [])) },
    { id: 'system-prompt-api', ...(await probe('@deepseek-ai/dsh-system-prompt', ['SystemPrompt'])) },
  ]

  const report = {
    schemaVersion: 1,
    work: 'EF-C1',
    generator: 'eval/c1/dsh-compatibility.mjs',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    generatedAt: new Date().toISOString(),
    declared: {
      engines: pkg.engines ?? {},
      dshLine: declaredLines,
    },
    measured: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      vendorPresent,
      vendoredDshVersion: vendorPkg?.version ?? null,
      vendoredBasicProvenance: vendoredBasicHeader,
      installedDshVersions: installedVersions,
      lockSha256: exists(lockPath) ? sha256(readFileSync(lockPath)) : null,
      libModules,
    },
    // The three identities are recorded separately because collapsing them into
    // "Basic" is exactly the error this round is meant to prevent.
    identities: {
      historicalBasic: vendoredBasicHeader,
      efVendoredBasic: 'src/basic/*.ts (regenerate with node scripts/vendor-basic.mjs)',
      currentHostBasic: installedVersions.length === 1 ? installedVersions[0] : installedVersions,
    },
    checks,
    packages: packages(),
    limitations: [
      'The vendored tree has no git metadata in a worktree, so its commit SHA cannot be measured locally.',
      'Vendored TypeScript is not importable by plain Node; its API surface is covered by typecheck, not by this probe.',
      'The installed version is what plain-Node scripts (the live runner) execute; vitest may resolve the vendored source instead.',
      'CI pins vendor 639ed01 (documented 0.2.0-rc.2) while package-lock installs 0.2.1-rc.3: a mixed lane this script cannot reproduce locally.',
    ],
  }

  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'dsh-compatibility.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `dsh compatibility: vendor ${report.measured.vendoredDshVersion ?? 'absent'}, `
    + `installed ${installedVersions.join(', ') || 'none'}, declared ${declaredLines.join(', ')}\n`,
  )
  for (const check of checks.filter(row => row.status !== 'available')) {
    process.stdout.write(`  ${check.status}: ${check.id} — ${check.detail}\n`)
  }
  process.stdout.write(`wrote ${join(OUT, 'dsh-compatibility.json')}\n`)
}

await main()
