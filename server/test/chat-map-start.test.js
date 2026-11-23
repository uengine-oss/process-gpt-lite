// 채팅의 프로세스 시작(agent.js processTurn → mapChatStart): 「지도에서 바로」 테넌트에서는 지도의 시작 카드(events.js onChat)를 띄우고,
// 지난 스냅샷 정의(onto_…)를 「프로세스 정의로」 시작하는 카드를 내지 않는다 — 데이터베이스 · 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DOTENV_CONFIG_QUIET = 'true'
const { mapChatStart, isMapSnapshot } = await import('../lib/agent.js')

const deps = (o = {}) => {
  const calls = []
  return { calls, d: { enabled: async () => o.enabled ?? true, engine: async () => o.engine ?? 'map', email: async () => 'me@x.dev',
    onChat: async (a) => { calls.push(a); return o.result === undefined ? { asked: true, started: [] } : o.result } } }
}

test('지도에서 바로: 사용자가 쓴 글 그대로 지도의 시작 카드를 묻는다(금액은 이 글에서 읽는다)', async () => {
  const { calls, d } = deps()
  const r = await mapChatStart({ userId: 'u1', threadId: 't1', said: '부산 출장비 정산, 영수증 합계 150만원' }, d)
  assert.deepEqual(r, { map: true, offered: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].said, '부산 출장비 정산, 영수증 합계 150만원')
  assert.deepEqual(calls[0].user, { id: 'u1', email: 'me@x.dev' })
  assert.equal(calls[0].threadId, 't1')
})

test('지도에 맞는 프로세스가 없으면 카드를 띄우지 않았다고 알린다(저장된 정의에서 고르되 스냅샷은 뺀다)', async () => {
  for (const result of [null, { asked: false, started: [] }]) {
    const { d } = deps({ result })
    assert.deepEqual(await mapChatStart({ userId: 'u1', threadId: 't1', said: '휴가 신청해 줘요' }, d), { map: true, offered: false })
  }
})

test('프로세스 정의로(기존) 실행이거나 온톨로지가 없으면 지도를 묻지 않는다 — 예전처럼 저장된 정의에서 고른다', async () => {
  for (const o of [{ engine: 'bpm' }, { enabled: false }]) {
    const { calls, d } = deps(o)
    assert.deepEqual(await mapChatStart({ userId: 'u1', threadId: 't1', said: '출장비 정산해 줘요' }, d), { map: false, offered: false })
    assert.equal(calls.length, 0)
  }
})

test('지도 스냅샷 정의 id 만 걸러낸다', () => {
  assert.equal(isMapSnapshot('onto_ae91ad5f57a1'), true)
  for (const id of ['onto_ae91', 'onto_agent', 'purchase_request', 'my_onto_ae91ad5f57a1', '', null]) assert.equal(isMapSnapshot(id), false, String(id))
})
