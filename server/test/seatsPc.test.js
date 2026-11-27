// Variation seats, P1 — a variation's working copy on its person's computer (spec openspec/specs/variation-seats; lib/folders/seatLink.js,
// the desktop's runner/seats.js). The link is a stand-in (the test plays the desktop's main process: seat:ready · token · pushed · release
// · status · left); git is real, over the public path /api/local-git with the tokens the server minted (gitHttp.js, a real express app).
// Pinned here:
//   - the seat token: one variation × one device × one epoch, looked at again on every request — the device revoked, the seat moved (the
//     epoch is old), the person's role below runner: refused at once, mid-life; it pushes only to its own epoch's branch
//   - the desktops' branches (seat-/left-) are hidden from every other token and refused to it; the leftover token pushes once
//   - the link's messages: ready → held (an older epoch, another computer: refused), pushed → the variation moves forward only (diverged and a
//     key-shaped file refused, put back), status counts, release → 보관 중 (the epoch's branch goes), failed → 보관 중, the list on link up,
//     leftover → a variation of its own; another person's or another company's link reaches nothing
// Run: node --test test/seatsPc.test.js  (the local database with sql/063; folders in a temporary directory, tenant "seats-pc-test",
// everything removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-pc-'))
const TENANT = 'seats-pc-test'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.PRO_GIT_PUBLIC_URL = ''
// (git here reads no ignore list of this computer's own — an upload asks git what the folder's .gitignore leaves out, and a developer's
// global list naming .claude/settings.local.json would answer for it; lib/folders/git.js takes the environment as it is at load)
process.env.XDG_CONFIG_HOME = path.join(ROOT, 'xdg')
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, 'gitconfig')
const SL = await import('../lib/folders/seatLink.js')
const H = await import('../lib/folders/gitHttp.js')
const D = await import('../lib/localAgents/devices.js')

// ---------- without the database ----------
test('WL-P-01 이름 · 토큰: 회차 가지와 남은 변경 가지, 한 번짜리 토큰, 앱의 능력 seats', () => {
  const vid = 'abcdef12-0000-4000-8000-000000000001'
  const dev = '99887766-0000-4000-8000-000000000002'
  // (the whole variation id: two variations whose ids start alike never share a branch — review 11-26 #12)
  assert.equal(SL.seatPrefix(vid, 4), `pgpt-agent/seat-${vid}-4/`)
  assert.equal(SL.seatBranch(vid, 4), `pgpt-agent/seat-${vid}-4/head`)
  // (the whole device id too: two computers whose ids start alike never share a leftover branch — review of #112)
  assert.equal(SL.leftPrefix(vid, dev), `pgpt-agent/left-${vid}-${dev}/`)
  assert.equal(H.seatPart(vid, 4), `refs/heads/pgpt-agent/seat-${vid}-4`)
  // git http-backend never takes the protocol from the server's own environment (v2 would hand out hidden objects by id)
  assert.equal('GIT_PROTOCOL' in H.backendEnv({ GIT_PROTOCOL: 'version=2', PATH: '/bin' }), false)
  process.env.SERVICE_ROLE_KEY ||= 'test-key'
  const c = H.verifyToken(H.mintToken({ tenant: TENANT, folderId: 'f1', push: SL.leftPrefix(vid, dev), scope: 'left', device: dev, seat: vid, epoch: 3, once: 'a1b2', hours: 1 }))
  assert.deepEqual([c.scope, c.seat, c.epoch, c.once, c.push], ['left', vid, 3, 'a1b2', SL.leftPrefix(vid, dev)])
  assert.equal(D.capsOf({ seats: true }).seats, true)
  assert.equal(D.capsOf({}).seats, false)
  // a push that names another desktop's branch is refused for any token but that part's own
  const cmd = (ref) => ({ old: '0'.repeat(40), new: '1'.repeat(40), ref })
  const seatClaims = { scope: 'seat', push: SL.seatPrefix(vid, 4) }
  assert.equal(H.syncRefusals([cmd(`refs/heads/${SL.seatBranch(vid, 4)}`)], seatClaims), null)
  assert.match(H.syncRefusals([cmd(`refs/heads/${SL.seatBranch(vid, 3)}`)], seatClaims)[0].why, /working copy/)
  assert.match(H.syncRefusals([cmd(`refs/heads/${SL.leftBranch(vid, dev)}`)], { scope: 'device', push: 'pgpt-agent/' })[0].why, /working copy/)
  assert.match(H.syncRefusals([cmd('refs/heads/pgpt-agent/sync-99887766/main')], seatClaims)[0].why, /sync branch/)
  assert.ok(SL.handles({ type: 'seat:ready' }) && !SL.handles({ type: 'sync:token' }))
})

