// A project's sub-topics (spec openspec/specs/project-room 「프로젝트 안의 주제」): what Lite offers the context router for a project's
// message (only this project's sub-topics, under the project's own key), which of its answers it takes, the summary kept for a sub-topic,
// a project's turns one at a time (lib/turns.js serial), and the page's pieces with no screen in them (src/projectTopics.js — which
// sub-topic each message belongs to, the list, the address; src/artifactScope.js — one sub-topic's files). No database, no model.
//   cd server && PRO_CONTEXT_ROUTER_URL= node --test test/projectTopics.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import * as PT from '../lib/projectTopics.js'
import * as T from '../lib/turns.js'
import { topicOf, topicList, topicPath, topicsShown } from '../../src/projectTopics.js'
import { artifactScope, artifactItems, CAPTION } from '../../src/artifactScope.js'

const U = '7d3f0c1e-1111-4222-8333-944455556666'
const P1 = 'a1a1a1a1-0000-4000-8000-000000000001'
const P2 = 'b2b2b2b2-0000-4000-8000-000000000002'

test('PT-U-01 프로젝트마다 열쇠가 따로 — 사람의 열쇠(메인 채팅)와도, 다른 프로젝트와도 다르다', () => {
  assert.equal(PT.scopeKey(U, P1), `${U}/project/${P1}`)
  assert.notEqual(PT.scopeKey(U, P1), PT.scopeKey(U, P2))
  assert.notEqual(PT.scopeKey(U, P1), U)
  // the workroom's check: every project of this person, nobody else's
  assert.equal(PT.scopePattern(U), `${U}/project/%`)
  assert.ok(PT.scopeKey(U, P2).startsWith(PT.scopePattern(U).slice(0, -1)))
})

test('PT-U-02 나누는 턴: 사람이 프로젝트에 보낸 메시지만 — 라우터가 없거나, 고른 주제 안이거나, 예약·배경·스킬·프로세스 설계는 그대로', () => {
  const base = { kind: 'project', routerOn: true }
  assert.equal(PT.routesProject(base), true)
  assert.equal(PT.routesProject({ ...base, kind: 'chat' }), false)
  assert.equal(PT.routesProject({ ...base, kind: 'process' }), false)
  assert.equal(PT.routesProject({ ...base, routerOn: false }), false)
  assert.equal(PT.routesProject({ ...base, pinned: true }), false)
  for (const k of ['silent', 'background', 'divider', 'generating']) assert.equal(PT.routesProject({ ...base, [k]: true }), false, k)
  assert.equal(PT.routesProject({ ...base, mode: 'skill' }), false)
})

test('PT-U-03 라우터에 주는 후보: 이 프로젝트의 주제(최근 순)와 진행 중인 요청 — 대화마다 하나, 제목은 늘 있음', () => {
  const topics = [
    { id: 'c-lecture', title: '클라우다이크 강의 준비', summary: '최근 요청: 강의안 정리해 줘', gist: '목차', updated_at: '2026-11-25T01:00:00Z' },
    { id: 'c-docs', title: '', summary: '', gist: '', updated_at: null },
    { id: 'c-old', title: '오래된 주제', summary: '', gist: '', updated_at: '2026-10-01T00:00:00Z' },
  ]
  const ahead = [{ conv: 'c-lecture', title: '강의 자료 표지 만들어 줘' }, { conv: 'c-run', title: '강의 준비 프로세스 실행해 줘' }, { conv: 'none:x', title: '브라우저' }]
  const got = PT.routeContexts({ topics, ahead, limit: 2 })
  assert.deepEqual(got.map((c) => c.conversation_id), ['c-lecture', 'c-run', 'c-docs'])
  // a request still being answered in a stored sub-topic: in progress, under the sub-topic's own title
  assert.equal(got[0].active, true)
  assert.equal(got[0].title, '클라우다이크 강의 준비')
  assert.equal(got[1].active, true)
  assert.match(got[1].summary, /진행 중인 요청: 강의 준비 프로세스/)
  // a sub-topic with no title yet is still offered (the router needs one)
  assert.equal(got[2].title, '프로젝트 대화')
  assert.ok(got.every((c) => c.title && c.kind === 'conversation'))
  // the limit keeps the newest; nothing else is offered
  assert.ok(!got.some((c) => c.conversation_id === 'c-old'))
  assert.deepEqual(PT.routeContexts({}), [])
})

