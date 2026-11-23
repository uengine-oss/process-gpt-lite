// 팀 활동(spec pgpt-pro_team-activity): 사람마다 공유된 AI 작업의 요약 카드, 장·관리자의 조직도 보기, 비슷한 주제를 하는 사람.
//   재료는 대화 맥락(context_threads)마다 미리 만든 요약(pro_context_digests, lib/context/digest.js) — 여기서는 LLM 을 부르지 않는다.
//   카드·조직도·겹침·시간순 보기는 보는 사람이 그 맥락에 가진 깊이(visibility.depthOf, 요청마다 새로 판정)만큼만 조립한다:
//     제목 = 제목·한 줄 목적·작업 유형 횟수, 요약 = 요약 첫 문장·프롬프트 유형 이름·바꿔 쓴 한 줄, 원문 = 프롬프트 예시 문장·답.
//   비공개 맥락은 존재도 숨기고 관리자에게만 건수로 보인다. 등급을 좁히거나 허락을 회수하면 다음 조립부터 바로 빠진다.
//   비용은 사람 단위(pro_billing_usage)라 맥락별로 나눌 수 없다 — 본인·장·관리자에게만, 비공개 몫은 따로 세지 않는다.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { relation, personName, teamName, peopleInScope, peopleUnder, ledNodes } from './org.js'
import { depthOf, atLeast } from './visibility.js'
import { contextsFor, contextRows, grantsOf, depthFor, turnsOf, logView, ContextError } from './items.js'
import { WORK_KINDS, classifyKind, firstSentence, rebuildSoon } from './digest.js'
import { vectors, cosine } from './embed.js'
import { creditsOf } from '../plans/catalog.js'

export const SCOPES = ['team', 'department', 'company']
export const OVERLAP_MIN = 0.75          // 겹침: 보는 사람이 볼 수 있는 글만으로 잰 유사도(bge-m3)
export const NOW_DAYS = 7, WINDOW_DAYS = 30, OVERLAP_DAYS = 14
const DAY = 86400000
export const RUN_LABEL = { working: '실행 중', running: '실행 중', needs_input: '입력 기다림', queued: '차례 기다림' }
const RUN_KIND = { chat: 'AI 비서', mission: '정기 작업', browser: '브라우저 작업', process: '프로세스 AI 단계' }
const T = () => config.tenantId
const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[.!?。~]+$/, '')
const ms = (t) => (t ? new Date(t).getTime() : 0)
const iso = (t) => (t ? new Date(t).toISOString() : null)
const firstLine = (s, n = 160) => short(String(s || '').split(/\n/).map((l) => l.trim()).find(Boolean) || '', n)
const visible = (x) => x.depth && x.depth !== 'none'
export const activeAt = (c) => ms(c.updated_at)
// 턴 수: 라우터의 수(context_threads.turns 는 라우터가 다시 셀 때 줄기도 한다)와 요약이 센 요청 수 중 큰 쪽
export const turnsN = (c) => Math.max(Number(c.turns || 0), Object.values(c.kinds || {}).reduce((n, v) => n + Number(v || 0), 0))
const request = (c) => ({ conversationId: c.id, depth: 'content' })
const money = (s) => (s ? { usd: Math.round(Number(s.usd || 0) * 10000) / 10000, credits: Math.round(Number(s.credits || 0)) } : { usd: 0, credits: 0 })

// ── 조립(순수) ──────────────────────────────────────────────────────────
// 카드 주인이 보는 사람에게 어떤 사이인지(보는 사람 쪽에서 읽는 말)
export function relLabel(rel) {
  if (rel.self) return '본인'
  if (rel.lead) return rel.sameTeam ? '내 팀원' : '내 조직'
  if (rel.admin) return '관리자로 봄'
  if (rel.sameTeam) return '같은 팀'
  if (rel.sameDept) return '같은 부서'
  return '다른 팀'
}

/**
 * 한 사람의 카드. 모든 칸은 items 에 매겨진 깊이(보는 사람 기준)로만 채운다.
 * @param person {id, name, team}
 * @param rel    보는 사람과의 관계(org.relation 또는 「다른 사람 눈으로」의 가짜 관계)
 * @param items  주인의 대화 맥락 + depth(none 포함 — 관리자의 비공개 건수). summary·prompt_types 같은 원본 칸이 있어도 깊이가 허락할 때만 쓴다
 * @param runs   진행 중인 AI 작업 [{kind, title, detail, status, started_at, conv}] (conv = 관련 맥락, 없으면 null)
 * @param spend  {usd, credits} 최근 30일 환산 비용(사람 단위 — 본인·장·관리자에게만)
 * @param arts   산출물(파일 카드) [{name, ext, kind, url, at, conv}]
 */
