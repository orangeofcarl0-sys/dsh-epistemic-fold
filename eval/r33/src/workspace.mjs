/**
 * Workspace materialization, process isolation, and hidden-checker execution.
 *
 * ## What R33 got wrong, and what this module now guarantees
 *
 *  1. **Freshness.** A run reused `out/live-work/<case>-<arm>/workspace`, and
 *     `materialize()` only overwrote the files it knew about. A helper file the
 *     previous agent created survived into the next replicate. Every replicate
 *     now gets a newly created directory; creation FAILS if the path exists.
 *  2. **Secrets.** `runNode` inherited `process.env`, so a provider API key was
 *     readable by the agent's own test process. Children now receive an
 *     explicit allowlist and nothing else.
 *  3. **Checker authority.** The checker's result was the first stdout line
 *     beginning with `R33_RESULT`; any imported workspace module could print
 *     one during import. The checker now runs inside a trusted bootstrap that
 *     captures stdout during import and writes the LAST marker to a private
 *     result file outside the workspace. The harness reads that file, never
 *     stdout, and validates the payload against the case's declared checks.
 *  4. **Timeout diagnosis.** A timer killed the child but the result still said
 *     `timedOut: false`, so a hang was indistinguishable from a normal non-zero
 *     exit. The state is now explicit and mutually exclusive.
 *  5. **Unbounded output.** A generated program could emit gigabytes into the
 *     harness's memory. Capture is capped and the truncation is reported.
 *
 * ## The isolation limit, stated honestly
 *
 * An environment allowlist and a path check are NOT a sandbox. Code running as
 * the same OS user can still read files elsewhere, inspect its own process, or
 * attack the checker process. The hidden checker is copied outside the agent
 * workspace, and the agent's tools are path-checked, but a formally adversarial
 * evaluation needs OS-level process/filesystem/network isolation. This module
 * reports the isolation level it actually provides instead of claiming one.
 *
 * @module eval/r33/src/workspace
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

/** The isolation this harness actually provides, for the report. */
export const ISOLATION_LEVEL = {
  environment: 'allowlist',
  filesystem: 'path-checked-workspace',
  checker: 'trusted-bootstrap-result-file',
  osSandbox: 'none',
  note: 'Same-user code can still access other local files and attack the checker process. Not an adversarial sandbox.',
}

const DEFAULT_OUTPUT_CAP = 256 * 1024

/**
 * Environment names a child may inherit.
 *
 * These are the minimum needed to start Node and resolve its own modules on
 * Windows and POSIX. `NODE_OPTIONS` is deliberately absent: it can inject code
 * and would make every child's behaviour depend on the parent's shell.
 */
const CHILD_ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TZ', 'LANG', 'LC_ALL',
]

/** Names that look like credentials may never be forwarded, even as extras. */
const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/iu

/** Harness names that are safe despite matching no sensitive pattern. */
const SAFE_EXTRAS = new Set([
  'R33_WORKSPACE', 'R33_CASE', 'R33_CHECKER', 'R33_RESULT_PATH', 'R33_RESULT_NONCE',
  'R33_VISIBLE_TESTS',
])

/** Build the exact environment a child process receives. */
export function childEnvironment(extras = {}) {
  const inherited = {}
  const lower = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]))
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = lower.get(name.toLowerCase())
    if (value !== undefined) inherited[name] = value
  }
  for (const [name, value] of Object.entries(extras)) {
    if (!SAFE_EXTRAS.has(name) && SENSITIVE_NAME.test(name)) {
      throw new Error(`refusing to forward credential-shaped environment variable ${name}`)
    }
    inherited[name] = String(value)
  }
  return inherited
}

/** Collect a stream without letting a generated program exhaust memory. */
function boundedCollect(cap) {
  const state = { text: '', bytes: 0, truncated: false }
  return {
    push(chunk) {
      if (state.bytes >= cap) {
        state.truncated = true
        return
      }
      const text = String(chunk)
      const remaining = cap - state.bytes
      if (text.length <= remaining) {
        state.text += text
        state.bytes += text.length
      } else {
        state.text += text.slice(0, remaining)
        state.bytes = cap
        state.truncated = true
      }
    },
    result() {
      return { text: state.text, truncated: state.truncated }
    },
  }
}

/**
 * Run a child process with a hard timeout, bounded output, and explicit states.
 *
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string,
 *   timedOut:boolean, processError:string|undefined,
 *   stdoutTruncated:boolean, stderrTruncated:boolean, durationMs:number}>}
 */
