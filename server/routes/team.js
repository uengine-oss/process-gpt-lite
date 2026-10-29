// HTTP routes for team sharing and the messenger (팀 공유·메신저). Every route checks that the
// caller is on the team; every recipient is checked too (lib/team/access.js).
// Design: process-gpt/openspec/changes/pgpt-pro-team-sharing/design.md
import express from 'express'
import { L } from '../lib/lang.js'
import { getThread, mainThread, addMessage } from '../lib/store.js'
import { runTurn } from '../lib/agent.js'
import { TeamError, requireMember, resolveRecipients, rateLimit, isMember } from '../lib/team/access.js'
import * as S from '../lib/team/shares.js'
import * as M from '../lib/team/messenger.js'
import { suggest, workState } from '../lib/team/suggest.js'
import { watchRooms } from '../lib/team/assist.js'
import { assistRoutes } from './teamAssist.js'
import * as RT from '../lib/team/roomTranslate.js'

export function teamRoutes(auth) {
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
      if (!res.headersSent) res.status(e.status || 500).json({ error: e instanceof TeamError ? e.message : L('처리하지 못했어요.', "I couldn't do that.") })
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
    const sent = []
    for (const p of recipients) {
      const t = await M.directThread(req.user, p.id)
      const m = await M.post(req.user, t.id, { kind: 'share', body: note, attach: (rs, mid, rid) => S.grant(req.user, rs, files, { note, dmMessageId: mid, roomId: rid }) })
      sent.push({ to: { id: p.id, name: p.name, via: p.via }, threadId: t.id, messageId: m.id })
    }
    // a share of a mail case's drafts is that case's next handover (process mining, lib/mining)
    import('../lib/mining/recorder.js').then((m) => m.recordShare(req.user, files, recipients, note)).catch((e) => console.warn('[mining] share', e.message))
    return { sent }
  }))
  r.get('/team/shares/:id/raw', async (req, res, next) => {
    // a link the browser opens directly may carry the token in the query
    if (!req.headers.authorization && req.query.token) req.headers.authorization = `Bearer ${req.query.token}`
    next()
  }, auth, h(async (req, res) => {
    const f = await S.bytes(req.user, req.params.id)
    res.setHeader('Content-Type', f.type)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`)
    res.end(f.buf)
  }))
  // the file card to open in the editor: my original (sender) or my own copy (recipient)
  r.post('/team/shares/:id/open', auth, h(async (req) => ({ message: await S.openCopy(req.user, req.params.id) })))
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
  r.post('/team/threads/:id/messages', auth, h(async (req) => {
    const body = text(req.body.text)
    const files = await S.myFiles(req.user, req.body.artifactIds || [])
    if (!body && !files.length) throw new TeamError(400, L('보낼 말을 적어 주세요.', 'Please write a message to send.'))
    rateLimit(req.user.id)
    const m = await M.post(req.user, req.params.id, { kind: files.length ? 'share' : 'text', body, attach: files.length ? (rs, mid, rid) => S.grant(req.user, rs, files, { note: body, dmMessageId: mid, roomId: rid }) : null })
    return m
  }))
  assistRoutes(r, auth, h)
  r.post('/team/threads/:id/read', auth, h((req) => M.markRead(req.user, req.params.id)))
  r.get('/team/unread', auth, h((req) => M.unread(req.user)))
  r.get('/team/inbox', auth, h(async (req) => RT.attachCached(req.user, await M.inbox(req.user))))

  // "이어서 작업": my agent picks up what a teammate sent — their note, the gist and my copies
  r.post('/team/messages/:id/continue', auth, h(async (req) => {
    const m = await M.message(req.user, req.params.id)
    if (!m || m.mine) throw new TeamError(404, L('이어서 할 메시지를 찾지 못했어요.', "I couldn't find the message to continue."))
    const files = await S.copiesFor(req.user, m.artifacts.map((a) => a.shareId).filter(Boolean))
    const t = await mainThread(req.user.id)
    const shown = L(`${m.sender.name}님이 보낸 일을 이어서 할게요${m.body ? `: "${m.body.slice(0, 200)}"` : ''}`, `Continuing the work ${m.sender.name} sent${m.body ? `: "${m.body.slice(0, 200)}"` : ''}`)
    const context = L([`(팀원 ${m.sender.name}님이 ${m.kind === 'share' ? '산출물을 공유했어요' : '이 일로 저를 언급했어요'}. 그 맥락에서 이어서 작업해 주세요.)`,
      m.context?.title ? `대화: ${m.context.title}` : '', ...(m.context?.excerpt?.length ? ['— 대화 발췌 —', ...m.context.excerpt] : []),
    ], [`(My teammate ${m.sender.name} ${m.kind === 'share' ? 'shared outputs with me' : 'mentioned me about this work'}. Please continue the work in that context.)`,
      m.context?.title ? `Conversation: ${m.context.title}` : '', ...(m.context?.excerpt?.length ? ['— conversation excerpt —', ...m.context.excerpt] : []),
    ]).filter(Boolean).join('\n')
    runTurn({ user: req.user, session: req.session, threadId: t.id, text: shown, context, files })
      .catch((e) => console.warn('[team continue]', e.message))
    M.markRead(req.user, m.threadId).catch(() => {})
    return { threadId: t.id, files: files.length }
  }))
  return r
}
