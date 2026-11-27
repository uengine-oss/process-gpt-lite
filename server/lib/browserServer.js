// The page driver for this server's own Chromium (Playwright): one persistent profile per person, the live view by CDP
// screencast, secret fields masked on screen and in the model's pictures, logins typed during takeover reported for the
// vault. lib/browser.js — the agent loop: model, judge, vault, skills, cards — drives a page only through a driver, this
// one or lib/browserRemote.js (a browser on the person's own PC, over their desktop's link). Both have the same small set
// of operations (navigate · look · describe · isSecret · box · click · fill · fillSecret · press · scroll · shot · frameShot ·
// words · text · stop · attach · input · healthy · closeOtherTabs · close); test/browserDriver.test.js runs one suite
// against both.
//
// A driver does not know about tasks: what it sees on its own (a live frame, a download, a login typed by the person, the
// work moving to a new tab) goes to the hooks it was given — on.frame(d, data, url), on.download(d, {name, read}),
// on.wantsDownload(d), on.capture(d, payload), on.moved(d, host).
//
// It never signs in to this app (lib/signInSteps.js: the auth server's sign-in steps, Lite's sign-in API and the sign-in screens):
// such a request — the agent's own goto, a link, a hop of a redirect, a new tab, a frame of another site, a page's own fetch, the
// person's takeover — is refused before it is sent, in every tab of this browser (guardSignIn).
import { chromium } from 'playwright'
import { signInPlaces, isSignInStep, stepPatterns } from './signInSteps.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { STEP, navigate, settleAfter, lookAll, throttledScreencast, releaseProfile, lockHolder, browserPidFor, pause,
  SECRET_SELECTOR, IS_SECRET_JS, DESCRIBE_JS, PAGE_WORDS_JS } from './browserSteps.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// Where the profiles (and so the sign-ins people made in them) live: PRO_BROWSER_PROFILES, else the
// data volume when there is one (production mounts an empty PVC at /data — a profile inside the
// container is lost on every deploy), else next to the server.
export function profilesDir(env = process.env, data = '/data') {
  if (env.PRO_BROWSER_PROFILES) return path.resolve(env.PRO_BROWSER_PROFILES)
  try {
    if (fs.statSync(data).isDirectory()) { fs.accessSync(data, fs.constants.W_OK); return path.join(data, 'browser-profiles') }
  } catch { /* no data volume here */ }
  return path.join(here, '..', '.browser-profiles')
}
export const PROFILES = profilesDir()
try { fs.mkdirSync(PROFILES, { recursive: true }) } catch (e) { console.warn('[browser] profiles', PROFILES, e.message) }

export const VIEW = { width: 1280, height: 800 }
// the data volume is shared with other features: Chromium's cache stays small
export const LAUNCH_ARGS = ['--disk-cache-size=52428800']
// The live view: at most this many frames a second (PRO_BROWSER_LIVE_FPS, default 3). An animated page made Chromium
// encode up to 9 frames a second at 1280×800 for every viewer (≈ 0.9 MB/s; 2026-11-24 measurement) — on a phone's
// connection, and on a pod with 2 CPUs shared with the page itself.
export const LIVE = { minMs: Math.round(1000 / Math.max(0.5, Number(process.env.PRO_BROWSER_LIVE_FPS) || 3)), width: 1024, height: 640 }
// The agent's view of the page (lib/browserSteps.js SNAPSHOT_JS: 120 elements, 3000 characters, 1.5 s of scanning)
export const SNAP_OPTS = { maxEls: 120, maxText: 3000, budgetMs: 1500 }

