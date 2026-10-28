// Remote meetings in a team room (회의) — the meeting's life, its people, signalling and the assistant.
//   topology  browser WebRTC mesh (≤ MAX people); offers/answers/ICE go through this server and reach the
//             other person on the event stream they already have open (lib/bus.js: SSE or long poll)
//   access    every call: the caller is one of the room's people (messenger.memberThread) and, for media
//             and audio, an active participant of this meeting; signals only between two participants
//   assistant each person's browser sends its own speech (말 단위 WAV); transcribe.js turns it into a line
//             with that person as the speaker; record.js writes it into the room's 회의록 block; intent.js
//             looks for materials and requests (rules → judge, debounced, no big model)
//   end       last person out (or 회의 끝내기, or nobody seen for STALE_S) → minutes.js writes the minutes
// Switches: PRO_MEETINGS=0 (no meetings), PRO_MEETING_AGENT=0 (video only), per room
// chat_rooms.context.pgpt.meetingAgent=false.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { TeamError } from '../team/access.js'
import * as M from '../team/messenger.js'
import * as A from '../team/assist.js'
import * as R from './record.js'
import * as I from './intent.js'
import * as MAT from './materials.js'
import { transcribe, wavMs, transcribeConfigured } from './transcribe.js'
import { finalize } from './minutes.js'
import { L, isEn, lang, withLang } from '../lang.js'

const T = () => config.tenantId
export const enabled = () => process.env.PRO_MEETINGS !== '0'
export const agentEnabled = () => process.env.PRO_MEETING_AGENT !== '0'
export const MAX = Number(process.env.PRO_MEETING_MAX || 6)
const STALE_S = Number(process.env.PRO_MEETING_STALE_S || 45)
const UUID = /^[0-9a-f-]{36}$/i
export function ice() {
  try { const v = JSON.parse(process.env.PRO_MEETING_ICE || ''); if (Array.isArray(v)) return v } catch { /* default */ }
  return [{ urls: 'stun:stun.l.google.com:19302' }]
}
export const tstats = { uploads: 0, rejected: {}, lines: 0, empty: 0, ms: [] }
const reject = (why) => { tstats.rejected[why] = (tstats.rejected[why] || 0) + 1 }

const presenting = new Map() // meetingId -> {materialId, by, byName, at}
// everything done for a meeting — cards, transcription, detection, suggestions, minutes — runs in the
// meeting's language (record.js meetingLang), whoever's request or timer it comes from
const inMeeting = (m, fn) => withLang(R.meetingLang(m), fn)

function off() { if (!enabled()) throw new TeamError(404, L('회의 기능이 꺼져 있어요.', "Meetings are turned off.")) }
async function meetingRow(id) {
  if (!UUID.test(String(id || ''))) return null
  const [m] = await q('select * from pro_meetings where id=$1 and tenant_id=$2', [id, T()])
  return m || null
}
// the meeting, if I am one of its room's people — anything else is "not found"
async function forMember(me, id) {
  off()
  const m = await meetingRow(id)
  if (!m) throw new TeamError(404, L('회의를 찾지 못했어요.', "I couldn't find the meeting."))
  const room = await M.memberThread(me, m.room_id)
  if (!room) throw new TeamError(404, L('회의를 찾지 못했어요.', "I couldn't find the meeting."))
  return { m, room }
}
const agentOn = (m, room) => !!m.agent && agentEnabled() && room?.context?.pgpt?.meetingAgent !== false
const PEOPLE = `select p.user_id::text as id, p.name, p.consent, p.consent_ever, p.joined_at, p.left_at, p.seen_at, u.email
                from pro_meeting_participants p left join users u on u.id=p.user_id and u.tenant_id=$2 where p.meeting_id=$1`
const active = (id) => q(`${PEOPLE} and p.left_at is null order by p.joined_at`, [id, T()])
const everyone = (id) => q(`${PEOPLE} order by p.joined_at`, [id, T()])
async function tell(meetingId, data, { except } = {}) {
  for (const p of await active(meetingId)) if (p.id !== except) emit(p.id, 'meeting', { meetingId, ...data })
}
const quietOf = (people) => people.flatMap((p) => [p.email, p.id]).filter(Boolean)
const peer = (p) => ({ id: p.id, name: p.name, consent: !!p.consent })

