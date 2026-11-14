// 프로세스 다듬기 ① 바로잡기 · ② 단계 가르기(plan-process-refinement §3 · §4): 찾은 지도는 「있는 그대로」라 순서가 틀리고 관문과
// 없어도 되는 단계가 섞여 있다. 찾은 흐름(지도의 프로세스 하나: 일 · 넘어감)은 그대로 두고(원칙 1), 고친 것은 pro_corrections(sql/040)에
// 한 줄씩 쌓아 그 위에 차례로 얹는다(applyCorrections, 모델 없음 — 줄을 지우면 되돌아간다). ① AI(rules.refine.judge, 기본 Fable)가
// 일 · 넘어감과 실제 건 몇 개(날짜 · 읽힌 말 · 메일 · 대화 앞부분, 개인정보 가림)를 prompts/review-sequence.md 로 보고 고칠 곳(순서 ·
// 섞인 일 · 기록 탓 · 빠진 단계)마다 동작 하나를 제안하고 「사실은 이럴 것」을 그린다. 사람이 받아들인 것만 고친 기록이 된다.
// ② 다듬은 흐름의 단계마다 관문 · 사람이 꼭 · AI · 걷어냄 · 건너뛰었지만 해야 함을 prompts/classify-steps.md 로 가르고(AI 후보 판단 ·
// 「사람이 꼭」 규칙과 어긋나지 않게), 사람이 정한다. 관문으로 정하면 지도에서 그 일을 고정한다(review.js pinTask). 결정은 모두 결정 원장에.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { maskPii } from '../policy/pii.js'
import { readGraph } from './store.js'
import { loadEvents } from './build.js'
import { stepsOf, textsOf } from './conditions.js'
import { taskFacts, humanByRule } from './candidates.js'
import { prompt, rules as skillRules, discoverySkill } from './discovery.js'
import { ledger, pinTask } from './review.js'
import { judge } from './judge.js'

const T = () => config.tenantId
export const END = '__end__'
export const OPS = ['reverse_edge', 'remove_edge', 'add_edge', 'rename_task', 'merge_task', 'add_task', 'remove_task']
export const KINDS = ['order', 'mixed', 'artifact', 'missing']
export const CLASSES = ['gate', 'human', 'ai', 'drop', 'skipped', 'none']
export const CLASS_KO = { gate: '꼭 하는 관문', human: '사람이 꼭', ai: 'AI가 맡음', drop: '걷어냄', skipped: '건너뛰었지만 해야 함', none: '그대로' }
const PIN_REASON = '다듬기: 꼭 하는 관문'
const sha = (s, n = 12) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const err = (status, message) => Object.assign(new Error(message), { status })
const day = (t) => new Date(t).toISOString().slice(0, 10)

// ---------- the overlay (pure) ----------
// Korean particles after a word: by whether its last syllable has a final consonant (ㄹ takes 로)
const fin = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0 }
const eul = (w) => (fin(w) ? '을' : '를')
const ro = (w) => (fin(w) && fin(w) !== 8 ? '으로' : '로')
const gwa = (w) => (fin(w) ? '과' : '와')
const iga = (w) => (fin(w) ? '이' : '가')
const shown = (k) => (k === END ? '끝' : k)
const word = (s) => clean(s).slice(0, 60)
const endOf = (s) => (['끝', 'end', END].includes(word(s)) ? END : word(s))

// a correction's args as the overlay reads them (null when the shape is wrong)
export function normFix(x) {
  const op = clean(x?.op), a = x?.args || {}
  if (!OPS.includes(op)) return null
  const need = (...ks) => ks.every((k) => k)
  if (op === 'reverse_edge' || op === 'remove_edge' || op === 'add_edge') { const args = { from: word(a.from), to: endOf(a.to) }; return need(args.from, args.to) ? { op, args } : null }
  if (op === 'rename_task') { const args = { task: word(a.task), name: word(a.name) }; return need(args.task, args.name) ? { op, args } : null }
  if (op === 'merge_task') { const args = { task: word(a.task), into: word(a.into) }; return need(args.task, args.into) ? { op, args } : null }
  if (op === 'remove_task') { const args = { task: word(a.task) }; return need(args.task) ? { op, args } : null }
  const args = { name: word(a.name), role: word(a.role) }
  if (word(a.after)) args.after = word(a.after)
  if (word(a.before)) args.before = endOf(a.before)
  return need(args.name) ? { op, args } : null
}

