// 대화를 통째로 프로젝트로 옮기기 (2026-11-28 사용자: 「필터링된 채팅방 자체를 프로젝트로 이관하는 기능. 이관 후엔 이 채팅 내용은 프로젝트에서만 볼 수
// 있음. 기존 채팅 목록에서는 제거됩니다... 라는 알림도 줘야」 — spec openspec/specs/thread-to-project).
//
// A conversation of the main chat (one the context router told apart — src/convOf.js, lib/conversations.js) goes into one of the person's
// projects as one of its sub-topics (lib/projectTopics.js), in one place only: its messages are not copied, they change rooms.
//   - its messages (answers, files, attachments, cards — every message the screen files under it) move to the project's room, each tagged
//     with the sub-topic (content.conv) and marked moved (content.moved {from, conv, by, at, prevConv}); a moved message is filed by its own
//     sub-topic and never moves the sub-topic the messages around it go with (lib/conversations.js topicOf — src/projectTopics.js);
//   - its row in context_threads moves from the person's key to the project's (`<user>/project/<thread>` — lib/projectTopics.js scopeKey):
//     the chat's 대화 list and the router's candidates for the chat no longer have it, the project's sub-topics do, and the deepagents
//     conversation (its history and its conversation folder) goes on under the same id — a question asked there goes on in the project,
//     with the project's plan and folder (lib/agent.js delegate);
//   - a chip in the project says where it came from, with 「채팅으로 되돌리기」 (content.moved.note).
// The claim is the row: one statement moves the row and the messages together (a data-modifying CTE — no advisory lock, no connection held:
// PR #118). Two presses, or two screens moving it to two projects at once: the row's update serializes them, the second finds the row gone
// and says where it went.
// Who may: the conversation's own person, into a project of theirs they may still work in (its folder at runner or above). A project that
// works in a shared folder other people are members of is said before the move — what the project makes from then on lands in that folder's
// variation, which they see — and the move needs that confirmed (membersOk).
// Kept out: a scheduled task's and the briefs' conversations (their runs keep arriving in the chat), a conversation with an answer being
// written or waiting (it would land in the chat after the move).
// Anything filed aside into a moved conversation later (a mail's line — lib/ownConversations.js mailConversation) goes to the project:
// store.js addMessage asks redirectOf. A link to /chat/c/<id> finds it through placeOf (GET /api/conversations/:cid/place).
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { L } from './lang.js'
import { ro } from './josa.js'
import { mainThread, addMessage } from './store.js'
import * as CV from './conversations.js'
import * as PT from './projectTopics.js'
import * as turns from './turns.js'

const T = () => config.tenantId
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, ...(code ? { code } : {}), ...extra })
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
// conversations that keep receiving their own runs in the chat (lib/ownConversations.js): not moved
export const STANDING = ['schedule', 'brief']
// an id the screen makes for an old run or brief it cannot name yet (src/convOf.js) — no request ever sends it as a person's own
const screenOnly = (id) => /^(sched-old-|brief-old)/.test(String(id))
const validConv = (cid) => { const s = String(cid || ''); return s && s.length <= 200 && !screenOnly(s) ? s : null }
const RUNNER = 2
const RANK = { viewer: 1, runner: 2, editor: 3, owner: 4 }

// ---------- pure ----------
// What the screen files under each message, without the bodies: the fields src/convOf.js reads (context · scheduleId · whether it carries mails)
// (and a browser task card's state — a task still at work keeps writing into the conversation: refusal)
export const SLIM = `jsonb_strip_nulls(jsonb_build_object('context', m.content->'context', 'scheduleId', m.content->'scheduleId',
  'mails', case when jsonb_typeof(m.content->'mails') = 'array' and jsonb_array_length(m.content->'mails') > 0 then '[1]'::jsonb end,
  'state', case when m.kind = 'task' then m.content->'state' end))`