export function assembleCard({ person, rel, items = [], runs = [], spend = null, arts = [], now = Date.now() }) {
  const vis = items.filter(visible)
  const recent = vis.filter((c) => activeAt(c) > now - WINDOW_DAYS * DAY)
  const open = !!(rel.self || rel.lead || rel.admin)
  // 지금 하는 일: 최근 7일 동안 움직인 맥락 세 개까지. 제목·목적은 제목 깊이부터, 한 줄(요약 첫 문장)은 요약 깊이부터
  const doing = vis.filter((c) => activeAt(c) > now - NOW_DAYS * DAY).sort((a, b) => activeAt(b) - activeAt(a)).slice(0, 3).map((c) => {
    const o = { conversationId: c.id, title: c.title, purpose: c.purpose || '', depth: c.depth, at: iso(c.updated_at) }
    if (atLeast(c.depth, 'summary') && c.summary) o.line = firstSentence(c.summary)
    if (!atLeast(c.depth, 'content')) o.request = request(c)
    return o
  })
  // 주로 하는 일: 제목 깊이 맥락도 횟수로 센다
  const kc = {}
  for (const c of recent) for (const [k, n] of Object.entries(c.kinds || {})) kc[k] = (kc[k] || 0) + Number(n || 0)
  const kinds = Object.entries(kc).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || WORK_KINDS.indexOf(a[0]) - WORK_KINDS.indexOf(b[0])).map(([name, count]) => ({ name, count }))
  // 자주 쓰는 프롬프트 유형: 이름·횟수는 요약 깊이부터, 예시 문장은 원문 깊이 맥락에서만
  const types = new Map()
  let unnamed = 0
  for (const c of recent) {
    if (!atLeast(c.depth, 'summary')) { unnamed += turnsN(c); continue }
    for (const t of c.prompt_types || []) {
      const e = types.get(t.name) || { name: t.name, count: 0, examples: [] }
      e.count += Number(t.count || 0)
      if (atLeast(c.depth, 'content')) for (const x of t.examples || []) if (e.examples.length < 2 && !e.examples.includes(x)) e.examples.push(x)
      types.set(t.name, e)
    }
  }
  const prompt_types = [...types.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko')).slice(0, 5)
    .map((t) => (t.examples.length ? t : { name: t.name, count: t.count }))
  // 진행 중인 AI 작업: 본인·장·관리자, 또는 관련 맥락을 요약 깊이 이상으로 보는 사람에게만 내용이 보인다(나머지는 건수)
  const byId = new Map(items.map((c) => [String(c.id), c]))
  const ctxOf = (r) => (r.conv ? byId.get(String(r.conv)) || null : null)
  const shown = runs.filter((r) => open || atLeast(ctxOf(r)?.depth, 'summary'))
  // 장·관리자에게도 비공개 맥락에서 도는 작업은 제목(= 맥락 제목) 없이 「비공개 맥락」으로만
  const running = { count: runs.length, hidden: runs.length - shown.length,
    items: shown.map((r) => {
      const c = ctxOf(r), closed = !!c && !visible(c)
      return { kind: r.kind, kind_label: RUN_KIND[r.kind] || 'AI 작업', title: closed ? '' : r.title || '', ...(closed ? { private: true } : {}), ...(r.detail && !closed ? { detail: r.detail } : {}),
        started_at: iso(r.started_at), status: r.status, status_label: RUN_LABEL[r.status] || r.status, ...(c && !closed ? { conversationId: c.id } : {}) }
    }) }
  // 최근 산출물: 그 맥락을 요약 깊이 이상으로 보는 사람에게 이름만, 원문 깊이면 링크까지. 맥락을 모르는 파일은 본인만
  const artifacts = arts.map((a) => ({ a, c: a.conv ? byId.get(String(a.conv)) : null }))
    .filter(({ c }) => (rel.self ? true : c && atLeast(c.depth, 'summary')))
    .slice(0, 3).map(({ a, c }) => ({ name: a.name, kind: a.kind, ext: a.ext || '', at: iso(a.at), ...(c ? { conversationId: c.id, context: c.title } : {}),
      ...(a.url && (rel.self || atLeast(c?.depth, 'content')) ? { url: a.url } : {}) }))
  const amount = { turns: recent.reduce((n, c) => n + turnsN(c), 0), contexts: recent.length }
  if (open) amount.cost = money(spend)
  const built = recent.map((c) => ms(c.built_at)).filter(Boolean)
  const card = { user: String(person.id), name: person.name, team: person.team || '', relation: relLabel(rel),
    built_at: built.length ? iso(Math.min(...built)) : null, now: doing, kinds, prompt_types, prompt_types_unnamed: unnamed, running, artifacts, amount }
  // 비공개: 관리자에게만 건수(비용은 사람 단위라 비공개 몫을 나누지 않는다)
  const priv = items.filter((c) => !visible(c) && c.visibility === 'private' && activeAt(c) > now - WINDOW_DAYS * DAY && turnsN(c) > 0)
  if (rel.admin && !rel.self && priv.length) card.private = { count: priv.length }
  card.depth = vis.some((c) => atLeast(c.depth, 'summary')) ? 'summary' : vis.length ? 'title' : 'none'   // 열람 기록에 남길 깊이
  return card
}

