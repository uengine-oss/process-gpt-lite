// What a meeting leaves in its room (회의 기록): ordinary process-gpt chats rows written by the meeting
// assistant, so the room reads the same in process-gpt's UI (content = readable text/markdown) and in
// pgpt-pro (messages.pgpt.kind tells the messenger to draw a meeting card):
//   meeting             the meeting card — one row, updated in place (참여 인원, 끝나면 시간)
//   meeting-transcript  a 회의록 block: speaker turns of up to 2 minutes / 24 lines in ONE row, updated in
//                       place as lines arrive (never a row per sentence)
//   meeting-material    a material the assistant found (visible to everyone in the room) or someone presented
//   meeting-minutes     the final minutes (lib/meetings/minutes.js)
// Rows are inserted/updated here; the pro_chats_notify trigger fans them out live (messenger.startRoomFeed),
// an UPDATE replacing the message with the same id on every client.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { L, isEn } from '../lang.js'

const T = () => config.tenantId
export const AGENT = { id: 'pgpt-meeting-assistant', name: '프로세스 GPT 라이트 도우미' }
// A meeting has one language: the one its starter was using when it began (stored as summary.lang,
// which the final minutes keep). Everything done for the meeting runs in it (service.js inMeeting).
export const meetingLang = (m) => (m?.summary?.lang === 'en' ? 'en' : 'ko')
// the helper's name in the meeting's language (English mode: the glossary's "Process GPT Lite helper")
const agentName = () => L(AGENT.name, 'Process GPT Lite helper')
export const BLOCK_MS = Number(process.env.PRO_MEETING_BLOCK_MS || 120000)
export const BLOCK_LINES = 24
const TURN_GAP_MS = 8000 // one speaker's lines this close together are one turn
const hhmm = (d) => new Date(d).toLocaleTimeString(isEn() ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' })

// the assistant's row, in the shape process-gpt persists an agent reply
function row(content, pgpt, uuid = crypto.randomUUID(), at = new Date()) {
  const name = agentName()
  return { uuid, id: AGENT.id, name, role: 'assistant', email: `agent:${AGENT.id}`, agentId: AGENT.id, userName: name,
    profile: '/images/chat-icon.png', content, timeStamp: new Date(at).toISOString(), pgpt }
}

async function insert(roomId, content, pgpt, { quiet = [] } = {}) {
  const msg = row(content, pgpt)
  await q('insert into chats(uuid, id, messages, tenant_id, thread_id) values ($1,$2,$3,$4,$2)', [msg.uuid, roomId, msg, T()])
  await q('update chat_rooms set message=$2 where id=$1', [roomId, { msg: String(content).replace(/[*#]/g, '').slice(0, 50), type: 'text', createdAt: msg.timeStamp }])
  // process-gpt's chat trigger made a 'chat' notice for everyone; people in the meeting are looking at it
  if (quiet.length) {
    await q(`update notifications set is_checked=true where type='chat' and url=$1 and user_id = any($2) and coalesce(is_checked,false)=false and title=$3`,
      [`/chats?id=${roomId}`, quiet, msg.content]).catch(() => {})
  }
  return msg.uuid
}
// update in place: content and pgpt replaced, timeStamp kept (the row stays where it was in the room)
const patch = (uuid, content, pgpt) => q(`update chats set messages = messages || $2::jsonb where uuid=$1`, [uuid, JSON.stringify({ content, pgpt })])

const names = (ps) => ps.map((p) => p.name).filter(Boolean)
const minutesOf = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000))

// ---- the meeting card ----
export function cardOf(m, people, { ended = false } = {}) {
  const live = people.filter((p) => !p.left_at)
  const all = names(people)
  const content = isEn()
    ? ended
      ? `📹 The meeting ended · ${minutesOf(m.started_at, m.ended_at || new Date())} min · ${all.length} joined (${all.join(', ')})`
      : `📹 Meeting in progress · ${live.length} in the meeting (${names(live).join(', ')}) — join it from Process GPT Lite Team messages`
    : ended
    ? `📹 회의가 끝났어요 · ${minutesOf(m.started_at, m.ended_at || new Date())}분 · 참여 ${all.length}명 (${all.join(', ')})`
    : `📹 회의 중 · ${live.length}명 참여 (${names(live).join(', ')}) — 프로세스 GPT 라이트 메시지에서 참여할 수 있어요`
  return { content, pgpt: { kind: 'meeting', meeting: { id: m.id, state: ended ? 'ended' : 'live', count: live.length, people: all, live: names(live),
    startedAt: m.started_at, endedAt: ended ? (m.ended_at || new Date()).toISOString?.() || m.ended_at : null, startedBy: m.started_by, agent: m.agent } } }
}

export async function startCard(m, people, quiet) {
  const c = cardOf(m, people)
  const uuid = await insert(m.room_id, c.content, c.pgpt, { quiet })
  await q('update pro_meetings set card_uuid=$2 where id=$1', [m.id, uuid])
  return uuid
}
export async function updateCard(m, people, opts) {
  if (!m.card_uuid) return
  const c = cardOf(m, people, opts)
  await patch(m.card_uuid, c.content, c.pgpt)
}

// ---- 회의록 blocks (rolling transcript) ----
const blocks = new Map() // meetingId -> {uuid, n, startedAt, lines}
const chains = new Map() // meetingId -> promise (one writer at a time per meeting)
function serial(id, fn) {
  const next = (chains.get(id) || Promise.resolve()).catch(() => {}).then(fn)
  chains.set(id, next.catch(() => {}))
  return next
}
// a line in another language than the meeting's carries its translation (process-gpt's room reads only
// this text; pgpt-pro shows each reader the line in their own language from pgpt.meeting.lines[].tr)
function blockText(b, mlang = 'ko') {
  const span = b.lines.length ? `${hhmm(b.lines[0].at)}–${hhmm(b.lines[b.lines.length - 1].at)}` : ''
  // plain "이름: 말" lines: process-gpt's chat room shows content as text (no markdown there)
  const said = (l) => `${l.speaker}: ${l.text}${l.lang && l.lang !== mlang && l.tr?.[mlang] ? ` (${l.tr[mlang]})` : ''}`
  return `🎙 ${L('회의록', 'Transcript')} ${b.n}${span ? ` (${span})` : ''}\n${b.lines.map(said).join('\n')}`
}
// (trp: the translation of each of a line's pieces, in memory only; tr: the whole line, once every piece has it)
const blockPgpt = (m, b) => ({ kind: 'meeting-transcript', meeting: { id: m.id, block: b.n, lang: meetingLang(m), lines: b.lines.map(({ trp, ...l }) => l) } })
const lineOf = (seg) => ({ speaker: seg.speaker, userId: seg.user_id, text: seg.text, lang: seg.lang || null, tr: {}, trp: {}, at: new Date(seg.at).toISOString(), segs: [seg.id] })
function joinTr(l) {
  for (const [lang, parts] of Object.entries(l.trp || {})) {
    if (l.segs.every((id) => parts[id])) l.tr[lang] = l.segs.map((id) => parts[id]).join(' ').slice(0, 1600)
    else delete l.tr[lang]
  }
}

// one transcribed line into the room's current block; returns the block's chats uuid
export function appendLine(m, seg, quiet) {
  return serial(m.id, async () => {
    let b = blocks.get(m.id)
    const at = new Date(seg.at).getTime()
    if (b) {
      const last = b.lines[b.lines.length - 1]
      if (last && last.userId === seg.user_id && (last.lang || null) === (seg.lang || null) && at - new Date(last.at).getTime() < TURN_GAP_MS) {
        last.text = `${last.text} ${seg.text}`.slice(0, 1200); last.at = new Date(seg.at).toISOString(); last.segs.push(seg.id)
        joinTr(last)
        await patch(b.uuid, blockText(b, meetingLang(m)), blockPgpt(m, b))
        return b.uuid
      }
      if (at - b.startedAt < BLOCK_MS && b.lines.length < BLOCK_LINES) {
        b.lines.push(lineOf(seg))
        await patch(b.uuid, blockText(b, meetingLang(m)), blockPgpt(m, b))
        return b.uuid
      }
    }
    const [{ n }] = await q(`select count(*)::int + 1 as n from chats where id=$1 and messages->'pgpt'->>'kind'='meeting-transcript' and messages->'pgpt'->'meeting'->>'id'=$2`, [m.room_id, m.id])
    b = { n, startedAt: at, lines: [lineOf(seg)] }
    b.uuid = await insert(m.room_id, blockText(b, meetingLang(m)), blockPgpt(m, b), { quiet })
    blocks.set(m.id, b)
    return b.uuid
  })
}
export const closeBlocks = (meetingId) => serial(meetingId, async () => { blocks.delete(meetingId) })

// a line's translation landed (service.js translateLine): into its line in the block, in place —
// the live block in memory, or (it has rolled over since) the stored row
export function lineTr(m, seg, lang, text) {
  return serial(m.id, async () => {
    const b = blocks.get(m.id)
    if (b && (!seg.block_uuid || b.uuid === seg.block_uuid)) {
      const l = b.lines.find((x) => x.segs.includes(seg.id))
      if (l) {
        ;(l.trp[lang] ||= {})[seg.id] = text
        joinTr(l)
        await patch(b.uuid, blockText(b, meetingLang(m)), blockPgpt(m, b))
        return
      }
    }
    if (!seg.block_uuid) return
    const [row] = await q('select messages from chats where uuid=$1', [seg.block_uuid])
    const lines = row?.messages?.pgpt?.meeting?.lines
    const l = lines?.find((x) => (x.segs || []).includes(seg.id))
    if (!l) return
    // a stored line made of several pieces gets the translation of the one piece only if it is alone
    if (l.segs.length === 1) {
      l.tr = { ...(l.tr || {}), [lang]: text }
      const sb = { n: row.messages.pgpt.meeting.block, lines }
      await patch(seg.block_uuid, blockText(sb, meetingLang(m)), { ...row.messages.pgpt, meeting: { ...row.messages.pgpt.meeting, lines } })
    }
  })
}

// ---- materials and results ----
const KIND_WORD = { file: '파일', process: '진행 상황', panel: '앱 데이터', folder: '폴더 문서', result: '에이전트 결과' }
export const KIND_WORD_EN = { file: 'File', process: 'Progress', panel: 'App data', folder: 'Folder document', result: 'Agent result' }
export const kindWord = (kind) => (isEn() ? KIND_WORD_EN[kind] || 'Material' : KIND_WORD[kind] || '자료')
export async function materialCard(m, mat, { presentedBy, quiet } = {}) {
  if (mat.chat_uuid) {
    // already in the room: a presentation updates its line
    if (presentedBy) await patch(mat.chat_uuid, materialText(mat, presentedBy), materialPgpt(m, mat, presentedBy))
    return mat.chat_uuid
  }
  const uuid = await insert(m.room_id, materialText(mat, presentedBy), materialPgpt(m, mat, presentedBy), { quiet })
  await q('update pro_meeting_materials set chat_uuid=$2 where id=$1', [mat.id, uuid])
  mat.chat_uuid = uuid
  return uuid
}
function materialText(mat, presentedBy) {
  if (isEn()) {
    const who = presentedBy ? `${presentedBy} showed it to everyone` : 'The helper found it and put it up'
    return `📎 Meeting material · ${kindWord(mat.kind)} · ${mat.title}\n${who}${mat.reason ? ` — ${mat.reason}` : ''}`
  }
  const who = presentedBy ? `${presentedBy}님이 모두에게 띄웠어요` : '도우미가 찾아 띄웠어요'
  return `📎 회의 자료 · ${KIND_WORD[mat.kind] || '자료'} · ${mat.title}\n${who}${mat.reason ? ` — ${mat.reason}` : ''}`
}
function materialPgpt(m, mat, presentedBy) {
  // ids only: the room card is a pointer; each viewer opens it through their own access
  return { kind: 'meeting-material', meeting: { id: m.id, material: { id: mat.id, kind: mat.kind, title: mat.title, reason: mat.reason || null, presentedBy: presentedBy || null } },
    ...(mat.kind === 'file' && mat.ref?.artifacts ? { artifacts: mat.ref.artifacts, by: mat.ref.ownerId } : {}) }
}

// ---- the final minutes ----
export async function minutesRow(m, md, pgptMeeting, quiet) {
  const uuid = await insert(m.room_id, md, { kind: 'meeting-minutes', meeting: { id: m.id, ...pgptMeeting } }, { quiet })
  await q('update pro_meetings set minutes_uuid=$2 where id=$1', [m.id, uuid])
  return uuid
}

// ---- process mining: what was handed over in the meeting (process-gpt handover_events shape,
// as lib/mining/recorder.js recordStep writes it), one case per meeting ----
export async function handover(m, { from, to, label, artifacts = [], note = '', isAgent = false }) {
  const caseId = `meeting:${m.id}`
  const [prev] = await q(`select to_user_id, to_user_name, to_is_agent, occurred_at from handover_events where tenant_id=$1 and case_id=$2 order by occurred_at desc limit 1`, [T(), caseId])
  const when = new Date()
  const latency = prev ? Math.max(0, Math.round((when - new Date(prev.occurred_at)) / 1000)) : null
  await q(`insert into handover_events (tenant_id, case_id, origin_room_id, source, is_explicit,
             from_room_id, to_room_id, from_user_id, from_user_name, from_is_agent, to_user_id, to_user_name, to_role, to_is_agent, agent_orch,
             activity_label, next_activity_label, norm_activity_label, instruction, reason, artifact_refs, occurred_at, returned_at, handover_latency_sec)
           values ($1,$2,$3,$4,$5,$3,$3,$6,$7,false,$8,$9,null,$10,$11,$12,$12,$12,$13,$14,$15,$16,$16,$17)`, [
    T(), caseId, m.room_id, isAgent ? 'agent_delegation' : 'chat_handover', !isAgent,
    String(from.id), from.name, String(to.id), to.name, isAgent, isAgent ? 'deepagents' : null,
    label, note || label, L('pgpt-pro 회의', 'pgpt-pro meeting'), JSON.stringify((artifacts.length ? artifacts : [{}]).map((a) => ({ type: 'file', ...a }))), when.toISOString(), latency])
    .catch((e) => console.warn('[meetings] handover', e.message))
}
