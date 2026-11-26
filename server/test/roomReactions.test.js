// 대화방 이름 · 말풍선 반응의 규칙(2026-11-26 사용자 「대화방 설정으로 대화방 명칭 바꿀 수 있게하고 다른 사람 말풍선에 좋아요 확인했음 사랑해
// 웃음 등을 붙힐 수 있게」, 스펙 messenger-dock 「단체방의 이름을 바꾼다」 · room-reactions). 데이터베이스 없이:
//   RX-U-01 반응 모으기: 종류마다 칩 하나 · 정해 둔 순서 · 사람은 누른 순서 · 같은 사람 두 번은 한 번 · 모르는 종류는 버림 · 보는 사람마다 「내 것」
//   RX-U-02 누가 붙일 수 있나: 남의 메시지 · 에이전트의 메시지는 되고, 내 메시지 · 시스템 줄(초대 · 이름) · 회의 카드 · 숨긴 행은 안 됨
//   RX-U-03 화면의 즉시 반영(src/roomReactions.js toggled): 켜고 끄기 · 마지막 사람이 빠지면 칩이 없어짐 · 서버와 같은 순서 · 다른 칩은 그대로
//   RX-U-04 화면과 서버가 같은 여섯 가지(열쇠 · 순서), 화면이 반응을 여는 말풍선(canReact)도 서버의 규칙과 같다
//   RX-U-05 이름 다듬기(lib/team/messenger.js cleanName): 앞뒤 공백 · 줄바꿈 · 제어 문자 → 한 칸, 빈 이름은 null(사람들 이름으로), 50자까지(이모지는 한 글자)
//   RX-U-06 메시지 합치기: 실시간으로 온 사본(반응 없음)이 있던 반응을 지우지 않고, 다시 받은 사본(반응 있음 · [])은 그대로 들어간다
// Run: node --test test/roomReactions.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { summarize, refusal, KEYS, isKey } from '../lib/team/reactions.js'
import { cleanName, NAME_MAX } from '../lib/team/messenger.js'
import { REACTIONS, toggled, canReact, whoLine, reactionOf } from '../../src/roomReactions.js'
import { merged } from '../../src/messageMerge.js'

const NAMES = { a: '정하윤', b: '김서연', c: '박도윤' }
const nameOf = (id) => NAMES[id] || ''
const at = (s) => `2026-11-26T09:00:${String(s).padStart(2, '0')}.000Z`

test('RX-U-01 반응 모으기 — 종류마다 칩 하나, 정해 둔 순서, 누른 순서, 보는 사람마다 내 것', () => {
  const rows = [
    { user_id: 'c', reaction: 'love', created_at: at(5) },
    { user_id: 'b', reaction: 'like', created_at: at(3) },
    { user_id: 'a', reaction: 'like', created_at: at(1) },
    { user_id: 'a', reaction: 'like', created_at: at(9) },      // the same person twice: once
    { user_id: 'b', reaction: 'angry', created_at: at(2) },     // not one of the set: dropped
    { user_id: 'a', reaction: 'thanks', created_at: at(4) },
  ]
  const forA = summarize(rows, 'a', nameOf)
  assert.deepEqual(forA.map((c) => c.key), ['like', 'love', 'thanks'])
  assert.deepEqual(forA[0], { key: 'like', count: 2, mine: true, people: [{ id: 'a', name: '정하윤' }, { id: 'b', name: '김서연' }] })
  assert.equal(forA[1].mine, false)
  const forC = summarize(rows, 'c', nameOf)
  assert.deepEqual(forC.map((c) => [c.key, c.mine]), [['like', false], ['love', true], ['thanks', false]])
  assert.deepEqual(summarize([], 'a', nameOf), [])
  assert.deepEqual(summarize(null, 'a'), [])
  assert.equal(whoLine(forA[0]), '정하윤, 김서연')
})

test('RX-U-02 남의 말풍선에만 — 내 메시지 · 시스템 줄 · 회의 카드 · 숨긴 행은 안 된다', () => {
  const me = { id: 'u-a', email: 'Hayoon@People.test' }
  const row = (messages) => ({ uuid: 'x', id: 'room', messages })
  assert.equal(refusal(row({ role: 'user', userId: 'u-b', email: 'b@people.test', content: '견적 보내 주세요' }), me), null)
  // an agent's bubble — even my own agent's — is someone else's bubble
  assert.equal(refusal(row({ role: 'assistant', email: 'agent:process-gpt-agent', pgpt: { kind: 'agent', by: 'u-a' } }), me), null)
  assert.equal(refusal(row({ role: 'user', userId: 'u-a', email: 'hayoon@people.test' }), me), 'own')
  assert.equal(refusal(row({ role: 'user', email: 'hayoon@people.test' }), me), 'own')   // (an older row names its writer by address only)
  assert.equal(refusal(row({ role: 'system', userId: 'u-b', pgpt: { kind: 'invite' } }), me), 'system')
  assert.equal(refusal(row({ role: 'system', userId: 'u-b', pgpt: { kind: 'rename', name: '견적 회의' } }), me), 'system')
  assert.equal(refusal(row({ role: 'assistant', email: 'agent:meeting', pgpt: { kind: 'meeting-minutes' } }), me), 'meeting')
  assert.equal(refusal(row({ role: 'user', userId: 'u-b', __hidden: 'true' }), me), 'hidden')
})

