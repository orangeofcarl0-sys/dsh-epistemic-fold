import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolves every `@deepseek-ai/*` import against the vendored DSH sources —
// the same source-level resolution the DSH monorepo itself uses, so tests run
// without a build step. Built from scripts/vendor-paths.json (extracted from
// the vendor tsconfig.base.json paths) instead of vite-tsconfig-paths so the
// `*/src/*` subpath exports and directory index resolution are explicit.
const root = dirname(fileURLToPath(import.meta.url))
const map: Record<string, string[]> = JSON.parse(
  readFileSync(join(root, 'scripts', 'vendor-paths.json'), 'utf8'),
)

const ESC = /[.*+?^${}()|[\]\\]/g
const escape = (value: string): string => value.replace(ESC, '\\$&')
const posix = (value: string): string => value.replace(/\\/g, '/')

const fileAliases: Array<{ find: RegExp; replacement: string }> = []
const dirExactAliases: Array<{ find: RegExp; replacement: string }> = []
const dirPrefixAliases: Array<{ find: RegExp; replacement: string }> = []

for (const [key, targets] of Object.entries(map)) {
  if (key.includes('*') || targets.length === 0) continue
  const target = targets[0]!
  // The vendor tsconfig names every workspace path, including packages the
  // vendored 0.1.7 tree does not ship (the native system addons). An alias to a
  // missing file does not "fall back": Vite fails the whole import graph. Skip
  // it so the installed package resolves normally. The drift itself is not
  // hidden — the package-version tests still report it — only the loader
  // failure is avoided.
  if (!existsSync(resolve(root, target))) continue
  const absolute = posix(resolve(root, target))
  if (/\.(ts|json|css)$/.test(target)) {
    fileAliases.push({ find: new RegExp(`^${escape(key)}$`), replacement: absolute })
  } else {
    dirExactAliases.push({ find: new RegExp(`^${escape(key)}$`), replacement: `${absolute}/index.ts` })
    // Subpaths resolve against the package root (the `./src/*` exports face),
    // so a target ending in `/src` strips it before appending the remainder.
    const packageRoot = absolute.endsWith('/src') ? absolute.slice(0, -'/src'.length) : absolute
    dirPrefixAliases.push({ find: new RegExp(`^${escape(key)}/(.*)$`), replacement: `${packageRoot}/$1` })
  }
}

// Replicates DSH's vitest.shared.ts standardDecoratorPlugin: pre-transforms
// decorator syntax (e.g. `@Remote` in dsh-llm) before vite's esbuild parser
// sees it, since the vendored sources rely on standard decorators.
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m
const standardDecoratorPlugin = () => ({
  name: 'dsh-standard-decorators',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    const file = id.split('?', 1)[0]!
    if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
    const result = ts.transpileModule(code, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
        sourceMap: true,
      },
    })
    return {
      code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
      map: result.sourceMapText,
    }
  },
})

// zod must be a SINGLE physical copy: the EF projection's schema types unify
// with the vendored session-projection's zod@4.4.3. A worktree that does not
// carry the gitignored vendor tree (every worktree except the one that
// materialized it) falls back to the installed copy rather than aliasing a
// path Vite cannot resolve.
const vendorZod = posix(resolve(root, 'vendor/deepseek-harness/node_modules/.pnpm/zod@4.4.3/node_modules/zod'))
const zodAlias = existsSync(vendorZod) ? vendorZod : undefined

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: [
      ...(zodAlias === undefined ? [] : [{ find: /^zod$/, replacement: zodAlias }]),
      ...fileAliases, ...dirExactAliases, ...dirPrefixAliases,
    ],
  },
  test: {
    pool: 'forks',
    // This repository's suites already fork child processes (real DSH folds,
    // the bridge, release hygiene), and the R33 arm matrix adds a hidden
    // checker per case/arm. One fork per logical CPU let the full run exhaust
    // memory on this machine, which surfaced as `exit 134` and checker result
    // files that never appeared -- not as assertion failures. Vitest 5 moved
    // these bounds out of `poolOptions` (that key is now ignored), so they are
    // top-level. Bounding the pool makes the result reproducible without
    // narrowing any test.
    maxWorkers: 4,
    minWorkers: 1,
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
    // Reclaims each worker's scratch directories on the way out. Without it a
    // full run leaves a few hundred empty directories behind; see tests/setup.ts.
    setupFiles: ['tests/setup.ts'],
  },
})