// the room's people hear when a meeting starts, changes or ends (header button, card)
async function roomState(m) {
  const live = m.state === 'live' ? await active(m.id) : []
  const info = m.state === 'live' ? { id: m.id, count: live.length, people: live.map((p) => p.name), startedAt: m.started_at } : null
  for (const p of await M.membersOf(m.room_id)) emit(p.id, 'meeting', { type: 'room', roomId: m.room_id, meeting: info })
}

export async function roomMeeting(me, roomId) {
  off()
  const room = await M.memberThread(me, roomId)
  if (!room) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find the conversation."))
  const [m] = await q(`select * from pro_meetings where room_id=$1 and state='live'`, [room.id])
  const live = m ? await active(m.id) : []
  return { enabled: true, agent: agentEnabled() && room.context?.pgpt?.meetingAgent !== false, max: MAX,
    meeting: m ? { id: m.id, count: live.length, people: live.map((p) => p.name), startedAt: m.started_at, joined: live.some((p) => p.id === me.id) } : null }
}

export async function setRoomAgent(me, roomId, on) {
  off()
  const room = await M.memberThread(me, roomId)
  if (!room) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find the conversation."))
  await q(`update chat_rooms set context = jsonb_set(coalesce(context,'{}'::jsonb), '{pgpt}', coalesce(context->'pgpt','{}'::jsonb) || jsonb_build_object('meetingAgent', $2::boolean)) where id=$1`, [room.id, !!on])
  for (const p of await M.membersOf(room.id)) emit(p.id, 'meeting', { type: 'room-agent', roomId: room.id, on: !!on, by: me.name })
  return { agent: !!on && agentEnabled() }
}

// 회의 시작 (or join the one already running in the room)
export async function start(me, roomId, { consent = false } = {}) {
  off()
  const room = await M.memberThread(me, roomId)
  if (!room) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find the conversation."))
  let [m] = await q(`select * from pro_meetings where room_id=$1 and state='live'`, [room.id])
  let created = false
  if (!m) {
    const agent = agentEnabled() && room.context?.pgpt?.meetingAgent !== false
    // the starter's language is the meeting's (Korean: summary stays empty until the minutes, as before)
    ;[m] = await q(`insert into pro_meetings(tenant_id, room_id, started_by, agent, summary) values ($1,$2,$3,$4,$5) on conflict do nothing returning *`, [T(), room.id, me.id, agent, lang() === 'en' ? { lang: 'en' } : null])
    if (m) created = true
    else [m] = await q(`select * from pro_meetings where room_id=$1 and state='live'`, [room.id])
  }
  const s = await join(me, m.id, { consent, card: false })
  if (created) {
    await inMeeting(m, async () => {
      const people = await everyone(m.id)
      m.card_uuid = await R.startCard(m, people, quietOf(people))
    })
    await roomState(m)
  }
  return s
}

export async function join(me, id, { consent = false, card = true } = {}) {
  const { m, room } = await forMember(me, id)
  if (m.state !== 'live') throw new TeamError(409, L('이미 끝난 회의예요.', "This meeting has already ended."))
  const live = await active(m.id)
  if (!live.some((p) => p.id === me.id) && live.length >= MAX) throw new TeamError(409, L(`회의는 ${MAX}명까지 함께할 수 있어요.`, `A meeting can have up to ${MAX} people.`))
  await q(`insert into pro_meeting_participants(meeting_id, user_id, name, consent, consent_ever) values ($1,$2,$3,$4,$4)
           on conflict (meeting_id, user_id) do update set left_at=null, seen_at=now(), joined_at=case when pro_meeting_participants.left_at is null then pro_meeting_participants.joined_at else now() end,
             consent=excluded.consent, consent_ever=pro_meeting_participants.consent_ever or excluded.consent, name=excluded.name`, [m.id, me.id, me.name, !!consent])
  await tell(m.id, { type: 'joined', peer: { id: me.id, name: me.name, consent: !!consent } }, { except: me.id })
  if (card && m.card_uuid) { await inMeeting(m, async () => R.updateCard(m, await everyone(m.id))); await roomState(m) }
  return state(me, m, room)
}

async function materialsFor(me, m) {
  const rows = await q('select * from pro_meeting_materials where meeting_id=$1 order by created_at', [m.id])
  const out = []
  for (const r of rows) if (await MAT.canSee(me, r)) out.push(await MAT.view(me, r))
  return out
}

