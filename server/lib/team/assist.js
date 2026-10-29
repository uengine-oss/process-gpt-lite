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
import { L, isEn, withLang, langOf } from '../lang.js'
import * as TR from '../translate.js'
import { mainLangOf, normMain } from '../mainLang.js'

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
// English mode (lib/lang.js): the same works in English — the judge's options, the card's badge and title
export const WORKS_EN = {
  CreateSpreadsheet: { label: 'Make a table or Excel file such as a quote, budget or expense sheet', noun: 'spreadsheet', badge: 'Table' },
  CreateDocument: { label: 'Write or revise a document such as a report, notice, plan or proposal', noun: 'document', badge: 'Document' },
  SummarizeChat: { label: 'Summarize or organize this conversation or material', noun: 'conversation', badge: 'Summary' },
  ScheduleRegistration: { label: 'Set up a meeting or event and put it on the calendar', noun: 'meeting', badge: 'Schedule' },
  CompanyQuery: { label: "Find and answer with the company's processes, work in progress, organization or materials", noun: 'information', badge: 'Lookup' },
  DraftReply: { label: 'Draft an e-mail, reply or announcement', noun: 'reply', badge: 'Reply' },
  StartProcessInstance: { label: 'Start a registered business process (request, approval, intake)', noun: 'process', badge: 'Process' },
  CreateProcessDefinition: { label: 'Create a new business process definition', noun: 'process definition', badge: 'Process' },
}
const NOUNS_EN = ['quote', 'estimate', 'expense sheet', 'budget', 'report', 'plan', 'notice', 'proposal', 'schedule', 'minutes', 'checklist', 'presentation', 'slides', 'announcement', 'invitation', 'list', 'comparison']
const worksOf = () => (isEn() ? WORKS_EN : WORKS)

// ---- stage 1: rules ----
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{P}\p{S}\s]*$/u
const CHAT = /^(ㅋ|ㅎ|ㅠ|ㅜ|넵|네|넹|예|응|ㅇㅇ|오케이|ok|굿|좋아요|좋네요|감사|고마워|고맙|수고|안녕|ㅇㅋ|헐|대박)/i
const SMALLTALK = /(점심|저녁|커피|날씨|퇴근|주말|ㅋㅋ|ㅎㅎ)/
const ASK = /(줘|주세요|주실|주시|줄\s*수|줄래|부탁|할까요|있을까요|될까요|가능할까|가능한가|해\s*봐|뽑아|만들어|정리해|\?|？)/
const WORK = /(견적|정산|예산|엑셀|표|시트|보고서|문서|계획서|안내문|제안서|초안|요약|정리|회의록|일정|미팅|회의|예약|캘린더|조사|찾아|알아봐|비교|분석|답장|회신|메일|공지|번역|발표|자료|ppt|피피티|신청|결재|접수|프로세스|절차|계산|현황|진행)/i
// a message with no Hangul is read with the English words (Korean messages exactly as before)
const CHAT_EN = /^(ok|okay|k|thanks|thank you|thx|ty|lol|haha|hi|hello|hey|yes|yep|yeah|sure|great|cool|nice|good|got it|sounds good|see you|bye)\b/i
const SMALLTALK_EN = /\b(lunch|dinner|coffee|weather|weekend|lol|haha)\b/i
const ASK_EN = /\b(can you|could you|would you|will you|please|pls|let's|lets|i need|we need|need (a|an|the)|make|draft|prepare|put together|send|write|create|set up|book|summari[sz]e|find|look up|check)\b|\?/i
const WORK_EN = /\b(quote|quotation|estimate|expense|budget|spreadsheet|excel|xlsx|sheet|table|report|document|doc|docx|plan|notice|proposal|draft|summary|summari[sz]e|minutes|schedule|meeting|book(ing)?|calendar|research|look up|find|compare|comparison|analy[sz]e|analysis|reply|respond|e-?mail|mail|announcement|translate|presentation|slides|deck|ppt|request|approval|process|procedure|calculate|status|progress)\b/i

// A message in another language than Korean or English (日本語, 中文, Español … — `hint` is its writer's
// main language) is not read by these word lists: it is judged by its translation into the language
// the card is written in, the way a meeting judges a line in another language (lib/meetings/service.js)
export function otherLang(body, hint = null) {
  const g = TR.guessLang(body, hint)
  return !!g.lang && g.lang !== 'ko' && g.lang !== 'en' && (g.sure || g.lang === normMain(hint)) ? g.lang : null
}
export function prefilter(body, hint = null) {
  const t = String(body || '').replace(/\s+/g, ' ').trim()
  if (!/[가-힣]/.test(t) && otherLang(t, hint)) {
    if (EMOJI_ONLY.test(t) || t.replace(/\s/g, '').length < 4) return { pass: false, why: EMOJI_ONLY.test(t) ? 'emoji' : 'short' }
    return { pass: false, why: 'other-lang', translate: true }
  }
  if (t.length < 8) return { pass: false, why: 'short' }
  if (!/[가-힣]/.test(t)) {
    if (EMOJI_ONLY.test(t)) return { pass: false, why: 'emoji' }
    if (CHAT_EN.test(t) && t.length < 24) return { pass: false, why: 'chat' }
    if (!WORK_EN.test(t)) return { pass: false, why: SMALLTALK_EN.test(t) ? 'smalltalk' : 'no-work' }
    if (!ASK_EN.test(t)) return { pass: false, why: 'not-a-request' }
    return { pass: true }
  }
  if (EMOJI_ONLY.test(t)) return { pass: false, why: 'emoji' }
  if (CHAT.test(t) && t.length < 20) return { pass: false, why: 'chat' }
  if (!WORK.test(t)) return { pass: false, why: SMALLTALK.test(t) ? 'smalltalk' : 'no-work' }
  if (!ASK.test(t)) return { pass: false, why: 'not-a-request' }
  return { pass: true }
}

// ---- counters (GET /api/team/assist/stats) ----
export const judgeConfigured = () => !!JUDGE_URL
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
  return rows.reverse().map(({ messages: m }) => `${m.userName || m.name || L('팀원', 'Teammate')}: ${(m.role === 'assistant' ? L('(에이전트) ', '(agent) ') : '') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}${(m.pgpt?.artifacts || []).length ? L(` [첨부: ${m.pgpt.artifacts.map((a) => a.name).join(', ')}]`, ` [attached: ${m.pgpt.artifacts.map((a) => a.name).join(', ')}]`) : ''}`)
}

