// 개선안의 한살이(설계 docs/auto-ax-onboarding/design-improve-on-map.md §5.3): 고쳐 보기(flowplan.js) → 개선안 → 합의에 올림(의견,
// opinions.js) → 관리자가 정함(효력일) → 시행 → 지켜보기(예상과 실측). Supabase pro_improve_plans(sql/047). The map's changes a plan makes are
// the same corrections 말로 고치기 keeps (editmap.js applyEdit — 고친 기록, one batch, undone one by one there); 사람 더하기 adds the people to
// the role (Settings › 팀 · 역할, pro_role_members). New cases follow the decided map; running cases go on as they started (D-1116).
// 시행 전후 is measured again whenever it is read (flowload.js flowModel since the effective day) — nothing measured is kept.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { ledger } from './review.js'
import { normLever, leverLabel, opsOf, reviewOf, VERDICT_KO } from './flowplan.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const uuid = (x) => /^[0-9a-f-]{36}$/i.test(String(x || ''))
const fmtH = (h) => (h == null ? '—' : h < 9 ? `${Math.round(h * 10) / 10}시간` : `${Math.round((h / 9) * 10) / 10}일`)
const STATUS_KO = { draft: '초안', voted: '합의 중', decided: '정함', declined: '하지 않기로 함' }

async function isAdmin(me) { return (await import('./service.js')).isAdmin(me).catch(() => false) }
async function nameOf(me) {
  const [u] = await q(`select coalesce(nullif(username,''), email) as name from users where id::text=$1 and tenant_id=$2`, [String(me.id), T()])
  return u?.name || me.email || ''
}
async function rowOf(id) {
  if (!uuid(id)) throw err(404, '개선안을 찾지 못했어요.')
  const [r] = await q(`select *, id::text as id, opinion_id::text as opinion_id, batch::text as batch from pro_improve_plans where tenant_id=$1 and id=$2`, [T(), id])
  if (!r) throw err(404, '개선안을 찾지 못했어요.')
  return r
}

// the words a plan says when it goes to the opinions: its levers and what it expects
export function wordsOf(p) {
  const b = p.baseline || {}, a = p.predicted || {}
  const expect = [b.nowH != null && a.nowH != null ? `지금 들어오면 ${fmtH(b.nowH)} → ${fmtH(a.nowH)}` : '', b.pastH != null && a.pastH != null ? `보통 건 ${fmtH(b.pastH)} → ${fmtH(a.pastH)}` : '']
    .filter(Boolean).join(', ')
  return clean(`개선안 「${p.name}」: ${(p.levers || []).map((l) => leverLabel(l)).join(' · ')}${expect ? ` (예상 ${expect})` : ''}`).slice(0, 600)
}

async function shape(me, r, { admin = null } = {}) {
  const ad = admin ?? (await isAdmin(me))
  let opinion = null
  if (r.opinion_id) {
    const [o] = await q(`select id::text as id, state, ops_key, note from pro_map_opinions where tenant_id=$1 and id=$2`, [T(), r.opinion_id]).catch(() => [])
    if (o) {
      const agree = await q(`select distinct by_user, by_name from pro_map_opinions where tenant_id=$1 and proc_key=$2 and ops_key=$3 and state=$4`, [T(), r.proc_key, o.ops_key, o.state]).catch(() => [])
      opinion = { id: o.id, state: o.state, note: o.note || '', agree: agree.length, who: agree.map((x) => x.by_name).filter(Boolean), mine: agree.some((x) => String(x.by_user) === String(me.id)) }
    }
  }
  return {
    id: r.id, proc: r.proc_key, name: r.name, levers: (r.levers || []).map((l) => ({ ...l, label: leverLabel(l) })), words: r.words || '', mapAt: r.map_at, theta: r.theta,
    measure: r.measure || null, baseline: r.baseline, predicted: r.predicted, notes: r.notes || [], status: r.status, statusName: STATUS_KO[r.status] || r.status,
    opinion, effectiveAt: r.effective_at, decidedBy: r.decided_by, decidedNote: r.decided_note || '', decidedAt: r.decided_at, batch: r.batch, membersAdded: r.members_added || [],
    by: { id: r.created_by, name: r.created_name || '' }, at: r.created_at, mine: String(r.created_by) === String(me.id),
    can: { vote: r.status === 'draft', agree: r.status === 'voted' && !!opinion && !opinion.mine, decide: ad && ['draft', 'voted'].includes(r.status), decline: ad && ['draft', 'voted'].includes(r.status),
      remove: r.status === 'draft' && (ad || String(r.created_by) === String(me.id)) },
  }
}

