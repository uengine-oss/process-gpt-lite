// What an answer did on the way, for the person reading it (2026-11-21 phone review: "주식 관련 API 는
// 제가 제공한 게 없는데 어떤 식으로 작업하고 있는지 모르겠어요"). Each tool call becomes one line — the
// step in everyday words and where it looked: the sites it read (host names only), what it searched
// for, the file it opened. Never a command line or a whole address: those can carry keys and tokens.

const URL_RE = /https?:\/\/[^\s"'`<>)\]}]+/gi
const SECRETISH = /(key|token|secret|password|passwd|auth|bearer|cookie|session|jwt)/i

export function hostsIn(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const out = []
  for (const m of text.matchAll(URL_RE)) {
    try {
      const h = new URL(m[0]).hostname.replace(/^www\./, '')
      if (h && !out.includes(h) && !/^(localhost|127\.|10\.|192\.168\.|host\.docker\.internal)/.test(h)) out.push(h)
    } catch { /* not an address */ }
  }
  return out
}

function queryOf(input) {
  if (!input || typeof input !== 'object') return ''
  for (const k of ['query', 'q', 'search', 'search_query', 'keyword', 'keywords', 'topic']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim() && !SECRETISH.test(k)) return v.trim().replace(/\s+/g, ' ').slice(0, 60)
  }
  return ''
}

function fileOf(input) {
  if (!input || typeof input !== 'object') return ''
  const p = input.file_path || input.path || input.filename || input.file
  if (typeof p !== 'string' || !p.trim()) return ''
  return p.split('/').filter(Boolean).pop()?.slice(0, 60) || ''
}

export function trailEntry(tool, input, phase) {
  const parsed = typeof input === 'string' ? (() => { try { return JSON.parse(input) } catch { return input } })() : input
  const hosts = hostsIn(parsed)
  const query = queryOf(parsed)
  const file = !hosts.length && !query ? fileOf(parsed) : ''
  return { tool: String(tool || '').slice(0, 60), phase: phase || '', ...(hosts.length ? { hosts: hosts.slice(0, 4) } : {}), ...(query ? { query } : {}), ...(file ? { file } : {}) }
}

// one trail per answer: entries in order, the same step looking at the same place counted once
// add → the entry as it stands now ({…, key, n} — a repeat comes back with its count), or null when the tool is not shown
// (lib/turnPlan.js sends it live as turn.step)
export function createTrail(limit = 14) {
  const list = []
  return {
    add(tool, input, phase) {
      if (!tool || /^(write_todos|ls|glob|think|todo)/i.test(tool)) return null
      const e = trailEntry(tool, input, phase)
      const key = `${e.phase}|${(e.hosts || []).join(',')}|${e.query || ''}|${e.file || ''}`
      const same = list.find((x) => x.key === key)
      if (same) { same.n += 1; return { ...same } }
      if (list.length >= limit) return null
      const row = { ...e, key, n: 1 }
      list.push(row)
      return { ...row }
    },
    list: () => list.map(({ key, ...e }) => e),
    // every site this answer read, for the one-line 「조회한 곳」
    hosts: () => [...new Set(list.flatMap((e) => e.hosts || []))],
  }
}
