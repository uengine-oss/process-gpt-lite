// 메일을 대화방에 (2026-11-27 사용자: 「메일이 왔을때 그걸 대화방에 공유하는 기능도 필요.」). 스펙 openspec/specs/mail-room-share.
// The mail sheet's 「대화방에 공유」 (always in the row — skills/mail-card-actions rules.json follow.actions `share`) opens a picker of the
// owner's conversations and teammates; the mail goes there as a mail mention (lib/mailMention.js: the colleagues see its summary — the
// sender, the subject, the date, the attachments' names — the body only when the owner shares it with that room, its files only when the
// owner shares them: lib/mailAttachments.js). Nothing is sent before 「보내기」.
//   roomsOfCard  GET  /actions/:id/rooms            the picker: the rooms, the likeliest first, each with why it is suggested —
//                  · the room the owner put this mail's thread in before, or a mail of the same sender or company (their cards' posts)
//                  · a room with someone who got the mail too (its To · Cc)
//                  · the judge's picks among the recent rooms (skills/mail-card-actions prompts/suggest-room.md — first-token odds,
//                    lib/decide.js chooseSome; kept on the card while the rooms are the same)
//                the teammates with no conversation with the owner yet, where the mail is shared now, and the 「앞으로 …」 choices
//   shareToRoom  POST /actions/:id/rooms            {room | person, note, body, files, follow} → the mail mention in that room
//   stopRoom     POST /actions/:id/rooms/:room/stop {what: body | files | follow}
//   autoShare    a mail arrives (lib/mail.js pollUser): the rules the owner set when sharing (「앞으로 … 메일도 이 방에 올리기」 — the same
//                thread, the same sender, the same company) post it to their rooms as the owner — its body when the rule says so, its files
//                never (their names only). A mail the triage made no Home card for gets a card already done (Home stays quiet; the room
//                message is the news, and its sheet opens from there).
// Everything stays on the owner's cards — the posts (source.room_posts {<room>: {at, message, auto?}}) and the rules (source.room_follow
// {<room>: {by, key, label, body, at}}); the body's share is mailMention's (source.mail_share), the files' mailAttachments' (source.att_share).
// Never on a message: a chats row is also written by process-gpt's own screen (PR #49 review).
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { L } from './lang.js'
import { chooseSome } from './decide.js'
import { cardSkill } from './mailCard.js'
import { followRules } from './mailFollow.js'
import * as MM from './mailMention.js'

const T = () => config.tenantId
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOM = /^[\w.:-]{1,120}$/
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const lower = (s) => String(s || '').trim().toLowerCase()
const round = (p) => (p == null ? null : Math.round(Number(p) * 1000) / 1000)
export const ROOM_DEFAULTS = { judgeRooms: 10, max: 2, minP: 0.3, cacheHours: 12, autoPerPoll: 20, noteChars: 1000 }
export const roomRules = (sk) => ({ ...ROOM_DEFAULTS, ...(sk?.rules?.rooms || {}) })
export const BY = ['thread', 'sender', 'domain']

// ---------- pure ----------
// a mail service's domain is many people's: it says nothing of a company
export const isPersonal = (domain, list = []) => !domain || list.map(lower).includes(lower(domain))
// the owner's own company (their sign-in's and mailbox's domains, and below them): 「같은 회사」 would be every colleague's mail — HR, payroll
// (PR #100 review) — so it is neither a rule nor a reason
export const isOwn = (domain, own = []) => !!domain && own.map(lower).filter(Boolean).some((d) => lower(domain) === d || lower(domain).endsWith(`.${d}`))
const companyOf = (domain, { personalDomains = [], ownDomains = [] } = {}) => (domain && !isPersonal(domain, personalDomains) && !isOwn(domain, ownDomains) ? lower(domain) : '')

// A rule's words, made when they are shown (in the reader's language — a rule keeps {by, key, name}, not words):
//   owner — the owner's sheet: the sender with their address
//   room  — what the room may read (the message, its members' notices): a name or the domain, never an address — the summary everyone sees
//           has none (PR #100 review)
export function ruleLabel(rule, { room = false } = {}) {
  if (rule?.by === 'thread') return L('이 메일 스레드의 다음 메일', 'the next mails of this thread')
  if (rule?.by === 'sender') {
    const key = String(rule.key || ''), name = clean(rule.name)
    const who = room ? name || key.split('@').pop() || L('그 보낸 사람', 'that sender') : name && lower(name) !== lower(key) ? `${name}(${key})` : key
    return L(`${who}에게서 오는 메일`, `mail from ${who}`)
  }
  if (rule?.by === 'domain') return L(`${rule.key}에서 오는 메일`, `mail from ${rule.key}`)
  return ''
}

