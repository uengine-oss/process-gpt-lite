// 말로 프로세스 지도 고치기 · 더하기(design-v0.3 §30): a person says what to change — on the map's instruction box, in chat, or on a step of
// a running case — and the words become operations on the company's process map, the same corrections 다듬기 keeps (refine.js
// pro_corrections, source said, why = the words). Three scopes, from what is selected: nothing → a new process from words; a process → change
// it; steps/ways inside it → change only within that range (enforced here, not only in the prompt: what the words ask outside is not applied
// and is listed 「범위 밖이라 하지 않았어요」).
//   words → the model (prompts/edit-map.md, rules.edit.judge — the same judge as 다듬기) → operations → checked here: names matched to the
//   company's work (names.js resolveLabels, kept nowhere before 적용), the scope, whether each applies on top of the others (refine.js
//   wontApply) → a preview (before · after drawn with 더함 · 뺌 · 바뀜, a plain list, one question back when unclear) → 적용 (admin) stores
//   them. Nothing changes before 적용; every change is one row in 「고친 기록」 and is undone one by one there.
// A process made by words is a Process on the map with the key said:… (stage 제안, band said): its new steps are Task nodes (kind said, n 0),
// its ways are its new_process row (all decided, in at any θ). A build keeps it (build.js keptAfterBuild); cases that do the same work later
// count on the same task nodes. It runs on both engines like any process (procGraph → snapshot · map engine).
// The model sees only the scope's steps (names, roles, who does them, counts) and ways, never mail text; people's names are masked before
// and put back after.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { maskPii } from '../policy/pii.js'
import { cypher, readGraph } from './store.js'
import { END } from './stats.js'
import { prompt, rules as skillRules } from './discovery.js'
import { judge } from './judge.js'
import { ledger } from './review.js'
import { ALL_OPS, EDIT_OPS, SIDE_OPS, normFix, labelOf, applyCorrections, refinedView, insertCorrection, correctionsOf, baseOf, isSaidKey, wontApply, flowOrder } from './refine.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const sha = (s, n = 10) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const flat = (s) => String(s || '').replace(/\s+/g, '')
const fin = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0 }
const iga = (w) => (fin(w) ? '이' : '가')
const eul = (w) => (fin(w) ? '을' : '를')
const wid = (a, b) => `${a}\u0000${b}`
export const OUT_OF_RANGE = '범위 밖이라 하지 않았어요'
export const ADMIN_ONLY = '적용은 관리자만 할 수 있어요 — 의견으로 남길 수 있어요'
const DEFAULTS = { judge: { via: 'claude-cli', model: 'claude-fable-5-2', fallback: 'gateway' }, timeoutMs: 240000, matchTimeoutMs: 30000, maxOps: 12, maxSteps: 16, wordsChars: 600, neighbours: 1, companySteps: 120 }
export const editRules = async () => ({ ...DEFAULTS, ...((await skillRules()).edit || {}) })
const KIND_OF = { add_task: 'add', add_edge: 'add', new_process: 'add', remove_task: 'remove', remove_edge: 'remove' }

// ---------- the scope (pure) ----------
// what an operation touches: the steps and ways it changes (opinions.js reads it too)
export function touchOf({ op, args: a = {} }) {
  switch (op) {
    case 'reverse_edge': case 'remove_edge': case 'add_edge': case 'set_cond': return { tasks: [], ways: [[a.from, a.to]] }
    case 'rename_task': case 'set_role': case 'set_runner': case 'set_requirement': case 'remove_task': return { tasks: [a.task], ways: [] }
    case 'merge_task': return { tasks: [a.task, a.into], ways: [] }
    case 'set_parallel': return { tasks: [a.a, a.b], ways: [] }
    case 'move_task': return { tasks: [a.task, a.after, a.before].filter((k) => k && k !== END), ways: [] }
    case 'add_task': return a.after && a.before ? { tasks: [], ways: [[a.after, a.before]] } : { tasks: [a.after || a.before].filter((k) => k && k !== END), ways: [] }
    case 'set_timer': return { tasks: [a.entry].filter(Boolean), ways: [], process: true }
    case 'new_process': return { tasks: (a.steps || []).map((s) => s.name), ways: (a.ways || []).map((w) => [w.from, w.to]), process: true }
    default: return { tasks: [], ways: [] }
  }
}

// '' when the operation stays inside the range (range: {tasks, ways:[{from,to}]}), else why it does not. Ways inside the range: the ones picked
// and any between two picked steps (to 끝 too); a step's own change needs the step picked; putting a step between two needs that way.
export function inRange(fix, range) {
  if (!range) return ''
  const T0 = new Set(range.tasks || [])
  const W = new Set((range.ways || []).map((w) => wid(w.from, w.to)))
  const way = (a, b) => W.has(wid(a, b)) || (T0.has(a) && (b === END || T0.has(b)))
  const a = fix.args || {}
  switch (fix.op) {
    case 'reverse_edge': case 'remove_edge': case 'add_edge': case 'set_cond': return way(a.from, a.to) ? '' : OUT_OF_RANGE
    case 'rename_task': case 'set_role': case 'set_runner': case 'set_requirement': case 'remove_task': return T0.has(a.task) ? '' : OUT_OF_RANGE
    case 'merge_task': return T0.has(a.task) && T0.has(a.into) ? '' : OUT_OF_RANGE
    case 'set_parallel': return T0.has(a.a) && T0.has(a.b) ? '' : OUT_OF_RANGE
    case 'move_task': return T0.has(a.task) && (!a.after || T0.has(a.after)) && (!a.before || (a.before === END ? !!a.after : T0.has(a.before))) ? '' : OUT_OF_RANGE
    case 'add_task':
      if (a.after && a.before) return way(a.after, a.before) ? '' : OUT_OF_RANGE
      if (a.after) return T0.has(a.after) ? '' : OUT_OF_RANGE
      return a.before && a.before !== END && T0.has(a.before) ? '' : OUT_OF_RANGE
    default: return OUT_OF_RANGE
  }
}
const rangeOf = (scope) => {
  const tasks = [...new Set((scope?.tasks || []).map(clean).filter(Boolean))]
  const ways = (scope?.ways || []).map((w) => ({ from: clean(w?.from), to: clean(w?.to) === '끝' ? END : clean(w?.to) })).filter((w) => w.from && w.to)
  return tasks.length || ways.length ? { tasks, ways } : null
}

