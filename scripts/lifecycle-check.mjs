/**
 * Lifecycle check — proves the host wiring (lib/index.js), not just the class:
 *
 *   start()        plugin start with gateway.json{enabled:true} → port bound
 *   applyConfig()  POST /dsh-quota-pill/gateway → listener rebinds live
 *   stop()         plugin dispose → port released, nothing left running
 *
 * No network: the fake credentials service resolves null, so the poller lands
 * in 'no-key' and never touches an upstream. No real credential is read.
 * gateway.json here uses a fake key and an ephemeral port (port 0).
 *
 *   node scripts/lifecycle-check.mjs
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshz-life-'))
process.env.DSH_HOME = home
delete process.env.DSHZ_SMOKE
delete process.env.ZHIPU_API_KEY // the poller must find no key at all

const dataDir = path.join(home, 'quota-pill')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'gateway.json'), JSON.stringify({
  enabled: true,
  port: 0, // ephemeral: never collides with a real DSH gateway port
  cooldownMs: 60_000,
  lowBalanceTokens: 0,
  upstreamTimeoutMs: 10_000,
  chain: [{
    id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash', authStyle: 'bearer', apiKey: 'fake-key-lifecycle.invalid',
    enabled: true, envelope: 'zhipu',
  }],
}, null, 2))

let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`) } catch (err) {
    failures += 1
    console.error(`  FAIL ${name}: ${err && err.message}`)
  }
}

const { default: plugin } = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)

const routes = []
const fakeCtx = {
  webServer: { register(route) { routes.push(route); return () => {} } },
  credentials: { resolve: async () => null }, // → 'no-key', no upstream call
  connection: null,
  get() { return null },
}
const disposers = []
const fakeRoot = {
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
  inject(services, cb) { cb(fakeCtx) },
}

const gatewayRoute = () => routes.find((r) => r.path === '/dsh-quota-pill/gateway')

function fakeRes() {
  return { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v }, end(body) { this.body = body } }
}
function fakeReq(method, body) {
  const listeners = {}
  const req = {
    method,
    headers: { host: '127.0.0.1:8559' },
    on(event, fn) { (listeners[event] ||= []).push(fn); return req },
    emit(event, arg) { for (const fn of listeners[event] || []) fn(arg) },
  }
  if (body !== undefined) queueMicrotask(() => { req.emit('data', body); req.emit('end') })
  return req
}

async function readStatus() {
  const res = fakeRes()
  await gatewayRoute().handler(fakeReq('GET'), res)
  return JSON.parse(res.body)
}

function probe(port) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET' }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    r.on('error', reject)
    r.end()
  })
}

async function waitListening(expect, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    const s = await readStatus()
    if (s.status.listening === expect) return s
    if (Date.now() > deadline) throw new Error(`gateway never reached listening=${expect} (got ${JSON.stringify(s.status)})`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

console.log(`lifecycle check DSH_HOME: ${home}`)
plugin.apply(fakeRoot)

await check('plugin start bound the gateway (enabled:true in gateway.json)', async () => {
  const s = await waitListening(true)
  assert.equal(s.enabled, true)
  // status.port is the bound port; s.port is the configured one (0 = ephemeral).
  assert.ok(s.status.port > 0, `no bound port: ${s.status.port}`)
  assert.equal(s.port, 0, 'configured port stays 0 (ephemeral)')
  assert.equal(s.virtualModel, 'auto-router')
  const live = await probe(s.status.port)
  assert.equal(live.status, 200, `GET /v1/models on the live port: ${live.status}`)
  assert.equal(JSON.parse(live.text).data.length, 1)
  console.log(`       listening on 127.0.0.1:${s.status.port}`)
})

let firstPort
await check('POST /dsh-quota-pill/gateway triggers applyConfig() — listener rebinds live', async () => {
  const before = await readStatus()
  firstPort = before.status.port
  assert.ok(firstPort > 0, `no bound port before rebind: ${firstPort}`)
  const res = fakeRes()
  await gatewayRoute().handler(fakeReq('POST', JSON.stringify({ enabled: true, port: 0, upstreamTimeoutMs: 20_000 })), res)
  const after = JSON.parse(res.body)
  assert.equal(after.ok, true, `POST failed: ${res.body}`)
  assert.equal(after.upstreamTimeoutMs, 20_000, 'patch not applied')
  const s = await waitListening(true)
  assert.ok(s.status.port > 0, `no bound port after rebind: ${s.status.port}`)
  const live = await probe(s.status.port)
  assert.equal(live.status, 200, `GET /v1/models after applyConfig: ${live.status}`)
  // Old port must be released (rebind = stop + start); an ephemeral port may be
  // reused, so only assert when the bind actually moved.
  if (s.status.port !== firstPort) {
    let refused = false
    try { await probe(firstPort) } catch { refused = true }
    assert.ok(refused, `old port ${firstPort} still answering after applyConfig`)
  }
  console.log(`       port ${firstPort} → ${s.status.port}`)
})

await check('dispose stops the gateway (stop() on plugin teardown) and the port goes dead', async () => {
  const s = await readStatus()
  const livePort = s.status.port
  assert.ok(livePort > 0, `no bound port before dispose: ${livePort}`)
  for (const d of disposers) { try { d() } catch {} }
  await new Promise((r) => setTimeout(r, 200))
  const after = await readStatus()
  assert.equal(after.status.listening, false, 'still listening after dispose')
  let refused = false
  try { await probe(livePort) } catch { refused = true }
  assert.ok(refused, `port ${livePort} still answering after dispose`)
})

await check('no key material in debug.log or the settings projection', async () => {
  const logText = fs.readFileSync(path.join(dataDir, 'debug.log'), 'utf8')
  assert.ok(!logText.includes('fake-key-lifecycle'), 'apiKey leaked into debug.log')
  const view = JSON.stringify(await readStatus())
  assert.ok(!view.includes('fake-key-lifecycle'), 'apiKey leaked into the gateway settings route')
  assert.ok(/gateway: listening on 127\.0\.0\.1:\d+/.test(logText), 'no gateway startup line in debug.log')
})

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nOK: lifecycle (start / applyConfig / stop) verified')
