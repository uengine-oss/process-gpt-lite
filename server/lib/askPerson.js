// The AI waits on the person — the chat agent stopped to ask (deepagents' human_input_required), a browser task asks a question, wants
// an approval (a payment, an upload) or a sign-in, or needs the person's hand on its screen — and the person hears of it on their phone
// even with Lite closed (2026-11-26 사용자: 「퀵하게 대화방에서 온 내용 혹은 ai의 후먼인더루프 등을 모바일에서 보게할 수 있나?」).
// It goes the way every Home card goes: a row in process-gpt's `notifications` (type 'ai_ask'), which the Home lists and the feed pushes
// to the person's devices (lib/notify.js feedOnce · pushRows). Answered — on the card, in the chat, from the notification — cancelled
// or over: the row is checked off, so the Home card goes with it. Progress lines are not notices: only a wait on the person is.
//   url: /pro/ask/<chat|task>/<thread>/<card> — chat: the agent's question message; task: the browser task's card (its question,
//   approval or vault card, or the task card itself when it asks for the screen)
// An answer from the notification (POST /api/push/act): the token the push carried (lib/pushActions.js) — checked, then the notice is
// used up once, then the card answered if it still waits (and given back when nothing was answered).
// Review 11-26 (PR #89): a button answers only what its asker marked light (quick) or the refusal it named — a lock screen's tap never
// approves, uploads or sends; the answer's turn runs in the person's own session, found by their account id (lib/supa.js sessionOfUser);
// only an approved member of this company is sent notices or may answer (lib/webpush.js memberHere).
import { config } from '../config.js'
import { q, sessionOfUser } from './supa.js'
import { memberHere } from './webpush.js'
import { emit } from './bus.js'
import { L, langOf, withLang, asUser } from './lang.js'
import * as PA from './pushActions.js'
import { ro } from './josa.js'

const T = () => config.tenantId
export const askUrl = (via, threadId, cardId) => `/pro/ask/${via}/${threadId}/${cardId}`
const ASK_URL = /^\/pro\/ask\/(chat|task)\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i
export function parseAskUrl(url) {
  const m = ASK_URL.exec(String(url || ''))
  return m ? { via: m[1], threadId: m[2], cardId: m[3] } : null
}

// the notification's title, in the person's language
export const askTitle = (kind) => ({
  question: L('Process GPT 의 질문이 있어요', 'Process GPT has a question'),
  approval: L('승인이 필요해요', 'Your approval is needed'),
  login: L('로그인이 필요해요', 'A sign-in is needed'),
  hands: L('직접 확인해 주셔야 해요', 'This needs your hand'),
}[kind] || L('Process GPT 의 질문이 있어요', 'Process GPT has a question'))

let key = null
export const signingKey = () => (key ||= PA.actionKey(config.serviceKey))

/** a notice that the AI waits on `userId` (once per card while it waits) → the notice's id */
export async function ask(userId, { via, threadId, cardId, kind = 'question', text = '' }) {
  if (!userId || !threadId || !cardId || !['chat', 'task'].includes(via)) return null
  const url = askUrl(via, threadId, cardId)
  const [had] = await q(`select id from notifications where tenant_id=$1 and user_id=$2 and type='ai_ask' and url=$3 and not coalesce(is_checked,false) limit 1`,
    [T(), String(userId), url])
  if (had) return had.id
  const title = withLang(await langOf(userId), () => askTitle(kind))
  // (only for a person of this company — a test's made-up person, or someone of another company, gets none)
  const [n] = await q(`insert into notifications(id,user_id,title,type,description,url,tenant_id)
                       select gen_random_uuid(),$1,$2,'ai_ask',$3,$4,$5 where exists (select 1 from users u where u.id::text = $1 and u.tenant_id = $5) returning id`,
    [String(userId), title, PA.askText(text) || title, url, T()])
  emit(userId, 'notifications', {})
  return n?.id || null
}

