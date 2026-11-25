/**
 * Client bundle check — the client is a hand-wrapped IIFE bundle with no build
 * step, so this loads it the way DSH does (window.__ModuleLoader__), gives it a
 * minimal fake react, and renders every registered component.
 *
 *   node scripts/client-check.mjs
 *
 * Covers: module evaluates, slot registrations (1 settings.section + 1 icon +
 * 1 dock pill), the pill renders with a snapshot, the merged "AI 额度" section
 * renders its monitor tab (API-key panel + polling rows) and its gateway tab
 * (chain editor) with a mocked host, and the key-save / gateway-save flows
 * post to the right host routes. Bundle-level: no CSS font-family anywhere
 * (typography follows the DSH theme), no legacy dsh-zhipu-status strings.
 *
 * Assertion strings use unicode escapes so the file stays robust no matter
 * which codepage an editor or shell round-trips it through.
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`) } catch (err) {
    failures += 1
    console.error(`  FAIL ${name}: ${err && err.message}`)
  }
}

// ---- bundle-level static assertions (typography + neutral naming) ----

await check('bundle has no CSS font-family (typography follows the DSH theme)', () => {
  assert.ok(!/font-family\s*:/i.test(SRC), 'a CSS font-family declaration is hardcoded')
  assert.ok(SRC.includes('font:inherit'), 'inputs must inherit the theme font (font:inherit)')
  assert.ok(SRC.includes('font-size:calc(var(--dsh-content-font-size-secondary'), 'pill font size must follow the theme secondary size var')
  assert.ok(SRC.includes("createElement('pre'") === false, 'status lines must not use <pre> (browser default is monospace)')
})

await check('bundle carries no legacy dsh-zhipu-status identifier', () => {
  assert.ok(!SRC.includes('dsh-zhipu-status'), 'legacy plugin id found in the client bundle')
  assert.ok(!SRC.includes('/dsh-zhipu-status/'), 'legacy route prefix found in the client bundle')
})

// ---- fake react: a per-instance fiber so nested components work ----
let currentFiber = null
const allFibers = []
const react = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  useState(initial) {
    const fiber = currentFiber
    const i = fiber.index++
    if (!(i in fiber.state)) fiber.state[i] = typeof initial === 'function' ? initial() : initial
    return [fiber.state[i], (next) => { fiber.state[i] = typeof next === 'function' ? next(fiber.state[i]) : next }]
  },
  useEffect(fn) { currentFiber.effects.push(fn) },
  useRef(initial) { return { current: initial } },
  useMemo(fn) { return fn() },
}

function newFiber() {
  const fiber = { state: [], index: 0, effects: [] }
  allFibers.push(fiber)
  return fiber
}

function withFiber(fiber, fn) {
  const previous = currentFiber
  currentFiber = fiber
  fiber.index = 0
  try { return fn() } finally { currentFiber = previous }
}

/** Expand function components into host elements. Fibers are cached per
 * component identity for the current render session so hook state survives
 * the re-render that follows an effect. */
let fiberCache = new Map()

function expand(node) {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') {
    const key = node.key !== undefined ? `${node.type.name}#${node.key}` : node.type
    let fiber = fiberCache.get(key)
    if (!fiber) {
      fiber = { state: [], index: 0, effects: [], key }
      fiberCache.set(key, fiber)
      allFibers.push(fiber)
    }
    const out = withFiber(fiber, () => node.type(node.props || {}))
    return expand(out)
  }
  return { type: node.type, props: node.props, children: node.children.map(expand) }
}

// ---- fake browser ----
const localStorageStore = new Map()
globalThis.window = {
  location: { origin: 'http://127.0.0.1:8559' },
  localStorage: {
    getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
    setItem: (k, v) => localStorageStore.set(k, v),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
}
globalThis.localStorage = window.localStorage
globalThis.CustomEvent = class { constructor(type) { this.type = type } }
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: () => {} },
}

