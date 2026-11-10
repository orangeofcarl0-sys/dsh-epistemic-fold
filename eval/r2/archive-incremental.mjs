#!/usr/bin/env node
/**
 * EF-R2 WP0 — incrementally archive the evidence produced after EF-R1.
 *
 * The EF-R1 package already carries 240 cells across 8 campaigns. Since then
 * four campaigns (50 cells) ran, plus one invalid first attempt whose only
 * meaning is that the harness ran against a stale `lib/`. Re-copying the
 * 240-cell package would duplicate 73 MB of historical raw runs and obscure
 * which bytes are new, so this script packages ONLY the new evidence and
 * points at the R1 package for the rest.
 *
 * It never rewrites a historical file. A credential found by the scan marks
 * the package unsafe to share; the bytes stay as they are.
 *
 *   node eval/r2/archive-incremental.mjs
 *
 * @module eval/r2/archive-incremental
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
const ROOT = resolve(HERE, '..', '..')
const OUT_DIR = join(ROOT, 'eval', 'e2e', 'out')
const R2_OUT = join(HERE, 'out')

const argv = process.argv.slice(2)
const value = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const ARCHIVE = resolve(value('out') ?? join(ROOT, '..', 'EF_R2_RESEARCH_ARCHIVE'))
const POINTER = resolve(value('pointer') ?? join(R2_OUT, 'research-archive-r2.json'))

/** Campaigns that produced valid evidence after the R1 package. */
const CAMPAIGNS = [
  'e2e-t10-retest-1',
  'e2e-prompt-pilot-2',
  'e2e-prompt-rerender-1',
  'e2e-prompt-confirm-1',
]

/**
 * The first prompt-repair attempt ran against a stale `lib/`; every E0-P cell
 * made zero requests. It is retained as negative evidence of the harness
 * defect, not as an experimental result.
 */
const INVALID = ['e2e-prompt-pilot-1']

const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256File = path => sha256Bytes(readFileSync(path))
const toPosix = path => path.replace(/\\/gu, '/')

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
const gitText = (...args) => {
  try {
    return git(...args).trim()
  } catch (error) {
    return `(failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`
  }
}

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
        credentials.push({ file: file.rel, pattern: pattern.name, offset: match.index })
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
    note: 'Credential values are never copied into this report; only the file and byte offset are recorded. Absolute local paths are informational: they identify this machine, not a secret.',
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

const EVIDENCE_SUFFIXES = ['results', 'analysis', 'manifest', 'authorization', 'evidence-index']

function experimentIndex() {
  const index = []
  for (const [names, valid] of [[CAMPAIGNS, true], [INVALID, false]]) {
    for (const campaign of names) {
      const resultsPath = join(OUT_DIR, `results-${campaign}.json`)
      if (!existsSync(resultsPath)) continue
      const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
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
      index.push({
        campaign,
        valid,
        status: valid ? 'valid' : 'invalid-stale-lib',
        note: valid ? null : 'First prompt-repair attempt: stale lib/, zero requests in every E0-P cell. Negative evidence of the harness defect, not an experimental result.',
        designCells: results.planned ?? 0,
        executed: results.executed ?? null,
        runStatus: results.status ?? null,
        stopReason: results.stopReason ?? null,
        budgetUsed: results.budget?.used ?? null,
        cells,
      })
    }
  }
  return index
}

function copyEvidence(campaigns, targetDir) {
  mkdirSync(join(ARCHIVE, targetDir), { recursive: true })
  for (const campaign of campaigns) {
    for (const suffix of EVIDENCE_SUFFIXES) {
      const name = `${suffix}-${campaign}.json`
      const source = join(OUT_DIR, name)
      if (!existsSync(source)) continue
      cpSync(source, join(ARCHIVE, targetDir, name))
    }
  }
}

