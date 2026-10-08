/**
 * RC3: the plugin must be LOADABLE by a real DSH.
 *
 * Through RC2.1 this package could not be mounted in a harness at all: its entry
 * was raw TypeScript, it declared no bundle patch, and its library face and its
 * plugin face were the same export. The tests here pin the packaging contract so
 * that cannot regress — every one of them corresponds to a failure that was
 * actually observed while mounting EF into a real DSH 0.2.0-rc.2 install.
 *
 * @module tests/rc3-plugin-packaging
 */

import { describe, expect, it } from 'vitest'
import { readFile, access } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from './harness.ts'

const ROOT = join(import.meta.dirname, '..')

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(ROOT, path), 'utf8')) as Record<string, unknown>
}

describe('RC3: the package declares a real plugin entry', () => {
  it('points `main` and the `.` export at the BUILT plugin entry', async () => {
    // THE DEFECT THIS PINS: `main` was `src/index.ts`. A real DSH `import()`s
    // that entry, and Node cannot execute TypeScript — the boot failed with
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before any plugin code ran.
    const pkg = await readJson('package.json')
    expect(pkg['main']).toBe('lib/entry.js')
    const exports = pkg['exports'] as Record<string, unknown>
    // `.` is what the loader resolves when a profile row names this package, so
    // it must be the PLUGIN, not the library. The library face lives at
    // `./library` for programmatic consumers.
    expect(exports['.']).toEqual({ types: './src/entry.ts', default: './lib/entry.js' })
    expect(exports['./library']).toBeDefined()
  })

  it('declares the bundle patch a profile loader consumes', async () => {
    // RC7: ONE patch file. It carries the in-place preset overrides plus the
    // doctor row, so there is a single artifact to ship, install and reason
    // about. RC5's array of three per-tier preset files is retired.
    const pkg = await readJson('package.json')
    const dsh = pkg['dsh'] as { bundle?: { patch?: string | string[] } } | undefined
    const declared = dsh?.bundle?.patch
    expect(declared, 'the patch must be declared').toBe('./cordis.patch.yml')
    await expect(access(join(ROOT, './cordis.patch.yml')), 'the patch must exist').resolves.toBeUndefined()
    // The retired per-tier files must NOT be declared, or an install would fail
    // on a missing path.
    expect(JSON.stringify(declared)).not.toContain('presets/')
  })

  it('ships `lib` in `files`, or an install would omit the entry', async () => {
    const pkg = await readJson('package.json')
    expect(pkg['files']).toContain('lib')
    expect(pkg['files']).toContain('cordis.patch.yml')
  })

  it('ships `docs`, so the doc links are not dead on the registry', async () => {
    // THE DEFECT THIS PINS: `files` omitted `docs`, so `npm pack` produced a
    // tarball with no documentation — while the README linked to 49 of them.
    // On the npm page every one of those links 404s, and a reader's first
    // impression of the project is a page of broken references.
    //
    // The check is the CONSEQUENCE rather than the declaration: it resolves
    // every `docs/*.md` link against the tracked files, so it fails for any
    // cause — `files` losing `docs`, a link pointing at a file that was
    // renamed, a doc deleted without updating the index.
    //
    // ## Where the index lives
    //
    // The README used to BE the index, linking all 49 numbered documents, and
    // this test required >40 such links in each edition. The docs rewrite makes
    // the README a product entry and moves the map to `docs/README.md`, so the
    // index requirement follows the index: the COUNT is asserted against the
    // map, and each README is held to what it actually carries — every link it
    // makes must resolve. That keeps the original defect pinned (a dead link on
    // npm) without forcing the README back into being a research-log index.
    const pkg = await readJson('package.json')
    expect(pkg['files'], 'docs must be published with the package').toContain('docs')

    // The map is the index, and it must be complete.
    const map = await readFile(join(ROOT, 'docs', 'README.md'), 'utf8')
    const indexed = [...new Set(
      [...map.matchAll(/\]\(([0-9]{2}_[A-Za-z0-9_.-]+\.md)\)/gu)].map(match => match[1]!),
    )]
    expect(indexed.length, 'docs/README.md must index the numbered documents').toBeGreaterThan(40)
    const unindexed = indexed.filter(file => !existsSync(join(ROOT, 'docs', file)))
    expect(unindexed, 'docs/README.md indexes a document that does not exist').toEqual([])

    // ...and the OTHER direction, which is the one that was missing.
    //
    // The check above is satisfied by a count and by dead links, so a new
    // numbered document could be added and never indexed: `docs/52` was
    // committed in exactly that state. A reader following the map would not find
    // it, and nothing failed. A count of `> 40` cannot notice a 54th file.
    const onDisk = readdirSync(join(ROOT, 'docs'))
      .filter(name => /^[0-9]{2}_[A-Za-z0-9_.-]+\.md$/u.test(name))
      .sort()
    const missingFromIndex = onDisk.filter(file => !indexed.includes(file))
    expect(
      missingFromIndex,
      'every numbered document must appear in docs/README.md, or a reader following the map will not find it',
    ).toEqual([])

    // Each edition carries the entry points a reader follows, and every link it
    // makes must resolve. BOTH are checked because a translation is the edition
    // most likely to rot: it is edited separately, and a stale link in it is
    // invisible to a reader of the other one.
    for (const name of ['README.md', 'README.zh.md']) {
      const readme = await readFile(join(ROOT, name), 'utf8')
      const linked = [...new Set(
        [...readme.matchAll(/\]\((docs\/[A-Za-z0-9_./-]+\.md)\)/gu)].map(match => match[1]!),
      )]
      expect(linked.length, `${name} must link the documentation`).toBeGreaterThan(3)
      const missing = linked.filter(file => !existsSync(join(ROOT, file)))
      expect(missing, `${name} links a doc that does not exist, which is a 404 on npm`).toEqual([])
    }
  })

  it('ships both language editions, and each links to the other', async () => {
    // The pair is a contract: a reader who lands on one must be able to reach
    // the other. A translated README that is not published, or that has no
    // cross-link, is unreachable in practice even though it exists in the repo.
    const pkg = await readJson('package.json')
    const files = pkg['files'] as string[]

    for (const [name, other] of [['README.md', 'README.zh.md'], ['README.zh.md', 'README.md']] as const) {
      expect(files, `${name} must be published`).toContain(name)
      const text = await readFile(join(ROOT, name), 'utf8')
      expect(text, `${name} must link to ${other}`).toContain(`](${other})`)
    }
  })

  it('keeps every stable document bilingual, and cross-linked', async () => {
    // The stable product documents are the ones a reader is expected to ACT on —
    // install, configure, understand the contract. A reader who only reads
    // Chinese was previously handed an English-only ARCHITECTURE/USER_GUIDE/
    // DEVELOPMENT, which is the same as not shipping them.
    //
    // The pair is the contract, in both directions: a `.zh.md` that exists but
    // cannot be reached from its English twin is unreachable in practice, and a
    // stale translation is worse than none because it reads as current.
    const STABLE = ['README', 'ARCHITECTURE', 'DEVELOPMENT', 'USER_GUIDE'] as const

    for (const stem of STABLE) {
      const en = `docs/${stem}.md`
      const zh = `docs/${stem}.zh.md`
      expect(existsSync(join(ROOT, en)), `${en} must exist`).toBe(true)
      expect(existsSync(join(ROOT, zh)), `${zh} must exist`).toBe(true)

      const enText = await readFile(join(ROOT, en), 'utf8')
      const zhText = await readFile(join(ROOT, zh), 'utf8')

      // Reachable from each side.
      expect(enText, `${en} must link to ${stem}.zh.md`).toContain(`](${stem}.zh.md)`)
      expect(zhText, `${zh} must link back to ${stem}.md`).toContain(`](${stem}.md)`)

      // A translation, not a stub. Counting HEADINGS rather than characters:
      // a placeholder file is usually long enough to pass a length check while
      // having none of the structure the reader navigates by. The Chinese
      // edition may merge or add a section, so the bar is a floor, not equality.
      const headings = (text: string): number => (text.match(/^#{2,3} /gmu) ?? []).length
      const enHeadings = headings(enText)
      expect(headings(zhText), `${zh} must carry the same section structure as ${en}`)
        .toBeGreaterThanOrEqual(Math.ceil(enHeadings * 0.8))
    }
  })

  it('documents that a bare git spec follows the branch, not the release', async () => {
    // MEASURED, and the reason this test exists: `dsh plugin` never queries the
    // GitHub Releases API. It hands the spec to pnpm, which resolves
    // `github:owner/repo` to the TIP of the default branch and only pins when the
    // spec carries `#<tag-or-commit>` — observed as a `codeload.github.com`
    // tarball URL ending in the resolved commit sha.
    //
    // That makes "install from git" and "install the release" different things
    // whenever an unreleased commit exists. A reader who assumes otherwise gets
    // code the release notes do not describe, so both editions must SAY so.
    for (const name of ['README.md', 'README.zh.md']) {
      const text = await readFile(join(ROOT, name), 'utf8')
      expect(text, `${name} must show the pinned git form`)
        .toContain('dsh-epistemic-fold#v0.1.0')
      expect(text, `${name} must name the resolver, so the claim is checkable`)
        .toContain('codeload.github.com')
      // The release ATTACHMENT is the pinned, no-build channel; the README must
      // keep offering it as such.
      expect(text, `${name} must document the tarball channel`)
        .toContain('dsh-epistemic-fold-0.1.0.tgz')
    }
  })

  it('the header badges point at things that exist, in both editions', async () => {
    // A badge is a CLAIM rendered as an image, and a broken one is worse than no
    // badge: a red CI badge reports a failing build, and a badge whose link goes
    // nowhere reports a repository that is not maintained. Both editions carry
    // the same five, so the check runs against each.
    const anchors = new Map<string, RegExp>([
      // `#ci` must resolve to a real heading in the file that uses it.
      ['#ci', /^#{2,3} CI$/mu],
    ])

    for (const name of ['README.md', 'README.zh.md']) {
      const text = await readFile(join(ROOT, name), 'utf8')

      // Exactly five badges, each one linked, all of them in the HEADER.
      //
      // Scoped to the header rather than to the whole file because the README
      // also carries a screenshot: counting every image made a product shot
      // indistinguishable from a dropped badge. The fix is to assert where
      // badges live, not to loosen the number — a `>= 5` would let one be
      // deleted silently, which is the failure this check exists to catch.
      const header = text.split(/\n## /u)[0] ?? ''
      const badges = [...header.matchAll(/\[!\[[^\]]*\]\(([^)]*)\)\]\(([^)]+)\)/gu)]
      expect(badges.length, `${name} must carry exactly five header badges`).toBe(5)

      // And they must stay ABOVE every other image. A badge demoted below the
      // screenshot is no longer a header badge, and a count taken anywhere in
      // the file would not notice the move. A badge is an image immediately
      // preceded by `[` (it is wrapped in a link); the screenshot is not.
      const images = [...text.matchAll(/(\[?)!\[[^\]]*\]\(([^)]+)\)/gu)]
      const firstPlainImage = images.findIndex(match => match[1] !== '[')
      expect(
        firstPlainImage === -1 || firstPlainImage >= badges.length,
        `${name} must keep its five badges above every other image`,
      ).toBe(true)

      const links = badges.map(match => match[2]!)

      for (const target of links) {
        if (target.startsWith('#')) {
          const pattern = anchors.get(target)
          expect(pattern, `${name} links an anchor this test does not know: ${target}`).toBeDefined()
          expect(text, `${name}: ${target} has no matching heading`).toMatch(pattern!)
          continue
        }
        // A repository-relative target must exist on disk; an absolute one is a
        // service URL and is not checked here (the CI badge's own status is the
        // workflow's business, not this test's).
        if (!/^https?:/u.test(target)) {
          expect(existsSync(join(ROOT, target)), `${name}: ${target} does not exist`).toBe(true)
        }
      }

      // The service names a reader recognizes, so the badges are not silently
      // swapped for something that always reports green.
      expect(text, `${name} must use the real CI workflow badge`)
        .toContain('actions/workflows/ci.yml/badge.svg')
      expect(text, `${name} must derive the release badge from the API, not a literal`)
        .toContain('img.shields.io/github/v/release/orangeofcarl0-sys/dsh-epistemic-fold')
    }
  })

  it('ships every top-level directory the README documents', async () => {
    // THE DEFECT THIS PINS: the README's repository layout listed
    // `profiles/economics/`, and `src/economics-profile.ts` calls those files
    // "the auditable, user-overridable copies" that its built-in constants
    // mirror — but `files` omitted `profiles`, so a consumer following the
    // README to the auditable source found nothing there.
    //
    // The check reads the layout block out of the README and requires each
    // directory it names to be in `files`, so the two cannot drift: adding a
    // directory to the layout without shipping it fails here, and so does
    // dropping one from `files` while the README still points at it.
    const pkg = await readJson('package.json')
    const files = pkg['files'] as string[]

    // LF-normalized before matching: this repository checks out CRLF on Windows
    // (see `.gitattributes`), and a `\n`-anchored fence pattern silently fails
    // to match `\r\n` — which reads as "the README has no layout block" rather
    // than as a line-ending mismatch.
    const layoutOf = async (name: string): Promise<string[]> => {
      const text = (await readFile(join(ROOT, name), 'utf8')).replace(/\r\n/gu, '\n')
      // The heading, then prose is allowed, then the first fenced block under it.
      const block = text.match(/^## (?:Repository layout|仓库结构)[^\n]*\n[\s\S]*?\n```\n([\s\S]*?)\n```/mu)
      expect(block, `${name} must document the repository layout`).not.toBeNull()
      // Top-level entries of the listing, e.g. `src/`, `docs/`, `eval/`.
      return [...new Set([...block![1]!.matchAll(/^([a-z][a-z0-9_-]*)\//gmu)].map(m => m[1]!))]
    }

    const documented = await layoutOf('README.md')
    expect(documented.length, 'the layout must name some directories').toBeGreaterThan(3)

    // The two editions must describe the SAME repository. A translation that
    // lists a different set of directories is a documentation defect that no
    // reader of either single file can see.
    expect(await layoutOf('README.zh.md'), 'both editions must list the same directories')
      .toEqual(documented)

    // The layout block documents the REPOSITORY, which is wider than the
    // published package: benchmark and test infrastructure lives in the repo
    // and is deliberately not shipped. Each exclusion is named with its reason,
    // so adding a directory to the layout forces a decision here rather than
    // silently defaulting either way.
    //
    // The distinction that matters: `profiles/` is shipped because
    // `src/economics-profile.ts` calls those files "the auditable,
    // user-overridable copies" and a consumer follows that reference; `eval/`
    // is not, because it CONSUMES `src/` (it is the evaluation harness) and no
    // consumer-facing document points at it.
    const developmentOnly = new Map([
      ['tests', 'the suite; consumers install a build, not a test tree'],
      ['bench', 'the paired-baseline harness; it imports src/ and is run from the repo'],
      ['eval', 'the evaluation harness; it imports src/ and is run from the repo'],
    ])
    const unpublished = documented.filter(dir => !developmentOnly.has(dir) && !files.includes(dir))
    expect(unpublished, 'a directory the README documents must be published, or named as development-only').toEqual([])
  })

  it('has a build script, so `lib/` can be produced', async () => {
    const pkg = await readJson('package.json')
    const scripts = pkg['scripts'] as Record<string, string>
    expect(scripts['build']).toBeDefined()
  })
})

describe("RC7: the patch substitutes EF into DSH's own presets, in place", () => {
  it('rewrites only the compaction backend inside each shipped preset', async () => {
    // RC3 mounted EF at the TOP level and disabled the top-level
    // `compaction-basic`. RC4-A found that is a NO-OP in a web profile, because
    // `dsh-web-app` already disables that row and puts a compaction group inside
    // each agent preset, isolated — so a top-level EF was invisible to every
    // session. RC5 declared EF's own presets, which worked but added three menu
    // items. RC7 substitutes the backend INSIDE the shipped presets instead, so
    // the menu is unchanged and nothing else about a preset moves.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    for (const name of ['standard', 'ptc', 'cordis']) {
      expect(patch, `${name} must be overridden`).toContain(`- id: preset-${name}`)
    }
    // `minimal` ships with NO compaction group, so EF deliberately leaves it
    // exactly as DSH ships it. Substituting it would change what "minimal" means.
    expect(patch, 'minimal must not be substituted').not.toContain('- id: preset-minimal')

    expect(patch).toContain('name: dsh-epistemic-fold')
    // The realm must be EXTENDED, not replaced: DSH's own two keys stay.
    expect(patch).toContain('epistemicFold: true')
    expect(patch).toMatch(/^ {18}compaction: true$/mu)
    expect(patch).toMatch(/^ {18}toolResultPruner: true$/mu)
  })

  it('mounts the doctor OUTSIDE the generated block', async () => {
    // EF is mounted BY the substitution, so when the substitution misses, EF
    // never mounts — and a check living inside EF can never run. The doctor
    // therefore mounts at the top level, where it always runs. Its row must sit
    // outside the generated markers, or a regeneration would delete it.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    const begin = patch.indexOf('# >>> epistemic-fold preset overrides')
    expect(begin).toBeGreaterThan(-1)
    expect(patch.slice(0, begin)).toContain('epistemic-fold-doctor')
    // ...and the package must export the subpath that row names.
    const pkg = await readJson('package.json')
    const exports = pkg['exports'] as Record<string, unknown>
    expect(exports['./doctor'], 'the doctor subpath must be exported').toBeDefined()
  })

  it('mounts no EF row of its own beyond the doctor', async () => {
    // A second mount path would re-introduce the invisible-EF problem in every
    // preset-based profile: the substitution is the only way EF reaches a
    // session. The doctor is the sole exception, and it is observation-only.
    //
    // The property is stated as "which plugin names this patch mounts", not as
    // an indent filter: preset rows, their nested plugin rows, and top-level
    // rows all appear at various indents, so indentation cannot distinguish a
    // mount path. The plugin NAME can.
    const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
    const names = patch.split(String.fromCharCode(10))
      .map(line => line.trim())
      .filter(line => line.startsWith('name: '))
      .map(line => line.slice('name: '.length).replace(/^['"]|['"]$/gu, ''))

    // Exactly ONE top-level row mounts from this package: the doctor. The three
    // `dsh-epistemic-fold/plugin` rows are the SUBSTITUTION rows, nested inside
    // each preset's compaction group — that is what replaces Basic, and they are
    // reached only through a preset, never on their own.
    const topLevel = patch.slice(0, patch.indexOf('# >>> epistemic-fold preset overrides'))
      .split(String.fromCharCode(10))
      .map(line => line.trim())
      .filter(line => line.startsWith('name: '))
      .map(line => line.slice('name: '.length).replace(/^['"]|['"]$/gu, ''))
    // The BARE package name: DSH's client roster only recognises an exact
    // package specifier (no slash), and a package it cannot recognise loses its
    // browser half. See the entry test below.
    expect(topLevel).toEqual(['dsh-epistemic-fold'])

    // ...and the two specifiers are counted EXACTLY, so a new mount path cannot
    // appear unnoticed. They are DIFFERENT specifiers, and conflating them was
    // the defect: the bare name resolves to the doctor (which provides no
    // service), so a preset row naming it mounts a module that cannot register
    // `ctx.compaction`, and every session on the profile fails to resume.
    //
    //   dsh-epistemic-fold          x1  the top-level doctor row (bare, for the
    //                                   client roster; see the entry test below)
    //   dsh-epistemic-fold/plugin   x3  the substitution rows, one per preset
    expect(names.filter(name => name === 'dsh-epistemic-fold').length).toBe(1)
    expect(names.filter(name => name === 'dsh-epistemic-fold/plugin').length).toBe(3)
    expect(names.filter(name => name === '@deepseek-ai/dsh-agent-preset').length).toBe(3)
  })
})

describe('RC16: the manifest uses the fields DSH actually defines', () => {
  it('declares the DSH range at engines.dsh, not in an invented dsh.compatibility', async () => {
    // THE DEFECT THIS PINS: the manifest declared
    //
    //   "dsh": { "compatibility": { "node": ">=22.5.0", "dsh": ">=0.1.7-rc.2" } }
    //
    // `dsh.compatibility` is not a field DSH defines — `@deepseek-ai/dsh-package-manifest`
    // declares `DshManifest` as exactly { manifestVersion, bundle, profile, client },
    // and a tree-wide grep for `dsh.compatibility` finds no reader at all. The
    // range was therefore inert, and it disagreed with `engines.node`
    // (`>=22.5.0` vs `^22.19.0 || >=24.0.0`) — two contradicting statements, the
    // unread one being the more permissive.
    const pkg = await readJson('package.json')
    const dsh = pkg['dsh'] as Record<string, unknown>
    expect(dsh['compatibility'], 'dsh.compatibility is not a DSH field').toBeUndefined()
    expect(Object.keys(dsh).sort()).toEqual(['bundle', 'client', 'manifestVersion'])
    // The DSH range belongs beside engines.node, where the spec puts it.
    //
    // It must name the line this repository actually TESTS and RUNS on, and that is
    // DERIVED here rather than written down twice. It used to say >=0.1.7-rc.2
    // while the vendored baseline was 0.2.0-rc.2 and the runtime resolved to
    // 0.1.7-rc.2 -- a claim, a compile target, and an execution target that were
    // three different things. That is how a bridge importing a package absent from
    // the installed line passed typecheck and died at runtime.
    const engines = pkg['engines'] as Record<string, string>
    const vendored = await readJson('vendor/deepseek-harness/package.json')
    expect(engines['dsh']).toBe('>=' + String(vendored['version']))
    expect(engines['node']).toBe('^22.19.0 || >=24.0.0')
  })

  it('declares manifestVersion 1', async () => {
    // Optional per the spec, but declared by every published plugin on this
    // machine (`dsh-better-sidebar`), and omitting it leaves the format version
    // undeclared rather than defaulted.
    const pkg = await readJson('package.json')
    const dsh = pkg['dsh'] as Record<string, unknown>
    expect(dsh['manifestVersion']).toBe(1)
  })

  it('stays private on purpose, because distribution is git and file only', async () => {
    // `private: true` blocks `npm publish`. That is deliberate, not an
    // oversight: this package is not on the registry (`npm view
    // dsh-epistemic-fold` returns 404) and there is no publish workflow in
    // .github/workflows. The two supported channels are `github:` and `file:`.
    // If a registry channel is ever wanted, this test is the one to change —
    // and it should change together with an actual publish path, not before.
    const pkg = await readJson('package.json')
    expect(pkg['private']).toBe(true)
  })
})

describe('RC16: the file: channel needs a built lib/, and says so', () => {
  it('ships a preflight that fails when lib/ cannot load', async () => {
    // THE GAP THIS CLOSES: `main` is `lib/entry.js` and `lib/` is gitignored, so
    // a clone that never built cannot install. Measured: pnpm runs `prepare` for
    // a `github:` dependency but NOT for a `file:` one (a marker script in
    // `prepare` never ran on the file channel). The resulting boot failure is
    // loud but late, and the entry that fails to import IS the doctor — the one
    // component that could explain it lives inside the directory that is
    // missing. Nothing in the package can diagnose it, so the check must run
    // from the source tree BEFORE the install.
    const pkg = await readJson('package.json')
    expect(pkg['scripts']).toMatchObject({ preflight: 'node scripts/preflight-lib.mjs' })
    const script = await readFile(join(ROOT, 'scripts', 'preflight-lib.mjs'), 'utf8')
    // It must name the real entry points and the real remedy.
    for (const rel of ['lib/entry.js', 'lib/plugin.js', 'lib/client.js']) {
      expect(script, `preflight must check ${rel}`).toContain(rel)
    }
    expect(script).toContain('npm run build')
    expect(script).toContain('process.exit(1)')
  })

  // Spawns two Node processes and copies a tree, so it gets an explicit budget:
  // the 5000ms default is for pure in-process tests, and this one crosses it
  // under the full suite's parallel load. Same class as the `docs-manifest`
  // timeout — a process-spawning test needs its own bound rather than a hope.
  it('the preflight passes on this tree and fails on one without lib/', { timeout: 30_000 }, async () => {
    // Executed, not just read: a guard that cannot fail is not a guard. The
    // healthy half runs the script in this tree; the failing half runs the same
    // script against a scratch tree with no `lib/`, which is exactly the state
    // `git clone` leaves behind.
    const { execFileSync } = await import('node:child_process')
    const healthy = execFileSync(process.execPath, ['scripts/preflight-lib.mjs'], {
      cwd: ROOT, encoding: 'utf8',
    })
    expect(healthy).toContain('installable')

    const { mkdtempSync, mkdirSync, cpSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const scratch = mkdtempSync(join(tmpdir(), 'ef-preflight-'))
    try {
      // Only what the preflight actually reads: the script, `client.js`, and
      // `src/` for its mtime comparison. Copying the whole tree would add
      // seconds per run for files the check never opens.
      //
      // The script must stay at `scripts/`, because it derives the tree root as
      // `dirname(itself)/..` — moved to the scratch root it would inspect the
      // temp directory instead and pass for the wrong reason.
      mkdirSync(join(scratch, 'scripts'), { recursive: true })
      cpSync(join(ROOT, 'scripts', 'preflight-lib.mjs'), join(scratch, 'scripts', 'preflight-lib.mjs'))
      cpSync(join(ROOT, 'client.js'), join(scratch, 'client.js'))
      cpSync(join(ROOT, 'src'), join(scratch, 'src'), { recursive: true })
      // No `lib/` — the state `git clone` leaves behind.
      let failed = false
      try {
        execFileSync(process.execPath, ['scripts/preflight-lib.mjs'], { cwd: scratch, encoding: 'utf8' })
      } catch (error) {
        failed = true
        const out = String((error as { stderr?: string }).stderr ?? '')
        expect(out).toContain('not installable')
        expect(out).toContain('does NOT run `prepare`')
      }
      expect(failed, 'preflight must FAIL on a tree with no lib/').toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('RC7: the bare-name entry mounts the doctor, not the plugin', () => {
  it('exports name, inject and a default mount function', async () => {
    const entry = await import('../src/entry.ts')
    expect(entry.name).toBe('epistemic-fold-doctor')
    expect(Array.isArray(entry.inject)).toBe(true)
    expect(typeof entry.default).toBe('function')
    expect(typeof entry.apply).toBe('function')
  })

  it('the bare name is load-bearing, and only the doctor may hold it', async () => {
    // DSH's client module system finds a package's browser half by scanning the
    // host Loader for a row whose `name` is an EXACT package specifier — a bare
    // name with no slash. `exactPackageSpecifier('dsh-epistemic-fold')` is
    // accepted; `.../doctor` is rejected. A package whose only top-level row uses
    // a subpath is therefore skipped entirely, and its `client.js` never reaches
    // the browser — which silently drops the Sidebar panel AND, because the
    // client declared a hard `inject`, fails the whole web boot.
    //
    // So the bare name must be held by a row that ALWAYS mounts and is
    // observation-only. That is the doctor.
    const entry = await import('../src/entry.ts')
    const source = await readFile(join(ROOT, 'src', 'entry.ts'), 'utf8')
    // It must be the doctor...
    expect(entry.name).toContain('doctor')
    // ...and it must NOT be the plugin: mounting the plugin at the root would
    // create a second engine whose surface reports on sessions it never folds.
    expect(source).not.toContain("from './plugin.ts'")
  })

  it('the plugin stays reachable at its own subpath', async () => {
    // A preset-based profile mounts the plugin per preset; a preset-free
    // deployment (headless/CLI) mounts it explicitly. Either way it must be
    // importable without going through the doctor.
    const pkg = await readJson('package.json')
    const exports = pkg['exports'] as Record<string, unknown>
    expect(exports['./plugin']).toBeDefined()
    expect(exports['./doctor']).toBeDefined()
    const entry = await import('../src/plugin.ts')
    expect(entry.EpistemicFoldPlugin).toBeDefined()
  })

  it('the client hard-injects only `slots`, never the optional sidebar services', () => {
    // The two kinds of service need opposite treatment, and collapsing them is
    // what broke the native path once already.
    //
    // `betterSidebar` belongs to a third-party plugin a deployment may not have.
    // A declared `inject: ['betterSidebar']` holds the entry pending forever —
    // measured in a real web boot with no dsh-better-sidebar installed:
    //
    //   Failed to load plugins
    //   web boot: 1 entry did not activate dsh-epistemic-fold:
    //   pending (waiting for service: betterSidebar)
    //
    // That fails the WHOLE UI, not just the panel. The optional-service idiom is
    // `ctx.inject([...], cb)` inside apply().
    //
    // `slots` is the opposite case: `@deepseek-ai/dsh-client-ui-renderer`
    // provides it and is the shell that mounts this module, so it is always
    // there — and cordis REFUSES the property unless it is declared. Leaving it
    // out let the tab type register while its body threw, which the UI reported
    // as the legitimate "no available way to view this content".
    const client = require('node:fs').readFileSync(join(ROOT, 'client.js'), 'utf8')
    expect(client, 'the client must use ctx.inject for the optional service')
      .toContain("ctx.inject(['betterSidebar']")
    expect(client, 'the optional service must NOT be hard-injected')
      .not.toMatch(/inject:\s*\[[^\]]*'betterSidebar'/u)
    expect(client, 'the slot registry must be hard-injected')
      .toMatch(/inject:\s*\['slots'\]/u)
  })
})

describe('RC3: conditional mounts never throw on a missing service', () => {
  it('mounts with NO ToolRuntime and NO CommandRuntime', async () => {
    // THE DEFECT THE REAL BOOT FOUND: `ctx.get('tools')` THROWS in cordis when
    // `tools` is not declared in `inject`, and every test harness had
    // pre-mounted a ToolRuntime so the broken probe was unreachable. The first
    // real DSH boot failed with `cannot get property "tools" without inject`.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072,
      plugin: true,
      systemPrompt: true,
      // Neither tools nor commands.
      efConfig: { mode: 'legacy' },
    })
    expect(harness.plugin).toBeDefined()
    expect(harness.ctx.get('tools')).toBeUndefined()
    expect(harness.ctx.get('commands')).toBeUndefined()
  }, 120_000)

  it('registers the recall tools once a ToolRuntime appears', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072,
      plugin: true,
      systemPrompt: true,
      tools: true,
      efConfig: { mode: 'legacy' },
    })
    // `ctx.inject` is ASYNC: the child fiber starts after the constructor
    // returns, so a test that checks immediately sees nothing. That timing is
    // exactly what made an earlier probe of this report wrongly conclude the
    // command was not registered.
    await new Promise(resolve => setTimeout(resolve, 100))
    // `get` is the registered-tool lookup; the recall tools must be there.
    expect(harness.ctx.tools.get('context_search')).toBeDefined()
    expect(harness.ctx.tools.get('context_recall')).toBeDefined()
  }, 120_000)

  it('registers /context once a CommandRuntime appears', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 131_072,
      plugin: true,
      systemPrompt: true,
      commands: true,
      efConfig: { mode: 'legacy' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const names = harness.ctx.commands.list({ id: 'probe' } as never).map(command => command.name)
    expect(names).toContain('context')
  }, 120_000)
})
