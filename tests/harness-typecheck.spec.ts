/**
 * The benchmark harness is TYPECHECKED, and its contract with the engine is pinned.
 *
 * ## The defect this exists for
 *
 * `eval/` was covered by no tsconfig: the main project includes only `src/**` and
 * `tests/**`, the client project only `client.js`. `bench/` was in the same
 * position. RC21 found and fixed exactly this shape for `client.js` ("the one
 * file no compiler had ever looked at") and the lesson was written down — but the
 * same gap survived one directory over, and it was not empty.
 *
 * Adding the project surfaced eleven errors, and three of them were real defects
 * that no test could have caught:
 *
 *   1. `bridge-host.ts` passed `'auto'` as a `CompactionTrigger`. The union is
 *      `'pressure' | 'context-overflow'`, so this is not a valid argument at all.
 *      The EF arm absorbed it — an unrecognised trigger falls through to the
 *      pressure path — but Basic has an `assertNever` on the same switch, so the
 *      moment the `basic` arm is fixed to construct a real Basic engine (a
 *      planned harness change) it would throw
 *      `unreachable variant in compaction trigger: "auto"` on its first fold.
 *      A harness fix that would have failed immediately, with the cause three
 *      files away from the symptom.
 *   2. A dead local (`before`) left over from an earlier counter design.
 *   3. Four union-narrowing errors: `TauMessage | TauMultiTool` never narrowed,
 *      so `message.content` and `message.id` were read off a type that may not
 *      have them. Fixed with a real type predicate, not a cast.
 *
 * ## Why the harness imported `lib/` at all
 *
 * It was the only module under `eval/` doing so; every other one imports
 * `src/*.ts` directly. That matters because the build deliberately emits NO
 * `.d.ts` ("emitting declarations would create a SECOND artifact"), so a `lib/`
 * import resolves to `any` — which is what silenced all of the above. The
 * runtime loads the `.ts` sources anyway via `--experimental-transform-types`,
 * so the `lib/` import bought nothing and cost the typecheck.
 *
 * @module tests/harness-typecheck
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** Every `.ts` file under a directory, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('the benchmark harness is typechecked', () => {
  it('a tsconfig project covers eval/ and bench/', () => {
    // The project must exist AND be reachable from `typecheck:all`, or the check
    // is decoration: a project nobody runs cannot fail a build.
    const configPath = join(ROOT, 'tsconfig.eval.json')
    expect(existsSync(configPath), 'tsconfig.eval.json must exist').toBe(true)
    const config = JSON.parse(
      readFileSync(configPath, 'utf8').replace(/^\s*\/\/.*$/gmu, ''),
    ) as { include?: readonly string[] }
    const include = config.include ?? []
    expect(include.some(entry => entry.startsWith('eval/'))).toBe(true)
    expect(include.some(entry => entry.startsWith('bench/'))).toBe(true)

    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scripts = pkg.scripts ?? {}
    expect(
      scripts['typecheck:all'],
      'typecheck:all must run the eval project, or the project is never checked',
    ).toContain('typecheck:eval')
    expect(scripts['typecheck:eval']).toContain('tsconfig.eval.json')
  })

  it('BOTH CI lanes run the harness typecheck', () => {
    // `typecheck:all` is the local convenience; CI is what actually gates a
    // merge, and a project wired into one lane but not the other is a hole on
    // the lane that skips it. Both lanes are asserted by name so a future lane
    // cannot be added without this check being considered.
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const laneCount = (workflow.match(/npm run typecheck:eval/gu) ?? []).length
    expect(
      laneCount,
      'each CI lane must run `npm run typecheck:eval`, or the harness is only checked locally',
    ).toBeGreaterThanOrEqual(2)
  })

  it('no module under eval/ or bench/ imports the built lib/ output', () => {
    // A `lib/*.js` import resolves to `any` (no `.d.ts` is emitted), which
    // silences the file without any visible symptom. Importing the `.ts` source
    // is both what the runtime loads and what the compiler can check.
    const offenders: string[] = []
    for (const dir of ['eval', 'bench']) {
      for (const file of tsFiles(join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(/from\s+'([^']*\/lib\/[^']*\.js)'/gu)) {
          offenders.push(`${file.slice(ROOT.length + 1)} imports ${match[1]}`)
        }
      }
    }
    expect(
      offenders,
      'a lib/ import is untyped (no .d.ts is shipped); import the src/*.ts module instead',
    ).toEqual([])
  })

  it('no caller passes a trigger outside CompactionTrigger', () => {
    // `'auto'` was the invalid value, and it is the one that would have thrown
    // from Basic's assertNever. The union is read from the engine's own use so
    // this does not hard-code a second copy of it.
    const VALID = ['pressure', 'context-overflow']
    const offenders: string[] = []
    for (const dir of ['eval', 'bench', 'src', 'tests']) {
      for (const file of tsFiles(join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(/compactIfNeeded\([^,]+,\s*'([^']+)'/gu)) {
          const trigger = match[1]!
          if (!VALID.includes(trigger)) {
            offenders.push(`${file.slice(ROOT.length + 1)} passes '${trigger}'`)
          }
        }
      }
    }
    expect(
      offenders,
      `a trigger outside ${VALID.join(' | ')} reaches Basic's assertNever and throws`,
    ).toEqual([])
  })
})