// what a correction did, in a line a person reads (「강의 준비 → 교육 진행」으로 뒤집음)
export function labelOf({ op, args: a = {} }) {
  switch (op) {
    case 'reverse_edge': return `「${shown(a.to)} → ${a.from}」${ro(a.from)} 뒤집음`
    case 'remove_edge': return `「${a.from} → ${shown(a.to)}」 끊음`
    case 'add_edge': return `「${a.from} → ${shown(a.to)}」 이음`
    case 'rename_task': return `「${a.task}」${eul(a.task)} 「${a.name}」${ro(a.name)} 이름 바꿈`
    case 'merge_task': return `「${a.task}」${eul(a.task)} 「${a.into}」에 합침`
    case 'remove_task': return `「${a.task}」${eul(a.task)} 이 프로세스에서 뺌`
    case 'add_task': {
      const it = `「${a.name}」${a.role ? `(${a.role})` : ''}`
      if (a.after && a.before) return `「${a.after}」${gwa(a.after)} 「${shown(a.before)}」 사이에 ${it} 더함`
      if (a.after) return `「${a.after}」 뒤에 ${it} 더함`
      if (a.before) return `「${shown(a.before)}」 앞에 ${it} 더함`
      return `${it} 더함`
    }
    default: return op
  }
}

// found {tasks:[{key,role,n}], edges:[{from,to,n,p}]} + corrections in order → the refined flow. found is not changed.
// Added things carry added:true; removed lists the found tasks · edges the overlay took out (a renamed task is the same task).
// The probabilities out of a task the overlay changed are its edges' shares of n; the others stay as found.
// A correction that does not apply any more (the map changed under it) is skipped with its reason.
export function applyCorrections(found, corrections = []) {
  let tasks = new Map((found.tasks || []).map((t) => [t.key, { key: t.key, role: t.role || '', n: t.n || 0, origin: t.key }]))
  let edges = (found.edges || []).map((e) => ({ from: e.from, to: e.to, n: e.n || 0, p: e.p || 0 }))
  let touched = new Set()
  const skipped = []
  const isTask = (k) => tasks.has(k)
  const isNode = (k) => k === END || tasks.has(k)
  const find = (a, b) => edges.find((e) => e.from === a && e.to === b)
  const add = (from, to, n, p = 0) => {
    if (from === to) return
    const e = find(from, to)
    if (e) e.n += n; else edges.push({ from, to, n, p })
    touched.add(from)
  }
  const cut = (pred) => { edges = edges.filter((e) => { if (!pred(e)) return true; touched.add(e.from); return false }) }
  const step = ({ op, args: a = {} }) => {
    switch (op) {
      case 'reverse_edge': {
        if (a.to === END) return '끝으로 가는 화살표는 뒤집을 수 없어요.'
        const e = find(a.from, a.to)
        if (!e) return '그 화살표가 없어요.'
        cut((x) => x === e); add(a.to, a.from, e.n)
        return ''
      }
      case 'remove_edge': {
        const e = find(a.from, a.to)
        if (!e) return '그 화살표가 없어요.'
        cut((x) => x === e)
        return ''
      }
      case 'add_edge': {
        if (!isTask(a.from) || !isNode(a.to)) return '그 일이 없어요.'
        if (a.from === a.to) return '같은 일로는 이을 수 없어요.'
        if (find(a.from, a.to)) return '이미 이어져 있어요.'
        add(a.from, a.to, 0)
        return ''
      }
      case 'rename_task': {
        if (!isTask(a.task)) return '그 일이 없어요.'
        if (a.name === END || isTask(a.name)) return '그 이름의 일이 이미 있어요 — 합치기를 쓰세요.'
        const mv = (k) => (k === a.task ? a.name : k)
        tasks = new Map([...tasks].map(([k, t]) => (k === a.task ? [a.name, { ...t, key: a.name }] : [k, t])))
        edges = edges.map((e) => ({ ...e, from: mv(e.from), to: mv(e.to) }))
        touched = new Set([...touched].map(mv))
        return ''
      }
      case 'merge_task': {
        if (!isTask(a.task) || !isTask(a.into)) return '그 일이 없어요.'
        if (a.task === a.into) return '같은 일이에요.'
        tasks.get(a.into).n += tasks.get(a.task).n
        tasks.delete(a.task)
        const old = edges
        edges = []
        touched.delete(a.task)
        for (const e of old) {
          const from = e.from === a.task ? a.into : e.from, to = e.to === a.task ? a.into : e.to
          // one step now: the way between the two is gone
          if (from === to) { touched.add(from); continue }
          if (from === e.from && to === e.to && !find(from, to)) { edges.push(e); continue }
          add(from, to, e.n, e.p)
        }
        return ''
      }
      case 'remove_task': {
        if (!isTask(a.task)) return '그 일이 없어요.'
        const ins = edges.filter((e) => e.to === a.task && e.from !== a.task)
        const outs = edges.filter((e) => e.from === a.task && e.to !== a.task)
        cut((e) => e.from === a.task || e.to === a.task)
        tasks.delete(a.task)
        touched.delete(a.task)
        // the way still goes on: what came in goes where it went out (only ways not there yet)
        for (const i of ins) for (const o of outs) if (i.from !== o.to && !find(i.from, o.to)) add(i.from, o.to, Math.min(i.n, o.n))
        return ''
      }
      case 'add_task': {
        if (!a.name || a.name === END || isTask(a.name)) return '그 이름의 일이 이미 있어요.'
        if (a.after && !isTask(a.after)) return `「${a.after}」${iga(a.after)} 없어요.`
        if (a.before && !isNode(a.before)) return `「${a.before}」${iga(a.before)} 없어요.`
        if (a.before === END && !a.after) return '끝 앞에 더하려면 어느 일 뒤인지도 정하세요.'
        tasks.set(a.name, { key: a.name, role: a.role || '', n: 0, origin: null })
        if (a.after && a.before) {
          const e = find(a.after, a.before)
          if (e) cut((x) => x === e)
          add(a.after, a.name, e?.n || 0); add(a.name, a.before, e?.n || 0)
        } else if (a.after) {
          // right after it: what went out of it now goes out of the new step
          const outs = edges.filter((e) => e.from === a.after)
          cut((e) => e.from === a.after)
          for (const o of outs) add(a.name, o.to, o.n, o.p)
          add(a.after, a.name, outs.reduce((s, o) => s + o.n, 0))
        } else if (a.before) {
          const ins = edges.filter((e) => e.to === a.before)
          cut((e) => e.to === a.before)
          for (const i of ins) add(i.from, a.name, i.n)
          add(a.name, a.before, ins.reduce((s, i) => s + i.n, 0))
        }
        return ''
      }
      default: return '모르는 고치기예요.'
    }
  }
  for (const c of corrections) {
    const why = step(c)
    if (why) skipped.push({ id: c.id ?? null, why })
  }
  for (const from of touched) {
    const outs = edges.filter((e) => e.from === from)
    const tot = outs.reduce((s, e) => s + e.n, 0)
    for (const e of outs) e.p = tot ? +(e.n / tot).toFixed(3) : 0
  }
  // what is new and what is gone, against found (a renamed task is the same task, so are its ways)
  const cur = new Map([...tasks.values()].filter((t) => t.origin).map((t) => [t.origin, t.key]))
  const mapped = (e) => { const a = cur.get(e.from), b = e.to === END ? END : cur.get(e.to); return a && b ? `${a}\u0000${b}` : null }
  const foundWays = new Set((found.edges || []).map(mapped).filter(Boolean))
  const now = new Set(edges.map((e) => `${e.from}\u0000${e.to}`))
  const origin = {}
  for (const t of tasks.values()) if (t.origin) origin[t.key] = t.origin
  return {
    tasks: [...tasks.values()].map((t) => ({ key: t.key, role: t.role, n: t.n, ...(t.origin ? {} : { added: true }) })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, n: e.n, p: e.p, ...(foundWays.has(`${e.from}\u0000${e.to}`) ? {} : { added: true }) })),
    removed: {
      tasks: (found.tasks || []).filter((t) => !cur.has(t.key)).map((t) => t.key),
      edges: (found.edges || []).filter((e) => { const k = mapped(e); return !k || !now.has(k) }).map((e) => ({ from: e.from, to: e.to })),
    },
    origin, skipped,
  }
}

