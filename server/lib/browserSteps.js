// Bounded steps for a browser agent on a Playwright page (2026-11-24, 「브라우저가 먹통이 된」): every look, move and
// wait has a limit; a page that never goes quiet is not waited on; the page read is capped and puts what is on screen
// first; the live view sends a bounded number of frames; a watchdog notices when nothing has moved for a while.
// Nothing here knows about tasks, cards or the database — the server's browser agent (lib/browser.js) uses it through
// either page driver (lib/browserServer.js, this server's Chromium; lib/browserRemote.js, a browser on the person's PC).
// The scripts that run inside the page (SNAPSHOT_JS, DESCRIBE_JS, PAGE_WORDS_JS, IS_SECRET_JS) have a twin in the desktop
// app (desktop/src/browser/pageScripts.js — the desktop runs its own copy, never code the server sends); a test keeps them
// the same (test/browserDriver.test.js).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// The limits, in ms (tests shorten them). A step that runs over is stopped and reported, never waited on without end.
export const STEP = {
  navMs: 20000, // a navigation, until the document is there (DOMContentLoaded) — never 'load' or 'networkidle'
  settleMs: 1500, // then at most this long for 'load': a page that keeps loading is read as it is
  snapMs: 6000, // reading the page
  shotMs: 6000, // its picture
  actMs: 15000, // one click, typing, scrolling (a navigation it starts has navMs of its own)
  modelMs: 90000, // one model turn (asked once more when it runs out)
  planMs: 30000, // the plan (the task goes on without one)
  stallMs: 20000, // nothing moved for this long: the card says what it is waiting on and offers 다시 시도 · 그만두기
  launchMs: 30000, // starting Chromium
}

// kind: 'timeout' (the limit passed), 'cancel' (the task was cancelled), 'retry' (the person asked to do this step again)
export class StepError extends Error {
  constructor(kind, label, ms = 0) {
    super(kind === 'timeout' ? `${label} took longer than ${Math.round(ms / 1000)} s` : `${label}: ${kind}`)
    this.kind = kind
    this.label = label
    this.ms = ms
  }
}
export const isStop = (e) => e instanceof StepError && (e.kind === 'cancel' || e.kind === 'retry')
const stopOf = (signal, label) => new StepError(signal?.reason === 'retry' ? 'retry' : 'cancel', label)

// work (a promise, or a function returning one) within ms; an aborted signal ends the wait at once. The work itself
// may go on in the background (a Playwright call keeps its own timeout): only the waiting stops.
export function bounded(work, ms, { signal, label = 'step' } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopOf(signal, label))
    let settled = false
    const timer = Number.isFinite(ms) && ms > 0 ? setTimeout(() => done(reject, new StepError('timeout', label, ms)), ms) : null
    const onAbort = () => done(reject, stopOf(signal, label))
    function done(fn, v) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(v)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let p
    try { p = typeof work === 'function' ? work() : work } catch (e) { return done(reject, e) }
    Promise.resolve(p).then((v) => done(resolve, v), (e) => done(reject, e))
  })
}

// a pause that a cancel or a retry ends early
export function pause(ms, signal) {
  return bounded(() => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() }), Infinity, { signal, label: 'pause' })
}

