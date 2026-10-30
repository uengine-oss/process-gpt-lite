// Plans as data (note: [Korean, English]). Lite applies a plan by turning each seat into LiteLLM limits
// (lib/plans/apply.js): a short usage window on the person's key, a longer one on their membership in the
// company, the models the seat may use and how fast, and — on pooled plans — the company's monthly pool on
// its team. PRO_PLAN_CATALOG picks one (default uengine).
//
//   uengine Process GPT's own plans (process-gpt openspec tenant-credit-billing, agreed 2026-09): 1 credit =
//           ₩10, sold at model cost × ₩1,450/USD × markup 2.2. Free (the company's 1,000 credits a month),
//           Team ₩19,000 and Business ₩39,000 a seat a month (yearly ₩16,000 / ₩33,000; 1,500 / 4,000 credits
//           a seat), Enterprise by contract (usage at the same rate, admin limits). Seats pool their credits
//           in the company; beyond the pool, the credits the company bought (extra usage). Claude-style
//           fairness on top: a 5-hour session may use a quarter of a seat's credits, a person at most twice
//           their seat's in a month (PRO_PLAN_SESSION_SHARE, PRO_PLAN_PERSON_SHARE; an admin may set a
//           person's own monthly limit instead).
//   claude  claude.com/pricing (2026-10-30) — Free · Pro (5x Free a session) · Max 5x · Max 20x (of Pro);
//           Team (Standard / Premium = 5x Standard, 2–150 seats) and Enterprise (seat + usage, admin limits).
//           5-hour session limits on every plan, weekly limits on paid ones, then "extra usage".
//   hark    Hark's coverage (layer3labs, usecarly, 2026-10) — Free · Pro 2x ($20) · Pro 10x ($100): the same
//           features on every plan; only how much it does in the billing cycle changes.
//
// Usage is counted in model cost (USD, LiteLLM's spend); uengine shows it as credits. claude / hark scale a
// baseline: PRO_PLAN_UNIT_SESSION_USD (one Free 5-hour session), _WEEK_USD (one Free week), _MONTH_USD (hark's
// Free month). PRO_PLAN_SCALE multiplies every limit (1; tests make it tiny). Model tiers: fast / standard /
// pro (PRO_LLM_FAST_MODEL / PRO_LLM_MODEL / PRO_LLM_PRO_MODEL).
import { config } from '../../config.js'

const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d)
export const unit = () => ({
  session: num('PRO_PLAN_UNIT_SESSION_USD', 0.4),
  week: num('PRO_PLAN_UNIT_WEEK_USD', 2.4),
  month: num('PRO_PLAN_UNIT_MONTH_USD', 6),
})
const scale = () => num('PRO_PLAN_SCALE', 1)
const shares = () => ({ session: num('PRO_PLAN_SESSION_SHARE', 0.25), person: num('PRO_PLAN_PERSON_SHARE', 2) })
// what one credit buys in model cost: ₩10 ÷ (₩1,450 a dollar × markup 2.2)
export const usdPerCredit = () => num('PRO_CREDIT_KRW', 10) / (num('PRO_FX_KRW_PER_USD', 1450) * num('PRO_MARKUP', 2.2))
export const creditsOf = (usd) => Math.round((Number(usd) || 0) / usdPerCredit())