// ---------- with the database ----------
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_seats limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const SE = await import('../lib/folders/seats.js')
const SRC = await import('../lib/folders/sources.js')
const { ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'seats-pc-owner@example.test' }
const mate = { id: crypto.randomUUID(), name: '김동료', email: 'seats-pc-mate@example.test' }
if (db) {
  await ensureTenantRow(TENANT).catch(() => {})
  for (const u of [owner, mate]) await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4) on conflict do nothing', [u.id, u.email, u.name, TENANT]).catch((e) => console.warn('users', e.message))
}
let server = null
let BASE = ''
if (db) {
  const express = (await import('express')).default
  const app = express()
  app.use('/api/git', H.gitRoutes())
  app.use('/api/local-git', H.gitRoutes({ device: true, check: (cl, o) => D.gitAccess(cl, o),
    after: (cl, f, cmds) => (cl.scope === 'sync' ? SRC.afterPush : SL.afterPush)(cl, f, cmds) }))
  server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)) })
  BASE = `http://127.0.0.1:${server.address().port}`
}
after(async () => {
  server?.close()
  if (db) {
    await q('delete from pro_variation_seat_log where tenant_id=$1', [TENANT]).catch(() => {})
    for (const t of ['pro_local_jobs', 'pro_folder_sources', 'pro_local_devices', 'pro_folders', 'notifications']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
    await q("delete from users where tenant_id=$1 and email like '%@example.test'", [TENANT]).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})

// real git, the token only in a request header (GIT_CONFIG_* — never on the command line)
const git = (cwd, args, token = null) => new Promise((resolve) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: ROOT }
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(k)) delete env[k]
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` })
  execFile('git', ['-c', 'user.name=한소유', '-c', 'user.email=seats-pc-owner@example.test', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
    { cwd, env }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: String(stdout).trim(), err: String(stderr) }))
})
const remote = (f) => `${BASE}/api/local-git/${f.id}.git`
const claimsOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString())
async function device(user, name = '맥북') {
  const [d] = await q(`insert into pro_local_devices (tenant_id, user_id, name, token_hash, caps) values ($1,$2,$3,$4,$5) returning *`, [TENANT, user.id, name, crypto.randomBytes(16).toString('hex'), { seats: true }])
  return d
}
// a link as the hub hands it to a message handler (a desktop 0.2.6: caps.seats), its replies kept
const linkOf = (d, extra = {}) => { const sent = []; return { id: d.id, tenant: TENANT, userId: String(d.user_id), name: d.name, caps: { seats: true }, sent, send: (m) => { sent.push(m); return true }, last: (t) => sent.filter((m) => m.type === t).at(-1), ...extra } }
const say = async (L, msg, want) => { const at = L.sent.length; await SL.receive(L, msg); return L.sent.slice(at).find((m) => !want || [].concat(want).includes(m.type)) }
async function folderWith(label) {
  const f = await S.createFolder(owner, { name: `${label} ${crypto.randomBytes(3).toString('hex')}` })
  await S.upload(f, owner, '안내문.md', Buffer.from('# 안내\n\n신청: 현장 접수\n'))
  await S.setMember(f, owner, { id: mate.id, role: 'editor' })
  return S.folderById(f.id)
}
const personVar = (f, who, title = '내 작업') => S.createVariation(f, { title, kind: 'person', holder: { type: 'user', id: who.id, name: who.name }, createdBy: who.id })
const fileOn = async (f, ref, p) => (await G.show(f.repo_path, ref, p).catch(() => Buffer.from(''))).toString()
// 「이 PC 에서 작업」 as the route does it: the seat moves to the computer (moving), the computer is told (seat:prepare), it says ready
async function onPc(f, v, d, who = owner) {
  const L = linkOf(d)
  const out = await SE.claimDevice(f, v, { user: who, device: d.id, ready: false })
  assert.ok(out.ok, out.why)
  assert.equal((await SE.seatOf(v.id)).state, 'moving')
  assert.ok(await SL.prepare(L, f, await S.variationById(v.id), { epoch: out.epoch }))
  const prep = L.last('seat:prepare')
  const dir = await fs.mkdtemp(path.join(ROOT, 'pc-'))
  await git(dir, ['init', '-q', '-b', 'work'])
  const fe = await git(dir, ['fetch', '-q', remote(f), `+refs/heads/${prep.branch}:refs/remotes/lite/v`], prep.token)
  assert.equal(fe.code, 0, fe.err)
  await git(dir, ['checkout', '-q', '-B', 'work', 'refs/remotes/lite/v'])
  const held = await say(L, { type: 'seat:ready', variation: v.id, epoch: prep.epoch, head: (await git(dir, ['rev-parse', 'HEAD'])).out }, ['seat:held', 'seat:refused'])
  assert.equal(held.type, 'seat:held', JSON.stringify(held))
  return { L, dir, prep, epoch: prep.epoch }
}
async function commitIn(dir, files, message = '저장 지점') {
  for (const [p, body] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true }); await fs.writeFile(path.join(dir, p), body) }
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', message])
  return (await git(dir, ['rev-parse', 'HEAD'])).out
}
async function pushToken(pc, v) {
  const t = await say(pc.L, { type: 'seat:token', variation: v.id, epoch: pc.epoch, for: 'push' }, ['seat:token', 'seat:refused'])
  assert.equal(t.type, 'seat:token', JSON.stringify(t))
  return t
}

test('WL-P-02 준비 → 받음: 넘기는 중의 토큰은 읽기만, 지난 회차 · 다른 PC 의 ready 는 거절, 받으면 자리를 쥔다 · 수 알림 · 실패는 보관 중', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('준비')
  const v = await personVar(f, owner)
  const d = await device(owner)
  const L = linkOf(d)
  const out = await SE.claimDevice(f, v, { user: owner, device: d.id, ready: false })
  await SL.prepare(L, f, await S.variationById(v.id), { epoch: out.epoch })
  const prep = L.last('seat:prepare')
  assert.deepEqual([prep.variation, prep.folderId, prep.branch, prep.epoch, prep.path, prep.url, prep.push],
    [v.id, f.id, v.branch, out.epoch, `/api/local-git/${f.id}.git`, null, SL.seatPrefix(v.id, out.epoch)])
  assert.equal(prep.head, await G.head(f.repo_path, `refs/heads/${v.branch}`))
  const c = claimsOf(prep.token)
  assert.deepEqual([c.scope, c.device, c.seat, c.epoch, c.push, c.folder, c.tenant], ['seat', d.id, v.id, out.epoch, SL.seatPrefix(v.id, out.epoch), f.id, TENANT])
  assert.ok(Math.abs(c.exp - Date.now() / 1000 - 3600) < 60, '1시간')
  assert.equal(JSON.stringify(prep).includes(ROOT), false, '경로가 없다')
  // while moving it reads, it does not push
  assert.equal(await D.gitAccess({ ...c }, { push: false }), null)
  assert.match(await D.gitAccess({ ...c }, { push: true }), /still being prepared/)
  // an older epoch · another computer of the same person · another company's link: refused, nothing changes
  assert.equal((await say(L, { type: 'seat:ready', variation: v.id, epoch: out.epoch - 1, head: prep.head }, 'seat:refused')).why, 'stale')
  const other = linkOf(await device(owner, '사무실 PC'))
  assert.equal((await say(other, { type: 'seat:ready', variation: v.id, epoch: out.epoch, head: prep.head }, 'seat:refused')).why, 'not_here')
  assert.equal((await say({ ...linkOf(d), tenant: 'seats-pc-other' }, { type: 'seat:ready', variation: v.id, epoch: out.epoch, head: prep.head }, 'seat:refused')).why, 'device_revoked')
  assert.equal((await SE.seatOf(v.id)).state, 'moving')
  const held = await say(L, { type: 'seat:ready', variation: v.id, epoch: out.epoch, head: prep.head }, ['seat:held'])
  assert.deepEqual([held.epoch, held.head], [out.epoch, prep.head])
  assert.equal((await SE.seatOf(v.id)).state, 'held')
  // (said again: still held, nothing moves)
  assert.equal((await say(L, { type: 'seat:ready', variation: v.id, epoch: out.epoch, head: prep.head }, ['seat:held', 'seat:refused'])).type, 'seat:held')
  // the counts it reports — numbers only — are what every screen shows; another computer's are not taken
  await SL.receive(L, { type: 'seat:status', variation: v.id, epoch: out.epoch, dirty: 3, ahead: 1, branchOk: true, files: ['비밀.txt'] })
  await SL.receive(other, { type: 'seat:status', variation: v.id, epoch: out.epoch, dirty: 99, ahead: 99 })
  const view = await SE.viewOf(await SE.seatOf(v.id), await S.variationById(v.id), { me: mate, role: 'editor' })
  assert.deepEqual([view.place, view.state, view.dirty, view.ahead, view.who.id, view.device.name], ['device', 'held', 3, 1, owner.id, '맥북'])
  assert.equal(JSON.stringify(view).includes(d.id), false, '기기 id 가 없다')
  await SL.receive(L, { type: 'seat:prefs', variation: v.id, autoSave: false })
  assert.equal((await SE.seatOf(v.id)).auto_save, false)
  // the list on link up: this computer's working copies only (not a chat run's seat, not a move that ran out of time)
  const v2 = await personVar(f, owner, '늦은 준비')
  await SE.claimDevice(f, v2, { user: owner, device: d.id, ready: false })
  await q(`update pro_variation_seats set deadline = now() - interval '1 minute' where variation_id=$1`, [v2.id])
  const v3 = await personVar(f, owner, '채팅 실행')
  await SE.claimDevice(f, v3, { user: owner, device: d.id, job: crypto.randomUUID(), ready: true })
  await SL.linkOn(L)
  assert.deepEqual(L.last('seat:list').seats, [{ variation: v.id, folderId: f.id, epoch: out.epoch, state: 'held', autoSave: false }])
  const old = linkOf(d, { caps: {} })
  assert.equal(await SL.linkOn(old), false, '작업본을 모르는 옛 앱에는 보내지 않는다')
  // the computer could not make it: 보관 중 (an older epoch's failure changes nothing)
  const v4 = await personVar(f, owner, '실패')
  const o4 = await SE.claimDevice(f, v4, { user: owner, device: d.id, ready: false })
  await SL.receive(L, { type: 'seat:failed', variation: v4.id, epoch: o4.epoch - 1, why: 'clone' })
  assert.equal((await SE.seatOf(v4.id)).state, 'moving')
  await SL.receive(L, { type: 'seat:failed', variation: v4.id, epoch: o4.epoch, why: 'clone' })
  assert.equal(await SE.seatOf(v4.id), null)
  assert.equal(Number((await S.variationById(v4.id)).seat_epoch), o4.epoch + 1)
})

test('WL-P-03 올림: 앞으로만 — 그 회차의 가지로 push → seat:pushed → 변형이 따라온다, 갈라진 머리 · 열쇠 생김새는 거절(되돌림), main · 남의 가지는 못 올림', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('올림')
  const v = await personVar(f, owner)
  const pc = await onPc(f, v, await device(owner))
  const t = await pushToken(pc, v)
  assert.deepEqual([t.branch, t.epoch, t.push], [SL.seatBranch(v.id, pc.epoch), pc.epoch, SL.seatPrefix(v.id, pc.epoch)])
  assert.equal(claimsOf(t.token).scope, 'seat')
  const one = await commitIn(pc.dir, { '안내문.md': '# 안내\n\n신청: 현장 접수\n마감: 11월 30일\n', '새 메모.md': 'PC 에서 쓴 메모\n' })
  const p = await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)
  assert.equal(p.code, 0, p.err)
  const before = await G.head(f.repo_path, `refs/heads/${v.branch}`)
  assert.notEqual(before, one, '올리기만으로는 변형이 움직이지 않는다')
  const taken = await say(pc.L, { type: 'seat:pushed', variation: v.id, epoch: pc.epoch, head: one }, ['seat:taken', 'seat:refused'])
  assert.deepEqual([taken.type, taken.head], ['seat:taken', one])
  assert.equal(await G.head(f.repo_path, `refs/heads/${v.branch}`), one)
  assert.match(await fileOn(f, v.branch, '안내문.md'), /마감: 11월 30일/)
  const cur = await S.variationById(v.id)
  assert.equal(cur.head_commit, one)
  const seat = await SE.seatOf(v.id)
  assert.equal(seat.head, one)
  assert.ok(seat.pushed_at, '마지막 올림')
  // said again: taken, nothing moves
  assert.equal((await say(pc.L, { type: 'seat:pushed', variation: v.id, epoch: pc.epoch, head: one }, ['seat:taken'])).head, one)
  // that token: not main, not another epoch's branch, not a leftover branch, not the variation itself, not deleting
  await commitIn(pc.dir, { '다음.md': '다음\n' })
  for (const ref of ['refs/heads/main', `refs/heads/${SL.seatBranch(v.id, pc.epoch + 1)}`, `refs/heads/${SL.leftBranch(v.id, pc.L.id)}`, `refs/heads/${v.branch}`]) {
    const r = await git(pc.dir, ['push', remote(f), `HEAD:${ref}`], t.token)
    assert.notEqual(r.code, 0, ref)
    assert.match(r.err, /remote rejected|only refs\/heads/, ref)
  }
  assert.match((await git(pc.dir, ['push', remote(f), `:refs/heads/${t.branch}`], t.token)).err, /remote rejected/)
  // a key-shaped file: put back right after the push, the reason said for that head (file + reason, never the value)
  await git(pc.dir, ['checkout', '-q', '-B', 'work', one])
  const key = `-----BEGIN ${'OPENSSH PRIVATE'} KEY-----\nAAAA\n`
  const bad = await commitIn(pc.dir, { 'keys/id.txt': key })
  assert.equal((await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)).code, 0)
  assert.equal(await G.head(f.repo_path, `refs/heads/${t.branch}`), one, '거절된 올림은 바로 되돌린다')
  const no = await say(pc.L, { type: 'seat:pushed', variation: v.id, epoch: pc.epoch, head: bad }, ['seat:taken', 'seat:refused'])
  assert.equal(no.type, 'seat:refused')
  assert.equal(no.why, 'secret')
  assert.equal(no.paths[0].path, 'keys/id.txt')
  assert.equal(JSON.stringify(no).includes('AAAA'), false)
  assert.equal(await G.head(f.repo_path, `refs/heads/${v.branch}`), one)
  // a head that is not ahead of the variation (history written over on the PC): refused, the variation stays
  await git(pc.dir, ['checkout', '-q', '-B', 'other', before])
  const side = await commitIn(pc.dir, { '다른 길.md': '갈라짐\n' })
  assert.equal((await git(pc.dir, ['push', '-q', '-f', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)).code, 0)
  const dv = await say(pc.L, { type: 'seat:pushed', variation: v.id, epoch: pc.epoch, head: side }, ['seat:taken', 'seat:refused'])
  assert.equal(dv.why, 'diverged')
  assert.equal(await G.head(f.repo_path, `refs/heads/${v.branch}`), one)
})

test('WL-P-04 작업본 토큰은 요청마다 다시 본다: 기기 끊김 · 자리가 옮겨 감(지난 회차) · 역할이 runner 아래로 — 살아 있는 토큰도 그 순간 멈춘다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('요청마다')
  const v = await personVar(f, mate, '김동료의 일')
  const d = await device(mate, '김동료의 노트북')
  const pc = await onPc(f, v, d, mate)
  const t = await pushToken(pc, v)
  const ls = async () => (await git(ROOT, ['ls-remote', remote(f)], t.token))
  assert.equal((await ls()).code, 0)
  // the device let go in the settings
  await q('update pro_local_devices set revoked_at=now() where id=$1', [d.id])
  assert.match((await ls()).err, /403/)
  assert.equal((await say(pc.L, { type: 'seat:token', variation: v.id, epoch: pc.epoch, for: 'push' }, 'seat:refused')).why, 'device_revoked')
  await q('update pro_local_devices set revoked_at=null where id=$1', [d.id])
  assert.equal((await ls()).code, 0)
  // the person's role goes below runner (viewer): the token stops
  await S.setMember(f, owner, { id: mate.id, role: 'viewer' })
  await commitIn(pc.dir, { '메모.md': '역할\n' })
  const p1 = await git(pc.dir, ['push', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)
  assert.notEqual(p1.code, 0)
  assert.match(p1.err, /403|runner/)
  assert.equal((await say(pc.L, { type: 'seat:token', variation: v.id, epoch: pc.epoch, for: 'push' }, 'seat:refused')).why, 'not_runner')
  await S.setMember(f, owner, { id: mate.id, role: 'editor' })
  assert.equal((await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)).code, 0)
  // the seat moved (its person took it from the web while this PC was off): the same token — an older epoch now — stops
  await SE.take(f, await S.variationById(v.id), mate, { role: 'editor' })
  assert.match((await ls()).err, /403/)
  assert.equal((await say(pc.L, { type: 'seat:token', variation: v.id, epoch: pc.epoch, for: 'push' }, 'seat:refused')).why, 'not_here')
  assert.equal((await say(pc.L, { type: 'seat:pushed', variation: v.id, epoch: pc.epoch, head: (await git(pc.dir, ['rev-parse', 'HEAD'])).out }, 'seat:refused')).why, 'not_here')
  // and the cluster path never takes a desktop's token
  assert.match((await git(ROOT, ['ls-remote', `${BASE}/api/git/${f.id}.git`], t.token)).err, /403/)
})

test('WL-P-05 데스크톱의 가지는 다른 토큰에 보이지 않는다: 일 토큰 · 동기화 토큰 · 다른 변형의 작업본 토큰 · 클러스터 — 받기 전의 자리도 미리 숨김', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('숨김')
  const v = await personVar(f, owner, '첫째')
  const pc = await onPc(f, v, await device(owner))
  const t = await pushToken(pc, v)
  await commitIn(pc.dir, { 'a.md': 'a\n' })
  assert.equal((await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)).code, 0)
  const own = await git(ROOT, ['ls-remote', remote(f)], t.token)
  assert.match(own.out, new RegExp(`refs/heads/${t.branch}`), '자기 회차의 가지는 보인다')
  assert.match(own.out, new RegExp(`refs/heads/${v.branch}`), '변형 가지는 보인다')
  // another variation on another computer of the same person
  const v2 = await personVar(f, owner, '둘째')
  const pc2 = await onPc(f, v2, await device(owner, '사무실 PC'))
  const t2 = await pushToken(pc2, v2)
  const theirs = await git(ROOT, ['ls-remote', remote(f)], t2.token)
  assert.equal(theirs.code, 0, theirs.err)
  assert.doesNotMatch(theirs.out, /pgpt-agent\/seat-/, '다른 작업본의 가지는 보이지 않는다')
  // a desktop sync token and the cluster's
  const sd = await device(owner, '원본 PC')
  await q(`insert into pro_folder_sources (tenant_id, folder_id, user_id, device_id, label, branch) values ($1,$2,$3,$4,'x',$5)`, [TENANT, f.id, owner.id, sd.id, SRC.branchOf(sd.id)]).catch(() => {})
  await q(`update pro_folders set settings = settings || '{"champion":{}}'::jsonb where id=$1`, [f.id])
  const sync = await git(ROOT, ['ls-remote', remote(f)], H.mintToken({ tenant: TENANT, folderId: f.id, push: SRC.prefixOf(sd.id), scope: 'sync', device: sd.id, hours: 1 }))
  assert.equal(sync.code, 0, sync.err)
  assert.doesNotMatch(sync.out, /pgpt-agent\/seat-/)
  const cluster = await git(ROOT, ['ls-remote', `${BASE}/api/git/${f.id}.git`], H.mintToken({ tenant: TENANT, folderId: f.id }))
  assert.equal(cluster.code, 0, cluster.err)
  assert.doesNotMatch(cluster.out, /pgpt-agent\/seat-/)
  // the cluster's token may not push there either
  const r = await git(pc.dir, ['push', `${BASE}/api/git/${f.id}.git`, `HEAD:refs/heads/${t.branch}`], H.mintToken({ tenant: TENANT, folderId: f.id }))
  assert.notEqual(r.code, 0)
  assert.match(r.err, /remote rejected|working copy/)
  // a seat with nothing pushed yet is hidden already
  const hidden = await H.syncHidden(f, { scope: 'device' })
  assert.ok(hidden.includes(H.seatPart(v2.id, pc2.epoch)), JSON.stringify(hidden))
  assert.ok(!(await H.syncHidden(f, claimsOf(t2.token))).includes(H.seatPart(v2.id, pc2.epoch)), '자기 것은 빼고')
})

test('WL-P-06 돌려놓기: 마지막 것을 넣고 보관 중 · 반영 대기, 회차 가지는 지움 — 지난 회차 · 다른 PC 는 거절', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('돌려놓기')
  const v = await personVar(f, owner)
  const pc = await onPc(f, v, await device(owner))
  await q(`update pro_folder_variations set status='open' where id=$1`, [v.id])
  const t = await pushToken(pc, v)
  const head = await commitIn(pc.dir, { '안내문.md': '# 안내\n\n돌려놓기 전에 고침\n' }, '돌려놓기')
  assert.equal((await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)).code, 0)
  assert.equal((await say(pc.L, { type: 'seat:release', variation: v.id, epoch: pc.epoch - 1, head }, 'seat:refused')).why, 'stale')
  const rel = await say(pc.L, { type: 'seat:release', variation: v.id, epoch: pc.epoch, head }, ['seat:released', 'seat:refused'])
  assert.deepEqual([rel.type, rel.head], ['seat:released', head])
  assert.equal(await SE.seatOf(v.id), null)
  const cur = await S.variationById(v.id)
  assert.deepEqual([cur.status, cur.head_commit, Number(cur.seat_epoch)], ['ready', head, pc.epoch + 1])
  assert.equal(await G.head(f.repo_path, `refs/heads/${t.branch}`), null, '회차 가지는 지운다')
  assert.match(await fileOn(f, v.branch, '안내문.md'), /돌려놓기 전에 고침/)
  // the server workroom can open it now (P0) and has what the PC had
  const room = await SE.openServer(f, cur, { user: owner, run: 'workroom', dir: S.personCheckoutDir(owner, cur) })
  assert.ok(room.ok)
  assert.match(await fs.readFile(path.join((await S.variationById(v.id)).worktree_path, '안내문.md'), 'utf8'), /돌려놓기 전에 고침/)
  // the old PC's token stops (another place has it)
  assert.match((await git(ROOT, ['ls-remote', remote(f)], t.token)).err, /403/)
})

test('WL-P-07 남은 변경: 자리를 잃은 PC 의 것은 새 변형으로 — 한 번짜리 토큰, 그 사람만, 다른 회사는 닿지 않음', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('남은 변경')
  const v = await personVar(f, owner, '보고서 다듬기')
  const d = await device(owner, '맥북')
  const pc = await onPc(f, v, d)
  const t = await pushToken(pc, v)
  // the person takes it from the web while the PC is off (P0 take): 보관 중 from the last push
  await SE.take(f, await S.variationById(v.id), owner, { role: 'owner' })
  const later = await commitIn(pc.dir, { '안내문.md': '# 안내\n\n꺼진 사이에 고친 것\n', '맥북 메모.md': '맥북에서만\n' }, '남아 있던 변경')
  const stale = await git(pc.dir, ['push', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)
  assert.notEqual(stale.code, 0)
  assert.match(stale.err, /403/)
  // its list on link up no longer has it
  await SL.linkOn(pc.L)
  assert.deepEqual(pc.L.last('seat:list').seats, [])
  // another person's link and another company's: no leftover token
  const other = linkOf(await device(mate, '김동료의 PC'))
  assert.equal((await say(other, { type: 'seat:token', variation: v.id, epoch: pc.epoch, for: 'left' }, 'seat:refused')).why, 'not_runner')
  assert.equal((await say({ ...linkOf(d), tenant: 'seats-pc-other' }, { type: 'seat:token', variation: v.id, epoch: pc.epoch, for: 'left' }, 'seat:refused')).why, 'device_revoked')
  const lt = await say(pc.L, { type: 'seat:token', variation: v.id, epoch: pc.epoch, for: 'left' }, ['seat:token', 'seat:refused'])
  assert.equal(lt.type, 'seat:token', JSON.stringify(lt))
  assert.equal(lt.branch, SL.leftBranch(v.id, d.id))
  const lc = claimsOf(lt.token)
  assert.deepEqual([lc.scope, lc.seat, lc.device, lc.push], ['left', v.id, d.id, SL.leftPrefix(v.id, d.id)])
  assert.ok(lc.once)
  // not into the variation, not to another branch
  assert.match((await git(pc.dir, ['push', remote(f), `HEAD:refs/heads/${v.branch}`], lt.token)).err, /remote rejected|only refs/)
  const up = await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${lt.branch}`], lt.token)
  assert.equal(up.code, 0, up.err)
  // one push only
  const again = await git(pc.dir, ['push', remote(f), `HEAD:refs/heads/${lt.push}again`], lt.token)
  assert.notEqual(again.code, 0)
  assert.match(again.err, /403/)
  // …also for a server that restarted or another process (nothing in its memory): the use is kept in the database (review 11-26 #11)
  const fresh = await import(`../lib/localAgents/devices.js?fresh=${Date.now()}`)
  assert.match(String(await fresh.leftAccess(lc, { push: true })), /used/)
  const got = await say(pc.L, { type: 'seat:left', variation: v.id, head: later }, ['seat:left-taken', 'seat:refused'])
  assert.equal(got.type, 'seat:left-taken', JSON.stringify(got))
  assert.equal(got.newVariation.title, '보고서 다듬기 — 맥북에 남아 있던 변경')
  const nv = await S.variationById(got.newVariation.id)
  assert.deepEqual([nv.kind, nv.status, nv.holder_id, nv.head_commit], ['imported', 'ready', owner.id, later])
  assert.match(await fileOn(f, nv.branch, '안내문.md'), /꺼진 사이에 고친 것/)
  assert.doesNotMatch(await fileOn(f, v.branch, '안내문.md'), /꺼진 사이에/, '원래 변형에는 섞이지 않는다')
  assert.equal(await G.head(f.repo_path, `refs/heads/${lt.branch}`), null, '남은 변경 가지는 새 변형 가지로 옮기고 지운다')
  // the same leftover said again (its PC could not move the copy aside and tries once more): the same variation, not a second one
  const lt3 = await say(pc.L, { type: 'seat:token', variation: v.id, epoch: pc.epoch, for: 'left' }, ['seat:token'])
  assert.equal((await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${lt3.branch}`], lt3.token)).code, 0)
  const again2 = await say(pc.L, { type: 'seat:left', variation: v.id, head: later }, ['seat:left-taken', 'seat:refused'])
  assert.equal(again2.newVariation?.id, got.newVariation.id, '같은 남은 변경은 같은 변형')
  const imported = await q(`select id from pro_folder_variations where folder_id=$1 and kind='imported' and source->>'left_of'=$2`, [f.id, v.id])
  assert.equal(imported.length, 1)
  // nothing beyond the variation: no new variation
  const v2 = await personVar(f, owner, '그대로')
  const pc2 = await onPc(f, v2, d)
  await SE.take(f, await S.variationById(v2.id), owner, { role: 'owner' })
  const lt2 = await say(pc2.L, { type: 'seat:token', variation: v2.id, epoch: pc2.epoch, for: 'left' }, ['seat:token'])
  const same = (await git(pc2.dir, ['rev-parse', 'HEAD'])).out
  assert.equal((await git(pc2.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${lt2.branch}`], lt2.token)).code, 0)
  assert.equal((await say(pc2.L, { type: 'seat:left', variation: v2.id, head: same }, ['seat:left-taken'])).newVariation, null)
})

