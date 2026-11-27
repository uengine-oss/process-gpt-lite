// 답을 공유 — 채팅의 글 답(파일이 아닌 결과)을 대화방 · 사람에게 보내거나, 문서로 남긴다 (2026-11-27 22:33 휴대폰 녹화: 「지금 보면 산출물 파일이 아니라
// 이렇게 그냥 이런 텍스트 결과가 나왔을 때 이것을 어딘가에 우리는 공유한다든지 하는 기능이 지금 존재하지 않아」 · 「대화방에 공유를 한다든지 … 공유 버튼
// 같은 게 좀 있어야 되겠지」). 스펙 openspec/specs/answer-share. 화면은 src/components/AnswerShareSheet.vue.
//   roomsFor     GET  /messages/:id/share/rooms       the picker: the owner's conversations (the ones an answer of this chat went to before first,
//                                                     with why) and the teammates with no conversation of two yet — as the mail's picker (lib/mailRooms.js)
//   shareToRoom  POST /messages/:id/share/room        {room | person, note} → the answer in that room as one message (kind 'answer':
//                                                     its title and its words — what the owner saw on screen, nothing more), the room's
//                                                     people told; a person: the conversation of two with them (made when there is none)
//   saveDoc      POST /messages/:id/share/doc         the answer as a Markdown file card under it (once): from then on the file's own share,
//                                                     download and IeumOffice open
// Who may get it is the messenger's rule (lib/team/messenger.js post · lib/team/access.js): a room the owner is in whose people are all still
// on the team, or a teammate of the same company — never oneself. The room sees the answer's words only: no file of the chat, no mail body,
// no address of the workspace. Where it went stays on the answer's own row (content.answerShares {<room>: {at, message}}, content.answerDoc).
import { q } from './supa.js'
import { emit } from './bus.js'
import { L } from './lang.js'
import { addMessage } from './store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
export const LIMITS = { note: 1000, text: 12000, title: 60 }
// an answer of the chat: the agent's words (a text answer, a document answer)
export const KINDS = ['text', 'doc']