/** the messages of the main chat filed under conv (src/convOf.js — the screen's own filing), oldest first */
export function idsOf(rows, conv, { briefId = null } = {}) {
  const of = CV.convOf(rows, { briefId })
  return rows.filter((r) => of[r.id] === conv).map((r) => r.id)
}
// the conversation's name: its row's, else the router's call on one of its messages
export function titleOf(row, rows = [], conv) {
  if (row?.title) return String(row.title)
  for (const r of rows) { const c = r.content?.context; if (c?.conversationId === conv && c.title) return String(c.title) }
  return ''
}
// the kind of a conversation of its own (a scheduled task's · the briefs' · a mail's), from its row or the messages filed aside in it
export function kindOf(row, rows = [], conv) {
  if (row?.kind) return String(row.kind)
  for (const r of rows) { const c = r.content?.context; if (c?.conversationId === conv && c.kind) return String(c.kind) }
  return 'conversation'
}
// A turn of the room not finished yet that is, or may still turn out to be, this conversation's: one on it, or one that does not know its
// conversation yet (a routed turn learns it only when the router answers — moved meanwhile, its answer would land in the old room)
// (PR #125 review 1)
const unknownConv = (c) => !c || String(c).startsWith('none:')
export const busyTurn = (list, conv) => (list || []).some((x) => !x.finished && (unknownConv(x.conv) || String(x.conv) === String(conv)))
// a browser task still at work in it: its later lines (a question, files, its result) go to the room it was started in (PR #125 review 3)
export const TASK_BUSY = ['queued', 'running', 'needs_input']
export const busyTask = (rows, ids) => { const set = new Set(ids); return (rows || []).some((r) => set.has(r.id) && r.kind === 'task' && TASK_BUSY.includes(r.content?.state)) }
// the project a scoped key names (`<user>/project/<thread>` — lib/projectTopics.js scopeKey)
export const projectOfKey = (key, userId) => {
  const pre = `${userId}${PT.SCOPE}`
  return String(key || '').startsWith(pre) ? String(key).slice(pre.length) : null
}

// ---------- the conversation in the main chat ----------
async function briefIdOf(userId) {
  const [b] = await q(`select conversation_id from context_threads where tenant_id=$1 and user_id=$2 and kind='brief' order by updated_at desc limit 1`, [T(), String(userId)])
  return b?.conversation_id || null
}
/** → {main, rows, ids, row, kind, title, count} — the conversation as the chat shows it now (no messages: count 0) */
export async function inChat(user, conv) {
  const main = await mainThread(user.id)
  const rows = await q(`select m.id, m.role, m.kind, m.created_at, ${SLIM} as content from pro_messages m where m.thread_id=$1 order by m.created_at`, [main.id])
  const ids = idsOf(rows, conv, { briefId: await briefIdOf(user.id) })
  const [row] = await q(`select conversation_id, title, kind, updated_at from context_threads where tenant_id=$1 and user_id=$2 and conversation_id=$3`, [T(), String(user.id), conv])
  return { main, rows, ids, convId: conv, row: row || null, kind: kindOf(row, rows, conv), title: titleOf(row, rows, conv) || L('대화', 'Conversation'), count: ids.length }
}

// where a conversation of this person now lives: one of their projects → {project: {id, title}, topic} | null
export async function placeOf(user, conv) {
  const id = validConv(conv)
  if (!id) return null
  const [r] = await q(`select t.id, t.title from context_threads c join pro_threads t on t.id::text = substr(c.user_id, $4) and t.user_id::text = $2 and t.kind = 'project'
                       where c.tenant_id=$1 and c.user_id like $3 and c.conversation_id=$5 limit 1`,
  [T(), String(user.id), PT.scopePattern(user.id), `${user.id}${PT.SCOPE}`.length + 1, id])
  return r ? { project: { id: r.id, title: r.title }, topic: id } : null
}
// A message filed aside into a conversation of the main chat that now lives in a project (a mail's line, a follow-up's — lib/ownConversations.js):
// the project it goes to instead, or null. One query; only for the person's own main chat.
export async function redirectOf(userId, threadId, conv) {
  if (!userId || !threadId || !conv || !UUID.test(String(threadId))) return null
  const [r] = await q(`select p.id from pro_threads t
                         join context_threads c on c.tenant_id=$1 and c.user_id like $3 and c.conversation_id=$4
                         join pro_threads p on p.id::text = substr(c.user_id, $5) and p.user_id = t.user_id and p.kind = 'project'
                       where t.id=$2 and t.user_id::text=$6 and t.kind='chat' limit 1`,
  [T(), threadId, PT.scopePattern(userId), String(conv), `${userId}${PT.SCOPE}`.length + 1, String(userId)]).catch(() => [])
  return r?.id || null
}