// Mock host: snapshot + key projection for the monitor tab, gateway settings
// for the gateway tab.
const SNAPSHOT = {
  ok: true, version: '0.1.0', state: 'ok', mode: 'resource-pack', provider: 'zhipu',
  packs: [{ name: 'GLM-5 pack', remaining: 800, magnitude: 10000, status: 'EFFECTIVE', model: null, expiresAt: 1799999999000 }],
  subscription: null, fetchedAt: Date.now() - 60000, cached: false, throttled: false, intervalMinutes: 2,
  hasKey: true, maskedHint: '8888',
}
const KEY = { ok: true, hasKey: true, maskedHint: '8888' }
const GATEWAY = {
  ok: true, enabled: true, port: 18434, cooldownMs: 300000, lowBalanceTokens: 0, upstreamTimeoutMs: 120000,
  chain: [{
    id: 'zhipu', label: 'ZHIPU-GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
    authStyle: 'bearer', enabled: true, envelope: 'zhipu', hasKey: true,
  }],
  virtualModel: 'auto-router',
  presets: [{ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', authStyle: 'bearer', envelope: 'none' }],
  status: {
    enabled: true, listening: true, port: 18434, requestedPort: 18434, error: null,
    active: { id: 'zhipu', label: 'ZHIPU-GLM', model: 'glm-4-flash' },
    cooldowns: [], chainCount: 1, enabledChainCount: 1,
  },
}
const fetchCalls = []
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts })
  const body = url.includes('/gateway') ? GATEWAY : url.includes('/key') ? KEY : SNAPSHOT
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

// ---- load the bundle like DSH does ----
let loaded = null
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) { loaded = { id, exports: factory((name) => (name === 'react' ? react : ({}))) } },
}
new Function('window', 'document', 'localStorage', 'fetch', 'CustomEvent', SRC)(
  window, globalThis.document, globalThis.localStorage, globalThis.fetch, globalThis.CustomEvent,
)

await check('bundle evaluates and exports apply + inject under the new id', () => {
  assert.ok(loaded, 'module loader was never called')
  assert.equal(loaded.id, 'dsh-quota-pill')
  assert.equal(typeof loaded.exports.apply, 'function')
  assert.deepEqual(loaded.exports.inject, ['slots'])
})

// ---- collect slot registrations ----
const registrations = []
const ctx = {
  slots: {
    inject(name, fn) { fn() },
    register(meta, component) { registrations.push({ meta, component }); return () => {} },
  },
}
loaded.exports.apply(ctx)

await check('registers ONE settings section + one icon + the dock pill (new ids)', () => {
  const byName = (n) => registrations.filter((r) => r.meta.name === n)
  const sections = byName('settings.section').map((r) => r.meta.id)
  assert.deepEqual(sections, ['quota-status'], `sections: ${sections} (exactly one sidebar slot)`)
  const icons = byName('settings.section.icon').map((r) => r.meta.id)
  assert.deepEqual(icons, ['quota-status'], `icons: ${icons}`)
  for (const id of sections) assert.ok(icons.includes(id), `no icon registered for section ${id}`)
  const dock = byName('conversation.composer.dock')
  assert.equal(dock.length, 1)
  assert.equal(dock[0].meta.id, 'quota-pill')
  assert.equal(dock[0].meta.replaceRisk, undefined, 'pill must not claim a replace risk')
})

function textOf(tree) {
  if (tree === null || tree === undefined || tree === false) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join(' ')
  return textOf(tree.children)
}

function findAll(tree, pred, out = []) {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { tree.forEach((t) => findAll(t, pred, out)); return out }
  if (pred(tree)) out.push(tree)
  findAll(tree.children, pred, out)
  return out
}

/** Expand, run collected effects (awaiting async ones), re-expand, repeat. */
async function settle(component, props = {}) {
  fiberCache = new Map()
  allFibers.length = 0
  let tree = withFiber(newFiber(), () => expand({ type: component, props }))
  for (let pass = 0; pass < 4; pass += 1) {
    const pending = allFibers.flatMap((f) => f.effects.splice(0))
    if (pending.length === 0) break
    for (const effect of pending) {
      const cleanup = effect()
      if (cleanup && typeof cleanup.then === 'function') await cleanup
      if (typeof cleanup === 'function') globalThis.__cleanups = (globalThis.__cleanups || []).concat(cleanup)
    }
    await new Promise((r) => setTimeout(r, 40))
    tree = withFiber(newFiber(), () => expand({ type: component, props }))
  }
  return tree
}

