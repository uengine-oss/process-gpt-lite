// The AI's help when someone asks it for something — the same steps for a line said to the helper in a meeting (lib/meetings/intent.js)
// and for 「@AI …」 in the team messenger (lib/team/aiHelp.js). 2026-11-24 사용자: 「"@"하여 AI 를 지칭하여 … "장진영 이력서 첨부해" 같은 명령을
// 보내면 이러한 멘션이나 관련 자료를 첨부할 수 있음. 이는 회의실내에서도 AI 에게 도움을 요청하는 액션들과 동일함.」
// The words that decide are the skill's (skills/assist-help — a company may change them, lib/skillPack.js); the choices are the judge's
// (lib/decide.js choose: the first token's probability, JSON for a model without them). No word list reads what a person meant.
//   askedFor       what an addressed request wants: material (bring what exists here) · work (a 시작/아니요 suggestion) · answer
//   findMaterials  the candidates the asker may see (meetings/materials.js pool — retrieval only), then the judge picks the one(s) meant
//   workOf         which kind of work (team/assist.js WORKS), asked with the caller's judge
//   briefAnswer    a short reply when nothing is to be fetched or made
import { choose } from './decide.js'
import { chatJson } from './llm.js'
import { skillPack } from './skillPack.js'
import { L, isEn } from './lang.js'
import { WORKS } from './team/assist.js'
import * as MAT from './meetings/materials.js'

export const SKILL = 'assist-help'
const DEFAULTS = { maxCandidates: 12, minAction: 0.45, minPick: 0.4, alsoPick: 0.25, maxPicks: 4, contextLines: 4, timeoutMs: 8000, options: {} }
export async function helpSkill() {
  const s = await skillPack(SKILL)
  return { ...s, rules: { ...DEFAULTS, ...s.rules } }
}
// a prompt in the language of the screen (prompt-en.md when there is one)
const promptOf = (sk, name) => (isEn() && sk.prompts[`${name}-en`]) || sk.prompts[name] || ''
const optionOf = (sk, key) => sk.rules.options?.[isEn() ? 'en' : 'ko']?.[key] || sk.rules.options?.ko?.[key] || key
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// what the judge reads: the earlier lines (names and words, as given), then the request on its own line
export function stateOf(said, prev = [], n = DEFAULTS.contextLines) {
  const before = (prev || []).slice(-n).map((l) => clean(l).slice(0, 200)).filter(Boolean)
  return L(`${before.length ? `앞선 대화:\n${before.join('\n')}\n\n` : ''}방금 AI 에게 한 부탁:\n${clean(said).slice(0, 400)}`,
    `${before.length ? `Earlier messages:\n${before.join('\n')}\n\n` : ''}The request just made to the AI:\n${clean(said).slice(0, 400)}`)
}

// → {action: 'material'|'work'|'answer'|null, p, probabilities, strategy}; null when no judge answered (the caller says so)
// judges: {odds, json} for tests (decide.js choose)
export async function askedFor({ said, prev = [] }, { skill, judges = {} } = {}) {
  const sk = skill || await helpSkill()
  const options = ['material', 'work', 'answer'].map((key) => ({ key, label: optionOf(sk, key) }))
  const r = await choose(stateOf(said, prev, sk.rules.contextLines), promptOf(sk, 'action'), options, { ...judges, answerJson: sk.prompts['answer-json'], timeoutMs: sk.rules.timeoutMs })
  if (!r) return { action: null }
  return { action: r.confidence >= sk.rules.minAction ? r.choice : 'answer', p: r.confidence, probabilities: r.probabilities, strategy: r.strategy, model: r.model || null }
}

// how a candidate reads to the judge: its name, where it is, its document card's keywords
const WHERE = { file: ['대화방 · 내 산출물의 파일', 'a file in the room or my outputs'], process: ['진행 중인 업무', 'work in progress'], panel: ['팀 앱 기록', 'team app records'], folder: ['공유 폴더 문서의 수정본', "a revision of a shared folder's document"] }
export const candidateLabel = (c) => [String(c.title || '').slice(0, 90),
  c.folderFile ? L(`공유 폴더 「${c.where || ''}」`, `shared folder "${c.where || ''}"`) : L(...(WHERE[c.kind] || WHERE.file)),
  c.keywords?.length ? c.keywords.slice(0, 5).join(', ') : ''].filter(Boolean).join(' — ')