export async function listPlans(me, procKey) {
  const rows = await q(`select *, id::text as id, opinion_id::text as opinion_id, batch::text as batch from pro_improve_plans where tenant_id=$1 and ($2 = '' or proc_key=$2) order by created_at desc limit 30`, [T(), String(procKey || '')])
  const admin = await isAdmin(me)
  return { plans: await Promise.all(rows.map((r) => shape(me, r, { admin }))), admin }
}
export async function getPlan(me, id) { return shape(me, await rowOf(id)) }

// keep what 고쳐 보기 showed as a plan: its levers and the before · after read on the map now (the same numbers, computed again here)
export async function savePlan(me, { proc = '', name = '', levers = [], words = '' } = {}) {
  const lv = (Array.isArray(levers) ? levers : []).map(normLever).filter(Boolean).slice(0, 12)
  if (!lv.length) throw err(400, '고칠 것을 하나 이상 골라 주세요.')
  const { whatIfView } = await import('./flowload.js')
  const w = await whatIfView(me, { proc, levers: lv })
  if (w.skipped.length === lv.length) throw err(409, `계산할 수 있는 것이 없어요 — ${w.skipped.map((s) => `${s.label}: ${s.why}`).join(' / ')}`)
  const nm = clean(name).slice(0, 60) || w.levers.map((l) => l.label).join(' · ').slice(0, 60)
  const [r] = await q(`insert into pro_improve_plans (tenant_id, proc_key, name, levers, words, map_at, theta, measure, baseline, predicted, notes, created_by, created_name)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *, id::text as id, opinion_id::text as opinion_id, batch::text as batch`,
  [T(), w.proc.key, nm, JSON.stringify(w.levers.map(({ label, ...l }) => l)), clean(words).slice(0, 600) || null, w.at, w.proc.theta ?? null, JSON.stringify({ window: w.window, skipped: w.skipped }),
    JSON.stringify(w.before), JSON.stringify(w.after), JSON.stringify(w.notes), String(me.id), await nameOf(me)])
  return shape(me, r)
}

export async function removePlan(me, id) {
  const r = await rowOf(id)
  if (r.status !== 'draft') throw err(409, '합의에 올린 안은 지우지 않아요 — 하지 않기로 정해 주세요.')
  if (String(r.created_by) !== String(me.id) && !(await isAdmin(me))) throw err(403, '만든 사람이나 관리자만 지울 수 있어요.')
  await q(`delete from pro_improve_plans where tenant_id=$1 and id=$2`, [T(), id])
  return { removed: id }
}

// 합의에 올리기: the plan becomes an opinion of its process (its map operations; 사람 더하기 only in the words) — conflicts with other opinions
// and with what was decided show where opinions are resolved
export async function votePlan(me, id) {
  const r = await rowOf(id)
  if (r.status !== 'draft') throw err(409, '이미 합의에 올렸어요.')
  const { voice } = await import('./opinions.js')
  const v = await voice(me, { proc: r.proc_key, words: wordsOf(r), ops: opsOf(r.levers || []), source: 'map' })
  await q(`update pro_improve_plans set status='voted', opinion_id=$3, updated_at=now() where tenant_id=$1 and id=$2`, [T(), id, v.opinion.id])
  await ledger(me, 'ontology.improve_plan', `개선안 합의에 올림 「${r.name}」`, { plan: id, proc: r.proc_key, opinion: v.opinion.id })
  return shape(me, await rowOf(id))
}
// 같은 의견: someone else says the plan's operations too (one per person — opinions.js counts them)
export async function agreePlan(me, id) {
  const r = await rowOf(id)
  if (r.status !== 'voted') throw err(409, '합의 중인 안이 아니에요.')
  const { voice } = await import('./opinions.js')
  await voice(me, { proc: r.proc_key, words: wordsOf(r), ops: opsOf(r.levers || []), source: 'map' })
  return shape(me, await rowOf(id))
}

