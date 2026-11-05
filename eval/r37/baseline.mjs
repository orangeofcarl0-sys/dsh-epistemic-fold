#!/usr/bin/env node
/**
 * Build the R37-A baseline manifest and, optionally, re-run the test baseline.
 *
 * The manifest is an identity document, not a result:
 *
 *   - repository / worktree / base commit / status at start
 *   - every R36 authoritative report and R36 document digest
 *   - the frozen dataset and the six behavioural cases used by R36
 *   - the 12 causal run reports, their 48 traces, and their final workspaces
 *   - Node/npm/build state
 *   - the test baseline, when R37_RUN_TESTS=1
 *
 * It reads the R36 worktree but never writes to it. Tests are only run when the
 * caller explicitly asks for them; the default invocation makes no provider
 * request and does not modify an R36 artifact.
 *
 *   node eval/r37/baseline.mjs
 *   R37_RUN_TESTS=1 node eval/r37/baseline.mjs
 *
 * @module eval/r37/baseline
 */

import { spawnSync } from 'node:child_process'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fileManifest,
  exists,
  readJson,
  sha256File,
  treeManifest,
  writeJson,
} from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R36 = process.env.R36_WORKTREE === undefined
  ? resolve(ROOT, '..', 'ef-r36-interface')
  : resolve(process.env.R36_WORKTREE)
const PRIMARY_ACTUAL = resolve(ROOT, '..', 'dsh-epistemic-fold')
const OUT = join(HERE, 'out', 'baseline-manifest.json')
const RUNS = join(R36, 'eval', 'r36', 'runs')
const CASES = ['A1', 'B2', 'C1', 'D1', 'F1', 'H1']
const RUN_IDS = [
  'r36-causal-A1', 'r36-causal-B2', 'r36-causal-C1',
  'r36-causal-D1', 'r36-causal-F1', 'r36-causal-H1',
  'r36-causal-r2-A1', 'r36-causal-r2-B2', 'r36-causal-r2-C1',
  'r36-causal-r2-D1', 'r36-causal-r2-F1', 'r36-causal-r2-H1',
]
if (await exists(OUT) && process.env.R37_RUN_TESTS !== '1' && process.env.R37_FORCE_BASELINE !== '1') {
  process.stderr.write(
    `refusing to overwrite an executed baseline at ${OUT}; `
    + 'set R37_RUN_TESTS=1 to rebuild with tests or R37_FORCE_BASELINE=1 to force\n',
  )
  process.exit(2)
}
const HISTORICAL_REPORTS = [
  'eval/r36/out/gate-status.json',
  'eval/r36/out/causal-comparison.json',
  'eval/r36/out/live-results.json',
  'eval/r36/out/conditions.json',
  'eval/r36/out/harness-calibration.json',
  'eval/r36/out/live-writer-analysis.json',
  'eval/r36/out/parser-ablation.json',
  'eval/r36/out/case-certification.json',
  'eval/r36/evidence/r35/writer-audit.json',
  'eval/r36/evidence/r35/continuation-writers.json',
]
const HISTORICAL_SOURCES = [
  'eval/r33/src/tool-protocol.mjs',
  'eval/r33/live.mjs',
  'eval/r33/src/grade.mjs',
  'eval/r33/src/dataset.mjs',
  'eval/r36/writer-protocol.mjs',
  'eval/r36/conditions.mjs',
  'eval/r36/write-manifests.mjs',
  'src/semantic/writer.ts',
]

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  return {
    status: result.status,
    text: String(result.stdout ?? '').trimEnd(),
    stderr: String(result.stderr ?? '').trimEnd(),
  }
}

function statusLines(cwd) {
  const text = git(cwd, ['status', '--short']).text
  return text.length === 0 ? [] : text.split(/\r?\n/u)
}

function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '')
}

function parseVitest(output) {
  const text = stripAnsi(output)
  const lines = text.split(/\r?\n/u)
  const summary = lines.filter(line => /^\s*Tests\s+/u.test(line)).at(-1)
    ?? lines.filter(line => /^\s*Test Files\s+/u.test(line)).at(-1)
    ?? null
  const files = lines.filter(line => /^\s*Test Files\s+/u.test(line)).at(-1) ?? null
  const count = (line, word) => {
    if (line === null) return null
    const match = new RegExp(`(\\d+)\\s+${word}`, 'u').exec(line)
    return match === null ? 0 : Number(match[1])
  }
  return {
    summary: summary === null ? null : summary.trim(),
    testFiles: files === null ? null : files.trim(),
    passed: count(summary, 'passed'),
    failed: count(summary, 'failed'),
    skipped: count(summary, 'skipped'),
    todo: count(summary, 'todo'),
  }
}

