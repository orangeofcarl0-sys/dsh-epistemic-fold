/**
 * Task checkers.
 *
 * A check is a claim about the WORKSPACE, never about the transcript. The
 * transcript says what the agent claimed; the checker says what is true. Both
 * are recorded, and a disagreement between them is the `falseVerification`
 * signal the analysis reports.
 *
 * Checks are declarative so a task cannot quietly special-case a model:
 *
 *   tests               run the workspace test command
 *   json_equals         parse a JSON file and compare it exactly
 *   file_contains       substring in a file
 *   file_not_contains   substring absent from a file
 *   file_exists         path exists
 *   file_absent         path does not exist
 *   external_script     run a checker module with the workspace as argv[2]
 *
 * @module eval/e2e/src/checker
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const CHECK_TIMEOUT_MS = 60_000

function run(command, args, cwd, timeoutMs = CHECK_TIMEOUT_MS) {
  return new Promise(resolvePromise => {
    execFile(command, args, { cwd, timeout: timeoutMs, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        resolvePromise({
          exitCode: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
          timedOut: error?.killed === true,
          stdout: stdout.slice(0, 8_000),
          stderr: stderr.slice(0, 4_000),
        })
      })
  })
}

function stable(value) {
  return JSON.stringify(value)
}

async function runCheck(check, { workspace, repoRoot }) {
  switch (check.kind) {
    case 'tests': {
      const result = await run(process.execPath, ['--test'], workspace)
      return {
        kind: check.kind,
        pass: result.exitCode === 0 && !result.timedOut,
        detail: `node --test exit ${result.exitCode}`,
        output: result,
      }
    }
    case 'json_equals': {
      const file = join(workspace, check.path)
      if (!existsSync(file)) return { kind: check.kind, pass: false, detail: `${check.path} is missing` }
      let parsed
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        return { kind: check.kind, pass: false, detail: `${check.path} is not JSON: ${error.message}` }
      }
      const pass = stable(parsed) === stable(check.value)
      return {
        kind: check.kind,
        pass,
        detail: pass ? `${check.path} matches` : `${check.path} = ${stable(parsed)}, expected ${stable(check.value)}`,
      }
    }
    case 'file_contains':
    case 'file_not_contains': {
      const file = join(workspace, check.path)
      if (!existsSync(file)) return { kind: check.kind, pass: false, detail: `${check.path} is missing` }
      const text = await readFile(file, 'utf8')
      const found = text.includes(check.needle)
      const pass = check.kind === 'file_contains' ? found : !found
      return {
        kind: check.kind,
        pass,
        detail: pass
          ? `${check.path} ${check.kind === 'file_contains' ? 'contains' : 'does not contain'} the required text`
          : `${check.path} ${found ? 'contains' : 'does not contain'} ${JSON.stringify(check.needle)}`,
      }
    }
    case 'file_exists':
    case 'file_absent': {
      const present = existsSync(join(workspace, check.path))
      const pass = check.kind === 'file_exists' ? present : !present
      return { kind: check.kind, pass, detail: `${check.path} ${present ? 'exists' : 'is absent'}` }
    }
    case 'external_script': {
      const script = isAbsolute(check.path) ? check.path : resolve(repoRoot, check.path)
      const result = await run(process.execPath, [script, workspace], repoRoot)
      return {
        kind: check.kind,
        pass: result.exitCode === 0,
        detail: `${check.path} exit ${result.exitCode}`,
        output: result,
      }
    }
    default:
      return { kind: check.kind, pass: false, detail: `unknown check kind: ${String(check.kind)}` }
  }
}

/** Run every check. All must pass; each result is kept. */
export async function runChecks(checks, context) {
  const results = []
  for (const check of checks) results.push(await runCheck(check, context))
  return {
    pass: results.every(row => row.pass),
    checks: results,
  }
}
