'use strict'
// What runs inside the pages of the browser on this PC (host.js — the server's browser agent drives it over the link, desktop 0.2.3).
// The desktop runs only its own code: the server names an operation, never sends code to run.
//
// SECRET_SELECTOR · IS_SECRET_JS · DESCRIBE_JS · PAGE_WORDS_JS · SNAPSHOT_JS are the server's own (server/lib/browserSteps.js), copied
// as they are — the agent reads this PC's pages exactly as it reads its own browser's; server/test/browserDriver.test.js fails when the
// two differ. Masking happens here, before anything leaves the PC: a secret field shows only that it is filled in a look (SNAPSHOT_JS),
// its value is not among the page's words (PAGE_WORDS_JS), it shows dots in the live view (GUARD_JS) and is painted over in the model's
// picture (MASK_ON_JS).

// ---- the server's (keep identical: server/lib/browserSteps.js) ----
const SECRET_SELECTOR = 'input[type=password], [data-pro-secret], input[autocomplete^="cc-"], input[autocomplete="one-time-code"]'

const IS_SECRET_JS = (e, sel) => e.matches(sel) || /card.?(no|num)|cardnumber|cvc|cvv|csc|otp/i.test(`${e.name} ${e.id}`)

const DESCRIBE_JS = (e) => {
  const tag = e.tagName.toLowerCase()
  const field = tag === 'input' || tag === 'textarea' || tag === 'select' || e.isContentEditable
  const auto = e.autocomplete || ''
  const id = `${e.name || ''} ${e.id || ''}`
  const secret = e.type === 'password' ? 'password' : /^cc-number/.test(auto) || /card.?(no|num)|cardnumber/i.test(id) ? 'card'
    : /^cc-csc/.test(auto) || /cvc|cvv|csc/i.test(id) ? 'cvc' : /^cc-exp/.test(auto) ? 'exp' : /one-time-code/.test(auto) || /otp/i.test(id) ? 'otp'
      : e.hasAttribute('data-pro-secret') || /^cc-/.test(auto) ? 'secret' : ''
  const label = e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.placeholder || e.getAttribute('title') || ''
  const button = tag === 'input' && /^(submit|button|reset)$/.test(e.type) ? e.value : ''
  const name = (field && !button ? label || e.name || '' : e.innerText || label || button || e.getAttribute('alt') || '').replace(/\s+/g, ' ').trim()
  const what = field && !button ? '' : [e.innerText, e.value, e.getAttribute('aria-label'), e.getAttribute('title')].filter(Boolean).join(' ').trim().slice(0, 80)
  // where a press goes: a link's address, or the address of the form a submit control sends
  const link = e.closest && e.closest('a[href]')
  const submits = (tag === 'button' && (e.type || 'submit') === 'submit') || (tag === 'input' && /^(submit|image)$/.test(e.type))
  const to = link ? link.href : submits && e.form ? e.form.action : ''
  return { name: name.length > 30 ? `${name.slice(0, 29)}…` : name, field: !!field && !button, secret, what, ...(to ? { to: String(to).slice(0, 2000) } : {}) }
}
const PAGE_WORDS_JS = () => {
  const b = document.body
  if (!b) return ''
  const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=password]):not([data-pro-secret]):not([autocomplete^="cc-"]):not([autocomplete="one-time-code"]),textarea:not([data-pro-secret]),select')].slice(0, 300)
    .map((e) => [e.tagName === 'SELECT' ? e.options[e.selectedIndex]?.text : e.value, e.placeholder, e.getAttribute('aria-label')].filter(Boolean).join(' '))
  return `${b.innerText}\n${fields.join('\n')}`
}
const SNAPSHOT_JS = (opts) => {
  const { maxEls = 120, maxText = 3000, budgetMs = 1500, below = 1, base = 0 } = opts || {}
  const t0 = performance.now()
  const over = () => performance.now() - t0 > budgetMs
  const H = innerHeight, W = innerWidth
  let cut = false
  for (const e of document.querySelectorAll('[data-pro-idx]')) e.removeAttribute('data-pro-idx')
  const meta = (n) => (document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content || '').trim()
  const fields = { password: false, signIn: false }
  const SEL = 'a,button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=searchbox],[role=textbox],[contenteditable=true]'
  const cands = []
  let n = 0
  for (const el of document.querySelectorAll(SEL)) {
    if ((++n & 63) === 0 && over()) { cut = true; break }
    if (el.type === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none') continue
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role') || ''
    const field = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable || /^(combobox|searchbox|textbox)$/.test(role)
    cands.push({ el, rank: field ? 0 : tag === 'a' || role === 'link' ? 2 : 1, order: cands.length })
  }
  const visible = cands.length
  const kept = visible > maxEls ? cands.slice().sort((a, b) => a.rank - b.rank || a.order - b.order).slice(0, maxEls).sort((a, b) => a.order - b.order) : cands
  const els = []
  kept.forEach(({ el }, k) => {
    const i = base + k
    el.setAttribute('data-pro-idx', String(i))
    // a secret field shows what it is for and whether it is filled, never its value
    const secret = el.type === 'password' || el.hasAttribute('data-pro-secret') || /^cc-|one-time-code/.test(el.autocomplete || '') ||
      /card.?(no|num)|cardnumber|cvc|cvv|csc|otp/i.test(`${el.name || ''} ${el.id || ''}`)
    const label = el.placeholder || el.getAttribute('aria-label') || ''
    if (el.type === 'password') fields.password = true
    if (el.tagName === 'INPUT' && (el.type === 'email' || String(el.autocomplete || '').split(/\s+/).some((t) => t === 'username' || t === 'email'))) fields.signIn = true
    const own = secret ? label : (el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text || label : (el.innerText || el.value || label))
    els.push({ i, tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', text: String(own || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      ...(secret ? { secret: true, filled: !!el.value } : {}) })
  })
  // the text on the screen and below it, in document order
  const bottom = H * (1 + below)
  const seen = new Map()
  const shown = (el) => {
    let v = seen.get(el)
    if (v === undefined) {
      const r = el.getBoundingClientRect()
      v = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < bottom && r.right > 0 && r.left < W && getComputedStyle(el).visibility !== 'hidden'
      seen.set(el, v)
    }
    return v
  }
  const parts = []
  let len = 0, last = null, k = 0
  const root = document.body || document.documentElement
  const walk = root ? document.createTreeWalker(root, NodeFilter.SHOW_TEXT) : null
  for (let node = walk?.nextNode(); node; node = walk.nextNode()) {
    if ((++k & 255) === 0 && over()) { cut = true; break }
    const s = node.nodeValue
    if (!s || !s.trim()) continue
    const p = node.parentElement
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) || !shown(p)) continue
    const t = s.replace(/\s+/g, ' ').trim()
    parts.push(p === last ? ` ${t}` : `\n${t}`)
    last = p
    len += t.length + 1
    if (len >= maxText) { cut = true; break }
  }
  return { title: document.title, url: location.href, site: meta('og:site_name') || meta('application-name'), fields,
    text: parts.join('').trim().slice(0, maxText), els,
    ...(cut || visible > els.length ? { more: { visible, cut, scanned: n, ms: Math.round(performance.now() - t0) } } : {}) }
}
// ---- this PC's own ----

// In every page and frame, from its first moment: secret fields show dots (a field the vault filled is marked data-pro-secret). A page's
// own alert · confirm · prompt never opens a box on this PC — a box there holds the page, and nobody may be watching: answered as a
// browser nobody watches answers (the server's own: confirm → cancel, prompt → nothing) and kept for the agent's next look (DIALOGS_JS).
// Unlike the server's guard it reports nothing: logins typed on this PC stay in this PC's browser.
const GUARD_JS = () => {
  const css = () => {
    const root = document.head || document.documentElement
    if (!root || document.getElementById('__pro_guard')) return
    const st = document.createElement('style')
    st.id = '__pro_guard'
    st.textContent = '[data-pro-secret],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]{-webkit-text-security:disc!important}'
    root.appendChild(st)
  }
  document.addEventListener('DOMContentLoaded', css)
  css()
  if (window.__proDialogGuard) return
  window.__proDialogGuard = true
  window.__proDialogs = []
  const keep = (kind, m) => { window.__proDialogs.push(`${kind}: ${String(m ?? '').slice(0, 200)}`); if (window.__proDialogs.length > 5) window.__proDialogs.shift() }
  // this window, and any window of the same origin this page reaches before a guard of its own ran in it: an iframe the page made a
  // moment ago (about:blank — no new document there for the guard to start in) and a window it opened (2026-11-25 re-review)
  const guard = (w) => {
    try {
      if (!w || w.__proDialogGuardOf) return
      w.__proDialogGuardOf = true
      w.alert = function alert(m) { keep('alert', m) }
      w.confirm = function confirm(m) { keep('confirm', m); return false }
      w.prompt = function prompt(m) { keep('prompt', m); return null }
    } catch { /* another origin: its own guard runs in it */ }
  }
  guard(window)
  for (const El of [window.HTMLIFrameElement, window.HTMLFrameElement]) {
    for (const prop of ['contentWindow', 'contentDocument']) {
      const d = El && Object.getOwnPropertyDescriptor(El.prototype, prop)
      if (!d?.get) continue
      Object.defineProperty(El.prototype, prop, { ...d, get() { const v = d.get.call(this); guard(prop === 'contentWindow' ? v : v?.defaultView); return v } })
    }
  }
  const open = window.open
  window.open = function (...a) { const w = open.apply(this, a); guard(w); return w }
  // a page closing its own window: the host closes that tab itself (the work goes back to the page that opened it, or the next operation
  // opens a new tab) — Electron's own close left a window that had been shown on this PC half closed: no 'close' event, and the page drew
  // and answered nothing after (2026-11-25 re-review)
  if (window.top === window) window.close = function close() { console.debug('__pgl_close_tab__') }
}
// the dialogs a page answered since the last look (and forgets them)
const DIALOGS_JS = () => { const d = window.__proDialogs || []; window.__proDialogs = []; return d }

// The model's picture: every secret field on screen painted over (as the server's screenshot mask), and taken off after.
const MASK_ON_JS = (sel) => {
  let n = 0
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect()
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
    const m = document.createElement('div')
    m.setAttribute('data-pro-mask', '')
    m.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:#1d1d1f;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0`
    ;(document.body || document.documentElement).appendChild(m)
    n++
  }
  return n
}
const MASK_OFF_JS = () => { for (const m of document.querySelectorAll('[data-pro-mask]')) m.remove() }