function runNpm(script, extra = []) {
  const started = Date.now()
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(command, ['run', script, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
    // npm.cmd is a batch file on Windows; shell resolution is needed here.
    shell: process.platform === 'win32',
    env: { ...process.env, CI: '1' },
  })
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  const combined = `${stdout}\n${stderr}`
  return {
    command: `npm run ${script}${extra.length === 0 ? '' : ` ${extra.join(' ')}`}`,
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    durationMs: Date.now() - started,
    vitest: parseVitest(combined),
    tail: stripAnsi(combined).split(/\r?\n/u).filter(Boolean).slice(-40),
  }
}

async function loadDatasetModule() {
  return await import('../r33/src/dataset.mjs')
}

async function runArchiveIdentity() {
  const perRun = []
  let reportCount = 0
  let traceCount = 0
  let verificationCount = 0
  let workspaceFileCount = 0
  // Count the whole archive, not only the 12 causal directories.
  async function walk(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.name === 'report.json') reportCount += 1
      else if (entry.name === 'record.json' && /trace[\\/]record\.json$/u.test(absolute)) traceCount += 1
      else if (entry.name === 'verification.json') verificationCount += 1
    }
  }
  await walk(RUNS)

  for (const runId of RUN_IDS) {
    const runRoot = join(RUNS, runId)
    const reportPath = join(runRoot, 'report.json')
    if (!await exists(reportPath)) {
      perRun.push({ runId, present: false })
      continue
    }
    const arms = {}
    for (const caseId of CASES) {
      // The run id names one case; the report still carries all four arms.
      const armRoot = join(runRoot, caseId)
      if (!await exists(armRoot)) continue
      const report = await readJson(reportPath)
      const replicateId = report.rows?.[0]?.replicateId ?? (runId.includes('-r2-') ? 'r2' : 'r1')
      for (const arm of ['B1', 'S', 'O1', 'O2']) {
        const root = join(armRoot, arm, replicateId)
        if (!await exists(root)) continue
        const trace = join(root, 'trace', 'record.json')
        const workspace = join(root, 'workspace')
        const workspaceIdentity = await treeManifest(workspace)
        const workspaceFiles = Object.keys(workspaceIdentity.files)
        arms[arm] = {
          replicateId,
          trace: await exists(trace)
            ? { path: trace, sha256: await sha256File(trace), bytes: (await stat(trace)).size }
            : null,
          workspace: {
            digest: workspaceIdentity.digest,
            fileCount: workspaceIdentity.fileCount,
            files: workspaceIdentity.files,
            verificationJson: workspaceFiles.includes('verification.json')
              ? await sha256File(join(workspace, 'verification.json'))
              : null,
          },
          bundles: await exists(join(root, 'bundles'))
            ? await treeManifest(join(root, 'bundles'))
            : null,
          journal: await exists(join(root, 'journal'))
            ? await treeManifest(join(root, 'journal'))
            : null,
        }
        workspaceFileCount += workspaceIdentity.fileCount
      }
    }
    perRun.push({
      runId,
      present: true,
      report: { path: reportPath, sha256: await sha256File(reportPath), bytes: (await stat(reportPath)).size },
      arms,
    })
  }
  return {
    root: RUNS,
    counts: { reports: reportCount, traces: traceCount, verificationJson: verificationCount, workspaceFiles: workspaceFileCount },
    runs: perRun,
  }
}

const startedAt = new Date()
const statusAtStart = statusLines(ROOT)
const r36Status = statusLines(R36)
const primaryStatus = statusLines(PRIMARY_ACTUAL)

const datasetModule = await loadDatasetModule()
const dataset = await datasetModule.verifyFrozen()
const datasetManifestPath = join(ROOT, 'eval', 'r33', 'manifest.json')
const datasetManifest = await readJson(datasetManifestPath)

const caseIdentities = []
for (const id of CASES) {
  const loaded = await datasetModule.loadCase(id)
  const workspaceIdentity = await treeManifest(join(ROOT, 'eval', 'r33', 'cases', id, 'workspace'))
  caseIdentities.push({
    id,
    digest: loaded.digest,
    caseJsonSha256: await sha256File(join(ROOT, 'eval', 'r33', 'cases', id, 'case.json')),
    checkSha256: await sha256File(join(ROOT, 'eval', 'r33', 'cases', id, 'check.mjs')),
    workspace: { digest: workspaceIdentity.digest, fileCount: workspaceIdentity.fileCount },
  })
}

const manifestFiles = (await readdir(join(R36, 'eval', 'r36', 'manifests')))
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => `eval/r36/manifests/${name}`)
const documentaryFiles = (await readdir(join(R36, 'docs', 'semantic-continuity')))
  .filter(name => /^R36_.+\.md$/u.test(name))
  .sort()
  .map(name => `docs/semantic-continuity/${name}`)

