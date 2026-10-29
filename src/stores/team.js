// Team sharing and messenger (server/routes/team.js): the inbox, threads with teammates, the share
// picker and the people "@" suggests. Live updates arrive as 'team' events, re-broadcast on the
// window by api.js events(), so this store needs no stream of its own.
import { defineStore } from 'pinia'
import { api } from '../api.js'
import { useApp } from './app.js'
import { openArtifact } from '../artifacts.js'
import { maybeOther } from '../i18n/mainLangs.js'

// file cards that can be shared: the ones with a storage object behind them (not workroom-only files)
export const shareable = (m) => m?.kind === 'file' && /\/storage\/v1\/object\/public\//.test(m.content?.url || '')

export const useTeam = defineStore('team', {
  state: () => ({
    booted: false,
    open: false,              // messenger sheet
    tab: 'inbox',             // inbox | threads
    threads: [],
    inbox: [],
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
    // auto-translation (server/lib/team/roomTranslate.js): message id -> {body, from} | {lines: {i: text}} |
    // {minutes: {summary, decisions, actions}} | {same: true}; original: message id -> showing the original
    tr: {},
    original: {},
  }),
  actions: {
    async boot() {
      if (this.booted) return
      this.booted = true
      window.addEventListener('pgpt:event', (e) => this.onEvent(e.detail))
      await Promise.all([this.loadUnread(), this.loadThreads(), this.loadInbox()]).catch(() => {})
    },
    async loadUnread() { this.unread = await api('/team/unread').catch(() => this.unread) },
    async loadThreads() { this.threads = await api('/team/threads').catch(() => this.threads) },
    async loadInbox() { this.inbox = await api('/team/inbox').catch(() => this.inbox); this.takeTr(this.inbox) },

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
        const at = list ? list.findIndex((x) => x.id === m.id) : -1
        if (list && at >= 0) list[at] = m
        else if (list) list.push(m)
        if (this.needsTr(m, { live: true })) this.queueTr([m.id], String(m.kind).startsWith('meeting') ? 2500 : 150)
        const looking = this.open && this.active === data.threadId && document.visibilityState === 'visible'
        if (!m.mine) {
          if (looking) this.markRead(data.threadId)
          else {
            this.unread = { total: this.unread.total + 1, byThread: { ...this.unread.byThread, [data.threadId]: (this.unread.byThread[data.threadId] || 0) + 1 } }
            if (!this.open) this.say(`${m.sender.name}님: ${m.kind === 'share' ? `${m.artifacts[0]?.name || '산출물'} 공유` : m.body.slice(0, 40)}`, { threadId: data.threadId, messageId: m.id })
          }
          if (m.kind !== 'text') this.loadInbox()
        }
        this.loadThreads()
      } else if (data.type === 'read') this.loadUnread()
      else if (data.type === 'assist') {
        const list = (this.suggestions[data.threadId] ||= [])
        const i = list.findIndex((x) => x.id === data.suggestion.id)
        if (data.suggestion.hidden) { if (i >= 0) list.splice(i, 1) } else if (i >= 0) list[i] = data.suggestion
        else list.unshift(data.suggestion)
        if (!data.suggestion.hidden) this.sugTr([data.suggestion])
      } else if (data.type === 'assist-status') this.assistStatus[data.id] = data.text
      else if (data.type === 'assist-toggle') this.assistOn[data.threadId] = data.on
    },
    say(text, go) {
      clearTimeout(this._t)
      this.toast = { text, go }
      this._t = setTimeout(() => (this.toast = null), 6000)
    },

    async openMessenger(threadId, messageId) {
      this.open = true
      this.toast = null
      if (threadId) { this.tab = 'threads'; await this.openThread(threadId, messageId) }
      else this.loadInbox()
    },
    async openThread(id, messageId) {
      this.active = id
      this.focus = messageId || null
      const [r, a] = await Promise.all([api(`/team/threads/${id}/messages`), api(`/team/threads/${id}/suggestions`).catch(() => null)])
      this.msgs[id] = r.messages
      this.takeTr(r.messages)
      if (a) { this.suggestions[id] = a.suggestions; this.assistOn[id] = a.assist && a.enabled; this.sugTr(a.suggestions) }
      this.markRead(id)
    },
    async markRead(id) {
      const n = this.unread.byThread[id] || 0
      if (n) this.unread = { total: Math.max(0, this.unread.total - n), byThread: { ...this.unread.byThread, [id]: 0 } }
      await api(`/team/threads/${id}/read`, { method: 'POST' }).catch(() => {})
      for (const x of this.inbox) if (x.threadId === id) x.unread = false
      const t = this.threads.find((x) => x.id === id)
      if (t) t.unread = 0
    },
    async startThread(members, title) {
      const t = await api('/team/threads', { method: 'POST', body: { members, title } })
      await this.loadThreads()
      this.tab = 'threads'
      await this.openThread(t.id)
      return t
    },
    async send(threadId, text, artifactIds = []) {
      const m = await api(`/team/threads/${threadId}/messages`, { method: 'POST', body: { text, artifactIds } })
      const list = (this.msgs[threadId] ||= [])
      if (!list.some((x) => x.id === m.id)) list.push(m)
      return m
    },

    // a shared artifact opens in the editor: my own copy (or, for the sender, the original card)
    async openShared(shareId, router) {
      const app = useApp()
      const { message } = await api(`/team/shares/${shareId}/open`, { method: 'POST' })
      const list = (app.messages[message.thread_id] ||= [])
      if (!list.some((x) => x.id === message.id)) list.push(message)
      this.open = false
      openArtifact(app, router, message)
      return message
    },
    async continueWork(messageId, router) {
      const r = await api(`/team/messages/${messageId}/continue`, { method: 'POST' })
      this.open = false
      const app = useApp()
      app.dockOpen = false
      if (router) await router.push('/chat')
      return r
    },

    startShare(messages) {
      const list = messages.filter(shareable)
      if (!list.length) return this.say('이 파일은 아직 공유할 수 없어요(작업실 파일).')
      this.sharing = { messageIds: list.map((m) => m.id), names: list.map((m) => m.content.name) }
    },
    async share(to, note) {
      const s = this.sharing
      const r = await api('/team/share', { method: 'POST', body: { to, messageIds: s.messageIds, note } })
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
