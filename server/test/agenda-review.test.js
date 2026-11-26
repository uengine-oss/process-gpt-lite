// 약속 알림 리뷰 반영(PR #95 검토) — DB · 모델 없이. 고치기 전 코드에서 먼저 돌려 실패를 확인한 시험이다.
//   RV-U-01 (#1) 메일 약속의 링크는 알림 글(Home 알림 · 휴대폰 푸시)에 넣지 않는다 — 대화방 약속의 링크는 그대로
//   RV-U-02 (#1) Home 카드에는 링크를 그 주소의 도메인으로, 메일 약속이면 「보낸 사람」과 함께 보인다
//   RV-U-03 (#9) 판정이 보는 글은 줄인다: 새 메시지는 마지막 15개, 한 메시지 300자, 메일 본문 1000자
//   RV-U-04 (#6) 시험 시계 길: 환경 변수 + 로그인 + 관리자, 프록시 · 터널 머리(X-Forwarded-For · Forwarded · CF-Connecting-IP)가 있으면 거절
// 이름은 지어낸 것.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

process.env.PRO_TENANT_ID = 'agenda-rv-unit'
process.env.PRO_BACKGROUND = '0'
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const M = await import('../lib/agenda/remind.js')
const R = await import('../lib/agenda/read.js')
const S = await import('../lib/agenda/store.js')
const { agendaRoutes } = await import('../routes/agenda.js')
const express = (await import('express')).default
const { pool } = await import('../lib/supa.js')
after(() => pool.end().catch(() => {}))

const PLAN = { title: '파트너 미팅', date: '2026-12-01', start: '15:00', allDay: false, tz: 'Asia/Seoul', durationMin: 60, location: '', link: 'https://evil.example/meet?x=1', bring: '', notes: '' }
const MORNING = new Date('2026-12-01T08:00:00+09:00')

test('RV-U-01 메일 약속의 링크는 알림 글에 넣지 않는다(대화방 약속은 그대로)', () => {
  const mail = M.reminderText(PLAN, 'day', { now: MORNING, source: { kind: 'mail', subject: '미팅 장소 변경' } })
  assert.ok(!mail.text.includes('evil.example'), mail.text)
  assert.ok(!mail.text.includes('참여 주소'), mail.text)
  const en = M.reminderText(PLAN, 'day', { now: MORNING, lang: 'en', source: { kind: 'mail', subject: 'x' } })
  assert.ok(!en.text.includes('evil.example'), en.text)
  const room = M.reminderText(PLAN, 'day', { now: MORNING, source: { kind: 'room', title: '영업팀' } })
  assert.match(room.text, /참여 주소: https:\/\/evil\.example\/meet\?x=1/)
})

test('RV-U-02 Home 카드: 링크는 도메인으로, 메일 약속이면 보낸 사람과 함께', async () => {
  const item = { ...PLAN, id: 'p-1', kind: 'mail', audience: 'owner', participants: ['u-1'], dismissedBy: [], status: 'active', version: 1, calendar: {}, history: [],
    messageIds: [], mailId: 'm-1', roomId: null, source: { kind: 'mail', subject: '미팅 장소 변경', from: '김 대리 <kim@partner.example>', sender: 'kim@partner.example' } }
  const v = await S.viewOf(item, { id: 'u-1' }, { now: new Date('2026-11-26T14:00:00+09:00') })
  assert.equal(v.link, 'https://evil.example/meet?x=1')
  assert.equal(v.linkHost, 'evil.example')
  assert.equal(v.linkFrom, 'kim@partner.example')
  const r = await S.viewOf({ ...item, kind: 'room', roomId: 'r-1', messageIds: ['u-9'], audience: 'room', source: { kind: 'room', title: '영업팀' } }, { id: 'u-1' },
    { now: new Date('2026-11-26T14:00:00+09:00'), titles: new Map([['r-1', '영업팀']]) })
  assert.equal(r.linkHost, 'evil.example')
  assert.equal(r.linkFrom, undefined, '대화방 약속은 방 사람이 정한 것')
})

test('RV-U-03 판정이 보는 글: 새 메시지는 마지막 15개 · 한 메시지 300자, 메일 본문 1000자', () => {
  const members = [{ id: '00000000-0000-4000-8000-000000000001', name: '정하윤' }]
  const now = new Date('2026-11-26T14:00:00+09:00')
  const messages = Array.from({ length: 40 }, (_, i) => ({ uuid: `u-${i + 1}`, who: '정하윤', at: now, text: `${i + 1}번 ` + '가'.repeat(1000), fresh: true }))
  const { input } = R.inputFor({ where: 'room', now, tz: 'Asia/Seoul', members, messages })
  const state = R.gateState(input)
  assert.ok(!state.includes('#25 '), '앞의 메시지는 빠진다')
  assert.ok(state.includes('#26 ') && state.includes('#40 '))
  const lines = state.split('\n').filter((l) => /^#\d+/.test(l))
  assert.equal(lines.length, 15)
  for (const l of lines) assert.ok(l.length <= 300 + 60, `한 줄 ${l.length}자`)
  const { input: mi } = R.inputFor({ where: 'mail', now, tz: 'Asia/Seoul', mail: { from: 'a@x.example', subject: 's', date: now, text: '나'.repeat(5000) } })
  const ms = R.gateState(mi)
  assert.ok((ms.match(/나/g) || []).length <= 1000, `메일 본문 ${(ms.match(/나/g) || []).length}자`)
})

test('RV-U-04 시험 시계 길: 로그인 · 관리자 · 프록시 머리 없음 · 환경 변수 — 하나라도 아니면 거절', async () => {
  process.env.PRO_AGENDA_TEST_CLOCK = '1'
  const fired = []
  // a sign-in of the test's own: 「Bearer user:<id>」
  const auth = (req, res, next) => {
    const m = /^Bearer user:(.+)$/.exec(req.headers.authorization || '')
    if (!m) return res.status(401).json({ error: 'unauthorized' })
    req.user = { id: m[1] }
    next()
  }
  const app = express()
  app.use(express.json())
  app.use('/api', agendaRoutes(auth, { isAdmin: async (u) => u.id === 'admin', fire: async ({ now }) => { fired.push(now.toISOString()); return [] } }))
  const srv = http.createServer(app)
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${srv.address().port}/api/agenda/test/tick`
  const tick = (headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ now: '2026-12-01T08:00:00+09:00' }) }).then((r) => r.status)
  try {
    assert.equal(await tick(), 401, '로그인 없음')
    assert.equal(await tick({ Authorization: 'Bearer user:someone' }), 403, '관리자 아님')
    assert.equal(await tick({ Authorization: 'Bearer user:admin', 'X-Forwarded-For': '203.0.113.9' }), 403, '프록시를 거친 요청')
    assert.equal(await tick({ Authorization: 'Bearer user:admin', Forwarded: 'for=203.0.113.9' }), 403)
    assert.equal(await tick({ Authorization: 'Bearer user:admin', 'CF-Connecting-IP': '203.0.113.9' }), 403, '터널')
    assert.equal(fired.length, 0)
    assert.equal(await tick({ Authorization: 'Bearer user:admin' }), 200)
    assert.deepEqual(fired, ['2026-11-30T23:00:00.000Z'])
    delete process.env.PRO_AGENDA_TEST_CLOCK
    assert.equal(await tick({ Authorization: 'Bearer user:admin' }), 404, '환경 변수가 없으면 길 자체가 없다')
  } finally { srv.close() }
})