// why a correction would not apply on top of the others ('' when it would)
export function wontApply(found, corrections, fix) {
  const r = applyCorrections(found, [...corrections, { ...fix, id: '__try__' }])
  return r.skipped.find((s) => s.id === '__try__')?.why || ''
}
const sameFix = (a, b) => a && b && a.op === b.op && JSON.stringify(a.args) === JSON.stringify(b.args)

// the tasks in the order the flow goes: from the starts, the most travelled way first; the rest by how often
export function flowOrder(tasks, edges, entries = []) {
  const keys = new Map(tasks.map((t) => [t.key, t])), out = new Map(), into = new Set()
  for (const e of edges) {
    if (e.to === END || !keys.has(e.from) || !keys.has(e.to)) continue
    if (!out.has(e.from)) out.set(e.from, [])
    out.get(e.from).push(e); into.add(e.to)
  }
  const byN = [...tasks].sort((a, b) => (b.n || 0) - (a.n || 0))
  const starts = [...new Set([...entries.filter((k) => keys.has(k)), ...byN.filter((t) => !into.has(t.key)).map((t) => t.key)])]
  const seen = new Set(), order = []
  for (const s of [...starts, ...byN.map((t) => t.key)]) {
    const queue = [s]
    while (queue.length) {
      const x = queue.shift()
      if (seen.has(x)) continue
      seen.add(x); order.push(keys.get(x))
      for (const e of (out.get(x) || []).sort((a, b) => (b.n || 0) - (a.n || 0))) if (!seen.has(e.to)) queue.push(e.to)
    }
  }
  return order
}

