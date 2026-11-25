// Which conversation each main-chat message belongs to, and the 대화 list (src/convOf.js — spec openspec/specs/chat-thread-list
// 「예약 작업과 브리프는 자기 대화에」). 2026-11-25 production: the conversation 「글씨가 표의 윗부분에 붙어있다. 중앙정렬」 held a 모닝
// 브리프, a mail chip and two runs of a stock watcher — every message without a router call of its own was filed under whatever
// conversation was last active. Now what arrives without the person typing it is filed aside, in its own conversation, and never moves
// the person's. The ids are the server's (lib/ownConversations.js). No database, no model.
//   cd server && node --test test/convOf.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { convOf, convRows, scheduleConversationId, briefConversationId, asideOf } from '../../src/convOf.js'
import * as Own from '../lib/ownConversations.js'

const ME = '4f1c2d3e-0000-4000-8000-00000000abcd'
const SCHED = '9a8b7c6d-1111-4222-8333-444455556666'
const SC = `sched-${SCHED.replace(/-/g, '')}`
const BR = `brief-${ME.replace(/-/g, '')}`
let n = 0
const at = () => new Date(Date.parse('2026-11-25T08:00:00+09:00') + (n++) * 60_000).toISOString()
const user = (id, text, extra = {}) => ({ id, role: 'user', kind: 'text', content: { text, ...extra }, created_at: at() })
const agent = (id, text, context, kind = 'text', extra = {}) => ({ id, role: 'agent', kind, content: { text, ...(context ? { context } : {}), ...extra }, created_at: at() })
const routed = (conv, title, action = 'new') => ({ conversationId: conv, title, action, strategy: 'judge', confidence: 0.9 })
const aside = (conv, kind, title) => ({ conversationId: conv, action: 'aside', kind, ...(title ? { title } : {}) })
const divider = (id, text, extra = {}) => ({ id, role: 'system', kind: 'divider', content: { text, ...extra }, created_at: at() })

test('CV-U-01 서버와 같은 id: 예약 작업 하나에 대화 하나, 사람마다 브리프 하나', () => {
  assert.equal(scheduleConversationId(SCHED), SC)
  assert.equal(Own.scheduleConversationId(SCHED), SC)
  assert.equal(briefConversationId(ME), BR)
  assert.equal(Own.briefConversationId(ME), BR)
  assert.deepEqual(Own.scheduleConversation({ id: SCHED, name: '주식 5일 누적 5% 급등락 감시' }), { conversationId: SC, title: '주식 5일 누적 5% 급등락 감시', kind: 'schedule' })
  assert.equal(Own.briefConversation(ME).kind, 'brief')
  // what a message filed aside carries: the one that names it has the title (a divider); the others none — no 「↳ …」 label over each
  assert.deepEqual(Own.aside(Own.briefConversation(ME)), { context: { conversationId: BR, action: 'aside', kind: 'brief' } })
  assert.deepEqual(Own.aside(Own.briefConversation(ME), { named: true }).context.title, '브리프')
  assert.deepEqual(Own.aside(null), {})
  assert.equal(asideOf({ content: { context: aside(SC, 'schedule') } }), SC)
  assert.equal(asideOf({ content: { context: routed('a', 'A') } }), null)
})