// The 「앞으로 … 메일도 이 방에 올리기」 choices for one mail: its thread (a mailbox that keeps threads — Gmail), its sender, its company (another
// company's own domain — not a mail service's, not the owner's own) → [{by, key, name?, label}]
export function ruleChoices({ from, threadId } = {}, { personalDomains = [], ownDomains = [] } = {}) {
  const who = MM.senderOf(from)
  const out = []
  if (threadId) out.push({ by: 'thread', key: String(threadId) })
  if (who.address) out.push({ by: 'sender', key: lower(who.address), ...(who.name && who.name !== who.address ? { name: who.name } : {}) })
  const company = companyOf(who.domain, { personalDomains, ownDomains })
  if (company) out.push({ by: 'domain', key: company })
  return out.map((c) => ({ ...c, label: ruleLabel(c) }))
}
// the choice the sheet offers first: the company when there is one, else the sender (the thread is the narrowest)
export const firstChoice = (choices) => choices.find((x) => x.by === 'domain') || choices.find((x) => x.by === 'sender') || choices[0] || null

// does a rule take this arriving mail? m: {from, thread}
export function ruleTakes(rule, m) {
  if (!rule || !m) return false
  const who = MM.senderOf(m.from)
  if (rule.by === 'thread') return !!m.thread && String(m.thread) === String(rule.key)
  if (rule.by === 'sender') return !!who.address && lower(who.address) === lower(rule.key)
  if (rule.by === 'domain') return !!who.domain && (lower(who.domain) === lower(rule.key) || lower(who.domain).endsWith(`.${lower(rule.key)}`))
  return false
}

// the message an automatic post says (the rule's words for the room): 「ace.example에서 오는 메일은 이 방에 올리기로 했어요.」
export function autoNote(rule) {
  const t = ruleLabel(rule, { room: true })
  return L(`${t || '이 메일'}은 이 방에 올리기로 했어요.`, `${t ? `${t[0].toUpperCase()}${t.slice(1)}` : 'This mail'} goes to this room, as set.`)
}

// The rooms in the order the picker shows them, each with why it is suggested (nothing: it is only one of the owner's rooms).
//   rooms  [{id, title, kind, members: [{id, name, email}], updatedAt}] — the owner's conversations
//   posts  [{room, address, domain, thread}] — where the owner put their other mails
//   mail   {from, to, cc, threadId}
//   picks  [{key: <room id>, p}] — the judge's
export function rankRooms(rooms, { me = {}, mail = {}, posts = [], picks = [], personalDomains = [], ownDomains = [] } = {}) {
  const who = MM.senderOf(mail.from)
  const company = companyOf(who.domain, { personalDomains, ownDomains })
  const got = new Set([...(mail.to || []), ...(mail.cc || [])].map((x) => lower(MM.senderOf(x).address)).filter(Boolean))
  got.delete(lower(me.email))
  return rooms.map((r, order) => {
    const why = []
    let score = 0
    const mine = posts.filter((p) => p.room === r.id)
    if (mail.threadId && mine.some((p) => p.thread && String(p.thread) === String(mail.threadId))) { why.push({ kind: 'thread', text: L('이 메일 스레드를 올린 방', 'Where this thread went') }); score += 4 }
    else if (who.address && mine.some((p) => lower(p.address) === lower(who.address))) { why.push({ kind: 'sender', text: L(`지난번에도 ${who.name || who.address} 메일을 올린 방`, `Where ${who.name || who.address}'s mail went before`) }); score += 3 }
    else if (company && mine.some((p) => lower(p.domain) === company)) { why.push({ kind: 'company', text: L(`지난번에도 ${company} 메일을 올린 방`, `Where mail from ${company} went before`) }); score += 2.5 }
    const cc = (r.members || []).filter((m) => m.id !== me.id && m.email && got.has(lower(m.email)))
    if (cc.length) { why.push({ kind: 'cc', text: L(`메일을 같이 받은 ${cc.map((m) => m.name).join(', ')}님이 있어요`, `${cc.map((m) => m.name).join(', ')} got the mail too`) }); score += 2 }
    const pk = picks.find((x) => x.key === r.id)
    if (pk) { why.push({ kind: 'judge', text: L('이 메일과 닿는 이야기를 하는 방', 'Talks about what this mail is about') }); score += 1 + Number(pk.p || 0) }
    return { ...r, why, ...(pk ? { p: round(pk.p) } : {}), score, order }
  }).sort((a, b) => b.score - a.score || a.order - b.order).map(({ score, order, ...r }) => ({ ...r, suggested: score > 0 }))
}

