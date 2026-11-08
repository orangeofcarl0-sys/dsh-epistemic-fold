#!/usr/bin/env node
/**
 * Generate EF's in-place preset overrides from the DSH build they must match (RC7).
 *
 * ## What changed from RC5, and why
 *
 * RC5 generated three NEW preset declarations, so EF appeared as three extra
 * items in DSH's preset menu. RC7 replaces the compaction backend INSIDE DSH's
 * own presets instead, so the menu is unchanged and nothing else about a preset
 * moves.
 *
 * Measured, that substitution is strictly better than the alternative (mounting
 * one EF at the host plane and de-isolating each preset's compaction group):
 *
 *   vanilla              in-place
 *   standard  Basic      standard  EF      pruner preserved
 *   ptc       Basic      ptc       EF      pruner preserved
 *   minimal   (none)     minimal   (none)  UNCHANGED
 *   cordis    Basic      cordis    EF      pruner preserved
 *
 * The host-plane variant had to repair two things by hand — `minimal` gained
 * compaction it never shipped with, and the tool-result pruner became
 * unreachable and silently stopped pruning. In-place substitution touches
 * neither, because it only ever rewrites one row inside a group that already
 * declares the realm it needs.
 *
 * ## Why the rows are restated at all
 *
 * The Loader cannot patch a row nested in an agent preset's `config.plugins`:
 * `applyEntryPatches` indexes only rows carrying `group: true` AND an array
 * `config`, and a preset's `config` is an object holding `plugins`. Nested ids
 * are therefore unaddressable, and a patch cannot rename a row. Restating the
 * preset's whole `config` is the only mechanism, which is what this emits.
 *
 * That makes the output VERSION-SPECIFIC: it mirrors the installed DSH's preset
 * rows. Two consequences, both handled:
 *
 *  - The generator is re-run at install time (`prepare`) and by hand, so the
 *    artifact usually matches the machine that will run it.
 *  - A patch whose target row is ABSENT only warns and is skipped, so a DSH
 *    upgrade would silently leave the user on Basic. `registerPresetSelfCheck`
 *    in `src/plugin.ts` turns that into a loud error.
 *
 * ## Usage
 *
 *   node scripts/generate-presets.mjs [--dsh <path>] [--mode <tier>] [--check]
 *   node scripts/generate-presets.mjs --output <path>
 *   node scripts/generate-presets.mjs --write
 *
 * The DSH path defaults to `$DSH_HOME` or `~/.dsh`. The mode defaults to
 * `economy`, the one tier with measured end-to-end evidence.
 *
 * ## Verify / generate / promote (EF-C1)
 *
 * Before EF-C1 the bare command WROTE `cordis.patch.yml`, and `prepare` ran it
 * on every `npm ci` / `npm install`. That made dependency installation a
 * repository mutation: measured on a clean checkout, `npm ci` rewrote the
 * checked-in block with the installed DSH's rows.
 *
 * The command now separates the three operations:
 *
 *   --check     compare the generated block with the checked-in file; write
 *               nothing. Exits 2 on a mismatch so CI can gate on it.
 *   --output    write the candidate file to an explicit path; write nothing in
 *               the repository.
 *   --write     replace `cordis.patch.yml` in place (the old behavior).
 *   (none)      check, but warn instead of failing — the safe default, because
 *               `prepare` runs on machines with no DSH and must not fail an
 *               install.
 *
 * `prepare` uses `--check --warn-only`; the boot-time doctor remains the
 * authoritative check against the DSH that actually runs the plugin.
 *
 * @module scripts/generate-presets
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The shipped presets EF substitutes into.
 *
 * `minimal` is deliberately absent: it declares no compaction group at all, so
 * there is nothing to replace and EF leaves it exactly as DSH ships it. A user
 * who wants EF and a small tool set uses `ptc`.
 */
const TARGETS = ['standard', 'ptc', 'cordis']

/**
 * The specifier a preset's compaction row must name: the PLUGIN subpath.
 *
 * Never the bare package name. The bare name is reserved for the doctor (see
 * `src/entry.ts`), and a preset that mounts the doctor has no `compaction`
 * provider — which fails the whole preset at mount time.
 */
