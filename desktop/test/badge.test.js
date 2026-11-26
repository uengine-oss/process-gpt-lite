'use strict'
// The count of Home cards waiting, on the Dock · taskbar · tray (src/badge.js · src/tray.js — 2026-11-25 사용자: 「일렉트론 버전의
// 시스템 트레이에 알람 개수 뱃지 설치」). Without Electron:
//   · the count (clamped), the words of each system (the menu bar's number, the tooltip, the overlay's description, the menu)
//   · the badge drawn on raw pixels (BGRA premultiplied — what nativeImage.toBitmap gives): sizes, red where the badge is, the icon
//     left alone at 0 and outside the badge, 「9+」 from 10 on
//   · tray.js as macOS, Windows and Linux with a fake app · Tray · Menu · nativeImage · window
//   · the tray PNGs are there, at their sizes, and packed
// The real app (Electron) is e2e D-12 (e2e/tests/desktop/desktop.spec.js).
// Run: cd desktop && node --test test/badge.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const B = require('../src/badge')
const { createTrayBadge } = require('../src/tray')

const ROOT = path.join(__dirname, '..')
const TRAY_DIR = path.join(ROOT, 'resources', 'tray')

// ---------- pixels ----------
// an opaque dark square (the app icon's body #1d1d1f), BGRA
function icon(size, [r, g, b, a] = [0x1d, 0x1d, 0x1f, 255]) {
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < buf.length; i += 4) { buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a }
  return buf
}
const px = (buf, size, x, y) => { const i = (y * size + x) * 4; return { b: buf[i], g: buf[i + 1], r: buf[i + 2], a: buf[i + 3] } }
const isRed = (p) => p.a === 255 && p.r > 230 && p.g < 90 && p.b < 90
const isWhite = (p) => p.a === 255 && p.r === 255 && p.g === 255 && p.b === 255
function count(buf, size, pred, box = { x0: 0, y0: 0, x1: size, y1: size }) {
  let n = 0
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) if (pred(px(buf, size, x, y))) n++
  return n
}
const cells = (ch) => B.GLYPHS[ch].join('').split('').filter((c) => c === '1').length

test('the count: a whole number 0…9999 — whatever comes over IPC', () => {
  assert.deepEqual([3, 0, -1, 2.9, '7', '', 'x', null, undefined, NaN, true, Infinity, 1e9].map(B.clampCount), [3, 0, 0, 2, 7, 0, 0, 0, 0, 0, 1, 9999, 9999])
  assert.deepEqual([0, 1, 9, 10, 12, 9999].map(B.badgeLabel), ['', '1', '9', '9+', '9+', '9+'])
})

test('the words of each system: the menu bar number (macOS only), the tooltip, the overlay, the menu — Korean and English', () => {
  // macOS: a space, then the number; nothing at 0; 99+ past 99. Windows · Linux trays have no title
  assert.deepEqual([0, 3, 12, 99, 100].map((n) => B.trayTitle(n, 'darwin')), ['', ' 3', ' 12', ' 99', ' 99+'])
  for (const p of ['win32', 'linux']) assert.deepEqual([0, 3, 12].map((n) => B.trayTitle(n, p)), ['', '', ''])
  assert.equal(B.tooltip(0, 'ko'), 'Process GPT Lite')
  assert.equal(B.tooltip(3, 'ko'), 'Process GPT Lite — 알림 3개')
  assert.equal(B.tooltip(1, 'en'), 'Process GPT Lite — 1 notification')
  assert.equal(B.tooltip(12, 'en'), 'Process GPT Lite — 12 notifications')
  assert.equal(B.overlayText(3, 'ko'), '알림 3개')
  assert.equal(B.overlayText(0, 'ko'), '')
  assert.equal(B.overlayText(2, 'en'), '2 notifications')
  const labels = (n, l) => B.menuItems(n, l).map((i) => (i.type ? '-' : `${i.id}:${i.label}${i.enabled === false ? ' (off)' : ''}`))
  assert.deepEqual(labels(3, 'ko'), ['open:열기', 'home:알림 3개 — 열기', '-', 'quit:종료'])
  assert.deepEqual(labels(0, 'ko'), ['open:열기', 'home:알림 없음 (off)', '-', 'quit:종료'])
  assert.deepEqual(labels(1, 'en'), ['open:Open', 'home:1 notification — Open', '-', 'quit:Quit'])
  // (an unknown language: Korean, like menu.js)
  assert.deepEqual(labels(2, 'fr'), labels(2, 'ko'))
})

