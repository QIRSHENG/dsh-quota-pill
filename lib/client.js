window.__ModuleLoader__.load({id:`dsh-quota-pill`,factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`});let react=require("react");

// dsh-quota-pill client bundle.
// - conversation.composer.dock pill (id 'quota-pill', order 2) — sits beside
//   the shipped activity/usage pills, never covers them; typography follows
//   the native StatsPills baseline (font: inherit, theme font vars).
// - ONE settings.section 'quota-status' ("AI 额度") with two tabs:
//   监控 (key panel + polling + display) and 网关 (multi-upstream routing).
// Settings persist in localStorage and are pushed to the host poller; changes
// apply immediately (no reload).

const createElement = react.createElement
const { useState, useEffect, useRef, useMemo } = react

const PLUGIN_ID = 'dsh-quota-pill'
const SETTINGS_KEY = 'dsh.quotaPill.settings.v1'
const LEGACY_SETTINGS_KEY = 'dsh.zhipuStatus.settings.v1' // pre-rename client storage
const SETTINGS_EVENT = 'dshz:settings-changed'
const POLL_ENDPOINT = '/dsh-quota-pill/quota'
const SETTINGS_ENDPOINT = '/dsh-quota-pill/settings'
const KEY_ENDPOINT = '/dsh-quota-pill/key'
const GATEWAY_ENDPOINT = '/dsh-quota-pill/gateway'
const CLIENT_REFRESH_MS = 30_000

const DEFAULT_SETTINGS = {
  showPill: true,
  intervalMinutes: 2,
  fontScale: 'theme', // 'theme' | 'small' | 'medium' | 'large'
  showBalance: true,
  showExpiry: true,
  showThrottle: true,
  lowBalanceTokens: 0, // 0 = off
}

const FONT_SCALES = { theme: '', small: '11px', medium: '12px', large: '14px' }
const INTERVAL_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60]

const STYLE_ID = 'dshz-style-v2'
// Typography contract: NO font-family anywhere — pill and panel inherit the
// DSH theme font. Sizes: the pill follows the native StatsPills baseline
// (content-font-size-secondary − 1px; 20px line-height + the theme's font
// delta var); panel rows keep their explicit sizes. Only the text-size
// setting may override the pill font size, via an inline style.
const STYLE_TEXT = `
.dshz-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:280px;overflow:hidden;vertical-align:middle;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-tertiary,inherit);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap}
.dshz-pill .dshz-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.5;flex:none}
.dshz-pill .dshz-text{overflow:hidden;text-overflow:ellipsis}
.dshz-pill.dshz-low .dshz-text{color:var(--dsh-danger-color,var(--dsw-alias-state-danger-label,#d05050))}
.dshz-section{display:flex;flex-direction:column;gap:2px;max-width:560px;color:var(--dsw-alias-label-primary,inherit)}
.dshz-tabbar{display:flex;align-items:flex-end;gap:22px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));margin:2px 0 10px}
.dshz-tab{position:relative;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,inherit);background:none;border:none;padding:7px 1px 9px;cursor:pointer}
.dshz-tab[data-active="true"]{color:var(--dsw-alias-label-primary,inherit)}
.dshz-tab[data-active="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary,currentColor)}
.dshz-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid rgba(127,127,127,.18)}
.dshz-row:last-child{border-bottom:none}
.dshz-label{font-size:13px}
.dshz-hint{font-size:11px;opacity:.55}
.dshz-warn{font-size:11px;opacity:.85;color:var(--dsh-danger-color,var(--dsw-alias-state-danger-label,#d05050))}
.dshz-status{font:inherit;font-size:12px;line-height:18px;opacity:.75;white-space:pre-wrap;margin:4px 0 8px}
.dshz-select,.dshz-input{font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit}
.dshz-input{width:130px}
.dshz-keybox{display:flex;flex-direction:column;gap:4px;width:270px;flex:none}
.dshz-keybox .dshz-input{width:100%;box-sizing:border-box}
.dshz-keyactions{display:flex;gap:8px;justify-content:flex-end}
.dshz-check{accent-color:var(--dsh-accent-color,var(--dsw-alias-brand-primary,#4d6bfe));width:15px;height:15px;flex:none}
.dshz-chain{border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:8px;margin:6px 0;display:flex;flex-direction:column;gap:6px}
.dshz-chain-head{display:flex;align-items:center;gap:8px;white-space:nowrap}
.dshz-chain-id{font-size:11px;opacity:.55;font-variant-numeric:tabular-nums;flex:none}
.dshz-chain input[type=text],.dshz-chain input[type=password]{font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;min-width:0;flex:1}
.dshz-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer}
.dshz-btn.primary{border-color:var(--dsh-accent-color,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsh-accent-color,var(--dsw-alias-brand-primary,#4d6bfe))}
.dshz-btn.danger{color:var(--dsh-danger-color,var(--dsw-alias-state-danger-label,#d05050));border-color:rgba(208,80,80,.5)}
.dshz-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.dshz-sub{font-size:11px;opacity:.6;margin:2px 0 0}
`

function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.appendChild(style)
}

// ---- settings store (localStorage, synced to the host poller) ----

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(LEGACY_SETTINGS_KEY)
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) }
  } catch { return { ...DEFAULT_SETTINGS } }
}

function saveSettings(next) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch {}
  try { window.dispatchEvent(new CustomEvent(SETTINGS_EVENT)) } catch {}
  pushSettingsToHost(next)
}

function pushSettingsToHost(settings) {
  const base = resolveBase()
  if (!base && base !== '') return
  fetch(`${base}${SETTINGS_ENDPOINT}`, {
    method: 'POST',
    // text/plain keeps this a CORS simple request (no preflight) so the
    // desktop shell page can also reach the local host.
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ intervalMinutes: settings.intervalMinutes }),
  }).catch(() => {})
}

// ---- host snapshot fetch (same-origin first, then known local bases) ----

let resolvedBase = null
function candidateBases() {
  const list = ['']
  try { if (window.location && window.location.origin) list.push(window.location.origin) } catch {}
  list.push('http://127.0.0.1:8559')
  return [...new Set(list)]
}

/** Base for write requests: whatever GET resolved to, else same-origin (''). */
function resolveBase() {
  return resolvedBase !== null ? resolvedBase : ''
}

async function fetchWithBase(endpoint) {
  const bases = resolvedBase !== null ? [resolvedBase] : candidateBases()
  for (const base of bases) {
    try {
      const res = await fetch(`${base}${endpoint}`, { headers: { Accept: 'application/json' } })
      if (!res.ok) continue
      const json = await res.json()
      if (json && json.ok) { resolvedBase = base; return json }
    } catch {}
  }
  return null
}

const fetchSnapshot = () => fetchWithBase(POLL_ENDPOINT)

// ---- panel key (host-persisted auth.json; only hasKey + tail ever return) ----

async function fetchKeyInfo() {
  const json = await fetchWithBase(KEY_ENDPOINT)
  return json ? { hasKey: !!json.hasKey, maskedHint: json.maskedHint || '' } : null
}

async function pushApiKey(payload) {
  const base = resolveBase()
  if (!base && base !== '') return { ok: false, error: '宿主地址未解析' }
  try {
    const res = await fetch(`${base}${KEY_ENDPOINT}`, {
      method: 'POST',
      // text/plain keeps the POST a CORS simple request (no preflight).
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    })
    return await res.json()
  } catch (err) {
    return { ok: false, error: String(err && err.message) }
  }
}

// ---- gateway settings (host-persisted, never in localStorage) ----

const EMPTY_ENTRY = {
  id: '', label: '', baseUrl: '', model: '', authStyle: 'bearer', apiKey: '', enabled: true, envelope: 'none', hasKey: false,
}

const fetchGateway = () => fetchWithBase(GATEWAY_ENDPOINT)

async function pushGateway(patch) {
  const base = resolveBase()
  if (!base && base !== '') return { ok: false, error: '宿主地址未解析' }
  try {
    const res = await fetch(`${base}${GATEWAY_ENDPOINT}`, {
      method: 'POST',
      // text/plain keeps the POST a CORS simple request (no preflight).
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(patch),
    })
    return await res.json()
  } catch (err) {
    return { ok: false, error: String(err && err.message) }
  }
}

// ---- display helpers ----

function formatTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

function formatExpiry(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '到期未知'
  const date = new Date(ms)
  const pad = (x) => String(x).padStart(2, '0')
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return sameYear ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (x) => String(x).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Collapse a snapshot into pill parts + tooltip lines. */
function summarize(snapshot, settings) {
  const parts = []
  const lines = []
  let low = false
  const hasPacks = Array.isArray(snapshot.packs) && snapshot.packs.length > 0
  const hasData = hasPacks || snapshot.subscription
  if (!hasData) {
    const map = {
      'no-key': ['未配置 API Key', '在 设置 → AI 额度 → 监控 中填入，或配置 ZHIPU_API_KEY 凭据'],
      'auth-error': ['凭据无效', 'API Key 校验失败；在 设置 → AI 额度 → 监控 中更新'],
      'network-error': ['额度 · 重试中', '网络或限流失败，已自动退避重试'],
      'no-data': ['额度 · 暂无数据', '接口可达但没有可显示的余量数据'],
      'api-error': ['额度 · 接口异常', '上游返回了非预期业务码，可能接口已变更；详见插件 README'],
    }
    const entry = map[snapshot.state] || ['额度 · 连接中', '等待首次数据']
    return { parts: [entry[0]], lines: [entry[1]], low: false }
  }
  if (snapshot.mode === 'subscription' && snapshot.subscription) {
    const windows = snapshot.subscription.windows || []
    for (const w of windows) {
      parts.push(`${w.label} ${Math.round(Number(w.percent) || 0)}%`)
      lines.push(`${w.label} 窗口已用 ${Math.round(Number(w.percent) || 0)}%${w.resetAt ? `，重置 ${formatTime(Number(w.resetAt))}` : ''}`)
    }
  } else if (hasPacks) {
    const packs = snapshot.packs.filter((p) => p && (p.status === 'EFFECTIVE' || p.remaining !== null))
    let total = 0
    let earliest = null
    for (const pack of packs) {
      const remaining = Number(pack.remaining) || 0
      total += remaining * (Number(pack.magnitude) || 1)
      if (pack.expiresAt && (earliest === null || pack.expiresAt < earliest)) earliest = pack.expiresAt
      lines.push(`${pack.name}: ${formatTokens(remaining * (Number(pack.magnitude) || 1))} tokens${pack.expiresAt ? `，到期 ${formatExpiry(pack.expiresAt)}` : ''}${pack.model ? `（${pack.model}）` : ''}`)
    }
    if (settings.showBalance) parts.push(formatTokens(total))
    if (settings.showExpiry) parts.push(earliest ? formatExpiry(earliest) : '到期未知')
    if (Number(settings.lowBalanceTokens) > 0 && total <= Number(settings.lowBalanceTokens)) low = true
  }
  if (settings.showThrottle && snapshot.throttled) parts.push('降频')
  if (snapshot.cached) lines.push(`显示缓存（${formatTime(snapshot.fetchedAt)}），正在刷新`)
  else lines.push(`更新于 ${formatTime(snapshot.fetchedAt)}`)
  if (parts.length === 0) parts.push('额度')
  return { parts, lines, low }
}

// ---- components ----

function Pill() {
  const [snapshot, setSnapshot] = useState(null)
  const [settings, setSettings] = useState(loadSettings)
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const snap = await fetchSnapshot()
      if (alive && snap) setSnapshot(snap)
    }
    refresh()
    const timer = setInterval(refresh, CLIENT_REFRESH_MS)
    const onSettings = () => setSettings(loadSettings())
    window.addEventListener(SETTINGS_EVENT, onSettings)
    window.addEventListener('storage', onSettings)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener(SETTINGS_EVENT, onSettings)
      window.removeEventListener('storage', onSettings)
    }
  }, [])
  if (!settings.showPill) return null
  ensureStyle()
  const summary = snapshot ? summarize(snapshot, settings) : { parts: ['额度 · 连接中'], lines: ['连接宿主轮询服务…'], low: false }
  const fontSize = FONT_SCALES[settings.fontScale] || ''
  const className = `dshz-pill${summary.low ? ' dshz-low' : ''}`
  return createElement('span', { className, style: fontSize ? { fontSize } : undefined, title: `AI 额度\n${summary.lines.join('\n')}\n\n在 设置 → AI 额度 中配置` },
    createElement('span', { className: 'dshz-dot', 'aria-hidden': true }),
    createElement('span', { className: 'dshz-text' }, summary.parts.join(' · ')),
  )
}

function SectionIcon(props) {
  const size = Number(props && props.size) || 16
  return createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
    style: { display: 'block' },
  }, createElement('circle', { cx: 8, cy: 8, r: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.85 }),
    createElement('text', { x: 8, y: 11.4, textAnchor: 'middle', fontSize: 8.5, fontFamily: 'inherit', fill: 'currentColor', opacity: 0.9 }, 'Q'))
}

function CheckRow(props) {
  const { label, hint, checked, onChange } = props
  return createElement('div', { className: 'dshz-row' },
    createElement('label', { className: 'dshz-label', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      label,
      hint ? createElement('span', { className: 'dshz-hint' }, hint) : null,
    ),
    createElement('input', {
      type: 'checkbox', className: 'dshz-check', checked: !!checked,
      onChange: (event) => onChange(!!event.target.checked),
    }),
  )
}

// ---- tab 1: monitor panel (key + polling + display) ----

function MonitorPanel() {
  const [settings, setSettings] = useState(loadSettings)
  const [snapshot, setSnapshot] = useState(null)
  const [keyInfo, setKeyInfo] = useState(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyMsg, setKeyMsg] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const snap = await fetchSnapshot()
      if (alive && snap) setSnapshot(snap)
      const info = await fetchKeyInfo()
      if (alive && info) setKeyInfo(info)
    }
    refresh()
    const timer = setInterval(refresh, CLIENT_REFRESH_MS)
    const onSettings = () => setSettings(loadSettings())
    window.addEventListener(SETTINGS_EVENT, onSettings)
    return () => { alive = false; clearInterval(timer); window.removeEventListener(SETTINGS_EVENT, onSettings) }
  }, [])
  ensureStyle()
  const update = (patch) => {
    const next = { ...loadSettings(), ...patch }
    saveSettings(next)
    setSettings(next)
  }
  const saveKey = async () => {
    const value = keyDraft.trim()
    if (!value) return
    setKeyBusy(true)
    const result = await pushApiKey({ apiKey: value })
    setKeyBusy(false)
    if (result && result.ok) {
      setKeyInfo({ hasKey: !!result.hasKey, maskedHint: result.maskedHint || '' })
      setKeyDraft('')
      setKeyMsg('已保存（掩码存储在本机 auth.json，立即生效）')
    } else {
      setKeyMsg(`保存失败：${(result && result.error) || '未知错误'}`)
    }
  }
  const clearKey = async () => {
    setKeyBusy(true)
    const result = await pushApiKey({ clear: true })
    setKeyBusy(false)
    if (result && result.ok) {
      setKeyInfo({ hasKey: false, maskedHint: '' })
      setKeyMsg('已清除面板 Key（凭据服务/环境变量来源不受影响）')
    } else {
      setKeyMsg(`清除失败：${(result && result.error) || '未知错误'}`)
    }
  }
  const stateLine = snapshot
    ? [
      `数据模式：${snapshot.mode === 'resource-pack' ? '资源包余量' : snapshot.mode === 'subscription' ? '订阅窗口' : '未取得数据'}`,
      `状态：${snapshot.state}`,
      `面板 Key：${keyInfo ? (keyInfo.hasKey ? `已配置(尾4位 ${keyInfo.maskedHint})` : '未配置') : '读取中'}`,
      `上次成功：${snapshot.fetchedAt ? formatTime(snapshot.fetchedAt) : '—'}${snapshot.cached ? '（缓存）' : ''}`,
      `轮询间隔：${snapshot.intervalMinutes} 分钟${snapshot.throttled ? '（连续失败，已降频到 15 分钟）' : ''}`,
    ].join('\n')
    : '尚未连接宿主轮询服务（插件刚安装时刷新页面即可）'
  const keyPlaceholder = keyInfo && keyInfo.hasKey
    ? `已配置(尾4位 ${keyInfo.maskedHint})；留空保存=不修改`
    : '未配置；粘贴 API Key（仅存本机）'
  return createElement('div', { className: 'dshz-section' },
    createElement('div', { className: 'dshz-status' }, stateLine),
    keyMsg ? createElement('div', { className: 'dshz-hint' }, keyMsg) : null,
    createElement('div', { className: 'dshz-row' },
      createElement('label', { className: 'dshz-label', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        'API Key',
        createElement('span', { className: 'dshz-hint' },
          '优先级：面板存储 > DSH 凭据服务(ZHIPU_API_KEY) > 环境变量；保存后立即生效，日志与接口不回传明文'),
      ),
      createElement('div', { className: 'dshz-keybox' },
        createElement('input', {
          type: 'password', className: 'dshz-input', value: keyDraft,
          placeholder: keyPlaceholder, autoComplete: 'new-password', spellCheck: false,
          onChange: (event) => setKeyDraft(event.target.value),
          onKeyDown: (event) => { if (event && event.key === 'Enter') saveKey() },
        }),
        createElement('div', { className: 'dshz-keyactions' },
          createElement('button', {
            className: 'dshz-btn primary', type: 'button', onClick: saveKey,
            disabled: keyBusy || !keyDraft.trim(),
          }, keyBusy ? '保存中…' : '保存 Key'),
          keyInfo && keyInfo.hasKey
            ? createElement('button', {
              className: 'dshz-btn danger', type: 'button', onClick: clearKey, disabled: keyBusy,
            }, '清除')
            : null,
        ),
      ),
    ),
    createElement('div', { className: 'dshz-row' },
      createElement('span', { className: 'dshz-label' }, '在状态栏显示'),
      createElement('input', {
        type: 'checkbox', className: 'dshz-check', checked: settings.showPill,
        onChange: (event) => update({ showPill: event.target.checked }),
      }),
    ),
    createElement('div', { className: 'dshz-row' },
      createElement('label', { className: 'dshz-label', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        '轮询间隔',
        createElement('span', { className: settings.intervalMinutes < 2 ? 'dshz-warn' : 'dshz-hint' },
          settings.intervalMinutes < 2 ? '低于 2 分钟可能触发上游限流（429），会自动退避' : '改动立即生效（宿主轮询同步调整）'),
      ),
      createElement('select', {
        className: 'dshz-select', value: String(settings.intervalMinutes),
        onChange: (event) => update({ intervalMinutes: Number(event.target.value) }),
      }, INTERVAL_CHOICES.map((m) => createElement('option', { key: m, value: String(m) }, `${m} 分钟`))),
    ),
    createElement('div', { className: 'dshz-row' },
      createElement('span', { className: 'dshz-label' }, '文字大小'),
      createElement('select', {
        className: 'dshz-select', value: settings.fontScale,
        onChange: (event) => update({ fontScale: event.target.value }),
      }, [
        ['theme', '跟随主题'], ['small', '小'], ['medium', '中'], ['large', '大'],
      ].map(([value, label]) => createElement('option', { key: value, value }, label))),
    ),
    createElement(CheckRow, {
      label: '显示余量', checked: settings.showBalance, onChange: (v) => update({ showBalance: v }),
    }),
    createElement(CheckRow, {
      label: '显示到期时间', hint: '接口未提供有效期时显示「到期未知」', checked: settings.showExpiry,
      onChange: (v) => update({ showExpiry: v }),
    }),
    createElement(CheckRow, {
      label: '显示降频状态', hint: '连续 3 次失败自动降为 15 分钟轮询', checked: settings.showThrottle,
      onChange: (v) => update({ showThrottle: v }),
    }),
    createElement('div', { className: 'dshz-row' },
      createElement('label', { className: 'dshz-label', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        '低余额提醒阈值',
        createElement('span', { className: 'dshz-hint' }, '余量低于该值（tokens）时数字高亮；0 = 关闭'),
      ),
      createElement('input', {
        type: 'number', min: 0, step: 100000, className: 'dshz-input', value: settings.lowBalanceTokens || '',
        placeholder: '0',
        onChange: (event) => update({ lowBalanceTokens: Math.max(0, Math.floor(Number(event.target.value) || 0)) }),
      }),
    ),
    createElement('div', { className: 'dshz-hint', style: { marginTop: 8 } },
      '数据来自 provider 控制台内部接口（当前已接入智谱 GLM，非官方契约）；字体跟随 DSH 主题，字号由「文字大小」控制。详见插件 README。'),
  )
}

// ---- tab 2: gateway panel ----

function GlobalIcon(props) {
  const size = Number(props && props.size) || 16
  return createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
    style: { display: 'block' },
  },
    createElement('circle', { cx: 8, cy: 8, r: 6.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.85 }),
    createElement('ellipse', { cx: 8, cy: 8, rx: 3, ry: 6.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.7 }),
    createElement('line', { x1: 1.6, y1: 8, x2: 14.4, y2: 8, stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.7 }))
}

function TextField(props) {
  const { label, hint, value, placeholder, type, onChange, width } = props
  return createElement('label', { className: 'dshz-label', style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
    createElement('span', null, label),
    createElement('input', {
      type: type || 'text', value: value === null || value === undefined ? '' : String(value),
      placeholder: placeholder || '', className: 'dshz-input', style: width ? { width } : { width: '100%' },
      onChange: (event) => onChange(event.target.value),
    }),
    hint ? createElement('span', { className: 'dshz-hint' }, hint) : null,
  )
}

function chainEntryView(entry) {
  return {
    id: entry.id || '',
    label: entry.label || '',
    baseUrl: entry.baseUrl || '',
    model: entry.model || '',
    authStyle: entry.authStyle === 'raw' ? 'raw' : 'bearer',
    apiKey: '',
    enabled: entry.enabled !== false,
    envelope: entry.envelope === 'zhipu' ? 'zhipu' : 'none',
    hasKey: entry.hasKey === true,
  }
}

function GatewaySection() {
  const [cfg, setCfg] = useState(null)
  const [status, setStatus] = useState(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(null)

  const reload = async () => {
    const json = await fetchGateway()
    if (!json) { setMsg('尚未连接宿主（插件刚装好时刷新页面即可）'); return }
    setCfg(json)
    setStatus(json.status || null)
    setDraft({
      enabled: !!json.enabled,
      port: json.port,
      cooldownMs: json.cooldownMs,
      lowBalanceTokens: json.lowBalanceTokens,
      upstreamTimeoutMs: json.upstreamTimeoutMs,
      chain: (json.chain || []).map(chainEntryView),
    })
  }
  useEffect(() => { reload() }, [])

  const patchDraft = (patch) => setDraft((prev) => ({ ...(prev || {}), ...patch }))
  const patchEntry = (index, patch) => setDraft((prev) => {
    if (!prev) return prev
    const chain = prev.chain.slice()
    chain[index] = { ...chain[index], ...patch }
    return { ...prev, chain }
  })

  const save = async () => {
    if (!draft) return
    setBusy(true)
    const result = await pushGateway(draft)
    setBusy(false)
    if (result && result.ok) {
      setMsg('已保存并应用')
      setCfg(result)
      setStatus(result.status || null)
      setDraft({
        enabled: !!result.enabled,
        port: result.port,
        cooldownMs: result.cooldownMs,
        lowBalanceTokens: result.lowBalanceTokens,
        upstreamTimeoutMs: result.upstreamTimeoutMs,
        chain: (result.chain || []).map(chainEntryView),
      })
    } else {
      setMsg(`保存失败：${(result && result.error) || '未知错误'}`)
    }
  }

  const addEntry = () => setDraft((prev) => prev ? {
    ...prev,
    chain: [...prev.chain, { ...EMPTY_ENTRY, id: `provider-${prev.chain.length + 1}` }],
  } : prev)

  const removeEntry = (index) => setDraft((prev) => prev ? {
    ...prev, chain: prev.chain.filter((_, i) => i !== index),
  } : prev)

  const moveEntry = (index, delta) => setDraft((prev) => {
    if (!prev) return prev
    const target = index + delta
    if (target < 0 || target >= prev.chain.length) return prev
    const chain = prev.chain.slice()
    const [item] = chain.splice(index, 1)
    chain.splice(target, 0, item)
    return { ...prev, chain }
  })

  if (!cfg || !draft) {
    return createElement('div', { className: 'dshz-section' },
      createElement('div', { className: 'dshz-status' }, msg || '正在读取网关设置…'),
    )
  }

  const listening = status && status.listening
  const statusLine = [
    `状态：${draft.enabled ? (listening ? `运行中 127.0.0.1:${status.port}` : '已启用但未监听') : '已关闭'}`,
    status && status.error ? `错误：${status.error}` : null,
    `虚拟模型：${cfg.virtualModel}`,
    status && status.active ? `当前上游：${status.active.label}（${status.active.model}）` : null,
    status && status.cooldowns && status.cooldowns.length
      ? `冷却中：${status.cooldowns.map((c) => c.id).join('、')}` : null,
    `链路：${status ? status.enabledChainCount : draft.chain.length} 个启用 / 共 ${draft.chain.length}`,
  ].filter(Boolean).join('\n')

  const endpoint = `${resolvedBase || 'http://127.0.0.1:8559'}`
  const portNow = status && status.port ? status.port : draft.port

  return createElement('div', { className: 'dshz-section' },
    createElement('div', { className: 'dshz-status' }, statusLine),
    msg ? createElement('div', { className: 'dshz-hint' }, msg) : null,

    createElement('div', { className: 'dshz-row' },
      createElement('label', { className: 'dshz-label', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        '启用本地网关',
        createElement('span', { className: 'dshz-hint' }, '在 127.0.0.1 上开一个 OpenAI 兼容入口，供 DSH 自定义 provider 使用'),
      ),
      createElement('input', {
        type: 'checkbox', className: 'dshz-check', checked: draft.enabled,
        onChange: (event) => patchDraft({ enabled: event.target.checked }),
      }),
    ),

    createElement('div', { className: 'dshz-row' },
      createElement(TextField, {
        label: '监听端口', value: draft.port, type: 'number', placeholder: '18434',
        hint: '1024–65535；被占用时状态行会提示换端口', onChange: (v) => patchDraft({ port: Number(v) || 0 }),
      }),
      createElement(TextField, {
        label: '上游超时（秒）', value: Math.round((Number(draft.upstreamTimeoutMs) || 120000) / 1000), type: 'number',
        hint: '10–600 秒', onChange: (v) => patchDraft({ upstreamTimeoutMs: (Number(v) || 120) * 1000 }),
      }),
      createElement(TextField, {
        label: '冷却时长（秒）', value: Math.round((Number(draft.cooldownMs) || 300000) / 1000), type: 'number',
        hint: '失败上游暂停多久', onChange: (v) => patchDraft({ cooldownMs: (Number(v) || 300) * 1000 }),
      }),
    ),

    createElement('div', { className: 'dshz-row' },
      createElement(TextField, {
        label: '低余量跳过阈值（tokens）', value: draft.lowBalanceTokens, type: 'number', placeholder: '0',
        hint: '监控面板轮询到的余量低于此值时跳过该上游；0 = 关闭', onChange: (v) => patchDraft({ lowBalanceTokens: Math.max(0, Math.floor(Number(v) || 0)) }),
      }),
    ),

    createElement('div', { style: { marginTop: 14 } },
      createElement('div', { className: 'dshz-label' }, `上游链路（按顺序故障切换）`),
      createElement('div', { className: 'dshz-hint' },
        '命中 401/402/403/429、业务包络鉴权错误或 5xx 时自动切下一条；key 只存宿主 gateway.json，不回传页面。'),

      draft.chain.length === 0
        ? createElement('div', { className: 'dshz-hint', style: { margin: '8px 0' } }, '链路为空 —— 加一个上游后才能用。')
        : null,

      draft.chain.map((entry, index) => createElement('div', { className: 'dshz-chain', key: `${entry.id}-${index}` },
        createElement('div', { className: 'dshz-chain-head' },
          createElement('span', { className: 'dshz-chain-id' }, `#${index + 1}`),
          createElement('input', {
            type: 'checkbox', className: 'dshz-check', checked: entry.enabled,
            title: '启用该上游',
            onChange: (event) => patchEntry(index, { enabled: event.target.checked }),
          }),
          createElement(TextField, {
            label: '名称', value: entry.label, placeholder: '上游名称',
            onChange: (v) => patchEntry(index, { label: v }),
          }),
          createElement('button', {
            className: 'dshz-btn', type: 'button', title: '上移',
            onClick: () => moveEntry(index, -1), disabled: index === 0,
          }, '↑'),
          createElement('button', {
            className: 'dshz-btn', type: 'button', title: '下移',
            onClick: () => moveEntry(index, 1), disabled: index === draft.chain.length - 1,
          }, '↓'),
          createElement('button', {
            className: 'dshz-btn danger', type: 'button',
            onClick: () => removeEntry(index),
          }, '删除'),
        ),
        createElement('div', { className: 'dshz-chain-head' },
          createElement(TextField, {
            label: 'Base URL', value: entry.baseUrl, placeholder: 'https://open.bigmodel.cn/api/paas/v4',
            onChange: (v) => patchEntry(index, { baseUrl: v }),
          }),
          createElement(TextField, {
            label: '模型', value: entry.model, placeholder: 'glm-4-flash',
            onChange: (v) => patchEntry(index, { model: v }),
          }),
        ),
        createElement('div', { className: 'dshz-chain-head' },
          createElement(TextField, {
            label: entry.hasKey ? 'API key（已保存，留空则不改）' : 'API key',
            value: entry.apiKey, type: 'password',
            placeholder: entry.hasKey ? '••••••（保持不变）' : '粘贴上游 key',
            onChange: (v) => patchEntry(index, { apiKey: v }),
          }),
          createElement('label', { className: 'dshz-label', style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '0 0 auto' } },
            '鉴权',
            createElement('select', {
              className: 'dshz-select', value: entry.authStyle,
              onChange: (event) => patchEntry(index, { authStyle: event.target.value }),
            }, [['bearer', 'Bearer'], ['raw', '裸 key']].map(([v, l]) => createElement('option', { key: v, value: v }, l))),
          ),
          createElement('label', { className: 'dshz-label', style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '0 0 auto' } },
            '包络',
            createElement('select', {
              className: 'dshz-select', value: entry.envelope,
              onChange: (event) => patchEntry(index, { envelope: event.target.value }),
            }, [['none', 'OpenAI 标准'], ['zhipu', '智谱业务码']].map(([v, l]) => createElement('option', { key: v, value: v }, l))),
          ),
        ),
      )),

      createElement('div', { className: 'dshz-actions' },
        createElement('button', { className: 'dshz-btn', type: 'button', onClick: addEntry }, '+ 添加上游'),
        createElement('button', {
          className: 'dshz-btn', type: 'button',
          onClick: () => setDraft((prev) => prev ? {
            ...prev,
            chain: [...prev.chain, ...(cfg.presets || []).map((p) => ({
              ...EMPTY_ENTRY, id: '', label: p.label, baseUrl: p.baseUrl, model: p.model,
              authStyle: p.authStyle, envelope: p.envelope,
            }))],
          } : prev),
        }, '+ 一键加全部预设'),
      ),
    ),

    createElement('div', { className: 'dshz-actions' },
      createElement('button', {
        className: 'dshz-btn primary', type: 'button', onClick: save, disabled: busy,
      }, busy ? '保存中…' : '保存并应用'),
      createElement('button', { className: 'dshz-btn', type: 'button', onClick: reload, disabled: busy }, '重新读取'),
    ),

    createElement('div', { style: { marginTop: 14 } },
      createElement('div', { className: 'dshz-label' }, '接入 DSH'),
      createElement('div', { className: 'dshz-status' },
        `在 DSH 设置 → 模型 → 自定义 provider（OpenAI 兼容 / openai-completions）里填：\n`
        + `  Base URL：http://127.0.0.1:${portNow}/v1\n`
        + `  模型：${cfg.virtualModel}\n`
        + `  API key：任意占位值（网关不校验；真实上游 key 只在上面配置）\n\n`
        + `模型列表里只会出现 ${cfg.virtualModel} 一个条目，由网关按链路切换真实上游。`),
    ),
  )
}

// ---- merged settings section: one sidebar slot, two tabs ----

function QuotaSection() {
  const [tab, setTab] = useState('monitor')
  ensureStyle()
  return createElement('div', { className: 'dshz-section' },
    createElement('div', { className: 'dshz-tabbar', role: 'tablist', 'aria-label': 'AI 额度面板' },
      [['monitor', '监控'], ['gateway', '网关']].map(([value, label]) =>
        createElement('button', {
          key: value, type: 'button', role: 'tab', 'aria-selected': tab === value,
          className: 'dshz-tab', 'data-active': tab === value,
          onClick: () => setTab(value),
        }, label)),
    ),
    tab === 'gateway' ? createElement(GatewaySection) : createElement(MonitorPanel),
  )
}

// ---- registration ----

const inject = ['slots']

function apply(ctx) {
  // ONE settings.section: the "AI 额度" page (monitor / gateway tabs inside).
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'quota-status', order: 90, label: 'AI 额度' },
    QuotaSection,
  ))
  // matching nav icon (registration id must equal the section id)
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
    { name: 'settings.section.icon', id: 'quota-status' },
    SectionIcon,
  ))
  // composer dock pill beside the shipped activity/usage entries
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'quota-pill', order: 2 },
    Pill,
  ))
}

exports.apply = apply
exports.inject = inject
return module.exports
}});
//# sourceMappingURL=client.js.map