// what the judge reads about one room (its name, its people, how it last spoke) and about the mail (as data)
export const roomLabel = (r, me = {}) => {
  const people = (r.members || []).filter((m) => m.id !== me.id).map((m) => m.name).filter(Boolean).slice(0, 6).join(', ')
  return [`「${clip(r.title, 40)}」`, people ? L(`사람: ${people}`, `people: ${people}`) : '', r.last?.body ? L(`최근 메시지: "${clip(r.last.body, 80)}"`, `last message: "${clip(r.last.body, 80)}"`) : ''].filter(Boolean).join(' · ')
}
export function mailState(card, mail, chars = 800) {
  const who = MM.senderOf(mail?.from || card?.source?.from)
  const atts = (mail?.attachments || []).map((a) => a?.name || String(a)).filter(Boolean)
  const body = clean(mail?.text || '').slice(0, chars)
  return [L('받은 메일:', 'The mail:'), `- ${L('보낸 사람', 'From')}: ${who.address ? `${who.name} <${who.address}>` : who.name}`,
    `- ${L('제목', 'Subject')}: ${clean(mail?.subject || card?.source?.subject)}`, atts.length ? `- ${L('첨부', 'Attachments')}: ${atts.join(', ')}` : '',
    body ? `- ${L('본문 앞부분', 'Start of the body')}: "${body}"` : ''].filter(Boolean).join('\n')
}

// ---------- the card ----------
async function cardFor(userId, id) {
  const [a] = UUID.test(String(id || '')) ? await q('select * from pro_actions where id=$1', [String(id)]) : []
  if (!a || a.status === 'deleted') throw fail(404, L('메일을 찾지 못했어요.', "I couldn't find that mail."))
  if (a.user_id !== userId) throw fail(403, L('다른 사람의 카드예요.', 'This card belongs to someone else.'), 'not_yours')
  if (!a.source?.mail_id) throw fail(400, L('메일에서 온 카드가 아니에요.', "This card didn't come from a mail."))
  return a
}
// one key of the card's source set (or taken away), in one statement — the row back
async function setIn(cardId, userId, path, value) {
  const [row] = value === undefined
    ? await q(`update pro_actions set source = source #- $3::text[] where id=$1 and user_id=$2 returning *`, [cardId, userId, path])
    : await q(`update pro_actions set source = jsonb_set(jsonb_set(source, $3::text[], coalesce(source #> $3::text[], '{}'::jsonb)), $4::text[], $5::jsonb)
               where id=$1 and user_id=$2 returning *`, [cardId, userId, path.slice(0, 1), path, JSON.stringify(value)])
  return row
}

// where the owner put their other mails (their cards' posts) → [{room, address, domain, thread}]
async function postsOf(userId, exceptId) {
  const rows = await q(`select id, source from pro_actions where user_id=$1 and id <> $2 and status <> 'deleted' and source ? 'room_posts' order by created_at desc limit 300`, [userId, exceptId])
  return rows.flatMap((c) => {
    const who = MM.senderOf(c.source?.from)
    return Object.keys(c.source.room_posts || {}).map((room) => ({ room, address: who.address, domain: who.domain, thread: c.source.thread_id || null }))
  })
}

