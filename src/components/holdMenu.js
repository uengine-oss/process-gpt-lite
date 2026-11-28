// A long press (touch) or a right-click (mouse) on a bubble opens the message menu (spec pgpt-pro_message-actions) — an AI answer's
// (공유 · 프로젝트로 시작 …, spec answer-share), a chat file card's (열기 · 공유 · 폴더에 정리, spec messenger-drop-folder), a teammate's
// bubble in the messenger (reactions, spec room-reactions).
// v-hold="(el, at) => …": at is {x, y} for a right-click, {touch: true} for a long press.
const HOLD_MS = 450
const SLOP = 10
const TOUCH_MEMORY_MS = 1000
// a link or a button in the bubble keeps its own behaviour — but one marked data-hold-tap keeps only its tap: held or right-clicked, it
// opens the menu (a chat file card is a button that opens the file — its long press · right-click is the card's menu, Message.vue)
const ownBehaviour = (t) => { const o = t.closest?.('a, button, input, textarea, summary'); return !!o && !o.hasAttribute('data-hold-tap') }
// words already selected in this bubble: the browser's own menu (copy, search…) stays
const selectedIn = (el) => { const s = window.getSelection(); return !!s && !s.isCollapsed && !!s.toString().trim() && el.contains(s.anchorNode) }

// The listeners go on once; each event reads the binding as it is now (v-hold="can ? open : null" — a bubble that becomes reactable, or stops
// being, after it is drawn), and with no handler nothing is held and nothing is prevented: the browser's own long press · menu stay.
const handler = (el) => (typeof el._holdOpen === 'function' ? el._holdOpen : null)
export const hold = {
  mounted(el, binding) {
    el._holdOpen = binding.value
    let timer = null, x0 = 0, y0 = 0, held = false, touchedAt = 0
    const clear = () => { clearTimeout(timer); timer = null }
    const on = {
      touchstart(e) {
        held = false
        if (!handler(el)) return clear()
        touchedAt = Date.now()
        if (e.touches.length !== 1 || ownBehaviour(e.target)) return clear()
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY
        clear()
        timer = setTimeout(() => { timer = null; const open = handler(el); if (!open) return; held = true; touchedAt = Date.now(); navigator.vibrate?.(10); open(el, { touch: true }) }, HOLD_MS)
      },
      // scrolling is not a long press
      touchmove(e) { if (timer && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > SLOP) clear() },
      // the finger coming up is not a tap on what the menu covers
      touchend(e) { clear(); if (held && e.cancelable) e.preventDefault() },
      touchcancel: clear,
      contextmenu(e) {
        const open = handler(el)
        if (!open) return
        // Android sends this for a long press too; the timer above has it (iOS sends none)
        if (e.pointerType === 'touch' || Date.now() - touchedAt < TOUCH_MEMORY_MS) { if (!ownBehaviour(e.target)) e.preventDefault(); return }
        if (ownBehaviour(e.target) || selectedIn(el)) return
        e.preventDefault()
        open(el, { x: e.clientX, y: e.clientY })
      },
    }
    el._holdOff = () => { clear(); for (const k in on) el.removeEventListener(k, on[k]) }
    el.addEventListener('touchstart', on.touchstart, { passive: true })
    el.addEventListener('touchmove', on.touchmove, { passive: true })
    el.addEventListener('touchend', on.touchend)
    el.addEventListener('touchcancel', on.touchcancel, { passive: true })
    el.addEventListener('contextmenu', on.contextmenu)
  },
  // (a handler taken away mid-press: the press is not held)
  updated(el, binding) { el._holdOpen = binding.value },
  unmounted(el) { el._holdOff?.() },
}
