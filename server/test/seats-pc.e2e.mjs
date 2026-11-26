// 작업본은 한 곳에 P1 — a variation's working copy on its person's PC, over the real wire (spec openspec/specs/variation-seats): a real Lite
// BFF, a stand-in for the desktop app (0.2.6) that opens the real link (WebSocket /api/local-agents/link with its device token and caps.seats)
// and speaks the seat messages, and real `git` over the public path /api/local-git with the tokens the server sends. Fictional people:
// 한소유 (the folder's owner, whose variation it is) and 김동료 (an editor of the folder).
//   1. 「이 PC 에서 작업」: POST …/seat {to:'device'} → seat:prepare (a token of that variation, that PC, that epoch) → fetch → seat:ready →
//      held; an old app, a PC that is off, someone else's PC or variation: refused
//   2. a save point: commit → seat:token → push to the epoch's branch → seat:status counts on the web → seat:pushed → the variation moves
//      forward to it (only forward); 「지금 올리기」 and the switch from the web reach the PC
//   3. 「돌려놓기」 from the PC: seat:release → 보관 중 · ready, the epoch's branch gone → the server workroom opens it with the PC's content
//   4. the PC loses the seat while it is off (its person takes it on the web) → back on, its list no longer has it → its old token's push
//      is refused (403) → a one-push leftover token → seat:left → a variation of its own 「… — <PC>에 남아 있던 변경」 with the content
//   5. another person's link and another company's variation: nothing reaches across
//   node test/seats-pc.e2e.mjs   (BFF on 8972 — SEAT_PORT to change; tenant "seats-pc-e2e", folders in a temporary directory; no model)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const PORT = Number(process.env.SEAT_PORT) || 8972
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
if (!portFree(PORT)) { console.log(`not ok - port ${PORT} is in use (SEAT_PORT=<another> to change)`); process.exit(1) }
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-pc-e2e-')))
const TENANT = 'seats-pc-e2e'
const OTHER = 'seats-pc-e2e-other'
const RESULTS = process.env.SEAT_RESULTS || ''
Object.assign(process.env, { PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '', PRO_FOLDERS_ROOT: path.join(ROOT, 'folders') })
const { q, pool } = await import('../lib/supa.js')

let server
const serverLog = []
const links = []
const report = []
let n = 0
async function cleanup() {
  for (const l of links) try { l.ws.close() } catch { /* gone */ }
  if (server && server.exitCode == null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)) }
  for (const tn of [TENANT, OTHER]) {
    await q('delete from pro_variation_seat_log where tenant_id=$1', [tn]).catch(() => {})
    for (const t of ['pro_local_jobs', 'pro_local_devices', 'pro_folders', 'notifications', 'pro_team_members', 'users']) await q(`delete from ${t} where tenant_id=$1`, [tn]).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
}
async function save() { if (RESULTS) await fs.writeFile(RESULTS, JSON.stringify({ at: new Date().toISOString(), port: PORT, steps: report }, null, 2)) }
async function step(name, fn) {
  n++
  const t = Date.now()
  try {
    const said = await fn()
    console.log(`ok ${n} - ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)${said ? `\n  ${said}` : ''}`)
    report.push({ n, name, ok: true, said: said || '', seconds: (Date.now() - t) / 1000 })
  } catch (e) {
    console.log(`not ok ${n} - ${name}\n  ${e.stack || e.message}`)
    console.log('--- server log (last 60 lines)\n' + serverLog.join('').split('\n').slice(-60).join('\n'))
    report.push({ n, name, ok: false, error: e.message })
    await save()
    await cleanup(); process.exit(1)
  }
}
const waitFor = async (fn, ms = 20000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 150)) } }
const api = async (token, p, { method = 'GET', body, raw = null, type = 'application/json' } = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { 'Content-Type': type, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) })
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch { j = text }
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${text.slice(0, 300)}`), { status: r.status, body: j })
  return j
}
const fails = async (token, p, opts) => { try { await api(token, p, opts); return { status: 200 } } catch (e) { return { status: e.status || 0, body: e.body } } }

// real git, the token only in a request header (GIT_CONFIG_* — never on the command line)
const git = (cwd, args, token = null) => new Promise((resolve) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: ROOT }
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k]
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` })
  execFile('git', ['-c', 'user.name=한소유', '-c', 'user.email=seats-owner@example.test', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'core.symlinks=false', ...args],
    { cwd, env }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: String(stdout).trim(), err: String(stderr) }))
})
const urlOf = (t) => (t.url || `${BASE}${t.path}`)
const claimsOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString())
async function write(dir, files) {
  for (const [p, body] of Object.entries(files)) {
    const f = path.join(dir, ...p.split('/'))
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, body)
  }
}

