// 약속 알림 — 실제 DB 위에서, 모델 없이(판정과 읽기는 이 시험이 대본으로 대신 답한다). 회사는 이 시험만의 것(agenda-it), 사람은 무작위 id
// (로그인 계정 아님), 끝나면 지운다. 스펙 openspec/specs/agenda-reminders.
//   AG-I-01 대화방의 새 메시지 → 판정 → 읽기 → 약속 하나 · 방 사람마다 알림 둘(아침 · 1시간 전), 읽은 자리는 앞으로, 다시 읽으면 새 것 없음
//   AG-I-02 「장소 바뀌었어요 역삼역으로」 → 판이 오르고 보내지 않은 알림은 거두고 다시 잡는다 → 1시간 전 알림의 글에 새 곳 · 이미 보낸 아침 알림은
//           어떤 시계로 다시 잡아도 다시 보내지 않는다
//   AG-I-03 때가 바뀌면 아침 알림도 새 날로 · 이미 보낸 알림은 다시 보내지 않는다
//   AG-I-04 「취소됐어요」 → 알림을 모두 거두고, 그때가 와도 아무것도 보내지 않는다
//   AG-I-05 보내기는 한 번만: 두 서버가 동시에 집어도 알림 하나씩
//   AG-I-06 보는 사람: 방 사람이 아니면 목록 · 알림 없음, 방에서 나간 사람은 그때 알림을 받지 않음, 메일의 약속은 주인만
//   AG-I-07 「이건 아니에요」: 그 사람의 알림만 거두고 피드백을 남긴다, 모두 누르면 dismissed
//   AG-I-08 「AI 제안」을 끈 방은 읽지 않고 읽은 자리만 앞으로
//   AG-I-09 두 서버가 같은 방을 동시에 읽으려 하면 하나만 읽는다(판정 한 번)
//   AG-I-10 약속 알림을 끄면 보내지 않은 알림이 없어지고, 시작 전 알림의 때를 바꾸면 새 때로
//   AG-I-11 메일: 메일함 주인의 약속, 다음 메일이 그 약속을 옮긴다(주인의 메일 약속을 함께 보냄), 다른 회사의 방에는 약속을 만들 수 없다
//   AG-I-12 늦게 집은 알림(시작이 지남)은 보내지 않는다 · 회사에서 내보낸 사람에게는 보내지 않는다
// Run: node --test --test-concurrency=1 test/agenda.integration.test.js
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TENANT = 'agenda-it'
process.env.PRO_TENANT_ID = TENANT
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_TENANT_HOSTS = ''
process.env.PRO_BACKGROUND = '0'
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_JUDGE_URL = ''
// (readRoom is called by the test itself: no room timers of its own)
process.env.PRO_AGENDA_ROOMS = '0'

const { q, pool } = await import('../lib/supa.js')
const up = await q('select 1 from pro_agenda_items limit 1').then(() => true, () => false)
const E = await import('../lib/calendarEvent.js')
const S = await import('../lib/agenda/store.js')
const RM = await import('../lib/agenda/rooms.js')
const AM = await import('../lib/agenda/mail.js')
const F = await import('../lib/agenda/fire.js')

