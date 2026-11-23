// 팀 활동 조립(lib/context/activity.js)의 순수 부분 — DB·모델 없이. 카드 칸마다 깊이 규칙, 겹침 짝짓기, 시간순 보기의 줄.
//   「원문표지-…」 글은 원문(답·프롬프트 예시)에만 있다 — 원문 깊이가 없는 보는 사람의 카드·줄에 나오면 실패.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleCard, pairsOf, overlapText, timelineLines, staleOf, turnsN, relLabel, OVERLAP_MIN } from '../lib/context/activity.js'
import { depthOf } from '../lib/context/visibility.js'

const NOW = new Date('2026-11-01T12:00:00Z').getTime()
const DAY = 86400000
const ago = (d) => new Date(NOW - d * DAY).toISOString()
const person = { id: 'lee', name: '이도윤', team: '전략팀' }
// 관계(org.relation 이 만드는 모양)
const R = {
  self: { self: true, member: true, sameTeam: true, sameDept: true, lead: null, admin: false, via: 'jwt' },
  lead: { self: false, member: true, sameTeam: true, sameDept: true, lead: 'strategy', admin: false, via: 'jwt' },
  team: { self: false, member: true, sameTeam: true, sameDept: true, lead: null, admin: false, via: 'jwt' },
  other: { self: false, member: true, sameTeam: false, sameDept: true, lead: null, admin: false, via: 'jwt' },
  admin: { self: false, member: true, sameTeam: false, sameDept: false, lead: null, admin: true, via: 'jwt' },
}
const TRENDS = { id: 'c-trend', owner: 'lee', title: '경쟁 서비스 동향', purpose: '경쟁 3사의 가격·기능 변화를 매주 추적', visibility: 'summary', reach: 'team', sensitive: 'none',
  summary: '경쟁 3사의 요금 변화를 조사해 표로 정리했다. 이번 주 보고 문단을 썼다.', turns: 1, kinds: { 조사: 4, '분석·계산': 3, '문서 작성': 1 },
  prompt_types: [
    { name: '경쟁사 요금 변동 조사', kind: '조사', count: 3, examples: ['A사 요금제 페이지에서 지난주와 달라진 점을 정리해 줘'], lines: [{ text: 'A사 요금제 페이지에서 지난주와 달라진 점을 정리해 줘', line: 'A사 요금제 변경점을 정리해 달라고 함' }] },
    { name: '경쟁사 가격 분석', kind: '분석·계산', count: 3, examples: ['경쟁 3사 사용자당 월 요금을 표로 비교해 줘'], lines: [] },
    { name: '주간 보고 작성', kind: '문서 작성', count: 1, examples: ['이번 주 경쟁 동향 보고 문단을 써 줘'], lines: [] },
  ], updated_at: ago(0.4), built_at: ago(0.3) }
const EDU = { id: 'c-edu', owner: 'lee', title: '사내 교육 자료 정리', purpose: '신입용 리서치 교육 자료', visibility: 'listed', reach: 'team', sensitive: 'none',
  summary: '신입용 체크리스트를 만들었다.', turns: 2, kinds: { '문서 작성': 2 }, prompt_types: [{ name: '교육 자료 작성', count: 2, examples: ['데스크 리서치 순서를 신입용 체크리스트로 만들어 줘'], lines: [] }],
  updated_at: ago(9), built_at: ago(1) }
const MEMO = { id: 'c-memo', owner: 'lee', title: '개인 학습 메모', purpose: '개인 공부', visibility: 'private', reach: 'team', sensitive: 'none',
  summary: '회귀 분석을 공부했다(원문표지-개인메모).', turns: 2, kinds: { 기타: 1, 코드: 1 }, prompt_types: [{ name: '공부 질문', count: 2, examples: ['회귀 분석 결과 해석하는 법을 쉽게 설명해 줘'], lines: [] }],
  updated_at: ago(3), built_at: ago(1) }
const OLD = { ...EDU, id: 'c-old', title: '지난 분기 정리', visibility: 'summary', updated_at: ago(40), kinds: { 조사: 9 }, turns: 9 }
const ALL = [TRENDS, EDU, MEMO, OLD]
const withDepth = (rel, items = ALL) => items.map((c) => ({ ...c, mine: !!rel.self, depth: depthOf(c, rel).depth }))
const card = (rel, extra = {}) => assembleCard({ person, rel, items: withDepth(rel), spend: { usd: 0.42, credits: 64 }, now: NOW, ...extra })
const has = (o, s) => JSON.stringify(o).includes(s)

