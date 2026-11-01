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

let api
try { api = await import(pathToFileURL(join(root, "src/api.mjs")).href) } catch (error) { checks.push({ name: 'module-load:src/api.mjs', pass: false, detail: String(error?.message ?? error) }) }
await check('readme.v2', () => assert.equal(api.publicApi().v2, 2))
await check('readme.version', () => assert.equal(api.publicApi().version, 1))
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
