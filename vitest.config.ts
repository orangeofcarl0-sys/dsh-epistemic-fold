import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
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
// with the vendored session-projection's zod@4.4.3.
const vendorZod = posix(resolve(root, 'vendor/deepseek-harness/node_modules/.pnpm/zod@4.4.3/node_modules/zod'))

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: [{ find: /^zod$/, replacement: vendorZod }, ...fileAliases, ...dirExactAliases, ...dirPrefixAliases],
  },
  test: {
    pool: 'forks',
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
    // Reclaims each worker's scratch directories on the way out. Without it a
    // full run leaves a few hundred empty directories behind; see tests/setup.ts.
    setupFiles: ['tests/setup.ts'],
  },
})