// ---------- pure ----------
// a link into the agent's sandbox ("[견적서.xlsx](</workspace/…/견적서.xlsx>)") opens nothing outside the chat: its label stays (as on screen —
// src/components/Message.vue)
const SANDBOX_LINK = /\[([^\]\n]+)\]\(<?(?:sandbox:)?\/workspace\/[^)>\n]*>?\)/g
export const answerText = (msg) => String(msg?.content?.text || '').replace(SANDBOX_LINK, '$1').trim()
// the answer's title: a document answer's first line; a text answer's first heading or line, its marks taken off
export function titleOf(msg) {
  const t = answerText(msg)
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
  const head = msg?.kind === 'doc' ? lines[0] : lines.find((l) => /^#{1,6}\s/.test(l)) || lines[0]
  const plain = String(head || '').replace(/^#{1,6}\s*/, '').replace(/[*_`>|]/g, '').replace(/^[-+]\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
  return clip(plain, LIMITS.title) || L('AI 답', 'AI answer')
}
// the answer as the room reads it: the whole text (its title on top for a document answer — as it shows in the chat)
export const sharedText = (msg) => answerText(msg).slice(0, LIMITS.text)
// a file name for the answer's document: its title, without the characters a file name cannot hold
export function docName(msg) {
  const base = titleOf(msg).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/[.…]+$/, '').trim().slice(0, 50) || L('AI 답', 'AI answer')
  return `${base}.md`
}
// the Markdown file: a document answer is its text; a text answer gets its title as the heading when it has none
export function docBody(msg) {
  const t = answerText(msg)
  if (msg?.kind === 'doc') return `${/^#\s/.test(t) ? '' : '# '}${t}\n`
  return /^#{1,6}\s/.test(t) ? `${t}\n` : `# ${titleOf(msg)}\n\n${t}\n`
}

// The rooms in the order the picker shows them: a room an answer of this same chat went to before first (「지난번에도 이 대화의 답을 공유한 대화방」),
// then as the messenger lists them (newest first). → rooms with why · suggested
export function rankRooms(rooms, posted = []) {
  const before = new Set(posted.map(String))
  return rooms.map((r, order) => ({ r, order, score: before.has(String(r.id)) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ r, score }) => ({ ...r, why: score ? [{ kind: 'before', text: L('지난번에도 이 대화의 답을 공유한 대화방', 'Where answers of this chat went before') }] : [], suggested: score > 0 }))
}

// ---------- the answer ----------
// a message of mine (in a thread of mine) that is an agent's text or document answer with words in it
export async function answerOf(user, id) {
  if (!UUID.test(String(id || ''))) throw fail(404, L('답을 찾지 못했어요.', "I couldn't find that answer."))
  const [m] = await q(`select m.*, t.kind as thread_kind, t.title as thread_title from pro_messages m join pro_threads t on t.id=m.thread_id
                       where m.id=$1 and t.user_id=$2`, [id, user.id])
  if (!m) throw fail(404, L('답을 찾지 못했어요.', "I couldn't find that answer."))
  if (m.role !== 'agent' || !KINDS.includes(m.kind) || !answerText(m)) throw fail(400, L('글로 된 AI 답만 공유할 수 있어요.', 'Only an AI answer in words can be shared.'), 'not_answer')
  return m
}
// one key of the answer's content set, in one statement — the row back (emitted: the chat's card says where it went)
async function setIn(userId, id, path, value) {
  const [row] = await q(`update pro_messages set content = jsonb_set(jsonb_set(content, $2::text[], coalesce(content #> $2::text[], '{}'::jsonb)), $3::text[], $4::jsonb)
                         where id=$1 returning *`, [id, path.slice(0, 1), path, JSON.stringify(value)])
  if (row) emit(userId, 'message', row)
  return row
}
// the rooms answers of this chat went to before (other answers' records)
async function postedFrom(threadId) {
  const rows = await q(`select content->'answerShares' as s from pro_messages where thread_id=$1 and content ? 'answerShares' order by created_at desc limit 50`, [threadId])
  return [...new Set(rows.flatMap((r) => Object.keys(r.s || {})))]
}
// the rooms' names as the messenger names them for this person
async function titleOfRoom(M, user, roomId) {
  const list = await M.listThreads(user).catch(() => [])
  return list.find((r) => r.id === roomId)?.title || ''
}
// where this answer went: [{room, title, at}]
export async function sharedOf(user, msg, M = null) {
  const s = msg.content?.answerShares || {}
  const ids = Object.keys(s)
  if (!ids.length) return []
  const list = M ? await M.listThreads(user).catch(() => []) : []
  const titles = Object.fromEntries(list.map((r) => [r.id, r.title]))
  return ids.map((room) => ({ room, title: titles[room] || s[room]?.title || '', at: s[room]?.at || null })).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
}

// ---------- the picker ----------
// GET /messages/:id/share/rooms → {answer: {title, chars}, rooms, people, shared}
export async function roomsFor(user, id, deps = {}) {
  const msg = await answerOf(user, id)
  const M = deps.messenger || await import('./team/messenger.js')
  const [rooms, team, posted] = await Promise.all([M.listThreads(user), deps.team ? deps.team() : import('./team.js').then((t) => t.listTeam()), postedFrom(msg.thread_id)])
  const view = rooms.map((r) => ({ id: r.id, kind: r.kind, title: r.title, members: (r.members || []).map((m) => ({ id: m.id, name: m.name, email: m.email || null })), updatedAt: r.updatedAt }))
  const paired = new Set(view.filter((r) => r.kind === 'direct').flatMap((r) => r.members.map((m) => String(m.id))))
  const people = (team || []).filter((p) => String(p.id) !== String(user.id) && !paired.has(String(p.id))).map((p) => ({ id: String(p.id), name: p.name, email: p.email || null }))
  return { answer: { title: titleOf(msg), chars: sharedText(msg).length }, rooms: rankRooms(view, posted), people, shared: await sharedOf(user, msg, M) }
}

// ---------- sharing ----------
// POST /messages/:id/share/room {room | person, note} → {room: {id, title}, message, shared}
export async function shareToRoom(user, id, opts = {}, deps = {}) {
  const msg = await answerOf(user, id)
  const M = deps.messenger || await import('./team/messenger.js')
  const { isMember, TeamError } = await import('./team/access.js')
  let room
  if (opts.person) {
    const pid = String(opts.person)
    if (!UUID.test(pid) || pid === String(user.id) || !(await isMember(pid))) throw fail(403, L('같은 회사 팀원에게만 보낼 수 있어요.', 'You can send it only to teammates.'))
    room = await M.directThread(user, pid)
  } else room = await M.memberThread(user, String(opts.room || ''))
  if (!room) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."), 'not_in_room')
  const note = clean(opts.note).slice(0, LIMITS.note)
  const answer = { title: titleOf(msg), text: sharedText(msg), kind: msg.kind }
  let m
  try {
    // (every person in the room must still be on the team: the messenger refuses the post otherwise — nothing is sent)
    m = await M.post(user, room.id, { kind: 'answer', body: note, answer })
  } catch (e) { throw e instanceof TeamError ? fail(e.status || 400, e.message) : e }
  const title = room.title || await titleOfRoom(M, user, room.id)
  const row = await setIn(user.id, msg.id, ['answerShares', room.id], { at: new Date().toISOString(), message: m.id, ...(title ? { title: clip(title, 80) } : {}) })
  return { room: { id: room.id, title }, message: m.id, shared: await sharedOf(user, row || msg, M) }
}

// POST /messages/:id/share/doc → {message (the file card), existing}
// publish: the bytes into storage → {name, url} (lib/office.js publishBuffer; a test passes its own)
export async function saveDoc(user, id, deps = {}) {
  const msg = await answerOf(user, id)
  const had = msg.content?.answerDoc?.messageId
  if (had && UUID.test(String(had))) {
    const [f] = await q(`select * from pro_messages where id=$1 and thread_id=$2 and kind='file'`, [had, msg.thread_id])
    if (f) return { message: f, existing: true }
  }
  const publish = deps.publish || (await import('./office.js')).publishBuffer
  const name = docName(msg)
  const pub = await publish(user.id, name, Buffer.from(docBody(msg), 'utf8'))
  // (the card goes where the answer is: its conversation of the main chat too — aside, so it never moves the one the chat is in)
  const conv = msg.content?.context?.conversationId
  const card = await addMessage(user.id, msg.thread_id, 'agent', 'file', { name: pub.name || name, url: pub.url, type: 'text/markdown', fromAnswer: msg.id,
    ...(conv ? { context: { conversationId: String(conv), action: 'aside' } } : {}) })
  await setIn(user.id, msg.id, ['answerDoc'], { messageId: card.id, name: card.content.name, at: new Date().toISOString() })
  return { message: card, existing: false }
}
