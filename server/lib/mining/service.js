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
//   - the admin's decisions are the boundary: every recommendation the admin has seen is sent along
//     (boundariesOf) and the miner keeps one group per boundary, so two of them never merge
//   - a group is an existing recommendation when it comes back under that recommendation's key
//     (sameSuggestion); only a group with no key of its own becomes a new recommendation
//   - a case the miner could not place (no category, or none of the group's required steps) comes back
//     in `unclassified`; the admin is asked which work it is (category_ask on the case)
//
// What the admin confirms holds (2026-11-10, boundary.js · talk.js):
//   - a step's frequency is only the draft of 필수/옵션; the admin confirms it (confirmed) and the counts
//     never change it again. The confirmed required steps are what the miner matches new cases against
//   - every recommendation the admin has seen — 추천 too, not only 정식 등록·보류 — is a boundary with its
//     own cases pinned. New cases of the same work come back from the miner apart (new_case_ids) and wait
//     as the recommendation's proposal; nothing about a recommendation changes until the admin says so
//   - the admin moves a case to another recommendation, or says it is not this one (excluded); the case's
//     category becomes the admin's, and admin-set categories are the examples the next judgment follows
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
import { boundaryOf, boundaryOrder, keepFound, requiredIn, sameCases, stepsView } from './boundary.js'
import { applyStepRules, forSave, gatewayLanes, ruleOf, stepKinds } from './shape.js'
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
- 범주는 되도록 적게 쓰세요. 한 조직이 하는 일의 종류는 보통 두세 가지입니다.
- examples 는 관리자가 직접 정한 업무와 범주입니다. 같은 일을 요청한 업무에는 그 범주를 글자 그대로 쓰세요.`
const CATEGORY_EN = `Below are pieces of work, each answering a customer's request mail. Name the kind of work each one is.
Answer with JSON {"categories": {"<id>": "<category>"}}, one for every piece.
- A category is an English noun phrase of at most 24 characters, e.g. "Event quote", "Store design".
- A category is the kind of work. Do not split by the name of the event (year-end party, workshop, book talk) or by the customer — those are all one "Event quote".
- If \`known\` already holds the same kind of work, reuse that category exactly.
- Go by what the customer asked for, not by the step names. Who reviewed it does not change the category.
- Use as few categories as possible. An organization usually does two or three kinds of work.
- \`examples\` are pieces of work an administrator categorized by hand. Work asking for the same thing gets that category, exactly.`

