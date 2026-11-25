/**
 * Real-network chain probe with a FAKE key (verification artifact; safe to
 * keep in the repo — no real credential ever touches this path).
 *
 * Runs the plugin's own pollOnce chain against open.bigmodel.cn with a fake
 * ZHIPU_API_KEY, waits for a terminal state, and prints the debug log. The
 * expected outcome is state 'auth-error' (the gateway answers HTTP 200 with
 * business code 401 for invalid keys).
 *
 *   node scripts/probe.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_KEY = 'dshz-probe.fake.invalid'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshz-probe-'))
process.env.DSH_HOME = home
delete process.env.DSHZ_SMOKE

const { default: plugin } = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)

const routes = []
const fakeCtx = {
  webServer: { register(route) { routes.push(route); return () => {} } },
  credentials: { resolve: async () => FAKE_KEY },
  connection: null,
  get() { return null },
}
const disposers = []
const fakeRoot = {
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
  inject(services, cb) { cb(fakeCtx) },
}

console.log(`probe DSH_HOME: ${home}`)
console.log(`probe key: ${FAKE_KEY} (fake)`)
plugin.apply(fakeRoot)

const quotaRoute = routes.find((r) => r.path === '/dsh-zhipu-status/quota')

const deadline = Date.now() + 90_000
let snapshot = null
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const res = { statusCode: 0, headers: {}, body: null, setHeader() {}, end(body) { this.body = body } }
  await quotaRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:8559' } }, res)
  snapshot = JSON.parse(res.body)
  if (['auth-error', 'network-error', 'no-data', 'api-error', 'ok'].includes(snapshot.state)) break
}

for (const d of disposers) { try { d() } catch {} }

console.log(`final state: ${snapshot.state}`)
console.log(`mode: ${snapshot.mode} | throttled: ${snapshot.throttled} | interval: ${snapshot.intervalMinutes}min`)
console.log('--- debug.log (no secrets) ---')
try {
  console.log(fs.readFileSync(path.join(home, 'zhipu-status', 'debug.log'), 'utf8'))
} catch (err) {
  console.log(`(log read failed: ${err && err.message})`)
}

if (snapshot.state === 'auth-error') {
  console.log('PROBE OK: invalid key degraded to auth-error as designed')
} else {
  console.log(`PROBE UNEXPECTED: expected auth-error, got ${snapshot.state}`)
  process.exit(1)
}
