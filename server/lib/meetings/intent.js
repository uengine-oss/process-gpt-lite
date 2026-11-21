// Intent detection on a meeting's rolling transcript — the team assist detector (lib/team/assist.js),
// inherited: a format gate, then the judge (lib/judge.js — the judge server, else the fast LLM), a
// debounce per meeting, counters like assist.stats. What a line means is read by the model only
// (decision 2, 2026-11-21); the options are skill descriptions (lib/offers.js, surface 'meeting').
// The big agent model is never called to detect (stats.bigModelCalls stays 0 on this path).
//   one judge call: none | show (open existing material now) | find (find / look at existing material)
//                   | a kind of work the assistant could make (a 시작/아니요 suggestion)
//   material: which candidate (lib/meetings/materials.js pick — embeddings shortlist, the judge picks)
// The judge sees the last few lines (names and text, ≤160 characters a line) and candidate names only.
import { formatGate } from '../team/assist.js'
import * as MAT from './materials.js'
import { L } from '../lang.js'
import { judge as ask, judgeAvailable, judgeLlm } from '../judge.js'
import { offers } from '../offers.js'
import * as EM from '../embed.js'

export const DEBOUNCE_MS = Number(process.env.PRO_MEETING_DEBOUNCE_MS || 1200)
const MIN_P = Number(process.env.PRO_MEETING_MIN_P || 0.6)
const PER_MIN = 6
// the least cosine to the nearest option for a line to be judged; unset = no embedding gate
const EMBED_MIN = () => (process.env.PRO_MEETING_EMBED_MIN ? Number(process.env.PRO_MEETING_EMBED_MIN) : null)

export const stats = { segments: 0, prefiltered: {}, judged: 0, judgeErrors: 0, materials: 0, suggested: 0, repeats: 0, bigModelCalls: 0, judgeMs: [], detectMs: [] }
const count = (why) => { stats.prefiltered[why] = (stats.prefiltered[why] || 0) + 1 }
const keep = (list, v) => { list.push(v); if (list.length > 300) list.shift() }
// the judge server, else the LLM (lib/judge.js)
export const judgeConfigured = () => judgeAvailable()

// ---- stage 1: format only ----
export function cue(text) {
  const g = formatGate(text)
  return g.pass ? { why: null } : { why: g.why }
}