test('WL-P-09 거절은 무엇에 대한 답인지 말한다(re) · 받는 동안 PC 가 알리면 넘기기 기한이 늘어난다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('기한')
  const v = await personVar(f, owner, '큰 폴더')
  const d = await device(owner, '느린 PC')
  const L = linkOf(d)
  const out = await SE.claimDevice(f, v, { user: owner, device: d.id, ready: false })
  assert.ok(out.ok)
  // (a ready for another epoch: the refusal names the message it answers)
  const no = await say(L, { type: 'seat:ready', variation: v.id, epoch: out.epoch + 5, head: null }, 'seat:refused')
  assert.deepEqual([no.why, no.re], ['stale', 'seat:ready'])
  // the computer still fetching a large folder says so: the move's deadline goes on
  await q(`update pro_variation_seats set deadline = now() + interval '2 seconds' where variation_id=$1`, [v.id])
  await SL.receive(L, { type: 'seat:preparing', variation: v.id, epoch: out.epoch })
  const [row] = await q(`select extract(epoch from deadline - now()) as left from pro_variation_seats where variation_id=$1`, [v.id])
  assert.ok(Number(row.left) > 60, `기한이 늘었다 (${row.left}s)`)
  // …not for another epoch, nor from another computer
  await q(`update pro_variation_seats set deadline = now() + interval '2 seconds' where variation_id=$1`, [v.id])
  await SL.receive(L, { type: 'seat:preparing', variation: v.id, epoch: out.epoch - 1 })
  await SL.receive(linkOf(await device(owner, '다른 PC')), { type: 'seat:preparing', variation: v.id, epoch: out.epoch })
  const [row2] = await q(`select extract(epoch from deadline - now()) as left from pro_variation_seats where variation_id=$1`, [v.id])
  assert.ok(Number(row2.left) < 10)
})