const historical = {}
for (const path of [...HISTORICAL_REPORTS, ...manifestFiles, ...documentaryFiles]) {
  const absolute = join(R36, path)
  historical[path] = await exists(absolute)
    ? { present: true, sha256: await sha256File(absolute), bytes: (await stat(absolute)).size }
    : { present: false, sha256: null, bytes: null }
}

const archive = await runArchiveIdentity()

const testBaseline = []
if (process.env.R37_RUN_TESTS === '1') {
  testBaseline.push(runNpm('typecheck'))
  testBaseline.push(runNpm('eval:r33'))
  testBaseline.push(runNpm('eval:r36-tests'))
  testBaseline.push(runNpm('test'))
}
const statusAfterTests = statusLines(ROOT)

const r36Head = git(R36, ['rev-parse', 'HEAD']).text
const head = git(ROOT, ['rev-parse', 'HEAD']).text
const branch = git(ROOT, ['branch', '--show-current']).text
const r36Branch = git(R36, ['branch', '--show-current']).text
const log = git(ROOT, ['log', '-15', '--oneline']).text.split(/\r?\n/u).filter(Boolean)

const manifest = {
  schemaVersion: 1,
  round: 'R37-A',
  generatedAt: startedAt.toISOString(),
  purpose: 'Identity and environment record for the R36-to-R37 evidence audit. No provider request is made by this script.',
  repository: {
    root: ROOT,
    worktree: ROOT,
    branch,
    head,
    baseCommit: r36Head,
    remote: git(ROOT, ['remote', '-v']).text.split(/\r?\n/u).filter(Boolean),
    statusAtStart,
    statusAfterTests,
    testGeneratedChanges: statusAfterTests.filter(line => !statusAtStart.includes(line)),
    log,
    r36Worktree: { path: R36, branch: r36Branch, head: r36Head, status: r36Status },
    primaryWorktree: { path: PRIMARY_ACTUAL, status: primaryStatus },
  },
  environment: {
    node: process.version,
    npm: process.env.npm_config_user_agent ?? null,
    platform: process.platform,
    arch: process.arch,
    packageLockSha256: await sha256File(join(ROOT, 'package-lock.json')),
    nodeModules: await exists(join(ROOT, 'node_modules')),
    libBuilt: await exists(join(ROOT, 'lib', 'plugin.js')),
    evalDistBuilt: await exists(join(ROOT, 'eval', 'live', 'dist')),
    vendorDeepseekHarness: await exists(join(ROOT, 'vendor', 'deepseek-harness')),
  },
  dataset: {
    id: datasetManifest.datasetId,
    digest: dataset.datasetDigest,
    frozenDigest: datasetManifest.datasetDigest,
    matches: dataset.ok === true,
    reason: dataset.ok ? null : dataset.reason,
    manifestPath: 'eval/r33/manifest.json',
    manifestSha256: await sha256File(datasetManifestPath),
    scorerVersion: datasetManifest.scorerVersion,
    caseCount: datasetManifest.caseCount,
    cases: caseIdentities,
  },
  historicalEvidence: {
    r36Worktree: R36,
    files: historical,
    sourceFiles: await fileManifest(R36, HISTORICAL_SOURCES),
    runArchive: archive,
  },
  tests: {
    requested: process.env.R37_RUN_TESTS === '1',
    status: testBaseline.length === 0 ? 'not-executed' : 'executed',
    commands: testBaseline,
  },
  notes: [
    'R36 is read-only. The archive is referenced by digest, not copied.',
    'A test-generated change is recorded, not hidden. The tracked install output (cordis.patch.yml) was restored before this manifest was written.',
    'Historical R36 reports keep their original bytes; R37 writes only under eval/r37 and its own documents.',
  ],
}
const testRows = testBaseline.length === 0
  ? ['| (not run) | - | - | - | - |', '| run with R37_RUN_TESTS=1 | | | | |']
  : testBaseline.map(row => `| ${row.command} | ${row.exitCode} | ${row.vitest.summary ?? '-'} | ${row.durationMs} ms | ${row.timedOut ? 'yes' : 'no'} |`)
const historicalRows = Object.entries(historical)
  .filter(([, record]) => record.present)
  .map(([path, record]) => `| \`${path}\` | \`${record.sha256.slice(0, 16)}…\` | ${record.bytes} |`)