const kst = (d, t) => E.zonedToUtc(d, t, 'Asia/Seoul')
const NOW = kst('2026-11-26', '14:00')
const id = () => crypto.randomUUID()
const HY = { id: id(), email: 'hy@agenda-it.test', name: '정하윤' }
const SY = { id: id(), email: 'sy@agenda-it.test', name: '김서연' }
const DY = { id: id(), email: 'dy@agenda-it.test', name: '박도윤' } // not in the room
const part = (u) => ({ id: u.id, email: u.email, username: u.name, is_agent: false })
const rooms = []
async function room(people, { assist = true, name = null, tenant = TENANT } = {}) {
  const rid = id()
  await q(`insert into chat_rooms (id, participants, message, name, tenant_id, context) values ($1,$2,$3,$4,$5,$6)`,
    [rid, JSON.stringify(people.map(part)), { msg: 'NEW', type: 'text', createdAt: new Date().toISOString() }, name, tenant, { pgpt: { kind: 'group', assist } }])
  rooms.push(rid)
  return rid
}
// a person's message, as the messenger writes it; at: how long before the reading (ms)
async function say(rid, who, content, at = 0) {
  const uuid = id()
  const ts = new Date(Date.now() - at).toISOString()
  await q('insert into chats (uuid, id, messages, tenant_id) values ($1,$2,$3,$4)', [uuid, rid, { uuid, role: 'user', content, timeStamp: ts, email: who.email, name: who.name, userName: who.name, userId: who.id }, TENANT])
  return uuid
}
// the scripted model: the gate's odds and the reading's ops, in order; calls are kept
function model({ p = 0.9, ops = [] } = {}) {
  const calls = { gate: [], read: [] }
  return {
    calls,
    decide: async (state) => { calls.gate.push(state); return { choice: p >= 0.5 ? 'plan' : 'none', probabilities: { plan: p, none: 1 - p }, confidence: Math.max(p, 1 - p), strategy: 'logprob', model: 'scripted' } },
    json: async (system, user) => { calls.read.push(JSON.parse(user)); return { ops: typeof ops === 'function' ? ops(JSON.parse(user)) : ops } },
  }
}
const reminders = (itemId) => q(`select user_id::text as user_id, slot, version, due_at, sent_at, cancelled_at, outcome from pro_agenda_reminders where item_id=$1 order by user_id, version, slot`, [itemId])
const notices = (u) => q(`select title, description, url from notifications where tenant_id=$1 and type='agenda' and user_id=$2 order by time_stamp`, [TENANT, u.id])
const member = async () => true

async function clean() {
  await q('delete from notifications where tenant_id=$1', [TENANT])
  for (const r of rooms) await q(`delete from notifications where url like $1`, [`%${r}%`])
  await q('delete from pro_agenda_items where tenant_id=$1', [TENANT])
  await q('delete from pro_agenda_rooms where tenant_id=$1', [TENANT])
  await q('delete from chats where tenant_id=$1', [TENANT])
  await q('delete from chat_rooms where tenant_id=$1', [TENANT])
  await q('delete from pro_profile where user_id = any($1::uuid[])', [[HY.id, SY.id, DY.id]])
}
before(async () => {
  if (!up) return
  await q(`insert into tenants (id) values ($1) on conflict (id) do nothing`, [TENANT])
  await q(`insert into tenants (id) values ('agenda-it-other') on conflict (id) do nothing`)
  await clean()
})
after(async () => {
  if (up) {
    await clean()
    await q(`delete from chat_rooms where tenant_id='agenda-it-other'`)
    await q(`delete from tenants where id in ($1, 'agenda-it-other')`, [TENANT])
  }
  await pool.end().catch(() => {})
})
const skip = !up && 'no database with sql/067'

let R1, PLAN // the room and its plan, through 01–05
const CREATE = { op: 'create', title: '시니어그룹 모임', date: '2026-12-01', start: '15:00', allDay: false, location: '강남역 스타벅스', for: 'all', message: '#1', basis: '다음주 화요일 3시' }