export async function state(me, m0, room0) {
  const { m, room } = m0 && room0 ? { m: m0, room: room0 } : await forMember(me, m0?.id || m0)
  const people = await active(m.id)
  const mine = people.find((p) => p.id === me.id)
  const segs = await q('select id, user_id::text as "userId", speaker, text, at, typed from (select *, false as typed from pro_meeting_segments where meeting_id=$1 order by id desc limit 120) s order by id', [m.id])
  const sugg = await q(`select * from pro_room_suggestions where meeting_id=$1 and chat_uuid like 'meeting:%' order by created_at`, [m.id])
  const pres = presenting.get(m.id)
  let present = null
  if (pres) {
    const [mat] = await q('select * from pro_meeting_materials where id=$1', [pres.materialId])
    present = mat && (await MAT.canSee(me, mat)) ? { material: await MAT.view(me, mat), by: pres.byName, byId: pres.by } : { material: null, hidden: true, by: pres.byName, byId: pres.by }
  }
  // lang: the meeting's language (what it is transcribed and written in)
  return { id: m.id, roomId: m.room_id, title: room.name || null, state: m.state, startedAt: m.started_at, startedBy: m.started_by, lang: R.meetingLang(m),
    agent: agentOn(m, room), transcribe: transcribeConfigured(), judge: I.judgeConfigured(), max: MAX, ice: ice(),
    me: { id: me.id, name: me.name, consent: !!mine?.consent, joined: !!mine },
    peers: people.map(peer), lines: segs, materials: await materialsFor(me, m),
    suggestions: sugg.map((s) => A.view(me.id, s)).filter((v) => !v.hidden), presenting: present }
}

export async function leave(me, id) {
  const { m } = await forMember(me, id)
  const [p] = await q('update pro_meeting_participants set left_at=now() where meeting_id=$1 and user_id=$2 and left_at is null returning user_id', [m.id, me.id])
  if (p) await tell(m.id, { type: 'left', peer: { id: me.id, name: me.name } })
  if (m.state !== 'live') return { ok: true }
  const live = await active(m.id)
  if (!live.length) await end(m)
  else { await inMeeting(m, async () => R.updateCard(m, await everyone(m.id))); await roomState(m) }
  return { ok: true }
}

// 회의 끝내기 for everyone (any participant)
export async function endFor(me, id) {
  const { m } = await forMember(me, id)
  const live = await active(m.id)
  if (!live.some((p) => p.id === me.id)) throw new TeamError(403, L('회의에 참여 중인 분만 끝낼 수 있어요.', "Only people in the meeting can end it."))
  await end(m, me)
  return { ok: true }
}

async function end(m0, by = null) {
  const [m] = await q(`update pro_meetings set state='ended', ended_at=now() where id=$1 and state='live' returning *`, [m0.id])
  if (!m) return
  return inMeeting(m, () => ended(m, by))
}
async function ended(m, by) {
  const before = await active(m.id)
  await q('update pro_meeting_participants set left_at=coalesce(left_at, now()) where meeting_id=$1', [m.id])
  presenting.delete(m.id)
  clearTimeout(pending.get(m.id)?.timer); pending.delete(m.id)
  await R.closeBlocks(m.id)
  const people = await everyone(m.id)
  await R.updateCard(m, people, { ended: true })
  for (const p of before) emit(p.id, 'meeting', { meetingId: m.id, type: 'ended', by: by?.name || null })
  await roomState(m)
  await handovers(m, people).catch((e) => console.warn('[meetings] handover', e.message))
  try {
    const uuid = await finalize(m)
    for (const p of people) emit(p.id, 'meeting', { meetingId: m.id, type: 'minutes', roomId: m.room_id, messageId: uuid })
    console.log(`[meetings] ${m.id} ended · minutes ${uuid}`)
  } catch (e) { console.warn('[meetings] minutes', e.message) }
}