// 요약이 없거나 맥락이 그 뒤로 바뀐 것(라우터가 턴을 더함) — 다시 만들기 대상
export const staleOf = (items) => items.filter((c) => turnsN(c) > 0 && (!c.built_at || ms(c.built_at) < ms(c.updated_at)))

// 겹침 비교 글: 보는 사람이 그 맥락에 가진 깊이만큼(제목 깊이 = 제목 + 한 줄 목적, 요약 깊이·본인 = + 요약)
export const overlapText = (c) => [c.title, c.purpose, c.mine || atLeast(c.depth, 'summary') ? c.summary : ''].map((s) => String(s || '').trim()).filter(Boolean).join('\n')
// 서로 다른 주인의 맥락 쌍 중 유사도 ≥ min. watch(c) = 보는 사람이 그 주인 쪽 당사자(본인·장·관리자)인가
export function pairsOf(items, vecs, { min = OVERLAP_MIN, watch = () => true } = {}) {
  const out = []
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]
    if (String(a.owner) === String(b.owner) || (!watch(a) && !watch(b))) continue
    const s = cosine(vecs[i], vecs[j])
    if (s >= min) out.push({ i, j, score: Math.round(s * 1000) / 1000 })
  }
  return out.sort((x, y) => y.score - x.score)
}

// 시간순 보기의 줄(순수). 원문 = 프롬프트 문장 + 답 첫 줄, 요약 = 프롬프트 유형 이름 + 바꿔 쓴 한 줄(프롬프트 문장은 없다),
// 제목 = 시각과 작업 유형만. 원문 깊이가 없는 줄에는 request 가 붙는다(참고 요청과 같은 규칙).
export function timelineLines({ item, depth, turns = [], runs = [], arts = [], exclude = [] }) {
  const deep = atLeast(depth, 'content'), mid = atLeast(depth, 'summary')
  const req = deep ? null : request(item)
  const member = new Map()
  for (const t of item.prompt_types || []) for (const l of t.lines || []) member.set(norm(l.text), { type: t.name, line: l.line || null })
  const ex = new Set((exclude || []).map(String))
  const lines = []
  for (const t of turns) {
    if (ex.has(String(t.id))) { lines.push({ kind: 'excluded', at: iso(t.at) }); continue }
    const work = classifyKind(t.prompt)
    const m = member.get(norm(t.prompt))
    const L = { kind: 'prompt', at: iso(t.at), work }
    if (deep) Object.assign(L, { prompt: t.prompt, answer: firstLine(t.answer), type: m?.type || null })
    else if (mid) Object.assign(L, { type: m?.type || `${work} 요청`, line: m?.line || null, request: req })
    else L.request = req
    lines.push(L)
  }
  for (const r of runs) lines.push({ kind: 'ai', at: iso(r.started_at), status_label: RUN_LABEL[r.status] || r.status, ...(mid ? { title: RUN_KIND[r.kind] || 'AI 작업' } : { request: req }) })
  for (const a of arts) lines.push({ kind: 'artifact', at: iso(a.at), ...(mid ? { name: a.name, ext: a.ext || '' } : { request: req }), ...(deep && a.url ? { url: a.url } : {}) })
  return lines.sort((x, y) => ms(x.at) - ms(y.at))
}

