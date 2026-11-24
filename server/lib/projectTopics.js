// A project's sub-topics (2026-11-25 사용자: 「홈 채팅에서 주제를 자동 분류하듯이 하나의 프로젝트 내에서도 서브 레벨로 주제들이 자동 분류될 수
// 있어야 한다. 한 프로젝트 내에서도 많은 내용들이 있을 수 있기 때문에.」 — spec openspec/specs/project-room 「프로젝트 안의 주제」).
//
// A message typed in a project is classified the way the main chat's are: the context router (POST /route — the decision only) picks
// which of THIS project's sub-topics it continues, or a new one, and the turn goes to that sub-topic's conversation. A sub-topic is a
// deepagents conversation of its own (its own history and conversation folder), recorded in context_threads like the main chat's
// conversations — under a scope key in place of the person's id (`<user>/project/<thread>`). So:
//   - the candidates are only this project's sub-topics: Lite passes them (metadata.contexts), and the router's own reads of stored
//     rows (router/store.py, by user_id) see only the rows under the same key;
//   - the main chat's conversations (GET /api/conversations, the router's reads for the person) never see a project's sub-topics, and
//     a project never sees the main chat's or another project's.
// The router decides; nothing here reads what a message is about. The router unreachable or not configured: the project works as
// before (its one conversation, no sub-topics).
// What stays the project's own: its folder's variation is checked out in the conversation the turn runs in (lib/folders/threadFolders.js
// prepareProjectWork), its turns run one at a time (lib/turns.js serial), the processes it starts, its room rule.
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { L } from './lang.js'

const T = () => config.tenantId
export const SCOPE = '/project/'
// the key a project's sub-topics are kept under (context_threads.user_id, and the router's user_uid for this project)
export const scopeKey = (userId, threadId) => `${userId}${SCOPE}${threadId}`
// a row of context_threads under one of this person's projects (lib/workroom.js: their conversation folders are theirs)
export const scopePattern = (userId) => `${userId}${SCOPE}%`
export const enabled = () => !!config.contextRouterUrl
// how many of the project's sub-topics are offered (the router narrows them to the few worth deciding among)
export const TOPIC_LIMIT = 40
const ROUTE_MS = Number(process.env.PRO_TOPIC_ROUTE_MS) || 45_000

const firstLine = (s, n = 60) => String(s || '').trim().split('\n')[0].trim().slice(0, n)
const iso = (t) => { const d = t ? new Date(t) : null; return d && Number.isFinite(d.getTime()) ? d.toISOString() : undefined }

// ---------- pure ----------
// Whether a turn of this thread is classified: a project's message a person typed — not a scheduled run (divider), a mail's or a
// teammate's work done in the background (silent · background), skill authoring, a process being designed (its draft is one exchange,
// kept in the conversation it started in) or a turn already pinned to a conversation (the view narrowed to one sub-topic, a folder run)
export function routesProject({ kind, routerOn, pinned = false, silent = false, background = false, divider = false, mode = null, generating = false }) {
  return kind === 'project' && !!routerOn && !pinned && !silent && !background && !divider && mode !== 'skill' && !generating
}

// The candidates offered to the router: the project's sub-topics (newest first) and the requests of this project still being answered
// (as conversations in progress — their rows are written only when they finish). One entry per conversation; the router needs a title.
export function routeContexts({ topics = [], ahead = [], limit = TOPIC_LIMIT } = {}) {
  const out = new Map()
  const working = L('진행 중인 요청', 'Request in progress')
  for (const x of ahead) {
    if (!x?.conv || String(x.conv).startsWith('none:')) continue
    out.set(String(x.conv), { conversation_id: String(x.conv), title: x.title || working, summary: `${working}: ${x.title || ''}`, kind: 'conversation', active: true })
  }
  for (const t of (topics || []).slice(0, limit)) {
    if (!t?.id) continue
    const id = String(t.id)
    const title = String(t.title || '').trim() || L('프로젝트 대화', 'Project conversation')
    const a = out.get(id)
    out.set(id, a
      ? { ...a, title, gist: String(t.gist || ''), updated_at: iso(t.updated_at) }
      : { conversation_id: id, title, summary: String(t.summary || ''), gist: String(t.gist || ''), kind: 'conversation', updated_at: iso(t.updated_at) })
  }
  return [...out.values()]
}

