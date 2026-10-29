// Scheduled tasks on process-gpt's pg_cron. Each job calls back into this server
// through pg_net; the callback runs the stored prompt and posts into the thread.
// pg_cron runs in GMT here, so KST expressions are translated (hour field, and the
// day-of-week for hours that fall on the previous UTC day).
import { config } from '../config.js'
import { q } from './supa.js'

const KST = 9

function expand(field, max) {
  if (field === '*') return null
  const out = new Set()
  for (const part of field.split(',')) {
    const [range, stepS] = part.split('/')
    const step = Number(stepS || 1)
    let [a, b] = range === '*' ? [0, max] : range.split('-').map(Number)
    if (b === undefined) b = stepS ? max : a
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return [...out].sort((x, y) => x - y)
}

function shiftDow(field, delta) {
  const days = expand(field, 6)
  if (!days) return '*'
  return [...new Set(days.map((d) => (d + delta + 7) % 7))].sort().join(',')
}

// Returns one or two GMT cron expressions equivalent to a KST expression.
export function kstToGmt(expr) {
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/)
  const hours = expand(hour, 23) ?? [...Array(24).keys()]
  const same = [], prev = []
  for (const h of hours) (h - KST >= 0 ? same : prev).push(h - KST >= 0 ? h - KST : h - KST + 24)
  const exprs = []
  if (hour === '*') return [`${min} * ${dom} ${mon} ${dow}`]
  if (same.length) exprs.push(`${min} ${same.join(',')} ${dom} ${mon} ${dow}`)
  if (prev.length) {
    if (dom !== '*') exprs.push(`${min} ${prev.join(',')} ${dom} ${mon} ${dow}`) // rare; accept day-of-month drift
    else exprs.push(`${min} ${prev.join(',')} * ${mon} ${shiftDow(dow, -1)}`)
  }
  return exprs
}

// Whether a 5-field KST cron expression names the minute of `t`.
function matcher(expr) {
  const [mi, ho, dom, mon, dow] = expr.trim().split(/\s+/)
  const sets = [expand(mi, 59), expand(ho, 23), expand(dom, 31), expand(mon, 12), expand(dow, 6)]
  const ok = (set, v) => !set || set.includes(v)
  return (t) => {
    const k = new Date(t.getTime() + KST * 3600000) // wall clock in KST via UTC getters
    return ok(sets[0], k.getUTCMinutes()) && ok(sets[1], k.getUTCHours()) && ok(sets[2], k.getUTCDate()) &&
      ok(sets[3], k.getUTCMonth() + 1) && ok(sets[4], k.getUTCDay())
  }
}
export const dueAt = (expr, minute) => matcher(expr)(minute)

// Next fire time of a 5-field KST cron expression, as a Date.
export function nextRun(expr, from = new Date()) {
  const match = matcher(expr)
  const t = new Date(Math.ceil((from.getTime() + 1) / 60000) * 60000)
  for (let i = 0; i < 60 * 24 * 32; i++) {
    if (match(t)) return t
    t.setTime(t.getTime() + 60000)
  }
  return null
}

// PRO_CRON_MODE=server: this process is the clock. A managed database outside the cluster cannot
// call back to the Service address, so pg_cron is not used; the server is one replica, so a
// minute fires once. A tick that comes late fires the minutes it missed.
export async function dueSchedules(minute) {
  return (await q('select id, cron from pro_schedules where not coalesce(paused, false)'))
    .filter((s) => { try { return dueAt(s.cron, minute) } catch { return false } }).map((s) => s.id)
}
export function startScheduleTicker(fire) {
  if (config.cronMode !== 'server') return
  let last = Math.floor(Date.now() / 60000) * 60000
  setInterval(async () => {
    const now = Math.floor(Date.now() / 60000) * 60000
    for (let m = last + 60000; m <= now; m += 60000) {
      try { for (const id of await dueSchedules(new Date(m))) fire(id) } catch (e) { console.warn('[cron] tick', e.message) }
    }
    last = now
  }, 15000)
}

export async function createSchedule({ userId, name, cron, prompt, threadId }) {
  const [s] = await q(
    `insert into pro_schedules(user_id,name,cron,prompt,thread_id) values ($1,$2,$3,$4,$5) returning *`,
    [userId, name, cron, prompt, threadId])
  if (config.cronMode === 'server') return s
  const jobBase = `pro_${s.id.slice(0, 8)}`
  const url = `${config.cronCallbackBase}/api/cron/fire`
  const body = JSON.stringify({ id: s.id, secret: config.cronSecret })
  const names = []
  for (const [i, gmt] of kstToGmt(cron).entries()) {
    const job = `${jobBase}_${i}`
    await q(`select cron.schedule($1, $2, $3)`, [job, gmt,
      `select net.http_post(url := '${url}', body := '${body}'::jsonb, headers := '{"Content-Type":"application/json"}'::jsonb)`])
    names.push(job)
  }
  await q('update pro_schedules set job_name=$2 where id=$1', [s.id, names.join(',')])
  return { ...s, job_name: names.join(',') }
}

export async function deleteSchedule(userId, id) {
  const [s] = await q('select * from pro_schedules where id=$1 and user_id=$2', [id, userId])
  if (!s) return
  for (const job of (s.job_name || '').split(',').filter(Boolean)) await q('select cron.unschedule($1)', [job]).catch(() => {})
  await q('delete from pro_schedules where id=$1', [id])
}

export const listSchedules = async (userId) =>
  (await q(`select s.*, t.kind as thread_kind, t.title as thread_title,
            (select row_to_json(r) from pro_mission_runs r where r.schedule_id=s.id order by r.started_at desc limit 1) as last_run_info
     from pro_schedules s left join pro_threads t on t.id = s.thread_id where s.user_id=$1 order by s.created_at desc`, [userId]))
    .map((s) => ({ ...s, next_run: s.paused ? null : nextRun(s.cron) }))
