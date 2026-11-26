// A finger on the spreadsheet editor (2026-11-26, the user: 「엑셀 이음오피스를 모바일에서 열었을때 쓰기모드라서 스크롤 할 수
// 없는문제」). The editor's grid reads a finger like a mouse, so a drag selected cells and the sheet never moved;
// src/officeTouchPan.js turns a finger into: drag → scroll (wheel, pixel for pixel, a flick keeps going),
// tap → the cell, double tap → edit, hold then drag → a range. No browser: a fake window with one grid.
//   cd server && node --test test/officeTouchPan.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { installSheetTouchPan } from '../../src/officeTouchPan.js'

class FakeEvent {
  constructor(type, init = {}) { Object.assign(this, init); this.type = type; this.isTrusted = false; this.stopped = false }
  stopImmediatePropagation() { this.stopped = true }
  preventDefault() { this.defaultPrevented = true }
}

// a window whose capture listeners run first, then the grid (the editor) gets what is left
function setup() {
  let clock = 1000
  const listeners = {}
  let timers = []
  let frames = []
  let seq = 0
  const grid = { tagName: 'CANVAS', got: [] }
  const other = { tagName: 'DIV', got: [] }
  const win = {
    document: {},
    navigator: {},
    PointerEvent: class extends FakeEvent {},
    WheelEvent: class extends FakeEvent {},
    MouseEvent: class extends FakeEvent {},
    addEventListener(type, fn, capture) { assert.equal(capture, true); (listeners[type] ||= []).push(fn) },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn) },
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: clock + ms, fn }); return id },
    clearTimeout(id) { timers = timers.filter((t) => t.id !== id) },
    requestAnimationFrame(fn) { const id = ++seq; frames.push({ id, fn }); return id },
    cancelAnimationFrame(id) { frames = frames.filter((f) => f.id !== id) },
  }
  const fire = (ev, target) => {
    ev.target = target
    for (const fn of listeners[ev.type] || []) { fn(ev); if (ev.stopped) return ev }
    target.got.push(ev)
    return ev
  }
  for (const el of [grid, other]) el.dispatchEvent = (ev) => fire(ev, el)
  const finger = (type, x, y, { id = 7, at = grid, primary = id === 7 } = {}) => {
    const ev = new FakeEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: primary, clientX: x, clientY: y })
    ev.isTrusted = true
    return fire(ev, at)
  }
  const pass = (ms) => {
    clock += ms
    for (const t of timers.filter((t) => t.at <= clock)) { timers = timers.filter((x) => x !== t); t.fn() }
  }
  const frame = (ms = 16) => {
    clock += ms
    const run = frames
    frames = []
    for (const f of run) f.fn()
    return run.length
  }
  const handle = installSheetTouchPan(win, { isGrid: (el) => el === grid, now: () => clock })
  return { win, grid, other, finger, pass, frame, handle, listeners, got: (type) => grid.got.filter((e) => e.type === type) }
}

// a slow drag from (x0, y0) to (x1, y1) in `n` moves, 30 ms apart
function drag(t, x0, y0, x1, y1, n = 10, ms = 30) {
  t.finger('pointerdown', x0, y0)
  for (let i = 1; i <= n; i++) { t.pass(ms); t.finger('pointermove', x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n) }
  t.finger('pointerup', x1, y1)
}

test('drag: the sheet scrolls by the finger\'s distance, and no cell gets selected', () => {
  const t = setup()
  drag(t, 200, 600, 200, 300) // finger up 300 px → the content moves up (scroll down)
  const wheels = t.got('wheel')
  assert.ok(wheels.length >= 9)
  assert.equal(Math.round(wheels.reduce((s, w) => s + w.deltaY, 0)), 300)
  assert.equal(wheels.reduce((s, w) => s + w.deltaX, 0), 0)
  assert.equal(t.got('pointerdown').length, 0, 'the editor never saw a press (a press would start a selection)')
  assert.equal(t.got('pointermove').length + t.got('pointerup').length, 0)
  // sideways: finger left → scroll right
  const s = setup()
  drag(s, 300, 400, 100, 400)
  assert.equal(Math.round(s.got('wheel').reduce((a, w) => a + w.deltaX, 0)), 200)
})

