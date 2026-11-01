import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
const root = process.env.R33_WORKSPACE
const checks = []
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }) }
  catch (error) { checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) }) }
}

let watcher
try { watcher = await import(pathToFileURL(join(root, "src/watcher.mjs")).href) } catch (error) { checks.push({ name: 'module-load:src/watcher.mjs', pass: false, detail: String(error?.message ?? error) }) }
await check('functionality.delivers-change', async () => { let watchCalls = 0; const fs = { watch(dir, listener) { watchCalls += 1; setTimeout(() => listener('change'), 0); return { close() {} } }, readdir() { return [] } }; const events = []; const handle = watcher.watchChanges({ fs, dir: '/r33', onEvent: event => events.push(event) }); await new Promise(resolve => setTimeout(resolve, 80)); handle.close(); assert.equal(events.length, 1); assert.equal(watchCalls >= 1, true, 'fs.watch was not used after the upgrade') })
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