const ALL = ['fast', 'standard', 'pro']
export const CATALOGS = {
  uengine: {
    name: 'Process GPT', source: null, currency: 'KRW', unit: 'credit', vat: 0.1,
    windows: { session: '5h', period: '30d' }, pooled: true,
    plans: {
      free: { name: 'Free', kind: 'company', seats: ['free'], fixedPool: 1000, note: ['회사에 매달 1,000크레딧 · 기본 모델', '1,000 credits a month for the company · standard models'] },
      team: { name: 'Team', kind: 'company', seats: ['team'], extraUsage: true, adminLimits: true, note: ['좌석당 매달 1,500크레딧을 회사가 함께 · 충전 크레딧', '1,500 credits a seat a month, shared · purchased credits'] },
      business: { name: 'Business', kind: 'company', seats: ['business'], extraUsage: true, adminLimits: true, note: ['좌석당 4,000크레딧 · 고급 모델 · 충전 크레딧', '4,000 credits a seat · advanced models · purchased credits'] },
      enterprise: { name: 'Enterprise', kind: 'company', seats: ['enterprise'], usageBased: true, adminLimits: true, contract: true, note: ['사용한 만큼(같은 요율) · 관리자 지출 한도 · 계약', 'Usage at the same rate · admin spend limits · by contract'] },
    },
    seats: {
      free: { name: 'Free', price: { month: 0 }, credits: 1000, models: ['fast', 'standard'], rpm: 10, parallel: 2 },
      team: { name: 'Team', price: { month: 19000, year: 16000 }, credits: 1500, models: ['fast', 'standard'], rpm: 30, parallel: 4 },
      business: { name: 'Business', price: { month: 39000, year: 33000 }, credits: 4000, models: ALL, rpm: 60, parallel: 8 },
      enterprise: { name: 'Enterprise', price: null, credits: null, models: ALL, rpm: 120, parallel: 16, usageBased: true },
    },
  },
  claude: {
    name: 'Claude', source: 'https://claude.com/pricing', currency: 'USD', unit: 'usd',
    windows: { session: '5h', period: '7d' },
    plans: {
      free: { name: 'Free', kind: 'personal', seats: ['free'], note: ['일상적인 질문과 가벼운 업무', 'Everyday questions and light work'] },
      pro: { name: 'Pro', kind: 'personal', seats: ['pro'], note: ['세션당 Free의 5배 · 주간 한도', '5x Free per session · weekly limit'] },
      max5: { name: 'Max 5x', kind: 'personal', seats: ['max5'], note: ['Pro의 5배', '5x Pro'] },
      max20: { name: 'Max 20x', kind: 'personal', seats: ['max20'], note: ['Pro의 20배', '20x Pro'] },
      team: { name: 'Team', kind: 'company', seats: ['standard', 'premium'], minSeats: 2, maxSeats: 150, extraUsage: true, adminLimits: true, note: ['좌석제 · 관리자 한도 · 추가 사용량', 'Seats · admin limits · extra usage'] },
      enterprise: { name: 'Enterprise', kind: 'company', seats: ['enterprise'], minSeats: 20, usageBased: true, adminLimits: true, note: ['좌석 + 사용량(원가) · 관리자 지출 한도', 'Seats + usage at cost · admin spend limits'] },
    },
    seats: {
      free: { name: 'Free', price: { month: 0 }, x: 1, weekly: false, models: ['fast', 'standard'], rpm: 10, parallel: 2 },
      pro: { name: 'Pro', price: { month: 20, year: 17 }, x: 5, models: ALL, rpm: 30, parallel: 4 },
      max5: { name: 'Max 5x', price: { month: 100 }, x: 25, models: ALL, rpm: 60, parallel: 8 },
      max20: { name: 'Max 20x', price: { month: 200 }, x: 100, models: ALL, rpm: 120, parallel: 8 },
      standard: { name: 'Team Standard', price: { month: 25, year: 20 }, x: 6, models: ALL, rpm: 30, parallel: 4 },
      premium: { name: 'Team Premium', price: { month: 125, year: 100 }, x: 30, models: ALL, rpm: 60, parallel: 8 },
      // no session or weekly window: what the person uses is billed at cost, up to the limits admins set
      enterprise: { name: 'Enterprise', price: { year: 20 }, x: null, models: ALL, rpm: 120, parallel: 16, usageBased: true },
    },
  },
  hark: {
    name: 'Hark', source: 'https://www.layer3labs.io/guides/hark-pro-pricing', currency: 'USD', unit: 'usd',
    windows: { session: null, period: '30d' },
    plans: {
      free: { name: 'Free', kind: 'personal', seats: ['free'], note: ['모든 기능 · 기본 사용량', 'Every feature · baseline usage'] },
      pro2: { name: 'Pro 2x', kind: 'personal', seats: ['pro2'], note: ['모든 기능 · 사용량 2배', 'Every feature · 2x usage'] },
      pro10: { name: 'Pro 10x', kind: 'personal', seats: ['pro10'], note: ['모든 기능 · 사용량 10배', 'Every feature · 10x usage'] },
    },
    seats: {
      free: { name: 'Free', price: { month: 0 }, x: 1, models: ALL, rpm: 20, parallel: 3 },
      pro2: { name: 'Pro 2x', price: { month: 20 }, x: 2, models: ALL, rpm: 30, parallel: 6 },
      pro10: { name: 'Pro 10x', price: { month: 100 }, x: 10, models: ALL, rpm: 60, parallel: 6 },
    },
  },
}

export const catalogName = () => (CATALOGS[process.env.PRO_PLAN_CATALOG] ? process.env.PRO_PLAN_CATALOG : 'uengine')
export const catalog = (name = catalogName()) => CATALOGS[name]
export const defaultPlan = () => 'free'
// a plan's seat for a new member: its first (Claude Team: Standard)
export const defaultSeat = (plan, name) => catalog(name).plans[plan]?.seats[0] || 'free'

