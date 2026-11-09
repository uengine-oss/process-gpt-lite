// Process mining over ad-hoc work: process-gpt's process-miner (services/process-miner, branch
// feat/handover-process-identification + feat/pgpt-lite-mining) finds the repeated flow in the
// handover records; an admin sees it as a recommendation, opens the mined flow and decides. On
// 정식 등록 the definition is generated from the mined model (steps, order, roles, agents) plus the
// catalog (forms, skills) and saved with process-gpt's own save path (save_contract + BPMN XML);
// the next similar mail starts it (routeMail).
//
// How cases become one recommendation (the matching rule, decided 2026-11-09):
//   - one case = one customer mail (pro_mining_cases); its steps are the handover records up to the
//     customer reply — anything after the reply is not part of it (recorder.js caseClosed)
//   - what the case was asked to do (its 업무 범주) is judged once, when the case ends, and kept on the
//     case (categoryOf). The miner groups by that category, not by how much the step names overlap:
//     branches, repeats and skipped steps are variants of one flow, not flows of their own
//   - the admin's decisions are the boundary: every 정식 등록·보류 recommendation is sent along
//     (decidedOf) and the miner keeps one group per decision, so two decided flows never merge
//   - a group is the same recommendation as an existing one when the key is the same; for a
//     recommendation that is not decided yet, also when most of its cases already belong to it
//     (sameSuggestion). A decided recommendation grows only through its own key — its evidence is
//     never overwritten by another group that happens to share cases
//   - a case the miner could not place (no category, or none of the group's required steps) comes back
//     in `unclassified`; the admin is asked which work it is (category_ask on the case)
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { chatJson } from '../llm.js'
import { saveGenerated } from '../generated.js'
import { mainThread, addMessage } from '../store.js'
import { agentsIn, ORCH, STEPS, STEPS_EN, TOOL_FORMAT, stepOf, labelLang } from './catalog.js'
import { caseClosed } from './recorder.js'
import { L, isEn, lang, langOf, withLang } from '../lang.js'
import { fmtNum } from '../improve/transform.js'
import { josa } from '../improve/focus.js'

const T = () => config.tenantId
// unset: the local miner; set but empty (an install without the mining profile): no scans, no new
// recommendations (registered processes still take matching mail)
const MINER = (process.env.PRO_MINER_URL ?? 'http://127.0.0.1:8014').replace(/\/$/, '')
export const minerEnabled = () => !!MINER
const err = (status, message) => Object.assign(new Error(message), { status })

