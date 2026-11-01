#!/usr/bin/env node
/**
 * Build the eval-only TypeScript adapters to plain JavaScript.
 *
 * `scripts/build-plugin.mjs` builds `src/` because a real DSH loader can only
 * import JS. The live runner has the same constraint: Node cannot execute the
 * adapter's constructor parameter properties, and `eval/live/openai-adapter.ts`
 * uses them. This script transpiles the three-file adapter closure that the
 * live runner needs into `eval/live/dist/`, leaving the TypeScript source as
 * the single source of truth.
 *
 * It deliberately does NOT build `eval/live/full-wire.ts` or the rest of the
 * eval tree: those import `tests/` and `src/` TypeScript and are exercised by
 * vitest, not by a plain-Node live entry.
 *
 * @module scripts/build-eval
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'eval', 'live')
const OUT = join(SRC, 'dist')

const FILES = ['openai-adapter.ts', 'request-budget.ts', 'zcode-config.ts']

function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      rewriteRelativeImportExtensions: true,
      useDefineForClassFields: true,
      sourceMap: false,
      removeComments: false,
      verbatimModuleSyntax: false,
    },
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
  if (errors.length > 0) {
    const text = errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')
    throw new Error(`eval build: ${fileName} failed to transpile: ${text}`)
  }
  return result.outputText
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
for (const name of FILES) {
  const source = await readFile(join(SRC, name), 'utf8')
  await writeFile(join(OUT, name.replace(/\.ts$/u, '.js')), transpile(source, name), 'utf8')
}
process.stdout.write(`eval build: wrote ${FILES.length} module(s) to ${relative(ROOT, OUT)}/\n`)