test('the badge on the tray icon: the same size, red in the top right corner with white digits, the rest of the icon as it was', () => {
  for (const size of [16, 32]) {
    const base = icon(size)
    const before = Buffer.from(base)
    const out = B.composeBadge(base, size, size, 3)
    assert.equal(out.length, size * size * 4, `${size}px: same dimensions`)
    assert.ok(base.equals(before), 'the icon handed in is left alone (a copy is drawn on)')
    const white = count(out, size, isWhite)
    const g = B.geometry(size, '3', 0.6875)
    const corner = { x0: size - g.d, y0: 0, x1: size, y1: g.d }
    const red = count(out, size, isRed, corner)
    assert.ok(red > g.d * g.d * 0.4, `${size}px: a red disc in the top right (${red} red pixels)`)
    assert.equal(count(out, size, isRed), red, 'no red outside its corner')
    assert.equal(white, cells('3') * g.s * g.s, `${size}px: the digit 3, ${g.s}× (${white} white pixels)`)
    // the badge stays in its corner: outside the disc and its clear ring, the icon is as it was
    const r = g.d / 2
    const cx = size - r
    const cy = r
    let kept = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r + g.s + 1) continue
        assert.deepEqual(px(out, size, x, y), px(before, size, x, y), `${size}px: (${x}, ${y}) untouched`)
        kept++
      }
    }
    assert.ok(kept > size * size * 0.4, `${size}px: most of the icon shows (${kept} pixels)`)
    // a clear ring around the disc: the badge stands off the icon (some pixels just outside it are see-through now)
    assert.ok(count(out, size, (p) => p.a < 255) > 0, 'a clear ring around the badge')
  }
})

test('0: the icon unchanged; 10 and up: 「9+」', () => {
  const base = icon(16)
  const zero = B.composeBadge(base, 16, 16, 0)
  assert.ok(zero.equals(base), 'nothing drawn at 0')
  assert.notEqual(zero, base, '(still a copy)')
  for (const size of [16, 32]) {
    const nine = B.composeBadge(icon(size), size, size, 9)
    const twelve = B.composeBadge(icon(size), size, size, 12)
    assert.ok(!twelve.equals(nine), `${size}px: 12 is not drawn as 9`)
    for (const n of [10, 99, 9999]) assert.ok(B.composeBadge(icon(size), size, size, n).equals(twelve), `${size}px: ${n} is drawn as 12 — 9+`)
    const g = B.geometry(size, '9+', 0.6875)
    assert.equal(count(twelve, size, isWhite), (cells('9') + cells('+')) * g.s * g.s, `${size}px: 「9」 and 「+」`)
  }
  // a see-through icon (Linux themes): the badge is drawn all the same
  const clear = B.composeBadge(Buffer.alloc(16 * 16 * 4), 16, 16, 5)
  assert.ok(count(clear, 16, isRed) > 20)
})

test('the digits sit in the middle of the disc, whole pixels (no blur), every digit', () => {
  for (const size of [16, 22, 32]) {
    for (const label of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '9+']) {
      const g = B.geometry(size, label, 0.6875)
      assert.equal((g.d - g.tw) % 2, 0, `${size}px ${label}: centred across`)
      assert.equal((g.d - g.th) % 2, 0, `${size}px ${label}: centred down`)
      assert.ok(g.tw <= g.d && g.th <= g.d && g.d <= size, `${size}px ${label}: fits`)
    }
  }
  // each digit draws as itself (no two alike)
  const drawn = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => B.composeBadge(icon(16), 16, 16, Number(d)).toString('hex')))
  assert.equal(drawn.size, 9)
})

