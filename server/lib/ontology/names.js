// 일 이름 맞추기(design-v0.2 §5.2): a raw activity text — a chat handover's message, a delegation's long instruction,
// what the mail reader said a mail does — becomes one of the company's task names, so the graph is not split by
// wording ("견적 보냄" and "견적서 송부" are one task). The same text is asked once (pro_onto_labels). Known names are
// offered first; a text the model cannot place becomes a candidate task, shown faded until someone confirms it.
// Also decides whose work it was: a request ("평면도 좀 그려 주세요") is the receiver's task, a delivery or a report
// ("평면도 공유해요") the sender's.
import crypto from 'node:crypto'
import { prompt } from './discovery.js'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chatJson } from '../llm.js'
import { maskPii } from '../policy/pii.js'

const T = () => config.tenantId
export const hashOf = (s) => crypto.createHash('sha1').update(String(s).trim()).digest('hex')
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
export const ACTS = ['request', 'deliver', 'approve', 'notify']

// prompt: the process-discovery skill's prompts/name-labels.md

// [{raw, hint?}] → Map(raw → {task, act, how})
export async function resolveLabels(items, { known = [] } = {}) {
  const out = new Map()
  const want = [...new Map(items.filter((x) => clean(x.raw)).map((x) => [clean(x.raw), x])).values()]
  if (!want.length) return out
  const cached = await q('select raw_hash, task, act, how from pro_onto_labels where tenant_id=$1 and raw_hash = any($2)', [T(), want.map((x) => hashOf(clean(x.raw)))])
  const byHash = new Map(cached.map((r) => [r.raw_hash, r]))
  const names = new Set([...known, ...cached.map((r) => r.task).filter(Boolean)])
  const left = []
  for (const x of want) {
    const r = byHash.get(hashOf(clean(x.raw)))
    if (r) out.set(clean(x.raw), { task: r.task, act: r.act || 'notify', how: r.how })
    else left.push(x)
  }
  // the names already used in this tenant are the vocabulary
  for (const r of await q('select distinct task from pro_onto_labels where tenant_id=$1 and task <> \'\'', [T()])) names.add(r.task)
  for (let i = 0; i < left.length; i += 10) {
    const part = left.slice(i, i + 10)
    let ans = null
    for (let tries = 0; tries < 2 && !ans; tries++) {
      try {
        const r = await chatJson(await prompt('name-labels'), JSON.stringify({ known_tasks: [...names], items: part.map((x, n) => ({ i: n, text: maskPii(clean(x.raw)).slice(0, 600), ...(x.hint ? { hint: x.hint } : {}) })) }), { timeoutMs: 120000, temperature: 0 })
        ans = Array.isArray(r?.items) ? r.items : null
      } catch (e) { console.warn('[ontology] names', e.message) }
    }
    // the model did not answer: nothing is decided (and nothing cached) — the next build asks again
    if (!ans) continue
    for (let n = 0; n < part.length; n++) {
      const a = ans.find((x) => Number(x.i) === n)
      if (!a) continue
      const task = clean(a.task).slice(0, 30)
      const act = ACTS.includes(a.act) ? a.act : 'notify'
      const how = !task ? 'none' : names.has(task) ? (a.known ? 'alias' : 'same') : 'model'
      if (task) names.add(task)
      const raw = clean(part[n].raw)
      out.set(raw, { task, act, how })
      await q(`insert into pro_onto_labels (tenant_id, raw_hash, raw, task, act, how) values ($1,$2,$3,$4,$5,$6)
               on conflict (tenant_id, raw_hash) do update set task=excluded.task, act=excluded.act, how=excluded.how`, [T(), hashOf(raw), raw.slice(0, 2000), task, act, how])
    }
  }
  return out
}

