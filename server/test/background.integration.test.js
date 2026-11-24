// 오늘의 배경 사진 — 실제 DB(sql/054 를 먼저)와 이 시험이 127.0.0.1 에 띄우는 가짜 사진 사이트(Commons · Unsplash). 공용 인터넷에는 나가지 않는다.
//   - 사이트의 답은 회사 + 날짜마다 한 번: 같은 회사의 같은 날은 다시 묻지 않고, 다른 회사 · 다른 날은 묻는다.
//   - 회사 스위치(pro_background_settings): 끄면 어떤 사이트에도 묻지 않고 후보도 없다(라우트), 저장도 막는다. 다시 켜면 그대로.
//   - 한 사람의 선택(pro_profile.background): 저장 → 읽기, 「오늘만」은 다음 날 하늘, 「계속」은 남는다, 하늘로, 다른 호스트의 사진은 400.
//   - 회사의 Unsplash 키(보관함, 버리는 키링): 후보의 일부를 Unsplash 에서, 키는 Authorization 으로만 가고 화면에 돌려주지 않는다,
//     Unsplash 사진을 고르면 그 사진의 download 주소를 부른다.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/background', n), 'utf8'))

// a throwaway vault keyring (the server's KEK is never touched) and a tenant of this run
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-bg-test-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK
const TENANT = `rt-bg-${crypto.randomUUID().slice(0, 8)}`
const OTHER = `${TENANT}-b`
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_TENANT_FROM_HEADER = '0'

