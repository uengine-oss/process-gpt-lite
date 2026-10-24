// 이벤트 앱 db 단계 통합 시험 — 실제 데이터베이스에서:
//   기록 종류별 추가 권한(RLS), 추가만 됨(수정·삭제 불가), 취소는 원래 기록의 주인만·한 번만,
//   민감 항목은 표에서 select 권한 없음·가린 보기에서만(본인·소유자), 외부인은 아무것도,
//   PostgREST 로 실제 JWT 를 써서 직접 불러도 같은 결과.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { pool, q } from '../lib/supa.js'
import { config } from '../config.js'
import * as R from '../lib/panelApps/rules.js'
import * as D from '../lib/panelApps/db.js'
import * as E from '../lib/panelApps/events.js'

const uid = () => crypto.randomUUID()
const M = uid(), M2 = uid(), OWNER = uid(), OUT = uid()
const FID = uid(), APP = uid()
const def = E.normalizeEventsDef({
  kind: 'events', title: '휴가 시험', entity: { key: 'member', label: '팀원', type: 'person' },
  fields: [{ key: 'days', label: '일수', type: 'number' }, { key: 'reason', label: '사유', type: 'longtext' }],
  events: [
    { type: 'grant', label: '휴가 부여', fields: ['days'], required: ['days'], manager: true },
    { type: 'request', label: '휴가 신청', fields: ['days', 'reason'], required: ['days'] },
    { type: 'cancel', label: '휴가 취소', fields: [], ref: { types: ['request'], mode: 'cancel', inherit: ['days'] } },
  ],
  projections: [{ kind: 'balance', key: 'summary', label: '요약', columns: [{ key: 'used', label: '사용', terms: [{ event: 'request', field: 'days' }, { event: 'cancel', field: 'days', sign: -1 }] }] }],
}, { secure: true })
const T = R.qualified(APP)
const V = `panel_data.${R.ident(R.viewName(APP))}`
async function as(user, sql, params = []) {
  const c = await pool.connect()
  try {
    await c.query('begin'); await c.query('set local role authenticated')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })])
    const r = await c.query(sql, params); await c.query('commit'); return r
  } catch (e) { await c.query('rollback'); throw e } finally { c.release() }
}