// ---------- the projects it may go to ----------
// one project of this person: {id, title, folder: {slug, name, mode} | null, writable, why, members: [{id, name}] (others who see what it makes)}
async function projectsOf(user, ids = null) {
  const rows = await q(`select t.id, t.title, t.updated_at, l.mode, l.folder_id, l.variation_id, f.slug, f.name as folder_name, f.kind as folder_kind
                        from pro_threads t left join pro_thread_folders l on l.thread_id = t.id left join pro_folders f on f.id = l.folder_id
                        where t.user_id=$1 and t.kind='project' ${ids ? 'and t.id = any($2::uuid[])' : ''} order by t.updated_at desc limit 60`, ids ? [user.id, ids] : [user.id])
  const working = rows.filter((r) => r.mode === 'project' && r.folder_id)
  const folderIds = [...new Set(working.map((r) => String(r.folder_id)))]
  const roles = new Map(folderIds.length ? (await q(`select folder_id::text as f, role from pro_folder_members where principal_type='user' and principal_id=$1 and folder_id = any($2::uuid[])`,
    [String(user.id), folderIds])).map((r) => [r.f, r.role]) : [])
  const vids = working.map((r) => r.variation_id).filter(Boolean)
  const privateWs = new Set(vids.length ? (await q(`select id::text as id from pro_folder_variations where id = any($1::uuid[]) and coalesce(source, '{}'::jsonb) ? 'template'`, [vids])).map((r) => r.id) : [])
  const S = folderIds.length ? await import('./folders/service.js') : null
  const members = folderIds.length ? await S.membersOfFolders(folderIds) : new Map()
  return rows.map((r) => {
    const inFolder = r.mode === 'project' && !!r.folder_id
    const role = inFolder ? roles.get(String(r.folder_id)) || null : null
    const writable = !inFolder || (!!role && RANK[role] >= RUNNER)
    // (a template's workspace is the project's person's only — folders/templates.js: nobody else sees what it makes)
    // (only while the person is still in that folder: a folder they left no longer tells them its members — PR #125 review 8)
    const others = inFolder && role && !privateWs.has(String(r.variation_id || ''))
      ? (members.get(String(r.folder_id)) || []).filter((m) => m.type === 'user' && !m.is_agent && String(m.id) !== String(user.id)).map((m) => ({ id: String(m.id), name: m.name || m.email || '' }))
      : []
    return {
      id: r.id, title: r.title, updated_at: r.updated_at,
      folder: inFolder ? { slug: r.slug, name: r.folder_name, workspace: privateWs.has(String(r.variation_id || '')) } : null,
      writable, why: writable ? '' : L(`이 프로젝트의 폴더 「${clip(r.folder_name, 40)}」에 쓸 권한이 없어요.`, `You can't write in this project's folder "${clip(r.folder_name, 40)}".`),
      members: others,
    }
  })
}

// GET /api/conversations/:cid/move → the conversation (its name, how many messages, whether it can move and why not) and the person's
// projects (each: may it go there, who else sees what it makes)
export async function targets(user, cid) {
  const conv = validConv(cid)
  if (!conv) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const place = await placeOf(user, conv)
  if (place) return { conversation: { id: conv, moved: true }, place, projects: [] }
  const c = await inChat(user, conv)
  if (!c.count) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const why = refusal(c, user)
  return { conversation: { id: conv, title: c.title, kind: c.kind, count: c.count, movable: !why, ...(why ? { why: why.message, code: why.code } : {}) }, projects: await projectsOf(user) }
}
// why this conversation cannot move now, or null
function refusal(c, user) {
  if (STANDING.includes(c.kind)) {
    return fail(409, c.kind === 'schedule'
      ? L('예약 작업의 대화는 옮길 수 없어요. 실행 결과가 계속 채팅으로 와요.', "A scheduled task's conversation can't be moved — its runs keep coming to the chat.")
      : L('브리프 대화는 옮길 수 없어요. 새 브리프가 계속 채팅으로 와요.', "The briefs' conversation can't be moved — new briefs keep coming to the chat."), 'standing')
  }
  const live = turns.unsettled({ userId: user.id, threadId: c.main.id })
  if (busyTurn(live, c.convId)) return live.some((x) => !x.finished && String(x.conv) === String(c.convId)) ? BUSY() : BUSY_CHAT()
  if (busyTask(c.rows, c.ids)) return TASK()
  return null
}
const BUSY = () => fail(409, L('이 대화에서 아직 답을 쓰고 있어요. 답이 완성된 뒤에 옮겨 주세요.', 'An answer is still being written in this conversation. Move it once it is done.'), 'busy')
// (a turn of the chat not yet told which conversation it is: maybe this one — not said as this conversation's — PR #125 final check 3)
const BUSY_CHAT = () => fail(409, L('채팅에서 아직 답을 쓰고 있어요. 답이 끝나면 다시 옮겨 주세요.', 'An answer is still being written in the chat. Move it again once it is done.'), 'busy')
const TASK = () => fail(409, L('이 대화에서 브라우저 작업이 아직 진행 중이에요. 작업이 끝난 뒤에 옮겨 주세요.', 'A browser task is still at work in this conversation. Move it once it is done.'), 'busy_task')

