// 공개 등급 고르기의 순수 함수(lib/context/grade.js) — DB 없이: 「누가 무엇을 보게 되나」 묶음, 조사, 민감 규칙.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { josa, ro, gradeLabel, sensitiveHit, previewGroups, reasonOf, SENSITIVE_OPEN } from '../lib/context/grade.js'
import { depthOf, sensitiveBlocks } from '../lib/context/visibility.js'
import { parseChart, relation } from '../lib/context/org.js'

// 시드(seed-team-context.mjs)와 같은 모양: 서진컨설팅(관리자 윤서진) › 컨설팅본부 › 전략팀(박하늘 장, 이도윤)·제안팀(최유나 장, 정하은)
const P = (id) => ({ id, data: { id, name: id } })
const chart = { id: 'root', data: { name: '서진컨설팅' }, children: [
  P('윤서진'),
  { id: 'hq', data: { id: 'hq', name: '컨설팅본부', isTeam: true }, children: [
    { id: 'strategy', data: { id: 'strategy', name: '전략팀', isTeam: true }, children: [P('박하늘'), P('이도윤'), { id: 'ai-1', data: { id: 'ai-1', name: '리서치 직원', isAgent: true } }] },
    { id: 'proposal', data: { id: 'proposal', name: '제안팀', isTeam: true }, children: [P('최유나'), P('정하은')] },
  ] },
] }
const { nodes, people } = parseChart(chart)
const org = { nodes, people, leads: new Map([['strategy', '박하늘'], ['proposal', '최유나']]), admins: new Set(['윤서진']), users: [] }
const names = (list) => list.map((p) => p.name).sort((a, b) => a.localeCompare(b, 'ko'))
const item = (o) => ({ owner: '이도윤', sensitive: 'none', ...o })

test('조사: 받침 있음/없음/ㄹ 받침, 숫자·영문 끝', () => {
  assert.equal(josa('경쟁 서비스 동향'), '이')
  assert.equal(josa('사내 교육 자료 정리'), '가')
  assert.equal(josa('고객 B'), '가')
  assert.equal(josa('3분기 보고서」'), '가')            // 끝 문장부호는 건너뛴다
  assert.equal(josa('A사 9900', '을', '를'), '을')       // 영
  assert.equal(josa('연봉 협상 준비', '을', '를'), '를')
  assert.equal(josa('개인 학습 메모', '은', '는'), '는')
  assert.equal(josa('', '이', '가'), '가')
})
test('「으로/로」: 받침 없음·ㄹ 받침은 로, 그 밖의 받침은 으로', () => {
  assert.equal(ro('요약 공개 · 팀'), '으로')
  assert.equal(ro('전체 공개 · 회사'), '로')
  assert.equal(ro('요약 공개 · 부서'), '로')
  assert.equal(ro('비공개'), '로')
  assert.equal(ro('제목 공개'), '로')
  assert.equal(ro('서울'), '로')                           // ㄹ 받침
  assert.equal(ro('7'), '로')                              // 칠
  assert.equal(ro('3'), '으로')                            // 삼
})
test('등급 이름: 범위는 요약·전체 공개에서만 붙는다', () => {
  assert.equal(gradeLabel('summary', 'team'), '요약 공개 · 팀')
  assert.equal(gradeLabel('open', 'company'), '전체 공개 · 회사')
  assert.equal(gradeLabel('listed', 'company'), '제목 공개')
  assert.equal(gradeLabel('private', 'department'), '비공개')
  assert.equal(gradeLabel('bogus', 'x'), '비공개')
})

test('민감 규칙: 인사·급여·연봉·계약 조건·건강·병가·징계·주민등록·개인정보', () => {
  const hits = {
    '연봉 협상 준비': '연봉', '팀원 급여 조정안': '급여', '하반기 인사 평가 기준': '인사', '인사 발령 초안': '인사', '「인사」 메모': '인사',
    '근로 계약 갱신': '계약 조건', '채용 조건 비교': '계약 조건', '건강검진 결과 정리': '건강', '병가 신청 처리': '병가', '징계 위원회 준비': '징계',
    '주민등록번호 마스킹': '주민등록', '고객 개인정보 처리방침': '개인정보', '이직 준비 메모': '이직',
  }
  for (const [t, k] of Object.entries(hits)) assert.equal(sensitiveHit(t), k, t)
  // 제목·목적·요약을 함께 본다
  assert.equal(sensitiveHit('팀 운영 메모', '', '면담에서 희망 연봉을 물었다'), '연봉')
})
test('민감 규칙: 비슷하지만 아닌 말은 제안하지 않는다(시드 맥락 포함)', () => {
  for (const t of ['인사이트 정리', '인사말 다듬기', '고객 B 가격 협상', '3년 계약 시 최대 12% 할인 가능', '개인 학습 메모', '고객 정보 보호를 위해 외부 전송 금지',
    '경쟁 서비스 동향', '가격 정책 조사', '제안서 표준 목차', '회사 운영 원칙', '팀 운영 회의', '사내 교육 자료 정리']) assert.equal(sensitiveHit(t), null, t)
})

