// Plans benchmarked on Claude's and Hark's (2026-10-30), as data (note: [Korean, English]). Lite applies a plan by turning each seat
// into LiteLLM limits (lib/plans/apply.js): a rolling-ish usage window on the person's key, a longer one on
// their membership in the company, the models the seat may use and how fast. PRO_PLAN_CATALOG picks one.
//
//   claude  claude.com/pricing — Free · Pro (5x Free a session) · Max 5x · Max 20x (of Pro) for one person;
//           Team (Standard / Premium = 5x Standard seats, 2–150 seats, admin limits, extra usage) and
//           Enterprise (seat + usage at cost, admin spend limits) for a company. Every plan has 5-hour
//           session limits; paid plans add weekly limits; usage beyond them is "extra usage" at API rates.
//   hark    Hark's coverage (layer3labs, usecarly, 2026-10) — Free · Pro 2x ($20) · Pro 10x ($100). The same
//           features on every plan; only how much autonomous work it does in the billing cycle changes.
//
// Usage is counted in model cost (USD, LiteLLM's spend). "x" multiplies the catalog's baseline (unit),
// which this install sets: PRO_PLAN_UNIT_SESSION_USD (one Free 5-hour session), PRO_PLAN_UNIT_WEEK_USD
// (one Free week), PRO_PLAN_UNIT_MONTH_USD (hark's Free month). Tiers: fast / standard / pro models
// (PRO_LLM_FAST_MODEL / PRO_LLM_MODEL / PRO_LLM_PRO_MODEL).
import { config } from '../../config.js'

const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d)
export const unit = () => ({
  session: num('PRO_PLAN_UNIT_SESSION_USD', 0.4),
  week: num('PRO_PLAN_UNIT_WEEK_USD', 2.4),
  month: num('PRO_PLAN_UNIT_MONTH_USD', 6),
})

const ALL = ['fast', 'standard', 'pro']
export const CATALOGS = {
  claude: {
    name: 'Claude', source: 'https://claude.com/pricing',
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
    name: 'Hark', source: 'https://www.layer3labs.io/guides/hark-pro-pricing',
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

export const catalogName = () => (CATALOGS[process.env.PRO_PLAN_CATALOG] ? process.env.PRO_PLAN_CATALOG : 'claude')
export const catalog = (name = catalogName()) => CATALOGS[name]
export const defaultPlan = () => 'free'
// a plan's seat for a new member: its first (Team: Standard)
export const defaultSeat = (plan, name) => catalog(name).plans[plan]?.seats[0] || 'free'

// model aliases of the tiers a seat may use
export function modelsOf(tiers) {
  const alias = { fast: config.llm.fastModel, standard: config.llm.model, pro: process.env.PRO_LLM_PRO_MODEL || config.llm.model }
  return [...new Set(tiers.map((t) => alias[t]).filter(Boolean))]
}

// What a seat means in LiteLLM: session (key budget, short window), period (membership budget, week or
// billing month), models, rpm, parallel. limitUsd: an administrator's monthly limit for the person
// (Team / Enterprise), which replaces a usage-based seat's open period.
export function limitsOf(seatCode, { name = catalogName(), limitUsd = null } = {}) {
  const c = catalog(name)
  const s = c.seats[seatCode]
  if (!s) throw Object.assign(new Error(`unknown seat ${seatCode}`), { status: 400 })
  const u = unit()
  const session = c.windows.session && s.x != null ? { usd: round(u.session * s.x), duration: c.windows.session } : null
  let period = null
  if (s.x != null && s.weekly !== false && c.windows.period) {
    period = { usd: round((c.windows.period === '7d' ? u.week : u.month) * s.x), duration: c.windows.period }
  }
  if (limitUsd != null && (s.usageBased || !period || limitUsd < period.usd)) period = { usd: Number(limitUsd), duration: '30d', byAdmin: true }
  return { seat: seatCode, name: s.name, session, period, models: modelsOf(s.models), rpm: s.rpm, parallel: s.parallel, usageBased: !!s.usageBased }
}

const round = (v) => Math.round(v * 1e6) / 1e6

// the price of a month on a plan: seats × seat price (at least the plan's minimum), plus usage beyond the seats
export function monthlyBill({ plan, billing = 'month', seats, extraSpent = 0, usageSpent = 0, name = catalogName() }) {
  const c = catalog(name)
  const p = c.plans[plan]
  const lines = []
  const count = {}
  for (const s of seats) count[s] = (count[s] || 0) + 1
  const total = Object.values(count).reduce((a, b) => a + b, 0)
  if (p.minSeats && total < p.minSeats) count[p.seats[0]] = (count[p.seats[0]] || 0) + (p.minSeats - total)
  for (const [s, n] of Object.entries(count)) {
    const price = c.seats[s].price
    const each = billing === 'year' ? (price.year ?? price.month) : (price.month ?? price.year)
    lines.push({ kind: 'seat', seat: s, name: c.seats[s].name, count: n, each, amount: round(n * each) })
  }
  if (extraSpent) lines.push({ kind: 'extra', name: 'extra usage', amount: round(extraSpent) })
  if (p.usageBased && usageSpent) lines.push({ kind: 'usage', name: 'usage at cost', amount: round(usageSpent) })
  return { currency: 'USD', billing, lines, total: round(lines.reduce((a, l) => a + l.amount, 0)) }
}
