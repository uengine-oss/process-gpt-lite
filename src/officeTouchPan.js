// A finger on a spreadsheet scrolls it (2026-11-26, the user: 「엑셀 이음오피스를 모바일에서 열었을때 쓰기모드라서
// 스크롤 할 수 없는문제」). The IeumOffice sheets editor draws its grid on one canvas (Univer) and reads a
// finger like a mouse: a drag selects a range, so on a phone the sheet never moves, read-only or not.
// Here, on the editor page (same origin, the frame installs it), a finger works as it does in phone
// spreadsheet apps:
//   - drag            → scrolls (the editor's own wheel scrolling, pixel for pixel), and keeps going a
//                       little after a quick flick
//   - tap             → selects the cell (the tap is handed to the editor as a mouse click)
//   - double tap      → edits the cell
//   - press and hold  → then drag selects a range
// A mouse, a pen and the editor's other parts (cell editor, formula bar, menus) are left alone. The
// editor itself is not changed (office-host stays as it is, as for the other phone fixes).

const MOVE_PX = 8       // a finger moving further than this is scrolling, not tapping
const HOLD_MS = 450     // a finger resting this long starts a range selection
const DOUBLE_MS = 350   // two taps this close in time (and place) are a double tap
const DOUBLE_PX = 24
const FLICK_MS = 100    // the finger's last moves that give a flick its speed
const FRICTION = 0.95   // speed kept per 16 ms frame of a flick
const MIN_SPEED = 0.03  // px/ms: a flick stops below this

// the grid: the editor's big canvas (the cell editor and the formula bar draw on small ones)
export const isSheetGrid = (el) =>
  el?.tagName === 'CANVAS' && !!el.closest?.('#univer-container') && el.getBoundingClientRect().height > 120

