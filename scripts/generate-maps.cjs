// Regenerates the vendored-DSH resolution maps from
// vendor/deepseek-harness/tsconfig.base.json:
//
//   scripts/vendor-paths.json        → @deepseek-ai/* → vendor SOURCE (vitest aliases)
//   scripts/vendor-types-paths.json  → @deepseek-ai/* → vendor lib/types DECLARATIONS (tsconfig)
//   tsconfig.json                    → compilerOptions.paths set to the types map
//
// Run after rebasing the vendor clone onto a new DSH version. Idempotent:
// tsconfig.json's non-paths content is preserved, only `paths` is replaced.
//
// ## Verify / generate / promote (EF-C1)
//
//   node scripts/generate-maps.cjs                 write in place (old behavior)
//   node scripts/generate-maps.cjs --check         compare only; exit 2 on drift
//   node scripts/generate-maps.cjs --output <dir>  write candidates to <dir>
//
// `--check` never writes a tracked path. The default stays `--write` because CI
// and the documented rebase procedure call the bare command and then diff; a
// silent behavior change there would make the CI step pass vacuously.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const vendorRoot = path.join(root, 'vendor', 'deepseek-harness')
const baseConfigPath = path.join(vendorRoot, 'tsconfig.base.json')
const VENDOR_PREFIX = './vendor/deepseek-harness/'

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const check = argv.includes('--check')
const output = flag('output')
const write = argv.includes('--write') || (!check && output === undefined)

if (check && output !== undefined) {
  console.error('generate-maps: --check and --output are mutually exclusive')
  process.exit(1)
}
if (output !== undefined && argv.includes('--write')) {
  console.error('generate-maps: --write and --output are mutually exclusive')
  process.exit(1)
}
if (!fs.existsSync(baseConfigPath)) {
  // A worktree without the gitignored vendor tree cannot derive the maps. That
  // is a "not-verifiable" state, not a silent success: --check exits 2 so CI
  // can tell it apart from a match.
  console.error(`generate-maps: no vendored DSH at ${baseConfigPath}`)
  process.exit(check ? 2 : 1)
}

// --- extract the `paths` object from the (commented) vendor base config ---
const src = fs.readFileSync(baseConfigPath, 'utf8')
const keyIdx = src.indexOf('"paths"')
if (keyIdx < 0) {
  console.error('no paths key found in vendor tsconfig.base.json')
  process.exit(1)
}
const braceStart = src.indexOf('{', keyIdx)
let depth = 0
let inStr = false
let esc = false
let end = -1
for (let i = braceStart; i < src.length; i += 1) {
  const ch = src[i]
  if (esc) { esc = false; continue }
  if (ch === '\\' && inStr) { esc = true; continue }
  if (ch === '"') { inStr = !inStr; continue }
  if (inStr) continue
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0) { end = i; break }
  }
}
if (end < 0) {
  console.error('unbalanced braces in vendor paths object')
  process.exit(1)
}

// Strip // and /* */ comments from the slice while respecting string literals.
function stripComments(text) {
  let out = ''
  inStr = false
  esc = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (esc) { out += ch; esc = false; continue }
    if (ch === '\\' && inStr) { out += ch; esc = true; continue }
    if (ch === '"') { inStr = !inStr; out += ch; continue }
    if (inStr) { out += ch; continue }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

const vendorPaths = JSON.parse(stripComments(src.slice(braceStart, end + 1)))

// --- rewrite targets from the vendor repo's view into ours ---
function rewritten(paths) {
  const out = {}
  for (const [key, targets] of Object.entries(paths)) {
    out[key] = targets.map(t => t
      .replace(/^\.\.\//, '../../')
      .replace(/^\.\//, VENDOR_PREFIX))
  }
  return out
}

function filterExisting(map, dirEntry = 'index.ts') {
  const out = {}
  let dropped = 0
  for (const [key, targets] of Object.entries(map)) {
    const found = targets.filter(t => {
      if (t.endsWith('.ts') || t.endsWith('.json') || t.endsWith('.d.ts')) return fs.existsSync(t)
      if (t.includes('*')) return true // wildcard entries resolved lazily
      return fs.existsSync(t + '/' + dirEntry) || fs.existsSync(t + '.ts') || fs.existsSync(t + '.d.ts')
    })
    if (found.length === 0) { dropped += 1; continue }
    out[key] = found
  }
  return { map: out, dropped }
}

const srcMap = filterExisting(rewritten(vendorPaths))

// Types map: src dir → lib/types dir, src/X.ts → lib/types/X.d.ts
const typesTargets = {}
for (const [key, targets] of Object.entries(srcMap.map)) {
  typesTargets[key] = targets
    .map(t => t.replace(/\/src\/([^/]+)\.ts$/, '/lib/types/$1.d.ts').replace(/\/src$/, '/lib/types'))
}
const typesMap = filterExisting(typesTargets, 'index.d.ts')

// --- tsconfig.json: replace only compilerOptions.paths ---
const tsconfigPath = path.join(root, 'tsconfig.json')
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'))
tsconfig.compilerOptions.paths = {
  ...typesMap.map,
  // zod must be a SINGLE physical copy so the EF projection's schema types
  // unify with the vendored session-projection's zod.
  zod: ['./vendor/deepseek-harness/node_modules/.pnpm/zod@4.4.3/node_modules/zod'],
}

const rendered = {
  'scripts/vendor-paths.json': JSON.stringify(srcMap.map, null, 2) + '\n',
  'scripts/vendor-types-paths.json': JSON.stringify(typesMap.map, null, 2) + '\n',
  'tsconfig.json': JSON.stringify(tsconfig, null, 2) + '\n',
}

/** Normalize line endings so a CRLF checkout does not read as a content change. */
const normalized = (text) => text.replace(/\r\n/g, '\n')

if (check) {
  const drift = []
  for (const [rel, next] of Object.entries(rendered)) {
    const current = fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : ''
    if (normalized(current) !== normalized(next)) drift.push(rel)
  }
  console.log(`src paths: ${Object.keys(srcMap.map).length} entries (${srcMap.dropped} dropped)`)
  console.log(`types paths: ${Object.keys(typesMap.map).length} entries (${typesMap.dropped} dropped)`)
  if (drift.length === 0) {
    console.log('resolution maps are current for the vendored DSH')
    process.exit(0)
  }
  console.error(`resolution maps are OUT OF DATE: ${drift.join(', ')}`)
  process.exit(2)
}

if (output !== undefined) {
  fs.mkdirSync(output, { recursive: true })
  for (const [rel, next] of Object.entries(rendered)) {
    fs.writeFileSync(path.join(output, path.basename(rel)), next)
  }
  console.log(`src paths: ${Object.keys(srcMap.map).length} entries (${srcMap.dropped} dropped)`)
  console.log(`types paths: ${Object.keys(typesMap.map).length} entries (${typesMap.dropped} dropped)`)
  console.log(`wrote candidates to ${output}`)
  process.exit(0)
}

if (write) {
  fs.writeFileSync(path.join(root, 'scripts', 'vendor-paths.json'), rendered['scripts/vendor-paths.json'])
  fs.writeFileSync(path.join(root, 'scripts', 'vendor-types-paths.json'), rendered['scripts/vendor-types-paths.json'])
  fs.writeFileSync(tsconfigPath, rendered['tsconfig.json'])
  console.log(`src paths: ${Object.keys(srcMap.map).length} entries (${srcMap.dropped} dropped)`)
  console.log(`types paths: ${Object.keys(typesMap.map).length} entries (${typesMap.dropped} dropped)`)
  console.log('tsconfig.json paths updated')
}
