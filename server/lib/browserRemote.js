// The page driver for a browser on the person's own PC (desktop app 0.2.3+, desktop/src/browser): the same operations as this
// server's own Chromium (lib/browserServer.js ServerDriver), each one a call over the person's desktop link
// (lib/localAgents/browserLink.js). lib/browser.js keeps the agent loop — model, judge, vault, skills, cards — and swaps only this.
//
// Where a task runs (routeOf / routeFor) — the person's consent is each PC's own setting, kept by the desktop app with its other
// runner settings and sent with its link (prefs.browser; 2026-11-25 review decision):
//   · 'own' (unset — the default): the person's own tasks, the ones they asked for in their own chat, run in that PC's browser
//   · 'all': also tasks nobody watches (a process step, a scheduled or agent's run) — they can reach that PC's sign-ins, so only when
//     the person turned this on; even then not that PC's own network (localhost, 10/8, 192.168/16 …: desktop host.js begin noPrivate)
//   · 'off', or 「이 컴퓨터에서 단계 실행」 off (prefs.enabled false): never that PC
//   · a task that starts on a page of this Lite server itself (a share page, a preview Lite showed): this server — the PC's agent
//     browser does not open the Lite it is linked to (desktop/src/policy.js agentMay; lib/liteOwn.js liteOwnPage)
//   · a desktop older than 0.2.6 (no caps.browserGuard — its browser neither keeps off the Lite app nor marks its requests): this server
// Else this server, as before (phones only, an older desktop). Decided when a task gets the browser; a task never moves by itself after
// that — a PC that goes off pauses it and the person chooses (lib/browser.js whenOffline).
//
// Secrets: a vault value goes to the desktop only for one fill, only over the link this task runs on — which is the task's own
// person's (checked at open and at each fill) — and the desktop types it into the field without keeping or logging it. What the
// desktop sends back is masked there first: secret fields blank in the look, painted over in the model's picture, dots in the live
// view (desktop/src/browser/pageScripts.js). Logins typed on the PC stay there (its browser profile); none is captured to the vault.
import fs from 'node:fs'
import path from 'node:path'
import { STEP, pause } from './browserSteps.js'
import { LIVE, VIEW, SNAP_OPTS, blankOf, hostOf } from './browserServer.js'
import * as BL from './localAgents/browserLink.js'
import * as H from './localAgents/hub.js'
import { liteOwnPage } from './liteOwn.js'
import { config } from '../config.js'

export const LinkLost = BL.LinkLost
// the oldest desktop that runs browser tasks (said where a newer one is needed): 0.2.6 — its browser keeps off the Lite app and marks
// its requests (caps.browserGuard); an older one's browser does neither, and its tasks run here
export const MIN_DESKTOP = '0.2.6'
// a desktop link whose browser may take a task
export const browsesHere = (link) => !!link?.caps?.browser && !!link?.caps?.browserGuard

// ---- where a task runs ----
// links: the person's desktops' links now · own: the person's own task (asked for in their own chat), not one nobody watches
// → { kind: 'local', link } | { kind: 'server', why: 'no-desktop' | 'old-desktop' | 'off' | 'not-own' }
// An address on the PC's own network, by its name or number — the desktop's rules (desktop/src/browser/host.js privateHost, a test
// compares them): localhost (and *.localhost), a name of one label (intranet), *.local · *.lan · *.internal · *.intranet · *.localdomain ·
// *.home.arpa, a trailing dot, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0/8, ::, ::1, fc00::/7, fe80::/10 and IPv4
// inside IPv6 (::ffff:7f00:1). A task nobody watches does not open these in a person's PC browser. A public name that resolves to such
// an address is the desktop's to catch (it resolves it there, with the PC's own resolver).
const NET_SUFFIX = /\.(localhost|local|lan|internal|intranet|localdomain|home\.arpa)$/
const privateV4 = (a, b) => a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
function privateIp(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) return privateV4(Number(m[1]), Number(m[2]))
  if (!h.includes(':')) return null
  if (h === '::' || h === '::1') return true
  if (/^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)) return true
  const v4 = /^::(?:ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]))
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (hex) { const hi = parseInt(hex[1], 16); return privateV4(hi >> 8, hi & 255) }
  return false
}
export function privateAddress(u) {
  let h
  try { h = new URL(String(u)).hostname.toLowerCase() } catch { return false }
  h = h.replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!h) return false
  const ip = privateIp(h)
  if (ip !== null) return ip
  return h === 'localhost' || !h.includes('.') || NET_SUFFIX.test(h)
}
export const prefOf = (link) => (link?.prefs?.enabled === false ? 'off' : ['off', 'own', 'all'].includes(link?.prefs?.browser) ? link.prefs.browser : 'own')

// (whether an address is a page of this Lite server itself: lib/liteOwn.js)
export { liteOwnPage } from './liteOwn.js'

