// 사건 · 프로세스 소속 · 역할 · 역할 루틴(spec pgpt-pro_process-ontology, design-v0.3): 데이터베이스 없이 structure.js 만.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCases, graphOf } from '../lib/ontology/stats.js'
import { structureOf, routinesOf, shownRoutine, clsOf } from '../lib/ontology/structure.js'

const H = 3600_000
const T0 = Date.UTC(2026, 8, 1)
const sales = { id: 'u1', name: '이도윤', agent: false }, fin = { id: 'u2', name: '박서연', agent: false }, bot = { id: 'a1', name: '견적 에이전트', agent: true }
const ev = (c, task, h, role, actor, arts = [], source = 'mail_history') => ({ case: c, task, at: T0 + h * H, role, actor, arts, source })
// 두 건: 요청 메일 → 견적서 작성(엑셀 결과물) → 재무 검토 → 고객 회신, 한 건은 채팅에서 시작해 재무 검토 없이
const events = [
  ev('c1', '요청 접수', 0, '영업', sales), ev('c1', '견적서 작성', 2, '견적 에이전트', bot, ['sheet']), ev('c1', '재무 검토', 5, '재무 담당', fin), ev('c1', '고객 회신', 8, '영업', sales),
  ev('c2', '요청 접수', 24, '영업', sales), ev('c2', '견적서 작성', 26, '견적 에이전트', bot, ['sheet']), ev('c2', '재무 검토', 30, '재무 담당', fin), ev('c2', '고객 회신', 33, '영업', sales),
  ev('c3', '요청 접수', 48, '영업', sales, [], 'chat_handover'), ev('c3', '견적서 작성', 50, '견적 에이전트', bot, ['sheet'], 'chat_handover'), ev('c3', '고객 회신', 52, '영업', sales, [], 'chat_handover'),
]
const cases = toCases(events)
const g = graphOf(cases)
const procs = [{ key: 'process:a', caseIds: ['c1', 'c2', 'c3'], tasks: ['요청 접수', '견적서 작성', '재무 검토', '고객 회신'] }]
const S = structureOf(cases, g, procs, { assigned: new Map([['u1', '영업'], ['u2', '재무 담당']]) })
const find = (list, from, to) => list.find((x) => x.from === from && x.to === to)

test('사건: 요청 메일 · 채팅 요청에서 첫 일, 결과물이 다음 일을 일으킨다(xor)', () => {
  assert.equal(find(S.triggers, 'mail', '요청 접수').n, 2)
  assert.equal(find(S.triggers, 'message', '요청 접수').n, 1)
  const art = 'artifact:견적서 작성:sheet'
  assert.equal(S.events.find((e) => e.key === art).n, 3)
  assert.equal(find(S.raises, '견적서 작성', art).p, 1)
  const toFin = find(S.triggers, art, '재무 검토'), toReply = find(S.triggers, art, '고객 회신')
  assert.equal(toFin.n, 2); assert.equal(toReply.n, 1)
  assert.equal(toFin.split, 'xor')
  assert.ok(Math.abs(toFin.p - 2 / 3) < 1e-9)
})

test('사건: 같은 결과물 뒤 두 일이 서로 앞뒤로 다 나오면 함께(and)', () => {
  const evs = [ev('d1', '계약 확정', 0, '영업', sales, ['doc']), ev('d1', '자재 발주', 1, '영업', sales), ev('d1', '일정 조정', 2, '영업', sales),
    ev('d2', '계약 확정', 10, '영업', sales, ['doc']), ev('d2', '일정 조정', 11, '영업', sales), ev('d2', '자재 발주', 12, '영업', sales)]
  const cs = toCases(evs), gg = graphOf(cs)
  const s = structureOf(cs, gg, [])
  assert.equal(find(s.triggers, 'artifact:계약 확정:doc', '자재 발주').split, 'and')
})

test('프로세스 소속: 일마다 그 프로세스 건 가운데 거친 비율과 시작 비율, 시작 사건', () => {
  assert.ok(Math.abs(find(S.hasTask, 'process:a', '재무 검토').share - 2 / 3) < 1e-9)
  assert.equal(find(S.hasTask, 'process:a', '요청 접수').entry_share, 1)
  assert.equal(find(S.startsOn, 'process:a', 'mail').n, 2)
})

test('역할: 수행 · 수행자 · 에이전트 비율 · 인계 · 한 사람에게만 걸린 일', () => {
  const salesR = S.roles.find((r) => r.key === '영업')
  assert.equal(salesR.members, 1)
  assert.deepEqual(salesR.single_tasks.sort(), ['고객 회신', '요청 접수'])
  const botR = S.roles.find((r) => r.key === '견적 에이전트')
  assert.equal(botR.agent_share, 1)
  assert.deepEqual(botR.artifacts, ['sheet'])
  assert.equal(S.roles.find((r) => r.key === '재무 담당').handovers_in, 2)
  assert.equal(find(S.performedBy, '재무 검토', '재무 담당').share, 1)
  assert.equal(find(S.plays, 'u1', '영업').assigned, true)
  assert.equal(find(S.plays, 'a1', '견적 에이전트').assigned, false)
  assert.ok(S.performers.find((p) => p.key === 'a1').is_agent)
})

test('역할 루틴: 사람마다 한 줄인 습관을 역할 · 결과물 · 일로 모아 사람 수를 센다(이름 · 말은 없다)', () => {
  const r = routinesOf([
    { userId: 'u1', role: '영업', cls: 'sheet', task: '직인 넣기', seen: 3 }, { userId: 'u3', role: '영업', cls: 'sheet', task: '직인 넣기', seen: 2 },
    { userId: 'u4', role: '영업', cls: 'sheet', task: '직인 넣기', seen: 2, shared: true }, { userId: 'u2', role: '재무 담당', cls: 'sheet', task: '검토 날짜 적기', seen: 2 },
    { userId: 'u5', role: '담당자', cls: 'doc', task: '대외비 표기', seen: 2 },
  ])
  const sales3 = r.find((x) => x.role === '영업')
  assert.equal(sales3.people, 3); assert.equal(sales3.n, 7); assert.equal(sales3.shared, 1)
  assert.equal(r.length, 2, '역할이 없는 습관은 루틴이 되지 않는다')
  assert.ok(!('userId' in sales3) && !('action' in sales3))
})

test('지도에 보이는 루틴: 기준(같은 역할 N명) · 본인 공유 · 모두 · 끄기', () => {
  const three = { people: 3, shared: 0 }, one = { people: 1, shared: 0 }, oneShared = { people: 1, shared: 1 }
  assert.equal(shownRoutine(three), true)
  assert.equal(shownRoutine(one), false)
  assert.equal(shownRoutine(oneShared), true, '한 사람뿐이어도 본인이 공유했으면 보인다')
  assert.equal(shownRoutine(three, { mode: 'threshold', min: 4 }), false)
  assert.equal(shownRoutine(one, { mode: 'all' }), true)
  assert.equal(shownRoutine(oneShared, { mode: 'off' }), false)
})

test('결과물 종류: 확장자에서(후행 습관과 같은 갈래, 도면 추가)', () => {
  assert.equal(clsOf('견적서_달빛.xlsx'), 'sheet'); assert.equal(clsOf('평면도.dxf'), 'drawing'); assert.equal(clsOf('제안서.hwpx'), 'doc'); assert.equal(clsOf('메모'), null)
})
