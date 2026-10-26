// Team assist (팀 대화 속 에이전트 제안) — process-gpt's "ProcessGPT active" chat assist, inherited.
// process-gpt (frontend WorkAssistantGenerator.js) classifies every chat message with gpt-4o into a work
// (CreateProcessDefinition / StartProcessInstance / CompanyQuery …), proposes it in the room and starts it.
// Here the same works, the same propose → start flow, but the per-message classification is cheap:
//   1. rules: skip chit-chat, emoji, short or plain-statement messages; keep request-shaped ones that
//      name a kind of work
//   2. the judge model (context-router's typed-decision server: softmax over the option letters, no text
//      generated, ~0.2–0.5s a call): (a) a request for work or not, (b) which work, (c) for
//      StartProcessInstance, which registered proc_def
// The big agent model is never called to detect. Nothing runs until a person in the room presses 시작;
// then it runs as that person, through process-gpt's chat-room path (deepagents /chat/stream with the room
// as conversation_id), so the answer lands in the room like any agent reply in process-gpt.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { TeamError } from './access.js'
import * as S from './shares.js'
import * as M from './messenger.js'

const T = () => config.tenantId
const ON = () => process.env.PRO_TEAM_ASSIST !== '0'
const JUDGE_URL = process.env.PRO_JUDGE_URL ?? 'http://127.0.0.1:8896/judge'
const JUDGE_MS = Number(process.env.PRO_ASSIST_JUDGE_TIMEOUT_MS || 5000)
const DEBOUNCE_MS = Number(process.env.PRO_ASSIST_DEBOUNCE_MS || 1200)
const MIN_YES = 0.7 // stage 2a: "a request for work" must hold at least this much of the judge's probability
const MIN_P = 0.5 // stage 2b: the chosen work at least this much

// the works: process-gpt's own (WorkAssistantGenerator: CreateProcessDefinition, StartProcessInstance,
// CompanyQuery; its legacy startProcess: ScheduleRegistration) plus document kinds pgpt-pro's agent makes
export const WORKS = {
  CreateSpreadsheet: { label: '견적서·예산표·정산표 같은 표나 엑셀 파일 만들기', noun: '엑셀 표', verb: '초안 만들기', badge: '표' },
  CreateDocument: { label: '보고서·안내문·계획서·제안서 같은 문서 작성이나 수정', noun: '문서', verb: '초안 작성하기', badge: '문서' },
  SummarizeChat: { label: '이 대화나 자료를 요약·정리하기', noun: '이 대화', verb: '요약하기', badge: '요약' },
  ScheduleRegistration: { label: '회의나 일정을 잡고 캘린더에 넣기', noun: '일정', verb: '잡기', badge: '일정' },
  CompanyQuery: { label: '회사의 프로세스·진행 중인 업무·조직 정보나 자료를 찾아 답하기', noun: '자료', verb: '찾아보기', badge: '조회' },
  DraftReply: { label: '메일·답장·공지 초안 쓰기', noun: '답장', verb: '초안 쓰기', badge: '답장' },
  StartProcessInstance: { label: '등록된 업무 프로세스(신청·결재·접수)를 시작하기', noun: '업무 프로세스', verb: '시작하기', badge: '프로세스' },
  CreateProcessDefinition: { label: '새 업무 프로세스(절차) 정의를 만들기', noun: '프로세스 정의', verb: '만들기', badge: '프로세스' },
}
const NOUNS = ['견적서', '정산표', '예산표', '보고서', '계획서', '안내문', '제안서', '일정표', '회의록', '체크리스트', '발표 자료', '공지', '초대장', '명단', '비교표']