// ---------- reading ----------
// the process as found on the map (retired ways left out: a person already took them out)
export async function foundOf(procKey) {
  const g = await readGraph({})
  const proc = g.processes.find((p) => p.key === procKey)
  if (!proc) throw err(404, '프로세스를 찾지 못했어요.')
  const set = new Set(proc.tasks)
  const edges = g.edges.filter((e) => e.status !== 'retired' && set.has(e.from) && (e.to === END || set.has(e.to)))
    .map((e) => ({ from: e.from, to: e.to, n: e.n || 0, p: +(e.p || 0).toFixed(3) }))
  const tasks = flowOrder(g.tasks.filter((t) => set.has(t.key)).map((t) => ({ key: t.key, role: t.role || '', n: t.n || 0 })), edges, proc.entries || [])
  return { proc, graph: g, found: { tasks, edges } }
}

async function correctionsOf(procKey) {
  return q(`select id::text as id, op, args, why, source, issue_id, by_user, at from pro_corrections where tenant_id=$1 and proc_key=$2 order by at, id`, [T(), procKey])
}
async function rowOf(procKey) {
  const [r] = await q(`select review, classes, model, version, facts_hash, made_at from pro_refine_reviews where tenant_id=$1 and proc_key=$2`, [T(), procKey])
  return r || null
}
async function jobOf(procKey) {
  const [j] = await q(`select id, status, detail, error from pro_onto_jobs where tenant_id=$1 and kind='refine' and detail->>'proc'=$2 order by started_at desc limit 1`, [T(), procKey])
  return j ? { id: j.id, status: j.status, detail: { ...(j.detail || {}), ...(j.error ? { error: j.error } : {}) } } : null
}
export async function runningJob(procKey) {
  const [j] = await q(`select id from pro_onto_jobs where tenant_id=$1 and kind='refine' and status='running' and detail->>'proc'=$2 and started_at > now() - interval '30 minutes' order by started_at desc limit 1`, [T(), procKey])
  return j?.id || null
}

// everything the 「다듬기」 screen shows for one process
export async function refineView(me, procKey) {
  const { proc, found } = await foundOf(procKey)
  const cs = await correctionsOf(procKey)
  const r = applyCorrections(found, cs)
  const row = await rowOf(procKey)
  const skipped = new Map(r.skipped.map((s) => [s.id, s.why]))
  const classes = {}
  for (const t of r.tasks) {
    const c = row?.classes?.[t.key] ?? row?.classes?.[r.origin[t.key]]
    if (c?.class) classes[t.key] = { class: c.class, why: c.why || '', by: c.by === 'person' ? 'person' : 'ai', decided: !!c.decided }
  }
  const entries = (proc.entries || []).map((k) => Object.keys(r.origin).find((x) => r.origin[x] === k) || k)
  return {
    proc: { key: proc.key, name: proc.name },
    found,
    refined: { tasks: flowOrder(r.tasks, r.edges, entries), edges: r.edges, removed: r.removed },
    review: row?.review ? { summary: row.review.summary || '', issues: row.review.issues || [], proposed: row.review.proposed || { steps: [], flows: [] }, model: row.model, made_at: row.made_at } : null,
    classes,
    corrections: cs.map((c) => ({ id: c.id, op: c.op, args: c.args, label: labelOf(c) + (skipped.has(c.id) ? ` — 지금 지도에는 맞지 않아 빠졌어요(${skipped.get(c.id)})` : ''),
      why: c.why, source: c.source, by: c.by_user, at: c.at })),
    job: await jobOf(procKey),
  }
}

// ---------- ① 바로잡기: the review ----------
// the process's real cases: mostly its own tasks (rules.refine.minInside), two steps or more once the others are left out
// (a step the case did again right after is one step, with how many records it holds); the widest and latest first
export function caseSequences(steps, taskKeys, { minInside = 0.6, examples = 8 } = {}) {
  const set = new Set(taskKeys), out = []
  for (const [id, s] of steps) {
    const inside = s.filter((x) => set.has(x.task))
    if (!inside.length || inside.length / s.length < minInside) continue
    const merged = []
    for (const x of inside) { const last = merged.at(-1); if (last && last.task === x.task) last.recs.push(...x.recs); else merged.push({ task: x.task, recs: [...x.recs] }) }
    if (merged.length < 2) continue
    out.push({ id, steps: merged, wide: new Set(merged.map((x) => x.task)).size, last: Math.max(...merged.flatMap((x) => x.recs.map((r) => new Date(r.at).getTime()))) })
  }
  return out.sort((a, b) => b.wide - a.wide || b.last - a.last).slice(0, examples)
}

const versionOf = async (R) => { const p = (await discoverySkill()).prompts; return sha(`${p['review-sequence'] || ''}|${p['classify-steps'] || ''}|${JSON.stringify([R.judge || {}, R.examples, R.stepsPerCase, R.textChars])}`, 10) }

