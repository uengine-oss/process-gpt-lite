// A browser task waiting for the person, and what they type meanwhile (2026-11-25 recording, project room 「링크 슬라이드 팟캐스트」:
// a NotebookLM task asked which notebook to use on a card, the person typed 「새로 만들어」 in the composer instead — it became a new
// browser task queued behind the waiting one, and everything was blocked until 멈추기. Then 「작업을 마치고 아까 노트북 엘엠 만들던거
// 진행해」 started the NotebookLM work before the stopped deletion was finished). 「계속 이렇게 막히는 문제가 있어 … 여기서 마치고 해라
// 라고 했는데 마치기 전에 자꾸 다음 일을 하려고」.
//
// What the words mean is read by the judge (lib/judge.js), never by words or patterns in code:
//   · readWaiting: with the waiting question and its options — is the message the answer (one of the options, or in its own
//     words), a correction or replacement of that task, or something else? The answer goes into the waiting task at RULE_BAR;
//     anything else goes its usual way, and a browser task it starts behind the waiting one shows three choices on its card,
//     the likeliest first (lib/browser.js queue offer).
//   · readResume: with the thread's recent browser tasks that stopped before they were done, or just finished (titles, how they
//     ended, their closing words, last actions) — does the message ask to finish one of them first and then do something else,
//     only to go on with it, or to go on with it as it now says (the 「원하시면 … 이어서 해 드릴게요」 a task closed with)?
//   · taskContext: the same for the room judge (lib/roomRules.js), so a word for the task is not taken for the room's rule.
// Structure only decides when to ask: a task waiting in this thread, stopped tasks in this thread.
import { q } from './supa.js'
import { L } from './lang.js'
import { judge } from './judge.js'

export const ANSWER_BAR = 0.7
// these are asked on messages in a room with a task, before anything else answers: a short wait (the message goes its usual way without)
export const JUDGE_MS = Number(process.env.PRO_QUEUE_JUDGE_MS || 4000)
export const RESUME_BAR = 0.7
const cap = (t, n = 300) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)