// startUrl: where the task starts — a page of this Lite server keeps it on this server even when a PC would take it ('lite-page')
export function routeOf({ links = [], own = true, startUrl = '' } = {}) {
  if (!links.length) return { kind: 'server', why: 'no-desktop' }
  const able = links.filter(browsesHere).sort((a, b) => b.since - a.since)
  if (!able.length) return { kind: 'server', why: 'old-desktop' }
  const on = able.filter((l) => prefOf(l) !== 'off')
  if (!on.length) return { kind: 'server', why: 'off' }
  const ok = on.filter((l) => own || prefOf(l) === 'all')
  if (!ok.length) return { kind: 'server', why: 'not-own' }
  if (startUrl && liteOwnPage(startUrl)) return { kind: 'server', why: 'lite-page' }
  return { kind: 'local', link: ok[0] }
}
export async function routeFor(userId, { own = true, startUrl = '' } = {}) {
  return routeOf({ links: H.linksOf(config.tenantId, userId), own, startUrl })
}
// what the settings show, everywhere (web · phone · the app): each linked desktop's own setting, and where the person's own tasks and the
// ones nobody watches run now. Changed only on that PC (the app's settings), never from here.
export async function whereFor(user) {
  const links = H.linksOf(config.tenantId, user.id)
  const own = routeOf({ links, own: true })
  const unattended = routeOf({ links, own: false })
  return {
    own: { where: own.kind, why: own.why || null, device: own.link ? { id: own.link.id, name: own.link.name } : null },
    unattended: { where: unattended.kind, why: unattended.why || null, device: unattended.link ? { id: unattended.link.id, name: unattended.link.name } : null },
    devices: links.map((l) => ({ id: l.id, name: l.name, browser: browsesHere(l), pref: prefOf(l), enabled: l.prefs?.enabled !== false })),
    min: MIN_DESKTOP,
  }
}

export class RemoteDriver {
  // link: the person's desktop link (hub.js) · on: the same hooks as ServerDriver's, and lost(d) when the link closes
  constructor(link, userId, on = {}) {
    if (String(link.userId) !== String(userId)) throw new Error('a browser task runs only on its own person\'s desktop')
    this.kind = 'local'
    this.link = link
    this.userId = String(userId)
    this.device = { id: link.id, name: link.name }
    this.on = on
    this.lost = false
    this.holding = false
    this.cur = { url: '', title: '', vp: { ...VIEW }, tab: 0 }
  }

  // The desktop's browser for this person (made, or the one it has: a page it was on stays — a link that came back)
  static async open(link, userId, on) {
    const d = new RemoteDriver(link, userId, on)
    BL.bind(link, d)
    try {
      await d.call('open', { user: d.userId, live: LIVE, view: VIEW, snap: SNAP_OPTS,
        step: { navMs: STEP.navMs, settleMs: STEP.settleMs, snapMs: STEP.snapMs, shotMs: STEP.shotMs } }, { timeoutMs: STEP.launchMs })
    } catch (e) { BL.unbind(link, d); throw e }
    return d
  }

  get closed() { return this.lost }
  get tab() { return this.cur.tab }
  url() { return this.cur.url }
  viewport() { return this.cur.vp }
  async title() { return this.cur.title || '' }
  // where the page is now (every answer carries it; one from a browser with no tab — closing, an app going down — says nothing)
  at(a = {}) {
    if (!a || !a.tab) return
    if (typeof a.url === 'string') this.cur.url = a.url
    if (typeof a.title === 'string') this.cur.title = a.title
    if (a.vp?.width > 0 && a.vp?.height > 0) this.cur.vp = { width: a.vp.width | 0, height: a.vp.height | 0 }
    if (Number.isFinite(a.tab)) this.cur.tab = a.tab
    if (Number.isFinite(a.tabs)) this.cur.tabs = a.tabs
  }

  async call(op, args = {}, opts = {}) {
    if (this.lost) throw new LinkLost(this.device.name)
    // (the same person, always: a vault value never goes to anyone else's desktop)
    if (String(this.link.userId) !== this.userId) throw new Error('not this person\'s desktop')
    // (the PC says its browser is not open — the app going down, its windows gone before its link: as good as off. When the app is
    // still linked, the task finds it and opens the browser there again — lib/browser.js whenOffline)
    return BL.call(this.link, op, args, opts).catch((e) => { if (e.code === 'closed' && op !== 'open') { this.linkLost(); e.lost = true } throw e })
  }
  // a call whose failure is an answer (a look that came back empty), not an error — except the link going
  quiet(op, args, opts, fallback) { return this.call(op, args, opts).catch((e) => { if (e.lost) this.lost = true; return fallback }) }

  // ---- from the link ----
  onFrame(data, url) { if (url) this.cur.url = url; this.on.frame?.(this, data, url) }
  async onEvent(ev) {
    if (ev.kind === 'download') {
      if (!this.on.wantsDownload?.(this)) return
      const name = String(ev.name || 'download').slice(0, 200)
      await this.on.download?.(this, {
        name,
        read: async () => {
          if (ev.error) throw Object.assign(new Error(String(ev.error).slice(0, 100)), ev.status ? { status: ev.status } : {})
          return Buffer.from(String(ev.data || ''), 'base64')
        },
      })
      return
    }
    if (ev.kind === 'moved') { this.at(ev.at || {}); this.on.moved?.(this, hostOf(ev.at?.url || '')); return }
    if (ev.kind === 'navigated') { this.at(ev.at || {}); return }
    if (ev.kind === 'shown' || ev.kind === 'hidden') { this.on.shown?.(this, ev.kind === 'shown'); return }
  }
  linkLost() {
    if (this.lost) return
    this.lost = true
    this.holding = false
    this.on.lost?.(this)
  }