export async function reviewInput(proc, found, cs, R) {
  const cases = caseSequences(stepsOf(await loadEvents()), found.tasks.map((t) => t.key), { minInside: R.minInside ?? 0.6, examples: R.examples || 8 })
  const per = R.stepsPerCase || 16, chars = R.textChars || 160
  const texts = await textsOf(cases.flatMap((c) => c.steps.slice(0, per).flatMap((s) => [s.recs[0], s.recs.at(-1)])), chars)
  const show = (r) => { const t = texts.get(r?.ref); return t ? maskPii(clean([t.subject, t.text].filter(Boolean).join(' — '))).slice(0, chars) : '' }
  const said = (s) => [...new Set(s.recs.map((r) => maskPii(clean(r.said)).slice(0, 40)).filter(Boolean))].slice(0, 2).join(' / ')
  const shownCases = cases.map((c, k) => ({
    id: `c${k + 1}`,
    steps: c.steps.slice(0, per).map((s, i) => ({ i, task: s.task, when: day(s.recs[0].at), times: s.recs.length,
      ...(s.recs.length > 1 ? { until: day(s.recs.at(-1).at) } : {}), said: said(s), text: show(s.recs[0]) || undefined })),
    ...(c.steps.length > per ? { more: c.steps.length - per } : {}),
  }))
  const input = {
    process: { name: proc.name, starts_with: proc.entries || [] },
    tasks: found.tasks.map((t) => ({ name: t.key, role: t.role, n: t.n })),
    edges: found.edges.map((e) => ({ from: e.from, to: shown(e.to), n: e.n, p: e.p })),
    cases: shownCases,
    already: cs.map((c) => labelOf(c)),
  }
  return { input, cases, shownCases }
}

// the model's answer → the review as kept (issue ids are stable over a re-run: a dismissed one stays dismissed)
export function shapeReview(r, { found, corrections, shownCases, before = null, maxIssues = 6 }) {
  const prev = new Map((before?.issues || []).map((x) => [x.id, x]))
  const issues = []
  for (const x of (Array.isArray(r?.issues) ? r.issues : []).slice(0, maxIssues)) {
    const title = clean(x?.title).slice(0, 60)
    if (!title) continue
    const kind = KINDS.includes(x.kind) ? x.kind : 'order'
    const n = normFix(x.fix)
    const done = n && corrections.find((c) => sameFix(c, n))
    const fix = n && (done || !wontApply(found, corrections, n)) ? { ...n, label: labelOf(n) } : null
    let id = sha(`${kind}|${title}|${JSON.stringify(n)}`, 8)
    while (issues.some((y) => y.id === id)) id = sha(id, 8)
    const evidence = (Array.isArray(x.evidence) ? x.evidence : []).map((v) => {
      const c = shownCases.find((y) => y.id === clean(v?.case)), s = c?.steps.find((y) => y.i === Number(v?.step))
      return s ? { at: s.when, said: maskPii(clean(v.said)).slice(0, 40) || s.said || s.task } : null
    }).filter(Boolean).slice(0, 3)
    const status = done ? 'accepted' : prev.get(id)?.status === 'dismissed' ? 'dismissed' : 'open'
    issues.push({ id, kind, title, why: maskPii(clean(x.why)).slice(0, 200), evidence, fix, status })
  }
  const steps = (Array.isArray(r?.proposed?.steps) ? r.proposed.steps : []).map((s) => ({ task: word(s?.task), role: word(s?.role) })).filter((s) => s.task)
  const names = new Set(steps.map((s) => s.task))
  const flows = (Array.isArray(r?.proposed?.flows) ? r.proposed.flows : []).map((f) => ({ from: word(f?.from), to: endOf(f?.to) }))
    .filter((f) => names.has(f.from) && (f.to === END || names.has(f.to)) && f.from !== f.to)
  return { summary: maskPii(clean(r?.summary)).slice(0, 300), issues, proposed: { steps, flows } }
}

// ---------- ② 단계 가르기 ----------
// the model's class for each step → kept consistently with the AI candidates: a reason a person must do it keeps it off
// 「AI」, 「걷어냄」 only with who gets the information instead, a pinned step is not dropped
export function shapeClass(x, { human = [], pinned = false } = {}) {
  let cls = CLASSES.includes(x?.class) ? x.class : 'none'
  let why = maskPii(clean(x?.why)).slice(0, 160)
  const instead = maskPii(clean(x?.instead)).slice(0, 80)
  if (cls === 'ai' && human.length) { cls = 'human'; why = `${why} — 사람이 꼭 해야 하는 까닭(${human.join(' · ')})이 있어 사람으로` }
  if (cls === 'drop' && pinned) { cls = 'none'; why = `${why} — 이미 고정된 단계라 걷어내지 않아요` }
  else if (cls === 'drop' && !instead) { cls = 'none'; why = `${why} — 걷어낼 수도 있지만 누가 대신 받는지 알 수 없어 그대로 둬요` }
  else if (cls === 'drop') why = `${why} — 대신 ${instead}`
  return { class: cls, why: why.replace(/^ — /, '') }
}

