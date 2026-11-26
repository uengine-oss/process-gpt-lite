'use strict'
// The tray icon (macOS: the menu bar) and the count of Home cards waiting on the Dock or the taskbar (2026-11-25 사용자:
// 「일렉트론 버전의 시스템 트레이에 알람 개수 뱃지 설치」). The web app sends the count (src/browserNotify.js setBadge → preload
// pglDesktop.setBadge → main.js 'pgl:badge'); what each system shows is in badge.js. Made once at start, kept until the app quits.
//   click: the main window, shown and in front · its menu: 열기 · 알림 N개 — 열기 (Home) · 종료
//   (Linux app indicators send no click — their menu's 열기 does it; macOS: a right click opens the menu, a click the window)
// macOS, something waiting (2026-11-26 사용자: 「상단바에 표시되는 카카오톡에 알람이 들어오듯이」): the menu bar icon with a red
// dot in its corner — a plain image drawn for the bar's look (nativeTheme: light or dark, drawn again when it changes), the
// template image back at 0 — and the Dock icon bounces once when the count goes up while the window is not in front.
// Electron is handed in (electron, platform), so test/badge.test.js drives this as each system with fakes.
const path = require('node:path')
const B = require('./badge')

/**
 * electron: { app, Tray, Menu, nativeImage, nativeTheme }; iconDir: resources/tray (tray.png · trayTemplate.png, @2x beside them)
 * lang(): 'ko' | 'en' · mainWindow(): the main BrowserWindow or null · dockMark(): what the Dock shows with no count ('●' while
 * a local agent runs — main.js) · show() · openHome() · quit()
 */