// Opens url without waiting for the page to go quiet: the response has to start within the limit (waitUntil
// 'commit'), then the document is given what is left of it (DOMContentLoaded), then at most settleMs for 'load'.
// A page still loading after that is stopped (window.stop) and read as it is.
// → { ok, partial, ms, error }: ok when the page is there (partial: it never finished loading); error when it never came.
export async function navigate(page, url, { timeoutMs = STEP.navMs, settleMs = STEP.settleMs, signal } = {}) {
  const t0 = Date.now()
  let committed = false
  let error = null
  try {
    await bounded(page.goto(url, { waitUntil: 'commit', timeout: timeoutMs }), timeoutMs + 1000, { signal, label: 'open' })
    committed = true
    const left = Math.max(1000, timeoutMs - (Date.now() - t0))
    await bounded(page.waitForLoadState('domcontentloaded', { timeout: left }), left + 500, { signal, label: 'document' })
  } catch (e) {
    if (isStop(e)) throw e
    error = e
  }
  if (!error) {
    try { await bounded(page.waitForLoadState('load', { timeout: settleMs }), settleMs + 500, { signal, label: 'load' }) } catch (e) { if (isStop(e)) throw e }
  }
  // still loading — or a navigation that never got an answer, which would otherwise be left pending and make the
  // next one fail at once (net::ERR_ABORTED): stopped. What is there is what the agent gets.
  if (error) await stopLoading(page)
  const ms = Date.now() - t0
  if (committed) return { ok: true, partial: !!error, ms, error: '' }
  return { ok: false, partial: false, ms, error: String(error?.message || error || 'not opened').split('\n')[0].slice(0, 160) }
}

// Stops what the page is loading, a navigation still waiting for its answer included: CDP Page.stopLoading needs nothing
// from the page itself (window.stop would wait for a document to run in); outside Chromium, window.stop.
export async function stopLoading(page) {
  try {
    const cdp = await bounded(page.context().newCDPSession(page), 2000)
    await bounded(cdp.send('Page.stopLoading'), 2000)
    cdp.detach().catch(() => {})
  } catch { await bounded(page.evaluate(() => window.stop()), 2000).catch(() => {}) }
}

// After a press: a short pause for the page to react and, when it started a navigation, the new document — bounded.
export async function settleAfter(page, { pauseMs = 500, docMs = 5000, signal } = {}) {
  await pause(pauseMs, signal)
  try { await bounded(page.waitForLoadState('domcontentloaded', { timeout: docMs }), docMs + 500, { signal, label: 'document' }) } catch (e) { if (isStop(e)) throw e }
}

// The agent's view of the page, run inside it (in one frame: lookAll below reads the frames on screen too). Bounded by itself (budgetMs of scanning) and capped (maxEls numbered
// elements, maxText characters): on a page of tens of thousands of nodes it stops early and says so (more.cut).
//  - numbers from an earlier look are taken off first, so a number never points at an element of an older look
//  - only elements on the screen are numbered; when there are more than maxEls, fields and buttons go before links
//  - the text is what is on the screen and the screen below it (scrolling shows the agent new text), not the top of
//    the document; the title and the page's own name (og:site_name / application-name) come along
//  - fields: whether a password or sign-in field is on screen (what the wall check reads besides the text)
export const SNAPSHOT_JS = (opts) => {
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

// Fields whose value must never reach the model, the live view or (a browser on the person's PC) the server.
export const SECRET_SELECTOR = 'input[type=password], [data-pro-secret], input[autocomplete^="cc-"], input[autocomplete="one-time-code"]'

// Whether element e is a secret field (the type gate: the model never types into one): run inside the page.
export const IS_SECRET_JS = (e, sel) => e.matches(sel) || /card.?(no|num)|cardnumber|cvc|cvv|csc|otp/i.test(`${e.name} ${e.id}`)

// The element an action is about, as the person would name it: a button by its text, a field by its
// label or placeholder (never its value), a secret field only by its kind. `what` is for the purchase gate.
export const DESCRIBE_JS = (e) => {
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
  // where a press goes: a link's address, or the address a submit control sends its form to
  const link = e.closest && e.closest('a[href]')
  const submits = (tag === 'button' && (e.type || 'submit') === 'submit') || (tag === 'input' && /^(submit|image)$/.test(e.type))
  // (a submit control's own formaction wins over its form's action — the button's formAction property gives the one that applies)
  const to = link ? link.href : submits && e.form ? (e.formAction || e.form.action) : ''
  return { name: name.length > 30 ? `${name.slice(0, 29)}…` : name, field: !!field && !button, secret, what, ...(to ? { to: String(to).slice(0, 2000) } : {}) }
}

// The words on the page a wait looks for: its text, and what fields hold or show (a value typed in, a placeholder) —
// the model picks until_text from the snapshot, where a field shows itself by those (2026-11-24: waits for the
// placeholder 「어디로 떠나시나요?」 and for 「계룡시」 typed into a field each ran their full minute). A secret field's value is
// never among them (a browser on the person's PC sends these words to the server).
export const PAGE_WORDS_JS = () => {
  const b = document.body
  if (!b) return ''
  const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=password]):not([data-pro-secret]):not([autocomplete^="cc-"]):not([autocomplete="one-time-code"]),textarea:not([data-pro-secret]),select')].slice(0, 300)
    .map((e) => [e.tagName === 'SELECT' ? e.options[e.selectedIndex]?.text : e.value, e.placeholder, e.getAttribute('aria-label')].filter(Boolean).join(' '))
  return `${b.innerText}\n${fields.join('\n')}`
}

