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
// what leaves the chat: no workspace · host path, no signed or storage address (their names only — lib/hidePaths.js)
import { cleanShared } from './hidePaths.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
export const LIMITS = { note: 1000, text: 12000, title: 60 }
// an answer of the chat: the agent's words (a text answer, a document answer)
export const KINDS = ['text', 'doc']

// ---------- pure ----------
// the answer as it may leave the chat: a workspace or host path reads as its file name (a link keeps its label), a signed or storage address
// as its file's name (lib/hidePaths.js) — the room, a notice, the room list's line, a document and a project's first document alike
// (once per answer row — the picker asks its title, words, preview and length, the room's share its title and words: PR #122 review — again
// only when its text changed)
const cleaned = new WeakMap()
export function answerText(msg) {
  const raw = String(msg?.content?.text || '')
  const had = msg && typeof msg === 'object' ? cleaned.get(msg) : null
  if (had && had.raw === raw) return had.out
  const out = cleanShared(raw).trim()
  if (msg && typeof msg === 'object') cleaned.set(msg, { raw, out })
  return out
}
export const cleanedOnce = (msg) => cleaned.has(msg)
// the answer's title: a document answer's first line; a text answer's first heading or line, its marks taken off
export function titleOf(msg) {
  const t = answerText(msg)
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
  const head = msg?.kind === 'doc' ? lines[0] : lines.find((l) => /^#{1,6}\s/.test(l)) || lines[0]
  const plain = String(head || '').replace(/^#{1,6}\s*/, '').replace(/[*_`>|]/g, '').replace(/^[-+]\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
  return clip(plain, LIMITS.title) || L('AI 답', 'AI answer')
}
// the answer as the room reads it: the whole text (its title on top for a document answer — as it shows in the chat), cut at LIMITS.text —
// a longer one says so (truncated: the sheet before 보내기, the room's card)
export const sharedText = (msg) => answerText(msg).slice(0, LIMITS.text)
export const truncated = (msg) => answerText(msg).length > LIMITS.text
// the first lines as words (the sheet's preview of what goes): Markdown's marks off
export function previewOf(msg, n = 220) {
  const lines = answerText(msg).split('\n').map((l) => l.trim()).filter(Boolean).slice(msg?.kind === 'doc' ? 1 : 0, (msg?.kind === 'doc' ? 1 : 0) + 4)
  return lines.map((l) => l.replace(/^#{1,6}\s*|^>\s*/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')).join(' ').slice(0, n)
}
// a file name for the answer's document: its title, without the characters a file name cannot hold
export function docName(msg) {
  const base = titleOf(msg).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/[.…]+$/, '').trim().slice(0, 50) || L('AI 답', 'AI answer')
  return `${base}.md`
}
// the Markdown file: a document answer is its text; a text answer gets its title as the heading when it has none
export function docBody(msg) {
  const t = answerText(msg)
  // (a document answer that starts with a heading of any level keeps it — 「## X」 never becomes 「# ## X」)
  if (msg?.kind === 'doc') return `${/^#{1,6}\s/.test(t) ? '' : '# '}${t}\n`
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

// A claim on a row in one statement (PR #118 review 2: a transaction holding an advisory lock while its work went through the same pool froze the
// server at ten callers): an UPDATE … WHERE <free> — two at once serialize on the row and the second sees the first's claim. No connection is
// held while the work (a storage upload) runs.
export const CLAIM_STALE_S = 60
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const token = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
export const newToken = token
// waits for what another caller is making: until got() answers, or the claim is gone (free() — then the caller tries again)
export async function waitFor(got, { ms = 30_000, every = 150 } = {}) {
  const end = Date.now() + ms
  for (;;) {
    const v = await got()
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}
// Right before a message goes into the person's conversation (PR #118 follow-up), in one statement: the row the claim is on is still there,
// its conversation still the person's, the claim (content[key][field]) still this caller's and not finished (no content[key][done]) — and its
// clock (content[key].at) moves on, so nobody takes it over while the message goes in. No lock, no connection held. → true | false
export async function holdClaim(userId, rowId, { key, field, done }, mine) {
  const [r] = await q(`update pro_messages m set content = jsonb_set(m.content, array[$3::text, 'at'], to_jsonb(now()))
    where m.id=$1 and m.content->($3::text)->>($4::text) = $6::text and m.content->($3::text)->>($5::text) is null
      and exists (select 1 from pro_threads t where t.id = m.thread_id and t.user_id = $2) returning m.id`, [rowId, userId, key, field, done, String(mine)])
  return !!r
}
// A message into the person's conversation right after the re-check: a conversation deleted in between is refused by the database (its key) —
// that reads 404, as a conversation not found, not a server error (PR #122 review)
export async function addInto(userId, threadId, role, kind, content) {
  try {
    return await addMessage(userId, threadId, role, kind, content)
  } catch (e) {
    if (e?.code === '23503') throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."), 'gone')
    throw e
  }
}
// (with no claim to hold: the conversation is still the person's — the same statement addMessage makes next)
export async function stillTheirs(userId, threadId) {
  const [r] = await q('update pro_threads set updated_at=now() where id=$1 and user_id=$2 returning id', [threadId, userId])
  return !!r
}
// the conversation of the main chat (or the sub-topic of a project) a message belongs to: the one its turn went to (content.conv), else the
// context router's (content.context — a scheduled run's or a brief's own, filed aside)
export const convOfRow = (m) => (m?.content?.conv ? String(m.content.conv) : m?.content?.context?.conversationId ? String(m.content.context.conversationId) : null)
export const asideRow = (m) => m?.content?.context?.action === 'aside'

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
  return { answer: { title: titleOf(msg), chars: sharedText(msg).length, preview: previewOf(msg), truncated: truncated(msg), limit: LIMITS.text }, rooms: rankRooms(view, posted), people,
    shared: await sharedOf(user, msg, M) }
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
  const answer = { title: titleOf(msg), text: sharedText(msg), kind: msg.kind, ...(truncated(msg) ? { truncated: true } : {}) }
  let m
  try {
    // (every person in the room must still be on the team: the messenger refuses the post otherwise — nothing is sent)
    m = await M.post(user, room.id, { kind: 'answer', body: note, answer })
  } catch (e) { throw e instanceof TeamError ? fail(e.status || 400, e.message) : e }
  const title = room.title || await titleOfRoom(M, user, room.id)
  const row = await setIn(user.id, msg.id, ['answerShares', room.id], { at: new Date().toISOString(), message: m.id, ...(title ? { title: clip(title, 80) } : {}) })
  return { room: { id: room.id, title }, message: m.id, shared: await sharedOf(user, row || msg, M) }
}

// the claim 「문서로 남기기」 holds on the answer's row: content.answerDoc {pending: token, at} until its card is there (messageId)
const DOC_CLAIM = { key: 'answerDoc', field: 'pending', done: 'messageId' }
// POST /messages/:id/share/doc → {message (the file card), existing}
// publish: the bytes into storage → {name, url} (lib/office.js publishBuffer; a test passes its own)
export async function saveDoc(user, id, deps = {}) {
  const msg = await answerOf(user, id)
  const current = async () => (await q(`select content->'answerDoc' as d from pro_messages where id=$1`, [msg.id]))[0]?.d || null
  const cardOf = async (d) => {
    if (!d?.messageId || !UUID.test(String(d.messageId))) return null
    const [f] = await q(`select * from pro_messages where id=$1 and thread_id=$2 and kind='file'`, [d.messageId, msg.thread_id])
    return f || null
  }
  for (let round = 0; round < 3; round++) {
    const had = await cardOf(await current())
    if (had) return { message: had, existing: true }
    // (one document per answer: the first caller claims the answer's row — a claim nobody finished for a minute is free again)
    const mine = token()
    const [claimed] = await q(`update pro_messages set content = jsonb_set(content, '{answerDoc}', jsonb_build_object('pending', $2::text, 'at', now()))
      where id=$1 and (not (content ? 'answerDoc') or (content->'answerDoc'->>'messageId' is null
        and coalesce((content->'answerDoc'->>'at')::timestamptz, to_timestamp(0)) < now() - make_interval(secs => $3))) returning id`, [msg.id, mine, CLAIM_STALE_S])
    if (!claimed) {
      // another caller is making it: its card, once it is there
      const got = await waitFor(async () => { const d = await current(); return (await cardOf(d)) || (!d || (!d.messageId && !d.pending) ? 'free' : null) })
      if (got && got !== 'free') return { message: got, existing: true }
      continue
    }
    const release = () => q(`update pro_messages set content = content - 'answerDoc' where id=$1 and content->'answerDoc'->>'pending' = $2`, [msg.id, mine]).catch(() => {})
    let card = null
    try {
      // (the upload runs with no connection held — outside any transaction)
      const publish = deps.publish || (await import('./office.js')).publishBuffer
      const name = docName(msg)
      const pub = await publish(user.id, name, Buffer.from(docBody(msg), 'utf8'))
      // (right before the card goes in: the answer's conversation still mine, the claim still this caller's — PR #118 follow-up)
      if (await holdClaim(user.id, msg.id, DOC_CLAIM, mine)) {
        // (the card goes where the answer is: its conversation of the main chat too — aside, so it never moves the one the chat is in)
        const conv = convOfRow(msg)
        card = await addInto(user.id, msg.thread_id, 'agent', 'file', { name: pub.name || name, url: pub.url, type: 'text/markdown', fromAnswer: msg.id,
          ...(conv ? { context: { conversationId: conv, action: 'aside' } } : {}) })
        const [row] = await q(`update pro_messages set content = jsonb_set(content, '{answerDoc}', $3::jsonb) where id=$1 and content->'answerDoc'->>'pending' = $2 returning *`,
          [msg.id, mine, JSON.stringify({ messageId: card.id, name: card.content.name, at: new Date().toISOString() })])
        if (row) emit(user.id, 'message', row)
      }
    } catch (e) {
      await release()
      throw e
    }
    if (card) return { message: card, existing: false }
    // no card from this caller: the answer or its conversation is no longer mine (404 — and the claim let go), or another caller took the claim
    // over meanwhile (its card: the next round)
    await release()
    await answerOf(user, id)
  }
  throw fail(409, L('문서를 남기고 있어요. 잠시 후 다시 해 주세요.', "It's being saved. Please try again in a moment."), 'busy')
}
