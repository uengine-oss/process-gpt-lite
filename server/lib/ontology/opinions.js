// 의견 모으기 · 상충 표시 · 지도에서 해소(design-v0.3 §31): anyone may say an improvement at any time — on the map's instruction box, in chat,
// on a step of a running case. It is kept as an opinion (pro_map_opinions, sql/046) and changes nothing: running cases go on as they are.
// The words go through the same words → operations path as 말로 고치기 (editmap.js); an opinion that does not become operations is kept as
// words. The same person saying the same thing again is not a second row; someone else saying the same operations agrees (「같은 의견 N명」).
// Conflicts are found by rules over the operations (conflictsBetween — no model, but for two written conditions that may mean the same:
// asked once, kept in pro_map_text_pairs): among open opinions of a process, and between an opinion and what a person already decided
// (corrections, 꼭 · 선택, pins). Opinions that conflict form one group (connected). An admin resolves on the map: pick one (applied as
// corrections, the others superseded), say it anew (말로 정리하기 — the result applied, the group merged), or keep the map as it is (declined,
// with a note). A non-conflicting opinion is applied or declined. Whoever's opinion was closed hears the outcome (notification + chat chip).
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { cypher, readGraph } from './store.js'
import { END } from './stats.js'
import { rules as skillRules } from './discovery.js'
import { ledger } from './review.js'
import { normFix, labelOf, whenKo, correctionsOf, baseOf } from './refine.js'
import { touchOf, refsOf, planOps, applyEdit } from './editmap.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const sha = (s, n = 16) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const flat = (s) => String(s || '').replace(/\s+/g, '')
const wid = (a, b) => `${a}\u0000${b}`
const fin = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0 }
const eul = (w) => (fin(w) ? '을' : '를')
export const STATES = ['open', 'applied', 'declined', 'merged', 'superseded']
export const STATE_KO = { open: '열림', applied: '적용됨', declined: '그대로 두기로 함', merged: '말로 정리해 적용됨', superseded: '다른 의견으로 정함' }
export const SOURCE_KO = { map: '지도', chat: '채팅', step: '건의 단계' }
export const KIND_KO = { remove: '빼기와 쓰기', order: '순서', role: '맡는 역할', runner: '하는 이', cond: '갈림길 조건', way: '길 잇기와 끊기', parallel: '나란히와 차례로', rename: '이름', requirement: '꼭 · 선택', pin: '고정' }