function cleanupAll() {
  for (const fn of globalThis.__cleanups || []) { try { fn() } catch {} }
  globalThis.__cleanups = []
  allFibers.length = 0
}

const components = Object.fromEntries(registrations.map((r) => [`${r.meta.name}:${r.meta.id || ''}`, r.component]))

// UI strings under test (escaped to survive any encoding round-trip).
const S = {
  modePack: '\u8d44\u6e90\u5305\u4f59\u91cf',            // 资源包余量
  interval: '\u8f6e\u8be2\u95f4\u9694',                  // 轮询间隔
  lowBalance: '\u4f4e\u4f59\u989d',                      // 低余额
  running: '\u8fd0\u884c\u4e2d',                         // 运行中
  zhipuLabel: 'ZHIPU-GLM',
  addUpstream: '\u6dfb\u52a0\u4e0a\u6e38',               // 添加上游
  addPresets: '\u4e00\u952e\u52a0\u5168\u90e8\u9884\u8bbe', // 一键加全部预设
  save: '\u4fdd\u5b58\u5e76\u5e94\u7528',                // 保存并应用
  saveKey: '\u4fdd\u5b58 Key',                           // 保存 Key
  keyConfigured: '\u5df2\u914d\u7f6e(\u5c3e4\u4f4d 8888)', // 已配置(尾4位 8888)
  apiKey: 'API Key',
  tabMonitor: '\u76d1\u63a7',                            // 监控
  tabGateway: '\u7f51\u5173',                            // 网关
  sectionLabel: 'AI \u989d\u5ea6',                       // AI 额度
}

await check('dock pill renders the balance + expiry from a live snapshot', async () => {
  const tree = await settle(components['conversation.composer.dock:quota-pill'])
  const text = textOf(tree)
  assert.ok(/8(\.0)?M/.test(text), `pill text missing the balance: ${text}`)
  assert.ok(/\d{2}-\d{2}/.test(text), `pill text missing the expiry: ${text}`)
  cleanupAll()
})

await check('merged section renders the tab bar with 监控/网关 and defaults to 监控', async () => {
  const tree = await settle(components['settings.section:quota-status'])
  const text = textOf(tree)
  const tabs = findAll(tree, (t) => t.type === 'button' && t.props && t.props.role === 'tab')
  assert.equal(tabs.length, 2, `expected two tab buttons, got ${tabs.length}`)
  assert.equal(textOf(tabs[0]), S.tabMonitor, 'first tab must be 监控')
  assert.equal(textOf(tabs[1]), S.tabGateway, 'second tab must be 网关')
  assert.equal(tabs[0].props['aria-selected'], true, 'monitor tab must be selected by default')
  assert.ok(text.includes(S.apiKey), 'monitor tab must expose the API Key row')
  assert.ok(!text.includes(S.running), 'gateway content must not render while the monitor tab is active')
  cleanupAll()
})

await check('monitor tab renders the key panel: password field, masked placeholder, no plaintext', async () => {
  const tree = await settle(components['settings.section:quota-status'])
  const text = textOf(tree)
  assert.ok(text.includes(S.keyConfigured), `masked key status missing: ${text.slice(0, 300)}`)
  const keyInputs = findAll(tree, (t) => t.type === 'input' && t.props && t.props.type === 'password')
  assert.ok(keyInputs.length >= 1, 'no password input for the panel key')
  const panelKey = keyInputs[0]
  assert.equal(panelKey.props.value, '', 'the key field must start empty (never echo a stored key)')
  assert.ok(String(panelKey.props.placeholder || '').includes(S.keyConfigured), 'placeholder must show the masked status')
  const buttons = findAll(tree, (t) => t.type === 'button').map((t) => textOf(t))
  assert.ok(buttons.some((b) => b.includes(S.saveKey)), `missing save-key button; got ${buttons.join(' | ')}`)
  assert.ok(buttons.some((b) => b.includes('\u6e05\u9664')), 'missing clear button while a key is stored') // 清除
  assert.ok(text.includes(S.modePack), 'status line missing the data mode')
  assert.ok(text.includes(S.interval), 'interval row missing')
  assert.ok(text.includes(S.lowBalance), 'threshold row missing')
  cleanupAll()
})