test('Windows: the taskbar overlay is the badge alone on a clear square; none at 0', () => {
  assert.equal(B.overlayBadge(16, 0), null)
  for (const size of [16, 32]) {
    const o = B.overlayBadge(size, 3)
    assert.equal(o.length, size * size * 4)
    assert.equal(px(o, size, 0, 0).a, 0, 'the corners are see-through')
    assert.ok(count(o, size, isRed) > size * size * 0.4, 'mostly red')
    assert.ok(count(o, size, isWhite) > 0, 'white digits')
  }
  assert.ok(!B.overlayBadge(16, 12).equals(B.overlayBadge(16, 9)))
})

// ---------- tray.js as each system, with fakes ----------
function fakeElectron({ trayFails = false } = {}) {
  const log = []
  let made = 0
  function image({ path: p = null, reps = {} } = {}) {
    // reps: scale → { width, height, buf } (pixels)
    const img = {
      id: ++made, path: p, reps, template: false,
      setTemplateImage(v) { img.template = v },
      getScaleFactors: () => Object.keys(img.reps).map(Number),
      getSize: () => { const r = img.reps[1] || Object.values(img.reps)[0]; return { width: r.width, height: r.height } },
      toBitmap: ({ scaleFactor = 1 } = {}) => Buffer.from(img.reps[scaleFactor].buf),
      addRepresentation({ scaleFactor, width, height, buffer }) { img.reps[scaleFactor] = { width, height, buf: buffer } },
    }
    return img
  }
  const nativeImage = {
    createFromPath: (p) => image({ path: p, reps: { 1: { width: 16, height: 16, buf: icon(16) }, 2: { width: 32, height: 32, buf: icon(32) } } }),
    createFromBitmap: (buf, { width, height, scaleFactor = 1 }) => {
      assert.equal(buf.length, width * height * 4, 'a bitmap of its size')
      return image({ reps: { [scaleFactor]: { width, height, buf } } })
    },
  }
  class Tray {
    constructor(img) {
      if (trayFails) throw new Error('no tray here')
      this.image = img; this.title = ''; this.tooltip = ''; this.menu = null; this.handlers = {}; this.popped = []; this.dead = false
      Tray.last = this
    }
    setImage(img) { this.image = img; log.push(['tray.image', img.id]) }
    setTitle(t, o) { this.title = t; log.push(['tray.title', t, o?.fontType]) }
    getTitle() { return this.title }
    setToolTip(t) { this.tooltip = t }
    setContextMenu(m) { this.menu = m; log.push(['tray.menu']) }
    popUpContextMenu(m) { this.popped.push(m) }
    on(ev, fn) { this.handlers[ev] = fn }
    emit(ev) { this.handlers[ev]?.() }
    isDestroyed() { return this.dead }
    destroy() { this.dead = true }
  }
  const Menu = { buildFromTemplate: (t) => ({ items: t.map((i) => ({ type: i.type || 'normal', label: i.label, enabled: i.enabled !== false, click: i.click })) }) }
  const app = {
    badge: 0, dockText: '',
    setBadgeCount(n) { app.badge = n; app.dockText = n ? String(n) : ''; log.push(['app.badge', n]); return true },
    getBadgeCount: () => app.badge,
    dock: { setBadge(t) { app.dockText = t; log.push(['dock', t]) } },
  }
  const win = { overlays: [], dead: false, setOverlayIcon(img, d) { win.overlays.push([img, d]) }, isDestroyed: () => win.dead }
  return { electron: { app, Tray, Menu, nativeImage }, app, Tray, win, log }
}
function make(platform, { lang = 'ko', mark = '', trayFails = false } = {}) {
  const f = fakeElectron({ trayFails })
  const did = []
  const ctl = { mark }
  const t = createTrayBadge({
    electron: f.electron, platform, iconDir: TRAY_DIR, lang: () => lang, mainWindow: () => f.win, dockMark: () => ctl.mark,
    show: () => did.push('show'), openHome: () => did.push('home'), quit: () => did.push('quit'),
  })
  return { ...f, t, did, ctl, tray: f.Tray.last }
}
const item = (t, id) => t.menu().items[{ open: 0, home: 1, quit: 3 }[id]]

