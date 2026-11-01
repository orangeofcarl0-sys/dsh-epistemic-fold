import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.env.R33_WORKSPACE
const checks = []
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }) }
  catch (error) { checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) }) }
}

let settings
try { settings = await import(pathToFileURL(join(root, 'src/settings.mjs')).href) } catch (error) { checks.push({ name: 'module-load:src/settings.mjs', pass: false, detail: String(error?.message ?? error) }) }
let consumers
try { consumers = await import(pathToFileURL(join(root, 'src/consumers.mjs')).href) } catch (error) { checks.push({ name: 'module-load:src/consumers.mjs', pass: false, detail: String(error?.message ?? error) }) }

await check('functionality.object-form', () => {
  const value = settings.readSettings({ name: 'config' })
  assert.equal(value.name, 'config')
  assert.equal(value.retries, 3)
})
await check('constraint.string-form', () => {
  const value = settings.readSettings('config')
  assert.equal(value.name, 'config')
  assert.equal(value.retries, 3)
})
await check('constraint.consumers', () => {
  assert.equal(consumers.runConsumers(), 'config')
})

console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every(entry => entry.pass) ? 0 : 1)
