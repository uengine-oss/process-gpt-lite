// English mode for Process GPT Lite: the screens hardcode Korean, so instead of rewriting every
// component this translates what reaches the screen through one dictionary (ko-en.json) — text
// nodes, placeholder / title / aria-label, alert/confirm, canvas text, Korean date/number formats —
// and keeps doing so as the page changes. Loaded only in English mode (src/i18n/english.js).
//   browser: english.js calls start(window, dict); window.osI18n.tr(text) translates a string and
//            osI18n.missing() lists the Korean it could not translate (scripts/i18n-check.mjs reads it)
//   node:    (await import('…/translate.js')).create(dict).tr(text)
// An ES module on purpose: a UMD wrapper (module.exports) is taken for CommonJS by the bundler.
// Left alone: user input (textarea, contenteditable), <pre>, and anything under [data-no-i18n]
// (user content, a language's own name). Inline <code> only when the dictionary has it word for word.
// Based on the tutorial-video-studio translator; the built-in rules below (relative time, Korean
// dates, 만/억 and 원 amounts, counters and durations) are what this app's screens need.
const HANGUL = /[가-힣]/

const plural = (n, one, many) => (Number(String(n).replace(/,/g, '')) === 1 ? one : many)
// a pattern's English is written for many ("{0} outputs"): with a count of 1 the noun after it is
// made singular ("1 output", "1 variation", "1 person")
const SINGULAR = { people: 'person', processes: 'process', times: 'time', ...Object.fromEntries(['cases', 'rows', 'records', 'outputs', 'steps',
  'items', 'bytes', 'variations', 'files', 'cards', 'days', 'drafts', 'actions', 'messages', 'conversations', 'agents', 'roles', 'forms',
  'scenarios', 'lines', 'hours', 'arrivals', 'formulas', 'characters', 'tables', 'attendees', 'teammates', 'members', 'folders', 'skills',
  'apps', 'versions', 'changes', 'instances', 'runs', 'results', 'tasks', 'documents', 'comments', 'replies', 'mails', 'emails', 'weeks',
  'months', 'years', 'minutes', 'seconds', 'suggestions', 'materials', 'pages', 'images', 'entries', 'branches', 'commits'].map((w) => [w, w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.endsWith('ches') ? w.slice(0, -2) : w.slice(0, -1)])) }
