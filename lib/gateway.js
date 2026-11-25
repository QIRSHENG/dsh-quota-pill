/**
 * dsh-quota-pill — local routing gateway (host side).
 *
 * An OpenAI Chat Completions compatible surface on 127.0.0.1:<port>:
 *   POST /v1/chat/completions  (stream SSE + non-stream, tool-calls pass through)
 *   GET  /v1/models            (exactly one virtual model: auto-router)
 *   GET  /healthz
 *
 * The user points a DSH custom provider (openai-completions protocol) at
 * http://127.0.0.1:<port>/v1 — the DSH model list gains exactly one entry.
 * The gateway routes each request through the user-ranked provider chain and
 * transparently fails over to the next entry when the current one is denied
 * (HTTP 401/402/429, zhipu-style business envelope auth/quota errors, or a
 * low polling-side balance). Streaming failover is allowed only before the
 * first forwarded byte; after that an upstream break ends the response and
 * merely marks the provider failed (documented README behavior).
 *
 * Upstream keys live only in the host-side gateway.json (same trust domain
 * as DSH home); they are never logged and never returned by any API — the
 * settings API returns hasKey flags only. The key DSH itself sends to the
 * gateway is a placeholder and is not validated.
 */

import http from 'node:http'

export const VIRTUAL_MODEL = 'auto-router'
const DEFAULT_PORT = 18434
const DEFAULT_COOLDOWN_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 600_000
const MAX_BODY_BYTES = 8 * 1024 * 1024
// HTTP statuses that immediately fail over to the next chain entry.
const FAILOVER_HTTP = new Set([401, 402, 403, 429])
// Provider presets for the chain editor (all OpenAI Chat Completions compatible).
export const GATEWAY_PRESETS = [
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', authStyle: 'bearer', envelope: 'zhipu' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', authStyle: 'bearer', envelope: 'none' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', authStyle: 'bearer', envelope: 'none' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', authStyle: 'bearer', envelope: 'none' },
]

function joinUrl(base, suffix) {
  return `${String(base || '').replace(/\/+$/, '')}${suffix}`
}

function clampTimeout(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)))
}

function normalizePort(port) {
  const n = Number(port)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  const rounded = Math.round(n)
  if (rounded === 0) return 0 // ephemeral (tests)
  if (rounded < 1024 || rounded > 65535) return DEFAULT_PORT
  return rounded
}

export { clampTimeout, normalizePort }
export const GATEWAY_DEFAULTS = {
  enabled: false,
  port: DEFAULT_PORT,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  lowBalanceTokens: 0,
  upstreamTimeoutMs: DEFAULT_TIMEOUT_MS,
}

const AUTH_STYLES = new Set(['bearer', 'raw'])
const ENVELOPES = new Set(['zhipu', 'none'])
const MAX_CHAIN = 8

