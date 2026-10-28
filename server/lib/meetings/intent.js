// Intent detection on a meeting's rolling transcript — the team assist detector (lib/team/assist.js),
// inherited and extended: rules first, then the judge model (context-router's typed-decision server: a
// softmax over option letters, no text generated), a debounce per meeting, counters like assist.stats.
// The big agent model is never called to detect (stats.bigModelCalls stays 0 on this path).
//   material  "지난번 견적서 다시 보자" → which kind (file/process/panel/folder) → which candidate
//   request   "견적서 5% 낮춰서 다시 만들어줘" → assist's request + work questions → a 시작/아니요 suggestion
// The judge sees the last few lines (names and text, ≤160 characters a line) and candidate names only.
import { prefilter as requestPrefilter, WORKS } from '../team/assist.js'
import * as MAT from './materials.js'
import { isEn } from '../lang.js'

const JUDGE_URL = process.env.PRO_JUDGE_URL ?? 'http://127.0.0.1:8896/judge'
const JUDGE_MS = Number(process.env.PRO_ASSIST_JUDGE_TIMEOUT_MS || 5000)
export const DEBOUNCE_MS = Number(process.env.PRO_MEETING_DEBOUNCE_MS || 1200)
const MIN_REQ = 0.7
const MIN_MAT = 0.6
const PER_MIN = 6

export const stats = { segments: 0, prefiltered: {}, judged: 0, judgeErrors: 0, materials: 0, suggested: 0, repeats: 0, bigModelCalls: 0, judgeMs: [], detectMs: [] }
const count = (why) => { stats.prefiltered[why] = (stats.prefiltered[why] || 0) + 1 }
const keep = (list, v) => { list.push(v); if (list.length > 300) list.shift() }
export const judgeConfigured = () => !!JUDGE_URL

// ---- stage 1: rules ----
const CUE = /(견적|평면도|도면|설계|정산|출장|휴가|연차|일정|안내문|공문|제안서|보고서|수정한\s*버전|수정본|변형|자료|파일|문서|표|시트|보여|띄워|열어|다시\s*보|어디까지|진행\s*상황|현황|확인|상태)/
// English meetings (the meeting's language is en): the same three questions in English words.
// ("proposal" is left out of the material cue: it names the deal as often as the document — "let's get
// started on the Moonlight Coffee proposal"; "let's look at the proposal" still cues by "look at")
// "Can you redo the quote 5% lower?" / "Let's look at the quote again" / "Pull up the floor plan"
const ASK_EN = /\b(can\s+you|could\s+you|would\s+you|will\s+you|please|let'?s|i'?d\s+like|we\s+need|i\s+need|send\s+(me|us|it)|make\s+(me|us))\b|\?/i
const WORK_EN = /\b(quotes?|quotations?|estimates?|budgets?|expenses?|spreadsheets?|excel|sheets?|tables?|reports?|documents?|docs?|plans?|notices?|proposals?|drafts?|summar(y|ies|ize|ise)|minutes|schedules?|meetings?|calendar|book|research|look\s+up|find|compare|analy[sz]e|reply|answer|e-?mail|mails?|announcement|translat(e|ion)|presentation|slides?|deck|ppt|materials?|request|approval|process|procedure|calculat(e|ion)|status|progress)\b/i
const FIGURE_EN = /\b(amount|price|prices|pricing|unit\s+price|discount|quantity|quantities|cost|costs|total)\b/i
const MAKE_EN = /\b(make|makes|making|create|redo|re-?do|remake|fix|change|revise|update|lower|reduce|cut|raise|increase|put\s+together|draft|write|prepare|calculate|work\s+out|turn\s+(it|this)\s+into)\b/i
const CUE_EN = /\b(quotes?|quotations?|estimates?|floor\s*plans?|drawings?|layouts?|designs?|expenses?|travel|leave|vacation|time\s+off|schedules?|notices?|letters?|reports?|revised|revision|new\s+version|versions?|variations?|materials?|files?|documents?|tables?|sheets?|show|pull\s+up|bring\s+up|put\s+up|open|look\s+at|look\s+again|take\s+a\s+look|where\s+are\s+we|how\s+far|progress|status|check)\b/i
function cueEn(t) {
  const shaped = (ASK_EN.test(t) && WORK_EN.test(t)) || (FIGURE_EN.test(t) && ASK_EN.test(t))
  const req = shaped && MAKE_EN.test(t)
  const mat = CUE_EN.test(t)
  return { req, mat }
}

