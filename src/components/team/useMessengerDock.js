// The messenger's place on the screen (src/messengerDock.js has the rules): the layout in effect, the page beside a docked
// column (html data-msgdock + --msgdock-* for App.vue's .page and the document panel, pageInset for the chat's columns),
// dragging the header onto a drop zone, and resizing a docked column by its inner edge.
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { layout, zones, zoneAt, canDock, GUTTER } from '../../messengerDock.js'
import { viewW, narrow, pageInset } from '../../viewport.js'
import { useTeam } from '../../stores/team.js'
import { useApp } from '../../stores/app.js'

const FLOAT = { dock: 'float', width: 0, left: 0, right: 0, inPanel: false, single: false }
// a header's own controls are not where a drag starts
const CONTROL = 'button, a, input, textarea, select, label, summary, [role="button"], [role="menu"], [role="menuitemradio"], [contenteditable]'
// the panel dock sits where the document panel is (OfficeSheet: 76px under the top, 16px from the edge)
const PANEL_TOP = 76, PANEL_EDGE = 16

export function useMessengerDock() {
  const team = useTeam()
  const app = useApp()
  // phones keep the full-screen sheet; a window too narrow for a column floats it (the choice is kept)
  const dockable = computed(() => !narrow.value && canDock(viewW.value))
  const lay = computed(() => (narrow.value ? FLOAT : layout(team.dockState, { viewW: viewW.value, docBeside: app.docSide })))
  const docked = computed(() => lay.value.dock !== 'float')
  // where the column is, in the window
  const box = computed(() => {
    const l = lay.value
    if (l.dock === 'float') return null
    if (l.inPanel) return { top: `${PANEL_TOP}px`, bottom: `${PANEL_EDGE}px`, right: `${PANEL_EDGE}px`, width: `${l.width}px` }
    return { top: `${GUTTER}px`, bottom: `${GUTTER}px`, [l.dock === 'left' ? 'left' : 'right']: `${GUTTER}px`, width: `${l.width}px` }
  })

  // ---- the page beside a docked column ----
  const root = document.documentElement
  function clear() {
    delete root.dataset.msgdock
    delete root.dataset.msgdockPanel
    for (const k of ['--msgdock-w', '--msgdock-l', '--msgdock-r']) root.style.removeProperty(k)
    pageInset.value = 0
  }
  watch(lay, (l) => {
    if (l.dock === 'float') return clear()
    root.dataset.msgdock = l.dock
    if (l.inPanel) root.dataset.msgdockPanel = ''
    else delete root.dataset.msgdockPanel
    root.style.setProperty('--msgdock-w', `${l.width}px`)
    root.style.setProperty('--msgdock-l', `${l.left}px`)
    root.style.setProperty('--msgdock-r', `${l.right}px`)
    pageInset.value = l.left + l.right
  }, { immediate: true })

  // ---- dragging the header onto a drop zone ----
  const drag = ref(null) // {x, y, zone} while a header is dragged
  const dropZones = computed(() => (drag.value ? zones(viewW.value, window.innerHeight) : []))
  let pending = null
  function dragStart(e) {
    if (!dockable.value || e.button > 0 || e.target.closest?.(CONTROL)) return
    pending = { x: e.clientX, y: e.clientY, id: e.pointerId, el: e.currentTarget }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* a synthetic event */ }
    window.addEventListener('pointermove', dragMove)
    window.addEventListener('pointerup', dragEnd)
    window.addEventListener('pointercancel', dragCancel)
    window.addEventListener('keydown', dragKey, true)
  }
  function dragMove(e) {
    if (!pending || e.pointerId !== pending.id) return
    if (!drag.value && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 6) return
    e.preventDefault()
    drag.value = { x: e.clientX, y: e.clientY, zone: zoneAt(e.clientX, e.clientY, viewW.value, window.innerHeight) }
  }
  function dragEnd(e) {
    if (pending && e.pointerId !== pending.id) return
    const z = drag.value?.zone
    stopDrag()
    if (z) team.setDock(z)
  }
  function dragCancel() { stopDrag() }
  function dragKey(e) { if (e.key === 'Escape' && drag.value) { e.stopImmediatePropagation(); stopDrag() } }
  function stopDrag() {
    try { pending?.el?.releasePointerCapture(pending.id) } catch { /* released */ }
    pending = null
    drag.value = null
    window.removeEventListener('pointermove', dragMove)
    window.removeEventListener('pointerup', dragEnd)
    window.removeEventListener('pointercancel', dragCancel)
    window.removeEventListener('keydown', dragKey, true)
  }

  // ---- resizing a docked column by its inner edge (pointer, or the arrow keys on the edge) ----
  const resizing = ref(false)
  let rz = null
  const widthAt = (x) => {
    const l = lay.value
    if (l.dock === 'left') return x - GUTTER
    return viewW.value - (l.inPanel ? PANEL_EDGE : GUTTER) - x
  }
  function resizeStart(e) {
    if (!docked.value || e.button > 0) return
    e.preventDefault()
    rz = { id: e.pointerId, el: e.currentTarget }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* a synthetic event */ }
    resizing.value = true
    root.classList.add('msgdock-resizing')
    window.addEventListener('pointermove', resizeMove)
    window.addEventListener('pointerup', resizeEnd)
    window.addEventListener('pointercancel', resizeEnd)
  }
  function resizeMove(e) { if (rz && e.pointerId === rz.id) team.setDockWidth(widthAt(e.clientX), { keep: false }) }
  function resizeEnd() {
    try { rz?.el?.releasePointerCapture(rz.id) } catch { /* released */ }
    rz = null
    resizing.value = false
    root.classList.remove('msgdock-resizing')
    window.removeEventListener('pointermove', resizeMove)
    window.removeEventListener('pointerup', resizeEnd)
    window.removeEventListener('pointercancel', resizeEnd)
    team.setDockWidth(team.dockState.width)
  }
  // ←/→ move the edge 16px (the column grows toward the page)
  function resizeKey(e) {
    const grow = lay.value.dock === 'left' ? { ArrowRight: 16, ArrowLeft: -16 } : { ArrowLeft: 16, ArrowRight: -16 }
    if (!(e.key in grow)) return
    e.preventDefault()
    team.setDockWidth(team.dockState.width + grow[e.key])
  }

  onBeforeUnmount(() => { stopDrag(); if (rz) resizeEnd(); clear() })
  return { lay, docked, dockable, box, drag, dropZones, dragStart, resizing, resizeStart, resizeKey }
}
