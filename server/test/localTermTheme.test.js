// The run card's terminal in Lite's colours (src/localTermTheme.js — spec openspec/specs/local-agents 「실행은 「대화」와 「터미널」 두 보기로
// 본다」): for the light and the dark theme, the text and the 16 ANSI colours read on the terminal's background (WCAG 4.5:1 or more), and
// the background is the card's own colour of that theme.
//   cd server && node --test test/localTermTheme.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { TERM_THEMES, contrast, themeFor, MIN_CONTRAST } from '../../src/localTermTheme.js'

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']

test('밝은 · 어두운 테마: 글과 16색이 바탕과 4.5:1 이상', () => {
  for (const [mode, t] of Object.entries(TERM_THEMES)) {
    assert.ok(contrast(t.foreground, t.background) >= 7, `${mode} foreground`)
    for (const k of ANSI) assert.ok(contrast(t[k], t.background) >= MIN_CONTRAST, `${mode} ${k}: ${contrast(t[k], t.background).toFixed(2)}`)
    assert.ok(contrast(t.cursor, t.background) >= 3, `${mode} cursor`)
  }
})

test('바탕은 그 테마의 카드 색(base.css 토큰), 테마 이름이 이상하면 어두운 쪽(앱의 바탕)', () => {
  assert.equal(TERM_THEMES.dark.background, '#1d1d1f')
  assert.equal(TERM_THEMES.light.background, '#fbfbfd')
  assert.equal(TERM_THEMES.light.foreground, '#1d1d1f')
  assert.equal(TERM_THEMES.dark.foreground, '#f5f5f7')
  assert.equal(themeFor('light'), TERM_THEMES.light)
  assert.equal(themeFor('sepia'), TERM_THEMES.dark)
  assert.equal(contrast('#000000', '#ffffff').toFixed(0), '21')
})
