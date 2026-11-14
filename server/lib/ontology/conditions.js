// 갈림길 조건(design-v0.3 §25): 한 일 뒤에 다음 일이 여럿으로 갈리면, 갈래마다 「어떤 경우에 이쪽으로 가는가」를 글로 뽑는다.
// 지도 셈과 같은 건(build.js loadEvents → 건마다 일의 순서)에서 그 갈래로 실제로 간 건을 갈래마다 몇 개 고르고, 그 일에서 오간
// 메일 · 대화(주인의 보관함 원문 앞부분, 개인정보 가림)와 다음 일에서 오간 것을 예시로 프로세스 찾기 스킬의 prompts/branch-conditions.md
// 에 보낸다. 판단은 rules.conditions.judge 의 모델(기본 Fable, judge.js). 결과는 표 pro_branch_conditions(sql/039).
// 스냅샷(run.js)은 숫자로 배운 조건이 없는 갈림에 이 글을 조건으로 쓰고, 관계 패널이 근거와 함께 보인다.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { maskPii } from '../policy/pii.js'
import { readGraph } from './store.js'
import { loadEvents } from './build.js'
import { prompt, rules as skillRules, discoverySkill } from './discovery.js'
import { judge } from './judge.js'

const T = () => config.tenantId
const END = '__end__'
const sha = (s, n = 12) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const err = (status, message) => Object.assign(new Error(message), { status })
const day = (t) => new Date(t).toISOString().slice(0, 10)

// every case's steps in time order (consecutive events of one task are one step), with the records each step came from
export function stepsOf(events) {
  const by = new Map()
  for (const e of events) { if (!e?.case || !e?.task) continue; if (!by.has(e.case)) by.set(e.case, []); by.get(e.case).push(e) }
  const out = new Map()
  for (const [id, evs] of by) {
    evs.sort((a, b) => new Date(a.at) - new Date(b.at))
    const steps = []
    for (const e of evs) {
      const last = steps.at(-1)
      const rec = { ref: e.ref || null, owner: e.owner || null, at: e.at, said: e.said || '', role: e.role || '' }
      if (last && last.task === e.task) { last.recs.push(rec); continue }
      steps.push({ task: e.task, recs: [rec] })
    }
    out.set(id, steps)
  }
  return out
}

// what went out of each task in the cases: from → to → [{case, x: the step's last record, y: the next step's first}]
export function branchesOf(steps) {
  const by = new Map()
  for (const [id, list] of steps) {
    list.forEach((s, i) => {
      const nx = list[i + 1]
      const to = nx ? nx.task : END
      if (!by.has(s.task)) by.set(s.task, new Map())
      const m = by.get(s.task)
      if (!m.has(to)) m.set(to, [])
      m.get(to).push({ case: id, x: s.recs.at(-1), y: nx ? nx.recs[0] : null })
    })
  }
  return by
}

// the splits worth a condition: a task with two or more live ways out (retired ones left out), seen at least minN times
export async function splitList({ minN } = {}) {
  const R = (await skillRules()).conditions || {}
  const min = minN ?? R.minN ?? 3
  const g = await readGraph({})
  const out = new Map()
  for (const e of g.edges || []) {
    if (e.status === 'retired') continue
    if (!out.has(e.from)) out.set(e.from, [])
    out.get(e.from).push(e)
  }
  const tasks = new Map(g.tasks.map((t) => [t.key, t]))
  // a way taken once tells nothing about when it is taken: only ways seen branchMinN times, the maxBranches most common
  const bmin = minN === 2 ? 1 : R.branchMinN ?? 2, most = R.maxBranches ?? 8
  return [...out].map(([from, es]) => [from, es.filter((e) => (e.n || 0) >= bmin).sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, most)])
    .filter(([, es]) => es.length >= 2 && es.reduce((a, e) => a + (e.n || 0), 0) >= min)
    .map(([from, es]) => ({ from, role: tasks.get(from)?.role || '', n: es.reduce((a, e) => a + (e.n || 0), 0), edges: es }))
    .sort((a, b) => b.n - a.n)
}

