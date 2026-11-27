// HTTP routes for team sharing and the messenger (팀 공유·메신저). Every route checks that the
// caller is on the team; every recipient is checked too (lib/team/access.js).
// Design: process-gpt/openspec/changes/pgpt-pro-team-sharing/design.md
import express from 'express'
import { L } from '../lib/lang.js'
import { getThread, mainThread, addMessage } from '../lib/store.js'
import { runTurn } from '../lib/agent.js'
import { TeamError, requireMember, resolveRecipients, rateLimit, isMember } from '../lib/team/access.js'
import * as S from '../lib/team/shares.js'
import * as W from '../lib/team/worktree.js'
// the messenger's signed media addresses (no sign-in token in an address — lib/team/mediaLink.js)
import { verifyLink } from '../lib/team/mediaLink.js'
import { asTenantOf } from '../lib/tenant.js'
import { q } from '../lib/supa.js'
import { config } from '../config.js'
import * as M from '../lib/team/messenger.js'
import { suggest, workState } from '../lib/team/suggest.js'
import { watchRooms } from '../lib/team/assist.js'
import { assistRoutes } from './teamAssist.js'
import * as RT from '../lib/team/roomTranslate.js'
import { uploadCard } from '../lib/team/uploads.js'
// file mentions (links to shared folders' files) and 「@AI …」 (lib/fileRefs.js · lib/team/aiHelp.js)
import * as FR from '../lib/fileRefs.js'
import * as MM from '../lib/mailMention.js'
import * as MA from '../lib/mailAttachments.js'
import * as AI from '../lib/team/aiHelp.js'
import { named } from '../lib/people.js'