// Runs in every page: masks secret fields on screen and reports logins/cards the user submits
// (during takeover) so the server can seal them into the vault. Values the vault itself filled
// are remembered on the element and not reported back.
const PAGE_GUARD = () => {
  const css = () => {
    const root = document.head || document.documentElement
    if (!root || document.getElementById('__pro_guard')) return // too early: DOMContentLoaded adds it
    const st = document.createElement('style')
    st.id = '__pro_guard'
    st.textContent = '[data-pro-secret],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]{-webkit-text-security:disc!important}'
    root.appendChild(st)
  }
  document.addEventListener('DOMContentLoaded', css)
  css()
  const typed = (el) => el && el.value && el.value !== el.__proFilled
  const field = (scope, test) => [...scope.querySelectorAll('input')].find(test)
  let last = ''
  const report = (scope) => {
    if (typeof window.__proVaultCapture !== 'function') return
    const pw = field(scope, (e) => e.type === 'password' && e.value)
    const cc = field(scope, (e) => /cc-number/.test(e.autocomplete) || /card.?(no|num)|cardnumber/i.test(e.name || e.id))
    let payload = null
    if (pw && typed(pw)) {
      const user = [...scope.querySelectorAll('input')].filter((e) => /^(text|email|tel)$/.test(e.type) && e.value && !/search/i.test(e.name || ''))
        .find((e) => /user|email|login|id|account/i.test(`${e.name} ${e.id} ${e.autocomplete}`)) ||
        [...scope.querySelectorAll('input')].find((e) => /^(text|email|tel)$/.test(e.type) && e.value)
      payload = { kind: 'login', host: location.hostname, username: user ? user.value : '', password: pw.value }
    } else if (cc && typed(cc)) {
      const v = (test) => (field(scope, test) || {}).value || ''
      payload = { kind: 'card', host: location.hostname, number: cc.value,
        exp: v((e) => /cc-exp$/.test(e.autocomplete) || /exp/i.test(e.name || e.id)),
        cvv: v((e) => /cc-csc/.test(e.autocomplete) || /cvc|cvv|csc/i.test(e.name || e.id)),
        name: v((e) => /cc-name/.test(e.autocomplete) || /holder|cardname/i.test(e.name || e.id)) }
    }
    if (!payload) return
    const key = JSON.stringify(payload)
    if (key === last) return
    last = key
    window.__proVaultCapture(payload)
  }
  const scopeOf = (el) => (el && el.closest && el.closest('form')) || document
  document.addEventListener('submit', (e) => report(e.target), true)
  document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button,[type=submit],[role=button]'); if (b) report(scopeOf(b)) }, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') report(scopeOf(e.target)) }, true)
}

// A page busy with its own scripts must not hold a task for minutes: every look at it has a limit.
export const within = (p, ms, fallback) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r(fallback), ms).unref?.())]).catch(() => fallback)

// a page that does not answer in time (a script holding it) reads as empty, and says so
export const blankOf = (url) => ({ title: '', url, text: '', els: [], more: { unread: true } })
// the agent's view of any Playwright page (the live wall check, test/browser-walls.live.mjs)
export const lookAt = (page) => within(lookAll(page, { ...SNAP_OPTS, timeoutMs: STEP.snapMs, view: VIEW }), STEP.snapMs + 1000, null).then((x) => x || blankOf(page.url()))

export class ServerDriver {
  // on: { frame, download, wantsDownload, capture, moved } (see the top of this file)
  constructor(userId, on = {}) {
    this.kind = 'server'
    this.userId = userId
    this.on = on
    this.ctx = null
    this.page = null
    this.cdp = null
    this.pid = 0
    this.frameOf = new Map() // the last look: element number → the frame that holds it
    this.dialogs = [] // a page's alert · confirm · prompt since the last look (answered at once: dismissed, a beforeunload accepted)
    this.refused = [] // ways into this app's sign-in refused since the last look (guardSignIn)
    this.refusals = 0
  }

  static async open(userId, on) {
    const d = new ServerDriver(userId, on)
    await d.launch()
    return d
  }

  get closed() { return !this.ctx || !!this.ctx._closed }
  get tab() { return this.page } // changes when the work moves to another tab
  get dir() { return path.join(PROFILES, this.userId) }
  url() { return this.page?.url() || '' }
  viewport() { return this.page?.viewportSize() || VIEW }
  async title() { return this.page.title().catch(() => '') }

