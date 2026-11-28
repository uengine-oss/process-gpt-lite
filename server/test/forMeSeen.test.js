// 대화 › 나에게 온 것의 「보면 읽음」 규칙(src/forMeSeen.js — components/team/Messenger.vue 가 씀). PR #127 검토: 가장 새 항목만 보여도 그 방을 그
// 메시지까지 읽어 화면 아래의 더 오래된 항목 · 그 Home 카드까지 지웠고, 목록보다 1.7배쯤 큰 항목은 「보였다」가 되지 못했다.
//   OL-U-01 방마다 가장 오래된 안 읽은 항목부터 모두 본 데까지만 · 다른 방 · 읽은 항목은 상관없음
//   OL-U-02 항목의 60 % 가 보이거나, 목록보다 큰 항목은 목록 높이의 60 % 를 채우면 본 것
import test from 'node:test'
import assert from 'node:assert/strict'
import { readPoint, seenEnough } from '../../src/forMeSeen.js'

const at = (min) => new Date(Date.UTC(2026, 10, 28, 9, min)).toISOString()
const items = [
  { id: 'g3', threadId: 'G', at: at(30), unread: true },
  { id: 'd1', threadId: 'D', at: at(25), unread: true },
  { id: 'g2', threadId: 'G', at: at(20), unread: true },
  { id: 'g1', threadId: 'G', at: at(10), unread: true },
  { id: 'g0', threadId: 'G', at: at(5), unread: false },
]

test('OL-U-01 읽는 곳은 가장 오래된 안 읽은 항목부터 모두 본 데까지 — 가장 새 것만 보았으면 아무것도 읽지 않음', () => {
  assert.equal(readPoint(items, 'G', new Set(['g3'])), null)
  assert.equal(readPoint(items, 'G', new Set(['g3', 'g2'])), null)
  assert.equal(readPoint(items, 'G', new Set(['g1'])).id, 'g1')
  assert.equal(readPoint(items, 'G', new Set(['g1', 'g3'])).id, 'g1')
  assert.equal(readPoint(items, 'G', new Set(['g1', 'g2', 'g3'])).id, 'g3')
  // (another room's item and an item already read change nothing)
  assert.equal(readPoint(items, 'G', new Set(['d1', 'g0'])), null)
  assert.equal(readPoint(items, 'D', new Set(['d1'])).id, 'd1')
  assert.equal(readPoint(items, 'X', new Set(['g1'])), null)
  assert.equal(readPoint([], 'G', new Set()), null)
})

test('OL-U-02 본 것: 항목의 60 % 이상, 또는 목록보다 큰 항목이 목록 높이의 60 % 이상', () => {
  const root = { height: 600 }
  assert.equal(seenEnough({ isIntersecting: false, intersectionRatio: 1, intersectionRect: { height: 300 }, rootBounds: root }), false)
  assert.equal(seenEnough({ isIntersecting: true, intersectionRatio: 0.6, intersectionRect: { height: 120 }, rootBounds: root }), true)
  assert.equal(seenEnough({ isIntersecting: true, intersectionRatio: 0.3, intersectionRect: { height: 120 }, rootBounds: root }), false)
  // an item of 1,500px in a list of 600: at most 40 % of itself shows — 360px of the list's 600 is enough
  assert.equal(seenEnough({ isIntersecting: true, intersectionRatio: 0.24, intersectionRect: { height: 360 }, rootBounds: root }), true)
  assert.equal(seenEnough({ isIntersecting: true, intersectionRatio: 0.2, intersectionRect: { height: 300 }, rootBounds: root }), false)
  // (no root size known: only the item's own share counts)
  assert.equal(seenEnough({ isIntersecting: true, intersectionRatio: 0.3, intersectionRect: { height: 360 }, rootBounds: null }), false)
})
