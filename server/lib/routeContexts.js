// What the context router chooses among for a message of the main chat (2026-11-25, production: 「글씨가 표의 윗부분에 붙어있다.
// 중앙정렬」, sent right after an edit of a document with a table in the same chat, was routed as 「새 주제」 (logprob 0.75) — user:
// 「분류를 할때에 이 대화의 시작 대화는 끊겨져 있다 (여기는 파일을 편집하는 요청이 그 전에 있었고, 그에 연결되기를 "글씨가 표의 윗부분에
// 붙어있다. 중앙정렬"이 들어온 상황이었다)」; spec openspec/specs/chat-thread-list 「후속 메시지는 방금 일하던 대화로」).
// The router saw each conversation by its title, a gist and its latest request and answer only: nothing said which document a
// conversation worked on, how long ago its last turn was, or that it was the one the person was in a minute ago. Now
//   · every candidate goes with those facts (the router's client contexts, metadata.contexts — they stand in for its stored rows of the
//     same ids; the title, gist and kind go as they are stored, since the router writes them back after the turn), and the conversation
//     the person was just in goes as live work (`active` — always among the router's candidates, labelled as in progress);
//   · a message sent while a document is open goes to the conversation that last worked on that document, without asking the router —
//     the link the screen makes for a document opened from its card (src/docSelection.js docConversation), here from what the server
//     saw, so it holds when the screen lost the link (a document opened another way, a save that replaced the open document's record).
// Structure only — what each conversation did and when; never the words of the message (no phrase rules).
import { config } from '../config.js'
import { q } from './supa.js'
import { L } from './lang.js'

// what kind of file a name is, said to the model (a lookup by extension, as the screens' file cards do)
const KINDS = [
  [/\.(docx?|odt|rtf)$/i, ['Word 문서', 'Word document']], [/\.(hwpx?)$/i, ['한글 문서', 'Hangul document']],
  [/\.(xlsx?|csv|ods)$/i, ['엑셀 표', 'spreadsheet']], [/\.(pptx?|odp)$/i, ['발표 자료', 'slides']], [/\.pdf$/i, ['PDF', 'PDF']],
  [/\.(dxf|dwg)$/i, ['도면', 'drawing']], [/\.(png|jpe?g|webp|gif|svg)$/i, ['그림', 'picture']], [/\.(mp3|wav|m4a|flac)$/i, ['소리', 'audio']],
  [/\.(mp4|mov|webm)$/i, ['영상', 'video']], [/\.(md|txt)$/i, ['글', 'text']],
]
export function fileKind(name) {
  const hit = KINDS.find(([re]) => re.test(String(name || '')))
  return hit ? L(...hit[1]) : String(name || '').split('.').slice(1).pop() || L('파일', 'file')
}
const HOW = { edited: ['편집', 'edited'], made: ['만듦', 'made'], attached: ['첨부', 'attached'] }
const ms = (t) => { const v = new Date(t).getTime(); return Number.isFinite(v) ? v : 0 }
const base = (name) => String(name || '').split('/').pop().trim().toLowerCase()
// a message's conversation tag: an id, or {id, title} (a card about a conversation)
const idOf = (v) => { const x = v && typeof v === 'object' ? v.id : v; return x ? String(x) : null }

/**
 * What each conversation of the main chat did, from its messages (oldest first): the files it made, was given or edited, and its last
 * turn; and the conversation the person was just in — the one their latest message went to. A message filed aside (a scheduled run, a
 * brief: lib/ownConversations.js) is never the person's work. except: the message being answered now (it has no conversation yet).
 * → { convs: { [conv]: { at, docs: [{ name, how, at }] } }, justIn: { conv, at } | null }
 */
export function factsOf(messages = [], { except = null } = {}) {
  const convs = {}
  const of = (conv) => (convs[conv] ||= { at: 0, docs: [] })
  const touch = (conv, at) => { if (conv) of(conv).at = Math.max(of(conv).at, at) }
  const addDoc = (conv, name, how, at) => {
    if (!conv || !name) return
    const docs = of(conv).docs
    const i = docs.findIndex((d) => base(d.name) === base(name))
    // the strongest thing done to it, at its latest moment
    const rank = { edited: 3, made: 2, attached: 1 }
    if (i >= 0) { docs[i] = { name: docs[i].name, how: rank[how] > rank[docs[i].how] ? how : docs[i].how, at: Math.max(docs[i].at, at) }; return }
    docs.push({ name: String(name), how, at })
  }
  let cur = null
  let waiting = null // the person's latest message whose conversation is not known yet (its answer tells)
  let attached = []  // files the person attached, waiting for the answer that took them
  let justIn = null
  for (const m of messages || []) {
    if (!m?.id || m.id === except) continue
    const c = m.content || {}
    const at = ms(m.created_at)
    if (c.context?.action === 'aside') continue
    if (m.role === 'user') {
      if (m.kind === 'file') { if (c.name) attached.push({ name: c.name, at }); continue }
      // (a request a button started — a mail's follow-up, lib/mailFollow.js — is not what the person typed)
      if (m.kind !== 'text' || c.follow) continue
      const conv = idOf(c.conv)
      if (conv) { justIn = { conv, at }; waiting = null; touch(conv, at) } else waiting = { at }
      continue
    }
    if (m.kind === 'text' || m.kind === 'doc') {
      const ctx = c.context
      const conv = ctx?.conversationId && ctx.action !== 'stay' ? String(ctx.conversationId) : idOf(c.conv) || cur
      if (!conv) continue
      cur = conv
      touch(conv, at)
      if (waiting) { justIn = { conv, at: waiting.at }; waiting = null }
      for (const f of attached) addDoc(conv, f.name, 'attached', f.at)
      attached = []
      // the document that was open for this turn (lib/agent.js delegate): the turn worked on it
      if (c.openDoc?.file) addDoc(conv, c.openDoc.file, 'edited', at)
      continue
    }
    if (m.kind === 'file' && c.name) addDoc(cur, c.name, c.edited ? 'edited' : 'made', at)
  }
  return { convs, justIn }
}

