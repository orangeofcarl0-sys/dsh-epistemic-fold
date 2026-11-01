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

let config
try { config = await import(pathToFileURL(join(root, "src/config.mjs")).href) } catch (error) { checks.push({ name: 'module-load:src/config.mjs', pass: false, detail: String(error?.message ?? error) }) }
let callers
try { callers = await import(pathToFileURL(join(root, "src/callers.mjs")).href) } catch (error) { checks.push({ name: 'module-load:src/callers.mjs', pass: false, detail: String(error?.message ?? error) }) }
await check('functionality.object-form', () => { const c = config.loadConfig({ path: 'config.json' }); assert.equal(c.source, 'config.json'); assert.equal(c.retries, 2) })
await check('constraint.legacy-string-api', () => { const c = config.loadConfig('config.json'); assert.equal(c.source, 'config.json'); assert.equal(c.retries, 2) })
await check('constraint.callers-still-work', () => { const c = callers.runCallers(); assert.equal(c.source, 'config.json') })
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
