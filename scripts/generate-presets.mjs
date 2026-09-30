#!/usr/bin/env node
/**
 * Generate EF's agent presets from the DSH build they must mirror (RC5).
 *
 * ## Why a generator rather than a checked-in YAML
 *
 * A preset declares its session's ENTIRE plugin list, so EF's presets must carry
 * the same non-compaction rows DSH's own presets do — persona, tools, skills,
 * instructions, and so on. Writing those out by hand would be a transcription of
 * 19 rows, repeated per tier, that silently rots the moment DSH changes its
 * presets.
 *
 * So EF does not author them. It EXTRACTS the reference preset from the
 * installed DSH build, substitutes the compaction backend, and emits the result.
 * The drift is then a property of when the generator ran, not of someone's
 * memory — and `tests/rc5-preset-drift.spec.ts` fails loudly when the checked-in
 * output no longer matches the installed reference.
 *
 * ## What it does, precisely
 *
 *  1. Reads `<dsh>/.../dsh-web-app/presets/<reference>.patch.yml`.
 *  2. Takes the `plugins:` block of the reference preset VERBATIM.
 *  3. Inside the `compaction` group only, replaces the `compaction-basic` row
 *     with an `epistemic-fold` row carrying this tier's config.
 *  4. Emits one `- insert:` patch per tier, into `presets/`.
 *
 * Everything outside the compaction group is byte-identical to DSH's own row
 * list, which is what makes the preset a mirror rather than a fork.
 *
 * ## Usage
 *
 *   node scripts/generate-presets.mjs [--dsh <path>] [--reference standard]
 *
 * The DSH path defaults to `$DSH_HOME` or `~/.dsh`.
 *
 * @module scripts/generate-presets
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'presets')

/** The tiers EF ships as presets, in ascending cost order. */
const TIERS = [
  {
    id: 'ef-economy',
    name: 'EF · economy',
    description: 'Lowest cost; quality measured at parity with Basic',
    mode: 'economy',
    order: 10,
  },
  {
    id: 'ef-balanced',
    name: 'EF · balanced',
    description: 'A larger verbatim tail, for steadier long tasks',
    mode: 'balanced',
    order: 11,
  },
  {
    id: 'ef-quality',
    name: 'EF · quality',
    description: 'A larger tail plus narrative checkpoints',
    mode: 'quality',
    order: 12,
  },
]

/** Parse `--flag value` pairs. */
function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 || process.argv[at + 1] === undefined ? fallback : process.argv[at + 1]
}

