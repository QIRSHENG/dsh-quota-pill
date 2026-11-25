/**
 * Provider registry — the data-source seam for dsh-quota-pill.
 *
 * The core poller in lib/index.js is generic: it consumes any entry below, so
 * adding a provider (DeepSeek, SiliconFlow, OpenRouter, console-URL auto-
 * detection) only adds entries here — no core changes. Zhipu is entry #1 of
 * the registry, not the plugin identity. Each entry owns:
 *   - matchHost(host)     which provider serves a given console host (v2 seam)
 *   - credentialName      the DSH credential / env var holding its API key
 *   - baseUrl             API origin
 *   - authAttempts        header styles to try, in order, for the primary
 *                         endpoint ('bearer' = `Authorization: Bearer <key>`,
 *                         'raw' = the bare key, zhipu style)
 *   - paths               endpoint paths
 *   - parsePacks(body)    resource-pack list → normalized packs
 *   - parseSubscription   coding-plan window usage (fallback data source)
 *   - parseExpiry(row)    expiry field scan for one resource-pack row
 *
 * Endpoints below are UNDOCUMENTED console-internal endpoints reverse-
 * engineered from public third-party clients; they are not an official
 * contract and may change without notice. See README for details.
 */

const EPOCH_MIN_MS = 946684800000 // 2000-01-01

function finiteOr(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

function magnitudeOr(value) {
  const n = finiteOr(value, 1)
  return n > 0 ? n : 1
}

/**
 * Parse one expiry-ish value into epoch ms (CN station is UTC+8; Date.parse
 * already treats "YYYY-MM-DD HH:mm:ss" as local time, which matches for CN
 * users and stays harmless elsewhere).
 */
function parseWhen(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value
    return ms >= EPOCH_MIN_MS ? ms : null
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  let t = Date.parse(value)
  if (!Number.isFinite(t)) {
    const normalized = value.replace(' ', 'T')
    t = Date.parse(normalized)
  }
  if (!Number.isFinite(t)) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T]?(\d{2}:\d{2}(:\d{2})?)?$/.exec(value.trim())
    if (m) t = Date.parse(`${m[1]}T${m[2] || '00:00'}:00+08:00`)
  }
  return Number.isFinite(t) && t >= EPOCH_MIN_MS ? t : null
}

const EXPIRY_KEY_RE = /expire|expiry|valid|until|deadline|end_?time|end_?date|effective|gmt_|expired/i

export const PROVIDERS = {
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    matchHost(host) {
      return /(^|\.)bigmodel\.cn$/i.test(host) || /(^|\.)z\.ai$/i.test(host)
    },
    credentialName: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn',
    // Primary (token-accounts) endpoint: try Bearer first, then the bare key
    // (the zhipu monitor/biz gateways historically accepted the raw key).
    authAttempts: ['bearer', 'raw'],
    // Coding-plan window endpoint: bare key only (Bearer is rejected there).
    quotaAuth: 'raw',
    paths: {
      tokenAccounts: '/api/biz/tokenAccounts/list/my?pageNum=1&pageSize=100',
      quota: '/api/monitor/usage/quota/limit',
    },
    /**
     * Resource-pack rows → normalized packs.
     * Observed shape (glm-for-copilot reverse engineering, 2026-11):
     * { code: 200, rows: [{ tokenBalance, tokensMagnitude, status,
     *                       resourcePackageName, suitableModel }] }
     */
    parsePacks(body) {
      const rows = body && Array.isArray(body.rows) ? body.rows : []
      const packs = []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const remaining = finiteOr(row.tokenBalance)
        if (remaining === null && row.status !== 'EFFECTIVE') continue
        packs.push({
          name: typeof row.resourcePackageName === 'string' && row.resourcePackageName ? row.resourcePackageName : 'Token 资源包',
          remaining,
          magnitude: magnitudeOr(row.tokensMagnitude),
          status: typeof row.status === 'string' ? row.status : 'UNKNOWN',
          model: typeof row.suitableModel === 'string' ? row.suitableModel : null,
        })
      }
      if (packs.length === 0) {
        const error = new Error('no resource-pack rows in response')
        error.code = 'empty'
        throw error
      }
      return { packs }
    },
    /**
     * Coding-plan windows (fallback chain when the account has no packs).
     * Observed shape: { data: { limits: [{ type, unit, percentage,
     * nextResetTime }] } } with unit 3 = 5h window, 6 = weekly; non-plan
     * accounts get "当前用户不存在coding plan".
     */
    parseSubscription(body) {
      const container = body && body.data && !Array.isArray(body.data) ? body.data : body
      const limits = container && Array.isArray(container.limits)
        ? container.limits
        : (Array.isArray(container) ? container : [])
      const pick = (unit) => {
        const entry = limits.find((l) => l && (l.type === 'TOKENS_LIMIT' || l.type === 'CREDIT_LIMIT') && l.unit === unit)
          || limits.find((l) => l && (l.type === 'TOKENS_LIMIT' || l.type === 'CREDIT_LIMIT') && l.unit === undefined)
        if (!entry) return null
        return {
          label: unit === 3 ? '5h' : '周',
          percent: finiteOr(entry.percentage, 0),
          resetAt: parseWhen(entry.nextResetTime),
        }
      }
      const windows = [pick(3), pick(6)].filter(Boolean)
      if (windows.length === 0) {
        const error = new Error('no coding-plan windows in response')
        error.code = 'empty'
        throw error
      }
      return { level: typeof container.level === 'string' ? container.level : null, windows }
    },
    /** Scan one resource-pack row for expiry-like fields (v1: logs candidates). */
    parseExpiry(row) {
      const candidates = []
      let expiresAt = null
      for (const [key, value] of Object.entries(row || {})) {
        if (!EXPIRY_KEY_RE.test(key)) continue
        const when = parseWhen(value)
        candidates.push({ field: key, value: typeof value === 'string' || typeof value === 'number' ? value : String(JSON.stringify(value)).slice(0, 80), parsed: when })
        if (when !== null && (expiresAt === null || when < expiresAt)) expiresAt = when
      }
      return { expiresAt, candidates }
    },
    /**
     * Business-envelope classification for zhipu endpoints. Measured
     * 2026-11-25 with an invalid key: the gateway answers HTTP 200 with
     * `{code: 401, msg: "令牌已过期或验证不正确", success: false}` — auth
     * failures NEVER arrive as HTTP 401. A non-plan account's quota endpoint
     * reports the "coding plan" wording instead.
     */
    readEnvelope(body) {
      if (!body || typeof body !== 'object' || body.code === undefined) return null
      const code = Number(body.code)
      const msg = typeof body.msg === 'string' ? body.msg : ''
      const auth = code === 401 || code === 403 || /令牌|过期|验证不正确|unauthorized|invalid\s*key/i.test(msg)
      return {
        code,
        msg,
        success: body.success === true,
        auth,
        planUnavailable: /coding plan/i.test(msg),
        error: !auth && code !== 200,
      }
    },
  },
}

export { parseWhen }