test('AG-I-01 대화방의 약속 → 방 사람마다 아침 · 1시간 전 알림, 읽은 자리는 앞으로', { skip }, async () => {
  R1 = await room([HY, SY], { name: '시니어그룹' })
  await say(R1, SY, '다음주 화요일 3시에 강남역 스타벅스에서 봐요', 2000)
  await say(R1, HY, '좋아요!', 1000)
  const m = model({ ops: [CREATE] })
  const r = await RM.readRoom(R1, { now: NOW, decide: m.decide, json: m.json })
  assert.equal(r.ops.length, 1, JSON.stringify(r))
  PLAN = r.ops[0].item
  assert.equal(PLAN.title, '시니어그룹 모임')
  assert.deepEqual([PLAN.date, PLAN.start, PLAN.location, PLAN.audience].join('|'), '2026-12-01|15:00|강남역 스타벅스|room')
  assert.deepEqual(PLAN.participants.sort(), [HY.id, SY.id].sort())
  // the model was shown the room's people by key, the new messages marked, today and the calendar
  const input = m.calls.read[0]
  assert.deepEqual(input.members.map((x) => x.name).sort(), ['김서연', '정하윤'])
  assert.equal(input.messages.filter((x) => x.new).length, 2)
  assert.equal(input.today, '2026-11-26 (목)')
  const rs = await reminders(PLAN.id)
  assert.deepEqual(rs.map((x) => `${x.slot}@${x.due_at.toISOString()}`).sort(), [`before@${kst('2026-12-01', '14:00').toISOString()}`, `before@${kst('2026-12-01', '14:00').toISOString()}`,
    `day@${kst('2026-12-01', '08:00').toISOString()}`, `day@${kst('2026-12-01', '08:00').toISOString()}`].sort())
  assert.ok(!rs.some((x) => x.user_id === DY.id))
  // read again with nothing new: no model call
  const m2 = model()
  assert.deepEqual(await RM.readRoom(R1, { now: NOW, decide: m2.decide, json: m2.json }), { skipped: 'nothing_new' })
  assert.equal(m2.calls.gate.length, 0)
  // what the person sees: 「다가오는 약속」 within 7 days, the source a link to the message
  const [v] = await S.upcoming(HY, { now: NOW })
  assert.equal(v.title, '시니어그룹 모임')
  assert.equal(v.source.title, '시니어그룹')
  assert.match(v.source.url, new RegExp(`^/pro/team/${R1}/[0-9a-f-]{36}$`))
  assert.deepEqual(await S.upcoming(HY, { now: kst('2026-11-20', '09:00') }), [], '7일보다 먼 약속은 아직 목록에 없다')
})

test('AG-I-02 곳이 바뀌면 판이 오르고, 보내지 않은 알림을 다시 잡아 새 곳으로 알린다', { skip }, async () => {
  // the morning one goes first
  const day = await F.fireDue({ now: kst('2026-12-01', '08:00'), deps: { memberHere: member } })
  assert.deepEqual(day.map((x) => `${x.slot}:${x.outcome}`).sort(), ['day:sent', 'day:sent'])
  const [n] = await notices(HY)
  assert.equal(n.title, '오늘 오후 3:00 · 시니어그룹 모임')
  assert.match(n.description, /^오늘 오후 3:00 시니어그룹 모임은 강남역 스타벅스에서 하기로 했어요\./)
  assert.match(n.description, /「시니어그룹」 대화에서 정했어요/)
  assert.match(n.url, new RegExp(`^/pro/team/${R1}/`))
  // 「장소 바뀌었어요 역삼역으로」 at 10:00 on the day
  const msg = await say(R1, SY, '장소 바뀌었어요 역삼역으로')
  const m = model({ ops: (input) => { assert.equal(input.plans[0].key, 'P1'); return [{ op: 'update', plan: 'P1', location: '역삼역', message: '#3', basis: '장소 바뀌었어요 역삼역으로' }] } })
  const r = await RM.readRoom(R1, { now: kst('2026-12-01', '10:00'), decide: m.decide, json: m.json })
  assert.equal(r.ops[0].op, 'update')
  const it = await S.visible(HY.id, PLAN.id)
  assert.deepEqual([it.location, it.status, it.version, it.start], ['역삼역', 'changed', 2, '15:00'])
  assert.equal(it.messageIds[it.messageIds.length - 1], msg)
  assert.deepEqual(it.history.map((h) => h.op), ['create', 'update'])
  assert.deepEqual(it.history[1].changed, ['location'])
  const rs = await reminders(PLAN.id)
  assert.equal(rs.filter((x) => x.version === 1 && x.slot === 'before' && x.outcome === 'changed').length, 2, '판 1 의 보내지 않은 알림은 거둠')
  assert.equal(rs.filter((x) => x.version === 2 && x.slot === 'day').length, 0, '아침은 이미 지나 다시 잡지 않는다')
  assert.equal(rs.filter((x) => x.version === 2 && x.slot === 'before' && !x.sent_at).length, 2)
  // armed again with a clock before the morning (another server's, a test's): the morning already sent at that moment is not armed again
  assert.equal(await S.arm(it, { now: NOW }), 0)
  const sent = await F.fireDue({ now: kst('2026-12-01', '14:00'), deps: { memberHere: member } })
  assert.deepEqual(sent.map((x) => x.outcome), ['sent', 'sent'])
  const last = (await notices(SY)).at(-1)
  assert.equal(last.title, '1시간 뒤 · 시니어그룹 모임')
  assert.match(last.description, /역삼역에서 하기로 했어요/)
  assert.match(last.url, new RegExp(`/pro/team/${R1}/${msg}$`), '알림은 마지막으로 바꾼 메시지를 연다')
})