// ---------- move ----------
// One statement: the row (the claim) — the person's, moved to the project's key; or, for a conversation the router never wrote a row for, a
// new row under the project's key — and, only when that went, the messages. → {claimed, made, moved}
const MOVE_SQL = `
with claim as (
  update context_threads set user_id = $4, updated_at = now() where tenant_id = $1 and user_id = $2 and conversation_id = $3 returning 1
), made as (
  insert into context_threads (tenant_id, user_id, conversation_id, title, summary, gist, kind, turns, created_at, updated_at)
  select $1, $4, $3, $5, '', '', 'conversation', 1, now(), now()
   where $6::boolean and not exists (select 1 from context_threads where tenant_id = $1 and user_id = $2 and conversation_id = $3)
  on conflict do nothing returning 1
), ok as (select 1 from claim union all select 1 from made),
moved as (
  update pro_messages m set thread_id = $7,
    content = m.content || jsonb_build_object('conv', $3::text, 'moved', jsonb_build_object('from', $8::text, 'conv', $3::text, 'by', $2::text, 'at', now(), 'prevConv', m.content->'conv'))
   where m.id = any($9::uuid[]) and m.thread_id = $8 and exists (select 1 from ok)
  returning m.id
), note as (
  -- (the project's chip about the move — 「채팅으로 되돌리기」 — goes in with the claim, never after it: PR #125 review 5)
  insert into pro_messages (thread_id, role, kind, content)
  select $7, 'agent', 'chip', $10::jsonb where exists (select 1 from ok)
  returning id
)
select (select count(*) from claim)::int as claimed, (select count(*) from made)::int as made, (select count(*) from moved)::int as moved,
  (select id from note) as note_id`
// what is left of it in the chat once the row is the project's (a line that came in the instant before): the same marks, while the row stays there
const SWEEP_SQL = `
update pro_messages m set thread_id = $3,
  content = m.content || jsonb_build_object('conv', $4::text, 'moved', jsonb_build_object('from', $2::text, 'conv', $4::text, 'by', $5::text, 'at', now(), 'prevConv', m.content->'conv'))
 where m.id = any($1::uuid[]) and m.thread_id = $2
   and exists (select 1 from context_threads where tenant_id = $6 and user_id = $7 and conversation_id = $4)
returning m.id`