// ---------- names (pure part) ----------
// a name said → the one the pool has: the same, or the same without spaces (null: not known)
export function sameName(name, pool) {
  const n = clean(name)
  if (!n) return null
  if (pool.has(n)) return n
  const f = flat(n)
  for (const k of pool) if (flat(k) === f) return k
  return null
}
// A step said as new is the company's work of another name only when it is the same kind of work: the reader of mail (names.js) folds
// 「견적서 송부」 into 「견적서 작성」 — right for a mail, wrong for a step of its own. So the last word (what is done) must be the same or of the
// same family (만들기 · 작성, 발송 · 송부 …); a name that differs only in spacing is always the same.
const FAMILIES = [['작성', '만들기', '만듦', '쓰기', '작성하기', '초안', '작업'], ['발송', '송부', '전송', '보내기', '보냄', '전달', '회신', '답장', '제출'], ['승인', '결재', '허가', '재가'],
  ['검토', '확인', '점검', '검수'], ['보고', '공유', '알림', '안내'], ['접수', '받기', '수신'], ['준비', '마련'], ['진행', '실시', '운영']]
const actionOf = (name) => { const w = clean(name).split(' '); return w.length > 1 ? w.at(-1) : (/(작성|발송|송부|승인|결재|검토|확인|보고|공유|접수|준비|진행|회신|전달|안내|요청)$/.exec(flat(name))?.[1] || '') }
export function sameWork(said, known) {
  if (flat(said) === flat(known)) return true
  const a = actionOf(said), b = actionOf(known)
  if (!a || !b) return false
  return a === b || FAMILIES.some((f) => f.includes(a) && f.includes(b))
}

// every name an operation refers to as a step that is there already ([field, value] — rewritten by setRef)
const REFS = { reverse_edge: ['from', 'to'], remove_edge: ['from', 'to'], add_edge: ['from', 'to'], set_cond: ['from', 'to'], rename_task: ['task'], set_role: ['task'],
  set_runner: ['task'], set_requirement: ['task'], remove_task: ['task'], merge_task: ['task', 'into'], set_parallel: ['a', 'b'], move_task: ['task', 'after', 'before'],
  add_task: ['after', 'before'], set_timer: ['entry'] }
export const refsOf = (fix) => (REFS[fix.op] || []).map((k) => [k, fix.args?.[k]]).filter(([, v]) => v && v !== END)

// ---------- people's names: masked for the model, put back after ----------
export function masker(names = [], extra = null) {
  const list = [...new Set(names.map(clean).filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length)
  const back = new Map(), fwd = new Map()
  const token = (name) => { if (!fwd.has(name)) { const t = `사람${fwd.size + 1}`; fwd.set(name, t); back.set(t, name) } return fwd.get(name) }
  const mask = (text) => {
    let t = String(text || '')
    for (const n of list) if (t.includes(n)) t = t.split(n).join(token(n))
    if (extra) t = t.replace(extra, (m, ...g) => { const title = g[0] || ''; const name = m.slice(0, m.length - title.length).trim(); return `${token(name)} ${title}`.trim() })
    return maskPii(t)
  }
  const unmask = (v) => {
    if (typeof v === 'string') { let s = v; for (const [t, n] of back) s = s.split(t).join(n); return s }
    if (Array.isArray(v)) return v.map(unmask)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmask(x)]))
    return v
  }
  return { mask, unmask, back }
}
async function peopleOf(roles = []) {
  const rows = await q(`select coalesce(nullif(username,''), '') as name from users where tenant_id=$1 and not coalesce(is_agent,false)
                        union select coalesce(p.name,'') from pro_profile p join users u on u.id::text = p.user_id::text and u.tenant_id=$1`, [T()]).catch(() => [])
  const skip = new Set(roles.map(clean))
  return rows.map((r) => clean(r.name)).filter((n) => n && !skip.has(n) && !/@/.test(n))
}

// ---------- the flow as drawn (Flow, .scratch/editmap-contract.md) ----------
export function flowOf(view) {
  if (!view) return null
  const tasks = [...view.tasks.values()].map((t) => {
    const n = t.n || 0
    return { key: t.key, role: t.role || '', n, origin: t.origin === undefined ? t.key : t.origin, ...(t.added ? { added: true } : {}), ...(t.said ? { said: true } : {}),
      ...(t.runner ? { runner: t.runner } : {}), ...(t.decided || t.added || t.said ? { decided: true } : {}), ...((t.decided || t.added || t.said) && !n ? { unseen: true } : {}) }
  })
  const edges = view.edges.filter((e) => e.status !== 'retired' && e.from !== e.to).map((e) => ({ from: e.from, to: e.to, n: e.n || 0, p: +(e.p || 0).toFixed(3),
    ...(e.decided ? { decided: true } : {}), ...(e.decided && !e.n ? { unseen: true } : {}), ...(e.added ? { added: true } : {}), ...(e.cond ? { cond: e.cond } : {}),
    ...(e.parallel ? { parallel: true } : {}), ...(e.pinned ? { pinned: true } : {}), status: e.status || 'active', ...(e.stale ? { stale: true } : {}), ...(e.thin ? { thin: true } : {}) }))
  const order = flowOrder(tasks, edges, view.proc?.entries || [])
  return { tasks: order, edges, entries: (view.proc?.entries || []).filter((k) => view.tasks.has(k)) }
}