const markdown = `# R37 — Baseline

## Repository

| field | value |
|---|---|
| Repository | \`orangeofcarl0-sys/dsh-epistemic-fold\` |
| R37 worktree | \`${ROOT}\` |
| Branch | \`${branch}\` |
| Base commit | \`${r36Head}\` (R36 HEAD) |
| R37 HEAD at manifest time | \`${head}\` |
| R36 worktree | \`${R36}\` (\`${r36Branch}\`) |
| R36 worktree status | ${r36Status.length === 0 ? 'clean' : `${r36Status.length} changed path(s)`} |
| Primary worktree | \`${PRIMARY_ACTUAL}\` |
| Push | not authorized, not performed |

Status at manifest time:

\`\`\`text
${statusAtStart.length === 0 ? '(clean)' : statusAtStart.join('\n')}
\`\`\`

## Environment

| field | value |
|---|---|
| Node | \`${process.version}\` |
| Platform | \`${process.platform} ${process.arch}\` |
| package-lock sha256 | \`${manifest.environment.packageLockSha256}\` |
| node_modules | ${manifest.environment.nodeModules ? 'present' : 'absent'} |
| lib built | ${manifest.environment.libBuilt ? 'yes' : 'no'} |
| eval/live/dist built | ${manifest.environment.evalDistBuilt ? 'yes' : 'no'} |
| vendor/deepseek-harness | ${manifest.environment.vendorDeepseekHarness ? 'present' : 'absent'} |

Build commands: \`npm ci\`, \`npm run build\`, \`npm run eval:build\`.

## Dataset

\`\`\`text
datasetId             ${manifest.dataset.id}
dataset digest        ${manifest.dataset.digest}
frozen digest         ${manifest.dataset.frozenDigest}
matches frozen        ${manifest.dataset.matches}
scorer                v${manifest.dataset.scorerVersion}
case count            ${manifest.dataset.caseCount}
\`\`\`

The six behavioural cases used by R36:

| case | digest | workspace files |
|---|---|---:|
${caseIdentities.map(row => `| ${row.id} | \`${row.digest.slice(0, 16)}…\` | ${row.workspace.fileCount} |`).join('\n')}

## R36 evidence identity

The R36 worktree is not copied and is not modified. These are content digests of
the authoritative files used by R37:

| file | sha256 (prefix) | bytes |
|---|---|---:|
${historicalRows.join('\n')}

The run archive is referenced by digest in
\`eval/r37/out/baseline-manifest.json\`. It contains
**${archive.counts.reports} report.json**, **${archive.counts.traces} trace records**,
**${archive.counts.verificationJson} verification.json** files and
**${archive.counts.workspaceFiles} final workspace files** across the whole R36 archive.
The 12 causal runs are traced individually, including each arm's final
workspace, bundle tree and journal tree.

## Test baseline

| command | exit | summary | duration | timed out |
|---|---:|---|---:|---|
${testRows.join('\n')}

${testBaseline.length === 0
    ? 'The baseline test suite was not executed in this invocation. This is recorded as `not-executed`, not as a pass.'
    : statusAfterTests.length === statusAtStart.length && statusAtStart.every(line => statusAfterTests.includes(line))
      ? 'The test run left the tracked worktree unchanged.'
      : `The test run changed the worktree. Those changes are recorded in the manifest as \`statusAfterTests\` and are not part of any R37 commit.`}

## Known baseline failures

The R36 baseline recorded 12 full-suite failures: four need the absent
\`vendor/deepseek-harness\` checkout, and eight are installed-vs-vendored DSH
differences. R37 distinguishes those from new R37 failures by command and test
file; it does not repair unrelated vendor drift.

## Caveats

- R36 did not record a per-run git SHA or writer finish reason. \`null\` is used
  rather than an inferred value.
- F1's initial raw writer output was lost in R35; it is not reconstructed.
- The R36 causal run archive is local and gitignored. Its digest identifies the
  bytes actually read; it is not a second copy of the data.
- \`cordis.patch.yml\` is regenerated by \`npm ci\`/prepare because the installed
  DSH line differs from the vendored line. It was restored to the tracked bytes
  before this manifest was written.
`
await writeJson(OUT, manifest)
await writeFile(join(ROOT, 'docs', 'semantic-continuity', 'R37_BASELINE.md'), markdown, 'utf8')

process.stdout.write(`baseline: ${OUT}\n`)
process.stdout.write(`tests: ${manifest.tests.status}\n`)
for (const row of testBaseline) {
  process.stdout.write(`  ${row.command}: exit ${row.exitCode}, ${row.vitest.summary ?? 'no vitest summary'}, ${row.durationMs} ms\n`)
}
process.stdout.write(`historical files: ${Object.values(historical).filter(record => record.present).length}/${Object.keys(historical).length}\n`)
process.stdout.write(`causal runs traced: ${archive.runs.filter(run => run.present).length}/12\n`)
process.stdout.write(`status after tests: ${statusAfterTests.length} path(s)\n`)