// ---- stage 1: rules ----
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{P}\p{S}\s]*$/u
const CHAT = /^(ㅋ|ㅎ|ㅠ|ㅜ|넵|네|넹|예|응|ㅇㅇ|오케이|ok|굿|좋아요|좋네요|감사|고마워|고맙|수고|안녕|ㅇㅋ|헐|대박)/i
const SMALLTALK = /(점심|저녁|커피|날씨|퇴근|주말|ㅋㅋ|ㅎㅎ)/
const ASK = /(줘|주세요|주실|주시|줄\s*수|줄래|부탁|할까요|있을까요|될까요|가능할까|가능한가|해\s*봐|뽑아|만들어|정리해|\?|？)/
const WORK = /(견적|정산|예산|엑셀|표|시트|보고서|문서|계획서|안내문|제안서|초안|요약|정리|회의록|일정|미팅|회의|예약|캘린더|조사|찾아|알아봐|비교|분석|답장|회신|메일|공지|번역|발표|자료|ppt|피피티|신청|결재|접수|프로세스|절차|계산|현황|진행)/i

export function prefilter(body) {
  const t = String(body || '').replace(/\s+/g, ' ').trim()
  if (t.length < 8) return { pass: false, why: 'short' }
  if (EMOJI_ONLY.test(t)) return { pass: false, why: 'emoji' }
  if (CHAT.test(t) && t.length < 20) return { pass: false, why: 'chat' }
  if (!WORK.test(t)) return { pass: false, why: SMALLTALK.test(t) ? 'smalltalk' : 'no-work' }
  if (!ASK.test(t)) return { pass: false, why: 'not-a-request' }
  return { pass: true }
}

// ---- counters (GET /api/team/assist/stats) ----
export const stats = { messages: 0, prefiltered: {}, judged: 0, suggested: 0, judgeMs: [], detectMs: [], judgeErrors: 0, bigModelCalls: 0, started: 0 }
const count = (why) => { stats.prefiltered[why] = (stats.prefiltered[why] || 0) + 1 }
const keep = (list, v) => { list.push(v); if (list.length > 200) list.shift() }

async function judge(state, question, options) {
  const t0 = Date.now()
  const r = await fetch(JUDGE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(JUDGE_MS),
    body: JSON.stringify({ state: state.slice(0, 1400), question, options }),
  })
  if (!r.ok) throw new Error(`judge ${r.status}`)
  const j = await r.json()
  stats.judged++; keep(stats.judgeMs, Date.now() - t0)
  return { ...j, ms: Date.now() - t0 }
}

// the minimal excerpt: the last few messages of the room, names and text only (no file contents, no ids,
// at most 200 characters a line)
async function excerpt(roomId, uuid) {
  const rows = await q(`select messages from chats where id=$1 and coalesce(public.pro_chat_ts(messages), now()) <=
                          coalesce((select public.pro_chat_ts(messages) from chats where uuid=$2), now())
                        order by coalesce(public.pro_chat_ts(messages), now()) desc limit 4`, [roomId, uuid])
  return rows.reverse().map(({ messages: m }) => `${m.userName || m.name || '팀원'}: ${(m.role === 'assistant' ? '(에이전트) ' : '') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}${(m.pgpt?.artifacts || []).length ? ` [첨부: ${m.pgpt.artifacts.map((a) => a.name).join(', ')}]` : ''}`)
}

function titleFor(work, body) {
  const w = WORKS[work]
  const noun = NOUNS.find((n) => body.replace(/\s/g, '').includes(n.replace(/\s/g, '')))
  if (work === 'SummarizeChat') return '이 대화 요약하기'
  return `${noun && ['CreateSpreadsheet', 'CreateDocument', 'DraftReply'].includes(work) ? noun : w.noun} ${w.verb}`
}

// who is offered it: the people asked — members named in the message, else everyone in the room but its author
function audienceOf(humans, authorId, body) {
  const others = humans.filter((m) => m.id !== authorId)
  const named = others.filter((m) => m.name && m.name.length >= 2 && (body.includes(m.name) || body.includes(m.name.slice(1))))
  return (named.length ? named : others).map((m) => m.id)
}

// registered processes whose names share a word with the request, for the judge to pick from (stage 2c)
async function processCandidates(body) {
  const words = body.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2)
  if (!words.length) return []
  const defs = await q(`select id, name from proc_def where tenant_id=$1 and coalesce(isdeleted,false)=false and name is not null`, [T()]).catch(() => [])
  return defs.filter((d) => words.some((w) => d.name.includes(w))).slice(0, 5)
}