// model aliases of the tiers a seat may use
export function modelsOf(tiers) {
  const alias = { fast: config.llm.fastModel, standard: config.llm.model, pro: process.env.PRO_LLM_PRO_MODEL || config.llm.model }
  return [...new Set(tiers.map((t) => alias[t]).filter(Boolean))]
}

const round = (v) => Math.round(v * 1e6) / 1e6

// a seat's monthly credits in model cost (USD), as this install scales it
export const seatUsd = (s) => round(s.credits * usdPerCredit() * scale())

// What a seat means in LiteLLM: session (key budget, short window), period (membership budget: the week, the
// billing month, or a pooled plan's fair share of a month), models, rpm, parallel. limitUsd: an
// administrator's monthly limit for the person, which replaces the period (Claude: only when lower, or on a
// usage-based seat).
export function limitsOf(seatCode, { name = catalogName(), limitUsd = null } = {}) {
  const c = catalog(name)
  const s = c.seats[seatCode]
  if (!s) throw Object.assign(new Error(`unknown seat ${seatCode}`), { status: 400 })
  let session = null, period = null
  if (s.credits != null) {
    const usd = seatUsd(s), sh = shares()
    session = { usd: round(usd * sh.session), duration: c.windows.session }
    period = { usd: round(usd * sh.person), duration: c.windows.period }
  } else if (s.x != null) {
    const u = unit(), k = scale()
    if (c.windows.session) session = { usd: round(u.session * s.x * k), duration: c.windows.session }
    if (s.weekly !== false && c.windows.period) period = { usd: round((c.windows.period === '7d' ? u.week : u.month) * s.x * k), duration: c.windows.period }
  }
  if (limitUsd != null && (c.pooled || s.usageBased || !period || limitUsd < period.usd)) period = { usd: Number(limitUsd), duration: '30d', byAdmin: true }
  return { seat: seatCode, name: s.name, session, period, models: modelsOf(s.models), rpm: s.rpm, parallel: s.parallel, usageBased: !!s.usageBased }
}

// a pooled plan's monthly pool for the company (USD): its fixed pool, or every seat's credits (at least the
// plan's minimum seats); null where the plan has none
export function poolUsd(plan, seats, name = catalogName()) {
  const c = catalog(name)
  if (!c.pooled) return null
  const p = c.plans[plan]
  if (p.usageBased) return null
  if (p.fixedPool) return round(p.fixedPool * usdPerCredit() * scale())
  const n = Math.max(seats.length, p.minSeats || 0)
  const each = c.seats[p.seats[0]]
  return round(seats.reduce((a, s) => a + seatUsd(c.seats[s] || each), 0) + Math.max(0, n - seats.length) * seatUsd(each))
}

// the month's bill: seats × seat price (at least the plan's minimum), then usage beyond the seats — credits
// at ₩10 on uengine, at cost in USD on the others — and VAT where the catalog has it
export function monthlyBill({ plan, billing = 'month', seats, extraSpent = 0, usageSpent = 0, name = catalogName() }) {
  const c = catalog(name)
  const p = c.plans[plan]
  const credit = c.unit === 'credit'
  const money = (usd) => (credit ? creditsOf(usd) * num('PRO_CREDIT_KRW', 10) : round(usd))
  const lines = []
  const count = {}
  for (const s of seats) count[s] = (count[s] || 0) + 1
  const total = Object.values(count).reduce((a, b) => a + b, 0)
  if (p.minSeats && total < p.minSeats) count[p.seats[0]] = (count[p.seats[0]] || 0) + (p.minSeats - total)
  for (const [s, n] of Object.entries(count)) {
    const price = c.seats[s].price
    if (!price) { lines.push({ kind: 'seat', seat: s, name: c.seats[s].name, count: n, each: null, amount: 0, contract: true }); continue }
    const each = billing === 'year' ? (price.year ?? price.month) : (price.month ?? price.year)
    lines.push({ kind: 'seat', seat: s, name: c.seats[s].name, count: n, each, amount: round(n * each) })
  }
  if (extraSpent) lines.push({ kind: 'extra', name: 'extra usage', credits: credit ? creditsOf(extraSpent) : null, amount: money(extraSpent) })
  if (p.usageBased && usageSpent) lines.push({ kind: 'usage', name: 'usage', credits: credit ? creditsOf(usageSpent) : null, amount: money(usageSpent) })
  const net = round(lines.reduce((a, l) => a + l.amount, 0))
  if (c.vat) lines.push({ kind: 'vat', name: 'VAT', amount: Math.round(net * c.vat) })
  return { currency: c.currency, billing, lines, net, total: round(lines.reduce((a, l) => a + l.amount, 0)) }
}