test('CV-U-02 예약 실행 · 브리프 · 메일 줄은 자기 대화로, 사람의 대화는 그대로 — 그 뒤의 칩 · 카드도 사람의 대화', () => {
  const msgs = [
    user('u1', '보고서 표 머리글 굵게 해 줘'),
    agent('a1', '머리글을 굵게 했어요.', routed('conv-A', '보고서 표 정리')),
    agent('f1', '', null, 'file', { name: '보고서.docx' }),
    // a scheduled run, filed aside (server lib/missions.js · delegate)
    divider('d1', '주식 5일 누적 5% 급등락 감시', { scheduleId: SCHED, context: aside(SC, 'schedule', '주식 5일 누적 5% 급등락 감시') }),
    agent('s1', 'KOSPI 5일 +1.2%, ASTS -6.1% · 출처: 네이버 증권', aside(SC, 'schedule')),
    agent('s1f', '', aside(SC, 'schedule'), 'file', { name: '급등락.xlsx' }),
    // the person's card after the background run: still the person's conversation
    agent('c1', '검수: 반영됨', null),
    // a brief and its mail chips, aside
    divider('d2', '모닝 브리프', { context: aside(BR, 'brief', '브리프') }),
    agent('b1', '박용주님이 uengine.org Tailscale 팀에 초대했어요.', aside(BR, 'brief'), 'text', { mails: [{ actionId: 'x', verb: 'Review', text: 'Tailscale 팀 가입 초대 확인' }] }),
    // the person's next message, sent after the brief, and its answer staying (router unsure)
    user('u2', '글씨가 표의 윗부분에 붙어있다. 중앙정렬'),
    agent('a2', '세로 가운데로 맞췄어요.', { title: '보고서 표 정리', action: 'stay' }),
    // a second run of the task: the same conversation
    divider('d3', '주식 5일 누적 5% 급등락 감시', { scheduleId: SCHED, context: aside(SC, 'schedule', '주식 5일 누적 5% 급등락 감시') }),
    agent('s2', '변동 있음: ASTS -7.0%', aside(SC, 'schedule')),
    // a mail follow-up started by a button: its request and its answer in their own conversation
    user('m1', '이 회사 알아보기 — uengine.org', { context: aside('mail-research-1', 'conversation', 'uengine.org 알아보기'), follow: { key: 'research' } }),
    agent('m2', 'uengine.org 은 …', aside('mail-research-1', 'conversation')),
    agent('c2', '', null, 'chip'),
  ]
  const of = convOf(msgs, { userId: ME })
  assert.deepEqual(Object.fromEntries(Object.entries(of)), {
    u1: 'conv-A', a1: 'conv-A', f1: 'conv-A', d1: SC, s1: SC, s1f: SC, c1: 'conv-A', d2: BR, b1: BR,
    u2: 'conv-A', a2: 'conv-A', d3: SC, s2: SC, m1: 'mail-research-1', m2: 'mail-research-1', c2: 'conv-A',
  })
  // conversation A holds none of them
  const inA = msgs.filter((m) => of[m.id] === 'conv-A').map((m) => m.id)
  assert.deepEqual(inA, ['u1', 'a1', 'f1', 'c1', 'u2', 'a2', 'c2'])
})

test('CV-U-03 사람의 메시지는 그 답의 대화로 — 사이에 끼어든 예약 실행 · 브리프가 데려가지 않는다', () => {
  const msgs = [
    user('u1', '부산 숙소 세 곳 비교해 줘'),
    agent('a1', '표로 비교했어요.', routed('trip', '부산 출장 숙소')),
    user('u2', '견적서 단가 봐 줘'),
    // arrives while u2 is being answered
    divider('d1', '감시', { scheduleId: SCHED, context: aside(SC, 'schedule', '감시') }),
    agent('s1', '변동 없음 아님', aside(SC, 'schedule')),
    agent('b1', '브리프', aside(BR, 'brief')),
    agent('a2', '단가 두 곳이 높아요.', routed('quote', '견적서 검토')),
  ]
  const of = convOf(msgs, { userId: ME })
  assert.equal(of.u2, 'quote')
  assert.equal(of.a2, 'quote')
  assert.equal(of.s1, SC)
  assert.equal(of.b1, BR)
  // a person's message whose answer has not come yet: the conversation the chat is in
  assert.equal(convOf([...msgs, user('u3', '하나 더')]).u3, 'quote')
})

test('CV-U-04 태그 이전에 저장된 메시지: 예약 실행의 구분선(scheduleId)과 바로 뒤 줄은 그 작업의 대화, 메일 칩을 단 브리프와 바로 앞 구분선은 브리프', () => {
  const msgs = [
    user('u1', '표 정리해 줘'),
    agent('a1', '정리했어요.', routed('conv-A', '표 정리')),
    divider('d1', '주식 감시', { scheduleId: SCHED }),
    agent('s1', 'KOSPI 5일 +1.2%', null, 'text', { conv: 'conv-A' }),
    agent('s1c', '텔레그램으로 보내지 못했어요', null, 'chip', { scheduleId: SCHED }),
    divider('d2', '모닝 브리프'),
    agent('b1', '오늘 메일 3통', null, 'text', { mails: [{ actionId: 'x' }] }),
    // an old brief without chips and other old lines: where the sweep put them (nothing structural tells them apart)
    agent('b2', '메일함을 살펴봤는데 지금 급한 건 없어요.', null),
    user('u2', '중앙정렬'),
    agent('a2', '맞췄어요.', routed('conv-A', '표 정리', 'continue')),
  ]
  const of = convOf(msgs, { userId: ME })
  assert.equal(of.d1, SC)
  assert.equal(of.s1, SC)
  assert.equal(of.s1c, SC)
  assert.equal(of.d2, BR)
  assert.equal(of.b1, BR)
  assert.equal(of.b2, 'conv-A')
  assert.equal(of.u2, 'conv-A')
  // without the person's id the old brief is not recognised (the store gives it once 'me' has loaded)
  assert.equal(convOf(msgs).b1, 'conv-A')
  // a router call right after an old run's divider ends that run's lines
  const cut = convOf([divider('d', 'x', { scheduleId: SCHED }), agent('r', '새 일', routed('conv-B', 'B'))])
  assert.equal(cut.r, 'conv-B')
})