  // Chromium on the person's profile. The profile is freed first: lock links a Chromium that is gone left behind (another
  // pod, a crash), and a Chromium of this server's own that stopped answering (lib/browserSteps.js releaseProfile). A launch
  // that fails is tried once more after freeing it again.
  async launch() {
    const dir = this.dir
    fs.mkdirSync(dir, { recursive: true })
    const freed = await releaseProfile(dir, { pid: this.pid })
    if (freed.stopped || freed.cleared.length) console.log('[browser] freed the profile', this.userId, freed.stopped ? `stopped ${freed.stopped}` : '', freed.cleared.join(','))
    const options = { headless: true, viewport: VIEW, locale: 'ko-KR', args: LAUNCH_ARGS, timeout: STEP.launchMs }
    let ctx
    try { ctx = await chromium.launchPersistentContext(dir, options) } catch (e) {
      console.warn('[browser] launch failed, once more:', String(e.message).split('\n')[0])
      await releaseProfile(dir)
      ctx = await chromium.launchPersistentContext(dir, options)
    }
    ctx.on('close', () => { ctx._closed = true })
    // (before any page loads: a browser whose guard cannot be turned on is not used)
    this.places = signInPlaces()
    try { await this.guardSignIn(ctx) } catch (e) {
      console.warn(`[browser] ${e.message} — the browser of ${this.userId} is closed`)
      await within(ctx.close(), 5000, null)
      throw e
    }
    this.ctx = ctx
    // the Chromium this driver runs (its lock link names it, else its command line): stopped by releaseProfile should it
    // stop answering and not close
    this.pid = lockHolder(dir)?.pid || browserPidFor(dir)
    await ctx.addInitScript(PAGE_GUARD)
    await ctx.exposeBinding('__proVaultCapture', (_src, payload) => Promise.resolve(this.on.capture?.(this, payload)).catch((e) => console.warn('[vault capture]', e.message)))
    const watchDownloads = (page) => {
      page.on('download', (d) => this.download(d, page).catch((e) => console.warn('[browser] download', e.message)))
      // (as Playwright does by itself — dismissed — and the agent's next look says what it said: the same on the person's PC)
      page.on('dialog', (d) => {
        this.dialogs.push(`${d.type()}: ${String(d.message() || '').slice(0, 200)}`)
        if (this.dialogs.length > 5) this.dialogs.shift()
        ;(d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {})
      })
    }
    // a link that opens a new tab, a sign-in popup: the work (and the live view) moves there, and back when it closes
    this.page = null
    ctx.on('page', (p) => { watchDownloads(p); if (this.page && this.ctx === ctx) this.follow(p).catch((e) => console.warn('[browser] new page', e.message)) })
    this.page = ctx.pages()[0] || await ctx.newPage()
    watchDownloads(this.page)
    await within(this.page.evaluate(PAGE_GUARD), 3000, null)
    await within(this.live(), 5000, null)
    return this
  }