/** Candidate locations of the installed DSH web-app preset directory. */
function presetDirCandidates(dshHome) {
  const base = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  return [
    join(base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets'),
    join(base, 'dsh-web-app', 'presets'),
  ]
}

/**
 * Extract the `plugins:` block of a preset patch, verbatim.
 *
 * @returns the block's lines, dedented to a known base, plus that base indent.
 */
function extractPlugins(source, presetId) {
  const lines = source.split('\n')
  const presetAt = lines.findIndex(line => line.trim() === `- id: ${presetId}`)
  if (presetAt === -1) throw new Error(`reference preset ${presetId} not found`)
  const pluginsAt = lines.findIndex((line, index) => index > presetAt && /^\s+plugins:\s*$/u.test(line))
  if (pluginsAt === -1) throw new Error(`preset ${presetId} has no plugins block`)
  const base = lines[pluginsAt].length - lines[pluginsAt].trimStart().length
  const block = []
  for (const line of lines.slice(pluginsAt + 1)) {
    if (line.trim() !== '' && (line.length - line.trimStart().length) <= base) break
    block.push(line)
  }
  // Drop trailing blank lines so the emitted YAML has no dangling whitespace.
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
  return { block, base }
}

/**
 * Replace the compaction backend inside the `compaction` group.
 *
 * The group is found by its `id: compaction` row; only rows INSIDE it are
 * touched, so a `compaction-basic` elsewhere in the list would be left alone —
 * which is the correct scope, because the group is what `isolate` scopes.
 *
 * ## Why the isolate list must also gain `epistemicFold`
 *
 * RC5's first boot failed with:
 *
 *   agent preset ef-economy: Preset services require isolate realms: epistemicFold
 *   service "epistemicFold" has been registered at <EpistemicFoldPlugin>
 *
 * `AgentPresetRegistry` audits every mounted preset with `leakedServices()`: a
 * service whose registration lands in the ROOT isolate realm is a leak, because
 * the second preset to mount the same plugin would collide on it. EF's
 * `ctx.provide('epistemicFold', …)` did exactly that.
 *
 * The fix is the one DSH itself uses for `compaction`, `toolResultPruner` and
 * `planMode`: name the service in the group's `isolate:` map, so each preset's
 * mount provides it into its OWN realm. That is why this generator adds
 * `epistemicFold: true` alongside the reference's entries rather than leaving the
 * list as DSH wrote it — the reference cannot know which services EF provides.
 *
 * @param block - the reference plugin rows.
 * @param tier - the tier whose config the EF row carries.
 * @returns the rows with EF in place of Basic, and the isolate list extended.
 */
function substituteBackend(block, tier) {
  const out = []
  let inCompactionGroup = false
  let groupIndent = -1
  let droppingNameFor = null
  let inIsolateBlock = false
  let isolateIndent = -1
  let addedRealm = false

  for (const line of block) {
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    // Leaving the group ends the substitution window.
    if (inCompactionGroup && trimmed !== '' && indent <= groupIndent) {
      inCompactionGroup = false
      inIsolateBlock = false
    }
    if (trimmed === '- id: compaction') {
      inCompactionGroup = true
      groupIndent = indent
    }
    // Track the group's `isolate:` map so the realm can be added to it.
    if (inCompactionGroup && trimmed === 'isolate:') {
      inIsolateBlock = true
      isolateIndent = indent
      out.push(line)
      continue
    }
    if (inIsolateBlock) {
      if (trimmed !== '' && indent <= isolateIndent) {
        // The isolate map ended without the realm being added; add it now.
        if (!addedRealm) {
          out.push(`${' '.repeat(isolateIndent + 2)}epistemicFold: true`)
          addedRealm = true
        }
        inIsolateBlock = false
      } else if (/^epistemicFold:/u.test(trimmed)) {
        addedRealm = true
      }
      out.push(line)
      continue
    }

    if (inCompactionGroup && trimmed === '- id: compaction-basic') {
      const pad = ' '.repeat(indent)
      out.push(`${pad}- id: epistemic-fold`)
      out.push(`${pad}  name: dsh-epistemic-fold`)
      out.push(`${pad}  config:`)
      out.push(`${pad}    bundleRoot: null`)
      out.push(`${pad}    mode: ${tier.mode}`)
      // The reference's `name:` line for that row is superseded by the block above.
      droppingNameFor = indent
      continue
    }
    if (droppingNameFor !== null && indent > droppingNameFor
      && trimmed.startsWith('name:') && trimmed.includes('dsh-compaction-basic')) {
      droppingNameFor = null
      continue
    }
    droppingNameFor = null
    out.push(line)
  }

  if (!out.some(line => line.includes('- id: epistemic-fold'))) {
    throw new Error('no compaction-basic row found inside the compaction group')
  }
  if (!addedRealm) {
    throw new Error(
      'the compaction group has no isolate: map to add `epistemicFold` to. Without it the '
      + 'preset mount leaks the service into the root realm and the SECOND preset to mount '
      + 'fails with "Preset services require isolate realms: epistemicFold".',
    )
  }
  return out
}

/** Render one tier's patch file. */
function renderPatch(tier, rows, base) {
  // The reference block sits at `base`; the preset's plugins sit two levels
  // deeper inside an `insert:` row, so shift everything by +2.
  const shift = 2
  const body = rows.map(line => (line.trim() === '' ? '' : ' '.repeat(shift) + line)).join('\n')
  return `# EF agent preset: ${tier.id} — GENERATED, do not edit by hand.
#
# Produced by \`node scripts/generate-presets.mjs\` from DSH's own reference
# preset, so every non-compaction row is byte-identical to the session DSH
# composes without EF. Only the compaction backend differs.
#
# Regenerate after upgrading DSH, and run tests/rc5-preset-drift.spec.ts — it
# fails when this file and the installed reference disagree.
- insert:
    - id: preset-${tier.id}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${tier.id}
        name: ${JSON.stringify(tier.name)}
        description: ${JSON.stringify(tier.description)}
        order: ${tier.order}
        plugins:
${body}
`
}

function main() {
  const dshHome = arg('dsh', process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
  const reference = arg('reference', 'standard')
  const dir = presetDirCandidates(dshHome).find(candidate => existsSync(candidate))
  if (dir === undefined) {
    throw new Error(
      `no installed dsh-web-app presets directory under ${dshHome}. `
      + 'Pass --dsh <path>, or install a web profile first. This generator mirrors a REAL '
      + 'DSH preset rather than inventing one.',
    )
  }
  const source = readFileSync(join(dir, `${reference}.patch.yml`), 'utf8')
  const { block, base } = extractPlugins(source, `preset-${reference}`)
  console.log(`reference: ${join(dir, `${reference}.patch.yml`)}`)
  console.log(`extracted ${block.length} plugin rows at indent ${base}`)

  mkdirSync(OUT_DIR, { recursive: true })
  for (const tier of TIERS) {
    const rows = substituteBackend(block, tier)
    const file = join(OUT_DIR, `${tier.id}.patch.yml`)
    writeFileSync(file, renderPatch(tier, rows, base), 'utf8')
    const added = rows.length - block.length
    console.log(`wrote presets/${tier.id}.patch.yml (${rows.length} rows, ${added >= 0 ? '+' : ''}${added})`)
  }
}

main()
