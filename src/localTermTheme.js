// The run card's terminal in Lite's own look (LocalTerminal.vue — the user's question 2026-11-24: 「ssh 터미널이지만, 보기 모드에 따라 원하는
// 경우는 우리 디자인에 맞춰서 스타일링이 가능할까?」): xterm.js colours from the tokens of src/styles/base.css for the dark base and the light
// theme (<html data-theme>), switched live when the theme changes. The 16 ANSI colours keep their meaning (red is red) but are toned to
// the tokens (--color-error · --color-success · --color-info …) and chosen to read on that background (contrast 4.5:1 or more — checked
// by server/test/localTermTheme.test.js); what a CLI paints in its own 24-bit colours is lifted to 4.5:1 by xterm (minimumContrastRatio).
// The font: a monospace face first, then Korean faces whose Hangul is two cells wide (D2Coding, Nanum Gothic Coding) before the system's.
export const TERM_FONT = '"SF Mono", Menlo, Monaco, Consolas, "D2Coding", "Nanum Gothic Coding", "Apple SD Gothic Neo", "Noto Sans Mono CJK KR", monospace'
export const MIN_CONTRAST = 4.5

export const TERM_THEMES = {
  // dark (the base): the card's ink (rgb 29 29 31), --text-primary, --color-info as the cursor
  dark: {
    background: '#1d1d1f', foreground: '#f5f5f7', cursor: '#a1d0ff', cursorAccent: '#1d1d1f',
    selectionBackground: 'rgba(120, 160, 255, 0.35)', selectionInactiveBackground: 'rgba(120, 160, 255, 0.2)',
    black: '#8e8e93', red: '#ff7a7a', green: '#96f0b0', yellow: '#f5c451', blue: '#a1d0ff', magenta: '#d7a6ff', cyan: '#7fdbdb', white: '#d1d1d6',
    brightBlack: '#a1a1a6', brightRed: '#ff9e9e', brightGreen: '#b6f5c8', brightYellow: '#ffd97a', brightBlue: '#c4e2ff', brightMagenta: '#e6c4ff', brightCyan: '#a6ecec', brightWhite: '#f5f5f7',
  },
  // light: the card's white (rgb 251 251 253), --text-primary (rgb 29 29 31), --color-info (#005AD7) as the cursor; the "white" ANSI
  // colours become greys that still read on white
  light: {
    background: '#fbfbfd', foreground: '#1d1d1f', cursor: '#005ad7', cursorAccent: '#fbfbfd',
    selectionBackground: 'rgba(0, 90, 215, 0.2)', selectionInactiveBackground: 'rgba(0, 90, 215, 0.12)',
    black: '#1d1d1f', red: '#c0392b', green: '#0b7a43', yellow: '#8a5a00', blue: '#005ad7', magenta: '#8e3bb8', cyan: '#00727a', white: '#5e5e63',
    brightBlack: '#5e5e63', brightRed: '#a52a1f', brightGreen: '#08663a', brightYellow: '#734b00', brightBlue: '#004bb3', brightMagenta: '#76309a', brightCyan: '#005e66', brightWhite: '#3a3a3c',
  },
}

// the theme in force: <html data-theme> (src/stores/sky.js sets it with the sun, or the person's choice); dark is the base
export const themeMode = () => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
export const themeFor = (mode = themeMode()) => TERM_THEMES[mode === 'light' ? 'light' : 'dark']
// call fn(mode) whenever the theme changes → stop()
export function watchTheme(fn) {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {}
  let last = themeMode()
  const mo = new MutationObserver(() => { const m = themeMode(); if (m !== last) { last = m; fn(m) } })
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => mo.disconnect()
}

// WCAG contrast of two #rrggbb colours (the test checks the palettes with it)
export function contrast(a, b) {
  const lum = (hex) => {
    const n = parseInt(String(hex).replace('#', ''), 16)
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