test('WL-P-10 PC 로 받기 전에: 실행되는 설정 파일(훅이 든 Claude 설정 · MCP · .envrc · VS Code 작업 · Windows 바로 가기)과 마지막으로 바꾼 사람', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('실행되는 설정')
  const T = await import('../lib/folders/seatTrust.js')
  await S.upload(f, mate, '.mcp.json', Buffer.from('{"mcpServers":{"x":{"command":"node","args":["x.js"]}}}\n'))
  await S.upload(f, mate, '.claude/settings.json', Buffer.from('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"curl example.test"}]}]}}\n'))
  await S.upload(f, owner, '.claude/settings.local.json', Buffer.from('{"permissions":{"allow":[]}}\n'))
  await S.upload(f, mate, '.envrc', Buffer.from('export X=1\n'))
  await S.upload(f, mate, '.vscode/tasks.json', Buffer.from('{"tasks":[]}\n'))
  await S.upload(f, mate, '문서/바로 가기.url', Buffer.from('[InternetShortcut]\nURL=https://example.test\n'))
  await S.upload(f, mate, 'desktop.ini', Buffer.from('[.ShellClassInfo]\n'))
  // (review of #112: more that runs or allows things by itself — Claude Code's other commands and permissions, Codex, VS Code's settings and
  // launch configurations, mise · asdf, and programs at the folder's top a Windows terminal runs before a command of the same name)
  await S.upload(f, mate, '보고/.claude/settings.json', Buffer.from('{"statusLine":{"type":"command","command":"sh x.sh"}}\n'))
  await S.upload(f, mate, '키/.claude/settings.json', Buffer.from('{"apiKeyHelper":"sh key.sh"}\n'))
  await S.upload(f, mate, '허락/.claude/settings.json', Buffer.from('{"permissions":{"allow":["Bash(*)"]}}\n'))
  await S.upload(f, mate, '모드/.claude/settings.json', Buffer.from('{"permissions":{"defaultMode":"bypassPermissions"}}\n'))
  await S.upload(f, mate, '엠씨피/.claude/settings.json', Buffer.from('{"enableAllProjectMcpServers":true}\n'))
  await S.upload(f, mate, '조용/.claude/settings.json', Buffer.from('{"permissions":{"defaultMode":"plan","allow":[]},"model":"x"}\n'))
  await S.upload(f, mate, '.codex/config.toml', Buffer.from('[mcp_servers.x]\ncommand = "node"\n'))
  await S.upload(f, mate, '.vscode/settings.json', Buffer.from('{}\n'))
  await S.upload(f, mate, '.vscode/launch.json', Buffer.from('{}\n'))
  await S.upload(f, mate, 'mise.toml', Buffer.from('[tools]\nnode = "22"\n'))
  await S.upload(f, mate, '.tool-versions', Buffer.from('nodejs 22\n'))
  await S.upload(f, mate, 'git.bat', Buffer.from('@echo off\n'))
  await S.upload(f, mate, '도구/build.cmd', Buffer.from('@echo off\n'))
  const v = await personVar(f, owner, '설정 보기')
  const t = await T.trustOf(await S.folderById(f.id), await S.variationById(v.id), owner)
  const got = t.files.map((x) => [x.path, x.reason, x.author])
  assert.deepEqual(got.sort(), [
    ['.claude/settings.json', 'hooks', '김동료'],
    ['.codex/config.toml', 'codex', '김동료'],
    ['.envrc', 'envrc', '김동료'],
    ['.mcp.json', 'mcp', '김동료'],
    ['.tool-versions', 'tools', '김동료'],
    ['.vscode/launch.json', 'vscode', '김동료'],
    ['.vscode/settings.json', 'vscode', '김동료'],
    ['.vscode/tasks.json', 'tasks', '김동료'],
    ['desktop.ini', 'shell', '김동료'],
    ['git.bat', 'run', '김동료'],
    ['mise.toml', 'tools', '김동료'],
    ['문서/바로 가기.url', 'shell', '김동료'],
    ['모드/.claude/settings.json', 'claude', '김동료'],
    ['보고/.claude/settings.json', 'claude', '김동료'],
    ['엠씨피/.claude/settings.json', 'claude', '김동료'],
    ['키/.claude/settings.json', 'claude', '김동료'],
    ['허락/.claude/settings.json', 'claude', '김동료'],
  ].sort(), '훅도 명령도 허락도 없는 설정(settings.local.json · plan 모드) · 하위 폴더의 .cmd 는 아니다')
  assert.equal(t.head, await G.head(f.repo_path, `refs/heads/${(await S.variationById(v.id)).branch}`), '본 판을 함께 준다')
  assert.equal(t.warn, true)
  assert.equal(t.verified, false, '커밋에 적힌 이름은 누구든 적을 수 있다 — 확인한 사람이라고 하지 않는다')
  // a commit that names me (anyone can write any name in a commit): still listed and still warned about (review 11-26 2nd #3)
  const quiet = await folderWith('내 이름으로 적힌 설정')
  await S.upload(quiet, { ...mate, name: owner.name, email: owner.email }, '.mcp.json', Buffer.from('{}\n'))
  const qv = await personVar(quiet, owner, '내 것처럼 보임')
  const t2 = await T.trustOf(await S.folderById(quiet.id), await S.variationById(qv.id), owner)
  assert.deepEqual([t2.files.length, t2.warn], [1, true], '이름이 나여도 알린다')
  // many settings files: their contents are read in one batch, and only so many
  const many = await folderWith('설정 많음')
  for (let i = 0; i < 70; i++) await S.upload(many, mate, `p${i}/.claude/settings.json`, Buffer.from('{"hooks":{"Stop":[]}}\n'))
  const mv = await personVar(many, owner, '많음')
  const t3 = await T.trustOf(await S.folderById(many.id), await S.variationById(mv.id), owner)
  assert.ok(t3.files.length <= 50 && t3.more > 0, '목록은 50개까지, 나머지는 수로')
})