test('tap: the editor gets a mouse click on that cell, nothing scrolls', () => {
  const t = setup()
  t.finger('pointerdown', 120, 340)
  t.pass(80)
  t.finger('pointermove', 122, 342) // a finger trembles a little: still a tap
  t.finger('pointerup', 122, 342)
  const [down] = t.got('pointerdown')
  const [up] = t.got('pointerup')
  assert.ok(down && up)
  assert.deepEqual([down.pointerType, down.pointerId, down.button, down.buttons, down.clientX, down.clientY], ['mouse', 1, 0, 1, 120, 340])
  assert.deepEqual([up.buttons, up.clientX, up.clientY], [0, 120, 340])
  assert.equal(t.got('wheel').length, 0)
  assert.equal(t.got('dblclick').length, 0)
})

test('double tap: the second tap reaches the editor where the first did (its double click opens the cell)', () => {
  // the editor counts two clicks within 2 px and 500 ms as a double click; two finger taps land further apart
  const t = setup()
  const tap = (x, y) => { t.finger('pointerdown', x, y); t.pass(60); t.finger('pointerup', x, y) }
  tap(200, 450)
  t.pass(120)
  tap(204, 452)
  const downs = t.got('pointerdown'), ups = t.got('pointerup')
  assert.equal(downs.length, 2)
  assert.deepEqual(downs.map((e) => [e.clientX, e.clientY]), [[200, 450], [200, 450]])
  assert.deepEqual(ups.map((e) => [e.clientX, e.clientY]), [[200, 450], [200, 450]])
  assert.equal(t.got('dblclick').length, 0, 'the editor reads clicks, not the dblclick event')
  // a third tap right after starts over (not a triple click at the same place)
  t.pass(100)
  tap(206, 455)
  assert.equal(t.got('pointerdown').at(-1).clientX, 206)
  // two taps too far apart in time, or on the next row, are two taps
  const s = setup()
  s.finger('pointerdown', 200, 450); s.pass(60); s.finger('pointerup', 200, 450)
  s.pass(600)
  s.finger('pointerdown', 202, 451); s.pass(60); s.finger('pointerup', 202, 451)
  assert.equal(s.got('pointerdown').at(-1).clientX, 202)
  const r = setup()
  r.finger('pointerdown', 200, 450); r.pass(60); r.finger('pointerup', 200, 450)
  r.pass(100)
  r.finger('pointerdown', 200, 472); r.pass(60); r.finger('pointerup', 200, 472)
  assert.equal(r.got('pointerdown').at(-1).clientY, 472, 'the next row is its own cell')
})

test('hold, then drag: a range selection (the editor sees a mouse drag from where the finger rested)', () => {
  const t = setup()
  t.finger('pointerdown', 150, 300)
  t.pass(500)
  const [down] = t.got('pointerdown')
  assert.ok(down, 'pressed after the hold')
  assert.deepEqual([down.clientX, down.clientY, down.buttons], [150, 300, 1])
  for (let i = 1; i <= 5; i++) { t.pass(30); t.finger('pointermove', 150 + i * 20, 300 + i * 25) }
  t.finger('pointerup', 250, 425)
  const moves = t.got('pointermove')
  assert.equal(moves.length, 5)
  assert.deepEqual([moves.at(-1).clientX, moves.at(-1).clientY, moves.at(-1).buttons], [250, 425, 1])
  const [up] = t.got('pointerup')
  assert.deepEqual([up.clientX, up.clientY, up.buttons], [250, 425, 0])
  assert.equal(t.got('wheel').length, 0, 'no scrolling while selecting')
})