function createTrayBadge({ electron, platform = process.platform, iconDir, lang = () => 'ko', mainWindow = () => null, dockMark = () => '', show, openHome, quit, log = () => {} }) {
  const { app, Tray, Menu, nativeImage, nativeTheme } = electron
  const MAC = platform === 'darwin'
  const WIN = platform === 'win32'
  let count = 0
  let menu = null
  let tooltipText = ''
  let overlayText = ''
  let destroyed = false

  const base = nativeImage.createFromPath(path.join(iconDir, MAC ? 'trayTemplate.png' : 'tray.png'))
  if (MAC) base.setTemplateImage(true)
  let tray = null
  try { tray = new Tray(base) } catch (e) { log(`[tray] ${e.message}`) } // (a Linux desktop without a tray: the counts below still go)

  // the icon drawn on, each of its sizes (16 · 32 px for 1× · 2× screens): draw(bitmap, width, height) → the new pixels;
  // null when the icon has no bitmap to draw on
  function drawn(draw) {
    let img = null
    const dip = base.getSize()
    for (const scaleFactor of base.getScaleFactors?.() || [1]) {
      // (getSize is in points; the bitmap of a scale is in pixels: 16 × 2 = 32)
      const width = Math.round(dip.width * scaleFactor)
      const height = Math.round(dip.height * scaleFactor)
      const bmp = base.toBitmap({ scaleFactor })
      if (bmp.length !== width * height * 4) continue
      const px = draw(bmp, width, height)
      if (!img) img = nativeImage.createFromBitmap(px, { width, height, scaleFactor })
      else img.addRepresentation({ scaleFactor, width, height, buffer: px })
    }
    return img
  }
  // Windows · Linux: the icon with the badge, made once per label (1 … 9, 9+)
  const composed = new Map()
  function withBadge(n) {
    const label = B.badgeLabel(n)
    if (!composed.has(label)) composed.set(label, drawn((bmp, w, h) => B.composeBadge(bmp, w, h, n)) || base)
    return composed.get(label)
  }
  // macOS: the menu bar icon with the red dot, made once for a light bar and once for a dark one. Not a template (macOS would
  // tint the dot too), so drawn for the bar's look: nativeTheme follows the system's appearance (the app leaves its themeSource
  // alone — the web app's own light and dark are drawn in the page). (A light bar that turns its icons white over a dark
  // wallpaper is what only a template follows: there the dot's icon stays dark until the count is 0 again.)
  const dark = () => !!nativeTheme?.shouldUseDarkColors
  const dotted = new Map()
  function withDot() {
    const look = dark() ? 'dark' : 'light'
    if (!dotted.has(look)) dotted.set(look, drawn((bmp, w, h) => B.menuBarDot(bmp, w, h, look === 'dark')) || base)
    return dotted.get(look)
  }
  const overlays = new Map()
  function overlay(n) {
    const label = B.badgeLabel(n)
    if (!overlays.has(label)) {
      const img = nativeImage.createFromBitmap(B.overlayBadge(16, n), { width: 16, height: 16, scaleFactor: 1 })
      img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: B.overlayBadge(32, n) })
      overlays.set(label, img)
    }
    return overlays.get(label)
  }

  const actions = { open: () => show(), home: () => openHome(), quit: () => quit() }
  function buildMenu() {
    return Menu.buildFromTemplate(B.menuItems(count, lang()).map((i) => (i.type ? i : { label: i.label, enabled: i.enabled !== false, click: actions[i.id] })))
  }

  // the Dock (macOS) · the launcher (Linux, where it has a number) · the taskbar button's overlay (Windows)
  function paintDock() {
    if (WIN) {
      // (not app.setBadgeCount here: on Windows it draws an overlay of its own — two would race for the button)
      const w = mainWindow()
      overlayText = B.overlayText(count, lang())
      if (w && !w.isDestroyed()) try { w.setOverlayIcon(count ? overlay(count) : null, overlayText) } catch (e) { log(`[tray] overlay ${e.message}`) }
      return
    }
    try { app.setBadgeCount(count) } catch { /* no launcher count here */ }
    // no count: the Dock still says that a local agent works on this computer
    const mark = MAC && !count ? dockMark() : ''
    if (mark) try { app.dock?.setBadge(mark) } catch { /* no dock */ }
  }
  // the tray's icon, set only when it is another (no flicker on a refresh); iconName for state()
  let shown = base
  let iconName = MAC ? 'template' : 'plain'
  function paintIcon() {
    if (!tray || tray.isDestroyed?.()) return
    const img = MAC ? (count ? withDot() : base) : count ? withBadge(count) : base
    if (img !== shown) { tray.setImage(img); shown = img }
    iconName = img === base ? (MAC ? 'template' : 'plain') : MAC ? `dot-${dark() ? 'dark' : 'light'}` : 'badge'
  }
  function paintTray() {
    if (!tray || tray.isDestroyed?.()) return
    paintIcon()
    if (MAC) tray.setTitle(B.trayTitle(count, platform), { fontType: 'monospacedDigit' })
    tooltipText = B.tooltip(count, lang())
    tray.setToolTip(tooltipText)
    menu = buildMenu()
    // (macOS: no menu of its own — a click opens the window, a right click pops this one up)
    if (!MAC) tray.setContextMenu(menu)
  }
  function paint() {
    if (destroyed) return
    paintDock()
    paintTray()
  }
  // macOS: a new item came while the window is not in front — the Dock icon bounces once ('informational': once, not until
  // the app is active). Only when the count goes up (not on a refresh, not when it goes down).
  function attention() {
    if (!MAC || destroyed) return
    const w = mainWindow()
    if (w && !w.isDestroyed() && w.isFocused()) return
    try { app.dock?.bounce('informational') } catch { /* no dock */ }
  }
  // macOS: the bar turned light or dark — the dot drawn for it
  const onLook = () => { if (!destroyed && MAC && count) paintIcon() }
  if (MAC) nativeTheme?.on?.('updated', onLook)

  if (tray) {
    tray.on('click', () => show())
    if (MAC) tray.on('right-click', () => { if (menu) tray.popUpContextMenu(menu) })
  }
  paint()

  return {
    // the web app's count (anything — clamped here again)
    set(n) {
      const c = B.clampCount(n)
      if (c === count) return count
      const rose = c > count
      count = c
      paint()
      if (rose) attention()
      return count
    },
    count: () => count,
    // the language changed, the window was shown or made again
    refresh: paint,
    // a local agent started or stopped (the Dock's ●)
    dock: () => { if (!destroyed) paintDock() },
    // tests (e2e D-12 · test/badge.test.js): what is shown now, read back where Electron can
    state: () => ({
      count,
      title: tray && MAC ? tray.getTitle() : '',
      tooltip: tooltipText,
      overlay: overlayText,
      menu: menu ? menu.items.map((i) => (i.type === 'separator' ? '-' : i.label)) : [],
      // the icon shown: 'template' (macOS, nothing waiting) · 'dot-light' · 'dot-dark' (macOS) · 'badge' · 'plain'
      icon: tray ? iconName : '',
    }),
    menu: () => menu,
    tray: () => tray,
    destroy() {
      destroyed = true
      if (MAC) nativeTheme?.removeListener?.('updated', onLook)
      if (tray && !tray.isDestroyed?.()) tray.destroy()
      tray = null
    },
  }
}

module.exports = { createTrayBadge }
