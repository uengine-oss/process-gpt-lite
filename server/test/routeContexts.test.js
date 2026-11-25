// What the context router chooses among for a main-chat message (lib/routeContexts.js — spec openspec/specs/chat-thread-list 「후속
// 메시지는 방금 일하던 대화로」). 2026-11-25 production: 「글씨가 표의 윗부분에 붙어있다. 중앙정렬」, sent a minute after an edit of a
// document with a table in the same chat, was routed as 「새 주제」 — the router saw each conversation by title and its latest request
// only. Now each candidate says which files it made, was given or edited and how long ago its last turn was, the one the person was just
// in is marked as live work, and a document open now links to the conversation that last worked on it. No database, no model.
//   cd server && node --test test/routeContexts.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { factsOf, contextsFor, docLinksOf, factLine, fileKind } from '../lib/routeContexts.js'
import { pool } from '../lib/supa.js'

after(() => pool.end().catch(() => {}))

const NOW = Date.parse('2026-11-25T09:30:00+09:00')
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString()
const msg = (id, role, kind, content, minAgo) => ({ id, role, kind, content, created_at: at(minAgo) })
// the chat a minute before the follow-up: an edit of 보고서.docx (its table) in conversation E, earlier a trip conversation, a scheduled
// run and a brief filed aside in between
const CHAT = [
  msg('u0', 'user', 'text', { text: '부산 숙소 세 곳 비교해 줘', conv: 'trip' }, 300),
  msg('a0', 'agent', 'text', { text: '표로 비교했어요.', context: { conversationId: 'trip', title: '부산 출장 숙소', action: 'new' }, conv: 'trip' }, 299),
  msg('f0', 'agent', 'file', { name: '숙소 비교.xlsx' }, 299),
  msg('u1', 'user', 'file', { name: '보고서.docx', attached: true, url: 'http://127.0.0.1:54321/storage/v1/object/public/files/u/att/r1.docx' }, 12),
  msg('u2', 'user', 'text', { text: '이 보고서 표 머리글 굵게 해 줘', conv: 'E' }, 12),
  msg('a2', 'agent', 'text', { text: '머리글을 굵게 했어요.', context: { conversationId: 'E', title: '보고서 표 정리', action: 'new' }, conv: 'E' }, 11),
  msg('f2', 'agent', 'file', { name: '보고서.docx', edited: true, url: 'http://127.0.0.1:54321/storage/v1/object/public/files/u/out/r2.docx' }, 11),
  msg('d1', 'system', 'divider', { text: '주식 감시', scheduleId: 's1', context: { conversationId: 'sched-s1', action: 'aside', kind: 'schedule', title: '주식 감시' } }, 6),
  msg('s1', 'agent', 'text', { text: 'ASTS -7%', context: { conversationId: 'sched-s1', action: 'aside', kind: 'schedule' }, conv: 'sched-s1' }, 6),
  msg('b1', 'agent', 'text', { text: '모닝 브리프', context: { conversationId: 'brief-x', action: 'aside', kind: 'brief' } }, 4),
  // the live edit a minute ago: the router stayed (no id in its call), the turn's own conversation is on `conv`, the open document on `openDoc`
  msg('u3', 'user', 'text', { text: '표 안 글씨 세로 가운데로', conv: 'E' }, 2),
  msg('a3', 'agent', 'text', { text: '세로 가운데로 맞췄어요.', context: { title: '보고서 표 정리', action: 'stay' }, conv: 'E', openDoc: { file: '보고서.docx', app: 'ieumoffice', msgId: 'f2' } }, 1),
  // the message being answered now
  msg('u4', 'user', 'text', { text: '글씨가 표의 윗부분에 붙어있다. 중앙정렬' }, 0),
]
const ROWS = [
  { conversation_id: 'brief-x', title: '브리프', summary: '최근 요청: 모닝 브리프\n최근 답: …', gist: '', kind: 'brief', updated_at: at(4) },
  { conversation_id: 'sched-s1', title: '주식 감시', summary: '최근 요청: 5일 누적 5% 급등락\n최근 답: ASTS -7%', gist: '', kind: 'schedule', updated_at: at(6) },
  { conversation_id: 'E', title: '보고서 표 정리', summary: '최근 요청: 이 보고서 표 머리글 굵게 해 줘\n최근 답: 머리글을 굵게 했어요.', gist: '보고서 머리글', kind: 'conversation', updated_at: at(11) },
  { conversation_id: 'trip', title: '부산 출장 숙소', summary: '최근 요청: 부산 숙소 세 곳 비교해 줘\n최근 답: 표로 비교했어요.', gist: '', kind: 'conversation', updated_at: at(299) },
]

test('RC-U-01 대화마다 다룬 파일(만듦 · 첨부 · 편집)과 마지막 턴, 사람이 방금 있던 대화 — 따로 둔 예약 실행 · 브리프는 아님', () => {
  const f = factsOf(CHAT, { except: 'u4' })
  assert.deepEqual(f.justIn, { conv: 'E', at: Date.parse(at(2)) })
  assert.deepEqual(f.convs.E.docs.map((d) => [d.name, d.how]), [['보고서.docx', 'edited']])
  assert.equal(f.convs.E.at, Date.parse(at(1)))
  assert.deepEqual(f.convs.trip.docs.map((d) => [d.name, d.how]), [['숙소 비교.xlsx', 'made']])
  assert.equal(f.convs['sched-s1'], undefined)
  assert.equal(f.convs['brief-x'], undefined)
  // without `except` the message being answered (no conversation yet) is still waiting: the conversation the person was in before stays
  assert.equal(factsOf(CHAT).justIn.conv, 'E')
  // a person's message whose turn has not recorded its conversation: the answer that follows tells it
  const f2 = factsOf([msg('x', 'user', 'text', { text: '숙소' }, 3), msg('y', 'agent', 'text', { text: '네', context: { conversationId: 'trip', action: 'continue', title: 't' } }, 2)])
  assert.equal(f2.justIn.conv, 'trip')
})