// pool: candidates (best first) → {picks: [candidate], judge: {p, strategy, model}}; [] when the judge says none or is unsure;
// failed: no judge answered (the caller says the model is not answering, not that nothing was found)
export async function pickAmong({ said, prev = [], pool }, { skill, judges = {} } = {}) {
  const sk = skill || await helpSkill()
  const R = sk.rules
  const list = (pool || []).slice(0, R.maxCandidates)
  if (!list.length) return { picks: [], judge: null }
  const options = [...list.map((c, i) => ({ key: `c${i}`, label: candidateLabel(c) })), { key: 'none', label: optionOf(sk, 'none') }]
  const r = await choose(stateOf(said, prev, R.contextLines), promptOf(sk, 'pick'), options, { ...judges, answerJson: sk.prompts['answer-json'], timeoutMs: R.timeoutMs })
  if (!r) return { picks: [], judge: null, failed: true }
  const judge = { p: Math.round((r.confidence || 0) * 100) / 100, strategy: r.strategy, model: r.model || null }
  if (r.choice === 'none' || r.confidence < R.minPick) return { picks: [], judge }
  const at = (k) => list[Number(String(k).slice(1))]
  // several asked for at once ("두 사람 이력서"): the others the judge gave a good share of its probability
  const also = Object.entries(r.probabilities || {}).filter(([k, p]) => k !== r.choice && k !== 'none' && p >= R.alsoPick)
    .sort((a, b) => b[1] - a[1]).slice(0, Math.max(0, R.maxPicks - 1)).map(([k]) => at(k)).filter(Boolean)
  return { picks: [at(r.choice), ...also].filter(Boolean), judge }
}

// → {picks, pool, judge} | {notFound: true, pool, judge} | {failed: true, pool} (no judge answered). kinds: which candidates may be
// picked (the messenger attaches files only)
// pool: the retrieval (tests pass a fixed list)
export async function findMaterials({ said, prev = [], roomId, asker, kinds = null }, { skill, judges = {}, pool: poolOf = MAT.pool } = {}) {
  const sk = skill || await helpSkill()
  let pool = await poolOf(said, { roomId, speaker: asker }, sk.rules.maxCandidates * 2)
  if (kinds) pool = pool.filter(kinds)
  pool = pool.slice(0, sk.rules.maxCandidates)
  if (!pool.length) return { notFound: true, pool, judge: null }
  const r = await pickAmong({ said, prev, pool }, { skill: sk, judges })
  if (r.failed) return { failed: true, pool, judge: null }
  if (!r.picks.length) return { notFound: true, pool, judge: r.judge }
  return { picks: r.picks, pool, judge: r.judge }
}

// the kinds of work the AI can be handed (team/assist.js — not starting or defining a process from a remark)
export const WORK_QUESTION = '방금 한 말이 AI 비서에게 부탁하는 일은 어떤 종류인가요?'
export const workOptions = () => Object.entries(WORKS).filter(([k]) => k !== 'StartProcessInstance' && k !== 'CreateProcessDefinition').map(([key, x]) => ({ key, label: x.label }))
// ask(state, question, options) → the judge's {probabilities, ms, model} (the meeting's own counted judge, or the messenger's)
export async function workOf(state, { ask }) {
  const w = await ask(state, WORK_QUESTION, workOptions())
  const [work, p] = Object.entries(w?.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || [null, 0]
  return { work, p, ms: w?.ms || 0, model: w?.model || null }
}

// a short reply in the room's words (two or three sentences) — null when the model did not answer
export async function briefAnswer({ said, prev = [] }, { skill, json = chatJson } = {}) {
  const sk = skill || await helpSkill()
  try {
    const j = await json(promptOf(sk, 'answer'), stateOf(said, prev, sk.rules.contextLines), { timeoutMs: 20000, temperature: 0.3 })
    const t = clean(j?.answer).slice(0, 600)
    return t || null
  } catch (e) { console.warn('[assist-help] answer', e.message); return null }
}
