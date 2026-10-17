#!/usr/bin/env node
// Rewrite stale comment-level citations of src/<name>.ts to the module's new
// home. A citation is text, so no compiler and no import resolver sees it, but
// a reader following it lands on a file that does not exist.
//
// Only rewrites paths that provably no longer exist. Skips docs/ (133 is the
// pre-move plan and 138 names both layouts on purpose) and vendor/.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const apply = process.argv.includes('--apply');
const SKIP_DIRS = new Set(['node_modules', '.git', 'docs', 'vendor', 'dist', 'lib', 'ef-phase7-logs']);
const EXTS = ['.ts', '.mts', '.cts', '.tsx', '.mjs', '.cjs', '.js', '.sh', '.json', '.yml', '.yaml'];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

// old repo-relative path -> new repo-relative path, for every module that moved.
const map = new Map();
for (const dir of fs.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })) {
  if (!dir.isDirectory() || dir.name === 'basic') continue;
  for (const f of fs.readdirSync(path.join(ROOT, 'src', dir.name))) {
    if (!f.endsWith('.ts')) continue;
    const oldRel = 'src/' + f;
    if (!fs.existsSync(path.join(ROOT, oldRel))) map.set(oldRel, 'src/' + dir.name + '/' + f);
  }
}

// Every module name is [a-z-]+, so alternation needs no escaping.
const names = [...map.keys()].map(p => p.slice(4, -3));
// The leading group keeps a path like vendor/.../src/tools.ts from matching:
// a citation is src/<name>.ts at a boundary, not any path that ends that way.
const RE = new RegExp('(^|[^\\w/.\\-])src/(' + names.join('|') + ')[.]ts', 'gm');

let files = 0, edits = 0;
for (const f of walk(ROOT)) {
  const text = fs.readFileSync(f, 'utf8');
  let n = 0;
  const next = text.replace(RE, (whole, pre, name) => { n++; return pre + map.get('src/' + name + '.ts'); });
  if (!n) continue;
  files++; edits += n;
  console.log((apply ? 'REWRITE ' : 'WOULD   ') + path.relative(ROOT, f) + '  (' + n + ')');
  if (apply) fs.writeFileSync(f, next);
}
console.log('');
console.log((apply ? 'rewrote' : 'would rewrite') + ' ' + edits + ' citations in ' + files + ' files');