export function installSheetTouchPan(win, { isGrid = isSheetGrid, now = () => win.performance.now() } = {}) {
  if (!win?.document || win.__pgptTouchPan) return win?.__pgptTouchPan || null
  let g = null           // the finger being followed
  const fingers = new Set() // every finger of the gesture, until each is lifted
  let replaying = false  // events this module sends to the editor pass through its own listeners
  let flick = null       // { raf, target, x, y, vx, vy, t }
  let lastTap = null     // { t, x, y } for a double tap
  let ownDouble = -1e9   // when this module sent a double click (the browser's own is then dropped)

  const send = (target, ev) => { replaying = true; try { target.dispatchEvent(ev) } finally { replaying = false } }
  // the editor takes it as the mouse (pointer 1 is always there: its pointer capture works)
  const mouse = (type, x, y, buttons) => new win.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: win, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: type === 'pointermove' ? -1 : 0, buttons, clientX: x, clientY: y, screenX: x, screenY: y,
  })
  const wheel = (target, dx, dy, x, y) => send(target, new win.WheelEvent('wheel', {
    bubbles: true, cancelable: true, composed: true, view: win, deltaX: dx, deltaY: dy, deltaMode: 0, clientX: x, clientY: y,
  }))

  function stopFlick() {
    if (!flick) return false
    win.cancelAnimationFrame(flick.raf)
    flick = null
    return true
  }
  function startFlick(target, x, y, vx, vy) {
    if (Math.hypot(vx, vy) < MIN_SPEED * 4) return
    flick = { target, x, y, vx, vy, t: now(), raf: 0 }
    const step = () => {
      if (!flick) return
      const t = now(), dt = Math.min(48, t - flick.t)
      flick.t = t
      const keep = Math.pow(FRICTION, dt / 16)
      flick.vx *= keep; flick.vy *= keep
      if (Math.hypot(flick.vx, flick.vy) < MIN_SPEED) { flick = null; return }
      wheel(flick.target, flick.vx * dt, flick.vy * dt, flick.x, flick.y)
      flick.raf = win.requestAnimationFrame(step)
    }
    flick.raf = win.requestAnimationFrame(step)
  }

  const ours = (e) => !replaying && e.isTrusted && e.pointerType === 'touch'

  function onDown(e) {
    if (!ours(e)) return
    if (fingers.size) {
      // a second finger: the gesture stops here (a range selection under way ends where it is)
      e.stopImmediatePropagation()
      fingers.add(e.pointerId)
      end(null)
      return
    }
    if (!isGrid(e.target)) return
    e.stopImmediatePropagation()
    fingers.add(e.pointerId)
    const stopped = stopFlick()
    g = { id: e.pointerId, target: e.target, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, mode: stopped ? 'stop' : 'wait', moves: [], hold: 0 }
    if (!stopped) g.hold = win.setTimeout(() => {
      if (!g || g.mode !== 'wait') return
      g.mode = 'select'
      send(g.target, mouse('pointerdown', g.x0, g.y0, 1))
      try { win.navigator.vibrate?.(8) } catch { /* no vibration here */ }
    }, HOLD_MS)
  }

  function onMove(e) {
    if (!ours(e) || !fingers.has(e.pointerId)) return
    e.stopImmediatePropagation()
    if (!g || e.pointerId !== g.id) return
    const x = e.clientX, y = e.clientY
    if ((g.mode === 'wait' || g.mode === 'stop') && Math.hypot(x - g.x0, y - g.y0) > MOVE_PX) {
      win.clearTimeout(g.hold)
      g.mode = 'pan'
    }
    if (g.mode === 'pan') {
      const dx = g.x - x, dy = g.y - y
      if (dx || dy) wheel(g.target, dx, dy, x, y)
      const t = now()
      g.moves.push({ t, dx, dy })
      while (g.moves.length && t - g.moves[0].t > FLICK_MS) g.moves.shift()
    } else if (g.mode === 'select') {
      send(g.target, mouse('pointermove', x, y, 1))
    }
    g.x = x; g.y = y
  }

  function end(e) {
    if (!g) return
    win.clearTimeout(g.hold)
    const cur = g
    g = null
    const up = e?.type === 'pointerup'
    if (cur.mode === 'select') {
      send(cur.target, mouse('pointerup', cur.x, cur.y, 0))
    } else if (cur.mode === 'wait' && up) {
      // a tap: the editor gets the click it would get from a mouse
      send(cur.target, mouse('pointerdown', cur.x0, cur.y0, 1))
      send(cur.target, mouse('pointerup', cur.x0, cur.y0, 0))
      const t = now()
      if (lastTap && t - lastTap.t < DOUBLE_MS && Math.hypot(cur.x0 - lastTap.x, cur.y0 - lastTap.y) < DOUBLE_PX) {
        lastTap = null
        ownDouble = t
        send(cur.target, new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: win, detail: 2, button: 0, clientX: cur.x0, clientY: cur.y0, screenX: cur.x0, screenY: cur.y0 }))
      } else lastTap = { t, x: cur.x0, y: cur.y0 }
    } else if (cur.mode === 'pan' && up) {
      // the speed of the last moves before the finger left (a finger that rested first does not flick)
      const t = now()
      const recent = cur.moves.filter((m) => t - m.t <= FLICK_MS)
      cur.moves = recent
      const span = recent.length > 1 ? t - recent[0].t : 0
      if (span > 0) {
        const sx = cur.moves.reduce((s, m) => s + m.dx, 0), sy = cur.moves.reduce((s, m) => s + m.dy, 0)
        startFlick(cur.target, cur.x, cur.y, sx / span, sy / span)
      }
    }
  }
  function onUp(e) {
    if (!ours(e) || !fingers.has(e.pointerId)) return
    e.stopImmediatePropagation()
    fingers.delete(e.pointerId)
    if (g && e.pointerId === g.id) end(e)
  }
  // the rest of a finger's pointer events (over · enter · out · leave) stay away from the grid too
  function onOther(e) {
    if (ours(e) && isGrid(e.target)) e.stopImmediatePropagation()
  }
  // a double tap the browser also reports: the editor got one already
  function onDouble(e) {
    if (e.isTrusted && !replaying && now() - ownDouble < 700 && isGrid(e.target)) { e.stopImmediatePropagation(); e.preventDefault() }
  }

  const on = [
    ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp],
    ['pointerover', onOther], ['pointerenter', onOther], ['pointerout', onOther], ['pointerleave', onOther],
    ['dblclick', onDouble],
  ]
  for (const [type, fn] of on) win.addEventListener(type, fn, true)
  const handle = {
    dispose() {
      stopFlick()
      if (g) win.clearTimeout(g.hold)
      g = null
      fingers.clear()
      for (const [type, fn] of on) win.removeEventListener(type, fn, true)
      if (win.__pgptTouchPan === handle) delete win.__pgptTouchPan
    },
  }
  win.__pgptTouchPan = handle
  return handle
}
