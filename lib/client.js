window.__ModuleLoader__.load({id:`dsh-zhipu-status`,factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`});let react=require("react");

// dsh-zhipu-status client bundle.
// - conversation.composer.dock pill (id 'zhipu-quota', order 2) — sits beside
//   the shipped activity/usage pills, never covers them.
// - settings.section 'zhipu-status' — a "智谱资源包" page in the DSH settings
//   panel (official list slot, replaceRisk 'none').
// Settings persist in localStorage and are pushed to the host poller; changes
// apply immediately (no reload).

const createElement = react.createElement
const { useState, useEffect, useRef, useMemo } = react

const PLUGIN_ID = 'dsh-zhipu-status'
const SETTINGS_KEY = 'dsh.zhipuStatus.settings.v1'
const SETTINGS_EVENT = 'dshz:settings-changed'
const POLL_ENDPOINT = '/dsh-zhipu-status/quota'
const SETTINGS_ENDPOINT = '/dsh-zhipu-status/settings'
const GATEWAY_ENDPOINT = '/dsh-zhipu-status/gateway'
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

const STYLE_ID = 'dshz-style-v1'
const STYLE_TEXT = `
.dshz-pill{display:inline-flex;align-items:center;gap:6px;padding:1px 10px;border-radius:999px;background:rgba(127,127,127,.12);color:inherit;line-height:20px;white-space:nowrap;max-width:280px;overflow:hidden;vertical-align:middle}
.dshz-pill .dshz-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.5;flex:none}
.dshz-pill .dshz-text{font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
.dshz-pill.dshz-low .dshz-text{color:var(--dsh-danger-color,#d05050);font-weight:600}
.dshz-section{display:flex;flex-direction:column;gap:2px;max-width:560px}
.dshz-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid rgba(127,127,127,.18)}
.dshz-row:last-child{border-bottom:none}
.dshz-label{font-size:13px}
.dshz-hint{font-size:11px;opacity:.55}
.dshz-warn{font-size:11px;opacity:.85;color:var(--dsh-danger-color,#d05050)}
.dshz-status{font-size:12px;opacity:.75;white-space:pre-wrap;margin:4px 0 8px}
.dshz-select,.dshz-input{font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit}
.dshz-input{width:130px}
.dshz-check{accent-color:var(--dsh-accent-color,#4d6bfe);width:15px;height:15px;flex:none}
.dshz-chain{border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:8px;margin:6px 0;display:flex;flex-direction:column;gap:6px}
.dshz-chain-head{display:flex;align-items:center;gap:8px;white-space:nowrap}
.dshz-chain-id{font-size:11px;opacity:.55;font-variant-numeric:tabular-nums;flex:none}
.dshz-chain input[type=text],.dshz-chain input[type=password]{font:inherit;font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;min-width:0;flex:1}
.dshz-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer}
.dshz-btn.primary{border-color:var(--dsh-accent-color,#4d6bfe);color:var(--dsh-accent-color,#4d6bfe)}
.dshz-btn.danger{color:var(--dsh-danger-color,#d05050);border-color:rgba(208,80,80,.5)}
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
    const raw = localStorage.getItem(SETTINGS_KEY)
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

async function fetchSnapshot() {
  const bases = resolvedBase !== null ? [resolvedBase] : candidateBases()
  for (const base of bases) {
    try {
      const res = await fetch(`${base}${POLL_ENDPOINT}`, { headers: { Accept: 'application/json' } })
      if (!res.ok) continue
      const json = await res.json()
      if (json && json.ok) { resolvedBase = base; return json }
    } catch {}
  }
  return null
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
      'no-key': ['未配置 ZHIPU_API_KEY', '在 DSH 设置 → 智谱资源包查看配置方法'],
      'auth-error': ['智谱凭据无效', 'ZHIPU_API_KEY 校验失败；检查凭据或接口变更'],
      'network-error': ['智谱 · 重试中', '网络或限流失败，已自动退避重试'],
      'no-data': ['智谱 · 暂无资源包', '接口可达但没有可显示的余量数据'],
      'api-error': ['智谱 · 接口异常', '智谱返回了非预期业务码，可能接口已变更；详见插件 README'],
    }
    const entry = map[snapshot.state] || ['智谱 · 连接中', '等待首次数据']
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
  if (parts.length === 0) parts.push('智谱')
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
  const summary = snapshot ? summarize(snapshot, settings) : { parts: ['智谱 · 连接中'], lines: ['连接宿主轮询服务…'], low: false }
  const fontSize = FONT_SCALES[settings.fontScale] || ''
  const className = `dshz-pill${summary.low ? ' dshz-low' : ''}`
  return createElement('span', { className, style: fontSize ? { fontSize } : undefined, title: `智谱资源包\n${summary.lines.join('\n')}\n\n在 设置 → 智谱资源包 中配置` },
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
    createElement('text', { x: 8, y: 11.4, textAnchor: 'middle', fontSize: 8.5, fontFamily: 'inherit', fill: 'currentColor', opacity: 0.9 }, 'Z'))
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

function ZhipuSection() {
  const [settings, setSettings] = useState(loadSettings)
  const [snapshot, setSnapshot] = useState(null)
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
    return () => { alive = false; clearInterval(timer); window.removeEventListener(SETTINGS_EVENT, onSettings) }
  }, [])
  ensureStyle()
  const update = (patch) => {
    const next = { ...loadSettings(), ...patch }
    saveSettings(next)
    setSettings(next)
  }
  const stateLine = snapshot
    ? [
      `数据模式：${snapshot.mode === 'resource-pack' ? '资源包余量' : snapshot.mode === 'subscription' ? 'Coding Plan 窗口' : '未取得数据'}`,
      `状态：${snapshot.state}`,
      `上次成功：${snapshot.fetchedAt ? formatTime(snapshot.fetchedAt) : '—'}${snapshot.cached ? '（缓存）' : ''}`,
      `轮询间隔：${snapshot.intervalMinutes} 分钟${snapshot.throttled ? '（连续失败，已降频到 15 分钟）' : ''}`,
    ].join('\n')
    : '尚未连接宿主轮询服务（插件刚安装时刷新页面即可）'
  return createElement('div', { className: 'dshz-section' },
    createElement('pre', { className: 'dshz-status' }, stateLine),
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
          settings.intervalMinutes < 2 ? '低于 2 分钟可能触发智谱限流（429），会自动退避' : '改动立即生效（宿主轮询同步调整）'),
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
      'API key 配置：DSH 凭据服务凭据名 ZHIPU_API_KEY（可在小鲸鱼记账的智谱模板里填一次，两个插件共用），或宿主环境变量 ZHIPU_API_KEY。数据来自智谱内部接口（非官方契约），详见插件 README。'),
  )
}

// ---- registration ----

const inject = ['slots']

function apply(ctx) {
  // settings.section: one page per list entry (official slot, id/order/label)
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'zhipu-status', order: 90, label: '智谱资源包' },
    ZhipuSection,
  ))
  // matching nav icon (registration id must equal the section id)
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
    { name: 'settings.section.icon', id: 'zhipu-status' },
    SectionIcon,
  ))
  // composer dock pill beside the shipped activity/usage entries
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'zhipu-quota', order: 2 },
    Pill,
  ))
}

exports.apply = apply
exports.inject = inject
return module.exports
}});
//# sourceMappingURL=client.js.map