// what was handed over in the meeting, for process mining (record.handover; files also through
// lib/mining recordShare, which continues a mail case whose drafts these are)
async function handovers(m, people) {
  const mats = await q('select * from pro_meeting_materials where meeting_id=$1 and presented_by is not null', [m.id])
  for (const x of mats) {
    const from = people.find((p) => p.id === x.presented_by)
    if (!from) continue
    const others = people.filter((p) => p.id !== from.id)
    for (const to of others) await R.handover(m, { from, to, label: L('회의 자료 공유', 'Meeting material shared'), artifacts: [{ name: x.title, kind: x.kind }], note: x.title })
    if (x.kind === 'file') import('../mining/recorder.js').then((r) => r.recordShare({ id: from.id, name: from.name }, [{ name: x.title }], others, `${L('회의 자료', 'Meeting material')} · ${x.title}`)).catch(() => {})
  }
  const tasks = await q(`select * from pro_room_suggestions where meeting_id=$1 and chat_uuid like 'meeting:%' and started_by is not null`, [m.id])
  for (const t of tasks) {
    const from = people.find((p) => p.id === t.started_by)
    if (from) await R.handover(m, { from, to: { id: 'deepagents', name: L(`${from.name}님의 에이전트`, `${from.name}'s agent`) }, label: L('회의 중 맡긴 작업', 'Work handed over in the meeting'), note: t.title, isAgent: true })
  }
}

export async function setConsent(me, id, on) {
  const { m } = await forMember(me, id)
  const [p] = await q(`update pro_meeting_participants set consent=$3, consent_ever=consent_ever or $3 where meeting_id=$1 and user_id=$2 and left_at is null returning *`, [m.id, me.id, !!on])
  if (!p) throw new TeamError(404, L('회의에 참여 중이 아니에요.', "You're not in this meeting."))
  await tell(m.id, { type: 'consent', peer: { id: me.id, name: me.name, consent: !!on } })
  return { consent: !!on }
}

export async function heartbeat(me, id) {
  const { m } = await forMember(me, id)
  const [p] = await q('update pro_meeting_participants set seen_at=now() where meeting_id=$1 and user_id=$2 and left_at is null returning user_id', [m.id, me.id])
  return { live: m.state === 'live', joined: !!p }
}

// a signal for one other participant (offer / answer / ice / bye), or a media state for all (mute, camera, screen)
const KINDS = new Set(['offer', 'answer', 'ice', 'bye', 'renegotiate'])
export async function signal(me, id, { to, kind, data }) {
  const { m } = await forMember(me, id)
  if (m.state !== 'live') throw new TeamError(409, L('이미 끝난 회의예요.', "This meeting has already ended."))
  if (!KINDS.has(kind)) throw new TeamError(400, L('알 수 없는 신호예요.', "Unknown signal."))
  if (JSON.stringify(data ?? null).length > 24000) throw new TeamError(413, L('신호가 너무 커요.', "The signal is too large."))
  const live = await active(m.id)
  if (!live.some((p) => p.id === me.id)) throw new TeamError(403, L('회의에 참여 중이 아니에요.', "You're not in this meeting."))
  if (!live.some((p) => p.id === String(to)) || String(to) === me.id) throw new TeamError(404, L('상대가 회의에 없어요.', "That person isn't in the meeting."))
  emit(String(to), 'meeting', { meetingId: m.id, type: 'signal', from: me.id, fromName: me.name, kind, data })
  return { ok: true }
}
export async function media(me, id, st) {
  const { m } = await forMember(me, id)
  const s = { mic: !!st.mic, cam: !!st.cam, screen: !!st.screen }
  await tell(m.id, { type: 'media', peer: { id: me.id, name: me.name }, media: s }, { except: me.id })
  return s
}

