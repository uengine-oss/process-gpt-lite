// 후행 습관(spec pgpt-pro_followup-habits): the next thing a person usually asks for once a result comes back ("slides
// done → swap the logo"), learned by watching and asked about the next time. Not a process and not a case model: one
// row per habit (sql/031). The model only reads values, by first-token odds (lib/decide.js oddsOf): is this a follow-up,
// is it the same thing, does it fit this result. The rules here decide how often to see it and when to stop asking, and
// nothing runs until the person says so.
import { config } from '../config.js'
import { q } from './supa.js'
import { L, isEn } from './lang.js'
import { chat, chatJson } from './llm.js'
import { oddsOf } from './decide.js'
import { addMessage, updateMessage } from './store.js'

// Bars, set on test/followup-eval (dev half). What is learned gets run again, so learning and merging want to be sure.
// Asking is one question about a habit this person showed, so the model only stops it for what would be odd to ask: a
// private file, or one that has it already (the bar and wording come from real runs: "does it fit?" turned down a paper's
// slides because the paper has nothing to do with the company, and that is exactly the habit).
export const HABIT = { bar: 0.5, learnBar: 0.7, sameBar: 0.6, fitsBar: 0.7, minSeen: Number(process.env.PRO_FOLLOWUP_MIN_SEEN) || 2, muteAfter: 3, windowDays: 3, maxTextChars: 300, answerMaxChars: 80 }

