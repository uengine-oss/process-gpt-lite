// A Home card put away with a sideways swipe, the way a phone's own notifications go (2026-11-21: the
// person swiped the card before finding its ✕; 2026-11-23: every Home card — notices, mail, work items —
// can be put away, 「홈은 일종의 노티피케이션이므로」). Up and down stay the list's scroll (touch-action:
// pan-y on the card). A mouse does not swipe; the ✕ is there.
//   const s = useSwipeAway(() => dismiss())  → bind ref="s.el", :style="s.style.value", and the pointer
//   handlers; in a card that is itself a button, s.swiped() says a click is the end of a swipe.
import { ref, computed } from 'vue'

export function useSwipeAway(away, { threshold = 0.33 } = {}) {
  const el = ref(null)
  const dx = ref(0)
  const leaving = ref(0)
  const snap = ref(false)
  let start = null
  let sideways = null
  let swipedAt = 0
  function down(e) {
    if (e.pointerType === 'mouse') return
    // a control inside the card keeps its own press (the card itself may be a button)
    const hit = e.target.closest?.('button, a, input, textarea, select, [role=button]')
    if (hit && hit !== el.value) return
    start = { x: e.clientX, y: e.clientY, id: e.pointerId }
    sideways = null
  }
  function move(e) {
    if (!start || e.pointerId !== start.id) return
    const mx = e.clientX - start.x
    const my = e.clientY - start.y
    if (sideways === null && Math.hypot(mx, my) > 10) sideways = Math.abs(mx) > Math.abs(my) * 1.3
    if (sideways) dx.value = mx
  }
  function up() {
    if (!start) return
    if (sideways) swipedAt = Date.now()
    const w = el.value?.offsetWidth || 320
    if (sideways && Math.abs(dx.value) > w * threshold) {
      leaving.value = dx.value > 0 ? 1 : -1
      setTimeout(away, 160)
    } else if (dx.value) {
      dx.value = 0
      snap.value = true
      setTimeout(() => { snap.value = false }, 220)
    }
    start = null
    sideways = null
  }
  // (transitions only while swiping: the list's own move animation — TransitionGroup arc-move — stays as it is)
  const style = computed(() => leaving.value ? { transform: `translateX(${leaving.value * 110}%)`, opacity: 0, transition: 'transform .18s ease-out, opacity .18s ease-out' }
    : dx.value ? { transform: `translateX(${dx.value}px)`, opacity: Math.max(0.3, 1 - Math.abs(dx.value) / 400) }
    : snap.value ? { transform: 'translateX(0)', transition: 'transform .2s ease-out, opacity .2s ease-out' } : null)
  const swiping = computed(() => !!dx.value)
  return { el, dx, style, swiping, down, move, up, swiped: () => Date.now() - swipedAt < 400 }
}