// ---- the assistant: speech → line → room record → intents ----
const hints = new Map() // meetingId -> {at, text}
async function hintFor(m) {
  const h = hints.get(m.id)
  if (h && Date.now() - h.at < 60000) return h.text
  const people = await everyone(m.id)
  const files = await q(`select distinct a->>'name' as n from chats c, jsonb_array_elements(case when jsonb_typeof(c.messages->'pgpt'->'artifacts')='array' then c.messages->'pgpt'->'artifacts' else '[]'::jsonb end) a
                         where c.id=$1 limit 12`, [m.room_id]).catch(() => [])
  const names = files.map((f) => String(f.n).replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ')).join(', ')
  const text = isEn()
    ? `Meeting participants: ${people.map((p) => p.name).join(', ')}. Materials that may come up: ${names}.`
    : `회의 참석자: ${people.map((p) => p.name).join(', ')}. 회의에 나올 수 있는 자료: ${names}.`
  hints.set(m.id, { at: Date.now(), text })
  return text
}

async function speaking(me, id) {
  const { m, room } = await forMember(me, id)
  if (m.state !== 'live') throw new TeamError(409, L('이미 끝난 회의예요.', "This meeting has already ended."))
  const [p] = await q('select * from pro_meeting_participants where meeting_id=$1 and user_id=$2 and left_at is null', [m.id, me.id])
  if (!p) throw new TeamError(403, L('회의에 참여 중이 아니에요.', "You're not in this meeting."))
  if (!agentOn(m, room)) throw new TeamError(403, L('이 회의는 도우미(받아쓰기)가 꺼져 있어요.', "The helper (transcription) is off for this meeting."))
  return { m, room, p }
}

export async function audio(me, id, buf, type = 'audio/wav') {
  tstats.uploads++
  let ctx
  try { ctx = await speaking(me, id) } catch (e) { reject(e.status === 404 ? 'not-member' : 'refused'); throw e }
  const { m, p } = ctx
  if (!p.consent) { reject('no-consent'); throw new TeamError(403, L('받아쓰기에 동의하지 않아 소리를 받지 않아요.', "You haven't agreed to transcription, so your audio isn't taken.")) }
  if (!Buffer.isBuffer(buf) || buf.length < 1600) { reject('tiny'); throw new TeamError(400, L('소리가 너무 짧아요.', "The audio is too short.")) }
  if (buf.length > 3 * 1024 * 1024) { reject('large'); throw new TeamError(413, L('한 번에 보낼 수 있는 소리는 3MB 까지예요.', "Audio can be up to 3 MB at a time.")) }
  await q('update pro_meeting_participants set seen_at=now() where meeting_id=$1 and user_id=$2', [m.id, me.id])
  // spoken in the meeting's language (an English meeting is transcribed as English)
  return inMeeting(m, async () => {
    const t = await transcribe(buf, { prompt: await hintFor(m), type: /webm|ogg/.test(type) ? type : 'audio/wav', language: R.meetingLang(m) })
    tstats.ms.push(t.ms); if (tstats.ms.length > 300) tstats.ms.shift()
    if (!t.text) { tstats.empty++; return { text: '', ms: t.ms } }
    return addLine(m, me, t.text, { ms: t.ms, audioMs: wavMs(buf) })
  })
}

// a line typed in the meeting's side panel goes the same way (also how the tests speak without audio)
export async function typed(me, id, text) {
  const { m, p } = await speaking(me, id)
  // a typed line is recorded like speech: only with the person's consent
  if (!p.consent) throw new TeamError(403, L('기록에 동의하지 않아 받지 않아요. 동의를 켜 주세요.', "You haven't agreed to the record, so it isn't taken. Turn consent on."))
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!t) throw new TeamError(400, L('내용을 적어 주세요.', "Please write something."))
  return inMeeting(m, () => addLine(m, me, t, { typed: true }))
}