test('AG-I-03 때가 바뀌면 새 날의 아침 알림을 다시 잡고, 이미 보낸 알림은 다시 보내지 않는다', { skip }, async () => {
  const rid = await room([HY, SY])
  await say(rid, HY, '금요일 저녁 7시 을지로에서 저녁 먹어요', 500)
  const m = model({ ops: [{ op: 'create', title: '저녁 식사', date: '2026-11-27', start: '19:00', location: '을지로', message: '#1' }] })
  const it = (await RM.readRoom(rid, { now: NOW, decide: m.decide, json: m.json })).ops[0].item
  await F.fireDue({ now: kst('2026-11-27', '08:00'), deps: { memberHere: member } })
  assert.equal((await reminders(it.id)).filter((x) => x.sent_at).length, 2)
  await say(rid, SY, '다음 주 월요일로 미뤄요, 시간은 그대로')
  const m2 = model({ ops: [{ op: 'update', plan: 'P1', date: '2026-11-30', message: '#2' }] })
  await RM.readRoom(rid, { now: kst('2026-11-27', '09:00'), decide: m2.decide, json: m2.json })
  const rs = await reminders(it.id)
  assert.deepEqual(rs.filter((x) => x.version === 2).map((x) => `${x.slot}@${x.due_at.toISOString()}`).sort(),
    [`before@${kst('2026-11-30', '18:00').toISOString()}`, `before@${kst('2026-11-30', '18:00').toISOString()}`, `day@${kst('2026-11-30', '08:00').toISOString()}`, `day@${kst('2026-11-30', '08:00').toISOString()}`].sort())
  assert.equal(rs.filter((x) => x.version === 1 && x.sent_at).length, 2, '보낸 것은 보낸 그대로')
  // the old Friday evening comes: nothing
  assert.deepEqual(await F.fireDue({ now: kst('2026-11-27', '18:00'), deps: { memberHere: member } }), [])
})

test('AG-I-04 「취소됐어요」 → 알림을 모두 거두고, 그때가 와도 보내지 않는다', { skip }, async () => {
  const rid = await room([HY, SY])
  await say(rid, SY, '모레 오전 10시에 회의실 A에서 리뷰해요', 500)
  const m = model({ ops: [{ op: 'create', title: '리뷰', date: '2026-11-28', start: '10:00', location: '회의실 A', message: '#1' }] })
  const it = (await RM.readRoom(rid, { now: NOW, decide: m.decide, json: m.json })).ops[0].item
  await say(rid, SY, '리뷰 취소됐어요')
  const m2 = model({ ops: [{ op: 'cancel', plan: 'P1', message: '#2', basis: '리뷰 취소됐어요' }] })
  await RM.readRoom(rid, { now: NOW, decide: m2.decide, json: m2.json })
  const [row] = await q('select status from pro_agenda_items where id=$1', [it.id])
  assert.equal(row.status, 'cancelled')
  const rs = await reminders(it.id)
  assert.ok(rs.length && rs.every((x) => x.cancelled_at && x.outcome === 'cancelled'))
  assert.deepEqual(await F.fireDue({ now: kst('2026-11-28', '10:00'), deps: { memberHere: member } }), [])
  assert.ok(!(await S.upcoming(HY, { now: NOW })).some((x) => x.id === it.id))
  // the next reading no longer offers it to the model
  await say(rid, HY, '그럼 다음에 봐요')
  const m3 = model({ p: 0.05 })
  await RM.readRoom(rid, { now: NOW, decide: m3.decide, json: m3.json })
  assert.match(m3.calls.gate[0], /정해 둔 약속:\n- 없음/)
})

