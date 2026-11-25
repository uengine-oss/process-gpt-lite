// 되풀이하는 일은 멈춤이 아니다 · 동작 한도는 나아가는 동안 늘어난다 (2026-11-25 녹화 「NotebookLM '제목없음' 노트북 모두 삭제」 —
// more_vert → delete 삭제 → 삭제 를 거듭하며 한 번에 하나씩 지웠는데 동작 40번에서 「같은 화면에서 멈춤」으로 멈췄다).
// lib/browserProgress.js (구조 신호만: 무엇을 눌렀는지, 그 직전 화면에 무엇이 몇 개 있었는지) · lib/browser.js briefOf · lib/browserQueue.js
// 의 판정 고르기 — 브라우저 · 모델 · DB 없이, 녹화의 화면을 본뜬 스냅숏 열로.
//   BQ-P-01~07 진행과 헛돎, 한도   BQ-J-01~06 판정 확률 → 고르기   BQ-B-01 짧은 결과
import test from 'node:test'
import assert from 'node:assert/strict'
import { turnOf, progressOf, budgetAfter, BLOCK, HARD, itemsOf } from '../lib/browserProgress.js'
import { waitPick, waitOptions, queueDefault, resumePick, resumeOptions, ANSWER_BAR } from '../lib/browserQueue.js'

// ---- snapshots shaped like the recording (NotebookLM's list of 「제목 없는 노트북」, its row menu, its confirm dialog) ----
const URL = 'https://notebooklm.google.com/'
const rowEls = (rows) => rows.flatMap((d) => [{ tag: 'a', text: `제목 없는 노트북 소스 0개 ${d} 소유자` }, { tag: 'button', text: 'more_vert' }])
const list = (rows, extra = {}) => ({ url: URL, title: 'Gemini Notebook', text: ['노트북', ...rows.flatMap((d) => ['제목 없는 노트북', '소스 0개', d, '소유자'])].join('\n'), els: [{ tag: 'button', text: '새 노트북' }, ...rowEls(rows)], ...extra })
const withMenu = (rows) => { const s = list(rows); return { ...s, els: [...s.els, { tag: 'button', text: 'delete 삭제' }, { tag: 'button', text: 'edit 이름 바꾸기' }] } }
const withDialog = (rows) => { const s = list(rows); return { ...s, text: `${s.text}\n노트북을 삭제할까요?`, els: [...s.els, { tag: 'button', text: '취소' }, { tag: 'button', text: '삭제' }] } }
const dates = (n, from = 0) => Array.from({ length: n }, (_, i) => `2026. 9. ${from + i + 1}.`)
// one round of the recording: more_vert on the list, 「delete 삭제」 on its menu, 「삭제」 on the dialog — the row goes when `removes`
function rounds(n, { start = 30, removes = true, slide = false } = {}) {
  const trail = []
  let rows = dates(start)
  let next = start
  for (let k = 0; k < n; k++) {
    trail.push(turnOf('click', { i: 3 }, 'more_vert', list(rows)))
    trail.push(turnOf('click', { i: 70 }, 'delete 삭제', withMenu(rows)))
    trail.push(turnOf('click', { i: 72 }, '삭제', withDialog(rows)))
    if (removes) rows = slide ? [...rows.slice(1), `2026. 10. ${++next - start}.`] : rows.slice(1)
  }
  return trail
}

test('BQ-P-01 녹화의 삭제 되풀이: 라운드마다 목록이 하나씩 줄면 진행이고(shrinks), 처리한 수를 센다', () => {
  const p = progressOf(rounds(13))
  assert.equal(p.progress, true)
  assert.equal(p.how, 'shrinks')
  assert.equal(p.rounds, 13)
  assert.equal(p.count, 12, '라운드 사이 12번 줄었다')
})

test('BQ-P-02 같은 화면에서 같은 동작(「삭제」를 눌러도 목록이 그대로): 진행이 아니다', () => {
  const p = progressOf(rounds(13, { removes: false }))
  assert.equal(p.progress, false)
  assert.equal(p.count, 0)
})