// the rooms' names, as the messenger names them for this person (a room with no name: the other people, by the names every screen uses —
// lib/people.js, not Process GPT's username)
async function titlesOf(user, ids) {
  if (!ids.length) return {}
  const rows = await q('select id, name, participants from chat_rooms where id = any($1) and tenant_id=$2', [ids, T()])
  const others = (ps) => (Array.isArray(ps) ? ps : []).filter((p) => p && !p.is_agent && String(p.id) !== String(user.id))
  const { people } = await import('./people.js')
  const names = await people(rows.filter((r) => !r.name).flatMap((r) => others(r.participants).map((p) => String(p.id)))).catch(() => new Map())
  return Object.fromEntries(rows.map((r) => [r.id, r.name || others(r.participants).map((p) => names.get(String(p.id))?.name || p.username || p.email || '').filter(Boolean).join(', ')]))
}
// the owner's own domains: their sign-in's and their mailbox's
async function ownDomainsOf(user) {
  const [acc] = await q('select address from pro_mail_accounts where user_id=$1', [user.id]).catch(() => [])
  return [...new Set([user.email, acc?.address].map((a) => MM.senderOf(a || '').domain).filter(Boolean))]
}
// where this mail is shared now: [{room, title, at, body, files, follow, auto}]
export async function sharedOf(user, card) {
  const s = card.source || {}
  const files = (room) => Object.values(s.att_share || {}).filter((rooms) => rooms && rooms[room]).length
  const ids = [...new Set([...Object.keys(s.room_posts || {}), ...Object.keys(s.mail_share || {}), ...Object.keys(s.room_follow || {})])]
  const titles = await titlesOf(user, ids)
  // (a post a rule brought: is that rule still on — on the card that set it)
  const from = [...new Set(Object.values(s.room_posts || {}).map((p) => p?.auto?.card).filter((x) => UUID.test(String(x || ''))))]
  const rules = from.length ? Object.fromEntries((await q(`select id, source->'room_follow' as f from pro_actions where id = any($1::uuid[]) and user_id=$2 and status <> 'deleted'`, [from, user.id])).map((r) => [r.id, r.f || {}])) : {}
  return ids.map((room) => {
    const post = s.room_posts?.[room] || null
    const rule = s.room_follow?.[room] || null
    return { room, title: titles[room] || '', at: post?.at || s.mail_share?.[room]?.at || rule?.at || null, message: post?.message || null, body: MM.sharedWith(card, room), files: files(room),
      follow: rule ? { by: rule.by, label: ruleLabel(rule), body: !!rule.body } : null,
      auto: post?.auto ? { label: ruleLabel(post.auto), on: !post.auto.off && !!rules[post.auto.card]?.[room] } : null }
  }).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
}

// ---------- the picker ----------
const deciding = new Map()
// the judge's picks among the recent rooms → {picks, read} (kept on the card while the rooms are the same; nothing kept when it could not be read)
async function judged(user, card, mail, rooms, { sk, R, judges = {} }) {
  const cand = rooms.filter((r) => r.kind !== 'direct').slice(0, R.judgeRooms)
  if (!cand.length) return { picks: [], read: { by: 'none' } }
  const set = cand.map((r) => r.id).sort().join(',')
  const kept = card.source?.room_suggest
  if (kept?.rooms === set && Date.now() - new Date(kept.at || 0).getTime() < R.cacheHours * 3600_000) return { picks: kept.picks || [], read: kept.read || null }
  const key = `${T()}:${card.id}:${set}`
  if (!deciding.has(key)) {
    deciding.set(key, (async () => {
      const options = [...cand.map((r) => ({ key: r.id, label: roomLabel(r, user) })), { key: 'none', label: L('어느 방도 이 메일과 닿지 않는다', 'None of these rooms is about this mail') }]
      const F = followRules(sk)
      const r = await chooseSome(mailState(card, mail, F.judgeChars), sk.prompts['suggest-room'], options,
        { ...judges, answerJson: sk.prompts['answer-many-json'], timeoutMs: sk.rules.timeoutMs, max: R.max, min: R.minP }).catch((e) => { console.warn('[mail rooms] judge', e.message); return null })
      if (!r) return { picks: [], read: { by: 'fallback' } }
      const picks = r.picks.filter((x) => x.key !== 'none').map((x) => ({ key: x.key, p: round(x.p) }))
      const read = { by: r.strategy, model: r.model || null, skill: sk.version || null, at: new Date().toISOString() }
      // (the mailbox could not be read this time: shown, not kept)
      if (!mail.failed) await setIn(card.id, user.id, ['room_suggest'], { rooms: set, picks, read, at: read.at }).catch((e) => console.warn('[mail rooms] keep', e.message))
      return { picks, read }
    })().finally(() => deciding.delete(key)))
  }
  return deciding.get(key)
}