await check('saving the panel key POSTs {apiKey} to /dsh-quota-pill/key (fake key only)', async () => {
  fetchCalls.length = 0
  const fake = 'fake-panel-key-ZZZZ9999'
  const tree = await settle(components['settings.section:quota-status'])
  const keyInput = findAll(tree, (t) => t.type === 'input' && t.props && t.props.type === 'password')[0]
  assert.ok(keyInput, 'panel key input missing')
  keyInput.props.onChange({ target: { value: fake } })
  const tree2 = await rerender(components['settings.section:quota-status'])
  const saveBtn = findAll(tree2, (t) => t.type === 'button' && textOf(t).includes(S.saveKey))[0]
  assert.ok(saveBtn, 'save-key button not found')
  await saveBtn.props.onClick()
  const post = fetchCalls.find((c) => c.opts && c.opts.method === 'POST' && c.url.includes('/key'))
  assert.ok(post, `no key POST issued; calls: ${fetchCalls.map((c) => c.url).join(', ')}`)
  assert.ok(post.url.endsWith('/dsh-quota-pill/key'), `wrong endpoint: ${post.url}`)
  const body = JSON.parse(post.opts.body)
  assert.equal(body.apiKey, fake, 'the typed key must reach the host route')
  const tree3 = await rerender(components['settings.section:quota-status'])
  const json = JSON.stringify(tree3, (k, v) => (k === 'children' ? undefined : v))
  assert.ok(!json.includes(fake), 'the typed key leaked into the render tree after save')
  cleanupAll()
})

await check('switching to the 网关 tab mounts the gateway panel (loaded state)', async () => {
  fiberCache = new Map()
  allFibers.length = 0
  const comp = components['settings.section:quota-status']
  let tree = withFiber(newFiber(), () => expand({ type: comp, props: {} }))
  let tabs = findAll(tree, (t) => t.type === 'button' && t.props && t.props.role === 'tab')
  tabs[1].props.onClick() // switch to the gateway tab (fiber state persists)
  for (let pass = 0; pass < 4; pass += 1) {
    const pending = allFibers.flatMap((f) => f.effects.splice(0))
    if (pending.length === 0 && pass > 0) break
    for (const effect of pending) {
      const cleanup = effect()
      if (cleanup && typeof cleanup.then === 'function') await cleanup
      if (typeof cleanup === 'function') globalThis.__cleanups = (globalThis.__cleanups || []).concat(cleanup)
    }
    await new Promise((r) => setTimeout(r, 40))
    tree = withFiber(newFiber(), () => expand({ type: comp, props: {} }))
    tabs = findAll(tree, (t) => t.type === 'button' && t.props && t.props.role === 'tab')
  }
  const text = textOf(tree)
  assert.equal(tabs[1].props['aria-selected'], true, 'gateway tab must be selected after the switch')
  assert.ok(text.includes(S.running), `live status line missing: ${text.slice(0, 400)}`)
  assert.ok(text.includes('127.0.0.1:18434'), 'bound port missing from the status line')
  assert.ok(text.includes('auto-router'), 'virtual model missing')
  assert.ok(text.includes(S.zhipuLabel), 'chain entry missing')
  assert.ok(text.includes('http://127.0.0.1:18434/v1'), 'DSH base URL hint missing')
  const buttons = findAll(tree, (t) => t.type === 'button').map((t) => textOf(t))
  for (const label of [S.addUpstream, S.addPresets, S.save]) {
    assert.ok(buttons.some((b) => b.includes(label)), `missing button ${label}; got ${buttons.join(' | ')}`)
  }
  cleanupAll()
})

