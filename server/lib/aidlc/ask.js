// A session that waits on a person without a selection prompt: it stopped, the turn is a person's, and nothing
// else on hand says so — no prompt on screen, no question file with blank answers. AI-DLC asks some approvals
// in the chat itself ("Build and Test를 승인할까요? 1. **Approve** 2. **Request Changes**"), and a session
// sometimes stops after saying it will go on ("…코드 생성으로 넘어가겠습니다."). Either way, until someone
// types, nothing moves; with no card, nobody knew (a run sat 41 hours on one: docs/robo-dlc/plan-p4.md).
//
// The words come from the session's Stop hook (lib/aidlc/hooks.js) when it has one, else off the screen —
// and then only once the same idle screen has stood for a few seconds, so a session between two steps
// is not taken for one that waits.
import crypto from 'node:crypto'
import { L } from '../lang.js'
import * as AS from './session.js'
import * as HK from './hooks.js'

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')
const STEADY_MS = 6000

// ---------- what the words offer ----------
// "1. **Approve**: Build and Test 단계로 넘어갑니다." — AI-DLC's options when it asks in the chat
const NUMBERED = /^\s*(\d{1,2})\.\s+\*\*(.+?)\*\*\s*(?::\s*(.*))?$/
// the same list read off the screen, where bold is drawn without its stars: "1. Approve: …"
const NUMBERED_PLAIN = /^\s*(\d{1,2})\.\s+([^:]{1,40}?)\s*(?::\s*(.*))?$/
// a word the reply is asked as: "**done**이나 **ready**를 보내 주시면"
const REPLY_WORD = /^(done|ready|continue|proceed|yes|no|retry|abort|approve(?: plan)?)$/i
const GO_ON = /^(done|ready|continue|proceed)$/i
// an option that needs the person's words: what to change, or something else altogether
const NEEDS_TEXT = /^(request changes|other|기타|다른 답)/i
const MAX_LABEL = 40

// → { kind: 'approval' | 'choice' | 'reply' | 'stalled', options: [{ label, hint, text }] }
//   text: whether the reply needs the person's words after the label ("Request Changes: …", or "Other": just words)
export function askOptions(message) {
  const lines = String(message || '').split('\n').map((l) => l.replace(/\s+$/, ''))
  const filled = lines.map((l, i) => [l, i]).filter(([l]) => l.trim())
  const tail = filled.length ? filled[Math.max(0, filled.length - 8)][1] : 0
  // the last numbered list of bold labels that ends near the end (the question it answers is just above)
  const RE = /\*\*/.test(message || '') ? NUMBERED : NUMBERED_PLAIN
  let list = [], at = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(RE)
    if (!m) continue
    if (Number(m[1]) === 1) list = []
    list.push({ label: m[2].trim(), hint: (m[3] || '').trim() }); at = i
  }
  if (list.length >= 2 && at >= tail && list.every((o) => o.label.length <= MAX_LABEL)) {
    const options = list.map((o) => ({ ...o, text: NEEDS_TEXT.test(o.label) }))
    return { kind: /^approve/i.test(options[0].label) ? 'approval' : 'choice', options }
  }
  // bold reply words: "done"/"ready" anywhere ("**done**이나 **ready**를 보내 주시면" comes before the list of
  // what is asked), the others only near the end (a summary may name an earlier "**Approve**")
  const bold = (from) => [...lines.slice(from).join('\n').matchAll(/\*\*([^*\n]{1,20})\*\*/g)].map((m) => m[1].trim())
  const words = [...new Set([...bold(0).filter((w) => GO_ON.test(w)), ...bold(tail).filter((w) => REPLY_WORD.test(w))])]
  if (words.length) return { kind: 'reply', options: words.map((label) => ({ label, hint: '', text: false })) }
  // a question, or a request to say something
  const end = filled.slice(-3).map(([l]) => l).join(' ')
  if (/[?？]\s*$|까요\?|나요\?|주세요[.!]?\s*$|말씀해 주세요|알려 주세요|please (let me know|confirm|reply)/i.test(end)) return { kind: 'reply', options: [] }
  // it said what it does next and stopped: someone has to tell it to go on
  return { kind: 'stalled', options: [{ label: L('계속 진행해 주세요', 'Please continue'), hint: '', text: false }] }
}

export const askTitle = (kind, stageName) => ({
  approval: L(`${stageName} 승인을 기다려요`, `${stageName} waits for approval`),
  choice: L(`${stageName} — 고를 것이 있어요`, `${stageName} — a choice to make`),
  reply: L(`${stageName} — 세션이 답을 기다려요`, `${stageName} — the session waits for an answer`),
  stalled: L(`${stageName} — 세션이 멈춰 있어요`, `${stageName} — the session has stopped`),
}[kind])

// ---------- is the session waiting on a person now? ----------
const idleSince = new Map() // session -> { fp, since }: the idle screen first seen, when no hook said it stopped

// cur: the intent being worked on (lib/aidlc/team.js currentIntent); text: the session's screen when already read
// → { key, kind: 'ask', askKind, options, message, stage, roleKey, title, text, fingerprint } or null
export async function askOf(cur, name, text, now = Date.now()) {
  if (!cur?.stage || cur.status === 'complete' || /^complete/i.test(cur.state?.status || '')) return null
  if (text == null) {
    if (!(await AS.has(name))) return null
    text = await AS.screen(name).catch(() => '')
  }
  // something else is on screen, it is working, or someone is typing an answer right now
  if (AS.parseChoice(text) || AS.parseTrust(text) || !AS.atPrompt(text) || AS.busy(text) || AS.draft(text)) { idleSince.delete(name); return null }
  const hook = HK.lastOf(name)
  let message
  if (hook?.turn === 'idle') message = hook.message || AS.lastMessage(text)
  else {
    const fp = sha(text)
    const seen = idleSince.get(name)
    if (!seen || seen.fp !== fp) { idleSince.set(name, { fp, since: now }); return null }
    if (now - seen.since < STEADY_MS) return null
    message = AS.lastMessage(text)
  }
  const { kind, options } = askOptions(message)
  const stage = cur.stage
  const fingerprint = sha(`${stage.slug}\n${message}`).slice(0, 16)
  return {
    key: `ask:${fingerprint}`, kind: 'ask', askKind: kind, options, message, stage: stage.slug, roleKey: stage.roleKey,
    title: askTitle(kind, stage.name), text: (message || L('세션이 사람의 말을 기다리고 있어요.', 'The session waits for a person.')).slice(-400), fingerprint,
  }
}