// ---------- a stand-in for the desktop app's link (the app's main process speaks the same) ----------
function openLink(deviceToken, name, { seats = true } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/local-agents/link`)
    const L = { ws, got: [], closed: null,
      send: (m) => ws.send(JSON.stringify(m)),
      next(types, since = L.got.length, ms = 20000) { const want = [].concat(types); return waitFor(() => L.got.slice(since).find((m) => want.includes(m.type)), ms, `${want.join('|')} on ${name}`) },
      async ask(msg, types) { const at = L.got.length; L.send(msg); return L.next(types, at) },
      close: () => new Promise((r) => { if (L.closed != null) return r(); ws.once('close', () => r()); ws.close() }) }
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: deviceToken, device: { name, appVersion: '0.2.6-e2e' }, caps: { clis: {}, ...(seats ? { seats: true } : {}) }, prefs: { enabled: false }, active: [] })))
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }))
      L.got.push(m)
      if (m.type === 'welcome') resolve(L)
      if (m.type === 'denied') reject(new Error(m.reason))
    })
    ws.on('close', (code) => { L.closed = code })
    ws.on('error', reject)
    links.push(L)
  })
}

// ---------- the BFF ----------
await step(`SP-E-01 BFF 를 띄운다(${PORT}, PRO_BACKGROUND=0, 시험 회사, 모델 없음)`, async () => {
  server = spawn(process.execPath, ['index.js'], { cwd: SERVER, env: { ...process.env, PRO_PORT: String(PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off',
    PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: BASE, PRO_GIT_PUBLIC_URL: '',
    PRO_DEEPAGENTS_URL: 'http://127.0.0.1:9', PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_CONTEXT_ROUTER_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => serverLog.push(String(d)))
  server.stderr.on('data', (d) => serverLog.push(String(d)))
  await waitFor(async () => (await fetch(`${BASE}/api/config`).catch(() => null))?.ok, 60000, 'the BFF')
  return BASE
})

const signIn = async (email, name) => {
  const r = await api(null, '/auth/email/verify', { method: 'POST', body: { email, code: '000000' } })
  await api(r.session.access_token, '/profile', { method: 'POST', body: { name, birth: '1990-01-01', onboarded: true } })
  await api(r.session.access_token, '/me')
  return { id: r.user.id, token: r.session.access_token, name }
}
const OWN = await signIn('pro-rt-seats-pc-a@uengine.org', '한소유')
const KIM = await signIn('pro-rt-seats-pc-b@uengine.org', '김동료')
const NOTICE = '# 고객 세미나 안내\n\n일시: 11월 20일\n신청: 현장 접수\n'
let folder, v, dev, pc, prep, work, held, epoch1

await step('SP-E-02 「이 PC 에서 작업」: POST …/seat {to:device} → seat:prepare(그 변형 · 그 PC · 그 회차의 토큰) → 받기 → seat:ready → 쥠 · 옛 앱 · 꺼진 PC · 남의 PC · 남의 변형은 거절', async () => {
  folder = await api(OWN.token, '/folders', { method: 'POST', body: { name: '고객 세미나', description: '작업본 시험' } })
  await api(OWN.token, `/folders/${folder.slug}/files?path=${encodeURIComponent('안내문.md')}`, { method: 'POST', raw: Buffer.from(NOTICE), type: 'text/markdown' })
  await api(OWN.token, `/folders/${folder.slug}/members`, { method: 'POST', body: { type: 'user', id: KIM.id, role: 'editor' } })
  v = await api(OWN.token, `/folders/${folder.slug}/variations`, { method: 'POST', body: { title: '마감일 추가' } })
  dev = await api(OWN.token, '/local-agents/devices', { method: 'POST', body: { name: '한소유의 맥북', platform: 'darwin', appVersion: '0.2.6' } })
  // the PC is off: refused, and no seat
  const off = await fails(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: dev.device.id } })
  assert.deepEqual([off.status, off.body.why], [409, 'offline'], JSON.stringify(off))
  // an app before 0.2.6 (no caps.seats): told to update
  const old = await openLink(dev.token, '한소유의 맥북', { seats: false })
  const o = await fails(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: dev.device.id } })
  assert.deepEqual([o.status, o.body.why], [409, 'old_app'])
  assert.equal(old.got.some((m) => m.type === 'seat:list'), false, '옛 앱에는 목록을 보내지 않는다')
  await old.close()
  pc = await openLink(dev.token, '한소유의 맥북')
  const list = await pc.next('seat:list', 0)
  assert.deepEqual(list.seats, [])
  // the 「작업실」 sheet's one answer: my computers — this one on, keeping working copies (desktop 0.2.6)
  const choices = await api(OWN.token, `/folders/${folder.slug}/workroom`)
  assert.deepEqual(choices.devices.map((x) => [x.name, x.online, x.seats]), [['한소유의 맥북', true, true]])
  // (by name only: the desktop app names its own device from its pairing — no id of a computer in a view)
  assert.ok(choices.devices.every((x) => !('id' in x)))
  assert.deepEqual(choices.mine.map((x) => x.title), ['마감일 추가'])
  // someone else's PC id, someone else's variation
  const kimDev = await api(KIM.token, '/local-agents/devices', { method: 'POST', body: { name: '김동료의 PC', platform: 'win32', appVersion: '0.2.6' } })
  assert.equal((await fails(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: kimDev.device.id } })).status, 404)
  const kimTry = await fails(KIM.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: kimDev.device.id } })
  assert.equal(kimTry.status, 409, JSON.stringify(kimTry))
  const at = pc.got.length
  const r = await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: dev.device.id } })
  assert.equal(r.seat.place, 'device')
  assert.equal(r.seat.state, 'moving')
  prep = await pc.next('seat:prepare', at)
  assert.deepEqual([prep.variation, prep.folderId, prep.folderName, prep.title, prep.branch, prep.path], [v.id, folder.id, '고객 세미나', '마감일 추가', v.branch, `/api/local-git/${folder.id}.git`])
  const c = claimsOf(prep.token)
  assert.deepEqual([c.scope, c.device, c.seat, c.epoch, c.push], ['seat', dev.device.id, v.id, prep.epoch, `pgpt-agent/seat-${v.id.slice(0, 8)}-${prep.epoch}/`])
  assert.ok(Math.abs(c.exp - Date.now() / 1000 - 3600) < 60, '1시간')
  // the PC: its clone (a plain one here — the app's is a bare repository and a worktree) fetched with that token
  work = path.join(ROOT, 'pc', 'wt')
  await fs.mkdir(work, { recursive: true })
  await git(work, ['init', '-q', '-b', 'work'])
  const fe = await git(work, ['fetch', '-q', urlOf(prep), `+refs/heads/${prep.branch}:refs/remotes/lite/v`], prep.token)
  assert.equal(fe.code, 0, fe.err)
  await git(work, ['checkout', '-q', '-B', 'work', 'refs/remotes/lite/v'])
  assert.equal((await git(work, ['rev-parse', 'HEAD'])).out, prep.head)
  assert.equal(await fs.readFile(path.join(work, '안내문.md'), 'utf8'), NOTICE)
  // while moving, nothing can be pushed
  await write(work, { 'x.md': 'x' })
  await git(work, ['add', '-A']); await git(work, ['commit', '-qm', 'x'])
  const early = await git(work, ['push', urlOf(prep), `HEAD:refs/heads/${prep.push}head`], prep.token)
  assert.notEqual(early.code, 0)
  assert.match(early.err, /403|still being prepared/)
  await git(work, ['checkout', '-q', '-B', 'work', 'refs/remotes/lite/v'])
  held = await pc.ask({ type: 'seat:ready', variation: v.id, epoch: prep.epoch, head: prep.head }, ['seat:held', 'seat:refused'])
  assert.equal(held.type, 'seat:held', JSON.stringify(held))
  epoch1 = prep.epoch
  const seat = await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`)
  assert.deepEqual([seat.place, seat.state, seat.mine, seat.device.name, seat.device.online], ['device', 'held', true, '한소유의 맥북', true])
  const kimSees = await api(KIM.token, `/folders/${folder.slug}/variations/${v.id}/seat`)
  assert.deepEqual([kimSees.who.name, kimSees.mine, kimSees.can.recall], ['한소유', false, true])
  assert.equal(JSON.stringify(kimSees).includes(dev.device.id), false, '기기 id 가 없다')
  // asked again from this PC: already here, nothing moves
  const again = await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: dev.device.id } })
  assert.equal(again.already, true)
  return `epoch ${epoch1} · 꺼짐 409 · 옛 앱 409 · 남의 PC 404 · 남의 변형 409 · 넘기는 중 push 403`
})

