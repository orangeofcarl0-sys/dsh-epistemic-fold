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
try { client = await import(pathToFileURL(join(root, 'src/client.mjs')).href) } catch (error) { checks.push({ name: 'module-load:src/client.mjs', pass: false, detail: String(error?.message ?? error) }) }

await check('functionality.create-client', () => {
  const value = client.createClient()
  assert.equal(typeof value.ttlMs, 'number')
  assert.equal(typeof value.transport, 'string')
})
await check('artifact.ttl', () => {
  assert.equal(client.createClient().ttlMs, 45_000)
})
await check('artifact.transport', () => {
  assert.equal(client.createClient().transport, 'polling')
})

console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every(entry => entry.pass) ? 0 : 1)