// GET /actions/:id/rooms → {rooms, people, shared, choices, choice, files, read}; only 'shared': where it is shared now, nothing asked
export async function roomsOfCard(user, actionId, deps = {}) {
  const card = await cardFor(user.id, actionId)
  if (deps.only === 'shared') return { shared: await sharedOf(user, card) }
  const sk = deps.skill || await cardSkill()
  const R = roomRules(sk)
  const F = followRules(sk)
  const M = deps.messenger || await import('./team/messenger.js')
  const [rooms, team, mail, posts] = await Promise.all([M.listThreads(user), deps.team ? deps.team() : import('./team.js').then((t) => t.listTeam()),
    deps.mail ? Promise.resolve(deps.mail) : MM.readMail(user.id, card), postsOf(user.id, card.id)])
  const view = rooms.map((r) => ({ id: r.id, kind: r.kind, title: r.title, members: (r.members || []).map((m) => ({ id: m.id, name: m.name, email: m.email || null })), updatedAt: r.updatedAt, last: r.last || null }))
  const { picks, read } = await judged(user, card, mail, view, { sk, R, judges: deps.judges })
  const ownDomains = await ownDomainsOf(user)
  const ranked = rankRooms(view, { me: user, mail: { from: mail.from || card.source.from, to: mail.to, cc: mail.cc, threadId: mail.threadId || card.source.thread_id }, posts, picks, personalDomains: F.personalDomains, ownDomains })
  // (teammates with a conversation of two already are found through it)
  const paired = new Set(view.filter((r) => r.kind === 'direct').flatMap((r) => r.members.map((m) => String(m.id))))
  const people = (team || []).filter((p) => String(p.id) !== String(user.id) && !paired.has(String(p.id))).map((p) => ({ id: String(p.id), name: p.name, email: p.email || null }))
  const choices = ruleChoices({ from: mail.from || card.source.from, threadId: mail.threadId || card.source.thread_id }, { personalDomains: F.personalDomains, ownDomains })
  return { rooms: ranked.map(({ last, ...r }) => ({ ...r, last: last ? { body: clip(last.body, 80), at: last.at } : null })), people, shared: await sharedOf(user, card),
    choices, choice: firstChoice(choices)?.by || null, files: (mail.attachments || []).length, read }
}

// ---------- sharing ----------
// POST /actions/:id/rooms {room | person, note, body, files, follow} → {room: {id, title}, message, shared}
//   room    a conversation the owner is in; person: a teammate — the conversation of two with them (made when there is none)
//   body    「본문도 공유」 — this room reads the body (lib/mailMention.js)
//   files   「첨부 파일도 공유」 — this room opens the attachments (lib/mailAttachments.js), each a mention of its own after the mail
//   follow  'thread' | 'sender' | 'domain' — 「앞으로 … 메일도 이 방에 올리기」 (with the body when body is on; the files never)
export async function shareToRoom(user, actionId, opts = {}, deps = {}) {
  const card = await cardFor(user.id, actionId)
  const M = deps.messenger || await import('./team/messenger.js')
  const { isMember, TeamError } = await import('./team/access.js')
  let room
  if (opts.person) {
    const pid = String(opts.person)
    if (!UUID.test(pid) || pid === user.id || !(await isMember(pid))) throw fail(403, L('팀원과만 대화할 수 있어요.', 'You can talk only with teammates.'))
    room = await M.directThread(user, pid)
  } else room = await M.memberThread(user, String(opts.room || ''))
  // (not in it — or no longer: an automatic rule for it is put away, lib/mailRooms.js autoShare)
  if (!room) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."), 'not_in_room')
  const sk = deps.skill || await cardSkill()
  const R = roomRules(sk)
  const mail = deps.mail || await MM.readMail(user.id, card)
  // the rule first (said before the mail goes: a choice this mail does not offer is refused, and nothing is sent)
  let rule = null
  if (opts.follow) {
    const c = ruleChoices({ from: mail.from || card.source.from, threadId: mail.threadId || card.source.thread_id }, { personalDomains: followRules(sk).personalDomains, ownDomains: await ownDomainsOf(user) })
      .find((x) => x.by === opts.follow)
    if (!c) throw fail(400, L('이 메일로는 그 약속을 정할 수 없어요.', "That rule can't be set from this mail."))
    // (its words are made when shown; the tenant it was set in is the only one it posts in)
    rule = { by: c.by, key: c.key, ...(c.name ? { name: c.name } : {}), body: opts.body === true, tenant: T(), at: new Date().toISOString() }
  }
  const atts = opts.files === true ? (mail.attachments || []).slice(0, 9) : []
  const refs = [{ type: 'mail', actionId: card.id, body: opts.body === true }, ...atts.map((a, i) => ({ type: 'mailatt', actionId: card.id, i, name: a.name || String(a), share: true }))]
  const FR = deps.fileRefs || await import('./fileRefs.js')
  // 「본문도 공유」 · 「첨부 파일도 공유」 are written on the card as the mention is made (forSend): when the message is not posted after all —
  // a member no longer on the team, a file that cannot be read — what this send turned on is turned off again (PR #100 review)
  const MA = await import('./mailAttachments.js')
  const before = { body: MM.sharedWith(card, room.id), files: atts.map((a, i) => MA.attSharedWith(card, i, room.id)) }
  const undo = async () => {
    if (opts.body === true && !before.body) await MM.setShare(user.id, card.id, room.id, false).catch((e) => console.warn('[mail rooms] undo body', e.message))
    for (const [i, was] of before.files.entries()) if (!was) await MA.setShare(user.id, card.id, i, room.id, false).catch(() => {})
  }
  const note = clean(opts.note).slice(0, R.noteChars)
  let m
  try {
    const kept = await FR.forSend(user, refs, { roomId: room.id, mail: deps.mail || mail })
    m = await M.post(user, room.id, { kind: 'mailref', body: note, refs: kept, ...(opts.auto ? { auto: { by: opts.auto.by, label: ruleLabel(opts.auto, { room: true }) } } : {}) })
  } catch (e) {
    await undo()
    throw e instanceof TeamError ? fail(e.status || 400, e.message) : e
  }
  const at = new Date().toISOString()
  let row = await setIn(card.id, user.id, ['room_posts', room.id], { at, message: m.id, ...(opts.auto ? { auto: opts.auto } : {}) })
  if (rule) row = await setIn(card.id, user.id, ['room_follow', room.id], rule)
  if (row) emit(user.id, 'action', row)
  return { room: { id: room.id, title: room.title || (await titlesOf(user, [room.id]))[room.id] || '' }, message: m.id, shared: await sharedOf(user, row || card) }
}

