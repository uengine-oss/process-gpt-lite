// A long press (touch) or a right-click (mouse) on a bubble opens the message menu (spec pgpt-pro_message-actions).
// v-hold="(el, at) => …": at is {x, y} for a right-click, {touch: true} for a long press.
const HOLD_MS = 450
const SLOP = 10
const TOUCH_MEMORY_MS = 1000
// a link or a button in the bubble keeps its own behaviour
const ownBehaviour = (t) => t.closest?.('a, button, input, textarea, summary')
// words already selected in this bubble: the browser's own menu (copy, search…) stays
const selectedIn = (el) => { const s = window.getSelection(); return !!s && !s.isCollapsed && !!s.toString().trim() && el.contains(s.anchorNode) }

export const hold = {
  mounted(el, binding) {
    el._holdOpen = binding.value
    let timer = null, x0 = 0, y0 = 0, held = false, touchedAt = 0
    const clear = () => { clearTimeout(timer); timer = null }
    const on = {
      touchstart(e) {
        held = false
        touchedAt = Date.now()
        if (e.touches.length !== 1 || ownBehaviour(e.target)) return clear()
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY
        clear()
        timer = setTimeout(() => { timer = null; held = true; touchedAt = Date.now(); navigator.vibrate?.(10); el._holdOpen(el, { touch: true }) }, HOLD_MS)
      },
      // scrolling is not a long press
      touchmove(e) { if (timer && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > SLOP) clear() },
      // the finger coming up is not a tap on what the menu covers
      touchend(e) { clear(); if (held && e.cancelable) e.preventDefault() },
      touchcancel: clear,
      contextmenu(e) {
        // Android sends this for a long press too; the timer above has it (iOS sends none)
        if (e.pointerType === 'touch' || Date.now() - touchedAt < TOUCH_MEMORY_MS) { if (!ownBehaviour(e.target)) e.preventDefault(); return }
        if (ownBehaviour(e.target) || selectedIn(el)) return
        e.preventDefault()
        el._holdOpen(el, { x: e.clientX, y: e.clientY })
      },
    }
    el._holdOff = () => { clear(); for (const k in on) el.removeEventListener(k, on[k]) }
    el.addEventListener('touchstart', on.touchstart, { passive: true })
    el.addEventListener('touchmove', on.touchmove, { passive: true })
    el.addEventListener('touchend', on.touchend)
    el.addEventListener('touchcancel', on.touchcancel, { passive: true })
    el.addEventListener('contextmenu', on.contextmenu)
  },
  updated(el, binding) { el._holdOpen = binding.value },
  unmounted(el) { el._holdOff?.() },
}