// the fake sites: Commons answers every search with the recorded ten snow photos (shifted per question), the POTD of 11-24;
// Unsplash answers its recorded search and counts download pings
const hits = { commons: [], unsplash: [], download: [] }
const snow = fixture('commons-search-snow.json')
const potd = fixture('commons-potd-2026-11-24.json')
const unsplash = fixture('unsplash-search.json')
let site, base
before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (u.pathname === '/w/api.php') {
      hits.commons.push(u.search)
      if (u.searchParams.get('generator') === 'images') return json(u.searchParams.get('titles') === 'Template:Potd/2026-11-24' ? potd : { batchcomplete: true })
      const q = u.searchParams.get('gsrsearch') + (u.searchParams.get('gsroffset') || '')
      const k = [...q].reduce((a, c) => a + c.charCodeAt(0), 0) % snow.query.pages.length
      return json({ query: { pages: snow.query.pages.map((p, i) => ({ ...p, index: ((i + k) % snow.query.pages.length) + 1 })) } })
    }
    if (u.pathname === '/unsplash/search/photos') { hits.unsplash.push(req.headers.authorization); return json(unsplash) }
    if (/^\/unsplash\/photos\/[\w-]+\/download$/.test(u.pathname)) { hits.download.push([u.pathname, req.headers.authorization]); return json({ url: 'x' }) }
    res.writeHead(404); res.end()
  })
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${site.address().port}`
  process.env.PRO_BG_COMMONS_API = `${base}/w/api.php`
  process.env.PRO_BG_UNSPLASH_API = `${base}/unsplash`
  // (the server's modules read these addresses when first imported: only now)
  await load()
})

let q, pool, svc, prefs, routes, app, appUrl, server
const users = []
async function load() {
  ;({ q, pool } = await import('../lib/supa.js'))
  svc = await import('../lib/background/service.js')
  prefs = await import('../lib/background/prefs.js')
  routes = await import('../routes/background.js')
  const express = (await import('express')).default
  app = express()
  app.use(express.json())
  // the signed-in person: the X-User header of the request (a made-up account of this run)
  const auth = (req, res, next) => { req.user = { id: req.headers['x-user'], email: `${req.headers['x-user']}@example.com` }; next() }
  app.use('/api', routes.backgroundRoutes(auth))
  server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  appUrl = `http://127.0.0.1:${server.address().port}/api`
}
after(async () => {
  for (const u of users) for (const t of ['pro_profile']) await q(`delete from ${t} where user_id=$1`, [u]).catch(() => {})
  await q('delete from pro_background_settings where tenant_id = any($1)', [[TENANT, OTHER]]).catch(() => {})
  const { companySubject } = await import('../lib/googleClient.js')
  for (const t of [TENANT, OTHER]) for (const tb of ['pro_vault_items', 'pro_vault_keys', 'pro_vault_audit']) await q(`delete from ${tb} where user_id=$1`, [companySubject(t)]).catch(() => {})
  server?.close()
  site?.closeAllConnections?.(); site?.close()
  await pool?.end()
  fs.rmSync(dir, { recursive: true, force: true })
})
const person = () => { const id = crypto.randomUUID(); users.push(id); return id }
const call = async (user, p, { method = 'GET', body } = {}) => {
  const r = await fetch(`${appUrl}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-User': user }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json() }
}
const today = () => new Date().toISOString().slice(0, 10)
const plus = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

test('사이트의 답은 회사 + 날짜마다 한 번: 같은 회사 같은 날은 다시 묻지 않고, 다른 회사 · 다른 날은 묻는다', async () => {
  svc._reset()
  const ask = (tenant, date) => svc.candidatesFor({ tenant, date, hour: 8, wx: 45 }, { keys: () => ({}) })
  const a = await ask(TENANT, '2026-11-24')
  const n1 = hits.commons.length
  assert.ok(n1 > 0)
  assert.ok(a.photos.length >= 6 && a.photos.length <= 10, `${a.photos.length}장`)
  assert.ok(a.photos.every((p) => p.thumb.startsWith('https://thumb.wikimedia.org/')), '기록한 답의 그림은 Commons CDN 주소')
  const again = await ask(TENANT, '2026-11-24')
  assert.equal(hits.commons.length, n1, '같은 회사 같은 날: 사이트에 묻지 않음')
  assert.deepEqual(again.photos.map((p) => p.id), a.photos.map((p) => p.id))
  await ask(OTHER, '2026-11-24')
  const n2 = hits.commons.length
  assert.ok(n2 > n1, '다른 회사는 따로')
  await ask(TENANT, '2026-11-25')
  assert.ok(hits.commons.length > n2, '다른 날은 따로')
  assert.ok(hits.commons.every((s) => new URLSearchParams(s).get('iiurlwidth') === '1920'))
})

test('회사 스위치: 끄면 후보 없음(사이트에 묻지 않음) · 저장도 403, 다시 켜면 그대로 · 행이 없으면 켬', async () => {
  svc._reset()
  const me = person()
  assert.equal(await svc.enabledFor(TENANT), true, '행이 없으면 켬')
  await svc.setEnabled(TENANT, false, null)
  const [row] = await q('select enabled from pro_background_settings where tenant_id=$1', [TENANT])
  assert.equal(row.enabled, false)
  const before = hits.commons.length
  const r = await call(me, `/background/today?date=${today()}&hour=9&wx=3`)
  assert.equal(r.status, 200)
  assert.equal(r.body.enabled, false)
  assert.deepEqual(r.body.candidates, [])
  assert.ok(r.body.day.term.name, '날짜 · 절기는 그대로 알려 준다')
  assert.equal(hits.commons.length, before, '끈 회사는 사이트에 묻지 않는다')
  const photo = svc && (await svc.candidatesFor({ tenant: OTHER, date: today(), hour: 9 }, { keys: () => ({}) })).photos[0]
  const put = await call(me, '/background', { method: 'PUT', body: { photo, keep: 'today', date: today() } })
  assert.equal(put.status, 403)
  await svc.setEnabled(TENANT, true, null)
  const on = await call(me, `/background/today?date=${today()}&hour=9&wx=3`)
  assert.equal(on.body.enabled, true)
  assert.ok(on.body.candidates.length >= 6)
  assert.ok(on.body.candidates.every((c) => c.label && c.license && c.sourceUrl))
})

test('한 사람의 선택: 저장 → 읽기 · 「오늘만」은 다음 날 하늘 · 「계속」은 남는다 · 하늘로 · 다른 호스트의 사진은 400', async () => {
  svc._reset()
  await svc.setEnabled(TENANT, true, null)
  const me = person()
  const d = today()
  const list = (await call(me, `/background/today?date=${d}&hour=8&wx=45`)).body.candidates
  const pick = list[1]
  const saved = await call(me, '/background', { method: 'PUT', body: { photo: pick, keep: 'today', date: d } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.pref.keep, 'today')
  assert.equal(saved.body.pref.day, d)
  assert.equal(saved.body.pref.photo.id, pick.id)
  assert.equal(saved.body.pref.photo.label, pick.label)
  const [row] = await q('select background from pro_profile where user_id=$1', [me])
  assert.equal(row.background.photo.id, pick.id, 'pro_profile.background 에')
  const now = await call(me, `/background?date=${d}`)
  assert.equal(now.body.active.id, pick.id)
  const tomorrow = await call(me, `/background?date=${plus(d, 1)}`)
  assert.equal(tomorrow.body.active, null, '「오늘만」은 다음 날 하늘')
  assert.equal(tomorrow.body.pref.photo.id, pick.id, '고른 기록은 남아 있다')
  // the candidates' answer carries the saved choice too (the panel marks it)
  assert.equal((await call(me, `/background/today?date=${d}&hour=8&wx=45`)).body.pref.photo.id, pick.id)
  const keep = await call(me, '/background', { method: 'PUT', body: { photo: pick, keep: 'always', date: d } })
  assert.equal(keep.body.pref.keep, 'always')
  assert.equal((await call(me, `/background?date=${plus(d, 1)}`)).body.active.id, pick.id, '「계속」은 다음 날에도')
  const sky = await call(me, '/background', { method: 'DELETE' })
  assert.deepEqual(sky.body, { pref: null })
  assert.equal((await call(me, `/background?date=${d}`)).body.active, null)
  const bad = await call(me, '/background', { method: 'PUT', body: { photo: { ...pick, src: { 1920: 'https://evil.example.com/x.jpg' } }, keep: 'today', date: d } })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /배경으로 쓸 수 없어요/)
  const badKeep = await call(me, '/background', { method: 'PUT', body: { photo: pick, keep: 'forever', date: d } })
  assert.equal(badKeep.status, 400)
})

test('회사의 Unsplash 키: 보관함에 두고 「저장됨」만 보인다, 후보의 일부가 Unsplash(키는 Authorization 으로만), 고르면 download 주소를 부른다', async () => {
  svc._reset()
  await svc.setEnabled(TENANT, true, null)
  const key = `test-key-${crypto.randomUUID().slice(0, 6)}`
  const info = await svc.saveKey(TENANT, 'unsplash', key, null)
  assert.deepEqual(info, { unsplash: { saved: true }, pexels: { saved: false } })
  assert.ok(!JSON.stringify(info).includes(key))
  const [item] = await q('select secret::text as s from pro_vault_items where site=$1 and user_id=$2', ['unsplash.com', (await import('../lib/googleClient.js')).companySubject(TENANT)])
  assert.ok(item && !item.s.includes(key), '보관함에는 암호화되어')
  const me = person()
  const r = await call(me, `/background/today?date=${today()}&hour=8&wx=45`)
  const u = r.body.candidates.find((c) => c.provider === 'unsplash')
  assert.ok(u, 'Unsplash 사진이 섞인다')
  assert.ok(!JSON.stringify(r.body).includes(key), '키는 화면에 가지 않는다')
  assert.ok(hits.unsplash.length > 0 && hits.unsplash.every((h) => h === `Client-ID ${key}`))
  assert.equal(u.sourceName, 'Unsplash')
  assert.match(u.authorUrl, /utm_source=process_gpt_lite/)
  // the fake site stands for api.unsplash.com: its download address is the fake one
  const pick = { ...u, downloadLocation: `${process.env.PRO_BG_UNSPLASH_API}/photos/Fk2mHq9xT0a/download` }
  const put = await call(me, '/background', { method: 'PUT', body: { photo: pick, keep: 'today', date: today() } })
  assert.equal(put.status, 200)
  for (let i = 0; i < 20 && !hits.download.length; i++) await new Promise((ok) => setTimeout(ok, 50))
  assert.deepEqual(hits.download[0], ['/unsplash/photos/Fk2mHq9xT0a/download', `Client-ID ${key}`])
  // removing the key: Commons only again
  assert.deepEqual(await svc.saveKey(TENANT, 'unsplash', '', null), { unsplash: { saved: false }, pexels: { saved: false } })
  svc._reset()
  const after = await call(me, `/background/today?date=${today()}&hour=8&wx=45`)
  assert.ok(after.body.candidates.every((c) => c.provider === 'commons'))
})