const singular = (s) => s.replace(/(^|[^\d.,])1 ([a-z]+)\b/g, (m, pre, w) => (SINGULAR[w] ? `${pre}1 ${SINGULAR[w]}` : m))
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = { 일: 'Sun', 월: 'Mon', 화: 'Tue', 수: 'Wed', 목: 'Thu', 금: 'Fri', 토: 'Sat' }
const UNIT = { 만: 1e4, 억: 1e8, 천: 1e3 }
const num = (s) => Number(String(s).replace(/,/g, ''))
const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const hm = (h, m, ap) => {
  let hh = Number(h)
  if (ap === '오후' && hh < 12) hh += 12
  if (ap === '오전' && hh === 12) hh = 0
  const suffix = hh >= 12 ? 'PM' : 'AM'
  return `${hh % 12 || 12}${m != null ? ':' + m : ''} ${suffix}`
}
// [regex, (match) => English] — Korean formats the app builds itself (not via toLocaleString)
const RELUNIT = { 초: ['sec', 'sec'], 분: ['min', 'min'], 시간: ['hour', 'hours'], 일: ['day', 'days'], 주: ['week', 'weeks'], 주일: ['week', 'weeks'], 개월: ['month', 'months'], 달: ['month', 'months'], 년: ['year', 'years'] }
const DUR = { 초: (n) => `${n}s`, 분: (n) => `${n} min`, 시간: (n) => `${n} ${plural(n, 'hr', 'hrs')}`, 일: (n) => `${n} ${plural(n, 'day', 'days')}`, 주: (n) => `${n} ${plural(n, 'week', 'weeks')}`, 개월: (n) => `${n} ${plural(n, 'month', 'months')}`, 년: (n) => `${n} ${plural(n, 'year', 'years')}` }
const COUNTER = { 건: (n) => `${n}`, 개: (n) => `${n}`, 명: (n) => `${n} ${plural(n, 'person', 'people')}`, 회: (n) => `${n}×`, 번: (n) => `${n}×`, 곳: (n) => `${n}`, 장: (n) => `${n}`, 줄: (n) => `${n} ${plural(n, 'line', 'lines')}`, 행: (n) => `${n} ${plural(n, 'row', 'rows')}`, 단계: (n) => `${n} ${plural(n, 'step', 'steps')}`, 자: (n) => `${n} ${plural(n, 'char', 'chars')}`, 쪽: (n) => `${n} ${plural(n, 'page', 'pages')}`, 페이지: (n) => `${n} ${plural(n, 'page', 'pages')}`, 개월치: (n) => `${n} months` }
const N = '(\\d[\\d,]*(?:\\.\\d+)?)'
const BUILTIN = [
  [/^(방금|방금 전|지금)$/, (m) => (m[1] === '지금' ? 'now' : 'just now')],
  [/^어제$/, () => 'yesterday'], [/^오늘$/, () => 'today'], [/^내일$/, () => 'tomorrow'], [/^모레$/, () => 'in 2 days'],
  [new RegExp(`^${N}\\s?(초|분|시간|일|주|주일|개월|달|년)\\s?(전|후|뒤)$`), (m) => {
    const [one, many] = RELUNIT[m[2]]
    const u = plural(m[1], one, many)
    return m[3] === '전' ? `${m[1]} ${u} ago` : `in ${m[1]} ${u}`
  }],
  // 2026년 10월 28일 (화) 오후 3:20 · 10월 28일 · 10월 28일 15:20 · 2026년 10월
  [/^(?:(\d{4})년\s?)?(\d{1,2})월\s?(\d{1,2})일(?:\s?\(?([일월화수목금토])(?:요일)?\)?)?(?:\s+(오전|오후)?\s?(\d{1,2}):(\d{2}))?$/, (m) => {
    let s = `${m[4] ? WEEKDAYS[m[4]] + ', ' : ''}${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}${m[1] ? ', ' + m[1] : ''}`
    if (m[6]) s += `, ${hm(m[6], m[7], m[5])}`
    return s
  }],
  [/^(\d{4})년\s?(\d{1,2})월$/, (m) => `${MONTHS[Number(m[2]) - 1]} ${m[1]}`],
  [/^(\d{4})년$/, (m) => m[1]],
  [/^(\d{1,2})월$/, (m) => MONTHS[Number(m[1]) - 1]],
  // 2026. 10. 28. (ko-KR toLocaleDateString) · 오후 3:20 · 오후 3시 20분 · 3시
  [/^(\d{4})\. ?(\d{1,2})\. ?(\d{1,2})\.?(?:\s+(오전|오후)\s?(\d{1,2}):(\d{2})(?::\d{2})?)?$/, (m) => `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}${m[5] ? ', ' + hm(m[5], m[6], m[4]) : ''}`],
  [/^(오전|오후)\s?(\d{1,2}):(\d{2})(?::\d{2})?$/, (m) => hm(m[2], m[3], m[1])],
  [/^(오전|오후)?\s?(\d{1,2})시(?:\s?(\d{1,2})분)?$/, (m) => hm(m[2], m[3] != null ? String(m[3]).padStart(2, '0') : null, m[1] || (Number(m[2]) >= 12 ? '오후' : '오전'))],
  [/^매일 (오전|오후)?\s?(\d{1,2})시(?:\s?(\d{1,2})분)?$/, (m) => `Daily at ${hm(m[2], m[3] != null ? String(m[3]).padStart(2, '0') : null, m[1] || (Number(m[2]) >= 12 ? '오후' : '오전'))}`],
  // amounts: 3만 · 1.2억 · 12,000원 · 3만 원 · 4,850만원 · 약 1.2억 원
  [new RegExp(`^(약 )?${N}\\s?(만|억|천)\\s?원$`), (m) => `${m[1] ? '~' : ''}₩${grouped.format(Math.round(num(m[2]) * UNIT[m[3]]))}`],
  [new RegExp(`^(약 )?${N}\\s?원$`), (m) => `${m[1] ? '~' : ''}₩${m[2]}`],
  [new RegExp(`^(약 )?${N}\\s?(만|억)$`), (m) => `${m[1] ? '~' : ''}${compact.format(num(m[2]) * UNIT[m[3]])}`],
  // durations and counters: 3.2일 · 45분 · 2시간 · 1시간 20분 · 3건 · 4명 · 2회
  [new RegExp(`^(약 |총 |최대 |최소 )?${N}\\s?(초|분|시간|일|주|개월|년)$`), (m) => (m[1] ? { '약 ': '~', '총 ': '', '최대 ': 'up to ', '최소 ': 'at least ' }[m[1]] : '') + DUR[m[3]](m[2])],
  [/^(\d+)\s?시간\s?(\d+)\s?분$/, (m) => `${m[1]}h ${m[2]}m`],
  [/^(\d+)\s?분\s?(\d+)\s?초$/, (m) => `${m[1]}m ${m[2]}s`],
  [/^(\d+)\s?일\s?(\d+)\s?시간$/, (m) => `${m[1]}d ${m[2]}h`],
  [new RegExp(`^(총 |약 )?${N}\\s?(건|개|명|회|번|곳|장|줄|행|단계|자|쪽|페이지)(째)?$`), (m) => (m[1] === '약 ' ? '~' : '') + (m[4] ? `#${m[2]}` : COUNTER[m[3]](m[2]))],
]