test('PT-U-04 /route 본문: 사람의 말, 프로젝트의 열쇠, 지금 서 있는 주제, 후보', () => {
  const contexts = [{ conversation_id: 'c-lecture', title: '강의 준비' }]
  const b = PT.routeBody({ text: '목차를 두 장으로 줄여 줘', tenantId: 'acme', userId: U, threadId: P1, current: 'c-lecture', contexts })
  assert.deepEqual(b, { message: '목차를 두 장으로 줄여 줘', tenant_id: 'acme', user_uid: `${U}/project/${P1}`, conversation_id: 'c-lecture', metadata: { contexts } })
  assert.equal(PT.routeBody({ text: 'x'.repeat(5000), tenantId: 't', userId: U, threadId: P1 }).message.length, 2000)
  assert.equal(PT.routeBody({ text: 'a', tenantId: 't', userId: U, threadId: P1 }).conversation_id, null)
})

test('PT-U-05 라우터의 답은 이 프로젝트의 대화일 때만 받는다', () => {
  const contexts = [{ conversation_id: 'c-lecture' }, { conversation_id: 'c-docs' }]
  const take = (j, current = 'c-docs') => PT.acceptRoute(j, { contexts, current })
  assert.equal(take({ conversation_id: 'n1', action: 'new' })?.conversation_id, 'n1')
  assert.equal(take({ conversation_id: 'c-lecture', action: 'continue' })?.conversation_id, 'c-lecture')
  assert.equal(take({ conversation_id: 'c-docs', action: 'stay' })?.action, 'stay')
  // a conversation that is none of these (the main chat's, another project's) is not taken
  assert.equal(take({ conversation_id: 'home-conv', action: 'continue' }), null)
  assert.equal(take({ conversation_id: 'home-conv', action: 'stay' }), null)
  // an unsure call with nowhere to stay: the new conversation the router made up
  assert.equal(PT.acceptRoute({ conversation_id: 'n2', action: 'stay' }, { contexts, current: null })?.conversation_id, 'n2')
  assert.equal(take({ conversation_id: 'x', action: 'jump' }), null)
  assert.equal(take(null), null)
  assert.equal(take({ action: 'new' }), null)
})

test('PT-U-06 주제의 요약: 최근 요청과 답, 앞의 요청은 요지로 접힘(새것이 남음)', () => {
  assert.equal(PT.summaryOf('강의안 정리해 줘', '정리했어요.'), '최근 요청: 강의안 정리해 줘\n최근 답: 정리했어요.')
  assert.equal(PT.foldGist('', '최근 요청: 강의안 정리해 줘\n최근 답: 정리했어요.'), '강의안 정리해 줘')
  assert.equal(PT.foldGist('강의안 정리해 줘', '최근 요청: 표지 만들어 줘\n최근 답: …'), '강의안 정리해 줘 · 표지 만들어 줘')
  // the same request twice is kept once; an English summary folds the same way
  assert.equal(PT.foldGist('표지 만들어 줘', '최근 요청: 표지 만들어 줘'), '표지 만들어 줘')
  assert.equal(PT.foldGist('', 'Latest request: make a cover\nLatest answer: done'), 'make a cover')
  const long = PT.foldGist(Array.from({ length: 12 }, (_, i) => `요청 ${i} 이것저것 해 줘`).join(' · '), '최근 요청: 마지막 요청', 80)
  assert.ok(long.length <= 80)
  assert.ok(long.endsWith('마지막 요청'))
  assert.ok(!long.includes('요청 0 '))
  assert.equal(PT.foldGist('그대로', ''), '그대로')
})

