// The left column beside a document open beside the page (src/leftColumn.js — spec openspec/specs/chat-artifacts 「문서가 페이지 옆에
// 열려 있어도 왼쪽 칸 · 채팅 · 문서는 겹치지 않는다」): beside the chat where the page holds the column (420px), the chat (512px + 40px
// each side) and the document; else the list is put away (a button in the top bar lays it over the chat) and Home lies over the chat.
// No browser, no database.
//   cd server && node --test test/docLayout.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { leftColumnPlace, fitsBeside, leftEdge, overWidth, LEFT_W, OVER_X, LEFT_LABEL, LEFT_SHORT } from '../../src/leftColumn.js'
import { CHAT_MIN } from '../../src/artifactScope.js'

// the document panel's width as OfficeSheet draws it: min(960px, 70%) for a document, min(840px, 64%) for an ArtCraft app, and in the
// panel dock the messenger's width more, at most 72% of the page
const docOf = (pageW, { craft = false, panel = 0 } = {}) => (panel ? Math.min((craft ? 840 : 960) + panel, 0.72 * pageW) : craft ? Math.min(840, 0.64 * pageW) : Math.min(960, 0.7 * pageW))
const KINDS = ['projects', 'routines', 'threads', 'home']

test('DL-U-01 문서가 없으면 왼쪽 칸은 늘 채팅 옆, 원하는 칸이 없으면 없음', () => {
  assert.equal(LEFT_W, 420)
  assert.equal(CHAT_MIN, 592)
  for (const kind of KINDS) for (const pageW of [1001, 1280, 2000]) assert.equal(leftColumnPlace({ kind, pageW }), 'column')
  assert.equal(leftColumnPlace({ kind: null, pageW: 2000 }), 'none')
  assert.equal(leftColumnPlace({ pageW: 1280, docW: 896, peek: true }), 'none')
})

test('DL-U-02 문서 옆: 왼쪽 칸 + 채팅(512 + 40 × 2) + 문서가 들어가면 나란히, 아니면 목록은 접힘 — 1280 · 1440 · 1600 은 접힘, 2000 은 나란히', () => {
  const at = (pageW, o) => leftColumnPlace({ kind: 'projects', pageW, docW: docOf(pageW, o) })
  assert.equal(at(1280), 'folded')
  assert.equal(at(1440), 'folded')
  assert.equal(at(1600), 'folded')
  assert.equal(at(2000), 'column')
  // the edge: 420 + 592 + 960 = 1972
  assert.equal(at(1972), 'column')
  assert.equal(at(1971), 'folded')
  // an ArtCraft app (840px) leaves more: 1852
  assert.equal(at(1852, { craft: true }), 'column')
  assert.equal(at(1851, { craft: true }), 'folded')
  // the same rule for every list
  for (const kind of ['routines', 'threads']) assert.equal(leftColumnPlace({ kind, pageW: 1600, docW: 960 }), 'folded')
  assert.equal(fitsBeside({ pageW: 1280 }), true)
  assert.equal(fitsBeside({ pageW: 1600, docW: 960 }), false)
})

test('DL-U-03 붙여 둔 메신저: 페이지가 메신저 열만큼 좁아지거나(오른쪽 · 왼쪽) 문서 패널이 메신저만큼 넓어짐(패널) — 그 폭으로 정함', () => {
  // 2000 − 412 (a 400px column + 12): the page 1588 → folded
  assert.equal(leftColumnPlace({ kind: 'projects', pageW: 1588, docW: docOf(1588) }), 'folded')
  // 2600 − 412 = 2188 → beside
  assert.equal(leftColumnPlace({ kind: 'projects', pageW: 2188, docW: docOf(2188) }), 'column')
  // the panel dock at 2000: the panel min(960 + 400, 1440) = 1360 → folded
  assert.equal(docOf(2000, { panel: 400 }), 1360)
  assert.equal(leftColumnPlace({ kind: 'projects', pageW: 2000, docW: docOf(2000, { panel: 400 }) }), 'folded')
})

test('DL-U-04 접힌 목록의 단추를 누르면 채팅 위에 펼침 · Home 은 열면 채팅 위 — 자리가 있으면 그대로 나란히', () => {
  assert.equal(leftColumnPlace({ kind: 'projects', pageW: 1600, docW: 960, peek: true }), 'over')
  assert.equal(leftColumnPlace({ kind: 'home', pageW: 1600, docW: 960 }), 'over')
  assert.equal(leftColumnPlace({ kind: 'home', pageW: 2000, docW: 960 }), 'column')
  assert.equal(leftColumnPlace({ kind: 'projects', pageW: 2000, docW: 960, peek: true }), 'column')
  // where the chat starts: the column's width, else the page's edge (nothing folded takes the chat's width)
  assert.deepEqual(['column', 'folded', 'over', 'none'].map(leftEdge), [LEFT_W, 0, 0, 0])
  // over the chat: from 12px, at most 408px, never into the document's room (1280: 1280 − 896 − 12 = 372)
  assert.equal(OVER_X, 12)
  assert.equal(overWidth({ pageW: 1600, docW: 960 }), 408)
  assert.equal(overWidth({ pageW: 1280, docW: 896 }), 372)
  assert.equal(OVER_X + overWidth({ pageW: 1028, docW: 720 }) <= 1028 - 720, true)
  assert.equal(overWidth({ pageW: 500, docW: 495 }), 0)
})

test('DL-U-05 단추의 이름', () => {
  assert.deepEqual(LEFT_LABEL, { home: 'Home', threads: '대화 목록', projects: '프로젝트 목록', routines: '루틴 목록' })
  assert.deepEqual(LEFT_SHORT, { home: 'Home', threads: '대화', projects: '프로젝트', routines: '루틴' })
})
