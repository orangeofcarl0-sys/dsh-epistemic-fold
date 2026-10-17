#!/usr/bin/env node
// Relocate flat src/*.ts modules into purpose directories, rewriting every
// relative specifier that changes meaning. Dry run unless --apply is given.
//
// Usage:  node scripts/dev/relocate-modules.mjs --batch recall [--apply]
//
// Resolution is done against the ORIGINAL layout for the whole batch before
// anything is written, so a move never has to be reasoned about twice.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

const PLAN = {
  recall: ['recall', 'recall-loop', 'recall-transport', 'recall-telemetry',
           'descriptors', 'gate', 'subagent-recall', 'tools'],
  state: ['state', 'projection', 'authority', 'anchor-service'],
  fold: ['engine', 'candidate', 'frontier', 'leaf-policy', 'fold-telemetry',
         'task-root', 'rebase-intent', 'idle-rebase'],
  checkpoint: ['checkpoint-marker', 'compiler', 'renderer', 'framing', 'rationale',
               'summary-retry', 'bundle-store', 'bundle-codec', 'archive-refs',
               'inventory', 'hash'],
  config: ['policy', 'preset', 'effective-config', 'plugin-config',
           'preset-self-check', 'ef-keys'],
  policy: ['policy-compiler', 'fold-economics', 'economics-profile', 'pressure',
           'root-policy', 'trigger', 'trigger-diagnostics'],
};

const SCAN_DIRS = ['src', 'tests', 'eval', 'bench', 'scripts', 'ef-phase7-logs'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'lib', 'basic']);
const EXTS = ['.ts', '.mts', '.cts', '.tsx'];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

function resolveSpecifier(importerAbs, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importerAbs), spec);
  const cands = [base];
  if (base.endsWith('.js')) cands.push(base.slice(0, -3) + '.ts');
  if (base.endsWith('.mjs')) cands.push(base.slice(0, -4) + '.mts');
  if (base.endsWith('.cjs')) cands.push(base.slice(0, -4) + '.cts');
  if (!path.extname(base)) {
    for (const e of EXTS) cands.push(base + e);
    for (const e of EXTS) cands.push(path.join(base, 'index' + e));
  }
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  return null;
}

// Keep the extension style the author chose: the repo mixes ".js" (NodeNext
// habit) with extensionless specifiers, and changing that is not this change.
function restyle(relPath, originalSpec, targetAbs) {
  const realExt = path.extname(targetAbs);
  if (originalSpec.endsWith('.js')) return relPath.replace(/\.(ts|tsx|mts|cts)$/, '.js');
  if (originalSpec.endsWith('.mjs')) return relPath.replace(/\.(ts|mts)$/, '.mjs');
  if (originalSpec.endsWith('.cjs')) return relPath.replace(/\.(ts|cts)$/, '.cjs');
  if (originalSpec.endsWith('.ts') || originalSpec.endsWith('.tsx') || originalSpec.endsWith('.mts')) return relPath;
  // extensionless: strip whatever real extension the file carries
  return realExt ? relPath.slice(0, -realExt.length) : relPath;
}

function toSpecifier(fromFileAbs, toFileAbs, originalSpec) {
  let rel = path.relative(path.dirname(fromFileAbs), toFileAbs).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return restyle(rel, originalSpec, toFileAbs);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const batchIdx = args.indexOf('--batch');
const batch = batchIdx >= 0 ? args[batchIdx + 1] : null;
if (!batch || !PLAN[batch]) {
  console.error('usage: --batch <' + Object.keys(PLAN).join('|') + '> [--apply]');
  process.exit(2);
}

// 1. Build the move map against the original layout.
const moveMap = new Map();
const destDir = path.join(ROOT, 'src', batch);
for (const name of PLAN[batch]) {
  const from = path.join(ROOT, 'src', name + '.ts');
  const to = path.join(destDir, name + '.ts');
  if (!fs.existsSync(from)) { console.error('MISSING source: ' + from); process.exit(3); }
  if (fs.existsSync(to)) { console.error('DEST EXISTS: ' + to); process.exit(3); }
  moveMap.set(from, to);
}
const newPathOf = (abs) => moveMap.get(abs) ?? abs;

// 2. Resolve every relative specifier, then compute the new text.
const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const SPEC_RE = /((?:from|import|require)\s*\(?\s*)(['"])(\.[^'"]*)\2/g;
const edits = [];
const touched = new Set();
// (original importer, original specifier) -> new specifier. Computed once
// against the pre-move layout and replayed verbatim, so the write phase can
// never be affected by the fact that some targets no longer exist.
const rewrite = new Map();
const key = (file, spec) => file + '\u0000' + spec;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  let m;
  SPEC_RE.lastIndex = 0;
  while ((m = SPEC_RE.exec(text))) {
    const prev = text[m.index - 1];
    if (prev === '"' || prev === "'" || prev === '\u0060') continue; // inside an outer string
    const spec = m[3];
    const target = resolveSpecifier(file, spec);
    if (!target) continue;
    const importerMoves = moveMap.has(file);
    const targetMoves = moveMap.has(target);
    if (!importerMoves && !targetMoves) continue;
    const recomputed = toSpecifier(newPathOf(file), newPathOf(target), spec);
    if (recomputed === spec) continue;
    rewrite.set(key(file, spec), recomputed);
    touched.add(file);
    edits.push({ file, from: spec, to: recomputed });
  }
}

console.log('batch: ' + batch + '  (' + moveMap.size + ' files -> src/' + batch + '/)');
console.log('specifier edits: ' + edits.length + ' across ' + touched.size + ' files');
const movedImporters = [...touched].filter((f) => moveMap.has(f));
console.log('  of which inside files that are themselves moving: ' + movedImporters.length);
for (const e of edits) {
  console.log('  ' + path.relative(ROOT, e.file) + ':  ' + e.from + '  ->  ' + e.to);
}

if (!apply) {
  console.log('\nDRY RUN. Re-run with --apply to move.');
  process.exit(0);
}

// 3. Move with git so rename detection survives.
fs.mkdirSync(destDir, { recursive: true });
for (const [from, to] of moveMap) {
  execFileSync('git', ['mv', path.relative(ROOT, from), path.relative(ROOT, to)], { cwd: ROOT });
}

// 4. Rewrite importers at their new locations.
let written = 0;
for (const file of touched) {
  const abs = newPathOf(file);
  const text = fs.readFileSync(abs, 'utf8');
  const next = text.replace(SPEC_RE, (whole, lead, quote, spec) => {
    const recomputed = rewrite.get(key(file, spec));
    return recomputed === undefined ? whole : lead + quote + recomputed + quote;
  });
  if (next !== text) { fs.writeFileSync(abs, next); written++; }
}
console.log('\nmoved ' + moveMap.size + ' files; rewrote ' + written + ' files');