// before → after with 더함 · 뺌 · 바뀜 on the after (removed things stay, marked, so the drawing can strike them). A step is the same step
// across a rename (its origin); a way is the same way between the same steps.
export function diffFlows(before, after) {
  const idT = (t) => t.origin || `+${t.key}`
  const bT = new Map((before?.tasks || []).map((t) => [idT(t), t]))
  const aT = new Map(after.tasks.map((t) => [idT(t), t]))
  const keyB = new Map((before?.tasks || []).map((t) => [t.key, idT(t)])), keyA = new Map(after.tasks.map((t) => [t.key, idT(t)]))
  const idE = (e, m) => wid(m.get(e.from) || e.from, e.to === END ? END : m.get(e.to) || e.to)
  const bE = new Map((before?.edges || []).map((e) => [idE(e, keyB), e]))
  const aE = new Set(after.edges.map((e) => idE(e, keyA)))
  const RUN = { agent: '에이전트', person: '사람' }
  const tasks = after.tasks.map((t) => {
    if (!before) return { ...t, diff: 'add' }
    const b = bT.get(idT(t))
    if (!b) return { ...t, diff: 'add' }
    const ch = []
    if (b.key !== t.key) ch.push(`이름: ${b.key} → ${t.key}`)
    if ((b.role || '') !== (t.role || '')) ch.push(`역할: ${b.role || '없음'} → ${t.role || '없음'}`)
    if ((b.runner || 'person') !== (t.runner || 'person') && (b.runner || t.runner)) ch.push(`하는 이: ${RUN[b.runner || 'person']} → ${RUN[t.runner || 'person']}`)
    return ch.length ? { ...t, diff: 'change', change: ch.join(' · '), ...(b.key !== t.key ? { was: b.key } : {}) } : t
  })
  const edges = after.edges.map((e) => {
    if (!before) return { ...e, diff: 'add' }
    const b = bE.get(idE(e, keyA))
    if (!b) return { ...e, diff: 'add' }
    const ch = []
    if ((b.cond || '') !== (e.cond || '')) ch.push(`조건: ${b.cond || '없음'} → ${e.cond || '없음'}`)
    if (!!b.parallel !== !!e.parallel) ch.push(e.parallel ? '나란히' : '차례로')
    return ch.length ? { ...e, diff: 'change', change: ch.join(' · ') } : e
  })
  if (before) {
    // what the after has no more: by origin (a renamed step is not gone); its ways keep the before's names
    for (const [id, b] of bT) if (!aT.has(id)) tasks.push({ ...b, diff: 'remove' })
    const shownKey = (k) => (k === END ? END : [...aT.values()].find((t) => idT(t) === (keyB.get(k) || k))?.key || k)
    for (const [id, b] of bE) if (!aE.has(id)) edges.push({ ...b, from: shownKey(b.from), to: shownKey(b.to), diff: 'remove' })
  }
  return { tasks, edges, entries: after.entries }
}

// ---------- reading what the words need ----------
async function mapFacts() {
  const g = await readGraph({})
  const roles = [...new Set([...g.roles.filter((r) => !r.outside).map((r) => r.name || r.key), ...(await q(`select distinct role from pro_role_members where tenant_id=$1 union select distinct role from pro_role_assignments where tenant_id=$1`, [T()]).catch(() => [])).map((r) => r.role)].filter(Boolean))]
  return { g, roles }
}
async function viewOf(g, procKey) {
  const proc = g.processes.find((p) => p.key === procKey)
  if (!proc || proc.kind === 'routine') throw err(404, '프로세스를 찾지 못했어요.')
  const cs = await correctionsOf(procKey)
  const base = baseOf(g, proc, cs)
  const found = { tasks: [...base.tasks.values()].map((t) => ({ key: t.key, role: t.role || '', n: t.n || 0 })),
    edges: base.edges.filter((e) => e.status !== 'retired').map((e) => ({ from: e.from, to: e.to, n: e.n || 0, p: e.p || 0 })) }
  return { proc, cs, base, found, view: cs.length ? refinedView(base, cs) : refinedView(base, []) }
}
// who does each step now (the definition, or what a person said for this process)
async function runnersOf(view) {
  const { taskDefinition } = await import('./taskdef.js')
  const out = new Map()
  for (const t of view.tasks.values()) out.set(t.key, (await taskDefinition(t.key, t)).runner)
  return out
}

// what the model gets: the scope's steps and ways (a range: the picked ones and their neighbours, marked), the company's roles — no mail
export async function modelInput({ kind, proc, view, range, words, answer, roles, company, runners, requirements, R }) {
  if (kind === 'new') return { scope: 'new', roles: roles.slice(0, 60), company_steps: company.slice(0, R.companySteps), words, ...(answer ? { answer } : {}) }
  const inside = range ? new Set([...range.tasks, ...range.ways.flatMap((w) => [w.from, w.to])]) : null
  let keys = [...view.tasks.keys()]
  if (inside) {
    const near = new Set(inside)
    for (let i = 0; i < (R.neighbours ?? 1); i++) for (const e of view.edges) { if (near.has(e.from) && e.to !== END) near.add(e.to); if (near.has(e.to)) near.add(e.from) }
    keys = keys.filter((k) => near.has(k))
  }
  const ks = new Set(keys)
  const wayIn = (e) => !range || range.ways.some((w) => w.from === e.from && w.to === e.to) || (range.tasks.includes(e.from) && (e.to === END || range.tasks.includes(e.to)))
  return {
    scope: range ? 'range' : 'process',
    process: { name: proc.name, summary: proc.summary || '', starts_with: (view.proc.entries || []).slice(0, 3) },
    steps: keys.map((k) => { const t = view.tasks.get(k); return { name: k, role: t.role || '', runner: runners.get(k) || 'person', n: t.n || 0, ...(requirements.get(k)?.requirement ? { requirement: requirements.get(k).requirement } : {}), ...(inside ? { in_range: range.tasks.includes(k) } : {}) } }),
    ways: view.edges.filter((e) => e.status !== 'retired' && ks.has(e.from) && (e.to === END || ks.has(e.to)) && e.from !== e.to)
      .map((e) => ({ from: e.from, to: e.to === END ? '끝' : e.to, n: e.n || 0, ...(e.cond ? { cond: String(e.cond).replace(/\s*\(amount\)/, '') } : {}), ...(e.parallel ? { parallel: true } : {}), ...(range ? { in_range: wayIn(e) } : {}) })),
    roles: roles.slice(0, 60), words, ...(answer ? { answer } : {}),
  }
}

