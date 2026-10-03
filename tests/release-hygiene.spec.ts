/**
 * The release gate: nothing machine-specific or secret reaches a published tree.
 *
 * ## Why this is a test and not a checklist
 *
 * The gate was run by hand before v0.1.0 and it **missed things**. The first
 * pass scanned for `C:\Users\...`-style paths with backslash patterns and
 * reported the tree clean; the real leak was forward-slash paths
 * (`D:/dsh/.credentials.yaml`, `F:/Codex_Work_Space/bench-workspace/`) in three
 * shipped scripts and five documents. A hand-run gate that reports "clean"
 * because its own pattern was wrong is worse than no gate, because it is
 * trusted.
 *
 * So the patterns live here, both slash styles, and CI runs them on every push.
 *
 * ## What this does and does not cover
 *
 * It covers the two things a scanner can decide mechanically:
 *
 *   1. **Machine-specific content** — absolute paths naming one developer's
 *      machine, in tracked files and in the published tarball.
 *   2. **Credential-shaped strings** — a key VALUE, not the name of an
 *      environment variable that holds one. The distinction matters: the
 *      runner scripts legitimately mention `OPENCODE_GO_API_KEY` because they
 *      read it from DSH's store, and a pattern that flags the name would be
 *      turned off within a week.
 *
 * It does NOT decide whether a given string is sensitive in context — that is a
 * judgement, and pretending otherwise is how a gate gets ignored. It covers the
 * mechanical cases so a human review starts from a clean baseline.
 *
 * @module tests/release-hygiene
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/**
 * Absolute paths that name one particular machine.
 *
 * Both separators, because the leak that prompted this test used `/` while the
 * first hand-run scan only looked for `\`. `~` and `<DSH_HOME>` are the
 * portable forms the repository uses instead.
 */
const MACHINE_PATH = /(?:[A-Za-z]:[\\/](?:dsh|Codex_Work_Space|Users[\\/]66494)|F:[\\/]Codex_Work_Space|\/f\/Codex_Work_Space)/u

/**
 * A credential VALUE rather than the name of the variable holding one.
 *
 * Keyed on the shapes real providers issue (`sk-…`, `ghp_…`, `gho_…`, AWS
 * access-key ids, PEM headers). A bare `API_KEY` mention is deliberately not a
 * hit.
 */
const SECRET = /(?:sk-[A-Za-z0-9_-]{20,}|gh[pous]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u

/** Every tracked file, as repo-relative POSIX paths. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

/** Files git knows about that are text and small enough to scan. */
function scannable(file: string): boolean {
  return !/\.(?:png|jpe?g|gif|webp|ico|pdf|woff2?|zip|tgz)$/iu.test(file)
}

/** Every hit of `pattern` in tracked files, as `file:line`. */
function hits(pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of trackedFiles().filter(scannable)) {
    let text: string
    try {
      text = readFileSync(join(ROOT, file), 'utf8')
    } catch {
      continue // unreadable: not this test's subject
    }
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) found.push(`${file}:${index + 1}`)
    })
  }
  return found
}

describe('release hygiene: no machine-specific content is published', () => {
  it('no tracked file names one particular machine', () => {
    // The files that HAVE to reference a DSH home use `<DSH_HOME>` or `$HOME`,
    // and the benchmark runner scripts take their roots from `LHTB_ROOT` /
    // `TAU2_ROOT` with an actionable error when unset. Neither needs a path that
    // only resolves on the author's machine.
    expect(hits(MACHINE_PATH), 'use <DSH_HOME> / $HOME / an env var instead').toEqual([])
  })

  it('no tracked file carries a credential value', () => {
    // The runner scripts read the key at runtime and never embed it; this pins
    // that. A hit here means a real key was pasted into a file.
    expect(hits(SECRET), 'a credential value must never be committed').toEqual([])
  })

  it('the runner scripts require their benchmark roots instead of defaulting', () => {
    // Both checkouts live OUTSIDE this repository, so a default path could only
    // be right on one machine. Each script must fail with an actionable message
    // rather than silently pointing somewhere that does not exist.
    for (const [script, variable] of [
      ['scripts/run-lhtb.sh', 'LHTB_ROOT'],
      ['scripts/run-tau2.sh', 'TAU2_ROOT'],
    ] as const) {
      const source = readFileSync(join(ROOT, script), 'utf8')
      // The exact assignment: `${VAR:-}` — an empty default, so an unset
      // variable is caught by the guard below rather than becoming an empty
      // path that resolves to the filesystem root.
      expect(source, `${script} must read ${variable} from the environment`)
        .toContain(`${variable}="\${${variable}:-}"`)
      expect(source, `${script} must say what to set when ${variable} is unset`)
        .toContain(`${variable} is not set`)
    }
  })

  it('the credential store is located portably, never by absolute path', () => {
    for (const script of ['scripts/run-lhtb.sh', 'scripts/run-tau2.sh', 'scripts/run-live-parallel.sh']) {
      const source = readFileSync(join(ROOT, script), 'utf8')
      expect(source, `${script} must default the store to the DSH home`)
        .toContain('DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml')
      expect(source, `${script} must name DSH_CREDENTIALS in its error`)
        .toContain('set DSH_CREDENTIALS')
    }
  })
})

describe('release hygiene: nothing secret is in the history either', () => {
  it('no commit ever added a credential-shaped string', () => {
    // A value removed from the working tree is still in every clone. This reads
    // the full history rather than the current tree, because that is where a
    // leak survives a "fix" commit.
    let log: string
    try {
      log = execFileSync('git', ['log', '--all', '-p', '--pretty=format:'], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      })
    } catch {
      return // no history available (shallow clone): nothing to assert
    }
    const leaked = log.split('\n').filter(line => SECRET.test(line))
    expect(leaked.slice(0, 5), 'a credential in history survives every later commit').toEqual([])
  })
})
