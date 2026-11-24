// 같은 브라우저 작업을 서버 브라우저와 사람 PC 의 브라우저(데스크톱 앱 0.2.3 — Electron)에서 하나씩 돌려 잰다(실제 사이트 · 실제 모델, 계정 없음).
// 서버 모듈을 그대로(lib/browser.js runBrowserTask), PC 쪽은 진짜 데스크톱 코드(desktop/test/helpers/browser-host.js)가 이 스크립트의 링크에 붙는다.
// 운영처럼 PRO_BROWSER_GATES=off · 판정은 모델(PRO_JUDGE_URL 없음). 작업마다 capSec 에서 끊고 cancel() — 끊긴 뒤 멈추기까지도 잰다.
//   cd server && node scripts/measure-browser-where.mjs [local|server|both] [out.json]
// 결과(JSON): 작업마다 어디서 · 결과 · 걸린 시간 · 턴 · 동작마다 평균(읽기 · 판정 · 사진 · 모델 · 동작) · 실시간 화면 장수 · 바이트 · 이벤트 없는 최장 시간.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const which = process.argv[2] || 'both'
const out = process.argv[3] || path.join(os.tmpdir(), `browser-where-${Date.now()}.json`)
process.env.PRO_BROWSER_GATES = 'off'
delete process.env.PRO_JUDGE_URL

const GOALS = [
  { key: 'stay', goal: '계룡대 인근 12월 18~20일 숙소를 검색해서 1박 가격이 싼 곳 3곳을 비교해 줘', startUrl: 'https://travel.naver.com', capSec: 300 },
  { key: 'news', goal: '연합뉴스 첫 화면의 주요 뉴스 제목 다섯 개를 알려 줘', startUrl: 'https://www.yna.co.kr', capSec: 180 },
]

const browser = await import('../lib/browser.js')
const bus = await import('../lib/bus.js')
const H = await import('../lib/localAgents/hub.js')
const D = await import('../lib/localAgents/devices.js')
const R = await import('../lib/browserRemote.js')
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const { startDesktopBrowser } = await import('../test/fixtures/desktopBrowser.mjs')

const user = crypto.randomUUID()
const [{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','browser where measure') returning id`, [user])
const hub = http.createServer()
H.attach(hub)
await new Promise((r) => hub.listen(0, '127.0.0.1', r))
const { token } = await D.issue({ id: user }, { name: '측정 맥', platform: process.platform, appVersion: '0.2.3' })
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-measure-pc-'))
let pc = null
const results = []

async function measure(where, g) {
  // (the PC's own setting, as its app sends it with its link: 'own' runs this person's task there, 'off' leaves it to this server)
  const link = H.linksOf(config.tenantId, user).find((l) => l.caps?.browser)
  if (link) await H.receive(link, { type: 'caps', prefs: { enabled: true, browser: where === 'local' ? 'own' : 'off' } })
  if ((await R.whereFor({ id: user })).own.where !== where) throw new Error(`the task would not run on ${where}`)
  const ev = { frames: 0, bytes: 0, statuses: [], cards: 0, last: Date.now(), longest: 0 }
  const tick = () => { const now = Date.now(); ev.longest = Math.max(ev.longest, now - ev.last); ev.last = now }
  const off = bus.subscribe(user, { writableLength: 0, write(l) {
    tick()
    if (l.startsWith('event: browser.frame')) { ev.frames++; ev.bytes += l.length }
    else if (l.startsWith('event: status')) { try { const t = JSON.parse(l.split('\ndata: ')[1]).text; if (t) ev.statuses.push(t) } catch { /* */ } }
    else if (l.startsWith('event: message')) ev.cards++
    return true
  } })
  const t0 = Date.now()
  let cut = null
  const p = browser.runBrowserTask({ userId: user, threadId, goal: g.goal, startUrl: g.startUrl })
  const timer = setTimeout(() => { cut = Date.now(); browser.cancel(user) }, g.capSec * 1000)
  const r = await p
  clearTimeout(timer)
  off()
  const row = { where, key: g.key, state: r.state, where_ran: r.where, ms: Date.now() - t0, cancel_to_stop_ms: cut ? Date.now() - cut : null, turns: r.stats.turns,
    llm: r.stats.llm, avg_ms: r.stats.avg_ms, stalls: r.stats.stalls, retries: r.stats.retries, step_timeouts: r.stats.step_timeouts, waits_refused: r.stats.waits_refused,
    frames: ev.frames, frame_mb: Math.round(ev.bytes / 1e4) / 100, fps: Math.round((ev.frames / ((Date.now() - t0) / 1000)) * 10) / 10, longest_quiet_ms: ev.longest,
    notes: r.notes.slice(0, 6), summary: String(r.summary || '').slice(0, 500), url: r.url, statuses: [...new Set(ev.statuses)].slice(0, 30) }
  results.push(row)
  console.log(JSON.stringify({ ...row, notes: row.notes.length, statuses: row.statuses.length }))
  fs.writeFileSync(out, JSON.stringify(results, null, 2))
}

try {
  if (which !== 'server') {
    pc = startDesktopBrowser({ server: `http://127.0.0.1:${hub.address().port}`, token, userData, device: '측정 맥', log: process.env.PGL_TEST_LOG === '1' })
    await pc.ready
    for (const g of GOALS) await measure('local', g)
  }
  if (which !== 'local') for (const g of GOALS) await measure('server', g)
} finally {
  await browser.close(user).catch(() => {})
  await pc?.stop()
  hub.close()
  await q('delete from pro_threads where user_id=$1', [user]).catch(() => {})
  await q('delete from pro_local_devices where user_id=$1', [user]).catch(() => {})
  await q('delete from pro_profile where user_id=$1', [user]).catch(() => {})
  await pool.end()
  fs.rmSync(path.join(browser.PROFILES, user), { recursive: true, force: true })
  console.log(`→ ${out}`)
}
