// An agent's words as markdown, safe to put into the page (the run card's 「대화」 view — LocalConversation.vue): marked renders it, then
// only plain document elements stay (paragraphs, emphasis, lists, quotes, code, tables, links). Raw HTML the text carries is dropped,
// as are scripts, styles, frames, event handlers and links that are not http(s) or mail. No library: the browser's own parser.
import { marked } from 'marked'

const TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'SPAN', 'INPUT'])
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'NOSCRIPT'])

function clean(node) {
  for (const el of [...node.children]) {
    if (DROP.has(el.tagName)) { el.remove(); continue }
    clean(el)
    if (!TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); continue }
    for (const a of [...el.attributes]) {
      const keep = (el.tagName === 'A' && a.name === 'href' && /^(https?:|mailto:)/i.test(a.value.trim()))
        || (el.tagName === 'INPUT' && ['type', 'checked', 'disabled'].includes(a.name))
        || (['TH', 'TD'].includes(el.tagName) && a.name === 'align')
      if (!keep) el.removeAttribute(a.name)
    }
    if (el.tagName === 'INPUT') { if (el.getAttribute('type') !== 'checkbox') { el.remove(); continue } el.setAttribute('disabled', '') }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer') }
  }
}

// breaks: a single line break is a <br> (chat text, the default) or not (documents: FileView)
export function safeMarkdown(text, { breaks = true } = {}) {
  const html = marked.parse(String(text || ''), { breaks, gfm: true, async: false })
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  clean(doc.body)
  return doc.body.innerHTML
}
