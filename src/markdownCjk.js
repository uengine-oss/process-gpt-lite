// CommonMark closes ** only on a "right-flanking" run: punctuation before it needs a space or
// punctuation after it. Korean answers put a particle right after the bold — "**AST모바일(096540)**은",
// "**코스피**가" — so marked left the asterisks on screen (2026-11-21 phone review). This inline rule
// takes **…** on one line wherever it opens and closes next to a non-space, then lets marked render
// it as its own strong token. Imported once (src/main.js); marked is a single shared instance.
import { marked } from 'marked'

const STRONG = /^\*\*(?=[^\s*])([^\n]*?[^\s*\\])\*\*(?!\*)/

export const cjkStrong = {
  name: 'cjkStrong',
  level: 'inline',
  start(src) {
    const i = src.indexOf('**')
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    const m = STRONG.exec(src)
    if (!m) return undefined
    return { type: 'strong', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) }
  },
}

let installed = false
export function installCjkMarkdown(instance = marked) {
  if (installed && instance === marked) return instance
  instance.use({ extensions: [cjkStrong] })
  if (instance === marked) installed = true
  return instance
}
