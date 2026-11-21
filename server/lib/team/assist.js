// Team assist (팀 대화 속 에이전트 제안) — process-gpt's "ProcessGPT active" chat assist, inherited.
// process-gpt (frontend WorkAssistantGenerator.js) classifies every chat message with gpt-4o into a work
// (CreateProcessDefinition / StartProcessInstance / CompanyQuery …), proposes it in the room and starts it.
// Here the same propose → start flow; what a message means is read by a model only (decision 2, 2026-11-21):
//   1. format: no judging of an empty, emoji- or jamo-only message, or one with a single letter
//   2. (optional) embeddings: a message far from every offer in the catalog is not judged — on only with
//      a threshold calibrated on the held-out set (PRO_ASSIST_EMBED_MIN; scripts in server/test/eval)
//   3. the judge, once: which offer the message asks for, or none (lib/judge.js: the judge server, else
//      the fast LLM — it also writes the card's title). The offers are skill descriptions
//      (lib/offers.js, skills/offers/*), not a list in this file
//   4. StartProcessInstance: which registered proc_def (the judge, among the nearest by embeddings, else
//      all of them)
// The big agent model is never called to detect. Nothing runs until a person in the room presses 시작;
// then it runs as that person, through process-gpt's chat-room path (deepagents /chat/stream with the room
// as conversation_id), so the answer lands in the room like any agent reply in process-gpt.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { TeamError } from './access.js'
import * as S from './shares.js'
import * as M from './messenger.js'
import { L, withLang, langOf } from '../lang.js'
import { judge as askJudge, judgeAvailable } from '../judge.js'
import { offers, offerOf } from '../offers.js'
import * as EM from '../embed.js'

const T = () => config.tenantId
const ON = () => process.env.PRO_TEAM_ASSIST !== '0'
const DEBOUNCE_MS = Number(process.env.PRO_ASSIST_DEBOUNCE_MS || 1200)
// the judge's pick must hold at least this much of its probability (the LLM's stated confidence; set on
// the dev set: requests came at 0.82 and above, false offers below — server/test/eval/results)
const MIN_P = Number(process.env.PRO_ASSIST_MIN_P || 0.8)
const MIN_PROC = 0.6
// stage 2: the least cosine to the nearest offer for a message to be judged; unset = no embedding gate
const EMBED_MIN = () => (process.env.PRO_ASSIST_EMBED_MIN ? Number(process.env.PRO_ASSIST_EMBED_MIN) : null)

// ---- stage 1: format only (what the characters are, never what the words say) ----
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{P}\p{S}\s]*$/u
// Hangul compatibility jamo alone (ㅋㅋ, ㅠㅠ, ㅇㅋ) are a reaction, like an emoji
const JAMO_ONLY = /^[\u3131-\u318E\p{P}\p{S}\s]*$/u
const BARE_URL = /^https?:\/\/\S+$/i
const letters = (t) => (t.match(/[\p{L}\p{N}]/gu) || []).length
export function formatGate(body) {
  const t = String(body || '').replace(/\s+/g, ' ').trim()
  if (!t) return { pass: false, why: 'empty' }
  if (EMOJI_ONLY.test(t) || JAMO_ONLY.test(t)) return { pass: false, why: 'emoji' }
  if (BARE_URL.test(t)) return { pass: false, why: 'link' }
  if (letters(t) < 2) return { pass: false, why: 'short' }
  return { pass: true }
}

// the offers a room message may get (skills/offers/*): starting a process only where processes exist
async function teamOffers() {
  const all = offers('team')
  const [{ n } = { n: 0 }] = await q(`select count(*)::int as n from proc_def where tenant_id=$1 and coalesce(isdeleted,false)=false and name is not null`, [T()]).catch(() => [{ n: 0 }])
  return n ? all : all.filter((o) => o.key !== 'StartProcessInstance')
}
const NONE = () => ({ key: 'none', label: L('위의 어느 일도 부탁하지 않는 말: 인사·감사·잡담·의견·소식 전하기, 사람에게 그 사람의 생각이나 사정을 묻는 말, 방 사람이 바로 답하면 되는 짧은 질문, 스스로 하겠다는 말',
  'Asks for none of the work above: greetings, thanks, small talk, opinions or news, asking a person what they think or how things are, a quick question someone in the room can just answer, or saying one will do it oneself') })