// The agent's view of a page and of the frames on its screen (a map's result list, a booking form, a sign-in box are
// often an iframe — 2026-11-24: the agent pressed 「주변 키워드 더보기」 six times on a map whose results it could not see).
// Elements are numbered across frames; snap.frameOf (not part of the JSON the model reads) says which frame holds a
// number. A frame that does not answer within its share of the limit is left out, never waited on.
export async function lookAll(page, { maxEls = 120, maxText = 3000, budgetMs = 1500, timeoutMs = STEP.snapMs, view = { width: 1280, height: 800 } } = {}) {
  const t0 = Date.now()
  const left = () => timeoutMs - (Date.now() - t0)
  const main = await bounded(page.evaluate(SNAPSHOT_JS, { maxEls, maxText, budgetMs }), timeoutMs).catch(() => null)
  if (!main) return null
  const frameOf = new Map()
  let n = main.els.length
  const extra = []
  for (const f of page.frames()) {
    if (f === page.mainFrame() || n >= maxEls || left() < 500 || f.isDetached()) continue
    const box = await bounded(async () => (await f.frameElement()).boundingBox(), Math.min(1000, left())).catch(() => null)
    // frames on screen that are big enough to hold content (not trackers, not a 1×1 pixel)
    if (!box || box.width < 120 || box.height < 60 || box.y >= view.height || box.y + box.height <= 0 || box.x >= view.width || box.x + box.width <= 0) continue
    const sub = await bounded(f.evaluate(SNAPSHOT_JS, { maxEls: maxEls - n, maxText: Math.max(500, Math.floor(maxText / 2)), budgetMs: Math.min(budgetMs, 800), base: n }), Math.min(3000, left())).catch(() => null)
    if (!sub || (!sub.els.length && !sub.text)) continue
    for (const e of sub.els) frameOf.set(e.i, f)
    main.els.push(...sub.els)
    n += sub.els.length
    main.fields = { password: main.fields.password || sub.fields.password, signIn: main.fields.signIn || sub.fields.signIn }
    let host = ''
    try { host = new URL(sub.url).host } catch { /* about:blank, srcdoc */ }
    if (sub.text) extra.push(`[frame${host ? ` ${host}` : ''}]\n${sub.text}`)
  }
  if (extra.length) main.text = [main.text, ...extra].join('\n').slice(0, maxText + 1500)
  Object.defineProperty(main, 'frameOf', { value: frameOf, enumerable: false })
  return main
}

// Nothing moved for stallMs: onStall({ what, kind, since }) once, onResume() when something moves again.
//   beat(kind, what) — a new phase started (progress): the clock starts again
//   label(what)      — the same phase says more about itself (a wait counting up): the clock goes on
//   hold() / go()    — waiting on the person is not a stall (its card asks them already)
export function watchdog({ stallMs = STEP.stallMs, onStall, onResume, every = 1000, now = Date.now } = {}) {
  let kind = null, what = '', since = now(), stalled = false, held = false
  const check = () => {
    if (!kind || held || stalled) return false
    if (now() - since < stallMs) return false
    stalled = true
    onStall?.({ kind, what, since })
    return true
  }
  const resume = () => { if (stalled) { stalled = false; onResume?.() } }
  const timer = every ? setInterval(check, every) : null
  timer?.unref?.()
  return {
    beat(k, w = '') { kind = k; what = w; since = now(); resume() },
    label(w) { what = w },
    hold() { held = true; resume() },
    go(k, w) { held = false; if (k) this.beat(k, w); else since = now() },
    check,
    get state() { return { kind, what, since, stalled, held } },
    stop() { clearInterval(timer); kind = null },
  }
}