test('장(같은 팀): 요약 맥락은 한 줄까지, 제목 맥락은 횟수로만, 비공개는 없다', () => {
  const c = card(R.lead)
  assert.equal(c.relation, '내 팀원')
  assert.deepEqual(c.now.map((x) => x.title), ['경쟁 서비스 동향'], '7일 안에 움직인 보이는 맥락만(비공개 메모는 빠짐)')
  assert.equal(c.now[0].line, '경쟁 3사의 요금 변화를 조사해 표로 정리했다.', '요약 첫 문장만')
  assert.deepEqual(c.now[0].request, { conversationId: 'c-trend', depth: 'content' }, '원문 깊이가 없으면 요청하기')
  assert.ok(c.prompt_types.length && c.prompt_types.every((t) => !t.examples), '유형 이름·횟수만, 예시 문장 없음')
  assert.equal(c.prompt_types_unnamed, 0, '장 덧씌움으로 제목 공개 맥락도 요약 깊이')
  assert.deepEqual(c.kinds.find((k) => k.name === '문서 작성'), { name: '문서 작성', count: 3 }, '제목 공개 맥락의 작업 유형도 센다')
  assert.ok(!c.kinds.some((k) => k.name === '코드' || k.name === '기타'), '비공개 맥락의 작업 유형은 세지 않는다')
  assert.equal(c.kinds.find((k) => k.name === '조사').count, 4, '30일이 지난 맥락은 세지 않는다')
  assert.deepEqual(c.amount.cost, { usd: 0.42, credits: 64 }, '비용은 장에게 보인다')
  assert.equal(c.private, undefined, '비공개 건수는 관리자에게만')
  assert.ok(!has(c, '원문표지') && !has(c, '개인 학습 메모'), '비공개 맥락은 존재도 숨긴다')
  assert.equal(c.depth, 'summary')
})

test('다른 팀: 제목·목적과 작업 유형 횟수만 — 한 줄·유형 이름·비용 없음', () => {
  const c = card(R.other)
  assert.equal(c.relation, '같은 부서')
  assert.equal(c.now[0].title, '경쟁 서비스 동향')
  assert.equal(c.now[0].depth, 'title')
  assert.equal(c.now[0].line, undefined)
  assert.equal(c.now[0].purpose, '경쟁 3사의 가격·기능 변화를 매주 추적', '한 줄 목적은 제목 깊이에 보인다')
  assert.deepEqual(c.prompt_types, [], '유형 이름은 요약 깊이부터')
  assert.equal(c.prompt_types_unnamed, turnsN(TRENDS) + turnsN(EDU), '이름 없이 횟수로만 센다')
  assert.ok(c.kinds.length > 0, '작업 유형 횟수는 보인다')
  assert.equal(c.amount.cost, undefined)
  for (const s of ['요금 변화를 조사해', 'A사 요금제 페이지', '경쟁사 요금 변동 조사']) assert.ok(!has(c, s), `제목 깊이 카드에 「${s}」 없음`)
  assert.equal(c.depth, 'title')
})

test('관리자: 요약 깊이 카드 + 「비공개 작업 1건」(비용은 사람 단위라 나누지 않는다)', () => {
  const c = card(R.admin)
  assert.equal(c.relation, '관리자로 봄')
  assert.deepEqual(c.private, { count: 1 })
  assert.ok(c.now[0].line)
  assert.ok(c.amount.cost)
  assert.ok(!has(c, '원문표지') && !has(c, '회귀 분석'), '비공개 맥락의 제목·요약은 없다')
})

test('본인: 모든 맥락 원문 — 예시 문장, 요청하기 없음, 비공개도 내 카드에는 든다', () => {
  const c = card(R.self)
  assert.equal(c.relation, '본인')
  assert.ok(c.now.some((x) => x.title === '개인 학습 메모'))
  assert.ok(c.now.every((x) => !x.request))
  assert.ok(c.prompt_types.some((t) => t.examples?.length), '원문 깊이 맥락의 예시 문장')
  assert.equal(c.private, undefined, '내 카드에 비공개 건수 칸은 따로 없다')
  assert.equal(c.amount.turns, turnsN(TRENDS) + turnsN(EDU) + turnsN(MEMO))
})

test('허락으로 원문 깊이를 받으면 그 맥락의 예시 문장이 나온다', () => {
  const grants = [{ conversation_id: 'c-trend', owner: 'lee', depth: 'content', duration: '7d', until: new Date(NOW + DAY).toISOString() }]
  const items = ALL.map((c) => ({ ...c, depth: depthOf(c, R.team, { grants: c.id === 'c-trend' ? grants : [], now: new Date(NOW) }).depth }))
  const c = assembleCard({ person, rel: R.team, items, now: NOW })
  assert.equal(c.now[0].depth, 'content')
  assert.equal(c.now[0].request, undefined)
  assert.ok(c.prompt_types.find((t) => t.name === '경쟁사 요금 변동 조사').examples.length === 1)
})