test('AG-I-05 두 서버가 동시에 집어도 알림은 한 사람에게 한 번', { skip }, async () => {
  const rid = await room([HY, SY])
  await say(rid, HY, '내일 오후 2시 3층 회의실', 500)
  const m = model({ ops: [{ op: 'create', title: '회의', date: '2026-11-27', start: '14:00', location: '3층 회의실', message: '#1' }] })
  const it = (await RM.readRoom(rid, { now: NOW, decide: m.decide, json: m.json })).ops[0].item
  const at = kst('2026-11-27', '13:00')
  const [a, b] = await Promise.all([F.fireDue({ now: at, deps: { memberHere: member } }), F.fireDue({ now: at, deps: { memberHere: member } })])
  const mine = [...a, ...b].filter((x) => x.item === it.id)
  assert.equal(mine.length, 4, '아침 둘 · 1시간 전 둘 — 한 번씩')
  assert.equal(new Set(mine.map((x) => x.id)).size, 4)
  const n = await q(`select count(*)::int n from notifications where tenant_id=$1 and type='agenda' and description like '%3층 회의실%'`, [TENANT])
  assert.equal(n[0].n, 4)
})

test('AG-I-06 보는 사람: 방 밖의 사람 · 방을 나간 사람 · 메일의 약속은 주인만', { skip }, async () => {
  assert.deepEqual(await S.upcoming(DY, { now: NOW }), [], '방 사람이 아니면 목록에 없다')
  assert.equal(await S.visible(DY.id, PLAN.id), null)
  // 김서연 leaves the room before a plan's reminder
  const rid = await room([HY, SY])
  await say(rid, HY, '토요일 오전 11시 판교역에서 만나요', 500)
  const m = model({ ops: [{ op: 'create', title: '판교 모임', date: '2026-11-28', start: '11:00', location: '판교역', message: '#1' }] })
  const it = (await RM.readRoom(rid, { now: NOW, decide: m.decide, json: m.json })).ops[0].item
  await q(`update chat_rooms set participants = $2 where id=$1`, [rid, JSON.stringify([part(HY)])])
  const out = await F.fireDue({ now: kst('2026-11-28', '08:00'), deps: { memberHere: member } })
  const mine = out.filter((x) => x.item === it.id)
  assert.deepEqual(mine.map((x) => `${x.user === SY.id ? 'SY' : 'HY'}:${x.outcome}`).sort(), ['HY:sent', 'SY:skipped:not_visible'])
  assert.ok(!(await S.upcoming(SY, { now: NOW })).some((x) => x.id === it.id))
  // a mail's plan: only its mailbox's owner
  const mm = model({ ops: [{ op: 'create', title: '분기 리뷰', date: '2026-12-02', start: '10:00', location: '본사 5층', message: '' }] })
  const r = await AM.fromMail(HY.id, { id: `m-${id()}`, from: '본사 기획팀 <plan@hq.example>', subject: '분기 리뷰 일정', date: NOW, text: '12월 2일 오전 10시 본사 5층에서 분기 리뷰를 합니다.' }, { deps: { now: NOW, decide: mm.decide, json: mm.json } })
  const mp = r.ops[0].item
  assert.deepEqual([mp.audience, mp.participants], ['owner', [HY.id]])
  assert.equal(await S.visible(SY.id, mp.id), null)
  assert.equal((await S.visible(HY.id, mp.id)).title, '분기 리뷰')
  assert.equal(S.sourceUrl(mp), `/pro/mail/${encodeURIComponent(mp.mailId)}`)
})