// POST /route's body: the person's words, this project's key as the user, the sub-topic the project stands in now (an unsure decision
// stays there), and the candidates
export function routeBody({ text, tenantId, userId, threadId, current = null, contexts = [] }) {
  return { message: String(text || '').slice(0, 2000), tenant_id: tenantId, user_uid: scopeKey(userId, threadId), conversation_id: current || null, metadata: { contexts } }
}

// The router's answer, taken only when it names a conversation of this project: a new one, one of the candidates, or the one it stands
// in (an unsure call with nowhere to stay is a new one the router made up). A stored sub-topic older than the candidates is checked
// against the database (routeProject).
export function acceptRoute(j, { contexts = [], current = null } = {}) {
  if (!j?.conversation_id || !['new', 'continue', 'stay'].includes(j.action)) return null
  const id = String(j.conversation_id)
  const known = id === current || contexts.some((c) => c.conversation_id === id)
  if (j.action === 'new' || known || (j.action === 'stay' && !current)) return { ...j, conversation_id: id }
  return null
}

// The earlier requests of a sub-topic, kept short in its gist when its summary is replaced by the latest one (the router reads both
// to recognise a follow-up). Newest kept; the oldest go first.
export function foldGist(gist, summary, max = 200) {
  const ask = String(summary || '').split('\n')[0].replace(/^(최근 요청|Latest request):\s*/, '').trim().slice(0, 60)
  const parts = String(gist || '').split(' · ').map((s) => s.trim()).filter(Boolean)
  if (ask && parts[parts.length - 1] !== ask) parts.push(ask)
  while (parts.length > 1 && parts.join(' · ').length > max) parts.shift()
  return parts.join(' · ').slice(0, max)
}

export const summaryOf = (text, answer) => L(`최근 요청: ${String(text || '').trim().slice(0, 200)}\n최근 답: ${String(answer || '').trim().slice(0, 300)}`,
  `Latest request: ${String(text || '').trim().slice(0, 200)}\nLatest answer: ${String(answer || '').trim().slice(0, 300)}`).slice(0, 600)

// ---------- the database ----------
// this project's sub-topics, newest first
export async function topicsOf(userId, threadId, limit = TOPIC_LIMIT) {
  return q(`select conversation_id as id, title, summary, gist, kind, turns, updated_at from context_threads
            where tenant_id=$1 and user_id=$2 order by updated_at desc limit $3`, [T(), scopeKey(userId, threadId), limit])
}
// a conversation of this project: the one it stands in, or one of its sub-topics
export async function isTopic(userId, thread, conv) {
  if (!conv || !thread?.id) return false
  if (thread.conversation_id && String(conv) === String(thread.conversation_id)) return true
  const [r] = await q('select 1 from context_threads where tenant_id=$1 and user_id=$2 and conversation_id=$3', [T(), scopeKey(userId, thread.id), String(conv)])
  return !!r
}