test('BQ-P-03 두 화면을 오가는 되풀이(앞서 본 화면으로 돌아옴): 진행이 아니다', () => {
  const a = list(dates(10)), b = list(dates(9, 1))
  const trail = Array.from({ length: 12 }, (_, k) => turnOf('click', { i: 3 }, 'more_vert', k % 2 ? b : a))
  assert.equal(progressOf(trail).progress, false)
})

test('BQ-P-04 맨 위 줄이 지워지고 아래에서 새 줄이 올라오는 목록(개수는 같음): 라운드마다 다른 것이 사라지면 진행(distinct)', () => {
  const p = progressOf(rounds(8, { slide: true }))
  assert.equal(p.progress, true)
  assert.equal(p.how, 'distinct')
  assert.equal(p.count, 7)
})

test('BQ-P-05 시계처럼 글 한 줄만 바뀌는 화면, 내리기만 되풀이: 진행이 아니다', () => {
  const clock = (k) => ({ ...list(dates(10)), text: `${list(dates(10)).text}\n${k}초 전에 저장됨` })
  assert.equal(progressOf(Array.from({ length: 10 }, (_, k) => turnOf('click', { i: 3 }, '새로 고침', clock(k)))).progress, false)
  // scrolling on and on (an endless feed) is never the rounds' anchor
  const scrolls = Array.from({ length: 10 }, (_, k) => turnOf('scroll', { dy: 600 }, '', list(dates(10, k * 10))))
  assert.equal(progressOf(scrolls).progress, false)
  assert.equal(progressOf(scrolls).rounds, 0)
})

test('BQ-P-06 한도: 40번에서 나아가는 중이면 한 블록 더(80), 헛돌면 그대로, 160 을 넘지 않는다', () => {
  assert.equal(BLOCK, 40)
  assert.equal(HARD, 160)
  const going = rounds(14) // 42 actions
  assert.deepEqual(({ ...budgetAfter(going, 40, 40), progress: undefined }), { budget: 80, extended: true, progress: undefined })
  assert.equal(budgetAfter(going, 39, 40).extended, false, '아직 한도 전')
  assert.equal(budgetAfter(rounds(14, { removes: false }), 40, 40).extended, false, '같은 화면 되풀이는 늘리지 않는다')
  assert.equal(budgetAfter(rounds(60, { start: 80 }), 160, 160).extended, false, '160 이 끝')
  assert.equal(budgetAfter(rounds(60, { start: 80 }), 120, 120).budget, 160)
})

test('BQ-P-07 느린 화면 한 번(지운 줄이 아직 보임)은 봐주지만, 마지막 라운드가 그대로면 진행이 아니다', () => {
  const t = rounds(6)
  // one round on a list that had not caught up yet: the same list as the round before
  const slow = [...t.slice(0, 9), ...t.slice(6, 9), ...t.slice(9)]
  assert.equal(progressOf(slow).progress, true, '한 번은 봐준다')
  const stalled = [...t, ...rounds(1, { start: 24, removes: false }), ...rounds(1, { start: 24, removes: false })]
  assert.equal(progressOf(stalled).progress, false)
  assert.ok(itemsOf(list(dates(2))).get('el:button:more_vert') === 2)
})

// ---- the judge's probabilities → what is done (lib/browserQueue.js) ----
const W = { title: 'NotebookLM 슬라이드·오디오 오버뷰 생성', waiting: true, question: '기존 노트북 중 어느 것에 만들까요? 목록에 없으면 소스를 알려 주세요.', options: ['AX 컨설팅 해설 1', 'AX 컨설팅 해설 2'] }

