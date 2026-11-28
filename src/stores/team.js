// Team sharing and messenger (server/routes/team.js): one list of conversations with teammates and what of theirs is for me
// (대화 › 나에게 온 것 — the rooms' own messages, filtered), the share picker and the people "@" suggests. Live updates arrive as 'team' events, re-broadcast on the
// window by api.js events() — one stream per page, which this store opens too when the chat has not (boot).
import { defineStore } from 'pinia'
import { api, events } from '../api.js'
import { useApp } from './app.js'
import { openArtifact, viewMedia } from '../artifacts.js'
import { openMailAttachment, carryOut } from '../mailAttach.js'
import { maybeOther } from '../i18n/mainLangs.js'
// where the messenger sits (float · right · left · panel), remembered per device: src/messengerDock.js
import { load as loadDock, save as saveDock, reduce as reduceDock, effective as dockIn } from '../messengerDock.js'
import { openPlan, closesMessenger } from '../openPlan.js'
import { craftMissing } from '../officeEditor.js'
import { viewW } from '../viewport.js'
// one copy per message id when what came live and what was asked for are put together
import { merged } from '../messageMerge.js'
// reactions on a room's messages: my own toggled at once, the server's answer and the room's live ones after (src/roomReactions.js)
import { toggled } from '../roomReactions.js'
// my share cards' people: asked in parts, merged without guessing (src/shareReceipts.js)
import { receiptChunks, mergeReceipts } from '../shareReceipts.js'
// a room read here: its phone notification goes (src/browserNotify.js)
import { clearRoom } from '../browserNotify.js'

const store = () => { try { return window.localStorage } catch { return null } }
// what 대화 › 나에게 온 것 lists: a teammate's share, mention, file link, mail mention, question (AI asking for them) and shared AI answer —
// the same kinds as the server's (lib/team/messenger.js FOR_ME)
export const FOR_ME = ['share', 'mention', 'fileref', 'mailref', 'askteam', 'answer']