async function classifySteps(proc, found, cs, review, graph, R) {
  const r = applyCorrections(found, cs)
  const H = ((await skillRules()).candidates || {}).human || {}
  const facts = new Map((await taskFacts()).tasks.map((t) => [t.name, t]))
  const origins = r.tasks.map((t) => r.origin[t.key]).filter(Boolean)
  const cands = new Map((origins.length ? await q(`select task, fit, how, why, human from pro_ai_candidates where tenant_id=$1 and task = any($2)`, [T(), origins]) : []).map((x) => [x.task, x]))
  const gtasks = new Map(graph.tasks.map((t) => [t.key, t]))
  const near = (edges, k, dir) => edges.filter((e) => e[dir === 'prev' ? 'to' : 'from'] === k).sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 2).map((e) => shown(e[dir === 'prev' ? 'from' : 'to']))
  const steps = r.tasks.map((t) => ({ name: t.key, role: t.role, n: t.n, origin: r.origin[t.key] || null, prev: near(r.edges, t.key, 'prev'), next: near(r.edges, t.key, 'next') }))
  // the review's 「사실은 있어야 하는 단계」 not in the refined flow yet: classed now, shown once a person adds it
  const flows = review?.proposed?.flows || []
  for (const s of review?.proposed?.steps || []) {
    if (steps.some((x) => x.name === s.task)) continue
    steps.push({ name: s.task, role: s.role, n: 0, origin: null, proposed: true, prev: flows.filter((f) => f.to === s.task).map((f) => f.from).slice(0, 2), next: flows.filter((f) => f.from === s.task).map((f) => shown(f.to)).slice(0, 2) })
  }
  // a reason a person must do it, as the AI candidates settled it (rule + model, candidates.js mergeHuman) — enforced;
  // the rule's word hits alone may only share a word (「강의 계획 공유」), so they go to the model as a hint
  const humanOf = (s) => ((s.origin && cands.get(s.origin)?.human) || []).map((h) => h.key)
  const ruleOf = (s) => humanByRule(facts.get(s.origin) || { name: s.name, said: [], acts: {} }, H).map((h) => h.key)
  const input = {
    process: { name: proc.name, summary: review?.summary || '' },
    human_kinds: (H.kinds || []).map((k) => ({ key: k.key, name: k.name, why: k.why })),
    steps: steps.map((s, i) => {
      const c = s.origin && cands.get(s.origin)
      return { i, name: s.name, role: s.role, n: s.n, prev: s.prev, next: s.next, ...(c ? { ai: { fit: c.fit, how: c.how, why: c.why, human: (c.human || []).map((h) => h.key) } } : {}),
        human_rule: c ? humanOf(s) : ruleOf(s), ...(s.origin && gtasks.get(s.origin)?.pinned ? { pinned: true } : {}), ...(s.proposed ? { proposed: true } : {}) }
    }),
  }
  const { r: out, model } = await judge(await prompt('classify-steps'), JSON.stringify(input), { ...R, timeoutMs: R.classifyTimeoutMs || R.timeoutMs })
  const classes = {}
  for (const x of Array.isArray(out?.items) ? out.items : []) {
    const s = steps[Number(x?.i)]
    if (!s) continue
    classes[s.name] = shapeClass(x, { human: humanOf(s), pinned: !!(s.origin && gtasks.get(s.origin)?.pinned) })
  }
  return { classes, model }
}

// a person's decisions stay over a re-run; the AI's suggestion is kept beside them
export function mergeClasses(have = {}, made = {}) {
  const out = {}
  for (const [k, c] of Object.entries(have || {})) if (c?.decided) out[k] = c
  for (const [k, c] of Object.entries(made)) {
    const ai = { class: c.class, why: c.why }
    out[k] = out[k]?.decided ? { ...out[k], ai } : { class: c.class, why: c.why, by: 'ai', decided: false, ai, ...(have?.[k]?.pinned_here ? { pinned_here: true } : {}) }
  }
  return out
}

