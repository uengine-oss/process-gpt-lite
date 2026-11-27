// The files a chat made (src/artifactScope.js — spec openspec/specs/chat-artifacts): which files the view on screen has, their order
// and search, where they show (the right column's list · its rail · the pile · nothing) and where the pile sits by the composer.
// No database, no model.
//   cd server && node --test test/chatArtifacts.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactScope, artifactItems, filterArtifacts, artifactLayout, sideWidth, pilePlace, pileRoom, readFolded, saveFolded, FOLD_KEY, LIST_W, RAIL_W, CHAT_MIN, CAPTION } from '../../src/artifactScope.js'

const t0 = Date.parse('2026-11-24T10:00:00Z')
const msg = (id, kind, name, sec) => ({ id, kind, content: kind === 'file' ? { name, url: `/f/${id}` } : { text: name }, created_at: new Date(t0 + sec * 1000).toISOString() })
const MAIN = [
  msg('u1', 'text', '숙소 알아봐 줘', 0), msg('a1', 'text', '표로 정리했어요', 1), msg('f1', 'file', '숙소.xlsx', 2), msg('f2', 'file', '지도.png', 3),
  msg('u2', 'text', '영상 목록', 4), msg('a2', 'text', '정리했어요', 5), msg('f3', 'file', '영상.md', 6),
  { id: 'f4', kind: 'file', content: { url: '/f/noname' }, created_at: new Date(t0 + 7000).toISOString() },
]
const convOf = { u1: 'trip', a1: 'trip', f1: 'trip', f2: 'trip', u2: 'yt', a2: 'yt', f3: 'yt' }
const titles = { trip: '출장 숙소', yt: '유튜브 채널' }

test('AS-U-01 범위: 전체 채팅 · 고른 대화 · 프로젝트 방, 그 밖(루틴 · 새 프로젝트 · 다른 방)은 없음', () => {
  assert.equal(artifactScope({ mode: 'chat', activeId: 'm', mainId: 'm' }), 'chat')
  assert.equal(artifactScope({ mode: 'chat', activeId: 'm', mainId: 'm', convFilter: 'trip' }), 'conv')
  assert.equal(artifactScope({ mode: 'project', activeId: 'p1', mainId: 'm', projectIds: ['p1'] }), 'project')
  assert.equal(artifactScope({ mode: 'project', activeId: 'draft-x', mainId: 'm', projectIds: ['p1'] }), null)
  assert.equal(artifactScope({ mode: 'project', activeId: null, mainId: 'm', projectIds: ['p1'] }), null)
  assert.equal(artifactScope({ mode: 'routine', activeId: 'inst-thread', mainId: 'm' }), null)
  // (one sub-topic of a project — spec project-room 「프로젝트 안의 주제」, test/projectTopics.test.js PT-U-11)
  assert.deepEqual(Object.keys(CAPTION), ['chat', 'conv', 'project', 'topic'])
})

test('AS-U-02 파일: 최근 순, 이름 없는 파일은 뺌, 전체 채팅은 나온 대화를 붙이고 고른 대화는 그 대화 것만', () => {
  const all = artifactItems({ scope: 'chat', messages: MAIN, convOf, titles })
  assert.deepEqual(all.map((x) => x.msg.id), ['f3', 'f2', 'f1'])
  assert.deepEqual(all.map((x) => x.convTitle), ['유튜브 채널', '출장 숙소', '출장 숙소'])
  assert.deepEqual(artifactItems({ scope: 'conv', messages: MAIN, convOf, convFilter: 'trip', titles }).map((x) => x.msg.id), ['f2', 'f1'])
  assert.deepEqual(artifactItems({ scope: 'project', messages: MAIN, convOf, titles }).map((x) => [x.msg.id, x.conv]), [['f3', null], ['f2', null], ['f1', null]])
  assert.deepEqual(artifactItems({ scope: null, messages: MAIN }), [])
  // same time: the later in the chat first; no time: last
  const same = [msg('x', 'file', 'a.md', 1), msg('y', 'file', 'b.md', 1), { id: 'z', kind: 'file', content: { name: 'c.md' } }]
  assert.deepEqual(artifactItems({ scope: 'project', messages: same }).map((x) => x.msg.id), ['y', 'x', 'z'])
  // the chat's own list is left as it was
  assert.equal(MAIN[0].id, 'u1')
})

test('AS-U-03 찾기: 파일 이름 · 나온 대화, 낱말마다, 대소문자 무시', () => {
  const all = artifactItems({ scope: 'chat', messages: MAIN, convOf, titles })
  const ids = (q) => filterArtifacts(all, q).map((x) => x.msg.id)
  assert.deepEqual(ids(''), ['f3', 'f2', 'f1'])
  assert.deepEqual(ids('숙소'), ['f2', 'f1'])
  assert.deepEqual(ids('출장 PNG'), ['f2'])
  assert.deepEqual(ids('유튜브'), ['f3'])
  assert.deepEqual(ids('없음'), [])
})