export function cue(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length < 5) return { material: false, request: false, why: 'short' }
  // an English meeting: English cues (or Korean ones, for a mixed meeting)
  if (isEn()) {
    const e = cueEn(t)
    const shapedKo = requestPrefilter(t).pass || (/(금액|가격|단가|할인|수량|비용)/.test(t) && /(줘|주세요|주실|부탁)/.test(t))
    const req = e.req || (shapedKo && /(만들어|다시\s*만들|고쳐|바꿔|수정해|낮춰|올려|정리해|작성해|뽑아|계산해)/.test(t))
    const mat = e.mat || CUE.test(t)
    return { material: mat, request: req, why: !mat && !req ? 'no-cue' : null }
  }
  // assist's request rules, or a figure to change ("금액 5% 낮춰서") — speech is looser than typed chat
  const shaped = requestPrefilter(t).pass || (/(금액|가격|단가|할인|수량|비용)/.test(t) && /(줘|주세요|주실|부탁)/.test(t))
  const req = shaped && /(만들어|다시\s*만들|고쳐|바꿔|수정해|낮춰|올려|정리해|작성해|뽑아|계산해)/.test(t)
  const mat = CUE.test(t)
  return { material: mat, request: req, why: !mat && !req ? 'no-cue' : null }
}

async function judge(state, question, options) {
  const t0 = Date.now()
  const r = await fetch(JUDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(JUDGE_MS),
    body: JSON.stringify({ state: state.slice(0, 1200), question: judgeQuestion(question), options: judgeOptions(options) }) })
  if (!r.ok) throw new Error(`judge ${r.status}`)
  const j = await r.json()
  const ms = Date.now() - t0
  stats.judged++; keep(stats.judgeMs, ms)
  return { ...j, ms }
}
const top = (j) => Object.entries(j.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || [null, 0]
const line = (s) => `${s.speaker}: ${String(s.text).replace(/\s+/g, ' ').slice(0, 160)}`

// the judge's questions and options in the meeting's language (keys never change): a small judge
// model reads English lines best against English labels
const Q_EN = {
  '방금 한 말은 어떤 말인가요?': 'What kind of remark was just made?',
  '방금 한 말이 AI 비서에게 부탁하는 일은 어떤 종류인가요?': 'What kind of work does the remark just made ask the AI assistant to do?',
  '방금 한 말이 보자는 자료는 어떤 종류인가요?': 'What kind of material does the remark just made want to look at?',
  '방금 한 말이 가리키는 자료는?': 'Which material does the remark just made point to?',
}
export const WORKS_EN = {
  CreateSpreadsheet: 'Make a table or spreadsheet such as a quote, budget or expense sheet',
  CreateDocument: 'Write or revise a document such as a report, notice, plan or proposal',
  SummarizeChat: 'Summarize or organize this conversation or material',
  ScheduleRegistration: 'Set up a meeting or schedule and put it on the calendar',
  CompanyQuery: "Find and answer with the company's processes, work in progress, organization or materials",
  DraftReply: 'Draft an e-mail, reply or announcement',
  StartProcessInstance: 'Start a registered business process (request, approval, intake)',
  CreateProcessDefinition: 'Create a new business process (procedure) definition',
}
const OPT_EN = {
  '참석한 사람에게 일을 맡기거나, 의견을 나누거나, 자료를 보자는 말': 'Giving work to someone at the meeting, sharing an opinion, or asking to look at material',
  'AI 비서에게 문서·표 같은 결과물을 새로 만들거나 고쳐 달라는 부탁': 'Asking the AI assistant to make or revise a deliverable such as a document or a table',
  '의견·잡담·결정처럼 자료를 찾을 필요가 없는 말': 'An opinion, small talk or a decision that needs no material looked up',
  '이미 있는 파일·문서·진행 상황·기록을 찾아서 보자는 말': 'Asking to find and look at an existing file, document, progress or record',
}
const KINDS_EN = {
  file: 'Asking to look again at a file or document such as a quote, floor plan or notice',
  process: 'Asking how far work in progress such as a request, approval or expense settlement has got',
  panel: "Asking to check records kept in a team app, such as a leave schedule or a list",
  folder: 'Asking to see a revised copy or version of a shared folder document someone changed',
}
// options as given (Korean meeting), or with English labels (English meeting); keys unchanged
export function judgeOptions(options) {
  if (!isEn()) return options
  return options.map((o) => ({ ...o, label: OPT_EN[o.label] || (KINDS.some((k) => k.key === o.key && k.label === o.label) && KINDS_EN[o.key]) || WORKS_EN[o.key] || o.label }))
}
export const judgeQuestion = (question) => (isEn() ? Q_EN[question] || question : question)

const KINDS = [
  { key: 'file', label: '견적서·평면도·안내문 같은 파일이나 문서를 다시 보자는 말' },
  { key: 'process', label: '신청·결재·정산 같은 진행 중인 업무가 어디까지 갔는지 묻는 말' },
  { key: 'panel', label: '휴가 일정·명단 같은 팀 앱에 쌓인 기록을 확인하자는 말' },
  { key: 'folder', label: '공유 폴더 문서를 누가 고친 수정본·버전을 보자는 말' },
]

// One spoken line (after the debounce) → {material} | {request} | null.
// ctx: {roomId, speaker:{id,email,name}, prev:[segments before], shown: Set(material keys)}
export async function detect(seg, ctx) {
  const t0 = Date.now()
  const c = cue(seg.text)
  if (c.why) { count(c.why); return null }
  if (!JUDGE_URL) { count('no-judge'); return null }
  const prev = (ctx.prev || []).slice(-3).map(line)
  const state = isEn()
    ? `${prev.length ? `Earlier in the meeting:\n${prev.join('\n')}\n\n` : ''}Just said:\n${line(seg)}`
    : `${prev.length ? `앞선 회의 대화:\n${prev.join('\n')}\n\n` : ''}방금 한 말:\n${line(seg)}`
  let ms = 0
  // a request for the assistant? (its own yes/no — mixed with other options the judge seldom says no)
  if (c.request) {
    const y = await judge(state, '방금 한 말은 어떤 말인가요?', [
      { key: 'no', label: '참석한 사람에게 일을 맡기거나, 의견을 나누거나, 자료를 보자는 말' },
      { key: 'yes', label: 'AI 비서에게 문서·표 같은 결과물을 새로 만들거나 고쳐 달라는 부탁' }])
    ms += y.ms
    const yes = y.probabilities?.yes ?? 0
    if (yes >= MIN_REQ) {
      const w = await judge(state, '방금 한 말이 AI 비서에게 부탁하는 일은 어떤 종류인가요?', Object.entries(WORKS).filter(([k]) => k !== 'StartProcessInstance' && k !== 'CreateProcessDefinition').map(([key, x]) => ({ key, label: x.label })))
      ms += w.ms
      const [work, p] = top(w)
      if (work && p >= 0.45) {
        keep(stats.detectMs, Date.now() - t0)
        return { request: { work, p, yes, ms, model: w.model } }
      }
      count('judge-work')
    } else count('judge-not-request')
    if (!c.material) return null
  }
  // looking at something that already exists?
  const m = await judge(state, '방금 한 말은 어떤 말인가요?', [
    { key: 'no', label: '의견·잡담·결정처럼 자료를 찾을 필요가 없는 말' },
    { key: 'yes', label: '이미 있는 파일·문서·진행 상황·기록을 찾아서 보자는 말' }])
  ms += m.ms
  const yes = m.probabilities?.yes ?? 0
  if (yes < MIN_MAT) { count('judge-no'); return null }
  // which kind, then which one (only candidates the speaker can see, named in what was said)
  const ranked = await MAT.ranked(seg.text, ctx)
  const k = await judge(line(seg), '방금 한 말이 보자는 자료는 어떤 종류인가요?', KINDS)
  ms += k.ms
  const [kind, pk] = top(k)
  let pool = ranked.filter((x) => x.kind === kind)
  if (!pool.length) pool = ranked
  if (!pool.length) { count('no-candidate'); return null }
  let pick = pool[0], pc = 1
  const tied = pool.filter((x) => x.score === pool[0].score).slice(0, 6)
  // the same words as something already on the panel: they mean that one
  const onPanel = pool.find((x) => x.score >= pool[0].score - 0.5 && ctx.shown?.has(`${x.kind}:${x.id}`))
  if (onPanel) { stats.repeats++; count('already-shown'); return { repeat: `${onPanel.kind}:${onPanel.id}` } }
  if (tied.length > 1) {
    const w = await judge(line(seg), '방금 한 말이 가리키는 자료는?', tied.map((x, i) => ({ key: `c${i}`, label: x.title.slice(0, 80) })))
    ms += w.ms
    const [key, p] = top(w)
    pick = tied[Number(String(key).slice(1))] || tied[0]; pc = p
  }
  const key = `${pick.kind}:${pick.id}`
  if (ctx.shown?.has(key)) { stats.repeats++; count('already-shown'); return { repeat: key } }
  if ((ctx.lastMinute || 0) >= PER_MIN) { count('rate'); return null }
  keep(stats.detectMs, Date.now() - t0)
  return { material: { ...pick, key, judge: { yes: round(yes), kind, pk: round(pk), pick: round(pc), ms, model: k.model } } }
}
const round = (x) => Math.round((x || 0) * 100) / 100

const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }
export function report() {
  return { ...stats, judgeMs: undefined, detectMs: undefined, judge: judgeConfigured(),
    judgeLatency: { n: stats.judgeMs.length, p50: pct(stats.judgeMs, 0.5), p90: pct(stats.judgeMs, 0.9) },
    detectLatency: { n: stats.detectMs.length, p50: pct(stats.detectMs, 0.5), p90: pct(stats.detectMs, 0.9) } }
}