test('WL-P-11 자리 목록과 준비에는 서버의 시각이 실린다(PC 가 늦게 온 옛 목록을 가린다)', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('시각')
  const v = await personVar(f, owner, '시각')
  const d = await device(owner, '시각 PC')
  const L = linkOf(d)
  const out = await SE.claimDevice(f, v, { user: owner, device: d.id, ready: false })
  await SL.prepare(L, f, await S.variationById(v.id), { epoch: out.epoch })
  await SL.linkOn(L)
  const prep = L.last('seat:prepare')
  const list = L.last('seat:list')
  assert.ok(Number.isFinite(prep.at) && Number.isFinite(list.at) && list.at >= prep.at, `${prep.at} ${list.at}`)
})

test('WL-P-12 「여기로 가져오기」를 PC 가 지금 못 하면(작업본에 열린 터미널) 그렇다고 답하고, 그 변형을 보는 그 사람에게 보인다 — 지난 회차 · 남의 PC 는 무시', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('가져오기 거절')
  const d = await device(owner, '터미널 연 PC')
  const v = await personVar(f, owner, '열린 터미널')
  const { L, epoch } = await onPc(f, v, d)
  const at = L.sent.length
  await SL.receive(L, { type: 'seat:refused', re: 'seat:recall', variation: v.id, epoch, why: 'in_use' })
  assert.equal(L.sent.length, at, '거절에 다시 거절로 답하지 않는다')
  const seat = await SE.seatOf(v.id)
  assert.deepEqual(SL.pcSays(v.id, seat) && [SL.pcSays(v.id, seat).why, SL.pcSays(v.id, seat).device], ['in_use', '터미널 연 PC'])
  SL.pcSaysClear(v.id)
  // an older epoch, another computer, another question, an unknown reason: nothing
  await SL.receive(L, { type: 'seat:refused', re: 'seat:recall', variation: v.id, epoch: epoch - 1, why: 'in_use' })
  await SL.receive(linkOf(await device(owner, '다른 PC')), { type: 'seat:refused', re: 'seat:recall', variation: v.id, epoch, why: 'in_use' })
  await SL.receive(L, { type: 'seat:refused', re: 'seat:save', variation: v.id, epoch, why: 'in_use' })
  await SL.receive(L, { type: 'seat:refused', re: 'seat:recall', variation: v.id, epoch, why: '<b>x</b>' })
  assert.equal(SL.pcSays(v.id, seat), null)
  // files to check on that PC (a pair it shows as one file, changed — 4th review #2): said too, without their names
  await SL.receive(L, { type: 'seat:refused', re: 'seat:recall', variation: v.id, epoch, why: 'unsure', files: ['Plan.md'] })
  assert.deepEqual(SL.pcSays(v.id, seat), { why: 'unsure', device: '터미널 연 PC', at: SL.pcSays(v.id, seat).at })
  // said, then the seat moved on: gone
  await SL.receive(L, { type: 'seat:refused', re: 'seat:recall', variation: v.id, epoch, why: 'in_use' })
  assert.equal(SL.pcSays(v.id, { ...seat, epoch: epoch + 1 }), null)
})

