/**
 * RC2: real workspace tools for a real long task.
 *
 * The RC1.3 probe measured retrieval with a conversation that carried no real
 * work — the model searched because it was asked a question, not because a task
 * required it. RC2 §2 asks for actual DSH tasks instead: coding, engineering,
 * tool-heavy work, with the lifecycle events a long session hits.
 *
 * So these are REAL tools over a REAL temporary directory. `write_file` writes,
 * `read_file` reads, `run_node` executes. A task's outcome is therefore checkable
 * by inspecting the filesystem afterwards — which is what makes TaskQuality a
 * measurement rather than a judgement about the model's prose.
 *
 * ## Confinement
 *
 * Every path is resolved and checked against the workspace root before use. A
 * model that emits `../../etc/passwd` gets an error, not a file. This is a real
 * boundary, not a formality: the tools are model-driven, and the model's
 * arguments are untrusted input.
 *
 * @module eval/real-task/workspace-tools
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/**
 * Resolve a model-supplied path inside the workspace.
 *
 * @throws when the path escapes the root. The check is on the RESOLVED path, so
 *   symlink-free traversal (`..`, absolute paths, mixed separators) is caught.
 */
export function confinePath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`path escapes the workspace: ${candidate}`)
  }
  return resolved
}

/** The tool names the workspace exposes, so a driver can count calls by name. */
export const WORKSPACE_TOOL_NAMES = ['write_file', 'read_file', 'list_files', 'run_node'] as const
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number]

/**
 * Register the workspace tools against `ctx.tools`.
 *
 * @param ctx - the context whose ToolRuntime registers them.
 * @param root - the workspace directory; created if absent.
 * @returns the exact disposer that unregisters every tool.
 */
export function registerWorkspaceTools(ctx: Context, root: string): () => void {
  const workspaceRoot = resolve(root)

  const writeFileTool = defineTool({
    name: 'write_file',
    description: 'Write text to a file in the workspace, creating parent directories.',
    parameters: {
      path: { type: 'string', description: 'workspace-relative file path' },
      content: { type: 'string', description: 'exact file contents' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(JSON.stringify(value)) },
    async execute(args) {
      const { path, content } = args as { path: string; content: string }
      const target = confinePath(workspaceRoot, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      return { path, bytes: Buffer.byteLength(content, 'utf8') }
    },
    isConcurrencySafe: () => false,
  })

  const readFileTool = defineTool({
    name: 'read_file',
    description: 'Read a file from the workspace. Returns the exact contents.',
    parameters: { path: { type: 'string', description: 'workspace-relative file path' } },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(JSON.stringify(value)) },
    async execute(args) {
      const { path } = args as { path: string }
      const target = confinePath(workspaceRoot, path)
      try {
        const content = await readFile(target, 'utf8')
        return { path, content, bytes: Buffer.byteLength(content, 'utf8') }
      } catch (error: unknown) {
        // Absence is a NORMAL outcome for a model exploring a tree, so it is
        // reported as data rather than thrown: a throw would read to the model
        // as a tool malfunction.
        return { path, missing: true, reason: error instanceof Error ? error.message : String(error) }
      }
    },
    isConcurrencySafe: () => true,
  })

  const listFilesTool = defineTool({
    name: 'list_files',
    description: 'List files in a workspace directory, recursively. Directories end with a slash.',
    parameters: { path: { type: 'string', description: 'workspace-relative directory (default: root)' } },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(JSON.stringify(value)) },
    async execute(args) {
      const { path } = args as { path?: string }
      const target = confinePath(workspaceRoot, path ?? '.')
      const found: string[] = []
      const walk = async (dir: string): Promise<void> => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = join(dir, entry.name)
          const rel = relative(workspaceRoot, full).split(sep).join('/')
          if (entry.isDirectory()) {
            found.push(`${rel}/`)
            await walk(full)
          } else {
            found.push(rel)
          }
        }
      }
      await walk(target)
      return { path: path ?? '.', files: found.sort() }
    },
    isConcurrencySafe: () => true,
  })

  const runNodeTool = defineTool({
    name: 'run_node',
    description:
      'Run a Node.js script in the workspace and return its exit code, stdout and stderr. '
      + 'Use it to verify code you wrote actually runs.',
    parameters: {
      file: { type: 'string', description: 'workspace-relative .js file to execute' },
      args: { type: 'array', items: { type: 'string' }, description: 'optional CLI arguments' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textBlock(JSON.stringify(value)) },
    async execute(args) {
      const { file, args: argv } = args as { file: string; args?: string[] }
      const target = confinePath(workspaceRoot, file)
      return await new Promise<{ file: string; code: number; stdout: string; stderr: string }>(resolveRun => {
        const child = spawn(process.execPath, [target, ...(argv ?? [])], {
          cwd: workspaceRoot,
          // A minimal environment: the tool runs model-authored code, so it does
          // not inherit this process's credentials.
          env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: '' },
          timeout: 20_000,
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.on('error', error => resolveRun({
          file, code: -1, stdout, stderr: `${stderr}${String(error)}`,
        }))
        child.on('close', code => resolveRun({
          file,
          code: code ?? -1,
          // Bounded: a runaway script must not flood the model's context with
          // the very output this experiment is measuring.
          stdout: stdout.slice(0, 4_000),
          stderr: stderr.slice(0, 4_000),
        }))
      })
    },
    isConcurrencySafe: () => false,
  })

  const disposers = [
    ctx.tools.register(writeFileTool),
    ctx.tools.register(readFileTool),
    ctx.tools.register(listFilesTool),
    ctx.tools.register(runNodeTool),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Remove a workspace; used by a driver between arms. */
export async function resetWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
}