export function runNode(args, options = {}) {
  return new Promise(resolvePromise => {
    const started = Date.now()
    const timeoutMs = options.timeoutMs ?? 20_000
    const cap = options.outputCap ?? DEFAULT_OUTPUT_CAP
    const stdout = boundedCollect(cap)
    const stderr = boundedCollect(cap)
    let timedOut = false
    let processError
    let finished = false
    let timer
    const finish = (exitCode) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolvePromise({
        exitCode,
        stdout: stdout.result().text,
        stderr: stderr.result().text,
        timedOut,
        processError,
        stdoutTruncated: stdout.result().truncated,
        stderrTruncated: stderr.result().truncated,
        durationMs: Date.now() - started,
      })
    }
    let child
    try {
      child = spawn(process.execPath, args, {
        cwd: options.cwd,
        env: options.env ?? childEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      processError = error instanceof Error ? error.message : String(error)
      finish(-1)
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => {
      processError = error instanceof Error ? error.message : String(error)
      finish(-1)
    })
    child.on('close', code => finish(code ?? -1))
  })
}

/** Write one `path -> content` map under `root`, creating parent directories. */
export async function materialize(files, root) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...String(path).split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

/**
 * Create a workspace that did not exist before.
 *
 * The failure on an existing path is the point: silently reusing a directory is
 * how the previous run's generated files leaked into the next measurement.
 */
export async function materializeFresh(files, root) {
  await mkdir(dirname(root), { recursive: true })
  await mkdir(root, { recursive: false })
  await materialize(files, root)
  return root
}

/**
 * Create `runId/caseId/arm/replicateId/{workspace,session,bundles,journal,trace}`.
 *
 * A collision is an error, never a reuse. Old runs stay where they are.
 */
export async function createReplicateLayout({ root, runId, caseId, arm, replicateId }) {
  const base = join(root, runId, caseId, arm, replicateId)
  await mkdir(dirname(base), { recursive: true })
  await mkdir(base, { recursive: false })
  const layout = {
    base,
    workspace: join(base, 'workspace'),
    session: join(base, 'session'),
    bundles: join(base, 'bundles'),
    journal: join(base, 'journal'),
    trace: join(base, 'trace'),
  }
  for (const directory of [layout.workspace, layout.session, layout.bundles, layout.journal, layout.trace]) {
    await mkdir(directory, { recursive: true })
  }
  return layout
}

/** Apply one action's file edits on top of the workspace. */
export async function applyAction(action, root) {
  await materialize(action.files ?? {}, root)
}

function inside(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (resolvedCandidate === resolvedRoot) return true
  return resolvedCandidate.startsWith(resolvedRoot + sep)
}

/**
 * Resolve a workspace-relative path and prove it stays inside the workspace.
 *
 * Rejects POSIX-absolute, Windows-drive, UNC, NUL, and `..` forms, then checks
 * the REAL path of the target (or its nearest existing ancestor) so a symlink
 * or junction cannot escape. `includes('..')` alone is not a containment proof.
 *
 * @returns {Promise<string|undefined>} the absolute path, or undefined if unsafe.
 */
export async function resolveInside(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return undefined
  if (relativePath.includes('\0')) return undefined
  const normalized = relativePath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized) || normalized.startsWith('//')) {
    return undefined
  }
  const segments = normalized.split('/').filter(segment => segment.length > 0 && segment !== '.')
  if (segments.some(segment => segment === '..')) return undefined
  const rootReal = await realpath(root)
  const candidate = resolve(rootReal, ...segments)
  if (!inside(rootReal, candidate)) return undefined
  // The target may not exist yet (a new file): prove its nearest existing
  // ancestor is inside the root, then the non-existent tail cannot escape.
  let existing = candidate
  for (;;) {
    try {
      const real = await realpath(existing)
      return inside(rootReal, real) ? candidate : undefined
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return undefined
      existing = parent
    }
  }
}

