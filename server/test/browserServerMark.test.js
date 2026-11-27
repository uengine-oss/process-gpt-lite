// This server's own browser (lib/browserServer.js — Playwright's Chromium) marks its requests to this Lite server's own addresses
// as an agent browser's (X-PGL-Agent-Browser: server — lib/agentBrowserGuard.js then serves them only what needs no session): the
// page, its fetches and pictures, by the public address and by another loopback name of it; the cookies the page has still go with
// them. Other sites get no mark.
//   cd server && node --test test/browserServerMark.test.js   (Playwright's Chromium — the same one browserDriver.test.js uses)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const seen = { lite: [], other: [] }
const page = (body) => `<!doctype html><meta charset="utf-8"><title>t</title><body>${body}</body>`
function site(name) {
  return http.createServer((req, res) => {
    seen[name].push({ url: req.url, mark: req.headers['x-pgl-agent-browser'] || '', cookie: req.headers.cookie || '' })
    if (req.url.startsWith('/page')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'lite_c=1; Path=/' })
      return res.end(page(`<img src="/pic.png"><script>fetch('/api/x').then(() => document.title = 'done')</script>`))
    }
    if (req.url.startsWith('/visit')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(page(`<script>fetch(${JSON.stringify(process.env.LITE_FOR_TEST + '/api/from-other')}, { mode: 'no-cors' }).finally(() => document.title = 'done')</script>`))
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
const lite = site('lite'), other = site('other')
const litePort = await listen(lite), otherPort = await listen(other)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-server-mark-'))
// (before the modules read their config: this test's own "Lite" is the public address)
Object.assign(process.env, { PRO_PUBLIC_URL: `http://127.0.0.1:${litePort}`, PRO_BROWSER_PROFILES: tmp, PRO_TENANT_FROM_HEADER: '', PRO_TENANT_HOSTS: '', LITE_FOR_TEST: `http://localhost:${litePort}` })
const { ServerDriver } = await import('../lib/browserServer.js')
let d
const waitTitle = async (want, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await d.title() === want) return true; await new Promise((r) => setTimeout(r, 100)) } return false }

before(async () => { d = await ServerDriver.open(`mark-test-${process.pid}`, {}) })
after(async () => { await d?.close().catch(() => {}); lite.close(); other.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

test('서버 브라우저: 이 Lite 서버로 가는 요청(페이지 · fetch · 그림, 다른 loopback 이름으로도)에는 표시 — 쿠키는 그대로, 다른 사이트에는 표시 없음', async () => {
  await d.navigate(`http://127.0.0.1:${litePort}/page`)
  assert.ok(await waitTitle('done'), 'the page fetched')
  const mine = (u) => seen.lite.filter((x) => x.url.startsWith(u))
  assert.equal(mine('/page')[0]?.mark, 'server')
  assert.equal(mine('/api/x')[0]?.mark, 'server')
  assert.match(mine('/api/x')[0]?.cookie, /lite_c=1/, 'the page\'s cookie still goes')
  assert.equal(mine('/pic.png')[0]?.mark, 'server')
  // another site: no mark on its own requests — and its request to this Lite (by another loopback name) is marked
  await d.navigate(`http://127.0.0.1:${otherPort}/visit`)
  assert.ok(await waitTitle('done'))
  assert.ok(seen.other.length > 0)
  assert.ok(seen.other.every((x) => x.mark === ''), JSON.stringify(seen.other))
  assert.equal(mine('/api/from-other')[0]?.mark, 'server')
})