// 습관의 목표 이름(design-v0.3 §10): what a person asks for right after a result is named after the goal of that follow-up
// step ("직인 넣기"), never after the work that made the result ("견적서 작성") — different words for the same goal get one
// name, so the same goal reached in different ways can be compared. Kept with the other names (raw "습관 · …").
// prompt: the process-discovery skill's prompts/name-habits.md
export async function nameHabits(actions) {
  const out = new Map()
  const want = [...new Set(actions.map(clean).filter(Boolean))]
  if (!want.length) return out
  const key = (a) => `습관 · ${a}`
  const cached = await q('select raw_hash, task from pro_onto_labels where tenant_id=$1 and raw_hash = any($2)', [T(), want.map((a) => hashOf(key(a)))])
  const byHash = new Map(cached.map((r) => [r.raw_hash, r.task]))
  const left = []
  for (const a of want) { const t = byHash.get(hashOf(key(a))); if (t) out.set(a, t); else left.push(a) }
  const known = new Set([...out.values()])
  for (const r of await q(`select distinct task from pro_onto_labels where tenant_id=$1 and act='habit' and task <> ''`, [T()])) known.add(r.task)
  for (let i = 0; i < left.length; i += 10) {
    const part = left.slice(i, i + 10)
    let ans = null
    for (let tries = 0; tries < 2 && !ans; tries++) {
      try {
        const r = await chatJson(await prompt('name-habits'), JSON.stringify({ known: [...known], items: part.map((a, n) => ({ i: n, text: maskPii(a).slice(0, 300) })) }), { timeoutMs: 60000, temperature: 0 })
        ans = Array.isArray(r?.items) ? r.items : null
      } catch (e) { console.warn('[ontology] habit names', e.message) }
    }
    if (!ans) continue
    for (let n = 0; n < part.length; n++) {
      const task = clean(ans.find((x) => Number(x.i) === n)?.task).slice(0, 30)
      if (!task) continue
      known.add(task)
      out.set(part[n], task)
      await q(`insert into pro_onto_labels (tenant_id, raw_hash, raw, task, act, how) values ($1,$2,$3,$4,'habit','model')
               on conflict (tenant_id, raw_hash) do update set task=excluded.task, act='habit'`, [T(), hashOf(key(part[n])), key(part[n]).slice(0, 2000), task])
    }
  }
  return out
}

// what the label table shows a person: raw texts and the task each became (newest first)
export async function labelExamples(limit = 30) {
  return q(`select raw, task, act, how, created_at from pro_onto_labels where tenant_id=$1 and task <> '' order by length(raw) desc, created_at desc limit $2`, [T(), limit])
}

// 같은 일, 다른 이름 묶기: when names were given in parallel (four threads read at once) or by different people, the same work
// can end up under two names ("현장 실측" · "현장 확인"). The model sees the names in use with how often and an example
// each, and groups only those that are the same work; each group takes its most used name. Kept in pro_onto_labels
// (how = merged), so the label table shows what was joined.
// prompt: the process-discovery skill's prompts/merge-names.md
// list: [{name, count, before: [names], after: [names]}] — the names in use with how often they occur and their usual
// neighbours in the flow (what the model needs to tell "the same work in other words" from different work)
export async function consolidate(list = []) {
  if (list.length < 2) return []
  let groups = []
  try {
    const r = await chatJson(await prompt('merge-names'), JSON.stringify(list), { temperature: 0, timeoutMs: 120000 })
    groups = Array.isArray(r?.groups) ? r.groups : []
  } catch (e) { console.warn('[ontology] consolidate', e.message); return [] }
  const count = new Map(list.map((x) => [x.name, x.count]))
  const merged = []
  for (const g of groups) {
    const names = [...new Set((g || []).map(String))].filter((x) => count.has(x))
    if (names.length < 2) continue
    const keep = names.sort((a, b) => count.get(b) - count.get(a))[0]
    for (const x of names.filter((y) => y !== keep)) {
      await q(`update pro_onto_labels set task=$3, how='merged' where tenant_id=$1 and task=$2`, [T(), x, keep])
      merged.push({ from: x, to: keep })
    }
  }
  return merged
}