// A text with line breaks ("…실패했어요: {0}\n다음 예약 시각에…") reaches the screen line by line
// once markdown turns the breaks into <br>: each line becomes an entry of its own too.
function byLine(dict) {
  const exact = { ...((dict && dict.exact) || {}) }
  const patterns = [...((dict && dict.patterns) || [])]
  const have = new Set(patterns.map((p) => p[0]))
  const ph = (s) => (s.match(/\{\d+(?::[^}]*)?\}/g) || []).map((x) => x.replace(/:.*\}/, '}')).sort().join()
  for (const [ko, en] of Object.entries(exact)) {
    const k = ko.split('\n'), e = en.split('\n')
    if (k.length > 1 && k.length === e.length) k.forEach((l, i) => { if (HANGUL.test(l) && !(l.trim() in exact)) exact[l.trim()] = e[i].trim() })
  }
  for (const [ko, en] of (dict && dict.patterns) || []) {
    const k = ko.split('\n'), e = en.split('\n')
    if (k.length < 2 || k.length !== e.length) continue
    k.forEach((l, i) => {
      const line = l.trim()
      if (!HANGUL.test(line) || have.has(line) || ph(line) !== ph(e[i])) return
      if (/\{\d+\}/.test(line)) { patterns.push([line, e[i].trim()]); have.add(line) } else if (!(line in exact)) exact[line] = e[i].trim()
    })
  }
  return { ...dict, exact, patterns }
}

