// Regenerates the vendored-DSH resolution maps from
// vendor/deepseek-harness/tsconfig.base.json:
//
//   scripts/vendor-paths.json        → @deepseek-ai/* → vendor SOURCE (vitest aliases)
//   scripts/vendor-types-paths.json  → @deepseek-ai/* → vendor lib/types DECLARATIONS (tsconfig)
//   tsconfig.json                    → compilerOptions.paths set to the types map
//
// Run after rebasing the vendor clone onto a new DSH version. Idempotent:
// tsconfig.json's non-paths content is preserved, only `paths` is replaced.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const vendorRoot = path.join(root, 'vendor', 'deepseek-harness')
const baseConfigPath = path.join(vendorRoot, 'tsconfig.base.json')
const VENDOR_PREFIX = './vendor/deepseek-harness/'

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
fs.writeFileSync(path.join(root, 'scripts', 'vendor-paths.json'), JSON.stringify(srcMap.map, null, 2) + '\n')

// Types map: src dir → lib/types dir, src/X.ts → lib/types/X.d.ts
const typesTargets = {}
for (const [key, targets] of Object.entries(srcMap.map)) {
  typesTargets[key] = targets
    .map(t => t.replace(/\/src\/([^/]+)\.ts$/, '/lib/types/$1.d.ts').replace(/\/src$/, '/lib/types'))
}
const typesMap = filterExisting(typesTargets, 'index.d.ts')
fs.writeFileSync(path.join(root, 'scripts', 'vendor-types-paths.json'), JSON.stringify(typesMap.map, null, 2) + '\n')

// --- tsconfig.json: replace only compilerOptions.paths ---
const tsconfigPath = path.join(root, 'tsconfig.json')
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'))
tsconfig.compilerOptions.paths = {
  ...typesMap.map,
  // zod must be a SINGLE physical copy so the EF projection's schema types
  // unify with the vendored session-projection's zod.
  zod: ['./vendor/deepseek-harness/node_modules/.pnpm/zod@4.4.3/node_modules/zod'],
}
fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n')

console.log(`src paths: ${Object.keys(srcMap.map).length} entries (${srcMap.dropped} dropped)`)
console.log(`types paths: ${Object.keys(typesMap.map).length} entries (${typesMap.dropped} dropped)`)
console.log('tsconfig.json paths updated')