  // ---- the page (the same operations as ServerDriver) ----
  async healthy() { await this.call('healthy', {}, { timeoutMs: 15000 }); return this }
  // a task takes the PC's browser (noPrivate: one nobody watches — not that PC's own network) · gives it back (nothing more is sent, the
  // page is cleared)
  // (holding: a task holds the PC's browser — only then does the link take a long message in pieces from that PC: browserLink.js)
  begin({ noPrivate = false } = {}) { this.holding = true; return this.call('begin', { noPrivate: !!noPrivate }, { timeoutMs: 15000 }) }
  // keep: the task ended needing the person — the page stays for 「이 PC에서 보기」
  idle({ keep = false } = {}) { this.holding = false; return this.quiet('idle', { keep: !!keep }, { timeoutMs: 5000 }, null) }
  async closeOtherTabs() { await this.quiet('closeTabs', {}, { timeoutMs: 5000 }) }
  async navigate(url, { signal } = {}) {
    const t0 = Date.now()
    try {
      return await this.call('navigate', { url }, { timeoutMs: STEP.navMs + STEP.settleMs + 4000, signal })
    } catch (e) {
      if (e.lost || e.stopped) throw e
      return { ok: false, partial: false, ms: Date.now() - t0, error: String(e.message || e).split('\n')[0].slice(0, 160) }
    }
  }
  async look() {
    const snap = await this.quiet('look', {}, { timeoutMs: STEP.snapMs + 1500 }, null)
    return snap && Array.isArray(snap.els) ? snap : blankOf(this.cur.url)
  }
  async describe(i, { strict = false, ms = 1500 } = {}) {
    const v = await this.call('describe', { i, ms }, { timeoutMs: ms + 1500 }).catch((e) => { if (e.lost) this.lost = true; return null })
    return strict ? v : v || {}
  }
  isSecret(i) { return this.call('isSecret', { i }, { timeoutMs: 4000 }) }
  box(i) { return this.call('box', { i }, { timeoutMs: 5000 }) }
  click(i, { signal } = {}) { return this.call('click', { i }, { timeoutMs: STEP.actMs, signal }) }
  fill(i, text, { enter = false, signal } = {}) { return this.call('fill', { i, text: String(text ?? ''), enter: !!enter }, { timeoutMs: STEP.actMs, signal }) }
  // one vault value, for one fill, to this person's own PC: typed there (keys: key by key, as a person types), never kept or
  // logged (desktop/src/browser/host.js)
  fillSecret(i, value, { keys = false, signal } = {}) {
    const v = String(value)
    return this.call('fillSecret', { i, value: v, keys: !!keys }, { timeoutMs: 10000 + (keys ? v.length * 150 : 0), signal })
  }
  press(i, key, { signal } = {}) { return this.call('press', { i, key: String(key) }, { timeoutMs: STEP.actMs, signal }) }
  async scroll(i, dy, { signal } = {}) {
    await this.call('scroll', { i: i ?? null, dy }, { timeoutMs: 5000, signal })
    await pause(300, signal) // (the page scrolls a moment after the wheel: the next look sees where it went)
  }
  async shot() {
    const b64 = await this.quiet('shot', {}, { timeoutMs: STEP.shotMs + 2000 }, null)
    return typeof b64 === 'string' && b64 ? Buffer.from(b64, 'base64') : null
  }
  async frameShot() {
    const b64 = await this.quiet('frameShot', {}, { timeoutMs: STEP.shotMs + 2000 }, null)
    return typeof b64 === 'string' && b64 ? b64 : null
  }
  words() { return this.quiet('words', {}, { timeoutMs: 5000 }, null) }
  async text() { return String(await this.quiet('text', {}, { timeoutMs: STEP.snapMs }, '') || '') }
  stop() { return this.quiet('stop', {}, { timeoutMs: 2000 }, null) }
  // a file this server has (a path) into the page's file field on the PC: its bytes go over the link
  async attach(i, file, name = '') {
    const data = await fs.promises.readFile(file)
    return this.call('attach', { i, name: name || path.basename(file), data: data.toString('base64') }, { timeoutMs: 30000 })
  }
  input(ev) { return this.call('input', ev, { timeoutMs: 5000 }) }
  // 「이 PC에서 보기」: the browser's window on the PC, in front (hidden again with show(false))
  show(on = true) { return this.call('show', { on: !!on }, { timeoutMs: 5000 }) }
  async addCookies() { throw new Error('cookies are set only in this server\'s browser') }
  async close() {
    if (!this.lost) await this.quiet('close', {}, { timeoutMs: 5000 })
    BL.unbind(this.link, this)
  }
}
