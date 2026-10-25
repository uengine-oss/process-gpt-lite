import { defineStore } from 'pinia'
import { api, stream, events, auth, uploadAttachment } from '../api.js'

export const useApp = defineStore('app', {
  state: () => ({
    me: null,
    mainThread: null,
    projects: [],
    activeId: null,            // thread shown in the center column
    messages: {},              // threadId -> []
    drafts: {},                // threadId -> streaming text
    status: {},                // threadId -> live status text
    actions: [],
    panels: [],
    panelApps: [],             // data apps (lib/panelApps) of folders I belong to
    panelAppTick: {},          // appId -> bumps when its rows change (another member, the sheet editor)
    frames: {},                // taskId -> {data,url}
    dockOpen: true,
    mode: 'chat',              // chat | project
    panelMode: false,          // "새 패널 만들기" composer mode
    handoff: null,             // message id of a task shown full screen
    officeDoc: null,           // {msgId, url, name} open in the IeumOffice editor
    attachments: [],           // files waiting in the composer: {id, name, size, state, result, error}
    conversations: [],         // what the context router told apart in the main chat (context_threads)
    convFilter: null,          // conversation id the main chat is narrowed to (/chat/c/:cid)
    searchOpen: false,
    prefill: '',
    instances: [],
    todos: [],
    notifications: [],         // process-gpt notifications addressed to me (Home "needs action")
    handled: [],               // work items just decided from a card (the engine catches up a moment later)
    instance: null,
    missionTick: 0,             // bumps on mission run events so open lists refresh            // detail of the instance page               // text pushed into the composer from elsewhere
  }),
  getters: {
    active(s) { return s.activeId === s.mainThread?.id ? s.mainThread : s.projects.find((p) => p.id === s.activeId) },
    thread(s) {
      const all = s.messages[s.activeId] || []
      if (!s.convFilter || s.activeId !== s.mainThread?.id) return all
      const of = this.convOf
      return all.filter((m) => of[m.id] === s.convFilter)
    },
    // Which conversation each main-chat message belongs to. An answer carries the router's call
    // (context.conversationId, continue/new); the user's message and attachments just before it go
    // with it; a "stay" answer (or a chip, a card) stays in the conversation the chat was in.
    convOf(s) {
      const out = {}
      let cur = null
      let pending = []
      for (const m of s.messages[s.mainThread?.id] || []) {
        if (m.role === 'user') { pending.push(m); continue }
        const c = m.content?.context
        if (c?.conversationId && c.action !== 'stay') cur = c.conversationId
        for (const p of pending) out[p.id] = cur
        pending = []
        out[m.id] = cur
      }
      for (const p of pending) out[p.id] = cur
      return out
    },
    // conversation list: the router's titles and summaries, with message counts from the chat
    convList(s) {
      const counts = {}
      for (const id of Object.values(this.convOf)) if (id) counts[id] = (counts[id] || 0) + 1
      const known = new Set(s.conversations.map((c) => c.id))
      const rows = s.conversations.filter((c) => counts[c.id]).map((c) => ({ ...c, count: counts[c.id] }))
      // a conversation the chat knows about but the router has not recorded (yet)
      for (const m of s.messages[s.mainThread?.id] || []) {
        const c = m.content?.context
        if (c?.conversationId && !known.has(c.conversationId) && counts[c.conversationId]) {
          known.add(c.conversationId)
          rows.push({ id: c.conversationId, title: c.title, summary: '', updated_at: m.created_at, count: counts[c.conversationId] })
        }
      }
      return rows.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    },
  },
  actions: {
    async boot() {
      this.me = await api('/me')
      ;[this.mainThread] = await api('/threads')
      this.activeId = this.mainThread.id
      await Promise.all([this.load(this.mainThread.id), this.loadActions(), this.loadPanels(), this.loadPanelApps(), this.loadProjects(), this.loadProcesses(), this.loadNotifications(), this.loadConversations()])
      events((t, d) => this.onEvent(t, d))
    },
    async load(id) { this.messages[id] = await api(`/threads/${id}/messages`) },
    async loadActions() { this.actions = await api('/actions') },
    async loadPanels() { this.panels = await api('/panels') },
    async loadPanelApps() { this.panelApps = await api('/panel-apps').catch(() => this.panelApps) },
    async loadConversations() { this.conversations = await api('/conversations').catch(() => []) },
    async loadNotifications() { this.notifications = await api('/notifications') },
    async loadProcesses() {
      ;[this.instances, this.todos] = await Promise.all([api('/instances'), api('/todos')])
    },
    async openInstance(id) {
      this.instance = await api(`/instances/${encodeURIComponent(id)}`)
      this.activeId = this.instance.threadId
      if (!this.messages[this.activeId]) await this.load(this.activeId)
    },
    async refreshInstance() {
      if (!this.instance) return
      this.instance = { ...await api(`/instances/${encodeURIComponent(this.instance.inst.proc_inst_id)}`) }
    },
    openTodo(t) { return api(`/todos/${t.id}/open`, { method: 'POST' }) },
    async loadProjects() { this.projects = await api('/threads?kind=project') },

    onEvent(type, d) {
      if (type === 'message') {
        const list = (this.messages[d.thread_id] ||= [])
        const i = list.findIndex((m) => m.id === d.id)
        if (i >= 0) list[i] = d
        else {
          list.push(d)
          if (d.role === 'agent' && (d.kind === 'text' || d.kind === 'doc')) this.drafts[d.thread_id] = null
        }
      } else if (type === 'thread') {
        if (d.id === this.mainThread?.id) this.mainThread = d
        const i = this.projects.findIndex((p) => p.id === d.id)
        if (i >= 0) this.projects[i] = d
        else if (d.kind === 'project') this.projects.unshift(d)
        if (!d.status) this.status[d.id] = null
      } else if (type === 'action') {
        const i = this.actions.findIndex((a) => a.id === d.id)
        if (d.status === 'done' || d.status === 'dismissed') { if (i >= 0) this.actions.splice(i, 1) }
        else if (i >= 0) this.actions[i] = d
        else this.actions.unshift(d)
      } else if (type === 'panel') {
        const i = this.panels.findIndex((p) => p.id === d.id)
        if (i >= 0) this.panels[i] = d
        else this.panels.push(d)
      } else if (type === 'panel.deleted') {
        this.panels = this.panels.filter((p) => p.id !== d.id)
      } else if (type === 'panelapp') {
        const i = this.panelApps.findIndex((p) => p.id === d.id)
        if (i >= 0) this.panelApps[i] = { ...this.panelApps[i], ...d }
        else this.panelApps.push(d)
      } else if (type === 'panelapp.rows') {
        this.panelAppTick[d.id] = (this.panelAppTick[d.id] || 0) + 1
      } else if (type === 'panelapp.deleted') {
        this.panelApps = this.panelApps.filter((p) => p.id !== d.id)
      } else if (type === 'panelapp.changed') {
        this.loadPanelApps()
      } else if (type === 'notifications') {
        this.loadNotifications()
      } else if (type === 'mission') {
        this.missionTick++
      } else if (type === 'process') {
        this.loadProcesses()
        if (this.instance && d.instId === this.instance.inst.proc_inst_id) this.refreshInstance()
      } else if (type === 'status') {
        this.status[d.threadId] = d.text
      } else if (type === 'browser.frame') {
        this.frames[d.taskId] = d
      }
    },

    // composer attachments: upload starts at once, so sending only waits for what is still going
    addAttachments(list) {
      for (const file of [...list].slice(0, 10)) {
        const a = { id: crypto.randomUUID(), name: file.name, size: file.size, state: 'uploading', result: null, error: '' }
        this.attachments.push(a)
        a.job = uploadAttachment(file)
          .then((r) => { const x = this.attachments.find((y) => y.id === a.id); if (x) { x.state = 'ready'; x.result = r } })
          .catch((e) => { const x = this.attachments.find((y) => y.id === a.id); if (x) { x.state = 'error'; x.error = e.message } })
      }
    },
    removeAttachment(id) { this.attachments = this.attachments.filter((a) => a.id !== id) },
    async send(text, threadId = this.activeId, context) {
      const pending = this.attachments
      this.attachments = []
      await Promise.all(pending.map((a) => a.job))
      const files = pending.filter((a) => a.result).map((a) => a.result)
      // asked from inside one conversation's view: it continues that conversation
      const conv = this.convFilter && threadId === this.mainThread?.id ? this.convList.find((c) => c.id === this.convFilter) : null
      const conversation = conv ? { id: conv.id, title: conv.title } : this.convFilter && threadId === this.mainThread?.id ? { id: this.convFilter } : undefined
      this.drafts[threadId] = ''
      let ended = false
      try {
        await stream(`/threads/${threadId}/messages`, { text, context, files, conversation }, (ev, data) => {
          if (ev === 'delta' && this.drafts[threadId] != null) this.drafts[threadId] += data.d
          if (ev === 'done' || ev === 'error') { ended = true; this.drafts[threadId] = null }
        })
      } catch (e) { console.warn('[send]', e.message) }
      // the connection dropped before the answer (a proxy cutting a long request, a server restart):
      // stop showing "생각하는 중"; the answer, if it comes, arrives as a live event
      if (!ended) { this.drafts[threadId] = null; this.load(threadId).catch(() => {}) }
      if (threadId === this.mainThread?.id) this.loadConversations()
    },
    async newProject(text) {
      const t = await api('/threads', { method: 'POST', body: { text } })
      this.messages[t.id] = []
      this.activeId = t.id
      this.send(text, t.id)
    },
    async open(id) {
      this.activeId = id
      if (!this.messages[id]) await this.load(id)
    },
    // a card button: the step's choice is submitted right there (or, with no choice, opened in chat)
    async actNotification(n, choice) {
      this.notifications = this.notifications.filter((x) => x.id !== n.id || !choice)
      if (choice && n.todoId) this.handled.push(n.todoId)
      const r = await api(`/notifications/${n.id}/act`, { method: 'POST', body: { choice } })
      await Promise.all([this.loadNotifications(), this.loadProcesses()])
      if (r?.thread) await this.open(r.thread)
      return r
    },
    async dismissNotification(n) {
      this.notifications = this.notifications.filter((x) => x.id !== n.id)
      await api(`/notifications/${n.id}/dismiss`, { method: 'POST' })
    },
    runAction(a) { return api(`/actions/${a.id}/run`, { method: 'POST' }) },
    dismissAction(a) { return api(`/actions/${a.id}/dismiss`, { method: 'POST' }) },
    async createPanel(description) {
      this.panelMode = false
      await this.send(`새 패널 만들기: ${description}`, this.mainThread.id)
    },
    logout() { auth.clear(); location.href = '/login' },
  },
})
