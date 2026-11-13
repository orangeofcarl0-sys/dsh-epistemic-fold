#!/usr/bin/env node
/**
 * Run a command with extra environment variables, portably.
 *
 * ## Why this exists
 *
 * The C1 verify/generate split is selected by an environment variable
 * (`EF_R1_REPORT_MODE`, `EF_R33_OFFLINE_REPORT_OUT`). The POSIX form
 *
 *   EF_R1_REPORT_MODE=generate npx vitest run ...
 *
 * is a syntax error under `cmd.exe`, which is what npm uses to run scripts on
 * Windows. A cross-platform wrapper is cheaper than a `cross-env` dependency,
 * and it keeps the npm script readable.
 *
 * ## Usage
 *
 *   node scripts/run-with-env.mjs KEY=VALUE [KEY=VALUE...] -- <command...>
 *
 * Every `KEY=VALUE` before `--` is merged into the child's environment. The
 * child's exit code is this process's exit code.
 *
 * @module scripts/run-with-env
 */

import { spawnSync } from 'node:child_process'

const separator = process.argv.indexOf('--')
if (separator === -1 || separator === process.argv.length - 1) {
  process.stderr.write('usage: node scripts/run-with-env.mjs KEY=VALUE [...] -- <command...>\n')
  process.exit(1)
}

const assignments = process.argv.slice(2, separator)
const command = process.argv.slice(separator + 1)
const env = { ...process.env }

for (const assignment of assignments) {
  const at = assignment.indexOf('=')
  if (at <= 0) {
    process.stderr.write(`run-with-env: expected KEY=VALUE, got ${JSON.stringify(assignment)}\n`)
    process.exit(1)
  }
  env[assignment.slice(0, at)] = assignment.slice(at + 1)
}

const child = spawnSync(command[0], command.slice(1), {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
})
process.exit(child.status ?? 1)