async function judge(state, question, options, also) {
  const j = await ask({ state: state.slice(-1200), question, options, also })
  stats.judged++; keep(stats.judgeMs, j.ms)
  return j
}
const top = (j) => Object.entries(j?.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || [null, 0]
const line = (s) => `${s.speaker}: ${String(s.text).replace(/\s+/g, ' ').slice(0, 160)}`
const round = (x) => Math.round((x || 0) * 100) / 100
const yes = (v) => /^(y|yes|true|1)$/i.test(String(v || '').trim()) // the also-field's contract (format)

// the options of the one judge call, in the meeting's language
export function options() {
  return [
    { key: 'none', label: L('AI 비서가 할 일이 없는 말: 의견(결과물에 대한 의견 포함)·잡담·결정·진행 이야기·다룰 안건 소개, 참석한 사람(이름으로 부르는 사람)에게 일을 맡기는 말, 스스로 하겠다는 말 — 이미 있는 자료를 같이 보자는 말은 아님',
      'Nothing for the AI assistant to do: an opinion (also about a deliverable), small talk, a decision, a status update or the agenda, work given to someone at the meeting by name, or offering to do it oneself — not a proposal to look at existing material') },
    { key: 'show', label: L('이미 있는 자료(파일·폴더 문서·진행 중인 업무·팀 앱 기록·수정본)를 지금 열거나 띄워 보여 달라는 말',
      'Asks to open, pull up or show now an existing material (a file, a folder document, work in progress, team app records, a revised copy)') },
    { key: 'find', label: L('이미 있는 자료나 진행 상황을 찾아 달라거나, 지금이 아니어도 같이 보자고 하는 말(지금 열어 달라는 것은 아님)',
      'Asks to find, or proposes looking at together (now or later), an existing material or the progress of some work (not asking to open it right now)') },
    ...offers('meeting').map((o) => ({ key: o.key, label: o.label })),
  ]
}
const ALSO = () => ({
  title: L('부탁한 일이면 제안 카드 제목(무엇을 할지 한국어 25자 이내), 아니면 빈 문자열', 'if it asks for work: the suggestion card title (what will be done, at most 40 characters, in English), else empty'),
  to_assistant: L('그 말이 AI 비서에게 직접 한 말이면 "yes", 아니면 "no"', '"yes" if the remark is said to the AI assistant itself, else "no"'),
})

// One spoken line (after the debounce) → {material} | {request} | {repeat} | {notFound} | null.
// ctx: {roomId, speaker:{id,email,name}, prev:[segments before], shown: Set(material keys), lastMinute,
//      candidates? (a given list instead of the speaker's — the evaluation)}
export async function detect(seg, ctx) {
  const t0 = Date.now()
  const c = cue(seg.text)
  if (c.why) { count(c.why); return null }
  if (!judgeAvailable()) { count('no-judge'); return null }
  const opts = options()
  const min = EMBED_MIN()
  if (min != null) {
    const near = await EM.nearest(seg.text, opts.filter((o) => o.key !== 'none').map((o) => o.label))
    if (near != null && near < min) { count('far'); return null }
  }
  const prev = (ctx.prev || []).slice(-3).map(line)
  const state = L(`${prev.length ? `앞선 회의 대화:\n${prev.join('\n')}\n\n` : ''}방금 한 말:\n${line(seg)}`,
    `${prev.length ? `Earlier in the meeting:\n${prev.join('\n')}\n\n` : ''}Just said:\n${line(seg)}`)
  const j = await judge(state, L('방금 한 말은 회의를 함께 듣는 AI 비서가 할 일을 담고 있나요? 담고 있다면 어떤 일인가요?', 'Does the remark just made hold something for the AI assistant listening in to do? If so, what?'), opts, ALSO())
  const [key, p] = top(j)
  let ms = j.ms
  const addressed = j.extra?.to_assistant != null ? yes(j.extra.to_assistant) : key === 'show'
  if (!key || key === 'none' || p < MIN_P) { count(key === 'none' ? 'judge-none' : 'judge-unsure'); return null }
  if (key !== 'show' && key !== 'find') {
    keep(stats.detectMs, Date.now() - t0)
    return { request: { work: key, p, yes: p, ms, model: j.model, title: j.extra?.title || null } }
  }
  // which material: only candidates the speaker can see, the model picks by name
  const found = await MAT.pick(seg.text, ctx, { state, judge, list: ctx.candidates || null })
  ms += found.ms || 0
  if (!found.pick) { count('no-candidate'); return { notFound: { p: round(p), ms }, addressed } }
  const pick = found.pick
  const k = `${pick.kind}:${pick.id}`
  const open = key === 'show'
  if (ctx.shown?.has(k)) { stats.repeats++; count('already-shown'); return { repeat: k, open, addressed } }
  if ((ctx.lastMinute || 0) >= PER_MIN) { count('rate'); return null }
  keep(stats.detectMs, Date.now() - t0)
  return { material: { ...pick, key: k, judge: { p: round(p), kind: key, pick: round(found.p), shortlist: found.shortlist, ms, model: j.model } }, open, addressed }
}

const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }
export function report() {
  return { ...stats, judgeMs: undefined, detectMs: undefined, judge: judgeConfigured(), judgeLlm: judgeLlm(), embed: EM.embedAvailable(),
    judgeLatency: { n: stats.judgeMs.length, p50: pct(stats.judgeMs, 0.5), p90: pct(stats.judgeMs, 0.9) },
    detectLatency: { n: stats.detectMs.length, p50: pct(stats.detectMs, 0.5), p90: pct(stats.detectMs, 0.9) } }
}
