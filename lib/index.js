/**
 * dsh-zhipu-status — host side.
 *
 * Polls the Zhipu (GLM) balance endpoints on a configurable interval, caches
 * the last success under $DSH_HOME/zhipu-status/, and serves three local
 * routes for the client pill + settings section:
 *   GET  /dsh-zhipu-status/quota     current snapshot (packs / windows / state)
 *   POST /dsh-zhipu-status/settings  { intervalMinutes } (1..60, clamped)
 *   GET  /dsh-zhipu-status/log       tail of the local debug log (no secrets)
 *   GET  /dsh-zhipu-status/gateway   routing-gateway settings + live status
 *   POST /dsh-zhipu-status/gateway   patch settings → persist → applyConfig()
 *
 * The poller consumes the provider registry (lib/providers.js); v1 registers
 * only Zhipu. Keys are resolved through the DSH credentials service first
 * (ctx.credentials.resolve), then the ZHIPU_API_KEY env var. No credential
 * value is ever logged, cached, or served.
 *
 * Endpoints are undocumented console-internal APIs (see README); failures
 * degrade silently — the pill shows a readable state instead of erroring.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns'
import { PROVIDERS } from './providers.js'
import {
  createGateway,
  GATEWAY_PRESETS,
  VIRTUAL_MODEL,
  normalizeGatewayConfig,
  redactGatewayConfig,
  mergeGatewayConfig,
} from './gateway.js'

// undici may prefer IPv6; open.bigmodel.cn has AAAA records that break on
// many hosts (whale-widget lesson). IPv4-first keeps the poller usable.
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const VERSION = '0.1.0'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'zhipu-status')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const CACHE_FILE = path.join(DATA_DIR, 'cache.json')
const GATEWAY_FILE = path.join(DATA_DIR, 'gateway.json')
const LOG_FILE = path.join(DATA_DIR, 'debug.log')
const LOG_MAX_BYTES = 256 * 1024
const LOG_KEEP_BYTES = 128 * 1024

const SMOKE = process.env.DSHZ_SMOKE === '1'

const DEFAULT_INTERVAL_MIN = 2
const MIN_INTERVAL_MIN = 1
const MAX_INTERVAL_MIN = 60
const THROTTLE_INTERVAL_MIN = 15
const THROTTLE_AFTER = 3
const NOKEY_RECHECK_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
const POST_BODY_LIMIT = 4096
// Extra in-flight waits after a 429 before the attempt counts as failed.
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000]

function clampInterval(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return DEFAULT_INTERVAL_MIN
  const n = Number(minutes)
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MIN
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.round(n)))
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    logLineSafe(`write ${path.basename(file)} failed: ${err && err.message}`)
    return false
  }
}

function logLineSafe(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    let lines = ''
    try {
      const stat = fs.statSync(LOG_FILE)
      if (stat.size > LOG_MAX_BYTES) {
        const buf = fs.readFileSync(LOG_FILE)
        fs.writeFileSync(LOG_FILE, buf.subarray(buf.length - LOG_KEEP_BYTES))
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${String(message).slice(0, 2000)}\n`, 'utf8')
  } catch {}
}

let logSink = logLineSafe
function logLine(message) { try { logSink(message) } catch {} }

function readLogLines(count) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    return text.split('\n').filter(Boolean).slice(-count)
  } catch { return [] }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

/** Light trust fence: loopback-only by default, delegates to the host fence
 * when one exists. Fail-closed on any internal error (read-only endpoints,
 * but parity with whale-widget's posture). */