function titleForEn(work, body) {
  const w = WORKS_EN[work]
  const noun = NOUNS_EN.find((n) => new RegExp(`\\b${n}`, 'i').test(body))
  const doc = noun && ['CreateSpreadsheet', 'CreateDocument', 'DraftReply'].includes(work) ? noun : w.noun
  return {
    CreateSpreadsheet: `Draft the ${doc}`, CreateDocument: `Draft the ${doc}`, DraftReply: `Draft the ${doc}`,
    SummarizeChat: 'Summarize this conversation', ScheduleRegistration: 'Schedule the meeting', CompanyQuery: 'Look up the information',
    StartProcessInstance: 'Start the process', CreateProcessDefinition: 'Create the process definition',
  }[work] || `Help with the ${w.noun}`
}
function titleFor(work, body) {
  if (isEn()) return titleForEn(work, body)
  const w = WORKS[work]
  const noun = NOUNS.find((n) => body.replace(/\s/g, '').includes(n.replace(/\s/g, '')))
  if (work === 'SummarizeChat') return '이 대화 요약하기'
  return `${noun && ['CreateSpreadsheet', 'CreateDocument', 'DraftReply'].includes(work) ? noun : w.noun} ${w.verb}`
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

// Does a request name this registered process? (stage 2c's shortlist for the judge)
// Korean words as before: a word of the request (2+ letters) inside the name. Other words (English)
// as whole words, never a piece of one ("of" is not in "Coffee", "on" not in "Moonlight"), without the
// function words and the words every process name has, and only for a meaningful part of the name:
// at least half of its own words, including the last one — what the process is ("…proposal",
// "…settlement") — or the request says it is a process ("the travel expense process"). A customer's
// name alone ("…after last week's Moonlight Coffee meeting") is not "Moonlight Coffee proposal".
const FUNCTION_EN = new Set(('a an the of on in at to for from by with into onto about over under after before as and or but nor so if '
  + 'is are was were be been am do does did have has had can could would will shall should may might must '
  + 'i me my we us our you your he him his she her it its they them their this that these those there here '
  + 'please pls let lets just also some any all each every no not one up out off new').split(' '))
const GENERIC_EN = new Set(['process', 'processes', 'procedure', 'workflow', 'flow', 'request', 'form', 'start'])
const SAYS_PROCESS = /\b(process|procedure|workflow)\b/i
const hangulWords = (s) => String(s || '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && /[가-힣]/.test(w))
const latinWords = (s) => (String(s || '').toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || [])
  .map((w) => w.replace(/'s$/, '')).filter((w) => w.length >= 2 && !FUNCTION_EN.has(w))
// "expenses" for "expense", "settle" for "settlement" (a word of 4+ letters that starts the other)
const sameWord = (a, b) => a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b))
export function processMatch(body, name) {
  const n = String(name || '')
  if (hangulWords(body).some((w) => n.includes(w))) return true
  const own = [...new Set(latinWords(n))].filter((w) => !GENERIC_EN.has(w))
  if (!own.length) return false
  const said = latinWords(body)
  const hit = own.filter((w) => said.some((s) => sameWord(s, w)))
  return hit.length >= Math.ceil(own.length / 2) && (hit.includes(own[own.length - 1]) || SAYS_PROCESS.test(String(body)))
}
async function processCandidates(body) {
  const defs = await q(`select id, name from proc_def where tenant_id=$1 and coalesce(isdeleted,false)=false and name is not null`, [T()]).catch(() => [])
  return defs.filter((d) => processMatch(body, d.name)).slice(0, 5)
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
    const pf = prefilter(m.content, await mainLangOf(author.id).catch(() => null))
    if (!pf.pass && !pf.translate) return count(pf.why)
    // an install without a judge server (PRO_JUDGE_URL empty, e.g. the Docker bundle): rules only, no suggestions
    if (!JUDGE_URL) return count('no-judge')
    clearTimeout(timers.get(row.id))
    // the latest message of a burst is judged with the ones before it
    timers.set(row.id, setTimeout(() => {
      timers.delete(row.id)
      detect(row, humans, author, { translate: !!pf.translate }).catch((e) => { stats.judgeErrors++; console.warn('[assist]', e.message) })
    }, DEBOUNCE_MS))
  })
}

