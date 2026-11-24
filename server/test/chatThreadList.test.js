// The chat's thread list (src/threadList.js — spec openspec/specs/chat-thread-list): the rows' order, the search box (plain text, for
// finding a row), the row's line and time, the remembered open state, and the 「채팅」 tab's click vs double click. No database, no model.
//   cd server && node --test test/chatThreadList.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { sortThreads, filterThreads, threadLine, lastRequest, whenText, readListOpen, saveListOpen, OPEN_KEY, createTaps } from '../../src/threadList.js'

const NOW = Date.parse('2026-11-24T12:00:00+09:00')
const ago = (min) => new Date(NOW - min * 60_000).toISOString()
const ROWS = [
  { id: 'report', title: '주간 보고서 초안', gist: '보고서 작성', summary: '최근 요청: 이번 주 매출 보고서 초안 써 줘\n최근 답: 초안을 만들었어요.', updated_at: ago(120) },
  { id: 'trip', title: '부산 출장 숙소', gist: '숙소 비교', summary: '최근 요청: 해운대 근처 숙소 세 곳 비교해 줘\n최근 답: 표로 정리했어요.', updated_at: ago(5) },
  { id: 'yt', title: '유튜브 채널 분석', gist: '', summary: '최근 요청: 채널 최근 영상 10개 조회수', updated_at: ago(3 * 1440) },
  { id: 'quote', title: '견적서 검토', gist: '', summary: '', updated_at: ago(30) },
]

test('CT-U-01 순서: 최근 것이 위, 시간이 없는 행은 맨 아래, 같은 시각은 들어온 차례', () => {
  assert.deepEqual(sortThreads(ROWS).map((c) => c.id), ['trip', 'quote', 'report', 'yt'])
  const same = [{ id: 'a', updated_at: ago(10) }, { id: 'b', updated_at: ago(10) }, { id: 'none' }, { id: 'c', updated_at: ago(1) }]
  assert.deepEqual(sortThreads(same).map((c) => c.id), ['c', 'a', 'b', 'none'])
  assert.deepEqual(sortThreads(null), [])
  // the input is left as it was (the store's getter)
  assert.equal(ROWS[0].id, 'report')
})

test('CT-U-02 찾기: 제목 · 요약(요청과 답) · gist 에서 낱말마다, 대소문자 무시, 빈 칸이면 모두', () => {
  const ids = (q) => filterThreads(ROWS, q).map((c) => c.id)
  assert.deepEqual(ids(''), ['report', 'trip', 'yt', 'quote'])
  assert.deepEqual(ids('   '), ['report', 'trip', 'yt', 'quote'])
  assert.deepEqual(ids('보고'), ['report'])
  assert.deepEqual(ids('해운대'), ['trip'])           // the last request
  assert.deepEqual(ids('표로 정리'), ['trip'])        // the last answer, two words
  assert.deepEqual(ids('숙소 비교'), ['trip'])        // the gist
  assert.deepEqual(ids('유튜브   조회수'), ['yt'])     // words anywhere, extra spaces
  assert.deepEqual(ids('YOUTUBE'), [])
  assert.deepEqual(filterThreads([{ id: 'en', title: 'Weekly Report', summary: '' }], 'report').map((c) => c.id), ['en'])
  // the summary's labels are not words of the conversation
  assert.deepEqual(ids('최근 요청'), [])
  assert.deepEqual(ids('없는 말'), [])
  assert.deepEqual(filterThreads(undefined, 'x'), [])
})

test('CT-U-03 행의 한 줄: gist · 마지막 요청, 하나뿐이면 그것만, 영어 요약의 표지도 뗌', () => {
  assert.equal(threadLine(ROWS[1]), '숙소 비교 · 해운대 근처 숙소 세 곳 비교해 줘')
  assert.equal(threadLine(ROWS[2]), '채널 최근 영상 10개 조회수')
  assert.equal(threadLine({ gist: '보고서 작성', summary: '' }), '보고서 작성')
  assert.equal(threadLine(ROWS[3]), '')
  assert.equal(lastRequest('Latest request: Compare three hotels\nLatest answer: Done.'), 'Compare three hotels')
  assert.equal(threadLine({ gist: '같은 말', summary: '최근 요청: 같은 말' }), '같은 말')
})

test('CT-U-04 시각: 「N분 전 · N시간 전 · 날짜」(대화 막대와 같은 말)', () => {
  assert.equal(whenText(ago(0.2), NOW), '1분 전')
  assert.equal(whenText(ago(5), NOW), '5분 전')
  assert.equal(whenText(ago(59), NOW), '59분 전')
  assert.equal(whenText(ago(120), NOW), '2시간 전')
  assert.equal(whenText(ago(3 * 1440), NOW), new Date(NOW - 3 * 1440 * 60_000).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }))
  assert.equal(whenText('not a date', NOW), '')
})

test('CT-U-05 열어 둔 채인지: 이 브라우저에 「1」 · 「0」, 저장소가 막혀도 오류 없이 닫힘', () => {
  const mem = new Map()
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) }
  assert.equal(readListOpen(storage), false)
  saveListOpen(true, storage)
  assert.equal(mem.get(OPEN_KEY), '1')
  assert.equal(readListOpen(storage), true)
  saveListOpen(false, storage)
  assert.equal(readListOpen(storage), false)
  const blocked = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceeded') } }
  assert.equal(readListOpen(blocked), false)
  assert.doesNotThrow(() => saveListOpen(true, blocked))
  assert.equal(readListOpen(null), false)
  assert.doesNotThrow(() => saveListOpen(true, null))
})

