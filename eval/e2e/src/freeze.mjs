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
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()

/**
 * The tracked source tree, minus the two paths a freeze necessarily adds
 * afterwards: the manifest/results directory and the authorization.
 *
 * `git ls-tree` does not accept `:(exclude)` pathspec magic, so the filter is
 * applied to its output. The line format is `<mode> <type> <sha>\t<path>`.
 */
function sourceTreeDigest() {
  const lines = git('ls-tree', '-r', 'HEAD').split('\n').filter(line => {
    const path = line.slice(line.indexOf('\t') + 1)
    return path !== 'eval/e2e/authorization.json' && !path.startsWith('eval/e2e/out/')
  })
  return sha256(lines.join('\n'))
}

/**
 * The FOLLOW-UP envelope for the index experiment.
 *
 * The original 72-cell envelope is exhausted (72/72). This is a separate,
 * deliberately smaller grant for the campaign the user authorized after the
 * variance attribution: 24 cells, 720 requests, 6M input, 250k output, 3h.
 * It is NOT an extension of the original envelope; the two are accounted
 * separately and the original remains closed.
 */
const FOLLOWUP_ENVELOPE = {
  continuationCells: 24,
  httpAttempts: 720,
  inputTokens: 6_000_000,
  outputTokens: 250_000,
  monetaryUsd: 25,
  wallClockMs: 3 * 60 * 60 * 1000,
  paidConcurrency: 1,
}

/**
 * The EF-R1 L×G pilot envelope, explicitly authorized by the user:
 * 24 cells, 800 requests, 4M input, 150k output, 2h, concurrency 1.
 *
 * It is a SEPARATE grant, like the index follow-up: the original 72-cell and
 * the 24-cell index envelopes are closed and are not charged again.
 */
const LG_PILOT_ENVELOPE = {
  continuationCells: 32,
  httpAttempts: 800,
  inputTokens: 4_000_000,
  outputTokens: 150_000,
  monetaryUsd: 10,
  wallClockMs: 2 * 60 * 60 * 1000,
  paidConcurrency: 1,
}

/**
 * Repair grant for the prompt pilot after a stale lib/ made every E0-P cell
 * fail at construction with zero requests. This is a separate, small grant; the
 * first pilot's E0-P rows are invalid and are not used.
 */
const PROMPT_REPAIR_ENVELOPE = {
  continuationCells: 8,
  httpAttempts: 200,
  inputTokens: 1_000_000,
  outputTokens: 40_000,
  monetaryUsd: 5,
  wallClockMs: 30 * 60 * 1000,
  paidConcurrency: 2,
}

/**
 * The follow-up grant: fold normally and re-render the active request into the
 * checkpoint body (`rerenderActiveRequest`). This is a separate 8-cell grant;
 * the span-start prototype above is not reused.
 */
const PROMPT_RERENDER_ENVELOPE = {
  continuationCells: 8,
  httpAttempts: 200,
  inputTokens: 1_000_000,
  outputTokens: 40_000,
  monetaryUsd: 5,
  wallClockMs: 30 * 60 * 1000,
  paidConcurrency: 2,
}

/**
 * The confirmatory L×G design: 120 cells + 18 fault reserve. This is the
 * envelope the pilot gate authorized; it is separate from both earlier grants.
 */
const LG_CONFIRM_ENVELOPE = {
  continuationCells: 138,
  httpAttempts: 4_200,
  inputTokens: 30_000_000,
  outputTokens: 1_200_000,
  monetaryUsd: 25,
  wallClockMs: 6 * 60 * 60 * 1000,
  paidConcurrency: 2,
}

/** The original envelope's hard caps (work package §2.3). Not a target. */
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
  requests: 24,
  inputTokens: 250_000,
  outputTokens: 20_000,
  wallClockMs: 300_000,
}

function armRotation(templateIndex, replicate) {
  const arms = ['B0', 'E0', 'E1']
  const shift = (templateIndex + replicate) % arms.length
  return [...arms.slice(shift), ...arms.slice(0, shift)]
}