/** the wait is over: its notice checked off (cardId omitted: every chat question of the thread — the person wrote in it again) */
export async function settle(userId, { via, threadId, cardId = null }) {
  if (!userId || !threadId) return 0
  const rows = cardId
    ? await q(`update notifications set is_checked=true where tenant_id=$1 and user_id=$2 and type='ai_ask' and url=$3 and not coalesce(is_checked,false) returning id`,
      [T(), String(userId), askUrl(via, threadId, cardId)])
    : await q(`update notifications set is_checked=true where tenant_id=$1 and user_id=$2 and type='ai_ask' and url like $3 and not coalesce(is_checked,false) returning id`,
      [T(), String(userId), `/pro/ask/${via}/${threadId}/%`])
  if (rows.length) emit(userId, 'notifications', {})
  return rows.length
}

/** Is the card still waiting? A browser task's card: still 「pending」 (its question, approval or vault card) or 「needs_input」 (the task
 *  card of a wait on its screen) — answered, expired, cancelled or ended by a restart, it is not. The chat's question: nothing the person
 *  said after it. */
export async function waitingCard({ via, threadId, cardId }) {
  const [m] = await q('select role, kind, content, created_at from pro_messages where id=$1 and thread_id=$2', [cardId, threadId]).catch(() => [])
  if (!m) return null
  if (via === 'task') {
    if (m.kind === 'task') return m.content?.state === 'needs_input' ? m : null
    if (m.content?.state !== 'pending') return null
    // a card of a task (lib/browser.js waitForUser posts it with taskId): the task must still be under way — one a restart ended is not
    if (!m.content?.taskId) return m
    const [t] = await q(`select content->>'state' as state from pro_messages where id::text=$1`, [String(m.content.taskId)]).catch(() => [])
    return ['running', 'needs_input', 'queued'].includes(t?.state) ? m : null
  }
  const [after] = await q(`select 1 from pro_messages where thread_id=$1 and role='user' and created_at > $2 limit 1`, [threadId, m.created_at]).catch(() => [])
  return after ? null : m
}
export const stillWaiting = async (at) => !!(await waitingCard(at))
/** the card's kind for the Home card and the push: question · approval · login · hands */
export const kindOf = (at, card) => (at.via === 'chat' ? 'question' : PA.askKind(card || {}))

/** At start: the notices of browser-task waits that are over go — decided by the task cards' own state (waitingCard's rule), not by which
 *  company or server: a wait another server still holds (its task card says needs_input) keeps its notice (re-review 11-26 #4) */
export async function resetTaskAsks() {
  return (await q(`update notifications n set is_checked=true
    where n.type='ai_ask' and n.url like '/pro/ask/task/%' and not coalesce(n.is_checked,false)
      and not exists (
        select 1 from pro_messages c left join pro_messages t on t.id::text = c.content->>'taskId'
        where c.id::text = split_part(n.url, '/', 6)
          and ((c.kind = 'task' and c.content->>'state' = 'needs_input')
            or (c.kind <> 'task' and c.content->>'state' = 'pending'
                and (c.content->>'taskId' is null or t.content->>'state' in ('running','needs_input','queued')))))
    returning n.id`)).length
}

/** where the notice opens: the project room, the routine's page, or the chat — the conversation the question was asked in when the main
 *  chat's message names one (/chat/c/<conversation>, as the conversation list opens it) */
export async function placeOf(threadId, cardId = null) {
  const [t] = await q('select id, kind, ref from pro_threads where id=$1', [threadId]).catch(() => [])
  if (!t) return '/chat'
  if (t.kind === 'project') return `/projects/${t.id}`
  if (t.kind === 'process' && t.ref) return `/routines/${encodeURIComponent(t.ref)}`
  const [m] = cardId ? await q(`select content->>'conv' as conv from pro_messages where id=$1`, [cardId]).catch(() => []) : []
  return m?.conv && !String(m.conv).startsWith('none:') ? `/chat/c/${encodeURIComponent(m.conv)}` : '/chat'
}

