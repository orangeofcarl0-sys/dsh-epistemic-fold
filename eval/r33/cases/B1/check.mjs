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

let scheduler
try { scheduler = await import(pathToFileURL(join(root, "src/scheduler.mjs")).href) } catch (error) { checks.push({ name: 'module-load:src/scheduler.mjs', pass: false, detail: String(error?.message ?? error) }) }
await check('functionality.fifo', async () => { const s = scheduler.createScheduler(); await s.enqueue({ id: 1 }); await s.enqueue({ id: 2 }); assert.deepEqual(await s.drain(), [{ id: 1 }, { id: 2 }]) })
await check('decision.durable-outbox', async () => { const appended = []; const s = scheduler.createScheduler({ storage: { append: async (task) => { appended.push(task) } } }); await s.enqueue({ id: 7 }); assert.deepEqual(appended, [{ id: 7 }]) })
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