export const CLASSES = {
  slides: { ext: ['pptx', 'ppt', 'key', 'odp'], ko: '슬라이드', obj: '슬라이드를', en: 'slides', word: /슬라이드|피피티|ppt|발표\s*자료|deck|slide/i },
  doc: { ext: ['docx', 'doc', 'hwp', 'hwpx', 'odt'], ko: '문서', obj: '문서를', en: 'a document', word: /문서|워드|한글|보고서|document|word/i },
  sheet: { ext: ['xlsx', 'xls', 'csv', 'ods'], ko: '표', obj: '표를', en: 'a spreadsheet', word: /엑셀|시트|표\b|excel|sheet/i },
  pdf: { ext: ['pdf'], ko: 'PDF', obj: 'PDF를', en: 'a PDF', word: /pdf/i },
  audio: { ext: ['mp3', 'wav', 'm4a', 'ogg', 'flac'], ko: '오디오', obj: '오디오를', en: 'audio', word: /오디오|팟캐스트|음성|audio|podcast/i },
  image: { ext: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'], ko: '그림', obj: '그림을', en: 'an image', word: /그림|이미지|사진|image|picture/i },
  video: { ext: ['mp4', 'mov', 'webm', 'mkv'], ko: '영상', obj: '영상을', en: 'a video', word: /영상|동영상|video/i },
}
export const classOf = (name) => {
  const ext = String(name || '').split('.').pop().toLowerCase()
  return Object.keys(CLASSES).find((k) => CLASSES[k].ext.includes(ext)) || null
}
export const classesOf = (files) => [...new Set((files || []).map((f) => classOf(f?.name)).filter(Boolean))]
// a turn that made slides and a podcast: the follow-up names which one, or else the first
export const pickClass = (classes, text) => classes.find((c) => CLASSES[c].word.test(String(text || ''))) || classes[0]
const objOf = (cls) => (isEn() ? CLASSES[cls]?.en : CLASSES[cls]?.obj) || cls
export const whenText = (cls) => L(`${objOf(cls)} 만들면`, `When you make ${objOf(cls)}`)
export const sameWords = (a, b) => String(a).replace(/[\s.,!?~·]/g, '').toLowerCase() === String(b).replace(/[\s.,!?~·]/g, '').toLowerCase()
const cap = (t, n = HABIT.maxTextChars) => String(t || '').trim().slice(0, n)

// The questions the model reads, kept here so a change of wording goes through test/followup-eval.
export const FOLLOWUP_QUESTION = () => L('이어서 한 말은 무엇인가?', 'What is this next message?')
export const FOLLOWUP_OPTIONS = () => [
  { key: 'followup', label: L('방금 만든 결과물을 고치거나 다듬거나, 그 결과물로 이어서 무언가를 만들거나 처리해 달라는 말이다', 'It asks to change or polish the result just made, or to make or do something more with that result') },
  { key: 'new', label: L('결과물과 상관없는 새 일이거나, 결과물 내용에 대해 묻는 말이거나, 감사·인사다', 'It is new work unrelated to the result, a question about its content, or thanks or a greeting') },
]
export const followupState = (prev, text) => L(
  `방금 끝난 일: ${cap(prev.request)}\n결과물: ${(prev.files || []).join(', ')}\n이어서 사용자가 한 말: ${cap(text)}`,
  `Work just finished: ${cap(prev.request)}\nResult: ${(prev.files || []).join(', ')}\nThe next message: ${cap(text)}`)
export const SAME_QUESTION = () => L('이번 말과 같은 일을 시키는 것은 어느 것인가? 표현이 달라도 하는 일이 같으면 같은 일이고, 낱말이 비슷해도 하는 일이 다르면 다른 일이다.', 'Which one asks for the same work as this message? Different words for the same work count as the same; similar words for different work do not.')
export const sameOptions = (actions) => [...actions.map((a, i) => ({ key: `h${i}`, label: cap(a, 200) })), { key: 'none', label: L('같은 일이 없다', 'None of these') }]
export const sameState = (text) => L(`이번 말: ${cap(text)}`, `This message: ${cap(text)}`)
export const FITS_QUESTION = () => L('이번 결과물에 이 습관대로 하자고 물어보면 이상한가?', 'Would it be odd to offer this habit for this result?')
export const FITS_OPTIONS = () => [
  { key: 'not', label: L('이상하다. 사적인 자료이거나, 이미 되어 있거나, 받는 사람이나 쓰임이 달라서 그 일이 분명히 맞지 않는다', 'Odd: it is a private file, already done, or the reader or use clearly rules that work out') },
  { key: 'fits', label: L('이상하지 않다. 그 일이 맞지 않을 분명한 이유가 없다', 'Not odd: there is no clear reason that work would not apply') },
]
export const fitsState = (cls, action, request, files) => L(
  `지금 끝난 일: ${cap(request)}\n결과물: ${(files || []).join(', ')}\n습관: ${CLASSES[cls]?.obj || cls} 만들면 「${cap(action, 200)}」를 시킨다`,
  `Work just finished: ${cap(request)}\nResult: ${(files || []).join(', ')}\nHabit: when ${CLASSES[cls]?.en || cls} is made, the person asks: "${cap(action, 200)}"`)
export const ANSWER_QUESTION = () => L('사용자의 말은 무슨 뜻인가?', 'What does the person mean?')
export const ANSWER_OPTIONS = () => [
  { key: 'accept', label: L('물은 일을 그대로 해 달라는 뜻이다', 'Yes, do what was asked') },
  { key: 'decline', label: L('아무것도 하지 말라는 뜻이다(사양하는 말 포함). 다른 일을 시키지 않는다', 'No, do nothing (a polite refusal included), with no other request') },
  { key: 'other', label: L('그 일 대신 다른 방식이나 다른 일을 해 달라는 말이거나, 질문에 대한 답이 아닌 말이다', 'A request for another way or other work instead, or not an answer to the question') },
]
export const answerState = (question, text) => L(`비서의 질문: ${cap(question)}\n사용자의 말: ${cap(text, HABIT.answerMaxChars)}`, `The assistant asked: ${cap(question)}\nThe person said: ${cap(text, HABIT.answerMaxChars)}`)
export const RULE_QUESTION = () => L('이 말은 무엇인가?', 'What is this message?')
export const RULE_OPTIONS = () => [
  { key: 'rule', label: L('어떤 결과물이 나올 때마다 할 일을 기억해 두라는 말이다', 'It asks to remember what to do every time a certain kind of result is made') },
  { key: 'not', label: L('지금 한 번 시키는 일, 정해진 시각의 예약, 일반적인 말투·취향, 또는 질문이다', 'One piece of work now, a schedule at set times, a general style preference, or a question') },
]
export const ruleState = (text) => L(`사용자가 한 말: ${cap(text)}`, `The person said: ${cap(text)}`)
// only words like these are worth a model read
const RULE_WORDS = /앞으로|앞으론|다음\s*(부터|번|에도)|담부터|담부턴|이제부터|매번|항상|늘\s|언제나|마다|기억|잊지\s*말|from now on|whenever|every time|always|remember/i
export const maybeRule = (text) => RULE_WORDS.test(String(text || '')) && String(text).length <= HABIT.maxTextChars

// ---- rules: pure, in test/followups-cases.json ----
// { state, seen, origin } → is this habit asked about?
export const asksNow = (h, minSeen = HABIT.minSeen) => h.state === 'on' && (h.origin === 'told' || h.seen >= minSeen)
// a refusal: { declined, declined_run, state }; three in a row and it stops asking
export function afterDecline(h, muteAfter = HABIT.muteAfter) {
  const run = (h.declined_run || 0) + 1
  return { declined: (h.declined || 0) + 1, declined_run: run, state: run >= muteAfter ? 'muted' : h.state }
}
export const afterAccept = (h) => ({ accepted: (h.accepted || 0) + 1, seen: (h.seen || 0) + 1, declined_run: 0 })
const fileOfHabit = (f) => ({ name: f.name, url: f.url, path: f.path, ...(f.key ? { key: f.key } : {}), ...(f.size ? { size: f.size } : {}), ...(f.type ? { type: f.type } : {}) })
const T = () => config.tenantId

const fallbackClause = (action) => L(`「${cap(action, 60)}」도 해 드릴까요?`, `Shall I also do this: "${cap(action, 60)}"?`)
async function askClause(action) {
  const r = await chat({ model: config.llm.fastModel, temperature: 0, think: false, maxTokens: 80, timeoutMs: 8000, messages: [
    { role: 'system', content: L('사용자가 비서에게 시킨 말을, 비서가 먼저 묻는 한 문장으로 바꾼다. "…드릴까요?"로 끝내고, 시킨 말에 있는 내용만 쓴다. 문장만 쓴다.', 'Turn what the person asked into one sentence the assistant asks first, starting with "Shall I" and ending with "?". Use only what they asked. Only the sentence.') },
    { role: 'user', content: cap(action, 200) }] }).catch(() => null)
  const t = String(r?.content || '').trim().replace(/^["'「]|["'」]$/g, '')
  return t && t.length <= 100 && !t.includes('\n') && /\?$/.test(t) ? t : fallbackClause(action)
}
export const askText = (h) => {
  const clause = h.ask || fallbackClause(h.action)
  return h.origin === 'told' ? L(`말씀하신 대로 ${clause}`, `As you asked: ${clause}`) : L(`지난번처럼 ${clause}`, `Like last time: ${clause}`)
}

export const listHabits = (userId) => q(`select id, event_cls, action, ask, origin, seen, accepted, declined, state, files, last_seen_at, created_at from pro_followups where tenant_id=$1 and user_id=$2 order by state, accepted desc, seen desc, last_seen_at desc`, [T(), userId])
async function ofClass(userId, cls) {
  return q(`select * from pro_followups where tenant_id=$1 and user_id=$2 and event_cls=$3 order by seen desc, last_seen_at desc limit 6`, [T(), userId, cls])
}
async function sameHabit(rows, text) {
  const exact = rows.find((h) => sameWords(h.action, text))
  if (exact || !rows.length) return exact || null
  const r = await oddsOf(sameState(text), SAME_QUESTION(), sameOptions(rows.map((h) => h.action)))
  if (!r || r.choice === 'none' || r.confidence < HABIT.sameBar) return null
  return rows[Number(r.choice.slice(1))] || null
}
// What was just asked after a result: a new habit, or one more sighting of a known one.
export async function recordPair(user, cls, text, attached = []) {
  const rows = await ofClass(user.id, cls)
  const known = await sameHabit(rows, text)
  const files = (attached || []).filter((f) => f?.url && f?.path).map(fileOfHabit)
  if (known) {
    const [h] = await q(`update pro_followups set seen=seen+1, last_seen_at=now(), files=case when $2::jsonb='[]'::jsonb then files else $2::jsonb end where id=$1 returning *`, [known.id, JSON.stringify(files)])
    return h
  }
  const [h] = await q(`insert into pro_followups(tenant_id,user_id,event_cls,action,ask,files) values ($1,$2,$3,$4,$5,$6) returning *`,
    [T(), user.id, cls, cap(text), await askClause(text), JSON.stringify(files)])
  return h
}

const within = (at) => Date.now() - new Date(at).getTime() < HABIT.windowDays * 864e5
const isFollowup = async (prev, text) => {
  if (cap(text).length < 2) return false
  const r = await oddsOf(followupState(prev, text), FOLLOWUP_QUESTION(), FOLLOWUP_OPTIONS())
  // the model cannot read: nothing is decided from words alone
  return !!r && r.choice === 'followup' && r.confidence >= HABIT.learnBar
}
// Is this message about the result the last turn of the chat made? Then the agent that made it answers, in that conversation:
// a small router model reads "put [uEngine] in front of the first title" as some other tool. → { conv, title } | null
export async function followsResult(threadId, saidId, text) {
  const [m] = await q(`select content->'event' as e from pro_messages where thread_id=$1 and id<>$2 and role='agent' and kind in ('text','doc') order by created_at desc limit 1`, [threadId, saidId])
  if (!m?.e?.classes?.length || !within(m.e.at) || !(await isFollowup(m.e, text))) return null
  return { conv: m.e.conv || null, title: m.e.title || '' }
}

// Whether this message followed the last result of its conversation; if so it is learned.
async function learn({ user, threadId, prev, said, attached }) {
  if (!(await isFollowup(prev, said))) return false
  const cls = pickClass(prev.classes, said)
  const h = await recordPair(user, cls, said, attached)
  // the once a habit becomes one: said out loud, so what is remembered is never a surprise
  if (h.seen === HABIT.minSeen && h.state === 'on' && h.origin === 'observed') {
    await addMessage(user.id, threadId, 'agent', 'chip', { icon: 'check', text: L(`이 순서를 기억할게요 · ${whenText(cls)} → ${cap(h.action, 40)} · 설정 › 습관에서 지울 수 있어요`, `I'll remember this · ${whenText(cls)} → ${cap(h.action, 40)} · remove it in Settings › Habits`), habit: h.id })
    // the way of doing it can go to the company (회사 프로세스 지도 v0.3): asked once, nothing is shared without a yes
    await import('./ontology/ways.js').then((w) => w.askShare(user, threadId, h)).catch((e) => console.warn('[followups] share', e.message))
  }
  return true
}

// The usual next step for this result, asked once per conversation. A habit that does not fit this result stays quiet;
// when the model cannot read, a habit of this kind of result is still only a question, so it is asked.
async function offer({ user, threadId, classes, said, files, conv, title }) {
  const rows = (await q(`select * from pro_followups where tenant_id=$1 and user_id=$2 and event_cls = any($3) and state='on' and coalesce(last_asked_conv,'') <> $4 order by accepted desc, seen desc, last_seen_at desc limit 6`, [T(), user.id, classes, conv || '']))
    .filter((h) => asksNow(h)).slice(0, 3)
  let pick = null, source = null, p = null
  for (const h of rows) {
    // the person said "every time": the model does not get to overrule that
    if (h.origin === 'told') { pick = h; source = 'told'; break }
    const r = await oddsOf(fitsState(h.event_cls, h.action, said, files), FITS_QUESTION(), FITS_OPTIONS())
    if (!r) { pick = h; source = 'rule'; break }
    if (r.probabilities.fits >= HABIT.fitsBar) { pick = h; source = 'logprob'; p = r.probabilities.fits; break }
  }
  if (!pick) return rows.length ? null : routineOffer({ user, threadId, classes, conv, title })
  await q('update pro_followups set last_asked_conv=$2 where id=$1', [pick.id, conv || null])
  return addMessage(user.id, threadId, 'agent', 'followup', { text: askText(pick), followupId: pick.id, state: 'pending', seen: pick.seen, accepted: pick.accepted, origin: pick.origin, source, p,
    ...(conv ? { conv: { id: conv, title: title || '' } } : {}) })
}

// No habit of one's own for this result: the same role's routine on the company map (shown by the company's setting), done
// the way the company picked — asked once per conversation, and taken up it becomes this person's habit
const started = new Map() // habit id → { t0, way } — a run's minutes for the way it followed (ontology/ways.js)
async function routineOffer({ user, threadId, classes, conv, title }) {
  const mine = await q('select 1 from pro_followups where tenant_id=$1 and user_id=$2 and event_cls = any($3) limit 1', [T(), user.id, classes])
  if (mine.length) return null
  const [asked] = await q(`select 1 from pro_messages where thread_id=$1 and kind='followup' and content->>'source'='routine' and coalesce(content->'conv'->>'id','')=$2 limit 1`, [threadId, conv || ''])
  if (asked) return null
  const r = await (async () => {
    const { routineFor } = await import('./ontology/ways.js')
    const { habitSettings } = await import('./ontology/service.js')
    return routineFor(user.id, classes, await habitSettings())
  })().catch((e) => { console.warn('[followups] routine', e.message); return null })
  if (!r) return null
  const what = CLASSES[r.cls]?.ko || r.cls
  const way = r.way ? L(` 회사가 고른 방법은 ${r.way.name}님의 방법이에요${r.way.minutes != null ? `(평균 ${r.way.minutes}분)` : ''}.`, ` The company's chosen way is ${r.way.name}'s${r.way.minutes != null ? ` (${r.way.minutes} min on average)` : ''}.`) : ''
  const text = L(`같은 역할(${r.role})에서는 ${what} 결과물 뒤에 보통 「${r.task}」를 해요(${r.people}명).${way} 이번에도 할까요?`,
    `People in your role (${r.role}) usually do “${r.task}” after a ${CLASSES[r.cls]?.en || r.cls} (${r.people} people).${way} Shall I do it now?`)
  return addMessage(user.id, threadId, 'agent', 'followup', { text, routine: r, state: 'pending', source: 'routine', ...(conv ? { conv: { id: conv, title: title || '' } } : {}) })
}
async function acceptRoutine(user, card) {
  const r = card.content.routine
  const action = String(r.way?.how || '').split('\n')[0].trim() || L(`방금 만든 ${CLASSES[r.cls]?.ko || '결과물'}에 「${r.task}」를 해 주세요`, `Do “${r.task}” on the ${CLASSES[r.cls]?.en || 'result'} just made`)
  const h = await recordPair(user, r.cls, action)
  await close(user.id, card, 'accepted')
  started.set(h.id, { t0: Date.now(), way: r.way?.followupId || null })
  return { ...h, action, files: h.files || [] }
}

// A turn ended: note what it made on its answer, learn whether it followed the one before, and ask about the usual next
// step. A follow-up's own result (the deck with the new logo) asks nothing, or a habit would ask for itself forever.
export async function afterTurn({ user, threadId, msg, conv, title, said, files, attached, fromHabit }) {
  const names = (files || []).map((f) => f?.name).filter(Boolean)
  const classes = classesOf(files)
  const [prev] = conv ? await q(`select content->'event' as e from pro_messages where thread_id=$1 and id<>$2 and role='agent' and kind in ('text','doc') and content->'event'->>'conv'=$3 order by created_at desc limit 1`, [threadId, msg.id, conv]) : []
  await q(`update pro_messages set content = content || jsonb_build_object('event', $2::jsonb) where id=$1`, [msg.id, JSON.stringify({ conv, title: title || '', classes, files: names.slice(0, 6), request: cap(said), at: new Date().toISOString() })])
  const last = prev?.e
  const recent = last?.classes?.length && within(last.at)
  if (fromHabit && started.has(fromHabit)) {
    const s = started.get(fromHabit)
    started.delete(fromHabit)
    if (s.way) await import('./ontology/ways.js').then((w) => w.recordRun(s.way, (Date.now() - s.t0) / 60000)).catch(() => {})
  }
  const followed = fromHabit || (recent ? await learn({ user, threadId, prev: last, said, attached }) : false)
  if (classes.length && !followed) await offer({ user, threadId, classes, said, files: names, conv, title })
}

const pendingCard = async (threadId, beforeId) => {
  const [m] = await q(`select * from pro_messages where thread_id=$1 and kind='followup' and content->>'state'='pending' and created_at > coalesce((select max(created_at) from pro_messages where thread_id=$1 and role='user' and id<>$2), to_timestamp(0)) order by created_at desc limit 1`, [threadId, beforeId])
  return m || null
}
const habitOf = async (id) => (await q('select * from pro_followups where id=$1', [id]))[0] || null
const close = (userId, card, state) => updateMessage(userId, card.id, { state })

async function accepted(user, card) {
  const h = await habitOf(card.content.followupId)
  if (h) await q('update pro_followups set accepted=$2, seen=$3, declined_run=$4, last_seen_at=now() where id=$1', [h.id, ...Object.values(afterAccept(h))])
  await close(user.id, card, 'accepted')
  if (h) started.set(h.id, { t0: Date.now(), way: h.id })
  return h
}
async function refused(user, card) {
  const h = await habitOf(card.content.followupId)
  if (h) { const n = afterDecline(h); await q('update pro_followups set declined=$2, declined_run=$3, state=$4 where id=$1', [h.id, n.declined, n.declined_run, n.state]) }
  await close(user.id, card, 'declined')
}

const fail = (status, message) => Object.assign(new Error(message), { status })
// The card's buttons. accept → { action, files, conversation } for the caller to run as a turn.
export async function answerCard(user, messageId, choice) {
  if (!['accept', 'decline', 'mute'].includes(choice)) throw fail(400, 'choice must be accept, decline or mute')
  if (!/^[0-9a-f-]{36}$/i.test(String(messageId))) throw fail(404, 'no such card')
  const [card] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='followup'`, [messageId, user.id])
  if (!card) throw fail(404, 'no such card')
  if (card.content.state !== 'pending') throw fail(409, 'already answered')
  if (card.content.routine) {
    if (choice !== 'accept') { await close(user.id, card, choice === 'mute' ? 'muted' : 'declined'); return { state: choice === 'mute' ? 'muted' : 'declined' } }
    const h = await acceptRoutine(user, card)
    return { state: 'accepted', threadId: card.thread_id, habitId: h.id, action: h.action, files: [], conversation: card.content.conv }
  }
  if (choice === 'decline') { await refused(user, card); return { state: 'declined' } }
  if (choice === 'mute') {
    await q(`update pro_followups set state='muted' where id=$1 and user_id=$2`, [card.content.followupId, user.id])
    await close(user.id, card, 'muted')
    return { state: 'muted' }
  }
  const h = await accepted(user, card)
  if (!h) return { state: 'accepted' }
  return { state: 'accepted', threadId: card.thread_id, habitId: h.id, action: h.action, files: h.files || [], conversation: card.content.conv }
}

// The same answer in words, when the next message comes right after the question: "응" runs it, "괜찮아요" does not, and
// anything else goes on as an ordinary message. → null | { accept: { action, files, conversation, habitId } } | { decline: true }
export async function readAnswer(user, threadId, saidId, text, hasFiles) {
  const card = await pendingCard(threadId, saidId)
  if (!card) return null
  if (hasFiles || cap(text, 999).length > HABIT.answerMaxChars) { await close(user.id, card, 'passed'); return null }
  const r = await oddsOf(answerState(card.content.text, text), ANSWER_QUESTION(), ANSWER_OPTIONS())
  if (r?.choice === 'accept' && r.confidence >= HABIT.bar) {
    const h = card.content.routine ? await acceptRoutine(user, card) : await accepted(user, card)
    return h ? { accept: { action: h.action, files: h.files || [], conversation: card.content.conv, habitId: h.id } } : null
  }
  if (r?.choice === 'decline' && r.confidence >= HABIT.bar) { if (card.content.routine) await close(user.id, card, 'declined'); else await refused(user, card); return { decline: true } }
  await close(user.id, card, 'passed')
  return null
}

// "앞으로 슬라이드 만들면 로고는 유엔진으로 바꿔 줘": remembered at once, asked from the next result on.
export async function readRule(user, text) {
  if (!maybeRule(text)) return null
  const r = await oddsOf(ruleState(text), RULE_QUESTION(), RULE_OPTIONS())
  if (!r || r.choice !== 'rule' || r.confidence < HABIT.bar) return null
  const parts = await ruleParts(text)
  if (!parts) return null
  const { event, action } = parts
  const rows = await ofClass(user.id, event)
  const known = await sameHabit(rows, action)
  if (known) {
    const [h] = await q(`update pro_followups set origin='told', state='on', declined_run=0, last_seen_at=now() where id=$1 returning *`, [known.id])
    return h
  }
  const [h] = await q(`insert into pro_followups(tenant_id,user_id,event_cls,action,ask,origin,seen) values ($1,$2,$3,$4,$5,'told',0) returning *`, [T(), user.id, event, action, await askClause(action)])
  return h
}
// { event: a key of CLASSES, action: what to do, as a request } or null
export async function ruleParts(text) {
  const j = await chatJson(
    L(`사용자가 어떤 결과물이 나올 때마다 할 일을 말했다. JSON 으로만 답한다: {"event": 결과물 종류, "action": 그때 할 일을 사용자가 시키는 말로}. event 는 ${Object.keys(CLASSES).join(', ')} 중 하나(${Object.entries(CLASSES).map(([k, v]) => `${k}=${v.ko}`).join(', ')}), 없으면 null.`,
      `The person said what to do every time a kind of result is made. Answer only in JSON: {"event": kind of result, "action": what to do, as a request}. event is one of ${Object.keys(CLASSES).join(', ')}, or null.`),
    cap(text), { model: config.llm.fastModel, temperature: 0, think: false }).catch(() => null)
  if (!j?.event || !CLASSES[j.event] || !String(j.action || '').trim()) return null
  return { event: j.event, action: cap(j.action) }
}

export async function setHabit(userId, id, state) {
  if (!['on', 'muted'].includes(state)) throw fail(400, 'state must be on or muted')
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw fail(404, 'no such habit')
  const [h] = await q(`update pro_followups set state=$3, declined_run=0 where id=$1 and user_id=$2 returning id, state`, [id, userId, state])
  if (!h) throw fail(404, 'no such habit')
  return h
}
export async function removeHabit(userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw fail(404, 'no such habit')
  const rows = await q('delete from pro_followups where id=$1 and user_id=$2 returning id', [id, userId])
  if (!rows.length) throw fail(404, 'no such habit')
  return { ok: true }
}
