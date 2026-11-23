// AI 후보(design-v0.3 §24): 회사 지도의 일 가운데 AI(에이전트 · 스킬)에 맡길 수 있는 일을 고른다.
// 일마다 지도가 아는 사실을 모은다: 얼마나 자주(한 달 몇 번), 누가(역할), 어떻게 오갔나(요청 · 전달 · 알림 · 승인), 첨부(양식 · 문서),
// 정해진 때, 앞뒤 일, AI가 읽은 말 몇 개. 이것을 프로세스 찾기 스킬의 prompts/ai-candidates.md 로 보내 맡길 수 있는 정도(fit) ·
// 방식(how) · 까닭 · 쓸 스킬 · 필요한 것 · 조심할 점을 받는다. rules.candidates.minN 번 이상 나온 일만 자주 일어나는 순으로 보고,
// 사실이나 프롬프트가 바뀐 일만 다시 묻는다. 사람이 검토(채택 · 아님)하고, 채택한 일은 일 정의 초안(runner: agent)으로 이어진다
// (taskdef.js). 결과는 표 pro_ai_candidates(sql/038)에.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { maskPii } from '../policy/pii.js'
import { readGraph } from './store.js'
import { prompt, rules as skillRules, discoverySkill } from './discovery.js'
import { ledger } from './review.js'
import { judge } from './judge.js'

const T = () => config.tenantId
const DAY = 86_400_000
const sha = (s, n = 12) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const err = (status, message) => Object.assign(new Error(message), { status })
export const FITS = ['high', 'mid', 'low', 'none']
export const HOWS = ['agent', 'draft', 'assist', 'person']
// how much a candidate is worth looking at first: what it would take off people's hands each month
export const FIT_W = { high: 1, mid: 0.6, low: 0.25, none: 0 }
export const scoreOf = (fit, monthly) => +((FIT_W[fit] ?? 0) * (monthly || 0)).toFixed(2)
// 사람이 꼭 해야 하는 일(규칙, 모델 없음): 일 이름 · 읽힌 말에 그 종류의 낱말이 있거나, 오간 것 중 승인이 approveShare 이상
export function humanByRule(f, H = {}) {
  const text = [f.name, ...(f.said || [])].join(' ')
  const out = []
  for (const k of H.kinds || []) { const hit = (k.words || []).find((w) => text.includes(w)); if (hit) out.push({ key: k.key, hit }) }
  const total = Object.values(f.acts || {}).reduce((a, b) => a + b, 0)
  if (total && (f.acts.approve || 0) / total >= (H.approveShare ?? 0.3) && !out.some((x) => x.key === 'approval')) out.push({ key: 'approval', hit: `승인 ${f.acts.approve}/${total}번` })
  return out
}
// 규칙과 모델을 합친다: 둘 다 = both, 규칙만(모델이 뺌) = 버림, 모델만 = model. 있으면 맡기는 정도는 「돕기」까지.
export function mergeHuman(rule, model, kinds = []) {
  const name = new Map(kinds.map((k) => [k.key, k])), m = new Set((model || []).filter((k) => name.has(k)))
  const out = rule.filter((r) => m.has(r.key)).map((r) => ({ key: r.key, name: name.get(r.key).name, why: name.get(r.key).why, by: 'both', hit: r.hit }))
  for (const k of m) if (!out.some((x) => x.key === k)) out.push({ key: k, name: name.get(k).name, why: name.get(k).why, by: 'model' })
  return out
}
const ext = (name) => String(name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] || ''