const timers = new Map()
const recent = new Map() // roomId -> [timestamps]
const LIMIT_HOUR = 6

// every chats row a person writes, from any UI (messenger.js room feed)
export function watchRooms() {
  if (watchRooms.on) return
  watchRooms.on = true
  M.onChat((row, humans) => {
    const m = row.messages || {}
    if (m.role !== 'user' || m.pgpt?.kind === 'assist' || m.__hidden) return
    const author = humans.find((h) => h.id === m.userId || h.email === m.email)
    if (!author) return // a system or agent row
    stats.messages++
    if (!ON()) return count('tenant-off')
    const pf = prefilter(m.content)
    if (!pf.pass) return count(pf.why)
    clearTimeout(timers.get(row.id))
    // the latest message of a burst is judged with the ones before it
    timers.set(row.id, setTimeout(() => {
      timers.delete(row.id)
      detect(row, humans, author).catch((e) => { stats.judgeErrors++; console.warn('[assist]', e.message) })
    }, DEBOUNCE_MS))
  })
}

async function detect(row, humans0, author) {
  const t0 = Date.now()
  const roomId = row.id, body = String(row.messages.content || '')
  const [room] = await q('select context from chat_rooms where id=$1 and tenant_id=$2', [roomId, T()])
  if (!room) return
  if (room.context?.pgpt?.assist === false) return count('room-off')
  const [seen] = await q('select 1 from pro_room_suggestions where chat_uuid=$1', [row.uuid])
  if (seen) return count('cached')
  const now = Date.now()
  const list = (recent.get(roomId) || []).filter((x) => now - x < 3600000)
  if (list.length >= LIMIT_HOUR) return count('room-rate')
  const lines = await excerpt(roomId, row.uuid)
  // the new message stands apart from what came before (mixed in, earlier chit-chat pulls "yes" down)
  const prev = lines.slice(0, -1)
  const state = `${prev.length ? `앞선 대화:\n${prev.join('\n')}\n\n` : ''}방금 온 메시지:\n${lines[lines.length - 1]}`
  // 2a. a request for work at all? (a separate yes/no: with the works beside it the judge almost never says no)
  const y = await judge(state, '방금 온 메시지는 어떤 말인가요?', [
    { key: 'no', label: '사람에게 의견이나 사정을 묻거나 잡담하는 말' },
    { key: 'yes', label: '자료·문서·표·일정·조사 같은 결과물을 만들어 달라는 부탁' }])
  const yes = y.probabilities?.yes ?? 0
  if (yes < MIN_YES) { console.log(`[assist] judge ${y.ms}ms yes=${yes.toFixed(2)} → no · ${body.slice(0, 40)}`); return count('judge-no') }
  // 2b. which work
  const j = await judge(state, '방금 온 메시지가 AI 비서에게 부탁하는 일은 어떤 종류인가요?', Object.entries(WORKS).map(([key, w]) => ({ key, label: w.label })))
  let [work, p] = Object.entries(j.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || []
  let ms = y.ms + j.ms
  if (!work || p < MIN_P) { console.log(`[assist] judge ${ms}ms yes=${yes.toFixed(2)} ${work}=${(p || 0).toFixed(2)} → unsure`); return count('judge-work') }
  // 2c. StartProcessInstance against proc_def, as process-gpt does: only among registered processes that
  // share a word with the request; none fits → the agent does the work itself
  let proc = null
  const cands = ['StartProcessInstance', 'CreateSpreadsheet', 'CreateDocument'].includes(work) ? await processCandidates(body) : []
  if (cands.length) {
    const pj = await judge(lines[lines.length - 1], '이 요청에 맞는 등록된 업무 프로세스는?', [{ key: 'none', label: '맞는 프로세스 없음' }, ...cands.map((d) => ({ key: d.id, label: d.name }))]).catch(() => null)
    if (pj) ms += pj.ms
    const best = pj && Object.entries(pj.probabilities || {}).sort((a, b) => b[1] - a[1])[0]
    if (best && best[0] !== 'none' && best[1] >= 0.6) { proc = cands.find((d) => d.id === best[0]); work = 'StartProcessInstance' }
  }
  if (work === 'StartProcessInstance' && !proc) work = 'CompanyQuery'
  const humans = humans0.map((h) => ({ id: h.id, name: h.username || h.name, email: h.email }))
  const audience = audienceOf(humans, author.id, body)
  if (!audience.length) return count('no-audience')
  const title = proc ? `${proc.name} 시작하기` : titleFor(work, body)
  const who = author.username || author.name || '팀원'
  const reason = `${who}님의 요청 "${body.replace(/\s+/g, ' ').slice(0, 60)}${body.length > 60 ? '…' : ''}" · 판단 모델 ${Math.round(p * 100)}%`
  const [s] = await q(`insert into pro_room_suggestions(tenant_id,room_id,chat_uuid,work,title,reason,process_id,audience,judge)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (chat_uuid) do nothing returning *`,
  [T(), roomId, row.uuid, work, title, reason, proc?.id || null, audience, { yes: Math.round(yes * 100) / 100, p: Math.round(p * 100) / 100, ms, model: j.model }])
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
  if (s.state === 'open' && !offered) return { id: s.id, threadId: s.room_id, messageId: s.chat_uuid, hidden: true }
  return { id: s.id, threadId: s.room_id, messageId: s.chat_uuid, work: s.work, kind: WORKS[s.work]?.badge || '도움', title: s.title, reason: s.reason, state: s.state,
    startedBy: s.started_by, resultMessageId: s.result_uuid, mine: s.started_by === viewerId, canStart: offered && s.state === 'open', judge: s.judge }
}

export async function list(me, roomId) {
  const t = await M.memberThread(me, roomId)
  if (!t) throw new TeamError(404, '대화를 찾지 못했어요.')
  const rows = await q('select * from pro_room_suggestions where room_id=$1 order by created_at desc limit 50', [t.id])
  return { assist: t.assist, enabled: ON(), suggestions: rows.map((s) => view(me.id, s)).filter((v) => !v.hidden) }
}

// the room's switch lives with the room (chat_rooms.context.pgpt.assist), like process-gpt's ProcessGPT-active
export async function setThreadAssist(me, roomId, on) {
  const t = await M.memberThread(me, roomId)
  if (!t) throw new TeamError(404, '대화를 찾지 못했어요.')
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
  if (!s) throw new TeamError(404, '제안을 찾지 못했어요.')
  await q(`update pro_room_suggestions set dismissed = array(select distinct unnest(dismissed || $2::uuid)), updated_at=now() where id=$1`, [s.id, me.id])
  return { ok: true }
}

async function broadcast(s) {
  for (const m of await M.membersOf(s.room_id)) emit(m.id, 'team', { type: 'assist', threadId: s.room_id, suggestion: view(m.id, s) })
}

// 시작: claim it (first click wins), then run as this person in the background
export async function start(me, id, run) {
  const s = await own(me, id)
  if (!s) throw new TeamError(404, '제안을 찾지 못했어요.')
  if (!s.audience.includes(me.id)) throw new TeamError(403, '이 제안은 요청받은 분이 시작할 수 있어요.')
  const [c] = await q(`update pro_room_suggestions set state='running', started_by=$2, updated_at=now() where id=$1 and state='open' returning *`, [s.id, me.id])
  if (!c) throw new TeamError(409, '이미 시작된 제안이에요.')
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
  const lines = await excerpt(s.room_id, s.chat_uuid)
  const rows = await q(`select messages from chats where id=$1 and messages ? 'pgpt' order by coalesce(public.pro_chat_ts(messages), now()) desc limit 6`, [s.room_id])
  const shareIds = rows.flatMap(({ messages: m }) => S.viewArtifacts(me.id, m.pgpt?.by || m.userId, m.pgpt?.artifacts).map((a) => a.shareId)).filter(Boolean)
  const files = shareIds.length ? await S.copiesFor(me, [...new Set(shareIds)].slice(0, 4)) : []
  return { lines, files }
}