test('RX-U-03 누르면 바로 바뀐다 — 켜고 끄기, 마지막 사람이 빠지면 칩이 없어진다', () => {
  const me = { id: 'a', name: '정하윤' }
  const chips = [{ key: 'love', count: 1, mine: false, people: [{ id: 'c', name: '박도윤' }] }]
  const on = toggled(chips, 'like', me, true)
  assert.deepEqual(on.map((c) => [c.key, c.count, c.mine]), [['like', 1, true], ['love', 1, false]])   // the set's order: like before love
  assert.deepEqual(on[0].people, [{ id: 'a', name: '정하윤' }])
  assert.deepEqual(toggled(on, 'like', me, true), on)                                             // on twice: still once
  const love = toggled(on, 'love', me, true)
  assert.deepEqual(love[1], { key: 'love', count: 2, mine: true, people: [{ id: 'c', name: '박도윤' }, { id: 'a', name: '정하윤' }] })
  const off = toggled(love, 'like', me, false)
  assert.deepEqual(off.map((c) => c.key), ['love'])                                               // nobody left on 👍: no chip
  assert.equal(chips[0].count, 1, 'the chips given are not changed')
  assert.deepEqual(toggled([], 'check', me, false), [])
})

test('RX-U-04 화면과 서버가 같은 여섯 가지, 같은 말풍선 규칙', () => {
  assert.deepEqual(REACTIONS.map((r) => r.key), KEYS)
  assert.deepEqual(REACTIONS.map((r) => r.label), ['좋아요', '확인했음', '사랑해', '웃음', '놀람', '감사'])
  assert.deepEqual(REACTIONS.map((r) => r.emoji), ['👍', '✅', '❤️', '😂', '😮', '🙏'])
  assert.equal(reactionOf('check').emoji, '✅')
  assert.ok(isKey('like') && !isKey('angry') && !isKey(''))
  assert.equal(canReact({ id: '1', kind: 'text', mine: false }), true)
  assert.equal(canReact({ id: '1', kind: 'agent', mine: false, byMe: true }), true)
  assert.equal(canReact({ id: '1', kind: 'share', mine: false }), true)
  assert.equal(canReact({ id: '1', kind: 'text', mine: true }), false)
  for (const kind of ['invite', 'rename', 'meeting', 'meeting-minutes', 'meeting-transcript']) assert.equal(canReact({ id: '1', kind, mine: false }), false, kind)
})

test('RX-U-05 대화방 이름 다듬기 — 공백 · 줄바꿈 · 빈 이름 · 50자', () => {
  assert.equal(cleanName('  3분기   영업 회의 '), '3분기 영업 회의')
  assert.equal(cleanName('견적\n회의\t\u0007방'), '견적 회의 방')
  assert.equal(cleanName(''), null)
  assert.equal(cleanName('   \n '), null)
  assert.equal(cleanName(null), null)
  assert.equal(cleanName(undefined), null)
  assert.equal(NAME_MAX, 50)
  assert.equal(cleanName('가'.repeat(50)), '가'.repeat(50))
  assert.throws(() => cleanName('가'.repeat(51)), (e) => e.status === 400)
  // an emoji is one character, as a person counts it
  assert.equal(cleanName('🙂'.repeat(50)), '🙂'.repeat(50))
})

test('RX-U-06 메시지 합치기 — 실시간 사본은 반응을 지우지 않는다', () => {
  const chips = [{ key: 'like', count: 1, mine: false, people: [{ id: 'b', name: '김서연' }] }]
  const list = [{ id: 'm1', at: at(1), body: '원래', reactions: chips }]
  // the agent's reply updated with its files comes again — without reactions
  const live = merged(list, [{ id: 'm1', at: at(1), body: '파일 붙음' }])
  assert.equal(live[0].body, '파일 붙음')
  assert.deepEqual(live[0].reactions, chips)
  // the conversation asked for again: what the reactions are now (none left: [])
  const fresh = merged(live, [{ id: 'm1', at: at(1), body: '파일 붙음', reactions: [] }])
  assert.deepEqual(fresh[0].reactions, [])
})