test('진행 중인 AI 작업: 장·관리자·본인 또는 관련 맥락을 요약 이상으로 보는 사람에게만 내용, 나머지는 건수', () => {
  const runs = [
    { kind: 'chat', title: '경쟁 서비스 동향', status: 'working', started_at: ago(0.01), conv: 'c-trend' },
    { kind: 'mission', title: '주간 경쟁 동향 조사', detail: '매주 월요일 경쟁 3사 요금제 확인', status: 'running', started_at: ago(0.02), conv: null },
  ]
  const lead = card(R.lead, { runs })
  assert.equal(lead.running.count, 2)
  assert.equal(lead.running.hidden, 0)
  assert.equal(lead.running.items.find((r) => r.kind === 'mission').status_label, '실행 중')
  const team = card(R.team, { runs })
  assert.equal(team.running.count, 2)
  assert.equal(team.running.hidden, 1, '관련 맥락이 없는 정기 작업은 같은 팀에게 건수만')
  assert.deepEqual(team.running.items.map((r) => r.kind), ['chat'])
  const other = card(R.other, { runs })
  assert.equal(other.running.items.length, 0)
  assert.equal(other.running.hidden, 2)
  assert.ok(!has(other.running, '주간 경쟁 동향'))
  // 비공개 맥락에서 도는 작업: 장에게도 제목(= 맥락 제목) 없이
  const priv = card(R.lead, { runs: [{ kind: 'chat', title: '개인 학습 메모', status: 'working', started_at: ago(0.01), conv: 'c-memo' }] })
  assert.deepEqual([priv.running.count, priv.running.items[0].private, priv.running.items[0].title, priv.running.items[0].conversationId], [1, true, '', undefined])
  assert.ok(!has(priv, '개인 학습 메모'))
})

test('최근 산출물: 요약 깊이부터 이름, 원문 깊이만 링크, 맥락 모르는 파일은 본인만', () => {
  const arts = [
    { name: '경쟁사 요금 비교.xlsx', ext: 'xlsx', kind: 'file', url: 'http://x/a.xlsx', at: ago(0.5), conv: 'c-trend' },
    { name: '메모.txt', ext: 'txt', kind: 'file', url: 'http://x/m.txt', at: ago(3), conv: 'c-memo' },
    { name: '어디서 왔는지 모름.pdf', ext: 'pdf', kind: 'file', url: 'http://x/u.pdf', at: ago(1), conv: null },
  ]
  const lead = card(R.lead, { arts })
  assert.deepEqual(lead.artifacts.map((a) => a.name), ['경쟁사 요금 비교.xlsx'])
  assert.equal(lead.artifacts[0].url, undefined, '요약 깊이에는 링크 없음')
  assert.equal(lead.artifacts[0].context, '경쟁 서비스 동향')
  assert.deepEqual(card(R.other, { arts }).artifacts, [], '제목 깊이에는 산출물 없음')
  const me = card(R.self, { arts })
  assert.equal(me.artifacts.length, 3)
  assert.ok(me.artifacts.every((a) => a.url))
})

test('겹침 비교 글은 보는 사람의 깊이만큼', () => {
  const [t] = withDepth(R.other, [TRENDS])
  assert.equal(overlapText(t), '경쟁 서비스 동향\n경쟁 3사의 가격·기능 변화를 매주 추적', '제목 깊이 = 제목 + 한 줄 목적')
  const [s] = withDepth(R.team, [TRENDS])
  assert.ok(overlapText(s).includes('요금 변화를 조사해'), '요약 깊이 = + 요약')
  const [m] = withDepth(R.self, [MEMO])
  assert.ok(overlapText(m).includes('회귀 분석'), '내 맥락은 요약까지')
})

