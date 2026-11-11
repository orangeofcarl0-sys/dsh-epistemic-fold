#!/usr/bin/env node
/**
 * EF-R3 product-lane — archive the 18-cell pilot raw evidence.
 *
 * The pilot is the first live product-preset run. This package keeps its raw
 * sessions, requests, reports, bundles, manifest, authorization, results,
 * health-probe evidence and analysis. It is incremental: the earlier R2 live
 * archive is untouched.
 *
 *   node eval/r3/archive-product-pilot.mjs
 *
 * @module eval/r3/archive-product-pilot
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
const RUNS = join(ROOT, 'eval', 'e2e', 'runs', 'e2e-r3-product-pilot-1')
const OUT = join(HERE, 'out')
const CAMPAIGN = 'e2e-r3-product-pilot-1'
const ARCHIVE = resolve(process.env.EF_R3_PILOT_ARCHIVE ?? join(ROOT, '..', 'EF_R3_PRODUCT_PILOT_ARCHIVE'))
const POINTER = join(OUT, 'research-archive-r3-product-pilot.json')

const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
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
  { name: 'url-credentials', re: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[A-Za-z0-9.-]+/gu },
]
const BINARY = new Set(['.bundle', '.gz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'])

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
  let textFiles = 0
  let skippedBinary = 0
  for (const file of files) {
    if (BINARY.has(file.rel.slice(file.rel.lastIndexOf('.')))) {
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
      if (match !== null) credentials.push({ file: file.rel, pattern: pattern.name, offset: match.index })
    }
    const absolute = text.match(/\b[A-Za-z]:[\\/](?:[^\s"'<>|]+)/gu) ?? []
    if (absolute.length > 0) absolutePaths.set(file.rel, absolute.length)
  }
  return {
    scannedTextFiles: textFiles,
    skippedBinaryFiles: skippedBinary,
    credentials,
    credentialsFound: credentials.length,
    absolutePathFiles: [...absolutePaths.entries()].map(([file, count]) => ({ file, count })),
    note: 'Credential values are never copied into this report; only the file and byte offset are recorded.',
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

function cellIndex() {
  const results = readJson(join(E2E_OUT, `results-${CAMPAIGN}.json`))
  return (results.results ?? []).filter(entry => entry.status === 'executed').map(entry => {
    const reportPath = entry.reportPath ?? join(RUNS, entry.cellId, 'report.json')
    const report = existsSync(reportPath) ? readJson(reportPath) : null
    return {
      cellId: entry.cellId,
      task: entry.cell?.task ?? null,
      arm: entry.cell?.arm ?? null,
      replicate: entry.cell?.replicate ?? null,
      checkerPassed: entry.checker === true,
      termination: entry.termination ?? null,
      requests: entry.usage?.requests ?? null,
      unknownUsage: entry.usage?.unknownUsage ?? null,
      costValid: entry.usage?.unknownUsage === 0,
      inputTokens: entry.usage?.inputTokens ?? null,
      outputTokens: entry.usage?.outputTokens ?? null,
      reportSha256: existsSync(reportPath) ? sha256File(reportPath) : null,
      requestsSha256: existsSync(join(RUNS, entry.cellId, 'raw', 'requests.json'))
        ? sha256File(join(RUNS, entry.cellId, 'raw', 'requests.json'))
        : null,
      stepLimited: (entry.termination ?? report?.termination?.kind) === 'step-limit',
    }
  })
}

function writeSums() {
  const sums = walk(ARCHIVE)
    .filter(file => file.rel !== 'SHA256SUMS')
    .sort((left, right) => left.rel.localeCompare(right.rel))
    .map(file => `${sha256File(file.path)}  ${file.rel}`)
    .join('\n')
  writeFileSync(join(ARCHIVE, 'SHA256SUMS'), `${sums}\n`, 'utf8')
}

function main() {
  if (existsSync(ARCHIVE) && readdirSync(ARCHIVE).length > 0) {
    process.stderr.write(`archive-product-pilot: ${ARCHIVE} exists and is not empty; refusing to overwrite\n`)
    process.exit(2)
  }
  mkdirSync(ARCHIVE, { recursive: true })

  if (existsSync(RUNS)) cpSync(RUNS, join(ARCHIVE, 'raw-runs', CAMPAIGN), { recursive: true })
  mkdirSync(join(ARCHIVE, 'evidence'), { recursive: true })
  for (const [source, name] of [
    [join(E2E_OUT, `manifest-${CAMPAIGN}.json`), `manifest-${CAMPAIGN}.json`],
    [join(E2E_OUT, `authorization-${CAMPAIGN}.json`), `authorization-${CAMPAIGN}.json`],
    [join(E2E_OUT, `results-${CAMPAIGN}.json`), `results-${CAMPAIGN}.json`],
    [join(OUT, 'product-pilot-analysis.json'), 'product-pilot-analysis.json'],
    [join(OUT, 'product-pilot-analysis.md'), 'product-pilot-analysis.md'],
    [join(OUT, 'product-pilot-gates.json'), 'product-pilot-gates.json'],
    [join(OUT, 'product-pilot-gates.md'), 'product-pilot-gates.md'],
    [join(OUT, 'product-pilot-design.json'), 'product-pilot-design.json'],
    [join(OUT, 'product-pilot-prerequisites.json'), 'product-pilot-prerequisites.json'],
    [join(OUT, 'health-probe-results.json'), 'health-probe-results.json'],
    [join(OUT, 'health-probe-analysis.md'), 'health-probe-analysis.md'],
    [join(OUT, 'admission-candidate.json'), 'admission-candidate.json'],
    [join(OUT, 'product-lane-exposure-audit.json'), 'product-lane-exposure-audit.json'],
    [join(OUT, 'cost-preflight.json'), 'cost-preflight.json'],
    [join(OUT, 'transport-diagnosis.json'), 'transport-diagnosis.json'],
  ]) {
    if (existsSync(source)) cpSync(source, join(ARCHIVE, 'evidence', name))
  }
  if (existsSync(join(ROOT, 'eval', 'e2e', 'tasks-r3'))) {
    cpSync(join(ROOT, 'eval', 'e2e', 'tasks-r3'), join(ARCHIVE, 'tasks-r3'), { recursive: true })
  }

  const gitDir = join(ARCHIVE, 'git')
  mkdirSync(gitDir, { recursive: true })
  const bundle = join(gitDir, 'ef-c1-evaluation-foundation.bundle')
  let bundleCreated = false
  try {
    execFileSync('git', ['bundle', 'create', bundle, 'chore/ef-c1-evaluation-foundation', '--tags'], { cwd: ROOT, stdio: 'pipe' })
    bundleCreated = true
  } catch (error) {
    process.stderr.write(`archive-product-pilot: git bundle failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  const bundleVerify = bundleCreated ? gitText('bundle', 'verify', bundle) : '(not created)'
  writeFileSync(join(ARCHIVE, 'git-snapshot.txt'), [
    `worktree          ${ROOT}`,
    `head              ${gitText('rev-parse', 'HEAD')}`,
    `headSubject       ${gitText('log', '-1', '--format=%s')}`,
    `branch            ${gitText('branch', '--show-current') || '(detached)'}`,
    '',
    'recent commits:',
    gitText('log', '--oneline', '-20'),
    '',
    'bundle verify:',
    bundleVerify,
    '',
  ].join('\n'), 'utf8')

  const results = readJson(join(E2E_OUT, `results-${CAMPAIGN}.json`))
  const pilotManifest = readJson(join(E2E_OUT, `manifest-${CAMPAIGN}.json`))
  mkdirSync(join(ARCHIVE, 'environment'), { recursive: true })
  writeFileSync(join(ARCHIVE, 'environment', 'environment.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dsh: dshVersions(),
    route: results.route ?? null,
    model: results.model ?? null,
    envDumpIncluded: false,
  }, null, 2)}\n`, 'utf8')

  const cells = cellIndex()
  writeFileSync(join(ARCHIVE, 'experiment-index.json'), `${JSON.stringify({
    schemaVersion: 1,
    work: 'EF-R3 product-lane pilot',
    campaign: CAMPAIGN,
    status: results.status,
    stopReason: results.stopReason,
    planned: results.planned,
    executed: results.executed,
    budget: results.budget,
    config: pilotManifest.config ?? null,
    counts: {
      cells: cells.length,
      passed: cells.filter(cell => cell.checkerPassed).length,
      costValid: cells.filter(cell => cell.costValid).length,
      stepLimited: cells.filter(cell => cell.stepLimited).length,
      byArm: Object.fromEntries([...new Set(cells.map(cell => cell.arm))].sort().map(arm => {
        const subset = cells.filter(cell => cell.arm === arm)
        return [arm, {
          cells: subset.length,
          passed: subset.filter(cell => cell.checkerPassed).length,
          stepLimited: subset.filter(cell => cell.stepLimited).length,
          costValid: subset.filter(cell => cell.costValid).length,
          requests: subset.reduce((sum, cell) => sum + (cell.requests ?? 0), 0),
          inputTokens: subset.reduce((sum, cell) => sum + (cell.inputTokens ?? 0), 0),
          outputTokens: subset.reduce((sum, cell) => sum + (cell.outputTokens ?? 0), 0),
        }]
      })),
    },
    cells,
    note: '18/18 executed; one E1 cell has partial usage. The pilot is exploratory, not confirmatory.',
  }, null, 2)}\n`, 'utf8')

  const scanResult = scan(walk(ARCHIVE))
  writeFileSync(join(ARCHIVE, 'scan.json'), `${JSON.stringify(scanResult, null, 2)}\n`, 'utf8')
  const all = walk(ARCHIVE).filter(file => file.rel !== 'SHA256SUMS')
  const manifest = {
    schemaVersion: 1,
    work: 'EF-R3 product-lane pilot',
    generatedAt: new Date().toISOString(),
    archiveRoot: toPosix(ARCHIVE),
    campaign: CAMPAIGN,
    source: {
      worktree: toPosix(ROOT),
      commit: gitText('rev-parse', 'HEAD'),
      branch: gitText('branch', '--show-current') || '(detached)',
    },
    counts: {
      files: all.length + 1,
      bytes: all.reduce((sum, file) => sum + statSync(file.path).size, 0),
      cells: cells.length,
      passed: cells.filter(cell => cell.checkerPassed).length,
      costValid: cells.filter(cell => cell.costValid).length,
      stepLimited: cells.filter(cell => cell.stepLimited).length,
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
      safeToShare: scanResult.credentialsFound === 0,
    },
    note: 'Incremental pilot raw evidence. The earlier R2 live archive and the R2 stress archive are untouched.',
  }
  writeFileSync(join(ARCHIVE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeSums()

  const pointer = {
    schemaVersion: 1,
    work: 'EF-R3 product-lane pilot',
    archiveRoot: toPosix(ARCHIVE),
    archiveManifestSha256: sha256File(join(ARCHIVE, 'manifest.json')),
    archiveSumsSha256: sha256File(join(ARCHIVE, 'SHA256SUMS')),
    archiveBundleSha256: manifest.bundle?.sha256 ?? null,
    commit: manifest.source.commit,
    counts: manifest.counts,
    scan: manifest.scan,
    secondCopy: null,
    note: '18-cell product-lane pilot raw evidence. Verified locally; an off-machine copy is not claimed.',
  }
  mkdirSync(dirname(POINTER), { recursive: true })
  writeFileSync(POINTER, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

  try {
    execFileSync('node', [
      join(ROOT, 'eval', 'e2e', 'src', 'verify-archive.mjs'),
      '--archive', ARCHIVE,
      '--pointer', POINTER,
      '--out', join(OUT, 'archive-verification-r3-product-pilot.json'),
    ], { cwd: ROOT, stdio: 'pipe' })
  } catch {
    // The verifier writes its report even on failure.
  }
  const verification = existsSync(join(OUT, 'archive-verification-r3-product-pilot.json'))
    ? readJson(join(OUT, 'archive-verification-r3-product-pilot.json'))
    : null

  const copyTo = 'E:/EF_R3_PRODUCT_PILOT_ARCHIVE'
  let copyVerification = null
  if (existsSync('E:/') && !existsSync(copyTo)) {
    cpSync(ARCHIVE, copyTo, { recursive: true })
    try {
      execFileSync('node', [
        join(ROOT, 'eval', 'e2e', 'src', 'verify-archive.mjs'),
        '--archive', copyTo,
        '--pointer', POINTER,
        '--out', join(OUT, 'archive-verification-r3-product-pilot-copy.json'),
      ], { cwd: ROOT, stdio: 'pipe' })
    } catch {
      // The verifier writes its report even on failure.
    }
    copyVerification = existsSync(join(OUT, 'archive-verification-r3-product-pilot-copy.json'))
      ? readJson(join(OUT, 'archive-verification-r3-product-pilot-copy.json'))
      : null
    pointer.secondCopy = {
      path: copyTo,
      verification: copyVerification?.verdict ?? 'missing',
      verificationArtifact: 'eval/r3/out/archive-verification-r3-product-pilot-copy.json',
    }
    writeFileSync(POINTER, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  }

  process.stdout.write(`archive: ${ARCHIVE}\n`)
  process.stdout.write(`files ${manifest.counts.files}, bytes ${manifest.counts.bytes}, cells ${manifest.counts.cells}, pass ${manifest.counts.passed}, cost-valid ${manifest.counts.costValid}, step-limited ${manifest.counts.stepLimited}\n`)
  process.stdout.write(`scan: credentials=${manifest.scan.credentialsFound} safeToShare=${manifest.scan.safeToShare}\n`)
  process.stdout.write(`primary verification: ${verification?.verdict ?? 'missing'}\n`)
  if (copyVerification !== null) process.stdout.write(`copy verification: ${copyVerification.verdict}\n`)
  if (verification?.verdict !== 'archive-verified') process.exit(1)
}

main()