// (errors from here carry .miner: the scan route tells the admin the search itself failed)
async function miner(path, body) {
  const fail = (m) => Object.assign(new Error(m), { miner: true })
  if (!MINER) throw fail('process-miner is not configured (PRO_MINER_URL)')
  let r
  try {
    // a server-to-server call (the periodic scan runs without a user): the miner accepts the verified
    // service_role key and reads only the tenant asked for; it writes nothing
    const headers = { ...(config.serviceKey ? { Authorization: `Bearer ${config.serviceKey}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }
    r = await fetch(`${MINER}${path}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers })
  } catch (e) { throw fail(`process-miner unreachable: ${e.cause?.code || e.message}`) }
  const t = await r.text()
  if (!r.ok) throw fail(`process-miner ${r.status}: ${t.slice(0, 200)}`)
  return JSON.parse(t)
}

export async function isAdmin(me) {
  const [u] = await q('select is_admin from users where id::text=$1 and tenant_id=$2', [String(me.id), T()])
  return !!u?.is_admin
}

// ---------- 찾기: 반복 패턴 → 추천 ----------
const NAME = `프로세스 마이닝이 사람·에이전트의 인계 기록에서 반복되는 업무 흐름을 찾았어요. 이 흐름에 이름을 붙이세요.
JSON {"name","summary","keywords"} 로 답하세요.
- name: 한국어 명사구 14자 이내, 가운뎃점(·)으로 두 일을 잇는 형식. 예: "설계 제안·견적 대응", "입사 서류·계정 발급"
- summary: 이 흐름이 무엇인지 해요체 한 문장
- keywords: 다음에 같은 일을 요청하는 메일에 나올 한국어 낱말 3~6개`
// English mode: an English flow (its steps were recorded in English) gets an English name, and English
// keywords, so the next English mail asking for the same work matches them (matches below)
const NAME_EN = `Process mining found a work flow that repeats in the handover records of people and agents. Give this flow a name.
Answer with JSON {"name","summary","keywords"}.
- name: an English noun phrase of at most 32 characters joining two jobs with " & ", e.g. "Design proposal & quote", "Onboarding papers & accounts"
- summary: one plain sentence on what this flow is
- keywords: 3–6 English words that a mail asking for the same work next time would contain (lowercase, single words)`

// the language a mined flow is in: the language its steps were recorded in (lib/mining/recorder.js)
export const patternLang = (p) => labelLang((p?.main_variant || []).join(' '))

async function nameOf(p, cases) {
  return withLang(patternLang(p), async () => {
    try {
      const r = await chatJson(L(NAME, NAME_EN), JSON.stringify({ steps: p.main_variant, examples: cases.map((c) => c.subject).filter(Boolean).slice(0, 5) }))
      if (r?.name) return { name: String(r.name).slice(0, L(30, 40)), summary: String(r.summary || ''), keywords: (r.keywords || []).map(String).slice(0, 6) }
    } catch (e) { console.warn('[mining] name', e.message) }
    return { name: L(`${p.main_variant[0]} 이후 반복 흐름`, `Recurring flow after ${p.main_variant[0]}`), summary: '', keywords: [] }
  })
}

// ---------- 업무 범주: 무엇을 요청받은 일인가 ----------
// The one thing that decides whether two cases are the same process. Judged once, when the case has
// ended, and kept — judging again on every search would make the same cases group differently each
// time the admin presses "지금 다시 찾기". An admin's own answer (category_by='admin') is never redone.
const CATEGORY = `아래는 고객이 메일로 요청한 일을 처리한 업무들입니다. 업무마다 무엇을 요청받은 일인지 범주를 정하세요.
JSON {"categories": {"<id>": "<범주>"}} 로 답하세요. 모든 업무에 하나씩 답하세요.
- 범주는 한국어 명사구 12자 이내입니다. 예: "행사 견적", "매장 설계"
- 범주는 일의 종류입니다. 행사 이름(송년회·워크숍·북토크·창립 기념식)이나 고객 이름으로 나누지 마세요 — 그것들은 모두 "행사 견적" 하나입니다.
- known 에 같은 종류의 일이 있으면 그 범주를 글자 그대로 쓰세요.
- 거쳐 간 단계 이름이 아니라 고객이 요청한 일로 정하세요. 누가 검토했는지는 범주와 상관없습니다.
- 범주는 되도록 적게 쓰세요. 한 조직이 하는 일의 종류는 보통 두세 가지입니다.`
const CATEGORY_EN = `Below are pieces of work, each answering a customer's request mail. Name the kind of work each one is.
Answer with JSON {"categories": {"<id>": "<category>"}}, one for every piece.
- A category is an English noun phrase of at most 24 characters, e.g. "Event quote", "Store design".
- A category is the kind of work. Do not split by the name of the event (year-end party, workshop, book talk) or by the customer — those are all one "Event quote".
- If \`known\` already holds the same kind of work, reuse that category exactly.
- Go by what the customer asked for, not by the step names. Who reviewed it does not change the category.
- Use as few categories as possible. An organization usually does two or three kinds of work.`

// All the pending cases are judged together, in one call: judged one at a time, the same work came
// back as 워크숍 견적, 송별회 견적, 시상식 견적 … — the event's name, not the kind of work — and the
// groups split for the same reason the step names used to split them.
async function categoriesOf(cases, known, cl) {
  return withLang(cl, async () => {
    try {
      const r = await chatJson(L(CATEGORY, CATEGORY_EN), JSON.stringify({ known, cases }))
      const out = {}
      for (const [id, v] of Object.entries(r?.categories || {})) {
        const name = String(v || '').trim().slice(0, L(14, 30))
        if (name) out[id] = name
      }
      return out
    } catch (e) { console.warn('[mining] category', e.message); return {} }
  })
}

// A case has ended when the customer was answered — or when nothing has moved on it for a while.
// The same two ways doScan counts a case as evidence: work that ends without a reply (the mail was
// handled another way, the demo mailbox cannot send) would otherwise never get a category at all.
async function caseEnded(caseId) {
  if (await caseClosed(caseId)) return true
  const [r] = await q(`select 1 from handover_events where tenant_id=$1 and case_id=$2
                       and occurred_at > now() - make_interval(secs => $3) limit 1`,
  [T(), caseId, Number(process.env.PRO_MINING_IDLE_SEC || 1800)])
  return !r
}

// every case that has ended and has no category yet gets one (once)
async function ensureCategories() {
  const rows = await q(`select case_id, subject, customer, files from pro_mining_cases
                        where tenant_id=$1 and category is null order by created_at`, [T()])
  if (!rows.length) return
  const known = (await q(`select distinct category from pro_mining_cases where tenant_id=$1 and category is not null order by category`, [T()])).map((r) => r.category)
  const pending = []
  for (const c of rows) {
    if (!(await caseEnded(c.case_id))) continue
    const steps = (await q(`select norm_activity_label as l from handover_events
                            where tenant_id=$1 and case_id=$2 order by occurred_at`, [T(), c.case_id])).map((r) => r.l).filter(Boolean)
    if (steps.length < 2) continue
    pending.push({ id: c.case_id, subject: c.subject || '', customer: c.customer || '', documents: c.files || [], steps })
  }
  if (!pending.length) return
  const cl = labelLang(pending.flatMap((p) => p.steps).join(' '))
  // in batches, so one call sees enough of the work at once to use the same few categories
  for (let i = 0; i < pending.length; i += 25) {
    const batch = pending.slice(i, i + 25)
    const got = await categoriesOf(batch, known, cl)
    for (const p of batch) {
      const category = got[p.id]
      if (!category) continue
      await q(`update pro_mining_cases set category=$2, category_by='ai' where case_id=$1 and category is null`, [p.id, category])
      if (!known.includes(category)) known.push(category)
    }
  }
}

// the boundaries the admin drew: one group per decided recommendation, in the order they were decided
async function decidedOf() {
  const rows = await q(`select pattern_key, pattern from pro_mining_suggestions
                        where tenant_id=$1 and status in ('registered','held')
                        order by coalesce(decided_at, created_at), created_at`, [T()])
  const out = []
  for (const r of rows) {
    const ids = r.pattern?.case_ids || []
    const [top] = ids.length
      ? await q(`select category from pro_mining_cases where tenant_id=$1 and case_id = any($2) and category is not null
                 group by category order by count(*) desc, category limit 1`, [T(), ids])
      : []
    out.push({ key: r.pattern_key, category: top?.category || r.pattern?.category || '', core_activities: r.pattern?.core_activities || [] })
  }
  return out
}

// cases the miner could not place — the admin is asked which work they are. Work still under way is
// not asked about: it has no category yet only because it has not ended, and it is not evidence either.
async function markUnclassified(list = []) {
  const ask = []
  for (const u of list) if (await caseEnded(u.case_id)) ask.push(u)
  await q('update pro_mining_cases set category_ask=null where tenant_id=$1 and category_ask is not null and not (case_id = any($2))',
    [T(), ask.map((u) => u.case_id)])
  for (const u of ask) {
    await q('update pro_mining_cases set category_ask=$2 where tenant_id=$1 and case_id=$3', [T(), u.reason || 'no_category', u.case_id])
  }
}

export async function unclassified() {
  const rows = await q(`select case_id, subject, customer, files, category, category_ask, created_at
                        from pro_mining_cases where tenant_id=$1 and category_ask is not null order by created_at`, [T()])
  const known = (await q(`select distinct category from pro_mining_cases where tenant_id=$1 and category is not null order by category`, [T()])).map((r) => r.category)
  const out = []
  for (const c of rows) {
    const steps = (await q(`select norm_activity_label as l from handover_events
                            where tenant_id=$1 and case_id=$2 order by occurred_at`, [T(), c.case_id])).map((r) => r.l).filter(Boolean)
    out.push({ ...c, steps })
  }
  return { cases: out, categories: known }
}

// the admin's answer wins over the judged category and is not judged again
export async function setCategory(me, caseId, category) {
  if (!(await isAdmin(me))) throw err(403, L('관리자만 바꿀 수 있어요.', 'Only an administrator can change this.'))
  const v = String(category || '').trim().slice(0, 40)
  if (!v) throw err(400, L('업무 범주를 입력해 주세요.', 'Enter the kind of work.'))
  const [row] = await q(`update pro_mining_cases set category=$2, category_by='admin', category_ask=null
                         where tenant_id=$1 and case_id=$3 returning case_id, category`, [T(), v, caseId])
  if (!row) throw err(404, L('사례를 찾지 못했어요.', "I couldn't find that case."))
  return row
}

let scanning = null
export function scan() { return (scanning ||= doScan().finally(() => { scanning = null })) }

// the admin's "지금 다시 찾기": a search that could not run is said so — not shown as "no flows yet".
// (500, not 502/503: Cloudflare in front of production replaces an origin 502 with its own HTML page and
// the message is lost.) The miner's status or reachability is kept short at the end, e.g. "(process-miner 401)".
export async function scanNow() {
  if (!MINER) throw err(500, L('프로세스 마이닝 서비스가 설정되지 않아 흐름을 찾을 수 없어요.', "Process mining isn't set up, so I can't look for flows."))
  try { return await scan() } catch (e) {
    if (!e.miner) throw e
    console.warn('[mining] scan', e.message)
    const why = (/^process-miner (\d{3}|unreachable: \S+)/.exec(e.message) || [])[0] || 'process-miner'
    throw err(500, L(`프로세스 마이닝 서비스에 연결하지 못해 흐름을 찾지 못했어요. 잠시 후 다시 시도해 주세요. (${why})`,
      `I couldn't reach the process mining service, so no flows were checked. Try again in a moment. (${why})`))
  }
}

async function doScan() {
  if (!MINER) return []
  await ensureCategories()
  const categories = Object.fromEntries((await q(
    'select case_id, category from pro_mining_cases where tenant_id=$1 and category is not null', [T()])).map((r) => [r.case_id, r.category]))
  const { patterns, unclassified: unplaced } = await miner('/patterns', {
    tenant_id: T(), min_cases: Number(process.env.PRO_MINING_MIN_CASES || 4), categories, decided: await decidedOf(),
  })
  await markUnclassified(unplaced)
  const made = []
  for (const p of patterns) {
    // A decided flow's evidence is exactly what the miner placed in it — empty included. The miner
    // places every case in one group only, so keeping an older, larger list here would show the same
    // case under two recommendations. (A flow starves when the admin drew two boundaries the data
    // cannot tell apart: same category, same required steps. Then the one decided first takes them.)
    if (!p.case_ids?.length && !p.decided_key) continue
    // only work pgpt-pro recorded (one case = one mail); other tenants' demos are not ours to suggest
    const cases = await q('select * from pro_mining_cases where tenant_id=$1 and case_id = any($2) order by created_at', [T(), p.case_ids])
    if (p.case_ids.length && cases.length * 2 < p.case_ids.length) continue
    const have = await sameSuggestion(p)
    if (have) {
      // more cases of a pattern already suggested: the evidence grows, the decision stays
      // (still undecided: the mined model is drawn again from all the cases)
      const again = have.status === 'suggested' ? await miner('/discover', { tenant_id: T(), process_id: p.process_id, name: p.process_id, case_ids: p.case_ids, lang: patternLang(p) }).catch(() => null) : null
      await q('update pro_mining_suggestions set pattern=$2, definition=coalesce($3, definition), updated_at=now() where id=$1', [have.id, p, again?.definition || null])
      continue
    }
    // a case still under way is not evidence yet: each case must have reached the flow's usual last
    // step (or sat idle for a while), and none may have moved in the last moments
    const last = p.main_variant.at(-1)
    const [open] = await q(`select 1 from (select distinct on (case_id) case_id, norm_activity_label as l, occurred_at from handover_events
                              where tenant_id=$1 and case_id = any($2) order by case_id, occurred_at desc) x
                            where occurred_at > now() - make_interval(secs => $4) or (l <> $3 and occurred_at > now() - make_interval(secs => $5)) limit 1`,
    [T(), p.case_ids, last, Number(process.env.PRO_MINING_SETTLE_SEC || 20), Number(process.env.PRO_MINING_IDLE_SEC || 1800)])
    if (open) continue
    const named = await nameOf(p, cases)
    named.name = await uniqueName(named.name)
    // the miner only draws the model (it writes nothing); its names and descriptions are in the language
    // of the work (the cases' recorded language). The process is saved on 정식 등록 (registerIn).
    const mined = await miner('/discover', { tenant_id: T(), process_id: p.process_id, name: named.name, case_ids: p.case_ids, lang: patternLang(p) })
    const formats = [...new Set(p.steps.flatMap((s) => s.tools.map((t) => TOOL_FORMAT[t]).filter(Boolean)))]
    const [s] = await q(`insert into pro_mining_suggestions (tenant_id, pattern_key, process_id, name, summary, pattern, definition, pr_id, version_uuid, match)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id, pattern_key) do nothing returning *`, [
      T(), p.key, p.process_id, named.name, named.summary, p, mined.definition, mined.pr?.pr_id || null, mined.pr?.version_uuid || null,
      { formats, keywords: named.keywords }])
    if (!s) continue
    made.push(s)
    await notifyAdmins(s)
  }
  await dropWithdrawn(patterns)
  return made
}

// A recommendation the admin has not decided on is the system's own proposal. When the cases it rested
// on now belong to other groups, the proposal no longer stands: its evidence is trimmed to what is
// still its own, and a proposal left with nothing is withdrawn. Decided ones (정식 등록·보류) are the
// admin's and are never withdrawn here — the miner keeps a group for each of them.
async function dropWithdrawn(patterns) {
  const taken = new Set(patterns.flatMap((p) => p.case_ids || []))
  const keys = new Set(patterns.map((p) => p.key))
  const rows = await q(`select id, pattern_key, pattern from pro_mining_suggestions where tenant_id=$1 and status='suggested'`, [T()])
  for (const r of rows) {
    if (keys.has(r.pattern_key)) continue
    const ids = (r.pattern?.case_ids || []).filter((c) => !taken.has(c))
    if (ids.length === (r.pattern?.case_ids || []).length) continue
    if (!ids.length) { await q('delete from pro_mining_suggestions where id=$1', [r.id]); continue }
    await q('update pro_mining_suggestions set pattern = jsonb_set(jsonb_set(pattern, \'{case_ids}\', $2::jsonb), \'{case_count}\', $3::jsonb), updated_at=now() where id=$1',
      [r.id, JSON.stringify(ids), JSON.stringify(ids.length)])
  }
}

// the recommendation a found group already is: the same key, or — for a recommendation the admin has
// not decided on yet — most of its cases (≥ half of the smaller side) already counted there.
// A decided recommendation (정식 등록·보류) grows only through its own key: the miner keeps one group
// per decision, so a group that merely shares cases with it is other work and must not overwrite it.
export async function sameSuggestion(p) {
  const [byKey] = await q('select id, status from pro_mining_suggestions where tenant_id=$1 and pattern_key=$2', [T(), p.key])
  if (byKey) return byKey
  if (p.decided_key) return null
  const rows = await q(`select id, status, pattern->'case_ids' as cases from pro_mining_suggestions where tenant_id=$1 and status='suggested'`, [T()])
  const mine = new Set(p.case_ids || [])
  let best = null
  for (const r of rows) {
    const theirs = Array.isArray(r.cases) ? r.cases : []
    const shared = theirs.filter((c) => mine.has(c)).length
    const share = shared / Math.max(1, Math.min(theirs.length, mine.size))
    if (shared && share >= 0.5 && (!best || share > best.share)) best = { id: r.id, status: r.status, share }
  }
  return best
}

// two different flows the model happens to name alike stay apart in the admin's list
async function uniqueName(name) {
  const taken = new Set((await q('select name from pro_mining_suggestions where tenant_id=$1', [T()])).map((r) => r.name))
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} ${n}`)) n++
  return `${name} ${n}`
}

async function notifyAdmins(s) {
  const admins = await q(`select u.id::text as id from users u join pro_team_members m on m.user_id=u.id and m.tenant_id=u.tenant_id
                          where u.tenant_id=$1 and u.is_admin and not coalesce(u.is_agent,false)`, [T()])
  const n = s.pattern.case_count
  for (const a of admins) {
    // each admin reads it in their own saved language (lib/lang.js)
    const en = (await langOf(a.id)) === 'en'
    await q(`insert into notifications (id, user_id, title, type, description, url, tenant_id) values (gen_random_uuid(),$1,$2,'mining',$3,$4,$5)`,
      [a.id, en ? `I found a recurring flow: ${s.name}` : `반복되는 흐름을 찾았어요: ${s.name}`,
        en ? `The last ${n} mail jobs were handled in the same order (${s.pattern.main_variant.join(' → ')}). Decide whether to register it as a process.`
          : `최근 ${n}건의 메일 업무가 같은 순서(${s.pattern.main_variant.join(' → ')})로 처리됐어요. 정식 프로세스로 등록할지 정해 주세요.`, `/mining/${s.id}`, T()])
    emit(a.id, 'notifications', {})
    emit(a.id, 'mining', { id: s.id })
  }
}

// ---------- 보기 ----------
export async function list() {
  return q(`select id, name, summary, status, proc_def_id, pattern->'case_count' as case_count, pattern->'main_variant' as steps, created_at, decided_at
            from pro_mining_suggestions where tenant_id=$1 order by created_at desc limit 20`, [T()])
}

export async function get(id) {
  const [s] = await q('select * from pro_mining_suggestions where id=$1 and tenant_id=$2', [id, T()])
  if (!s) return null
  const cases = await q('select case_id, customer, subject, demo, created_at from pro_mining_cases where tenant_id=$1 and case_id = any($2) order by created_at', [T(), s.pattern.case_ids])
  const evs = await q(`select case_id, norm_activity_label as activity, to_user_name as who, to_is_agent as agent, occurred_at, artifact_refs
                       from handover_events where tenant_id=$1 and case_id = any($2) order by occurred_at`, [T(), s.pattern.case_ids])
  for (const c of cases) {
    const mine = evs.filter((e) => e.case_id === c.case_id)
    c.steps = mine.map((e) => ({ activity: e.activity, who: e.who, agent: e.agent, at: e.occurred_at, files: (e.artifact_refs || []).map((r) => r.name).filter(Boolean) }))
    c.minutes = mine.length > 1 ? Math.round((new Date(mine.at(-1).occurred_at) - new Date(mine[0].occurred_at)) / 60000) : 0
  }
  const steps = s.pattern.steps.map((x) => ({ ...x, kind: x.by_agent * 2 >= x.total ? 'agent' : 'human', catalog: stepOf(x.activity) }))
  const pr = s.pr_id ? (await q('select id, title, status, branch_name, created_at, merged_at from resource_pull_requests where id=$1', [s.pr_id]))[0] : null
  const runs = s.proc_def_id ? await q(`select r.proc_inst_id, r.mail, r.created_at, i.status, i.proc_inst_name from pro_mining_runs r
                                         left join bpm_proc_inst i on i.proc_inst_id=r.proc_inst_id where r.suggestion_id=$1 order by r.created_at desc`, [s.id]) : []
  return { ...s, steps, cases, pr, runs }
}

// ---------- 결정 ----------
const tag = { text: 'text-field', select: 'select-field', radio: 'radio-field', textarea: 'textarea-field', file: 'file-field' }
const html = (id, alias, fs) => `<section>\n${fs.map((f) => {
  const t = tag[f.type] || 'text-field'
  const items = f.items ? ` is_dynamic_load='fixed' items='${JSON.stringify(f.items)}'` : ''
  const type = t === 'text-field' ? " type='text'" : ''
  return `  <row-layout name="${id}" alias="${alias}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><${t} name='${f.key}' alias='${f.text}'${type}${items} disabled='false' readonly='false' v-model="slotProps.modelValue['${f.key}']"></${t}></div></div></row-layout>`
}).join('\n')}\n</section>`

// A mined optional review (the miner's xor(review, skip) after the quote, e.g. 'Finance review' skipped
// in one case of five) gets the rule it stands for: a quote under the threshold skips it — the same
// rule and wording as the improvement 'skip under a threshold' (lib/improve/transform.js), on the
// quote step's amount. When the amount is missing the review is the default flow (the miner's
// default/priority), so the engine always hands out exactly one of the two.
export const REVIEW_THRESHOLD = () => Number(process.env.PRO_MINING_REVIEW_THRESHOLD || 50_000_000)
export function reviewRule(d0, threshold = REVIEW_THRESHOLD()) {
  const d = JSON.parse(JSON.stringify(d0))
  const quote = (d.activities || []).find((a) => stepOf(a.name)?.key === 'quote')
  if (!quote) return d
  const label = L('견적 합계', 'Quote total')
  for (const g of d.gateways || []) {
    if (!/exclusive/i.test(g.type || '')) continue
    const outs = (d.sequences || []).filter((x) => x.source === g.id)
    if (outs.length !== 2) continue
    const review = outs.map((x) => (d.activities || []).find((a) => a.id === x.target)).find((a) => a && stepOf(a.name)?.key === 'finance')
    const keep = review && outs.find((x) => x.target === review.id)
    const skip = keep && outs.find((x) => x !== keep)
    // the other branch must go around the review (a pass-through gateway or the join), not to another step
    if (!skip || (d.activities || []).some((a) => a.id === skip.target)) continue
    g.name = L(`${label} 기준`, `${label} threshold`)
    g.description = L(`${label} ${fmtNum(threshold)} 미만이면 '${review.name}' 을(를) 건너뜀`, `Skips '${review.name}' when ${label} is under ${fmtNum(threshold)}`)
    Object.assign(keep, { name: L(`${fmtNum(threshold)} 이상`, `${fmtNum(threshold)} or more`), condition: L(`${label}(amount) 이(가) ${threshold} 이상`, `${label} (amount) is ${threshold} or more`), properties: JSON.stringify({ priority: 0, default: true }) })
    Object.assign(skip, { name: L(`${fmtNum(threshold)} 미만 · 건너뜀`, `under ${fmtNum(threshold)} · skipped`), condition: L(`${label}(amount) 이(가) ${threshold} 미만`, `${label} (amount) is under ${threshold}`), properties: JSON.stringify({ priority: 1 }) })
  }
  return d
}

// An older miner leaves "조건N" on an optional step's XOR split for an LLM pass Lite does not run, and the
// engine cannot decide such a branch (the instance stops there): keep the step on the main path instead.
// (after reviewRule, which gives the mined Finance review its real rule; a current miner writes none)
export function dropSkips(d) {
  const placeholder = (c) => /^조건\s*\d+$/.test(String(c || '').trim())
  let gateways = [...(d.gateways || [])]
  let sequences = [...(d.sequences || [])]
  const isGateway = (id) => gateways.some((g) => g.id === id)
  for (const s of sequences.filter((x) => placeholder(x.condition) && isGateway(x.target))) {
    const ins = sequences.filter((x) => x.target === s.target), outs = sequences.filter((x) => x.source === s.target)
    if (ins.length !== 1 || outs.length !== 1) continue
    sequences = sequences.filter((x) => x !== s && x !== outs[0])
    gateways = gateways.filter((g) => g.id !== s.target)
  }
  sequences = sequences.map((x) => (placeholder(x.condition) ? { ...x, condition: '' } : x))
  for (const g of [...gateways]) {
    const ins = sequences.filter((x) => x.target === g.id), outs = sequences.filter((x) => x.source === g.id)
    if (ins.length !== 1 || outs.length !== 1) continue
    sequences = sequences.filter((x) => x !== outs[0]).map((x) => (x === ins[0] ? { ...x, target: outs[0].target } : x))
    gateways = gateways.filter((y) => y !== g)
  }
  return { ...d, gateways, sequences }
}

// mined definition (flattened) → process-gpt generation contract (elements[] + forms + agents + skills)
export function buildContract(s) {
  const d = dropSkips(reviewRule(s.definition))
  const PID = s.process_id
  const formId = (a) => `${PID}_${(stepOf(a.name)?.key || a.id)}_form`
  const roles = new Map()
  const elements = []
  const forms = []
  const agentSkills = new Map()
  const firstHumanRole = d.activities.map((a) => stepOf(a.name)).find((c) => c?.kind === 'human')?.role || d.roles[0]?.name || L('담당자', 'Assignee')
  for (const e of d.events) elements.push({ elementType: 'Event', id: e.id, name: e.type === 'startEvent' ? L('요청 메일 도착', 'Request mail arrives') : L('회신 완료', 'Reply sent'), role: firstHumanRole, type: e.type === 'startEvent' ? 'StartEvent' : 'EndEvent' })
  for (const a of d.activities) {
    const c = stepOf(a.name)
    const role = c?.role || a.role || L('담당자', 'Assignee')
    const agent = c?.kind === 'agent' ? agentsIn()[c.agent] : (a.agent ? { id: a.agent } : null)
    if (!roles.has(role)) roles.set(role, { name: role, endpoint: agent?.id || '', default: agent?.id || '', resolutionRule: agent ? '' : L('프로세스 마이닝: 인계 기록에서 이 일을 맡아 온 역할', 'Process mining: the role that has done this work in the handover records'), origin: agent ? 'used' : 'created' })
    const skills = [...new Set([...(c ? [c.skill] : []), ...(a.skills || [])])]
    const fields = c?.fields || [{ key: 'result', text: L(`${a.name} 결과`, `${a.name} result`), type: 'textarea' }]
    const fid = formId(a)
    forms.push({ activity_id: a.id, form_id: fid, html: html(fid, a.name, fields) })
    const base = { elementType: 'Activity', id: a.id, name: a.name, role, type: 'UserActivity', tool: `formHandler:${fid}`, duration: 1, inputData: [], outputData: [a.name],
      checkpoints: [], skills, description: c?.description || a.description || '', instruction: c?.instruction || '' }
    if (agent) {
      elements.push({ ...base, agent: agent.id, agentMode: 'complete', orchestration: c ? ORCH : (a.orchestration || 'deepagents'), duration: 1 })
      agentSkills.set(agent.id, [...new Set([...(agentSkills.get(agent.id) || []), ...skills])])
    } else elements.push({ ...base, agentMode: 'none' })
  }
  // process-gpt's BPMN generator (bpmn_xml_generator.createGateway) draws elements[] gateways from
  // gateWayType only — without it every gateway, parallel ones too, is drawn as exclusive (X)
  for (const g of d.gateways) {
    const parallel = /parallel/i.test(g.type || '')
    elements.push({ elementType: 'Gateway', id: g.id, name: g.name || '', type: parallel ? 'ParallelGateway' : 'ExclusiveGateway', gateWayType: parallel ? 'bpmn:parallelGateway' : 'bpmn:exclusiveGateway' })
  }
  // (properties carry the miner's default flow and priority: exactly one branch of an exclusive gateway is taken)
  for (const x of d.sequences) elements.push({ elementType: 'Sequence', id: x.id, source: x.source, target: x.target, condition: x.condition || '', ...(x.name || x.condition ? { name: x.name || x.condition } : {}), ...(x.properties && x.properties !== '{}' ? { properties: x.properties } : {}) })
  const cases = s.pattern.case_count
  return {
    type: 'process-definition-result',
    processDefinition: {
      processDefinitionId: PID, processDefinitionName: s.name, isHorizontal: true, data: [],
      description: L(`${s.summary ? `${s.summary} ` : ''}프로세스 마이닝이 인계 기록 ${s.pattern.event_count}건(케이스 ${cases}건)에서 찾은 흐름을 정식 등록했어요.`,
        `${s.summary ? `${s.summary} ` : ''}Registered from the flow process mining found in ${s.pattern.event_count} handover records (${cases} cases).`),
      roles: [...roles.values()], elements,
    },
    forms,
    agents: [...agentSkills].map(([id, skills]) => ({ id, skills })),
    skills: [...new Set([...agentSkills.values()].flat())],
  }
}

// the agents' user rows, named in the language of the work (same ids in both languages)
export async function ensureAgents() {
  for (const a of Object.values(agentsIn())) {
    await q(`insert into users (id, username, email, tenant_id, is_agent, is_admin, is_draft, agent_type, alias, goal, persona, permission_ids)
             values ($1,$2,$3,$4,true,false,false,'agent',$5,$6,$7,'{}')
             on conflict (id, tenant_id) do update set username=$2, alias=$5, goal=$6, persona=$7`,
    [a.id, a.name, `${a.alias}@${T()}`, T(), a.alias, a.goal, a.persona])
  }
}

export async function register(me, id) {
  if (!(await isAdmin(me))) throw err(403, L('관리자만 정식 등록할 수 있어요.', 'Only an administrator can register a process.'))
  const [s] = await q('select * from pro_mining_suggestions where id=$1 and tenant_id=$2', [id, T()])
  if (!s) throw err(404, L('추천을 찾지 못했어요.', "I couldn't find that recommendation."))
  if (s.status === 'registered') return get(id)
  // the process is written in the language its flow was recorded in (English steps → English process)
  return withLang(patternLang(s.pattern), () => registerIn(me, id, s))
}
async function registerIn(me, id, s) {
  await ensureAgents()
  // the evidence may have grown since the recommendation: draw the model again from the cases as they are now
  const again = await miner('/discover', { tenant_id: T(), process_id: s.process_id, name: s.name, case_ids: s.pattern.case_ids, lang: lang() }).catch((e) => { console.warn('[mining] rediscover', e.message); return null })
  if (again?.definition) { s.definition = again.definition; await q('update pro_mining_suggestions set definition=$2 where id=$1', [id, again.definition]) }
  const contract = buildContract(s)
  const saved = await saveGenerated(contract)
  const defId = saved.proc_def_id || s.process_id
  // save_contract keeps activities' own fields, but make sure each step carries its skills and runner
  const byId = Object.fromEntries(contract.processDefinition.elements.filter((e) => e.elementType === 'Activity').map((e) => [e.id, e]))
  const [row] = await q('select definition from proc_def where id=$1 and tenant_id=$2', [defId, T()])
  if (row?.definition?.activities) {
    const acts = row.definition.activities.map((a) => ({ ...a, skills: byId[a.id]?.skills || a.skills || [], ...(byId[a.id]?.agent ? { orchestration: byId[a.id].orchestration, agentMode: 'complete', agent: byId[a.id].agent } : {}) }))
    await q(`update proc_def set definition = jsonb_set(definition, '{activities}', $3::jsonb) where id=$1 and tenant_id=$2`, [defId, T(), JSON.stringify(acts)])
  }
  // people roles go to whoever did that step before (when they are on the team)
  for (const r of s.definition.roles || []) {
    const c = Object.values(STEPS).find((x) => x.role === r.name) || Object.values(STEPS_EN).find((x) => x.role === r.name) || null
    const roleName = c?.role || r.name
    if (!r.endpoint || c?.kind === 'agent') continue
    const [m] = await q('select 1 from pro_team_members where tenant_id=$1 and user_id::text=$2', [T(), String(r.endpoint)])
    if (m) await q(`insert into pro_role_assignments(tenant_id,proc_def_id,role,user_id,updated_by) values ($1,$2,$3,$4,$5)
                    on conflict (tenant_id,proc_def_id,role) do update set user_id=excluded.user_id, updated_by=excluded.updated_by, updated_at=now()`,
    [T(), defId.toLowerCase(), roleName, r.endpoint, me.id])
  }
  if (s.pr_id) await q(`update resource_pull_requests set status='MERGED', merged_at=now(), reviewer_id=$2, updated_at=now() where id=$1`, [s.pr_id, me.id]).catch((e) => console.warn('[mining] pr', e.message))
  await q(`update pro_mining_suggestions set status='registered', proc_def_id=$2, saved=$3, decided_by=$4, decided_at=now(), updated_at=now() where id=$1`,
    [id, defId, { ...saved, forms: contract.forms.length }, me.id])
  await q(`update notifications set is_checked=true where tenant_id=$1 and url=$2`, [T(), `/mining/${id}`])
  return get(id)
}

export async function hold(me, id) {
  if (!(await isAdmin(me))) throw err(403, L('관리자만 정할 수 있어요.', 'Only an administrator can decide this.'))
  const [s] = await q(`update pro_mining_suggestions set status='held', decided_by=$2, decided_at=now(), updated_at=now() where id=$1 and tenant_id=$3 and status='suggested' returning *`, [id, me.id, T()])
  if (!s) throw err(409, L('이미 정한 추천이에요.', 'This recommendation has already been decided.'))
  if (s.pr_id) await q(`update resource_pull_requests set status='CLOSED', updated_at=now() where id=$1`, [s.pr_id]).catch(() => {})
  await q(`update notifications set is_checked=true where tenant_id=$1 and url=$2`, [T(), `/mining/${id}`])
  return get(id)
}

// ---------- 다음 메일: 등록된 프로세스로 ----------
export function matches(m, mail, d) {
  const formats = new Set((d?.items || []).map((i) => i.format))
  const said = `${mail.subject} ${mail.text}`
  // (English mail too: "floor plan", "store design proposal")
  if (/평면도|설계도|도면|배치도|인테리어|설계\s*제안/.test(said) || /floor\s*plan|layout|interior|design\s+proposal|drawing/i.test(said)) formats.add('dxf')
  // a Word proposal answers what a 한글 one does
  if (formats.has('docx') && (m?.formats || []).includes('hwpx') && !(m?.formats || []).includes('docx')) formats.add('hwpx')
  if (formats.has('hwpx') && (m?.formats || []).includes('docx') && !(m?.formats || []).includes('hwpx')) formats.add('docx')
  const hit = (m?.formats || []).filter((f) => formats.has(f)).length
  // English keywords are matched without regard to case ("Proposal" in a subject)
  const low = said.toLowerCase()
  const words = (m?.keywords || []).filter((k) => k && (said.includes(k) || (!/[가-힣]/.test(k) && low.includes(String(k).toLowerCase())))).length
  return (m?.formats?.length >= 2 && hit >= 2) || words >= 2
}

// called by lib/mail.js for a mail asking for documents: true when a registered process took it
// (in the owner's language: this request's English, else their saved language)
export async function routeMail(userId, mail, d) {
  return withLang(isEn() ? 'en' : await langOf(userId), () => routeMailIn(userId, mail, d))
}
async function routeMailIn(userId, mail, d) {
  const regs = await q(`select * from pro_mining_suggestions where tenant_id=$1 and status='registered' and proc_def_id is not null order by decided_at desc`, [T()])
  // English mode: only a process registered in English takes the mail — its step, form and agent texts
  // are written in its language, so a Korean-named one would put Korean on an English person's screens;
  // without an English one the mail gets the ad-hoc drafts, in English
  // (Korean mode: as before, any registered process)
  const sameLang = (r) => !isEn() || !/[가-힣]/.test(String(r.name || ''))
  const s = regs.find((r) => sameLang(r) && matches(r.match, mail, d))
  if (!s) return false
  const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
  if (!p?.email) return false
  const { startProcess } = await import('../engine.js')
  const customer = d?.customer || (String(mail.from || '').split('<')[0].trim()) || L('고객', 'Customer')
  const values = { customer, sender: mail.from || '', subject: mail.subject || '', body: String(mail.text || '').slice(0, 3000), requested: (d?.items || []).map((i) => i.kind).join(L('·', ', ')) }
  const t = await mainThread(userId)
  await addMessage(userId, t.id, 'system', 'divider', { text: L(`메일 · ${customer} ${values.requested || '요청'}`, `Mail · ${customer} ${values.requested || 'request'}`) })
  const { instId, instName } = await startProcess({ me: { id: userId, email: p.email }, defId: s.proc_def_id, values })
  await q(`insert into pro_mining_runs (proc_inst_id, tenant_id, suggestion_id, user_id, mail) values ($1,$2,$3,$4,$5) on conflict do nothing`,
    [instId, T(), s.id, userId, { id: mail.id, from: mail.from, subject: mail.subject, text: String(mail.text || '').slice(0, 3000), customer, items: d?.items || [] }])
  const { getDefinition } = await import('../processes.js')
  await addMessage(userId, t.id, 'agent', 'text', { text: routeNote(customer, s.name, await getDefinition(s.proc_def_id).catch(() => null)), mail: { from: mail.from, subject: mail.subject } })
  await addMessage(userId, t.id, 'agent', 'process', { defId: s.proc_def_id, name: s.name, state: 'started', instId, instName })
  console.log(`[mining] mail ${mail.id} → ${s.proc_def_id} ${instId}`)
  return { instId, suggestion: s.id }
}

// What the started process will do next, read from its own definition: the steps after the first one
// (the start form, filled from the mail), agent steps by the agent's role, people's steps by their role.
// "견적서 작성은 견적 에이전트가, 재무 검토는 재무 담당이, 고객 회신은 영업 담당이 맡아요." A process without a floor plan
// step never mentions one.
export function routeNote(customer, name, def) {
  const acts = (def?.steps || []).filter((x) => x.kind === 'human' || x.kind === 'agent')
  const rest = acts.slice(1)
  const head = L(`${customer} 메일은 정식 등록된 '${name}' 프로세스로 처리할게요.`, `I'll handle the ${customer} mail with the registered '${name}' process.`)
  if (!rest.length) return head
  // consecutive steps of one role read as one clause ("재무 검토·고객 회신은 재무 담당이")
  const groups = []
  for (const x of rest) {
    const g = groups[groups.length - 1]
    const role = x.role || (x.kind === 'agent' ? L('에이전트', 'an agent') : L('담당자', 'the assignee'))
    if (g && g.role === role && g.kind === x.kind) g.names.push(x.name)
    else groups.push({ role, kind: x.kind, names: [x.name] })
  }
  const ko = groups.map((g) => `${josa(g.names.join('·'), '은/는')} ${josa(g.role, '이/가')}`).join(', ')
  const en = groups.map((g) => `${g.names.join(', ')} by ${g.role}`).join(', ')
  return `${head} ${L(`${ko} 맡아요.`, `Next: ${en}.`)}`
}

export const newId = () => crypto.randomUUID()