// ---- the task running or waiting in this thread: an answer, steering, or something else ----
export const WAIT_QUESTION = () => L('사용자가 입력창에 쓴 말은 지금 하고 있는 브라우저 작업과 어떤 관계인가?', 'How does what the person typed relate to the browser task under way?')
// w: { title, waiting, question, options, vault, step, doing } (lib/browser.js activeIn · waitingIn). An answer is offered only when the
// task waits on a question; a login, card or one-time code is never answered from the composer (it would sit in the chat, and the
// judge would read it).
export function waitOptions(w, { files = 0 } = {}) {
  // (a wait the person answers only by pressing its card — an approval, a login, a card, a code, a check on the screen — gets no answer
  // from the composer: w.locked, lib/browser.js waitingIn)
  const asks = w.waiting && !w.vault && !w.locked && !files
  const answers = asks ? [
    ...(w.options || []).map((o, i) => ({ key: `o${i}`, label: L(`작업이 물은 질문의 보기 「${cap(o, 80)}」를 고른 답이다`, `It picks the option "${cap(o, 80)}" of the task's question`) })),
    { key: 'answer', label: L('작업이 물은 질문에 대한 답이다(보기에 없는 답을 자기 말로 하거나, 보기 대신 다른 방법을 고르는 답 포함)', "It answers the task's question in its own words (an answer not among the options, or another way instead of them)") },
  ] : []
  return [...answers,
    { key: 'steer', label: L('그 작업에게 어떻게 진행하라고 알려 주는 말이다: 방법을 바로잡거나, 막힌 곳을 넘는 길을 일러 주거나, 이어서 할 일을 덧붙이는 말', 'It tells that task how to go on: corrects its way, says how to get past where it is stuck, or adds what to do next in it') },
    { key: 'replace', label: L('그 작업을 그만두고 대신 다른 일을 하라는 말이다', 'It says to stop that task and do something else instead') },
    { key: 'other', label: L('그 밖의 말이다: 그 작업과 상관없는 새 일, 다른 질문, 인사', 'Something else: new work unrelated to that task, another question, a greeting') },
  ]
}
export function waitState(w, text, { files = 0 } = {}) {
  return [
    L(`지금 하고 있는 브라우저 작업: 「${cap(w.title, 120)}」${w.step ? ` · 하는 단계: ${cap(w.step, 120)}` : ''}${w.doing ? ` · 지금: ${cap(w.doing, 120)}` : ''}`,
      `Browser task under way: "${cap(w.title, 120)}"${w.step ? ` · step: ${cap(w.step, 120)}` : ''}${w.doing ? ` · now: ${cap(w.doing, 120)}` : ''}`),
    w.waiting ? L(`작업이 사람에게 물은 것: ${cap(w.question, 500) || '(직접 확인을 기다림)'}`, `What the task asked the person: ${cap(w.question, 500) || '(waiting for them to look at the page)'}`)
      : L('작업은 사람을 기다리지 않고 진행 중이다.', 'The task is going on; it is not waiting for the person.'),
    ...(w.waiting && w.options?.length ? [L(`카드의 보기: ${w.options.map((o, i) => `${i + 1}) ${cap(o, 80)}`).join(' ')}`, `Options on the card: ${w.options.map((o, i) => `${i + 1}) ${cap(o, 80)}`).join(' ')}`)] : []),
    L(`사용자가 입력창에 쓴 말: ${cap(text, 600)}`, `What the person typed: ${cap(text, 600)}`),
    ...(files ? [L(`이 말에 첨부한 파일: ${files}개`, `Files attached to it: ${files}`)] : []),
  ].join('\n')
}
// probabilities → { pick: 'answer' | 'steer' | 'other', option: index | null, p: { answer, steer, replace, other } }
// The answer's share is every option's and the own-words one together, taken at bar — but an option is given as the person's pick only
// when that one option alone is at bar; anything less goes in the person's own words, never as an option they did not pick. A wait that
// is locked (an approval, a login …) never takes an answer from here. (2026-11-25 review: a confused judge's o0 at 0.5 approved a payment.)
export function waitPick(probabilities, w, { bar = ANSWER_BAR } = {}) {
  const pr = probabilities || {}
  const opts = (w.options || []).map((_, i) => Number(pr[`o${i}`]) || 0)
  const answer = opts.reduce((x, y) => x + y, 0) + (Number(pr.answer) || 0)
  const p = { answer, steer: Number(pr.steer) || 0, replace: Number(pr.replace) || 0, other: Number(pr.other) || 0 }
  const best = opts.length ? opts.indexOf(Math.max(...opts)) : -1
  const option = best >= 0 && opts[best] >= bar ? best : null
  if (!w.locked && !w.vault && answer >= bar && answer >= p.steer) return { pick: 'answer', option, p }
  if (p.steer >= bar) return { pick: 'steer', option: null, p }
  return { pick: 'other', option: null, p }
}
// → { pick, option, p, probabilities, via, ms } — a judge that cannot answer delivers nothing (the message goes its usual way)
export async function readWaiting(w, text, { files = 0 } = {}) {
  const t0 = Date.now()
  try {
    const r = await judge({ state: waitState(w, text, { files }), question: WAIT_QUESTION(), options: waitOptions(w, { files }), timeoutMs: JUDGE_MS })
    return { ...waitPick(r?.probabilities, w), probabilities: r?.probabilities || {}, via: r?.via || '', ms: Date.now() - t0 }
  } catch (e) {
    return { pick: 'other', option: null, p: { answer: 0, steer: 0, replace: 0, other: 1 }, probabilities: {}, via: 'none', ms: Date.now() - t0, error: e.message }
  }
}
// the queue card's first (big) action: the likeliest reading — words for the task ahead (an answer, how to go on) → 「이 말을 앞 작업의
// 답으로」, a replacement → 「앞 작업 멈추고 이것부터」, anything else → 「앞 작업 뒤에 줄 세우기」
export function queueDefault(p) {
  const x = p || {}
  const ranked = [['answer', (x.answer || 0) + (x.steer || 0)], ['first', x.replace || 0], ['after', x.other || 0]].sort((a, b) => b[1] - a[1])
  return ranked[0][1] > 0 ? ranked[0][0] : 'after'
}

