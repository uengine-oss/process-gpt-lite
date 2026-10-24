// 기본 보안 — 모든 통로에서 같은 규칙: 다른 구성원의 민감 항목(휴가 사유)은 패널 API·MCP 도구·시트 보기·
// 폴더 스냅샷·검색 어디에서도 보이지 않고, 외부인은 앱 목록·건수까지 아무것도 못 본다.
// pgpt-pro 서버(:8787)가 떠 있어야 한다(없으면 건너뜀). 모델 호출 없이 고정 정의로 앱을 만든다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { pool, q } from '../lib/supa.js'
import * as P from '../lib/panelApps/service.js'
import * as E from '../lib/panelApps/events.js'

const API = 'http://127.0.0.1:8787/api'
const up = await fetch(`${API}/config`).then((r) => r.ok).catch(() => false)
const login = async (email) => (await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json())
const call = (tok, method, path, body) => fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
const mcp = (tok, name, args) => fetch('http://127.0.0.1:8787/mcp/panelapps', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.json())

const SECRET = '정신건강의학과 진료'
let o, m, m2, out, app
test('준비: 소유자·구성원 둘·외부인, 휴가 앱(사유=민감)', { skip: !up }, async () => {
  const stamp = Date.now()
  ;[o, m, m2, out] = await Promise.all(['owner', 'm1', 'm2', 'out'].map((x) => login(`pv-${x}-${stamp}@pgpt.test`)))
  const def = E.normalizeEventsDef({
    kind: 'events', title: `개인정보 시험 ${stamp}`, entity: { key: 'member', label: '팀원', type: 'person' },
    fields: [{ key: 'days', label: '일수', type: 'number' }, { key: 'reason', label: '사유', type: 'longtext' }],
    events: [{ type: 'grant', label: '휴가 부여', fields: ['days'], manager: true }, { type: 'request', label: '휴가 신청', fields: ['days', 'reason'], required: ['days'] }],
    projections: [{ kind: 'balance', key: 'summary', label: '요약', columns: [{ key: 'used', label: '사용', terms: [{ event: 'request', field: 'days' }] }] }],
  }, { secure: true })
  const owner = { id: o.user.id, name: '소유자', email: o.user.email, jwt: o.session.access_token }
  app = await P.createApp(owner, { description: '', def })
  for (const u of [m, m2]) assert.equal((await call(o.session.access_token, 'POST', `/folders/${app.folder.slug}/members`, { type: 'user', id: u.user.id, role: 'runner' })).status, 200)
  const r = await call(m.session.access_token, 'POST', `/panel-apps/${app.id}/events`, { type: 'request', entity: m.user.id, values: { days: 1, reason: SECRET } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('패널 API: 다른 구성원에게 사유는 비공개, 본인·소유자에게는 보임', { skip: !up }, async () => {
  const seen = async (u) => (await call(u.session.access_token, 'GET', `/panel-apps/${app.id}/rows`)).body.events.find((e) => e.type === 'request')
  assert.equal((await seen(m2)).reason, '')
  assert.deepEqual((await seen(m2))._hidden, ['reason'])
  assert.equal((await seen(m)).reason, SECRET)
  assert.equal((await seen(o)).reason, SECRET)
  const [a] = await q(`select count(*)::int as n from pro_panel_app_audit where app_id=$1 and action='read_sensitive'`, [app.id])
  assert.ok(a.n >= 1, '관리자의 민감 항목 열람은 감사 기록에 남음')
})

test('MCP 도구: 같은 사용자 권한으로 — 사유는 (비공개)', { skip: !up }, async () => {
  const r = await mcp(m2.session.access_token, 'panel_app_rows', { app: app.id })
  const text = r.result.content[0].text
  assert.ok(!text.includes(SECRET))
  assert.ok(text.includes('(비공개)'))
})

test('시트 보기: 그 사람이 볼 수 있는 것만 담긴 사본', { skip: !up }, async () => {
  const s = await call(m2.session.access_token, 'POST', `/panel-apps/${app.id}/sheet`)
  assert.equal(s.status, 200)
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await (await fetch(s.body.url)).arrayBuffer()))
  const cells = []
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value?.result ?? c.value ?? '')))))
  assert.ok(!cells.some((c) => c.includes(SECRET)))
  assert.ok(cells.includes('비공개'))
})

test('폴더 스냅샷·검색: 민감 값은 폴더 파일·색인에 들어가지 않음', { skip: !up }, async () => {
  const snap = await call(o.session.access_token, 'POST', `/panel-apps/${app.id}/snapshot`)
  assert.equal(snap.status, 200, JSON.stringify(snap.body))
  const [f] = await q('select repo_path from pro_folders where slug=$1', [app.folder.slug])
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(`${f.repo_path}/${snap.body.path}`)
  const cells = []
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value?.result ?? c.value ?? '')))))
  assert.ok(!cells.some((c) => c.includes(SECRET)), '폴더 스냅샷에 민감 값 없음')
  const found = await call(m2.session.access_token, 'GET', `/folders/search?q=${encodeURIComponent('정신건강')}`)
  assert.ok(!JSON.stringify(found.body).includes(SECRET))
})

test('외부인: 앱 목록·데이터·건수·MCP 모두 없음', { skip: !up }, async () => {
  const t = out.session.access_token
  assert.deepEqual((await call(t, 'GET', '/panel-apps')).body, [])
  assert.equal((await call(t, 'GET', `/panel-apps/${app.id}/rows`)).status, 403)
  assert.equal((await call(t, 'POST', `/panel-apps/${app.id}/sheet`)).status, 403)
  assert.equal((await call(t, 'POST', `/panel-apps/${app.id}/events`, { type: 'request', entity: out.user.id, values: { days: 1 } })).status, 403)
  const l = await mcp(t, 'panel_app_list', {})
  assert.match(l.result.content[0].text, /쓸 수 있는 패널 앱이 없어요/)
})

after(async () => {
  if (app) await P.remove({ id: o.user.id, name: '소유자', email: o.user.email, jwt: o.session.access_token }, app.id).catch(() => {})
  await pool.end()
})