async function main() {
  const campaign = value('campaign', 'e2e-core-1')
  // The watchdog heartbeat is appended by a local process, carries no
  // measurement, and cannot be frozen. Everything else must be committed.
  const dirty = git('status', '--porcelain')
    .split('\n')
    // Git on Windows can leave a CR on each line; trim it before comparing.
    .map(line => line.replace(/\r$/u, ''))
    .filter(line => line.length > 0 && line.slice(3) !== 'ef-phase7-logs/watchdog.heartbeat')
  if (dirty.length > 0) {
    process.stderr.write('e2e freeze: the worktree is dirty; commit or restore before freezing\n')
    process.stderr.write(`${dirty}\n`)
    process.exit(2)
  }

  const taskFiles = (await readdir(TASKS)).filter(name => /^T\d+[A-Za-z]?-s\d\.json$/u.test(name)).sort()
  const tasks = []
  for (const name of taskFiles) {
    const text = await readFile(join(TASKS, name), 'utf8')
    const task = JSON.parse(text)
    tasks.push({ file: `eval/e2e/tasks/${name}`, id: task.id, template: task.template, seed: task.seed, digest: sha256(text) })
  }

  const templates = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']
  const cells = []
  const pilot = argv.includes('--pilot')
  const retest = argv.includes('--retest')
  const recall = argv.includes('--recall')
  const guardSmoke = argv.includes('--guard-smoke')
  const index = argv.includes('--index')
  const lgPilot = argv.includes('--lg-pilot')
  const lgConfirm = argv.includes('--lg-confirm')
  const t10Retest = argv.includes('--t10-retest')
  const promptPilot = argv.includes('--prompt-pilot')
  const promptRepair = argv.includes('--prompt-repair')
  const promptRerender = argv.includes('--prompt-rerender')
  if (promptRerender) {
    // Fold normally and copy the active request into the body.
    for (const task of ['T9-s1', 'T9-s2', 'T10-s1', 'T10-s2']) {
      for (const arm of ['E0', 'E0-R']) {
        cells.push({ block: 'prompt-rerender', task, arm, replicate: 1 })
      }
    }
  } else if (promptRepair) {
    // Same 8 cells as the prompt pilot, after `npm run build` made the config
    // key visible to the built plugin. The first pilot's E0-P rows are invalid.
    for (const task of ['T9-s1', 'T9-s2', 'T10-s1', 'T10-s2']) {
      for (const arm of ['E0', 'E0-P']) {
        cells.push({ block: 'prompt-repair', task, arm, replicate: 1 })
      }
    }
  } else if (promptPilot) {
    // Prompt-protection pilot under the LAST 8 cells of the confirm reserve:
    // T9/T10 (where the confirm lost the request), both seeds, E0 vs E0-P.
    for (const task of ['T9-s1', 'T9-s2', 'T10-s1', 'T10-s2']) {
      for (const arm of ['E0', 'E0-P']) {
        cells.push({ block: 'prompt-pilot', task, arm, replicate: 1 })
      }
    }
  } else if (t10Retest) {
    // The T10 fault retest, under the CONFIRM envelope's remaining 18-cell
    // reserve. The fixture was ambiguous in the confirm; this uses the fixed
    // time-based version. One replicate per arm: 10 cells, a fault retest,
    // not a powered estimate.
    const arms = ['E0', 'E0-L', 'E0-G', 'E0-LG', 'E1']
    for (const seed of [1, 2]) {
      const shift = seed % arms.length
      const ordered = [...arms.slice(shift), ...arms.slice(0, shift)]
      for (const arm of ordered) {
        cells.push({
          block: 't10-retest',
          task: `T10-s${seed}`,
          arm,
          replicate: 1,
          guard: arm === 'E0-G' || arm === 'E0-LG',
        })
      }
    }
  } else if (lgConfirm) {
    // The frozen design: 6 templates × 2 seeds × 2 replicates × 5 arms = 120
    // cells. E1 is a reference arm and is never pooled into the 2×2.
    const arms = ['E0', 'E0-L', 'E0-G', 'E0-LG', 'E1']
    const order = ['T2', 'T4', 'T7', 'T8', 'T9', 'T10']
    for (const [templateIndex, template] of order.entries()) {
      for (const seed of [1, 2]) {
        for (const replicate of [1, 2]) {
          const shift = (templateIndex + seed + replicate) % arms.length
          const ordered = [...arms.slice(shift), ...arms.slice(0, shift)]
          for (const arm of ordered) {
            cells.push({
              block: 'lg-confirm',
              task: `${template}-s${seed}`,
              arm,
              replicate,
              guard: arm === 'E0-G' || arm === 'E0-LG',
            })
          }
        }
      }
    }
  } else if (lgPilot) {
    // EF-R1 L×G pilot: T2 (the known write failure), T9 (cross-file) and T10
    // (multi-revision), both seeds, four arms, one paired replicate. Arm order
    // rotates by task so provider drift cannot masquerade as an arm effect.
    const arms = ['E0', 'E0-L', 'E0-G', 'E0-LG']
    for (const [taskIndex, task] of ['T2-s1', 'T2-s2', 'T9-s1', 'T9-s2', 'T10-s1', 'T10-s2'].entries()) {
      const shift = taskIndex % arms.length
      const ordered = [...arms.slice(shift), ...arms.slice(0, shift)]
      for (const arm of ordered) {
        cells.push({
          block: 'lg-pilot',
          task,
          arm,
          replicate: 1,
          // The guard is a CELL property: it is a harness/runtime check, not
          // an EF feature and not part of the arm's config.
          guard: arm === 'E0-G' || arm === 'E0-LG',
        })
      }
    }
  } else if (index) {
    // Folded-span-index experiment under the SEPARATE follow-up envelope:
    // E0 (bare), E0i (index), E0ai (index + retrieval instruction), on the two
    // tasks whose failures the trajectory analysis attributed to the missing
    // retrieval cue. Two seeds x two replicates = 24 cells.
    for (const replicate of [1, 2]) {
      for (const task of ['T2-s1', 'T2-s2', 'T4-s1', 'T4-s2']) {
        for (const arm of ['E0', 'E0i', 'E0ai']) {
          cells.push({ block: 'index', task, arm, replicate })
        }
      }
    }
  } else if (guardSmoke) {
    // The ONE remaining continuation cell under the ORIGINAL envelope (71/72
    // used). A single live demonstration of the completion guard, labelled n=1.
    cells.push({ block: 'guard-smoke', task: 'T2-s1', arm: 'E0', replicate: 0, guard: true })
  } else if (recall) {
    // Recall-affordance experiment: E0 vs E0+affordance on the memory-sensitive
    // tasks, contemporaneous, the same seeds.
    for (const task of ['T2-s1', 'T2-s2', 'T4-s1', 'T4-s2', 'T5B-s1', 'T5B-s2']) {
      for (const arm of ['E0', 'E0a']) {
        cells.push({ block: 'recall', task, arm, replicate: Number(task.slice(-1)) })
      }
    }
  } else if (retest) {
    // Fault-retest reserve: T5b (the explicit-shape version) across the four
    // arms, both seeds. The original T5 cells keep their recorded outcome.
    for (const seed of [1, 2]) {
      for (const arm of ['B0', 'E0', 'E1', 'S']) {
        cells.push({ block: 'retest', task: `T5B-s${seed}`, arm, replicate: seed })
      }
    }
  } else if (pilot) {
    // Semantic pilot: three memory-sensitive tasks × {E1, S-safe} × 2
    // replicates. The E1 rows run in the SAME batch as S, not reused from the
    // core campaign, so the pairing is contemporaneous.
    for (const task of ['T2-s1', 'T3-s1', 'T5-s1']) {
      for (const replicate of [1, 2]) {
        for (const arm of ['E1', 'S']) {
          cells.push({ block: 'pilot', task, arm, replicate })
        }
      }
    }
  } else {
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

  // The ORIGINAL envelope is cumulative across its phases. The FOLLOW-UP
  // envelope (`--index`) is separate and starts from zero: the original is
  // closed at 72/72, and its spend must not be charged twice.
  const envelope = promptRerender ? PROMPT_RERENDER_ENVELOPE : promptRepair ? PROMPT_REPAIR_ENVELOPE : promptPilot ? LG_CONFIRM_ENVELOPE : t10Retest ? LG_CONFIRM_ENVELOPE : lgConfirm ? LG_CONFIRM_ENVELOPE : lgPilot ? LG_PILOT_ENVELOPE : index ? FOLLOWUP_ENVELOPE : ENVELOPE
  let priorUsage = { requests: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 }
  let priorCells = 0
  if (promptPilot) {
    // The prompt pilot and the T10 retest both draw on the confirm grant; the
    // manifest must reflect BOTH prior campaigns.
    for (const priorCampaign of ['e2e-lg-confirm-1', 'e2e-t10-retest-1']) {
      const priorPath = join(OUT, `results-${priorCampaign}.json`)
      if (!existsSync(priorPath)) {
        process.stderr.write(`e2e freeze: the prompt pilot needs ${priorCampaign} for the reserve accounting\n`)
        process.exit(2)
      }
      const prior = JSON.parse(await readFile(priorPath, 'utf8'))
      priorUsage.requests += prior.budget.used.requests
      priorUsage.inputTokens += prior.budget.used.inputTokens
      priorUsage.outputTokens += prior.budget.used.outputTokens
      priorUsage.wallClockMs += prior.budget.used.wallClockMs
      priorCells += prior.executed
    }
  } else if (t10Retest) {
    // The retest draws on the CONFIRM grant's reserve, so its manifest limits
    // are what remains after the 120 confirm cells - not a fresh 30M tokens.
    const priorPath = join(OUT, 'results-e2e-lg-confirm-1.json')
    if (!existsSync(priorPath)) {
      process.stderr.write('e2e freeze: the T10 retest needs results-e2e-lg-confirm-1.json for the reserve accounting\n')
      process.exit(2)
    }
    const prior = JSON.parse(await readFile(priorPath, 'utf8'))
    priorUsage.requests += prior.budget.used.requests
    priorUsage.inputTokens += prior.budget.used.inputTokens
    priorUsage.outputTokens += prior.budget.used.outputTokens
    priorUsage.wallClockMs += prior.budget.used.wallClockMs
    priorCells += prior.executed
  } else if (!index && !lgPilot && !lgConfirm && !promptRepair && !promptRerender) {
    for (const priorCampaign of ['e2e-core-1', 'e2e-pilot-1', 'e2e-t5-retest-1', 'e2e-recall-1', 'e2e-guard-smoke-1']) {
      const path = join(OUT, `results-${priorCampaign}.json`)
      if (!existsSync(path)) continue
      const prior = JSON.parse(await readFile(path, 'utf8'))
      priorUsage.requests += prior.budget.used.requests
      priorUsage.inputTokens += prior.budget.used.inputTokens
      priorUsage.outputTokens += prior.budget.used.outputTokens
      priorUsage.wallClockMs += prior.budget.used.wallClockMs
      priorCells += prior.executed
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
      sourceTreeDigest: sourceTreeDigest(),
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
      index: cells.filter(cell => cell.block === 'index').length,
      lgPilot: cells.filter(cell => cell.block === 'lg-pilot').length,
      lgConfirm: cells.filter(cell => cell.block === 'lg-confirm').length,
      t10Retest: cells.filter(cell => cell.block === 't10-retest').length,
      promptPilot: cells.filter(cell => cell.block === 'prompt-pilot').length,
      promptRepair: cells.filter(cell => cell.block === 'prompt-repair').length,
      promptRerender: cells.filter(cell => cell.block === 'prompt-rerender').length,
      replicates: 'r1 = seed 1, r2 = seed 2; arms rotate inside each replicate block',
      scorerVersion: 1,
      operationalBudgetTokens: 'per task (16384); an operational budget, not the model window',
      maxSteps: 8,
      outputTokensPerRequest: 1024,
      cachePolicy: 'no arm pre-warms or clears a provider cache; cross-cell prefix reuse is recorded, not controlled',
    },
    perCell: PER_CELL,
    limits: {
      httpAttempts: envelope.httpAttempts - priorUsage.requests,
      inputTokens: envelope.inputTokens - priorUsage.inputTokens,
      outputTokens: envelope.outputTokens - priorUsage.outputTokens,
      wallClockMs: envelope.wallClockMs - priorUsage.wallClockMs,
      monetaryUsd: envelope.monetaryUsd,
      monetaryNote: 'no per-token price is verifiable for this local route; token and request caps are the enforced bound',
      continuationCells: envelope.continuationCells - priorCells,
      paidConcurrency: envelope.paidConcurrency,
    },
    authorizationEnvelope: {
      reference: promptRerender
        ? 'Separate 8-cell grant for the active-request re-render pilot'
        : promptRepair
        ? 'Repair grant for the prompt-protection pilot after a stale lib/'
        : promptPilot
        ? 'Prompt-protection pilot under the last 8 cells of the confirm reserve'
        : t10Retest
        ? 'T10 fault retest under the remaining 18-cell reserve of the lg-confirm envelope'
        : lgConfirm
        ? 'EF-R1 120-cell confirmatory L×G design under a separate 138-cell envelope'
        : lgPilot
        ? 'Separate EF-R1 32-cell L×G pilot envelope, explicitly authorized by the user'
        : index
          ? 'Separate 24-cell follow-up envelope for the folded-span-index campaign'
          : 'EF-E2E work package §2.3-2.4 (delegated manifest freeze)',
      statement: promptRerender
        ? 'the span-start prototype disabled folding; this separate 8-cell grant tests folding normally while copying the active request into the checkpoint'
        : promptRepair
        ? 'the first prompt pilot failed at construction because lib/ predated the config key; this separate 8-cell grant reruns it after a build'
        : promptPilot
        ? 'the confirm lost the active request in 44/120 cells; this 8-cell pilot tests the opt-in leaf rule inside the remaining reserve, with both prior campaigns subtracted'
        : t10Retest
        ? 'the confirm exposed an ambiguous T10 fixture; this 10-cell retest uses the fixed task inside the remaining reserve of the confirm envelope, with the prior usage subtracted'
        : lgConfirm
        ? 'the pilot gate was positive; the user authorized the staged plan, and the agent froze the 120-cell design inside a 138-cell cap (4,200 requests, 30M input, 1.2M output, 6h, concurrency 2)'
        : lgPilot
        ? 'both earlier envelopes are closed; the user authorized this 24-cell pilot inside a 32-cell cap (800 requests, 4M input, 150k output, 2h, concurrency 1), and the agent froze the concrete manifest'
        : index
          ? 'the original 72-cell envelope is closed; the user authorized this separate follow-up design, and the agent froze the concrete manifest inside it'
          : 'the user authorized this execution envelope; the agent freezes the concrete manifest',
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