function create(dict) {
  dict = byLine(dict)
  const exact = (dict && dict.exact) || {}
  // where the same Korean means something else: [css selector, Korean, English]
  const context = (dict && dict.context) || []
  // A placeholder written right against Korean text ("{0}일", "시작{0}") must not take part of a
  // Korean word: its value may not have Hangul at that join ("메일" is not "{0}일" with "메").
  const pats = ((dict && dict.patterns) || []).map(([ko, en]) => {
    const parts = ko.split(/\{(\d+)\}/)
    let re = '^'
    let loose = '^'
    const order = []
    const glue = []
    parts.forEach((p, i) => {
      if (i % 2) {
        re += '([\\s\\S]+?)'
        loose += '([\\s\\S]*?)'
        order.push(Number(p))
        glue.push([HANGUL.test(parts[i - 1].slice(-1)), HANGUL.test((parts[i + 1] || '').slice(0, 1)), (parts[i + 1] || '').startsWith('님')])
      } else {
        const lit = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        re += lit
        loose += lit.replace(/ /g, ' ?')
      }
    })
    // loose (second pass): a variable part may be empty — a field not loaded yet, " · 내 권한 소유"
    return { re: new RegExp(re + '$'), loose: new RegExp(loose + '$'), order, glue, en, lit: ko.replace(/\{\d+\}|\s/g, '').length }
  }).sort((a, b) => b.lit - a.lit || a.order.length - b.order.length) // most fixed text first, then fewest variables
  // a part glued to Korean text: no whitespace at the join, and Hangul there only when the part
  // translates completely ("18.9시간이 되지만" is fine, "메일" is not "{0}일" with "메")
  // ("{0}님…": the part before the honorific is a person's name — "장진영님의 에이전트" is "장진영's agent", the
  // name's last letter is not a cut word)
  const glued = (p, m, vals) => p.glue.some(([before, after, honorific], i) => {
    const v = m[i + 1]
    const a = before && v.slice(0, 1), b = after && v.slice(-1)
    if ((a && /\s/.test(a)) || (b && /\s/.test(b))) return true
    return ((a && HANGUL.test(a)) || (b && !honorific && HANGUL.test(b))) && HANGUL.test(vals[p.order[i]])
  })
  // "재무 검토를": a variable part with a Korean particle — translate the word without it
  const PARTICLE = /^([\s\S]*[^\s])(을|를|이|가|은|는|와|과|으로|로|의|에게|에서|에|님)$/
  const value = (v) => {
    const t = tr(v)
    if (!HANGUL.test(t)) return t
    const m = v.match(PARTICLE)
    if (m) { const st = tr(m[1]); if (!HANGUL.test(st)) return st }
    return t
  }
  const cache = new Map()
  const missing = new Set()

  // a file name is the person's (or the agent's) data: only an exact entry may change it
  const FILE = /\.(xlsx|xlsm|xls|csv|docx|doc|pptx|hwpx|hwp|pdf|md|txt|html?|png|jpe?g|gif|webp|svg|dxf|dwg|mp4|mov|webm|wav|mp3|m4a|zip|json|psd)$/i
  function core(s) {
    if (Object.prototype.hasOwnProperty.call(exact, s)) return exact[s]
    // (a sentence that only ends with a file name — "자료를 찾았어요 · Quote Tracker.xlsx" — is not a file name)
    if (FILE.test(s) && !s.includes(' · ')) return undefined
    for (const [re, fn] of BUILTIN) { const m = s.match(re); if (m) return fn(m) }
    for (const loose of [false, true]) for (const p of pats) {
      const m = s.match(loose ? p.loose : p.re)
      if (!m) continue
      const vals = {}
      p.order.forEach((n, i) => { vals[n] = value(m[i + 1]) })
      if (glued(p, m, vals)) continue
      if (loose && p.order.some((n) => HANGUL.test(vals[n]))) continue
      // a short pattern ("예약 {0}") whose variable part stays Korean is cutting a sentence apart
      if (p.lit <= 3 && p.order.some((n) => HANGUL.test(vals[n]))) continue
      // {0:만} / {0:억}: a count of 10,000s / 100,000,000s (Korean amounts) as a full number
      const out = p.en.replace(/\{(\d+)(?::(만|억|천))?\}/g, (_, n, u) => {
        const v = vals[n] == null ? '' : vals[n]
        return u && Number.isFinite(num(v)) && v !== '' ? grouped.format(Math.round(num(v) * UNIT[u])) : v
      })
      return Object.values(vals).includes('1') ? singular(out) : out
    }
    return undefined
  }
  /** Translated text, keeping the surrounding whitespace; the input itself when there is no entry. */
  let depth = 0 // missing() lists whole strings, not the parts patterns try
  function tr(s) {
    if (typeof s !== 'string' || !HANGUL.test(s)) return s
    if (cache.has(s)) return cache.get(s)
    depth++
    try { return trBody(s) } finally { depth-- }
  }
  function trBody(s) {
    const [, lead, body, tail] = s.match(/^(\s*)([\s\S]*?)(\s*)$/)
    let out = core(body)
    if (out === undefined) {
      // an icon or mark glued to a known string: "▤ 자원 닫기", "✓ 완료", "· 진행 중"
      const m = body.match(/^([^\p{L}\p{N}]*)([\s\S]*?\p{L}[\s\S]*?)([^\p{L}\p{N}]*)$/u)
      if (m && (m[1] || m[3])) { const t = core(m[2]); if (t !== undefined) out = m[1] + t + m[3] }
      // only the leading mark ("= …(합이 100%)") or only the trailing one
      if (out === undefined && m && m[1] && m[3]) { const t = core(m[2] + m[3]); if (t !== undefined) out = m[1] + t }
      if (out === undefined && m && m[1] && m[3]) { const t = core(m[1] + m[2]); if (t !== undefined) out = t + m[3] }
    }
    if (out === undefined && body.includes('\n')) {
      const lines = body.split('\n').map((l) => tr(l))
      if (lines.some((l, i) => l !== body.split('\n')[i])) out = lines.join('\n')
    }
    for (const sep of [' · ', ', ', ' → ', ' — ']) {
      // "3건 · 진행 중", "김민지(편집), 박서연(보기)", "2.5일 → 1.3일", "실행 — 변형 만들기·에이전트 실행" — parts joined by a separator, each a known string
      if (out !== undefined || !body.includes(sep)) continue
      const parts = body.split(sep).map((p) => tr(p))
      if (!parts.some((p) => HANGUL.test(p))) out = parts.join(sep)
    }
    if (out === undefined) { if (depth === 1) missing.add(body); out = body }
    out = lead + out + tail
    if (depth === 1 || !HANGUL.test(out)) cache.set(s, out)
    return out
  }
  /** Only what the dictionary has word for word — for inline <code>, which may hold real code. */
  const exactOnly = (s) => {
    const [, lead, body, tail] = s.match(/^(\s*)([\s\S]*?)(\s*)$/)
    return Object.prototype.hasOwnProperty.call(exact, body) ? lead + exact[body] + tail : s
  }
  /** The context entry for this text inside `el`, if one applies. */
  const inContext = (el, s) => {
    const body = s.trim()
    for (const [sel, ko, en] of context) if (ko === body && el.closest(sel)) return s.replace(body, en)
    return undefined
  }
  return { tr, exactOnly, inContext, missing: () => [...missing] }
}