// ---------- 맞춰 적기 (pure) ----------
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : typeof v === 'string' ? clean(v) : v)
// operations as an opinion keeps them: read (normFix), only the args that matter (no labels, no derived words), sorted
export function normOps(ops = []) {
  const out = []
  for (const x of Array.isArray(ops) ? ops : []) {
    const f = normFix(x)
    if (!f) continue
    const { when, event, was, ...args } = f.args
    const keep = f.op === 'set_cond' ? { ...args, when: f.args.when } : f.op === 'set_timer' ? { cron: args.cron, entry: args.entry } : f.op === 'new_process' ? f.args : args
    out.push(canon({ op: f.op, args: keep }))
  }
  return [...new Map(out.map((x) => [JSON.stringify(x), x])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
// the opinion's fingerprint: the same operations are the same opinion; words that became none are compared as words
export const opsKey = (ops, words = '') => (ops.length ? `ops:${sha(JSON.stringify(ops))}` : `text:${sha(flat(words))}`)

// ---------- 상충 (pure) ----------
// what an operation list says, as facts that can contradict each other
function factsOf(ops = []) {
  const f = { removes: new Map(), uses: new Map(), before: [], at: new Map(), role: new Map(), runner: new Map(), cond: new Map(), add: new Map(), cut: new Map(), par: [], name: new Map(), req: new Map(), pinT: new Map(), pinW: new Map() }
  const put = (m, k, v) => { if (!m.has(k)) m.set(k, v) }
  for (const o of ops) {
    const a = o.args || {}, label = o.label || labelOf(o)
    const it = { label, op: o }
    switch (o.op) {
      case 'remove_task': put(f.removes, a.task, it); break
      case 'merge_task': put(f.removes, a.task, it); put(f.uses, a.into, it); break
      case 'add_edge': put(f.add, wid(a.from, a.to), it); if (a.to !== END) f.before.push([a.from, a.to, it]); break
      case 'remove_edge': put(f.cut, wid(a.from, a.to), it); break
      case 'reverse_edge': put(f.cut, wid(a.from, a.to), it); put(f.add, wid(a.to, a.from), it); f.before.push([a.to, a.from, it]); break
      case 'move_task':
        put(f.at, a.task, { ...it, pos: `${a.after || ''}|${a.before || ''}` })
        if (a.after) f.before.push([a.after, a.task, it])
        if (a.before && a.before !== END) f.before.push([a.task, a.before, it])
        break
      case 'add_task':
        if (a.after) f.before.push([a.after, a.name, it])
        if (a.before && a.before !== END) f.before.push([a.name, a.before, it])
        if (a.role) put(f.role, a.name, { ...it, v: a.role })
        if (a.runner) put(f.runner, a.name, { ...it, v: a.runner })
        break
      case 'set_role': put(f.role, a.task, { ...it, v: a.role }); break
      case 'set_runner': put(f.runner, a.task, { ...it, v: a.runner }); break
      case 'set_cond': put(f.cond, wid(a.from, a.to), { ...it, v: a.when || null }); break
      case 'set_parallel': f.par.push([a.a, a.b, it]); break
      case 'rename_task': put(f.name, a.task, { ...it, v: a.name }); break
      case 'set_requirement': put(f.req, a.task, { ...it, v: a.requirement || null }); break
      case 'pin_task': put(f.pinT, a.task, it); break
      case 'pin_edge': put(f.pinW, wid(a.from, a.to), it); break
      default: break
    }
    // a step this operation needs to be there (anything that names it but removing it)
    for (const [, v] of refsOf(o)) if (!(o.op === 'remove_task' && v === a.task) && !(o.op === 'merge_task' && v === a.task)) put(f.uses, v, it)
    if (o.op === 'add_task' && a.name) put(f.uses, a.name, it)
  }
  return f
}
const sameWhen = (x, y, sameText) => {
  if (!x || !y) return !x && !y
  if (x.amount && y.amount) return x.amount.op === y.amount.op && x.amount.value === y.amount.value
  if (x.text && y.text) return sameText(x.text, y.text) !== false
  return false
}
// two operation lists (two opinions, or an opinion and what was decided) → the ways they cannot both hold: [{kind, why, a, b}] (a · b: labels)
export function conflictsBetween(A = [], B = [], { sameText = (x, y) => flat(x) === flat(y) } = {}) {
  const same = new Set(A.map((o) => JSON.stringify(canon({ op: o.op, args: o.args }))))
  const B2 = B.filter((o) => !same.has(JSON.stringify(canon({ op: o.op, args: o.args }))))
  const A2 = A.filter((o) => !new Set(B.map((x) => JSON.stringify(canon({ op: x.op, args: x.args })))).has(JSON.stringify(canon({ op: o.op, args: o.args }))))
  const fa = factsOf(A2), fb = factsOf(B2)
  const out = []
  const add = (kind, why, x, y) => { if (!out.some((c) => c.kind === kind && c.a === x.label && c.b === y.label)) out.push({ kind, why, a: x.label, b: y.label }) }
  for (const [p, q2] of [[fa, fb], [fb, fa]]) {
    const flip = p === fb
    const pair = (kind, why, x, y) => (flip ? add(kind, why, y, x) : add(kind, why, x, y))
    // a step taken out vs a step something else needs (꼭 하게 · 옮기기 · 역할 …) or keeps (a pin)
    for (const [t, x] of p.removes) {
      const y = q2.uses.get(t) || q2.req.get(t) || q2.pinT.get(t)
      if (y && !q2.removes.has(t)) {
        const kind = q2.req.has(t) ? 'requirement' : q2.pinT.has(t) && !q2.uses.has(t) ? 'pin' : 'remove'
        pair(kind, kind === 'requirement' ? `「${t}」${eul(t)} 빼자는 것과 그 단계의 꼭 · 선택을 정하자는 것은 함께 될 수 없어요.` : kind === 'pin' ? `「${t}」${eul(t)} 빼자고 했지만 고정된 단계예요.` : `「${t}」${eul(t)} 빼면서 그 단계를 쓸 수는 없어요.`, x, q2.req.get(t) || y)
      }
    }
    // a way cut vs the same way added (or kept by a pin)
    for (const [w, x] of p.cut) {
      const y = q2.add.get(w) || q2.pinW.get(w) || q2.cond.get(w)
      if (y && !q2.cut.has(w)) { const [a, b] = w.split('\u0000'); pair(q2.pinW.has(w) ? 'pin' : 'way', `「${a} → ${b === END ? '끝' : b}」 길을 끊으면서 이을 수는 없어요.`, x, y) }
    }
  }
  // order: one says X before Y, the other Y before X
  for (const [x1, y1, a] of fa.before) for (const [x2, y2, b] of fb.before) if (x1 === y2 && y1 === x2) add('order', `「${x1}」${'과'}「${y1}」의 순서가 서로 반대예요.`.replace('」과「', fin(x1) ? '」과 「' : '」와 「'), a, b)
  // the same step put in two different places
  for (const [t, a] of fa.at) { const b = fb.at.get(t); if (b && b.pos !== a.pos) add('order', `「${t}」${eul(t)} 서로 다른 자리로 옮기자고 해요.`, a, b) }
  // the same step: another role · another runner · another name · another 꼭 · 선택
  for (const [k, m, why] of [['role', 'role', (t) => `「${t}」을(를) 맡는 역할이 서로 달라요.`], ['runner', 'runner', (t) => `「${t}」을(를) 누가 하는지 서로 달라요.`], ['rename', 'name', (t) => `「${t}」의 새 이름이 서로 달라요.`], ['requirement', 'req', (t) => `「${t}」이(가) 꼭인지 선택인지 서로 달라요.`]]) {
    for (const [t, a] of fa[m]) { const b = fb[m].get(t); if (b && b.v !== a.v) add(k, why(t).replace('을(를)', eul(t)).replace('이(가)', fin(t) ? '이' : '가'), a, b) }
  }
  // the same split's way: two different conditions
  for (const [w, a] of fa.cond) {
    const b = fb.cond.get(w)
    if (b && !sameWhen(a.v, b.v, sameText)) { const [x, y] = w.split('\u0000'); add('cond', `「${x} → ${y === END ? '끝' : y}」로 가는 조건이 서로 달라요(${whenKo(a.v)} · ${whenKo(b.v)}).`, a, b) }
  }
  // side by side vs one after the other
  for (const [p, q2] of [[fa, fb], [fb, fa]]) {
    for (const [x, y, a] of p.par) {
      const b = q2.before.find(([u, v]) => (u === x && v === y) || (u === y && v === x))
      if (b) (p === fa ? add : (k, wy, i, j) => add(k, wy, j, i))('parallel', `「${x}」${fin(x) ? '과' : '와'} 「${y}」${eul(y)} 나란히 할지 차례로 할지 서로 달라요.`, a, b[2])
    }
  }
  return out
}

// the written conditions two opinions put on the same way (asked to the judge when they differ in words)
export function textPairs(lists = []) {
  const by = new Map()
  for (const ops of lists) for (const o of ops) if (o.op === 'set_cond' && o.args?.when?.text) { const k = wid(o.args.from, o.args.to); if (!by.has(k)) by.set(k, new Set()); by.get(k).add(clean(o.args.when.text)) }
  const out = []
  for (const set of by.values()) { const xs = [...set]; for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (flat(xs[i]) !== flat(xs[j])) out.push([xs[i], xs[j]]) }
  return out
}
export const pairKey = (a, b) => sha([flat(a), flat(b)].sort().join('\u0000'))

// open opinions [{id, ops}] + what is decided [{kind, op, args, label, by, why, at}] → conflict groups: connected opinions (and an opinion
// alone when it contradicts what is decided); each with the kinds and the reasons. Opinions with the same operations agree, never conflict.
export function groupsOf(opinions = [], decided = [], { sameText } = {}) {
  const parent = new Map(opinions.map((o) => [o.id, o.id]))
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const pairs = []
  for (let i = 0; i < opinions.length; i++) for (let j = i + 1; j < opinions.length; j++) {
    const a = opinions[i], b = opinions[j]
    if (!a.ops?.length || !b.ops?.length || (a.key && a.key === b.key)) continue
    const cs = conflictsBetween(a.ops, b.ops, { sameText })
    if (cs.length) { pairs.push({ a: a.id, b: b.id, conflicts: cs }); parent.set(find(a.id), find(b.id)) }
  }
  const against = new Map()
  for (const o of opinions) {
    if (!o.ops?.length) continue
    const hit = []
    for (const d of decided) { const cs = conflictsBetween(o.ops, [{ op: d.op, args: d.args, label: d.label }], { sameText }); if (cs.length) hit.push({ decided: d, conflicts: cs }) }
    if (hit.length) against.set(o.id, hit)
  }
  const groups = new Map()
  const into = (id) => { const r = find(id); if (!groups.has(r)) groups.set(r, { ids: new Set(), kinds: new Set(), why: [], decided: [] }); return groups.get(r) }
  for (const p of pairs) { const g = into(p.a); g.ids.add(p.a); g.ids.add(p.b); for (const c of p.conflicts) { g.kinds.add(c.kind); if (!g.why.includes(c.why)) g.why.push(c.why) } }
  for (const [id, hit] of against) {
    const g = into(id); g.ids.add(id)
    for (const h of hit) { if (!g.decided.includes(h.decided)) g.decided.push(h.decided); for (const c of h.conflicts) { g.kinds.add(c.kind); const w = `이미 정한 것과 달라요: ${c.why}`; if (!g.why.includes(w)) g.why.push(w) } }
  }
  return [...groups.values()].map((g) => { const ids = [...g.ids].sort(); return { id: sha(ids.join(','), 10), ids, kinds: [...g.kinds], why: g.why, decided: g.decided } })
}

// where opinions point on the drawing: steps and ways with an open opinion (「의견 N」), the ones in a conflict (「해소 필요」)
export function marksOf(opinions = [], groups = []) {
  const inGroup = new Set(groups.flatMap((g) => g.ids))
  const tasks = {}, ways = {}
  for (const o of opinions) {
    const t = new Set(), w = new Set()
    for (const op of o.ops || []) { const x = touchOf(op); x.tasks.forEach((k) => t.add(k)); x.ways.forEach(([a, b]) => w.add(wid(a, b))) }
    if (!o.ops?.length) { (o.range?.tasks || []).forEach((k) => t.add(k)); (o.range?.ways || []).forEach((x) => w.add(wid(x.from, x.to))); if (o.task) t.add(o.task) }
    for (const k of t) { tasks[k] ||= { n: 0, conflict: false }; tasks[k].n++; if (inGroup.has(o.id)) tasks[k].conflict = true }
    for (const k of w) { ways[k] ||= { n: 0, conflict: false }; ways[k].n++; if (inGroup.has(o.id)) ways[k].conflict = true }
  }
  return { tasks, ways }
}

// ---------- reading ----------
const rowOut = (r) => ({ id: r.id, proc: r.proc_key, words: r.words, ops: (r.ops || []).map((o) => ({ ...o, label: labelOf(o) })), key: r.ops_key, range: r.scope || null,
  who: { id: r.by_user, name: r.by_name || '', role: r.role || '' }, source: r.source, caseId: r.case_id || null, todoId: r.todo_id || null, task: r.task || null,
  at: r.created_at, state: r.state, note: r.note || '', decidedBy: r.decided_by || null, decidedAt: r.decided_at || null })
async function rowsOf(procKey, { closed = 20 } = {}) {
  const open = await q(`select *, id::text as id, case_id::text as case_id, todo_id::text as todo_id from pro_map_opinions where tenant_id=$1 and proc_key=$2 and state='open' order by created_at`, [T(), procKey])
  const done = await q(`select *, id::text as id, case_id::text as case_id, todo_id::text as todo_id from pro_map_opinions where tenant_id=$1 and proc_key=$2 and state<>'open' order by coalesce(decided_at, updated_at) desc limit $3`, [T(), procKey, closed])
  return { open: open.map(rowOut), closed: done.map(rowOut) }
}
// what a person already decided for this process: its corrections, its 꼭 · 선택, its pinned steps and ways
export async function decidedOf(procKey, g = null) {
  const cs = await correctionsOf(procKey)
  const out = cs.filter((c) => c.op !== 'new_process').map((c) => ({ kind: 'correction', op: c.op, args: c.args, label: labelOf(c), by: c.by_user || '', why: c.why || '', at: c.at }))
  const reqs = await q(`select task, requirement, reason, by_user, at from pro_step_requirements where tenant_id=$1 and proc_key=$2 and requirement is not null`, [T(), procKey]).catch(() => [])
  for (const r of reqs) if (!out.some((d) => d.op === 'set_requirement' && d.args.task === r.task)) out.push({ kind: 'requirement', op: 'set_requirement', args: { task: r.task, requirement: r.requirement }, label: labelOf({ op: 'set_requirement', args: { task: r.task, requirement: r.requirement } }), by: r.by_user || '', why: r.reason || '', at: r.at })
  const graph = g || await readGraph({})
  const proc = graph.processes.find((p) => p.key === procKey)
  if (proc) {
    const base = baseOf(graph, proc, cs)
    for (const t of base.tasks.values()) if (t.pinned) out.push({ kind: 'pin', op: 'pin_task', args: { task: t.key }, label: `「${t.key}」 고정`, by: t.pinned_by || '', why: t.pin_reason || '', at: null })
    for (const e of base.edges) if (e.pinned) out.push({ kind: 'pin', op: 'pin_edge', args: { from: e.from, to: e.to }, label: `「${e.from} → ${e.to === END ? '끝' : e.to}」 고정`, by: '', why: '', at: null })
  }
  return out
}
// two written conditions on the same way: the same meaning? (kept; the judge only for pairs not asked before)
async function sameTexts(lists, { ask = true } = {}) {
  const pairs = textPairs(lists)
  const known = new Map()
  if (pairs.length) for (const r of await q(`select pair, same from pro_map_text_pairs where tenant_id=$1 and pair = any($2)`, [T(), pairs.map(([a, b]) => pairKey(a, b))]).catch(() => [])) known.set(r.pair, r.same)
  if (ask) {
    const R = (await skillRules()).opinions || {}
    const { judge } = await import('./judge.js')
    for (const [a, b] of pairs) {
      const k = pairKey(a, b)
      if (known.has(k)) continue
      try {
        const { r, model } = await judge('갈림길 조건 두 개가 같은 경우를 말하는지 봅니다. JSON {"same": true|false} 로만 답하세요.', JSON.stringify({ a, b }), { judge: R.judge, timeoutMs: R.timeoutMs || 120000 })
        known.set(k, r?.same === true)
        await q(`insert into pro_map_text_pairs (tenant_id, pair, same, model) values ($1,$2,$3,$4) on conflict (tenant_id, pair) do update set same=excluded.same, model=excluded.model, at=now()`, [T(), k, r?.same === true, model])
      } catch (e) { console.warn('[ontology] opinion text pair', e.message) }
    }
  }
  return (x, y) => (flat(x) === flat(y) ? true : known.has(pairKey(x, y)) ? known.get(pairKey(x, y)) : undefined)
}

// everything the 「의견 · 해소」 panel shows for one process
export async function opinionsView(me, procKey, { ask = true } = {}) {
  const g = await readGraph({})
  const proc = g.processes.find((p) => p.key === procKey)
  if (!proc) throw err(404, '프로세스를 찾지 못했어요.')
  const R = (await skillRules()).opinions || {}
  const { open, closed } = await rowsOf(procKey, { closed: R.closedShown || 20 })
  const decided = await decidedOf(procKey, g)
  const sameText = await sameTexts([...open.map((o) => o.ops), decided.map((d) => ({ op: d.op, args: d.args }))], { ask })
  // agreement: the open opinions with the same operations (one per person)
  const byKey = new Map()
  for (const o of open) { if (!byKey.has(o.key)) byKey.set(o.key, []); byKey.get(o.key).push(o) }
  for (const o of open) { const same = o.ops.length ? byKey.get(o.key) : [o]; o.agree = new Set(same.map((x) => x.who.id)).size; o.agreeWho = [...new Set(same.map((x) => x.who.name).filter(Boolean))] }
  // one option per set of operations (the first one said)
  const options = [...byKey.values()].map((xs) => (xs[0].ops.length ? xs[0] : null)).filter(Boolean)
  const textOnly = open.filter((o) => !o.ops.length)
  const groups = groupsOf(options, decided, { sameText })
  const inGroup = new Set(groups.flatMap((x) => x.ids))
  const byId = new Map(options.map((o) => [o.id, o]))
  const { isAdmin } = await import('./service.js')
  return {
    proc: { key: proc.key, name: proc.name }, admin: await isAdmin(me).catch(() => false),
    conflicts: groups.map((x) => ({ id: x.id, kinds: x.kinds.map((k) => KIND_KO[k] || k), why: x.why, opinions: x.ids.map((id) => byId.get(id)).filter(Boolean),
      decided: x.decided.map((d) => ({ kind: d.kind, label: d.label, by: d.by, why: d.why, at: d.at })) })),
    open: [...options.filter((o) => !inGroup.has(o.id)), ...textOnly],
    closed,
    marks: marksOf(open, groups.map((x) => ({ ...x, ids: x.ids.flatMap((id) => (byKey.get(byId.get(id)?.key) || []).map((o) => o.id)) }))),
    counts: { open: open.length, conflicts: groups.length },
  }
}
// the map's chips: open opinions and conflicts per process (cached sameness only — no model while drawing the map)
export async function countsByProcess(g) {
  const rows = await q(`select proc_key, id::text as id, ops, ops_key from pro_map_opinions where tenant_id=$1 and state='open'`, [T()]).catch(() => [])
  const by = new Map()
  for (const r of rows) { if (!by.has(r.proc_key)) by.set(r.proc_key, []); by.get(r.proc_key).push({ id: r.id, key: r.ops_key, ops: r.ops || [] }) }
  const out = {}
  for (const [proc, list] of by) {
    const options = [...new Map(list.filter((o) => o.ops.length).map((o) => [o.key, o])).values()]
    const decided = await decidedOf(proc, g).catch(() => [])
    const sameText = await sameTexts([...options.map((o) => o.ops), decided.map((d) => ({ op: d.op, args: d.args }))], { ask: false })
    out[proc] = { open: list.length, conflicts: groupsOf(options, decided, { sameText }).length }
  }
  return out
}

// ---------- 의견 남기기 ----------
export async function voice(me, { proc: procKey = '', scope = null, words = '', ops = [], source = 'map', caseId = null, todoId = null, task = null, messageId = null } = {}) {
  if (!['map', 'chat', 'step'].includes(source)) throw err(400, 'source 는 map · chat · step 이에요.')
  const said = clean(words).slice(0, 600)
  if (!said && !ops?.length) throw err(400, '의견을 말해 주세요.')
  // only operations that would apply now (the same check as 말로 고치기, no model) — the rest stay in the words
  const plan = await planOps(me, { proc: procKey, scope, words: said, ops: (Array.isArray(ops) ? ops : []).slice(0, 24) })
  if (!plan.proc) throw err(400, '어느 프로세스에 대한 의견인지 골라 주세요.')
  const norm = normOps(plan.ops)
  const key = opsKey(norm, said)
  const [u] = await q(`select coalesce(nullif(username,''), email) as name from users where id::text=$1 and tenant_id=$2`, [String(me.id), T()])
  const role = await (await import('./ways.js')).roleOfUser(me.id).catch(() => null)
  const uuid = (x) => (/^[0-9a-f-]{36}$/i.test(String(x || '')) ? String(x) : null)
  const [row] = await q(`insert into pro_map_opinions (tenant_id, proc_key, scope, words, ops, ops_key, by_user, by_name, role, source, case_id, todo_id, task, message_id)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                         on conflict (tenant_id, proc_key, ops_key, by_user) where state = 'open'
                         do update set words=excluded.words, scope=excluded.scope, source=excluded.source, case_id=coalesce(excluded.case_id, pro_map_opinions.case_id),
                           todo_id=coalesce(excluded.todo_id, pro_map_opinions.todo_id), task=coalesce(excluded.task, pro_map_opinions.task), updated_at=now()
                         returning *, id::text as id, case_id::text as case_id, todo_id::text as todo_id, (xmax <> 0) as again`,
  [T(), plan.proc.key, plan.range ? JSON.stringify(plan.range) : null, said, JSON.stringify(norm), key, String(me.id), u?.name || me.email || '', role, source, uuid(caseId), uuid(todoId), clean(task).slice(0, 60) || null, uuid(messageId)])
  const [{ n }] = await q(`select count(distinct by_user)::int as n from pro_map_opinions where tenant_id=$1 and proc_key=$2 and ops_key=$3 and state='open'`, [T(), plan.proc.key, key])
  const agree = norm.length ? n : 1
  const opinion = { ...rowOut(row), agree }
  if (messageId) await (await import('./editmap.js')).voicedOnMessage(me, messageId, { voiced: { id: row.id, agree, again: !!row.again }, agree })
  const { emit } = await import('../bus.js')
  emit(me.id, 'ontology', { opinion: row.id, proc: plan.proc.key })
  return { opinion, agree, again: !!row.again, refused: plan.refused }
}

// an opinion's operations drawn on the map as it is now (flip through a conflict's options) — no model
export async function opinionPreview(me, id) {
  const [r] = await q(`select *, id::text as id from pro_map_opinions where tenant_id=$1 and id::text=$2`, [T(), String(id)])
  if (!r) throw err(404, '의견을 찾지 못했어요.')
  const plan = await planOps(me, { proc: r.proc_key, scope: r.scope, words: r.words, ops: r.ops || [] })
  return { id: r.id, before: plan.before, after: plan.after, changes: plan.changes, ops: plan.ops, refused: plan.refused, words: r.words }
}

// ---------- 해소 ----------
async function tell(me, rows, { procName, procKey, note }) {
  const { notifyUser } = await import('../notify.js')
  const { mainThread, addMessage } = await import('../store.js')
  for (const r of rows) {
    if (String(r.by_user) === String(me.id)) continue
    const head = `의견이 ${STATE_KO[r.state]}: 「${procName}」`
    const text = `「${clean(r.words).slice(0, 80)}」 — ${STATE_KO[r.state]}${note ? ` · ${clean(note).slice(0, 120)}` : ''}`
    await notifyUser(r.by_user, { type: 'opinion', title: head, text, url: `/process-map?proc=${encodeURIComponent(procKey)}` }).catch((e) => console.warn('[ontology] opinion notify', e.message))
    const th = await mainThread(r.by_user).catch(() => null)
    if (th) await addMessage(r.by_user, th.id, 'agent', 'chip', { icon: 'map', text: `${head} — ${text}`, opinion: r.id, proc: procKey }).catch(() => {})
  }
}
// close opinions as one state (with the opinions that say the same thing): who said them hears it
export async function closeAs(me, procKey, ids = [], { state, note = '', batch = null, procName = null } = {}) {
  if (!STATES.includes(state) || state === 'open') throw err(400, '닫는 상태가 아니에요.')
  const list = [...new Set((ids || []).map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x))
  if (!list.length) return []
  const keys = (await q(`select ops_key from pro_map_opinions where tenant_id=$1 and proc_key=$2 and id::text = any($3) and ops_key like 'ops:%'`, [T(), procKey, list])).map((r) => r.ops_key)
  const rows = await q(`update pro_map_opinions set state=$4, note=$5, decided_by=$6, decided_at=now(), updated_at=now()
                        where tenant_id=$1 and proc_key=$2 and state='open' and (id::text = any($3) or ops_key = any($7)) returning *, id::text as id`,
  [T(), procKey, list, state, clean(note).slice(0, 300) || null, String(me.id), keys])
  const name = procName || (await cypher('MATCH (b:Process {key:$key}) RETURN b.name AS name', { key: procKey }))[0]?.name || procKey
  await tell(me, rows, { procName: name, procKey, note })
  if (rows.length) await ledger(me, 'ontology.opinion', `의견 ${STATE_KO[state]}: 「${name}」 ${rows.length}개${note ? ` — ${clean(note).slice(0, 80)}` : ''}`, { proc: procKey, state, opinions: rows.map((r) => r.id), note: clean(note).slice(0, 300) || null, batch })
  return rows
}

const plansClosed = async (me, ids, o) => (await import('./improveplans.js')).onOpinionClosed(me, ids, o).catch((e) => console.warn('[ontology] plans', e.message))

// the admin's decision: apply (one opinion, the others of its conflict superseded) · decline (one) · keep (a conflict: all declined)
export async function resolve(me, procKey, { action = '', opinion = null, opinions = [], note = '' } = {}) {
  const { isAdmin } = await import('./service.js')
  if (!(await isAdmin(me))) throw err(403, '의견을 정하는 것은 관리자만 할 수 있어요.')
  const n = clean(note)
  if (action === 'apply') {
    const [r] = await q(`select *, id::text as id from pro_map_opinions where tenant_id=$1 and proc_key=$2 and id::text=$3 and state='open'`, [T(), procKey, String(opinion || '')])
    if (!r) throw err(404, '열린 의견을 찾지 못했어요.')
    if (!(r.ops || []).length) throw err(409, '동작으로 옮기지 못한 의견이에요 — 「말로 정리하기」로 정해 주세요.')
    const res = await applyEdit(me, { proc: procKey, scope: r.scope, words: `${r.words}${n ? ` — ${n}` : ''}`, ops: r.ops, opinionId: r.id })
    await closeAs(me, procKey, [r.id], { state: 'applied', note: n, batch: res.batch, procName: res.proc.name })
    const others = (opinions || []).map(String).filter((x) => x !== r.id)
    if (others.length) await closeAs(me, procKey, others, { state: 'superseded', note: n || '다른 의견으로 정했어요', batch: res.batch, procName: res.proc.name })
    // an improvement plan that went to the opinions (improveplans.js): applied → decided (effective now, its people join their roles)
    await plansClosed(me, [r.id], { state: 'applied', batch: res.batch, note: n })
    await plansClosed(me, others, { state: 'superseded', note: n })
  } else if (action === 'decline') {
    if (!n) throw err(400, '거절하는 까닭을 한 줄 적어 주세요.')
    await closeAs(me, procKey, [opinion], { state: 'declined', note: n })
    await plansClosed(me, [opinion], { state: 'declined', note: n })
  } else if (action === 'keep') {
    if (!n) throw err(400, '그대로 두는 까닭을 한 줄 적어 주세요.')
    await closeAs(me, procKey, opinions, { state: 'declined', note: n })
    await plansClosed(me, opinions, { state: 'declined', note: n })
  } else throw err(400, 'action 은 apply · decline · keep 이에요.')
  return opinionsView(me, procKey)
}