// POST /api/conversations/:cid/move {project, membersOk} → {moved, project: {id, title}, topic, already?}
//   404  not a conversation of this person's chat (or a project not theirs)
//   403  a project they may no longer write in (its folder below runner)
//   409  standing (a scheduled task's · the briefs'), busy (an answer being written), moved (already in another project — where),
//        confirm_members (the project's folder has other members and the move did not say it saw them)
export async function move(user, cid, { project, membersOk = false } = {}) {
  const conv = validConv(cid)
  if (!conv) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  if (!UUID.test(String(project || ''))) throw fail(400, L('옮길 프로젝트를 골라 주세요.', 'Please pick a project.'))
  const already = async () => {
    const place = await placeOf(user, conv)
    if (place?.project.id === String(project)) return { already: true, moved: 0, project: place.project, topic: conv }
    if (place) throw fail(409, L(`이미 프로젝트 「${clip(place.project.title, 40)}」${ro(`「${clip(place.project.title, 40)}」`)} 옮긴 대화예요.`, `This conversation was already moved to the project "${clip(place.project.title, 40)}".`), 'moved', { place })
    return null
  }
  const done = await already()
  if (done) return done
  const c = await inChat(user, conv)
  if (!c.count) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const why = refusal(c, user)
  if (why) throw why
  const [p] = await projectsOf(user, [String(project)])
  if (!p) throw fail(404, L('프로젝트를 찾지 못했어요.', "I couldn't find that project."))
  if (!p.writable) throw fail(403, p.why, 'readonly')
  if (p.members.length && !membersOk) {
    throw fail(409, L(`프로젝트 「${clip(p.title, 40)}」의 구성원도 이 대화에서 계속 만드는 것을 볼 수 있어요. 확인하고 다시 옮겨 주세요.`,
      `Members of the project "${clip(p.title, 40)}" will see what this conversation makes from now on. Confirm and move it again.`), 'confirm_members', { members: p.members })
  }
  const scope = PT.scopeKey(user.id, p.id)
  const chipOf = (count) => ({ icon: 'chat', conv, text: L(`채팅에서 옮겨 온 대화예요 · 메시지 ${count}개`, `A conversation moved from the chat · ${count} messages`),
    moved: { note: true, conv, from: c.main.id, by: String(user.id), at: new Date().toISOString(), count, title: clip(c.title, 120) } })
  const [r] = await q(MOVE_SQL, [T(), String(user.id), conv, scope, clip(c.title, 120), !c.row, p.id, c.main.id, c.ids, JSON.stringify(chipOf(c.ids.length))])
  if (!r.claimed && !r.made) {
    // another press or another screen took it first: where it went
    const again = await already()
    if (again) return again
    throw fail(409, L('다른 곳에서 이 대화를 옮기는 중이에요. 잠시 후 다시 해 주세요.', 'This conversation is being moved elsewhere. Try again in a moment.'), 'moving')
  }
  if (!r.moved) {
    // (a row made for it while another screen moved its messages elsewhere first: that row goes, and the chip made with it)
    if (r.made) await q('delete from context_threads where tenant_id=$1 and user_id=$2 and conversation_id=$3', [T(), scope, conv]).catch(() => {})
    if (r.note_id) await q('delete from pro_messages where id=$1', [r.note_id]).catch(() => {})
    const again = await already()
    if (again) return again
    throw fail(409, L('이 대화를 옮기지 못했어요. 다시 해 주세요.', "Couldn't move this conversation. Please try again."), 'moving')
  }
  // a line that came in the instant before the statement (filed under it by the screen's rules now): it goes too
  const after = await inChat(user, conv).catch(() => null)
  const stray = after?.ids?.length ? await q(SWEEP_SQL, [after.ids, c.main.id, p.id, conv, String(user.id), T(), scope]).catch(() => []) : []
  const count = r.moved + stray.length
  // the chat no longer stands in it (an unsure next message of the chat must not go on in it)
  await q('update pro_threads set conversation_id=null where id=$1 and conversation_id=$2', [c.main.id, conv]).catch(() => {})
  await q('update pro_threads set updated_at=now() where id=$1', [p.id]).catch(() => {})
  // where it came from, in the project (filed under its sub-topic; marked moved, so it never takes the messages after it with it) — made in the
  // statement above; its count said again when a line came in meanwhile
  const [chip] = r.note_id ? await q(count === c.ids.length ? 'select * from pro_messages where id=$1' : `update pro_messages set content = $2::jsonb where id=$1 returning *`,
    count === c.ids.length ? [r.note_id] : [r.note_id, JSON.stringify(chipOf(count))]).catch(() => []) : []
  if (chip) emit(user.id, 'message', chip)
  const ids = [...c.ids, ...stray.map((x) => x.id)]
  // a card that asked about this move (by words — offerByWords) says it is done (it came along with the conversation)
  for (const m of await q(`update pro_messages set content = content || jsonb_build_object('state', 'moved', 'project', jsonb_build_object('id', $3::text, 'title', $4::text))
      where thread_id=$1 and kind='conv_move' and content->'moveOf'->>'id' = $2 and content->>'state' = 'offered' returning *`, [p.id, conv, p.id, p.title]).catch(() => [])) emit(user.id, 'message', m)
  // …and a 「새 프로젝트로」 card still open for it is closed: it moved elsewhere (its 「만들고 옮기기」 would make an empty project — PR #125 review 9)
  for (const m of await q(`update pro_messages set content = content || jsonb_build_object('state', 'declined', 'closed', 'moved', 'project', jsonb_build_object('id', $3::text, 'title', $4::text))
      where thread_id=$1 and kind='project_offer' and content->'move'->>'conversationId' = $2 and content->>'state' = 'offered' returning *`, [p.id, conv, p.id, p.title]).catch(() => [])) emit(user.id, 'message', m)
  emit(user.id, 'conversation.moved', { conv, from: c.main.id, project: { id: p.id, title: p.title }, ids, count })
  console.log(`[conv-move] conv=${conv.slice(0, 12)} → project=${String(p.id).slice(0, 8)} messages=${count} members=${p.members.length}`)
  return { moved: count, project: { id: p.id, title: p.title }, topic: conv, from: c.main.id, ids }
}