/** Read a workspace file through the containment check, with a size cap. */
export async function readWorkspaceFile(root, path, cap = 200 * 1024) {
  const target = await resolveInside(root, path)
  if (target === undefined) return { ok: false, reason: 'invalid path' }
  try {
    const content = await readFile(target, 'utf8')
    return {
      ok: true,
      content: content.length > cap ? `${content.slice(0, cap)}\n[truncated]` : content,
      truncated: content.length > cap,
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Write a workspace file through the containment check. */
export async function writeWorkspaceFile(root, path, content) {
  const target = await resolveInside(root, path)
  if (target === undefined) return { ok: false, reason: 'invalid path' }
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, String(content ?? ''), 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * List the workspace without following symlinks or leaving the root.
 *
 * Symlinks are reported by name and never traversed: a link to `C:\` must not
 * turn `list_dir` into a filesystem walk.
 */
export async function listWorkspace(root, options = {}) {
  const limit = options.limit ?? 2000
  const lines = []
  let truncated = false
  async function walk(directory, prefix) {
    if (truncated) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (lines.length >= limit) {
        truncated = true
        return
      }
      const display = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) {
        lines.push(`${display} [symlink, not followed]`)
        continue
      }
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), display)
      } else if (entry.isFile()) {
        lines.push(display)
      }
    }
  }
  await walk(root, '')
  return {
    text: lines.join('\n'),
    truncated,
    entries: lines.length,
  }
}

/**
 * The trusted bootstrap that wraps the case checker.
 *
 * It is written OUTSIDE the agent workspace and imported as a separate child
 * process. During the import it captures stdout, so a workspace module that
 * prints `R33_RESULT ...` cannot become the result: only the LAST marker line,
 * emitted by the checker itself, is authoritative, and the parsed payload is
 * written to a private file the harness reads instead of stdout.
 */
const CHECKER_BOOTSTRAP = String.raw`
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'

const checker = process.env.R33_CHECKER
const resultPath = process.env.R33_RESULT_PATH
let captured = ''
const originalWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, encoding, callback) => {
  captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  if (typeof encoding === 'function') encoding()
  else if (typeof callback === 'function') callback()
  return true
}
class ExitSignal extends Error {}
const realExit = process.exit.bind(process)
let requestedExit = 0
process.exit = code => {
  requestedExit = Number.isInteger(code) ? code : 0
  throw new ExitSignal('checker-exit')
}
let importError
try {
  await import(pathToFileURL(checker).href)
} catch (error) {
  if (!(error instanceof ExitSignal)) importError = error
}
process.stdout.write = originalWrite
process.exit = realExit
const markers = []
for (const line of captured.split(/\r?\n/u)) {
  if (!line.startsWith('R33_RESULT ')) continue
  try { markers.push(JSON.parse(line.slice('R33_RESULT '.length))) }
  catch { markers.push({ malformed: true }) }
}
const authoritative = markers.length === 0 ? undefined : markers[markers.length - 1]
const spoofMarkers = Math.max(0, markers.length - 1)
let payload
if (importError !== undefined) {
  payload = {
    checks: [],
    claims: {},
    agentError: String(importError && importError.stack ? importError.stack : importError),
    exitCode: requestedExit,
    spoofMarkers,
  }
} else if (authoritative === undefined || authoritative === null || typeof authoritative !== 'object') {
  payload = {
    checks: [],
    claims: {},
    checkerError: 'no R33_RESULT line was emitted',
    exitCode: requestedExit,
    spoofMarkers,
  }
} else {
  payload = { ...authoritative, exitCode: requestedExit, spoofMarkers }
}
writeFileSync(resultPath, JSON.stringify(payload), 'utf8')
realExit(payload.checkerError !== undefined ? 2 : requestedExit)
`

function invalidResult(status, detail, extra = {}) {
  return {
    status,
    checks: [],
    claims: {},
    detail,
    ...extra,
  }
}

/**
 * Execute one case's hidden checker against a finished workspace.
 *
 * Statuses:
 *   executed        the checker produced a schema-valid, complete result
 *   checker-invalid the result contradicts the declared checks or the exit code
 *   checker-crashed the checker process failed or emitted no result
 *   checker-timeout the checker exceeded its deadline
 *
 * A failing CHECK is a task failure inside `executed`, never `checker-invalid`.
 */
export async function runChecker(caseData, workspaceRoot, options = {}) {
  const root = await mkdtemp(join(tmpdir(), `r33-check-${caseData.id}-`))
  const checkerPath = join(root, 'check.mjs')
  const bootstrapPath = join(root, 'bootstrap.mjs')
  const resultPath = join(root, 'result.json')
  const nonce = randomBytes(16).toString('hex')
  await writeFile(checkerPath, caseData.checker.source, 'utf8')
  await writeFile(bootstrapPath, CHECKER_BOOTSTRAP, 'utf8')
  try {
  const started = Date.now()
  const result = await runNode([bootstrapPath], {
    cwd: root,
    env: childEnvironment({
      R33_WORKSPACE: resolve(workspaceRoot),
      R33_CASE: caseData.id,
      R33_CHECKER: checkerPath,
      R33_RESULT_PATH: resultPath,
      R33_RESULT_NONCE: nonce,
    }),
    timeoutMs: caseData.checker.timeoutMs ?? options.timeoutMs ?? 20_000,
    outputCap: options.outputCap,
  })
  const elapsedMs = Date.now() - started
  const base = {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    processError: result.processError,
    outputTruncated: result.stdoutTruncated || result.stderrTruncated,
    elapsedMs,
  }
  if (result.timedOut) {
    return invalidResult('checker-timeout', 'the checker exceeded its deadline', base)
  }
  let payload
  try {
    payload = JSON.parse(await readFile(resultPath, 'utf8'))
  } catch {
    return invalidResult(
      'checker-crashed',
      result.processError ?? 'the checker emitted no result file',
      base,
    )
  }
  if (payload.checkerError !== undefined) {
    return invalidResult('checker-crashed', String(payload.checkerError), base)
  }
  if (!Array.isArray(payload.checks)) {
    return invalidResult('checker-invalid', 'result has no checks array', base)
  }
  const checks = []
  const seen = new Set()
  for (const entry of payload.checks) {
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string') {
      return invalidResult('checker-invalid', 'a check has no string name', base)
    }
    if (seen.has(entry.name)) {
      return invalidResult('checker-invalid', `duplicate check ${entry.name}`, base)
    }
    seen.add(entry.name)
    checks.push({
      name: entry.name,
      pass: entry.pass === true,
      ...(entry.detail === undefined ? {} : { detail: String(entry.detail) }),
    })
  }
  const expected = Array.isArray(caseData.checker.expectedChecks)
    ? caseData.checker.expectedChecks
    : []
  const allowedDynamic = name => name.startsWith('module-load:')
  for (const check of checks) {
    if (!expected.includes(check.name) && !allowedDynamic(check.name)) {
      return invalidResult('checker-invalid', `unknown check ${check.name}`, { ...base, checks })
    }
  }
  const missing = expected.filter(name => !seen.has(name))
  const agentError = payload.agentError === undefined ? undefined : String(payload.agentError)
  if (missing.length > 0 && agentError === undefined) {
    return invalidResult(
      'checker-invalid',
      `missing declared check(s): ${missing.join(', ')}`,
      { ...base, checks },
    )
  }
  const failed = checks.filter(check => !check.pass)
  // A non-zero exit with every check passing is not a task failure; the two
  // records disagree, so the measurement is invalid.
  if (payload.exitCode !== 0 && failed.length === 0 && agentError === undefined) {
    return invalidResult(
      'checker-invalid',
      `checker exited ${payload.exitCode} while reporting every check passed`,
      { ...base, checks },
    )
  }
  return {
    status: 'executed',
    checks,
    claims: payload.claims ?? {},
    ...(agentError === undefined ? {} : { agentError }),
    spoofMarkers: Number.isInteger(payload.spoofMarkers) ? payload.spoofMarkers : 0,
    ...base,
  }
  } finally {
    // The checker source and its private result file live outside the agent
    // workspace by design. Leaving them in the OS temp directory accumulated
    // thousands of directories across a full arm matrix.
    await rm(root, { recursive: true, force: true })
  }
}

/** Run the workspace's VISIBLE test command, which the agent may also run. */
export async function runVisibleTests(workspaceRoot, timeoutMs = 20_000, options = {}) {
  const result = await runNode(['--test', 'tests'], {
    cwd: workspaceRoot,
    env: childEnvironment(),
    timeoutMs,
    outputCap: options.outputCap,
  })
  return {
    exitCode: result.exitCode,
    passed: result.exitCode === 0 && !result.timedOut,
    timedOut: result.timedOut,
    processError: result.processError,
    outputTruncated: result.stdoutTruncated || result.stderrTruncated,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/** Read `verification.json` when the case asks for one. */
export async function readVerification(workspaceRoot) {
  try {
    const raw = await readFile(join(workspaceRoot, 'verification.json'), 'utf8')
    if (raw.length > 64 * 1024) return undefined
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A path relative to `root`, using POSIX separators; for reports only. */
export function relativePath(root, path) {
  return relative(root, path).split(sep).join('/')
}