// ---------- checking operations (no model) ----------
// raw operations (the model's or a card's) → {ok, refused, matched}: each read (normFix), its names matched, inside the scope, applying on
// top of the corrections already there and the ones before it. kind: new | process | range. match(names, pool) → Map(name → known name)
export async function checkOps({ kind, raw = [], found, cs = [], view = null, range = null, company = new Set(), R = DEFAULTS, match = null }) {
  const ok = [], refused = [], matched = []
  const inProc = new Set(view ? [...view.tasks.keys()] : [])
  const refuse = (fix, why, raw0) => refused.push({ op: fix?.op || clean(raw0?.op) || '?', args: fix?.args || raw0?.args || {}, label: fix ? labelOf(fix) : clean(raw0?.op) || '읽지 못한 동작', why })
  // the names: steps there already (this process), new steps (the company's work of that name when there is one)
  const fixes = raw.slice(0, (R.maxOps || 12) * 2).map((x) => ({ raw: x, fix: normFix(x) }))
  const refNames = new Set(), newNames = new Set()
  for (const { fix } of fixes) {
    if (!fix) continue
    for (const [, v] of refsOf(fix)) if (!sameName(v, inProc)) refNames.add(v)
    if (fix.op === 'add_task' && !sameName(fix.args.name, inProc) && !sameName(fix.args.name, company)) newNames.add(fix.args.name)
    if (fix.op === 'new_process') for (const s of fix.args.steps) if (!sameName(s.name, company)) newNames.add(s.name)
  }
  const fromModel = match ? await match([...refNames, ...newNames], { inProc, company }).catch(() => new Map()) : new Map()
  const known = (name, pool, allowModel = true) => sameName(name, pool) || (allowModel && pool.has(fromModel.get(name)) ? fromModel.get(name) : null)
  const note = (said, task) => { if (said !== task && !matched.some((m) => m.said === said)) matched.push({ said, task }) }
  const seen = new Set()
  let overlay = []
  for (const { raw: r0, fix: f0 } of fixes) {
    if (!f0) { refuse(null, '읽지 못한 동작이에요.', r0); continue }
    const fix = JSON.parse(JSON.stringify(f0))
    if (kind === 'new' && fix.op !== 'new_process') { refuse(fix, '새 프로세스를 그릴 때는 고르지 않은 동작이에요.'); continue }
    if (kind !== 'new' && fix.op === 'new_process') { refuse(fix, '고르고 있는 프로세스가 있어 새 프로세스는 만들지 않았어요 — 아무것도 고르지 않고 말해 주세요.'); continue }
    // names that are there: as this process has them
    let missing = ''
    for (const [k, v] of refsOf(fix)) {
      const m = known(v, inProc)
      if (!m) { missing ||= `「${v}」${iga(v)} 이 프로세스에 없어요.`; continue }
      if (m !== v) { note(v, m); fix.args[k] = m }
    }
    if (missing) { refuse(fix, missing); continue }
    if (fix.op === 'add_task') {
      if (sameName(fix.args.name, inProc)) { refuse(fix, `「${sameName(fix.args.name, inProc)}」${eul(fix.args.name)} 이 프로세스에 이미 있어요 — 옮기려면 「옮겨 줘」라고 말해 주세요.`); continue }
      // a step the company already does elsewhere: that work (its definition and records), not a second name for it
      const m = known(fix.args.name, company)
      if (m && m !== fix.args.name && !inProc.has(m) && sameWork(fix.args.name, m)) { note(fix.args.name, m); fix.args.name = m }
    }
    if (fix.op === 'new_process') {
      // (two steps said apart stay apart: a match that lands on another step of the same process is not taken)
      const rename = new Map(), taken = new Set(fix.args.steps.map((s) => s.name))
      for (const s of fix.args.steps) {
        const m = known(s.name, company)
        if (!m || m === s.name || !sameWork(s.name, m) || (taken.has(m) && m !== s.name) || [...rename.values()].includes(m)) continue
        note(s.name, m); rename.set(s.name, m); taken.add(m); s.name = m
      }
      const rn = (k) => rename.get(k) || k
      fix.args.ways = fix.args.ways.map((w) => ({ ...w, from: rn(w.from), to: rn(w.to) })).filter((w) => w.from !== w.to)
      fix.args.start = rn(fix.args.start)
      if (fix.args.parallel) fix.args.parallel = fix.args.parallel.map(([x, y]) => [rn(x), rn(y)])
      if (fix.args.steps.length > (R.maxSteps || 16)) { refuse(fix, `단계가 ${fix.args.steps.length}개예요 — 한 번에 ${R.maxSteps || 16}개까지 그려요.`); continue }
      if (!fix.args.ways.length && fix.args.steps.length > 1) fix.args.ways = fix.args.steps.slice(1).map((s, i) => ({ from: fix.args.steps[i].name, to: s.name }))
      if (!fix.args.ways.some((w) => w.to === END)) {
        const outs = new Set(fix.args.ways.map((w) => w.from))
        for (const s of fix.args.steps) if (!outs.has(s.name)) fix.args.ways.push({ from: s.name, to: END })
      }
    }
    const k = JSON.stringify([fix.op, fix.args])
    if (seen.has(k)) continue
    seen.add(k)
    const out = inRange(fix, kind === 'range' ? range : null)
    if (out) { refuse(fix, out); continue }
    if (fix.op === 'set_timer') {
      if (fix.args.entry && !inProc.has(fix.args.entry)) { refuse(fix, '시작할 일을 이 프로세스에서 찾지 못했어요.'); continue }
      const { cronKo } = await import('./timers.js')
      if (cronKo(fix.args.cron) === fix.args.cron) { refuse(fix, '주기를 읽지 못했어요.'); continue }
      fix.args.when = cronKo(fix.args.cron)
    }
    if (fix.op === 'set_requirement' && !inProc.has(fix.args.task)) { refuse(fix, '그 단계가 이 프로세스에 없어요.'); continue }
    // applies on top of what is there and what came before (the overlay, no model)
    if (EDIT_OPS.includes(fix.op) && found) {
      const why = wontApply(found, [...cs, ...overlay], fix)
      if (why) { refuse(fix, why); continue }
      overlay = [...overlay, { ...fix, id: `p${overlay.length}` }]
    }
    if (ok.length >= (R.maxOps || 12)) { refuse(fix, `한 번에 ${R.maxOps || 12}가지까지 고쳐요.`); continue }
    ok.push({ ...fix, label: labelOf(fix) })
  }
  return { ok, refused, matched }
}

// the model's name matching for what is not plainly the same (names.js, kept nowhere: a preview writes nothing)
async function modelMatch(names, { inProc, company }) {
  const out = new Map()
  if (!names.length) return out
  const { resolveLabels } = await import('./names.js')
  const pool = [...new Set([...inProc, ...company])]
  // (a preview waits for a person: a short try, no retry — unmatched names stay as said)
  const R = await editRules()
  const r = await resolveLabels(names.map((raw) => ({ raw })), { known: pool, keep: false, timeoutMs: R.matchTimeoutMs || 30000, tries: 1 })
  for (const n of names) { const x = r.get(clean(n)); if (x?.task && pool.includes(x.task)) out.set(n, x.task) }
  return out
}