// the texts of the records an example points at (the owner's mail archive: subject and the newly written part)
export async function textsOf(refs, chars) {
  const ids = [...new Set(refs.filter((r) => r?.ref && !String(r.ref).startsWith('ho:')).map((r) => r.ref))]
  const rows = ids.length ? await q(`select mail_id, subject, left(coalesce(nullif(new_part,''), body, ''), $3) as text from pro_mail_archive where tenant_id=$1 and mail_id = any($2)`, [T(), ids, chars]) : []
  const by = new Map(rows.map((r) => [r.mail_id, r]))
  const hos = refs.filter((r) => String(r?.ref || '').startsWith('ho:')).map((r) => r.ref.slice(3))
  for (const r of hos.length ? await q(`select id::text as id, instruction from handover_events where tenant_id=$1 and id::text = any($2)`, [T(), hos]).catch(() => []) : []) by.set(`ho:${r.id}`, { subject: '', text: String(r.instruction || '').slice(0, chars) })
  return by
}

const versionOf = async (R) => sha(`${(await discoverySkill()).prompts['branch-conditions'] || ''}|${JSON.stringify([R.judge || {}, R.perBranch, R.textChars])}`, 10)

// ask about one split: returns its rows as saved
async function judgeSplit(split, branches, R, version) {
  const per = R.perBranch || 4, chars = R.textChars || 300
  const picks = split.edges.map((e) => {
    const all = branches.get(e.to) || []
    // the most recent ones first (the way it is done now), different cases
    return { e, ex: [...all].sort((a, b) => new Date(b.x?.at) - new Date(a.x?.at)).slice(0, per) }
  })
  const texts = await textsOf(picks.flatMap((b) => b.ex.flatMap((x) => [x.x, x.y])), chars)
  const show = (r) => { if (!r) return null; const t = texts.get(r.ref); return maskPii(clean([t?.subject, t?.text].filter(Boolean).join(' — '))).slice(0, chars) || null }
  const input = {
    step: split.from, role: split.role,
    branches: picks.map((b, i) => ({ i, to: b.e.to === END ? '끝' : b.e.to, n: b.e.n || 0, p: +(b.e.p || 0).toFixed(2),
      examples: b.ex.map((x) => ({ when: day(x.x.at), said: maskPii(clean(x.x.said)).slice(0, 60), at_step: show(x.x), next: x.y ? `${maskPii(clean(x.y.said)).slice(0, 60)}${show(x.y) ? ` — ${show(x.y).slice(0, 120)}` : ''}` : '(건이 여기서 끝남)' })) })),
  }
  const { r, model } = await judge(await prompt('branch-conditions'), JSON.stringify(input), R)
  const hash = sha(JSON.stringify(picks.map((b) => [b.e.to, b.e.n, b.ex.map((x) => x.x.ref)])))
  const rows = picks.map((b, i) => {
    const a = (r?.branches || []).find((x) => Number(x.i) === i) || {}
    return { from_task: split.from, to_task: b.e.to, cond: clean(a.cond).slice(0, 120), signals: (a.signals || []).map(clean).filter(Boolean).slice(0, 3).map((s) => s.slice(0, 30)),
      confidence: ['high', 'mid', 'low'].includes(a.confidence) ? a.confidence : 'low', examples: b.ex.map((x) => ({ ref: x.x.ref, at: x.x.at, said: x.x.said, next: x.y?.said || '' })),
      n: b.e.n || 0, p: b.e.p || 0, note: clean(r?.note).slice(0, 160), model, facts_hash: hash }
  })
  await q(`insert into pro_branch_conditions (tenant_id, from_task, to_task, cond, signals, confidence, examples, n, p, note, model, version, facts_hash)
           select $1, x->>'from_task', x->>'to_task', x->>'cond', x->'signals', x->>'confidence', x->'examples', (x->>'n')::int, (x->>'p')::float8, x->>'note', x->>'model', $3, x->>'facts_hash'
             from jsonb_array_elements($2::jsonb) x
           on conflict (tenant_id, from_task, to_task) do update set cond=excluded.cond, signals=excluded.signals, confidence=excluded.confidence, examples=excluded.examples,
             n=excluded.n, p=excluded.p, note=excluded.note, model=excluded.model, version=excluded.version, facts_hash=excluded.facts_hash, made_at=now()`, [T(), JSON.stringify(rows), version])
  // a way that is no longer out of this task (retired, merged) loses its old condition
  await q(`delete from pro_branch_conditions where tenant_id=$1 and from_task=$2 and not (to_task = any($3))`, [T(), split.from, split.edges.map((e) => e.to)])
  return rows
}