// the job's work (service.js startRefine): ① the review, kept as soon as it is made, then ② the classes
export async function runReview(me, procKey, { say = async () => {} } = {}) {
  const R = (await skillRules()).refine || {}
  const version = await versionOf(R)
  const { proc, found, graph } = await foundOf(procKey)
  const cs = await correctionsOf(procKey)
  await say(`「${proc.name}」의 일 ${found.tasks.length}개 · 넘어감 ${found.edges.length}개와 실제 건을 모아요.`)
  const { input, cases, shownCases } = await reviewInput(proc, found, cs, R)
  await say(`실제 건 ${cases.length}개의 순서로 지도를 점검해요 — 몇 분 걸릴 수 있어요.`)
  const { r, model } = await judge(await prompt('review-sequence'), JSON.stringify(input), R)
  const before = (await rowOf(procKey))?.review || null
  const review = shapeReview(r, { found, corrections: cs, shownCases, before, maxIssues: R.maxIssues || 6 })
  const hash = sha(JSON.stringify([found.tasks.map((t) => [t.key, t.n]), found.edges.map((e) => [e.from, e.to, e.n]), cases.map((c) => c.id)]))
  await q(`insert into pro_refine_reviews (tenant_id, proc_key, review, model, version, facts_hash) values ($1,$2,$3,$4,$5,$6)
           on conflict (tenant_id, proc_key) do update set review=excluded.review, model=excluded.model, version=excluded.version, facts_hash=excluded.facts_hash, made_at=now()`,
  [T(), procKey, JSON.stringify(review), model, version, hash])
  const count = (k) => review.issues.filter((x) => x.kind === k).length
  const KO = { order: '순서', mixed: '섞인 일', artifact: '기록 탓', missing: '빠진 단계' }
  await say(review.issues.length ? `고칠 곳 ${review.issues.length}개를 찾았어요 — ${KINDS.filter(count).map((k) => `${KO[k]} ${count(k)}`).join(' · ')}.` : '순서에서 고칠 곳은 찾지 못했어요.')
  if (review.proposed.steps.length) await say(`사실은 이렇게 흐를 거예요: ${review.proposed.steps.map((s) => s.task).join(' → ')}`)
  await say('단계마다 관문 · 사람이 꼭 · AI · 걷어냄을 가려요.')
  let classed = 0, classModel = ''
  try {
    const { classes, model: m } = await classifySteps(proc, found, cs, review, graph, R)
    const have = (await rowOf(procKey))?.classes || {}
    const merged = mergeClasses(have, classes)
    await q(`update pro_refine_reviews set classes=$3 where tenant_id=$1 and proc_key=$2`, [T(), procKey, JSON.stringify(merged)])
    classed = Object.keys(classes).length; classModel = m
    const n = (c) => Object.values(classes).filter((x) => x.class === c).length
    await say(`단계 ${classed}개를 갈랐어요 — 관문 ${n('gate')} · 사람이 꼭 ${n('human')} · AI ${n('ai')} · 걷어냄 ${n('drop')} · 해야 함 ${n('skipped')}.`)
  } catch (e) {
    console.warn('[ontology] refine classes', e.message)
    await say('단계 가르기는 이번에 하지 못했어요 — 다시 점검하면 다시 해요.')
  }
  return { proc: procKey, issues: review.issues.length, cases: cases.length, classes: classed, model, classModel }
}

// ---------- a person's decisions ----------
const subject = (proc, text) => `다듬기 「${proc.name}」: ${text}`
async function saveIssues(procKey, issues) {
  await q(`update pro_refine_reviews set review = jsonb_set(review, '{issues}', $3::jsonb) where tenant_id=$1 and proc_key=$2`, [T(), procKey, JSON.stringify(issues)])
}
async function insertCorrection(me, procKey, { op, args, why, source, issueId = null }) {
  const [c] = await q(`insert into pro_corrections (tenant_id, proc_key, op, args, why, source, issue_id, by_user) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id::text as id`,
    [T(), procKey, op, JSON.stringify(args), clean(why).slice(0, 300), source, issueId, me.email || String(me.id)])
  return c.id
}

// 제안대로 고침(accept: the issue's fix becomes a correction, source ai) · 그대로 둠(dismiss: and a fix taken before is taken back)
export async function decideIssue(me, procKey, issueId, { action } = {}) {
  if (!['accept', 'dismiss'].includes(action)) throw err(400, 'action 은 accept 나 dismiss 예요.')
  const { proc, found } = await foundOf(procKey)
  const row = await rowOf(procKey)
  const issues = row?.review?.issues || []
  const issue = issues.find((x) => x.id === issueId)
  if (!issue) throw err(404, '그 제안을 찾지 못했어요.')
  if (action === 'accept' && issue.status !== 'accepted' && issue.fix) {
    const cs = await correctionsOf(procKey)
    const why = wontApply(found, cs, issue.fix)
    if (why) throw err(409, `지금 흐름에는 적용할 수 없어요 — ${why}`)
    await insertCorrection(me, procKey, { op: issue.fix.op, args: issue.fix.args, why: issue.why || issue.title, source: 'ai', issueId })
  }
  if (action === 'dismiss') await q(`delete from pro_corrections where tenant_id=$1 and proc_key=$2 and issue_id=$3`, [T(), procKey, issueId])
  const status = action === 'accept' ? 'accepted' : 'dismissed'
  await saveIssues(procKey, issues.map((x) => (x.id === issueId ? { ...x, status } : x)))
  await ledger(me, 'ontology.refine', subject(proc, `${action === 'accept' ? '제안대로 고침' : '그대로 둠'} — ${issue.title}`),
    { proc: procKey, action, issue: issueId, kind: issue.kind, fix: issue.fix ? { op: issue.fix.op, args: issue.fix.args } : null })
  return refineView(me, procKey)
}