// All the pending cases are judged together, in one call: judged one at a time, the same work came
// back as 워크숍 견적, 송별회 견적, 시상식 견적 … — the event's name, not the kind of work — and the
// groups split for the same reason the step names used to split them.
async function categoriesOf(cases, known, cl, examples = []) {
  return withLang(cl, async () => {
    try {
      const r = await chatJson(L(CATEGORY, CATEGORY_EN), JSON.stringify({ known, examples, cases }))
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
  // what the admin has said about earlier work (picked a category, moved a case): the next judgment follows it
  const examples = await adminExamples()
  // in batches, so one call sees enough of the work at once to use the same few categories
  for (let i = 0; i < pending.length; i += 25) {
    const batch = pending.slice(i, i + 25)
    const got = await categoriesOf(batch, known, cl, examples)
    for (const p of batch) {
      const category = got[p.id]
      if (!category) continue
      await q(`update pro_mining_cases set category=$2, category_by='ai' where case_id=$1 and category is null`, [p.id, category])
      if (!known.includes(category)) known.push(category)
    }
  }
}

export async function adminExamples(limit = 30) {
  return (await q(`select subject, category from pro_mining_cases where tenant_id=$1 and category_by='admin'
                   and category is not null and coalesce(subject,'') <> '' order by created_at desc limit $2`, [T(), limit]))
    .map((r) => ({ subject: r.subject, category: r.category }))
}

// The boundaries: every recommendation the admin has seen — decided ones first, in the order they were
// decided, then the open ones, oldest first. Each carries its required steps (the admin's word over the
// draft), the cases it rests on (pinned there) and the cases the admin took out.
async function boundariesOf() {
  const rows = boundaryOrder(await q(`select pattern_key, pattern, status, confirmed, excluded, decided_at, created_at, proc_def_id, definition
                                      from pro_mining_suggestions where tenant_id=$1`, [T()]))
  const out = []
  for (const r of rows) {
    const ids = r.pattern?.case_ids || []
    // (a row from before categories: the category most of its cases have)
    const [top] = !r.pattern?.category && ids.length
      ? await q(`select category from pro_mining_cases where tenant_id=$1 and case_id = any($2) and category is not null
                 group by category order by count(*) desc, category limit 1`, [T(), ids])
      : []
    // required = what the process definition says (every path passes it); new cases are matched against it
    out.push(boundaryOf(r, top?.category || '', requiredIn(await definitionOf(r))))
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
  const rows = await q('select * from pro_mining_suggestions where tenant_id=$1', [T()])
  const { patterns, unclassified: unplaced } = await miner('/patterns', {
    tenant_id: T(), min_cases: Number(process.env.PRO_MINING_MIN_CASES || 4), categories, decided: await boundariesOf(),
  })
  await markUnclassified(unplaced)
  const byKey = new Map(rows.map((r) => [r.pattern_key, r]))
  const made = []
  for (const p of patterns) {
    // A recommendation the admin has already seen (any status): its cases and required steps stay as the
    // admin has them. The miner's view of those same cases is refreshed (a case's late steps, the counts);
    // new cases of the same work wait as its proposal. (The miner pins each one's cases there, so no case
    // shows under two recommendations, and nothing is withdrawn behind the admin's back.)
    const have = byKey.get(p.decided_key || p.key)
    if (have) { await keepExisting(have, p); continue }
    if (!p.case_ids?.length) continue
    // only work pgpt-pro recorded (one case = one mail); other tenants' demos are not ours to suggest
    const cases = await q('select * from pro_mining_cases where tenant_id=$1 and case_id = any($2) order by created_at', [T(), p.case_ids])
    if (cases.length * 2 < p.case_ids.length) continue
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
    // (a new recommendation's 필수/옵션 is the draft from the counts; the admin confirms it in the talk)
    const mined = await miner('/discover', { tenant_id: T(), process_id: p.process_id, name: named.name, case_ids: p.case_ids, lang: patternLang(p) })
    const formats = [...new Set(p.steps.flatMap((s) => s.tools.map((t) => TOOL_FORMAT[t]).filter(Boolean)))]
    const pattern = { ...p }
    delete pattern.new_case_ids
    delete pattern.proposed
    const [s] = await q(`insert into pro_mining_suggestions (tenant_id, pattern_key, process_id, name, summary, pattern, definition, pr_id, version_uuid, match)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id, pattern_key) do nothing returning *`, [
      T(), p.key, p.process_id, named.name, named.summary, pattern, mined.definition, mined.pr?.pr_id || null, mined.pr?.version_uuid || null,
      { formats, keywords: named.keywords }])
    if (!s) continue
    made.push(s)
    await notifyAdmins(s)
  }
  return made
}

// One recommendation the admin has seen, after a search: same cases, same required steps; the counts
// over those cases refreshed; new cases kept as the proposal (the admin is told when it is new or grew).
async function keepExisting(row, p) {
  const { pattern, proposal } = keepFound(row, p, requiredIn(await definitionOf(row)))
  await q('update pro_mining_suggestions set pattern=$2, proposal=$3, updated_at=now() where id=$1', [row.id, pattern, proposal])
  if (proposal && !sameCases(proposal, row.proposal) && proposal.case_count > (row.proposal?.case_count || 0)) await notifyProposal({ ...row, pattern }, proposal)
}

// the recommendation a found group already is: the same key (the miner hands each boundary back under
// its own key; a new group's key carries its category, so two kinds of work never share one)
export async function sameSuggestion(p) {
  const [byKey] = await q('select id, status from pro_mining_suggestions where tenant_id=$1 and pattern_key=$2', [T(), p.decided_key || p.key])
  return byKey || null
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

// new cases of the same work for a recommendation the admin has seen: they decide whether they go in
async function notifyProposal(s, prop) {
  const admins = await q(`select u.id::text as id from users u join pro_team_members m on m.user_id=u.id and m.tenant_id=u.tenant_id
                          where u.tenant_id=$1 and u.is_admin and not coalesce(u.is_agent,false)`, [T()])
  await q(`update notifications set is_checked=true where tenant_id=$1 and url=$2 and type='mining' and not coalesce(is_checked,false)`, [T(), `/mining/${s.id}`])
  for (const a of admins) {
    const en = (await langOf(a.id)) === 'en'
    await q(`insert into notifications (id, user_id, title, type, description, url, tenant_id) values (gen_random_uuid(),$1,$2,'mining',$3,$4,$5)`,
      [a.id, en ? `New cases for ${s.name}` : `${s.name}에 같은 업무의 새 사례가 있어요`,
        en ? `${prop.case_count} new case(s) look like the same work. The process stays as it is until you decide whether they go in.`
          : `새 사례 ${prop.case_count}건이 같은 업무로 보여요. 넣을지 정하기 전에는 프로세스가 바뀌지 않아요.`, `/mining/${s.id}`, T()])
    emit(a.id, 'notifications', {})
    emit(a.id, 'mining', { id: s.id })
  }
}

// ---------- 보기 ----------
export async function list() {
  return q(`select id, name, summary, status, proc_def_id, pattern->'case_count' as case_count, pattern->'main_variant' as steps,
                   pattern->>'category' as category, proposal->'case_count' as proposal_count, created_at, decided_at
            from pro_mining_suggestions where tenant_id=$1 order by created_at desc limit 20`, [T()])
}

// the cases of a recommendation (or of its proposal) as the admin reads them: who asked, what, the
// steps it went through, its category and who set it, and the required steps it skipped
async function casesOf(ids, required = []) {
  if (!ids?.length) return []
  const cases = await q(`select case_id, customer, subject, demo, category, category_by, created_at from pro_mining_cases
                         where tenant_id=$1 and case_id = any($2) order by created_at`, [T(), ids])
  const evs = await q(`select case_id, norm_activity_label as activity, to_user_name as who, to_is_agent as agent, occurred_at, artifact_refs
                       from handover_events where tenant_id=$1 and case_id = any($2) order by occurred_at`, [T(), ids])
  for (const c of cases) {
    const mine = evs.filter((e) => e.case_id === c.case_id)
    c.steps = mine.map((e) => ({ activity: e.activity, who: e.who, agent: e.agent, at: e.occurred_at, files: (e.artifact_refs || []).map((r) => r.name).filter(Boolean) }))
    c.minutes = mine.length > 1 ? Math.round((new Date(mine.at(-1).occurred_at) - new Date(mine[0].occurred_at)) / 60000) : 0
    const went = new Set(mine.map((e) => e.activity))
    c.missing = required.filter((a) => !went.has(a))
  }
  return cases
}

export async function get(id) {
  const [s] = await q('select * from pro_mining_suggestions where id=$1 and tenant_id=$2', [id, T()])
  if (!s) return null
  // 필수·옵션 per step: the draft from the counts, the admin's word over it (boundary.js)
  // 필수·옵션 is what the process definition says (BPMN: a way around the task or not); the counts are evidence
  const def = await definitionOf(s)
  const decided = stepsView(s.pattern, s.confirmed || {}, def)
  const required = decided.filter((x) => x.kind === 'required').map((x) => x.activity)
  const cases = await casesOf(s.pattern.case_ids, required)
  const byAct = Object.fromEntries(decided.map((x) => [x.activity, x]))
  const steps = s.pattern.steps.map((x) => ({ ...x, kind: x.by_agent * 2 >= x.total ? 'agent' : 'human', catalog: stepOf(x.activity), decided: byAct[x.activity] || null }))
  const proposal = s.proposal ? { ...s.proposal, cases: await casesOf(s.proposal.case_ids, required) } : null
  // where a case can be moved to: the other recommendations; and cases in none of them
  const others = await q(`select id, name, status, pattern->>'category' as category from pro_mining_suggestions
                          where tenant_id=$1 and id<>$2 order by created_at`, [T(), id])
  const unplaced = await unplacedCases()
  const pr = s.pr_id ? (await q('select id, title, status, branch_name, created_at, merged_at from resource_pull_requests where id=$1', [s.pr_id]))[0] : null
  const runs = s.proc_def_id ? await q(`select r.proc_inst_id, r.mail, r.created_at, i.status, i.proc_inst_name from pro_mining_runs r
                                         left join bpm_proc_inst i on i.proc_inst_id=r.proc_inst_id where r.suggestion_id=$1 order by r.created_at desc`, [s.id]) : []
  return { ...s, steps, decided, required, cases, proposal, others, unplaced, pr, runs }
}

// ---------- 관리자 확정 (대화로: talk.js) ----------
async function own(me, id) {
  if (!(await isAdmin(me))) throw err(403, L('관리자만 바꿀 수 있어요.', 'Only an administrator can change this.'))
  const [s] = await q('select * from pro_mining_suggestions where id=$1 and tenant_id=$2', [id, T()])
  if (!s) throw err(404, L('추천을 찾지 못했어요.', "I couldn't find that recommendation."))
  return s
}

// The definition a recommendation stands for: a registered one's saved definition (what the engine runs);
// otherwise the drawn one with the admin's word applied — what 정식 등록 will save (buildContract).
export async function definitionOf(s) {
  if (s.status === 'registered' && s.proc_def_id) {
    const [row] = await q('select definition from proc_def where lower(id)=lower($1) and tenant_id=$2', [s.proc_def_id, T()])
    if (row?.definition?.activities?.length) return row.definition
  }
  return s.definition ? applyStepRules(dropSkips(reviewRule(s.definition)), s.confirmed || {}).def : null
}

// a changed definition saved the way Lite saves a process (lib/generated.js → process-gpt save_contract +
// BPMN generator), with a new proc_def_version as process-gpt's own save button leaves (the engine takes it
// from the next instance) — the same path 「개선안 적용」 uses (lib/improve/apply.js)
async function saveVersion(me, defId, def, message) {
  def = forSave(def)
  const [d] = await q('select id, name, description from proc_def where lower(id)=lower($1) and tenant_id=$2', [defId, T()])
  if (!d) throw err(404, L('등록된 프로세스를 찾지 못했어요.', "I couldn't find the registered process."))
  const vs = await q(`select version, arcv_id from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2 and not coalesce(is_draft,false) order by "timeStamp" asc nulls first`, [d.id, T()])
  const version = `${Math.max(0, ...vs.map((v) => parseInt(String(v.version), 10) || 0)) + 1}.0`
  const forms = await q('select id, activity_id, html from form_def where lower(proc_def_id)=lower($1) and tenant_id=$2', [d.id, T()])
  await saveGenerated({
    type: 'process-definition-result',
    processDefinition: { ...def, processDefinitionId: d.id, processDefinitionName: d.name, description: def.description || d.description || '' },
    forms: forms.map((f) => ({ activity_id: f.activity_id, form_id: f.id, html: f.html })), agents: [], skills: [],
  })
  const [row] = await q('select bpmn, definition from proc_def where id=$1 and tenant_id=$2', [d.id, T()])
  await q(`insert into proc_def_version (arcv_id, proc_def_id, version, version_tag, "timeStamp", snapshot, definition, diff, message, tenant_id, parent_version, is_draft, owner)
           values ($1,$2,$3,'major',now(),$4,$5,$6,$7,$8,$9,false,$10)`,
  [`${d.id}_${version}`, d.id, version, row?.bpmn || null, row?.definition || def, JSON.stringify({ mining: message }), message, T(), vs.at(-1)?.arcv_id || null, String(me.id)])
  return { version, definition: row?.definition || def }
}

const NOTE = {
  not_in_definition: (a) => L(`'${a}' 단계는 프로세스 정의에 없어요. 정의에 있는 단계만 필수·옵션을 정할 수 있어요.`, `The process definition has no '${a}' step. Only steps in the definition can be made required or optional.`),
  many_outgoing: (a) => L(`'${a}' 뒤 흐름이 여러 갈래라 건너뛰는 분기를 넣을 수 없어요.`, `'${a}' is followed by more than one flow, so a skip branch can't be added.`),
  still_bypassed: (a) => L(`'${a}' 을(를) 돌아가는 다른 길이 남아 있어 필수로 만들지 못했어요.`, `Another path still goes around '${a}', so it couldn't be made required.`),
}

// The admin confirms a step 필수 or 옵션 — in the BPMN sense. 옵션 needs when it is skipped (skip_when): the
// definition gets an exclusive gateway before the task, the skip flow carries that condition and the flow
// into the task is the default. 필수 takes every way around it away. A registered process is saved as a
// new version at once (the next mail runs it); a recommendation keeps the word and 정식 등록 applies it.
// The counts never change it again, and the required steps go to the miner as the boundary.
export async function setStep(me, id, activity, kind, skipWhen = '') {
  const s = await own(me, id)
  const rule = ruleOf(kind === 'optional' ? { kind, skip_when: skipWhen } : kind)
  if (!rule) throw err(400, kind === 'optional' ? L('언제 건너뛰는지(조건)를 알려 주세요.', 'Tell me when it is skipped (the condition).') : L('필수나 옵션으로 정해 주세요.', 'Choose required or optional.'))
  const before = await definitionOf(s)
  const step = stepsView(s.pattern, s.confirmed || {}, before).find((x) => x.activity === activity)
  if (!step) throw err(404, L(`'${activity}' 단계가 이 추천에 없어요.`, `This recommendation has no '${activity}' step.`))
  const value = rule.kind === 'required' ? 'required' : rule
  let saved = null
  if (s.status === 'registered' && s.proc_def_id) {
    const { def, notes } = applyStepRules(before, { [activity]: value })
    if (notes.length) throw err(409, NOTE[notes[0].reason](activity))
    saved = await saveVersion(me, s.proc_def_id, def, rule.kind === 'required'
      ? L(`[프로세스 마이닝] '${activity}' 필수 — 건너뛰는 길 없음`, `[Process mining] '${activity}' required — no way around it`)
      : L(`[프로세스 마이닝] '${activity}' 옵션 — ${rule.skip_when} 건너뜀`, `[Process mining] '${activity}' optional — skipped ${rule.skip_when}`))
  } else if (before) {
    const { notes } = applyStepRules(before, { [activity]: value })
    if (notes.length) throw err(409, NOTE[notes[0].reason](activity))
  }
  await q('update pro_mining_suggestions set confirmed=$2, updated_at=now() where id=$1', [id, { ...(s.confirmed || {}), [activity]: value }])
  const after = stepKinds(saved?.definition || applyStepRules(before || {}, { [activity]: value }).def)[activity]
  return { activity, kind: after?.kind || rule.kind, skip_when: after?.skip_when || rule.skip_when || '', was: step.kind, cases: step.cases, total: step.total, version: saved?.version || null, registered: s.status === 'registered' }
}

// the admin says which recommendation a case belongs to (toId), or only which work it is (category) and that
// it is not the recommendation it sits in now. Wherever the case was — another recommendation's evidence
// or proposal, or none — it leaves there for good (excluded), joins toId's evidence, and takes that
// recommendation's category as the admin's: the example the next judgment follows.
export async function moveCase(me, caseId, { toId = null, category = '' } = {}) {
  if (!(await isAdmin(me))) throw err(403, L('관리자만 바꿀 수 있어요.', 'Only an administrator can change this.'))
  const [c] = await q('select case_id, subject, category from pro_mining_cases where tenant_id=$1 and case_id=$2', [T(), caseId])
  if (!c) throw err(404, L('사례를 찾지 못했어요.', "I couldn't find that case."))
  const to = toId ? await own(me, toId) : null
  const cat = String(to?.pattern?.category || category || '').trim().slice(0, 40)
  if (!to && !cat) throw err(400, L('옮길 추천이나 업무 범주를 알려 주세요.', 'Tell me which recommendation or kind of work it is.'))
  const without = (xs) => (xs || []).filter((x) => x !== caseId)
  const prop = (p) => { const ids = without(p?.case_ids); return ids.length ? { ...p, case_ids: ids, case_count: ids.length } : null }
  const rows = await q(`select * from pro_mining_suggestions where tenant_id=$1 and (pattern->'case_ids' ? $2 or proposal->'case_ids' ? $2)`, [T(), caseId])
  const from = rows.find((r) => r.id !== to?.id && (r.pattern?.case_ids || []).includes(caseId)) || null
  if (to && (to.pattern.case_ids || []).includes(caseId)) throw err(400, L('이미 이 추천의 사례예요.', 'That case is already in this recommendation.'))
  for (const r of rows) {
    if (r.id === to?.id) continue
    const ids = without(r.pattern?.case_ids)
    await q('update pro_mining_suggestions set pattern=$2, excluded=$3, proposal=$4, updated_at=now() where id=$1',
      [r.id, { ...r.pattern, case_ids: ids, case_count: ids.length }, JSON.stringify([...new Set([...(r.excluded || []), caseId])]), prop(r.proposal)])
  }
  if (to) {
    const ids = [...new Set([...(to.pattern.case_ids || []), caseId])]
    await q('update pro_mining_suggestions set pattern=$2, excluded=$3, proposal=$4, updated_at=now() where id=$1',
      [to.id, { ...to.pattern, case_ids: ids, case_count: ids.length }, JSON.stringify(without(to.excluded)), prop(to.proposal)])
  }
  if (cat) await q(`update pro_mining_cases set category=$3, category_by='admin', category_ask=null where tenant_id=$1 and case_id=$2`, [T(), caseId, cat])
  return { case_id: caseId, subject: c.subject, from: from?.name || null, to: to?.name || null, category: cat || c.category }
}

// ended cases that sit in no recommendation (too few of their kind yet, or taken out by the admin):
// the admin may still say where they belong
export async function unplacedCases(limit = 20) {
  return q(`select c.case_id, c.customer, c.subject, c.category, c.category_by, c.created_at from pro_mining_cases c
            where c.tenant_id=$1 and c.category is not null
              and not exists (select 1 from pro_mining_suggestions s where s.tenant_id=c.tenant_id
                              and (s.pattern->'case_ids' ? c.case_id or s.proposal->'case_ids' ? c.case_id))
            order by c.created_at desc limit $2`, [T(), limit])
}

// the admin's answer to a proposal: the new cases go in (the evidence grows; an undecided recommendation's
// model is drawn again from all its cases), or they stay out of this recommendation for good
export async function decideProposal(me, id, accept) {
  const s = await own(me, id)
  const prop = s.proposal
  if (!prop?.case_ids?.length) throw err(409, L('반영할 제안이 없어요.', 'There is no proposal to decide.'))
  if (accept) {
    const ids = [...new Set([...(s.pattern.case_ids || []), ...prop.case_ids])]
    const p = { ...s.pattern, case_ids: ids, case_count: ids.length }
    const again = s.status === 'suggested'
      ? await miner('/discover', { tenant_id: T(), process_id: s.process_id, name: s.name, case_ids: ids, lang: patternLang(p) }).catch(() => null) : null
    await q('update pro_mining_suggestions set pattern=$2, proposal=null, definition=coalesce($3, definition), updated_at=now() where id=$1', [id, p, again?.definition || null])
  } else {
    await q('update pro_mining_suggestions set proposal=null, excluded=$2, updated_at=now() where id=$1', [id, JSON.stringify([...new Set([...(s.excluded || []), ...prop.case_ids])])])
  }
  await q(`update notifications set is_checked=true where tenant_id=$1 and url=$2`, [T(), `/mining/${id}`])
  return { accepted: !!accept, case_count: prop.case_ids.length, name: s.name }
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
  // (the admin's 필수·옵션 go into the definition: an exclusive gateway with the skip condition — shape.js)
  const d = applyStepRules(dropSkips(reviewRule(s.definition)), s.confirmed || {}).def
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
  // (and in a lane: the generator lays out by role, a gateway with none is left in the corner — shape.js gatewayLanes)
  const lanes = gatewayLanes(d, (a) => stepOf(a.name)?.role || a.role || L('담당자', 'Assignee'))
  for (const g of d.gateways) {
    const parallel = /parallel/i.test(g.type || '')
    elements.push({ elementType: 'Gateway', id: g.id, name: g.name || '', role: g.role || lanes[g.id] || firstHumanRole, type: parallel ? 'ParallelGateway' : 'ExclusiveGateway', gateWayType: parallel ? 'bpmn:parallelGateway' : 'bpmn:exclusiveGateway' })
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
