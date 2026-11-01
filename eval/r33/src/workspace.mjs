/**
 * Workspace materialization and hidden-checker execution.
 *
 * The checker never lives inside the agent's workspace: it is written to a
 * separate temp directory and imports the workspace by absolute file URL. That
 * is the no-gold-leakage rule at the filesystem level, not a convention.
 *
 * The checker prints one line beginning with `R33_RESULT ` followed by JSON:
 *
 *   { "checks": [{ "name": "...", "pass": true, "detail": "..." }],
 *     "claims": { ... } }
 *
 * A checker that crashes or prints unparseable output is an INVALID measurement
 * (`checker-invalid`), not a task failure: the harness must be able to tell
 * "the agent did the wrong thing" from "the evaluation did not run".
 *
 * @module eval/r33/src/workspace
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** Write one `path -> content` map under `root`, creating parent directories. */
export async function materialize(files, root) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

/** Apply one action's file edits on top of the workspace. */
export async function applyAction(action, root) {
  await materialize(action.files ?? {}, root)
}

/** Run a child process with a hard timeout, capturing output. */
export function runNode(args, options = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 20_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      clearTimeout(timeout)
      resolvePromise({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false })
    })
    child.on('close', code => {
      clearTimeout(timeout)
      resolvePromise({ exitCode: code ?? -1, stdout, stderr, timedOut: false })
    })
  })
}

/**
 * Execute one case's hidden checker against a finished workspace.
 *
 * @param {object} caseData - frozen case.
 * @param {string} workspaceRoot - the agent's workspace.
 * @returns {Promise<object>} `{status, checks, claims, stdout, stderr, elapsedMs}`.
 */
export async function runChecker(caseData, workspaceRoot) {
  const root = await mkdtemp(join(tmpdir(), `r33-check-${caseData.id}-`))
  const checkerPath = join(root, 'check.mjs')
  await writeFile(checkerPath, caseData.checker.source, 'utf8')
  const started = Date.now()
  const result = await runNode([checkerPath], {
    cwd: root,
    env: { R33_WORKSPACE: resolve(workspaceRoot), R33_CASE: caseData.id },
    timeoutMs: caseData.checker.timeoutMs ?? 20_000,
  })
  const elapsedMs = Date.now() - started
  const line = result.stdout.split(/\r?\n/u).find(entry => entry.startsWith('R33_RESULT '))
  if (line === undefined) {
    return {
      status: 'checker-invalid',
      checks: [],
      claims: {},
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      elapsedMs,
    }
  }
  let payload
  try {
    payload = JSON.parse(line.slice('R33_RESULT '.length))
  } catch (error) {
    return {
      status: 'checker-invalid',
      checks: [],
      claims: {},
      stdout: result.stdout,
      stderr: `${result.stderr}\n${String(error)}`,
      exitCode: result.exitCode,
      elapsedMs,
    }
  }
  if (!Array.isArray(payload.checks)) {
    return {
      status: 'checker-invalid',
      checks: [],
      claims: {},
      stdout: result.stdout,
      stderr: `${result.stderr}\nchecker payload has no checks array`,
      exitCode: result.exitCode,
      elapsedMs,
    }
  }
  return {
    status: 'executed',
    checks: payload.checks.map(check => ({
      name: String(check.name),
      pass: check.pass === true,
      detail: check.detail === undefined ? undefined : String(check.detail),
    })),
    claims: payload.claims ?? {},
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    elapsedMs,
  }
}

/** Run the workspace's VISIBLE test command, which the agent may also run. */
export async function runVisibleTests(workspaceRoot, timeoutMs = 20_000) {
  const result = await runNode(['--test', 'tests'], { cwd: workspaceRoot, timeoutMs })
  return {
    exitCode: result.exitCode,
    passed: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/** Read `verification.json` when the case asks for one. */
export async function readVerification(workspaceRoot) {
  try {
    return JSON.parse(await readFile(join(workspaceRoot, 'verification.json'), 'utf8'))
  } catch {
    return undefined
  }
}