/** the push of one 'ai_ask' row for its person: title and words, where it opens, its buttons and — when a button answers — the token */
export async function askPayload(row, userId, { now = Date.now() } = {}) {
  const at = parseAskUrl(row.url)
  if (!at) return null
  const [card] = await q('select kind, content from pro_messages where id=$1', [at.cardId]).catch(() => [])
  const kind = kindOf(at, card)
  // what the asker said of its choice: quick (light enough for a lock screen's tap), refusal (the option that declines)
  const said = at.via === 'chat' ? card?.content?.ask || {} : card?.kind === 'choice' ? card.content || {} : {}
  // (a chat question: 「열기」 only, whatever its JSON says — pushActions.askButtons)
  const { buttons, answers } = withLang(await langOf(userId), () => PA.askButtons({ via: at.via, kind, options: said.options || [], quick: said.quick === true, refusal: said.refusal || null }, { open: L('열기', 'Open') }))
  const token = answers.length ? PA.mintAction({ key: signingKey(), tenant: T(), userId, notice: row.id, card: at.cardId, answers, now }) : null
  return {
    id: row.id, type: 'ai_ask', kind, title: String(row.title || '').slice(0, 120), body: String(row.description || '').slice(0, 160),
    tag: `pgl-ask-${at.cardId}`, renotify: true, requireInteraction: true,
    url: row.url, thread: at.threadId, card: at.cardId, place: await placeOf(at.threadId, at.cardId),
    actions: buttons, ...(token ? { token } : {}),
  }
}

const refuse = (status, error) => ({ status, error })
/** An answer from a notification's button: { token, answer: index into the token's answers }.
 *  deps.answerTask(userId, cardId, label) → true when that browser task still waited on that card and took it (lib/browser.js answerCard);
 *  deps.answerChat(person, thread, cardId, label) → true when the chat question is still the thread's last word and the answer was sent.
 *  → {status: 200, answered} | {status, error} */