// the card is written in the language of the person whose message it answers (lib/lang.js)
export async function detect(row, humans0, author, opts) {
  return withLang(await langOf(author.id), () => detectIn(row, humans0, author, opts))
}
// another language's message, in the card's language (the reader translation's cache: a teammate who
// reads this language already made it, or will reuse it) — null when it cannot be translated now
export async function readable(body, { hint = null, budget = null } = {}) {
  const r = await TR.translate(body, { to: isEn() ? 'en' : 'ko', hint, kind: 'chat', budget })
  if (!r || r.off || r.limited || r.error || !r.text) return null
  return r.text
}
async function detectIn(row, humans0, author, { translate = false } = {}) {
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
  // another language: the rules, the judge, the card's title and the process names read its translation
  let body = said
  if (translate) {
    body = await readable(said, { hint: await mainLangOf(author.id).catch(() => null), budget: `assist:${roomId}` })
    if (!body) return count('other-lang-untranslated')
    const pf = prefilter(body)
    if (!pf.pass) return count(pf.why)
  }
  const lines = await excerpt(roomId, row.uuid)
  if (body !== said && lines.length) {
    const orig = said.replace(/\s+/g, ' ').slice(0, 200)
    lines[lines.length - 1] = lines[lines.length - 1].replace(orig, body.replace(/\s+/g, ' ').slice(0, 200))
  }
  // the new message stands apart from what came before (mixed in, earlier chit-chat pulls "yes" down)
  const prev = lines.slice(0, -1)
  const state = L(`${prev.length ? `앞선 대화:\n${prev.join('\n')}\n\n` : ''}방금 온 메시지:\n${lines[lines.length - 1]}`,
    `${prev.length ? `Earlier messages:\n${prev.join('\n')}\n\n` : ''}New message:\n${lines[lines.length - 1]}`)
  // 2a. a request for work at all? (a separate yes/no: with the works beside it the judge almost never says no)
  const y = await judge(state, L('방금 온 메시지는 어떤 말인가요?', 'What is the new message?'), L([
    { key: 'no', label: '사람에게 의견이나 사정을 묻거나 잡담하는 말' },
    { key: 'yes', label: '자료·문서·표·일정·조사 같은 결과물을 만들어 달라는 부탁' }], [
    { key: 'no', label: 'Asking a person for an opinion or how things are, or small talk' },
    { key: 'yes', label: 'Asking for something to be made: material, a document, a table, a schedule or research' }]))
  const yes = y.probabilities?.yes ?? 0
  if (yes < MIN_YES) { console.log(`[assist] judge ${y.ms}ms yes=${yes.toFixed(2)} → no · ${body.slice(0, 40)}`); return count('judge-no') }
  // 2b. which work
  const j = await judge(state, L('방금 온 메시지가 AI 비서에게 부탁하는 일은 어떤 종류인가요?', 'What kind of work does the new message ask the AI assistant for?'), Object.entries(worksOf()).map(([key, w]) => ({ key, label: w.label })))
  let [work, p] = Object.entries(j.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || []
  let ms = y.ms + j.ms
  if (!work || p < MIN_P) { console.log(`[assist] judge ${ms}ms yes=${yes.toFixed(2)} ${work}=${(p || 0).toFixed(2)} → unsure`); return count('judge-work') }
  // 2c. StartProcessInstance against proc_def, as process-gpt does: only among registered processes that
  // share a word with the request; none fits → the agent does the work itself
  let proc = null
  const cands = ['StartProcessInstance', 'CreateSpreadsheet', 'CreateDocument'].includes(work) ? await processCandidates(body) : []
  if (cands.length) {
    const pj = await judge(lines[lines.length - 1], L('이 요청에 맞는 등록된 업무 프로세스는?', 'Which registered business process fits this request?'), [{ key: 'none', label: L('맞는 프로세스 없음', 'No process fits') }, ...cands.map((d) => ({ key: d.id, label: d.name }))]).catch(() => null)
    if (pj) ms += pj.ms
    const best = pj && Object.entries(pj.probabilities || {}).sort((a, b) => b[1] - a[1])[0]
    if (best && best[0] !== 'none' && best[1] >= 0.6) { proc = cands.find((d) => d.id === best[0]); work = 'StartProcessInstance' }
  }
  if (work === 'StartProcessInstance' && !proc) work = 'CompanyQuery'
  const humans = humans0.map((h) => ({ id: h.id, name: h.username || h.name, email: h.email }))
  const audience = audienceOf(humans, author.id, body)
  if (!audience.length) return count('no-audience')
  const title = proc ? L(`${proc.name} 시작하기`, `Start ${proc.name}`) : titleFor(work, body)
  const who = author.username || author.name || L('팀원', 'Teammate')
  // (the request in its writer's own words)
  const reason = L(`${who}님의 요청 "${said.replace(/\s+/g, ' ').slice(0, 60)}${said.length > 60 ? '…' : ''}" · 판단 모델 ${Math.round(p * 100)}%`,
    `${who}'s request "${said.replace(/\s+/g, ' ').slice(0, 60)}${said.length > 60 ? '…' : ''}" · routing model ${Math.round(p * 100)}%`)
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
  // a meeting's suggestions hang under the room row they came from (회의록 block / minutes: anchor_uuid)
  const messageId = s.anchor_uuid || s.chat_uuid
  if (s.state === 'open' && !offered) return { id: s.id, threadId: s.room_id, messageId, hidden: true }
  return { id: s.id, threadId: s.room_id, messageId, meetingId: s.meeting_id || null, work: s.work, kind: L(WORKS[s.work]?.badge || '도움', WORKS_EN[s.work]?.badge || 'Help'), title: s.title, reason: s.reason, state: s.state,
    startedBy: s.started_by, resultMessageId: s.result_uuid, mine: s.started_by === viewerId, canStart: offered && s.state === 'open', judge: s.judge }
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
  const [c] = await q(`update pro_room_suggestions set state='running', started_by=$2, updated_at=now() where id=$1 and state='open' returning *`, [s.id, me.id])
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