// ── DB 에서 모으기 ────────────────────────────────────────────────────────
// 진행 중인 AI 작업(사람마다): 메인 채팅이 일하는 중·입력을 기다림(관련 맥락 = 그 대화의 맥락), 정기 작업 실행 중,
// 브라우저 작업, 그 사람이 참여한 프로세스의 AI 단계. 서버가 멈춰 남은 「실행 중」은 하루가 지나면 세지 않는다.
export async function runsOf(owners) {
  if (!owners.length) return []
  const [chat, missions, tasks, steps] = await Promise.all([
    q(`select t.user_id::text as owner, 'chat' as kind, coalesce(c.title, t.title, '') as title, t.status, t.updated_at as started_at, t.conversation_id as conv
        from pro_threads t left join context_threads c on c.tenant_id = $1 and c.user_id = t.user_id::text and c.conversation_id = t.conversation_id
        where t.user_id = any($2::uuid[]) and t.status in ('working', 'needs_input') and t.updated_at > now() - interval '1 day'`, [T(), owners]),
    q(`select s.user_id::text as owner, 'mission' as kind, s.name as title, left(s.prompt, 120) as detail, r.status, r.started_at, null as conv
        from pro_mission_runs r join pro_schedules s on s.id = r.schedule_id
        where s.user_id = any($1::uuid[]) and r.status = 'running' and r.finished_at is null and r.started_at > now() - interval '1 day'`, [owners]),
    q(`select t.user_id::text as owner, 'browser' as kind, coalesce(m.content->>'title', '') as title, left(m.content->>'goal', 120) as detail, m.content->>'state' as status, m.created_at as started_at, null as conv
        from pro_messages m join pro_threads t on t.id = m.thread_id
        where t.user_id = any($1::uuid[]) and m.kind = 'task' and m.content->>'state' in ('running', 'needs_input', 'queued') and m.created_at > now() - interval '1 day'`, [owners]),
    q(`select p.uid as owner, 'process' as kind, coalesce(t.activity_name, '') as title, coalesce(i.proc_inst_name, '') as detail, 'running' as status,
          coalesce(t.actual_start_date, t.updated_at) as started_at, null as conv
        from todolist t join bpm_proc_inst i on i.proc_inst_id = t.proc_inst_id and i.tenant_id = t.tenant_id
        cross join lateral unnest(i.participants) as p(uid)
        where t.tenant_id = $1 and p.uid = any($2::text[]) and t.agent_orch is not null and t.status::text not in ('DONE', 'CANCELLED')
          and (t.draft_status::text = 'STARTED' or t.consumer is not null or t.lease_until > now())`, [T(), owners]).catch(() => []),
  ])
  return [...chat, ...missions, ...tasks, ...steps].sort((a, b) => ms(b.started_at) - ms(a.started_at))
}

// 최근 30일 환산 비용(사람 단위) — 사용 원장(lib/plans/meter.js)
export async function spendOf(owners) {
  if (!owners.length) return new Map()
  const rows = await q(`select user_id, coalesce(sum(cost_usd), 0)::float8 as usd, coalesce(sum(credits), 0)::float8 as credits from pro_billing_usage
      where tenant_id = $1 and user_id = any($2::text[]) and at > now() - interval '30 days' group by user_id`, [T(), owners]).catch(() => [])
  return new Map(rows.map((r) => [String(r.user_id), { usd: r.usd, credits: r.credits || creditsOf(r.usd) }]))
}