test('macOS: the menu bar icon is the template image, the number beside it, the Dock\'s number; click → the window, right click → the menu', () => {
  const m = make('darwin')
  assert.match(m.tray.image.path, /trayTemplate\.png$/)
  assert.equal(m.tray.image.template, true, 'a template image (macOS tints it for the bar)')
  assert.deepEqual(m.t.state(), { count: 0, title: '', tooltip: 'Process GPT Lite', overlay: '', menu: ['열기', '알림 없음', '-', '종료'] })
  assert.equal(m.t.set(3), 3)
  assert.equal(m.app.getBadgeCount(), 3)
  assert.equal(m.app.dockText, '3')
  assert.deepEqual(m.t.state(), { count: 3, title: ' 3', tooltip: 'Process GPT Lite — 알림 3개', overlay: '', menu: ['열기', '알림 3개 — 열기', '-', '종료'] })
  assert.ok(m.log.some((l) => l[0] === 'tray.title' && l[1] === ' 3' && l[2] === 'monospacedDigit'))
  // no icon of its own with a badge (the template image stays), no context menu of its own (a click is the window)
  assert.ok(!m.log.some((l) => l[0] === 'tray.image' || l[0] === 'tray.menu'))
  assert.equal(m.win.overlays.length, 0)
  m.tray.emit('click')
  m.tray.emit('right-click')
  assert.deepEqual(m.did, ['show'])
  assert.equal(m.tray.popped.length, 1)
  assert.equal(m.tray.popped[0], m.t.menu())
  item(m.t, 'home').click()
  item(m.t, 'open').click()
  item(m.t, 'quit').click()
  assert.deepEqual(m.did, ['show', 'home', 'show', 'quit'])
  // back to 0: nothing beside the icon, the Dock's number gone
  m.t.set(0)
  assert.equal(m.app.getBadgeCount(), 0)
  assert.equal(m.t.state().title, '')
  assert.equal(m.app.dockText, '')
})

test('macOS: with no count the Dock still shows ● while a local agent runs; a count comes first', () => {
  const m = make('darwin', { mark: '●' })
  assert.equal(m.app.dockText, '●')
  m.t.set(2)
  assert.equal(m.app.dockText, '2')
  m.t.set(0)
  assert.equal(m.app.dockText, '●')
  m.ctl.mark = ''
  m.t.dock()
  assert.equal(m.app.dockText, '')
})