function makeFence(ctx) {
  function isLoopbackHostname(hostname) {
    const hn = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (hn === 'localhost' || hn.endsWith('.localhost') || hn === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hn)
    if (!m) return false
    return m.slice(1).every((x) => Number(x) <= 255)
  }
  return function fence(req) {
    try {
      const headers = (req && req.headers) || {}
      let parsed = null
      try { parsed = new URL('http://' + String(headers.host || '')) } catch { return 403 }
      const authority = parsed.host
      const site = String(headers['sec-fetch-site'] || '').toLowerCase()
      if (site === 'cross-site') return 403
      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        let originHost = null
        try { originHost = new URL(origin).host } catch { return 403 }
        if (originHost.toLowerCase() !== authority.toLowerCase()) return 403
      }
      if (!isLoopbackHostname(parsed.hostname)) {
        let conn = null
        try { conn = ctx.get('connection') || ctx.connection || null } catch {}
        if (!conn || typeof conn.requestRejection !== 'function') return 403
        let code
        try { code = conn.requestRejection(req) } catch { return 403 }
        if (code === undefined || code === null || code === false) return null
        return typeof code === 'number' ? code : 403
      }
      return null
    } catch { return 403 }
  }
}

function sendJson(res, payload, status = 200) {
  try {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {}
}

/** Host plugin entry. apply() runs immediately (no object-level inject, so
 * nothing delays registration); services arrive via root.inject. */
export default {
  name: 'zhipu-status',
  version: VERSION,
  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const d of disposers) { try { d() } catch {} }
    })
    root.inject(['webServer', 'credentials'], (ctx) => {
      start(ctx, disposers)
    })
  },
}