test('PT-U-07 프로젝트의 턴은 하나씩 — 다른 주제라도 앞의 에이전트 턴이 끝날 때까지 기다림, 에이전트 없는 턴은 기다리지 않음', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5))
  const a = T.enqueue({ userId: 'u', threadId: 'proj', conv: 'topic-a' })
  a.serial = true
  assert.equal(await T.waitTurn(a), false)
  const b = T.enqueue({ userId: 'u', threadId: 'proj', conv: 'topic-b' })
  b.serial = true
  let started = false
  const w = T.waitTurn(b).then((x) => { started = true; return x })
  await tick()
  assert.equal(started, false, 'a project turn in another sub-topic waits')
  a.finish()
  assert.equal(await w, true)
  // the main chat (not serial): another conversation goes side by side, as before
  const c = T.enqueue({ userId: 'u', threadId: 'main', conv: 'c1' })
  await T.waitTurn(c)
  const d = T.enqueue({ userId: 'u', threadId: 'main', conv: 'c2' })
  assert.equal(await T.waitTurn(d), false)
  // a message answered without an agent turn (none:) holds nobody up
  const e = T.enqueue({ userId: 'u', threadId: 'proj2' })
  e.setConv(`none:${e.id}`)
  const f = T.enqueue({ userId: 'u', threadId: 'proj2', conv: 'topic-x' })
  f.serial = true
  assert.equal(await T.waitTurn(f), false)
  for (const x of [b, c, d, e, f]) x.finish()
  assert.equal(T._live.size, 0)
})

// ---- the page (src/projectTopics.js) ----
const at = (iso) => ({ created_at: iso })
const MSGS = [
  { id: 'old-u', role: 'user', kind: 'text', content: { text: '구글 문서 읽어 줘' }, ...at('2026-11-24T00:00:00Z') },
  { id: 'old-a', role: 'agent', kind: 'text', content: { text: '읽었어요' }, ...at('2026-11-24T00:01:00Z') },
  { id: 'u1', role: 'user', kind: 'text', content: { text: '강의안 정리해 줘', conv: 'lec' }, ...at('2026-11-25T01:00:00Z') },
  { id: 'a1', role: 'agent', kind: 'text', content: { text: '정리했어요', conv: 'lec', context: { title: '강의 준비', action: 'new', conversationId: 'lec' } }, ...at('2026-11-25T01:01:00Z') },
  { id: 'f1', role: 'agent', kind: 'file', content: { name: '강의준비안.md', conv: 'lec' }, ...at('2026-11-25T01:01:05Z') },
  { id: 'u2', role: 'user', kind: 'text', content: { text: '견적서 검토해 줘' }, ...at('2026-11-25T02:00:00Z') },
  { id: 'a2', role: 'agent', kind: 'text', content: { text: '검토했어요', conv: 'quote', context: { title: '견적서 검토', action: 'new', conversationId: 'quote' } }, ...at('2026-11-25T02:01:00Z') },
  { id: 'chip', role: 'agent', kind: 'chip', content: { text: '폴더에 담았어요' }, ...at('2026-11-25T02:01:10Z') },
  { id: 'u3', role: 'user', kind: 'text', content: { text: '강의 표지도', conv: 'lec' }, ...at('2026-11-25T03:00:00Z') },
  // the previous turn's card, written after the person's next message (another sub-topic's)
  { id: 'late', role: 'agent', kind: 'followup', content: { text: '다음에 견적 비교표도 만들까요?' }, ...at('2026-11-25T03:00:01Z') },
  { id: 'stop', role: 'agent', kind: 'text', content: { text: '(답을 멈췄어요)', stopped: true, conv: 'lec' }, ...at('2026-11-25T03:00:05Z') },
  { id: 'u4', role: 'user', kind: 'text', content: { text: '아직 답을 기다리는 말' }, ...at('2026-11-25T04:00:00Z') },
  { id: 'n', role: 'agent', kind: 'text', content: { text: '알겠어요', conv: 'none:abc' }, ...at('2026-11-25T04:00:01Z') },
  { id: 'r', role: 'agent', kind: 'followup', content: { text: '루틴', conv: { id: 'quote', title: '견적서 검토' } }, ...at('2026-11-25T04:00:02Z') },
]

