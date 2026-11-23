// Personal data that has a written form (resident registration numbers, mobile numbers, e-mail addresses,
// bank-account-like numbers): found by pattern, counted by distinct value, never kept. A hit means the form is
// there, not that something is wrong: a form sample, an order number or a signature matches too, so a hit goes to a
// person (spec pgpt-pro_agentic-guardrails). Whether a text is sensitive is another question: lib/context/sensitive.js.
export const ADDR = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
const EMAIL_G = new RegExp(ADDR.source, 'g')
const PII = [
  // 주민등록번호·외국인등록번호: YYMMDD-Gnnnnnn with a plausible date
  ['resident_id', /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s?-\s?[1-8]\d{6}(?!\d)/g],
  // 휴대전화: 010-1234-5678, 010 1234 5678, 01012345678, +82 10-1234-5678
  ['mobile', /(?:\+82[-.\s]?|(?<![\d+])0)1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g],
  ['email', EMAIL_G],
  // 계좌번호처럼 보이는 수: hyphenated groups (110-123-456789, 123456-01-123456, 3333-01-1234567); 11–14 digits and
  // not starting with 0 keeps out phone and area-code numbers, dates and business registration numbers (10 digits)
  ['bank_account', /(?<![\d-])[1-9]\d{1,5}(?:-\d{2,7}){2,3}(?![\d-])/g],
]
const digits = (s) => s.replace(/\D/g, '')
const KEEP = { bank_account: (v) => digits(v).length >= 11 && digits(v).length <= 14 }

// {count, kinds, byKind}; the addresses of the people on the mail (recipients, sender) are not disclosed by
// naming them, so they do not count
export function findPii(text, { except = [] } = {}) {
  const skip = new Set(except.map((s) => String(s).toLowerCase()))
  const byKind = {}
  for (const [kind, re] of PII) {
    const seen = new Set()
    for (const m of String(text || '').matchAll(re)) {
      const v = kind === 'email' ? m[0].toLowerCase() : digits(m[0])
      if ((kind === 'email' && skip.has(v)) || (KEEP[kind] && !KEEP[kind](m[0]))) continue
      seen.add(v)
    }
    if (seen.size) byKind[kind] = seen.size
  }
  const count = Object.values(byKind).reduce((s, n) => s + n, 0)
  return { count, kinds: Object.keys(byKind), byKind }
}
// what the ledger line and a notification title show of the mail's own subject: personal data masked
export const maskPii = (s) => PII.reduce((t, [kind, re]) => t.replace(re, (m) => (KEEP[kind] && !KEEP[kind](m) ? m : '•••')), String(s || ''))
