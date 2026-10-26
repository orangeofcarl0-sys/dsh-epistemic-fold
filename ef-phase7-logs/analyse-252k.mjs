import fs from 'node:fs';

const files = fs.readdirSync('ef-phase7-logs').filter(f => /^phased-252k-(none|retire)/.test(f) && f.endsWith('.json'));
const arms = { none: [], retire: [] };
for (const f of files) {
  const j = JSON.parse(fs.readFileSync('ef-phase7-logs/' + f, 'utf8'));
  const arm = f.includes('retire') ? 'retire' : 'none';
  const s = j.phases.map(p => p.surface_before_probe);
  const kinds = Object.fromEntries(Object.entries(j.score.by_kind).map(([k, v]) => [k, v.accuracy]));
  arms[arm].push({
    file: f,
    acc: j.score.overall.accuracy,
    growth: s[s.length - 1] - s[0],
    surface: s,
    composition: j.rows.filter(r => r.kind === 'composition'),
    kinds,
    retired: (j.phases[j.phases.length - 1] || {}).residency_after?.retired ?? 0,
    conflicts: (j.phases[j.phases.length - 1] || {}).residency_after?.conflicts ?? 0,
  });
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => a.length < 2 ? NaN : Math.sqrt(mean(a.map(x => (x - mean(a)) ** 2)));
const fmt = v => Number.isFinite(v) ? v.toFixed(4) : 'n/a';

console.log('252K phased, quality arm, order=logical, free model');
console.log('');
for (const arm of ['none', 'retire']) {
  const rs = arms[arm];
  if (!rs.length) continue;
  console.log('=== ' + (arm === 'none' ? 'BASELINE (no exit)' : 'EXIT (tombstone)') + '  n=' + rs.length + ' ===');
  console.log('  accuracy       ' + fmt(mean(rs.map(r => r.acc))) + ' +/- ' + fmt(sd(rs.map(r => r.acc))));
  console.log('  surface growth ' + Math.round(mean(rs.map(r => r.growth))) + ' +/- ' + Math.round(sd(rs.map(r => r.growth))) + ' tokens per cell');
  const compRate = rs.map(r => r.composition.filter(x => x.correct === true).length / r.composition.filter(x => x.correct !== null).length);
  console.log('  composition    ' + fmt(mean(compRate)) + ' (' + rs.map(r => Math.round(compRate[0] * 0 + 0) && '').filter(() => false).join('') +
    rs.map(r => r.composition.filter(x => x.correct === true).length + '/' + r.composition.length).join(', ') + ')');
  for (const k of ['extraction', 'disambiguation', 'composition', 'update', 'abstention']) {
    const vals = rs.map(r => r.kinds[k]).filter(v => typeof v === 'number');
    if (vals.length) console.log('    ' + k.padEnd(15) + fmt(mean(vals)) + ' +/- ' + fmt(sd(vals)));
  }
  const last = rs[rs.length - 1];
  console.log('  retired/conflicts (last cell) ' + last.retired + '/' + last.conflicts);
  console.log('');
}