// ---------- the plan (the preview) ----------
// ops ok → the drawing before and after, the plain list
export function previewOf({ kind, base, cs, ok, newProc = null, g = null }) {
  if (kind === 'new') {
    const np = ok.find((x) => x.op === 'new_process')
    if (!np) return { before: null, after: { tasks: [], edges: [], entries: [] } }
    const steps = np.args.steps.map((s) => s.name)
    const proc = { key: 'said:new', name: np.args.name, kind: 'flow', status: 'suggested', tasks: steps, entries: [np.args.start] }
    const fake = { tasks: g?.tasks || [], edges: g?.edges || [], processes: [proc] }
    const b = baseOf(fake, proc, [np])
    for (const s of steps) if (!b.tasks.has(s)) b.tasks.set(s, { key: s, role: '', n: 0, status: 'active' })
    const after = flowOf(refinedView(b, [{ ...np, id: 'np' }]))
    return { before: null, after: diffFlows(null, after) }
  }
  const before = flowOf(refinedView(base, cs))
  const overlay = ok.filter((x) => EDIT_OPS.includes(x.op) || x.op === 'new_process').map((x, i) => ({ op: x.op, args: x.args, id: `p${i}` }))
  const after = flowOf(refinedView(base, [...cs, ...overlay]))
  return { before, after: diffFlows(before, after) }
}
export const changesOf = (ok) => ok.map((x) => ({ kind: KIND_OF[x.op] || 'change', text: x.label }))

// words → the plan. me: who asks (적용 is the admin's; anyone may leave it as an opinion)
export async function planEdit(me, { proc: procKey = '', scope = null, words = '', answer = '' } = {}) {
  const R = await editRules()
  const said = clean(words).slice(0, R.wordsChars || 600)
  if (!said) throw err(400, '무엇을 바꿀지 말해 주세요.')
  const t0 = Date.now()
  const { g, roles } = await mapFacts()
  const kind = !procKey ? 'new' : rangeOf(scope) ? 'range' : 'process'
  const range = kind === 'range' ? rangeOf(scope) : null
  const company = new Set(g.tasks.filter((t) => t.kind !== 'habit').map((t) => t.key))
  const companyByN = [...g.tasks].filter((t) => t.kind !== 'habit').sort((a, b) => (b.n || 0) - (a.n || 0)).map((t) => t.key)
  let ctx = null, runners = new Map(), requirements = new Map()
  if (kind !== 'new') {
    ctx = await viewOf(g, procKey)
    runners = await runnersOf(ctx.view)
    requirements = await (await import('./edgecond.js')).stepRequirementsOf(procKey, ctx.view).catch(() => new Map())
    if (range) for (const k of range.tasks) if (!ctx.view.tasks.has(k)) throw err(400, `고른 「${k}」${iga(k)} 이 프로세스의 흐름에 없어요.`)
  }
  const input = await modelInput({ kind, proc: ctx?.proc, view: ctx?.view, range, words: said, answer: clean(answer).slice(0, 300), roles, company: companyByN, runners, requirements, R })
  const m = masker(await peopleOf(roles), null)
  const { r, model } = await judge(await prompt('edit-map'), m.mask(JSON.stringify(input)), { judge: R.judge, timeoutMs: R.timeoutMs })
  const out = m.unmask(r || {})
  const raw = Array.isArray(out.ops) ? out.ops : []
  const checked = await checkOps({ kind, raw, found: ctx?.found || null, cs: ctx?.cs || [], view: ctx?.view || null, range, company, R, match: modelMatch })
  const plan = await shapePlan(me, { kind, ctx, range, words: said, checked, g, question: clean(out.question).slice(0, 200), note: clean(out.note).slice(0, 300), model, ms: Date.now() - t0 })
  if (kind !== 'new' && plan.ops.length) plan.effect = await effectOf(me, plan.proc.key, plan.ops)
  return plan
}

// 예상 효과(설계 §5.2 끝): the plan's operations as levers on the map's numbers (flowplan.js) — 지금 들어오면 · 보통 건 · 병목, before → after.
// null when none of the operations is one the arithmetic reads (이름 · 순서만 바꾸는 고침) or the map has no run records yet
export async function effectOf(me, procKey, ops = []) {
  try {
    const { normLever } = await import('./flowplan.js')
    const levers = ops.map(normLever).filter(Boolean)
    if (!levers.length) return null
    const w = await (await import('./flowload.js')).whatIfView(me, { proc: procKey, levers })
    const side = (s) => ({ pastH: s.pastH, nowH: s.nowH, bottleneck: s.bottleneck, constraint: s.constraint ? { role: s.constraint.role, perPerson: s.constraint.perPerson, rho: s.constraint.rho } : null })
    return { before: side(w.before), after: side(w.after), levers: w.levers.map((l) => l.label), moved: w.moved, notes: w.notes, estimated: true }
  } catch (e) { console.warn('[ontology] effect', e.message); return null }
}

async function shapePlan(me, { kind, ctx, range, words, checked, g, question = '', note = '', model = '', ms = 0 }) {
  const { ok, refused, matched } = checked
  const { before, after } = previewOf({ kind, base: ctx?.base, cs: ctx?.cs || [], ok, g })
  const admin = me ? await (await import('./service.js')).isAdmin(me).catch(() => false) : false
  const np = ok.find((x) => x.op === 'new_process')
  return {
    scope: kind, proc: ctx ? { key: ctx.proc.key, name: ctx.proc.name } : null, words, range, name: np?.args?.name || '',
    ops: ok.map(({ op, args, label }) => ({ op, args, label })), refused, matched, question, note,
    before, after, changes: changesOf(ok), model, ms,
    canApply: admin && ok.length > 0, whyNot: !admin ? ADMIN_ONLY : ok.length ? '' : '바꿀 것이 없어요.', canVoice: kind !== 'new',
  }
}

