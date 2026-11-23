// Saving an open IeumOffice document without the person reaching for 저장.
// The web editors write their file only on 저장 (the quick-access button in their title bar) or
// Ctrl+S — a phone has neither in reach, so an edit stayed in the open tab and was lost on close.
// The editor page is same-origin (/office is proxied), so the frame can see that something was
// edited and press the editor's own 저장. Which press works, measured on the production host
// (ecea940, 2026-11-24): docs · sheets · slides take the 저장 button (sheets refuses a Ctrl+S save:
// "save target was not authorized", slides ignores it); the 한글 editor has no such button and
// takes Ctrl+S (the host page forwards it to the editor).

// a key that changes the document (not moving, selecting or a shortcut)
export function editingKey(e) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey) return false
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return true // an input method (한글) at work
  return e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || e.key === 'Tab' || (typeof e.key === 'string' && e.key.length === 1)
}

// the editor's own 저장 in its quick-access bar ("저장 (⌘S)" · "Save (Ctrl+S)"), never 다른 이름으로 저장
export function saveButton(doc) {
  for (const b of doc?.querySelectorAll?.('.qa-btn') || []) {
    const label = String(b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()
    if (/^(저장|save)(?!\s*as)/i.test(label)) return b
  }
  return null
}

// press 저장 in the editor; false when the frame is not there
export function pressSave(frame) {
  const w = frame?.contentWindow
  const doc = frame?.contentDocument
  if (!w || !doc) return false
  // a slide's text box being typed in keeps its text to itself until it is left
  const el = doc.activeElement
  if (el && el !== doc.body && el.isContentEditable && doc.querySelector('.slide-list, .stage-wrap')) {
    el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  }
  const btn = saveButton(doc)
  if (btn) { btn.click(); return true }
  ;(doc.activeElement || doc.body).dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
  return true
}

// listen for edits in the editor page and the same-origin pages inside it (the 한글 editor's studio, which a
// slow phone builds well after the page says it is ready: frames added later are watched as they come);
// returns a function that stops listening. A drag on a slide (moving a shape) counts as an edit too.
export function watchEdits(frame, onEdit) {
  const offs = []
  const seen = new WeakSet()
  const frames = new WeakSet()
  const hook = (f) => {
    if (frames.has(f)) return
    frames.add(f)
    const inner = () => { try { attach(f.contentDocument) } catch { /* another origin */ } }
    f.addEventListener('load', inner)
    offs.push(() => f.removeEventListener('load', inner))
    inner()
  }
  const attach = (doc) => {
    if (!doc || seen.has(doc)) return
    seen.add(doc)
    let down = null
    const on = (type, fn) => { doc.addEventListener(type, fn, true); offs.push(() => doc.removeEventListener(type, fn, true)) }
    for (const t of ['input', 'paste', 'cut', 'drop', 'compositionend']) on(t, () => onEdit(t))
    on('keydown', (e) => { if (editingKey(e)) onEdit('key') })
    // (a deck only: elsewhere a drag is mostly selecting)
    on('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY } })
    on('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 && doc.querySelector('.slide-list, .stage-wrap')) onEdit('drag')
      down = null
    })
    for (const f of doc.querySelectorAll('iframe')) hook(f)
    const MO = doc.defaultView?.MutationObserver
    if (MO) {
      const mo = new MO(() => { for (const f of doc.querySelectorAll('iframe')) hook(f) })
      mo.observe(doc.documentElement, { childList: true, subtree: true })
      offs.push(() => mo.disconnect())
    }
  }
  // the editor page itself may not be there yet, or may load again
  const outer = () => { try { attach(frame?.contentDocument) } catch { /* not ready */ } }
  frame?.addEventListener?.('load', outer)
  offs.push(() => frame?.removeEventListener?.('load', outer))
  let tries = 0
  const tick = setInterval(() => { outer(); if (++tries > 20) clearInterval(tick) }, 500)
  offs.push(() => clearInterval(tick))
  outer()
  return () => { for (const off of offs.splice(0)) off() }
}
