#!/usr/bin/env node
/**
 * EF-C0 WP0 — read-only repository, change and evidence audit.
 *
 * Produces the machine-readable half of WP0:
 *
 *   docs/convergence/data/git-stage-map.json
 *   docs/convergence/data/change-inventory.json
 *   docs/convergence/data/artifact-manifest.json
 *
 * READ-ONLY with respect to history: this script runs `git` inspection
 * commands and hashes files. It never writes to `.git`, never checks out,
 * never fetches, and never modifies a tracked file. The only writes are the
 * three JSON artifacts above.
 *
 * The classification is by PATH and, where the path is ambiguous, by reading
 * the file's first lines — never by commit message. A commit message is a
 * claim; the diff is the evidence.
 *
 * @module eval/c0/git-audit
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DATA = join(ROOT, 'docs', 'convergence', 'data')
const OUT = join(HERE, 'out')

const R37B_ARCHIVE = 'F:/Codex_Work_Space/DSH plugin/ef-r37c-evidence-archive/r37b-raw-evidence-20261106.tar.gz'
const R37B_SHA = 'de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92'
const R37B_BYTES = 3_763_962

/** Run one git command and return trimmed stdout. Read-only by construction. */
function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

/** Run git and return stdout lines, dropping blanks. */
function gitLines(...args) {
  const text = git(...args)
  return text.length === 0 ? [] : text.split(/\r?\n/)
}

