// Extracts the `compilerOptions.paths` object from the vendored DSH
// tsconfig.base.json (which carries comments, so plain JSON.parse fails) and
// writes the raw map to ../src/vendor-paths.raw.json for the package
// tsconfig generation step to rewrite.
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..', 'vendor', 'deepseek-harness')
const src = fs.readFileSync(path.join(repoRoot, 'tsconfig.base.json'), 'utf8')

const keyIdx = src.indexOf('"paths"')
if (keyIdx < 0) {
  console.error('no paths key found')
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
  if (ch === '\\') { esc = true; continue }
  if (ch === '"') { inStr = !inStr; continue }
  if (inStr) continue
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0) { end = i; break }
  }
}
if (end < 0) {
  console.error('unbalanced braces in paths object')
  process.exit(1)
}

// Strip // and /* */ comments from the slice while respecting string literals.
function stripComments(text) {
  let out = ''
  let inStr = false
  let esc = false
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

const paths = JSON.parse(stripComments(src.slice(braceStart, end + 1)))
const out = path.join(__dirname, '..', 'src', 'vendor-paths.raw.json')
fs.writeFileSync(out, JSON.stringify(paths, null, 2))
console.log('entries:', Object.keys(paths).length, '->', out)
