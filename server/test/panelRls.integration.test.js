// 패널 앱 db 단계 통합 시험 — 실제 데이터베이스에서 RLS 가 지키는지 본다.
// 1) 서버 없이: 임시 폴더·구성원을 만들고, 컴파일한 표에 사용자 A·B·외부인으로 직접 접속(set local role
//    authenticated + request.jwt.claims)해 남의 행 고치기·지우기·비공개 보기·승인 항목·작성자 위조가 막히는지.
// 2) pgpt-pro 서버(:8787)가 떠 있으면: 실제 로그인 JWT 로 PostgREST(:54321, Accept-Profile: panel_data)를
//    직접 불러 A 가 B 의 행을 고칠 수 없는지.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { pool, q } from '../lib/supa.js'
import { config } from '../config.js'
import * as R from '../lib/panelApps/rules.js'
import * as D from '../lib/panelApps/db.js'
import { normalizeDef } from '../lib/panelApps/sheet.js'

const uid = () => crypto.randomUUID()
const A = uid(), B = uid(), OWNER = uid(), OUT = uid()
const FID = uid(), APP = uid()
const def = normalizeDef({
  title: 'RLS 시험 캘린더', tier: 'db',
  fields: [
    { key: 'title', label: '제목', type: 'text', required: true },
    { key: 'visibility', label: '공개 범위', type: 'choice', choices: ['공개', '비공개', "x'); drop table pro_folders; --"] },
    { key: 'approved', label: '승인', type: 'checkbox' },
  ],
  access: { read: ['owner_of_row', { field_equals: { field: 'visibility', value: '공개' } }], create: ['member'], update: ['owner_of_row', 'role>=owner'], delete: ['owner_of_row', 'role>=owner'] },
  fieldRules: { approved: { update: ['role>=owner'] } },
}, { strict: true })
const app = { id: APP, def }

// a raw connection as one person, exactly what PostgREST would do for their JWT
async function as(user, sql, params = []) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role authenticated')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })])
    const r = await c.query(sql, params)
    await c.query('commit')
    return r
  } catch (e) { await c.query('rollback'); throw e } finally { c.release() }
}
const T = R.qualified(APP)