test('WL-P-08 설정에서 기기 연결을 끊으면 그 기기의 작업본 자리는 보관 중 — 채팅 실행의 자리 · 다른 기기의 자리는 그대로', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('끊음')
  const d = await device(owner, '끊을 PC')
  const v = await personVar(f, owner, '작업본')
  await onPc(f, v, d)
  const v2 = await personVar(f, owner, '채팅 실행')
  await SE.claimDevice(f, v2, { user: owner, device: d.id, job: crypto.randomUUID(), ready: true })
  const v3 = await personVar(f, owner, '다른 PC')
  await onPc(f, v3, await device(owner, '남는 PC'))
  const epoch = Number((await S.variationById(v.id)).seat_epoch)
  assert.equal(await SL.deviceGone(d.id, owner.id), 1)
  assert.equal(await SE.seatOf(v.id), null)
  assert.equal(Number((await S.variationById(v.id)).seat_epoch), epoch + 1)
  assert.equal((await SE.seatOf(v2.id)).place, 'device', '채팅 실행은 그 실행이 끝날 때 내려놓는다')
  assert.equal((await SE.seatOf(v3.id)).place, 'device')
})

test('WL-P-13 프로젝트의 작업 공간(템플릿에서 시작)도 그 사람의 PC 에서: 작업본 토큰이 그 가지를 받고, 저장 지점은 받기 전 검사를 지나 변형으로 — 남의 토큰에는 숨은 채로', { skip: !db && 'no database' }, async () => {
  // (a workspace as folders/templates.js makes one: a branch under var/t/, source.template, held by its person — hidden from every token
  // but that person's own desktop tokens, gitHttp.js workspaceHidden)
  const f = await folderWith('작업 공간')
  const v = await S.createVariation(f, { title: '견적 프로젝트', kind: 'person', branch: `${S.WORKSPACE_PREFIX}${crypto.randomBytes(8).toString('hex')}`,
    holder: { type: 'user', id: owner.id, name: owner.name }, createdBy: owner.id,
    source: { label: '프로젝트', thread_id: crypto.randomUUID(), project: true, template: { folder_id: f.id, slug: f.slug, name: f.name, commit: await G.head(f.repo_path, f.default_branch), outputs: '산출물' } } })
  assert.ok(S.isWorkspaceBranch(v.branch))
  // (another workspace of the same person in this folder, and a run branch of theirs)
  const other = await S.createVariation(f, { title: '다른 프로젝트', kind: 'person', branch: `${S.WORKSPACE_PREFIX}${crypto.randomBytes(8).toString('hex')}`,
    holder: { type: 'user', id: owner.id, name: owner.name }, createdBy: owner.id,
    source: { label: '프로젝트', thread_id: crypto.randomUUID(), project: true, template: { folder_id: f.id, slug: f.slug, name: f.name, commit: await G.head(f.repo_path, f.default_branch), outputs: '산출물' } } })
  const run = `pgpt-agent/local/${owner.id}/abcdef12-${Date.now().toString(36)}`
  await G.git(f.repo_path, ['branch', run, f.default_branch])
  const d = await device(owner)
  const pc = await onPc(f, v, d)
  const c = claimsOf(pc.prep.token)
  const shown = await H.hiddenFor(f, c)
  assert.ok(H.hiddenBy(`refs/heads/${v.branch}`, ['refs/heads/var/t/']) && !H.hiddenBy(`refs/heads/${v.branch}`, shown), '그 사람의 작업본 토큰에는 그 작업 공간이 보인다')
  // …only that one: not the person's other workspace, not their runs (review of #112)
  assert.ok(H.hiddenBy(`refs/heads/${other.branch}`, shown), '같은 사람의 다른 작업 공간은 숨은 채로')
  assert.ok(H.hiddenBy(`refs/heads/${run}`, shown), '그 사람의 실행 가지도 숨은 채로')
  const lsOwn = await git(pc.dir, ['ls-remote', remote(f)], pc.prep.token)
  assert.equal(lsOwn.code, 0, lsOwn.err)
  assert.deepEqual(lsOwn.out.split('\n').map((l) => l.split('\t')[1]).filter((r) => /var\/t\/|pgpt-agent\/local\//.test(r || '')), [`refs/heads/${v.branch}`])
  // a save point: through git's own pre-receive check (pushCheck.js) — everything it stands on is the token's to see — and into the workspace
  const t = await pushToken(pc, v)
  const one = await commitIn(pc.dir, { '산출물/견적서.md': '# 견적서\n\n합계: 120만 원\n' })
  const p = await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)
  assert.equal(p.code, 0, p.err)
  const taken = await say(pc.L, { type: 'seat:pushed', variation: v.id, epoch: pc.epoch, head: one }, ['seat:taken', 'seat:refused'])
  assert.deepEqual([taken.type, taken.head], ['seat:taken', one], JSON.stringify(taken))
  assert.match(await fileOn(f, v.branch, '산출물/견적서.md'), /120만 원/)
  // anyone else's working-copy token in the same folder, and a cluster token: the workspace stays hidden
  const mv = await personVar(f, mate, '동료 작업')
  const mpc = await onPc(f, mv, await device(mate, '동료 PC'), mate)
  assert.ok(H.hiddenBy(`refs/heads/${v.branch}`, await H.hiddenFor(f, claimsOf(mpc.prep.token))), '남의 작업본 토큰에는 숨은 채로')
  const ls = await git(mpc.dir, ['ls-remote', remote(f)], mpc.prep.token)
  assert.equal(ls.code, 0, ls.err)
  assert.doesNotMatch(ls.out, /refs\/heads\/var\/t\//)
  assert.ok(H.hiddenBy(`refs/heads/${v.branch}`, await H.hiddenFor(f, { scope: null })))
  // (a token whose variation is of another folder sees nothing of this one's workspaces)
  assert.ok(H.hiddenBy(`refs/heads/${v.branch}`, await H.hiddenFor(await folderWith('다른 폴더'), c)))
  // the leftover token of that computer for that workspace: the same one branch
  const left = { scope: 'left', device: d.id, seat: v.id, once: 'x1', tenant: TENANT, folder: f.id, push: SL.leftPrefix(v.id, d.id) }
  const leftShown = await H.hiddenFor(f, left)
  assert.ok(!H.hiddenBy(`refs/heads/${v.branch}`, leftShown) && H.hiddenBy(`refs/heads/${other.branch}`, leftShown))
  // …but not for a variation of the person's that is not a workspace, nor on another person's computer
  assert.equal(await H.seatWorkspace(f, { ...left, seat: mv.id }), null)
  assert.equal(await H.seatWorkspace(f, { ...left, device: (await device(mate, '동료의 둘째 PC')).id }), null)
  // the computer let go in the settings: the workspace is hidden from its tokens again
  await q('update pro_local_devices set revoked_at=now() where id=$1', [d.id])
  assert.ok(H.hiddenBy(`refs/heads/${v.branch}`, await H.hiddenFor(f, c)), '연결을 끊으면 다시 숨는다')
  assert.ok(H.hiddenBy(`refs/heads/${v.branch}`, await H.hiddenFor(f, left)))
})

test('WL-P-14 데스크톱 토큰은 폴더 잠금 안에서 다시 본다 — 바깥 검사를 지난 밀어 넣기도 그사이 쓰인 한 번짜리 토큰 · 옮겨 간 자리면 git 에 닿기 전에 403', { skip: !db && 'no database' }, async () => {
  const express = (await import('express')).default
  const f = await folderWith('잠금 안 검사')
  const v = await personVar(f, owner)
  const pc = await onPc(f, v, await device(owner))
  const t = await pushToken(pc, v)
  const asked = []
  // (the access check says yes outside the lock — the push's advertisement and its request — and no inside it: what a push just before this
  // one did there, a leftover token used up)
  const app = express()
  app.use('/api/local-git', H.gitRoutes({ device: true, check: async (cl, o) => { asked.push(o.push); return asked.filter(Boolean).length >= 3 ? 'this leftover token was used already' : D.gitAccess(cl, o) } }))
  const sv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)) })
  try {
    await commitIn(pc.dir, { '잠금.md': '잠금 안에서\n' })
    const before = await G.head(f.repo_path, `refs/heads/${t.branch}`)
    const p = await git(pc.dir, ['push', `http://127.0.0.1:${sv.address().port}/api/local-git/${f.id}.git`, `HEAD:refs/heads/${t.branch}`], t.token)
    assert.notEqual(p.code, 0)
    assert.match(p.err, /403|used already/)
    assert.equal(asked.filter(Boolean).length, 3, '밀어 넣기는 바깥에서(광고 · 요청), 그리고 잠금 안에서 한 번 더 본다')
    assert.equal(await G.head(f.repo_path, `refs/heads/${t.branch}`), before, '가지는 그대로')
  } finally { await new Promise((r) => sv.close(r)) }
})

