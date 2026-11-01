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
await check('readme.default-500', () => assert.equal(config.loadConfig({ path: 'x' }).timeoutMs, 500))
await check('readme.explicit-value', () => assert.equal(config.loadConfig({ path: 'x', timeoutMs: 250 }).timeoutMs, 250))
await check('readme.source-preserved', () => assert.equal(config.loadConfig({ path: 'x' }).source, 'x'))
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