// the people 사람 더하기 may pick: the company's people (not agents), with their roles and the open items they hold now
export async function peopleFor(me, role = '') {
  const rows = await q(`select u.id::text as id, coalesce(nullif(u.username,''), u.email) as name,
                               coalesce(array_agg(distinct x.role) filter (where x.role is not null), '{}') as roles
                          from users u
                          left join (select user_id, role from pro_role_members where tenant_id=$1
                                     union select user_id, role from pro_role_assignments where tenant_id=$1 and proc_def_id='*') x on x.user_id = u.id
                         where u.tenant_id=$1 and not coalesce(u.is_agent,false) group by u.id, u.username, u.email order by 2`, [T()])
  const open = await q(`select user_id from todolist where tenant_id=$1 and status::text in ('NEW','TODO','IN_PROGRESS','PENDING')`, [T()]).catch(() => [])
  const count = new Map()
  for (const o of open) for (const x of String(o.user_id || '').split(',').map((s) => s.trim()).filter(Boolean)) count.set(x, (count.get(x) || 0) + 1)
  return { role, people: rows.filter((p) => !p.roles.includes(role)).map((p) => ({ ...p, open: count.get(p.id) || 0 })) }
}

// the people a plan's 사람 더하기 names, added to their roles (kept on the plan, so 되돌리기 knows whom it added)
async function addMembers(me, levers) {
  const { setMember } = await import('./ways.js')
  const added = [], open = []
  for (const l of levers.map(normLever).filter((x) => x?.type === 'capacity')) {
    for (const p of l.people || []) { await setMember(me, l.role, p.id, true); added.push({ role: l.role, userId: p.id, name: p.name }) }
    if ((l.people || []).length < l.n) open.push(`「${l.role}」 역할에 ${l.n - (l.people || []).length}명 — 사람을 정하면 설정 › 팀 · 역할에서 넣어 주세요.`)
  }
  return { added, open }
}

// 정하기(관리자): the plan's map operations become corrections (one batch — through its opinion when it went to the opinions, so the others of a
// conflict are closed as 「다른 의견으로 정함」), its people join their roles, the effective day is set. One line in the decision ledger.
export async function decidePlan(me, id, { note = '', fromOpinion = null } = {}) {
  if (!(await isAdmin(me))) throw err(403, '개선안을 정하는 것은 관리자만 할 수 있어요.')
  const r = await rowOf(id)
  if (!['draft', 'voted'].includes(r.status)) throw err(409, `이미 ${STATUS_KO[r.status]} 안이에요.`)
  const n = clean(note).slice(0, 300)
  const words = `${wordsOf(r)}${n ? ` — ${n}` : ''}`
  const ops = opsOf(r.levers || [])
  let batch = fromOpinion?.batch || null
  if (!fromOpinion) {
    const E = await import('./editmap.js')
    const O = await import('./opinions.js')
    const [o] = r.opinion_id ? await q(`select id::text as id, state, ops from pro_map_opinions where tenant_id=$1 and id=$2`, [T(), r.opinion_id]) : []
    if (o?.state === 'open') {
      // the others of its conflict (the opinions panel's groups) are closed as superseded, as resolve does
      const view = await O.opinionsView(me, r.proc_key, { ask: false }).catch(() => null)
      const group = view?.conflicts.find((c) => c.opinions.some((x) => x.id === o.id))
      const others = (group?.opinions || []).map((x) => x.id).filter((x) => x !== o.id)
      if ((o.ops || []).length) {
        const res = await E.applyEdit(me, { proc: r.proc_key, words, ops: o.ops, opinionId: o.id })
        batch = res.batch
        await O.closeAs(me, r.proc_key, [o.id], { state: 'applied', note: n, batch, procName: res.proc.name })
        if (others.length) await O.closeAs(me, r.proc_key, others, { state: 'superseded', note: n || '개선안으로 정했어요', batch, procName: res.proc.name })
      } else await O.closeAs(me, r.proc_key, [o.id], { state: 'applied', note: n })
    } else if (ops.length) {
      const res = await E.applyEdit(me, { proc: r.proc_key, words, ops })
      batch = res.batch
    }
  }
  const { added, open } = await addMembers(me, r.levers || [])
  await q(`update pro_improve_plans set status='decided', effective_at=now(), decided_by=$3, decided_note=$4, decided_at=now(), batch=$5, members_added=$6, updated_at=now()
           where tenant_id=$1 and id=$2`, [T(), id, String(me.id), n || null, batch, JSON.stringify(added)])
  await ledger(me, 'ontology.improve_plan', `개선안 정함 「${r.name}」`, { plan: id, proc: r.proc_key, ops, batch, members: added, open, note: n || null })
  return { ...(await shape(me, await rowOf(id))), open }
}

