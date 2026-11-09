// Robo-DLC Lite P1 end to end against a running server (docs/robo-dlc/plan-team.md): roles, the watcher's
// Home card to the person in the stage's role, the decision page, the choice typed into the session's
// prompt, the answers written into a question file. The session is a stand-in in tmux (it prints a Claude
// Code prompt screen and records the keys it gets), so the test costs no model calls.
// Needs the server with the watcher on (PRO_E2E_API, PRO_AIDLC_WATCH=1); skipped when it is not up.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pool, q } from '../lib/supa.js'
import { config } from '../config.js'

const API = process.env.PRO_E2E_API || 'http://127.0.0.1:8787/api'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'aidlc-project')
const SCREEN = path.join(HERE, 'fixtures', 'aidlc-screens', 'approval.txt')
const up = await fetch(`${API}/config`).then((r) => r.ok).catch(() => false)
const login = async (email) => (await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json())
const call = async (tok, method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const tok = (u) => u.session.access_token
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(1000) }
  throw new Error(`timeout: ${what}`)
}
const tmux = (...a) => execFileSync('tmux', ['-L', config.aidlcTmuxSocket, ...a], { encoding: 'utf8' })

let lead, po, out, repo, folder, name, keys
const tenant = 'localhost'

test('준비: AI-DLC 저장소, 팀 리드(소유)·PO(편집)·외부인, PO 역할', { skip: !up }, async () => {
  const stamp = Date.now()
  ;[lead, po, out] = await Promise.all(['lead', 'po', 'out'].map((x) => login(`rdlc-team-${x}-${stamp}@pgpt.test`)))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-team-'))
  await fs.cp(FIXTURE, repo, { recursive: true })
  const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@pgpt.test', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'AI-DLC record')
  const r = await call(tok(lead), 'POST', '/folders/link', { path: repo, name: `AI-DLC 팀 시험 ${stamp}` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  folder = r.body
  assert.equal((await call(tok(lead), 'POST', `/folders/${folder.slug}/members`, { type: 'user', id: po.user.id, role: 'editor' })).status, 200)
  const roles = await call(tok(lead), 'PUT', `/aidlc/${folder.slug}/roles`, { roleKey: 'product', userIds: [po.user.id] })
  assert.equal(roles.status, 200, JSON.stringify(roles.body))
  assert.deepEqual(roles.body.find((x) => x.roleKey === 'product').people.map((p) => p.id), [po.user.id])
  // only the folder's own members can be given a role; an outsider sees nothing
  assert.equal((await call(tok(lead), 'PUT', `/aidlc/${folder.slug}/roles`, { roleKey: 'architect', userIds: [out.user.id] })).status, 400)
  assert.equal((await call(tok(out), 'GET', `/aidlc/${folder.slug}/decide`)).status, 403)
})

test('세션이 묻는 선택 창 → 단계 역할(PO)에게 홈 카드 → 결정 화면에서 고르면 그 번호가 세션에 들어간다', { skip: !up }, async () => {
  // the stand-in session: the approval prompt screen, then every key it gets goes to keys.log
  name = `aidlc-${tenant}-${folder.slug}`.replace(/[^A-Za-z0-9_-]/g, '_')
  keys = path.join(repo, '.keys.log')
  const script = path.join(repo, '.fake-claude.sh')
  await fs.writeFile(script, `#!/bin/bash\ncat ${JSON.stringify(SCREEN)}\nwhile IFS= read -rsn1 k; do printf '%s' "$k" >> ${JSON.stringify(keys)}; done\n`, { mode: 0o755 })
  tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', script)
  const ses = await until(async () => { const s = (await call(tok(po), 'GET', `/aidlc/${folder.slug}/session`)).body; return s?.choice && s }, 15000, 'the prompt on screen')
  assert.equal(ses.running, true)
  assert.equal(ses.choice.title, 'Approval')
  // the watcher's card reaches the PO (the requirements stage is the PO's), once
  const card = await until(async () => {
    const list = (await call(tok(po), 'GET', '/notifications')).body || []
    return list.find((n) => n.type === 'aidlc' && String(n.url).startsWith(`/aidlc/${folder.slug}/decide`))
  }, 30000, 'the PO card')
  assert.match(card.title, /승인/)
  assert.ok(!((await call(tok(lead), 'GET', '/notifications')).body || []).some((n) => n.type === 'aidlc' && String(n.url).startsWith(`/aidlc/${folder.slug}/`)), 'not the lead\'s card')
  const v = (await call(tok(po), 'GET', `/aidlc/${folder.slug}/decide`)).body
  assert.equal(v.stage.slug, 'requirements-analysis')
  assert.equal(v.role, 'PO·기획')
  assert.equal(v.canDecide, true)
  assert.equal(v.session.choice.kind, 'approval')
  // a stale screen is refused; the right one types the number
  assert.equal((await call(tok(po), 'POST', `/aidlc/${folder.slug}/decide`, { fingerprint: 'stale', option: 1 })).status, 409)
  const d = await call(tok(po), 'POST', `/aidlc/${folder.slug}/decide`, { fingerprint: v.session.choice.fingerprint, option: 1 })
  assert.equal(d.status, 200, JSON.stringify(d.body))
  assert.equal(d.body.answered, 'Approve')
  assert.equal(await until(() => fs.readFile(keys, 'utf8').then((k) => k.includes('1') && k), 10000, 'the key'), '1')
  const ledger = (await call(tok(po), 'GET', `/aidlc/${folder.slug}/decide`)).body.ledger
  assert.equal(ledger[0].choice, 'Approve')
})

test('세션이 끝나면 카드는 홈에서 내려가고, 답이 빈 질문 파일이 다음 대기가 된다', { skip: !up }, async () => {
  tmux('kill-session', '-t', name)
  await until(async () => !((await call(tok(po), 'GET', '/notifications')).body || []).some((n) => n.type === 'aidlc' && /승인/.test(n.title) && String(n.url).startsWith(`/aidlc/${folder.slug}/`)), 30000, 'the approval card leaving Home')
  const qcard = await until(async () => ((await call(tok(po), 'GET', '/notifications')).body || []).find((n) => n.type === 'aidlc' && /질문 3개/.test(n.title) && String(n.url).startsWith(`/aidlc/${folder.slug}/`)), 30000, 'the questions card')
  assert.ok(qcard)
  const v = (await call(tok(po), 'GET', `/aidlc/${folder.slug}/decide`)).body
  const f = v.questions.find((x) => x.open > 0)
  assert.equal(f.open, 3)
  const a = await call(tok(po), 'POST', `/aidlc/${folder.slug}/answers`, { path: f.path, answers: { Q1: 'A', Q2: 'B', Q3: 'A' } })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.deepEqual(a.body.written, { Q1: 'A', Q2: 'B', Q3: 'A' })
  assert.equal(a.body.told, false, 'no session to tell')
  const text = await fs.readFile(path.join(repo, 'aidlc/spaces/default/intents/261109-todo-web-app', f.path), 'utf8')
  assert.match(text, /\[Answer\]: B/)
  // outside the record or not a question file: refused
  assert.equal((await call(tok(po), 'POST', `/aidlc/${folder.slug}/answers`, { path: '../../../../etc/hosts', answers: { Q1: 'A' } })).status, 404)
})

after(async () => {
  try { if (name) tmux('kill-session', '-t', name) } catch { /* gone */ }
  if (repo) {
    const [f] = await q('select id from pro_folders where repo_path=$1', [path.resolve(repo)]).catch(() => [])
    if (f) for (const t of ['pro_aidlc_roles', 'pro_aidlc_decisions', 'pro_aidlc_waits', 'pro_aidlc_proposals', 'pro_aidlc_mobs']) await q(`delete from ${t} where folder_id=$1`, [f.id]).catch(() => {})
    await q(`update notifications set is_checked=true where type='aidlc' and url like $1`, [`/aidlc/${folder?.slug}/%`]).catch(() => {})
    await q('delete from pro_folder_members where folder_id in (select id from pro_folders where repo_path=$1)', [path.resolve(repo)]).catch(() => {})
    await q('delete from pro_folders where repo_path=$1', [path.resolve(repo)]).catch(() => {})
    await fs.rm(repo, { recursive: true, force: true })
  }
  await pool.end().catch(() => {})
})
