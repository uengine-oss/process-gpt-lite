// Whom "@" suggests, in order: the teammates I hand things to most (recency-weighted), then the
// ones the judge model reads as related to this work, then roles with a holder, then everyone else.
// The judge (context-router's typed-decision server: softmax over the options' letters, nothing
// generated) is cheap, but optional: slow or down, the list is the frequency order alone.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'

const T = () => config.tenantId
// unset: the local judge; set but empty (an install without one): no judge call, frequency order only
const JUDGE_URL = process.env.PRO_JUDGE_URL ?? 'http://127.0.0.1:8896/judge'
const JUDGE_MS = Number(process.env.PRO_JUDGE_TIMEOUT_MS || 5000)

async function team(me) {
  const rows = await q(`select u.id, u.email, u.username as name from pro_team_members m
                        join users u on u.id=m.user_id and u.tenant_id=m.tenant_id
                        where m.tenant_id=$1 and m.user_id <> $2 order by u.username`, [T(), me.id])
  const roles = await q(`select a.role, a.user_id from pro_role_assignments a where a.tenant_id=$1 and a.proc_def_id='*'`, [T()])
  return rows.map((p) => ({ type: 'user', id: p.id, name: p.name || p.email.split('@')[0], email: p.email, roles: roles.filter((r) => r.user_id === p.id).map((r) => r.role) }))
}

// handoffs in the last 90 days: my messenger messages (a group message counts 1/(n-1) per member)
// and my chat requests to a teammate (notifications type 'mention' from me), each weighted exp(-days/14)
export async function frequency(me) {
  const rows = await q(`
    with dm as (
      select mb.user_id as other, m.created_at as at,
             1.0 / greatest(1, (select count(*) from pro_dm_members z where z.thread_id=m.thread_id) - 1) as w
      from pro_dm_messages m join pro_dm_members mb on mb.thread_id=m.thread_id and mb.user_id <> m.sender_id
      where m.tenant_id=$1 and m.sender_id=$2 and m.created_at > now() - interval '90 days'
    ), req as (
      select u.id as other, n.time_stamp as at, 1.0 as w from notifications n
      join users u on (u.id::text = n.user_id or u.email = n.user_id) and u.tenant_id = n.tenant_id
      where n.tenant_id=$1 and n.from_user_id=$3 and n.type='mention' and n.time_stamp > now() - interval '90 days'
    )
    select other, sum(w * exp(-extract(epoch from now() - at) / 86400 / 14))::float as score, count(*)::int as n
    from (select * from dm union all select * from req) x group by other`, [T(), me.id, me.email])
  return Object.fromEntries(rows.map((r) => [r.other, { score: r.score, n: r.n }]))
}

// what the work is about, from the sender's own messages (ids checked against their threads)
export async function workState(me, { messageIds = [], title = '' } = {}) {
  const ids = [...new Set(messageIds.map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 12)
  const rows = ids.length ? await q(`select m.role, m.kind, m.content, m.created_at from pro_messages m join pro_threads t on t.id=m.thread_id
                                      where m.id = any($1::uuid[]) and t.user_id=$2 order by m.created_at`, [ids, me.id]) : []
  const lines = rows.filter((r) => ['text', 'doc'].includes(r.kind) && r.content?.text)
    .slice(-4).map((r) => `${r.role === 'user' ? '나' : '비서'}: ${r.content.text.replace(/\s+/g, ' ').slice(0, 220)}`)
  const files = rows.filter((r) => r.kind === 'file').map((r) => r.content?.name).filter(Boolean)
  return [title && `대화: ${title}`, ...lines, files.length && `산출물: ${files.join(', ')}`].filter(Boolean).join('\n')
}

const cache = new Map() // hash -> {at, out}
export async function judgeRelated(me, state, candidates) {
  if (!JUDGE_URL || !state || candidates.length < 2) return { related: [], judged: false }
  const key = crypto.createHash('sha1').update(me.id + state + candidates.map((c) => c.id).join()).digest('hex')
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 120000) return hit.out
  const recent = await q(`select mb.user_id as other, string_agg(distinct coalesce(m.context->>'title', a->>'name'), ', ') as what
                          from pro_dm_messages m join pro_dm_members mb on mb.thread_id=m.thread_id and mb.user_id <> $2
                          left join lateral jsonb_array_elements(m.artifacts) a on true
                          where m.tenant_id=$1 and m.sender_id=$2 and m.created_at > now() - interval '30 days' group by 1`, [T(), me.id]).catch(() => [])
  const what = Object.fromEntries(recent.map((r) => [r.other, (r.what || '').slice(0, 80)]))
  const options = candidates.slice(0, 12).map((c) => ({
    key: c.id, label: `${c.name}${c.roles.length ? ` (${c.roles.join(', ')})` : ''}${what[c.id] ? ` — 최근 함께한 일: ${what[c.id]}` : ''}`,
  }))
  try {
    const r = await fetch(JUDGE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(JUDGE_MS),
      body: JSON.stringify({ state: state.slice(0, 1500), question: '이 일을 이어받거나 확인해야 할, 가장 관계된 팀원은 누구인가요?', options }),
    })
    if (!r.ok) throw new Error(`judge ${r.status}`)
    const j = await r.json()
    const related = Object.entries(j.probabilities || {}).sort((a, b) => b[1] - a[1]).filter(([, p]) => p >= 0.3).slice(0, 2)
      .map(([id, p]) => ({ id, p: Math.round(p * 100) / 100 }))
    const out = { related, judged: true, model: j.model, ms: j.latency_ms }
    cache.set(key, { at: Date.now(), out })
    return out
  } catch (e) {
    return { related: [], judged: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message }
  }
}

// mode 'fast': frequency + roles + the rest, at once; mode 'related': the judge's picks as well
export async function suggest(me, { mode = 'fast', messageIds, title } = {}) {
  const people = await team(me)
  const freq = await frequency(me)
  const frequent = people.filter((p) => freq[p.id]).sort((a, b) => freq[b.id].score - freq[a.id].score).slice(0, 3)
    .map((p) => ({ ...p, why: 'frequent', n: freq[p.id].n }))
  const taken = new Set(frequent.map((p) => p.id))
  let related = [], judge = null
  if (mode === 'related') {
    const state = await workState(me, { messageIds: messageIds || [], title })
    // the judge picks among the ones not already on top: "who else is this work about?"
    judge = await judgeRelated(me, state, people.filter((p) => !taken.has(p.id)))
    related = judge.related.filter((r) => !taken.has(r.id)).map((r) => ({ ...people.find((p) => p.id === r.id), why: 'related', p: r.p })).filter((p) => p.id)
    for (const r of related) taken.add(r.id)
  }
  const roles = (await q(`select a.role, u.id, u.username as name from pro_role_assignments a
                          join users u on u.id=a.user_id and u.tenant_id=a.tenant_id
                          join pro_team_members m on m.user_id=a.user_id and m.tenant_id=a.tenant_id
                          where a.tenant_id=$1 and a.proc_def_id='*' and a.user_id <> $2 order by a.role`, [T(), me.id]))
    .map((r) => ({ type: 'role', role: r.role, holder: { id: r.id, name: r.name } }))
  const rest = people.filter((p) => !taken.has(p.id)).map((p) => ({ ...p, why: 'team' }))
  return { frequent, related, roles, rest, judge: judge && { judged: judge.judged, model: judge.model, ms: judge.ms, error: judge.error } }
}
