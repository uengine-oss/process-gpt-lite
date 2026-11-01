// 메일로 온 인증 코드. A browser task waiting on a one-time code (lib/browser.js need_secret) also looks in the
// person's own connected mailbox (lib/mail.js recentMail: gmail, imap or the demo mailbox) for the mail the site sent:
// one that came after the code was asked for (from a little before — the site sends it as the code page opens), from
// the site — its sender's domain is the site's, or it names the site (the name in the page title, the host) — and not
// used for a code before. The code comes out by rule, not by a model: a 4–8 character code next to the words that name
// it. It goes straight into the field and is kept nowhere: not in the model's messages, the chat or the audit log.
import { q } from './supa.js'
import { recentMail } from './mail.js'

// the words a verification mail names its code with
const WORDS = /인증\s*(코드|번호)|확인\s*(코드|번호)|보안\s*코드|일회용|승인\s*번호|인증|코드|verification|verify|one[-\s]?time|passcode|security\s+code|sign[-\s]?in\s+code|login\s+code|\bcode\b|\botp\b|\bpin\b/gi
// a 4–8 digit code (G-123456 too), not a part of a date, a time, a phone or order number, an amount or a count
// (a full stop after it ends the sentence; a digit after the point makes it a decimal or a date)
const DIGITS = /(?<![\w.,:/#$₩-])(?:[A-Z]-)?(\d{4,8})(?![\w,:/-]|\.\d|\s?(원|won|krw|달러|usd|%|년|월|일|시|분|초|개|건|명|회|번째))/gi
// or 6–8 capitals and digits mixed (K7Q2ZP)
const MIXED = /(?<![\w-])(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])([A-Z0-9]{6,8})(?![\w-])/g

// The code in a mail's subject and text, or null. The candidate nearest after (or just before) the words that
// name it wins; one far from any such word is not taken.
export function extractCode(text) {
  const t = String(text || '')
  const words = [...t.matchAll(WORDS)].map((m) => [m.index, m.index + m[0].length])
  if (!words.length) return null
  const cands = [...[...t.matchAll(DIGITS)].map((m) => ({ code: m[1], at: m.index + m[0].length - m[1].length, len: m[1].length })),
    ...[...t.matchAll(MIXED)].map((m) => ({ code: m[1], at: m.index, len: m[1].length }))]
  let best = null
  for (const c of cands) {
    // characters between the code and the nearest naming word: after it counts once, before it twice
    const d = Math.min(...words.map(([s, e]) => (e <= c.at ? c.at - e : s >= c.at + c.len ? 2 * (s - (c.at + c.len)) : 0)))
    if (d > 80) continue
    // a year (© 2026) is a code only when nothing else is
    const score = 100 - d + (c.len === 6 ? 10 : 0) + (/^\d+$/.test(c.code) ? 5 : 0) - (/^(19|20)\d\d$/.test(c.code) ? 40 : 0)
    if (!best || score > best.score) best = { ...c, score }
  }
  return best?.code || null
}

const domainOf = (from) => (/@([\w.-]+)/.exec(String(from || ''))?.[1] || '').toLowerCase()
const SECOND = new Set(['co', 'or', 'go', 'ac', 'ne', 're', 'com', 'net', 'org', 'gov', 'edu'])
// the part of a host a company owns (accounts.shop.example → shop.example, mail.naver.co.kr → naver.co.kr); an
// address or a single name is itself
export function registrable(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '')
  if (/^\d+(\.\d+){3}$/.test(h) || !h.includes('.')) return h
  const p = h.split('.')
  return p.slice(SECOND.has(p.at(-2)) && p.at(-1).length === 2 ? -3 : -2).join('.')
}

// The site's own names for matching a mail: the parts of the page title that are not the page's purpose
// ("인증 코드 · 테스트 상점" → 테스트 상점)
const GENERIC = /로그인|인증|코드|확인|계정|비밀번호|sign|log\s?in|verif|code|account|password|security/i
export const namesOf = (title) => String(title || '').split(/\s[·|–—:-]\s|\s\|\s/).map((s) => s.trim()).filter((s) => s.length >= 2 && !GENERIC.test(s))

// Whether a mail is the site's: 'domain' (its sender's domain is the site's), 'name' (it names the site), or null
export function fromSite(mail, { site, names = [] }) {
  const s = registrable(site), d = registrable(domainOf(mail.from))
  if (s && d && s === d && s.includes('.') && !/^\d+(\.\d+){3}$/.test(s)) return 'domain'
  const hay = `${mail.from || ''}\n${mail.subject || ''}\n${mail.text || ''}`.toLowerCase()
  if (names.some((n) => hay.includes(n.toLowerCase()))) return 'name'
  if (site && hay.includes(String(site).toLowerCase())) return 'name'
  return null
}

// The code from the newest fitting mail: the site's sender before a mail that only names the site, newer first
export function pickCode(mails, { site, names = [], since = 0, used = new Set() }) {
  const fit = mails
    .filter((m) => !used.has(m.id) && (!m.date || Date.parse(m.date) >= since))
    .map((m) => ({ m, how: fromSite(m, { site, names }) }))
    .filter((x) => x.how)
    .sort((a, b) => (b.how === 'domain') - (a.how === 'domain') || Date.parse(b.m.date || 0) - Date.parse(a.m.date || 0))
  for (const { m, how } of fit) {
    const code = extractCode(`${m.subject || ''}\n${m.text || ''}`)
    if (code) return { id: m.id, code, how, from: domainOf(m.from) || String(m.from || ''), at: m.date || null }
  }
  return null
}

// on for a person who has a mailbox connected, unless they turned it off (Settings › 보안)
export async function enabledFor(userId) {
  const [r] = await q(`select a.provider, coalesce(p.mail_codes, true) as on from pro_mail_accounts a left join pro_profile p on p.user_id = a.user_id where a.user_id=$1`, [userId])
  return !!r?.on
}

// mails already used for a code, per person (a code is used once)
const usedBy = new Map()
const SLACK = 3 * 60000
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })

// Watches the mailbox until the site's code comes, the wait is over, or the signal aborts (the person typed it,
// the task ended). Resolves { code, from, how, at } or null.
export async function watchForCode(userId, { site, names = [], since = Date.now(), timeoutMs = 180000, every = 3000, signal } = {}) {
  const used = usedBy.get(userId) || usedBy.set(userId, new Set()).get(userId)
  const end = Date.now() + timeoutMs
  while (!signal?.aborted && Date.now() < end) {
    let mails = []
    try { mails = await recentMail(userId, since - SLACK) } catch (e) { console.warn('[mail-code]', e.message) }
    const found = pickCode(mails, { site, names, since: since - SLACK, used })
    if (found && !signal?.aborted) { used.add(found.id); return found }
    await sleep(every, signal)
  }
  return null
}