// how long ago, in the words the model reads
function ago(t, now) {
  const mins = Math.max(1, Math.round((now - t) / 60000))
  if (mins < 60) return L(`${mins}분 전`, `${mins} min ago`)
  const h = Math.round(mins / 60)
  return h < 48 ? L(`${h}시간 전`, `${h} h ago`) : L(`${Math.round(h / 24)}일 전`, `${Math.round(h / 24)} days ago`)
}

/** one candidate's facts, in a line: just in · last turn · files (newest first, at most three) */
export function factLine(f, { justIn = false, now = Date.now() } = {}) {
  const parts = []
  if (justIn) parts.push(L(`방금까지 사람이 있던 대화(마지막 턴 ${ago(f.at, now)})`, `The conversation the person was just in (last turn ${ago(f.at, now)})`))
  else if (f?.at) parts.push(L(`마지막 턴 ${ago(f.at, now)}`, `Last turn ${ago(f.at, now)}`))
  const docs = [...(f?.docs || [])].sort((a, b) => b.at - a.at).slice(0, 3)
  if (docs.length) parts.push(L('다룬 파일: ', 'Files: ') + docs.map((d) => `${d.name}(${fileKind(d.name)}, ${L(...HOW[d.how])})`).join(', '))
  return parts.join(' · ')
}

/**
 * The router's candidates (metadata.contexts): the person's recent conversations (context_threads rows, newest first), each with its
 * facts before its stored summary; title, gist and kind exactly as stored (the router writes them back after the turn). The
 * conversation the person was just in is always one of them, as live work.
 */
export function contextsFor(rows = [], facts = { convs: {}, justIn: null }, { now = Date.now(), limit = 12 } = {}) {
  const just = facts.justIn?.conv || null
  const list = (rows || []).slice(0, limit)
  if (just && !list.some((r) => r.conversation_id === just)) {
    const r = (rows || []).find((x) => x.conversation_id === just)
    if (r) list.push(r)
  }
  return list.filter((r) => r?.conversation_id && r.title).map((r) => {
    const f = facts.convs?.[r.conversation_id] || { at: ms(r.updated_at), docs: [] }
    const line = factLine({ ...f, at: f.at || ms(r.updated_at) }, { justIn: r.conversation_id === just, now })
    return {
      conversation_id: r.conversation_id, title: r.title, kind: r.kind || 'conversation', gist: r.gist || '',
      summary: [line, r.summary || ''].filter(Boolean).join('\n'),
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at || null,
      ...(r.conversation_id === just ? { active: true } : {}),
    }
  })
}

/** the conversation that last worked on the document named `file` (its card, an attachment, or a turn it was open for) — or null */
export function docLinkOf(facts, file) {
  const want = base(file)
  if (!want) return null
  let best = null
  for (const [conv, f] of Object.entries(facts?.convs || {})) {
    for (const d of f.docs) if (base(d.name) === want && (!best || d.at > best.at)) best = { conv, at: d.at }
  }
  return best?.conv || null
}

/**
 * For a main-chat message about to be routed: the router's candidates, and the conversation to go to without asking when a document
 * is open (open: {file}) that a conversation of this chat worked on. except: the message being answered (handleTurn's).
 */
export async function turnFacts({ user, threadId, except = null, open = null }) {
  const [msgs, rows] = await Promise.all([
    q(`select id, role, kind, created_at, jsonb_build_object('context', content->'context', 'conv', content->'conv', 'name', content->'name',
          'openDoc', content->'openDoc', 'edited', content->'edited', 'follow', content->'follow') as content
        from (select * from pro_messages where thread_id=$1 order by created_at desc limit 400) m order by created_at`, [threadId]),
    q(`select conversation_id, title, summary, gist, kind, updated_at from context_threads where tenant_id=$1 and user_id=$2
        and updated_at > now() - interval '30 days' order by updated_at desc limit 40`, [config.tenantId, user.id]),
  ])
  const facts = factsOf(msgs, { except })
  const contexts = contextsFor(rows, facts)
  const conv = open?.file ? docLinkOf(facts, open.file) : null
  return { facts, contexts, docLink: conv ? { conversationId: conv, title: rows.find((r) => r.conversation_id === conv)?.title || '' } : null }
}
