// Intent detection on a meeting's rolling transcript — the team assist detector (lib/team/assist.js),
// inherited and extended: rules first, then the judge model (context-router's typed-decision server: a
// softmax over option letters, no text generated), a debounce per meeting, counters like assist.stats.
// The big agent model is never called to detect (stats.bigModelCalls stays 0 on this path).
//   material  "지난번 견적서 다시 보자" → which kind (file/process/panel/folder) → which candidate
//   request   "견적서 5% 낮춰서 다시 만들어줘" → assist's request + work questions → a 시작/아니요 suggestion
// The judge sees the last few lines (names and text, ≤160 characters a line) and candidate names only.
import { prefilter as requestPrefilter } from '../team/assist.js'
// which material and which work: the same functions the messenger's 「@AI …」 calls (lib/assistHelp.js, skill assist-help)
import * as H from '../assistHelp.js'
import { isEn } from '../lang.js'
import { judge as ask, judgeAvailable, judgeLlm } from '../judge.js'

export const DEBOUNCE_MS = Number(process.env.PRO_MEETING_DEBOUNCE_MS || 1200)
const MIN_REQ = 0.7
const MIN_MAT = 0.6
const PER_MIN = 6

export const stats = { segments: 0, prefiltered: {}, judged: 0, judgeErrors: 0, materials: 0, suggested: 0, repeats: 0, bigModelCalls: 0, judgeMs: [], detectMs: [] }
const count = (why) => { stats.prefiltered[why] = (stats.prefiltered[why] || 0) + 1 }
const keep = (list, v) => { list.push(v); if (list.length > 300) list.shift() }
// the judge server, else the LLM (lib/judge.js)
export const judgeConfigured = () => judgeAvailable()

// ---- stage 1: rules ----
const CUE = /(견적|평면도|도면|설계|정산|출장|휴가|연차|일정|안내문|공문|제안서|보고서|수정한\s*버전|수정본|변형|자료|파일|문서|표|시트|보여|띄워|열어|다시\s*보|어디까지|진행\s*상황|현황|확인|상태)/
// English meetings (the meeting's language is en): the same three questions in English words.
// ("proposal" is left out of the material cue: it names the deal as often as the document — "let's get
// started on the Moonlight Coffee proposal"; "let's look at the proposal" still cues by "look at")
// "Can you redo the quote 5% lower?" / "Let's look at the quote again" / "Pull up the floor plan"
const ASK_EN = /\b(can\s+you|could\s+you|would\s+you|will\s+you|please|let'?s|i'?d\s+like|we\s+need|i\s+need|send\s+(me|us|it)|make\s+(me|us))\b|\?/i
const WORK_EN = /\b(quotes?|quotations?|estimates?|budgets?|expenses?|spreadsheets?|excel|sheets?|tables?|reports?|documents?|docs?|plans?|notices?|proposals?|drafts?|summar(y|ies|ize|ise)|minutes|schedules?|meetings?|calendar|book|research|look\s+up|find|compare|analy[sz]e|reply|answer|e-?mail|mails?|announcement|translat(e|ion)|presentation|slides?|deck|ppt|materials?|request|approval|process|procedure|calculat(e|ion)|status|progress)\b/i
const FIGURE_EN = /\b(amount|price|prices|pricing|unit\s+price|discount|quantity|quantities|cost|costs|total)\b/i
const MAKE_EN = /\b(make|makes|making|create|redo|re-?do|remake|fix|change|revise|update|lower|reduce|cut|raise|increase|put\s+together|draft|write|prepare|calculate|work\s+out|turn\s+(it|this)\s+into|find|look\s+up|research|search)\b/i
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
    const req = e.req || (shapedKo && /(만들어|다시\s*만들|고쳐|바꿔|수정해|낮춰|올려|정리해|작성해|뽑아|계산해|찾아|알아봐|조사해|검색해)/.test(t))
    const mat = e.mat || CUE.test(t)
    return { material: mat, request: req, why: !mat && !req ? 'no-cue' : null }
  }
  // assist's request rules, or a figure to change ("금액 5% 낮춰서") — speech is looser than typed chat;
  // "관련 자료 좀 찾아줄래?" is a request to the assistant too (CompanyQuery), not only a material to show (2026-11-18)
  const shaped = requestPrefilter(t).pass || (/(금액|가격|단가|할인|수량|비용)/.test(t) && /(줘|주세요|주실|부탁)/.test(t))
  const req = shaped && /(만들어|다시\s*만들|고쳐|바꿔|수정해|낮춰|올려|정리해|작성해|뽑아|계산해|찾아|알아봐|조사해|검색해)/.test(t)
  const mat = CUE.test(t)
  return { material: mat, request: req, why: !mat && !req ? 'no-cue' : null }
}