test('미리보기: 요약 공개 · 팀 → 회사로 넓히면 정하은·최유나가 요약 칸에 새로 든다(spec)', () => {
  const cur = item({ visibility: 'summary', reach: 'team' }), next = { ...cur, reach: 'company' }
  const g = previewGroups(org, '이도윤', cur, next)
  assert.deepEqual(names(g.summary), ['박하늘', '윤서진', '정하은', '최유나'])
  assert.deepEqual(g.added.summary.sort(), ['정하은', '최유나'].sort())
  assert.deepEqual(g.content, [])
  assert.equal(g.hidden, 0)
  assert.ok(!g.summary.some((p) => p.name === '이도윤'), '주인은 빠진다')
  assert.ok(!g.summary.some((p) => p.name === '리서치 직원'), 'AI 직원 노드는 사람이 아니다')
  // 지금 그대로일 때: 박하늘은 같은 팀(등급), 윤서진은 관리자 덧씌움, 정하은·최유나는 제목
  const now = previewGroups(org, '이도윤', cur, cur)
  assert.deepEqual(names(now.title), ['정하은', '최유나'])
  assert.equal(now.summary.find((p) => p.name === '윤서진').via, 'admin')
  assert.equal(now.summary.find((p) => p.name === '박하늘').via, 'grade')
  assert.equal(now.added.summary.length, 0)
})
test('미리보기: 제목 공개면 장은 「전략팀장」 이유로 요약, 관리자는 「관리자」, 다른 팀은 제목', () => {
  const cur = item({ visibility: 'listed', reach: 'team' })
  const g = previewGroups(org, '이도윤', cur, cur)
  const park = g.summary.find((p) => p.name === '박하늘'), yoon = g.summary.find((p) => p.name === '윤서진')
  assert.deepEqual([park.via, park.reason], ['lead', '전략팀장'])
  assert.deepEqual([yoon.via, yoon.reason], ['admin', '관리자'])
  assert.deepEqual(names(g.title), ['정하은', '최유나'])
  assert.equal(park.team, '전략팀')
})
test('미리보기: 비공개로 좁히면 모두 숨고 덜 보게 되는 사람이 나온다', () => {
  const cur = item({ visibility: 'summary', reach: 'team' }), next = { ...cur, visibility: 'private' }
  const g = previewGroups(org, '이도윤', cur, next)
  assert.equal(g.title.length + g.summary.length + g.content.length, 0)
  assert.equal(g.hidden, 4)
  assert.deepEqual(names(g.lost), ['박하늘', '윤서진', '정하은', '최유나'])
  assert.equal(g.lost.find((p) => p.name === '박하늘').from, 'summary')
})
test('미리보기: 원문 칸에는 범위 안(전체 공개)이나 허락받은 사람만 — 허락은 방과 관계없이 보인다', () => {
  const cur = item({ visibility: 'summary', reach: 'team' })
  const grants = [{ grantee: '정하은', depth: 'content', duration: 'task', room: 'thread-1', thread_id: 'thread-1', until: new Date(Date.now() + 86400000).toISOString(), via: 'auto' },
    { grantee: '최유나', depth: 'content', duration: 'forever', revoked_at: new Date().toISOString(), via: 'owner' }]
  const g = previewGroups(org, '이도윤', cur, cur, grants)
  assert.deepEqual(names(g.content), ['정하은'])
  assert.equal(g.content[0].via, 'grant')
  assert.match(g.content[0].reason, /허락\(자동 허용 · 이 작업 동안\)/)
  assert.ok(g.title.some((p) => p.name === '최유나'), '회수된 허락은 쓰지 않는다')
  const open = previewGroups(org, '이도윤', cur, { ...cur, visibility: 'open' }, grants)
  assert.deepEqual(names(open.content), ['박하늘', '정하은'])
  assert.deepEqual(open.added.content, ['박하늘'])
})
test('민감 항목: 전체 공개 불가, 장·관리자에게도 제목만', () => {
  const s = { owner: '최유나', visibility: 'summary', reach: 'team', sensitive: 'confirmed' }
  assert.equal(sensitiveBlocks({ ...s, visibility: 'open' }), true)
  assert.equal(sensitiveBlocks(s), false)
  assert.equal(sensitiveBlocks({ ...s, sensitive: 'proposed', visibility: 'open' }), false, '제안은 승인 전까지 적용되지 않는다')
  assert.equal(SENSITIVE_OPEN, '민감 항목은 전체 공개로 열 수 없습니다')
  const g = previewGroups(org, '최유나', s, s)
  assert.ok(g.title.some((p) => p.name === '윤서진'), '관리자는 제목만')
  assert.deepEqual(names(g.summary), ['정하은'], '같은 팀만 요약')
  const listed = previewGroups(org, '최유나', { ...s, visibility: 'listed' }, { ...s, visibility: 'listed' })
  assert.equal(listed.summary.length, 0, '제목 공개 민감 항목: 덧씌움 없음')
})
test('근거: 허락 > 장 > 관리자 > 등급', () => {
  const rel = relation(org, '박하늘', '이도윤')
  assert.equal(reasonOf(depthOf(item({ visibility: 'listed' }), rel), rel, org).via, 'lead')
  assert.equal(reasonOf(depthOf(item({ visibility: 'summary' }), rel), rel, org).via, 'grade')
  const g = { depth: 'content', duration: '7d', until: new Date(Date.now() + 3600000).toISOString(), via: 'owner' }
  assert.equal(reasonOf(depthOf(item({ visibility: 'listed' }), rel, { grants: [g] }), rel, org).via, 'grant')
})