test('WL-P-15 지난 회차의 가지는 밤 정리에서 지운다 — 지금 PC 가 쥔 회차의 가지는 그대로', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('지난 회차')
  const v = await personVar(f, owner)
  const d = await device(owner)
  const pc = await onPc(f, v, d)
  const t = await pushToken(pc, v)
  await commitIn(pc.dir, { '하나.md': '하나\n' })
  assert.equal((await git(pc.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${t.branch}`], t.token)).code, 0)
  // taken from the web while the PC is off: its epoch's branch stays behind
  await SE.take(f, await S.variationById(v.id), owner, { role: 'owner' })
  assert.ok(await G.head(f.repo_path, `refs/heads/${t.branch}`))
  // another variation held on the PC right now, with a push on its epoch's branch
  const v2 = await personVar(f, owner, '지금 것')
  const pc2 = await onPc(f, v2, d)
  const t2 = await pushToken(pc2, v2)
  await commitIn(pc2.dir, { '둘.md': '둘\n' })
  assert.equal((await git(pc2.dir, ['push', '-q', remote(f), `HEAD:refs/heads/${t2.branch}`], t2.token)).code, 0)
  const GC = await import('../lib/folders/gc.js')
  const r = await GC.gcFolder(await S.folderById(f.id))
  assert.equal(r.seatBranches, 1)
  assert.equal(await G.head(f.repo_path, `refs/heads/${t.branch}`), null, '지난 회차의 가지는 지움')
  assert.ok(await G.head(f.repo_path, `refs/heads/${t2.branch}`), '지금 회차의 가지는 그대로')
  assert.equal(await SL.dropOldSeatBranches(await S.folderById(f.id)), 0, '두 번째는 할 일 없음')
})
