// An AI-DLC document (Markdown the engine wrote from what people said) as HTML for the viewer: raw
// HTML in it stays text, links go nowhere on their own, every heading gets an id, and the section a
// review points at can be found by its name.
import { Marked } from 'marked'

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const norm = (s) => String(s || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_"'“”‘’()[\]{}:;,.!?·…—–\-/\\|#>]+/g, ' ').replace(/\s+/g, ' ').trim()

export function renderDoc(text) {
  const headings = []
  const used = new Map()
  const slug = (t) => {
    const base = norm(t).replace(/ /g, '-').slice(0, 60) || 'section'
    const n = used.get(base) || 0
    used.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
  const marked = new Marked({ gfm: true, breaks: false })
  marked.use({
    renderer: {
      // what the document says in HTML is shown, never run
      html: ({ text: t }) => esc(t),
      heading({ tokens, depth, text: raw }) {
        const id = slug(raw)
        headings.push({ id, level: depth, text: raw.replace(/[`*_]/g, '') })
        return `<h${depth} id="h-${id}" data-h="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
      // a link is shown with its address; the viewer opens it (outside links in a new tab)
      link({ href, title, tokens }) {
        const safe = /^(https?:|mailto:)/i.test(href || '') ? href : ''
        return `<a ${safe ? `data-href="${esc(safe)}"` : `data-ref="${esc(href || '')}"`} title="${esc(title || href || '')}">${this.parser.parseInline(tokens)}</a>`
      },
      image: ({ text: alt }) => `<span class="img-alt">[${esc(alt || 'image')}]</span>`,
    },
  })
  const html = marked.parse(String(text || ''))
  const title = headings[0]?.text || ''
  return { html, headings, title }
}

// the heading a focus names: the same words first, then one that starts with them, then one that
// holds them ("ADR-004" → "ADR-004: 칸 단위 저장"); none: null (the viewer then looks in the text)
export function findHeading(headings, focus) {
  const f = norm(focus)
  if (!f) return null
  return headings.find((h) => norm(h.text) === f) || headings.find((h) => norm(h.text).startsWith(f)) || headings.find((h) => norm(h.text).includes(f)) || null
}