test('준비: 사유는 민감, 표는 db 단계', async () => {
  assert.equal(def.tier, 'db')
  assert.equal(def.fields.find((f) => f.key === 'reason').sensitivity, 'sensitive')
  await q(`insert into pro_folders (id, tenant_id, slug, name, repo_path) values ($1,'ev-test',$2,$2,'/nonexistent')`, [FID, `ev-${FID.slice(0, 8)}`])
  for (const [u, role] of [[M, 'runner'], [M2, 'runner'], [OWNER, 'owner']]) await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,$3)`, [FID, u, role])
  await D.asOwner(E.createEventsSql(def, APP, FID))
})

let req
test('기록 종류별 권한: 부여는 관리자만, 신청은 본인 것만', async () => {
  await assert.rejects(as(M, `insert into ${T} ("type", "entity", c_days) values ('grant', $1, 30)`, [M]), /row-level security/)
  await as(OWNER, `insert into ${T} ("type", "entity", c_days) values ('grant', $1, 15)`, [M])
  await assert.rejects(as(M, `insert into ${T} ("type", "entity", c_days) values ('request', $1, 1)`, [M2]), /row-level security/)
  req = (await as(M, `insert into ${T} ("type", "entity", c_days, c_reason) values ('request', $1, 2, '병원 진료') returning id`, [M])).rows[0].id
  // by / at / id cannot be forged by the caller
  const r = await q(`select "by" from ${T} where id = $1`, [req])
  assert.equal(r[0].by, M)
})

test('추가만 됨: 수정·삭제는 권한도 없고, 소유자 계정(트리거)도 막힘', async () => {
  await assert.rejects(as(M, `update ${T} set c_days = 0 where id = $1`, [req]), /permission denied/)
  await assert.rejects(as(OWNER, `delete from ${T} where id = $1`, [req]), /permission denied/)
  await assert.rejects(q(`update ${T} set c_days = 0 where id = $1`, [req]), /panel_append_only/)
  await assert.rejects(q(`delete from ${T} where id = $1`, [req]), /panel_append_only/)
})

test('취소: 원래 기록의 주인만, 한 번만, 일수는 원래 기록에서', async () => {
  await assert.rejects(as(M2, `insert into ${T} ("type", "ref") values ('cancel', $1)`, [req]), /row-level security/)
  const c = (await as(M, `insert into ${T} ("type", "ref", "entity", c_days) values ('cancel', $1, 'x', 99) returning id`, [req])).rows[0].id
  const row = (await q(`select "entity", c_days::float8 as d from ${T} where id = $1`, [c]))[0]
  assert.equal(row.entity, M, '대상은 원래 기록에서')
  assert.equal(row.d, 2, '일수도 원래 기록에서(99 는 무시)')
  await assert.rejects(as(M, `insert into ${T} ("type", "ref") values ('cancel', $1)`, [req]), /panel_ref_closed/)
  const used = E.replay(def, await D.eventsAsOwner({ id: APP, def })).projections.summary.find((x) => x.entity === M).used
  assert.equal(used, 0)
})

test('민감 항목: 표에서는 select 불가, 가린 보기에서는 본인·소유자만', async () => {
  await assert.rejects(as(M2, `select c_reason from ${T}`), /permission denied/)
  const seen = async (u) => (await as(u, `select c_reason, _hidden from ${V} where id = $1`, [req])).rows[0]
  assert.equal((await seen(M2)).c_reason, null)
  assert.deepEqual((await seen(M2))._hidden, ['reason'])
  assert.equal((await seen(M)).c_reason, '병원 진료')
  assert.equal((await seen(OWNER)).c_reason, '병원 진료')
  // the server path (D.events) returns the same masking
  const evs = await D.events({ id: M2 }, { id: APP, def })
  assert.equal(evs.find((e) => e.id === req).reason, '')
  assert.deepEqual(evs.find((e) => e.id === req)._hidden, ['reason'])
})

test('외부인: 기록도, 건수도, 추가도 없음', async () => {
  assert.equal((await as(OUT, `select count(*)::int as n from ${V}`)).rows[0].n, 0)
  assert.equal((await as(OUT, `select count(*)::int as n from ${T}`)).rows[0].n, 0)
  await assert.rejects(as(OUT, `insert into ${T} ("type", "entity", c_days) values ('request', $1, 1)`, [OUT]), /row-level security/)
})

const API = 'http://127.0.0.1:8787/api'
const login = async (email) => (await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json())
test('PostgREST: 실제 JWT 로도 민감 열은 표에서 막히고, 보기는 가려짐', async (t) => {
  if (!(await fetch(`${API}/config`).then((r) => r.ok).catch(() => false))) return t.skip('pgpt-pro 서버가 꺼져 있음')
  const lm = await login('ev-it-member@pgpt.test')
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'runner') on conflict do nothing`, [FID, lm.user.id])
  await new Promise((ok) => setTimeout(ok, 1500))
  const get = (path) => fetch(`${config.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: config.anonKey, Authorization: `Bearer ${lm.session.access_token}`, 'Accept-Profile': 'panel_data' } }).then(async (r) => ({ status: r.status, body: await r.json() }))
  const base = await get(`${R.tableName(APP)}?select=id,c_reason`)
  assert.notEqual(base.status, 200, '민감 열을 표에서 직접 읽을 수 없음')
  const view = await get(`${R.viewName(APP)}?select=id,c_reason,_hidden&id=eq.${req}`)
  assert.equal(view.status, 200)
  assert.equal(view.body[0].c_reason, null)
  const patch = await fetch(`${config.supabaseUrl}/rest/v1/${R.tableName(APP)}?id=eq.${req}`, { method: 'PATCH', headers: { apikey: config.anonKey, Authorization: `Bearer ${lm.session.access_token}`, 'Content-Profile': 'panel_data', 'Content-Type': 'application/json' }, body: JSON.stringify({ c_days: 0 }) })
  assert.notEqual(patch.status, 200)
  assert.notEqual(patch.status, 204)
})

after(async () => {
  await D.asOwner([`drop table if exists ${T} cascade`, `drop function if exists panel_data.${R.ident(`${R.tableName(APP)}_guard`)}()`]).catch(() => {})
  await q('delete from pro_folders where id=$1', [FID]).catch(() => {})
  await pool.end()
})
