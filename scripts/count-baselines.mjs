// Count cells in the named job directories that did NOT produce a real implementation.
//
// `best_correct_fields <= 256` is the verifier's value for an implementation that changed nothing, so
// it is the definition of 'baseline' used here -- not a new threshold. A cell with no reward at all
// also counts, because an abandoned trial is not a result.
//
// Done in Node rather than sed: the shell version embedded a quote inside `"$(sed -n '..."...' ...)"`,
// bash's parser rejected the whole script, and the supervisor died before its first round.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const jobsRoot = process.argv[2]
const dirs = process.argv.slice(3)
let bad = 0
let seen = 0
const detail = []
for (const dir of dirs) {
  const root = join(jobsRoot, dir)
  if (!existsSync(root)) continue
  for (const cell of readdirSync(root)) {
    const cellDir = join(root, cell)
    try { if (!statSync(cellDir).isDirectory()) continue } catch { continue }
    const transcript = join(cellDir, 'ef-transcript.json')
    if (!existsSync(transcript)) continue
    seen += 1
    const reward = join(cellDir, 'verifier', 'reward.json')
    if (!existsSync(reward)) { bad += 1; detail.push(cell + ':no-reward'); continue }
    let fields = Number.NaN
    try { fields = JSON.parse(readFileSync(reward, 'utf8')).best_correct_fields } catch { /* counted below */ }
    if (!Number.isFinite(fields) || fields <= 256) { bad += 1; detail.push(cell + ':' + fields) }
  }
}
console.log(JSON.stringify({ seen, bad, detail: detail.slice(0, 20) }))
process.exitCode = 0