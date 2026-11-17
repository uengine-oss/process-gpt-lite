// 프로젝트·채팅의 폴더 — HTTP 끝에서 끝까지(개발 BFF, en-demo): 폴더를 만들고 → 그 폴더로 새 프로젝트 →
// 파일을 고치는 한 턴 → 프로젝트 변형에 담기고 main 은 그대로 → 채팅에 참고로 붙이고 읽는 질문 → 변형 없이 답 →
// 이름을 안 적은 변경 요청은 붙인 폴더의 짧은 변형으로 → 떼기 → 만든 것 모두 지우기.
// 서버(PRO_E2E_API, 기본 :8793)와 deepagents 가 떠 있어야 한다(서버가 없으면 건너뜀). 에이전트 턴이라 몇 분 걸릴 수 있다.
// Run: PRO_TENANT_ID=en-demo node --test test/threadFolders.e2e.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pool, q, admin } from '../lib/supa.js'
import { config } from '../config.js'

const API = process.env.PRO_E2E_API || 'http://127.0.0.1:8793/api'
const up = await fetch(`${API}/config`).then((r) => r.ok).catch(() => false)
const stamp = Date.now()
const EMAIL = `pro-en-fix-tf${stamp}@uengine.org`
let tok, me, slug, project, main
const call = (method, p, body) => fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-PGL-Lang': 'ko' }, body: body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
// one chat turn; the final message (the SSE stream's done event)
async function turn(threadId, text) {
  const r = await fetch(`${API}/threads/${threadId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-PGL-Lang': 'ko' }, body: JSON.stringify({ text }) })
  const body = await r.text()
  const done = /event: done\ndata: (.*)/.exec(body)?.[1]
  return done ? JSON.parse(done) : { content: { text: body.slice(-400) } }
}
const raw = (p, ref = 'main') => fetch(`${API}/folders/${slug}/raw?path=${encodeURIComponent(p)}&ref=${ref}`, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.text())
const NOTICE = '# 안내문\n모임 장소는 보라색 회의실이에요.\n'
const unreachable = (m) => /에이전트에 연결하지 못했어요|응답하지 않아 기다리기를 멈췄어요/.test(m?.content?.text || '')

after(async () => {
  try {
    if (!me) return
    const threads = (await q('select id, conversation_id from pro_threads where user_id=$1', [me])).map((t) => t.conversation_id).filter(Boolean)
    const folders = await q('select id, slug, repo_path from pro_folders where tenant_id=$1 and created_by=$2', [config.tenantId, me])
    const rooms = [...threads, ...(await q(`select source->>'room_id' as r from pro_folder_variations where folder_id = any($1)`, [folders.map((f) => f.id)])).map((x) => x.r).filter(Boolean)]
    await q('delete from pro_threads where user_id=$1', [me])
    for (const t of ['pro_actions', 'pro_team_members', 'pro_role_assignments']) await q(`delete from ${t} where user_id=$1`, [me]).catch(() => {})
    await q('delete from context_threads where tenant_id=$1 and user_id=$2', [config.tenantId, me]).catch(() => {})
    await q('delete from notifications where tenant_id=$1 and user_id=$2', [config.tenantId, me]).catch(() => {})
    for (const f of folders) { await q('delete from pro_folders where id=$1', [f.id]); await fs.rm(f.repo_path, { recursive: true, force: true }) }
    const { workspaceDir } = await import('../lib/folders/service.js')
    for (const room of rooms) {
      const keys = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`skills/${config.tenantId}/${room}/`])).map((r) => r.name)
      for (let i = 0; i < keys.length; i += 100) await admin.storage.from('files').remove(keys.slice(i, i + 100)).catch(() => {})
      await fs.rm(path.join(workspaceDir(), '.bpmn', room), { recursive: true, force: true }).catch(() => {})
    }
    await q('delete from pro_profile where user_id=$1', [me]).catch(() => {})
    await q('delete from users where id=$1', [me]).catch(() => {})
    await admin.auth.admin.deleteUser(me).catch(() => {})
  } finally { await pool.end() }
})

test('준비: 시험 계정 · 폴더 하나(안내문)', { skip: !up }, async () => {
  const login = await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: '000000' }) })).json()
  tok = login.session.access_token
  me = login.user.id
  const f = await call('POST', '/folders', { name: `프로젝트 폴더 e2e ${stamp}` })
  assert.equal(f.status, 200, JSON.stringify(f.body))
  slug = f.body.slug
  const u = await fetch(`${API}/folders/${slug}/files?path=notice.md`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/markdown' }, body: NOTICE })
  assert.equal(u.status, 200)
})

test('새 프로젝트를 그 폴더로: 프로젝트 = 그 폴더의 변형 하나 (첫 턴에 만듦)', { skip: !up }, async () => {
  const bad = await call('POST', '/threads', { text: '안내문 손보기', folder: 'no-such-folder-x' })
  assert.equal(bad.status, 404, '없는 폴더면 프로젝트를 만들지 않음')
  const r = await call('POST', '/threads', { text: '안내문 손보기', folder: slug })
  assert.equal(r.status, 200)
  project = r.body
  assert.equal(project.folder.mode, 'project')
  assert.equal(project.folder.slug, slug)
  assert.equal(project.folder.variation, null)
  const list = await call('GET', '/threads?kind=project')
  assert.equal(list.body.find((p) => p.id === project.id)?.folder?.slug, slug, '프로젝트 목록에도 폴더')
})

test('프로젝트에서 파일을 고치는 한 턴: 프로젝트 변형에 담기고 main 은 그대로', { skip: !up, timeout: 600000 }, async (t) => {
  const m = await turn(project.id, "notice.md 파일 맨 끝에 '확인함' 한 줄을 추가해 줘")
  const f = (await call('GET', `/threads/${project.id}/folder`)).body.folder
  assert.ok(f.variation, '변형이 생김')
  assert.match(f.variation.branch, /^var\/p\//)
  assert.equal(f.variation.status, 'ready')
  assert.equal(await raw('notice.md'), NOTICE, 'main 은 그대로')
  const [{ conversation_id: conv }] = await q('select conversation_id from pro_threads where id=$1', [project.id])
  assert.ok(conv, '프로젝트 대화가 정해짐')
  if (unreachable(m)) { t.diagnostic('deepagents 에 닿지 못함: 변형 만들기·꺼내기·커밋만 확인'); return }
  const d = (await call('GET', `/folders/${slug}/variations/${f.variation.id}`)).body
  assert.deepEqual(d.changes.map((c) => c.path), ['notice.md'], JSON.stringify(m.content))
  assert.match(await raw('notice.md', f.variation.id), /확인함/)
  const msgs = (await call('GET', `/threads/${project.id}/messages`)).body
  assert.ok(!msgs.some((x) => x.kind === 'folder_variation'), '턴마다 반영 카드를 붙이지 않음(머리의 반영이 반영 지점)')
  assert.ok(msgs.some((x) => x.kind === 'chip' && x.content.folderVariation === f.variation.id), '담았다는 칩')
})

test('채팅에 참고로 붙이기 → 읽는 질문은 변형 없이 답', { skip: !up, timeout: 600000 }, async (t) => {
  main = (await call('GET', '/threads')).body[0]
  const a = await call('POST', `/threads/${main.id}/folder`, { folder: slug })
  assert.equal(a.status, 200)
  assert.equal(a.body.folder.mode, 'ref')
  assert.equal(a.body.folder.working, false)
  assert.equal((await call('GET', '/threads')).body[0].folder.slug, slug)
  const m = await turn(main.id, '붙여 둔 폴더의 notice.md 에는 모임 장소가 어디라고 되어 있어? 한 줄로 알려 줘')
  const f = (await call('GET', `/threads/${main.id}/folder`)).body.folder
  assert.equal(f.variation, null, '읽기만: 변형 없음')
  const vs = (await call('GET', `/folders/${slug}`)).body.variations.filter((v) => v.kind === 'chat')
  assert.equal(vs.length, 0)
  if (unreachable(m)) { t.diagnostic('deepagents 에 닿지 못함: 답 내용은 확인 못 함'); return }
  assert.match(m.content.text, /보라색/, `붙인 폴더를 읽고 답함: ${m.content.text}`)
})

test('이름을 안 적은 변경 요청 → 붙인 폴더의 짧은 변형 · 반영 카드 · 칩은 변형 작업 중 · main 그대로', { skip: !up, timeout: 600000 }, async (t) => {
  const m = await turn(main.id, "notice.md 맨 끝에 '준비물: 노트북' 줄을 추가해 줘")
  if (unreachable(m)) { t.diagnostic('deepagents 에 닿지 못함'); return }
  const f = (await call('GET', `/threads/${main.id}/folder`)).body.folder
  assert.ok(f.variation, JSON.stringify(m.content))
  assert.match(f.variation.branch, /^var\/run\//)
  assert.equal(f.working, true)
  const msgs = (await call('GET', `/threads/${main.id}/messages`)).body
  assert.ok(msgs.some((x) => x.kind === 'folder_variation' && x.content.variation === f.variation.id), '반영할까요 카드')
  assert.equal(await raw('notice.md'), NOTICE, 'main 은 그대로')
  const d = await call('DELETE', `/threads/${main.id}/folder`)
  assert.equal(d.status, 200)
  assert.equal((await call('GET', '/threads')).body[0].folder, null)
  assert.equal((await call('GET', `/folders/${slug}/variations/${f.variation.id}`)).status, 200, '떼어도 변형은 폴더에 남음')
})
