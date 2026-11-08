#!/usr/bin/env node
/**
 * Freeze one campaign manifest.
 *
 * The manifest binds the code tree, the lockfile, the host fingerprint, every
 * task file, the arm configuration, the route identity, the cell order and the
 * budgets. It is written once and never refreshed to chase a later HEAD: the
 * run records its own `evaluatedCommit` separately.
 *
 *   node eval/e2e/src/freeze.mjs --campaign e2e-core-1
 *
 * @module eval/e2e/src/freeze
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARMS } from './host.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const TASKS = join(ROOT, 'eval', 'e2e', 'tasks')
const OUT = join(ROOT, 'eval', 'e2e', 'out')

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

/** The envelope's hard caps (work package §2.3). Not a target. */
const ENVELOPE = {
  continuationCells: 72,
  httpAttempts: 2200,
  inputTokens: 18_000_000,
  outputTokens: 1_000_000,
  monetaryUsd: 25,
  wallClockMs: 8 * 60 * 60 * 1000,
  paidConcurrency: 2,
}

const PER_CELL = {
  requests: 12,
  inputTokens: 120_000,
  outputTokens: 8_000,
  wallClockMs: 240_000,
}

function armRotation(templateIndex, replicate) {
  const arms = ['B0', 'E0', 'E1']
  const shift = (templateIndex + replicate) % arms.length
  return [...arms.slice(shift), ...arms.slice(0, shift)]
}

async function main() {
  const campaign = value('campaign', 'e2e-core-1')
  const dirty = git('status', '--porcelain')
  if (dirty.length > 0) {
    process.stderr.write('e2e freeze: the worktree is dirty; commit or restore before freezing\n')
    process.stderr.write(`${dirty}\n`)
    process.exit(2)
  }

  const taskFiles = (await readdir(TASKS)).filter(name => /^T\d-s\d\.json$/u.test(name)).sort()
  const tasks = []
  for (const name of taskFiles) {
    const text = await readFile(join(TASKS, name), 'utf8')
    const task = JSON.parse(text)
    tasks.push({ file: `eval/e2e/tasks/${name}`, id: task.id, template: task.template, seed: task.seed, digest: sha256(text) })
  }

  const templates = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']
  const cells = []
  // Calibration: one instance, three arms. It proves the pipeline and is
  // excluded from the core comparison.
  for (const arm of ['B0', 'E0', 'E1']) {
    cells.push({ block: 'calibration', task: 'T1-s1', arm, replicate: 0 })
  }
  // Core: 6 templates × 2 seeds × 3 arms = 36. Replicate r1 uses seed 1, r2
  // uses seed 2; arms rotate inside each replicate block.
  for (const replicate of [1, 2]) {
    for (const [templateIndex, template] of templates.entries()) {
      for (const arm of armRotation(templateIndex, replicate)) {
        cells.push({ block: 'core', task: `${template}-s${replicate}`, arm, replicate })
      }
    }
  }

  const route = (await import('../../live/dist/zcode-config.js')).resolveLiveRoute({ model: 'deepseek-v4.1-flash' })
  if (route === undefined) {
    process.stderr.write('e2e freeze: no live route resolved\n')
    process.exit(2)
  }

  const dshVersions = {}
  for (const name of ['dsh-agent-loop', 'dsh-agent', 'dsh-tools', 'dsh-llm', 'dsh-session', 'dsh-compaction', 'dsh-compaction-basic']) {
    try {
      dshVersions[name] = JSON.parse(await readFile(join(ROOT, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8')).version
    } catch {
      dshVersions[name] = null
    }
  }

  const lock = await readFile(join(ROOT, 'package-lock.json'), 'utf8')
  const manifest = {
    schemaVersion: 1,
    campaign,
    frozenAt: new Date().toISOString(),
    work: 'EF-E2E',
    code: {
      evaluatedCommit: git('rev-parse', 'HEAD'),
      branch: git('branch', '--show-current') || '(detached)',
      worktreeClean: true,
      // The manifest and its authorization are committed AFTER the freeze, so
      // HEAD necessarily moves by one commit. The binding is the source tree
      // excluding eval/e2e/out, which no later evidence commit may change.
      sourceTreeDigest: sha256(git('ls-tree', '-r', 'HEAD', '--', '.',
        ':(exclude)eval/e2e/out', ':(exclude)eval/e2e/authorization.json')),
      lockSha256: sha256(lock),
      dsh: dshVersions,
    },
    model: 'deepseek-v4.1-flash',
    route: {
      origin: route.origin,
      baseUrl: route.baseUrl,
      headers: Object.keys(route.headers ?? {}),
      note: 'API key is resolved at run time and never written to the manifest or a report',
    },
    arms: ARMS,
    tasks,
    cells,
    design: {
      calibration: cells.filter(cell => cell.block === 'calibration').length,
      core: cells.filter(cell => cell.block === 'core').length,
      replicates: 'r1 = seed 1, r2 = seed 2; arms rotate inside each replicate block',
      scorerVersion: 1,
      operationalBudgetTokens: 'per task (4096); an operational budget, not the model window',
      maxSteps: 8,
      outputTokensPerRequest: 1024,
      cachePolicy: 'no arm pre-warms or clears a provider cache; cross-cell prefix reuse is recorded, not controlled',
    },
    perCell: PER_CELL,
    limits: {
      httpAttempts: ENVELOPE.httpAttempts,
      inputTokens: ENVELOPE.inputTokens,
      outputTokens: ENVELOPE.outputTokens,
      wallClockMs: ENVELOPE.wallClockMs,
      monetaryUsd: ENVELOPE.monetaryUsd,
      monetaryNote: 'no per-token price is verifiable for this local route; token and request caps are the enforced bound',
      continuationCells: ENVELOPE.continuationCells,
      paidConcurrency: ENVELOPE.paidConcurrency,
    },
    authorizationEnvelope: {
      reference: 'EF-E2E work package §2.3-2.4 (delegated manifest freeze)',
      statement: 'the user authorized this execution envelope; the agent freezes the concrete manifest',
    },
  }

  await mkdir(OUT, { recursive: true })
  const path = join(OUT, `manifest-${campaign}.json`)
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(path, text, 'utf8')
  process.stdout.write(`wrote ${path.slice(ROOT.length + 1)}\n`)
  process.stdout.write(`sha256 ${sha256(text)}\n`)
  process.stdout.write(`cells ${cells.length} (calibration ${manifest.design.calibration}, core ${manifest.design.core})\n`)
}

await main()