test('CV-U-05 대화 목록: 서버 행(종류 포함) · 아직 서버에 없는 대화는 그 이름표 · 옛 예약 실행 · 브리프, 메시지 수, 최근 순', () => {
  const msgs = [
    user('u1', '표 정리해 줘'),
    agent('a1', '정리했어요.', routed('conv-A', '표 정리')),
    divider('d1', '주식 감시', { scheduleId: SCHED }),
    agent('s1', 'KOSPI', null),
    agent('o1', '타이머 카드', aside('sched-other', 'schedule')),
    divider('d2', '이브닝 브리프', { context: aside(BR, 'brief', '브리프') }),
    agent('b1', '오늘 메일', aside(BR, 'brief')),
    agent('t1', '메일에서 찾은 정해진 때', aside(`brief-${'f'.repeat(32)}`, 'brief')),
  ]
  const of = convOf(msgs, { userId: ME })
  const rows = convRows([{ id: 'conv-A', title: '표 정리', summary: '', kind: 'conversation', updated_at: '2026-11-24T20:00:00Z' }, { id: 'gone', title: '메시지 없음', updated_at: '2026-11-25T01:00:00Z' }], msgs, of)
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(by.gone, undefined)
  assert.equal(by['conv-A'].count, 2)
  assert.deepEqual([by[SC].title, by[SC].kind, by[SC].count], ['주식 감시', 'schedule', 2])
  assert.deepEqual([by[BR].title, by[BR].kind, by[BR].count], ['브리프', 'brief', 2])
  assert.deepEqual([by['sched-other'].title, by['sched-other'].kind], ['', 'schedule'])
  // a brief conversation known only by an untitled line still reads as the briefs
  assert.equal(by[`brief-${'f'.repeat(32)}`].title, '브리프')
  // newest first (a conversation the server has not listed: its latest message's time)
  assert.deepEqual(rows.map((r) => r.id), [`brief-${'f'.repeat(32)}`, BR, 'sched-other', SC, 'conv-A'])
  // the server's row wins over the chat's own naming once it is there
  const listed = convRows([{ id: SC, title: '주식 5일 누적 5% 급등락 감시', kind: 'schedule', summary: '', updated_at: '2026-11-25T02:00:00Z' }], msgs, of)
  assert.equal(listed.find((r) => r.id === SC).title, '주식 5일 누적 5% 급등락 감시')
})

test('CV-U-06 메일 줄의 대화: 그 메일의 후속 작업 대화(가장 최근) → 초안 대화 → 브리프', () => {
  const card = { source: { follow: { runs: { research: { conv: 'mail-research-1', title: 'A 알아보기', at: '2026-11-25T01:00:00Z' }, meet: { conv: 'mail-meet-2', title: '회의 잡기', at: '2026-11-25T02:00:00Z' } } }, conv: { id: 'mail-abc', title: '메일 · 가온 견적 요청' } } }
  assert.equal(Own.mailConversation(card, ME).conversationId, 'mail-meet-2')
  assert.deepEqual(Own.mailConversation({ source: { conv: card.source.conv } }, ME), { conversationId: 'mail-abc', title: '메일 · 가온 견적 요청', kind: 'mail' })
  assert.equal(Own.mailConversation({ source: {} }, ME).conversationId, BR)
  assert.equal(Own.mailConversationId(ME, 'demo-1'), Own.mailConversationId(ME, 'demo-1'))
  assert.notEqual(Own.mailConversationId(ME, 'demo-1'), Own.mailConversationId(ME, 'demo-2'))
  assert.match(Own.mailConversationId(ME, 'demo-1'), /^mail-[0-9a-f]{24}$/)
})
