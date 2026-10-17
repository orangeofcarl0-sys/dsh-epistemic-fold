#!/usr/bin/env node
// Repair pass for a move that has already happened: find every relative
// specifier that no longer resolves, locate the target by unique basename
// under src/, and rewrite the specifier to its new home.
//
// This exists because a scan list that is one directory short (bench/) leaves
// importers behind, and re-running the forward relocation cannot help once the
// source files have already moved.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const apply = process.argv.includes('--apply');
const SCAN_DIRS = ['src', 'tests', 'eval', 'bench', 'scripts', 'ef-phase7-logs'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'lib']);
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

function resolve(importer, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), spec);
  const cands = [base];
  if (base.endsWith('.js')) cands.push(base.slice(0, -3) + '.ts');
  if (base.endsWith('.mjs')) cands.push(base.slice(0, -4) + '.mts');
  if (base.endsWith('.cjs')) cands.push(base.slice(0, -4) + '.cts');
  if (!path.extname(base)) {
    for (const e of EXTS) cands.push(base + e);
    for (const e of EXTS) cands.push(path.join(base, 'index' + e));
  }
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}

// Index every module under src/ by basename so a dangling specifier can be
// re-pointed, but only when exactly one file can satisfy it.
const srcFiles = walk(path.join(ROOT, 'src'));
const byBase = new Map();
for (const f of srcFiles) {
  const b = path.basename(f);
  if (!byBase.has(b)) byBase.set(b, []);
  byBase.get(b).push(f);
}

const SPEC_RE = /((?:from|import|require)\s*\(?\s*)(['"])(\.[^'"]*)\2/g;
const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
let repaired = 0, unresolved = 0;

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const hitsList = [];
  SPEC_RE.lastIndex = 0;
  let m;
  while ((m = SPEC_RE.exec(text))) {
    const prev = text[m.index - 1];
    if (prev === '"' || prev === "'" || prev === '\u0060') continue; // inside an outer string
    const spec = m[3];
    if (resolve(f, spec)) continue;
    let base = path.basename(spec);
    if (base.endsWith('.js')) base = base.slice(0, -3) + '.ts';
    if (base.endsWith('.mjs')) base = base.slice(0, -4) + '.mts';
    const hits = byBase.get(base) ?? [];
    if (hits.length !== 1) {
      unresolved++;
      console.log('UNRESOLVED  ' + path.relative(ROOT, f) + '  ' + spec + '  (' + hits.length + ' candidates)');
      continue;
    }
    let rel = path.relative(path.dirname(f), hits[0]).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    if (spec.endsWith('.js')) rel = rel.replace(/\.ts$/, '.js');
    if (spec.endsWith('.mjs')) rel = rel.replace(/\.mts$/, '.mjs');
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(spec)) rel = rel.replace(/\.(ts|tsx|mts|cts)$/, '');
    repaired++;
    console.log('REPAIR  ' + path.relative(ROOT, f) + '  ' + spec + '  ->  ' + rel);
    hitsList.push({ start: m.index + m[1].length, end: m.index + m[0].length, text: m[2] + rel + m[2] });
  }
  if (!hitsList.length || !apply) continue;
  let next = text;
  for (const h of hitsList.reverse()) next = next.slice(0, h.start) + h.text + next.slice(h.end);
  fs.writeFileSync(f, next);
}

console.log('\n' + (apply ? 'repaired' : 'would repair') + ' ' + repaired + '; unresolved ' + unresolved);
process.exit(unresolved === 0 ? 0 : 1);
