#!/usr/bin/env node
/**
 * Build the plugin into `lib/` as loadable JavaScript (RC3).
 *
 * ## Why this exists
 *
 * Through RC2.1 this package's entry was `src/index.ts` — raw TypeScript. That
 * is fine for a repository whose tests run the vendored DSH SOURCES through a
 * vitest alias table, but it makes the package UNLOADABLE by a real DSH: the
 * loader `import()`s the entry, and Node cannot execute TypeScript (EF uses
 * constructor parameter properties, which strip-only mode rejects outright).
 *
 * A real DSH plugin ships built JS. `dsh-contextvm`, the third-party plugin
 * installed in this machine's profile, declares `"main": "lib/index.js"` and
 * ships `lib/` with no `.d.ts` at all. This script produces the same shape.
 *
 * ## What it does
 *
 * Uses the TypeScript compiler already in `node_modules` to transpile each
 * `src/**\/*.ts` to `lib/**\/*.js`, with `rewriteRelativeImportExtensions` so
 * the source's `./engine.ts` specifiers become `./engine.js` in the output.
 * EF's source imports are all either relative (`./x.ts`) or external
 * (`@deepseek-ai/*`), and nothing outside `src/` is imported, so a per-file
 * transpile is sufficient — no bundling, and the emitted tree mirrors the
 * source tree so a stack trace points at a file a reader can find.
 *
 * `import type` statements are erased by the transpiler, so the one subpath
 * import EF makes for a type (`@deepseek-ai/dsh-token-meter/client`) leaves no
 * runtime dependency behind.
 *
 * ## What it does NOT do
 *
 * No bundling, no minification, no `.d.ts` emission. The runtime needs plain
 * JS; a consumer that wants types reads the TypeScript source, which stays the
 * single source of truth. Emitting declarations would create a SECOND artifact
 * that can drift from the source, which is the failure mode this project
 * avoids everywhere else.
 *
 * @module scripts/build-plugin
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const OUT = join(ROOT, 'lib')

/** Every `.ts` file under `src/`, recursively, as paths relative to `src/`. */
async function collect(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...await collect(join(dir, entry.name), rel))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(rel)
    }
  }
  return found
}

/**
 * Transpile one file.
 *
 * `rewriteRelativeImportExtensions` is the load-bearing option: without it the
 * output would still say `./engine.ts` and Node would refuse to resolve it,
 * because the emitted file is `engine.js`.
 */
function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      rewriteRelativeImportExtensions: true,
      // Decorators are used by DSH services EF extends; keep them as written.
      experimentalDecorators: false,
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
    throw new Error(`build: ${fileName} failed to transpile: ${text}`)
  }
  return result.outputText
}

async function main() {
  await rm(OUT, { recursive: true, force: true })
  const files = (await collect(SRC)).sort()
  if (files.length === 0) throw new Error('build: no source files found under src/')

  for (const rel of files) {
    const source = await readFile(join(SRC, rel), 'utf8')
    const js = transpile(source, rel)
    const target = join(OUT, rel.replace(/\.ts$/u, '.js'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, js, 'utf8')
  }

  // The CLIENT face is copied verbatim, not transpiled: it is already in the
  // loader's own `window.__ModuleLoader__.load({...})` format and imports only
  // React, which the host provides. Shipping it through the compiler would
  // rewrite those shared imports into file paths the browser cannot resolve.
  const clientSource = await readFile(join(ROOT, 'client.js'), 'utf8')
  await writeFile(join(OUT, 'client.js'), clientSource, 'utf8')

  console.log(`build: wrote ${files.length} module(s) to ${relative(ROOT, OUT)}/`)
  console.log(`build: client face ${relative(ROOT, join(OUT, 'client.js'))}`)
  console.log(`build: entry ${relative(ROOT, join(OUT, 'index.js'))}`)
}

await main()
