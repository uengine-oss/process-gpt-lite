// 2026-11-21 phone review: the pure pieces behind the fixes (no database, no model).
import test from 'node:test'
import assert from 'node:assert/strict'
import { marked } from 'marked'
import { noticeText } from '../../src/noticeText.js'
import { installCjkMarkdown } from '../../src/markdownCjk.js'
import { wantsRunNow, telegramIntent, pickSchedule, recentScheduleIds, sendsToTelegram } from '../lib/scheduleIntent.js'
import { createTrail, hostsIn, trailEntry } from '../lib/workTrail.js'
import { marketHint, stripInventedCodes } from '../lib/marketHint.js'

// the notice from the recording: an agent answer with its ```json block copied into the title
const LEAVE = '휴가 신청이 성공적으로 완료되었습니다. 이번 주 목요일(12월 28일)부터 금요일(12월 29일)까지 휴가를 신청하셨습니다. 상사와 인사팀의 승인을 기다리시면 됩니다. 추가로 궁금한 점이 있거나 다른 요청이 있으시면 언제든지 말씀해 주세요! 😊 ```json { "action": "process_executed", "status": "success", "message": "휴가 신청이 성공적으로 완료되었습니다.", "data": { "instance_id": "leave_request_and_approval_process.ae1d7b9d-41d2-4209-b919-d8285a0f13d3" }, "next_actions": ["휴가 신청 상태 확인", "다른 프로세스 실행"] } ```'

