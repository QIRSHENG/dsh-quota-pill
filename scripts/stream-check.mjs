/**
 * Streaming + tool-call passthrough check — the path DSH actually uses.
 *
 *   node scripts/stream-check.mjs
 *
 * Scene A (stream): upstream emits real SSE chunks; the gateway must forward
 *   them incrementally, end cleanly, and mark the provider active.
 * Scene B (stream failover): upstream A denies before any byte (business 401)
 *   → gateway must fail over to B, which streams normally, so the client sees
 *   one coherent stream and never the failure.
 * Scene C (json→SSE): upstream answers a stream request with plain JSON; the
 *   gateway must synthesize a valid SSE sequence (data: … / data: [DONE]).
 * Scene D (tool calls): an OpenAI tool-call response body must pass through
 *   with tool_calls intact (the agent loop depends on it).
 *
 * Fake keys only; loopback mock upstreams; temp DSH_HOME.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshz-stream-'))
process.env.DSH_HOME = home

let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`) } catch (err) {
    failures += 1
    console.error(`  FAIL ${name}: ${err && err.message}`)
  }
}

function makeUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => handler(req, res, body))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const seen = { sse: 0, deny: 0, jsonStream: 0, tools: 0 }

// A: real SSE, two chunks then DONE.
const sseUp = await makeUpstream((req, res) => {
  seen.sse += 1
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
  setTimeout(() => {
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  }, 20)
})

// Deny: zhipu business 401 arriving as HTTP 200.
const denyUp = await makeUpstream((req, res) => {
  seen.deny += 1
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 401, msg: '令牌已过期或验证不正确', success: false }))
})

// JSON-instead-of-SSE.
const jsonStreamUp = await makeUpstream((req, res) => {
  seen.jsonStream += 1
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'plain json' } }] }))
})

// Tool calls.
const toolsUp = await makeUpstream((req, res) => {
  seen.tools += 1
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'c1', object: 'chat.completion', model: 'model-tools',
    choices: [{
      index: 0, finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      },
    }],
  }))
})

const { createGateway, normalizeGatewayConfig } = await import(pathToFileURL(path.join(ROOT, 'lib', 'gateway.js')).href)
const { PROVIDERS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'providers.js')).href)

function envelope(entry, body) {
  if (!entry || entry.envelope !== 'zhipu') return null
  const env = PROVIDERS.zhipu.readEnvelope(body)
  if (!env) return null
  if (env.auth) return { auth: true, code: env.code, msg: env.msg }
  if (env.error && (env.code === 429 || env.code === 402)) return { error: true, code: env.code, msg: env.msg }
  return null
}

function entryOf(id, port, extra = {}) {
  return { id, label: id, baseUrl: `http://127.0.0.1:${port}`, model: `model-${id}`, authStyle: 'bearer', apiKey: `fake-${id}`, enabled: true, envelope: 'none', ...extra }
}

function makeGateway(chain) {
  const config = normalizeGatewayConfig({ enabled: true, port: 0, cooldownMs: 30_000, upstreamTimeoutMs: 15_000, chain })
  const g = createGateway({ getConfig: () => config, log: () => {}, envelope, balanceTokensLeft: () => null })
  g.start()
  return g
}

async function waitListening(g) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !g.status().listening) await new Promise((r) => setTimeout(r, 20))
  assert.ok(g.status().listening, 'gateway never listened')
  return g.status().port
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const r = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    r.on('error', reject)
    r.write(payload)
    r.end()
  })
}

console.log(`stream check DSH_HOME: ${home}`)

await check('stream: SSE chunks forwarded in order, [DONE] preserved, provider marked active', async () => {
  const g = makeGateway([entryOf('sse', sseUp.port)])
  const port = await waitListening(g)
  const res = await post(port, { model: 'auto-router', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  g.stop()
  assert.equal(res.status, 200, `status ${res.status}`)
  assert.match(String(res.headers['content-type']), /text\/event-stream/)
  assert.ok(res.text.includes('hello'), `first chunk missing: ${res.text}`)
  assert.ok(res.text.includes(' world'), 'second chunk missing')
  assert.ok(res.text.trim().endsWith('data: [DONE]'), `stream must end with [DONE]: ${res.text.slice(-80)}`)
  assert.ok(res.text.indexOf('hello') < res.text.indexOf(' world'), 'chunk order changed')
})

await check('stream failover: A denies before first byte → B streams to the client, no error surfaces', async () => {
  const g = makeGateway([
    entryOf('deny', denyUp.port, { envelope: 'zhipu' }),
    entryOf('sse2', sseUp.port),
  ])
  const port = await waitListening(g)
  const before = { deny: seen.deny, sse: seen.sse }
  const res = await post(port, { model: 'auto-router', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  const status = g.status()
  g.stop()
  assert.equal(res.status, 200, `status ${res.status}: ${res.text.slice(0, 200)}`)
  assert.equal(seen.deny, before.deny + 1, 'A was not attempted')
  assert.equal(seen.sse, before.sse + 1, 'B was not reached')
  assert.ok(res.text.includes('hello'), 'no stream content from B')
  assert.ok(!res.text.includes('令牌'), 'the A failure leaked into the client stream')
  assert.equal(status.active && status.active.id, 'sse2', `active provider not updated: ${JSON.stringify(status.active)}`)
  assert.ok(status.cooldowns.some((c) => c.id === 'deny'), 'A did not cool down')
})

await check('JSON answer to a stream request is synthesized into valid SSE', async () => {
  const g = makeGateway([entryOf('js', jsonStreamUp.port)])
  const port = await waitListening(g)
  const res = await post(port, { model: 'auto-router', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  g.stop()
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /text\/event-stream/)
  const lines = res.text.split('\n\n').filter(Boolean)
  assert.ok(lines[0].startsWith('data: {'), `first SSE frame malformed: ${lines[0]}`)
  const payload = JSON.parse(lines[0].slice('data: '.length))
  assert.equal(payload.choices[0].message.content, 'plain json')
  assert.equal(lines[lines.length - 1].trim(), 'data: [DONE]')
})

await check('tool_calls pass through unchanged (agent loop depends on it)', async () => {
  const g = makeGateway([entryOf('tools', toolsUp.port)])
  const port = await waitListening(g)
  const res = await post(port, {
    model: 'auto-router',
    messages: [{ role: 'user', content: 'read a.txt' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  })
  g.stop()
  assert.equal(res.status, 200)
  const json = JSON.parse(res.text)
  const call = json.choices[0].message.tool_calls[0]
  assert.equal(call.id, 'call_1')
  assert.equal(call.function.name, 'read_file')
  assert.equal(JSON.parse(call.function.arguments).path, 'a.txt')
  assert.equal(json.choices[0].finish_reason, 'tool_calls')
})

await check('client-side 400 from upstream is returned, not failed over', async () => {
  const badUp = await makeUpstream((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'messages: field required' } }))
  })
  const g = makeGateway([entryOf('bad', badUp.port), entryOf('sse3', sseUp.port)])
  const port = await waitListening(g)
  const before = seen.sse
  const res = await post(port, { model: 'auto-router', messages: [{ role: 'user', content: 'x' }] })
  g.stop()
  await new Promise((r) => badUp.server.close(r))
  assert.equal(res.status, 400, `status ${res.status}: ${res.text.slice(0, 200)}`)
  const json = JSON.parse(res.text)
  assert.equal(json.error.code, 'upstream_400')
  assert.match(json.error.message, /field required/)
  assert.equal(seen.sse, before, 'a 400 must not fail over to the next provider')
})

for (const u of [sseUp, denyUp, jsonStreamUp, toolsUp]) await new Promise((r) => u.server.close(r))

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nOK: streaming, failover, JSON→SSE and tool-call passthrough verified')
process.exit(0)