// The element numbered i in the last look (SNAPSHOT_JS marks them), as an action needs it: scrolled into view when it is not, its
// box in this frame's pixels, and whether a press at its middle lands on it (not on something over it).
const ELEMENT_JS = (i, scroll) => {
  const e = document.querySelector(`[data-pro-idx="${i}"]`)
  if (!e) return null
  let r = e.getBoundingClientRect()
  const off = r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth || r.top < 0 || r.bottom > innerHeight
  if (scroll && off) { e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); r = e.getBoundingClientRect() }
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const at = document.elementFromPoint(x, y)
  const hit = !!at && (at === e || e.contains(at) || at.contains(e) || (e.labels && [...e.labels].some((l) => l === at || l.contains(at))) || (at.tagName === 'LABEL' && at.control === e))
  return { x: r.left, y: r.top, width: r.width, height: r.height, hit, tag: e.tagName, type: e.type || '', editable: !!e.isContentEditable }
}

// Ready element i for typing (as Playwright's fill): a field of a kind that takes its value directly gets it now (→ 'set'); a text field
// or an editable area is focused with what it holds selected, so the typed text replaces it (→ 'type'). A select or a non-text input
// cannot be typed into (the same words as the server's browser).
const FOCUS_JS = (i, value) => {
  const e = document.querySelector(`[data-pro-idx="${i}"]`)
  if (!e) throw new Error('this element is no longer on the page')
  const tag = e.tagName
  const direct = ['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week']
  const notText = ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden']
  if (tag === 'INPUT') {
    const t = (e.type || 'text').toLowerCase()
    if (notText.includes(t)) throw new Error(`Error: Input of type "${t}" cannot be filled`)
    if (direct.includes(t)) {
      e.focus()
      e.value = value
      if (e.value !== value) throw new Error('Malformed value')
      e.dispatchEvent(new Event('input', { bubbles: true }))
      e.dispatchEvent(new Event('change', { bubbles: true }))
      return 'set'
    }
  } else if (tag !== 'TEXTAREA' && !e.isContentEditable) {
    throw new Error('Error: Element is not an <input>, <textarea> or [contenteditable] element')
  }
  e.focus()
  if (e.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(e)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  } else {
    try { e.select() } catch { try { e.setSelectionRange(0, e.value.length) } catch { /* not selectable */ } }
  }
  return 'type'
}
// a field the vault filled: masked from now on (GUARD_JS shows it as dots, SNAPSHOT_JS as secret)
const MARK_SECRET_JS = (i) => { const e = document.querySelector(`[data-pro-idx="${i}"]`); if (e) e.setAttribute('data-pro-secret', '') }
const IS_FILE_JS = (i) => { const e = document.querySelector(`[data-pro-idx="${i}"]`); return !!e && e.tagName === 'INPUT' && e.type === 'file' }
const ELEMENT_AT_JS = (i) => document.querySelector(`[data-pro-idx="${i}"]`)
// an iframe's content box in its parent's pixels (called on the iframe element)
const OWNER_BOX_JS = function () {
  const r = this.getBoundingClientRect()
  const s = getComputedStyle(this)
  return { x: r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft), y: r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop), width: r.width, height: r.height }
}

module.exports = { SECRET_SELECTOR, IS_SECRET_JS, DESCRIBE_JS, PAGE_WORDS_JS, SNAPSHOT_JS, GUARD_JS, DIALOGS_JS, MASK_ON_JS, MASK_OFF_JS, ELEMENT_JS, FOCUS_JS, MARK_SECRET_JS,
  IS_FILE_JS, ELEMENT_AT_JS, OWNER_BOX_JS }