test('AS-U-04 자리: 채팅 칸(512px + 양옆 40px)이 남으면 오른쪽 목록 · 접으면 띠, 모자라면 더미, 휴대폰은 더미, 문서가 열리면 없음', () => {
  assert.equal(CHAT_MIN, 592)
  assert.equal(artifactLayout({ pageW: 1440, leftW: 420, count: 3 }), 'list')
  assert.equal(artifactLayout({ pageW: 1312, leftW: 420, count: 3 }), 'list')
  assert.equal(artifactLayout({ pageW: 1311, leftW: 420, count: 3 }), 'pile')
  assert.equal(artifactLayout({ pageW: 1280, leftW: 420, count: 3 }), 'pile')
  assert.equal(artifactLayout({ pageW: 1280, leftW: 0, count: 3 }), 'list')
  assert.equal(artifactLayout({ pageW: 1440, leftW: 420, count: 3, folded: true }), 'rail')
  assert.equal(artifactLayout({ pageW: 1100, leftW: 420, count: 3, folded: true }), 'pile')
  assert.equal(artifactLayout({ pageW: 390, leftW: 0, wide: false, count: 3 }), 'pile')
  assert.equal(artifactLayout({ pageW: 1440, leftW: 420, count: 3, docOpen: true }), 'none')
  assert.equal(artifactLayout({ pageW: 390, wide: false, count: 3, docOpen: true }), 'none')
  assert.equal(artifactLayout({ pageW: 1440, count: 0 }), 'none')
  // a docked messenger (400 + 12) narrows the page: 1600 − 412 = 1188
  assert.equal(artifactLayout({ pageW: 1188, leftW: 420, count: 3 }), 'pile')
  assert.equal(artifactLayout({ pageW: 1188, leftW: 0, count: 3 }), 'list')
  assert.deepEqual([sideWidth('list'), sideWidth('rail'), sideWidth('pile'), sideWidth('none')], [LIST_W, RAIL_W, 0, 0])
})

test('AS-U-05 더미의 자리: 입력창 오른쪽에 넉넉하면 옆, 아니면 입력창(과 그 위 알약) 위 — 휴대폰은 작게', () => {
  // 1280 with Home: the chat column 860 → 174px right of the composer
  assert.deepEqual(pilePlace({ gutter: 174, footTop: 84 }), { mode: 'beside', size: 64, right: 55, bottom: 30 })
  assert.equal(pilePlace({ gutter: 112, footTop: 84 }).mode, 'beside')
  // 1100 with Home: 84px — above the composer, its right edges in line, clear of 「멈추기」(12 + 38 over the composer)
  assert.deepEqual(pilePlace({ gutter: 84, footTop: 84 }), { mode: 'above', size: 64, right: 84, bottom: 144 })
  // a grown composer pushes it up
  assert.equal(pilePlace({ gutter: 84, footTop: 230 }).bottom, 290)
  // a phone: 16px from the edge, small
  assert.deepEqual(pilePlace({ gutter: 16, footTop: 84, small: true }), { mode: 'above', size: 48, right: 16, bottom: 144 })
  assert.equal(pilePlace({ gutter: 400, small: true }).mode, 'above')
  assert.equal(pilePlace({ gutter: 0, footTop: 84 }).right, 16)
  // a turn's row over the box (36px) comes and goes: the pile stays where it was (PR #119 review), clear of the row
  assert.equal(pilePlace({ gutter: 84, footTop: 120, boxTop: 84 }).bottom, 144)
  assert.equal(pilePlace({ gutter: 16, footTop: 120, boxTop: 84, small: true }).bottom, 144)
  // a taller composer over a short box (a grown row): still 10px over the row
  assert.equal(pilePlace({ gutter: 84, footTop: 200, boxTop: 84 }).bottom, 210)
  // a notice of two lines (62px, 12px over the composer): clear of it
  assert.equal(pilePlace({ gutter: 84, footTop: 84, boxTop: 84, noticeH: 62 }).bottom, 168)
})

// (2026-11-28 · PR #118 후속 회귀 F-CP-03: 390 휴대폰에서 확인 카드의 「만들기」가 더미 밑에 깔림) 더미가 채팅 위에 떠 있으면 목록 끝은 그 위까지 비운다
test('AS-U-05b 더미가 채팅 위에 있으면(입력창 위) 목록이 비워 둘 높이 — 더미 · 이름 · 개수 배지 · 흔들림까지, 입력창 옆이면 0', () => {
  // a phone: the small pile 144px over the bottom — 48 tall, its name under it (6 + 16), the count's badge (6) and the bob (4) over it
  assert.equal(pileRoom(pilePlace({ gutter: 16, footTop: 84, small: true })), 144 + 48 + 32)
  // a narrow window: the big pile above the composer
  assert.equal(pileRoom(pilePlace({ gutter: 84, footTop: 84 })), 144 + 64 + 32)
  // a composer grown by typing raises the pile, and the room with it
  assert.equal(pileRoom(pilePlace({ gutter: 16, footTop: 230, small: true })), 290 + 48 + 32)
  // beside the composer (a desktop with a gutter): clear of the list — nothing changes there
  assert.equal(pileRoom(pilePlace({ gutter: 174, footTop: 84 })), 0)
  assert.equal(pileRoom(null), 0)
  // (PR #122 review) while the on-screen keyboard is up the chat is short: no room kept for the pile then
  assert.equal(pileRoom(pilePlace({ gutter: 16, footTop: 84, small: true }), { keyboard: true }), 0)
  assert.equal(pileRoom(pilePlace({ gutter: 16, footTop: 84, small: true }), { keyboard: false }), 144 + 48 + 32)
})

test('AS-U-06 접은 채인지: 이 브라우저에 「rail」 · 「list」, 저장소가 막혀도 오류 없이 펼침', () => {
  const mem = new Map()
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) }
  assert.equal(readFolded(storage), false)
  saveFolded(true, storage)
  assert.equal(mem.get(FOLD_KEY), 'rail')
  assert.equal(readFolded(storage), true)
  saveFolded(false, storage)
  assert.equal(readFolded(storage), false)
  const blocked = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceeded') } }
  assert.equal(readFolded(blocked), false)
  assert.doesNotThrow(() => saveFolded(true, blocked))
})