// 내가 고침: one correction on top of the others (refused when it would not apply)
export async function addCorrection(me, procKey, { op, args, why = '' } = {}) {
  const fix = normFix({ op, args })
  if (!fix) throw err(400, `op 는 ${OPS.join(' · ')} 중 하나이고, 그에 맞는 args 가 있어야 해요.`)
  const { proc, found } = await foundOf(procKey)
  const cs = await correctionsOf(procKey)
  const no = wontApply(found, cs, fix)
  if (no) throw err(409, no)
  const id = await insertCorrection(me, procKey, { ...fix, why, source: 'person' })
  await ledger(me, 'ontology.refine', subject(proc, labelOf(fix)), { proc: procKey, action: 'correct', id, op: fix.op, args: fix.args, why: clean(why).slice(0, 300) })
  return refineView(me, procKey)
}

// 되돌리기: the correction goes (the flow is found + the rest again); an issue it came from is open again
export async function removeCorrection(me, procKey, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw err(404, '그 고친 기록을 찾지 못했어요.')
  const { proc } = await foundOf(procKey)
  const [c] = await q(`delete from pro_corrections where tenant_id=$1 and proc_key=$2 and id=$3 returning op, args, issue_id`, [T(), procKey, id])
  if (!c) throw err(404, '그 고친 기록을 찾지 못했어요.')
  if (c.issue_id) {
    const issues = (await rowOf(procKey))?.review?.issues || []
    if (issues.some((x) => x.id === c.issue_id)) await saveIssues(procKey, issues.map((x) => (x.id === c.issue_id ? { ...x, status: 'open' } : x)))
  }
  await ledger(me, 'ontology.refine', subject(proc, `되돌림 — ${labelOf(c)}`), { proc: procKey, action: 'undo', id, op: c.op, args: c.args, issue: c.issue_id || null })
  return refineView(me, procKey)
}

// 분류 확정: class (null = back to the AI's suggestion, undecided). A decided gate pins the task on the map (when it was not
// pinned already); a gate that is no longer one is unpinned only when that pin was this screen's.
export async function setClass(me, procKey, { task, class: cls } = {}) {
  if (cls !== null && cls !== undefined && cls !== '' && !CLASSES.includes(cls)) throw err(400, `class 는 ${CLASSES.join(' · ')} 중 하나예요.`)
  const want = CLASSES.includes(cls) ? cls : null
  const { proc, found, graph } = await foundOf(procKey)
  const r = applyCorrections(found, await correctionsOf(procKey))
  if (!r.tasks.some((t) => t.key === task)) throw err(404, '다듬은 흐름에 그 일이 없어요.')
  const origin = r.origin[task] || null
  await q(`insert into pro_refine_reviews (tenant_id, proc_key) values ($1,$2) on conflict do nothing`, [T(), procKey])
  const classes = { ...((await rowOf(procKey))?.classes || {}) }
  const prev = classes[task] ?? (origin ? classes[origin] : undefined)
  if (origin && origin !== task) delete classes[origin]
  const ai = prev?.ai || null
  let next = null
  if (want) next = { class: want, why: ai?.class === want ? ai.why : `사람이 「${CLASS_KO[want]}」${ro(CLASS_KO[want])} 정했어요.`, by: ai?.class === want ? 'ai' : 'person', decided: true, ai, by_user: me.email || String(me.id), at: new Date().toISOString() }
  else if (ai) next = { class: ai.class, why: ai.why, by: 'ai', decided: false, ai }
  const g = origin ? graph.tasks.find((t) => t.key === origin) : null
  let pinnedHere = !!prev?.pinned_here
  if (next?.class === 'gate' && next.decided) {
    if (g && !g.pinned) { await pinTask(me, origin, { pinned: true, reason: PIN_REASON }); pinnedHere = true }
  } else if (pinnedHere) {
    if (g?.pinned && g.pin_reason === PIN_REASON) await pinTask(me, origin, { pinned: false, reason: '다듬기: 관문에서 뺌' })
    pinnedHere = false
  }
  if (next) classes[task] = { ...next, ...(pinnedHere ? { pinned_here: true } : {}) }
  else delete classes[task]
  await q(`update pro_refine_reviews set classes=$3 where tenant_id=$1 and proc_key=$2`, [T(), procKey, JSON.stringify(classes)])
  await ledger(me, 'ontology.refine', subject(proc, `「${task}」 ${want ? CLASS_KO[want] : 'AI 제안으로 되돌림'}`),
    { proc: procKey, action: 'class', task, class: want, was: prev?.class || null, pinned: pinnedHere })
  return refineView(me, procKey)
}