// POST /actions/:id/rooms/:room/stop {what} — the owner, from the sheet (in the room still or not any more):
//   body    the room no longer reads the body (its mentions there say so at once)
//   files   nor opens the attachments
//   follow  the mails that come no longer go there: this card's rule — or, on a mail an automatic post brought, the rule that brought it
export async function stopRoom(user, actionId, roomId, what) {
  const card = await cardFor(user.id, actionId)
  const room = String(roomId || '')
  if (!ROOM.test(room)) throw fail(400, L('대화방을 알 수 없어요.', "I don't know which room."))
  if (what === 'body') {
    await MM.setShare(user.id, card.id, room, false)
    // (this card's rule for the room no longer shares the bodies of the mails it brings either — PR #100 review)
    if (card.source?.room_follow?.[room]?.body) await setIn(card.id, user.id, ['room_follow', room, 'body'], false)
    const rows = await q(`select uuid, id, messages from chats where id=$1 and tenant_id=$2 and messages->'pgpt'->'refs' @> $3::jsonb`, [room, T(), JSON.stringify([{ type: 'mail', actionId: card.id }])]).catch(() => [])
    const { deliver } = await import('./team/messenger.js')
    for (const row of rows) {
      for (const [k, r] of (row.messages?.pgpt?.refs || []).entries()) {
        if (r?.type !== 'mail' || String(r.actionId) !== String(card.id) || String(r.owner) !== String(user.id)) continue
        await q(`update chats set messages = jsonb_set(messages, $2::text[], $3::jsonb) where uuid=$1 and tenant_id=$4`, [row.uuid, ['pgpt', 'refs', String(k)], JSON.stringify({ ...r, share: null, sharedAt: null }), T()])
      }
      await deliver(row.uuid)
    }
  } else if (what === 'files') {
    const MA = await import('./mailAttachments.js')
    for (const n of Object.keys(card.source?.att_share || {})) if (card.source.att_share[n]?.[room]) await MA.unshare(user, card.id, Number(n), room)
  } else if (what === 'follow') {
    const from = card.source?.room_posts?.[room]?.auto?.card
    const target = card.source?.room_follow?.[room] ? card.id : from && UUID.test(String(from)) ? String(from) : null
    if (!target) throw fail(404, L('이 방에 올리는 약속이 없어요.', "There's no such rule for this room."))
    const row = await setIn(target, user.id, ['room_follow', room], undefined)
    if (!row) throw fail(404, L('이 방에 올리는 약속이 없어요.', "There's no such rule for this room."))
    emit(user.id, 'action', row)
    // (the mail the rule brought keeps saying it came by a rule that is off now)
    if (target !== card.id) { const r2 = await setIn(card.id, user.id, ['room_posts', room, 'auto', 'off'], true); if (r2) emit(user.id, 'action', r2) }
  } else throw fail(400, L('무엇을 끌지 알 수 없어요.', "I don't know what to stop."))
  const [now] = await q('select * from pro_actions where id=$1', [card.id])
  return { shared: await sharedOf(user, now || card) }
}

