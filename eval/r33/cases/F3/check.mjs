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
await check('scope.release', () => assert.equal(config.timeoutFor('release'), 30))
await check('scope.experiment', () => assert.equal(config.timeoutFor('experiment'), 60))
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
