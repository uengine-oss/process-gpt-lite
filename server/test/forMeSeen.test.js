// 대화 › 나에게 온 것의 「보면 읽음」 규칙(src/forMeSeen.js — components/team/Messenger.vue 가 씀). PR #127 검토: 가장 새 항목만 보여도 그 방을 그
// 메시지까지 읽어 화면 아래의 더 오래된 항목 · 그 Home 카드까지 지웠고, 목록보다 1.7배쯤 큰 항목은 「보였다」가 되지 못했다.
//   OL-U-01 방마다 가장 오래된 안 읽은 항목부터 모두 본 데까지만 · 다른 방 · 읽은 항목은 상관없음
//   OL-U-02 항목의 60 % 가 보이거나, 목록보다 큰 항목은 목록 높이의 60 % 를 채우면 본 것 · 항목마다의 관찰 임계값(재검토: 목록의 10~12배 · 20배 넘게 큰 항목)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readRun, seenEnough, thresholdFor } from '../../src/forMeSeen.js'

const at = (min) => new Date(Date.UTC(2026, 10, 28, 9, min)).toISOString()
const items = [
  { id: 'g3', threadId: 'G', at: at(30), unread: true },
  { id: 'd1', threadId: 'D', at: at(25), unread: true },
  { id: 'g2', threadId: 'G', at: at(20), unread: true },
  { id: 'g1', threadId: 'G', at: at(10), unread: true },
  { id: 'g0', threadId: 'G', at: at(5), unread: false },
]

test('OL-U-01 읽는 곳은 가장 오래된 안 읽은 항목부터 모두 본 데까지 — 가장 새 것만 보았으면 아무것도 읽지 않음, 서버에는 시작도 함께', () => {
  const to = (seen, room = 'G') => readRun(items, room, new Set(seen))?.to.id ?? null
  assert.equal(to(['g3']), null)
  assert.equal(to(['g3', 'g2']), null)
  assert.equal(to(['g1']), 'g1')
  assert.equal(to(['g1', 'g3']), 'g1')
  assert.equal(to(['g1', 'g2', 'g3']), 'g3')
  assert.equal(readRun(items, 'G', new Set(['g1', 'g2'])).from.id, 'g1')
  // (another room's item and an item already read change nothing)
  assert.equal(to(['d1', 'g0']), null)
  assert.equal(to(['d1'], 'D'), 'd1')
  assert.equal(to(['g1'], 'X'), null)
  assert.equal(readRun([], 'G', new Set()), null)
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

test('OL-U-03 항목마다 임계값 하나 — 보통 항목은 60 %, 큰 항목은 목록 높이의 60 % 에 해당하는 비율', () => {
  assert.equal(thresholdFor(300, 600), 0.6)
  for (const k of [1.7, 5, 10, 11, 12, 20, 25, 40]) {
    const h = 600 * k, t = thresholdFor(h, 600)
    // reaching the threshold is exactly 60 % of the list on screen — and an observer can fire there
    assert.ok(Math.abs(t * h - 360) < 1e-6, `k=${k}`)
    assert.ok(t > 0 && t <= 0.6)
    assert.equal(seenEnough({ isIntersecting: true, intersectionRatio: t, intersectionRect: { height: t * h }, rootBounds: { height: 600 } }), true, `k=${k}`)
  }
  assert.equal(thresholdFor(0, 600), 0.6)
})