// ---- counters (GET /api/team/assist/stats) ----
// the judge server, else the LLM (lib/judge.js)
export const judgeConfigured = () => judgeAvailable()
export const stats = { messages: 0, prefiltered: {}, judged: 0, suggested: 0, judgeMs: [], detectMs: [], judgeErrors: 0, bigModelCalls: 0, started: 0 }
const count = (why) => { stats.prefiltered[why] = (stats.prefiltered[why] || 0) + 1 }
const keep = (list, v) => { list.push(v); if (list.length > 200) list.shift() }

async function judge(state, question, options, also) {
  const j = await askJudge({ state: state.slice(-1400), question, options, also })
  stats.judged++; keep(stats.judgeMs, j.ms)
  return j
}

// the minimal excerpt: the last few messages of the room, names and text only (no file contents, no ids,
// at most 200 characters a line)
async function excerpt(roomId, uuid) {
  const rows = await q(`select messages from chats where id=$1 and coalesce(public.pro_chat_ts(messages), now()) <=
                          coalesce((select public.pro_chat_ts(messages) from chats where uuid=$2), now())
                        order by coalesce(public.pro_chat_ts(messages), now()) desc limit 4`, [roomId, uuid])
  return rows.reverse().map(({ messages: m }) => `${m.userName || m.name || L('팀원', 'Teammate')}: ${(m.role === 'assistant' ? L('(에이전트) ', '(agent) ') : '') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}${(m.pgpt?.artifacts || []).length ? L(` [첨부: ${m.pgpt.artifacts.map((a) => a.name).join(', ')}]`, ` [attached: ${m.pgpt.artifacts.map((a) => a.name).join(', ')}]`) : ''}`)
}