// a plan from operations already made (a chat draft's contract, an opinion): no model
// matchNames: false — the names are the ones a preview already matched (적용 asks no model)
export async function planOps(me, { proc: procKey = '', scope = null, words = '', ops = [], kind: forced = null, matchNames = true } = {}) {
  const R = await editRules()
  const { g } = await mapFacts()
  const kind = forced || (!procKey ? 'new' : rangeOf(scope) ? 'range' : 'process')
  const range = kind === 'range' ? rangeOf(scope) : null
  const company = new Set(g.tasks.filter((t) => t.kind !== 'habit').map((t) => t.key))
  const ctx = kind === 'new' ? null : await viewOf(g, procKey)
  const checked = await checkOps({ kind, raw: ops, found: ctx?.found || null, cs: ctx?.cs || [], view: ctx?.view || null, range, company, R, match: kind === 'new' && matchNames ? modelMatch : null })
  return shapePlan(me, { kind, ctx, range, words: clean(words).slice(0, R.wordsChars || 600), checked, g })
}

// ---------- 적용 ----------
// a process made by words on the map: its new steps as tasks (kind said, n 0), the process (stage 제안), its membership
async function createSaid(me, args) {
  const now = new Date().toISOString()
  const w = { validFrom: now, actor: me.email || String(me.id), reason: `말로 만든 프로세스 — ${args.name}` }
  const key = `said:${sha(`${T()}|${args.name}|${now}`)}`
  const have = new Map((await cypher('MATCH (t:Task) RETURN t.key AS key, t.status AS status')).map((r) => [r.key, r.status]))
  const steps = args.steps.map((s) => s.name)
  for (const s of args.steps) {
    if (!have.has(s.name)) {
      await cypher(`CREATE (t:Task {key:$key, name:$key, role:$role, kind:'said', n:0, n_cases:0, entry_share:0, exit_share:0, people:0, status:'active', pinned:false, candidate:false, sources:$sources})`,
        { key: s.name, role: s.role || '', sources: JSON.stringify({ said: 1 }) }, w)
    } else if (have.get(s.name) === 'gone') await cypher('MATCH (t:Task {key:$key}) SET t.status=$status', { key: s.name, status: 'active' }, w)
  }
  await cypher(`CREATE (b:Process {key:$key, name:$name, summary:$summary, kind:'flow', status:'suggested', autonomy:'draft', tasks:$tasks, entries:$entries, cases:0, band:'said',
                 theta:0.05, summary_theta:0, half_life:0, theta_start:false, owner:$owner})`,
  { key, name: args.name, summary: args.summary || '', tasks: steps, entries: [args.start || steps[0]], owner: me.email || '' }, w)
  for (const s of steps) await cypher(`MATCH (b:Process {key:$key}), (t:Task {key:$task}) CREATE (b)-[:HAS_TASK {n:0, share:0, entry_share:0}]->(t)`, { key, task: s }, w)
  return key
}

export async function applyEdit(me, { proc: procKey = '', scope = null, words = '', ops = [], messageId = null, resolve = null, opinionId = null, source = 'said' } = {}) {
  const { isAdmin } = await import('./service.js')
  if (!(await isAdmin(me))) throw err(403, ADMIN_ONLY)
  const plan = await planOps(me, { proc: procKey, scope, words, ops, matchNames: false })
  if (!plan.ops.length) throw err(409, `적용할 것이 없어요${plan.refused.length ? ` — ${plan.refused.map((x) => `${x.label}: ${x.why}`).join(' / ')}` : '.'}`)
  const why = clean(words).slice(0, 300) || '말로 고침'
  const batch = crypto.randomUUID()
  const applied = []
  let key = procKey, name = plan.proc?.name || ''
  if (plan.scope === 'new') {
    const np = plan.ops.find((x) => x.op === 'new_process')
    key = await createSaid(me, np.args)
    name = np.args.name
    const id = await insertCorrection(me, key, { op: 'new_process', args: np.args, why, source, batch, opinionId })
    applied.push({ id, op: 'new_process', label: np.label })
    await ledger(me, 'ontology.edit', `말로 만든 프로세스 「${name}」: ${np.label}`, { proc: key, op: 'new_process', words: why, batch, id, steps: np.args.steps.map((s) => s.name) })
  } else {
    for (const x of plan.ops) {
      let args = x.args
      if (x.op === 'set_requirement') {
        // 꼭 · 선택 lives on the ways into the step (edge settings, edgecond.js) — every way into it in this process, each keeping its rules
        const was = await (await import('./edgecond.js')).setStepRequirement(me, key, args.task, args.requirement, { reason: why })
        args = { ...args, was }
      } else if (x.op === 'set_timer') {
        const t = await (await import('./timers.js')).addProcessTimer(me, { proc: key, entry: args.entry, cron: args.cron })
        args = { ...args, entry: t.entry, when: t.when, event: t.key }
      }
      const id = await insertCorrection(me, key, { op: x.op, args, why, source, batch, opinionId })
      applied.push({ id, op: x.op, label: x.label })
      await ledger(me, 'ontology.edit', `말로 고침 「${name}」: ${x.label}`, { proc: key, op: x.op, args, words: why, batch, id, ...(opinionId ? { opinion: opinionId } : {}) })
    }
  }
  const result = { proc: { key, name }, applied, refused: plan.refused, said: isSaidKey(key), batch }
  if (resolve?.opinions?.length) await (await import('./opinions.js')).closeAs(me, key, resolve.opinions, { state: 'merged', note: resolve.note || '', batch })
  if (messageId) await markMessage(me, messageId, { applied: result })
  return result
}

// 되돌리기 of a change kept in its own table (refine.js removeCorrection): the 꼭 · 선택 it replaced (only when nobody changed it since) · the timer
export async function undoSide(me, procKey, row) {
  const a = row.args || {}
  if (row.op === 'set_requirement') {
    // (a change made before edge settings kept one step row in `was` — nothing on the edges to put back)
    if (Array.isArray(a.was)) await (await import('./edgecond.js')).restoreStepRequirement(me, procKey, { task: a.task, requirement: a.requirement, was: a.was }, { reason: '말로 고친 것을 되돌림' })
  }
  if (row.op === 'set_timer' && a.event) await (await import('./timers.js')).setTimerStatus(me, a.event, 'gone').catch((e) => { if (e.status !== 404) throw e })
}