async function addLine(m, me, text, { ms = null, audioMs = null } = {}) {
  I.stats.segments++; tstats.lines++
  const [seg] = await q(`insert into pro_meeting_segments(meeting_id, room_id, user_id, speaker, text, ms, audio_ms) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [m.id, m.room_id, me.id, me.name, text, ms, audioMs])
  const people = await active(m.id)
  seg.block_uuid = await R.appendLine(m, seg, quietOf(people)).catch((e) => { console.warn('[meetings] record', e.message); return null })
  if (seg.block_uuid) await q('update pro_meeting_segments set block_uuid=$2 where id=$1', [seg.id, seg.block_uuid])
  await tell(m.id, { type: 'line', line: { id: seg.id, userId: me.id, speaker: me.name, text, at: seg.at, ms } })
  queueDetect(m, seg, me)
  return { id: seg.id, text, ms }
}

// debounce per meeting: lines that arrive close together are judged together, in order
const pending = new Map() // meetingId -> {timer, segs}
function queueDetect(m, seg, me) {
  const p = pending.get(m.id) || { segs: [] }
  p.segs.push({ seg, me })
  clearTimeout(p.timer)
  p.timer = setTimeout(() => {
    pending.delete(m.id)
    inMeeting(m, () => runQueue(m, p.segs)).catch((e) => { I.stats.judgeErrors++; console.warn('[meetings] detect', e.message) })
  }, I.DEBOUNCE_MS)
  pending.set(m.id, p)
}
async function runQueue(m, items) {
  // one speaker's consecutive lines are one turn
  const turns = []
  for (const it of items) {
    const last = turns[turns.length - 1]
    if (last && last.me.id === it.me.id) { last.seg = { ...it.seg, text: `${last.seg.text} ${it.seg.text}` } } else turns.push({ ...it })
  }
  for (const { seg, me } of turns) await detectOne(m, seg, me)
}
async function detectOne(m0, seg, me) {
  const m = await meetingRow(m0.id)
  if (!m || m.state !== 'live') return
  const prev = await q('select speaker, text from pro_meeting_segments where meeting_id=$1 and id < $2 order by id desc limit 3', [m.id, seg.id])
  const shownRows = await q('select key, created_at from pro_meeting_materials where meeting_id=$1', [m.id])
  const lastMinute = shownRows.filter((r) => Date.now() - new Date(r.created_at) < 60000).length
  const r = await I.detect(seg, { roomId: m.room_id, speaker: me, prev: prev.reverse(), shown: new Set(shownRows.map((x) => x.key)), lastMinute })
  if (!r) return
  if (r.repeat) {
    const [mat] = await q('select id from pro_meeting_materials where meeting_id=$1 and key=$2', [m.id, r.repeat])
    if (mat) await tell(m.id, { type: 'mentioned', materialId: mat.id })
    return
  }
  if (r.material) await addMaterial(m, r.material, seg, me)
  if (r.request) await addRequest(m, r.request, seg, me)
}

async function addMaterial(m, cand, seg, me) {
  const said = `"${seg.text.replace(/\s+/g, ' ').slice(0, 40)}${seg.text.length > 40 ? '…' : ''}"`
  const reason = isEn() ? `${me.name}: ${said}` : `${me.name}님 ${said}`
  const [mat] = await q(`insert into pro_meeting_materials(meeting_id, room_id, kind, ref, key, title, reason, segment_id, by_agent, found_for, judge)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10) on conflict (meeting_id, key) do nothing returning *`,
  [m.id, m.room_id, cand.kind, cand.ref, cand.key, String(cand.title).slice(0, 200), reason, seg.id, me.id, cand.judge])
  if (!mat) return
  I.stats.materials++
  for (const p of await active(m.id)) if (await MAT.canSee(p, mat)) emit(p.id, 'meeting', { meetingId: m.id, type: 'material', material: await MAT.view(p, mat) })
  // into the room's record only if everyone in the room may see it (a private thing's name stays private)
  const members = await M.membersOf(m.room_id)
  let all = true
  for (const p of members) if (!(await MAT.canSee(p, mat))) { all = false; break }
  if (all) await R.materialCard(m, mat, { quiet: quietOf(await active(m.id)) })
  console.log(`[meetings] material ${mat.kind} · ${mat.title} · judge ${cand.judge?.ms}ms`)
}

const NOUNS = ['견적서', '정산표', '예산표', '보고서', '계획서', '안내문', '제안서', '일정표', '회의록', '평면도', '체크리스트']
// English meetings: the thing asked for, by the words said, and a title per kind of work
const NOUNS_EN = [['revised quote', /revised\s+quote/i], ['quote', /\b(quote|quotation|estimate)\b/i], ['expense sheet', /\bexpense/i], ['budget', /\bbudget/i],
  ['report', /\breport/i], ['plan', /\bplan\b(?!\s*\w*\s*drawing)/i], ['notice', /\bnotice/i], ['proposal', /\bproposal/i], ['schedule', /\bschedule/i],
  ['minutes', /\bminutes\b/i], ['floor plan', /floor\s*plan/i], ['checklist', /checklist/i]]
export const NOUN_EN = { CreateSpreadsheet: 'spreadsheet', CreateDocument: 'document', SummarizeChat: 'meeting', ScheduleRegistration: 'meeting', CompanyQuery: 'information', DraftReply: 'reply', StartProcessInstance: 'process', CreateProcessDefinition: 'process definition' }
export function requestTitleEn(work, text) {
  if (work === 'SummarizeChat') return 'Summarize the meeting'
  const found = NOUNS_EN.filter(([, re]) => re.test(String(text || ''))).map(([n]) => n)
  // "floor plan" beats "plan", "revised quote" beats "quote"
  const noun = found.find((n) => found.some((o) => o !== n && n.endsWith(o))) || found[0] || NOUN_EN[work] || 'document'
  if (work === 'ScheduleRegistration') return `Schedule the ${noun}`
  if (work === 'CompanyQuery') return `Look up the ${noun}`
  if (work === 'StartProcessInstance') return `Start the ${noun}`
  if (work === 'CreateProcessDefinition') return `Create the ${noun}`
  return `Draft the ${noun}`
}
async function addRequest(m, req, seg, me) {
  const w = A.WORKS[req.work]
  if (!w) return
  const noun = NOUNS.find((n) => seg.text.replace(/\s/g, '').includes(n)) || w.noun
  const title = isEn() ? requestTitleEn(req.work, seg.text) : req.work === 'SummarizeChat' ? '회의 내용 요약하기' : `${noun} ${w.verb}`
  const audience = (await active(m.id)).map((p) => p.id)
  const reason = isEn()
    ? `${me.name}'s request "${seg.text.replace(/\s+/g, ' ').slice(0, 60)}" · routing model ${Math.round(req.yes * 100)}%`
    : `${me.name}님의 부탁 "${seg.text.replace(/\s+/g, ' ').slice(0, 60)}" · 판단 모델 ${Math.round(req.yes * 100)}%`
  const [s] = await q(`insert into pro_room_suggestions(tenant_id,room_id,chat_uuid,anchor_uuid,meeting_id,work,title,reason,audience,judge)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (chat_uuid) do nothing returning *`,
  [T(), m.room_id, `meeting:${seg.id}`, seg.block_uuid || null, m.id, req.work, title, reason, audience, { yes: req.yes, p: req.p, ms: req.ms, model: req.model }])
  if (!s) return
  I.stats.suggested++
  for (const p of await M.membersOf(m.room_id)) {
    const v = A.view(p.id, s)
    emit(p.id, 'team', { type: 'assist', threadId: m.room_id, suggestion: v })
    if (!v.hidden) emit(p.id, 'meeting', { meetingId: m.id, type: 'suggestion', suggestion: v })
  }
  console.log(`[meetings] request ${req.work} · ${title} · judge ${req.ms}ms`)
}