test('flick: the sheet keeps going and slows down; a touch stops it without selecting', () => {
  const t = setup()
  drag(t, 200, 700, 200, 400, 4, 16) // 300 px in 64 ms
  const during = t.got('wheel').length
  const steps = []
  for (let i = 0; i < 400 && t.frame() > 0; i++) steps.push(t.got('wheel').at(-1).deltaY)
  assert.ok(steps.length > 10, `kept going for ${steps.length} frames`)
  assert.ok(steps.every((d) => d > 0), 'same direction')
  assert.ok(steps[0] > steps[steps.length - 1] * 3, 'slowing down')
  assert.equal(t.frame(), 0, 'stopped by itself')
  assert.ok(t.got('wheel').length > during)

  const s = setup()
  drag(s, 200, 700, 200, 400, 4, 16)
  s.frame(); s.frame()
  const before = s.got('wheel').length
  s.finger('pointerdown', 220, 500) // the finger stops the flick …
  s.pass(60)
  s.finger('pointerup', 220, 500)
  assert.equal(s.frame(), 0)
  assert.equal(s.got('wheel').length, before)
  assert.equal(s.got('pointerdown').length, 0, '… and does not pick a cell')
  // a mouse press or a key also stops it
  for (const how of ['mouse', 'key']) {
    const m = setup()
    drag(m, 200, 700, 200, 400, 4, 16)
    m.frame()
    if (how === 'mouse') { const ev = new FakeEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 5, clientY: 5 }); ev.isTrusted = true; m.other.dispatchEvent(ev) } else {
      const ev = new FakeEvent('keydown', { key: 'ArrowDown' }); ev.isTrusted = true; m.grid.dispatchEvent(ev)
    }
    assert.equal(m.frame(), 0, `stopped by the ${how}`)
  }
  // a finger on another part of the editor stops it as well
  const o = setup()
  drag(o, 200, 700, 200, 400, 4, 16)
  o.frame()
  o.finger('pointerdown', 5, 5, { at: o.other }); o.finger('pointerup', 5, 5, { at: o.other })
  assert.equal(o.frame(), 0, 'stopped by a finger outside the grid')
  // a finger that rests before it lifts does not flick: the next tap picks a cell
  const q = setup()
  q.finger('pointerdown', 200, 700)
  for (let i = 1; i <= 4; i++) { q.pass(16); q.finger('pointermove', 200, 700 - i * 75) }
  q.pass(200)
  q.finger('pointerup', 200, 400)
  assert.equal(q.frame(), 0, 'no flick')
  q.finger('pointerdown', 200, 500); q.pass(60); q.finger('pointerup', 200, 500)
  assert.equal(q.got('pointerdown').length, 1)
})

test('a second finger ends the gesture; nothing of either finger reaches the grid', () => {
  const t = setup()
  t.finger('pointerdown', 200, 600)
  t.pass(30); t.finger('pointermove', 200, 560)
  const wheels = t.got('wheel').length
  t.finger('pointerdown', 260, 600, { id: 8 })
  t.pass(30); t.finger('pointermove', 200, 500); t.finger('pointermove', 260, 540, { id: 8 })
  t.finger('pointerup', 200, 500); t.finger('pointerup', 260, 540, { id: 8 })
  assert.equal(t.got('wheel').length, wheels, 'no more scrolling')
  assert.equal(t.grid.got.filter((e) => e.pointerType === 'touch').length, 0)
  assert.equal(t.got('pointerdown').length, 0)
  // and the next single finger works again
  drag(t, 200, 600, 200, 500)
  assert.ok(t.got('wheel').length > wheels)
})

test('a lost lift does not leave touch off: the next first finger starts afresh', () => {
  const t = setup()
  t.finger('pointerdown', 200, 600) // its pointerup never arrives
  t.finger('pointerdown', 200, 600, { id: 9, primary: true })
  t.pass(60)
  t.finger('pointerup', 200, 600, { id: 9 })
  assert.equal(t.got('pointerdown').length, 1, 'the tap reached the editor')
})

test('a mouse, a pen, and a finger on other parts of the editor are left alone', () => {
  const t = setup()
  for (const pointerType of ['mouse', 'pen']) {
    const ev = new FakeEvent('pointerdown', { pointerId: 1, pointerType, clientX: 10, clientY: 10 })
    ev.isTrusted = true
    t.grid.dispatchEvent(ev)
  }
  assert.deepEqual(t.got('pointerdown').map((e) => e.pointerType), ['mouse', 'pen'])
  t.finger('pointerdown', 10, 10, { at: t.other })
  t.finger('pointerup', 10, 10, { at: t.other })
  assert.deepEqual(t.other.got.map((e) => e.type), ['pointerdown', 'pointerup'])
  // the finger's over/enter/out/leave stay away from the grid
  t.finger('pointerout', 10, 10)
  t.finger('pointerleave', 10, 10)
  assert.equal(t.grid.got.filter((e) => e.pointerType === 'touch').length, 0)
})

test('installed once per editor page; dispose takes every listener away', () => {
  const t = setup()
  assert.equal(installSheetTouchPan(t.win), t.handle)
  const count = () => Object.values(t.listeners).reduce((s, l) => s + l.length, 0)
  assert.equal(count(), 9)
  t.handle.dispose()
  assert.equal(count(), 0)
  assert.equal(t.win.__pgptTouchPan, undefined)
  t.finger('pointerdown', 10, 10)
  assert.equal(t.got('pointerdown').length, 1, 'after dispose the editor sees the finger as before')
})
