// 방 규칙의 판단(lib/roomRules.js)과 사이트 안내(lib/browserGuides.js): 무엇이 "올린 것"인지, 어떤 말을 모델에게 읽힐지 — DB·모델 없이. spec pgpt-pro_room-rules
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { LEFT_WORDS_MAX, maybeRoomRule, roomGoal, roomInput } from '../lib/roomRules.js'
import { NOTEBOOK_URL, guideFor, isNotebookJob } from '../lib/browserGuides.js'

const CASES = JSON.parse(fs.readFileSync(new URL('./room-rules-cases.json', import.meta.url)))
const shape = (r) => (r ? { urls: r.urls.length, files: r.files.length } : null)
const RUN = {
  input: (c) => shape(roomInput(c.text, Array.from({ length: c.files }, () => ({ name: 'a.pdf' })))),
  room_words: (c) => maybeRoomRule(c.text),
  notebook: (c) => isNotebookJob(c.text),
}
for (const c of CASES) test(c.name, () => assert.deepEqual(RUN[c.kind](c), c.expect))

test('경계값이 사례의 글자 수와 맞다', () => assert.equal(LEFT_WORDS_MAX, 30))
test('할 일에 링크와 파일을 붙인다', () => {
  const g = roomGoal('이 링크나 파일로 슬라이드를 만든다', { urls: ['https://a.example/x'], files: [{ name: '보고서.pdf' }], words: '급해요' })
  assert.match(g, /슬라이드를 만든다/)
  assert.match(g, /링크: https:\/\/a\.example\/x/)
  assert.match(g, /첨부 파일: 보고서\.pdf/)
  assert.match(g, /덧붙인 말: 급해요/)
})
test('NotebookLM 안내: 그 일에만 붙고, 비밀번호를 치지 말라고 하고, 오래 기다리라고 한다', () => {
  assert.equal(guideFor('상점 주문 내역 확인', 'https://shop.example'), '')
  const g = guideFor('노트북 lm으로 슬라이드', NOTEBOOK_URL)
  assert.match(g, /never type a Google password/)
  assert.match(g, /wait_for_page/)
  assert.match(g, /웹사이트/)
  assert.ok(guideFor('아무 일', 'https://notebook.google.com/notebook/x').length > 0)
})