const PLUGIN_SPECIFIER = 'dsh-epistemic-fold/plugin'

/** The output file, and the marker block that makes regeneration safe. */
const OUT_FILE = join(ROOT, 'cordis.patch.yml')
const BEGIN = '# >>> epistemic-fold preset overrides — GENERATED, do not edit'
const END = '# <<< epistemic-fold preset overrides'

/** Parse `--flag value` pairs. */
function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 || process.argv[at + 1] === undefined ? fallback : process.argv[at + 1]
}

/** Candidate locations of the shipped presets inside a DSH home. */
function presetDirCandidates(dshHome) {
  const base = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  return [
    join(base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets'),
    join(base, 'dsh-web-app', 'presets'),
  ]
}

/**
 * Extract one preset's `config` block VERBATIM from a shipped patch file.
 *
 * Line-oriented on purpose: the source is YAML with `!!js` expressions and
 * deeply nested groups, and re-serializing it would normalize formatting DSH
 * owns. Copying the lines and re-indenting preserves them byte-for-byte.
 *
 * @param source - the shipped `*.patch.yml` text.
 * @param presetId - the preset row id, e.g. `preset-standard`.
 * @returns the `config:` block lines and the indent the row sits at.
 */
function extractConfig(source, presetId) {
  const lines = source.split('\n')
  const rowAt = lines.findIndex(line => line.trim() === `- id: ${presetId}`)
  if (rowAt === -1) throw new Error(`reference preset ${presetId} not found`)
  const configAt = lines.findIndex((line, index) => index > rowAt && /^\s+config:\s*$/u.test(line))
  if (configAt === -1) throw new Error(`preset ${presetId} has no config block`)
  const rowIndent = lines[rowAt].length - lines[rowAt].trimStart().length
  const configIndent = lines[configAt].length - lines[configAt].trimStart().length
  const block = []
  for (const line of lines.slice(configAt + 1)) {
    if (line.trim() !== '' && (line.length - line.trimStart().length) <= configIndent) break
    block.push(line)
  }
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
  return { block, rowIndent, configIndent }
}

/**
 * Substitute the compaction backend inside the `compaction` group.
 *
 * Three edits, all scoped to that group:
 *  1. the `compaction-basic` row's `name:` becomes `dsh-epistemic-fold/plugin`;
 *  2. that row gains EF's `config` (`mode`, `bundleRoot`);
 *  3. the group's existing `isolate:` map gains `epistemicFold: true`.
 *
 * Edit 3 is not optional. `AgentPresetRegistry` audits every mount with
 * `leakedServices()`: a service registered into the ROOT realm is a leak, and the
 * second preset to mount collides on it — measured as
 * `Preset services require isolate realms: epistemicFold`. The `isolate:` map is
 * what puts each preset's registration in its OWN realm.
 *
 * The group's `isolate:` map must therefore already exist. If it does not, this
 * throws rather than emitting a patch that would fail at the user's boot.
 *
 * @param block - the preset's `config:` block lines.
 * @param mode - the EF mode the replaced row declares.
 * @returns the rewritten lines.
 */
function substituteBackend(block, mode) {
  const out = []
  let inGroup = false
  let groupIndent = -1
  let inIsolate = false
  let isolateIndent = -1
  let addedRealm = false
  let replaced = false

  for (const line of block) {
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    if (inGroup && trimmed !== '' && indent <= groupIndent) {
      inGroup = false
      inIsolate = false
    }
    if (trimmed === '- id: compaction') {
      inGroup = true
      groupIndent = indent
    }
    if (inGroup && trimmed === 'isolate:') {
      inIsolate = true
      isolateIndent = indent
      out.push(line)
      continue
    }
    if (inIsolate) {
      if (trimmed !== '' && indent <= isolateIndent) {
        // The map ended without the realm being added; add it before leaving.
        if (!addedRealm) {
          out.push(`${' '.repeat(isolateIndent + 2)}epistemicFold: true`)
          addedRealm = true
        }
        inIsolate = false
      } else if (/^epistemicFold:/u.test(trimmed)) {
        addedRealm = true
      }
      out.push(line)
      continue
    }

    if (inGroup && trimmed === '- id: compaction-basic') {
      const pad = ' '.repeat(indent)
      out.push(`${pad}- id: compaction-basic`)
      // The `/plugin` subpath is REQUIRED, not cosmetic.
      //
      // The bare package name resolves to `lib/entry.js`, which mounts the
      // DOCTOR — an observation-only module whose whole job is to occupy the
      // bare name so the client roster can find the package's browser half. It
      // provides no service. Substituting it here left the preset's compaction
      // group without a `compaction` provider, so `command-compact` (which
      // injects that service) stayed pending forever and the whole mount failed:
      // every session on the profile then failed to resume with
      // "command-compact (...): waiting for compaction".
      //
      // The loader accepts subpath specifiers; DSH's own presets use them
      // (`@deepseek-ai/dsh-plugin-manager/tools`). The bare-name rule that
      // motivates the doctor belongs to `exactPackageSpecifier` in
      // `dsh-client-modules`, which is the CLIENT roster — a different
      // mechanism that never sees this row.
      out.push(`${pad}  name: ${PLUGIN_SPECIFIER}`)
      out.push(`${pad}  config:`)
      out.push(`${pad}    bundleRoot: null`)
      out.push(`${pad}    mode: ${mode}`)
      replaced = true
      continue
    }
    // Drop the reference's own `name:` line for the replaced row: it is
    // superseded by the block above, and keeping it would leave two `name:` keys.
    if (replaced && /^name: '@deepseek-ai\/dsh-compaction-basic'\s*$/u.test(trimmed)) {
      replaced = 'done'
      continue
    }
    out.push(line)
  }

  // Assert the EXACT specifier, not merely that the bare name appears.
  //
  // The previous check passed as long as any line contained
  // `name: dsh-epistemic-fold` — which the doctor row satisfies. So a patch that
  // substituted the doctor instead of the plugin sailed through generation and
  // only failed at mount time, on the user's machine.
  if (!out.some(line => line.includes(`name: ${PLUGIN_SPECIFIER}`))) {
    throw new Error(
      `no compaction-basic row naming ${PLUGIN_SPECIFIER} was produced. The preset's compaction `
      + 'backend must name the plugin SUBPATH: the bare package name resolves to the doctor, which '
      + 'provides no service, and every session on the profile then fails to resume.',
    )
  }
  if (!addedRealm) {
    throw new Error(
      'the compaction group has no isolate: map to add `epistemicFold` to. Without it the preset '
      + 'mount leaks the service into the root realm and the SECOND preset to mount fails with '
      + '"Preset services require isolate realms: epistemicFold".',
    )
  }
  return out
}

/**
 * Render the override row for one preset.
 *
 * The shipped file wraps its preset in `- insert: [row]`; the override is a
 * top-level row, so the wrapper is dropped and everything is de-indented to the
 * row's original level.
 */
function renderRow(presetId, lines, rowIndent) {
  const pad = ' '.repeat(rowIndent)
  const body = lines.map(line => (line.trim() === '' ? '' : `${pad}${line}`)).join('\n')
  return `${pad}- id: ${presetId}\n${pad}  name: '@deepseek-ai/dsh-agent-preset'\n${pad}  config:\n${body}`
}

/**
 * Replace the generated block in the output file, preserving everything outside it.
 *
 * The block markers are what make regeneration safe: without them a re-run would
 * append a second copy of every override, and the Loader's "last layer wins"
 * behaviour would make which one applies depend on file order.
 */
function spliceBlock(existing, block) {
  const start = existing.indexOf(BEGIN)
  if (start === -1) return `${existing.replace(/\n*$/u, '\n')}${block}`
  const end = existing.indexOf(END, start)
  if (end === -1) throw new Error('cordis.patch.yml has a begin marker but no end marker')
  const tail = existing.indexOf('\n', end)
  return existing.slice(0, start) + block + (tail === -1 ? '' : existing.slice(tail + 1))
}

/**
 * Build the generated block for one installed DSH home.
 *
 * Returns `{ found: false }` when no DSH presets are installed: that is not an
 * error, because `prepare` runs on machines that do not have DSH yet.
 */
function buildBlock(dshHome, mode) {
  const dir = presetDirCandidates(dshHome).find(candidate => existsSync(candidate))
  if (dir === undefined) return { found: false }

  const rows = []
  for (const name of TARGETS) {
    const file = join(dir, `${name}.patch.yml`)
    const { block, rowIndent } = extractConfig(readFileSync(file, 'utf8'), `preset-${name}`)
    const rewritten = substituteBackend(block, mode)
    rows.push(renderRow(`preset-${name}`, rewritten, rowIndent))
  }

  const block = [
    BEGIN,
    '#',
    '# DSH\'s own presets with the compaction backend replaced in place. The menu is',
    '# unchanged and every other row is byte-identical to what DSH ships.',
    '#',
    `# Generated from the installed DSH by \`node scripts/generate-presets.mjs\` (mode: ${mode}).`,
    '# Re-run after upgrading DSH; tests/rc7-inplace-drift.spec.ts fails when this',
    '# block and the installed reference disagree.',
    '',
    ...rows,
    '',
    END,
    '',
  ].join('\n')

  return { found: true, dir, block }
}

/**
 * Which target presets differ between the checked-in block and a candidate.
 *
 * The whole-file comparison is enough for a pass/fail, but a version upgrade
 * changes rows across several presets, and "cordis.patch.yml is out of date"
 * does not say which DSH change caused it. This names them.
 */
function differingPresets(existing, candidate) {
  const ids = TARGETS.map(name => `preset-${name}`)
  return ids.filter(id => {
    const at = (text) => {
      const start = text.indexOf(`- id: ${id}`)
      if (start === -1) return undefined
      const next = text.indexOf('- id: preset-', start + 1)
      return text.slice(start, next === -1 ? undefined : next)
    }
    return at(existing) !== at(candidate)
  })
}

function main() {
  const dshHome = arg('dsh', process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
  const mode = arg('mode', 'economy')
  const check = process.argv.includes('--check')
  const write = process.argv.includes('--write')
  const warnOnly = process.argv.includes('--warn-only')
  const output = arg('output')

  if (write && output !== undefined) {
    console.error('generate-presets: --write and --output are mutually exclusive')
    process.exit(1)
  }

  const built = buildBlock(dshHome, mode)
  if (!built.found) {
    // NO DSH FOUND. This runs from `prepare` on every install, including on a
    // machine that has no DSH yet, so it must NOT throw: a failing `prepare`
    // fails the install, and the user would be unable to install EF in order to
    // get the DSH it needs. The checked-in block stays as generated (it is
    // pinned to the release it was built against) and the boot-time doctor
    // reports if it does not match the DSH that eventually runs it.
    const message = `generate-presets: no installed dsh-web-app presets under ${dshHome}; keeping the `
      + 'checked-in block. Re-run this after installing a DSH web profile, or pass --dsh <path>.'
    if (check && !warnOnly) {
      console.error(message)
      process.exit(2) // not-verifiable, not a silent pass
    }
    console.log(message)
    return
  }

  console.log(`reference: ${built.dir}`)
  console.log(`mode: ${mode}`)

  const existing = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : ''
  const next = spliceBlock(existing, built.block)

  if (output !== undefined) {
    writeFileSync(output, next, 'utf8')
    console.log(`wrote candidate ${output}`)
    return
  }

  if (write) {
    writeFileSync(OUT_FILE, next, 'utf8')
    console.log(`wrote ${OUT_FILE.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '')}`)
    return
  }

  // Default: compare, never write.
  if (next === existing) {
    console.log('cordis.patch.yml is current for the installed DSH')
    return
  }
  const changed = differingPresets(existing, next)
  console.error(
    `cordis.patch.yml is OUT OF DATE for the installed DSH. `
    + `Differing preset(s): ${changed.length === 0 ? 'generated block boundaries' : changed.join(', ')}. `
    + 'Run with --write to promote a candidate, or --output <path> to inspect it first.',
  )
  if (check && !warnOnly) process.exit(2)
}

main()
