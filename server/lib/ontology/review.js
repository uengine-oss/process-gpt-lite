// 학습 순환의 사람 몫(design-v0.2 §7.2 · §7.3): the review agenda and its decisions. The agenda is computed — paths
// that firmed up (their probability rose against four weeks ago), retirement candidates (the Poisson test: at their old
// rate they should have shown up more than 3 times since, and did not), pinned steps a case went around — and a person
// decides: pin · unpin · retire · revive, effective now or from a later date (Ontological's valid time). Each decision
// is a write with who and why in tx_metadata (Ontological's audit) and a row in the policy decision ledger.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { cypher, readGraph } from './store.js'
import { END, DAY } from './stats.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const pct = (p) => `${Math.round((p || 0) * 100)}%`

export async function agenda({ weeks = 4 } = {}) {
  const now = await readGraph({})
  const then = await readGraph({ validAt: new Date(Date.now() - weeks * 7 * DAY).toISOString() }).catch(() => ({ edges: [] }))
  const before = new Map(then.edges.map((e) => [`${e.from}>${e.to}`, e]))
  const tasks = new Map(now.tasks.map((t) => [t.key, t]))
  const items = []
  for (const e of now.edges) {
    if (e.to === END) continue
    if (e.stale && e.status !== 'retired' && !e.pinned) {
      items.push({ kind: 'retire', from: e.from, to: e.to, n: e.n, p: e.p, gapDays: Math.round(e.gap_days || 0), expected: Math.round((e.expected || 0) * 10) / 10,
        text: `「${e.from} → ${e.to}」 예전 빈도로는 최근 ${Math.round(e.gap_days || 0)}일 동안 ${Math.round((e.expected || 0) * 10) / 10}건쯤 나왔어야 하는데 0건이에요.` })
    }
    const b = before.get(`${e.from}>${e.to}`)
    if (e.status !== 'retired' && e.n >= 3 && (e.p || 0) - (b?.p || 0) >= 0.15) {
      items.push({ kind: 'firmed', from: e.from, to: e.to, p: e.p, was: b?.p || 0, text: `「${e.from} → ${e.to}」 ${weeks}주 전 ${pct(b?.p)} → 지금 ${pct(e.p)}` })
    }
    if (e.status === 'retired') items.push({ kind: 'retired', from: e.from, to: e.to, text: `「${e.from} → ${e.to}」 은퇴함 — 다시 쓰이면 되살림 후보가 돼요.` })
  }
  // pinned steps that cases went around (a snapshot started after them, or a move skipped them)
  const pinned = now.tasks.filter((t) => t.pinned).map((t) => t.key)
  if (pinned.length) {
    const rows = await q(`select id, entry_task, history from pro_po_cases where tenant_id=$1 and created_at > now() - interval '60 days'`, [T()])
    for (const k of pinned) {
      const n = rows.filter((r) => (r.history || []).some((h) => h.task === k && h.state === 'skipped')).length
      if (n) items.push({ kind: 'pin-skipped', task: k, n, text: `고정된 「${k}」를 건너뛴 건이 ${n}건 있어요.` })
    }
  }
  const order = { retire: 0, 'pin-skipped': 1, firmed: 2, retired: 3 }
  return { items: items.sort((a, b) => order[a.kind] - order[b.kind]), pinned, tasks: [...tasks.keys()] }
}

async function ledger(me, actionKind, subject, facts) {
  await q(`insert into pro_policy_decisions (tenant_id, user_id, action_kind, subject, facts, decision, status, ref)
           values ($1,$2,$3,$4,$5,'allow','executed','process-ontology')`, [T(), me.id, actionKind, subject, facts]).catch((e) => console.warn('[ontology] ledger', e.message))
}

const when = (validFrom) => {
  if (!validFrom) return undefined
  const d = new Date(validFrom)
  if (Number.isNaN(d.getTime())) throw err(400, '효력일을 읽지 못했어요.')
  return d.toISOString()
}

export async function pinTask(me, key, { pinned = true, validFrom, reason = '' } = {}) {
  const at = when(validFrom)
  const r = await cypher(`MATCH (t:Task {key:$key}) SET t.pinned=$pinned, t.pinned_by=$by, t.pin_reason=$reason RETURN t.key AS key`,
    { key, pinned: !!pinned, by: me.email || String(me.id), reason }, { actor: me.email || String(me.id), reason: reason || (pinned ? '고정' : '고정 풀기'), validFrom: at })
  if (!r.length) throw err(404, '일을 찾지 못했어요.')
  await ledger(me, pinned ? 'ontology.pin' : 'ontology.unpin', `${pinned ? '고정' : '고정 풀기'}: ${key}${at ? ` (${at.slice(0, 10)}부터)` : ''}`, { task: key, validFrom: at || null, reason })
  return { key, pinned: !!pinned, validFrom: at || null }
}

export async function setEdge(me, from, to, { status, validFrom, reason = '' }) {
  if (!['retired', 'active'].includes(status)) throw err(400, 'status 는 retired 나 active 예요.')
  const at = when(validFrom)
  const r = await cypher(`MATCH (a:Task {key:$from})-[e:NEXT]->(b:Task {key:$to}) SET e.status=$status, e.retired_by=$by, e.retire_reason=$reason RETURN e.status AS status`,
    { from, to, status, by: status === 'retired' ? (me.email || String(me.id)) : '', reason }, { actor: me.email || String(me.id), reason: reason || (status === 'retired' ? '은퇴' : '되살림'), validFrom: at })
  if (!r.length) throw err(404, '그 관계를 찾지 못했어요.')
  await ledger(me, status === 'retired' ? 'ontology.retire' : 'ontology.revive', `${status === 'retired' ? '은퇴' : '되살림'}: ${from} → ${to}`, { from, to, validFrom: at || null, reason })
  return { from, to, status, validFrom: at || null }
}

export async function decisions(limit = 30) {
  return q(`select id, action_kind, subject, facts, created_at, user_id from pro_policy_decisions where tenant_id=$1 and action_kind like 'ontology.%' order by created_at desc limit $2`, [T(), limit])
}