// ---------- back to the chat ----------
// One statement: the row back to the person's key (the claim), the conversation's messages back to the chat — each filed aside in it
// (src/convOf.js: it never takes the chat's other messages with it, nor moves the conversation the chat is in), its earlier tag back —
// and the project's chip about the move gone.
const BACK_SQL = `
with claim as (
  update context_threads set user_id = $2, updated_at = now() where tenant_id = $1 and user_id = $3 and conversation_id = $4 returning 1
), back as (
  update pro_messages m set thread_id = $5,
    content = (m.content - 'moved' - 'conv')
      || case when jsonb_typeof(m.content->'moved'->'prevConv') in ('string', 'object') then jsonb_build_object('conv', m.content->'moved'->'prevConv') else '{}'::jsonb end
      || jsonb_build_object('context', case when jsonb_typeof(m.content->'context') = 'object' then m.content->'context' else '{}'::jsonb end
           || jsonb_build_object('conversationId', $4::text, 'action', 'aside'))
   where m.id = any($6::uuid[]) and m.thread_id = $7 and exists (select 1 from claim)
  returning m.id
), gone as (
  delete from pro_messages where id = any($8::uuid[]) and thread_id = $7 and exists (select 1 from claim) returning id
)
select (select count(*) from claim)::int as claimed, (select count(*) from back)::int as back, (select count(*) from gone)::int as gone`

// POST /api/conversations/:cid/move/undo {project} → {back, topic}: only a conversation moved there from the chat, only by the one who moved it
export async function undo(user, cid, { project } = {}) {
  const conv = validConv(cid)
  if (!conv || !UUID.test(String(project || ''))) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const [p] = await q(`select * from pro_threads where id=$1 and user_id=$2 and kind='project'`, [String(project), user.id])
  if (!p) throw fail(404, L('프로젝트를 찾지 못했어요.', "I couldn't find that project."))
  const place = await placeOf(user, conv)
  if (!place || place.project.id !== p.id) throw fail(404, L('이 프로젝트에 그 대화가 없어요.', "That conversation isn't in this project."))
  const rows = await q(`select id, role, kind, created_at, content from pro_messages where thread_id=$1 and kind <> 'note' order by created_at`, [p.id])
  const notes = rows.filter((r) => r.content?.moved?.note && r.content.moved.conv === conv)
  // what came from the chat: the chip, else (a chip that never got written) the moved lines themselves (PR #125 review 5)
  const moved = rows.filter((r) => r.content?.moved?.conv === conv)
  // (another screen brought it back just now — its lines are no longer here: it is in the chat, nothing more to do)
  const main0 = await mainThread(user.id)
  const backAlready = async () => (!(await placeOf(user, conv)) ? { already: true, back: 0, topic: conv, to: main0.id, project: { id: p.id, title: p.title }, ids: [], notes: [] } : null)
  // (a sub-topic the project started itself never was in the chat: nothing to take back)
  if (!moved.length) {
    const done = await backAlready()
    if (done) return done
    throw fail(409, L('이 프로젝트에서 시작한 주제라 채팅으로 되돌릴 수 없어요.', 'This topic started in the project, so it cannot go back to the chat.'), 'not_moved')
  }
  if (!(notes.length ? notes : moved).some((n) => String(n.content.moved.by) === String(user.id))) throw fail(403, L('대화를 옮긴 사람만 되돌릴 수 있어요.', 'Only the person who moved it can move it back.'), 'not_mover')
  // (a turn of the project not finished — on this sub-topic, or not yet told which one: PT.routeProject may still pick it — PR #125 review 1)
  const live = turns.unsettled({ userId: user.id, threadId: p.id })
  if (busyTurn(live, conv)) {
    throw fail(409, live.some((x) => !x.finished && String(x.conv) === String(conv))
      ? L('이 대화에서 아직 답을 쓰고 있어요. 답이 끝난 뒤에 되돌려 주세요.', 'An answer is still being written here. Move it back once it is done.')
      : L('프로젝트에서 아직 답을 쓰고 있어요. 답이 끝나면 다시 되돌려 주세요.', 'An answer is still being written in the project. Move it back again once it is done.'), 'busy')
  }
  const of = CV.topicOf(rows)
  const noteIds = new Set(notes.map((n) => n.id))
  // (the project's own lines are never its: a change of the project's plan stays with the project — PR #125 review 6)
  const ids = rows.filter((r) => of[r.id] === conv && !noteIds.has(r.id) && !r.content?.planChange).map((r) => r.id)
  if (busyTask(rows, ids)) throw fail(409, L('이 대화에서 브라우저 작업이 아직 진행 중이에요. 작업이 끝난 뒤에 되돌려 주세요.', 'A browser task is still at work here. Move it back once it is done.'), 'busy_task')
  const main = await mainThread(user.id)
  const scope = PT.scopeKey(user.id, p.id)
  // A row for it under the person's own key — written meanwhile by a late answer of the chat (PR #125 review 2) — would collide with the row
  // going back: it is folded into the project's row first (the larger turn count, the later time), and once more if one comes in between
  // (only while the project's row is still there, locked: a second undo a moment later — another screen — must not take the row the first
  // one just brought back for a stray one — PR #125 final check 1)
  const fold = () => q(`with scope_row as (select 1 from context_threads where tenant_id=$1 and user_id=$4 and conversation_id=$3 for update),
    stray as (delete from context_threads where tenant_id=$1 and user_id=$2 and conversation_id=$3 and exists (select 1 from scope_row) returning turns, updated_at)
    update context_threads c set turns = greatest(c.turns, coalesce((select max(turns) from stray), 0)), updated_at = greatest(c.updated_at, coalesce((select max(updated_at) from stray), c.updated_at))
    where c.tenant_id=$1 and c.user_id=$4 and c.conversation_id=$3`, [T(), String(user.id), conv, scope])
  let r = null
  for (let i = 0; i < 3 && !r; i++) {
    await fold()
    try {
      ;[r] = await q(BACK_SQL, [T(), String(user.id), scope, conv, main.id, ids, p.id, [...noteIds]])
    } catch (e) {
      if (e.code !== '23505' || i === 2) throw e
    }
  }
  if (!r.claimed) {
    // (another screen brought it back a moment ago: it is in the chat — nothing more to do)
    const done = await backAlready()
    if (done) return done
    throw fail(409, L('다른 곳에서 이 대화를 옮기는 중이에요. 잠시 후 다시 해 주세요.', 'This conversation is being moved elsewhere. Try again in a moment.'), 'moving')
  }
  // the project no longer stands in it
  await q('update pro_threads set conversation_id=null where id=$1 and conversation_id=$2', [p.id, conv]).catch(() => {})
  await q('update pro_threads set updated_at=now() where id=$1', [main.id]).catch(() => {})
  emit(user.id, 'conversation.unmoved', { conv, to: main.id, project: { id: p.id, title: p.title }, ids, notes: [...noteIds], count: r.back })
  console.log(`[conv-move] conv=${conv.slice(0, 12)} ← project=${String(p.id).slice(0, 8)} messages=${r.back}`)
  return { back: r.back, topic: conv, to: main.id, project: { id: p.id, title: p.title }, ids, notes: [...noteIds] }
}