test('PT-U-08 메시지마다 주제: 답과 그 턴의 카드는 그 대화, 사람의 메시지는 그 답과, 늦게 온 카드는 앞 답과, 주제 전의 메시지는 없음', () => {
  const of = topicOf(MSGS)
  assert.equal(of['old-u'], null)
  assert.equal(of['old-a'], null)
  assert.equal(of.u1, 'lec')
  assert.equal(of.a1, 'lec')
  assert.equal(of.f1, 'lec')
  // the person's message waiting for its sub-topic goes with the answer that follows it; a chip with the answer before it
  assert.equal(of.u2, 'quote')
  assert.equal(of.chip, 'quote')
  // a message tagged when sent inside a sub-topic is that sub-topic's at once — and does not take the previous turn's late card
  assert.equal(of.u3, 'lec')
  assert.equal(of.late, 'quote')
  assert.equal(of.stop, 'lec')
  // none: (answered without an agent) is no sub-topic: it and the message before it go with the conversation around them
  assert.equal(of.u4, 'lec')
  assert.equal(of.n, 'lec')
  // a card about a conversation names it as {id, title}
  assert.equal(of.r, 'quote')
  assert.deepEqual(topicOf([]), {})
})

test('PT-U-09 주제 목록: 서버의 행 + 이 프로젝트의 메시지 수, 최근 순, 아직 기록 전인 주제는 답의 제목으로', () => {
  const rows = [
    { id: 'lec', title: '클라우다이크 강의 준비', summary: '최근 요청: 강의 표지도', gist: '강의안 정리해 줘', updated_at: '2026-11-25T01:01:00Z' },
    { id: 'gone', title: '메시지가 없는 주제', updated_at: '2026-11-25T05:00:00Z' },
  ]
  const list = topicList(rows, MSGS)
  assert.deepEqual(list.map((c) => [c.id, c.title, c.count]), [['quote', '견적서 검토', 5], ['lec', '클라우다이크 강의 준비', 7]])
  // the latest moment is the newest message's when the row is older
  assert.equal(list[0].updated_at, '2026-11-25T04:00:02Z')
  assert.equal(list[1].updated_at, '2026-11-25T04:00:01Z')
  assert.deepEqual(topicList([], []), [])
})

test('PT-U-10 주소와 막대: /projects/:id/t/:주제, 두 개 이상이거나 하나를 열었을 때만', () => {
  assert.equal(topicPath('p1', 'c 1/2'), '/projects/p1/t/c%201%2F2')
  assert.equal(topicPath('p1', null), '/projects/p1')
  assert.equal(topicsShown([{ id: 'a' }], null), false)
  assert.equal(topicsShown([{ id: 'a' }, { id: 'b' }], null), true)
  assert.equal(topicsShown([], 'a'), true)
  assert.equal(topicsShown(undefined, null), false)
})

test('PT-U-11 한 주제의 산출물: 그 주제의 파일만, 캡션 「이 주제의 산출물」', () => {
  assert.equal(artifactScope({ mode: 'project', activeId: 'p1', mainId: 'm', projectIds: ['p1'], topicFilter: 'lec' }), 'topic')
  assert.equal(artifactScope({ mode: 'project', activeId: 'p1', mainId: 'm', projectIds: ['p1'] }), 'project')
  // (the main chat's narrowing does not leak into a project)
  assert.equal(artifactScope({ mode: 'chat', activeId: 'm', mainId: 'm', topicFilter: 'lec' }), 'chat')
  const msgs = [...MSGS, { id: 'f2', role: 'agent', kind: 'file', content: { name: '견적 검토표.xlsx', conv: 'quote' }, created_at: '2026-11-25T02:02:00Z' }]
  const of = topicOf(msgs)
  assert.deepEqual(artifactItems({ scope: 'topic', messages: msgs, convOf: of, convFilter: 'lec', titles: { lec: '강의 준비' } }).map((x) => [x.msg.id, x.convTitle]), [['f1', '강의 준비']])
  assert.deepEqual(artifactItems({ scope: 'topic', messages: msgs, convOf: of, convFilter: 'quote' }).map((x) => x.msg.id), ['f2'])
  assert.deepEqual(artifactItems({ scope: 'project', messages: msgs, convOf: of }).map((x) => x.msg.id), ['f2', 'f1'])
  assert.equal(CAPTION.topic, '이 주제의 산출물')
})
