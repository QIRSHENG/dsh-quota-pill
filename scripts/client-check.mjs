/**
 * Client bundle check — the client is a hand-wrapped IIFE bundle with no build
 * step, so this loads it the way DSH does (window.__ModuleLoader__), gives it a
 * minimal fake react, and renders every registered component.
 *
 *   node scripts/client-check.mjs
 *
 * Covers: module evaluates, slot registrations (2 settings.section + 2 icons +
 * 1 dock pill), the pill renders with a snapshot, the zhipu section renders,
 * and the gateway section renders its loaded state (with a mocked host
 * response) including chain editing callbacks.
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

// UI strings under test (escaped to survive any encoding round-trip).
const S = {
  modePack: '\u8d44\u6e90\u5305\u4f59\u91cf',            // 资源包余量
  interval: '\u8f6e\u8be2\u95f4\u9694',                    // 轮询间隔
  lowBalance: '\u4f4e\u4f59\u989d',                        // 低余额
  running: '\u8fd0\u884c\u4e2d',                           // 运行中
  zhipuLabel: '\u667a\u8c31 GLM',                          // 智谱 GLM
  addUpstream: '\u6dfb\u52a0\u4e0a\u6e38',                 // 添加上游
  addPresets: '\u4e00\u952e\u52a0\u5168\u90e8\u9884\u8bbe', // 一键加全部预设
  save: '\u4fdd\u5b58\u5e76\u5e94\u7528',                  // 保存并应用
}

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

// Mock host: snapshot for the pill + gateway settings for the new section.
const SNAPSHOT = {
  ok: true, version: '0.1.0', state: 'ok', mode: 'resource-pack', provider: 'zhipu',
  packs: [{ name: 'GLM-5 pack', remaining: 800, magnitude: 10000, status: 'EFFECTIVE', model: null, expiresAt: 1799999999000 }],
  subscription: null, fetchedAt: Date.now() - 60000, cached: false, throttled: false, intervalMinutes: 2,
}
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
  const body = url.includes('/gateway') ? GATEWAY : SNAPSHOT
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

await check('bundle evaluates and exports apply + inject', () => {
  assert.ok(loaded, 'module loader was never called')
  assert.equal(loaded.id, 'dsh-zhipu-status')
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

await check('registers the pill + two settings sections + two icons', () => {
  const byName = (n) => registrations.filter((r) => r.meta.name === n)
  const sections = byName('settings.section').map((r) => r.meta.id).sort()
  assert.deepEqual(sections, ['zhipu-gateway', 'zhipu-status'], `sections: ${sections}`)
  const icons = byName('settings.section.icon').map((r) => r.meta.id).sort()
  assert.deepEqual(icons, ['zhipu-gateway', 'zhipu-status'], `icons: ${icons}`)
  for (const id of sections) assert.ok(icons.includes(id), `no icon registered for section ${id}`)
  const dock = byName('conversation.composer.dock')
  assert.equal(dock.length, 1)
  assert.equal(dock[0].meta.id, 'zhipu-quota')
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

/** Render, run collected effects (awaiting async ones), re-render, repeat. */
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

await check('dock pill renders the balance + expiry from a live snapshot', async () => {
  const tree = await settle(components['conversation.composer.dock:zhipu-quota'])
  const text = textOf(tree)
  assert.ok(/8(\.0)?M/.test(text), `pill text missing the balance: ${text}`)
  assert.ok(/\d{2}-\d{2}/.test(text), `pill text missing the expiry: ${text}`)
  cleanupAll()
})

await check('zhipu settings section renders its status line and controls', async () => {
  const tree = await settle(components['settings.section:zhipu-status'])
  const text = textOf(tree)
  assert.ok(text.includes(S.modePack), `mode line missing: ${text.slice(0, 300)}`)
  assert.ok(text.includes(S.interval), 'interval row missing')
  assert.ok(text.includes(S.lowBalance), 'threshold row missing')
  cleanupAll()
})

await check('gateway section renders the loaded state (chain, endpoint hint, buttons)', async () => {
  const tree = await settle(components['settings.section:zhipu-gateway'])
  const text = textOf(tree)
  assert.ok(text.includes(S.running), `live status line missing: ${text.slice(0, 400)}`)
  assert.ok(text.includes('127.0.0.1:18434'), 'bound port missing from the status line')
  assert.ok(text.includes('auto-router'), 'virtual model missing')
  assert.ok(text.includes('ZHIPU-GLM'), 'chain entry missing')
  assert.ok(text.includes('http://127.0.0.1:18434/v1'), 'DSH base URL hint missing')
  const buttons = findAll(tree, (t) => t.type === 'button').map((t) => textOf(t))
  for (const label of [S.addUpstream, S.addPresets, S.save]) {
    assert.ok(buttons.some((b) => b.includes(label)), `missing button ${label}; got ${buttons.join(' | ')}`)
  }
  cleanupAll()
})

await check('gateway section keeps secrets out of the rendered tree', async () => {
  const tree = await settle(components['settings.section:zhipu-gateway'])
  const json = JSON.stringify(tree, (k, v) => (k === 'children' ? undefined : v))
  assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(json), 'something key-shaped leaked into the render tree')
  const inputs = findAll(tree, (t) => t.type === 'input' && t.props && t.props.type === 'password')
  assert.ok(inputs.length >= 1, 'no password input for the upstream key')
  assert.equal(inputs[0].props.value, '', 'the key field must start empty (never echo a stored key)')
  cleanupAll()
})

await check('saving posts the draft to the host gateway route', async () => {
  fetchCalls.length = 0
  const tree = await settle(components['settings.section:zhipu-gateway'])
  const saveBtn = findAll(tree, (t) => t.type === 'button' && textOf(t).includes(S.save))[0]
  assert.ok(saveBtn, 'save button not found')
  await saveBtn.props.onClick()
  const post = fetchCalls.find((c) => c.opts && c.opts.method === 'POST')
  assert.ok(post, `no POST issued; calls: ${fetchCalls.map((c) => c.url).join(', ')}`)
  assert.ok(post.url.endsWith('/dsh-zhipu-status/gateway'), `wrong endpoint: ${post.url}`)
  const body = JSON.parse(post.opts.body)
  assert.equal(body.enabled, true)
  assert.equal(body.port, 18434)
  assert.equal(body.chain.length, 1)
  assert.equal(body.chain[0].apiKey, '', 'the draft must not invent a key')
  cleanupAll()
})

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nOK: client bundle renders (pill + both settings sections)')
process.exit(0)