async function judge(state, question, options) {
  const j = await ask({ state: state.slice(0, 1200), question: judgeQuestion(question), options: judgeOptions(options) })
  stats.judged++; keep(stats.judgeMs, j.ms)
  return j
}
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
const REQ_NO = '참석한 사람(이름이나 님으로 부르는 사람)에게 일을 맡기거나, 스스로 하겠다고 하거나, 의견을 나누는 말'
const REQ_YES = '사람 이름 없이 결과물(문서·표)을 만들거나 고치거나, 자료·정보를 찾아 달라는 부탁 — 회의를 함께 듣는 AI 비서가 할 수 있는 일'
const OPT_EN = {
  [REQ_NO]: 'Giving work to someone at the meeting (named), offering to do it oneself, or sharing an opinion',
  [REQ_YES]: 'Asking, without naming a person, for a deliverable (a document or a table) to be made or revised, or for material or information to be found — work the AI assistant listening in can do',
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
  if (!judgeAvailable()) { count('no-judge'); return null }
  const prev = (ctx.prev || []).slice(-3).map(line)
  const state = isEn()
    ? `${prev.length ? `Earlier in the meeting:\n${prev.join('\n')}\n\n` : ''}Just said:\n${line(seg)}`
    : `${prev.length ? `앞선 회의 대화:\n${prev.join('\n')}\n\n` : ''}방금 한 말:\n${line(seg)}`
  let ms = 0
  // a request for the assistant? (its own yes/no — mixed with other options the judge seldom says no)
  if (c.request) {
    // who it is said to: a person is named ("민지님이 …"), or nobody is — then it is for the helper. The old
    // labels left "견적서 금액 5% 낮춰서 다시 만들어 주세요" to a person (LLM judge 0.15 yes, 2026-11-19); these
    // separate 4 requests (0.92) from 3 remarks to or by people (≤0.08) on the same model
    const y = await judge(state, '방금 한 말은 어떤 말인가요?', [
      { key: 'no', label: REQ_NO },
      { key: 'yes', label: REQ_YES }])
    ms += y.ms
    const yes = y.probabilities?.yes ?? 0
    if (yes >= MIN_REQ) {
      const w = await H.workOf(state, { ask: judge })
      ms += w.ms
      let { work, p } = w
      // a table named and no document (or the other way round) settles a table/document pick the model
      // wavered on ("견적서 금액 … 다시 만들어 주세요" came back CreateDocument now and then from an LLM judge)
      const said = String(seg.text || '')
      if (work === 'CreateDocument' && SHEET_WORD.test(said) && !DOC_WORD.test(said)) work = 'CreateSpreadsheet'
      else if (work === 'CreateSpreadsheet' && DOC_WORD.test(said) && !SHEET_WORD.test(said)) work = 'CreateDocument'
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
  // which one: what the speaker may see, and the judge picks what the line means (lib/assistHelp.js — the messenger's @AI does the same)
  // asked for, and nothing of that name anywhere the speaker can look: said so (it used to end here in silence — "셉 ERP 관련 PDF 좀
  // 열어볼래?" and the helper kept saying 듣고 있어요, 2026-11-19)
  const found = await H.findMaterials({ said: seg.text, prev, roomId: ctx.roomId, asker: ctx.speaker }, { judges: ctx.judges })
  if (found.judge) stats.judged++
  // (no judge answered: the caller says the model is not answering — detectOne)
  if (found.failed) throw new Error('judge did not answer (pick)')
  if (found.notFound) { count('no-candidate'); return { notFound: { yes: round(yes), ms } } }
  const [pick, ...more] = found.picks
  const key = `${pick.kind}:${pick.id}`
  // the same words as something already on the panel: they mean that one
  if (ctx.shown?.has(key)) { stats.repeats++; count('already-shown'); return { repeat: key } }
  if ((ctx.lastMinute || 0) >= PER_MIN) { count('rate'); return null }
  keep(stats.detectMs, Date.now() - t0)
  return { material: { ...pick, key, judge: { yes: round(yes), pick: found.judge?.p ?? null, strategy: found.judge?.strategy || null, ms, model: found.judge?.model || null } },
    more: more.filter((x) => !ctx.shown?.has(`${x.kind}:${x.id}`)).map((x) => ({ ...x, key: `${x.kind}:${x.id}`, judge: { yes: round(yes), ms } })) }
}
const round = (x) => Math.round((x || 0) * 100) / 100

// said to the helper ("…열어볼래?", "띄워 줘", "찾아 주세요") rather than about something: such a remark
// always gets an answer, even when nothing was found or the judge could not be asked
const ASKED = /(열어|보여|띄워|찾아|꺼내|가져와|불러|틀어)\s*(볼래|줄래|줘|주세요|주실|봐|볼까|줄\s*수|주시겠|줄래요|봐요|봐\s*줘)/
const ASKED_EN = /\b(open|show|pull\s+up|bring\s+up|put\s+up|find|look\s+up)\b/i
export const addressed = (text) => { const t = String(text || ''); return ASKED.test(t.replace(/\s+/g, ' ')) || (isEn() && ASKED_EN.test(t) && ASK_EN.test(t)) }
const SHEET_WORD = /(견적서|견적|예산표|정산표|엑셀|스프레드시트|시트|\b(quotes?|quotations?|estimates?|budgets?|spreadsheets?|excel)\b)/i
const DOC_WORD = /(보고서|안내문|계획서|제안서|공문|문서|\b(reports?|notices?|letters?|proposals?|documents?)\b)/i
const FILE_WORD =/(자료|파일|문서|폴더|pdf|피디에프|엑셀|excel|ppt|피피티|워드|한글\s*(파일|문서)|보고서|제안서|견적|계획서|안내문|회의록|도면|시트|\b(file|document|folder|sheet|deck|slides|report|quote)s?\b)/i
export const namesFile = (text) => FILE_WORD.test(String(text || ''))
// "열어볼래?" / "보여 줘": the one who asked sees it open at once (others see it on their 자료 panel)
const OPEN = /(열어|보여|띄워|틀어)/
const OPEN_EN = /\b(open|show|pull\s+up|bring\s+up|put\s+up)\b/i
export const wantsOpen = (text) => OPEN.test(String(text || '')) || OPEN_EN.test(String(text || ''))

const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }
export function report() {
  return { ...stats, judgeMs: undefined, detectMs: undefined, judge: judgeConfigured(), judgeLlm: judgeLlm(),
    judgeLatency: { n: stats.judgeMs.length, p50: pct(stats.judgeMs, 0.5), p90: pct(stats.judgeMs, 0.9) },
    detectLatency: { n: stats.detectMs.length, p50: pct(stats.detectMs, 0.5), p90: pct(stats.detectMs, 0.9) } }
}
