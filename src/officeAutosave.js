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
    if (saveKindOf(b) === 'save') return b
  }
  return null
}

// What an editor control does with the document, by the editor's own label for it (its aria-label, tooltip or text — UI words
// of the editor, not anything a person wrote): 'save' (저장 · Save), 'saveAs' (다른 이름으로 저장… · Save As…, or the quick-access
// .qa-save-as) or null. 2026-11-27 production: the text editor's 「다른 이름으로 저장…」 did nothing (the web host answers every
// file dialog with 「cancelled」), so the sheet takes it (OfficeEditorFrame) — and watches 저장 to say how the save went.
// The 한글 editor's studio names its menu entries by command (data-cmd="file:save" · "file:save-as" · "file:save-as-hwp(x)").
export function saveKindOf(el) {
  if (!el?.getAttribute) return null
  if (el.classList?.contains('qa-save-as')) return 'saveAs'
  const cmd = el.getAttribute('data-cmd')
  if (cmd) return /^file:save-as/.test(cmd) ? 'saveAs' : cmd === 'file:save' ? 'save' : null
  const named = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tip') || '').replace(/\s+/g, ' ').trim()
  const label = named || String(el.textContent || '').replace(/\s+/g, ' ').trim()
  if (/^(다른 이름으로 저장|save as)/i.test(label)) return 'saveAs'
  // (저장 by its name only — a button whose text merely starts with 저장 is something else)
  if (/^(저장|save)(?!\s*as)(\s|\(|$)/i.test(named)) return 'save'
  return null
}

// The letter a shortcut was pressed with: the key's own where the layout gives a Latin letter (AZERTY's Ctrl+Z is on the key QWERTY calls
// W — code KeyW, key 'z'; Dvorak's Ctrl+S on QWERTY's ;), else the key's place (a Korean or Cyrillic layout gives no Latin letter).
function letterOf(e) {
  const k = String(e?.key || '')
  if (/^[a-z]$/i.test(k)) return k.toLowerCase()
  return /^Key([A-Z])$/.exec(e?.code || '')?.[1]?.toLowerCase() || ''
}

// ⌘S · Ctrl+S → 'save', with ⇧ → 'saveAs' (the editors' own shortcuts), anything else → null
export function saveKeyOf(e) {
  if (!e || !(e.ctrlKey || e.metaKey) || e.altKey || e.repeat || letterOf(e) !== 's') return null
  return e.shiftKey ? 'saveAs' : 'save'
}

// The editor says there is nothing to save: its own 저장 is there and switched off (the text editor's is while nothing changed since
// its last save — a search typed, an edit undone before any save is not a change to it). true / false (switched on) / null (no such button).
export function editorClean(doc) {
  const b = saveButton(doc)
  return b ? b.disabled === true || b.getAttribute('aria-disabled') === 'true' : null
}

// CSS that hides the editor's 「다른 이름으로 저장」 entries (the quick-access button, the 한글 studio's menu) — and, always, the studio's
// 「HWP 형식으로 저장」 · 「HWPX 형식으로 저장」 (another format: not what the sheet's 「다른 이름으로 저장」 does). saveAs: the sheet takes
// 「다른 이름으로 저장」 itself, so that entry stays.
export function saveAsHideCss({ saveAs = false } = {}) {
  const sel = ['.md-item[data-cmd="file:save-as-hwp"]', '.md-item[data-cmd="file:save-as-hwpx"]']
  if (!saveAs) sel.unshift('.qa-save-as', '.md-item[data-cmd="file:save-as"]')
  return `${sel.join(', ')} { display: none !important; }`
}

// The editors' own controls around the document that change nothing in it (IeumOffice: the ribbon and its quick-access row, the search
// panel, the status bar; the 한글 studio: its menu and status bar; any toolbar or dialog). Not the 한글 studio's style bar (#style-bar):
// a font, size or style set there changes the document, and that editor has no 저장 of its own to tell (review #107).
export const EDITOR_CHROME = '.ribbon, .ribbon-tabs, .ribbon-collapsible, .find-panel, .status-bar, #status-bar, .md-menu, [role="toolbar"], [role="dialog"], [role="menu"]'

// press 저장 in the editor; false when the frame is not there. force: also when the editor's button says there is nothing to save
// (a retry after the editor's upload failed — the editor took that save as done): its own ⌘S writes the file again.
// → how it was pressed: 'button' | 'republish' | 'key', or null (no editor page). Async: a slide's text box left by Escape turns 저장 on
// a moment later (waited for, up to 2 s).
// The editor's 저장 switched off says it has written everything it has — and a press of it is never answered (review #111: 25–30 s, then
// 「저장하지 못했어요」; an upload that failed leaves it off too, the editor taking its save as done). Then the host is asked to send the
// editor's last write up again (republish — a host that says it can, in its 'ready'), which it answers like a save; without that, the
// editor's own Ctrl+S. Only where 저장 off can be taken at its word (review #111): the text, HTML and Word editors turn it on with each
// edit as it is made, the mind map (its fork build) also while a title is being typed; a spreadsheet when no cell is open. A slide's text
// box and a sheet's open cell keep text that is not written while 저장 is off: the editor's Ctrl+S then — refused by the web host's
// spreadsheet, ignored by its slides, so the save is not answered and nothing typed is taken as saved — unless nothing was edited since
// the write that failed (quiet: the page's word), which is then the one to send up again.
const OFF_MEANS_WRITTEN = new Set(['markdown', 'html', 'docs', 'mindmap'])
export async function pressSave(frame, { republish = null, editor = '', quiet = false } = {}) {
  const w = frame?.contentWindow
  const doc = frame?.contentDocument
  if (!w || !doc) return null
  // a slide's text box being typed in keeps its text to itself until it is left
  const el = doc.activeElement
  if (el && el !== doc.body && el.isContentEditable && doc.querySelector('.slide-list, .stage-wrap')) {
    el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
    // (the editor puts the box's text into the slide a moment later, and only then turns its 저장 on — measured 11-27, e2e F-CS-23: not
    // within 150 ms; pressed before that, the save of the text never came)
    for (let t = 0; t < 2000 && saveButton(doc)?.disabled; t += 50) await new Promise((r) => setTimeout(r, 50))
  }
  const btn = saveButton(doc)
  if (btn && !btn.disabled) { btn.click(); return 'button' }
  const written = quiet || OFF_MEANS_WRITTEN.has(editor) || (editor === 'sheets' && !typingIn(doc))
  if (btn && republish && written) { republish(); return 'republish' }
  ;(doc.activeElement || doc.body).dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
  return 'key'
}
// the keyboard is in a field of the page that is on the page (a cell's editor open on a cell, a text box, an input). The spreadsheet
// (Univer) keeps its cell editor focused when no cell is being typed in, parked off the page (at -1000, -1038 — measured 11-27 on the
// production host, e2e F-CS-16): that is not typing.
function typingIn(doc) {
  const el = doc?.activeElement
  if (!el || el === doc.body || !(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return false
  const r = el.getBoundingClientRect?.()
  const w = doc.defaultView
  return !r || !w || (r.right > 0 && r.bottom > 0 && r.left < w.innerWidth && r.top < w.innerHeight)
}

// ⌘Z · Ctrl+Z, ⌘⇧Z, Ctrl+Y: an undo or a redo changes the document (review #111: the mind map's are not typed)
export function undoKeyOf(e) {
  if (!e || !(e.ctrlKey || e.metaKey) || e.altKey || e.repeat) return false
  const l = letterOf(e)
  return l === 'z' || l === 'y'
}

// listen for edits in the editor page and the same-origin pages inside it (the 한글 editor's studio, which a
// slow phone builds well after the page says it is ready: frames added later are watched as they come);
// returns a function that stops listening. A drag on a slide (moving a shape) counts as an edit too.
// hooks.onSave: the person pressed the editor's 저장 (its button or ⌘S); hooks.onSaveAs: its 「다른 이름으로 저장」 — a press on the
// control, or ⌘⇧S, is taken here (the 한글 studio's own handler, on its text box, never sees it; the text editor's, on its window,
// sees ⌘⇧S first and does nothing with it in the web host); hooks.onDoc(doc): each page watched (the 한글 studio's comes later);
// hooks.onPointer(e): every press of the mouse or a finger in a watched page (the mind map's edits are mostly made that way).
// What is typed in the editor's own controls (its ribbon, search box, status bar, the 한글 studio's style bar — EDITOR_CHROME) is not an
// edit of the document; a field of the document itself (a form field on a 한글 page, a spreadsheet's formula bar) is.
export function watchEdits(frame, onEdit, hooks = {}) {
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
    const field = (e) => !!e.target?.closest?.(EDITOR_CHROME)
    for (const t of ['input', 'paste', 'cut', 'drop', 'compositionend']) on(t, (e) => { if (!field(e)) onEdit(t) })
    on('keydown', (e) => {
      if (editingKey(e) || undoKeyOf(e)) return field(e) ? undefined : onEdit('key')
      const k = saveKeyOf(e)
      if (k === 'save') hooks.onSave?.('key')
      else if (k === 'saveAs' && hooks.onSaveAs) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
        hooks.onSaveAs('key')
      }
    })
    // (capture on the document: before the editor's own handler on its root)
    on('click', (e) => {
      const el = e.target?.closest?.('button, [role="button"], [role="menuitem"], [data-cmd]')
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList?.contains('disabled')) return
      const k = saveKindOf(el)
      if (k === 'save') hooks.onSave?.('button')
      else if (k === 'saveAs' && hooks.onSaveAs) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
        hooks.onSaveAs('button')
      }
    })
    // (a deck only: elsewhere a drag is mostly selecting)
    on('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; hooks.onPointer?.(e) })
    on('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 && doc.querySelector('.slide-list, .stage-wrap')) onEdit('drag')
      down = null
    })
    try { hooks.onDoc?.(doc) } catch { /* the page went away */ }
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
