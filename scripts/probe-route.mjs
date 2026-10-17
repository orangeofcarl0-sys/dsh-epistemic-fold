// Exit 0 only when the lane's route actually serves a completion.
//
// A separate file rather than `node -e` inside the supervisor: the embedded script needed three
// levels of quoting, bash parsed a `(` in a log message as an unterminated construct, and the
// supervisor died before its first round. **A probe that cannot be parsed cannot protect anything.**
//
// `process.exit()` is deliberately NOT used: with a live fetch handle it aborts on Windows (measured
// exit code 0xC0000409), and the supervisor reads the CODE -- so a successful probe would have read
// as a failure and the supervisor would have waited forever on a working route.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

let code = 1
try {
  const cred = readFileSync(homedir() + '/.dsh/.credentials.yaml', 'utf8')
  const m = cred.match(/OPENCODE_GO_API_KEY:\s*["']?([^"'\s]+)/)
  if (!m) {
    console.log('probe: no credential in the store')
  } else {
    const model = process.env.EF_LIVE_MODEL ?? 'cat-jam-free'
    const base = process.env.EF_LIVE_BASE_URL ?? 'https://opencode.ai/zen/go/v1'
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer ' + m[1],
        'x-opencode-session': 'ef-preflight-' + Date.now(),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'OK' }], stream: false, max_tokens: 4 }),
    })
    const text = await r.text()
    console.log('probe: ' + r.status + ' ' + text.replace(/\s+/g, ' ').slice(0, 110))
    code = r.status === 200 ? 0 : 1
  }
} catch (error) {
  console.log('probe: threw ' + String(error).slice(0, 120))
}
process.exitCode = code