// A project that talked before it had sub-topics: its one conversation is offered as its first sub-topic, named after the project, so
// the router can continue it or tell a new topic apart from it — and once the router has answered it is kept as one (the list shows it).
// Nothing is written while the router does not answer (the project then works as before).
export async function originTopic(userId, thread) {
  if (!thread?.conversation_id) return null
  const said = await q(`select role, content->>'text' as text from pro_messages where thread_id=$1 and kind in ('text','doc') and coalesce(content->>'text','') <> ''
                        order by created_at desc limit 12`, [thread.id])
  if (!said.length) return null
  const [{ n }] = await q(`select count(*)::int as n from pro_messages where thread_id=$1 and role='user' and kind='text'`, [thread.id])
  return { id: String(thread.conversation_id), title: String(thread.title || L('프로젝트 대화', 'Project conversation')).slice(0, 120),
    summary: summaryOf(said.find((m) => m.role === 'user')?.text || '', said.find((m) => m.role === 'agent')?.text || ''), gist: '', turns: Math.max(1, n),
    updated_at: thread.updated_at || null }
}
export async function keepOrigin(userId, thread, t) {
  if (!t) return
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,created_at,updated_at)
           values ($1,$2,$3,$4,$5,'','conversation',$6,coalesce($7::timestamptz, now()),coalesce($7::timestamptz, now()))
           on conflict (tenant_id,user_id,conversation_id) do nothing`, [T(), scopeKey(userId, thread.id), t.id, t.title, t.summary, t.turns, t.updated_at])
}

// The router's decision for a project's message → {conversation_id, action, context, decision}, or null (not configured, unreachable,
// an answer that is not this project's): the turn then goes where the project's turns always went.
// ahead: the turns of this project still in flight (lib/turns.js aheadInThread)
export async function routeProject({ user, thread, text, ahead = [] }) {
  if (!enabled() || thread?.kind !== 'project') return null
  try {
    const topics = await topicsOf(user.id, thread.id)
    const origin = topics.length ? null : await originTopic(user.id, thread).catch((e) => { console.warn('[topics] origin', e.message); return null })
    const contexts = routeContexts({ topics: origin ? [origin] : topics, ahead })
    const current = thread.conversation_id || null
    const started = Date.now()
    const r = await fetch(`${config.contextRouterUrl}/route`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(ROUTE_MS),
      body: JSON.stringify(routeBody({ text, tenantId: T(), userId: user.id, threadId: thread.id, current, contexts })),
    })
    if (!r.ok) { console.warn(`[topics] route ${r.status}: the project's own conversation`); return null }
    const j = await r.json()
    let ok = acceptRoute(j, { contexts, current })
    if (!ok && j?.conversation_id && await isTopic(user.id, thread, j.conversation_id).catch(() => false)) ok = { ...j, conversation_id: String(j.conversation_id) }
    console.log(`[topics] thread=${String(thread.id).slice(0, 8)} ${ok ? `${ok.action} → ${ok.conversation_id.slice(0, 12)}` : 'not this project\'s, ignored'} (${contexts.length} candidates, ${Date.now() - started} ms)`)
    if (ok && origin) await keepOrigin(user.id, thread, origin).catch((e) => console.warn('[topics] origin keep', e.message))
    return ok
  } catch (e) {
    console.warn('[topics] route', e.cause?.code || e.message, "— the project's own conversation")
    return null
  }
}

// The person's message goes with its sub-topic at once (the page puts it under that sub-topic while it is being answered)
export async function tagMessage(userId, messageId, conv) {
  if (!messageId || !conv) return
  const [m] = await q(`update pro_messages set content = content || jsonb_build_object('conv', $2::text) where id=$1 returning *`, [messageId, String(conv)])
  if (m) emit(userId, 'message', m)
}

// A turn answered in a sub-topic: its row (made with the request's first line as its title when it is new), the latest request and
// answer as its summary, the earlier ones folded into its gist, one more turn
export async function fileTopic(user, thread, routing, text, answer = '') {
  const conv = routing?.conversation_id
  if (!conv || !thread?.id) return
  const scope = scopeKey(user.id, thread.id)
  const [prev] = await q('select title, summary, gist from context_threads where tenant_id=$1 and user_id=$2 and conversation_id=$3', [T(), scope, String(conv)])
  const title = prev?.title || routing.context?.title || firstLine(text) || L('새 주제', 'New topic')
  const gist = prev ? foldGist(prev.gist, prev.summary) : String(routing.context?.gist || '').slice(0, 200)
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,$4,$5,$6,'conversation',1,now())
           on conflict (tenant_id,user_id,conversation_id) do update set summary=excluded.summary, gist=excluded.gist, turns=context_threads.turns+1, updated_at=now()`,
  [T(), scope, String(conv), String(title).slice(0, 120), summaryOf(text, answer), gist])
}