function short(sha) {
  return typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : String(sha)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function bytesOf(path) {
  return statSync(path).size
}

// The audit is ABOUT the R38 baseline, not about whatever the convergence
// worktree has committed since. Pinning the target to the verified R38 ref keeps
// the stage map and change inventory stable across EF-C0's own commits.
const HEAD = git('rev-parse', 'origin/rc38-mechanism-validation')
const WORKTREE_HEAD = git('rev-parse', 'HEAD')
const BRANCH = git('branch', '--show-current')
const MAIN = git('rev-parse', 'origin/main')
const LOCAL_MAIN = git('rev-parse', 'main')

// ---------------------------------------------------------------------------
// 1. Stage map
// ---------------------------------------------------------------------------

/**
 * The research line's stage tips, in order. Every entry after `main` was
 * verified as a descendant of its predecessor before this table is used.
 */
const CHAIN = [
  { stage: 'main', branch: 'origin/main', tip: MAIN },
  { stage: 'rc30', branch: 'rc30-semantic-continuity' },
  { stage: 'rc31', branch: 'rc31-persistence-lifecycle' },
  { stage: 'rc32', branch: 'rc32-semantic-integrity' },
  { stage: 'rc33', branch: 'rc33-semantic-behavior' },
  { stage: 'rc34', branch: 'rc34-live-causal-pilot' },
  { stage: 'rc35', branch: 'rc35-real-semantic-evaluation' },
  { stage: 'rc36', branch: 'rc36-semantic-interface' },
  { stage: 'rc37ab', branch: 'rc37-semantic-action' },
  { stage: 'rc37c', branch: 'rc37c-measurement-closure' },
  { stage: 'rc37d', branch: 'rc37d-operational-completion' },
  { stage: 'rc38', branch: 'rc38-mechanism-validation' },
]

/** Paths that make a stage's diff a PRODUCTION change rather than eval/docs. */
function stageProductionPaths(from, to) {
  return gitLines('diff', '--name-only', `${from}..${to}`).filter(path => path.startsWith('src/'))
}

function stageEvidencePaths(from, to) {
  return gitLines('diff', '--name-only', `${from}..${to}`)
    .filter(path => path.startsWith('eval/') && (path.includes('/out/') || path.includes('/evidence/')))
}

/** Map a commit SHA to the worktree that has it checked out, if any. */
const worktreeByHead = new Map()
{
  let current = null
  for (const line of gitLines('worktree', 'list', '--porcelain')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    else if (line.startsWith('HEAD ') && current !== null) {
      worktreeByHead.set(line.slice('HEAD '.length), current)
      current = null
    }
  }
}

const stageRows = []
let previousTip = null
for (const entry of CHAIN) {
  const tip = entry.tip ?? git('rev-parse', entry.branch)
  const parent = git('rev-parse', `${tip}^`)
  const base = previousTip === null ? tip : git('rev-list', '--reverse', `${previousTip}..${tip}`).split(/\r?\n/)[0]
  const commits = previousTip === null ? 1 : Number(git('rev-list', '--count', `${previousTip}..${tip}`))
  const remote = gitLines('for-each-ref', '--format=%(refname)', `refs/remotes/origin/${entry.branch}`)
  const local = gitLines('for-each-ref', '--format=%(refname)', `refs/heads/${entry.branch}`)
  const worktreePath = worktreeByHead.get(tip) ?? null
  stageRows.push({
    stage: entry.stage,
    branch: entry.branch,
    baseSha: base,
    baseShort: short(base),
    finalSha: tip,
    finalShort: short(tip),
    parentSha: parent,
    parentShort: short(parent),
    commits,
    remoteRef: remote.length > 0 ? remote[0] : null,
    localRef: local.length > 0 ? local[0] : null,
    worktree: worktreePath,
    productionPaths: previousTip === null ? [] : stageProductionPaths(previousTip, tip),
    evidencePaths: previousTip === null ? [] : stageEvidencePaths(previousTip, tip),
  })
  previousTip = tip
}
stageRows[0].kind = 'baseline'

// RC29 is a SIDE line: it is not an ancestor of R38. Record it separately
// rather than inserting it into a chain it does not belong to.
const RC29_TIP = git('rev-parse', 'rc29-working-set-observer')
const RC29_BASE = git('merge-base', 'main', 'rc29-working-set-observer')
const rc29Row = {
  stage: 'rc29',
  branch: 'rc29-working-set-observer',
  baseSha: RC29_BASE,
  baseShort: short(RC29_BASE),
  finalSha: RC29_TIP,
  finalShort: short(RC29_TIP),
  parentSha: git('rev-parse', `${RC29_TIP}^`),
  commits: Number(git('rev-list', '--count', `${RC29_BASE}..${RC29_TIP}`)),
  remoteRef: 'refs/remotes/origin/rc29-working-set-observer',
  localRef: 'refs/heads/rc29-working-set-observer',
  ancestorOfR38: false,
  note:
    `Side line branched from ${short(RC29_BASE)} (the LOCAL main), not from the released `
    + 'origin/main line. Its work is not an ancestor of R38 and must not be described as a '
    + 'predecessor stage of it.',
}

const ancestorChecks = []
for (let index = 1; index < CHAIN.length; index += 1) {
  const from = CHAIN[index - 1]
  const to = CHAIN[index]
  const fromSha = from.tip ?? git('rev-parse', from.branch)
  const toSha = to.tip ?? git('rev-parse', to.branch)
  const ok = (() => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', fromSha, toSha], { cwd: ROOT, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()
  ancestorChecks.push({ from: from.stage, to: to.stage, ancestor: ok })
}

const mergeBase = git('merge-base', 'origin/main', 'origin/rc38-mechanism-validation')
const leftRight = git('rev-list', '--left-right', '--count', 'origin/main...origin/rc38-mechanism-validation')
  .split(/\s+/).map(Number)

const tags = gitLines('for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags').map(line => {
  const [ref, object] = line.split(' ')
  const peeled = git('rev-parse', `${ref}^{commit}`)
  return { ref, object, commit: peeled, inMain: (() => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', peeled, MAIN], { cwd: ROOT, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })() }
})

const stageMap = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work: 'EF-C0-WP0',
  repository: 'orangeofcarl0-sys/dsh-epistemic-fold',
  head: { sha: HEAD, short: short(HEAD), branch: 'rc38-mechanism-validation' },
  audit: { worktreeHead: WORKTREE_HEAD, worktreeHeadShort: short(WORKTREE_HEAD), branch: BRANCH },
  main: {
    remote: { ref: 'origin/main', sha: MAIN, short: short(MAIN) },
    local: { ref: 'main', sha: LOCAL_MAIN, short: short(LOCAL_MAIN) },
    // The local main is NOT the released line: it is behind the remote by many
    // commits and carries one commit of its own. Recorded, not repaired.
    localDiverged: LOCAL_MAIN !== MAIN,
  },
  ancestry: {
    mergeBase,
    mergeBaseShort: short(mergeBase),
    mainToR38: { ahead: leftRight[1] ?? null, behind: leftRight[0] ?? null },
    checks: ancestorChecks,
  },
  stages: stageRows,
  sideLines: [rc29Row],
  tags,
  refsWithoutRemote: stageRows
    .filter(row => row.remoteRef === null && row.stage !== 'main')
    .map(row => row.branch),
}

// ---------------------------------------------------------------------------
// 2. Change inventory (main -> HEAD)
// ---------------------------------------------------------------------------

const CATEGORY_RULES = [
  // Evidence directories come FIRST: a result JSON inside eval/r38/out is
  // generated evidence, not part of the round's harness code.
  [/^eval\/.*\/(out|evidence|frozen|reports|corpora)\//, 'generated-evidence'],
  [/^src\/semantic\//, 'semantic-continuity'],
  [/^src\/config\//, 'configuration'],
  [/^src\/policy\//, 'compaction-policy'],
  [/^src\/(checkpoint|recall)\//, 'checkpoint-archive-recall'],
  [/^src\/state\//, 'deterministic-state'],
  [/^src\/(status|plugin|index|entry|types|compat|doctor)\.ts$/, 'core-runtime'],
  [/^src\/basic\//, 'basic-compat'],
  [/^src\/fold\//, 'core-runtime'],
  [/^src\//, 'core-runtime'],
  [/^eval\/(memory|tau2)\//, 'research-only-prototype'],
  [/^eval\/r3[1-8][a-z]?\//, 'research-evaluation'],
  [/^eval\//, 'evaluation-harness'],
  [/^tests\//, 'tests'],
  [/^docs\//, 'documentation'],
  [/^scripts\//, 'configuration-build'],
  [/^\.github\//, 'configuration-build'],
  [/^(package\.json|package-lock\.json|tsconfig.*\.json|vitest\.config\.ts|cordis\.patch\.yml|\.gitignore|\.npmignore|eslint.*|\.editorconfig)$/, 'configuration-build'],
  [/\.(md)$/, 'documentation'],
]

function categoryOf(path) {
  for (const [pattern, category] of CATEGORY_RULES) if (pattern.test(path)) return category
  return 'other'
}

const numstat = new Map()
for (const line of gitLines('diff', '--numstat', '--no-renames', `${MAIN}..${HEAD}`)) {
  const [added, deleted, ...rest] = line.split('\t')
  if (rest.length === 0) continue
  const path = rest.join('\t')
  numstat.set(path, {
    added: added === '-' ? null : Number(added),
    deleted: deleted === '-' ? null : Number(deleted),
  })
}

const statusOf = new Map()
for (const line of gitLines('diff', '--name-status', '--no-renames', `${MAIN}..${HEAD}`)) {
  const [status, ...rest] = line.split('\t')
  if (rest.length === 0) continue
  statusOf.set(rest.join('\t'), status)
}

const files = [...statusOf.keys()].sort().map(path => {
  const counts = numstat.get(path) ?? { added: null, deleted: null }
  return {
    path,
    status: statusOf.get(path),
    category: categoryOf(path),
    added: counts.added,
    deleted: counts.deleted,
    bytes: existsSync(join(ROOT, path)) ? bytesOf(join(ROOT, path)) : 0,
  }
})

const categoryTotals = {}
for (const file of files) {
  const row = categoryTotals[file.category] ?? { files: 0, added: 0, deleted: 0, bytes: 0 }
  row.files += 1
  row.added += file.added ?? 0
  row.deleted += file.deleted ?? 0
  row.bytes += file.bytes
  categoryTotals[file.category] = row
}

// The R38 stage's own production surface, kept separate because the brief asks
// for it explicitly.
const r38Base = git('rev-parse', 'rc37d-operational-completion')
const r38Production = gitLines('diff', '--name-status', `${r38Base}..${HEAD}`)
  .filter(line => line.split('\t')[1]?.startsWith('src/'))
  .map(line => {
    const [status, path] = line.split('\t')
    return { path, status, category: categoryOf(path) }
  })

// Shared evaluation-runner changes: harness files outside the round-owned
// directories. A round's own runner is that round's; a change to `eval/live`
// or a top-level eval module is a change the NEXT round inherits.
const SHARED_EVAL_DIR = /^eval\/(live|src|scenarios|workloads|cache|policy-replay|real-task|lhtb|bridge)\//
const TOP_LEVEL_EVAL = /^eval\/[^/]+\.(mjs|ts)$/
const sharedRunnerChanges = files
  .filter(file => SHARED_EVAL_DIR.test(file.path) || TOP_LEVEL_EVAL.test(file.path))
  .map(file => file.path)

const changeInventory = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work: 'EF-C0-WP0',
  range: { from: MAIN, fromShort: short(MAIN), to: HEAD, toShort: short(HEAD) },
  summary: {
    files: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
    trackedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  },
  categories: categoryTotals,
  r38Production,
  sharedRunnerChanges,
  files,
  method:
    'Category is assigned by path (and by reading the file where the path is ambiguous), '
    + 'never by commit message. Renames are reported as add+delete because the inventory '
    + 'is a path census, not a similarity analysis.',
}

// ---------------------------------------------------------------------------
// 3. Artifact / evidence manifest
// ---------------------------------------------------------------------------

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, predicate, out)
    else if (predicate(full)) out.push(full)
  }
  return out
}

const evidenceFiles = [
  // `eval/c0` is this audit's own output; including it would make the manifest
  // depend on a previous run of itself.
  ...walk(join(ROOT, 'eval'), path => path.endsWith('.json') && !path.includes(`${sep}c0${sep}out${sep}`)),
  ...walk(join(ROOT, 'docs', 'semantic-continuity'), path => path.endsWith('.md')),
].sort()

const artifacts = evidenceFiles.map(path => {
  const rel = relative(ROOT, path).split(sep).join('/')
  const tracked = (() => {
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: ROOT, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()
  return {
    path: rel,
    bytes: bytesOf(path),
    sha256: sha256File(path),
    tracked,
    kind: rel.startsWith('docs/') ? 'document' : 'evidence-json',
  }
})

const historicalDigests = JSON.parse(readFileSync(join(ROOT, 'eval', 'r38', 'out', 'baseline-manifest.json'), 'utf8'))
  .historicalEvidence.digests

const digestChecks = Object.entries(historicalDigests).map(([path, expected]) => {
  const full = join(ROOT, path)
  const actual = existsSync(full) ? sha256File(full) : null
  return { path, expected, actual, match: actual === expected }
})

const archiveCheck = existsSync(R37B_ARCHIVE)
  ? {
    path: R37B_ARCHIVE,
    outsideWorktree: true,
    bytes: bytesOf(R37B_ARCHIVE),
    sha256: sha256File(R37B_ARCHIVE),
    expectedSha256: R37B_SHA,
    expectedBytes: R37B_BYTES,
    match: sha256File(R37B_ARCHIVE) === R37B_SHA && bytesOf(R37B_ARCHIVE) === R37B_BYTES,
  }
  : { path: R37B_ARCHIVE, outsideWorktree: true, available: false, match: false }

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work: 'EF-C0-WP0',
  head: { sha: HEAD, short: short(HEAD) },
  counts: {
    artifacts: artifacts.length,
    evidenceJson: artifacts.filter(row => row.kind === 'evidence-json').length,
    documents: artifacts.filter(row => row.kind === 'document').length,
    totalBytes: artifacts.reduce((sum, row) => sum + row.bytes, 0),
  },
  externalArchive: archiveCheck,
  historicalDigests: { checks: digestChecks, allMatch: digestChecks.every(row => row.match) },
  reconstruction: {
    // These statements are DERIVED from what is on disk, not assumed.
    rawRunAvailable: archiveCheck.match === true,
    note:
      'The R37-B raw archive lives OUTSIDE the git worktree. The repository '
      + 'carries its SHA-256 and byte count, not its bytes. Any claim that the '
      + 'raw runs are reproducible from a clone alone is false.',
    scriptedAdapterEvidence: [
      'eval/r38/out/native-context-smoke.json',
      'eval/r37d/out/gates-r37d.json',
    ],
  },
  artifacts,
}

// ---------------------------------------------------------------------------
// 4. Write
// ---------------------------------------------------------------------------

mkdirSync(DATA, { recursive: true })
mkdirSync(OUT, { recursive: true })
for (const [name, value] of [
  ['git-stage-map.json', stageMap],
  ['change-inventory.json', changeInventory],
  ['artifact-manifest.json', manifest],
]) {
  writeFileSync(join(DATA, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
writeFileSync(join(OUT, 'git-audit.json'), `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  head: HEAD,
  stages: stageRows.length,
  sideLines: stageMap.sideLines.length,
  files: files.length,
  artifacts: artifacts.length,
  archiveMatch: archiveCheck.match,
  historicalDigestsMatch: manifest.historicalDigests.allMatch,
}, null, 2)}\n`, 'utf8')

process.stdout.write(
  `stages ${stageRows.length}; files ${files.length}; artifacts ${artifacts.length}; `
  + `archive ${archiveCheck.match}; digests ${manifest.historicalDigests.allMatch}\n`,
)
