// What a plan's usage buys, said in jobs people know — the plan screen's line, after Hark's "at full output Hark
// could plan 50 weddings, buy 100 grand pianos …". Each job was asked the way a person asks for it and its model
// cost measured (scripts/measure-plan-jobs.mjs → jobs.json), so a count is the plan's usage divided by real
// runs, rounded down to a round number. A usage-based plan has no amount to divide: it gets each job's price.
import fs from 'node:fs'
import { catalog, creditsOf, limitsOf, usdPerCredit } from './catalog.js'

// (an install without the file says nothing rather than a guess)
const read = () => { try { return JSON.parse(fs.readFileSync(new URL('./jobs.json', import.meta.url), 'utf8')) } catch { return { jobs: {} } } }
export const MEASURED = read()
// the order the line reads in; the last is the joke ("in case it all goes wrong")
export const ORDER = ['draft', 'minutes', 'process', 'apology']

// rounded down to two significant figures (1,234 → 1,200; 87 → 87), never more than was measured
export const roundDown = (n) => {
  if (!(n >= 1)) return 0
  if (n < 100) return Math.floor(n)
  const p = 10 ** (Math.floor(Math.log10(n)) - 1)
  return Math.floor(n / p) * p
}

// a plan's usage to divide, in model cost, and whose: one seat's month (credits), the company's fixed month
// (Free), or — on catalogs measured in windows — a seat's week or, without one, its 5-hour session
export function amountOf(planCode, name) {
  const c = catalog(name)
  const p = c.plans[planCode]
  if (!p || p.usageBased) return null
  if (p.fixedPool) return { per: 'company', usd: p.fixedPool * usdPerCredit(), credits: p.fixedPool }
  const s = c.seats[p.seats[0]]
  if (s.credits != null) return { per: 'seat', usd: s.credits * usdPerCredit(), credits: s.credits }
  const l = limitsOf(p.seats[0], { name })
  if (l.period) return { per: l.period.duration === '7d' ? 'week' : 'month', usd: l.period.usd }
  if (l.session) return { per: 'session', usd: l.session.usd }
  return null
}

// {per, credits?, jobs: [{key, n}]} — or, usage-based, {per: 'usage', jobs: [{key, credits, krw | usd}]}
export function equivalentsOf(planCode, name) {
  const c = catalog(name)
  if (!c?.plans[planCode]) return null
  const jobs = ORDER.filter((k) => MEASURED.jobs[k]?.usd > 0).map((k) => ({ key: k, usd: MEASURED.jobs[k].usd }))
  const a = amountOf(planCode, name)
  if (!a) {
    if (!c.plans[planCode].usageBased) return null
    return {
      per: 'usage',
      jobs: jobs.map((j) => (c.unit === 'credit'
        ? { key: j.key, credits: Math.max(1, creditsOf(j.usd)), krw: Math.max(1, creditsOf(j.usd)) * Number(process.env.PRO_CREDIT_KRW || 10) }
        : { key: j.key, usd: Math.round(j.usd * 1000) / 1000 })),
    }
  }
  return { per: a.per, credits: a.credits ?? null, jobs: jobs.map((j) => ({ key: j.key, n: roundDown(a.usd / j.usd) })).filter((j) => j.n > 0) }
}

// how the counts were made, for the line under them
export const basis = () => ({ measured: MEASURED.measured, models: [...new Set(Object.values(MEASURED.jobs).flatMap((j) => j.models || []))] })