export async function act({ token, answer }, { answerTask, answerChat, now = Date.now() } = {}) {
  const v = PA.verifyAction(token, { key: signingKey(), now })
  if (!v.ok) return v.why === 'expired' ? refuse(410, L('오래된 알림이라 답할 수 없어요. 앱에서 열어 주세요.', 'This notification is too old to answer. Open it in the app.')) : refuse(401, 'bad token')
  const c = v.claims
  if (c.t !== String(T())) return refuse(401, 'bad token')
  const i = Number(answer)
  if (!Number.isInteger(i) || i < 0 || i >= c.a.length) return refuse(400, 'answer')
  const [n] = await q(`select id, user_id, url from notifications where id=$1 and tenant_id=$2 and type='ai_ask'`, [c.n, T()])
  if (!n) return refuse(404, 'no such notice')
  const at = parseAskUrl(n.url)
  // the token is this person's, for this notice's card, and the notice (by their id — never public.users.email, which its owner can change)
  // and its thread are theirs — a member of this company still
  const [who] = await q(`select u.id::text as id, coalesce(nullif(p.name,''), u.username) as name from users u
                         left join pro_profile p on p.user_id = u.id where u.id::text=$1 and u.tenant_id=$2`, [c.u, T()]).catch(() => [])
  if (!who || !at || at.cardId !== c.c || String(n.user_id) !== who.id || !(await memberHere(who.id))) return refuse(403, 'not yours')
  const [thread] = await q('select * from pro_threads where id=$1 and user_id=$2', [at.threadId, who.id])
  if (!thread) return refuse(403, 'not yours')
  // a chat question is never answered from a notification: its options are the model's own text (re-review 11-26 #1 — pushActions.askButtons
  // mints no token for one; a token that names one anyway answers nothing)
  if (at.via === 'chat') return refuse(403, withLang(await langOf(who.id), () => L('채팅 질문은 앱에서 답해 주세요.', 'Answer chat questions in the app.')))
  // used once: the notice goes from waiting to checked here — a second tap, another device, the same token again finds it checked
  const [won] = await q(`update notifications set is_checked=true where id=$1 and not coalesce(is_checked,false) returning id`, [n.id])
  if (!won) return refuse(409, withLang(await langOf(who.id), () => L('이미 답했거나 닫은 알림이에요', 'This was already answered or closed.')))
  emit(who.id, 'notifications', {})
  const label = c.a[i]
  let ok = false, failed = null
  try {
    ok = at.via === 'task' ? await answerTask?.(who.id, at.cardId, label) : await answerChat?.(who, thread, at.cardId, label, { notice: n.id })
  } catch (e) { failed = e; console.warn(`[push] ${at.via} answer failed:`, e.message) }
  if (!ok) {
    // nothing was answered (a turn under way in its thread, no session, the task in another server's memory): a card that still waits gets
    // its notice and Home card back
    const back = await stillWaiting(at)
    if (back) { await q('update notifications set is_checked=false where id=$1', [n.id]); emit(who.id, 'notifications', {}) }
    return refuse(failed ? 503 : 409, withLang(await langOf(who.id), () => (failed ? L('지금은 답하지 못했어요. 앱에서 답해 주세요.', "Couldn't answer just now. Answer it in the app.")
      : back ? L('그 대화에서 다른 답을 쓰는 중이에요. 앱에서 답해 주세요.', 'Another answer is being written in that chat. Answer it in the app.')
        : L('더 이상 답을 기다리는 질문이 아니에요', 'This question is no longer waiting for an answer.'))))
  }
  console.log(`[push] ${at.via} card ${at.cardId.slice(0, 8)}: answered from the notification (option ${i})`)
  const said = withLang(await langOf(who.id), () => L(`「${label}」${ro(`${label}」`)} 답했어요`, `Answered: ${label}`))
  return { status: 200, ok: true, answered: label, said, place: await placeOf(at.threadId, at.cardId) }
}

/** the chat's answerer for act(): the question must still be unanswered (nothing the person said after it) with no turn under way — then
 *  the option goes to the thread as the person's own message (what tapping the chat's quick reply does), in a session of theirs.
 *  runTurn · busy: lib/agent.js runTurn, lib/turns.js running (given, not imported: no cycle). sessionOf(userId): the person's own session
 *  by their account id (lib/supa.js sessionOfUser — never by an address from public.users, never making an account or a users row); a
 *  session that turns out to be someone else's is not used. */
//  Not reachable from act() while chat questions get no answer buttons (re-review 11-26 #1); kept for when their marks come on a channel
//  the model cannot write. notice: its notice — given back if the turn fails before the person's message is in (nothing new is pushed:
//  the row only waits again).
export function chatAnswerer({ runTurn, busy, sessionOf = sessionOfUser }) {
  return async (who, thread, cardId, label, { notice = null } = {}) => {
    if (!(await stillWaiting({ via: 'chat', threadId: thread.id, cardId })) || busy?.({ userId: who.id, threadId: thread.id })?.length) return false
    const { user, session } = await sessionOf(who.id)
    if (!user?.id || String(user.id) !== String(who.id) || !session?.access_token) throw new Error('the session is not this person\'s')
    const person = { id: who.id, email: user.email, name: who.name }
    // (in the person's language, tenant and usage — as their own request would be: lib/lang.js asUser)
    asUser(who.id, () => runTurn({ user: person, session, threadId: thread.id, text: label }))
      .catch(async (e) => {
        console.warn('[push] chat answer', e.message)
        // (the turn failed before the person's message was written: the question still waits — so does its notice)
        if (notice && await stillWaiting({ via: 'chat', threadId: thread.id, cardId })) {
          await q('update notifications set is_checked=false where id=$1 and coalesce(is_checked,false)', [notice]).catch(() => {})
          emit(who.id, 'notifications', {})
        }
      })
    return true
  }
}