// who is offered it: the people asked — members named in the message, else everyone in the room but its author
function audienceOf(humans, authorId, body) {
  const others = humans.filter((m) => m.id !== authorId)
  const named = namedIn(others, body)
  return (named.length ? named : others).map((m) => m.id)
}
// The members a message names. A Korean name: in full or by its given name (김민지 → 민지), as before.
// A name in Latin letters ("Minji Kim"): in full in any case, or by one of its parts as a word of its
// own — the given name ("Minji", "minji님") or the family name ("Kim"). A full name that was found
// is taken out first, so "Minji Kim" does not also name Jiho Kim by "Kim".
const LATIN = /[A-Za-z]/
const word = (part) => new RegExp(`(?<![A-Za-z0-9])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i')
export function namedIn(members, body) {
  const text = String(body || '')
  const found = new Set()
  let rest = text
  for (const m of [...members].filter((x) => x.name && LATIN.test(x.name)).sort((a, b) => b.name.length - a.name.length)) {
    const full = word(m.name.trim().replace(/\s+/g, ' ')).source.replace(/ /g, '\\s+')
    const re = new RegExp(full, 'gi')
    if (re.test(rest)) { found.add(m); rest = rest.replace(re, ' ') }
  }
  return members.filter((m) => {
    if (!m.name || m.name.length < 2) return false
    if (!LATIN.test(m.name)) return text.includes(m.name) || text.includes(m.name.slice(1))
    if (found.has(m)) return true
    return m.name.trim().split(/[\s.·-]+/).filter((p) => p.length >= 2).some((p) => word(p).test(rest))
  })
}

// StartProcessInstance's shortlist for the judge: the registered processes nearest to the request by
// embeddings, or (no embeddings) all of them up to a cap — the judge reads the names, nothing here does
const PROC_CAP = 40
export async function processCandidates(body) {
  const defs = await q(`select id, name from proc_def where tenant_id=$1 and coalesce(isdeleted,false)=false and name is not null
                        order by coalesce(updated_at, now()) desc limit 200`, [T()])
    .catch(() => q(`select id, name from proc_def where tenant_id=$1 and coalesce(isdeleted,false)=false and name is not null limit 200`, [T()]).catch(() => []))
  if (defs.length <= 6) return defs
  const r = await EM.rank(body, defs.map((d) => ({ key: d.id, text: d.name })), 6)
  return r ? r.map((x) => defs.find((d) => d.id === x.key)) : defs.slice(0, PROC_CAP)
}

const timers = new Map()
const recent = new Map() // roomId -> [timestamps]
const LIMIT_HOUR = 6

// every chats row a person writes, from any UI (messenger.js room feed)
export function watchRooms() {
  if (watchRooms.on) return
  watchRooms.on = true
  M.onChat(async (row, humans) => {
    const m = row.messages || {}
    if (m.role !== 'user' || m.pgpt?.kind === 'assist' || m.__hidden) return
    const author = humans.find((h) => h.id === m.userId || h.email === m.email)
    if (!author) return // a system or agent row
    stats.messages++
    if (!ON()) return count('tenant-off')
    const pf = formatGate(m.content)
    if (!pf.pass) return count(pf.why)
    // no judge server and no LLM (lib/judge.js): no suggestions
    if (!judgeAvailable()) return count('no-judge')
    clearTimeout(timers.get(row.id))
    // the latest message of a burst is judged with the ones before it
    timers.set(row.id, setTimeout(() => {
      timers.delete(row.id)
      detect(row, humans, author).catch((e) => { stats.judgeErrors++; console.warn('[assist]', e.message) })
    }, DEBOUNCE_MS))
  })
}

// the card is written in the language of the person whose message it answers (lib/lang.js)
export async function detect(row, humans0, author, opts) {
  return withLang(await langOf(author.id), () => detectIn(row, humans0, author, opts))
}
// What the judge reads: the room's last lines with the new message apart from them. A message in any
// language is read as written (the model reads it; the card's title comes out in the card's language).
export function judgeState(lines) {
  const prev = lines.slice(0, -1)
  return L(`${prev.length ? `앞선 대화:\n${prev.join('\n')}\n\n` : ''}방금 온 메시지:\n${lines[lines.length - 1]}`,
    `${prev.length ? `Earlier messages:\n${prev.join('\n')}\n\n` : ''}New message:\n${lines[lines.length - 1]}`)
}
const top = (j) => Object.entries(j?.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || [null, 0]
const cardTitle = (t) => String(t || '').replace(/[\r\n]+/g, ' ').replace(/^["'「『]+|["'」』]+$/g, '').trim().slice(0, 40)

// One message → {work, p, title, proc, ms, model} or {none, why}: the same stages the room feed runs,
// without the database writes (also what server/test/eval runs). lines: the room's last lines, the new
// message last (the excerpt's shape — it is added when it is not there); opts: {offers, processes(body)}
export async function classify(lines0, body, { offers: opts, processes = processCandidates } = {}) {
  const lines = lines0.length && String(lines0[lines0.length - 1]).includes(String(body).replace(/\s+/g, ' ').slice(0, 200)) ? lines0 : [...lines0, String(body).replace(/\s+/g, ' ').slice(0, 200)]
  const pf = formatGate(body)
  if (!pf.pass) return { none: true, why: pf.why }
  const list = opts || await teamOffers()
  const min = EMBED_MIN()
  if (min != null) {
    const near = await EM.nearest(body, list.map((o) => o.label))
    if (near != null && near < min) return { none: true, why: 'far', sim: near }
  }
  const state = judgeState(lines)
  const j = await judge(state, L('방금 온 메시지가 AI 에이전트에게 맡길 수 있는 일을 부탁하나요? 바라는 것을 말하거나 돌려 말한 부탁도 부탁입니다. 부탁한다면 어떤 일인가요?', 'Does the new message ask for work an AI agent could do? A wish or a request put indirectly counts too. If so, which?'),
    [NONE(), ...list.map((o) => ({ key: o.key, label: o.label }))],
    { title: L('제안 카드 제목: 무엇을 만들거나 할지 한국어 25자 이내 (none 이면 빈 문자열)', 'suggestion card title: what will be made or done, in English, at most 40 characters (empty for none)') })
  let [work, p] = top(j)
  let ms = j.ms
  if (!work || work === 'none' || p < MIN_P) return { none: true, why: work === 'none' ? 'judge-none' : 'judge-unsure', p, ms, model: j.model }
  // StartProcessInstance against proc_def, as process-gpt does (a sheet or a document may be what a
  // registered process makes): the judge picks one of the registered processes or none
  let proc = null
  if (['StartProcessInstance', 'CreateSpreadsheet', 'CreateDocument'].includes(work)) {
    const cands = (await processes(body).catch(() => [])).filter(Boolean)
    if (cands.length) {
      const pj = await judge(lines[lines.length - 1], L('이 요청이 시작해 달라는 등록된 업무 프로세스는?', 'Which registered business process does this request ask to start?'),
        [{ key: 'none', label: L('등록된 프로세스를 시작해 달라는 요청이 아님', 'It does not ask to start a registered process') }, ...cands.map((d) => ({ key: d.id, label: d.name }))]).catch(() => null)
      if (pj) ms += pj.ms
      const [best, bp] = top(pj)
      if (best && best !== 'none' && bp >= MIN_PROC) { proc = cands.find((d) => d.id === best); work = 'StartProcessInstance' }
    }
  }
  if (work === 'StartProcessInstance' && !proc) work = 'CompanyQuery'
  const title = proc ? L(`${proc.name} 시작하기`, `Start ${proc.name}`) : cardTitle(j.extra?.title) || offerOf(work)?.title || L('도와 드리기', 'Help with this')
  return { work, p, title, proc, ms, model: j.model }
}

async function detectIn(row, humans0, author) {
  const t0 = Date.now()
  const roomId = row.id, said = String(row.messages.content || '')
  const [room] = await q('select context from chat_rooms where id=$1 and tenant_id=$2', [roomId, T()])
  if (!room) return
  if (room.context?.pgpt?.assist === false) return count('room-off')
  const [seen] = await q('select 1 from pro_room_suggestions where chat_uuid=$1', [row.uuid])
  if (seen) return count('cached')
  const now = Date.now()
  const list = (recent.get(roomId) || []).filter((x) => now - x < 3600000)
  if (list.length >= LIMIT_HOUR) return count('room-rate')
  const lines = await excerpt(roomId, row.uuid)
  if (!lines.length) return
  const r = await classify(lines, said)
  if (r.none) { console.log(`[assist] ${r.why}${r.ms ? ` ${r.ms}ms` : ''} · ${said.slice(0, 40)}`); return count(r.why) }
  const { work, p, title, proc, ms } = r
  const humans = humans0.map((h) => ({ id: h.id, name: h.username || h.name, email: h.email }))
  const audience = audienceOf(humans, author.id, said)
  if (!audience.length) return count('no-audience')
  const who = author.username || author.name || L('팀원', 'Teammate')
  // (the request in its writer's own words)
  const reason = L(`${who}님의 요청 "${said.replace(/\s+/g, ' ').slice(0, 60)}${said.length > 60 ? '…' : ''}" · 판단 모델 ${Math.round(p * 100)}%`,
    `${who}'s request "${said.replace(/\s+/g, ' ').slice(0, 60)}${said.length > 60 ? '…' : ''}" · routing model ${Math.round(p * 100)}%`)
  const [s] = await q(`insert into pro_room_suggestions(tenant_id,room_id,chat_uuid,work,title,reason,process_id,audience,judge)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (chat_uuid) do nothing returning *`,
  [T(), roomId, row.uuid, work, title, reason, proc?.id || null, audience, { p: Math.round(p * 100) / 100, ms, model: r.model }])
  if (!s) return count('cached')
  list.push(now); recent.set(roomId, list)
  stats.suggested++; keep(stats.detectMs, Date.now() - t0)
  for (const h of humans) emit(h.id, 'team', { type: 'assist', threadId: roomId, suggestion: view(h.id, s) })
  console.log(`[assist] suggested in ${Date.now() - t0}ms (judge ${ms}ms) · ${work} · ${title}`)
}

