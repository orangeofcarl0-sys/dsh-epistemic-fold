/**
 * The toolset every arm sees.
 *
 * The same six tools are registered for B0, Bv, E0 and E1. No arm gets an EF
 * recall tool that another lacks, and no arm gets a harness-side shortcut: the
 * agent reads, writes, edits, runs the tests and says when it is done. That is
 * the whole contract.
 *
 * ## Bounds
 *
 * `read_file` truncates at 24,000 characters and SAYS SO in the result. A
 * silent truncation would let a task look impossible for a reason that is the
 * harness's fault. `run_tests` has a hard timeout, because a hung test process
 * would consume the cell's wall-clock budget without producing a measurement.
 *
 * @module eval/e2e/src/tools
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const READ_LIMIT = 24_000
const TEST_TIMEOUT_MS = 60_000

/** Resolve a workspace-relative path, refusing anything that escapes it. */
function inside(workspace, path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('path is required')
  const root = resolve(workspace)
  const full = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, full)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${path}`)
  }
  return full
}

function textBlocks(text) {
  return [{ type: 'text', text }]
}

function jsonTool({ name, description, parameters, execute, concurrencySafe = false }) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => textBlocks(JSON.stringify(value)),
    },
    async execute(args) {
      return execute(args)
    },
    isConcurrencySafe: () => concurrencySafe,
  })
}

/** The tools, bound to one workspace. */
export function buildTools({ workspace, state }) {
  return [
    jsonTool({
      name: 'list_dir',
      description: 'List one directory in the workspace (names only, one level).',
      parameters: { path: { type: 'string', description: 'directory path, "." for the root' } },
      concurrencySafe: true,
      async execute(args) {
        const dir = inside(workspace, args.path ?? '.')
        const entries = await readdir(dir, { withFileTypes: true })
        return {
          path: args.path ?? '.',
          entries: entries
            .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        }
      },
    }),

    jsonTool({
      name: 'read_file',
      description: 'Read one UTF-8 file from the workspace.',
      parameters: { path: { type: 'string', description: 'file path' } },
      concurrencySafe: true,
      async execute(args) {
        const file = inside(workspace, args.path)
        const content = await readFile(file, 'utf8')
        const truncated = content.length > READ_LIMIT
        return {
          path: args.path,
          content: truncated ? content.slice(0, READ_LIMIT) : content,
          chars: content.length,
          truncated,
          ...(truncated ? { note: `truncated to ${READ_LIMIT} chars` } : {}),
        }
      },
    }),

    jsonTool({
      name: 'write_file',
      description: 'Create or replace one UTF-8 file in the workspace.',
      parameters: {
        path: { type: 'string', description: 'file path' },
        content: { type: 'string', description: 'full file content' },
      },
      async execute(args) {
        const file = inside(workspace, args.path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, args.content, 'utf8')
        state.writes += 1
        return { path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') }
      },
    }),

    jsonTool({
      name: 'edit_file',
      description: 'Replace exactly one occurrence of old_string with new_string in a file.',
      parameters: {
        path: { type: 'string', description: 'file path' },
        old_string: { type: 'string', description: 'exact text to replace' },
        new_string: { type: 'string', description: 'replacement text' },
      },
      async execute(args) {
        const file = inside(workspace, args.path)
        const content = await readFile(file, 'utf8')
        const at = content.indexOf(args.old_string)
        if (at === -1) throw new Error('old_string was not found in the file')
        if (content.indexOf(args.old_string, at + 1) !== -1) {
          throw new Error('old_string appears more than once; include more context')
        }
        const next = content.slice(0, at) + args.new_string + content.slice(at + args.old_string.length)
        await writeFile(file, next, 'utf8')
        state.writes += 1
        return { path: args.path, bytes: Buffer.byteLength(next, 'utf8') }
      },
    }),

    jsonTool({
      name: 'run_tests',
      description: 'Run the workspace test command (node --test) and return its output.',
      parameters: {},
      async execute() {
        state.testRuns += 1
        return new Promise(resolvePromise => {
          execFile(
            process.execPath,
            ['--test'],
            { cwd: workspace, timeout: TEST_TIMEOUT_MS, encoding: 'utf8', windowsHide: true },
            (error, stdout, stderr) => {
              const exitCode = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
              state.testsExecuted += 1
              state.lastTest = { exitCode, at: Date.now() }
              resolvePromise({
                command: 'node --test',
                exitCode,
                timedOut: error?.killed === true,
                stdout: stdout.slice(0, 12_000),
                stderr: stderr.slice(0, 4_000),
              })
            },
          )
        })
      },
    }),

    jsonTool({
      name: 'finish',
      description: 'Declare the task finished and give a short summary.',
      parameters: { summary: { type: 'string', description: 'what was done' } },
      async execute(args) {
        state.finished = true
        state.finishSummary = args.summary
        return { done: true }
      },
    }),
  ]
}

/** The mutable record one cell keeps about tool use. */
export function createToolState({ maxSteps }) {
  return {
    writes: 0,
    testRuns: 0,
    testsExecuted: 0,
    lastTest: null,
    finished: false,
    finishSummary: null,
    maxSteps,
  }
}

/** Register the toolset on one agent's scoped context. */
export function registerTools(agentCtx, { workspace, state }) {
  for (const tool of buildTools({ workspace, state })) agentCtx.tools.register(tool)
  return state
}

/** Test whether a path exists (used by the checker, not by the agent). */
export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
