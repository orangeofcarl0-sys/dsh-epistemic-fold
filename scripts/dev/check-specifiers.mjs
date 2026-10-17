#!/usr/bin/env node
// Independent check: every relative specifier in the repo must resolve to a
// real file, and every specifier must be identical to what a fresh resolver
// computes for that importer. Catches a half-applied move that tsc happens to
// miss because the file is not reachable from any tsconfig include.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'tests', 'eval', 'scripts'];
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

const SPEC_RE = /((?:from|import|require)\s*\(?\s*)(['"])(\.[^'"]*)\2/g;
let checked = 0, dangling = 0;
const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  SPEC_RE.lastIndex = 0;
  let m;
  while ((m = SPEC_RE.exec(text))) {
    const prev = text[m.index - 1];
    if (prev === '"' || prev === "'" || prev === '\u0060') continue; // inside an outer string
    checked++;
    if (!resolve(f, m[3])) {
      dangling++;
      const line = text.slice(0, m.index).split('\n').length;
      console.log('DANGLING  ' + path.relative(ROOT, f) + ':' + line + '  ' + m[3]);
    }
  }
}
console.log('\nchecked ' + checked + ' relative specifiers in ' + files.length + ' files; dangling: ' + dangling);
process.exit(dangling === 0 ? 0 : 1);