// what one person sees: open suggestions only if offered to them and not dismissed; running and finished
// ones (who started it, the result) to everyone in the room
export function view(viewerId, s) {
  const offered = s.audience.includes(viewerId) && !s.dismissed.includes(viewerId)
  // a meeting's suggestions hang under the room row they came from (회의록 block / minutes: anchor_uuid)
  const messageId = s.anchor_uuid || s.chat_uuid
  if (s.state === 'open' && !offered) return { id: s.id, threadId: s.room_id, messageId, hidden: true }
  return { id: s.id, threadId: s.room_id, messageId, meetingId: s.meeting_id || null, work: s.work, kind: offerOf(s.work)?.badge || L('도움', 'Help'), title: s.title, reason: s.reason, state: s.state,
    startedBy: s.started_by, resultMessageId: s.result_uuid, mine: s.started_by === viewerId, canStart: offered && ['open', 'failed'].includes(s.state), judge: s.judge }
}

export async function list(me, roomId) {
  const t = await M.memberThread(me, roomId)
  if (!t) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const rows = await q('select * from pro_room_suggestions where room_id=$1 order by created_at desc limit 50', [t.id])
  return { assist: t.assist, enabled: ON(), suggestions: rows.map((s) => view(me.id, s)).filter((v) => !v.hidden) }
}