let one
await step('SP-E-03 저장 지점: 커밋 → seat:token → 그 회차의 가지로 push → 수(seat:status)가 웹에 → seat:pushed → 변형이 앞으로 · 「지금 올리기」 · 스위치가 PC 로', async () => {
  const t = await pc.ask({ type: 'seat:token', variation: v.id, epoch: epoch1, for: 'push' }, ['seat:token', 'seat:refused'])
  assert.equal(t.type, 'seat:token', JSON.stringify(t))
  assert.equal(t.branch, `pgpt-agent/seat-${v.id.slice(0, 8)}-${epoch1}/head`)
  assert.equal(t.person.name, '한소유')
  await write(work, { '안내문.md': `${NOTICE}마감: 11월 30일\n`, '체크리스트.md': '- 장소 예약\n- 다과\n' })
  pc.send({ type: 'seat:status', variation: v.id, epoch: epoch1, dirty: 2, ahead: 0, branchOk: true })
  const dirty = await waitFor(async () => { const s = await api(KIM.token, `/folders/${folder.slug}/variations/${v.id}/seat`); return s.dirty === 2 && s }, 10000, 'dirty 2 on the web')
  assert.equal(dirty.pushedAt, null)
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-qm', '저장 지점'])
  one = (await git(work, ['rev-parse', 'HEAD'])).out
  const p = await git(work, ['push', '-q', urlOf(t), `HEAD:refs/heads/${t.branch}`], t.token)
  assert.equal(p.code, 0, p.err)
  // to main, or the variation itself: refused (only its epoch's branch)
  assert.match((await git(work, ['push', urlOf(t), 'HEAD:refs/heads/main'], t.token)).err, /remote rejected/)
  assert.match((await git(work, ['push', urlOf(t), `HEAD:refs/heads/${v.branch}`], t.token)).err, /remote rejected/)
  const taken = await pc.ask({ type: 'seat:pushed', variation: v.id, epoch: epoch1, head: one }, ['seat:taken', 'seat:refused'])
  assert.deepEqual([taken.type, taken.head], ['seat:taken', one])
  pc.send({ type: 'seat:status', variation: v.id, epoch: epoch1, dirty: 0, ahead: 0, branchOk: true })
  const s = await waitFor(async () => { const x = await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`); return x.dirty === 0 && x.pushedAt && x }, 10000, 'pushed on the web')
  assert.ok(Date.now() - new Date(s.pushedAt).getTime() < 60_000, '방금 올림')
  const detail = await api(KIM.token, `/folders/${folder.slug}/variations/${v.id}`)
  assert.equal(detail.head_commit, one)
  // the server's variation branch, as anyone reading the folder sees it (the token reads the folder)
  const ls = await git(ROOT, ['ls-remote', urlOf(t), `refs/heads/${v.branch}`], t.token)
  assert.equal(ls.out.split('\t')[0], one)
  // the web's 「지금 올리기」 and 「자동으로 올리기」 reach the PC
  let at = pc.got.length
  assert.deepEqual(await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat/save`, { method: 'POST' }), { ok: true, asked: true })
  assert.deepEqual(await pc.next('seat:save', at), { type: 'seat:save', variation: v.id })
  at = pc.got.length
  await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'PATCH', body: { autoSave: false } })
  assert.deepEqual(await pc.next('seat:prefs', at), { type: 'seat:prefs', variation: v.id, autoSave: false })
  // someone else asks for it back: the PC hears it (a notification there), the seat stays
  at = pc.got.length
  await api(KIM.token, `/folders/${folder.slug}/variations/${v.id}/seat/recall`, { method: 'POST', body: { why: '오늘 반영해요' } })
  const rc = await pc.next('seat:recall', at)
  assert.deepEqual([rc.auto, rc.by, rc.why], [false, '김동료', '오늘 반영해요'])
  assert.equal((await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`)).place, 'device')
  // and the web's own workroom cannot write meanwhile
  assert.equal((await fails(OWN.token, `/workroom/variation/${v.id}/file`, { method: 'PUT', body: { path: '안내문.md', content: '웹에서 덮어쓰기' } })).status, 409)
  return `변형 → ${one.slice(0, 8)} · 저장 안 한 변경 2 → 0 · 방금 올림`
})

await step('SP-E-04 「돌려놓기」(PC): 마지막 것을 넣고 seat:release → 보관 중 · 반영 대기 · 회차 가지 지움 → 서버 작업실이 PC 의 내용으로 연다', async () => {
  await write(work, { '안내문.md': `${NOTICE}마감: 11월 30일\n장소: 3층 세미나실\n` })
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-qm', '돌려놓기'])
  const last = (await git(work, ['rev-parse', 'HEAD'])).out
  const t = await pc.ask({ type: 'seat:token', variation: v.id, epoch: epoch1, for: 'push' }, ['seat:token'])
  assert.equal((await git(work, ['push', '-q', urlOf(t), `HEAD:refs/heads/${t.branch}`], t.token)).code, 0)
  const rel = await pc.ask({ type: 'seat:release', variation: v.id, epoch: epoch1, head: last }, ['seat:released', 'seat:refused'])
  assert.deepEqual([rel.type, rel.head], ['seat:released', last])
  const seat = await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`)
  assert.equal(seat.place, null, '보관 중')
  const d = await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}`)
  assert.deepEqual([d.status, d.head_commit], ['ready', last])
  // the old token stops (another place may have it now), the epoch's branch is gone
  assert.match((await git(ROOT, ['ls-remote', urlOf(t)], t.token)).err, /403/)
  // the server workroom takes it, with what the PC had
  const open = await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'POST', body: { to: 'server' } })
  assert.equal(open.seat.place, 'server')
  const f = await api(OWN.token, `/workroom/variation/${v.id}/file?path=${encodeURIComponent('안내문.md')}`)
  assert.match(f.content, /장소: 3층 세미나실/)
  const tree = await api(OWN.token, `/workroom/variation/${v.id}`)
  assert.ok(tree.files.some((x) => (x.path || x.name) === '체크리스트.md'), JSON.stringify(tree.files).slice(0, 300))
  await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat/release`, { method: 'POST', body: { epoch: open.seat.epoch } })
  return `보관 중 → 서버 작업실 → 안내문.md 에 「장소: 3층 세미나실」`
})

