// People with the same name in one list, told apart (2026-11-25, production: one person had two accounts in one company — a Gmail one
// and a company one — both 「윤가람」, and the messenger listed two identical rows; sign-up stays open, so it can happen again, and two
// people may simply share a name). Within one list, each person whose name another person there also has gets what tells them apart:
// the address's domain when no one else of that name has it (「윤가람 · gmail.com」 · 「윤가람 · uengine.org」), else the whole address.
// A name that is alone in the list gets nothing. No page, no network: src/people.js (tagsFor) and server/test/sameNames.test.js use it.

const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
export const domainOf = (email) => {
  const s = String(email ?? '').trim().toLowerCase()
  const i = s.lastIndexOf('@')
  return i > 0 && i < s.length - 1 ? s.slice(i + 1) : ''
}

// list: [{id, name, email}] → Map id → the tag ('' when the name is alone, or nothing tells them apart)
export function nameTags(list) {
  const out = new Map()
  const groups = new Map()
  for (const p of list || []) {
    const id = p?.id == null ? '' : String(p.id)
    if (!id || out.has(id)) continue
    out.set(id, '')
    const k = key(p.name)
    if (!k) continue
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push({ id, email: String(p.email ?? '').trim().toLowerCase() })
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const count = new Map()
    for (const p of g) { const d = domainOf(p.email); if (d) count.set(d, (count.get(d) || 0) + 1) }
    for (const p of g) {
      const d = domainOf(p.email)
      out.set(p.id, d && count.get(d) === 1 ? d : p.email)
    }
  }
  return out
}

// a name with its tag after it, as the lists show it
export const tagged = (name, tag) => (tag ? `${name ?? ''} · ${tag}` : String(name ?? ''))