// all splits (or one): the ones not asked yet, or whose ways · examples or prompt changed
export async function judgeConditions({ say = async () => {}, task = null, force = false } = {}) {
  const R = (await skillRules()).conditions || {}
  const version = await versionOf(R)
  const splits = (await splitList({ minN: task ? 2 : undefined })).filter((s) => !task || s.from === task)
  if (task && !splits.length) throw err(404, '이 일 뒤에는 갈림길이 없어요(다음 일이 하나뿐이에요).')
  const all = branchesOf(stepsOf(await loadEvents()))
  const done = new Map()
  for (const r of await q(`select from_task, version, facts_hash, count(*) over (partition by from_task)::int as k from pro_branch_conditions where tenant_id=$1`, [T()])) done.set(r.from_task, r)
  const todo = splits.filter((s) => force || task || done.get(s.from)?.version !== version || done.get(s.from)?.k !== s.edges.length)
  if (!todo.length) { await say(`갈림길 ${splits.length}개 모두 이미 봤어요.`); return { splits: splits.length, asked: 0 } }
  await say(`갈림길 ${splits.length}개 중 ${todo.length}개의 조건을 뽑아요 — 갈래마다 실제로 간 건을 예시로.`)
  let asked = 0, clear = 0
  const queue = [...todo]
  await Promise.all(Array.from({ length: task ? 1 : Math.max(1, R.parallel || 3) }, async () => {
    while (queue.length) {
      const s = queue.shift()
      try {
        const rows = await judgeSplit(s, all.get(s.from) || new Map(), R, version)
        if (rows.some((x) => x.confidence !== 'low')) clear++
      } catch (e) { console.warn('[ontology] conditions', s.from, e.message) }
      asked++
      await say(`${asked}/${todo.length}개 봤어요 — 조건이 갈리는 갈림길 ${clear}개.`, 'cond')
    }
  }))
  return { splits: splits.length, asked, clear }
}

// one task's ways out with their conditions and examples (for the edge panel); subjects only for the archive's owner
export async function branchView(me, from) {
  const g = await readGraph({})
  const edges = (g.edges || []).filter((e) => e.from === from && e.status !== 'retired').sort((a, b) => (b.n || 0) - (a.n || 0))
  const rows = new Map((await q(`select to_task, cond, signals, confidence, examples, note, model, made_at from pro_branch_conditions where tenant_id=$1 and from_task=$2`, [T(), from])).map((r) => [r.to_task, r]))
  const refs = [...rows.values()].flatMap((r) => (r.examples || []).map((x) => x.ref)).filter((x) => x && !String(x).startsWith('ho:'))
  const mine = new Map(refs.length ? (await q(`select mail_id, subject from pro_mail_archive where tenant_id=$1 and owner_id::text=$2 and mail_id = any($3)`, [T(), String(me.id), refs])).map((r) => [r.mail_id, r.subject]) : [])
  const note = [...rows.values()].find((r) => r.note)?.note || ''
  return {
    from, split: edges.length >= 2, note, judged_at: [...rows.values()][0]?.made_at || null, model: [...rows.values()][0]?.model || '',
    branches: edges.map((e) => {
      const r = rows.get(e.to)
      return { to: e.to, n: e.n || 0, p: e.p || 0, numeric: e.cond || '', cond: r?.cond || '', signals: r?.signals || [], confidence: r?.confidence || null,
        examples: (r?.examples || []).map((x) => ({ at: x.at, said: x.said, next: x.next, subject: mine.get(x.ref) || null })) }
    }),
  }
}

// the text conditions of the given splits, for the snapshot: from → to → cond (only those that tell the ways apart)
export async function textConditions(fromTasks) {
  if (!fromTasks?.length) return new Map()
  const rows = await q(`select from_task, to_task, cond, confidence from pro_branch_conditions where tenant_id=$1 and from_task = any($2) and cond <> ''`, [T(), fromTasks]).catch(() => [])
  const out = new Map()
  for (const r of rows) if (r.confidence !== 'low') out.set(`${r.from_task}\u0000${r.to_task}`, r.cond)
  return out
}