await step('SP-E-05 자리를 잃은 PC: 꺼진 사이 웹에서 가져옴 → 다시 켜지면 목록에 없음 → 옛 토큰의 push 403 → 한 번짜리 토큰으로 「… — 한소유의 맥북에 남아 있던 변경」', async () => {
  let at = pc.got.length
  await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: dev.device.id } })
  const p2 = await pc.next('seat:prepare', at)
  assert.ok(p2.epoch > epoch1)
  await git(work, ['fetch', '-q', urlOf(p2), `+refs/heads/${p2.branch}:refs/remotes/lite/v`], p2.token)
  await git(work, ['checkout', '-q', '-B', 'work', 'refs/remotes/lite/v'])
  assert.equal((await pc.ask({ type: 'seat:ready', variation: v.id, epoch: p2.epoch, head: p2.head }, ['seat:held', 'seat:refused'])).type, 'seat:held')
  const t = await pc.ask({ type: 'seat:token', variation: v.id, epoch: p2.epoch, for: 'push' }, ['seat:token'])
  // the PC goes off with work it never pushed
  await write(work, { '안내문.md': `${NOTICE}마감: 12월 2일(연기)\n`, '맥북 메모.md': '연기 사유: 강사 일정\n' })
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-qm', '꺼진 사이'])
  const later = (await git(work, ['rev-parse', 'HEAD'])).out
  await pc.close()
  await waitFor(async () => (await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`)).device?.online === false, 10000, 'PC off on the web')
  // its person takes it on the web (the PC is off: from the last push — 보관 중)
  const tk = await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat/take`, { method: 'POST', body: {} })
  assert.notEqual(tk.waiting, true)
  assert.equal((await api(OWN.token, `/folders/${folder.slug}/variations/${v.id}/seat`)).place, null)
  // back on: its list no longer has it
  pc = await openLink(dev.token, '한소유의 맥북')
  assert.deepEqual((await pc.next('seat:list', 0)).seats, [])
  const stale = await git(work, ['push', urlOf(t), `HEAD:refs/heads/${t.branch}`], t.token)
  assert.notEqual(stale.code, 0)
  assert.match(stale.err, /403/)
  assert.equal((await pc.ask({ type: 'seat:token', variation: v.id, epoch: p2.epoch, for: 'push' }, ['seat:refused'])).why, 'not_here')
  // what it still has comes back as a variation of its own
  const lt = await pc.ask({ type: 'seat:token', variation: v.id, epoch: p2.epoch, for: 'left' }, ['seat:token', 'seat:refused'])
  assert.equal(lt.type, 'seat:token', JSON.stringify(lt))
  assert.equal(lt.branch, `pgpt-agent/left-${v.id.slice(0, 8)}-${dev.device.id.slice(0, 8)}/head`)
  const up = await git(work, ['push', '-q', urlOf(lt), `HEAD:refs/heads/${lt.branch}`], lt.token)
  assert.equal(up.code, 0, up.err)
  assert.match((await git(work, ['push', urlOf(lt), `HEAD:refs/heads/${lt.push}again`], lt.token)).err, /403/, '한 번만')
  const got = await pc.ask({ type: 'seat:left', variation: v.id, head: later }, ['seat:left-taken', 'seat:refused'])
  assert.equal(got.type, 'seat:left-taken', JSON.stringify(got))
  assert.equal(got.newVariation.title, '마감일 추가 — 한소유의 맥북에 남아 있던 변경')
  const fd = await api(OWN.token, `/folders/${folder.slug}`)
  const nv = fd.variations.find((x) => x.id === got.newVariation.id)
  assert.deepEqual([nv.kind, nv.status, nv.holder_id], ['imported', 'ready', OWN.id])
  assert.match(nv.source?.label || '', /한소유의 맥북에 남아 있던 변경/)
  const orig = await api(OWN.token, `/workroom/variation/${v.id}/file?path=${encodeURIComponent('안내문.md')}`)
  assert.doesNotMatch(orig.content, /12월 2일/, '원래 변형에는 섞이지 않는다')
  await api(OWN.token, `/folders/${folder.slug}/variations/${nv.id}/seat`, { method: 'POST', body: { to: 'server' } })
  assert.match((await api(OWN.token, `/workroom/variation/${nv.id}/file?path=${encodeURIComponent('안내문.md')}`)).content, /12월 2일\(연기\)/)
  assert.match((await api(OWN.token, `/workroom/variation/${nv.id}/file?path=${encodeURIComponent('맥북 메모.md')}`)).content, /강사 일정/)
  return `새 변형 「${nv.title}」 · 옛 토큰 403 · 한 번짜리 토큰 두 번째 403`
})