// a fake clock and a record of what ran
function rig(gap = 400) {
  let t = 1000
  const log = []
  const taps = createTaps({ gap, now: () => t })
  let shown = false
  const handlers = {
    single: () => { log.push('single'); return shown },
    double: (was) => { log.push(`double:${was}`); shown = !(was ?? shown) },
  }
  return { taps, log, handlers, at: (ms) => { t += ms }, shown: () => shown, set: (v) => { shown = v } }
}

const M = (detail) => ({ detail, pointerType: 'mouse' })
const T = (detail = 1) => ({ detail, pointerType: 'touch' })

test('CT-U-06 한 번 누르기: 기다리지 않고 바로, 사이를 두고 누르면 매번', () => {
  const r = rig()
  assert.equal(r.taps.click(M(1), r.handlers), 'single')
  assert.deepEqual(r.log, ['single'])
  r.at(900)
  assert.equal(r.taps.click(M(1), r.handlers), 'single')
  // a mouse: the browser's count decides — two separate clicks close together are two single clicks
  r.at(150)
  assert.equal(r.taps.click(M(1), r.handlers), 'single')
  // a touch: two taps far apart
  r.at(401)
  assert.equal(r.taps.click(T(1), r.handlers), 'single')
  assert.deepEqual(r.log, ['single', 'single', 'single', 'single'])
})

test('CT-U-07 두 번 누르기(마우스): 둘째 click 은 다시 이동하지 않고 목록을 한 번만 — 뒤이은 dblclick 은 무시', () => {
  const r = rig()
  r.taps.click(M(1), r.handlers)
  r.at(120)
  assert.equal(r.taps.click(M(2), r.handlers), 'double')
  assert.equal(r.taps.dblclick(M(2), r.handlers), 'ignored')
  assert.deepEqual(r.log, ['single', 'double:false'])
  assert.equal(r.shown(), true)
  // and twice again closes it — even right after (✕ pressed, then a double click 300 ms later)
  r.at(300)
  assert.equal(r.taps.click(M(1), r.handlers), 'single')
  r.at(150)
  assert.equal(r.taps.click(M(2), r.handlers), 'double')
  r.taps.dblclick(M(2), r.handlers)
  assert.deepEqual(r.log, ['single', 'double:false', 'single', 'double:true'])
  assert.equal(r.shown(), false)
})

test('CT-U-08 두 번 누르기(터치): 브라우저가 탭 수를 안 세도(detail 1) 시간으로, dblclick 만 와도', () => {
  const r = rig()
  r.taps.click(T(1), r.handlers)
  r.at(250)
  assert.equal(r.taps.click(T(1), r.handlers), 'double')
  assert.deepEqual(r.log, ['single', 'double:false'])
  // a browser that counts taps and sends dblclick after the two clicks: still once
  r.at(1000)
  r.taps.click(T(1), r.handlers)
  r.at(200)
  r.taps.click(T(2), r.handlers)
  assert.equal(r.taps.dblclick({}, r.handlers), 'ignored')
  assert.deepEqual(r.log, ['single', 'double:false', 'single', 'double:true'])
  // a click event that is no PointerEvent (no pointerType): by time too
  r.at(1000)
  r.taps.click({ detail: 1 }, r.handlers)
  r.at(200)
  assert.equal(r.taps.click({ detail: 1 }, r.handlers), 'double')
})

test('CT-U-09 첫 클릭이 화면을 바꿔도 두 번 누르기는 첫 클릭 전의 화면 기준(휴대폰: 시트를 닫은 뒤에도 닫힘으로)', () => {
  const r = rig()
  r.set(true)
  // the first tap puts the sheet away (a phone), the second must not open it again
  const phone = { single: () => { const was = r.shown(); r.set(false); r.log.push('single'); return was }, double: r.handlers.double }
  r.taps.click(T(1), phone)
  r.at(200)
  r.taps.click(T(2), phone)
  assert.equal(r.shown(), false)
  assert.deepEqual(r.log, ['single', 'double:true'])
})

test('CT-U-10 세 번 누르기 · 키보드(detail 0) 두 번 · 첫 클릭을 못 본 두 번 누르기', () => {
  const r = rig()
  r.taps.click(M(1), r.handlers)
  r.at(100)
  r.taps.click(M(2), r.handlers)
  r.taps.dblclick(M(2), r.handlers)
  r.at(100)
  assert.equal(r.taps.click(M(3), r.handlers), 'ignored')
  r.at(100)
  assert.equal(r.taps.click(T(1), r.handlers), 'ignored')   // a fourth tap within the burst
  assert.deepEqual(r.log, ['single', 'double:false'])
  // Enter pressed twice quickly on the focused tab (clicks with detail 0, no pointer)
  r.at(2000)
  assert.equal(r.taps.click({ detail: 0, pointerType: '' }, r.handlers), 'single')
  r.at(200)
  assert.equal(r.taps.click({ detail: 0, pointerType: '' }, r.handlers), 'double')
  // the first click went to the page before (another top bar): the second, counted 2 by the browser, still opens the list
  r.at(3000)
  assert.equal(r.taps.click(M(2), r.handlers), 'double')
  assert.equal(r.log.at(-1), 'double:undefined')
  // and a dblclick alone (its clicks unseen) too
  r.at(3000)
  r.taps.click(M(1), r.handlers)
  r.at(3000)
  assert.equal(r.taps.dblclick({}, r.handlers), 'double')
})