// 이 프로세스 지우기 (a process made by words): off the map (kept in the history), its own new steps too when no other live process has them;
// its rows (corrections, 꼭 · 선택), its timers and its open opinions go
export async function removeSaid(me, procKey) {
  const { isAdmin } = await import('./service.js')
  if (!(await isAdmin(me))) throw err(403, '관리자만 지울 수 있어요.')
  if (!isSaidKey(procKey)) throw err(400, '말로 만든 프로세스만 지울 수 있어요.')
  const g = await readGraph({})
  const p = g.processes.find((x) => x.key === procKey)
  if (!p) throw err(404, '프로세스를 찾지 못했어요.')
  const w = { validFrom: new Date().toISOString(), actor: me.email || String(me.id), reason: `말로 만든 프로세스 지움 — ${p.name}` }
  await cypher('MATCH (b:Process {key:$key}) SET b.status=$status', { key: procKey, status: 'gone' }, w)
  const others = new Set(g.processes.filter((x) => x.key !== procKey).flatMap((x) => x.tasks || []))
  const mine = g.tasks.filter((t) => (p.tasks || []).includes(t.key) && t.kind === 'said' && !others.has(t.key) && !(t.n > 0)).map((t) => t.key)
  if (mine.length) await cypher(`UNWIND $keys AS k MATCH (t:Task {key:k}) SET t.status='gone'`, { keys: mine }, w)
  for (const s of g.startsOn.filter((x) => x.from === procKey && String(x.to).startsWith('timer:'))) await (await import('./timers.js')).setTimerStatus(me, s.to, 'gone').catch(() => {})
  await q(`delete from pro_corrections where tenant_id=$1 and proc_key=$2`, [T(), procKey])
  await q(`delete from pro_step_requirements where tenant_id=$1 and proc_key=$2`, [T(), procKey])
  await q(`delete from pro_edge_conditions where tenant_id=$1 and proc_key=$2`, [T(), procKey]).catch(() => {})
  await q(`update pro_map_opinions set state='declined', note='프로세스를 지웠어요', decided_by=$3, decided_at=now(), updated_at=now() where tenant_id=$1 and proc_key=$2 and state='open'`, [T(), procKey, String(me.id)]).catch(() => {})
  await ledger(me, 'ontology.edit', `말로 만든 프로세스 지움: ${p.name}`, { proc: procKey, tasks: mine })
  return { removed: procKey, tasks: mine }
}

// the decided flow of every process a person refined or made by words, for the map to draw (service.js map: refined) — as of validAt
export async function refinedFlows(g, procs, { validAt } = {}) {
  const rows = await q(`select proc_key, id::text as id, op, args from pro_corrections where tenant_id=$1 and ($2::timestamptz is null or at <= $2) order by at, id`, [T(), validAt || null]).catch(() => [])
  const by = new Map()
  for (const r of rows) { if (!by.has(r.proc_key)) by.set(r.proc_key, []); by.get(r.proc_key).push(r) }
  const out = {}
  for (const p of procs) {
    const cs = by.get(p.key) || []
    if (p.kind === 'routine' || (!cs.length && !isSaidKey(p.key))) continue
    const v = refinedView(baseOf(g, p, cs), cs)
    out[p.key] = { ...flowOf(v), removed: v.refined.removed, corrections: cs.length, said: isSaidKey(p.key) }
  }
  return out
}

// ---------- chat ----------
// a process draft card's contract (process-gpt's generation: activities, sequences, gateways, roles) → one new_process operation. Sequences
// are followed through gateways to the next activities (or the end); an exclusive gateway's conditions become the ways' conditions (an amount
// when it reads as one), a parallel gateway's branches are side by side; an activity an agent does is the agent's.
export function opsFromContract(contract) {
  const pd = contract?.processDefinition || {}
  const els = Array.isArray(pd.elements) ? pd.elements : []
  const acts = els.length ? els.filter((e) => e.elementType === 'Activity') : (pd.activities || []).map((a) => ({ ...a, elementType: 'Activity' }))
  const seqs = els.length ? els.filter((e) => e.elementType === 'Sequence') : (pd.sequences || []).map((s) => ({ ...s, elementType: 'Sequence' }))
  const gws = new Map((els.length ? els.filter((e) => e.elementType === 'Gateway') : pd.gateways || []).map((g) => [g.id, g]))
  const events = new Map((els.length ? els.filter((e) => e.elementType === 'Event') : pd.events || []).map((e) => [e.id, e]))
  const byId = new Map(acts.map((a) => [a.id, a]))
  const nameOf = (a) => clean(a.name).slice(0, 60)
  const isAgent = (a) => (a.agentMode && a.agentMode !== 'none') || !!a.orchestration || /에이전트|agent/i.test(a.role || '')
  const out = (id) => seqs.filter((s) => (s.source || s.sourceRef) === id)
  // where a sequence leads: activities (with the condition on the way) — through gateways, at most a few levels
  const reach = (id, cond = '', depth = 0, par = false) => {
    if (byId.has(id)) return [{ to: nameOf(byId.get(id)), cond, par }]
    if (events.has(id) || depth > 6) return [{ to: END, cond, par }]
    const g = gws.get(id)
    if (!g) return []
    const p = /parallel/i.test(`${g.type || ''} ${g.gateWayType || ''}`)
    return out(id).flatMap((s) => reach(s.target || s.targetRef, (p ? '' : clean(s.condition)) || cond, depth + 1, p || par))
  }
  const steps = acts.map((a) => ({ name: nameOf(a), role: isAgent(a) ? '' : clean(a.role).slice(0, 40), ...(isAgent(a) ? { runner: 'agent' } : { runner: 'person' }) })).filter((s) => s.name)
  const ways = [], parallel = []
  for (const a of acts) {
    const from = nameOf(a)
    const targets = out(a.id).flatMap((s) => reach(s.target || s.targetRef, clean(s.condition)))
    for (const t of targets) if (t.to && t.to !== from && !ways.some((w) => w.from === from && w.to === t.to)) ways.push({ from, to: t.to, ...(t.cond ? { when: whenOfText(t.cond) } : {}) })
    const par = targets.filter((t) => t.par && t.to !== END).map((t) => t.to)
    if (par.length >= 2) parallel.push([par[0], par[1]])
  }
  // the start: the activity the start event leads to (else the first)
  const startEv = [...events.values()].find((e) => /start/i.test(e.type || '') || /시작|요청/.test(e.name || ''))
  const start = startEv ? reach(startEv.id).find((t) => t.to !== END)?.to : null
  return [{ op: 'new_process', args: { name: clean(pd.processDefinitionName || pd.name).slice(0, 40), summary: clean(pd.description).slice(0, 200), start: start || steps[0]?.name || '', steps, ways, ...(parallel.length ? { parallel } : {}) } }]
}
// a condition's words → an amount (「500만 원 이상」 · 「금액 >= 5000000」) when they read as one, else the words
export function whenOfText(text) {
  const t = clean(text)
  const m = /(\d[\d,.]*)\s*(억|천만|백만|만)?\s*원?\s*(이상|초과|이하|미만)/.exec(t) || /(?:금액|amount)\s*(>=|>|<=|<)\s*(\d[\d,]*)/i.exec(t)
  if (m && /이상|초과|이하|미만/.test(m[3] || '')) {
    const unit = { 억: 1e8, 천만: 1e7, 백만: 1e6, 만: 1e4 }[m[2]] || 1
    const value = Math.round(Number(m[1].replace(/,/g, '')) * unit)
    return { amount: { op: { 이상: '>=', 초과: '>', 이하: '<=', 미만: '<' }[m[3]], value } }
  }
  if (m && /[<>]/.test(m[1])) return { amount: { op: m[1], value: Number(m[2].replace(/,/g, '')) } }
  return { text: t.slice(0, 120) }
}