test('AG-I-07 「이건 아니에요」: 그 사람의 알림만 거두고 피드백을 남긴다, 모두 누르면 dismissed', { skip }, async () => {
  const rid = await room([HY, SY])
  await say(rid, SY, '수요일 3시 탕비실 정리해요', 500)
  const m = model({ ops: [{ op: 'create', title: '탕비실 정리', date: '2026-12-02', start: '15:00', message: '#1' }] })
  const it = (await RM.readRoom(rid, { now: NOW, decide: m.decide, json: m.json })).ops[0].item
  await S.dismiss(HY, it.id)
  const rs = await reminders(it.id)
  assert.ok(rs.filter((x) => x.user_id === HY.id).every((x) => x.outcome === 'dismissed'))
  assert.ok(rs.filter((x) => x.user_id === SY.id).every((x) => !x.cancelled_at))
  const [fb] = await q('select verdict, item from pro_agenda_feedback where item_id=$1 and user_id=$2', [it.id, HY.id])
  assert.equal(fb.verdict, 'not_a_plan')
  assert.equal(fb.item.title, '탕비실 정리')
  assert.equal(await S.visible(HY.id, it.id), null)
  assert.ok(await S.visible(SY.id, it.id))
  await assert.rejects(S.dismiss(DY, it.id), { status: 404 })
  assert.equal((await S.dismiss(SY, it.id)).status, 'dismissed')
})

test('AG-I-08 「AI 제안」을 끈 방은 읽지 않는다', { skip }, async () => {
  const rid = await room([HY, SY], { assist: false })
  await say(rid, HY, '내일 오후 4시 카페에서 봐요', 500)
  const m = model({ ops: [CREATE] })
  assert.deepEqual(await RM.readRoom(rid, { now: NOW, decide: m.decide, json: m.json }), { skipped: 'room_off' })
  assert.equal(m.calls.gate.length, 0)
  const [c] = await q('select read_upto from pro_agenda_rooms where room_id=$1', [rid])
  assert.ok(c.read_upto.getTime() > Date.now() - 5000, '읽은 자리는 앞으로')
})

test('AG-I-09 두 서버가 같은 방을 동시에 읽으려 하면 하나만 읽는다', { skip }, async () => {
  const rid = await room([HY, SY])
  await say(rid, HY, '목요일 오전 9시 정문 앞', 500)
  let release, entered
  const inside = new Promise((ok) => { entered = ok })
  const slow = model({ ops: [{ op: 'create', title: '정문 집합', date: '2026-12-03', start: '09:00', location: '정문 앞', message: '#1' }] })
  const decide = async (...a) => { entered(); await new Promise((ok) => { release = ok }); return slow.decide(...a) }
  const first = RM.readRoom(rid, { now: NOW, decide, json: slow.json })
  // the first server is reading (it holds the room)
  await inside
  const other = model({ ops: [] })
  const second = await RM.readRoom(rid, { now: NOW, decide: other.decide, json: other.json })
  assert.deepEqual(second, { skipped: 'busy' })
  release()
  const r = await first
  assert.equal(r.ops.length, 1)
  assert.equal(other.calls.gate.length, 0)
})

test('AG-I-10 약속 알림을 끄면 보내지 않은 알림이 없어지고, 시작 전 알림의 때를 바꾸면 새 때로', { skip }, async () => {
  const rid = await room([HY, SY])
  await say(rid, HY, '금요일 오후 5시 옥상에서', 500)
  const m = model({ ops: [{ op: 'create', title: '옥상 모임', date: '2026-11-27', start: '17:00', location: '옥상', message: '#1' }] })
  const it = (await RM.readRoom(rid, { now: NOW, decide: m.decide, json: m.json })).ops[0].item
  await S.savePrefs(SY, { on: false }, { now: NOW })
  assert.equal((await reminders(it.id)).filter((x) => x.user_id === SY.id).length, 0)
  await S.savePrefs(HY, { leadMin: 30 }, { now: NOW })
  const hy = (await reminders(it.id)).filter((x) => x.user_id === HY.id && !x.cancelled_at && !x.sent_at)
  assert.deepEqual(hy.map((x) => `${x.slot}@${x.due_at.toISOString()}`).sort(), [`before@${kst('2026-11-27', '16:30').toISOString()}`, `day@${kst('2026-11-27', '08:00').toISOString()}`])
  assert.deepEqual(await S.prefsOf(HY.id), { on: true, leadMin: 30 })
  await S.savePrefs(SY, { on: true, leadMin: 999 }, { now: NOW })
  assert.equal((await S.prefsOf(SY.id)).leadMin, 60, '정해 둔 보기 밖의 값은 그대로')
  assert.equal((await reminders(it.id)).filter((x) => x.user_id === SY.id && !x.sent_at && !x.cancelled_at).length, 2, '다시 켜면 다시 잡는다')
  await S.savePrefs(HY, { leadMin: 60 }, { now: NOW })
})

