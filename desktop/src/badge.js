'use strict'
// The count of Home cards waiting, as each system shows such a count (src/tray.js puts it there). The web app counts them
// (src/browserNotify.js setBadge — the same number an installed web app shows on its icon) and hands it over the preload's
// bridge (pglDesktop.setBadge). Nothing of Electron here: the words, and the badge drawn on raw pixels — test/badge.test.js.
//   macOS:   the Dock's number (app.setBadgeCount) · the menu bar icon with the number beside it (setTitle) — the template
//            image at 0, from 1 on the icon with a red dot in its corner (menuBarDot, drawn for a light or a dark bar)
//   Windows: the taskbar button's overlay (a red badge, 「알림 3개」 for screen readers) · the tray icon with a red badge
//   Linux:   the launcher's number where there is one (Unity — app.setBadgeCount) · the tray icon with a red badge
// A bitmap here is what nativeImage.toBitmap() gives: BGRA, 4 bytes a pixel, row after row, alpha premultiplied.

const MAX = 9999

// whatever came over IPC → a whole number 0…9999
function clampCount(n) {
  const v = Math.floor(Number(n))
  if (!(v > 0)) return 0
  return Math.min(v, MAX)
}

// what a badge drawn on an icon says: 1 … 9, then 9+
function badgeLabel(n) {
  const c = clampCount(n)
  return !c ? '' : c <= 9 ? String(c) : '9+'
}

// ---------- words (Korean, or English when the web app is in English — like menu.js) ----------
const T = {
  ko: { app: 'Process GPT Lite', count: (n) => `알림 ${n}개`, none: '알림 없음', open: '열기', openHome: (n) => `알림 ${n}개 — 열기`, quit: '종료' },
  en: { app: 'Process GPT Lite', count: (n) => (n === 1 ? '1 notification' : `${n} notifications`), none: 'No notifications', open: 'Open', openHome: (n) => `${n === 1 ? '1 notification' : `${n} notifications`} — Open`, quit: 'Quit' },
}
const words = (lang) => T[lang === 'en' ? 'en' : 'ko']

// macOS: the number beside the menu bar icon (with a space before it, empty at 0); elsewhere a tray has no title
function trayTitle(n, platform) {
  const c = clampCount(n)
  if (platform !== 'darwin' || !c) return ''
  return ` ${c > 99 ? '99+' : c}`
}
// the tray icon's tooltip
function tooltip(n, lang) {
  const c = clampCount(n)
  const t = words(lang)
  return c ? `${t.app} — ${t.count(c)}` : t.app
}
// Windows: what the taskbar button's overlay says to a screen reader
function overlayText(n, lang) {
  const c = clampCount(n)
  return c ? words(lang).count(c) : ''
}
// the tray icon's menu: 열기 · 알림 N개 — 열기 (Home) · 종료 — ids for tray.js to hang its actions on
function menuItems(n, lang) {
  const c = clampCount(n)
  const t = words(lang)
  return [
    { id: 'open', label: t.open },
    { id: 'home', label: c ? t.openHome(c) : t.none, enabled: c > 0 },
    { type: 'separator' },
    { id: 'quit', label: t.quit },
  ]
}

// ---------- the badge, drawn on pixels ----------
// a red disc (Apple's system red) with white digits from a 3×5 pixel font, scaled by whole pixels so they stay sharp
const RED = [0xff, 0x3b, 0x30]
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '011', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
}

// the disc's diameter and the font's scale for a label on a size×size square: the text fits the disc (72% of it wide,
// 66% high), and the disc's size and the text's have the same parity, so the text sits exactly in the middle
function geometry(size, label, frac) {
  const tw = label.length * 4 - 1
  let d = Math.max(5, Math.min(size, Math.round(size * frac)))
  const s = Math.max(1, Math.floor(Math.min((d * 0.72) / tw, (d * 0.66) / 5)))
  if ((d - s) % 2) d = d + 1 <= size ? d + 1 : d - 1
  return { d, s, tw: tw * s, th: 5 * s }
}

// how much of pixel (px, py) a disc of radius r around (cx, cy) covers — 4×4 samples
function cover(px, py, cx, cy, r) {
  let n = 0
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const dx = px + (i + 0.5) / 4 - cx
      const dy = py + (j + 0.5) / 4 - cy
      if (dx * dx + dy * dy <= r * r) n++
    }
  }
  return n / 16
}

