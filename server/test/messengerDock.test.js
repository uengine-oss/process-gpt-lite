// 메신저 붙이기(2026-11-24 「대화방 위치를 끌어다가 다른 위치로 docking …」): src/messengerDock.js 의 규칙 — 상태 · 창 너비 · 배치 ·
// 끌어 놓는 자리 · 기기에 남기기. 화면 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as D from '../../src/messengerDock.js'

test('처음 · 남긴 값: 모르는 값은 떠 있기 · 기본 너비, 너비는 한도 안으로', () => {
  assert.deepEqual(D.initial(null), { dock: 'float', width: D.DEFAULT_W })
  assert.deepEqual(D.initial({ dock: 'right', width: 480 }), { dock: 'right', width: 480 })
  assert.deepEqual(D.initial({ dock: 'top', width: 'x' }), { dock: 'float', width: D.DEFAULT_W })
  assert.equal(D.initial({ dock: 'left', width: 99 }).width, D.MIN_W)
  assert.equal(D.initial({ dock: 'left', width: 5000 }).width, D.MAX_W)
  assert.equal(D.initial({ dock: 'panel', width: -3 }).width, D.DEFAULT_W)
})

test('reduce: 자리 바꾸기 · 너비(창이 남겨 둘 페이지 폭 안에서) · 되돌리기, 같은 값이면 같은 상태', () => {
  const s0 = D.initial(null)
  const s1 = D.reduce(s0, { type: 'dock', to: 'right' })
  assert.equal(s1.dock, 'right')
  assert.equal(D.reduce(s1, { type: 'dock', to: 'right' }), s1, '같은 자리: 그대로')
  assert.equal(D.reduce(s1, { type: 'dock', to: 'top' }), s1, '모르는 자리: 그대로')
  assert.equal(D.reduce(s1, { type: 'resize', width: 520, viewW: 1440 }).width, 520)
  // 1100px 창: 페이지에 560px 을 남기면 열은 1100 - 560 - 12 = 528 까지
  assert.equal(D.reduce(s1, { type: 'resize', width: 700, viewW: 1100 }).width, 528)
  // 좁은 창이라도 최소 너비 아래로는 줄지 않는다
  assert.equal(D.reduce(s1, { type: 'resize', width: 200, viewW: 1000 }).width, D.MIN_W)
  assert.equal(D.reduce(s1, { type: 'resize', width: s1.width, viewW: 1440 }), s1)
  assert.deepEqual(D.reduce(s1, { type: 'reset' }), D.initial(null))
  assert.equal(D.reduce(s1, { type: 'nope' }), s1)
})

test('창 너비: 1000px 아래(휴대폰 포함)는 붙이지 않고 떠 있다 — 고른 자리는 남는다', () => {
  const s = { dock: 'panel', width: 400 }
  assert.equal(D.effective(s, 1440), 'panel')
  assert.equal(D.effective(s, 999), 'float')
  assert.equal(D.effective(s, 390), 'float')
  assert.equal(D.canDock(1000), true)
  assert.equal(D.layout(s, { viewW: 390 }).dock, 'float')
  assert.equal(s.dock, 'panel')
})

test('배치: 오른쪽 · 왼쪽은 페이지가 열만큼 비켜 주고, 문서 패널은 문서가 옆에 열렸을 때 그 패널에 들어간다', () => {
  const W = 400, G = D.GUTTER
  assert.deepEqual(D.layout({ dock: 'float', width: W }, { viewW: 1440 }), { dock: 'float', width: W, left: 0, right: 0, inPanel: false, single: false })
  assert.deepEqual(D.layout({ dock: 'right', width: W }, { viewW: 1440 }), { dock: 'right', width: W, left: 0, right: W + G, inPanel: false, single: true })
  assert.deepEqual(D.layout({ dock: 'left', width: W }, { viewW: 1440 }), { dock: 'left', width: W, left: W + G, right: 0, inPanel: false, single: true })
  // 문서가 없으면 오른쪽 열과 같다
  assert.deepEqual(D.layout({ dock: 'panel', width: W }, { viewW: 1440 }), { dock: 'panel', width: W, left: 0, right: W + G, inPanel: false, single: true })
  // 문서가 페이지 옆에 열리면 그 패널 안: 페이지는 더 비켜 주지 않는다
  assert.deepEqual(D.layout({ dock: 'panel', width: W }, { viewW: 1440, docBeside: true }), { dock: 'panel', width: W, left: 0, right: 0, inPanel: true, single: true })
  // 넓은 열은 목록과 대화를 나란히
  assert.equal(D.layout({ dock: 'right', width: 660 }, { viewW: 1600 }).single, false)
  // 남긴 너비가 지금 창에 넘치면 창에 맞춘다
  assert.equal(D.layout({ dock: 'right', width: 720 }, { viewW: 1100 }).width, 528)
})

test('끌어 놓는 자리: 왼쪽 끝 · 오른쪽 끝 · 문서 패널, 그 밖은 떠 있기, 좁은 창은 없음', () => {
  const [w, h] = [1440, 900]
  const z = Object.fromEntries(D.zones(w, h).map((r) => [r.id, r]))
  assert.deepEqual(Object.keys(z), ['left', 'panel', 'right'])
  // 겹치지 않고 창 안에 있다
  assert.ok(z.left.x + z.left.w < z.panel.x && z.panel.x + z.panel.w < z.right.x && z.right.x + z.right.w <= w)
  assert.equal(D.zoneAt(40, 450, w, h), 'left')
  assert.equal(D.zoneAt(1400, 450, w, h), 'right')
  assert.equal(D.zoneAt(1000, 450, w, h), 'panel')
  assert.equal(D.zoneAt(400, 450, w, h), 'float')
  assert.equal(D.zoneAt(1000, 30, w, h), 'float', '패널은 머리 막대 아래부터')
  assert.equal(D.zoneAt(40, 450, 900, h), null)
  for (const vw of [1000, 1280, 1920]) {
    for (const r of D.zones(vw, 800)) assert.equal(D.zoneAt(r.x + r.w / 2, r.y + r.h / 2, vw, 800), r.id, `${vw}px 의 ${r.id}`)
  }
})

test('기기에 남기기: 저장소가 없거나 막혀도 기본값, 저장 실패는 조용히', () => {
  const mem = new Map()
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) }
  assert.deepEqual(D.load(store), D.initial(null))
  D.save(store, { dock: 'left', width: 456 })
  assert.deepEqual(JSON.parse(mem.get(D.KEY)), { dock: 'left', width: 456 })
  assert.deepEqual(D.load(store), { dock: 'left', width: 456 })
  mem.set(D.KEY, '{not json')
  assert.deepEqual(D.load(store), D.initial(null))
  const blocked = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceeded') } }
  assert.deepEqual(D.load(blocked), D.initial(null))
  assert.doesNotThrow(() => D.save(blocked, { dock: 'right', width: 400 }))
  assert.deepEqual(D.load(null), D.initial(null))
  assert.doesNotThrow(() => D.save(undefined, { dock: 'right', width: 400 }))
})
