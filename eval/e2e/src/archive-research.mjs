#!/usr/bin/env node
/**
 * EF-R1 WP0 — preserve the E2E research assets as one verifiable package.
 *
 * ## What this protects, and what it does not
 *
 * The 96-cell round left two different kinds of asset:
 *
 *   - TRACKED evidence: the frozen manifests, results, analyses and the
 *     per-cell SHA-256 index under `eval/e2e/out/`;
 *   - IGNORED evidence: the raw run directories under `eval/e2e/runs/`
 *     (reports, request structures, trajectories, archives), which git does
 *     not carry.
 *
 * A `git clone` therefore loses the raw runs, and the tracked index only says
 * what their hashes were. This script copies both into a standalone directory,
 * hashes every file, and records the git state that produced them.
 *
 * It deliberately does NOT rewrite, redact or re-analyse any historical file.
 * A credential found by the scan is reported and the archive is marked unsafe
 * to share; the historical bytes stay as they are.
 *
 * ## Why a separate archive and not more tracked JSON
 *
 * The raw runs are ~13 MB and contain the full request structure. Committing
 * them would put model prompts and workspace paths into the repository's
 * permanent history. The package is external; a small pointer
 * (`eval/e2e/out/research-archive.json`) records where it is and what it hashed
 * to, so a reader of the repository can verify a copy they were given without
 * the repository carrying the copy itself.
 *
 *   node eval/e2e/src/archive-research.mjs --out ../EF_E2E_RESEARCH_ARCHIVE
 *
 * @module eval/e2e/src/archive-research
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT_DIR = join(ROOT, 'eval', 'e2e', 'out')

const argv = process.argv.slice(2)
const value = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const ARCHIVE = resolve(value('out') ?? join(ROOT, '..', 'EF_E2E_RESEARCH_ARCHIVE'))

const CAMPAIGNS = [
  'e2e-core-1',
  'e2e-pilot-1',
  'e2e-t5-retest-1',
  'e2e-recall-1',
  'e2e-guard-smoke-1',
  'e2e-index-1',
]

const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256File = path => sha256Bytes(readFileSync(path))
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
const gitText = (...args) => {
  try {
    return git(...args).trim()
  } catch (error) {
    return `(failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`
  }
}
const toPosix = path => path.replace(/\\/gu, '/')

/**
 * Credential patterns. Narrow on purpose: a broad `secret` matcher flags every
 * document that says the word and buries a real key.
 */
const CREDENTIAL_PATTERNS = [
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/gu },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu },
  { name: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu },
  { name: 'private-key-block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/gu },
  { name: 'bearer-value', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gu },
  { name: 'named-secret', re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/giu },
  { name: 'provider-env', re: /\b(?:deepseek|openai|anthropic|zhipu|moonshot)_api_key\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/giu },
  { name: 'url-credentials', re: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[A-Za-z0-9.-]+/gu },
]

/** Files we do not scan as text. The bundle is compressed repository history. */
const BINARY_EXTENSIONS = new Set(['.bundle', '.gz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'])

function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, base))
    else if (entry.isFile()) out.push({ path, rel: toPosix(relative(base, path)) })
  }
  return out
}