test('R-1121-01 a notice title drops the JSON an agent answer carried, and stays short', () => {
  const t = noticeText(LEAVE, 160)
  assert.ok(!t.includes('{') && !t.includes('instance_id') && !t.includes('```'), t)
  assert.ok(t.startsWith('휴가 신청이 성공적으로 완료되었습니다.'))
  assert.ok(t.length <= 160)
  assert.ok(t.endsWith('말씀해 주세요! 😊'), t)
  assert.ok(noticeText(LEAVE.repeat(3).replace(/```json[^`]*```/g, ''), 160).endsWith('…'))
})

test('R-1121-02 a cut-off fence, a bare JSON tail and markdown marks', () => {
  assert.equal(noticeText('완료했어요. ```json {"a": 1, "b": "x'), '완료했어요.')
  assert.equal(noticeText('완료했어요. {"status": "success", "id": "p.1"}'), '완료했어요.')
  assert.equal(noticeText('**견적서** 를 [열어](https://x.y/z) 보세요\n\n# 제목'), '견적서 를 열어 보세요 제목')
  assert.equal(noticeText(''), '')
  assert.equal(noticeText('평범한 제목'), '평범한 제목')
  // a brace in the middle of a sentence is not a JSON tail
  assert.equal(noticeText('집합 {a, b} 를 비교했어요'), '집합 {a, b} 를 비교했어요')
})

test('R-1121-03 **bold** closes before a Korean particle', () => {
  installCjkMarkdown()
  assert.match(marked.parse('**AST모바일(096540)**은 조회 데이터에서'), /<strong>AST모바일\(096540\)<\/strong>은/)
  assert.match(marked.parse('**코스피**가 올랐어요'), /<strong>코스피<\/strong>가/)
  assert.match(marked.parse('- **KOSPI**: 현재 4,869.96'), /<li><strong>KOSPI<\/strong>: 현재/)
  // what CommonMark already did stays the same
  assert.match(marked.parse('a **b** c'), /a <strong>b<\/strong> c/)
  assert.match(marked.parse('`**code**`'), /<code>\*\*code\*\*<\/code>/)
  assert.match(marked.parse('** 띄움 **'), /\*\* 띄움 \*\*/)
})

test('R-1121-04 "run it now" is not a new schedule; a delay or a time is', () => {
  for (const t of ['곧바로 하나 정도 한번 실행해 봐', '지금 바로 돌려 봐', '한번 실행해봐', '테스트로 실행해 줘', 'run it now'])
    assert.equal(wantsRunNow(t), true, t)
  for (const t of ['10분 뒤에 한 번 실행해 줘', '내일 오전 9시에 실행해 줘', '매일 아침 8시에 바로 실행해줘', '이렇게 지시를 했는데 이게 되는지 확인을 좀 해봐야겠죠', '휴가 신청 프로세스 실행해줘'])
    assert.equal(wantsRunNow(t), false, t)
})

test('R-1121-05 Telegram words: alerts · send · off · connect', () => {
  assert.equal(telegramIntent('급등락이 감지되면 내 텔레그램 봇으로 알려줘'), 'alerts')
  assert.equal(telegramIntent('이거 텔레그램으로 보내줘'), 'send')
  assert.equal(telegramIntent('텔레그램 알림 꺼 줘'), 'off')
  assert.equal(telegramIntent('텔레그램 봇 연결해 줘'), 'connect')
  assert.equal(telegramIntent('주가 알려줘'), null)
})

test('R-1121-06 which task: named, else the one this conversation just set up or ran', () => {
  const a = { id: 'a1111111-0000', name: '주식 5일 누적 5% 급등락 감시' }
  const b = { id: 'b2222222-0000', name: '매일 아침 인기 유튜브 영상 브리핑' }
  const rows = [{ kind: 'chip', content: { scheduleId: b.id } }, { kind: 'text', content: { text: '…' } }, { kind: 'chip', content: { scheduleId: a.id } }]
  assert.deepEqual(recentScheduleIds(rows), [a.id, b.id])
  assert.equal(pickSchedule([a, b], '매일 아침 인기 유튜브 영상 브리핑 지금 돌려 봐', recentScheduleIds(rows)).id, b.id)
  assert.equal(pickSchedule([a, b], '곧바로 하나 정도 한번 실행해 봐', recentScheduleIds(rows)).id, a.id)
  // run-now never falls back to "the only task" — the words may be about a process
  assert.equal(pickSchedule([a], '바로 실행해 줘', [], { only: false }), null)
  assert.equal(pickSchedule([a], '텔레그램으로 알려줘', []).id, a.id)
  assert.equal(sendsToTelegram({ state: { channels: ['telegram'] } }), true)
  assert.equal(sendsToTelegram({ state: {} }), false)
})

test('R-1121-07 the work trail names steps and sites, never a command or a key', () => {
  const tr = createTrail()
  tr.add('execute', { command: 'curl -H "User-Agent: Mozilla/5.0" "https://ac.stock.naver.com/ac?q=AST&target=stock&key=SECRET123"' }, '실행하는 중')
  tr.add('execute', { command: 'curl https://api.stock.naver.com/chart/foreign/item/ASTS.O/day' }, '실행하는 중')
  tr.add('web_search', { query: 'AST SpaceMobile 주가' }, '찾아보는 중')
  tr.add('read_file', { file_path: '/workspace/x/report.md' }, '파일 살펴보는 중')
  tr.add('write_todos', { todos: [] }, '할 일 정리하는 중')
  const list = tr.list()
  const text = JSON.stringify(list)
  assert.ok(!text.includes('SECRET123') && !text.includes('curl') && !text.includes('User-Agent'), text)
  assert.deepEqual(tr.hosts(), ['ac.stock.naver.com', 'api.stock.naver.com'])
  assert.equal(list.find((e) => e.query)?.query, 'AST SpaceMobile 주가')
  assert.equal(list.find((e) => e.file)?.file, 'report.md')
  assert.equal(list.some((e) => e.tool === 'write_todos'), false)
  assert.deepEqual(hostsIn('http://localhost:8787/x https://www.youtube.com/watch?v=1'), ['youtube.com'])
  assert.deepEqual(trailEntry('fetch', '{"url":"https://m.stock.naver.com/api"}', '찾아보는 중').hosts, ['m.stock.naver.com'])
})

test('R-1121-08 a stock request gets where prices are and how to find the listing', () => {
  const h = marketHint('코스피 코스닥 그리고 테슬라, ast 모바일 주가를 1시간 주기로 파악해서 5일 누적 급락과 급등(5프로)가 있으면 내게 알려줘')
  assert.match(h, /ac\.stock\.naver\.com/)
  assert.match(h, /ASTS/)
  assert.match(h, /출처/)
  assert.equal(marketHint('회의록 정리해 줘'), '')
})

test('R-1121-09 a stock task keeps the names as said: no guessed listing codes', () => {
  const said = '코스피 코스닥 그리고 테슬라, ast 모바일 주가를 1시간 주기로 파악해서 5일 누적 급락과 급등(5프로)가 있으면 내게 알려줘'
  const p = '코스피, 코스닥, 테슬라(TSLA), AST모바일(031440)의 현재 지수/주가를 조회하고 5일 누적 변동률(5%)을 계산해'
  const out = stripInventedCodes(p, said)
  assert.ok(!out.includes('031440') && !out.includes('TSLA'), out)
  assert.ok(out.includes('AST모바일의 현재') && out.includes('(5%)'), out)
  // a code the person gave stays
  assert.ok(stripInventedCodes('삼성전자(005930) 주가 알려줘', '삼성전자(005930) 주가 매일 알려줘').includes('005930'))
  // not a stock request: untouched
  assert.equal(stripInventedCodes('회의(ABC1) 정리', '회의 정리해줘'), '회의(ABC1) 정리')
})

// pre-merge review (2026-11-21): the words must not take over other requests
test('R-1121-10 Telegram words are ours only with a clear ask — a how-to question or a new recurring job goes to the router', () => {
  assert.equal(telegramIntent('텔레그램 봇 만드는 방법 알려줘'), null)
  assert.equal(telegramIntent('매일 아침 텔레그램 채널 요약해서 알려줘'), null)
  assert.equal(telegramIntent('텔레그램 좋아?'), null)
  assert.equal(telegramIntent('텔레그램으로도 알려줘'), 'alerts')
})

test('R-1121-11 "run it now" is not taken when the message names something else to run', () => {
  assert.equal(wantsRunNow('휴가 신청 프로세스 바로 실행해줘'), false)
  assert.equal(wantsRunNow('이 스크립트 먼저 실행해 봐'), false)
  assert.equal(wantsRunNow('곧바로 하나 정도 한번 실행해 봐'), true)
})

test('R-1121-12 only listing-shaped codes are taken out of a stock task; units and abbreviations stay', () => {
  const out = stripInventedCodes('KODEX 200(ETF) 종가를 매일 9시(KST) 기준, 테슬라(TSLA), AST모바일(031440), 상위 (10)개', '주가 알려줘')
  assert.equal(out, 'KODEX 200(ETF) 종가를 매일 9시(KST) 기준, 테슬라, AST모바일, 상위 (10)개')
})

test('R-1121-13 a sentence after an inline JSON snippet is not cut from a notice', () => {
  assert.equal(noticeText('설정 {"a":1} 을 저장했고 결과는 목록 [1]'), '설정 {"a":1} 을 저장했고 결과는 목록 [1]')
})
