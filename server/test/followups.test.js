// 후행 습관의 규칙(lib/followups.js): 언제 묻는지, 언제 그만 묻는지, 어떤 결과물인지 — DB·모델 없이. spec pgpt-pro_followup-habits
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { asksNow, afterDecline, afterAccept, classOf, classesOf, pickClass, maybeRule, sameWords, askText, sameOptions, HABIT } from '../lib/followups.js'
import { withLang } from '../lib/lang.js'

const CASES = JSON.parse(fs.readFileSync(new URL('./followups-cases.json', import.meta.url)))
const RUN = {
  asks: (c) => asksNow(c.habit, 2),
  decline: (c) => afterDecline(c.habit, 3),
  accept: (c) => afterAccept(c.habit),
  class: (c) => classOf(c.name_),
  pick: (c) => pickClass(c.classes, c.text),
  rule_words: (c) => maybeRule(c.text),
  same_words: (c) => sameWords(c.a, c.b),
}
for (const c of CASES) test(c.name, () => assert.deepEqual(RUN[c.kind](c), c.expect))

test('기본값: 두 번 보면 묻고, 연달아 세 번 거절하면 그만 묻는다', () => {
  assert.equal(HABIT.minSeen, 2)
  assert.equal(HABIT.muteAfter, 3)
})
test('한 턴의 결과물 종류: 겹치지 않고, 스크립트는 빠진다', () => {
  assert.deepEqual(classesOf([{ name: 'a.pptx' }, { name: 'b.pptx' }, { name: 'c.mp3' }, { name: 'd.py' }]), ['slides', 'audio'])
  assert.deepEqual(classesOf([]), [])
  assert.deepEqual(classesOf(null), [])
})
test('묻는 말: 지켜본 습관은 「지난번처럼」, 직접 말한 습관은 「말씀하신 대로」', () => {
  assert.equal(askText({ origin: 'observed', ask: '로고를 바꿔드릴까요?', action: 'x' }), '지난번처럼 로고를 바꿔드릴까요?')
  assert.equal(askText({ origin: 'told', ask: '로고를 바꿔드릴까요?', action: 'x' }), '말씀하신 대로 로고를 바꿔드릴까요?')
  assert.match(askText({ origin: 'observed', ask: null, action: '로고 바꿔 줘' }), /^지난번처럼 「로고 바꿔 줘」도 해 드릴까요\?$/)
})
test('영어 모드의 묻는 말', () => withLang('en', () => {
  assert.match(askText({ origin: 'observed', ask: 'Shall I swap the logo?', action: 'x' }), /^Like last time: /)
  assert.match(askText({ origin: 'told', ask: null, action: 'swap the logo' }), /^As you asked: Shall I also do this/)
}))
test('같은 일을 고르는 보기: 습관마다 하나, 끝에 없음', () => {
  const o = sameOptions(['가', '나'])
  assert.deepEqual(o.map((x) => x.key), ['h0', 'h1', 'none'])
})
