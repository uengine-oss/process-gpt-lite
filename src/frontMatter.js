// A Markdown file's YAML front matter (a SKILL.md's name · description, a Cursor rule's globs …), split from its body for the file view
// (components/files/FileView.vue — the folder preview, the 「에이전트 자산」 tab's file, the workroom). marked alone draws `---` / `name: …` /
// `---` as a rule and a bold heading (the lines above the closing `---` become a setext heading — champion folders video, 2026-11-26).
// Shown the way GitHub does: its keys and values in a small table above the body, never as a heading.
// Front matter: `---` on the very first line and a closing `---` (or `...`) within 200 lines, with at least one top-level `key:` line;
// anything else is the body as it is. The YAML read is a small subset — enough to show, never to act on: top-level keys; a value on its
// line (quotes taken off, `[a, b]` as "a, b"), a folded or literal block below (`>` · `|`), a "- item" list, a nested map as its lines.
const OPEN = /^\uFEFF?---[ \t]*\r?\n/
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/
const KEY = /^([^\s#:\-[{"'][^:]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/
const LINES = 200

const unquote = (v) => {
  const s = String(v || '').trim()
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) return s.slice(1, -1).replace(s[0] === "'" ? /''/g : /\\"/g, s[0])
  if (s.length >= 2 && s[0] === '[' && s.endsWith(']')) return s.slice(1, -1).split(',').map(unquote).filter(Boolean).join(', ')
  return s
}

function valueOf(first, more) {
  const block = /^[>|][-+0-9]*$/.exec(first)
  const lines = more.slice()
  while (lines.length && !lines.at(-1).trim()) lines.pop()
  if (block) {
    const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length))
    const rows = lines.map((l) => (l.trim() ? l.slice(Number.isFinite(pad) ? pad : 0) : ''))
    // (folded: lines joined by a space, a blank line a new paragraph; literal: as they are)
    return first[0] === '|' ? rows.join('\n') : rows.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/\n\n+/g, '\n')
  }
  const items = lines.filter((l) => l.trim())
  if (items.length && items.every((l) => /^\s*-\s/.test(l) || /^\s*-$/.test(l))) return items.map((l) => unquote(l.replace(/^\s*-\s?/, ''))).join(', ')
  if (items.length && items.some((l) => KEY.test(l.trim()))) return [first && unquote(first), ...items.map((l) => l.trim())].filter(Boolean).join('\n')
  return [first, ...items.map((l) => l.trim())].filter(Boolean).map(unquote).join(' ')
}

// text → {meta: [[key, value]] | null, body}
export function splitFrontMatter(text) {
  const s = String(text ?? '')
  const open = OPEN.exec(s)
  if (!open) return { meta: null, body: s }
  const lines = s.slice(open[0].length).split(/\r?\n/)
  const end = lines.slice(0, LINES).findIndex((l) => CLOSE.test(l))
  if (end < 0) return { meta: null, body: s }
  const head = lines.slice(0, end)
  const meta = []
  let cur = null
  for (const l of head) {
    const top = !/^\s/.test(l) && !/^-(\s|$)/.test(l)
    const k = top && !l.startsWith('#') ? KEY.exec(l) : null
    // (a comment after a plain value goes; a quoted value keeps its #)
    if (k) { cur = { key: k[1], first: /^["']/.test(k[2] || '') ? k[2] : (k[2] || '').replace(/\s+#.*$/, ''), more: [] }; meta.push(cur); continue }
    if (cur && !(top && l.startsWith('#'))) cur.more.push(l)
  }
  // (not front matter — a rule, then text, then a rule: shown as it is)
  if (!meta.length && head.some((l) => l.trim() && !l.trim().startsWith('#'))) return { meta: null, body: s }
  return { meta: meta.map((m) => [m.key, valueOf(m.first, m.more)]), body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') }
}