// what the map knows of every task (the graph's counts + the mail · chat history behind them)
export async function taskFacts() {
  const g = await readGraph({})
  const months = Math.max(1, (new Date(g.meta?.data_end || Date.now()) - new Date(g.meta?.data_start || Date.now())) / (30 * DAY))
  const toTask = new Map((await q(`select raw, task from pro_onto_labels where tenant_id=$1 and task <> '' and act <> 'habit'`, [T()])).map((r) => [r.raw, r.task]))
  const acts = new Map(), files = new Map(), said = new Map()
  for (const r of await q(`select activity_label, act, artifacts from pro_mail_history where tenant_id=$1`, [T()])) {
    const t = toTask.get(r.activity_label) || r.activity_label
    if (!acts.has(t)) { acts.set(t, {}); files.set(t, {}) }
    const a = acts.get(t); a[r.act || 'notify'] = (a[r.act || 'notify'] || 0) + 1
    const f = files.get(t)
    for (const x of r.artifacts || []) { const e = ext(x?.name) || x?.type || ''; if (e) f[e] = (f[e] || 0) + 1 }
  }
  for (const [raw, t] of toTask) { if (raw === t) continue; if (!said.has(t)) said.set(t, []); const s = said.get(t); if (s.length < 3) s.push(maskPii(clean(raw)).slice(0, 60)) }
  // a schedule: a time event (mined from the mail's regular times, or a timer) that starts the task
  const timeEv = new Map((g.events || []).filter((e) => e.kind === 'time' || e.kind === 'timer').map((e) => [e.key, e.name]))
  const sched = new Map()
  for (const tr of g.triggers || []) if (timeEv.has(tr.from) && !sched.has(tr.to)) sched.set(tr.to, timeEv.get(tr.from))
  const out = new Map(), inn = new Map()
  for (const e of g.edges || []) {
    if (e.to === '__end__' || e.status === 'retired') continue
    if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e)
    if (!inn.has(e.to)) inn.set(e.to, []); inn.get(e.to).push(e)
  }
  const top = (list, k) => (list || []).sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 2).map((e) => e[k])
  const J = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s || {} } catch { return {} } }
  return {
    months: +months.toFixed(1),
    tasks: g.tasks.filter((t) => t.key !== '__end__').map((t) => {
      const src = J(t.sources)
      const f = {
        name: t.key, role: t.role || '', kind: t.kind || 'flow', n: t.n || 0, cases: t.n_cases || 0, monthly: +((t.n || 0) / months).toFixed(1), people: t.people || 0,
        sources: { mail: src.mail_history || 0, chat: (src.chat_export || 0) + (src.chat_handover || 0) },
        acts: acts.get(t.key) || {}, files: files.get(t.key) || {}, schedule: sched.get(t.key) || '',
        prev: top(inn.get(t.key), 'from'), next: top(out.get(t.key), 'to'), said: said.get(t.key) || [],
      }
      // what changes the judgement (not every new occurrence): the size of n, the mix of acts, the files, the schedule, the neighbours
      const nb = f.n < 3 ? f.n : f.n < 10 ? 'few' : f.n < 30 ? 'many' : 'lots'
      f.hash = sha(JSON.stringify([f.role, nb, Object.keys(f.acts).sort(), Object.keys(f.files).sort(), f.schedule, f.prev, f.next]))
      return f
    }),
  }
}

const versionOf = async (R) => sha(`${(await discoverySkill()).prompts['ai-candidates'] || ''}|${JSON.stringify([R.skills || [], R.human || {}, R.judge || {}])}`, 10)

// ask the model about the tasks not judged yet (or whose facts changed): returns {seen, asked, high, mid}
export async function judgeCandidates({ say = async () => {}, all = false } = {}) {
  const R = (await skillRules()).candidates || {}
  const minN = all ? 1 : (R.minN ?? 2)
  const version = await versionOf(R)
  const { tasks } = await taskFacts()
  const seen = tasks.filter((t) => t.n >= minN).sort((a, b) => b.n - a.n)
  const done = new Map((await q(`select task, version, facts_hash from pro_ai_candidates where tenant_id=$1`, [T()])).map((r) => [r.task, r]))
  const todo = seen.filter((t) => { const r = done.get(t.name); return !r || r.version !== version || r.facts_hash !== t.hash })
  if (!todo.length) { await say(`일 ${seen.length}개 모두 이미 봤어요.`); return { seen: seen.length, asked: 0 } }
  await say(`일 ${seen.length.toLocaleString('ko-KR')}개(${minN}번 이상 나온 일) 중 ${todo.length.toLocaleString('ko-KR')}개를 AI 가 맡을 수 있는지 봐요 — 자주 일어나는 일부터.`)
  const per = R.batch || 20
  const parts = []
  for (let i = 0; i < todo.length; i += per) parts.push(todo.slice(i, i + per))
  const skills = (R.skills || []).map((s) => (typeof s === 'string' ? { name: s } : s))
  const names = new Set(skills.map((s) => s.name))
  const H = R.human || {}, kinds = H.kinds || []
  let asked = 0, high = 0, mid = 0, must = 0
  const one = async (part) => {
    const input = part.map((t, i) => ({ i, name: t.name, role: t.role, n: t.n, monthly: t.monthly, people: t.people, acts: t.acts, files: t.files, schedule: t.schedule || undefined, prev: t.prev, next: t.next, said: t.said, human_rule: humanByRule(t, H).map((x) => x.key) }))
    let r = null, model = ''
    for (let tries = 0; tries < 2 && !r; tries++) {
      try { ({ r, model } = await judge(await prompt('ai-candidates'), JSON.stringify({ skills, human_kinds: kinds.map((k) => ({ key: k.key, name: k.name, why: k.why })), items: input }), R)) } catch (e) { console.warn('[ontology] candidates', e.message) }
    }
    const rows = []
    for (const x of r?.items || []) {
      const t = part[Number(x.i)]
      if (!t) continue
      let fit = FITS.includes(x.fit) ? x.fit : 'none', how = HOWS.includes(x.how) ? x.how : 'person'
      const human = mergeHuman(humanByRule(t, H), x.human, kinds)
      if (human.length) { if (fit === 'high' || fit === 'mid') fit = 'low'; if (how === 'agent' || how === 'draft') how = 'assist'; must++ }
      rows.push({ task: t.name, fit, how, human, why: clean(x.why).slice(0, 120), skills: (x.skills || []).map(clean).filter((s) => names.has(s)).slice(0, 3),
        needs: (x.needs || []).map(clean).filter(Boolean).slice(0, 3).map((s) => s.slice(0, 30)), risk: clean(x.risk).slice(0, 80),
        facts: { model, n: t.n, monthly: t.monthly, role: t.role, acts: t.acts, files: t.files, schedule: t.schedule, prev: t.prev, next: t.next }, facts_hash: t.hash })
      if (fit === 'high') high++; else if (fit === 'mid') mid++
    }
    // the judgement is the model's; a person's review (status · note) stays when it is asked again
    if (rows.length) await q(`insert into pro_ai_candidates (tenant_id, task, fit, how, why, skills, needs, risk, human, facts, facts_hash, version)
             select $1, x->>'task', x->>'fit', x->>'how', x->>'why', x->'skills', x->'needs', x->>'risk', x->'human', x->'facts', x->>'facts_hash', $3 from jsonb_array_elements($2::jsonb) x
             on conflict (tenant_id, task) do update set fit=excluded.fit, how=excluded.how, why=excluded.why, skills=excluded.skills, needs=excluded.needs,
               risk=excluded.risk, human=excluded.human, facts=excluded.facts, facts_hash=excluded.facts_hash, version=excluded.version, made_at=now()`, [T(), JSON.stringify(rows), version])
    asked += part.length
    await say(`${asked.toLocaleString('ko-KR')}/${todo.length.toLocaleString('ko-KR')}개 봤어요 — 맡길 만한 일 ${high}개 · 초안을 맡길 일 ${mid}개 · 사람이 꼭 해야 하는 일 ${must}개.`, 'judge')
  }
  // a few parts at once (the gateway answers one part in about a minute)
  const queue = [...parts]
  await Promise.all(Array.from({ length: Math.max(1, R.parallel || 3) }, async () => { while (queue.length) await one(queue.shift()) }))
  const best = (await candidateList()).items.filter((x) => x.fit === 'high' || x.fit === 'mid').slice(0, 3)
  if (best.length) await say(`먼저 볼 후보: ${best.map((x) => `「${x.task}」(한 달 ${x.monthly}번 · ${HOW_KO[x.how]})`).join(' · ')}`)
  return { seen: seen.length, asked, high, mid, must }
}
export const HOW_KO = { agent: '에이전트가 맡음', draft: '에이전트가 초안', assist: 'AI가 도움', person: '사람' }

