// Markdown anyone may have written, as HTML safe to put into the page (v-html): an agent's answer (it can repeat a mail, a web page or a
// colleague's words), a shared folder's file, a company skill, a process definition, a form's value. marked renders it; then the browser's
// own parser reads that into an inert document and only plain document elements stay — paragraphs, emphasis, lists, quotes, code, tables,
// links. Scripts, styles, frames, SVG · MathML, forms, comments and every other attribute go; a picture leaves its alt text (no request
// to another site from a message); a link keeps its address only when it is http(s), mailto or a path of this site, and opens in a new
// tab. No library: the browser's own parser, so what is checked is what the page will read.
//   html: 'allow' (default) — raw HTML in the text goes through the same allow-list (a document's <br>, <b>…)
//         'text'  — raw HTML in the text shows as the text it is (an answer that writes "<div>" means the word, as chats always showed it)
//   breaks: a single line break is a <br> (chat text, the default) or not (documents)
import { Marked, Lexer } from 'marked'
import { installCjkMarkdown } from './markdownCjk.js'

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'input'])
// gone with what is inside them (any namespace: an <svg>'s or a <math>'s own children are not HTML)
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'template', 'svg', 'math',
  'form', 'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'textarea', 'title', 'select', 'audio', 'video', 'canvas', 'portal'])
const SCHEMES = new Set(['http:', 'https:', 'mailto:'])

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const here = () => (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.href : 'https://lite.invalid/')

// A link address the page may follow: read by the URL parser the browser itself navigates with (entities are already read by then, tabs
// and line breaks inside it dropped, leading spaces and control characters too), so "java\tscript:", "&#106;avascript:" and " javascript:"
// are what they are. A relative address is this site's.
export function safeHref(v) {
  if (typeof v !== 'string' || !v) return undefined
  try { return SCHEMES.has(new URL(v, here()).protocol) ? v : undefined } catch { return undefined }
}

function keepAttr(name, a) {
  if (name === 'a') return (a.name === 'href' && !!safeHref(a.value)) || a.name === 'title'
  if (name === 'input') return ['type', 'checked', 'disabled'].includes(a.name)
  if (name === 'th' || name === 'td') return a.name === 'align' && /^(left|center|right)$/i.test(a.value)
  if (name === 'ol') return a.name === 'start' && /^\d{1,9}$/.test(a.value)
  return false
}

function clean(node) {
  for (const n of [...node.childNodes]) {
    if (n.nodeType === 3) continue
    // comments, processing instructions, CDATA: nothing of the document's words
    if (n.nodeType !== 1) { n.remove(); continue }
    const name = n.localName
    // (SVG and MathML come in their own namespaces: gone with all they hold)
    if (DROP.has(name.toLowerCase()) || n.namespaceURI !== HTML_NS) { n.remove(); continue }
    if (name === 'img') { n.replaceWith(n.getAttribute('alt') || ''); continue }
    clean(n)
    if (!TAGS.has(name)) { n.replaceWith(...n.childNodes); continue }
    for (const a of [...n.attributes]) if (!keepAttr(name, a)) n.removeAttribute(a.name)
    if (name === 'input') { if (n.getAttribute('type') !== 'checkbox') { n.remove(); continue } n.setAttribute('disabled', '') }
    if (name === 'a') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer') }
  }
}

// HTML made elsewhere (a renderer of its own) through the same allow-list
export function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${String(html || '')}</body>`, 'text/html')
  clean(doc.body)
  return doc.body.innerHTML
}

// raw HTML in the text, shown as its text: a tag in a line as the characters it is; a block of it (a <div> … </div> on lines of their own)
// as a paragraph of those characters, the Markdown inside still read
function htmlAsText({ text, block }) {
  if (!block) return esc(text)
  return `<p>${this.parser.parseInline(Lexer.lexInline(String(text).replace(/\n+$/, ''), this.options))}</p>\n`
}
const md = { allow: installCjkMarkdown(new Marked({ gfm: true })), text: installCjkMarkdown(new Marked({ gfm: true })).use({ renderer: { html: htmlAsText } }) }

export function safeMarkdown(text, { breaks = true, html = 'allow' } = {}) {
  const out = (html === 'text' ? md.text : md.allow).parse(String(text ?? ''), { breaks, async: false })
  return cleanHtml(out)
}