function start(ctx, disposers) {
  const provider = PROVIDERS.zhipu
  let timer = null
  let stopped = false
  let consecutiveFailures = 0
  let throttled = false
  let nextDelayMs = null

  const state = {
    state: 'starting',
    mode: null,
    provider: provider.id,
    packs: null,
    subscription: null,
    fetchedAt: 0,
    cached: false,
  }

  // Serve the last success immediately after a restart; the first poll
  // refreshes over it.
  const cached = readJson(CACHE_FILE)
  if (cached && cached.mode) {
    state.mode = cached.mode
    state.packs = Array.isArray(cached.packs) ? cached.packs : null
    state.subscription = cached.subscription ?? null
    state.fetchedAt = Number(cached.fetchedAt) || 0
    state.cached = true
  }

  const readConfig = () => {
    const raw = readJson(CONFIG_FILE)
    return { intervalMinutes: clampInterval(raw && raw.intervalMinutes) }
  }

  // ---- routing gateway (lib/gateway.js) ----
  // Config lives in $DSH_HOME/zhipu-status/gateway.json: same trust domain as
  // the rest of the cache, upstream keys never leave the host.
  const readGatewayConfig = () => normalizeGatewayConfig(readJson(GATEWAY_FILE))
  let gatewayConfig = readGatewayConfig()

  /** Remaining zhipu tokens from the last successful poll, for the gateway's
   * low-balance skip. Unknown (null) means "don't skip on balance". */
  function balanceTokensLeft(entry) {
    if (!entry || entry.envelope !== 'zhipu') return null
    if (!state.packs || state.packs.length === 0) return null
    let total = 0
    for (const pack of state.packs) {
      const remaining = Number(pack && pack.remaining)
      if (!Number.isFinite(remaining)) continue
      total += remaining * (Number(pack && pack.magnitude) || 1)
    }
    return total
  }

  /** zhipu-style business envelope classifier for gateway upstreams. */
  function gatewayEnvelope(entry, body) {
    if (!entry || entry.envelope !== 'zhipu') return null
    const readEnvelope = PROVIDERS.zhipu.readEnvelope
    const env = readEnvelope(body)
    if (!env) return null
    // Only auth/quota-ish business codes fail over; a plain non-200 code from
    // an OpenAI-compatible body is passed through untouched.
    if (env.auth) return { auth: true, code: env.code, msg: env.msg }
    if (env.error && (env.code === 429 || env.code === 402)) return { error: true, code: env.code, msg: env.msg }
    return null
  }

  const gateway = createGateway({
    getConfig: () => gatewayConfig,
    log: (message) => logLine(message),
    envelope: gatewayEnvelope,
    balanceTokensLeft,
  })

  // SMOKE mode must never bind a port: the smoke harness runs the plugin
  // routes in-process and a live listener would keep the event loop alive.
  const startGateway = () => { if (SMOKE) return; gateway.start() }
  const applyGatewayConfig = () => { if (SMOKE) return; gateway.applyConfig() }
  const stopGateway = () => { try { gateway.stop() } catch {} }

  const gatewaySnapshot = () => ({
    ok: true,
    ...redactGatewayConfig(gatewayConfig),
    virtualModel: VIRTUAL_MODEL,
    presets: GATEWAY_PRESETS,
    status: gateway.status(),
  })

  const snapshot = () => ({
    ok: true,
    version: VERSION,
    ...state,
    throttled,
    intervalMinutes: readConfig().intervalMinutes,
  })

  function schedule(ms) {
    if (stopped) return
    if (timer) { clearTimeout(timer); timer = null }
    timer = setTimeout(() => { timer = null; pollOnce() }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function setNext(ms) { if (nextDelayMs === null || ms < nextDelayMs) nextDelayMs = ms }

  function scheduleNext() {
    const interval = readConfig().intervalMinutes
    const effective = throttled ? Math.max(THROTTLE_INTERVAL_MIN, interval) : interval
    schedule(nextDelayMs ?? effective * 60_000)
    nextDelayMs = null
  }

  function commitSuccess(mode, data) {
    state.state = 'ok'
    state.mode = mode
    state.packs = data.packs ?? null
    state.subscription = data.subscription ?? null
    state.fetchedAt = Date.now()
    state.cached = false
    consecutiveFailures = 0
    throttled = false
    writeJsonAtomic(CACHE_FILE, {
      version: VERSION,
      mode: state.mode,
      packs: state.packs,
      subscription: state.subscription,
      fetchedAt: state.fetchedAt,
    })
  }

  function commitFailure(reason, detail) {
    consecutiveFailures += 1
    state.state = reason
    logLine(`poll failure #${consecutiveFailures}: ${reason}${detail ? ` (${detail})` : ''}`)
    if (consecutiveFailures >= THROTTLE_AFTER && !throttled) {
      throttled = true
      logLine(`throttling to ${THROTTLE_INTERVAL_MIN}min after ${consecutiveFailures} consecutive failures`)
    }
  }

  function authHeader(style, key) { return style === 'bearer' ? `Bearer ${key}` : key }

  async function fetchJson(url, style, key) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        headers: { Authorization: authHeader(style, key), Accept: 'application/json' },
        signal: controller.signal,
      })
      let body = null
      try { body = await res.json() } catch {}
      return { status: res.status, body }
    } finally { clearTimeout(timeout) }
  }

  async function fetchJsonWithBackoff(url, style, key) {
    let attempt = 0
    for (;;) {
      const result = await fetchJson(url, style, key)
      if (result.status !== 429 || attempt >= RATE_LIMIT_BACKOFF_MS.length) return result
      const wait = RATE_LIMIT_BACKOFF_MS[attempt]
      logLine(`429 from ${new URL(url).pathname}; backing off ${wait}ms`)
      await sleep(wait)
      attempt += 1
    }
  }

  async function resolveKey() {
    try {
      const resolve = ctx.credentials && typeof ctx.credentials.resolve === 'function'
        ? ctx.credentials.resolve.bind(ctx.credentials) : null
      if (resolve) {
        const cred = await resolve(provider.credentialName)
        if (typeof cred === 'string' && cred.trim()) return cred.trim()
      }
    } catch (err) {
      logLine(`credentials.resolve(${provider.credentialName}) failed: ${err && err.message}`)
    }
    const fromEnv = process.env[provider.credentialName]
    return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : null
  }

  async function pollOnce() {
    if (stopped) return
    nextDelayMs = null
    try {
      const key = await resolveKey()
      if (!key) {
        state.state = 'no-key'
        logLine(`no ${provider.credentialName} credential configured; rechecking in 60s`)
        setNext(NOKEY_RECHECK_MS)
        scheduleNext()
        return
      }

      const readEnvelope = typeof provider.readEnvelope === 'function' ? provider.readEnvelope : () => null
      let authDenied = 0
      let tokenAccountsAnswered = false
      let tokenAccountsHttp = 0

      for (const style of provider.authAttempts) {
        const result = await fetchJsonWithBackoff(provider.baseUrl + provider.paths.tokenAccounts, style, key)
        tokenAccountsHttp = result.status
        logLine(`tokenAccounts (${style}) → HTTP ${result.status}`)
        const envelope = result.status === 200 ? readEnvelope(result.body) : null
        if (envelope && envelope.auth) {
          authDenied += 1
          logLine(`tokenAccounts (${style}) → business ${envelope.code}: ${envelope.msg}`)
          continue // try the next auth style before declaring auth failure
        }
        if (envelope && envelope.error) {
          commitFailure('api-error', `tokenAccounts business ${envelope.code}: ${envelope.msg}`)
          scheduleNext()
          return
        }
        if (result.status === 200 && result.body) {
          tokenAccountsAnswered = true
          try {
            const { packs } = provider.parsePacks(result.body)
            const rows = Array.isArray(result.body.rows) ? result.body.rows : []
            for (let i = 0; i < packs.length; i += 1) {
              const expiry = provider.parseExpiry(rows[i])
              packs[i].expiresAt = expiry.expiresAt
              if (expiry.candidates.length > 0) {
                logLine(`expiry candidates (pack ${i}): ${JSON.stringify(expiry.candidates)}`)
              }
            }
            commitSuccess('resource-pack', { packs })
            setNext(readConfig().intervalMinutes * 60_000)
            scheduleNext()
            return
          } catch (err) {
            if (err && err.code === 'empty') {
              logLine('tokenAccounts 200 with no usable rows; falling through to quota endpoint')
            } else {
              logLine(`parsePacks failed: ${err && err.message}`)
            }
            break
          }
        }
        break
      }

      const canTryQuota = authDenied > 0 || tokenAccountsAnswered
        || tokenAccountsHttp === 401 || tokenAccountsHttp === 403 || tokenAccountsHttp === 404
      if (canTryQuota) {
        const quota = await fetchJsonWithBackoff(provider.baseUrl + provider.paths.quota, provider.quotaAuth, key)
        const envelope = quota.status === 200 ? readEnvelope(quota.body) : null
        logLine(`quota endpoint → HTTP ${quota.status}${envelope ? ` (business ${envelope.code})` : ''}`)
        if (envelope && envelope.auth) {
          commitFailure('auth-error', `quota business ${envelope.code}: ${envelope.msg}`)
          scheduleNext()
          return
        }
        if (envelope && envelope.planUnavailable) {
          state.state = 'no-data'
          logLine('account has no coding plan; subscription fallback unavailable')
          setNext(readConfig().intervalMinutes * 60_000)
          scheduleNext()
          return
        }
        if (envelope && envelope.error) {
          commitFailure('api-error', `quota business ${envelope.code}: ${envelope.msg}`)
          scheduleNext()
          return
        }
        if (quota.status === 200 && quota.body) {
          try {
            const subscription = provider.parseSubscription(quota.body)
            commitSuccess('subscription', { subscription })
            setNext(readConfig().intervalMinutes * 60_000)
            scheduleNext()
            return
          } catch (err) {
            logLine(`parseSubscription failed: ${err && err.message}`)
          }
        }
      }

      if (tokenAccountsAnswered) {
        state.state = 'no-data'
        logLine('endpoints reachable but no usable data; state=no-data')
        setNext(readConfig().intervalMinutes * 60_000)
        scheduleNext()
        return
      }
      if (authDenied > 0) {
        commitFailure('auth-error', `tokenAccounts business 401 after ${authDenied} auth style(s)`)
      } else if (tokenAccountsHttp === 429) {
        commitFailure('network-error', 'tokenAccounts 429 after backoff')
      } else {
        commitFailure('network-error', `tokenAccounts HTTP ${tokenAccountsHttp || 'no response'}`)
      }
      scheduleNext()
    } catch (err) {
      commitFailure('network-error', err && err.message)
      scheduleNext()
    }
  }

  function rescheduleNow() {
    if (stopped || SMOKE) return
    schedule(readConfig().intervalMinutes * 60_000)
  }

  // ---- routes ----
  const fence = makeFence(ctx)
  const register = (route) => {
    const inner = route.handler
    const wrapped = { ...route, handler: async (req, res) => {
      const deny = fence(req)
      if (deny) {
        try { res.statusCode = deny; res.end() } catch {}
        return
      }
      return inner(req, res)
    } }
    const disposer = ctx.webServer.register(wrapped)
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  register({ kind: 'exact', path: '/dsh-zhipu-status/quota', handler: (req, res) => sendJson(res, snapshot()) })

  register({ kind: 'exact', path: '/dsh-zhipu-status/log', handler: (req, res) => sendJson(res, { ok: true, lines: readLogLines(60) }) })

  /** Shared POST body reader: text/plain CORS-simple bodies from the client,
   * 4 KB cap, 413 on overflow. Resolves null after already answering. */
  function readPostJson(req, res, onJson) {
    let body = ''
    let overflow = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > POST_BODY_LIMIT) { overflow = true; req.destroy() }
    })
    req.on('error', () => {})
    req.on('end', () => {
      if (overflow) { res.statusCode = 413; res.end(); return }
      let parsed
      try { parsed = JSON.parse(body || '{}') } catch (err) {
        sendJson(res, { ok: false, error: `invalid JSON: ${err && err.message}` }, 400)
        return
      }
      onJson(parsed)
    })
  }

  register({ kind: 'exact', path: '/dsh-zhipu-status/settings', handler: (req, res) => {
    if (String(req.method || 'GET').toUpperCase() !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    readPostJson(req, res, (parsed) => {
      if (!Object.prototype.hasOwnProperty.call(parsed, 'intervalMinutes')) {
        sendJson(res, { ok: false, error: 'intervalMinutes required' }, 400)
        return
      }
      const minutes = clampInterval(parsed.intervalMinutes)
      writeJsonAtomic(CONFIG_FILE, { intervalMinutes: minutes, updatedAt: Date.now() })
      logLine(`settings updated: intervalMinutes=${minutes}`)
      rescheduleNow()
      sendJson(res, { ok: true, intervalMinutes: minutes })
    })
  } })

  // ---- gateway routes: GET status/projection, POST patch → persist → apply ----
  register({ kind: 'exact', path: '/dsh-zhipu-status/gateway', handler: (req, res) => {
    const method = String(req.method || 'GET').toUpperCase()
    if (method === 'GET') { sendJson(res, gatewaySnapshot()); return }
    if (method !== 'POST') { res.statusCode = 405; res.end(); return }
    readPostJson(req, res, (parsed) => {
      try {
        const next = mergeGatewayConfig(gatewayConfig, parsed)
        const saved = writeJsonAtomic(GATEWAY_FILE, next)
        if (!saved) { sendJson(res, { ok: false, error: 'failed to persist gateway.json' }, 500); return }
        gatewayConfig = next
        // Settings changed → restart the listener with the new config. The
        // gateway itself re-reads via getConfig, so this is the whole contract.
        applyGatewayConfig()
        logLine(`gateway settings updated: enabled=${next.enabled} port=${next.port} chain=${next.chain.length}`)
        sendJson(res, gatewaySnapshot())
      } catch (err) {
        sendJson(res, { ok: false, error: String(err && err.message) }, 400)
      }
    })
  } })

  disposers.push(() => { stopped = true; if (timer) clearTimeout(timer) })
  // Gateway lifecycle rides the same disposer list: plugin teardown stops the
  // listener, so a profile reload never leaves a stray port bound.
  disposers.push(stopGateway)

  logLine(`dsh-zhipu-status ${VERSION} started (smoke=${SMOKE ? '1' : '0'}, interval=${readConfig().intervalMinutes}min)`)
  if (!SMOKE) {
    // First poll fires immediately; later polls follow the configured interval.
    schedule(0)
  }
  // Start the gateway when enabled in gateway.json. SMOKE skips the listener
  // so the smoke test stays port-free.
  startGateway()
  const gatewayStatus = gateway.status()
  if (gatewayStatus.enabled && !SMOKE) logLine(`gateway enabled (port ${gatewayStatus.requestedPort})`)
}

export { clampInterval, readLogLines }