// The live view from a CDP screencast, at most one frame per minMs: Chromium sends the next frame only after the last
// one is acknowledged, so holding the acknowledgement holds the rate (and the work of encoding frames nobody needs).
export function throttledScreencast(cdp, { minMs = 333, onFrame } = {}) {
  let last = 0
  let held = null
  cdp.on('Page.screencastFrame', (f) => {
    const wait = Math.max(0, last + minMs - Date.now())
    const deliver = () => {
      held = null
      last = Date.now()
      try { onFrame?.(f) } catch { /* a viewer's trouble is not the page's */ }
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    }
    if (!wait) return deliver()
    clearTimeout(held)
    held = setTimeout(deliver, wait)
    held.unref?.()
  })
  return { stop: () => clearTimeout(held) }
}

// ---- the profile lock: a Chromium of this server's own that stopped answering must not keep the profile ----

// The Chromium named in a profile's lock link (<host>-<pid>): { host, pid, here, alive } or null without a lock.
export function lockHolder(dir) {
  let link = ''
  try { link = fs.readlinkSync(path.join(dir, 'SingletonLock')) } catch { return null }
  const m = /^(.+)-(\d+)$/.exec(link)
  if (!m) return { host: '', pid: 0, here: false, alive: false }
  const pid = Number(m[2])
  const here = m[1] === os.hostname()
  return { host: m[1], pid, here, alive: here && alive(pid) }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
// a process's parent: /proc on Linux (the container has no ps), else ps
export function parentOf(pid) {
  try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+\S+\s+/, '').split(' ')[0]) || 0 } catch { /* not Linux */ }
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()) || 0 } catch { return 0 }
}

// A process's command line: /proc on Linux, else ps ('' when it cannot be read)
export function commandOf(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ') } catch { /* not Linux */ }
  try { return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim() } catch { return '' }
}
const onProfile = (cmd, dir) => cmd.includes(`--user-data-dir=${dir}`) && !/\s--type=/.test(cmd)
// The Chromium browser process running on profile dir (not its renderers), when it is a child of this process: the
// headless shell keeps no lock link to read it from.
export function browserPidFor(dir) {
  let list = []
  try { list = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map((d) => [Number(d), commandOf(d)]) } catch {
    try { list = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 << 20 }).split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), m[2]]) } catch { return 0 }
  }
  return list.find(([pid, cmd]) => onProfile(cmd, dir) && parentOf(pid) === process.pid)?.[0] || 0
}

// Frees a profile for the next launch: a Chromium holding it that is this server's own (its pid known — the session's —
// or a child of this process) is stopped; one any other program runs is left alone. The holder is the one the lock link
// names, else (the headless shell keeps no lock) the session's own Chromium if it still runs on this profile. Lock links
// left by a Chromium that is gone (another pod, a crash) are removed. → { stopped, kept, cleared }
export async function releaseProfile(dir, { pid: known = 0, waitMs = 3000 } = {}) {
  const h = lockHolder(dir)
  let stopped = 0
  const holder = h?.alive ? h.pid : known && alive(known) && onProfile(commandOf(known), dir) ? known : 0
  if (holder) {
    const ours = holder !== process.pid && ((known && holder === known) || parentOf(holder) === process.pid)
    if (!ours) return { stopped: 0, kept: holder, cleared: [] }
    try { process.kill(holder, 'SIGKILL') } catch { /* gone meanwhile */ }
    stopped = holder
    const end = Date.now() + waitMs
    while (alive(holder) && parentOf(holder) !== 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  }
  const cleared = []
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(dir, f)); cleared.push(f) } catch { /* not there */ }
  }
  return { stopped, kept: 0, cleared }
}