function main() {
  if (existsSync(ARCHIVE) && readdirSync(ARCHIVE).length > 0) {
    process.stderr.write(`archive-incremental: ${ARCHIVE} already exists and is not empty; refusing to overwrite historical evidence\n`)
    process.exit(2)
  }
  mkdirSync(ARCHIVE, { recursive: true })

  // 1. The new raw runs only, keeping invalid evidence in its own namespace.
  for (const campaign of CAMPAIGNS) {
    const source = join(ROOT, 'eval', 'e2e', 'runs', campaign)
    if (existsSync(source)) cpSync(source, join(ARCHIVE, 'raw-runs', campaign), { recursive: true })
  }
  for (const campaign of INVALID) {
    const source = join(ROOT, 'eval', 'e2e', 'runs', campaign)
    if (existsSync(source)) cpSync(source, join(ARCHIVE, 'raw-runs-invalid', campaign), { recursive: true })
  }

  // 2. The campaign evidence files, and cross-campaign analyses that cover
  //    cells outside this package (stage-attribution spans all 12 campaigns).
  copyEvidence(CAMPAIGNS, 'evidence')
  copyEvidence(INVALID, 'evidence-invalid')
  mkdirSync(join(ARCHIVE, 'evidence', 'cross-campaign'), { recursive: true })
  for (const name of ['stage-attribution.json', 'stage-attribution.md']) {
    const source = join(OUT_DIR, name)
    if (existsSync(source)) cpSync(source, join(ARCHIVE, 'evidence', 'cross-campaign', name))
  }
  mkdirSync(join(ARCHIVE, 'parent'), { recursive: true })
  for (const name of ['research-archive-r1.json', 'archive-verification-r1.json', 'archive-verification-r1-copy.json']) {
    const source = join(ROOT, 'eval', 'ef-r1', 'out', name)
    if (existsSync(source)) cpSync(source, join(ARCHIVE, 'parent', name))
  }

  // 3. Frozen task inputs.
  if (existsSync(join(ROOT, 'eval', 'e2e', 'tasks'))) {
    cpSync(join(ROOT, 'eval', 'e2e', 'tasks'), join(ARCHIVE, 'tasks'), { recursive: true })
  }

  // 4. Git state: a bundle of the branch and a textual snapshot.
  const gitDir = join(ARCHIVE, 'git')
  mkdirSync(gitDir, { recursive: true })
  const bundle = join(gitDir, 'ef-c1-evaluation-foundation.bundle')
  let bundleCreated = false
  try {
    execFileSync('git', ['bundle', 'create', bundle, 'chore/ef-c1-evaluation-foundation', '--tags'], { cwd: ROOT, stdio: 'pipe' })
    bundleCreated = true
  } catch (error) {
    process.stderr.write(`archive-incremental: git bundle failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  const bundleVerify = bundleCreated ? gitText('bundle', 'verify', bundle) : '(not created)'
  const snapshot = [
    `worktree          ${ROOT}`,
    `head              ${gitText('rev-parse', 'HEAD')}`,
    `headSubject       ${gitText('log', '-1', '--format=%s')}`,
    `branch            ${gitText('branch', '--show-current') || '(detached)'}`,
    `remote            ${gitText('remote', 'get-url', 'origin').replace(/\/\/[^/@]+@/u, '//<redacted>@')}`,
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
    'parent archive:',
    existsSync(join(ARCHIVE, 'parent', 'research-archive-r1.json'))
      ? readFileSync(join(ARCHIVE, 'parent', 'research-archive-r1.json'), 'utf8').trim()
      : '(missing)',
    '',
  ].join('\n')
  writeFileSync(join(ARCHIVE, 'git-snapshot.txt'), snapshot, 'utf8')

  // 5. Environment identity. No environment dump and no key material.
  const manifestPath = join(OUT_DIR, 'manifest-e2e-prompt-confirm-1.json')
  const sampleManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined
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
    dsh: dshVersions(),
    route: sampleManifest === undefined ? null : {
      origin: sampleManifest.route?.origin ?? null,
      baseUrl: sampleManifest.route?.baseUrl ?? null,
      headerNames: sampleManifest.route?.headers ?? [],
      model: sampleManifest.model ?? null,
    },
    envDumpIncluded: false,
    note: 'Only version and route identity are recorded. The API key is resolved at run time and was never written to a manifest or a report.',
  }
  mkdirSync(join(ARCHIVE, 'environment'), { recursive: true })
  writeFileSync(join(ARCHIVE, 'environment', 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`, 'utf8')

  // 6. Experiment index, scoped to this package.
  const experiments = experimentIndex()
  const validCells = experiments.filter(campaign => campaign.valid).reduce((sum, campaign) => sum + campaign.cells.length, 0)
  const invalidCells = experiments.filter(campaign => !campaign.valid).reduce((sum, campaign) => sum + campaign.cells.length, 0)
  writeFileSync(join(ARCHIVE, 'experiment-index.json'), `${JSON.stringify({
    schemaVersion: 1,
    work: 'EF-R2 WP0',
    parent: 'EF_R1_RESEARCH_ARCHIVE',
    campaigns: experiments,
    counts: {
      validCampaigns: experiments.filter(campaign => campaign.valid).length,
      validCells,
      invalidCampaigns: experiments.filter(campaign => !campaign.valid).length,
      invalidCells,
    },
  }, null, 2)}\n`, 'utf8')

  // 7. Scan every copied text file. The git bundle is the repository's own
  //    history and stays un-scanned, exactly as in the R1 package.
  const files = walk(ARCHIVE)
  const scanResult = scan(files)
  writeFileSync(join(ARCHIVE, 'scan.json'), `${JSON.stringify(scanResult, null, 2)}\n`, 'utf8')

  // 8. Manifest and checksums.
  const all = walk(ARCHIVE).filter(file => file.rel !== 'SHA256SUMS')
  const totalBytes = all.reduce((sum, file) => sum + statSync(file.path).size, 0)
  const manifest = {
    schemaVersion: 1,
    work: 'EF-R2 WP0',
    generatedAt: new Date().toISOString(),
    archiveRoot: toPosix(ARCHIVE),
    scope: 'incremental: only the evidence produced after the EF-R1 240-cell package',
    parent: {
      pointer: 'parent/research-archive-r1.json',
      campaigns: 8,
      cells: 240,
      note: 'The R1 package remains the authority for the earlier 240 cells; this package does not duplicate them.',
    },
    source: {
      worktree: toPosix(ROOT),
      commit: gitText('rev-parse', 'HEAD'),
      branch: gitText('branch', '--show-current') || '(detached)',
      dirtyAwayFromEvidence: gitText('status', '--porcelain'),
    },
    contents: {
      rawRuns: 'raw-runs/',
      rawRunsInvalid: 'raw-runs-invalid/',
      trackedEvidence: 'evidence/',
      invalidEvidence: 'evidence-invalid/',
      tasks: 'tasks/',
      gitBundle: bundleCreated ? 'git/ef-c1-evaluation-foundation.bundle' : null,
      gitSnapshot: 'git-snapshot.txt',
      experimentIndex: 'experiment-index.json',
      environment: 'environment/environment.json',
      scan: 'scan.json',
    },
    counts: {
      files: all.length + 1,
      bytes: totalBytes,
      campaigns: experiments.filter(campaign => campaign.valid).length,
      cells: validCells,
      invalidCampaigns: experiments.filter(campaign => !campaign.valid).length,
      invalidCells,
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
    provenance: 'Copied verbatim from the worktree; no historical file was modified. The invalid first prompt-repair attempt is retained and labelled; it is not counted as an experimental cell.',
  }
  writeFileSync(join(ARCHIVE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const sums = walk(ARCHIVE)
    .filter(file => file.rel !== 'SHA256SUMS')
    .sort((left, right) => left.rel.localeCompare(right.rel))
    .map(file => `${sha256File(file.path)}  ${file.rel}`)
    .join('\n')
  writeFileSync(join(ARCHIVE, 'SHA256SUMS'), `${sums}\n`, 'utf8')

  // 9. Repository-side pointer; the package stays external.
  const pointer = {
    schemaVersion: 1,
    work: 'EF-R2 WP0',
    archiveRoot: toPosix(ARCHIVE),
    archiveManifestSha256: sha256File(join(ARCHIVE, 'manifest.json')),
    archiveSumsSha256: sha256File(join(ARCHIVE, 'SHA256SUMS')),
    archiveBundleSha256: manifest.bundle?.sha256 ?? null,
    commit: manifest.source.commit,
    counts: manifest.counts,
    scan: manifest.scan,
    parent: {
      pointer: 'eval/ef-r1/out/research-archive-r1.json',
      campaigns: 8,
      cells: 240,
    },
    note: 'Incremental package: 50 valid new cells plus 8 invalid negative-evidence cells. The R1 package remains the authority for the earlier 240 cells.',
  }
  mkdirSync(dirname(POINTER), { recursive: true })
  writeFileSync(POINTER, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

  process.stdout.write(`archive: ${ARCHIVE}\n`)
  process.stdout.write(`campaigns ${manifest.counts.campaigns} cells ${manifest.counts.cells} invalidCells ${manifest.counts.invalidCells} files ${manifest.counts.files} bytes ${manifest.counts.bytes}\n`)
  process.stdout.write(`bundle: ${manifest.bundle === null ? 'not created' : `${manifest.bundle.bytes} bytes ${manifest.bundle.sha256.slice(0, 16)}`}\n`)
  process.stdout.write(`scan: credentials=${manifest.scan.credentialsFound} absolutePathFiles=${manifest.scan.absolutePathFiles} safeToShare=${manifest.scan.safeToShare}\n`)
  if (!manifest.scan.safeToShare) process.exit(1)
}

main()