// ---------- a mail arrives ----------
// the owner's rules in this tenant: [{card, room, by, key, name, body}] (a card has no tenant: a rule keeps the one it was set in — a poll in
// another tenant neither uses nor puts away the rules of this one, PR #100 review)
export async function rulesOf(userId) {
  const rows = await q(`select id, source from pro_actions where user_id=$1 and status <> 'deleted' and source ? 'room_follow' order by created_at desc limit 200`, [userId])
  const seen = new Set()
  const out = []
  for (const c of rows) {
    for (const [room, r] of Object.entries(c.source.room_follow || {})) {
      if (!r || !BY.includes(r.by) || !r.key || (r.tenant && r.tenant !== T())) continue
      const k = `${room}|${r.by}|${lower(r.key)}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ card: c.id, room, by: r.by, key: r.key, ...(r.name ? { name: r.name } : {}), body: r.body === true })
    }
  }
  return out
}

// lib/mail.js pollUser: the mails just arrived (not the owner's own) and the cards made of them. Each mail a rule takes goes to that rule's
// room, once per room, as the owner — at most rooms.autoPerPoll posts a poll (a flood guard: the ones over it are not posted). A rule whose
// room the owner is no longer in (or that is gone) is put away; any other failure (a member no longer on the team, the database) keeps it.
// → [{mail, room}]
export async function autoShare(userId, mails, cards = [], deps = {}) {
  const rules = await rulesOf(userId)
  if (!rules.length || !mails.length) return []
  const sk = deps.skill || await cardSkill()
  const R = roomRules(sk)
  const { person } = await import('./people.js')
  const p = await person(userId)
  const me = { id: userId, email: p?.email || null, name: p?.name || '' }
  const done = []
  // the mail as the poll read it (no second read of the mailbox): the shape lib/mailMention.js readMail gives
  const asRead = (m) => ({ from: m.from, to: m.to || [], cc: m.cc || [], date: m.date || null, subject: m.subject || '', text: m.text || '', attachments: m.attachments || [], threadId: m.thread || null })
  for (const m of mails) {
    if (done.length >= R.autoPerPoll) break
    const hits = rules.filter((r) => ruleTakes(r, m)).filter((r, i, all) => all.findIndex((x) => x.room === r.room) === i)
    if (!hits.length) continue
    let card = cards.find((c) => c.source?.mail_id === m.id)
      || (await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2 and status <> 'deleted' order by created_at limit 1`, [userId, m.id]))[0]
    if (!card) {
      // a mail with no Home card (the triage saw nothing to do): a card already done — the room's message opens its sheet
      ;[card] = await q(`insert into pro_actions(user_id,verb,text,icon,source,status) values ($1,'Review',$2,null,$3,'done') returning *`,
        [userId, clip(m.subject, 200) || L('(제목 없음)', '(no subject)'), { mail_id: m.id, from: m.from, subject: m.subject, ...(m.thread ? { thread_id: m.thread } : {}), by_rule: true }])
    }
    for (const r of hits) {
      if (done.length >= R.autoPerPoll) break
      if (r.card === card.id || card.source?.room_posts?.[r.room]) continue
      try {
        await (deps.share || shareToRoom)(me, card.id, { room: r.room, note: autoNote(r), body: r.body, auto: { card: r.card, by: r.by, key: r.key, ...(r.name ? { name: r.name } : {}) } },
          { ...deps, skill: sk, mail: asRead(m) })
        done.push({ mail: m.id, room: r.room })
      } catch (e) {
        if (e.code === 'not_in_room') await setIn(r.card, userId, ['room_follow', r.room], undefined).catch(() => {})
        console.warn('[mail rooms] auto', e.status || '', e.code || '', e.message)
      }
    }
  }
  return done
}