// 산출물: 메인 채팅에서 에이전트가 남긴 파일·문서 카드(최근 30일). 맥락 = 카드의 표지, 없으면 바로 앞 에이전트 답의 맥락
export async function artifactsOf(owners) {
  if (!owners.length) return []
  const rows = await q(`select t.user_id::text as owner, m.kind, m.content->>'name' as name, m.content->>'ext' as ext, m.content->>'url' as url,
        left(m.content->>'text', 200) as text, m.created_at as at,
        coalesce(m.content->>'conv', m.content->'context'->>'conversationId', prev.conv) as conv
      from pro_messages m join pro_threads t on t.id = m.thread_id
      left join lateral (select coalesce(p.content->>'conv', p.content->'context'->>'conversationId') as conv from pro_messages p
          where p.thread_id = m.thread_id and p.role = 'agent' and p.kind = 'text' and p.created_at <= m.created_at and p.created_at > m.created_at - interval '30 minutes'
          order by p.created_at desc limit 1) prev on true
      where t.user_id = any($1::uuid[]) and t.kind = 'chat' and m.role = 'agent' and m.kind in ('file', 'doc') and m.created_at > now() - interval '30 days'
      order by m.created_at desc limit 300`, [owners])
  return rows.map((r) => ({ ...r, name: r.name || (r.text ? firstLine(String(r.text).replace(/^#+\s*/, ''), 60) : '문서'),
    ext: String(r.ext || (r.name || '').split('.').slice(1).pop() || (r.kind === 'doc' ? 'doc' : '')).replace(/^\./, '') }))
}

// 사람들(owners)의 카드 재료. items 는 보는 사람 기준 깊이가 매겨진 맥락(none 포함 — 관리자 건수와 「다시 만들기」 판단용)
async function gather(vc, owners) {
  owners = owners.map(String)
  if (!owners.length) return { items: [], runs: [], spend: new Map(), arts: [] }
  const [items, runs, spend, arts] = await Promise.all([contextsFor(vc, { owners, withNone: true }), runsOf(owners), spendOf(owners), artifactsOf(owners)])
  return { items, runs, spend, arts }
}
// 한 사람 몫. depthFn 으로 깊이를 다시 매길 수 있다(「다른 사람 눈으로 내 카드 보기」)
function inputOf(raw, owner, depthFn = (x) => x.depth) {
  const o = String(owner)
  return { items: raw.items.filter((c) => c.owner === o).map((c) => ({ ...c, depth: depthFn(c) })), runs: raw.runs.filter((r) => String(r.owner) === o),
    spend: raw.spend.get(o) || null, arts: raw.arts.filter((a) => String(a.owner) === o) }
}
const personOf = (org, id) => ({ id: String(id), name: personName(org, id), team: teamName(org, id) })
// 보이는(또는 내) 맥락 가운데 요약이 낡은 것은 곧 다시 만든다(digest.rebuildSoon: 같은 맥락은 한 번으로 모은다)
function kick(items) {
  const st = staleOf(items.filter((c) => visible(c) || c.mine))
  for (const c of st) rebuildSoon(c.owner, c.id)
  return st.length > 0
}

// GET /team-activity?scope=
export async function activity(vc, scope = 'team') {
  if (!SCOPES.includes(scope)) throw new ContextError(400, `범위는 ${SCOPES.join('|')}`)
  const people = peopleInScope(vc.org, vc.viewer, scope)
  const order = (p) => (String(p.id) === vc.viewer ? '0' : '1') + teamName(vc.org, p.id) + p.name
  people.sort((a, b) => order(a).localeCompare(order(b), 'ko'))
  const raw = await gather(vc, people.map((p) => p.id))
  const cards = []
  for (const p of people) {
    const rel = relation(vc.org, vc.viewer, p.id, { via: vc.via })
    const inp = inputOf(raw, p.id)
    const card = assembleCard({ person: personOf(vc.org, p.id), rel, ...inp })
    if (kick(inp.items)) card.stale = true
    // 요약 열람은 사람·날짜별로 모아 남긴다(제목만 본 카드는 남기지 않는다)
    if (card.depth === 'summary') await logView(vc, { id: null, title: '팀 활동 카드', owner: p.id }, 'summary', `팀 활동 · ${card.relation}`)
    delete card.depth
    cards.push(card)
  }
  const led = ledNodes(vc.org, vc.viewer).filter((n) => vc.org.nodes.has(n))
  return { scope, viewer: { id: vc.viewer, name: vc.name, admin: vc.org.admins.has(vc.viewer), can_org: led.length > 0, in_org: vc.org.people.has(vc.viewer) }, cards, at: new Date().toISOString() }
}

// GET /team-activity/me/as?as= — 내 카드를 같은 팀·다른 팀·장·관리자의 눈으로(허락 없이 등급과 역할만으로) + 이번 주 열람 기록
export const AS = {
  team: { label: '같은 팀', rel: { self: false, member: true, sameTeam: true, sameDept: true, lead: null, admin: false, via: 'jwt' } },
  other: { label: '다른 팀', rel: { self: false, member: true, sameTeam: false, sameDept: false, lead: null, admin: false, via: 'jwt' } },
  lead: { label: '장', rel: { self: false, member: true, sameTeam: true, sameDept: true, lead: 'team', admin: false, via: 'jwt' } },
  admin: { label: '관리자', rel: { self: false, member: true, sameTeam: false, sameDept: false, lead: null, admin: true, via: 'jwt' } },
}
export async function meAs(vc, as = 'team') {
  const a = AS[as]
  if (!a) throw new ContextError(400, `보기는 ${Object.keys(AS).join('|')}`)
  const raw = await gather(vc, [vc.viewer])
  const card = assembleCard({ person: personOf(vc.org, vc.viewer), rel: a.rel, ...inputOf(raw, vc.viewer, (x) => depthOf(x, a.rel, { grants: [] }).depth) })
  delete card.depth
  card.relation = a.label
  return { as, label: a.label, choices: Object.entries(AS).map(([id, x]) => ({ id, label: x.label })), card, views: await viewsOf(vc) }
}
// 이번 주(월요일부터, 한국 시각) 내 카드를 본 사람과 내 원문을 연 기록
export async function viewsOf(vc) {
  const rows = await q(`select viewer, conversation_id, item_title, depth, basis, count, last_at from pro_context_views
      where tenant_id = $1 and owner = $2 and last_at >= (date_trunc('week', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
      order by last_at desc limit 60`, [T(), vc.viewer])
  return rows.map((v) => ({ viewer: String(v.viewer), viewer_name: personName(vc.org, v.viewer), conversationId: v.conversation_id || null, title: v.item_title,
    depth: v.depth, basis: v.basis, count: v.count, at: iso(v.last_at) }))
}

// GET /team-activity/overlaps — 보는 사람이 당사자(두 주인·장·관리자)인 겹침만, 보는 사람이 볼 수 있는 글로만 잰다
export async function overlaps(vc, { min = OVERLAP_MIN, days = OVERLAP_DAYS } = {}) {
  const since = Date.now() - days * DAY
  const cs = (await contextsFor(vc)).filter((c) => activeAt(c) > since)
  const watch = (c) => !!(c.mine || c.rel?.lead || c.rel?.admin)
  if (!cs.some(watch) || cs.length < 2) return { min, days, pairs: [] }
  let vs
  try { vs = await vectors(cs.map(overlapText)) } catch (e) {
    console.warn('[team-activity] overlaps', e.message)
    return { min, days, pairs: [], error: '뜻 비교 서버를 쓸 수 없어 겹침을 재지 못했어요' }
  }
  const side = (c) => ({ conversationId: c.id, title: c.title, purpose: c.purpose || '', owner: c.owner, owner_name: c.owner_name, depth: c.depth, mine: !!c.mine,
    ...(atLeast(c.depth, 'summary') && c.summary ? { line: firstSentence(c.summary) } : {}), ...(c.mine || atLeast(c.depth, 'content') ? {} : { request: request(c) }) })
  const pairs = pairsOf(cs, vs, { min, watch }).slice(0, 20).map(({ i, j, score }) => {
    const [a, b] = cs[j].mine && !cs[i].mine ? [cs[j], cs[i]] : [cs[i], cs[j]]
    return { score, a: side(a), b: side(b) }
  })
  return { min, days, pairs }
}

// GET /team-activity/org — 보는 사람이 장인 노드(관리자는 회사 노드) 아래 조직도 + 노드마다 모은 활동
export async function orgView(vc) {
  const org = vc.org
  const led = ledNodes(org, vc.viewer).filter((n) => org.nodes.has(n))
  if (!led.length) throw new ContextError(403, '조직도 보기는 팀·부서의 장과 관리자만 볼 수 있습니다')
  const within = (a, b) => { for (let n = a, k = 0; n && k < 50; n = org.nodes.get(n)?.parent, k++) if (n === b) return true; return false }
  const tops = led.filter((n) => !led.some((m) => m !== n && within(n, m)))
  const owners = [...new Set(tops.flatMap((n) => peopleUnder(org, n).map((p) => String(p.id))))]
  const [items, runs, spend] = owners.length ? await Promise.all([contextsFor(vc, { owners, withNone: true }), runsOf(owners), spendOf(owners)]) : [[], [], new Map()]
  const since = Date.now() - WINDOW_DAYS * DAY
  const live = items.filter((c) => activeAt(c) > since && turnsN(c) > 0)
  const shownOwners = new Set()
  const node = (id) => {
    const n = org.nodes.get(id)
    const under = new Set(peopleUnder(org, id).map((p) => String(p.id)))
    const mine = live.filter((c) => under.has(c.owner))
    const vis = mine.filter(visible)
    const kc = {}
    for (const c of vis) for (const [k, v] of Object.entries(c.kinds || {})) kc[k] = (kc[k] || 0) + Number(v || 0)
    const topics = [...vis].sort((a, b) => turnsN(b) - turnsN(a) || activeAt(b) - activeAt(a)).slice(0, 5).map((c) => {
      const t = { conversationId: c.id, title: c.title, owner: c.owner, owner_name: c.owner_name, depth: c.depth, turns: turnsN(c), at: iso(c.updated_at) }
      if (atLeast(c.depth, 'summary') && c.summary) { t.line = firstSentence(c.summary); if (!c.mine) shownOwners.add(c.owner) }
      return t
    })
    const cost = [...under].reduce((s, o) => { const x = spend.get(o); return { usd: s.usd + Number(x?.usd || 0), credits: s.credits + Number(x?.credits || 0) } }, { usd: 0, credits: 0 })
    const leadId = org.leads.get(id)
    return { id, name: n.name, lead: leadId ? { id: leadId, name: personName(org, leadId) } : null,
      members: [...org.people.values()].filter((p) => p.teams.includes(id)).map((p) => ({ id: String(p.id), name: p.name })),
      stats: { people: under.size,
        contexts: mine.length,                                            // 비공개 맥락도 건수에는 든다
        private: mine.filter((c) => !visible(c) && c.visibility === 'private').length,
        turns: mine.reduce((s, c) => s + turnsN(c), 0),
        cost: money(cost),                                                // 사람 단위 — 비공개 작업 비용 포함
        running: runs.filter((r) => under.has(String(r.owner))).length, topics,
        kinds: Object.entries(kc).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) },
      children: (n.children || []).map(node) }
  }
  const roots = tops.map(node)
  for (const o of shownOwners) await logView(vc, { id: null, title: '팀 활동 카드', owner: o }, 'summary', '팀 활동 · 조직도')
  const built = live.filter(visible).map((c) => ms(c.built_at)).filter(Boolean)
  return { roots, built_at: built.length ? iso(Math.min(...built)) : null, at: new Date().toISOString() }
}

// GET /team-activity/:user/timeline?conv= — 그 사람의 맥락 하나에서 일어난 일을 시간순으로, 보는 사람의 깊이로
export async function timeline(vc, user, conv) {
  if (!conv) throw new ContextError(400, '맥락(conv)이 필요합니다')
  const [r] = (await contextRows({ owners: [String(user)], convs: [String(conv)] })).filter((x) => x.owner === vc.viewer || vc.org.people.has(x.owner))
  if (!r) throw new ContextError(404, '없는 맥락입니다')
  const d = depthFor(vc, r, await grantsOf(vc.viewer, [r.id]))
  if (d.depth === 'none') throw new ContextError(404, '없는 맥락입니다')
  const mid = atLeast(d.depth, 'summary')
  const [turns, runs, arts] = await Promise.all([
    turnsOf(r.owner, r.id, { since: new Date(ms(r.created_at) - 60000), limit: 200 }),
    runsOf([r.owner]).then((xs) => xs.filter((x) => x.conv === r.id)),
    artifactsOf([r.owner]).then((xs) => xs.filter((x) => x.conv === r.id)),
  ])
  const lines = timelineLines({ item: r, depth: d.depth, turns, runs, arts, exclude: d.grant?.exclude || [] })
  const mine = r.owner === vc.viewer
  const item = { conversationId: r.id, title: r.title, purpose: r.purpose || '', owner: r.owner, owner_name: personName(vc.org, r.owner), depth: d.depth, why: d.why,
    mine, updated_at: iso(r.updated_at), turns: turnsN(r), visibility: mine ? r.visibility : undefined }
  if (mid) Object.assign(item, { summary: r.summary || '', decisions: r.decisions || [], questions: r.questions || [] })
  if (!mine) await logView(vc, { id: r.id, title: r.title, owner: r.owner }, d.depth, `팀 활동 · ${d.why.join(', ')}`)
  return { item, lines, request: atLeast(d.depth, 'content') ? null : request(r), built_at: iso(r.built_at) }
}
