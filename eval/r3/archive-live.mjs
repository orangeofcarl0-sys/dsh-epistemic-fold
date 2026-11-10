#!/usr/bin/env node
/**
 * EF-R3 WP2 — archive the EF-R2 live raw evidence.
 *
 * The R2 incremental archive predates both live stages. This package adds ONLY
 * the live evidence: the 18-cell pilot, the 21 executed confirm attempts, the 4
 * executed resume attempts, the two transport-failed attempts, and the 30
 * never-started cells as an explicit negative record.
 *
 * It never rewrites a historical report. The archive index uses the corrected
 * Attempt/Cell ledgers; the old `live-route-incident.json` is copied verbatim
 * and its counts are superseded by `live-confirm-reconciliation.json`.
 *
 *   node eval/r3/archive-live.mjs
 *   node eval/r3/archive-live.mjs --copy-to "E:/EF_R2_LIVE_RESEARCH_ARCHIVE"
 *
 * @module eval/r3/archive-live
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
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')

const argv = process.argv.slice(2)
const value = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const ARCHIVE = resolve(value('out') ?? join(ROOT, '..', 'EF_R2_LIVE_RESEARCH_ARCHIVE'))
const POINTER = resolve(value('pointer') ?? join(OUT, 'research-archive-r2-live.json'))
const COPY_TO = value('copy-to') === undefined ? null : resolve(value('copy-to'))

const CAMPAIGNS = [
  'e2e-r2-pilot-1',
  'e2e-r2-confirm-1',
  'e2e-r2-confirm-resume-1',
]
const EVIDENCE_SUFFIXES = ['manifest', 'authorization', 'results', 'analysis', 'evidence-index']

const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256File = path => sha256Bytes(readFileSync(path))
const toPosix = path => path.replace(/\\/gu, '/')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
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
      versions[name] = readJson(join(ROOT, 'node_modules', '@deepseek-ai', name, 'package.json')).version
    } catch {
      versions[name] = null
    }
  }
  return versions
}

function loadLedger() {
  const path = join(OUT, 'cell-ledger.json')
  const attemptsPath = join(OUT, 'attempt-ledger.json')
  if (!existsSync(path) || !existsSync(attemptsPath)) {
    process.stderr.write('archive-live: run eval/r3/reconcile-confirm.mjs first; the ledger is missing\n')
    process.exit(2)
  }
  return {
    cells: readJson(path),
    attempts: readJson(attemptsPath),
    sha256: sha256File(path),
    attemptsSha256: sha256File(attemptsPath),
  }
}

function campaignAttempts(ledger, campaign) {
  const section = campaign.startsWith('e2e-r2-pilot') ? ledger.attempts.pilot : ledger.attempts.confirm
  return (section.attempts ?? []).filter(attempt => attempt.campaign === campaign)
}

function experimentIndex(ledger) {
  const index = []
  for (const campaign of CAMPAIGNS) {
    const resultsPath = join(E2E_OUT, `results-${campaign}.json`)
    if (!existsSync(resultsPath)) continue
    const results = readJson(resultsPath)
    const attempts = campaignAttempts(ledger, campaign)
    const cells = (results.results ?? []).map(cell => {
      const cellId = cell.cellId ?? `${cell.cell.task}-${cell.cell.arm}-r${cell.cell.replicate}`
      const dir = join(ROOT, 'eval', 'e2e', 'runs', campaign, cellId)
      const reportPath = join(dir, 'report.json')
      const requestsPath = join(dir, 'raw', 'requests.json')
      const trajectoryPath = join(dir, 'raw', 'trajectory.json')
      const attempt = attempts.find(entry => entry.cellKey === cellId)
      return {
        cellId,
        status: cell.status,
        arm: cell.cell?.arm ?? null,
        task: cell.cell?.task ?? null,
        block: cell.cell?.block ?? null,
        checkerPassed: cell.checker === true,
        attemptStatus: attempt?.status ?? null,
        taskOutcomeValid: attempt?.taskOutcomeValid ?? null,
        treatmentValid: attempt?.treatmentValid ?? null,
        costValid: attempt?.costValid ?? null,
        requests: cell.usage?.requests ?? null,
        unknownUsage: cell.usage?.unknownUsage ?? null,
        configMismatch: attempt?.treatment?.configMismatch ?? [],
        reportSha256: existsSync(reportPath) ? sha256File(reportPath) : null,
        requestsSha256: existsSync(requestsPath) ? sha256File(requestsPath) : null,
        trajectorySha256: existsSync(trajectoryPath) ? sha256File(trajectoryPath) : null,
      }
    })
    index.push({
      campaign,
      role: campaign === 'e2e-r2-pilot-1'
        ? 'pilot'
        : campaign === 'e2e-r2-confirm-1' ? 'confirm' : 'confirm-resume',
      valid: true,
      status: results.status ?? null,
      stopReason: results.stopReason ?? null,
      designCells: results.planned ?? 0,
      executed: results.executed ?? null,
      attempts: attempts.length,
      validAttempts: attempts.filter(attempt => attempt.status === 'valid').length,
      transportFailedAttempts: attempts.filter(attempt => attempt.status === 'transport-failed').length,
      budgetUsed: results.budget?.used ?? null,
      cells,
    })
  }
  return index
}

function copyEvidence(targetDir) {
  mkdirSync(join(ARCHIVE, targetDir), { recursive: true })
  for (const campaign of CAMPAIGNS) {
    for (const suffix of EVIDENCE_SUFFIXES) {
      const name = `${suffix}-${campaign}.json`
      const source = join(E2E_OUT, name)
      if (!existsSync(source)) continue
      cpSync(source, join(ARCHIVE, targetDir, name))
    }
  }
}

function writeSums() {
  const sums = walk(ARCHIVE)
    .filter(file => file.rel !== 'SHA256SUMS')
    .sort((left, right) => left.rel.localeCompare(right.rel))
    .map(file => `${sha256File(file.path)}  ${file.rel}`)
    .join('\n')
  writeFileSync(join(ARCHIVE, 'SHA256SUMS'), `${sums}\n`, 'utf8')
}

function verify(archive, outName) {
  const outPath = join(OUT, outName)
  try {
    execFileSync('node', [
      join(ROOT, 'eval', 'e2e', 'src', 'verify-archive.mjs'),
      '--archive', archive,
      '--pointer', POINTER,
      '--out', outPath,
    ], { cwd: ROOT, stdio: 'pipe' })
  } catch {
    // The verifier writes the report even when it exits non-zero.
  }
  return existsSync(outPath) ? readJson(outPath) : null
}

function main() {
  const ledger = loadLedger()
  if (existsSync(ARCHIVE) && readdirSync(ARCHIVE).length > 0) {
    process.stderr.write(`archive-live: ${ARCHIVE} already exists and is not empty; refusing to overwrite historical evidence\n`)
    process.exit(2)
  }
  mkdirSync(ARCHIVE, { recursive: true })

  // 1. Raw runs, verbatim. The resume is its own campaign; it is not folded into
  //    the confirm directory.
  for (const campaign of CAMPAIGNS) {
    const source = join(ROOT, 'eval', 'e2e', 'runs', campaign)
    if (existsSync(source)) cpSync(source, join(ARCHIVE, 'raw-runs', campaign), { recursive: true })
  }

  // 2. Campaign evidence files.
  copyEvidence('evidence')
  const extraEvidence = [
    [join(ROOT, 'eval', 'r2', 'out', 'live-route-incident.json'), 'live-route-incident.json'],
    [join(ROOT, 'eval', 'r2', 'out', 'live-pilot-analysis.json'), 'live-pilot-analysis.json'],
    [join(ROOT, 'eval', 'r2', 'out', 'live-pilot-analysis.md'), 'live-pilot-analysis.md'],
    [join(ROOT, 'eval', 'r2', 'out', 'live-pilot-analysis-ledger.json'), 'live-pilot-analysis-ledger.json'],
    [join(ROOT, 'eval', 'r2', 'out', 'live-confirm-analysis.json'), 'live-confirm-analysis.json'],
    [join(ROOT, 'eval', 'r2', 'out', 'live-confirm-analysis.md'), 'live-confirm-analysis.md'],
    [join(ROOT, 'eval', 'r2', 'out', 'live-confirm-analysis-ledger.json'), 'live-confirm-analysis-ledger.json'],
    [join(ROOT, 'eval', 'r2', 'out', 'live-design-r2.json'), 'live-design-r2.json'],
    [join(ROOT, 'eval', 'r2', 'out', 'gate-status.json'), 'gate-status.json'],
    [join(ROOT, 'eval', 'r2', 'out', 'evidence-claims.json'), 'evidence-claims.json'],
    [join(OUT, 'live-confirm-reconciliation.json'), 'live-confirm-reconciliation.json'],
    [join(OUT, 'live-ledger-summary.json'), 'live-ledger-summary.json'],
    [join(OUT, 'attempt-ledger.json'), 'attempt-ledger.json'],
    [join(OUT, 'cell-ledger.json'), 'cell-ledger.json'],
  ]
  for (const [source, name] of extraEvidence) {
    if (existsSync(source)) cpSync(source, join(ARCHIVE, 'evidence', name))
  }

  // 3. The R2/R1 parent pointers, so the package is self-locating.
  mkdirSync(join(ARCHIVE, 'parent'), { recursive: true })
  for (const [source, name] of [
    [join(ROOT, 'eval', 'r2', 'out', 'research-archive-r2.json'), 'research-archive-r2.json'],
    [join(ROOT, 'eval', 'r2', 'out', 'archive-verification-r2.json'), 'archive-verification-r2.json'],
    [join(ROOT, 'eval', 'ef-r1', 'out', 'research-archive-r1.json'), 'research-archive-r1.json'],
  ]) {
    if (existsSync(source)) cpSync(source, join(ARCHIVE, 'parent', name))
  }

  // 4. Frozen task inputs.
  if (existsSync(join(ROOT, 'eval', 'e2e', 'tasks-r2'))) {
    cpSync(join(ROOT, 'eval', 'e2e', 'tasks-r2'), join(ARCHIVE, 'tasks-r2'), { recursive: true })
  }

  // 5. Git bundle and textual snapshot.
  const gitDir = join(ARCHIVE, 'git')
  mkdirSync(gitDir, { recursive: true })
  const bundle = join(gitDir, 'ef-c1-evaluation-foundation.bundle')
  let bundleCreated = false
  try {
    execFileSync('git', ['bundle', 'create', bundle, 'chore/ef-c1-evaluation-foundation', '--tags'], { cwd: ROOT, stdio: 'pipe' })
    bundleCreated = true
  } catch (error) {
    process.stderr.write(`archive-live: git bundle failed: ${error instanceof Error ? error.message : String(error)}\n`)
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
    'R2 parent archive:',
    existsSync(join(ARCHIVE, 'parent', 'research-archive-r2.json'))
      ? readFileSync(join(ARCHIVE, 'parent', 'research-archive-r2.json'), 'utf8').trim()
      : '(missing)',
    '',
  ].join('\n')
  writeFileSync(join(ARCHIVE, 'git-snapshot.txt'), snapshot, 'utf8')

  // 6. Environment identity. No env dump, no key material.
  const sampleResults = readJson(join(E2E_OUT, 'results-e2e-r2-confirm-1.json'))
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
    route: sampleResults.route ?? null,
    model: sampleResults.model ?? null,
    envDumpIncluded: false,
    note: 'Only version and route identity are recorded. The API key is resolved at run time and was never written to a manifest or a report.',
  }
  mkdirSync(join(ARCHIVE, 'environment'), { recursive: true })
  writeFileSync(join(ARCHIVE, 'environment', 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`, 'utf8')

  // 7. Experiment index, using the corrected ledger.
  const experiments = experimentIndex(ledger)
  const confirmSummary = ledger.cells.confirm.summary
  const pilotSummary = ledger.cells.pilot.summary
  writeFileSync(join(ARCHIVE, 'experiment-index.json'), `${JSON.stringify({
    schemaVersion: 1,
    work: 'EF-R3 WP2',
    parent: 'EF_R2_RESEARCH_ARCHIVE',
    ledger: {
      cellLedgerSha256: ledger.sha256,
      attemptLedgerSha256: ledger.attemptsSha256,
      note: 'The archive index uses the R3 Attempt/Unique Cell ledger, not the old live-route-incident counts.',
    },
    campaigns: experiments,
    counts: {
      pilotValidCells: pilotSummary.valid,
      confirmValidCells: confirmSummary.valid,
      confirmUnresolvedCells: confirmSummary.unresolved,
      confirmNeverStartedCells: confirmSummary.neverStarted,
      confirmNoValidOutcomeCells: confirmSummary.noValidOutcome,
      confirmAttempts: confirmSummary.attempts,
      confirmTransportFailedAttempts: confirmSummary.transportFailedAttempts,
      rawAttempts: experiments.reduce((sum, campaign) => sum + campaign.attempts, 0),
    },
    note: 'The pilot and confirm use different instances and are not pooled. Transport-failed attempts are negative evidence, not arm outcomes.',
  }, null, 2)}\n`, 'utf8')

  // 8. Scan every copied text file.
  const scanResult = scan(walk(ARCHIVE))
  writeFileSync(join(ARCHIVE, 'scan.json'), `${JSON.stringify(scanResult, null, 2)}\n`, 'utf8')

  // 9. Manifest.
  const all = walk(ARCHIVE).filter(file => file.rel !== 'SHA256SUMS')
  const totalBytes = all.reduce((sum, file) => sum + statSync(file.path).size, 0)
  const manifest = {
    schemaVersion: 1,
    work: 'EF-R3 WP2',
    generatedAt: new Date().toISOString(),
    archiveRoot: toPosix(ARCHIVE),
    scope: 'incremental: EF-R2 live raw evidence only',
    parent: {
      pointer: 'parent/research-archive-r2.json',
      note: 'The R2 package covers the pre-live 50 valid cells and 8 invalid records. This package adds the live pilot and confirm attempts.',
    },
    source: {
      worktree: toPosix(ROOT),
      commit: gitText('rev-parse', 'HEAD'),
      branch: gitText('branch', '--show-current') || '(detached)',
      dirtyAwayFromEvidence: gitText('status', '--porcelain'),
    },
    contents: {
      rawRuns: 'raw-runs/',
      evidence: 'evidence/',
      tasks: 'tasks-r2/',
      gitBundle: bundleCreated ? 'git/ef-c1-evaluation-foundation.bundle' : null,
      gitSnapshot: 'git-snapshot.txt',
      experimentIndex: 'experiment-index.json',
      environment: 'environment/environment.json',
      scan: 'scan.json',
    },
    counts: {
      files: all.length + 1,
      bytes: totalBytes,
      pilotValidCells: pilotSummary.valid,
      confirmValidCells: confirmSummary.valid,
      confirmUnresolvedCells: confirmSummary.unresolved,
      confirmNeverStartedCells: confirmSummary.neverStarted,
      confirmNoValidOutcomeCells: confirmSummary.noValidOutcome,
      confirmAttempts: confirmSummary.attempts,
      confirmTransportFailedAttempts: confirmSummary.transportFailedAttempts,
      rawAttempts: experiments.reduce((sum, campaign) => sum + campaign.attempts, 0),
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
    provenance: 'Copied verbatim from the worktree; no historical file was modified. The failed attempts and the 30 never-started cells are retained as negative evidence, not as arm outcomes.',
  }
  writeFileSync(join(ARCHIVE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeSums()

  // 10. Repository-side pointer.
  const pointer = {
    schemaVersion: 1,
    work: 'EF-R3 WP2',
    archiveRoot: toPosix(ARCHIVE),
    archiveManifestSha256: sha256File(join(ARCHIVE, 'manifest.json')),
    archiveSumsSha256: sha256File(join(ARCHIVE, 'SHA256SUMS')),
    archiveBundleSha256: manifest.bundle?.sha256 ?? null,
    commit: manifest.source.commit,
    counts: manifest.counts,
    scan: manifest.scan,
    ledger: {
      cellLedger: 'eval/r3/out/cell-ledger.json',
      cellLedgerSha256: ledger.sha256,
      attemptLedger: 'eval/r3/out/attempt-ledger.json',
      attemptLedgerSha256: ledger.attemptsSha256,
    },
    secondCopy: null,
    note: 'Incremental live-only package: 18 pilot cells and 25 confirm attempts (23 valid cells, 2 transport-failed attempts, 30 never-started cells). The R2 package remains the authority for the pre-live evidence.',
  }
  mkdirSync(dirname(POINTER), { recursive: true })
  writeFileSync(POINTER, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

  // 11. Verify the primary copy, then an optional second local copy.
  const verification = verify(ARCHIVE, 'archive-verification-r2-live.json')
  let copyVerification = null
  if (COPY_TO !== null) {
    if (existsSync(COPY_TO) && readdirSync(COPY_TO).length > 0) {
      process.stderr.write(`archive-live: copy target ${COPY_TO} already exists and is not empty; refusing to overwrite\n`)
      process.exit(2)
    }
    cpSync(ARCHIVE, COPY_TO, { recursive: true })
    copyVerification = verify(COPY_TO, 'archive-verification-r2-live-copy.json')
    pointer.secondCopy = {
      path: toPosix(COPY_TO),
      verification: copyVerification?.verdict ?? 'missing',
      verificationArtifact: 'eval/r3/out/archive-verification-r2-live-copy.json',
    }
    writeFileSync(POINTER, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  }

  process.stdout.write(`archive: ${ARCHIVE}\n`)
  process.stdout.write(`files ${manifest.counts.files}, bytes ${manifest.counts.bytes}, raw attempts ${manifest.counts.rawAttempts}\n`)
  process.stdout.write(`confirm: ${manifest.counts.confirmValidCells} valid, ${manifest.counts.confirmUnresolvedCells} unresolved, ${manifest.counts.confirmNeverStartedCells} never-started, ${manifest.counts.confirmTransportFailedAttempts} transport-failed attempts\n`)
  process.stdout.write(`scan: credentials=${manifest.scan.credentialsFound} absolutePathFiles=${manifest.scan.absolutePathFiles} safeToShare=${manifest.scan.safeToShare}\n`)
  process.stdout.write(`primary verification: ${verification?.verdict ?? 'missing'}\n`)
  if (copyVerification !== null) process.stdout.write(`copy verification: ${copyVerification.verdict}\n`)
  if (verification?.verdict !== 'archive-verified') process.exit(1)
}

main()