test('BQ-J-01 기다리는 질문의 답: 보기를 고른 답은 그 보기로, 자기 말의 답(「새로 만들어」)은 그 말 그대로 — 둘을 합쳐 0.7', () => {
  assert.deepEqual(waitPick({ o0: 0.05, o1: 0.82, answer: 0.05, steer: 0.03, replace: 0.02, other: 0.03 }, W).option, 1)
  const own = waitPick({ o0: 0.02, o1: 0.03, answer: 0.86, steer: 0.04, replace: 0.02, other: 0.03 }, W)
  assert.equal(own.pick, 'answer')
  assert.equal(own.option, null)
  // spread over the options and its own words: still the answer
  assert.equal(waitPick({ o0: 0.3, o1: 0.25, answer: 0.2, other: 0.25 }, W).pick, 'answer')
  assert.equal(waitPick({ o0: 0.3, answer: 0.3, other: 0.4 }, W).pick, 'other', `${ANSWER_BAR} 아래는 전하지 않는다`)
})

test('BQ-J-02 진행 중인 작업에게 어떻게 하라는 말(steer)은 0.7 에서 그 작업으로, 바꾸라는 말 · 그 밖의 말은 평소 길', () => {
  assert.equal(waitPick({ steer: 0.84, replace: 0.06, other: 0.1 }, { ...W, waiting: false, options: [] }).pick, 'steer')
  assert.equal(waitPick({ steer: 0.5, replace: 0.4, other: 0.1 }, { ...W, waiting: false, options: [] }).pick, 'other')
  assert.equal(waitPick({ replace: 0.9, other: 0.1 }, W).pick, 'other', '바꾸라는 말은 저절로 앞 작업을 멈추지 않는다(카드의 「앞 작업 멈추고 이것부터」가 첫 단추)')
})

test('BQ-J-03 카드의 첫 단추는 판정이 가장 높게 본 것: 답 · 지시 → 「답으로」, 바꾸기 → 「이것부터」, 그 밖 → 「뒤에 줄 서기」', () => {
  assert.equal(queueDefault({ answer: 0.6, steer: 0, replace: 0.1, other: 0.3 }), 'answer')
  assert.equal(queueDefault({ answer: 0.2, steer: 0.3, replace: 0.1, other: 0.4 }), 'answer', '답과 지시는 함께 센다')
  assert.equal(queueDefault({ answer: 0.1, replace: 0.6, other: 0.3 }), 'first')
  assert.equal(queueDefault({ answer: 0.1, replace: 0.1, other: 0.8 }), 'after')
  assert.equal(queueDefault(null), 'after', '판정이 없으면 뒤에 줄 서기')
})

test('BQ-J-04 로그인 · 카드 · 일회용 코드를 묻는 카드는 입력창의 말로 답하지 않는다(보기에 답이 없다), 파일을 붙인 말도', () => {
  assert.deepEqual(waitOptions({ ...W, vault: true }).map((o) => o.key), ['steer', 'replace', 'other'])
  assert.deepEqual(waitOptions(W, { files: 1 }).map((o) => o.key), ['steer', 'replace', 'other'])
  assert.deepEqual(waitOptions(W).map((o) => o.key), ['o0', 'o1', 'answer', 'steer', 'replace', 'other'])
  assert.deepEqual(waitOptions({ ...W, waiting: false }).map((o) => o.key), ['steer', 'replace', 'other'], '기다리지 않는 작업에는 답이 없다')
})

test('BQ-J-05 멈춘 작업: 먼저 마저(then) · 그것만 이어서(only) · 이렇게 이어서(more) — 끝난 작업에는 more 만', () => {
  const list = [{ id: 'a', title: "NotebookLM '제목없음' 노트북 모두 삭제", done: false, last: [] }, { id: 'b', title: 'Medium 글로 노트북', done: true, last: [] }]
  assert.deepEqual(resumeOptions(list).map((o) => o.key), ['then0', 'only0', 'more0', 'more1', 'none'])
  assert.equal(resumePick({ then0: 0.88, none: 0.12 }, list).pick, 'then')
  assert.equal(resumePick({ only0: 0.75, none: 0.25 }, list).task.id, 'a')
  assert.equal(resumePick({ more1: 0.9, none: 0.1 }, list).task.id, 'b')
  assert.equal(resumePick({ then0: 0.6, none: 0.4 }, list).pick, null, '0.7 아래')
  assert.equal(resumePick({ only1: 0.95 }, list).pick, null, '끝난 작업은 다시 하지 않는다')
})
