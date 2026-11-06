import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const root = process.env.R33_WORKSPACE
const checks = []
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }) }
  catch (error) { checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) }) }
}

let client
try { client = await import(pathToFileURL(join(root, "src/config.mjs")).href) } catch (error) { checks.push({ name: 'module-load:src/config.mjs', pass: false, detail: String(error?.message ?? error) }) }
await check('timeout.production', () => assert.equal(client.checkoutTimeout(), 30))
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