function scan(files) {
  const credentials = []
  const absolutePaths = new Map()
  const proxyValues = new Map()
  let textFiles = 0
  let skippedBinary = 0
  for (const file of files) {
    if (BINARY_EXTENSIONS.has(file.rel.slice(file.rel.lastIndexOf('.')))) {
      skippedBinary += 1
      continue
    }
    let text
    try {
      text = readFileSync(file.path, 'utf8')
    } catch {
      skippedBinary += 1
      continue
    }
    textFiles += 1
    for (const pattern of CREDENTIAL_PATTERNS) {
      pattern.re.lastIndex = 0
      const match = pattern.re.exec(text)
      if (match !== null) {
        credentials.push({
          file: file.rel,
          pattern: pattern.name,
          // Never reproduce the value; the offset is enough to find it.
          offset: match.index,
        })
      }
    }
    const absolute = text.match(/\b[A-Za-z]:[\\/](?:[^\s"'<>|]+)/gu) ?? []
    if (absolute.length > 0) absolutePaths.set(file.rel, absolute.length)
    const proxy = text.match(/127\.0\.0\.1:\d{2,5}/gu) ?? []
    if (proxy.length > 0) proxyValues.set(file.rel, [...new Set(proxy)].join(','))
  }
  return {
    scannedTextFiles: textFiles,
    skippedBinaryFiles: skippedBinary,
    credentials,
    credentialsFound: credentials.length,
    absolutePathFiles: [...absolutePaths.entries()].map(([file, count]) => ({ file, count })),
    proxyValues: [...proxyValues.entries()].map(([file, values]) => ({ file, values })),
    note: 'Credential values are never copied into this report; only the file and byte offset are recorded. Absolute local paths are reported as informational: they identify this machine, not a secret.',
  }
}

function dshVersions() {
  const versions = {}
  for (const name of ['dsh-agent-loop', 'dsh-agent', 'dsh-tools', 'dsh-llm', 'dsh-session', 'dsh-compaction', 'dsh-compaction-basic']) {
    try {
      versions[name] = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8')).version
    } catch {
      versions[name] = null
    }
  }
  return versions
}

function experimentIndex() {
  const campaigns = []
  for (const campaign of CAMPAIGNS) {
    const resultsPath = join(OUT_DIR, `results-${campaign}.json`)
    const analysisPath = join(OUT_DIR, `analysis-${campaign}.json`)
    const indexPath = join(OUT_DIR, `evidence-index-${campaign}.json`)
    if (!existsSync(resultsPath)) continue
    const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
    const analysis = existsSync(analysisPath) ? JSON.parse(readFileSync(analysisPath, 'utf8')) : undefined
    const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : undefined
    const cells = (results.results ?? []).map(cell => {
      const dir = join(ROOT, 'eval', 'e2e', 'runs', campaign, cell.cellId)
      const reportPath = join(dir, 'report.json')
      const requestsPath = join(dir, 'raw', 'requests.json')
      const trajectoryPath = join(dir, 'raw', 'trajectory.json')
      return {
        cellId: cell.cellId,
        status: cell.status,
        arm: cell.cell?.arm ?? null,
        template: cell.cell?.task ?? null,
        block: cell.cell?.block ?? null,
        checkerPassed: cell.checker === true,
        compactions: cell.compactions ?? null,
        requests: cell.usage?.requests ?? null,
        reportSha256: existsSync(reportPath) ? sha256File(reportPath) : null,
        requestsSha256: existsSync(requestsPath) ? sha256File(requestsPath) : null,
        trajectorySha256: existsSync(trajectoryPath) ? sha256File(trajectoryPath) : null,
      }
    })
    campaigns.push({
      campaign,
      designCells: results.planned ?? 0,
      executed: results.executed ?? null,
      status: results.status ?? null,
      stopReason: results.stopReason ?? null,
      budgetUsed: results.budget?.used ?? null,
      analysisVerdict: analysis?.aggregates?.verdict ?? analysis?.verdict ?? null,
      evidenceIndexRows: index?.cells?.length ?? index?.rows?.length ?? null,
      cells,
    })
  }
  return campaigns
}

function main() {
  if (existsSync(ARCHIVE) && readdirSync(ARCHIVE).length > 0) {
    process.stderr.write(`archive-research: ${ARCHIVE} already exists and is not empty; refusing to overwrite historical evidence\n`)
    process.exit(2)
  }
  mkdirSync(ARCHIVE, { recursive: true })

  // 1. Copy the raw runs, the tracked evidence and the frozen task inputs.
  const copies = [
    ['eval/e2e/runs', 'raw-runs'],
    ['eval/e2e/out', 'evidence'],
    ['eval/e2e/tasks', 'tasks'],
  ]
  for (const [from, to] of copies) {
    const source = join(ROOT, from)
    if (!existsSync(source)) continue
    cpSync(source, join(ARCHIVE, to), {
      recursive: true,
      dereference: false,
      // The repository-side pointer is generated FROM this package; copying it
      // in would freeze a stale self-reference into the archive.
      filter: path => !path.endsWith('research-archive.json'),
    })
  }

  // 2. Git: a bundle of the kept line plus every archive tag, and a snapshot.
  const gitDir = join(ARCHIVE, 'git')
  mkdirSync(gitDir, { recursive: true })
  const bundle = join(gitDir, 'ef-c1-evaluation-foundation.bundle')
  let bundleCreated = false
  try {
    execFileSync('git', [
      'bundle', 'create', bundle,
      'chore/ef-c1-evaluation-foundation',
      '--tags',
    ], { cwd: ROOT, stdio: 'pipe' })
    bundleCreated = true
  } catch (error) {
    process.stderr.write(`archive-research: git bundle failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  const bundleVerify = bundleCreated
    ? gitText('bundle', 'verify', bundle)
    : '(not created)'
  const tags = gitText('tag', '-l', 'archive/*', '--format=%(refname:short) %(objectname) %(subject)')
  const snapshot = [
    `worktree          ${ROOT}`,
    `head              ${gitText('rev-parse', 'HEAD')}`,
    `headSubject       ${gitText('log', '-1', '--format=%s')}`,
    `branch            ${gitText('branch', '--show-current') || '(detached)'}`,
    `remote            ${gitText('remote', 'get-url', 'origin').replace(/\/\/[^/@]+@/u, '//<redacted>@')}`,
    '',
    'archive tags:',
    tags,
    '',
    'worktrees:',
    gitText('worktree', 'list', '--porcelain'),
    '',
    'status:',
    gitText('status', '--porcelain'),
    '',
    'recent commits:',
    gitText('log', '--oneline', '-30'),
    '',
    'bundle verify:',
    bundleVerify,
    '',
  ].join('\n')
  writeFileSync(join(ARCHIVE, 'git-snapshot.txt'), snapshot, 'utf8')

  // 3. Environment: versions and the route identity the manifests already
  //    recorded. No environment-variable dump and no key material.
  const manifests = CAMPAIGNS
    .map(campaign => join(OUT_DIR, `manifest-${campaign}.json`))
    .filter(path => existsSync(path))
    .map(path => JSON.parse(readFileSync(path, 'utf8')))
  const environment = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    npm: (() => {
      try {
        return execFileSync('npm', ['--version'], { cwd: ROOT, encoding: 'utf8' }).trim()
      } catch {
        return null
      }
    })(),
    platform: process.platform,
    arch: process.arch,
    release: execFileSync('node', ['-p', 'require("os").release()'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    dsh: dshVersions(),
    route: manifests.length === 0 ? null : {
      origin: manifests[0].route?.origin ?? null,
      baseUrl: manifests[0].route?.baseUrl ?? null,
      headerNames: manifests[0].route?.headers ?? [],
      model: manifests[0].model ?? null,
    },
    envDumpIncluded: false,
    note: 'Only version and route identity are recorded. The API key is resolved at run time and was never written to a manifest or a report.',
  }
  mkdirSync(join(ARCHIVE, 'environment'), { recursive: true })
  writeFileSync(join(ARCHIVE, 'environment', 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`, 'utf8')

  // 4. Experiment index: campaigns, cells and per-file hashes.
  const experiments = experimentIndex()
  writeFileSync(join(ARCHIVE, 'experiment-index.json'), `${JSON.stringify({
    schemaVersion: 1,
    work: 'EF-E2E',
    campaigns: experiments,
  }, null, 2)}\n`, 'utf8')

  // 5. Scan every copied text file. The git bundle is compressed and is the
  //    repository's own history; it is recorded but not pattern-scanned.
  const files = walk(ARCHIVE)
  const scanResult = scan(files)
  writeFileSync(join(ARCHIVE, 'scan.json'), `${JSON.stringify(scanResult, null, 2)}\n`, 'utf8')

  // 6. Manifest, then SHA256SUMS over everything except itself.
  const all = walk(ARCHIVE).filter(file => file.rel !== 'SHA256SUMS')
  const totalBytes = all.reduce((sum, file) => sum + statSync(file.path).size, 0)
  const manifest = {
    schemaVersion: 1,
    work: 'EF-R1 WP0',
    generatedAt: new Date().toISOString(),
    archiveRoot: toPosix(ARCHIVE),
    source: {
      worktree: toPosix(ROOT),
      commit: gitText('rev-parse', 'HEAD'),
      branch: gitText('branch', '--show-current') || '(detached)',
      dirtyAwayFromEvidence: gitText('status', '--porcelain'),
    },
    contents: {
      rawRuns: 'raw-runs/',
      trackedEvidence: 'evidence/',
      tasks: 'tasks/',
      gitBundle: bundleCreated ? 'git/ef-c1-evaluation-foundation.bundle' : null,
      gitSnapshot: 'git-snapshot.txt',
      experimentIndex: 'experiment-index.json',
      environment: 'environment/environment.json',
      scan: 'scan.json',
    },
    counts: {
      // `all` was walked before this file existed; +1 counts the manifest
      // itself. `bytes` is the copied payload, before this manifest was added.
      files: all.length + 1,
      bytes: totalBytes,
      campaigns: experiments.length,
      cells: experiments.reduce((sum, campaign) => sum + campaign.cells.length, 0),
    },
    bundle: bundleCreated ? {
      path: 'git/ef-c1-evaluation-foundation.bundle',
      sha256: sha256File(bundle),
      bytes: statSync(bundle).size,
      verify: bundleVerify,
    } : null,
    scan: {
      credentialsFound: scanResult.credentialsFound,
      absolutePathFiles: scanResult.absolutePathFiles.length,
      proxyFiles: scanResult.proxyValues.length,
      safeToShare: scanResult.credentialsFound === 0,
    },
    provenance: 'Copied verbatim from the worktree; no historical file was modified. The manifest of each campaign records the commit it evaluated, which may precede the archive commit.',
  }
  writeFileSync(join(ARCHIVE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const sums = walk(ARCHIVE)
    .filter(file => file.rel !== 'SHA256SUMS')
    .sort((left, right) => left.rel.localeCompare(right.rel))
    .map(file => `${sha256File(file.path)}  ${file.rel}`)
    .join('\n')
  writeFileSync(join(ARCHIVE, 'SHA256SUMS'), `${sums}\n`, 'utf8')

  // 7. A small repository-side pointer. The archive itself stays external.
  const pointer = {
    schemaVersion: 1,
    work: 'EF-R1 WP0',
    archiveRoot: toPosix(ARCHIVE),
    archiveManifestSha256: sha256File(join(ARCHIVE, 'manifest.json')),
    archiveSumsSha256: sha256File(join(ARCHIVE, 'SHA256SUMS')),
    archiveBundleSha256: manifest.bundle?.sha256 ?? null,
    commit: manifest.source.commit,
    counts: manifest.counts,
    scan: manifest.scan,
    note: 'The archive is external to the repository. Verify a copy with `sha256sum -c SHA256SUMS` at its root.',
  }
  writeFileSync(join(OUT_DIR, 'research-archive.json'), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

  process.stdout.write(`archive: ${ARCHIVE}\n`)
  process.stdout.write(`files ${manifest.counts.files}, bytes ${manifest.counts.bytes}, cells ${manifest.counts.cells}\n`)
  process.stdout.write(`bundle: ${manifest.bundle === null ? 'not created' : `${manifest.bundle.bytes} bytes ${manifest.bundle.sha256.slice(0, 16)}`}\n`)
  process.stdout.write(`scan: credentials=${manifest.scan.credentialsFound} absolutePathFiles=${manifest.scan.absolutePathFiles} safeToShare=${manifest.scan.safeToShare}\n`)
  if (!manifest.scan.safeToShare) process.exit(1)
}

main()