test('AG-I-11 메일: 주인의 약속, 다음 메일이 그것을 옮긴다 · 다른 회사의 방에는 약속을 만들 수 없다', { skip }, async () => {
  const first = model({ ops: [{ op: 'create', title: '고객사 방문', date: '2026-12-03', start: '14:00', location: '고객사 본사 3층', message: '' }] })
  const a = await AM.fromMail(SY.id, { id: `m-${id()}`, from: '영업 담당 <sales@client.example>', subject: '방문 일정 확정', date: NOW, text: '12월 3일 오후 2시 본사 3층으로 오시면 됩니다.' }, { deps: { now: NOW, decide: first.decide, json: first.json } })
  const it = a.ops[0].item
  const next = model({ ops: (input) => { assert.deepEqual(input.plans.map((p) => p.title), ['고객사 방문']); return [{ op: 'update', plan: 'P1', start: '16:00' }] } })
  const mid = `m-${id()}`
  await AM.fromMail(SY.id, { id: mid, from: '영업 담당 <sales@client.example>', subject: 'Re: 방문 일정 확정', date: NOW, text: '죄송하지만 4시로 옮겨 주실 수 있을까요? 네 그렇게 하겠습니다.' }, { deps: { now: NOW, decide: next.decide, json: next.json } })
  const after = await S.visible(SY.id, it.id)
  assert.deepEqual([after.start, after.version, after.mailId, after.source.subject], ['16:00', 2, mid, 'Re: 방문 일정 확정'])
  // the gate says no: one short call and nothing else
  const no = model({ p: 0.02 })
  assert.deepEqual((await AM.fromMail(SY.id, { id: `m-${id()}`, from: 'news@letters.example', subject: '이번 주 소식', date: NOW, text: '이번 주의 소식입니다.' }, { deps: { now: NOW, decide: no.decide, json: no.json } })).ops, [])
  assert.equal(no.calls.read.length, 0)
  // a room of another company: the guard refuses
  const foreign = await room([HY], { tenant: 'agenda-it-other' })
  await assert.rejects(q(`insert into pro_agenda_items (tenant_id, source_kind, room_id, title, starts_at) values ($1, 'room', $2, 'x', now())`, [TENANT, foreign]), /not in tenant/)
})

test('AG-I-12 늦게 집은 시작 전 알림 · 내보낸 사람 · 끈 사람에게는 보내지 않는다', { skip }, async () => {
  const rid = await room([HY, SY])
  await say(rid, HY, '오늘 오후 4시 회의', 500)
  const m = model({ ops: [{ op: 'create', title: '오후 회의', date: '2026-11-26', start: '16:00', message: '#1' }] })
  const it = (await RM.readRoom(rid, { now: NOW, decide: m.decide, json: m.json })).ops[0].item
  // the server was down from 15:00 to 16:10
  const out = (await F.fireDue({ now: kst('2026-11-26', '16:10'), deps: { memberHere: async (u) => u !== SY.id } })).filter((x) => x.item === it.id)
  assert.deepEqual(out.map((x) => `${x.user === SY.id ? 'SY' : 'HY'}:${x.outcome}`).sort(), ['HY:skipped:late', 'SY:skipped:not_member'])
})