// the badge on buf (width × height, BGRA premultiplied), its disc's top-left at (x, y); ring: a clear ring this wide
// around the disc first, so the badge stands off the icon under it
function drawBadge(buf, width, height, { x, y, d, s, tw, th }, label, ring) {
  const r = d / 2
  const cx = x + r
  const cy = y + r
  const x0 = Math.max(0, Math.floor(x - ring)); const x1 = Math.min(width, Math.ceil(x + d + ring))
  const y0 = Math.max(0, Math.floor(y - ring)); const y1 = Math.min(height, Math.ceil(y + d + ring))
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * width + px) * 4
      if (ring > 0) {
        const keep = 1 - cover(px, py, cx, cy, r + ring)
        for (let k = 0; k < 4; k++) buf[i + k] = Math.round(buf[i + k] * keep)
      }
      const a = cover(px, py, cx, cy, r)
      if (!a) continue
      // source over, premultiplied: B G R A
      buf[i] = Math.round(RED[2] * a + buf[i] * (1 - a))
      buf[i + 1] = Math.round(RED[1] * a + buf[i + 1] * (1 - a))
      buf[i + 2] = Math.round(RED[0] * a + buf[i + 2] * (1 - a))
      buf[i + 3] = Math.round(255 * a + buf[i + 3] * (1 - a))
    }
  }
  // the digits, white and opaque, in the middle of the disc
  const left = x + (d - tw) / 2
  const top = y + (d - th) / 2
  ;[...label].forEach((ch, g) => {
    GLYPHS[ch].forEach((row, gy) => {
      for (let gx = 0; gx < 3; gx++) {
        if (row[gx] !== '1') continue
        for (let sy = 0; sy < s; sy++) {
          for (let sx = 0; sx < s; sx++) {
            const px = left + (g * 4 + gx) * s + sx
            const py = top + gy * s + sy
            if (px < 0 || py < 0 || px >= width || py >= height) continue
            const i = (py * width + px) * 4
            buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255
          }
        }
      }
    })
  })
  return buf
}

// the tray icon with the count in its top right corner (a copy — the icon itself is left alone); n = 0: the icon as it was
function composeBadge(bitmap, width, height, n) {
  const out = Buffer.from(bitmap)
  const label = badgeLabel(n)
  if (!label) return out
  const size = Math.min(width, height)
  const g = geometry(size, label, 0.6875)
  return drawBadge(out, width, height, { x: width - g.d, y: 0, ...g }, label, g.s)
}

// Windows: the taskbar button's overlay — the badge alone, on a clear size×size square (Windows puts it at the button's
// bottom right); n = 0: none (null)
function overlayBadge(size, n) {
  const label = badgeLabel(n)
  if (!label) return null
  const g = geometry(size, label, 1)
  const off = Math.floor((size - g.d) / 2)
  return drawBadge(Buffer.alloc(size * size * 4), size, size, { x: off, y: off, ...g }, label, 0)
}

// ---------- macOS: the menu bar icon with a red dot (2026-11-26 사용자: 「상단바에 표시되는 카카오톡에 알람이 들어오듯이」) ----------
// The menu bar icon is a template image (black + alpha): macOS tints it for a light or a dark bar, and it can hold no colour.
// With something waiting the menu bar shows a plain image instead, drawn here from the template for the bar's look: the glyph
// in the colour macOS gives a template there (its label colour — black or white at 85%), and a red dot in the top right
// corner with a clear ring around it, so the dot stands off the glyph (no number in it — the number is beside the icon).
const INK = { light: [0x00, 0x00, 0x00], dark: [0xff, 0xff, 0xff], alpha: 0.85 }

// the dot's diameter and its clear ring on a size×size icon: 6 and 1 px at 16 (1×), 12 and 2 at 32 (2×)
function dotGeometry(size) {
  return { d: Math.max(3, Math.round(size * 0.375)), ring: Math.max(1, Math.round(size / 16)) }
}

// the template's bitmap (width × height, BGRA premultiplied) → the menu bar icon with the dot, for a dark bar or a light one
// (a copy — the template is left alone)
function menuBarDot(template, width, height, dark) {
  const [r, g, b] = dark ? INK.dark : INK.light
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < out.length; i += 4) {
    // only the template's alpha counts (its colour is black, or whatever — macOS ignores it too)
    const a = (template[i + 3] || 0) * INK.alpha
    out[i] = Math.round((b * a) / 255)
    out[i + 1] = Math.round((g * a) / 255)
    out[i + 2] = Math.round((r * a) / 255)
    out[i + 3] = Math.round(a)
  }
  const { d, ring } = dotGeometry(Math.min(width, height))
  return drawBadge(out, width, height, { x: width - d, y: 0, d, s: 1, tw: 0, th: 0 }, '', ring)
}

module.exports = { MAX, clampCount, badgeLabel, words, trayTitle, tooltip, overlayText, menuItems, composeBadge, overlayBadge, menuBarDot, dotGeometry, INK, GLYPHS, RED, geometry }