// 시작 on a meeting request: team assist's own start (first click wins), run as the person who pressed it
// through runAs (their deepagents, room = conversation_id); the result joins the meeting's materials
export async function startSuggestion(me, id, sid, runner) {
  const { m } = await forMember(me, id)
  const [s] = await q('select * from pro_room_suggestions where id=$1 and meeting_id=$2', [sid, m.id])
  if (!s) throw new TeamError(404, L('제안을 찾지 못했어요.', "I couldn't find the suggestion."))
  // the work and the result it leaves in the room are in the meeting's language
  return inMeeting(m, () => A.start(me, sid, async (c) => {
    await tell(m.id, { type: 'task', id: c.id, state: 'running', by: me.name, title: c.title })
    const uuid = await runner(c)
    const [row] = await q('select messages from chats where uuid=$1', [uuid])
    const files = (row?.messages?.pgpt?.artifacts || []).map((a) => a.name)
    const [mat] = await q(`insert into pro_meeting_materials(meeting_id, room_id, kind, ref, key, title, reason, by_agent, found_for, chat_uuid)
                           values ($1,$2,'result',$3,$4,$5,$6,true,$7,$8) on conflict (meeting_id, key) do nothing returning *`,
    [m.id, m.room_id, { chatUuid: uuid, files, suggestion: c.id }, `result:${c.id}`, L(`${c.title} 결과`, `${c.title} — result`), L(`${me.name}님의 에이전트가 만들었어요`, `Made by ${me.name}'s agent`), me.id, uuid])
    if (mat) for (const p of await active(m.id)) emit(p.id, 'meeting', { meetingId: m.id, type: 'material', material: await MAT.view(p, mat) })
    await tell(m.id, { type: 'task', id: c.id, state: 'done', by: me.name, title: c.title, messageId: uuid })
    return uuid
  }))
}

export async function dismissSuggestion(me, id, sid) {
  const { m } = await forMember(me, id)
  const [s] = await q('select id from pro_room_suggestions where id=$1 and meeting_id=$2', [sid, m.id])
  if (!s) throw new TeamError(404, L('제안을 찾지 못했어요.', "I couldn't find the suggestion."))
  return A.dismiss(me, sid)
}