// file cards that can be shared: the ones with a storage object behind them (not workroom-only files)
// a stored file, or one the agent left in its work folder (shared through the branch commit)
export const shareable = (m) => m?.kind === 'file' && (/\/storage\/v1\/object\/public\//.test(m.content?.url || '') || /^\/workspace\//.test(m.content?.path || ''))

export const useTeam = defineStore('team', {
  state: () => ({
    booted: false,
    open: false,              // messenger sheet
    // the messenger's one list and its chips (2026-11-28 「받은 편지함 = 대화의 거르개」): all · forme (나에게 온 것: the rooms' shares,
    // mentions, file links, mail mentions, questions, answers from others) · unread · mail (my mail cards — another source)
    filter: 'all',
    threads: [],
    forMe: [],                // 나에게 온 것: room messages (server lib/team/messenger.js inbox), each with unread by the room's read state
    unread: { total: 0, byThread: {} },
    active: null,             // thread id shown in the messenger
    msgs: {},                 // threadId -> [message]
    focus: null,              // message id to scroll to
    sharing: null,            // {messageIds, names} → SharePicker
    toast: null,
    people: null,             // last fast suggestion {frequent, related, roles, rest, at}
    suggestions: {},          // threadId -> [assist suggestion] (lib/team/assist.js)
    assistOn: {},             // threadId -> the thread's AI 제안 switch
    assistStatus: {},         // suggestion id -> live status text while it runs
    aiStatus: {},             // threadId -> {messageId, text}: 「AI가 찾는 중…」 while 「@AI …」 is answered (lib/team/aiHelp.js)
    // auto-translation (server/lib/team/roomTranslate.js): message id -> {body, from} | {lines: {i: text}} |
    // {minutes: {summary, decisions, actions}} | {same: true}; original: message id -> showing the original
    tr: {},
    original: {},
    dockState: loadDock(store()), // {dock, width} as chosen on this device (a narrow window floats it: dockNow)
    // my share messages as their sender sees them (server lib/team/shares.js receipts): message id -> [{id, name, email, files, opened,
    // openedAt, lastOpenedAt, branch}] — for each person it went to, opened or not, and what their copy changed
    receipts: {},
    replyAt: 0,               // when 「답장」 on a phone notification opened a room (Messenger.vue focuses the composer)
    // this database has no reactions yet (sql/062 — the room's messages say so): none are offered, so none are put on and taken back off
    rxOff: false,
    // whether that is known yet: a room's messages say it (thread.reactions), 나에게 온 것 says it on its items — until then no reaction is
    // offered there (a database without them would put one on and take it back off)
    rxKnown: false,
  }),
  getters: {
    // the dock in effect on this window: float · right · left · panel
    dockNow: (s) => dockIn(s.dockState, viewW.value),
  },
  actions: {
    setDock(to) { this.dockState = reduceDock(this.dockState, { type: 'dock', to }); saveDock(store(), this.dockState) },
    // keep: false while the edge is being dragged (kept once, when it is let go)
    setDockWidth(width, { keep = true } = {}) {
      this.dockState = reduceDock(this.dockState, { type: 'resize', width, viewW: viewW.value })
      if (keep) saveDock(store(), this.dockState)
    },
    async boot() {
      if (this.booted) return
      this.booted = true
      window.addEventListener('pgpt:event', (e) => this.onEvent(e.detail))
      // the page's live events, also where the chat never booted (the folder screen with the messenger docked beside it)
      events(() => {})
      await Promise.all([this.loadUnread(), this.loadThreads(), this.loadForMe()]).catch(() => {})
    },
    // (asked again on every read, and a room in a meeting is read again and again as its cards change: only the newest answer counts)
    async loadUnread() { const r = await this.latest('unread', '/team/unread'); if (r) this.unread = r },
    // Lists asked for again and again (on open, on every arriving message) answer out of order on a busy
    // server: only the newest request's answer is kept — an older one, asked before a share arrived,
    // must not put back 나에게 온 것 without it (the share was missing on the first open)
    async latest(key, path) {
      const n = (this._seq = (this._seq || 0) + 1)
      ;(this._want ||= {})[key] = n
      const r = await api(path).catch(() => null)
      return r && this._want[key] === n ? r : null
    },
    async loadThreads() { const r = await this.latest('threads', '/team/threads'); if (r) this.threads = r },
    async loadForMe() {
      const r = await this.latest('forme', '/team/inbox')
      if (!r) return
      this.forMe = r
      this.takeTr(this.forMe)
      if (r.length) { this.rxOff = r.some((x) => x.rxOff); this.rxKnown = true }
    },
    // the counts once more, soon: one read can be told twice (its answer and its live 'read') — asked once
    refreshUnread() { clearTimeout(this._unreadT); this._unreadT = setTimeout(() => this.loadUnread(), 200) },

    // ---- auto-translation: messages in another language than my main one ----
    myLang() { return useApp().me?.mainLang || 'ko' },
    // what the server already knew (m.tr) and what it said is missing (m.trNeeded)
    takeTr(list) {
      const want = []
      for (const m of list || []) {
        if (m.tr?.body) this.tr[m.id] = { body: m.tr.body, from: m.tr.from }
        else if (m.trNeeded || this.needsTr(m)) want.push(m.id)
      }
      if (want.length) this.queueTr(want)
    },
    needsTr(m, { live = false } = {}) {
      const my = this.myLang()
      if (m.kind === 'meeting-transcript') return (m.meeting?.lines || []).some((l, i) => l.lang && l.lang !== my && !l.tr?.[my] && !this.tr[m.id]?.lines?.[i])
      if (m.kind === 'meeting-minutes') return (m.meeting?.lang || 'ko') !== my && !m.meeting?.tr?.[my] && !this.tr[m.id]?.minutes
      if (!live || m.mine || !m.body || !['text', 'agent', 'share', 'mention'].includes(m.kind)) return false
      if (this.tr[m.id]) return false
      return maybeOther(m.body, my) !== false
    },
    // a suggestion card written in another language (its requester's)
    sugTr(list) {
      const my = this.myLang()
      const want = (list || []).filter((x) => x?.id && !this.tr[`s:${x.id}`] && (maybeOther(x.title, my) !== false || maybeOther(x.reason, my) === true)).map((x) => `s:${x.id}`)
      if (want.length) this.queueTr(want)
    },
    trSug(sg, key) { return !this.original[`s:${sg.id}`] && this.tr[`s:${sg.id}`]?.[key] ? this.tr[`s:${sg.id}`][key] : null },
    queueTr(ids, wait = 150) {
      this._trq = new Set([...(this._trq || []), ...ids])
      clearTimeout(this._trt)
      this._trt = setTimeout(() => this.flushTr(), wait)
    },
    async flushTr() {
      const all = [...(this._trq || [])].slice(0, 40)
      this._trq = new Set([...(this._trq || [])].slice(40))
      if (!all.length) return
      const ids = all.filter((x) => !x.startsWith('s:'))
      const suggestions = all.filter((x) => x.startsWith('s:')).map((x) => x.slice(2))
      const r = await api('/team/translate', { method: 'POST', body: { ids, suggestions } }).catch(() => null)
      for (const [id, v] of Object.entries(r?.items || {})) this.tr[id] = { ...(this.tr[id] || {}), ...v, lines: { ...(this.tr[id]?.lines || {}), ...(v.lines || {}) } }
      if (this._trq.size) this.queueTr([], 50)
    },
    // the body as I read it (null = show it as written)
    trBody(m) { return !this.original[m.id] && this.tr[m.id]?.body ? this.tr[m.id].body : null },
    toggleOriginal(id) { this.original = { ...this.original, [id]: !this.original[id] } },
    onEvent({ type, data }) {
      if (type !== 'team') return
      if (data.type === 'message') {
        const m = data.message
        const list = this.msgs[data.threadId]
        // an agent's reply arrives twice: inserted, then updated with its shared files — replace in place
        // (a meeting's card and 회의록 block too, as they change; the minutes come a while after the end)
        const at = list ? list.findIndex((x) => x.id === m.id) : -1
        // (a message's copy carries no reactions — they come on their own, 'reactions' below: the ones it has stay)
        if (list && at >= 0) list[at] = m.reactions || !list[at].reactions ? m : { ...m, reactions: list[at].reactions }
        else if (list) list.push(m)
        this._live?.[data.threadId]?.set(m.id, m)
        if (this.needsTr(m, { live: true })) this.queueTr([m.id], String(m.kind).startsWith('meeting') ? 2500 : 150)
        const looking = this.open && this.active === data.threadId && document.visibilityState === 'visible'
        // news once per message: an update of one already here (or already counted) is not another unread one
        const seen = (this._seen ||= new Set())
        // (an old message brought up to date — a mail mention's share changed, server routes/team.js: update — is not news either)
        const news = at < 0 && !seen.has(m.id) && !data.update
        seen.add(m.id)
        if (seen.size > 2000) seen.delete(seen.values().next().value)
        // a room's new name is not news: its line is in the room, the header changes — no unread, no toast (server lib/team/messenger.js rename)
        if (!m.mine && m.kind !== 'rename') {
          if (looking) this.markRead(data.threadId)
          else if (news) {
            this.unread = { total: this.unread.total + 1, byThread: { ...this.unread.byThread, [data.threadId]: (this.unread.byThread[data.threadId] || 0) + 1 } }
            if (!this.open) this.say(`${m.sender.name}님: ${m.kind === 'share' ? `${m.artifacts[0]?.name || '산출물'} 공유` : m.body.slice(0, 40)}`, { threadId: data.threadId, messageId: m.id })
          }
          // 나에게 온 것 at once, whatever it is of them (a share, a mention, a file link, a mail mention, a question, an answer): the event
          // carries the message as the room shows it — an update keeps the item's read state and its reactions
          if (FOR_ME.includes(m.kind)) {
            const i = this.forMe.findIndex((x) => x.id === m.id)
            if (i >= 0) this.forMe[i] = { ...this.forMe[i], ...m, reactions: m.reactions || this.forMe[i].reactions, unread: looking ? false : this.forMe[i].unread }
            else this.forMe.unshift({ ...m, reactions: m.reactions || [], unread: !looking })
          }
          if (m.kind !== 'text') this.loadForMe()
        }
        this.loadThreads()
      } else if (data.type === 'read') {
        // the room read here or on another device, whole or up to a message: its items of 나에게 온 것 up to then, and the counts
        this.readUpTo(data.threadId, data.at)
        // (nothing newer is left: this device's notification of the room goes too)
        if (data.rest === 0) clearRoom(data.threadId)
        this.refreshUnread()
      }
      else if (data.type === 'assist') {
        const list = (this.suggestions[data.threadId] ||= [])
        const i = list.findIndex((x) => x.id === data.suggestion.id)
        if (data.suggestion.hidden) { if (i >= 0) list.splice(i, 1) } else if (i >= 0) list[i] = data.suggestion
        else list.unshift(data.suggestion)
        if (!data.suggestion.hidden) this.sugTr([data.suggestion])
      } else if (data.type === 'assist-status') this.assistStatus[data.id] = data.text
      else if (data.type === 'ai-status') {
        if (data.text) this.aiStatus = { ...this.aiStatus, [data.threadId]: { messageId: data.messageId, text: data.text } }
        else { const { [data.threadId]: _done, ...rest } = this.aiStatus; this.aiStatus = rest }
      }
      else if (data.type === 'assist-toggle') this.assistOn[data.threadId] = data.on
      // someone was invited into a room or named it (server lib/team/messenger.js invite · rename): its people and title, at once
      else if (data.type === 'room') {
        const t = this.threads.find((x) => x.id === data.threadId)
        if (t && Array.isArray(data.members)) t.members = data.members
        if (t && typeof data.name === 'string' && data.name) t.title = data.name
        this.loadThreads()
      }
      // a message's reactions changed (server lib/team/reactions.js): its chips as I see them — nothing else (no unread, no toast)
      else if (data.type === 'reactions') this.setReactions(data.threadId, data.messageId, data.reactions)
      // someone opened a file I shared for the first time (server lib/team/shares.js recordOpen — to me only): my card says so
      else if (data.type === 'opened' && this.receipts[data.messageId]) this.loadReceipts(data.threadId, [data.messageId]).catch(() => {})
    },
    say(text, go) {
      clearTimeout(this._t)
      this.toast = { text, go }
      this._t = setTimeout(() => (this.toast = null), 6000)
    },

    // reply: opened from 「답장」 on a room's phone notification (public/sw.js) — the composer gets the focus once the room is in (Messenger.vue)
    async openMessenger(threadId, messageId, { reply = false } = {}) {
      this.open = true
      this.toast = null
      if (threadId) { await this.openThread(threadId, messageId); if (reply) this.replyAt = Date.now() }
      else this.loadForMe()
    },
    async openThread(id, messageId) {
      this.active = id
      this.focus = messageId || null
      // what comes live while the page is asked for stays (it replaced the list it came into before)
      const live = ((this._live ||= {})[id] = new Map())
      let r, a
      try {
        ;[r, a] = await Promise.all([api(`/team/threads/${id}/messages`), api(`/team/threads/${id}/suggestions`).catch(() => null)])
      } finally { if (this._live[id] === live) delete this._live[id] }
      this.msgs[id] = merged(r.messages, [...live.values()])
      this.rxOff = r.thread?.reactions === false
      if (typeof r.thread?.reactions === 'boolean') this.rxKnown = true
      this.takeTr(r.messages)
      if (a) { this.suggestions[id] = a.suggestions; this.assistOn[id] = a.assist && a.enabled; this.sugTr(a.suggestions) }
      this.markRead(id)
    },
    // The open conversation once more from the server, merged by message id into what is shown — after something that
    // changed the room while a live push may have been missed (a meeting started or ended, its minutes are in: they come
    // a while after the end, 2026-11-24 「나갔다 들어와야 업데이트됨」). Nothing for a room that is not open.
    async catchUp(id) {
      if (!id || this.active !== id || !this.msgs[id]) return
      const r = await api(`/team/threads/${id}/messages`).catch(() => null)
      if (!r || this.active !== id) return
      const fresh = r.messages.filter((m) => !(this.msgs[id] || []).some((x) => x.id === m.id && JSON.stringify(x) === JSON.stringify(m)))
      if (!fresh.length) return
      this.msgs[id] = merged(this.msgs[id] || [], r.messages)
      this.takeTr(fresh)
      this.loadThreads()
    },
    // One read state: the room's (server pro_chat_reads). Opened, the room is read whole; upTo (a message's id — an item of 나에게 온 것
    // seen or opened) reads it up to that message only: the count comes back from the server, later messages stay unread.
    async markRead(id, { upTo = null, from = null } = {}) {
      if (!upTo) {
        // its notification on this device goes too (one per room: src/browserNotify.js clearRoom)
        clearRoom(id)
        const n = this.unread.byThread[id] || 0
        if (n) this.unread = { total: Math.max(0, this.unread.total - n), byThread: { ...this.unread.byThread, [id]: 0 } }
      }
      const r = await api(`/team/threads/${id}/read`, { method: 'POST', ...(upTo ? { body: { upTo, ...(from ? { from } : {}) } } : {}) }).catch(() => null)
      if (upTo) {
        // (only what the server read: no answer, or nothing read — nothing shown as read)
        if (r?.at) this.readUpTo(id, r.at)
        if (r?.rest === 0) clearRoom(id)
        this.refreshUnread()
        return r
      }
      this.readUpTo(id, null)
      const t = this.threads.find((x) => x.id === id)
      if (t) t.unread = 0
      return r
    },
    // the items of 나에게 온 것 of a room read up to a time (null: all of them)
    readUpTo(id, at) {
      const to = at ? new Date(at).getTime() : Infinity
      for (const x of this.forMe) if (x.threadId === id && x.unread && new Date(x.at).getTime() <= to) x.unread = false
    },
    // teammates into a group room I am in (POST /team/rooms/:id/invite): someone already there is left as is
    async invite(threadId, userIds) {
      const r = await api(`/team/rooms/${encodeURIComponent(threadId)}/invite`, { method: 'POST', body: { userIds } })
      const t = this.threads.find((x) => x.id === threadId)
      if (t && Array.isArray(r.members)) t.members = r.members
      await this.loadThreads()
      return r
    },
    // a group room's name (PUT /team/rooms/:id/name — any of its people; '' → called by its people again)
    async rename(threadId, name) {
      const r = await api(`/team/rooms/${encodeURIComponent(threadId)}/name`, { method: 'PUT', body: { name } })
      const t = this.threads.find((x) => x.id === threadId)
      if (t && r.name) t.title = r.name
      await this.loadThreads()
      return r
    },
    setReactions(threadId, messageId, reactions) {
      // (the same message where it shows: its room, and 나에게 온 것)
      for (const list of [this.msgs[threadId], this.forMe]) {
        const i = list ? list.findIndex((x) => x.id === messageId) : -1
        if (i >= 0) list[i] = { ...list[i], reactions: Array.isArray(reactions) ? reactions : [] }
      }
    },
    // One of my reactions on someone else's message, put on or taken off (POST /team/messages/:id/reactions): the chips change at once,
    // then become the server's — back as they were if it refused
    async react(m, key) {
      if (this.rxOff) return null
      const was = (this.msgs[m.threadId] || []).find((x) => x.id === m.id)?.reactions || this.forMe.find((x) => x.id === m.id)?.reactions || []
      const on = !was.find((c) => c.key === key)?.mine
      const meId = useApp().me?.user?.id
      const me = { id: meId, name: this.threads.find((t) => t.id === m.threadId)?.members?.find((p) => p.id === meId)?.name || '' }
      this.setReactions(m.threadId, m.id, toggled(was, key, me, on))
      try {
        const r = await api(`/team/messages/${encodeURIComponent(m.id)}/reactions`, { method: 'POST', body: { key, on } })
        this.setReactions(m.threadId, m.id, r.reactions)
        return r
      } catch (e) {
        this.setReactions(m.threadId, m.id, was)
        // (the database has none yet: no more are offered — sql/062. Only the server's own word for it: a 503 from a proxy during a
        // rollout is not that)
        if (e.code === 'reactions_off') this.rxOff = true
        throw e
      }
    },
    async startThread(members, title) {
      const t = await api('/team/threads', { method: 'POST', body: { members, title } })
      await this.loadThreads()
      await this.openThread(t.id)
      return t
    },
    // extra: {refs (file mentions — links to shared folders' files), ai (addressed to the AI), mentions (people named with @)}
    async send(threadId, text, artifactIds = [], extra = {}) {
      const m = await api(`/team/threads/${threadId}/messages`, { method: 'POST', body: { text, artifactIds, ...extra } })
      const list = (this.msgs[threadId] ||= [])
      if (!list.some((x) => x.id === m.id)) list.push(m)
      return m
    },

    // A shared artifact opens in the office panel: my own copy (or, for the sender, the original card). The floating sheet
    // goes away once it opened (it lies over the panel); a docked messenger stays beside it. Answers what happened
    // ({how, opened, reason, url} — artifacts.js openArtifact): the messenger says why when it did not open.
    // edit: the person asked to edit it (the viewer's 「PhotoCraft 로 편집」): a picture · sound · video opens in its ArtCraft app
    async openShared(shareId, router, { edit = false } = {}) {
      const app = useApp()
      const { message } = await api(`/team/shares/${shareId}/open`, { method: 'POST' })
      const list = (app.messages[message.thread_id] ||= [])
      if (!list.some((x) => x.id === message.id)) list.push(message)
      // (the server recorded my open just now: counted)
      const r = await openArtifact(app, router, message, { link: false, edit, counted: true })
      if (r.opened && closesMessenger(r, this.dockNow)) this.open = false
      return { message, ...r }
    },
    // ---- file mentions (server lib/fileRefs.js) ----
    // dropped files → what each becomes here: {ok, as: 'link'|'share', name, ref | cardId} or {ok: false, error}
    async resolveItems(items) { return (await api('/files/resolve', { method: 'POST', body: { items } })).items },
    // A mention opens where the file is: a document in the office panel (an editor of the folder edits the newest version in place),
    // anything else in its folder at that file. latest: the folder's newest version instead of the one mentioned.
    async openRef(m, i, router, { latest = false } = {}) {
      const r = await api('/team/refs/open', { method: 'POST', body: { messageId: m.id, index: i, latest } })
      const app = useApp()
      if (r.message) {
        const res = await openArtifact(app, router, r.message, { link: false })
        if (res.opened) { if (closesMessenger(res, this.dockNow)) this.open = false; return res }
        if (res.how !== 'link') return res
      }
      if (router) await router.push({ path: `/folders/${encodeURIComponent(r.slug)}`, query: { file: r.path, ...(r.ref && r.ref !== 'main' ? { ref: r.ref } : {}) } })
      if (this.dockNow === 'float') this.open = false
      return { how: 'folder', opened: true }
    },
    // ---- mail mentions (server lib/mailMention.js) ----
    // 「본문 보기」: my own mail → its sheet; one whose body its owner shared with the room → the mail, read only ({mail}); else 403
    async openMailRef(m, i) {
      const r = await api('/team/refs/open', { method: 'POST', body: { messageId: m.id, index: i } })
      if (r.mine) { await useApp().openMailCard({ actionId: r.actionId }, 'chat'); if (this.dockNow === 'float') this.open = false }
      return r
    },
    // 「열기」 on a mail's attachment mentioned here (server lib/mailAttachments.js): my own — opened as from the mail sheet; one its owner
    // shared with this room — read only (the editor, the viewer, or a 「내려받기」 address); else 403 with why → {how, opened, url?}
    async openMailAttRef(m, i) {
      const app = useApp()
      const r = await api('/team/refs/open', { method: 'POST', body: { messageId: m.id, index: i } })
      const res = r.mine ? await openMailAttachment(app, { actionId: r.actionId, i: r.i, name: r.name }) : await carryOut(app, r.plan)
      if (res.opened && res.how === 'office' && this.dockNow === 'float') this.open = false
      return res
    },
    // 「본문 공유」 · 「공유 그만두기」 (the owner): every member's card changes (the message comes back as each one sees it)
    async shareMailRef(m, i, on) {
      const x = await api('/team/refs/share', { method: 'POST', body: { messageId: m.id, index: i, on } })
      for (const list of [this.msgs[m.threadId], this.forMe]) {
        const k = (list || []).findIndex((y) => y.id === m.id)
        if (k >= 0 && x) list[k] = { ...list[k], refs: x.refs }
      }
      return x
    },
    // 권한 요청: the folder's owners are told; the card says it was asked
    async requestRef(m, i) {
      const r = await api('/team/refs/request', { method: 'POST', body: { messageId: m.id, index: i } })
      for (const list of [this.msgs[m.threadId], this.forMe]) {
        const x = (list || []).find((y) => y.id === m.id)
        if (x?.refs?.[i] && r.requested) x.refs[i] = { ...x.refs[i], state: { ...(x.refs[i].state || {}), requested: true, card: 'requested' } }
      }
      return r
    },
    // a received share continues in its own work conversation; my own share gathers the branches first
    // (choices: conflict picks, {path: side}; a 409 carries the conflicts to pick from)
    async continueWork(messageId, router, choices) {
      const r = await api(`/team/messages/${messageId}/continue`, { method: 'POST', body: { choices } })
      if (this.dockNow === 'float') this.open = false
      const app = useApp()
      app.dockOpen = false
      if (r.branch) { await app.loadProjects(); if (router) await router.push(`/projects/${r.threadId}`) }
      else if (router) await router.push('/chat')
      return r
    },
    // my share messages in a room (ids): for each person they went to, opened or not and what their copy changed — in parts of
    // 100, the most recent first (src/shareReceipts.js); only what the server looked at is kept
    async loadReceipts(threadId, ids) {
      if (!threadId) return
      for (const part of receiptChunks(ids)) {
        const r = await api(`/team/threads/${encodeURIComponent(threadId)}/receipts?ids=${part.map(encodeURIComponent).join(',')}`)
        this.receipts = mergeReceipts(this.receipts, r)
      }
    },
    // a file of a branch, read-only unless the branch is mine — in the panel like any document (same answer as openShared);
    // a picture · sound · video in the viewer (read-only there: no 「편집」)
    async openBranchFile(room, path) {
      const f = await api(`/team/branches/file?room=${encodeURIComponent(room)}&path=${encodeURIComponent(path)}`)
      const plan = openPlan({ url: f.url, name: f.name }, { craftMissing })
      if (plan.how === 'view') return { ...plan, opened: viewMedia(useApp(), { kind: plan.media, url: f.url, name: f.name }) }
      if (plan.how !== 'office') return { ...plan, opened: false, reason: plan.reason || '앱 안에서 열 수 없는 파일이에요.' }
      const opened = (await useApp().setOfficeDoc({ url: f.url, name: f.name, readOnly: f.readOnly })) !== false
      if (opened && closesMessenger(plan, this.dockNow)) this.open = false
      return { ...plan, opened, reason: opened ? '' : '열린 문서를 아직 저장하지 못해 그대로 두었어요. 한 번 더 누르면 바꿔요.' }
    },

    startShare(messages) {
      const list = messages.filter(shareable)
      if (!list.length) return this.say('이 파일은 아직 공유할 수 없어요(작업실 파일).')
      this.sharing = { messageIds: list.map((m) => m.id), names: list.map((m) => m.content.name) }
    },
    async share(to, note, choices) {
      const s = this.sharing
      const r = await api('/team/share', { method: 'POST', body: { to, messageIds: s.messageIds, note, choices } })
      this.sharing = null
      this.say(`${r.sent.map((x) => x.to.name).join(', ')}님께 공유했어요`, r.sent[0] && { threadId: r.sent[0].threadId })
      this.loadThreads()
      return r
    },

    async suggest(mode = 'fast', ctx = {}) {
      const r = await api('/team/suggest', { method: 'POST', body: { mode, ...ctx } })
      if (mode === 'fast') this.people = { ...r, at: Date.now() }
      return r
    },
    mention(body) { return api('/team/mention', { method: 'POST', body }) },
    // team assist: 시작 runs it as me; 아니요 hides it for me only
    async startSuggestion(sg) {
      // a meeting's request goes through the meeting (its result joins the meeting's 자료 panel)
      const v = await api(sg.meetingId ? `/meetings/${sg.meetingId}/suggestions/${sg.id}/start` : `/team/suggestions/${sg.id}/start`, { method: 'POST' })
      this.onEvent({ type: 'team', data: { type: 'assist', threadId: sg.threadId, suggestion: v } })
    },
    async dismissSuggestion(sg) {
      const list = this.suggestions[sg.threadId] || []
      this.suggestions[sg.threadId] = list.filter((x) => x.id !== sg.id)
      await api(`/team/suggestions/${sg.id}/dismiss`, { method: 'POST' }).catch(() => {})
    },
    async toggleAssist(threadId) {
      const on = !this.assistOn[threadId]
      this.assistOn[threadId] = on
      await api(`/team/threads/${threadId}/assist`, { method: 'PUT', body: { on } })
    },
  },
})