export async function declinePlan(me, id, { note = '' } = {}) {
  if (!(await isAdmin(me))) throw err(403, '개선안을 정하는 것은 관리자만 할 수 있어요.')
  const r = await rowOf(id)
  const n = clean(note).slice(0, 300)
  if (!n) throw err(400, '하지 않는 까닭을 한 줄 적어 주세요.')
  if (r.opinion_id) {
    const [o] = await q(`select state from pro_map_opinions where tenant_id=$1 and id=$2`, [T(), r.opinion_id])
    if (o?.state === 'open') await (await import('./opinions.js')).closeAs(me, r.proc_key, [r.opinion_id], { state: 'declined', note: n })
  }
  await q(`update pro_improve_plans set status='declined', decided_by=$3, decided_note=$4, decided_at=now(), updated_at=now() where tenant_id=$1 and id=$2`, [T(), id, String(me.id), n])
  await ledger(me, 'ontology.improve_plan', `개선안 하지 않기로 함 「${r.name}」`, { plan: id, proc: r.proc_key, note: n })
  return shape(me, await rowOf(id))
}

// opinions.js resolve → a plan's opinion was applied (the plan is decided with that batch) or closed otherwise (declined)
export async function onOpinionClosed(me, opinionIds = [], { state, batch = null, note = '' } = {}) {
  const ids = (opinionIds || []).map(String).filter(uuid)
  if (!ids.length) return
  const rows = await q(`select id::text as id from pro_improve_plans where tenant_id=$1 and opinion_id::text = any($2) and status='voted'`, [T(), ids]).catch(() => [])
  for (const r of rows) {
    if (state === 'applied') await decidePlan(me, r.id, { note, fromOpinion: { batch } }).catch((e) => console.warn('[ontology] plan decide', e.message))
    else await q(`update pro_improve_plans set status='declined', decided_by=$3, decided_note=$4, decided_at=now(), updated_at=now() where tenant_id=$1 and id=$2`,
      [T(), r.id, String(me.id), clean(note).slice(0, 300) || '의견을 정하면서 닫혔어요']).catch(() => {})
  }
}

// 시행 전후: what the plan expected, against the map read again with the run records since its effective day
export async function reviewPlan(me, id) {
  const r = await rowOf(id)
  if (r.status !== 'decided' || !r.effective_at) throw err(409, '정한 안만 시행 전후를 봐요.')
  const { flowModel } = await import('./flowload.js')
  const { view } = await flowModel(me, { proc: r.proc_key, since: r.effective_at })
  const F = await import('./flowtime.js')
  const now = {
    pastH: view.path?.pastH ?? null, nowH: view.path?.nowH ?? null, bottleneck: view.bottleneck ? { key: view.bottleneck.key, wip: view.bottleneck.wip } : null,
    tasks: view.tasks.map((t) => ({ key: t.key, wip: t.wip, since: !!t.time?.since })), roles: view.constraint.roles.map((x) => ({ role: x.role, perPerson: x.perPerson, members: x.members })),
  }
  const since = new Date(r.effective_at).getTime()
  const { runRows } = await import('./flowload.js')
  const after = (await runRows({})).filter((x) => x.proc === r.proc_key && x.start >= since)
  const days = F.workMs(since, Date.now()) / (F.WORK_H * F.HOUR)
  const rv = reviewOf({ baseline: r.baseline, predicted: r.predicted }, now)
  return {
    plan: await shape(me, r), ...rv, verdictKo: VERDICT_KO,
    since: { at: r.effective_at, workDays: Math.round(days * 10) / 10, items: after.length, cases: new Set(after.map((x) => x.caseId)).size, timed: now.tasks.filter((t) => t.since).map((t) => t.key) },
    now: { bottleneck: now.bottleneck, constraint: view.constraint.key },
  }
}
