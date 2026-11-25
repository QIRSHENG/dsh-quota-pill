/**
 * Build + smoke checks (zero dependencies).
 *   node scripts/build.mjs          → syntax/manifest checks
 *   node scripts/build.mjs --smoke  → checks + mock-context smoke test
 *
 * The smoke test loads lib/index.js with DSHZ_SMOKE=1 (no timers, no network)
 * against a fake cordis root/ctx, then exercises the quota and settings
 * routes end-to-end. All writes land in a temp DSH_HOME, never the real one.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  FAIL ${name}: ${err && err.message}`)
  }
}

async function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

console.log(`dsh-quota-pill build @ ${ROOT}`)
console.log(`node ${process.version}`)

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
check('package.json parses, version + dsh manifest present', () => {
  if (!packageJson.version) throw new Error('missing version')
  if (!packageJson.dsh || !packageJson.dsh.bundle || !packageJson.dsh.client) throw new Error('missing dsh manifest fields')
  if (packageJson.dsh.client.platform !== 'web') throw new Error('client platform must be web')
})

for (const file of ['lib/index.js', 'lib/client.js', 'lib/providers.js', 'lib/gateway.js', 'scripts/gateway-smoke.mjs', 'scripts/lifecycle-check.mjs', 'scripts/client-check.mjs', 'scripts/stream-check.mjs', 'scripts/migration-check.mjs']) {
  await check(`syntax: ${file}`, () => {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `exit ${result.status}`)
  })
}

if (process.argv.includes('--smoke')) {
  const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshz-smoke-'))
  process.env.DSH_HOME = smokeHome
  process.env.DSHZ_SMOKE = '1'
  const { default: plugin } = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
  await check('module loads and exports apply()', () => {
    if (typeof plugin.apply !== 'function') throw new Error('apply missing')
    if (plugin.name !== 'quota-pill') throw new Error(`unexpected name ${plugin.name}`)
  })

  const routes = []
  const fakeCtx = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    credentials: { resolve: async (name) => (name === 'ZHIPU_API_KEY' ? 'fake-key-for-smoke' : null) },
    connection: null,
    get(name) { return name === 'connection' ? null : undefined },
  }
  const disposers = []
  const fakeRoot = {
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    inject(services, cb) { cb(fakeCtx) },
  }
  plugin.apply(fakeRoot)

  await check('apply registers the four routes (quota/settings/key/log)', () => {
    for (const p of ['/dsh-quota-pill/quota', '/dsh-quota-pill/settings', '/dsh-quota-pill/key', '/dsh-quota-pill/log']) {
      if (!routes.some((r) => r.path === p)) throw new Error(`route missing: ${p}`)
    }
  })

  await check('apply registers the gateway route', () => {
    if (!routes.some((r) => r.path === '/dsh-quota-pill/gateway')) throw new Error('route missing: /dsh-quota-pill/gateway')
  })

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

  const quotaRoute = routes.find((r) => r.path === '/dsh-quota-pill/quota')
  const settingsRoute = routes.find((r) => r.path === '/dsh-quota-pill/settings')
  const keyRoute = routes.find((r) => r.path === '/dsh-quota-pill/key')
  const res1 = fakeRes()
  await quotaRoute.handler(fakeReq('GET'), res1)
  await check('GET /quota returns a starting snapshot (smoke mode: no timers)', async () => {
    const payload = JSON.parse(res1.body)
    await assertEqual(payload.ok, true, 'ok')
    await assertEqual(payload.state, 'starting', 'state')
    await assertEqual(payload.intervalMinutes, 2, 'default interval')
    await assertEqual(payload.provider, 'zhipu', 'provider')
    await assertEqual(payload.packs, null, 'packs')
  })

  const res2 = fakeRes()
  await settingsRoute.handler(fakeReq('POST', JSON.stringify({ intervalMinutes: 7 })), res2)
  await check('POST /settings {intervalMinutes:7} persists and echoes', async () => {
    const payload = JSON.parse(res2.body)
    await assertEqual(payload.ok, true, 'ok')
    await assertEqual(payload.intervalMinutes, 7, 'interval echo')
    const saved = JSON.parse(fs.readFileSync(path.join(smokeHome, 'quota-pill', 'config.json'), 'utf8'))
    await assertEqual(saved.intervalMinutes, 7, 'config file')
  })

  const res3 = fakeRes()
  await settingsRoute.handler(fakeReq('POST', JSON.stringify({ intervalMinutes: 999 })), res3)
  await check('POST /settings clamps out-of-range interval to 60', async () => {
    const payload = JSON.parse(res3.body)
    await assertEqual(payload.ok, true, 'ok')
    await assertEqual(payload.intervalMinutes, 60, 'clamped')
  })

  const res4 = fakeRes()
  await quotaRoute.handler(fakeReq('GET', undefined), res4)
  await check('GET /quota reflects updated interval', async () => {
    const payload = JSON.parse(res4.body)
    await assertEqual(payload.intervalMinutes, 60, 'interval')
  })

  const res5 = fakeRes()
  await quotaRoute.handler({ method: 'GET', headers: { host: 'evil.example.com' } }, res5)
  await check('non-loopback Host without host fence is rejected (403)', async () => {
    await assertEqual(res5.statusCode, 403, 'status')
  })

  // ---- panel key chain: POST /key → GET quota projection (fake key only) ----
  await check('POST /key with an empty string keeps the stored key (unchanged)', async () => {
    const res = fakeRes()
    await keyRoute.handler(fakeReq('POST', JSON.stringify({ apiKey: '' })), res)
    const payload = JSON.parse(res.body)
    await assertEqual(payload.ok, true, 'ok')
    await assertEqual(payload.unchanged, true, 'unchanged flag')
    await assertEqual(payload.hasKey, false, 'nothing stored yet')
  })

  await check('POST /key stores a fake key masked; GET /key + quota project hasKey + tail only', async () => {
    const fake = 'fake-panel-key-ABCD4321'
    const res = fakeRes()
    await keyRoute.handler(fakeReq('POST', JSON.stringify({ apiKey: fake })), res)
    const payload = JSON.parse(res.body)
    await assertEqual(payload.ok, true, 'ok')
    await assertEqual(payload.hasKey, true, 'hasKey')
    await assertEqual(payload.maskedHint, '4321', 'masked tail')
    const text = res.body
    if (text.includes(fake)) throw new Error('apiKey leaked in the POST /key response')
    const res2 = fakeRes()
    await keyRoute.handler(fakeReq('GET'), res2)
    const proj = JSON.parse(res2.body)
    await assertEqual(proj.hasKey, true, 'GET hasKey')
    await assertEqual(proj.maskedHint, '4321', 'GET masked tail')
    if (JSON.stringify(proj).includes(fake)) throw new Error('apiKey leaked in the GET /key projection')
    const res3 = fakeRes()
    await quotaRoute.handler(fakeReq('GET'), res3)
    const snap = JSON.parse(res3.body)
    await assertEqual(snap.hasKey, true, 'quota hasKey')
    await assertEqual(snap.maskedHint, '4321', 'quota maskedHint')
    if (JSON.stringify(snap).includes(fake)) throw new Error('apiKey leaked in the quota snapshot')
    const authRaw = fs.readFileSync(path.join(smokeHome, 'quota-pill', 'auth.json'), 'utf8')
    if (authRaw.includes(fake)) throw new Error('plaintext apiKey written to auth.json')
    const decoded = Buffer.from(JSON.parse(authRaw).apiKeyEncoded, 'base64').toString('utf8')
    await assertEqual(decoded, fake, 'auth.json round-trip decodes to the stored key')
  })

  await check('POST /key replaces, then clear deletes (credentials/env untouched)', async () => {
    const first = 'fake-key-AAAA1111'
    const second = 'fake-key-BBBB2222'
    const res = fakeRes()
    await keyRoute.handler(fakeReq('POST', JSON.stringify({ apiKey: first })), res)
    await assertEqual(JSON.parse(res.body).maskedHint, '1111', 'first key tail')
    const res2 = fakeRes()
    await keyRoute.handler(fakeReq('POST', JSON.stringify({ apiKey: second })), res2)
    await assertEqual(JSON.parse(res2.body).maskedHint, '2222', 'replaced key tail')
    const res3 = fakeRes()
    await keyRoute.handler(fakeReq('POST', JSON.stringify({ clear: true })), res3)
    const payload = JSON.parse(res3.body)
    await assertEqual(payload.ok, true, 'ok')
    await assertEqual(payload.hasKey, false, 'cleared')
    if (fs.existsSync(path.join(smokeHome, 'quota-pill', 'auth.json'))) throw new Error('auth.json survived clear')
    const res4 = fakeRes()
    await keyRoute.handler(fakeReq('DELETE'), res4)
    await assertEqual(res4.statusCode, 405, 'non-GET/POST rejected')
  })

  const res6 = fakeRes()
  await quotaRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:8559', origin: 'http://evil.example.com' } }, res6)
  await check('cross-origin Origin is rejected (403)', async () => {
    await assertEqual(res6.statusCode, 403, 'status')
  })

  await check('provider registry shape (v2 seam)', async () => {
    const { PROVIDERS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'providers.js')).href)
    const zhipu = PROVIDERS.zhipu
    for (const key of ['id', 'label', 'matchHost', 'credentialName', 'baseUrl', 'authAttempts', 'paths', 'parsePacks', 'parseSubscription', 'parseExpiry']) {
      if (zhipu[key] === undefined) throw new Error(`registry entry missing ${key}`)
    }
    if (!zhipu.matchHost('open.bigmodel.cn') || !zhipu.matchHost('api.z.ai')) throw new Error('matchHost failed for known hosts')
    if (zhipu.matchHost('api.deepseek.com')) throw new Error('matchHost must not claim other providers yet')
    const parsed = zhipu.parsePacks({ code: 200, rows: [{ tokenBalance: 800, tokensMagnitude: 10000, status: 'EFFECTIVE', resourcePackageName: 'GLM-5 资源包' }] })
    await assertEqual(parsed.packs[0].remaining, 800, 'tokenBalance')
    await assertEqual(parsed.packs[0].magnitude, 10000, 'magnitude')
    await assertEqual(parsed.packs[0].remaining * parsed.packs[0].magnitude, 8000000, 'effective tokens')
    const expiry = zhipu.parseExpiry({ expireTime: '2026-12-31 23:59:59', status: 'EFFECTIVE' })
    if (expiry.expiresAt === null) throw new Error('expiry parse missed expireTime field')
    const sub = zhipu.parseSubscription({ data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 42.5, nextResetTime: 1799000000000 }] } })
    await assertEqual(sub.windows[0].percent, 42.5, 'window percent')
  })

  await check('business-envelope classification (measured: auth failures arrive as HTTP 200 + code 401)', async () => {
    const { PROVIDERS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'providers.js')).href)
    const readEnvelope = PROVIDERS.zhipu.readEnvelope
    const authEnvelope = readEnvelope({ code: 401, msg: '令牌已过期或验证不正确', success: false })
    await assertEqual(authEnvelope.auth, true, 'auth flag')
    await assertEqual(authEnvelope.error, false, 'auth is not generic error')
    const planEnvelope = readEnvelope({ code: 401, msg: '当前用户不存在coding plan', success: false })
    await assertEqual(planEnvelope.auth, true, 'plan-unavailable reports auth-ish')
    await assertEqual(planEnvelope.planUnavailable, true, 'plan-unavailable flag')
    const okEnvelope = readEnvelope({ code: 200, rows: [], success: true })
    await assertEqual(okEnvelope.auth, false, '200 envelope not auth')
    await assertEqual(okEnvelope.error, false, '200 envelope not error')
    const weird = readEnvelope({ code: 500, msg: '服务器开小差了', success: false })
    await assertEqual(weird.error, true, 'non-200 non-auth is generic error')
    await assertEqual(readEnvelope(null), null, 'null body → no envelope')
    await assertEqual(readEnvelope({ rows: [] }), null, 'envelope-less body → no envelope')
  })

  await check('gateway config normalization + key redaction', async () => {
    const { normalizeGatewayConfig, redactGatewayConfig, mergeGatewayConfig, GATEWAY_PRESETS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'gateway.js')).href)
    const raw = normalizeGatewayConfig({
      enabled: true, port: 0, chain: [
        { id: 'a', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKey: 'sk-fake-secret' },
        { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-fake-two', enabled: false },
        { baseUrl: 'not-a-url', model: 'x' },
        { baseUrl: 'https://no-model.example', model: '' },
      ],
    })
    await assertEqual(raw.port, 0, 'ephemeral port kept')
    await assertEqual(raw.chain.length, 2, 'invalid entries dropped')
    await assertEqual(raw.chain[0].envelope, 'zhipu', 'bigmodel.cn auto-detects the zhipu envelope')
    await assertEqual(raw.chain[0].id, 'a', 'explicit id kept')
    await assertEqual(raw.chain[1].id, 'provider-2', 'generated id')
    await assertEqual(raw.chain[1].enabled, false, 'disabled flag kept')
    const view = redactGatewayConfig(raw)
    const text = JSON.stringify(view)
    if (text.includes('sk-fake-secret') || text.includes('sk-fake-two')) throw new Error('apiKey leaked into the settings projection')
    await assertEqual(view.chain[0].hasKey, true, 'hasKey true')
    await assertEqual(view.chain[0].apiKey, undefined, 'apiKey omitted')
    const merged = mergeGatewayConfig(raw, { chain: [{ id: 'a', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' }] })
    await assertEqual(merged.chain[0].apiKey, 'sk-fake-secret', 'keyless patch keeps the stored key')
    await assertEqual(merged.chain[0].model, 'glm-4-plus', 'patch applied')
    const emptied = mergeGatewayConfig(raw, { chain: [{ id: 'a', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', apiKey: '' }] })
    await assertEqual(emptied.chain[0].apiKey, 'sk-fake-secret', 'empty apiKey keeps the stored key (page round-trip)')
    await assertEqual(GATEWAY_PRESETS.length >= 4, true, 'presets present')
    await assertEqual(normalizeGatewayConfig(null).enabled, false, 'empty config stays disabled')
  })

  await check('gateway settings route persists and re-applies (SMOKE: no listener)', async () => {
    const gatewayRoute = routes.find((r) => r.path === '/dsh-quota-pill/gateway')
    if (!gatewayRoute) throw new Error('gateway route missing')
    const res = fakeRes()
    await gatewayRoute.handler(fakeReq('GET'), res)
    const before = JSON.parse(res.body)
    await assertEqual(before.ok, true, 'ok')
    await assertEqual(before.enabled, false, 'default disabled')
    await assertEqual(before.virtualModel, 'auto-router', 'virtual model')
    await assertEqual(before.status.listening, false, 'smoke must not bind a port')

    const res2 = fakeRes()
    await gatewayRoute.handler(fakeReq('POST', JSON.stringify({
      enabled: true,
      port: 18999,
      chain: [{ id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKey: 'sk-smoke-fake' }],
    })), res2)
    const after = JSON.parse(res2.body)
    await assertEqual(after.ok, true, 'ok')
    await assertEqual(after.enabled, true, 'enabled persisted')
    await assertEqual(after.port, 18999, 'port persisted')
    await assertEqual(after.chain.length, 1, 'chain persisted')
    await assertEqual(after.chain[0].hasKey, true, 'hasKey flag')
    if (JSON.stringify(after).includes('sk-smoke-fake')) throw new Error('apiKey leaked in the POST response')
    const saved = JSON.parse(fs.readFileSync(path.join(smokeHome, 'quota-pill', 'gateway.json'), 'utf8'))
    await assertEqual(saved.enabled, true, 'gateway.json enabled')
    await assertEqual(saved.chain[0].apiKey, 'sk-smoke-fake', 'key persisted host-side only')
    await assertEqual(after.status.listening, false, 'SMOKE still binds nothing')

    const res3 = fakeRes()
    await gatewayRoute.handler(fakeReq('DELETE'), res3)
    await assertEqual(res3.statusCode, 405, 'non-GET/POST rejected')
  })

  console.log(`smoke DSH_HOME: ${smokeHome}`)
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nOK: all checks passed')