await check('gateway tab keeps secrets out of the rendered tree', async () => {
  fiberCache = new Map()
  allFibers.length = 0
  const comp = components['settings.section:quota-status']
  let tree = withFiber(newFiber(), () => expand({ type: comp, props: {} }))
  const tabs0 = findAll(tree, (t) => t.type === 'button' && t.props && t.props.role === 'tab')
  tabs0[1].props.onClick()
  for (let pass = 0; pass < 4; pass += 1) {
    const pending = allFibers.flatMap((f) => f.effects.splice(0))
    if (pending.length === 0 && pass > 0) break
    for (const effect of pending) {
      const cleanup = effect()
      if (cleanup && typeof cleanup.then === 'function') await cleanup
      if (typeof cleanup === 'function') globalThis.__cleanups = (globalThis.__cleanups || []).concat(cleanup)
    }
    await new Promise((r) => setTimeout(r, 40))
    tree = withFiber(newFiber(), () => expand({ type: comp, props: {} }))
  }
  const json = JSON.stringify(tree, (k, v) => (k === 'children' ? undefined : v))
  assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(json), 'something key-shaped leaked into the render tree')
  const inputs = findAll(tree, (t) => t.type === 'input' && t.props && t.props.type === 'password')
  assert.ok(inputs.length >= 1, 'the chain key password input is missing')
  const chainKey = inputs.find((t) => String(t.props.placeholder || '').includes('\u2022')) // ••••••（保持不变）
  assert.ok(chainKey, 'chain key field with the keep-unchanged placeholder missing')
  assert.equal(chainKey.props.value, '', 'the chain key field must start empty (never echo a stored key)')
  cleanupAll()
})

await check('gateway save posts the draft to /dsh-quota-pill/gateway', async () => {
  fetchCalls.length = 0
  fiberCache = new Map()
  allFibers.length = 0
  const comp = components['settings.section:quota-status']
  let tree = withFiber(newFiber(), () => expand({ type: comp, props: {} }))
  const tabs0 = findAll(tree, (t) => t.type === 'button' && t.props && t.props.role === 'tab')
  tabs0[1].props.onClick()
  for (let pass = 0; pass < 4; pass += 1) {
    const pending = allFibers.flatMap((f) => f.effects.splice(0))
    if (pending.length === 0 && pass > 0) break
    for (const effect of pending) {
      const cleanup = effect()
      if (cleanup && typeof cleanup.then === 'function') await cleanup
      if (typeof cleanup === 'function') globalThis.__cleanups = (globalThis.__cleanups || []).concat(cleanup)
    }
    await new Promise((r) => setTimeout(r, 40))
    tree = withFiber(newFiber(), () => expand({ type: comp, props: {} }))
  }
  const saveBtn = findAll(tree, (t) => t.type === 'button' && textOf(t).includes(S.save))[0]
  assert.ok(saveBtn, 'save button not found')
  await saveBtn.props.onClick()
  const post = fetchCalls.find((c) => c.opts && c.opts.method === 'POST' && c.url.includes('/gateway'))
  assert.ok(post, `no POST issued; calls: ${fetchCalls.map((c) => c.url).join(', ')}`)
  assert.ok(post.url.endsWith('/dsh-quota-pill/gateway'), `wrong endpoint: ${post.url}`)
  const body = JSON.parse(post.opts.body)
  assert.equal(body.enabled, true)
  assert.equal(body.port, 18434)
  assert.equal(body.chain.length, 1)
  assert.equal(body.chain[0].apiKey, '', 'the draft must not invent a key')
  cleanupAll()
})

async function rerender(component) {
  const tree = withFiber(newFiber(), () => expand({ type: component, props: {} }))
  return tree
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nOK: client bundle renders (pill + merged section with monitor/gateway tabs)')
process.exit(0)