// the room's switch lives with the room (chat_rooms.context.pgpt.assist), like process-gpt's ProcessGPT-active
export async function setThreadAssist(me, roomId, on) {
  const t = await M.memberThread(me, roomId)
  if (!t) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  await q(`update chat_rooms set context = jsonb_set(coalesce(context,'{}'::jsonb), '{pgpt}', coalesce(context->'pgpt','{}'::jsonb) || jsonb_build_object('assist', $2::boolean)) where id=$1`, [t.id, !!on])
  for (const m of await M.membersOf(t.id)) emit(m.id, 'team', { type: 'assist-toggle', threadId: t.id, on: !!on, by: me.name })
  return { assist: !!on }
}

async function own(me, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null
  const [s] = await q('select * from pro_room_suggestions where id=$1 and tenant_id=$2', [id, T()])
  if (!s || !(await M.memberThread(me, s.room_id))) return null
  return s
}

export async function dismiss(me, id) {
  const s = await own(me, id)
  if (!s) throw new TeamError(404, L('제안을 찾지 못했어요.', "I couldn't find that suggestion."))
  await q(`update pro_room_suggestions set dismissed = array(select distinct unnest(dismissed || $2::uuid)), updated_at=now() where id=$1`, [s.id, me.id])
  return { ok: true }
}

async function broadcast(s) {
  for (const m of await M.membersOf(s.room_id)) emit(m.id, 'team', { type: 'assist', threadId: s.room_id, suggestion: view(m.id, s) })
}

// 시작: claim it (first click wins), then run as this person in the background
export async function start(me, id, run) {
  const s = await own(me, id)
  if (!s) throw new TeamError(404, L('제안을 찾지 못했어요.', "I couldn't find that suggestion."))
  if (!s.audience.includes(me.id)) throw new TeamError(403, L('이 제안은 요청받은 분이 시작할 수 있어요.', 'Only the people asked can start this suggestion.'))
  // a failed one can be tried again (its card says 다시 시도 — 2026-11-18, a meeting's action items failed in
  // production before the cause was fixed, and nothing could start them again)
  const [c] = await q(`update pro_room_suggestions set state='running', started_by=$2, updated_at=now() where id=$1 and state in ('open','failed') returning *`, [s.id, me.id])
  if (!c) throw new TeamError(409, L('이미 시작된 제안이에요.', 'This suggestion has already been started.'))
  stats.started++
  await broadcast(c)
  run(c).then(async (resultUuid) => {
    const [d] = await q(`update pro_room_suggestions set state='done', result_uuid=$2, updated_at=now() where id=$1 returning *`, [c.id, resultUuid || null])
    await broadcast(d)
  }).catch(async (e) => {
    console.warn('[assist] run', e.message)
    const [f] = await q(`update pro_room_suggestions set state='failed', updated_at=now() where id=$1 returning *`, [c.id])
    await broadcast(f)
  })
  return view(me.id, c)
}

// the work order for the person's agent: the room excerpt and the files in it they may open
export async function workOrder(me, s) {
  // from a meeting (lib/meetings): its transcript and the files shown there, not the room's messages
  if (s.meeting_id) return (await import('../meetings/order.js')).meetingOrder(me, s)
  const lines = await excerpt(s.room_id, s.chat_uuid)
  const rows = await q(`select messages from chats where id=$1 and messages ? 'pgpt' order by coalesce(public.pro_chat_ts(messages), now()) desc limit 6`, [s.room_id])
  const shareIds = rows.flatMap(({ messages: m }) => S.viewArtifacts(me.id, m.pgpt?.by || m.userId, m.pgpt?.artifacts).map((a) => a.shareId)).filter(Boolean)
  const files = shareIds.length ? await S.copiesFor(me, [...new Set(shareIds)].slice(0, 4)) : []
  return { lines, files }
}
