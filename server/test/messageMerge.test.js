// 열린 대화의 메시지 합치기(src/messageMerge.js, 2026-11-24 「회의록이 … 나갔다 들어와야 업데이트됨」): 실시간으로 온 것과 다시
// 물어 받은 것을 메시지 id 하나에 하나로 — 새 사본이 그 자리를 바꾸고, 새 메시지는 시각 순서에, 두 번 들어가지 않는다. 화면 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { merged } from '../../src/messageMerge.js'

const msg = (id, at, extra = {}) => ({ id, at, kind: 'text', body: id, ...extra })

test('MM-U-01 같은 id 는 하나: 새 사본이 그 자리를 바꾼다(회의 카드가 「끝났어요」로)', () => {
  const list = [msg('a', '2026-11-24T12:10:00.000Z'), msg('card', '2026-11-24T12:10:05.000Z', { kind: 'meeting', meeting: { state: 'live' } })]
  const out = merged(list, [msg('card', '2026-11-24T12:10:05.000Z', { kind: 'meeting', meeting: { state: 'ended' } })])
  assert.deepEqual(out.map((m) => m.id), ['a', 'card'])
  assert.equal(out[1].meeting.state, 'ended')
  assert.equal(list[1].meeting.state, 'live', 'the list given is not changed')
})

test('MM-U-02 새 메시지는 시각 순서에, 시각이 없거나 가장 늦으면 끝에', () => {
  const list = [msg('a', '2026-11-24T12:10:00.000Z'), msg('c', '2026-11-24T12:12:00.000Z')]
  assert.deepEqual(merged(list, [msg('b', '2026-11-24T12:11:00.000Z')]).map((m) => m.id), ['a', 'b', 'c'])
  assert.deepEqual(merged(list, [msg('minutes', '2026-11-24T12:13:00.000Z', { kind: 'meeting-minutes' })]).map((m) => m.id), ['a', 'c', 'minutes'])
  assert.deepEqual(merged(list, [msg('x', null)]).map((m) => m.id), ['a', 'c', 'x'])
})

test('MM-U-03 다시 물어 받은 쪽 전체를 합쳐도 두 번 들어가는 것이 없다', () => {
  const live = [msg('a', '2026-11-24T12:10:00.000Z'), msg('card', '2026-11-24T12:10:05.000Z'), msg('minutes', '2026-11-24T12:11:00.000Z')]
  const page = [msg('a', '2026-11-24T12:10:00.000Z'), msg('card', '2026-11-24T12:10:05.000Z'), msg('material', '2026-11-24T12:10:30.000Z'), msg('minutes', '2026-11-24T12:11:00.000Z')]
  const out = merged(merged(live, page), page)
  assert.deepEqual(out.map((m) => m.id), ['a', 'card', 'material', 'minutes'])
  assert.deepEqual(merged(null, null), [])
  assert.deepEqual(merged([msg('a', null)], [null, {}]).map((m) => m.id), ['a'])
})