function str(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Normalize one chain entry; returns null when it cannot be used at all.
 * Keys are kept verbatim (host-side file only) but never echoed by any API. */
function normalizeChainEntry(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const baseUrl = str(raw.baseUrl)
  const model = str(raw.model)
  if (!baseUrl || !model) return null
  if (!/^https?:\/\//i.test(baseUrl)) return null
  const id = str(raw.id) || `provider-${index + 1}`
  return {
    id,
    label: str(raw.label) || model,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    authStyle: AUTH_STYLES.has(raw.authStyle) ? raw.authStyle : 'bearer',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    enabled: raw.enabled !== false,
    envelope: ENVELOPES.has(raw.envelope) ? raw.envelope : (/(^|\.)bigmodel\.cn/i.test(baseUrl) ? 'zhipu' : 'none'),
  }
}

/** Normalize the whole gateway config (file or request patch result). Keeps
 * the shape stable so the poller, routes and gateway always agree. */
export function normalizeGatewayConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const chain = Array.isArray(src.chain)
    ? src.chain.slice(0, MAX_CHAIN).map(normalizeChainEntry).filter(Boolean)
    : []
  // De-duplicate ids so cooldown/maps stay unambiguous.
  const seen = new Set()
  for (const entry of chain) {
    let id = entry.id
    let n = 2
    while (seen.has(id)) { id = `${entry.id}-${n}`; n += 1 }
    entry.id = id
    seen.add(id)
  }
  return {
    enabled: src.enabled === true,
    port: normalizePort(src.port),
    cooldownMs: Number.isFinite(Number(src.cooldownMs))
      ? Math.min(60 * 60_000, Math.max(10_000, Math.round(Number(src.cooldownMs))))
      : DEFAULT_COOLDOWN_MS,
    lowBalanceTokens: Number.isFinite(Number(src.lowBalanceTokens))
      ? Math.max(0, Math.round(Number(src.lowBalanceTokens)))
      : 0,
    upstreamTimeoutMs: clampTimeout(src.upstreamTimeoutMs),
    chain,
  }
}

/** Settings projection: identical to the stored config except every apiKey is
 * replaced by a boolean. Never leak key material to the web surface. */
export function redactGatewayConfig(config) {
  const cfg = normalizeGatewayConfig(config)
  return {
    ...cfg,
    chain: cfg.chain.map((entry) => {
      const { apiKey, ...rest } = entry
      return { ...rest, hasKey: !!(apiKey && apiKey.trim()) }
    }),
  }
}

/** Merge a settings patch into the current config without dropping keys the
 * client cannot see (a chain entry posted without apiKey keeps the old one). */
export function mergeGatewayConfig(current, patch) {
  const base = normalizeGatewayConfig(current)
  const src = patch && typeof patch === 'object' ? patch : {}
  const next = { ...base }
  if (src.enabled !== undefined) next.enabled = src.enabled === true
  if (src.port !== undefined) next.port = normalizePort(src.port)
  if (src.cooldownMs !== undefined) next.cooldownMs = src.cooldownMs
  if (src.lowBalanceTokens !== undefined) next.lowBalanceTokens = src.lowBalanceTokens
  if (src.upstreamTimeoutMs !== undefined) next.upstreamTimeoutMs = src.upstreamTimeoutMs
  if (Array.isArray(src.chain)) {
    const byId = new Map(base.chain.map((entry) => [entry.id, entry]))
    next.chain = src.chain
    next.chain.forEach((raw) => {
      if (!raw || typeof raw !== 'object') return
      // An absent or empty apiKey means "leave the stored key alone": the
      // settings page can never read a key back, so an empty field is the
      // normal state for an entry that already has one.
      const provided = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
      if (provided) return
      const previous = byId.get(str(raw.id))
      raw.apiKey = previous ? previous.apiKey : ''
    })
  }
  return normalizeGatewayConfig(next)
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

/**
 * @param {object} opts
 * @param {() => object} opts.getConfig  current gateway config {enabled,port,cooldownMs,lowBalanceTokens,upstreamTimeoutMs,chain}
 * @param {(msg: string) => void} opts.log
 * @param {(entry: object, body: object) => object|null} opts.envelope  provider-specific business-envelope classifier
 * @param {(entry: object) => number|null} opts.balanceTokensLeft  polling-side remaining tokens for this entry (null = unknown)
 */
export function createGateway(opts) {
  const { getConfig, log, envelope, balanceTokensLeft } = opts
  let server = null
  let actualPort = null
  let listenError = null
  const cooldowns = new Map() // id -> { until, reason }
  const softFailures = new Map() // id -> count
  let active = null // { id, label, model }
  let stopped = true

  function now() { return Date.now() }

  function coolDown(id, reason, ms) {
    cooldowns.set(id, { until: now() + ms, reason })
    softFailures.delete(id)
    log(`gateway: provider ${id} cooling down ${Math.round(ms / 1000)}s (${reason})`)
  }

  function inCooldown(id) {
    const entry = cooldowns.get(id)
    if (!entry) return false
    if (entry.until <= now()) { cooldowns.delete(id); return false }
    return true
  }

  function markHardFailure(entry, reason) {
    coolDown(entry.id, reason, Number(getConfig().cooldownMs) || DEFAULT_COOLDOWN_MS)
    if (active && active.id === entry.id) active = null
  }

  function markSoftFailure(entry, reason) {
    const count = (softFailures.get(entry.id) || 0) + 1
    softFailures.set(entry.id, count)
    log(`gateway: provider ${entry.id} soft failure #${count} (${reason})`)
    if (count >= 2) markHardFailure(entry, `${reason} ×${count}`)
    if (active && active.id === entry.id) active = null
  }

  function markSuccess(entry) {
    softFailures.delete(entry.id)
    cooldowns.delete(entry.id)
    active = { id: entry.id, label: entry.label, model: entry.model }
  }

  function status() {
    const config = getConfig()
    return {
      enabled: !!config.enabled,
      listening: !!server && actualPort !== null,
      port: actualPort,
      requestedPort: normalizePort(config.port),
      error: listenError,
      active,
      cooldowns: [...cooldowns.entries()].map(([id, c]) => ({ id, until: c.until, reason: c.reason })),
      chainCount: (config.chain || []).length,
      enabledChainCount: (config.chain || []).filter((e) => e.enabled).length,
    }
  }

  function respondJson(res, status, payload, extraHeaders) {
    try {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      for (const [k, v] of Object.entries(extraHeaders || {})) res.setHeader(k, v)
      res.end(JSON.stringify(payload))
    } catch {}
  }

  function respondError(res, status, message, type, code) {
    respondJson(res, status, { error: { message: String(message || 'unknown gateway error'), type: String(type || 'gateway_error'), code: code ?? null } })
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let body = ''
      let overflow = false
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > limit) { overflow = true; req.destroy(); reject(new Error('body too large')) }
      })
      req.on('error', () => {})
      req.on('end', () => { if (!overflow) resolve(body) })
      req.on('error', () => { if (!overflow) reject(new Error('request aborted')) })
    })
  }

  function safeText(response) {
    return response.text().catch(() => '')
  }

  function extractMessage(text) {
    try {
      const parsed = JSON.parse(text)
      return parsed?.error?.message || parsed?.msg || parsed?.message || text.slice(0, 300)
    } catch {
      return text.slice(0, 300) || 'upstream returned no body'
    }
  }

  async function handleModels(req, res) {
    respondJson(res, 200, {
      object: 'list',
      data: [{ id: VIRTUAL_MODEL, object: 'model', created: 0, owned_by: 'dsh-quota-pill' }],
    })
  }

  async function handleChat(req, res) {
    let clientBody
    try {
      const raw = await readBody(req, MAX_BODY_BYTES)
      clientBody = JSON.parse(raw || '{}')
    } catch (err) {
      respondError(res, 400, `invalid request body: ${err && err.message}`, 'invalid_request_error', 'bad_request')
      return
    }
    if (!clientBody || typeof clientBody !== 'object' || !Array.isArray(clientBody.messages)) {
      respondError(res, 400, 'messages array is required', 'invalid_request_error', 'bad_request')
      return
    }
    const wantsStream = clientBody.stream === true
    const config = getConfig()
    const chain = (config.chain || []).filter((entry) => entry && entry.enabled && entry.baseUrl && entry.model)
    if (chain.length === 0) {
      respondError(res, 503, 'gateway chain is empty — configure providers in DSH settings', 'gateway_error', 'empty_chain')
      return
    }

    for (const entry of chain) {
      if (inCooldown(entry.id)) { log(`gateway: skipping ${entry.id} (cooldown)`); continue }
      const balance = balanceTokensLeft ? balanceTokensLeft(entry) : null
      if (Number(config.lowBalanceTokens) > 0 && balance !== null && balance < Number(config.lowBalanceTokens)) {
        log(`gateway: skipping ${entry.id} (balance ${balance} below threshold ${config.lowBalanceTokens})`)
        continue
      }
      const outcome = await tryUpstream(entry, clientBody, wantsStream, res, config)
      if (outcome === 'forwarded' || outcome === 'aborted') return
      log(`gateway: failing over from ${entry.id}`)
    }
    respondError(res, 502, 'all upstream providers in the chain failed', 'gateway_upstream_error', 'chain_exhausted')
  }

  /** One upstream attempt. Returns 'forwarded' | 'failed' | 'aborted'.
   * Failover is only possible before any byte reaches the client — once the
   * SSE body starts, an upstream break ends the response (no switch). */
  async function tryUpstream(entry, clientBody, wantsStream, res, config) {
    const timeoutMs = clampTimeout(config.upstreamTimeoutMs)
    const controller = new AbortController()
    let clientGone = false
    const onClientClose = () => {
      if (!res.writableEnded) { clientGone = true; controller.abort() }
    }
    res.on('close', onClientClose)

    const headers = {
      'content-type': 'application/json',
      accept: wantsStream ? 'text/event-stream' : 'application/json',
      authorization: entry.authStyle === 'raw' ? String(entry.apiKey || '') : `Bearer ${String(entry.apiKey || '')}`,
    }
    if (entry.envelope === 'none' && /openrouter/i.test(String(entry.baseUrl))) {
      headers['HTTP-Referer'] = 'http://127.0.0.1'
      headers['X-Title'] = 'dsh-quota-pill'
    }

    let upstream
    let headerTimer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      upstream = await fetch(joinUrl(entry.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...clientBody, model: entry.model }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(headerTimer)
      res.removeListener('close', onClientClose)
      if (clientGone) { log(`gateway: client aborted during ${entry.id} request`); return 'aborted' }
      markSoftFailure(entry, `network: ${err && err.message}`)
      return 'failed'
    }

    const status = upstream.status
    const contentType = String(upstream.headers.get('content-type') || '')

    if (status < 200 || status >= 300) {
      clearTimeout(headerTimer)
      const text = await safeText(upstream)
      res.removeListener('close', onClientClose)
      if (clientGone) return 'aborted'
      if (FAILOVER_HTTP.has(status)) {
        markHardFailure(entry, `HTTP ${status}: ${extractMessage(text)}`)
        return 'failed'
      }
      if (status >= 500) {
        markSoftFailure(entry, `HTTP ${status}`)
        return 'failed'
      }
      // Genuine client-side error (400/404/422…): no failover — the request
      // itself is broken; return the normalized upstream error.
      respondError(res, status, extractMessage(text), 'upstream_error', `upstream_${status}`)
      return 'forwarded'
    }

    // 2xx + SSE: forward bytes as they arrive. Failover window closed once
    // the first chunk is written.
    if (wantsStream && contentType.includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      let forwardedAny = false
      let idleTimer = setTimeout(() => controller.abort(), timeoutMs)
      const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), timeoutMs) }
      try {
        for await (const chunk of upstream.body) {
          if (clientGone) break
          forwardedAny = true
          res.write(Buffer.from(chunk))
          resetIdle()
        }
        clearTimeout(idleTimer)
        clearTimeout(headerTimer)
        res.removeListener('close', onClientClose)
        try { res.end() } catch {}
        if (clientGone) { log(`gateway: client aborted mid-stream`); markSoftFailure(entry, 'client aborted mid-stream'); return 'aborted' }
        markSuccess(entry)
        return 'forwarded'
      } catch (err) {
        clearTimeout(idleTimer)
        clearTimeout(headerTimer)
        res.removeListener('close', onClientClose)
        try { res.end() } catch {}
        if (clientGone) return 'aborted'
        // After the first byte the request is committed — no failover.
        markSoftFailure(entry, forwardedAny ? 'upstream stream broke mid-flight' : 'upstream stream error before first byte')
        return forwardedAny ? 'forwarded' : 'failed'
      }
    }

    // 2xx JSON: envelope classification before anything reaches the client.
    clearTimeout(headerTimer)
    const text = await safeText(upstream)
    res.removeListener('close', onClientClose)
    if (clientGone) return 'aborted'
    let json = null
    try { json = JSON.parse(text) } catch {}
    const env = json ? envelope(entry, json) : null
    if (env && (env.auth || env.error)) {
      markHardFailure(entry, `business ${env.code}: ${env.msg}`)
      return 'failed'
    }
    markSuccess(entry)
    if (wantsStream && json) {
      // Upstream answered a stream request with a single JSON body —
      // synthesize a valid SSE sequence so the client parser stays happy.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      res.write(`data: ${JSON.stringify(json)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return 'forwarded'
    }
    res.writeHead(status, { 'Content-Type': contentType || 'application/json; charset=utf-8' })
    res.end(text)
    return 'forwarded'
  }

  function handler(req, res) {
    const urlPath = String((req.url || '/').split('?')[0])
    Promise.resolve().then(async () => {
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader('Allow', 'GET, POST, OPTIONS'); res.end(); return }
      if (urlPath === '/v1/models' && req.method === 'GET') { await handleModels(req, res); return }
      if (urlPath === '/v1/chat/completions' && req.method === 'POST') { await handleChat(req, res); return }
      if (urlPath === '/healthz') { respondJson(res, 200, { ok: true, model: VIRTUAL_MODEL }); return }
      respondError(res, 404, `unknown path ${urlPath}`, 'invalid_request_error', 'not_found')
    }).catch((err) => {
      log(`gateway: handler error: ${err && err.message}`)
      if (!res.writableEnded) respondError(res, 500, String(err && err.message), 'gateway_error', 'internal')
    })
  }

  function stop() {
    if (server) {
      const closing = server
      server = null
      actualPort = null
      try { closing.close() } catch {}
    }
    stopped = true
  }

  function start() {
    const config = getConfig()
    if (!config.enabled) { stop(); return }
    if (server) return
    listenError = null
    stopped = false
    const port = normalizePort(config.port)
    server = http.createServer(handler)
    server.on('clientError', (err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch {}
    })
    server.on('error', (err) => {
      listenError = err && err.code === 'EADDRINUSE'
        ? `端口 ${port} 被占用，换一个端口后保存`
        : String(err && err.message)
      log(`gateway: listen error: ${listenError}`)
      try { server.close() } catch {}
      server = null
      actualPort = null
    })
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port
      log(`gateway: listening on 127.0.0.1:${actualPort} (virtual model ${VIRTUAL_MODEL})`)
    })
  }

  function applyConfig() {
    stop()
    start()
  }

  return { start, stop, applyConfig, status, isActive: () => !stopped }
}