// ---- a task that ended: finish it first, go on with it, or go on with it as told ----
// The thread's browser tasks that stopped before they were done (stopped at the action limit, failed, left for the person to check,
// or stopped by them) and the one that just finished (its closing words may offer to go on), newest first — only ones that did
// something (a task cancelled before it started is just asked for again)
const STOPPED = ['needs_review', 'failed', 'cancelled']
export async function recentEnded(userId, threadId, { within = 30, max = 3, hours = 24, justNow = 6 } = {}) {
  const rows = await q(`select m.id, m.content, m.created_at, m.pos from (select id, kind, content, created_at, row_number() over (order by created_at desc) as pos
      from pro_messages where thread_id=$1 order by created_at desc limit $2) m
    join pro_threads t on t.id=$1 and t.user_id=$3
    where m.kind='task' and m.created_at > now() - make_interval(hours => $4) and coalesce(m.content->>'goal', '') <> '' and coalesce(m.content->>'connect', '') = ''
      and (m.content->>'state' = any($5) or (m.content->>'state' = 'done' and m.pos <= $6))
      and (jsonb_array_length(coalesce(m.content->'did', '[]'::jsonb)) > 0 or jsonb_array_length(coalesce(m.content->'notes', '[]'::jsonb)) > 0)
    order by m.created_at desc limit $7`, [threadId, within, userId, hours, STOPPED, justNow, max])
  return rows.map((r) => {
    const c = r.content
    const words = String(c.detail || c.summary || c.reason || '').trim().split(/\n\s*\n/)[0].split(/(?<=[.!?。])\s+/).map((x) => x.trim()).filter(Boolean)
    return { id: r.id, title: c.title || '', state: c.state, need: c.need || '', done: c.state === 'done',
      outcome: cap(words[0] || '', 200), closing: words.length > 1 ? cap(words.at(-1), 200) : '',
      last: (c.did || []).slice(-3).map((d) => d.text), count: c.progress?.count || 0 }
  })
}
// (kept for the stopped ones alone)
export const recentStopped = async (userId, threadId, opts) => (await recentEnded(userId, threadId, opts)).filter((t) => !t.done)
const stateWord = (t) => (t.done ? L('끝남', 'finished') : t.state === 'cancelled' ? L('사람이 멈춤', 'stopped by the person')
  : t.need === 'limit' ? L('동작 한도에서 멈춤', 'stopped at the action limit')
    : t.state === 'failed' ? L('실패', 'failed') : L('끝내지 못하고 멈춤', 'stopped before it was done'))