// every task with its judgement (if any), most worth looking at first
export async function candidateList() {
  const R = (await skillRules()).candidates || {}
  const { months, tasks } = await taskFacts()
  const rows = new Map((await q(`select task, fit, how, why, skills, needs, risk, human, status, note, decided_by, decided_at, made_at, facts_hash, facts from pro_ai_candidates where tenant_id=$1`, [T()])).map((r) => [r.task, r]))
  const items = tasks.map((t) => {
    const r = rows.get(t.name)
    return { task: t.name, role: t.role, kind: t.kind, n: t.n, monthly: t.monthly, schedule: t.schedule, files: t.files, acts: t.acts,
      ...(r ? { fit: r.fit, how: r.how, why: r.why, skills: r.skills, needs: r.needs, risk: r.risk, human: r.human || [], status: r.status, note: r.note, decided_by: r.decided_by, decided_at: r.decided_at, judged_at: r.made_at, model: r.facts?.model || '', stale: r.facts_hash !== t.hash } : { fit: null }),
      score: r ? scoreOf(r.fit, t.monthly) : 0 }
  }).sort((a, b) => b.score - a.score || b.n - a.n)
  const judged = items.filter((x) => x.fit)
  const count = (f) => judged.filter((x) => x.fit === f).length
  return { months, minN: R.minN ?? 2, total: items.length, judged: judged.length, unjudged: items.filter((x) => !x.fit && x.n >= (R.minN ?? 2)).length,
    once: items.filter((x) => !x.fit && x.n < (R.minN ?? 2)).length, counts: { high: count('high'), mid: count('mid'), low: count('low'), none: count('none'), human: judged.filter((x) => x.human?.length).length },
    accepted: judged.filter((x) => x.status === 'accepted').length, items }
}

export async function candidateOf(task) {
  const [r] = await q(`select task, fit, how, why, skills, needs, risk, human, facts, status, note, decided_by, decided_at, made_at from pro_ai_candidates where tenant_id=$1 and task=$2`, [T(), task])
  return r || null
}

// a person's review: 채택(accepted) · 아님(rejected) · 다시 후보로(proposed)
export async function decideCandidate(me, task, { status, note = '' } = {}) {
  if (!['accepted', 'rejected', 'proposed'].includes(status)) throw err(400, 'status 는 accepted · rejected · proposed 중 하나예요.')
  const [r] = await q(`update pro_ai_candidates set status=$3, note=$4, decided_by=$5, decided_at=now() where tenant_id=$1 and task=$2 returning task, fit, how, status`,
    [T(), task, status, clean(note).slice(0, 300), me.email || String(me.id)])
  if (!r) throw err(404, '아직 AI 가 보지 않은 일이에요.')
  await ledger(me, 'ontology.ai_candidate', task, { status, fit: r.fit, how: r.how, note: clean(note).slice(0, 300) })
  return candidateOf(task)
}