test('준비: 임시 폴더·구성원·표', async () => {
  await q(`insert into pro_folders (id, tenant_id, slug, name, repo_path) values ($1,'rls-test',$2,$2,'/nonexistent')`, [FID, `rls-${FID.slice(0, 8)}`])
  for (const [u, role] of [[A, 'editor'], [B, 'editor'], [OWNER, 'owner']]) await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,$3)`, [FID, u, role])
  await D.asOwner(R.createSql(def, APP, FID))
  assert.equal((await q('select count(*)::int as n from pro_folders')).length, 1) // the quoted choice did not drop anything
})

let rowA, rowB, privB
test('구성원은 자기 행을 만들고, 작성자는 위조할 수 없다', async () => {
  rowA = (await as(A, `insert into ${T} (c_title, c_visibility) values ('A 일정', '공개') returning id, created_by`)).rows[0]
  rowB = (await as(B, `insert into ${T} (c_title, c_visibility, created_by) values ('B 일정', '공개', $1) returning id, created_by`, [A])).rows[0]
  privB = (await as(B, `insert into ${T} (c_title, c_visibility) values ('B 비공개', '비공개') returning id`)).rows[0]
  assert.equal(rowA.created_by, A)
  assert.equal(rowB.created_by, B, 'created_by 를 A 로 보내도 B 로 기록된다')
})

test('A 는 B 의 행을 고치거나 지울 수 없다 (데이터베이스가 거절)', async () => {
  const u = await as(A, `update ${T} set c_title = '덮어쓰기' where id = $1`, [rowB.id])
  assert.equal(u.rowCount, 0)
  const d = await as(A, `delete from ${T} where id = $1`, [rowB.id])
  assert.equal(d.rowCount, 0)
  const still = await q(`select c_title from ${T} where id = $1`, [rowB.id])
  assert.equal(still[0].c_title, 'B 일정')
  // the server path reports it as a refusal
  await assert.rejects(D.update({ id: A }, app, rowB.id, null, { title: 'x' }), (e) => e.status === 403)
})

test('비공개 행은 만든 사람만 본다 (폴더 소유자도 못 봄)', async () => {
  const seenA = (await as(A, `select c_title from ${T} order by created_at`)).rows.map((r) => r.c_title)
  const seenO = (await as(OWNER, `select c_title from ${T} order by created_at`)).rows.map((r) => r.c_title)
  const seenB = (await as(B, `select c_title from ${T} order by created_at`)).rows.map((r) => r.c_title)
  assert.deepEqual(seenA, ['A 일정', 'B 일정'])
  assert.deepEqual(seenO, ['A 일정', 'B 일정'])
  assert.deepEqual(seenB, ['A 일정', 'B 일정', 'B 비공개'])
})

test('폴더 소유자는 남의 공개 행을 고칠 수 있다', async () => {
  const u = await as(OWNER, `update ${T} set c_title = '소유자가 고침' where id = $1`, [rowA.id])
  assert.equal(u.rowCount, 1)
})

test('승인 항목은 소유자만 (항목 단위 트리거)', async () => {
  await assert.rejects(as(A, `update ${T} set c_approved = true where id = $1`, [rowA.id]), /panel_field_denied:approved/)
  const u = await as(OWNER, `update ${T} set c_approved = true where id = $1`, [rowA.id])
  assert.equal(u.rowCount, 1)
  // created_by cannot be moved to someone else either
  await as(A, `update ${T} set created_by = $2 where id = $1`, [rowA.id, B])
  assert.equal((await q(`select created_by from ${T} where id = $1`, [rowA.id]))[0].created_by, A)
})

test('외부인은 아무것도 보지도 만들지도 못한다', async () => {
  assert.equal((await as(OUT, `select * from ${T}`)).rowCount, 0)
  await assert.rejects(as(OUT, `insert into ${T} (c_title) values ('침입')`), /row-level security/)
  // anon has no grant at all
  const c = await pool.connect()
  try {
    await c.query('begin'); await c.query('set local role anon')
    await assert.rejects(c.query(`select * from ${T}`), /permission denied/)
  } finally { await c.query('rollback'); c.release() }
})

// ---------- PostgREST with real JWTs (needs the pgpt-pro server for demo login) ----------
const API = 'http://127.0.0.1:8787/api'
const login = async (email) => (await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json())
test('PostgREST: A 의 JWT 로 B 의 행을 PATCH 해도 바뀌지 않는다', async (t) => {
  const up = await fetch(`${API}/config`).then((r) => r.ok).catch(() => false)
  if (!up) return t.skip('pgpt-pro 서버가 꺼져 있음')
  const la = await login('rls-it-a@pgpt.test'), lb = await login('rls-it-b@pgpt.test')
  const a = la.user.id, b = lb.user.id
  for (const u of [a, b]) await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'editor') on conflict do nothing`, [FID, u])
  const rest = (tok, method, query, body, profile = 'Accept-Profile') => fetch(`${config.supabaseUrl}/rest/v1/${R.tableName(APP)}${query}`, {
    method, body: body && JSON.stringify(body),
    headers: { apikey: config.anonKey, Authorization: `Bearer ${tok}`, [profile]: 'panel_data', 'Content-Type': 'application/json', Prefer: 'return=representation' },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  await new Promise((ok) => setTimeout(ok, 1500)) // PostgREST reloads its schema cache (notified by asOwner)
  const made = await rest(lb.session.access_token, 'POST', '', { c_title: 'B 의 PostgREST 일정', c_visibility: '공개' }, 'Content-Profile')
  assert.equal(made.status, 201)
  const id = made.body[0].id
  assert.equal(made.body[0].created_by, b)
  const patched = await rest(la.session.access_token, 'PATCH', `?id=eq.${id}`, { c_title: 'A 가 덮어씀' }, 'Content-Profile')
  assert.deepEqual(patched.body, [])
  const del = await rest(la.session.access_token, 'DELETE', `?id=eq.${id}`, null, 'Content-Profile')
  assert.deepEqual(del.body, [])
  assert.equal((await q(`select c_title from ${T} where id = $1`, [id]))[0].c_title, 'B 의 PostgREST 일정')
  const anon = await fetch(`${config.supabaseUrl}/rest/v1/${R.tableName(APP)}`, { headers: { apikey: config.anonKey, 'Accept-Profile': 'panel_data' } })
  assert.ok(anon.status === 401 || anon.status === 403 || (anon.status === 200 && (await anon.json()).length === 0))
})

after(async () => {
  await D.asOwner([`drop table if exists ${T}`, `drop function if exists panel_data.${R.ident(`${R.tableName(APP)}_guard`)}()`]).catch(() => {})
  await q('delete from pro_folders where id=$1', [FID]).catch(() => {})
  await pool.end()
})