export const RESUME_QUESTION = () => L('사용자가 이번에 한 말은 아래 브라우저 작업과 어떤 관계인가?', 'How does what the person said now relate to the browser tasks below?')
export function resumeOptions(list) {
  return [
    ...list.flatMap((t, i) => t.done ? [] : [
      { key: `then${i}`, label: L(`「${cap(t.title, 80)}」 작업을 먼저 마저 끝내고, 그다음에 다른 일을 하라는 말이다`, `Finish "${cap(t.title, 80)}" first, then do something else`) },
      { key: `only${i}`, label: L(`「${cap(t.title, 80)}」 작업을 멈춘 자리부터 이어서(다시) 하라는 말이다. 다른 일은 시키지 않는다`, `Go on with (or try again) "${cap(t.title, 80)}" from where it stopped, nothing else`) },
    ]),
    ...list.map((t, i) => ({ key: `more${i}`, label: L(`「${cap(t.title, 80)}」 작업을 이어서 하되 어떻게 할지 새로 일러 주는 말이다(막힌 곳을 넘는 방법, 작업이 끝에 제안한 다음 일을 하라는 말 포함)`,
      `It tells how to go on with "${cap(t.title, 80)}": a way past where it got stuck, or doing the next thing that task offered at its end`) })),
    { key: 'none', label: L('그 밖의 말이다: 위 작업과 상관없는 새 일, 질문, 인사', 'Something else: new work unrelated to those tasks, a question, a greeting') },
  ]
}
// one line per task: title, how it ended, what it said first and last (where it left things), its last actions
export const taskLine = (t, i) => `${i + 1}. 「${cap(t.title, 120)}」 — ${stateWord(t)}${t.count ? L(` · ${t.count}개 처리`, ` · ${t.count} done`) : ''}${t.outcome ? L(` · 결과: ${t.outcome}`, ` · result: ${t.outcome}`) : ''}${t.closing ? L(` · 끝맺은 말: ${t.closing}`, ` · closing words: ${t.closing}`) : ''}${t.last.length ? L(` · 마지막 동작: ${t.last.join(', ')}`, ` · last actions: ${t.last.join(', ')}`) : ''}`
export function resumeState(list, text) {
  return [
    L('이 방의 최근 브라우저 작업(끝내지 못하고 멈춘 것, 방금 끝난 것):', 'Recent browser tasks in this room (stopped before they were done, or just finished):'),
    ...list.map(taskLine),
    L(`사용자가 이번에 한 말: ${cap(text, 600)}`, `What the person said now: ${cap(text, 600)}`),
  ].join('\n')
}
// probabilities → { pick: 'then' | 'only' | 'more' | null, task } (the likeliest, at bar)
export function resumePick(probabilities, list, { bar = RESUME_BAR } = {}) {
  const [key, p] = Object.entries(probabilities || {}).filter(([k]) => k !== 'none').sort((a, b) => b[1] - a[1])[0] || ['', 0]
  const m = /^(then|only|more)(\d+)$/.exec(key)
  const t = m && list[Number(m[2])]
  if (!t || p < bar || (t.done && m[1] !== 'more')) return { pick: null, task: null, p }
  return { pick: m[1], task: t, p }
}
export async function readResume(list, text) {
  const t0 = Date.now()
  if (!list.length) return { pick: null, task: null, ms: 0 }
  try {
    const r = await judge({ state: resumeState(list, text), question: RESUME_QUESTION(), options: resumeOptions(list), timeoutMs: JUDGE_MS })
    return { ...resumePick(r?.probabilities, list), probabilities: r?.probabilities || {}, via: r?.via || '', ms: Date.now() - t0 }
  } catch (e) {
    return { pick: null, task: null, probabilities: {}, via: 'none', ms: Date.now() - t0, error: e.message }
  }
}
// What the room judge reads besides the rule (lib/roomRules.js roomState): this person's browser tasks in the room — the one under way
// (what it is on, what it waits for) and the ones that just ended (how, and their closing words)
export function taskContext(active, ended = []) {
  const lines = []
  if (active) lines.push(L(`지금 하고 있는 브라우저 작업: 「${cap(active.title, 120)}」${active.step ? ` · 하는 단계: ${cap(active.step, 100)}` : ''}${active.waiting ? ` · 사람을 기다림: ${cap(active.question, 200) || '직접 확인'}` : ''}`,
    `Browser task under way: "${cap(active.title, 120)}"${active.step ? ` · step: ${cap(active.step, 100)}` : ''}${active.waiting ? ` · waiting for the person: ${cap(active.question, 200) || 'a look at the page'}` : ''}`))
  if (ended.length) lines.push(L('최근에 끝났거나 멈춘 브라우저 작업:', 'Browser tasks that just ended or stopped:'), ...ended.map(taskLine))
  return lines.join('\n')
}

// the reply that says the order (the second one by what it was asked to do)
const short = (t, n = 40) => { const s = String(t || '').split('\n')[0].trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
export const orderText = (first, second) => L(`① '${short(first)}' 마저 끝내고 → ② '${short(second)}' 시작할게요.`, `① I'll finish '${short(first)}' first → ② then start '${short(second)}'.`)
export const orderTextAgent = (first) => L(`① '${short(first)}' 마저 끝내고 → ② 그다음에 이 요청을 할게요.`, `① I'll finish '${short(first)}' first → ② then I'll do this.`)
export const resumeText = (title) => L(`'${short(title)}' 작업을 멈춘 자리부터 이어서 할게요.`, `I'll go on with '${short(title)}' from where it stopped.`)
export const answeredText = (title) => L(`'${short(title)}' 작업의 답으로 전했어요.`, `I passed that on to '${short(title)}' as its answer.`)
export const steeredText = (title) => L(`'${short(title)}' 작업에 그대로 전했어요. 그 말대로 이어서 해요.`, `I passed that on to '${short(title)}'. It goes on that way.`)
export const continueText = (title) => L(`'${short(title)}' 작업을 말씀하신 대로 이어서 할게요.`, `I'll go on with '${short(title)}' the way you said.`)