// does the deepagents this server talks to unfold a room's branch and commit its turns? (/health worktree)
// (asked again after a minute: deepagents restarts and upgrades without this server)
let worktreeAgent = null, askedAt = 0
async function agentWorktree() {
  if (worktreeAgent !== null && Date.now() - askedAt < 60_000) return worktreeAgent
  try {
    const h = await fetch(`${config.deepagentsUrl}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
    const now = h?.worktree === true
    if (now !== worktreeAgent) console.log(`[team] deepagents worktree: ${now ? 'yes — continue runs on the branch' : 'no — continue hands the branch files over as attachments'}`)
    worktreeAgent = now; askedAt = Date.now()
  } catch { return false }
  return worktreeAgent
}

export function teamRoutes(auth) {
  agentWorktree()
  const r = express.Router()
  // messages written anywhere (process-gpt's UI, agents, here) reach pgpt-pro clients live
  // (not on a PRO_BACKGROUND=0 development server: the main server already listens and assists)
  if (process.env.PRO_BACKGROUND !== '0') {
    M.startRoomFeed()
    // team assist watches every new person-written message in a room (lib/team/assist.js)
    watchRooms()
  }
  const h = (fn) => async (req, res) => {
    try {
      await requireMember(req.user)
      const out = await fn(req, res)
      if (out !== undefined && !res.headersSent) res.json(out)
    } catch (e) {
      if (!(e instanceof TeamError)) console.warn('[team]', req.method, req.path, e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ error: e instanceof TeamError ? e.message : L('처리하지 못했어요.', "I couldn't do that."), ...(e.conflicts ? { conflicts: e.conflicts } : {}),
        // (a code says which refusal it is: reactions_off — the screen offers no reactions; a 503 from anything in between does not)
        ...(e instanceof TeamError && e.code ? { code: e.code } : {}) })
    }
  }
  const text = (v, n = 4000) => String(v ?? '').trim().slice(0, n)

  // ---- suggestions for "@" and the share picker ----
  r.post('/team/suggest', auth, h((req) => suggest(req.user, { mode: req.body.mode === 'related' ? 'related' : 'fast', messageIds: req.body.messageIds, title: text(req.body.title, 120) })))

  // ---- shares ----
  // one artifact (or a few) to one or more teammates, each in our 1:1 thread
  r.post('/team/share', auth, h(async (req) => {
    const recipients = await resolveRecipients(req.user, req.body.to)
    const files = await S.myFiles(req.user, req.body.messageIds)
    if (!files.length) throw new TeamError(400, L('공유할 산출물을 골라 주세요.', 'Please choose the outputs to share.'))
    rateLimit(req.user.id, recipients.length)
    const note = text(req.body.note, 1000)
    // one fork for everyone in this send: every branch starts from the same commit (one batch)
    const forked = await S.fork(req.user, files, { choices: req.body.choices || {} }).catch((e) => {
      if (e instanceof TeamError || (e.code !== '42P01' && e.code !== '42883')) throw e
      return null
    })
    const sent = []
    for (const p of recipients) {
      const t = await M.directThread(req.user, p.id)
      const m = await M.post(req.user, t.id, { kind: 'share', body: note, attach: (rs, mid, rid) => S.grant(req.user, rs, files, { note, dmMessageId: mid, roomId: rid, forked }) })
      sent.push({ to: { id: p.id, name: p.name, via: p.via }, threadId: t.id, messageId: m.id })
    }
    // a share of a mail case's drafts is that case's next handover (process mining, lib/mining)
    import('../lib/mining/recorder.js').then((m) => m.recordShare(req.user, files, recipients, note, forked)).catch((e) => console.warn('[mining] share', e.message))
    return { sent, batch: forked ? { id: forked.batchId, baseCommitId: forked.baseCommitId } : null }
  }))
  r.get('/team/shares/:id/raw', async (req, res, next) => {
    // the messenger's previews and its viewer: a signed address (GET …/link, the room's messages) names the person instead of a
    // token. A valid signature only says who asks — the same access check as a signed-in call follows (S.stream → objectFor:
    // not theirs, revoked → 404). Expired: 401 (the page asks for a new address); altered: 403.
    if (!req.headers.authorization && req.query.sig) {
      const u = String(req.query.u || '')
      return asTenantOf(u, () => {
        let v = 'bad'
        try { v = verifyLink({ key: S.mediaKey(), tenant: config.tenantId, id: req.params.id, u, exp: req.query.exp, sig: req.query.sig, inline: req.query.inline === '1' }) } catch { /* no key: refused */ }
        if (v !== 'ok') return res.status(v === 'expired' ? 401 : 403).json({ error: v === 'expired' ? L('주소가 만료됐어요. 다시 열어 주세요.', 'This address has expired. Please open it again.') : L('주소가 맞지 않아요.', "This address isn't valid.") })
        req.user = { id: u.toLowerCase() }
        next('route')
      })
    }
    // a link the browser opens directly may carry the token in the query (older callers; the messenger now signs its own)
    if (!req.headers.authorization && req.query.token) req.headers.authorization = `Bearer ${req.query.token}`
    next()
  }, auth, (req, res, next) => next('route'))
  r.get('/team/shares/:id/raw', h(async (req, res) => {
    // streamed from storage, a part when the browser asks for one (Range): the messenger plays a sound or a video from here and
    // shows a picture (src/components/MediaPreview.vue) — a seek, and Safari at all, need 206
    const f = await S.stream(req.user, req.params.id, req.headers.range)
    // open=1: the person opened it (the viewer, its 「새 창에서 열기」) — their open is recorded (only on their own row as its recipient;
    // its sender opening it records nothing). The room's small preview of a picture · a video's first frame asks without it: shown, not opened.
    // A player asks in parts (Range): only the request from the start counts — a seek or the next part is the same open. Written
    // alongside, not before the file goes out.
    const fromStart = !req.headers.range || /^bytes=0-/i.test(String(req.headers.range).trim())
    if (req.query.open === '1' && f.res.ok && fromStart) S.recordOpen(req.user, [req.params.id]).catch((e) => console.warn('[team] opened', e.message))
    res.status(f.res.status)
    for (const k of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (f.res.headers.get(k)) res.setHeader(k, f.res.headers.get(k))
    res.setHeader('Content-Type', f.type)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // nothing in it runs on this origin (an SVG opened by itself draws, its script does not)
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
    // inline=1: a picture · sound · video shown in its own tab (the viewer's 「새 창에서 열기」); anything else is a download
    const inline = !!req.query.inline && /^(image|audio|video)\//i.test(f.type)
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
    res.setHeader('Cache-Control', 'private, max-age=60')
    if (!f.res.body) return void res.end()
    const { Readable } = await import('node:stream')
    await new Promise((ok) => { const s = Readable.fromWeb(f.res.body); s.on('error', () => { res.destroy(); ok() }); res.on('close', () => { s.destroy(); ok() }); s.pipe(res) })
  }))
  // a fresh signed address of my share's file (the one in the room's messages is good for 15 minutes): the same check as reading it
  r.get('/team/shares/:id/link', auth, h(async (req) => {
    await S.objectFor(req.user, req.params.id)
    const link = S.mediaLink(req.user.id, req.params.id)
    if (!link) throw new TeamError(503, L('지금은 주소를 만들 수 없어요.', "I can't make the address right now."))
    return { link }
  }))
  // the file card to open in the editor: my original (sender) or my own copy (recipient — my open is recorded)
  r.post('/team/shares/:id/open', auth, h(async (req) => ({ message: await S.openCopy(req.user, req.params.id) })))
  // I opened a share where this server does not see it (my copy's card in my work conversation, a sound · a video played in the room)
  r.post('/team/shares/:id/opened', auth, h((req) => S.markOpened(req.user, req.params.id)))
  // my share messages in a room, as their sender sees them: for each person they went to, opened or not (first · last), and what
  // their copy changed — ?ids=<message ids> (the room's messages on my screen). Nobody else is told who opened what.
  // (→ {receipts, asked}: asked — the ids looked at, the first 100; the screen asks for more in parts of 100)
  r.get('/team/threads/:id/receipts', auth, h((req) => S.receipts(req.user, String(req.params.id), String(req.query.ids || '').split(',').filter(Boolean))))
  // the sender's view of the branches a share message started: what each recipient changed, when, by whom
  // (the sender, or a recipient of the same batch; anyone else gets 403)
  r.get('/team/messages/:id/branches', auth, h(async (req) => {
    const rows = await branchRows(req.user, { chat: String(req.params.id) })
    return { branches: (await Promise.all(dedupe(rows).map(W.branchStatus))).filter(Boolean) }
  }))
  // one file of a branch, read-only unless it is my own branch
  r.get('/team/branches/file', auth, h(async (req) => {
    const room = String(req.query.room || ''), path = String(req.query.path || '')
    const [row] = await branchRows(req.user, { room })
    const entry = (await W.branchHead(room))?.tree?.[path]
    if (!entry) throw new TeamError(404, '파일을 찾지 못했어요.')
    return { url: W.objectUrl(entry), name: path.split('/').pop(), readOnly: row.recipient_id !== req.user.id }
  }))
  r.delete('/team/shares/:id', auth, h(async (req) => {
    if (!(await S.revoke(req.user, req.params.id))) throw new TeamError(404, L('취소할 공유를 찾지 못했어요.', "I couldn't find the share to cancel."))
    return { ok: true }
  }))

  // ---- @mention from chat: the message goes to the teammates, with this conversation's gist ----
  r.post('/team/mention', auth, h(async (req) => {
    const recipients = await resolveRecipients(req.user, req.body.to)
    const body = text(req.body.text)
    if (!body) throw new TeamError(400, L('보낼 말을 적어 주세요.', 'Please write a message to send.'))
    const own = req.body.threadId ? await getThread(req.user.id, String(req.body.threadId)).catch(() => null) : null
    if (req.body.threadId && !own) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
    rateLimit(req.user.id, recipients.length)
    const title = text(req.body.conversation?.title, 120)
    const state = await workState(req.user, { messageIds: req.body.contextIds || [] })
    const excerpt = state.split('\n').filter((l) => !l.startsWith('산출물:') && !l.startsWith('Outputs:')).slice(-4)
    const files = await S.myFiles(req.user, (req.body.artifactIds || []).slice(-3), { lenient: true })
    const context = { title: title || null, conversationId: req.body.conversation?.id ? text(req.body.conversation.id, 80) : null, excerpt }
    for (const p of recipients) {
      const t = await M.directThread(req.user, p.id)
      await M.post(req.user, t.id, { kind: 'mention', body, context, attach: files.length ? (rs, mid, rid) => S.grant(req.user, rs, files, { note: body, dmMessageId: mid, roomId: rid }) : null })
    }
    const names = recipients.map((p) => (p.via ? `${p.name}(${p.via})` : p.name)).join(', ')
    if (own) {
      await addMessage(req.user.id, own.id, 'user', 'text', { text: `${recipients.map((p) => `@${p.via || p.name}`).join(' ')} ${body}`, team: true })
      await addMessage(req.user.id, own.id, 'agent', 'chip', { icon: 'bell', text: L(`${names}님께 보냈어요${files.length ? ` · 산출물 ${files.length}개` : ''}`, `Sent to ${names}${files.length ? ` · ${files.length} output${files.length > 1 ? 's' : ''}` : ''}`) })
    }
    return { sent: recipients.map((p) => ({ id: p.id, name: p.name, via: p.via })), files: files.length }
  }))

  // ---- messenger ----
  r.get('/team/threads', auth, h((req) => M.listThreads(req.user)))
  // invite teammates into a group room I am in (lib/team/messenger.js invite): {userIds} → {threadId, added, members}
  r.post('/team/rooms/:id/invite', auth, h((req) => M.invite(req.user, String(req.params.id), req.body?.userIds)))
  // a group room's name, set by any of its people (Process GPT's chat_rooms.name; '' → called by its people again): {name} → {threadId, name, changed}
  r.put('/team/rooms/:id/name', auth, h((req) => {
    // the name is sent on purpose: '' (or null) gives the room back its people's names; a body without it changes nothing
    if (!req.body || !('name' in req.body)) throw new TeamError(400, L('바꿀 이름을 보내 주세요.', 'Send the name to set.'))
    return M.rename(req.user, String(req.params.id), req.body.name)
  }))
  // one of my reactions on someone else's message (lib/team/reactions.js): {key, on?} — on omitted turns it over → {messageId, threadId, reactions}
  r.post('/team/messages/:id/reactions', auth, h((req) => M.react(req.user, String(req.params.id), req.body?.key, typeof req.body?.on === 'boolean' ? req.body.on : undefined)))
  r.post('/team/threads', auth, h(async (req) => {
    const ids = [...new Set((req.body.members || []).map(String))].filter((id) => id !== req.user.id)
    if (!ids.length) throw new TeamError(400, L('대화할 팀원을 골라 주세요.', 'Please choose the teammates to talk with.'))
    for (const id of ids) if (!(await isMember(id))) throw new TeamError(403, L('팀원과만 대화할 수 있어요.', 'You can talk only with teammates.'))
    const t = ids.length === 1 ? await M.directThread(req.user, ids[0]) : await M.groupThread(req.user, ids, text(req.body.title, 60))
    return { id: t.id }
  }))
  // (each message as I read it: in my main language when it is already translated — lib/team/roomTranslate.js)
  r.get('/team/threads/:id/messages', auth, h(async (req) => {
    const out = await M.messages(req.user, req.params.id, { before: req.query.before })
    await RT.attachCached(req.user, out.messages)
    return out
  }))
  // messages in another language than my main one, translated for me (once per text and language)
  r.post('/team/translate', auth, h((req) => RT.translateFor(req.user, req.body?.ids, req.body?.suggestions)))
  // a file from the computer (dropped, pasted or picked in the messenger): stored and made a card of mine, then sent like any card
  // (lib/team/uploads.js). The body is the file itself; its name and type in X-File-Name / X-File-Type (the body goes as
  // application/octet-stream, so the JSON parser in front never takes a .json file)
  r.post('/team/uploads', express.raw({ type: () => true, limit: '50mb' }), auth, h(async (req) => {
    const type = String(req.headers['x-file-type'] || '').slice(0, 120)
    let name = 'file'
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')) } catch { /* the raw header */ }
    return uploadCard(req.user, name, type && type !== 'application/octet-stream' ? type : '', req.body)
  }))
  // refs: shared folders' files mentioned by link (dropped from a folder, a chat card, a received mention — checked again as the sender:
  // a folder they cannot read is refused); ai: addressed to the AI, which answers in the room (lib/team/aiHelp.js); mentions: people named
  r.post('/team/threads/:id/messages', auth, h(async (req) => {
    const body = text(req.body.text)
    const files = await S.myFiles(req.user, req.body.artifactIds || [])
    const refs = await FR.forSend(req.user, req.body.refs, { roomId: req.params.id }).catch((e) => { throw new TeamError(e.status || 400, e.message) })
    const ai = req.body.ai === true
    if (!body && !files.length && !refs.length) throw new TeamError(400, L('보낼 말을 적어 주세요.', 'Please write a message to send.'))
    rateLimit(req.user.id)
    const mentions = Array.isArray(req.body.mentions) ? req.body.mentions.slice(0, 8) : []
    // (a mail mention — lib/mailMention.js — is 'mailref' when it is all the message carries)
    const kind = files.length ? 'share' : refs.length ? (refs.every((x) => x.type === 'mail' || x.type === 'mailatt') ? 'mailref' : 'fileref') : 'text'
    const m = await M.post(req.user, req.params.id, { kind, body, refs, ai, mentions,
      attach: files.length ? (rs, mid, rid) => S.grant(req.user, rs, files, { note: body, dmMessageId: mid, roomId: rid }) : null })
    if (ai) AI.answer(req.user, req.params.id, m).catch((e) => console.warn('[ai-help]', e.message))
    return m
  }))
  // a file mention: open it (a card of mine for the office panel, or where it is in its folder) — the newest version with latest
  r.post('/team/refs/open', auth, h(async (req) => FR.open(req.user, String(req.body.messageId || ''), Number(req.body.index) || 0, { latest: req.body.latest === true })
    .catch((e) => { throw new TeamError(e.status || 500, e.status ? e.message : L('열지 못했어요.', "I couldn't open it.")) })))
  // 권한 요청 on a mention of a folder I cannot read: the folder's owners (and who mentioned it) are told
  r.post('/team/refs/request', auth, h(async (req) => FR.requestAccess(req.user, String(req.body.messageId || ''), Number(req.body.index) || 0)
    .catch((e) => { throw new TeamError(e.status || 500, e.status ? e.message : L('요청하지 못했어요.', "I couldn't send the request.")) })))
  // a mail mention's body, shared with the room or no longer (its owner only — lib/mailMention.js): every member's card changes at once
  r.post('/team/refs/share', auth, h(async (req) => {
    const messageId = String(req.body.messageId || ''), index = Number(req.body.index) || 0
    const [row] = /^[\w.:-]{1,120}$/.test(messageId) ? await q('select uuid, id, messages from chats where uuid=$1 and tenant_id=$2', [messageId, config.tenantId]) : []
    const ref = (row?.messages?.pgpt?.refs || [])[index]
    const member = !!row && !!(await M.memberThread(req.user, row.id))
    // the mail's owner may always stop sharing it with a room — also one they have left (the room keeps the share otherwise, and whoever
    // joins it later gets it — review 11-25 #5); sharing anew needs the room
    const ownerOff = !!row && req.body.on === false && ['mail', 'mailatt'].includes(ref?.type) && String(ref.owner) === String(req.user.id)
    if (!row || (!member && !ownerOff)) throw new TeamError(404, L('메시지를 찾지 못했어요.', "I couldn't find that message."))
    // (an attachment of a mail — lib/mailAttachments.js — is shared the same way, that file only)
    const updated = await (ref?.type === 'mailatt' ? MA.share : MM.share)(req.user, row, index, req.body.on !== false).catch((e) => { throw new TeamError(e.status || 500, e.status ? e.message : L('바꾸지 못했어요.', "I couldn't change it.")) })
    await M.deliver(updated.uuid)
    return member ? M.message(req.user, updated.uuid) : { id: updated.uuid, refs: [], left: true }
  }))
  assistRoutes(r, auth, h)
  r.post('/team/threads/:id/read', auth, h((req) => M.markRead(req.user, req.params.id)))
  r.get('/team/unread', auth, h((req) => M.unread(req.user)))
  r.get('/team/inbox', auth, h(async (req) => RT.attachCached(req.user, await M.inbox(req.user))))

  // "이어서 작업": my agent picks up what a teammate sent — in that share's own work conversation, on
  // its branch (deepagents unfolds it and commits the turn). A share made before branches, a mention
  // without files, or an agent that cannot unfold a branch: the old way, my copies in my main chat.
  // On my own share: the returned branches are gathered and my agent works on the result.
  r.post('/team/messages/:id/continue', auth, h(async (req) => {
    const m = await M.message(req.user, req.params.id)
    if (!m) throw new TeamError(404, L('이어서 할 메시지를 찾지 못했어요.', "I couldn't find the message to continue."))
    const shareIds = m.artifacts.map((a) => a.shareId).filter(Boolean)
    const rows = shareIds.length ? await q(`select * from pro_shares where id = any($1::uuid[]) and branch_room_id is not null and revoked_at is null`, [shareIds]) : []
    if (m.mine) {
      if (!rows.length) throw new TeamError(404, L('이어서 할 메시지를 찾지 못했어요.', "I couldn't find the message to continue."))
      return gatherAndContinue(req, m, rows[0].source_room_id)
    }
    const mine = rows.find((x) => x.recipient_id === req.user.id)
    // picking up what was sent is opening it: my own rows only (their sender's card says 「열어 봄」)
    await S.recordOpen(req.user, shareIds).catch((e) => console.warn('[team] opened', e.message))
    const shown = L(`${m.sender.name}님이 보낸 일을 이어서 할게요${m.body ? `: "${m.body.slice(0, 200)}"` : ''}`, `Continuing the work ${m.sender.name} sent${m.body ? `: "${m.body.slice(0, 200)}"` : ''}`)
    const context = L([`(팀원 ${m.sender.name}님이 ${m.kind === 'share' ? '산출물을 공유했어요' : '이 일로 저를 언급했어요'}. 그 맥락에서 이어서 작업해 주세요.)`,
      m.context?.title ? `대화: ${m.context.title}` : '', ...(m.context?.excerpt?.length ? ['— 대화 발췌 —', ...m.context.excerpt] : []),
    ], [`(My teammate ${m.sender.name} ${m.kind === 'share' ? 'shared outputs with me' : 'mentioned me about this work'}. Please continue the work in that context.)`,
      m.context?.title ? `Conversation: ${m.context.title}` : '', ...(m.context?.excerpt?.length ? ['— conversation excerpt —', ...m.context.excerpt] : []),
    ]).filter(Boolean).join('\n')
    let threadId, files = []
    if (mine) {
      threadId = W.threadOfRoom(mine.branch_room_id)
      // the agent cannot unfold the branch: hand it the branch files as attachments
      if (!(await agentWorktree())) files = await S.branchAttachments(req.user, mine.branch_room_id)
    } else {
      files = await S.copiesFor(req.user, shareIds)
      threadId = (await mainThread(req.user.id)).id
    }
    // (composed here from a teammate's message: the room's judge does not take it as this person's rule or plan — review PR #105 #8)
    runTurn({ user: req.user, session: req.session, threadId, text: shown, context, files, composed: true })
      .catch((e) => console.warn('[team continue]', e.message))
    M.markRead(req.user, m.threadId).catch(() => {})
    return { threadId, files: files.length, branch: !!mine }
  }))

  async function gatherAndContinue(req, m, room) {
    const own = W.threadOfRoom(room)
    const [src] = own ? await q('select * from pro_threads where id=$1 and user_id=$2', [own, req.user.id]) : []
    if (!src) throw new TeamError(404, '공유한 대화를 찾지 못했어요.')
    const g = await W.gather(req.user, room, req.body?.choices || {})
    // a work conversation is its own branch room: the agent works right there
    let threadId = src.conversation_id === room ? src.id : null
    if (!threadId) {
      // the main chat talks to deepagents under the router's conversation: the gathered state gets a
      // conversation of its own (again the same one while nothing new came back)
      const head = await W.branchHead(room)
      const [prev] = g.merged ? [] : await q(`select * from pro_threads where user_id=$1 and share_ref like $2 order by created_at desc limit 1`, [req.user.id, `collect:${room}:%`])
      if (prev) threadId = prev.id
      else {
        const [t] = await q(`insert into pro_threads(user_id,kind,title,share_ref) values ($1,'project',$2,$3) returning *`,
          [req.user.id, `모은 결과 · ${(m.artifacts[0]?.name || '공유').slice(0, 40)}`, `collect:${room}:${head.head_commit_id}`])
        await q('update pro_threads set conversation_id=$2 where id=$1', [t.id, W.roomOf(t.id)])
        await W.forkBranch({ repoId: head.repo_id, room: W.roomOf(t.id), baseCommitId: head.head_commit_id, tree: head.tree, authorId: req.user.id })
        threadId = t.id
      }
    }
    const shown = `팀원들이 돌려준 결과를 모아 이어서 할게요${m.body ? `: "${m.body.slice(0, 200)}"` : ''}`
    const files = (await agentWorktree()) ? [] : await S.branchAttachments(req.user, W.roomOf(threadId))
    runTurn({ user: req.user, session: req.session, threadId, text: shown, context: `(모은 갈래 ${g.merged}개의 결과가 작업 폴더에 있어요.)`, files, composed: true })
      .catch((e) => console.warn('[team gather]', e.message))
    return { threadId, merged: g.merged, branch: true }
  }

  // share rows I may see branches of: I sent them, or I received one of the same batch
  async function branchRows(me, { chat, room }) {
    const rows = await q(`select s.*, u.username as name from pro_shares s left join users u on u.id=s.recipient_id and u.tenant_id=s.tenant_id
                          where s.tenant_id=$1 and s.branch_room_id is not null and s.revoked_at is null and ${chat ? 's.chat_uuid=$2' : 's.branch_room_id=$2'}`, [config.tenantId, chat || room])
    if (!rows.length) throw new TeamError(404, '갈래를 찾지 못했어요.')
    if (rows.some((x) => x.owner_id === me.id || x.recipient_id === me.id)) return named(rows, { id: 'recipient_id' })
    const [peer] = await q('select 1 from pro_shares where batch_id = any($1::uuid[]) and recipient_id=$2 and revoked_at is null limit 1', [[...new Set(rows.map((x) => x.batch_id))], me.id])
    if (!peer) throw new TeamError(403, '이 공유에 참여하지 않았어요.')
    return named(rows, { id: 'recipient_id' })
  }
  const dedupe = (rows) => rows.filter((x, i) => rows.findIndex((y) => y.branch_room_id === x.branch_room_id) === i)
  return r
}
