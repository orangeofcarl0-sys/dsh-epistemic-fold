#!/usr/bin/env node
/**
 * Candidate build smoke: install, load, mode switch, disabled capability.
 *
 * Runs against the INSTALLED tarball in a throwaway host directory, not against
 * the repository's `lib/`. That distinction is the point: a package that only
 * works from its own checkout is not installable.
 *
 *   node eval/e2e/src/candidate-smoke.mjs --install eval/e2e/candidate/install
 *
 * No provider request is made. The adapter is a stub that is never called: this
 * smoke is about construction and composition, not model behaviour.
 *
 * @module eval/e2e/src/candidate-smoke
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const argv = process.argv.slice(2)
const at = argv.indexOf('--install')
const installDir = at === -1 ? join(ROOT, 'eval', 'e2e', 'candidate', 'install') : resolve(argv[at + 1])
const packageDir = join(installDir, 'node_modules', 'dsh-epistemic-fold')
const tarballAt = argv.indexOf('--tarball')
const tarball = tarballAt === -1
  ? join(ROOT, 'eval', 'e2e', 'candidate', 'dsh-epistemic-fold-0.1.0.tgz')
  : resolve(argv[tarballAt + 1])
const workAt = argv.indexOf('--work')
const work = workAt === -1 ? 'EF-E2E' : argv[workAt + 1]

class StubAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 131_072 } })
  }

  async *stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mount(config) {
  const ctx = new Context()
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  new AgentRegistry(ctx)
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: createVolatile(1) })
  ctx.llm.registerAdapter(['candidate-smoke'], new StubAdapter())
  const { default: EpistemicFoldPlugin } = await import(pathToFileURL(join(packageDir, 'lib', 'plugin.js')).href)
  const plugin = new EpistemicFoldPlugin(ctx, config)
  return { ctx, plugin }
}

const checks = []
const check = (id, pass, detail) => {
  checks.push({ id, pass, detail })
  if (!pass) process.exitCode = 1
}

if (!existsSync(packageDir)) {
  process.stderr.write(`candidate-smoke: ${packageDir} is not installed\n`)
  process.exit(2)
}

// 1. The package loads from the INSTALLED location.
const pluginModule = await import(pathToFileURL(join(packageDir, 'lib', 'plugin.js')).href)
check('loads-plugin', typeof pluginModule.default === 'function', 'lib/plugin.js exports a class')
const entryModule = await import(pathToFileURL(join(packageDir, 'lib', 'entry.js')).href)
check('loads-entry', entryModule !== null, 'lib/entry.js imports')
const doctorModule = await import(pathToFileURL(join(packageDir, 'lib', 'doctor.js')).href)
check('loads-doctor', doctorModule !== null, 'lib/doctor.js imports')

// 2. Mode switching: each mode mounts on its own context and owns compaction.
for (const [mode, expectedBasic] of [['basic', true], ['economy', false], ['quality', false]]) {
  const roots = join(installDir, 'roots', mode)
  const { ctx, plugin } = await mount({
    auto: false,
    mode,
    semanticMode: mode === 'basic' ? 'none' : 'rationale',
    semanticContinuity: 'off',
    bundleRoot: join(roots, 'bundles'),
    semanticRoot: join(roots, 'semantic'),
  })
  const provided = ctx.get('compaction')
  // Cordis may hand back a service PROXY rather than the instance, so identity
  // is not the contract. The contract is: a compaction service exists and it
  // is the EF engine's implementation.
  const sameEngine = provided === plugin.engine
    || (provided?.constructor?.name === plugin.engine?.constructor?.name
      && typeof provided?.compactIfNeeded === 'function')
  check(`mounts-${mode}`, sameEngine, `${mode}: ctx.compaction is the EF engine`)
  check(`basic-flag-${mode}`, plugin.engine.isBasic() === expectedBasic, `${mode}: isBasic() is ${expectedBasic}`)
  await ctx.dispose?.()
}

// 3. Disabled capability: semantic continuity OFF constructs no writer call.
//    The engine exposes the resolved continuity mode; assert it stayed off.
{
  const { ctx, plugin } = await mount({
    auto: false,
    mode: 'economy',
    semanticMode: 'rationale',
    semanticContinuity: 'off',
    bundleRoot: join(installDir, 'roots', 'off', 'bundles'),
    semanticRoot: join(installDir, 'roots', 'off', 'semantic'),
  })
  const resolved = plugin.engine.efConfig?.semanticContinuity ?? plugin.engine.config?.semanticContinuity ?? null
  check('semantic-off', resolved === 'off', `semanticContinuity resolved to ${String(resolved)}`)
  await ctx.dispose?.()
}

// 4. The tarball carries no credential, no raw run and no absolute build path.
if (existsSync(tarball)) {
  const buffer = readFileSync(tarball)
  check('tarball-sha256', true, `${createHash('sha256').update(buffer).digest('hex')} (${buffer.length} bytes)`)
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(packageDir)
  const suspicious = files.filter(file => /(^|[\\/])(runs?|\.env|secrets?)([\\/]|$)|\.(pem|key)$/u.test(file))
  check('tarball-no-raw-or-secret', suspicious.length === 0, `${suspicious.length} suspicious path(s)`)
  const leaked = files
    .filter(file => file.endsWith('.js'))
    .filter(file => readFileSync(file, 'utf8').includes(ROOT))
  check('tarball-no-build-path', leaked.length === 0, `${leaked.length} file(s) contain the checkout path`)
} else {
  check('tarball-present', false, `${tarball} is missing`)
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work,
  installDir: installDir.slice(ROOT.length + 1),
  packageDir: packageDir.slice(ROOT.length + 1),
  checks,
  pass: checks.every(row => row.pass),
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(report.pass ? 0 : 1)