  // This browser never signs in to this app (lib/signInSteps.js). One CDP session on the browser itself turns on Fetch for the whole
  // browser — every tab and every frame, from its first request: a new tab, a popup, a frame of another site in a process of its own —
  // pausing only page loads (documents: a page, a frame, each hop of a redirect) and requests under /auth/v1/ and /api/auth/ on the
  // auth server's and this app's hosts; those that are a way into the sign-in are refused (net::ERR_BLOCKED_BY_CLIENT), the rest go on
  // as they were. Every other request is never paused, and the HTTP cache works as it does without it (a Playwright route would take
  // every request through this process and turn the cache off). The next look says what was refused. When it cannot be turned on,
  // the browser is not used (launch).
  async guardSignIn(ctx) {
    const patterns = stepPatterns(this.places)
    if (!patterns.length) return
    const cdp = await within(ctx.browser()?.newBrowserCDPSession(), 5000, null)
    if (!cdp) throw new Error('the sign-in guard could not be turned on (no session on the browser)')
    cdp.on('Fetch.requestPaused', (e) => {
      const url = e.request?.url || ''
      if (!isSignInStep(url, this.places, { document: e.resourceType === 'Document' })) return cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {})
      this.refuse(url)
      cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
    })
    if (!await within(cdp.send('Fetch.enable', { patterns }).then(() => true), 5000, false)) throw new Error('the sign-in guard could not be turned on')
  }
  // (only where it was — host and path — is said and logged: never the query)
  refuse(url) {
    let where = ''
    try { const u = new URL(url); where = `${u.host}${u.pathname}` } catch { /* not an address */ }
    this.refusals++
    this.refused.push(where)
    if (this.refused.length > 5) this.refused.shift()
    console.warn(`[browser] refused (a way into this app's own sign-in): ${where}`)
  }

  // The same driver on a new Chromium: the old one is closed (stopped, when closing hangs) and the profile freed.
  async relaunch(why) {
    console.warn(`[browser] restarting the browser of ${this.userId}: ${why}`)
    const old = this.ctx
    this.cdp = null
    if (old && !old._closed) { old._closed = true; await within(old.close(), 5000, null) }
    await this.launch()
    return this
  }

  // A file the page downloads: kept by the hooks (lib/browser.js keepDownload) while a task holds the browser, else dropped.
  async download(d, from) {
    try {
      if (!this.on.wantsDownload?.(this)) return await d.cancel().catch(() => {})
      await this.on.download?.(this, { name: d.suggestedFilename(), read: async () => fs.promises.readFile(await d.path()) })
    } finally { await this.dropDownloadTabs(from) }
  }

  // A link that downloads into a new tab leaves that tab with no page of its own (the download is the opener's);
  // Chrome closes it. Kept open, the work and the live view stayed on a blank tab, and the finished card had no
  // last screen to show (2026-11-22, NotebookLM audio overview). Once the file is kept, the tabs this page opened
  // that never got a page close, and follow() goes back.
  async dropDownloadTabs(from) {
    for (const p of this.closed ? [] : this.ctx.pages()) {
      if (p === from || p.isClosed() || (p.url() && p.url() !== 'about:blank')) continue
      if ((await p.opener().catch(() => null)) === from) await p.close().catch(() => {})
    }
  }

  async follow(p) {
    if (p === this.page || p.isClosed()) return
    const from = this.page
    p.once('close', () => {
      if (this.page !== p || this.closed) return
      const back = !from.isClosed() ? from : this.ctx.pages().filter((x) => !x.isClosed()).at(-1)
      if (back) this.use(back).catch((e) => console.warn('[browser] back to page', e.message))
    })
    await this.use(p)
    await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
  }

  async use(p) {
    this.page = p
    await p.bringToFront().catch(() => {})
    const old = this.cdp
    this.cdp = null
    await within(old?.send('Page.stopScreencast'), 2000, null)
    await within(old?.detach(), 2000, null)
    // (a tab that has only just opened may not take it yet: once more a moment later)
    const live = () => this.live().then(() => true)
    const ok = await within(live().catch(() => false), 5000, false) || (this.page === p && await within(new Promise((r) => setTimeout(r, 300)).then(live).catch((e) => { console.warn('[browser] screencast', e.message); return false }), 5000, false))
    if (!ok && this.page === p) console.warn('[browser] no live view for this tab')
    this.on.moved?.(this, hostOf(p.url()))
  }

  // The live view: CDP screencast frames, at most one per LIVE.minMs (lib/browserSteps.js throttledScreencast), to
  // whoever watches (lib/bus.js drops frames for a viewer whose connection has not taken the last ones yet).
  async live() {
    const page = this.page
    const cdp = await this.ctx.newCDPSession(page)
    this.cdp = cdp
    throttledScreencast(cdp, {
      minMs: LIVE.minMs,
      onFrame: (f) => { if (this.page === page && this.cdp === cdp) this.on.frame?.(this, f.data, page.url()) },
    })
    // 1024×640 at quality 50: half the bytes of 1280×800 at 60 (≈100 KB a frame on a map page, 2026-11-24), the same 16:10 —
    // the card and the full view never show it wider than 1024, and takeover clicks are fractions of it
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: LIVE.width, maxHeight: LIVE.height, everyNthFrame: 1 })
  }

  // Before a task drives the browser: the page has to answer (a renderer stuck in a page's script does not, and every
  // look at it would run out its limit). Else a fresh tab; else a fresh browser on the same profile.
  async healthy() {
    const answers = (p) => within(p.evaluate(() => 1).then(() => true), 3000, false)
    if (this.closed) return this.relaunch('the browser closed')
    if (await answers(this.page)) return this
    // the stuck renderer is ended first (CDP Page.crash runs on its IO thread, which a looping script does not hold):
    // a new tab of the same site would otherwise be put in that same process and be stuck as well
    const old = this.page // (before the new tab: following it, follow() makes it this.page as soon as it opens)
    const cdp = this.cdp || await within(this.ctx.newCDPSession(old), 2000, null)
    await within(cdp?.send('Page.crash'), 2000, null)
    const p = await within(this.ctx.newPage(), 5000, null)
    if (p && await answers(p)) {
      if (this.page !== p) await this.use(p)
      old.close().catch(() => {}) // (a stuck page may never confirm it closed)
      console.warn('[browser] the page stopped answering: going on in a fresh tab', this.userId)
      return this
    }
    return this.relaunch('the page stopped answering')
  }

  // After a task: tabs it left open (links that opened new tabs, popups) close, all but the one it ended on —
  // each one is a renderer holding memory in a pod with a memory limit.
  async closeOtherTabs() {
    if (this.closed) return
    for (const p of this.ctx.pages()) if (p !== this.page && !p.isClosed()) await within(p.close(), 3000, null)
  }

  // ---- the page ----
  // (a load that was a way into this app's sign-in — the address itself or a hop on the way — says so: guardSignIn)
  async navigate(url, { signal } = {}) {
    const before = this.refusals
    const r = await navigate(this.page, url, { signal })
    if (!r.ok && this.refusals > before) {
      r.error = 'refused: this browser does not sign in to this app (its sign-in pages and steps are not opened)'
      // (the refusal's own page comes a moment later: the next load must not be cut off by it)
      await this.page.waitForURL((u) => u.protocol === 'chrome-error:', { waitUntil: 'commit', timeout: 1000 }).catch(() => {})
    }
    return r
  }
  async look() {
    const snap = await lookAt(this.page)
    this.frameOf = snap.frameOf || new Map()
    const said = this.dialogs.splice(0)
    if (said.length) snap.text = `${snap.text || ''}\n${said.map((d) => `[dialog] ${d}`).join('\n')}`
    const refused = [...new Set(this.refused.splice(0))]
    if (refused.length) snap.text = `${snap.text || ''}\n${refused.map((r) => `[not opened] ${r} — a way into this app's own sign-in, which this browser does not take`).join('\n')}`
    return snap
  }
  // the element numbered i in the last look, in whichever frame holds it
  el(i) { return (this.frameOf.get(Number(i)) || this.page).locator(`[data-pro-idx="${i}"]`).first() }
  // what an element is (DESCRIBE_JS) — {} when it does not answer in time, null with strict when it is gone
  async describe(i, { strict = false, ms = 1500 } = {}) {
    const p = this.el(i).evaluate(DESCRIBE_JS, undefined, { timeout: ms })
    return strict ? p.catch(() => null) : within(p, ms + 1000, {})
  }
  async isSecret(i) { return this.el(i).evaluate(IS_SECRET_JS, SECRET_SELECTOR, { timeout: 3000 }) }
  // Where element i is, in page pixels of the live view (scrolled into view first, as the click itself would) → {x, y, w, h}
  async box(i) {
    const loc = this.el(i)
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 })
    const b = await loc.boundingBox({ timeout: 2000 })
    if (!b) return null
    const { width: w, height: h } = this.viewport()
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), w, h }
  }
  // After a press: a short pause for the page to react, and the new page's load when it navigated (bounded)
  settle(signal) { return settleAfter(this.page, { pauseMs: 500, docMs: 5000, signal }) }
  async click(i, { signal } = {}) {
    await this.el(i).click({ timeout: 8000 })
    await this.settle(signal)
  }
  async fill(i, text, { enter = false, signal } = {}) {
    await this.el(i).fill(text, { timeout: 8000 })
    if (enter) { await this.el(i).press('Enter', { timeout: 8000 }); await this.settle(signal) }
  }
  // a vault value into the page: the element remembers it (so the page guard does not "capture" it back) and is masked.
  // keys: typed key by key as a person types (masked first; 40–100 ms between keys) — sign-in pages that read the keys
  // their fields get (lib/browser.js typeSecret)
  async fillSecret(i, value, { keys = false, signal } = {}) {
    const loc = this.el(i)
    const v = String(value)
    if (!keys) {
      await loc.fill(v)
      await loc.evaluate((e, x) => { e.__proFilled = x; e.setAttribute('data-pro-secret', '') }, v)
      return
    }
    await loc.evaluate((e, x) => { e.__proFilled = x; e.setAttribute('data-pro-secret', '') }, v, { timeout: 3000 })
    await loc.fill('', { timeout: 5000 })
    for (const ch of v) {
      await loc.pressSequentially(ch, { timeout: 5000 })
      await pause(40 + Math.floor(Math.random() * 60), signal)
    }
  }
  // a key on element i (Enter sends a sign-in form), then the page's answer (bounded)
  async press(i, key, { signal } = {}) {
    await this.el(i).press(key, { timeout: 5000 })
    await this.settle(signal)
  }
  // the wheel turns what is under the pointer: over the element given (its list, its frame), else the middle of the page
  async scroll(i, dy, { signal } = {}) {
    const box = i != null && i !== '' ? await within(this.el(i).boundingBox({ timeout: 1500 }), 2500, null) : null
    const { width, height } = this.viewport()
    await this.page.mouse.move(box ? box.x + box.width / 2 : width / 2, box ? box.y + box.height / 2 : height / 2)
    await this.page.mouse.wheel(0, dy)
    await pause(300, signal) // (the page scrolls a moment after the wheel: the next look sees where it went)
  }
  // the model's picture: secret fields painted over
  async shot() {
    return this.page.screenshot({ type: 'jpeg', quality: 50, mask: [this.page.locator(SECRET_SELECTOR)], maskColor: '#1d1d1f', timeout: STEP.shotMs }).catch(() => null)
  }
  // the live view's picture now (base64), or null
  async frameShot() {
    const shot = await this.page.screenshot({ type: 'jpeg', quality: 55, timeout: STEP.shotMs }).catch(() => null)
    return shot ? shot.toString('base64') : null
  }
  words() { return within(this.page.evaluate(PAGE_WORDS_JS), 5000, null) }
  text() { return within(this.page.evaluate(() => document.body.innerText.slice(0, 6000)), STEP.snapMs, '') }
  stop() { return within(this.page.evaluate(() => window.stop()), 2000, null) }
  // the page on screen as a PDF, as the site prints it (this browser is headless Chromium, which prints; the page is the person's
  // signed-in one) — bounded like an action
  pdf() { return within(this.page.pdf({ format: 'A4', printBackground: true }), STEP.actMs, null) }
  // a file (a path on this machine) into a file field, or through the file picker the control opens
  async attach(i, file) {
    if (await this.el(i).evaluate((e) => e.tagName === 'INPUT' && e.type === 'file', undefined, { timeout: 3000 })) { await this.el(i).setInputFiles(file); return }
    const [chooser] = await Promise.all([this.page.waitForEvent('filechooser', { timeout: 8000 }), this.el(i).click({ timeout: 8000 })])
    await chooser.setFiles(file)
  }
  // Takeover: raw input forwarded from the live view (coords are 0..1 of the viewport).
  async input(ev) {
    const { width, height } = this.viewport()
    if (ev.type === 'click') await this.page.mouse.click(ev.x * width, ev.y * height)
    if (ev.type === 'key') await this.page.keyboard.press(ev.key)
    if (ev.type === 'text') await this.page.keyboard.type(ev.text)
    if (ev.type === 'scroll') await this.page.mouse.wheel(0, ev.dy)
  }
  addCookies(list) { return this.ctx.addCookies(list) }
  // Closes the browser (the profile stays on disk); a Chromium that does not close (stuck) is stopped, so the profile opens
  // again next time
  async close() {
    if (!this.ctx) return
    const closed = await within(this.ctx.close().then(() => true), 5000, false)
    if (!closed) await releaseProfile(this.dir, { pid: this.pid })
  }
}

export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return String(u || '').slice(0, 60) } }