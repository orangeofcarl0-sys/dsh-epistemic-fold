#!/usr/bin/env node
/**
 * Preflight: refuse to let a `file:` install ship a package with no `lib/`.
 *
 * ## The gap this closes
 *
 * `package.json` points `main` at `lib/entry.js`, and `lib/` is deliberately
 * gitignored — it is a build product, and this project's rule is that a
 * generated artifact must not become a second source of truth that drifts
 * (`scripts/build-plugin.mjs` states the same reasoning for `.d.ts` emission).
 *
 * That decision has a consequence on one install channel, measured:
 *
 *   git  channel  pnpm runs `prepare` → `lib/` is built → install works
 *                 (subject to pnpm's `allowBuilds` gate, which it prints)
 *   file: channel pnpm does NOT run `prepare`. Measured with a marker script:
 *                 the marker never ran. `lib/` is copied as it exists on disk,
 *                 so a clone that never ran `npm install` installs broken.
 *
 * The failure is loud but late: the loader reports
 *
 *   dsh: warning: 1 entry did not activate
 *   epistemic-fold-doctor (dsh-epistemic-fold): failed to import
 *
 * and — this is the sharp edge — the entry that fails to import IS the doctor,
 * the component whose job is to report install problems. It lives in `lib/`, so
 * it cannot diagnose the one condition that stops it loading. Nothing in the
 * package can. The check therefore has to run BEFORE the install, from the
 * source tree, which is what this script is.
 *
 * ## What it checks
 *
 *   1. `lib/` exists and contains every path `package.json` points at.
 *   2. No source file is NEWER than the build output, i.e. the tree does not
 *      hold a stale `lib/` that would install code the author no longer has.
 *
 * Freshness is by mtime, which is a heuristic — a checkout can reset mtimes —
 * so a stale verdict is reported as a warning-grade failure with the fix in the
 * message rather than as a silent pass. Absence is a hard failure, because that
 * state cannot load at all.
 *
 * ## Usage
 *
 *   node scripts/preflight-lib.mjs        # exits 1 when the tree cannot install
 *
 * `npm run prepare` runs the build first, so this is a no-op there. It matters
 * for the `file:` channel, where `prepare` never runs.
 *
 * @module scripts/preflight-lib
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name), rel))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** Newest mtime among the inputs that `lib/` is derived from. */
function newestInputMtime() {
  let newest = 0
  const consider = (path) => {
    if (!existsSync(path)) return
    const at = statSync(path).mtimeMs
    if (at > newest) newest = at
  }
  for (const rel of sourceFiles(join(ROOT, 'src'))) consider(join(ROOT, 'src', rel))
  // The client face is copied verbatim rather than transpiled, so it is an input too.
  consider(join(ROOT, 'client.js'))
  consider(join(ROOT, 'scripts', 'build-plugin.mjs'))
  return newest
}

function main() {
  const problems = []

  // 1. The entry points `package.json` names must actually be on disk.
  const required = ['lib/entry.js', 'lib/plugin.js', 'lib/client.js', 'lib/index.js']
  const missing = required.filter(rel => !existsSync(join(ROOT, rel)))
  if (missing.length > 0) {
    problems.push(
      `lib/ is absent or incomplete (missing: ${missing.join(', ')}).\n`
      + '    This tree cannot be installed as-is: `main` points at lib/entry.js, and the\n'
      + '    `file:` install channel does NOT run `prepare`, so pnpm would copy this\n'
      + '    directory without ever building it. The loader would then report\n'
      + '    "failed to import" for an entry that is itself the install doctor.\n'
      + '    Fix: run `npm install` (or `npm run build`) in this directory first.',
    )
  }

  // 2. A stale build installs code the author no longer has.
  if (missing.length === 0) {
    const input = newestInputMtime()
    let oldestOutput = Infinity
    for (const rel of ['lib/entry.js', 'lib/client.js']) {
      const at = statSync(join(ROOT, rel)).mtimeMs
      if (at < oldestOutput) oldestOutput = at
    }
    if (input > oldestOutput) {
      problems.push(
        'lib/ is STALE: a source file is newer than the build output.\n'
        + `    newest input  ${new Date(input).toISOString()}\n`
        + `    oldest output ${new Date(oldestOutput).toISOString()}\n`
        + '    Fix: run `npm run build` before installing. mtime is a heuristic, so a\n'
        + '    fresh checkout can trip this spuriously — rebuilding is cheap and always safe.',
      )
    }
  }

  if (problems.length > 0) {
    console.error('preflight-lib: this tree is not installable\n')
    for (const problem of problems) console.error(`  - ${problem}\n`)
    process.exit(1)
  }

  console.log('preflight-lib: lib/ present and current — this tree is installable')
}

main()