test('Windows: the taskbar button\'s red overlay with 「알림 N개」, the tray icon with the badge, the menu on a right click', () => {
  const m = make('win32')
  assert.match(m.tray.image.path, /[\\/]tray\.png$/)
  assert.equal(m.tray.image.template, false)
  const base = m.tray.image
  m.t.set(3)
  // not app.setBadgeCount: Electron would draw an overlay of its own on the same button
  assert.ok(!m.log.some((l) => l[0] === 'app.badge'))
  const [img, desc] = m.win.overlays.at(-1)
  assert.equal(desc, '알림 3개')
  assert.deepEqual(img.getScaleFactors(), [1, 2])
  assert.equal(img.reps[1].width, 16)
  assert.equal(img.reps[2].width, 32)
  assert.ok(count(img.reps[1].buf, 16, isRed) > 100)
  // the tray icon: the badge drawn on each size of the icon
  const shown = m.tray.image
  assert.notEqual(shown, base)
  assert.deepEqual(shown.getScaleFactors(), [1, 2])
  assert.equal(shown.reps[1].buf.length, 16 * 16 * 4)
  assert.equal(shown.reps[2].buf.length, 32 * 32 * 4)
  assert.ok(count(shown.reps[1].buf, 16, isRed) > 20 && count(shown.reps[2].buf, 32, isRed) > 80)
  assert.ok(shown.reps[2].buf.equals(B.composeBadge(icon(32), 32, 32, 3)))
  assert.equal(m.tray.tooltip, 'Process GPT Lite — 알림 3개')
  assert.equal(m.tray.menu, m.t.menu(), 'the tray\'s own context menu')
  assert.deepEqual(m.t.state().menu, ['열기', '알림 3개 — 열기', '-', '종료'])
  assert.equal(m.t.state().title, '')
  m.tray.emit('click')
  m.tray.menu.items[1].click()
  m.tray.menu.items[3].click()
  assert.deepEqual(m.did, ['show', 'home', 'quit'])
  // 9+ is made once and kept
  m.t.set(12)
  const nine = m.tray.image
  m.t.set(15)
  assert.equal(m.tray.image, nine)
  assert.equal(m.win.overlays.at(-1)[1], '알림 15개')
  // 0: no overlay, the plain icon
  m.t.set(0)
  assert.deepEqual(m.win.overlays.at(-1), [null, ''])
  assert.equal(m.tray.image, base)
  assert.equal(m.tray.menu.items[1].enabled, false)
  // the same count again: nothing repainted
  const n = m.log.length
  m.t.set(0)
  assert.equal(m.log.length, n)
})

test('Linux: the launcher\'s number where there is one, the tray icon with the badge, the menu (app indicators send no click)', () => {
  const m = make('linux', { lang: 'en' })
  m.t.set(4)
  assert.equal(m.app.getBadgeCount(), 4)
  assert.equal(m.win.overlays.length, 0)
  assert.ok(count(m.tray.image.reps[1].buf, 16, isRed) > 20)
  assert.equal(m.tray.tooltip, 'Process GPT Lite — 4 notifications')
  assert.deepEqual(m.tray.menu.items.map((i) => i.label), ['Open', '4 notifications — Open', undefined, 'Quit'])
  m.tray.menu.items[0].click()
  assert.deepEqual(m.did, ['show'])
})

test('no tray on this desktop (Linux without one): the app still starts, the launcher still counts', () => {
  const m = make('linux', { trayFails: true })
  assert.equal(m.t.set(2), 2)
  assert.equal(m.app.getBadgeCount(), 2)
  assert.equal(m.t.state().count, 2)
  m.t.destroy()
})

test('destroy: the tray goes, later counts change nothing', () => {
  const m = make('win32')
  m.t.destroy()
  assert.equal(m.tray.isDestroyed(), true)
  const n = m.win.overlays.length
  m.t.set(5)
  assert.equal(m.win.overlays.length, n)
})

// ---------- the files ----------
const pngSize = (f) => { const b = fs.readFileSync(f); assert.equal(b.toString('latin1', 1, 4), 'PNG', `${f}: a PNG`); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colour: b[25] } }
test('the tray PNGs: 16 and 32 px (@2x), RGBA, the macOS ones a template, all packed (electron-builder files)', () => {
  for (const [name, size] of [['tray.png', 16], ['tray@2x.png', 32], ['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
    const s = pngSize(path.join(TRAY_DIR, name))
    assert.deepEqual([s.w, s.h], [size, size], name)
    assert.equal(s.colour, 6, `${name}: RGBA`)
  }
  // (a Windows checkout has CRLF line ends)
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
  assert.match(yml, /^files:\n(?:\s+.*\n)*?\s+- resources\/\*\*/m, 'resources/** is packed')
  // main.js finds them beside src/
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8'), /path\.join\(__dirname, '\.\.', 'resources', 'tray'\)/)
})