// ---- materials: open, present ----
async function materialOf(me, id, mid) {
  const { m, room } = await forMember(me, id)
  if (!UUID.test(String(mid || ''))) throw new TeamError(404, L('자료를 찾지 못했어요.', "I couldn't find the material."))
  const [mat] = await q('select * from pro_meeting_materials where id=$1 and meeting_id=$2', [mid, m.id])
  if (!mat || !(await MAT.canSee(me, mat))) throw new TeamError(404, L('자료를 찾지 못했어요.', "I couldn't find the material."))
  return { m, room, mat }
}

export async function openMaterial(me, id, mid) {
  const { mat } = await materialOf(me, id, mid)
  if (mat.kind === 'file') {
    const msg = await MAT.openFile(me, mat)
    if (!msg) throw new TeamError(404, L('파일을 열 수 없어요.', "I can't open the file."))
    return { message: msg }
  }
  return { material: await MAT.view(me, mat) }
}

export async function present(me, id, mid) {
  const { m, mat } = await materialOf(me, id, mid)
  const live = await active(m.id)
  if (!live.some((p) => p.id === me.id)) throw new TeamError(403, L('회의에 참여 중인 분만 띄울 수 있어요.', "Only people in the meeting can show material."))
  return inMeeting(m, () => presentIn(me, m, mat, live))
}
async function presentIn(me, m, mat, live) {
  let ref = mat.ref
  if (mat.kind === 'file' && ref?.ownerId === me.id) {
    const g = await MAT.grantForRoom(me, mat, await M.membersOf(m.room_id), { roomId: m.room_id, chatUuid: mat.chat_uuid, note: `${L('회의 자료', 'Meeting material')} · ${mat.title}` })
    if (g?.artifacts) ref = { ...ref, artifacts: g.artifacts }
  }
  const [upd] = await q('update pro_meeting_materials set ref=$2, presented_by=$3, presented_at=now() where id=$1 returning *', [mat.id, ref, me.id])
  presenting.set(m.id, { materialId: mat.id, by: me.id, byName: me.name, at: Date.now() })
  for (const p of live) {
    const ok = await MAT.canSee(p, upd)
    emit(p.id, 'meeting', { meetingId: m.id, type: 'present', by: me.name, byId: me.id, material: ok ? await MAT.view(p, upd) : null, hidden: !ok })
  }
  await R.materialCard(m, upd, { presentedBy: me.name, quiet: quietOf(live) })
  return { ok: true }
}

export async function unpresent(me, id) {
  const { m } = await forMember(me, id)
  presenting.delete(m.id)
  await tell(m.id, { type: 'present', material: null, by: me.name, byId: me.id })
  return { ok: true }
}

export function report() {
  const s = [...tstats.ms].sort((a, b) => a - b)
  const pct = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null)
  return { detection: I.report(), transcription: { ...tstats, ms: undefined, latency: { n: s.length, p50: pct(0.5), p90: pct(0.9) }, configured: transcribeConfigured() }, enabled: enabled(), agent: agentEnabled() }
}

// people whose page stopped answering are taken out; a meeting nobody is in ends (minutes follow)
export function startSweeper() {
  if (startSweeper.on) return
  startSweeper.on = true
  setInterval(async () => {
    try {
      const gone = await q(`update pro_meeting_participants p set left_at=now() from pro_meetings m where m.id=p.meeting_id and m.state='live'
                            and p.left_at is null and p.seen_at < now() - make_interval(secs => $1) returning p.meeting_id, p.user_id::text as id, p.name`, [STALE_S])
      for (const g of gone) await tell(g.meeting_id, { type: 'left', peer: { id: g.id, name: g.name }, stale: true })
      const empty = await q(`select * from pro_meetings m where m.state='live' and m.started_at < now() - interval '20 seconds'
                             and not exists (select 1 from pro_meeting_participants p where p.meeting_id=m.id and p.left_at is null)`)
      for (const m of empty) await end(m)
      for (const id of new Set(gone.map((g) => g.meeting_id))) {
        const [m] = await q(`select * from pro_meetings where id=$1 and state='live'`, [id])
        if (m) { await inMeeting(m, async () => R.updateCard(m, await everyone(m.id))); await roomState(m) }
      }
    } catch (e) { console.warn('[meetings] sweep', e.message) }
  }, 15000).unref?.()
}