function install(win, t) {
  const doc = win.document
  const ATTRS = ['placeholder', 'data-placeholder', 'title', 'aria-label', 'alt', 'label', 'data-tooltip']
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'PRE', 'NOSCRIPT'])
  // user content: what the person typed in chat, terminal output, anything marked data-no-i18n
const USER = 'pre, [data-no-i18n], .xterm, .bubble.user'
const userText = (el) => el && (SKIP.has(el.tagName) || el.isContentEditable || !!el.closest(USER))
  function text(node) {
    const v = node.nodeValue
    if (!HANGUL.test(v) || userText(node.parentElement)) return
    // inline <code> may be real code: only what the dictionary has word for word
    const el = node.parentElement
    const out = (el && t.inContext(el, v)) || (el && el.closest('code') ? t.exactOnly(v) : t.tr(v))
    if (out !== v) node.nodeValue = out
  }
  function attrs(el) {
    if (el.closest && el.closest('[data-no-i18n], .xterm')) return
    for (const a of ATTRS) {
      const v = el.getAttribute(a)
      if (v && HANGUL.test(v)) { const out = t.tr(v); if (out !== v) el.setAttribute(a, out) }
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(el.type) && HANGUL.test(el.value)) el.value = t.tr(el.value)
  }
  function walk(node) {
    if (node.nodeType === 3) return text(node)
    if (node.nodeType !== 1 && node.nodeType !== 11) return
    if (node.nodeType === 1) {
      attrs(node)
      if (userText(node)) return
      if (node.shadowRoot) { walk(node.shadowRoot); observe(node.shadowRoot) }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c)
  }
  function observe(target) {
    new win.MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') text(m.target)
        else if (m.type === 'attributes') attrs(m.target)
        else m.addedNodes.forEach(walk)
      }
    }).observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
  }
  // dialogs
  for (const fn of ['alert', 'confirm', 'prompt']) {
    const orig = win[fn]
    if (orig) win[fn] = function (msg, ...rest) { return orig.call(win, t.tr(msg), ...rest) }
  }
  // canvas text: measure and draw the same translated string
  for (const C of [win.CanvasRenderingContext2D, win.OffscreenCanvasRenderingContext2D]) {
    if (!C) continue
    for (const m of ['fillText', 'strokeText', 'measureText']) {
      const orig = C.prototype[m]
      C.prototype[m] = function (s, ...rest) { return orig.call(this, t.tr(s), ...rest) }
    }
  }
  // dates and numbers: Korean (or unspecified) locale → en-US
  const en = (l) => (l == null || (typeof l === 'string' && /^ko\b/i.test(l)) || (Array.isArray(l) && l.some((x) => /^ko\b/i.test(x))) ? 'en-US' : l)
  for (const [C, ms] of [[win.Date, ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']], [win.Number, ['toLocaleString']]]) {
    for (const m of ms) { const orig = C.prototype[m]; C.prototype[m] = function (l, o) { return orig.call(this, en(l), o) } }
  }
  for (const name of ['DateTimeFormat', 'NumberFormat', 'RelativeTimeFormat', 'PluralRules', 'ListFormat']) {
    const Orig = win.Intl[name]
    if (!Orig) continue
    const Wrapped = function (l, o) { return new Orig(en(l), o) }
    Wrapped.prototype = Orig.prototype
    Wrapped.supportedLocalesOf = Orig.supportedLocalesOf
    win.Intl[name] = Wrapped
  }
  doc.documentElement.lang = 'en'
  const start = () => { walk(doc.documentElement); observe(doc.documentElement) }
  if (doc.documentElement) start()
}

/** Install the translator on a page (English mode) and expose window.osI18n. */
function start(win, dict) {
  const t = create(dict)
  win.osI18n = { lang: 'en', tr: t.tr, missing: t.missing }
  install(win, t)
  return t
}

export { create, install, start }
