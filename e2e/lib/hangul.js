// English mode: the Korean still visible on a page — what the runtime translator (src/i18n) missed.
// Used by scripts/i18n-check.mjs (report per screen) and tests/smoke/english.spec.js (assert none).
// User content is not the app's text and is left out: anything under [data-no-i18n], form fields,
// <pre>, contenteditable, and the selectors in USER_CONTENT (chat bubbles the user typed). Agent
// answers stay in: on a fresh account they are the server's own texts (onboarding, notices).
export const USER_CONTENT = [
  '[data-no-i18n]', 'textarea', 'input', 'select', 'pre', '[contenteditable="true"]',
  '.bubble.user', // what the user typed in chat
  'iframe', // embedded editors and panel apps are checked separately
]

/** In the page: {lang, missing, left: [{text, where}]} for visible Hangul outside user content. */
export function collect(extraExclude = []) {
  const sel = [...USER_CONTENT, ...extraExclude].join(',')
  // a function the page runs: kept self-contained
  return [`(${inPage.toString()})(${JSON.stringify(sel)})`]
}

function inPage(sel) {
  const re = /[가-힣]/
  const seen = new Map()
  const visible = (el) => {
    if (!el || !el.getClientRects().length) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const where = (el) => {
    const parts = []
    for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) {
      parts.unshift(e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : ''))
    }
    return parts.join(' > ')
  }
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = n.nodeValue.trim()
    if (!t || !re.test(t)) continue
    const el = n.parentElement
    if (!el || el.closest(sel) || !visible(el)) continue
    if (!seen.has(t)) seen.set(t, where(el))
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
    if (el.closest(sel.replace(/(^|,)(textarea|input|select)(?=,|$)/g, '$1__none__')) || !visible(el)) continue
    for (const a of ['placeholder', 'title', 'aria-label', 'alt']) {
      const v = (el.getAttribute(a) || '').trim()
      if (v && re.test(v) && !seen.has(v)) seen.set(v, `${where(el)} [${a}]`)
    }
  }
  return {
    lang: document.documentElement.lang,
    missing: (window.osI18n && window.osI18n.missing && window.osI18n.missing()) || [],
    left: [...seen].map(([text, w]) => ({ text, where: w })),
  }
}

/** Run the collector on a Playwright page. */
export async function visibleHangul(page, extraExclude = []) {
  const [code] = collect(extraExclude)
  return page.evaluate(code)
}

// Tenant data the screens show (teammates, roles, skills, processes, schedules, folders) is not the
// app's own text; on a shared dev tenant other accounts left it in Korean. Collected from the API
// and set apart: dataOf(get) → strings; isData(text, data) → whether a visible line is only data.
export const DATA_PATHS = ['/team', '/roles', '/roles/catalog', '/skills', '/improve', '/mining/suggestions', '/schedules', '/processes', '/folders', '/folders/people', '/team/threads']
export async function dataOf(get, extra = []) {
  const out = new Set()
  const walk = (v) => {
    if (typeof v === 'string') { if (/[가-힣]/.test(v) && v.length < 5000) out.add(v.trim()) } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  for (const p of [...DATA_PATHS, ...extra]) walk(await get(p).catch(() => null))
  // shown as rendered markdown: without ** and `
  for (const d of [...out]) out.add(d.replace(/\*\*|`/g, ''))
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length)
}
export function isData(t, data) {
  if (t.length === 1) return data.some((d) => d.startsWith(t)) // an avatar initial
  // shown cut short ("…" or a clamp): a piece of one data string
  const cut = t.replace(/(…|\.\.\.)$/, '').trim()
  if (cut.length >= 6 && data.some((d) => d.includes(cut))) return true
  let rest = t
  for (const d of data) if (d.length >= 2 && rest.includes(d)) rest = rest.split(d).join(' ')
  if (!/[가-힣]/.test(rest)) return true
  // data the dictionary translated in part ("구매 에이전트" → "구매 agent"): every Korean word is from the data
  const words = rest.match(/[^\s()·,.:'"“”]*[가-힣][^\s()·,.:'"“”]*/g) || []
  const all = data.join('\n')
  return words.every((w) => all.includes(w))
}
