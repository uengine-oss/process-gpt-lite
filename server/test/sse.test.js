// A chat answer's stream (POST /api/threads/:id/messages) sends its headers and a comment at once and
// one every interval after: behind Cloudflare a response that sends nothing for 100 s ends in 524,
// and an agent's first word can take longer than that (lib/sse.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openStream } from '../lib/sse.js'

// a server whose answer comes after `late` ms, as a slow agent's would; always closed after `fn`
async function withServer({ late, every, onRes }, fn) {
  const timers = []
  const srv = http.createServer((req, res) => {
    onRes?.(res)
    const { send, end } = openStream(res, { every })
    if (late != null) timers.push(setTimeout(() => { send('delta', { d: '답' }); send('done', { ok: true }); end() }, late))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/`)
  } finally {
    timers.forEach(clearTimeout)
    srv.closeAllConnections()
    srv.close()
  }
}
// (without the first comment nothing arrives until the answer: fail rather than wait)
const post = (url, signal) => fetch(url, { method: 'POST', signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]) })

test('헤더와 첫 바이트는 답을 기다리지 않고 바로 간다', () => withServer({ late: 1500, every: 10_000 }, async (url) => {
  const t0 = Date.now()
  const r = await post(url)
  const first = new TextDecoder().decode((await r.body.getReader().read()).value)
  const waited = Date.now() - t0
  assert.equal(r.headers.get('content-type'), 'text/event-stream')
  assert.equal(first, ': ok\n\n')
  assert.ok(waited < 1000, `첫 바이트까지 ${waited}ms (답은 1500ms 뒤)`)
}))

test('답이 오기 전까지 주기마다 주석이 가고, 화면 파서는 진짜 이벤트만 본다', () => withServer({ late: 1300, every: 300 }, async (url) => {
  const text = await (await post(url)).text()
  assert.ok((text.match(/^: ping$/gm) || []).length >= 3, text)
  // the same parsing as src/api.js stream()
  const events = text.split('\n\n').map((c) => [/^event: (.*)$/m.exec(c)?.[1], /^data: (.*)$/m.exec(c)?.[1]]).filter(([e, d]) => e && d)
  assert.deepEqual(events.map(([e, d]) => [e, JSON.parse(d)]), [['delta', { d: '답' }], ['done', { ok: true }]])
}))

test('보는 사람이 끊으면 주석을 멈춘다', async () => {
  let pings = 0, closed = null
  const onRes = (res) => {
    const w = res.write.bind(res)
    res.write = (chunk, ...rest) => { if (String(chunk).startsWith(': ping')) pings++; return w(chunk, ...rest) }
    res.on('close', () => { closed = pings })
  }
  await withServer({ every: 40, onRes }, async (url) => {
    const ac = new AbortController()
    const r = await post(url, ac.signal)
    await r.body.getReader().read()
    await new Promise((done) => setTimeout(done, 200))
    ac.abort()
    await new Promise((done) => setTimeout(done, 300))
    assert.ok(closed > 0, `끊기 전 주석 ${closed}`)
    assert.equal(pings, closed, '끊긴 뒤에도 주석을 썼다')
  })
})
