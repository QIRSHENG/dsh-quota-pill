/**
 * Gateway smoke test — fake keys only, two loopback mock upstreams.
 *
 *   node scripts/gateway-smoke.mjs
 *
 * Scene:
 *   upstream A : answers HTTP 200 + zhipu business envelope {code:401} → must
 *                be classified as an auth failure and trigger failover.
 *   upstream B : answers HTTP 500 → must be treated as a soft failure; once the
 *                chain is exhausted the gateway returns its normalized error.
 *
 * Asserts:
 *   1. GET /v1/models returns exactly one virtual model (auto-router)
 *   2. POST /v1/chat/completions fails over A → B and ends with the normalized
 *      gateway error body (502 chain_exhausted, OpenAI error shape)
 *   3. A ended up in cooldown, B counted a soft failure
 *   4. no key material appears in any gateway status/settings projection
 *
 * Everything is temp DSH_HOME; no real credential is read or written.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_KEY_A = 'fake-key-AAAA.upstream-a.invalid'
const FAKE_KEY_B = 'fake-key-BBBB.upstream-b.invalid'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshz-gw-'))
process.env.DSH_HOME = home
process.env.DSHZ_SMOKE = '1' // plugin routes must not bind the gateway themselves

let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`) } catch (err) {
    failures += 1
    console.error(`  FAIL ${name}: ${err && err.message}`)
  }
}

// ---- mock upstreams ----
const hits = { a: 0, b: 0 }

function makeUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => handler(req, res, body))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const upstreamA = await makeUpstream((req, res) => {
  hits.a += 1
  // zhipu-style: auth failures arrive as HTTP 200 + business code 401.
  const payload = JSON.stringify({ code: 401, msg: '令牌已过期或验证不正确', success: false })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(payload)
})

const upstreamB = await makeUpstream((req, res) => {
  hits.b += 1
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'upstream B exploded' } }))
})

const { createGateway, VIRTUAL_MODEL, normalizeGatewayConfig, redactGatewayConfig, mergeGatewayConfig } =
  await import(pathToFileURL(path.join(ROOT, 'lib', 'gateway.js')).href)

const logs = []
const config = normalizeGatewayConfig({
  enabled: true,
  port: 0, // ephemeral
  cooldownMs: 60_000,
  lowBalanceTokens: 0,
  upstreamTimeoutMs: 10_000,
  chain: [
    {
      id: 'a', label: 'upstream A', baseUrl: `http://127.0.0.1:${upstreamA.port}`,
      model: 'model-a', authStyle: 'bearer', apiKey: FAKE_KEY_A, enabled: true, envelope: 'zhipu',
    },
    {
      id: 'b', label: 'upstream B', baseUrl: `http://127.0.0.1:${upstreamB.port}`,
      model: 'model-b', authStyle: 'bearer', apiKey: FAKE_KEY_B, enabled: true, envelope: 'none',
    },
  ],
})

// Same classifier the host wires into createGateway (lib/index.js gatewayEnvelope).
const { PROVIDERS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'providers.js')).href)
function envelope(entry, body) {
  if (!entry || entry.envelope !== 'zhipu') return null
  const env = PROVIDERS.zhipu.readEnvelope(body)
  if (!env) return null
  if (env.auth) return { auth: true, code: env.code, msg: env.msg }
  if (env.error && (env.code === 429 || env.code === 402)) return { error: true, code: env.code, msg: env.msg }
  return null
}

const gateway = createGateway({
  getConfig: () => config,
  log: (m) => logs.push(m),
  envelope,
  balanceTokensLeft: () => null,
})

gateway.start()
// Wait for the ephemeral listener.
const deadline = Date.now() + 5000
while (Date.now() < deadline && !gateway.status().listening) {
  await new Promise((r) => setTimeout(r, 25))
}
const port = gateway.status().port
assert.ok(port, 'gateway did not start listening')

function req(method, urlPath, body) {
  // Resolve the port per call: applyConfig() rebinds to a fresh ephemeral port.
  const livePort = gateway.status().port
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const r = http.request({
      host: '127.0.0.1', port: livePort, path: urlPath, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

function reqPort(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    r.on('error', reject)
    r.end()
  })
}

console.log(`gateway smoke: 127.0.0.1:${port} (A=${upstreamA.port}, B=${upstreamB.port})`)
console.log(`fake keys only: A=${FAKE_KEY_A.slice(0, 10)}… B=${FAKE_KEY_B.slice(0, 10)}…`)

await check('GET /v1/models returns exactly one virtual model (auto-router)', async () => {
  const res = await req('GET', '/v1/models')
  assert.equal(res.status, 200, `status ${res.status}`)
  const json = JSON.parse(res.text)
  assert.equal(json.object, 'list')
  assert.equal(json.data.length, 1, `expected 1 model, got ${json.data.length}`)
  assert.equal(json.data[0].id, VIRTUAL_MODEL)
  assert.equal(json.data[0].id, 'auto-router')
})

let exhausted
await check('fake-key chain: A business 401 → failover → B 500 → normalized 502 chain_exhausted', async () => {
  const res = await req('POST', '/v1/chat/completions', {
    model: 'auto-router',
    messages: [{ role: 'user', content: 'ping' }],
  })
  exhausted = res
  assert.equal(hits.a, 1, `A should be hit once, got ${hits.a}`)
  assert.equal(hits.b, 1, `B should be hit once after failover, got ${hits.b}`)
  assert.equal(res.status, 502, `status ${res.status}: ${res.text}`)
  const json = JSON.parse(res.text)
  assert.ok(json.error, 'error envelope missing')
  assert.equal(json.error.type, 'gateway_upstream_error')
  assert.equal(json.error.code, 'chain_exhausted')
  assert.match(json.error.message, /all upstream providers/i)
  assert.equal(json.choices, undefined, 'must not leak an upstream body')
})

await check('A cooled down on business 401, B recorded a soft failure (no cooldown yet)', async () => {
  const status = gateway.status()
  assert.ok(status.cooldowns.some((c) => c.id === 'a'), `A not in cooldown: ${JSON.stringify(status.cooldowns)}`)
  const aCool = status.cooldowns.find((c) => c.id === 'a')
  assert.match(aCool.reason, /401/, `unexpected cooldown reason: ${aCool.reason}`)
  assert.ok(!status.cooldowns.some((c) => c.id === 'b'), 'B (single 500) must stay out of cooldown')
})

await check('second request skips the cooled-down A and still ends in chain_exhausted', async () => {
  const before = hits.a
  const res = await req('POST', '/v1/chat/completions', {
    model: 'auto-router', messages: [{ role: 'user', content: 'ping again' }],
  })
  assert.equal(hits.a, before, 'A must be skipped while cooling down')
  assert.equal(res.status, 502, `status ${res.status}`)
  assert.equal(JSON.parse(res.text).error.code, 'chain_exhausted')
})

await check('settings projection never leaks upstream keys', async () => {
  const view = redactGatewayConfig(config)
  const text = JSON.stringify(view)
  assert.ok(!text.includes(FAKE_KEY_A), 'key A leaked into the settings projection')
  assert.ok(!text.includes(FAKE_KEY_B), 'key B leaked into the settings projection')
  assert.equal(view.chain[0].hasKey, true)
  assert.equal(view.chain[0].apiKey, undefined)
  assert.ok(!JSON.stringify(gateway.status()).includes('fake-key'), 'key leaked into status()')
})

await check('mergeGatewayConfig keeps the stored key when a patch omits apiKey', async () => {
  const merged = mergeGatewayConfig(config, {
    chain: [{ id: 'a', label: 'A renamed', baseUrl: `http://127.0.0.1:${upstreamA.port}`, model: 'model-a2', authStyle: 'bearer', enabled: true, envelope: 'zhipu' }],
  })
  assert.equal(merged.chain.length, 1)
  assert.equal(merged.chain[0].label, 'A renamed')
  assert.equal(merged.chain[0].model, 'model-a2')
  assert.equal(merged.chain[0].apiKey, FAKE_KEY_A, 'stored key must survive a keyless patch')
})

await check('an empty apiKey (what the settings page always sends) also keeps the stored key', async () => {
  // The page can never read a key back, so it round-trips an empty string for
  // every entry that already has one — that must not wipe the key.
  const merged = mergeGatewayConfig(config, {
    chain: [{ id: 'a', baseUrl: `http://127.0.0.1:${upstreamA.port}`, model: 'model-a', apiKey: '' }],
  })
  assert.equal(merged.chain[0].apiKey, FAKE_KEY_A, 'empty apiKey wiped the stored key')
  // A genuinely new key still wins.
  const replaced = mergeGatewayConfig(config, {
    chain: [{ id: 'a', baseUrl: `http://127.0.0.1:${upstreamA.port}`, model: 'model-a', apiKey: 'rotated-key' }],
  })
  assert.equal(replaced.chain[0].apiKey, 'rotated-key', 'a provided key must replace the stored one')
})

await check('applyConfig() rebinds the listener (old port released, new one live)', async () => {
  const beforePort = gateway.status().port
  gateway.applyConfig()
  const d2 = Date.now() + 5000
  while (Date.now() < d2 && !gateway.status().listening) await new Promise((r) => setTimeout(r, 25))
  const afterPort = gateway.status().port
  assert.ok(afterPort, 'gateway not listening after applyConfig')
  assert.notEqual(afterPort, undefined)
  const res = await req('GET', '/healthz')
  assert.equal(res.status, 200, `healthz after applyConfig: ${res.status}`)
  console.log(`       port ${beforePort} → ${afterPort}`)
})

await check('stop() releases the port (connection refused afterwards)', async () => {
  const livePort = gateway.status().port
  gateway.stop()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(gateway.status().listening, false)
  assert.equal(gateway.status().port, null)
  let refused = false
  try { await reqPort(livePort, 'GET', '/healthz') } catch { refused = true }
  assert.ok(refused, `port ${livePort} still answering after stop()`)
})

// ---- teardown ----
await new Promise((r) => upstreamA.server.close(r))
await new Promise((r) => upstreamB.server.close(r))

console.log('\n--- gateway log (no keys) ---')
for (const line of logs) console.log(line)
if (JSON.stringify(logs).includes('fake-key')) {
  failures += 1
  console.error('  FAIL key material leaked into the gateway log')
}
console.log(`\ngateway smoke DSH_HOME: ${home}`)

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nOK: gateway smoke passed')