test('겹침 짝: 다른 주인끼리, 기준 이상, 보는 사람이 당사자인 쪽이 있을 때만', () => {
  const items = [{ owner: 'lee', mine: true }, { owner: 'choi' }, { owner: 'lee' }, { owner: 'jung' }]
  const v = (x, y) => [x, y]
  const vecs = [v(1, 0), v(0.9, 0.2), v(1, 0.01), v(0, 1)]
  const all = pairsOf(items, vecs, { min: OVERLAP_MIN })
  assert.ok(!all.some((p) => p.i === 0 && p.j === 2), '같은 주인끼리는 짝이 아니다')
  assert.ok(all.some((p) => p.i === 0 && p.j === 1 && p.score >= OVERLAP_MIN))
  assert.ok(!all.some((p) => p.j === 3), '기준 아래는 없다')
  const mineOnly = pairsOf(items, vecs, { watch: (x) => !!x.mine })
  assert.deepEqual(mineOnly.map((p) => [p.i, p.j]), [[0, 1]], '당사자가 아닌 짝(choi~lee 다른 맥락)은 빠진다')
  assert.equal(OVERLAP_MIN, 0.75)
})

const TURNS = [
  { id: 'm1', prompt: 'A사 요금제 페이지에서 지난주와 달라진 점을 정리해 줘', answer: 'A사는 9,900원으로 올렸어요(원문표지-A사9900).\n무료 요금제는 그대로예요.', at: ago(1) },
  { id: 'm2', prompt: '경쟁 3사 사용자당 월 요금을 표로 비교해 줘', answer: '| 회사 | 프로 |', at: ago(0.9) },
  { id: 'm3', prompt: '새로 생긴 요청이야 찾아 줘', answer: '찾았어요', at: ago(0.5) },
]
test('시간순 보기 — 원문: 프롬프트 문장과 답 첫 줄', () => {
  const L = timelineLines({ item: TRENDS, depth: 'content', turns: TURNS })
  assert.equal(L.length, 3)
  assert.equal(L[0].prompt, TURNS[0].prompt)
  assert.equal(L[0].answer, 'A사는 9,900원으로 올렸어요(원문표지-A사9900).', '답은 첫 줄만')
  assert.equal(L[0].type, '경쟁사 요금 변동 조사')
  assert.ok(L.every((x) => !x.request))
})
test('시간순 보기 — 요약: 유형 이름과 바꿔 쓴 한 줄, 프롬프트 문장·답은 없다', () => {
  const L = timelineLines({ item: TRENDS, depth: 'summary', turns: TURNS })
  assert.deepEqual([L[0].type, L[0].line], ['경쟁사 요금 변동 조사', 'A사 요금제 변경점을 정리해 달라고 함'])
  assert.equal(L[2].type, '조사 요청', '요약에 없는 새 턴은 작업 유형 이름으로')
  assert.equal(L[2].line, null)
  for (const t of TURNS) assert.ok(!has(L, t.prompt), `프롬프트 문장 「${t.prompt}」 없음`)
  assert.ok(!has(L, '원문표지') && !has(L, '9,900'), '답 원문 없음')
  assert.ok(L.every((x) => x.request?.depth === 'content'), '줄마다 원문 요청')
})
test('시간순 보기 — 제목: 시각과 작업 유형만', () => {
  const L = timelineLines({ item: TRENDS, depth: 'title', turns: TURNS, runs: [{ kind: 'chat', status: 'working', started_at: ago(0.1) }], arts: [{ name: '비교.xlsx', at: ago(0.2), url: 'u' }] })
  assert.deepEqual(L.map((x) => x.kind), ['prompt', 'prompt', 'prompt', 'artifact', 'ai'])
  assert.ok(L.every((x) => !x.type && !x.line && !x.prompt && !x.name && x.request))
  assert.equal(L[0].work, '조사')
})
test('시간순 보기 — 허락에서 뺀 턴은 「빠진 턴」으로만', () => {
  const L = timelineLines({ item: TRENDS, depth: 'content', turns: TURNS, exclude: ['m1'] })
  assert.deepEqual(L[0], { kind: 'excluded', at: TURNS[0].at })
  assert.ok(!has(L, '원문표지'))
})

test('다시 만들기 대상: 요약이 없거나 맥락이 그 뒤로 바뀐 것', () => {
  const st = staleOf([TRENDS, { ...EDU, built_at: null }, { ...MEMO, built_at: ago(4) }, { ...OLD, turns: 0, kinds: {} }])
  assert.deepEqual(st.map((c) => c.id), ['c-edu', 'c-memo'])
})
test('턴 수: 라우터의 수와 요약이 센 요청 수 중 큰 쪽', () => {
  assert.equal(turnsN(TRENDS), 8)
  assert.equal(turnsN({ turns: 5, kinds: { 조사: 2 } }), 5)
  assert.equal(turnsN({}), 0)
})
test('관계 이름', () => {
  assert.deepEqual(Object.values(R).map(relLabel), ['본인', '내 팀원', '같은 팀', '같은 부서', '관리자로 봄'])
  assert.equal(relLabel({ member: true }), '다른 팀')
})
