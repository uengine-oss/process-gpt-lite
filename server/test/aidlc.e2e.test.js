// Robo-DLC Lite end to end against a running server: an AI-DLC repository linked as a shared folder,
// read by its members only, dashboards put on Home, and the working copy read live.
// Needs the server (PRO_E2E_API, default http://127.0.0.1:8787/api); skipped when it is not up.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pool, q } from '../lib/supa.js'

const API = process.env.PRO_E2E_API || 'http://127.0.0.1:8787/api'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aidlc-project')
const up = await fetch(`${API}/config`).then((r) => r.ok).catch(() => false)
const login = async (email) => (await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json())
const call = async (tok, method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

let owner, member, outsider, repo, folder
const created = []
const tok = (u) => u.session.access_token
const base = () => `/aidlc/${folder.slug}/intents/default`

test('준비: AI-DLC 저장소를 연결형 공유 폴더로, 구성원 한 명은 보기 권한', { skip: !up }, async () => {
  const stamp = Date.now()
  ;[owner, member, outsider] = await Promise.all(['owner', 'member', 'out'].map((x) => login(`rdlc-${x}-${stamp}@pgpt.test`)))
  for (const u of [owner, member, outsider]) assert.ok(tok(u), 'signed in')
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-e2e-'))
  await fs.cp(FIXTURE, repo, { recursive: true })
  const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@pgpt.test', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'AI-DLC record')
  const r = await call(tok(owner), 'POST', '/folders/link', { path: repo, name: `AI-DLC 시험 ${stamp}` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  folder = r.body
  const m = await call(tok(owner), 'POST', `/folders/${folder.slug}/members`, { type: 'user', id: member.user.id, role: 'viewer' })
  assert.equal(m.status, 200, JSON.stringify(m.body))
})

test('구성원에게만 보인다: 프로젝트 목록과 요약', { skip: !up }, async () => {
  const mine = await call(tok(member), 'GET', '/aidlc/projects')
  const p = mine.body.find((x) => x.folder === folder.slug)
  assert.ok(p, 'member sees the project')
  assert.deepEqual(p.intents.map((i) => i.slug).sort(), ['todo-web-app', 'voice-parking'])
  const theirs = await call(tok(outsider), 'GET', '/aidlc/projects')
  assert.ok(!theirs.body.some((x) => x.folder === folder.slug), 'outsider does not')
  const denied = await call(tok(outsider), 'GET', `${base()}/voice-parking/summary`)
  assert.equal(denied.status, 403)
})

test('요약: 끝난 실습(classic)과 진행 중인 poc', { skip: !up }, async () => {
  const s = (await call(tok(member), 'GET', `${base()}/voice-parking/summary`)).body
  assert.equal(s.counts.approvals, 18)
  assert.equal(s.counts.rejections, 3)
  assert.equal(s.units.length, 5)
  assert.ok(s.units.every((u) => u.status === 'done'))
  assert.equal(s.waiting.length, 0)
  const t = (await call(tok(member), 'GET', `${base()}/todo-web-app/summary`)).body
  assert.equal(t.current.slug, 'requirements-analysis')
  assert.ok(t.questions.open >= 1)
  const tl = (await call(tok(member), 'GET', `${base()}/voice-parking/timeline?limit=5`)).body
  assert.equal(tl.length, 5)
  const qs = (await call(tok(member), 'GET', `${base()}/todo-web-app/questions`)).body
  assert.ok(qs.some((f) => f.open > 0 && f.stageName))
  const rv = (await call(tok(member), 'GET', `${base()}/voice-parking/reviews`)).body
  assert.ok(rv.some((r) => r.verdict === 'NOT-READY'))
})

test('경로: 폴더 밖이나 없는 작업은 거절', { skip: !up }, async () => {
  for (const p of [`${base()}/..%2F..%2Fx/summary`, `/aidlc/${folder.slug}/intents/..%2F/voice-parking/summary`, `${base()}/nope/summary`]) {
    const r = await call(tok(member), 'GET', p)
    assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`)
  }
})

test('대시보드 6개를 내 홈에, 외부인·없는 작업은 거절', { skip: !up }, async () => {
  const r = await call(tok(member), 'POST', `/aidlc/${folder.slug}/panels`, { space: 'default', slug: 'voice-parking' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.length, 6)
  created.push(...r.body.map((p) => [tok(member), p.id]))
  const home = (await call(tok(member), 'GET', '/panels')).body
  assert.deepEqual(home.filter((p) => p.spec?.aidlc).map((p) => p.spec.aidlc).sort(), ['bolts', 'quality', 'questions', 'status', 'timeline', 'wait'])
  assert.ok(home.every((p) => !p.spec?.aidlc || p.data.folder === folder.slug))
  assert.equal((await call(tok(outsider), 'POST', `/aidlc/${folder.slug}/panels`, { space: 'default', slug: 'voice-parking' })).status, 403)
  assert.equal((await call(tok(member), 'POST', `/aidlc/${folder.slug}/panels`, { space: 'default', slug: 'nope' })).status, 404)
})

test('작업 사본을 바로 읽는다: 승인 대기가 생기면 요약에 대기 시간이 나온다', { skip: !up }, async () => {
  const dir = path.join(repo, 'aidlc/spaces/default/intents/261109-todo-web-app/audit')
  const [shard] = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'))
  const at = new Date(Date.now() - 3 * 60000).toISOString().replace(/\.\d+Z$/, 'Z')
  await fs.appendFile(path.join(dir, shard), `\n---\n\n## Stage Awaiting Approval\n**Timestamp**: ${at}\n**Event**: STAGE_AWAITING_APPROVAL\n**Stage**: requirements-analysis\n`)
  const s = (await call(tok(member), 'GET', `${base()}/todo-web-app/summary`)).body
  const w = s.waiting.find((x) => x.slug === 'requirements-analysis')
  assert.ok(w, JSON.stringify(s.waiting))
  assert.ok(w.minutes >= 2.5 && w.minutes < 10, String(w.minutes))
  assert.equal(w.role, 'PO·기획')
})

after(async () => {
  for (const [t, id] of created) await call(t, 'DELETE', `/panels/${id}`).catch(() => {})
  if (repo) {
    // a linked folder is one per repository path (lib/folders/service.js linkRepo)
    await q('delete from pro_folder_members where folder_id in (select id from pro_folders where repo_path=$1)', [path.resolve(repo)]).catch(() => {})
    await q('delete from pro_folders where repo_path=$1', [path.resolve(repo)]).catch(() => {})
  }
  if (repo) await fs.rm(repo, { recursive: true, force: true })
  await pool.end().catch(() => {})
})