test('RC-U-02 라우터 후보: 저장된 제목 · gist · 종류는 그대로, 요약 앞에 사실 한 줄, 방금 있던 대화는 진행 중', () => {
  const c = contextsFor(ROWS, factsOf(CHAT, { except: 'u4' }), { now: NOW })
  const E = c.find((x) => x.conversation_id === 'E')
  assert.equal(E.title, '보고서 표 정리')
  assert.equal(E.gist, '보고서 머리글')
  assert.equal(E.kind, 'conversation')
  assert.equal(E.active, true)
  const [line, ...rest] = E.summary.split('\n')
  assert.equal(line, '방금까지 사람이 있던 대화(마지막 턴 1분 전) · 다룬 파일: 보고서.docx(Word 문서, 편집)')
  // the stored summary follows as it was (the router reads its 「최근 요청」 line to fold the gist)
  assert.deepEqual(rest, ['최근 요청: 이 보고서 표 머리글 굵게 해 줘', '최근 답: 머리글을 굵게 했어요.'])
  const trip = c.find((x) => x.conversation_id === 'trip')
  assert.equal(trip.active, undefined)
  assert.equal(trip.summary.split('\n')[0], '마지막 턴 5시간 전 · 다룬 파일: 숙소 비교.xlsx(엑셀 표, 만듦)')
  // a background conversation: its stored row, its last time
  assert.equal(c.find((x) => x.conversation_id === 'sched-s1').summary.split('\n')[0], '마지막 턴 6분 전')
  // the conversation the person was just in is a candidate even when older rows crowd the list
  const many = [...Array.from({ length: 14 }, (_, i) => ({ conversation_id: `x${i}`, title: `다른 일 ${i}`, summary: '', gist: '', kind: 'conversation', updated_at: at(i) })), ROWS[2]]
  assert.ok(contextsFor(many, factsOf(CHAT, { except: 'u4' }), { now: NOW }).some((x) => x.conversation_id === 'E' && x.active))
})

test('RC-U-03 열린 문서 → 그 문서를 마지막으로 다룬 대화: 그 카드(메시지 id)나 주소로만 — 이름만으로는 잇지 않는다(검토 11-25 #4)', () => {
  const f = factsOf(CHAT, { except: 'u4' })
  // opened from its card (the edited copy), or by its address (a signed one's query does not matter)
  assert.deepEqual(docLinksOf(f, { file: '보고서.docx', msgId: 'f2' }), ['E'])
  assert.deepEqual(docLinksOf(f, { file: '보고서.docx', url: 'http://127.0.0.1:54321/storage/v1/object/public/files/u/out/r2.docx?token=abc' }), ['E'])
  assert.deepEqual(docLinksOf(f, { file: '보고서.docx', msgId: 'u1' }), ['E'])
  assert.deepEqual(docLinksOf(f, { file: '숙소 비교.xlsx', msgId: 'f0' }), ['trip'])
  // a document of the same name opened from somewhere else, or a name alone: no link (the router decides)
  assert.deepEqual(docLinksOf(f, { file: '보고서.docx' }), [])
  assert.deepEqual(docLinksOf(f, { file: '보고서.docx', msgId: '00000000-0000-4000-8000-000000000000' }), [])
  assert.deepEqual(docLinksOf(f, null), [])
  // the same card worked on later in another conversation: the later one first, the earlier after it (a folder run room is skipped by
  // the caller — turnFacts)
  const later = factsOf([...CHAT.slice(0, -1), msg('u5', 'user', 'text', { text: '숙소 표에 보고서 붙여', conv: 'trip' }, 0.5), msg('a5', 'agent', 'text', { text: '붙였어요', conv: 'trip', openDoc: { file: '보고서.docx', msgId: 'f2' } }, 0.2)])
  assert.deepEqual(docLinksOf(later, { msgId: 'f2' }), ['trip', 'E'])
})

test('RC-U-04 사실 한 줄의 말: 시간 · 파일 종류', () => {
  assert.equal(factLine({ at: NOW - 3 * 3600_000, docs: [] }, { now: NOW }), '마지막 턴 3시간 전')
  assert.equal(factLine({ at: NOW - 3 * 86400_000, docs: [] }, { now: NOW }), '마지막 턴 3일 전')
  assert.equal(factLine({ at: 0, docs: [] }, { now: NOW }), '')
  assert.deepEqual(['a.hwpx', 'b.pptx', 'c.dxf', 'd.png', 'e.pdf', 'f.zip'].map(fileKind), ['한글 문서', '발표 자료', '도면', '그림', 'PDF', 'zip'])
  // at most three files, newest first
  const docs = ['1.docx', '2.docx', '3.docx', '4.docx'].map((name, i) => ({ name, how: 'made', at: i }))
  assert.equal(factLine({ at: NOW, docs }, { now: NOW }), '마지막 턴 1분 전 · 다룬 파일: 4.docx(Word 문서, 만듦), 3.docx(Word 문서, 만듦), 2.docx(Word 문서, 만듦)')
})