await step('SP-E-06 내 PC 가 켜져 있으면 「여기로 가져오기」는 PC 가 돌려놓게 한다(seat:recall auto) · 남의 링크 · 다른 회사의 변형에는 닿지 않는다', async () => {
  const v2 = await api(OWN.token, `/folders/${folder.slug}/variations`, { method: 'POST', body: { title: '다과 목록' } })
  let at = pc.got.length
  await api(OWN.token, `/folders/${folder.slug}/variations/${v2.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: dev.device.id } })
  const p = await pc.next('seat:prepare', at)
  assert.equal((await pc.ask({ type: 'seat:ready', variation: v2.id, epoch: p.epoch, head: p.head }, ['seat:held'])).type, 'seat:held')
  at = pc.got.length
  const tk = await api(OWN.token, `/folders/${folder.slug}/variations/${v2.id}/seat/take`, { method: 'POST', body: {} })
  assert.equal(tk.waiting, true)
  const rc = await pc.next('seat:recall', at)
  assert.deepEqual([rc.variation, rc.epoch, rc.auto], [v2.id, p.epoch, true])
  // (the PC gives it back — here with nothing new)
  assert.equal((await pc.ask({ type: 'seat:release', variation: v2.id, epoch: p.epoch }, ['seat:released', 'seat:refused'])).type, 'seat:released')
  assert.equal((await api(OWN.token, `/folders/${folder.slug}/variations/${v2.id}/seat`)).place, null)
  // 김동료's link: it never had this variation — no token, no ready, no release
  const kimDev = await api(KIM.token, '/local-agents/devices', { method: 'POST', body: { name: '김동료의 노트북', platform: 'darwin', appVersion: '0.2.6' } })
  const kim = await openLink(kimDev.token, '김동료의 노트북')
  await api(OWN.token, `/folders/${folder.slug}/variations/${v2.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: dev.device.id } })
  const p3 = await pc.next('seat:prepare', at)
  assert.equal((await kim.ask({ type: 'seat:ready', variation: v2.id, epoch: p3.epoch, head: p3.head }, ['seat:held', 'seat:refused'])).why, 'not_here')
  assert.equal((await kim.ask({ type: 'seat:token', variation: v2.id, epoch: p3.epoch, for: 'push' }, ['seat:token', 'seat:refused'])).why, 'not_here')
  assert.equal((await kim.ask({ type: 'seat:token', variation: v2.id, epoch: p3.epoch, for: 'left' }, ['seat:token', 'seat:refused'])).why, 'not_runner')
  assert.equal((await kim.ask({ type: 'seat:release', variation: v2.id, epoch: p3.epoch }, ['seat:released', 'seat:refused'])).why, 'not_here')
  // another company's folder and variation (the same server and database, another tenant): not found from this link
  const otherRepo = path.join(ROOT, 'other-co')
  await fs.mkdir(otherRepo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', otherRepo])
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: otherRepo })
  execFileSync('git', ['branch', 'var/u/x/other', 'main'], { cwd: otherRepo })
  const [of] = await q(`insert into pro_folders (tenant_id, slug, name, kind, repo_path) values ($1,'other-co','다른 회사 폴더','managed',$2) returning id`, [OTHER, otherRepo])
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'owner')`, [of.id, OWN.id])
  const [ov] = await q(`insert into pro_folder_variations (folder_id, branch, title, kind, status, holder_type, holder_id, holder_name) values ($1,'var/u/x/other','남의 회사 일','person','open','user',$2,'한소유') returning id`, [of.id, OWN.id])
  await q(`insert into pro_variation_seats (variation_id, tenant_id, folder_id, place, state, user_id, device_id, epoch) values ($1,$2,$3,'device','held',$4,$5,1)`, [ov.id, OTHER, of.id, OWN.id, dev.device.id])
  for (const m of [{ type: 'seat:token', variation: ov.id, epoch: 1, for: 'push' }, { type: 'seat:token', variation: ov.id, epoch: 1, for: 'left' }, { type: 'seat:ready', variation: ov.id, epoch: 1, head: 'a'.repeat(40) }]) {
    assert.equal((await pc.ask(m, ['seat:token', 'seat:held', 'seat:refused'])).why, 'no_variation', JSON.stringify(m))
  }
  assert.equal((await fails(OWN.token, `/folders/other-co/variations/${ov.id}/seat`, { method: 'POST', body: { to: 'device', deviceId: dev.device.id } })).status, 404)
  await kim.close()
  return '켜진 PC → seat:recall auto → 돌려놓음 · 김동료 not_here · not_runner · 다른 회사 no_variation · 404'
})

await save()
await cleanup()
console.log(`# ${report.length} steps passed`)