const ownMessage = async (me, id, kind) => (await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2${kind ? ' and m.kind=$3' : ''}`, kind ? [id, me.id, kind] : [id, me.id]))[0] || null
async function markMessage(me, id, { applied, voiced }) {
  const m = await ownMessage(me, id)
  if (!m) return
  const { updateMessage } = await import('../store.js')
  if (m.kind === 'process_draft' && applied) await updateMessage(me.id, id, { mapApplied: { proc: applied.proc, at: new Date().toISOString() } })
  if (m.kind === 'onto-edit') await updateMessage(me.id, id, applied ? { state: 'applied', applied } : { state: 'voiced', ...voiced })
}
export async function voicedOnMessage(me, id, voiced) { if (id) await markMessage(me, id, { voiced }) }

// 「지도에 넣기」 on a process draft card: the draft as a process made by words, previewed on the card
export async function fromDraft(me, msgId) {
  const m = await ownMessage(me, msgId, 'process_draft')
  if (!m) throw err(404, '카드를 찾지 못했어요.')
  const ops = opsFromContract(m.content?.contract)
  const pd = m.content?.contract?.processDefinition || {}
  const plan = await planOps(me, { words: `채팅에서 만든 초안 「${clean(pd.processDefinitionName)}」${pd.description ? ` — ${clean(pd.description).slice(0, 160)}` : ''}`, ops, kind: 'new' })
  const { updateMessage } = await import('../store.js')
  await updateMessage(me.id, msgId, { mapPlan: plan })
  return plan
}

// chat «○○ 프로세스에서 …를 바꿔 줘» (agent.js router, intent edit_map): the process it names (asked when unclear), a card with the preview
export function pickProcess(processes, { name = '', text = '' } = {}) {
  const flows = processes.filter((p) => p.kind !== 'routine' && p.status !== 'gone')
  const said = `${clean(name)} ${clean(text)}`
  const f = flat(said)
  const exact = flows.filter((p) => p.name && (f.includes(flat(p.name)) || (name && flat(p.name) === flat(name))))
  if (exact.length === 1) return { proc: exact[0] }
  const words = said.split(/[\s·,.]+/).filter((x) => x.length >= 2)
  const score = (p) => words.filter((x) => String(p.name || '').includes(x) || (p.tasks || []).some((t) => t.includes(x))).length
  const ranked = (exact.length ? exact : flows).map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0 || exact.length).sort((a, b) => b.s - a.s || (b.p.cases || 0) - (a.p.cases || 0))
  if (ranked.length === 1 || (ranked.length > 1 && ranked[0].s >= 2 && ranked[0].s > ranked[1].s)) return { proc: ranked[0].p }
  return { choices: (ranked.length ? ranked : flows.map((p) => ({ p })).slice(0, 6)).slice(0, 6).map((x) => ({ key: x.p.key, name: x.p.name })) }
}
export async function chatEdit({ user, threadId, query = '', process: name = '', text = '' }) {
  const { addMessage } = await import('../store.js')
  const g = await readGraph({})
  const words = clean(query || text)
  const pick = pickProcess(g.processes, { name, text: `${query} ${text}` })
  if (!pick.proc) return addMessage(user.id, threadId, 'agent', 'onto-edit', { state: 'ask', words, proc: null, choices: pick.choices })
  const msg = await addMessage(user.id, threadId, 'agent', 'onto-edit', { state: 'pending', words, proc: { key: pick.proc.key, name: pick.proc.name } })
  planEdit(user, { proc: pick.proc.key, words })
    .then((plan) => import('../store.js').then((S) => S.updateMessage(user.id, msg.id, { state: 'preview', plan })))
    .catch((e) => import('../store.js').then((S) => S.updateMessage(user.id, msg.id, { state: 'failed', error: e.status ? e.message : '말을 지도로 옮기지 못했어요.' })))
  return msg
}
export async function chatEditAction(me, msgId, body = {}) {
  const m = await ownMessage(me, msgId, 'onto-edit')
  if (!m) throw err(404, '카드를 찾지 못했어요.')
  const { updateMessage } = await import('../store.js')
  if (body.action === 'stop') return (await updateMessage(me.id, msgId, { state: 'stopped' })).content
  const key = clean(body.proc) || m.content?.proc?.key
  if (!key) throw err(400, '어느 프로세스인지 골라 주세요.')
  const g = await readGraph({})
  const p = g.processes.find((x) => x.key === key)
  if (!p) throw err(404, '프로세스를 찾지 못했어요.')
  const plan = await planEdit(me, { proc: key, scope: m.content?.plan?.range || null, words: m.content?.words || '', answer: clean(body.answer) })
  return (await updateMessage(me.id, msgId, { state: 'preview', proc: { key, name: p.name }, plan, choices: null })).content
}

export { ALL_OPS, SIDE_OPS }