// ---------- 「새 프로젝트로」 ----------
// POST /api/conversations/:cid/move/offer → the confirm card of 「프로젝트로 시작」 (lib/chatProject.js — the name, the purpose, the template folders
// that fit, each with why), about this whole conversation and filed in it; its 「만들기」 makes the project and moves the conversation there.
export async function offerNew(user, cid) {
  const conv = validConv(cid)
  if (!conv) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const place = await placeOf(user, conv)
  if (place) throw fail(409, L(`이미 프로젝트 「${clip(place.project.title, 40)}」${ro(`「${clip(place.project.title, 40)}」`)} 옮긴 대화예요.`, `This conversation was already moved to the project "${clip(place.project.title, 40)}".`), 'moved', { place })
  const c = await inChat(user, conv)
  if (!c.count) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const why = refusal(c, user)
  if (why) throw why
  const CP = await import('./chatProject.js')
  return CP.offer(user, { threadId: c.main.id, via: 'move', move: { conversationId: conv, count: c.count, title: c.title, lastId: c.ids[c.ids.length - 1] } })
}

// ---------- by words: 「이 대화 프로젝트로 옮겨 줘」 ----------
// The chat's router picked move_to_project (lib/agent.js — the model reads the meaning, never a pattern of words): a card in the conversation
// (kind 'conv_move', filed aside in it — it goes along when it moves) that opens the same picker and the same notice before anything moves
// (components/ConvMoveCard.vue → ConversationMoveSheet.vue). The project the person named, if any, is read by the judge among the projects
// they may move it to (skills/chat-to-project prompts/pick-project.md, first-token odds — lib/decide.js choose), and only suggested.
// conversationId: the conversation the turn was pinned to (the page narrowed to one), else the one the chat is in.
export async function offerByWords(user, { threadId, conversationId = null, project = '', said = '' } = {}, deps = {}) {
  const { getThread } = await import('./store.js')
  const t = await getThread(user.id, threadId)
  if (!t) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  if (t.kind !== 'chat') {
    return addMessage(user.id, t.id, 'agent', 'text', { text: L('이 대화는 이미 프로젝트 안에 있어요. 채팅의 대화만 프로젝트로 옮길 수 있어요.', 'This conversation is already in a project. Only a conversation of the chat can be moved into one.') })
  }
  let conv = validConv(conversationId)
  if (!conv) {
    const rows = await q(`select m.id, m.role, m.kind, m.created_at, ${SLIM} as content from pro_messages m where m.thread_id=$1 order by m.created_at`, [t.id])
    const of = CV.convOf(rows, { briefId: await briefIdOf(user.id) })
    conv = validConv(CV.currentConversation(rows, of))
  }
  const c = conv ? await inChat(user, conv) : null
  if (!c?.count) {
    return addMessage(user.id, t.id, 'agent', 'text', { text: L('옮길 대화를 찾지 못했어요. 대화 목록에서 그 대화를 열고 「다른 대화 ▾」의 「프로젝트로 옮기기」를 눌러 주세요.', "I couldn't tell which conversation to move. Open it from the conversation list and press 「Move to a project」 under 「Other conversations ▾」.") })
  }
  const why = refusal(c, user)
  if (why && why.code === 'standing') return addMessage(user.id, t.id, 'agent', 'text', { text: why.message, context: { conversationId: conv, action: 'aside' } })
  const suggest = String(project || '').trim() ? await namedProject(user, { project, said, title: c.title }, deps).catch((e) => { console.warn('[conv-move] named project', e.message); return null }) : null
  console.log(`[conv-move] card conv=${conv.slice(0, 12)} named=${project ? 'yes' : 'no'} suggest=${suggest ? String(suggest.id).slice(0, 8) : '-'}`)
  return addMessage(user.id, t.id, 'agent', 'conv_move', {
    text: L('이 대화를 프로젝트로 옮길까요?', 'Move this conversation to a project?'),
    moveOf: { id: conv, title: clip(c.title, 120), count: c.count }, ...(suggest ? { suggest } : {}), state: 'offered',
    context: { conversationId: conv, action: 'aside' },
  })
}
// the project the person named, among the ones it may go to: the judge's reading (none below the skill's moveMinP) → {id, title} | null
async function namedProject(user, { project, said, title }, deps = {}) {
  const list = (await projectsOf(user)).filter((p) => p.writable).slice(0, 20)
  if (!list.length) return null
  const CP = await import('./chatProject.js')
  const sk = deps.skill || await CP.projectSkill()
  const isEn = (await import('./lang.js')).isEn
  const prompt = (isEn() && sk.prompts?.['pick-project-en']) || sk.prompts?.['pick-project'] || ''
  const min = Number(sk.rules?.move?.minP) || 0.7
  const { choose } = await import('./decide.js')
  const options = [...list.map((p) => ({ key: p.id, label: `「${clip(p.title, 60)}」${p.folder ? ` · ${clip(p.folder.name, 40)}` : ''}` })), { key: 'none', label: L('어느 프로젝트도 아니다', 'None of these projects') }]
  const state = [L(`사람이 한 말: ${clip(said, 300)}`, `What the person said: ${clip(said, 300)}`), L(`사람이 말한 프로젝트 이름: ${clip(project, 80)}`, `The project name the person said: ${clip(project, 80)}`),
    L(`옮길 대화: 「${clip(title, 80)}」`, `The conversation to move: "${clip(title, 80)}"`)].join('\n')
  const r = await choose(state, prompt, options, { ...(deps.odds ? { odds: deps.odds } : {}), ...(deps.json ? { json: deps.json } : {}), timeoutMs: Number(sk.rules?.move?.timeoutMs) || 6000, jsonTimeoutMs: Number(sk.rules?.move?.timeoutMs) || 6000 })
  if (!r || r.choice === 'none' || (r.confidence ?? 0) < min) return null
  const p = list.find((x) => x.id === r.choice)
  return p ? { id: p.id, title: p.title, p: Math.round((r.confidence || 0) * 1000) / 1000 } : null
}
// 「아니요」 on that card: it says so; nothing moves
export async function declineCard(user, cardId) {
  if (!UUID.test(String(cardId || ''))) throw fail(404, L('카드를 찾지 못했어요.', "I couldn't find that card."))
  const [m] = await q(`update pro_messages m set content = m.content || '{"state":"declined"}'::jsonb
    where m.id=$1 and m.kind='conv_move' and m.content->>'state'='offered' and exists (select 1 from pro_threads t where t.id=m.thread_id and t.user_id=$2) returning m.*`, [cardId, user.id])
  if (!m) throw fail(409, L('이미 답한 카드예요.', 'This card was already answered.'))
  emit(user.id, 'message', m)
  return { card: m }
}
