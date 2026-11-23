// 에이전트가 하지 못한 단계(run.js agentFailure · runmode.js stepState): 안내 문구를 단계 결과로 받지 않고, 건 화면에 실패로 보인다 — 데이터베이스 없이.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DOTENV_CONFIG_QUIET = 'true'
const { agentFailure } = await import('../lib/ontology/run.js')
const { stepState } = await import('../lib/ontology/runmode.js')

test('연결 실패 · 응답 없음 · 멈춤은 단계 실패로 읽는다', () => {
  assert.match(agentFailure({ content: { text: '에이전트에 연결하지 못했어요.', failed: 'unreachable', cause: 'deepagents 401' } }), /연결하지 못했어요 \(deepagents 401\)/)
  assert.match(agentFailure({ content: { text: '…', failed: 'idle' } }), /응답하지 않았어요/)
  assert.match(agentFailure({ content: { text: '하다 만 글', stopped: true } }), /멈췄어요/)
  assert.ok(agentFailure(null))
})

test('에이전트가 답한 단계는 그대로 둔다(글이 비어 있어도)', () => {
  assert.equal(agentFailure({ content: { text: '### 금액 확인 결과 …' } }), null)
  assert.equal(agentFailure({ content: { text: '' } }), null)
})

test('실패한 에이전트 단계는 「하지 못함」 — 하는 중도, 끝남도 아니다', () => {
  const t = { status: 'IN_PROGRESS', agent_orch: 'pgpt-pro-onto', agent_mode: 'COMPLETE' }
  assert.equal(stepState({ ...t, draft_status: 'FAILED' }), 'failed')
  assert.equal(stepState({ ...t, draft_status: 'STARTED' }), 'running')
  assert.equal(stepState({ ...t, status: 'DONE', draft_status: 'FAILED' }), 'done')
  assert.equal(stepState({ status: 'IN_PROGRESS', agent_mode: 'NONE', draft_status: 'FAILED' }), 'person') // 사람 단계는 상관없다
})
