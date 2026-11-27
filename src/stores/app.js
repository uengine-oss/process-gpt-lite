import { defineStore } from 'pinia'
import { runner as localRunner, startDesktopRunner, disconnectThis } from '../localRunner.js'
import { api, stream, events, auth, uploadAttachment } from '../api.js'
import { newId, retryable, backoff, why, retryWindow, loadUnsent, saveUnsent, forgetAllUnsent, ATTEMPT_MS } from '../sendQueue.js'
import { BASE } from '../base.js'
import { forgetPlaces } from '../shareTarget.js'
import { syncLang, isEnglish } from '../i18n/lang.js'
import { officeEditorFor, CRAFT_APPS } from '../officeEditor.js'
import { announce } from '../browserNotify.js'
import { keyOf as chatKeyOf } from '../chatAgent.js'
import { readListOpen, saveListOpen } from '../threadList.js'
import { artifactScope, artifactItems, readFolded, saveFolded } from '../artifactScope.js'
import { topicOf, topicList } from '../projectTopics.js'
import { applyTurnEvent, fromSnapshot } from '../turnState.js'
import { docSelectionOf, docSelectionKey, selectionMention, mentionContext, docConversation } from '../docSelection.js'
import { convOf as convsOf, convRows, asideOf } from '../convOf.js'

// the room 새 프로젝트 is making (newProject): resolves to its id, or null
let draftJob = Promise.resolve(null)
// messages not taken yet (src/sendQueue.js): the attempt under way (id → its AbortController), the rooms whose queue is being worked,
// and the composer's attachment chips each one took (id → chips — given back as they were)
const inFlight = new Map()
const working = new Set()
const tookChips = new Map()
// words taken back from a line (그만두기 · 입력창에 넣기): sent again unchanged — in the same conversation, within ten minutes — they keep their
// name: the server may have the first one already (it was on its way when it was taken back) and takes a name once. Later, the same
// words ("네", "계속") are a new message. (conversation key + words → {id, at})
const takenBack = new Map()
const TAKEN_BACK_MS = 10 * 60_000
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

// turns this page saw end (turnId → when): a snapshot or a late event does not bring their cards back (src/turnState.js)
const endedTurns = new Map()

// a routed turn that came as a live event (another device, an answer after a dropped connection): the list's titles and summaries
// again, once things settle (the router writes its row as the turn ends)
let convReload = null
// the same for a project's sub-topics (src/projectTopics.js): threadId → timer
const topicReload = {}

// the open document's sheet answers here before the document is replaced or closed (setOfficeDoc)
let officeLeave = null
export function onOfficeLeave(fn) { officeLeave = fn }
// a chat file card → the document to open: a shared folder's file (folder_open) carries its folder —
// an editor of the folder edits it in place (saved into the folder), anyone else sees it read-only
export function officeDocOf(msgId, c) {
  const folder = c?.folder?.slug ? c.folder : null
  // private: a card with no address of its own (a mail's attachment — server lib/mailAttachments.js): it was opened by a short-lived signed
  // one, and an editor's save never puts an address on it
  // branch: a received share's file — its saves are commits on that conversation's branch (no 「다른 이름으로 저장」 there, OfficeSheet)
  return { msgId, url: c.url, name: c.name, ...(folder ? { folder, readOnly: folder.editable !== true } : {}), ...(c?.private ? { private: true } : {}), ...(c?.branch ? { branch: true } : {}) }
}

// an attachment's upload, to stop it (not in the store's state: an AbortController is no data to watch)
const abortOf = new Map()

export const useApp = defineStore('app', {
  state: () => ({
    me: null,
    mainThread: null,
    projects: [],
    activeId: null,            // thread shown in the center column
    messages: {},              // threadId -> []
    drafts: {},                // threadId -> streaming text
    // messages the server has not taken yet (src/sendQueue.js): [{id, threadId, key, conv, text, context, files, refs, openDoc, agent, fresh,
    // at, state: 'waiting' | 'retrying' | 'failed', tries, error}] — asked again while the server is away, kept for the person otherwise,
    // in this browser too; the composer shows the ones of its room (Composer.vue)
    unsent: [],
    askedAt: {},               // threadId -> when this screen last sent a message there (a file the agent opens on request opens here)
    status: {},                // threadId -> live status text
    // threadId -> {turnId -> the turn as it runs}: plan, stage, to-dos, steps, notes (server lib/turnPlan.js; TurnPlanCard · TurnProgress)
    turns: {},
    turnPanel: null,           // the turn whose progress panel is open (its id), or null
    planOpen: null,            // the project whose plan sheet is open (its thread id — ProjectNote.vue, a change chip's 「계획 보기」), or null
    planTick: {},              // threadId -> bumps when the project's plan changed (server event projectNote)
    actions: [],
    mailCard: null,            // a mail's Home card, opened: the mail as it arrived and the reply (MailReplySheet)
    mailCardFrom: null,        // where that sheet was opened: home | chat | instance | inbox (the sheet's 「Home 카드로」 is for the others)
    // the newest row of every mail card this page heard of ('action' events) — a card no longer on Home (done) still updates its sheet
    // (a follow-up action that finished: lib/mailFollow.js)
    cardRows: {},
    flashCard: null,           // a Home card to bring into view and light up once (the mail sheet's 「Home 카드로」)
    panels: [],
    panelApps: [],             // data apps (lib/panelApps) of folders I belong to
    panelAppTick: {},          // appId -> bumps when its rows change (another member, the sheet editor)
    frames: {},                // taskId -> {data,url}
    clicks: {},                // taskId -> {x,y,w,h,kind,n}: where the browser agent is about to click (the live screen's ripple)
    takeover: null,            // task id whose full view opens with 직접 제어 already on (직접 로그인)
    draftProject: null,        // 새 프로젝트 sent, its room still being made: {tmp, id} — the chat shows the message meanwhile
    notice: null,              // a short line over the composer: {text} (새 프로젝트 could not be made, the text is back in the box)
    // Home's dock (the left column on a wide screen, the 홈 tab on a phone) — closed at start when the chat's thread list was left open
    dockOpen: !readListOpen(),
    // the chat's thread list (components/ThreadList.vue): the left column in place of Home on a wide screen, a sheet on a phone; opened
    // by double-clicking 「채팅」 (TopBar), remembered in this browser (src/threadList.js)
    threadList: readListOpen(),
    // the files list in the right column folded to its rail of icons (components/ArtifactList.vue), remembered in this browser
    artifactsFolded: readFolded(),
    mode: 'chat',              // chat | project | routine (a process instance: /routines)
    panelMode: false,          // "새 패널 만들기" composer mode
    handoff: null,             // message id of a task shown full screen
    officeDoc: null,           // {msgId, url, name} open in the IeumOffice editor
    media: null,               // {kind, url, name, editWith, edit} a picture · sound · video in the viewer (MediaViewer.vue, artifacts.js viewMedia)
    docSide: false,            // that document is open beside the page, not over it (OfficeSheet) — the messenger's panel dock joins it
    // files of the app dragged onto the composer (src/fileDrag.js — a shared folder's file, an artifact, a file a teammate sent): the
    // next message is about them, the agent reads each with my access (server lib/fileRefs.js turnRefs): {key, item, name, folder, as, wait, error}
    fileRefs: [],
    attachments: [],           // files waiting in the composer: {id, name, size, state, result, error}
    newProjectFolder: null,    // 새 프로젝트: the folder it will work in — {id, slug, name} or {newName}
    folderPicker: false,       // the composer's folder list is open (📎 폴더 붙이기, 새 프로젝트's chip)
    conversations: [],         // what the context router told apart in the main chat (context_threads)
    convFilter: null,          // conversation id the main chat is narrowed to (/chat/c/:cid)
    topics: {},                // projectId -> its sub-topics as the server lists them (GET /threads/:id/topics — server lib/projectTopics.js)
    topicFilter: null,         // the sub-topic a project's view is narrowed to (/projects/:id/t/:tid)
    searchOpen: false,
    prefill: '',
    focusTick: 0,              // bumps: the chat composer takes the focus (an open document's AI 도우미 button)
    mentions: [],              // objects pointed at in an open document (@표 2, @이미지 1, @B3:D6) for the next message
    docSel: null,              // what is selected in the open document right now (OfficeEditorFrame 'selection', src/docSelection.js)
    docSelOff: '',             // …a selection put away (its chip's ✕, or sent): no chip again until the selection changes
    beforeSend: null,          // (text, mentions) => true when it took the message (OfficeSheet: an image goes to PhotoCraft)
    instances: [],
    todos: [],
    notifications: [],         // process-gpt notifications addressed to me (Home "needs action")
    handled: [],               // work items just decided from a card (the engine catches up a moment later)
    instance: null,
    localActive: {},           // instId → the card of its local CLI agent run that is on now (Home cards — server lib/localAgents)
    nextAgent: null,           // the composer's agent for the message it is sending now: {key, agent} (ComposerAgent · src/chatAgent.js)
    missionTick: 0,             // bumps on mission run events so open lists refresh            // detail of the instance page               // text pushed into the composer from elsewhere
  }),
  getters: {
    // the open document's selection, as the composer's chip and the next message's mention (src/docSelection.js)
    docSelChip(s) { return s.docSel && docSelectionKey(s.docSel) !== s.docSelOff ? selectionMention(s.docSel) : null },
    // the thread list on screen: the chat's page, not replaced by Home's dock. Beside a document open beside the page it follows the
    // left column's rule like the project and routine lists — beside the chat where the page holds all three, else folded to a rail
    // (src/leftColumn.js, views/MainView.vue)
    threadListShown(s) { return s.mode === 'chat' && s.threadList && !s.dockOpen },
    active(s) { return s.activeId === s.mainThread?.id ? s.mainThread : s.projects.find((p) => p.id === s.activeId) },
    thread(s) {
      const all = s.messages[s.activeId] || []
      // one sub-topic of the project on screen (src/projectTopics.js)
      if (s.topicFilter && s.mode === 'project' && this.projectOpen) {
        const of = this.topicOf
        return all.filter((m) => of[m.id] === s.topicFilter)
      }
      if (!s.convFilter || s.activeId !== s.mainThread?.id) return all
      const of = this.convOf
      return all.filter((m) => of[m.id] === s.convFilter)
    },
    // the view on screen is a project's (not a draft being made, not the main chat)
    projectOpen(s) { return !!s.activeId && s.projects.some((p) => p.id === s.activeId) },
    // the turns running in the view on screen, oldest first (server lib/turnPlan.js): in one conversation's (or sub-topic's) view only
    // that one's — by the message it answers, or the conversation it went to (design turnplan §3.3)
    viewTurns(s) {
      const all = Object.values(s.turns[s.activeId] || {})
      if (!all.length) return []
      const narrowed = s.convFilter || (s.topicFilter && s.mode === 'project' ? s.topicFilter : null)
      const shown = narrowed ? new Set(this.thread.map((m) => m.id)) : null
      return all.filter((t) => !narrowed || shown.has(t.msgId) || t.conversationId === narrowed).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
    },
    // which sub-topic each message of the project on screen belongs to, and its sub-topics with message counts (src/projectTopics.js)
    topicOf(s) { return this.projectOpen ? topicOf(s.messages[s.activeId] || []) : {} },
    topicList(s) { return this.projectOpen ? topicList(s.topics[s.activeId] || [], s.messages[s.activeId] || [], this.topicOf) : [] },
    // Which conversation each main-chat message belongs to (src/convOf.js): the router's call on an answer, and what arrives without
    // the person typing it — a scheduled run, a brief — in its own conversation, aside from the one the chat is in
    convOf(s) { return convsOf(s.messages[s.mainThread?.id] || [], { briefId: s.conversations.find((c) => c.kind === 'brief')?.id }) },
    // The files the view on screen made (src/artifactScope.js): the whole chat, one conversation of it, or a project's room — newest
    // first, each with the conversation it came from (the right column's list and the pile both show these)
    artifacts(s) {
      const scope = artifactScope({ mode: s.mode, activeId: s.activeId, mainId: s.mainThread?.id, convFilter: s.convFilter, topicFilter: s.topicFilter, projectIds: s.projects.map((p) => p.id) })
      if (!scope) return { scope, items: [] }
      // one sub-topic of a project: its files only
      if (scope === 'topic') {
        const titles = Object.fromEntries(this.topicList.map((c) => [c.id, c.title]))
        return { scope, items: artifactItems({ scope, messages: s.messages[s.activeId] || [], convOf: this.topicOf, convFilter: s.topicFilter, titles }) }
      }
      const main = scope !== 'project'
      const titles = main ? Object.fromEntries(this.convList.map((c) => [c.id, c.title])) : {}
      return { scope, items: artifactItems({ scope, messages: s.messages[s.activeId] || [], convOf: main ? this.convOf : {}, convFilter: s.convFilter, titles }) }
    },
    // conversation list: the server's titles and summaries (and kinds — a scheduled task's, the briefs'), with message counts from the chat
    convList(s) { return convRows(s.conversations, s.messages[s.mainThread?.id] || [], this.convOf) },
  },
  actions: {
    // Replacing or closing the open document: the sheet saves what is left in it first (OfficeSheet
    // registers onOfficeLeave; it answers false to stay open — a save that did not finish, said on the sheet).
    async setOfficeDoc(doc) {
      if (this.officeDoc && officeLeave) {
        const ok = await Promise.resolve(officeLeave()).catch(() => true)
        if (!ok) return false
      }
      this.officeDoc = doc
      return true
    },
    async boot() {
      this.me = await api('/me')
      syncLang(this.me)
      // messages a reload or a sign-in left before the server took them: kept, and asked again where they were being
      this.unsent = loadUnsent(this.me?.user?.id).map((u) => (u.state === 'sending' ? { ...u, state: 'retrying', tries: Math.max(1, u.tries || 0) } : u))
      for (const t of new Set(this.unsent.filter((u) => u.state !== 'failed').map((u) => u.threadId))) this.runUnsent(t)
      // in the desktop app: this computer's CLI agents run this person's local steps (src/localRunner.js)
      startDesktopRunner(this.me).catch(() => {})
      ;[this.mainThread] = await api('/threads')
      this.activeId = this.mainThread.id
      await Promise.all([this.load(this.mainThread.id), this.loadActions(), this.loadPanels(), this.loadPanelApps(), this.loadProjects(), this.loadProcesses(), this.loadNotifications(), this.loadConversations(), this.loadLocalActive()])
      events((t, d) => this.onEvent(t, d))
    },
    async load(id) {
      this.messages[id] = await api(`/threads/${id}/messages`)
      // a turn still running (the page opened or reloaded mid-turn): its card and panel come back as they are
      this.loadTurns(id)
    },
    async loadTurns(id) {
      const r = await api(`/threads/${id}/turn`).catch(() => null)
      if (!r || !Array.isArray(r.turns)) return
      // (a turn that ended while the snapshot was on the way stays ended: src/turnState.js)
      this.turns = { ...this.turns, [id]: fromSnapshot(r, endedTurns) }
      if (this.turnPanel && !Object.values(this.turns[id]).some((t) => t.turnId === this.turnPanel) && endedTurns.has(this.turnPanel)) this.turnPanel = null
    },
    // the turn.* events (server lib/turnPlan.js) → this.turns
    onTurn(type, d) {
      if (!d?.threadId || !d.turnId) return
      const all = this.turns[d.threadId] || {}
      const next = applyTurnEvent(all, type, d, endedTurns)
      if (next !== all) this.turns = { ...this.turns, [d.threadId]: next }
      if (type === 'turn.end' && this.turnPanel === d.turnId) this.turnPanel = null
    },
    // the local CLI agent runs on now (Home cards) and one run's newest card (a push, or what a steer answered)
    async loadLocalActive() {
      const rows = await api('/local-agents/active').catch(() => null)
      if (rows) this.localActive = Object.fromEntries(rows.map((c) => [c.instId, c]))
    },
    patchLocalRun(card) {
      const on = ['queued', 'offered', 'running'].includes(card.state)
      if (on) this.localActive = { ...this.localActive, [card.instId]: card }
      else if (this.localActive[card.instId]?.jobId === card.jobId) { const { [card.instId]: _gone, ...rest } = this.localActive; this.localActive = rest }
      if (this.instance && card.instId === this.instance.inst.proc_inst_id) {
        const runs = [...(this.instance.localRuns || [])]
        const i = runs.findIndex((x) => x.jobId === card.jobId)
        if (i >= 0) runs[i] = card
        else runs.unshift(card)
        this.instance = { ...this.instance, localRuns: runs }
      }
    },
    async loadActions() { this.actions = await api('/actions') },
    async loadPanels() { this.panels = await api('/panels') },
    async loadPanelApps() { this.panelApps = await api('/panel-apps').catch(() => this.panelApps) },
    async loadConversations() { this.conversations = await api('/conversations').catch(() => []) },
    // a project's sub-topics (server lib/projectTopics.js) — kept as they were when the server does not answer
    async loadTopics(id) {
      if (!id) return
      const r = await api(`/threads/${id}/topics`).catch(() => null)
      if (r) this.topics = { ...this.topics, [id]: Array.isArray(r.topics) ? r.topics : [] }
    },
    foldArtifacts(folded) {
      this.artifactsFolded = !!folded
      saveFolded(this.artifactsFolded)
    },
    // the chat's thread list open or closed (remembered in this browser); opening it puts Home's dock away — the two share the left
    // column — and fetches the list again so it shows what the router recorded last
    setThreadList(open) {
      this.threadList = !!open
      saveListOpen(this.threadList)
      if (this.threadList) {
        this.dockOpen = false
        this.loadConversations()
      }
    },
    async loadNotifications() {
      this.notifications = await api('/notifications')
      // a background tab gets them as browser notifications (src/browserNotify.js); a click opens them (MainView)
      announce(this.notifications, (n) => window.dispatchEvent(new CustomEvent('pgl:open-notification', { detail: n })))
    },
    async loadProcesses() {
      ;[this.instances, this.todos] = await Promise.all([api('/instances'), api('/todos')])
    },
    // current(): still on this instance's page once the answer comes (the person may have closed it)
    async openInstance(id, current = () => true) {
      const inst = await api(`/instances/${encodeURIComponent(id)}`)
      if (!current()) return null
      if (!this.messages[inst.threadId]) await this.load(inst.threadId)
      if (!current()) return null
      this.instance = inst
      this.activeId = inst.threadId
      return inst
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
        // the server's copy of a message shown before it was saved (새 프로젝트) takes its place
        const mine = i < 0 && d.role === 'user' && d.kind === 'text' ? list.findIndex((m) => m.content?.local) : -1
        if (i >= 0) list[i] = d
        else if (mine >= 0) list[mine] = d
        else {
          list.push(d)
          if (d.role === 'agent' && (d.kind === 'text' || d.kind === 'doc') && !asideOf(d) && !d.content?.silent) this.drafts[d.thread_id] = null
          // a turn of the main chat the router placed: the conversation list follows (its row is written as the turn ends)
          if (d.role === 'agent' && d.thread_id === this.mainThread?.id && d.content?.context?.conversationId) {
            clearTimeout(convReload)
            convReload = setTimeout(() => this.loadConversations(), 2500)
          }
          // a project's turn answered in one of its sub-topics: the project's list follows the same way
          if (d.role === 'agent' && d.content?.conv && this.projects.some((p) => p.id === d.thread_id)) {
            clearTimeout(topicReload[d.thread_id])
            topicReload[d.thread_id] = setTimeout(() => this.loadTopics(d.thread_id), 2500)
          }
          // a document the person asked to see (folder_open: "장진영 이력서 열어 줘") opens in the editor at
          // once — on the screen that asked (not their other devices), in the conversation on screen, as the
          // answer to that message (askedAt lasts until shortly after its answer ends), once
          if (d.role === 'agent' && d.kind === 'file' && d.content?.open && d.content.url && d.thread_id === this.activeId && this.askedAt[d.thread_id]) {
            const ed = officeEditorFor(d.content.name || d.content.url)
            if (ed && !CRAFT_APPS.has(ed)) { this.setOfficeDoc(officeDocOf(d.id, d.content)); delete this.askedAt[d.thread_id] }
          }
        }
      } else if (type === 'projectNote') {
        this.planTick = { ...this.planTick, [d.threadId]: (this.planTick[d.threadId] || 0) + 1 }
      } else if (type === 'thread') {
        // (merged: a status-only event carries no folder, the thread keeps the one it has)
        if (d.id === this.mainThread?.id) this.mainThread = { ...this.mainThread, ...d }
        const i = this.projects.findIndex((p) => p.id === d.id)
        if (i >= 0) this.projects[i] = { ...this.projects[i], ...d }
        else if (d.kind === 'project') this.projects.unshift(d)
        if (!d.status) this.status[d.id] = null
      } else if (type === 'action') {
        if (d?.id && d.source?.mail_id) this.cardRows = { ...this.cardRows, [d.id]: d }
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
      } else if (type === 'local_run') {
        // a step runs on someone's desktop: its card follows wherever it is shown (LocalRunCard — the instance page, Home), no reload
        // (a chat message's run follows in its chat's message — not a Home card)
        if (d.card && !d.card.chat) this.patchLocalRun(d.card)
      } else if (type === 'local_presence') {
        // my PC app came on, went off or found its CLIs: the composer's agent picker looks again (ComposerAgent)
        window.dispatchEvent(new CustomEvent('pgl:local-presence', { detail: d }))
      } else if (type.startsWith('turn.')) {
        this.onTurn(type, d)
      } else if (type === 'reconnect') {
        // the live events were cut and came back (src/api.js): what ran meanwhile — a turn that ended unseen — is read again
        for (const id of new Set([...Object.keys(this.turns), this.activeId].filter(Boolean))) this.loadTurns(id)
      } else if (type === 'status') {
        this.status[d.threadId] = d.text
      } else if (type === 'browser.frame') {
        this.frames[d.taskId] = d
      } else if (type === 'browser.click') {
        // hark: a ring where the agent is about to click, drawn on every view of its live screen (TaskCard, BrowserDock)
        this.clicks[d.taskId] = { ...d, n: (this.clicks[d.taskId]?.n || 0) + 1 }
      }
    },

    // composer attachments: upload starts at once, so sending only waits for what is still going
    // extra: marks on each (share: the id of a share from another app — components/ShareArrival.vue takes those back for 「다른 곳에」)
    addAttachments(list, extra = {}) {
      for (const file of [...list].slice(0, 10)) {
        const a = { id: crypto.randomUUID(), name: file.name, size: file.size, state: 'uploading', result: null, error: '', ...extra }
        this.attachments.push(a)
        // (taken away before it is up — its ×, or a share put somewhere else: the upload stops)
        const ctl = typeof AbortController === 'function' ? new AbortController() : null
        abortOf.set(a.id, ctl)
        a.job = uploadAttachment(file, { signal: ctl?.signal })
          .then((r) => { const x = this.attachments.find((y) => y.id === a.id); if (x) { x.state = 'ready'; x.result = r } })
          .catch((e) => { const x = this.attachments.find((y) => y.id === a.id); if (x) { x.state = 'error'; x.error = e.message } })
          .finally(() => abortOf.delete(a.id))
      }
    },
    removeAttachment(id) { this.dropAttachments((a) => a.id === id) },
    // the chips that match go, and their uploads still going stop
    dropAttachments(match) {
      for (const a of this.attachments.filter(match)) { if (a.state === 'uploading') abortOf.get(a.id)?.abort(); abortOf.delete(a.id) }
      this.attachments = this.attachments.filter((a) => !match(a))
    },
    // dropped files of the app → chips at once, then what each one is (or why it cannot be used) from the server
    addFileRefs(items) {
      const job = this._addFileRefs(items)
      this._refsJob = Promise.all([this._refsJob, job]).then(() => {})
      return job
    },
    // the composer's message takes them (Composer.vue submit): it waits for any still being checked, takes the usable ones and clears
    // what it took (and the refused ones, which said why). Only the composer's own send carries them — no other send of the store picks
    // up chips lying in the composer, and a message queued for a room being made keeps its own (PR #45 review).
    async takeFileRefs() {
      await this._refsJob
      const taken = this.fileRefs.filter((r) => !r.wait)
      this.fileRefs = this.fileRefs.filter((r) => r.wait)
      return taken.filter((r) => !r.error).map((r) => r.item)
    },
    async _addFileRefs(items) {
      const fresh = (items || []).filter((it) => !this.fileRefs.some((r) => JSON.stringify(r.item) === JSON.stringify(it))).slice(0, Math.max(0, 10 - this.fileRefs.length))
      if (!fresh.length) return
      const keys = fresh.map(() => crypto.randomUUID())
      this.fileRefs = [...this.fileRefs, ...fresh.map((it, i) => ({ key: keys[i], item: it, name: it.name || '파일', folder: it.folder || '', as: it.as || 'link', ...(it.src === 'mail' ? { from: it.from || '' } : {}),
        ...(it.src === 'mailatt' ? { subject: it.subject || '' } : {}), wait: true, error: '' }))]
      let res = []
      try { res = (await api('/files/resolve', { method: 'POST', body: { items: fresh } })).items } catch (e) { res = fresh.map(() => ({ ok: false, error: e.message })) }
      this.fileRefs = this.fileRefs.map((r) => {
        const i = keys.indexOf(r.key)
        if (i < 0) return r
        const x = res[i]
        if (!x?.ok) return { ...r, wait: false, error: x?.error || '이 파일을 쓸 수 없어요' }
        // a mail of mine (server lib/mailMention.js): its chip says who sent it and its subject
        if (x.as === 'mail') return { ...r, wait: false, name: x.name || r.name, as: 'mail', from: x.mail?.from || r.item?.from || '', mail: x.mail || null }
        // an attachment of a mail of mine (server lib/mailAttachments.js): its chip names the file and the mail it came with
        if (x.as === 'mailatt') return { ...r, wait: false, name: x.name || r.name, as: 'mailatt', att: x.att || null, subject: x.att?.subject || r.subject || '' }
        return { ...r, wait: false, name: x.name || r.name, as: x.as, folder: x.ref?.folder || '', variation: x.ref?.variation || null }
      })
    },
    removeFileRef(key) { this.fileRefs = this.fileRefs.filter((r) => r.key !== key) },
    addMention(m) {
      if (!m?.label) return
      this.mentions = [...this.mentions.filter((x) => !(x.label === m.label && x.file === m.file)), m].slice(-4)
    },
    removeMention(i) { this.mentions = this.mentions.filter((_, k) => k !== i) },
    // the open document's selection as it changes (null: nothing selected, or the document closed — a chip put away may come back
    // for the same words selected again)
    setDocSel(sel, file) { this.docSel = docSelectionOf(sel, file); if (!this.docSel) this.docSelOff = '' },
    dropDocSel() { if (this.docSel) this.docSelOff = docSelectionKey(this.docSel) },
    // attachments: the files this message carries when they were taken earlier (a message queued while 새 프로젝트's room is made)
    // opts.fresh: 「이미 한 요청」 카드의 「그래도 새로 하기」·허락 뒤 다시 답하기 — 서버가 같은 요청 알아보기를 건너뛴다
    // opts.agent: who answers — 'default' (the server's agent) or a CLI on my PC ('claude-code' · 'codex', server lib/localAgents/chat.js);
    // unless given, the composer's choice for this chat when it was the composer that sent it (nextAgent), else 'default'
    async send(text, threadId = this.activeId, context, attachments, opts = {}) {
      const picked = this.nextAgent
      this.nextAgent = null
      // mentions: the chips read first in the message; where each one is goes to the agent — the open document's selection too
      // (its chip goes with this message, then stays away until the selection changes)
      const sel = this.docSelChip
      if (sel) this.dropDocSel()
      const mentions = [...this.mentions, ...(sel ? [sel] : [])]
      if (mentions.length) {
        this.mentions = []
        if (this.beforeSend && (await this.beforeSend(text, mentions, threadId))) return
        text = `${mentions.map((m) => `@${m.label}`).join(' ')} ${text}`
        context = [context, mentionContext(mentions, isEnglish)].filter(Boolean).join('\n\n')
      }
      const pending = attachments || this.attachments
      if (!attachments) this.attachments = []
      // files dragged onto the composer: only what the composer gave this message (opts.refs, takeFileRefs)
      const refs = Array.isArray(opts.refs) ? opts.refs : []
      await Promise.all(pending.map((a) => a.job))
      const files = pending.filter((a) => a.result).map((a) => a.result)
      // asked from inside one conversation's view: it continues that conversation — and inside one sub-topic of a project, that
      // sub-topic (server lib/projectTopics.js: the router is not asked)
      const conv = this.convFilter && threadId === this.mainThread?.id ? this.convList.find((c) => c.id === this.convFilter) : null
      const inTopic = this.topicFilter && this.mode === 'project' && threadId === this.activeId && this.projects.some((p) => p.id === threadId)
      const topic = inTopic ? this.topicList.find((c) => c.id === this.topicFilter) || { id: this.topicFilter } : null
      const chosen = conv ? { id: conv.id, title: conv.title } : this.convFilter && threadId === this.mainThread?.id ? { id: this.convFilter }
        : topic ? { id: topic.id, title: topic.title || '' } : null
      // an editable document open in the editor (OfficeSheet): the message is about it, even when its
      // live link (src/liveLink.js) is down — the server still edits it in place (lib/agent.js delegate)
      const d = this.officeDoc, ed = d && !d.readOnly ? officeEditorFor(d.name || d.url) : null
      const openDoc = ed && !CRAFT_APPS.has(ed) && d.name ? { app: 'ieumoffice', file: d.name, name: d.name, editor: ed, ...(d.msgId ? { msgId: d.msgId } : {}), ...(d.url ? { url: d.url } : {}) } : undefined
      // …and it stays in the conversation the document is in: the context router does not file it under a new topic (src/docSelection.js)
      const docConv = openDoc ? docConversation({ doc: d, threadId, mainId: this.mainThread?.id, convOf: this.convOf, convList: this.convList, chosen }) : null
      const conversation = chosen || docConv || undefined
      const key = chatKeyOf(threadId, conversation?.id)
      const agent = opts.agent || (picked && picked.key === key ? picked.agent : 'default')
      // Each message is named (src/sendQueue.js newId — the server takes a name once, lib/sendOnce.js) and kept until the server takes it:
      // a server away for a moment (a deploy's restart — 2026-11-27 recording) is asked again, anything else is kept for the person.
      const back = takenBack.get(`${key}\n${text}`)
      takenBack.delete(`${key}\n${text}`)
      const again = back && Date.now() - back.at < TAKEN_BACK_MS ? back.id : null
      const entry = { id: again || newId(), threadId, key, conv: conversation || null, text, context, files, refs, openDoc, agent, fresh: !!opts.fresh, at: Date.now(), tries: 0 }
      tookChips.set(entry.id, pending)
      // behind a message of this room not taken yet: it waits its turn (the server answers them in the order they reach it)
      if (this.unsent.some((u) => u.threadId === threadId && u.state !== 'failed')) { this.keepUnsent({ ...entry, state: 'waiting' }); this.runUnsent(threadId); return }
      // kept from the first try on (state 'sending' — no line for it): a reload while the first try hangs (a gateway may take 15 – 100 s to
      // give up) does not lose it; at the next start it is sent again under its name
      this.keepUnsent({ ...entry, state: 'sending' })
      const r = await this.trySend(entry, (ev, data) => {
        // a document whose card is in no conversation: the one its first message went to is the document's from now on
        const went = ev === 'done' && data?.content?.context?.conversationId
        if (went && openDoc && !docConv && !chosen && this.officeDoc === d && threadId === this.mainThread?.id) this.officeDoc = { ...d, conv: went }
      })
      if (r.accepted) { tookChips.delete(entry.id); return r.finished }
      // (taken back meanwhile: nothing more)
      if (!this.unsent.some((x) => x.id === entry.id)) return
      if (retryable(r.error)) { this.patchUnsent(entry.id, { state: 'retrying', tries: 1, error: why(r.error) }); this.runUnsent(threadId); return }
      this.failUnsent(entry, r.error)
    },
    // One attempt: resolves the moment the server took the message ({accepted: true, finished — the whole answer}) or did not ({error});
    // the answer streams into the room's draft as it always did. A message taken leaves the unsent list at once — its line goes before
    // the answer is written, so 「그만두기」 is never offered for a message already in the room.
    async trySend(entry, extra) {
      const { threadId } = entry
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      inFlight.set(entry.id, ctl)
      // (no answer at all for a while — a gateway that has not given up: given up here and asked again under the same name)
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; ctl?.abort() }, ATTEMPT_MS)
      this.drafts[threadId] = ''
      const asked = this.askedAt[threadId] = Date.now()
      let ended = false, accepted = false, took
      const tookIt = new Promise((ok) => { took = ok })
      const run = stream(`/threads/${threadId}/messages`, { text: entry.text, context: entry.context, files: entry.files, conversation: entry.conv || undefined, openDoc: entry.openDoc,
        ...(entry.refs?.length ? { refs: entry.refs } : {}), ...(entry.fresh ? { fresh: true } : {}), ...(entry.agent && entry.agent !== 'default' ? { agent: entry.agent } : {}), clientId: entry.id }, (ev, data) => {
        if (ev === 'delta' && this.drafts[threadId] != null) this.drafts[threadId] += data.d
        // the draft was an interim text after all (a tool call followed it — server lib/turnPlan.js): back to 「생각하는 중」
        if (ev === 'retract' && this.drafts[threadId] != null) this.drafts[threadId] = ''
        if (ev === 'done' || ev === 'error') { ended = true; this.drafts[threadId] = null }
        extra?.(ev, data)
      }, { signal: ctl?.signal, onAccepted: () => { accepted = true; clearTimeout(timer); inFlight.delete(entry.id); this.dropUnsent(entry.id); took() } })
      const outcome = run.then(() => null, (e) => (timedOut && !accepted ? Object.assign(e, { timedOut: true }) : e))
      const finished = outcome.then((e) => {
        if (!accepted) return
        if (e) console.warn('[send]', e.message)
        // the connection dropped before the answer (a proxy cutting a long request, a server restart):
        // stop showing "생각하는 중"; the answer, if it comes, arrives as a live event
        if (!ended) { this.drafts[threadId] = null; this.load(threadId).catch(() => {}) }
        // the answer's cards come as live events, a moment after it ends; a dropped connection waits longer
        setTimeout(() => { if (this.askedAt[threadId] === asked) delete this.askedAt[threadId] }, ended ? 15_000 : 10 * 60_000)
        if (threadId === this.mainThread?.id) this.loadConversations()
        else if (this.projects.some((p) => p.id === threadId)) this.loadTopics(threadId)
      })
      const first = await Promise.race([tookIt.then(() => null), outcome])
      clearTimeout(timer)
      if (accepted) return { accepted: true, finished }
      inFlight.delete(entry.id)
      this.drafts[threadId] = null
      return { accepted: false, error: first || Object.assign(new Error('no answer'), { accepted: false }) }
    },
    // The room's messages not taken yet, asked again one at a time in the order they were sent, each for retryWindow() from its first
    // try (2 s, 4 s … 15 s apart). One worker per room.
    async runUnsent(threadId) {
      if (working.has(threadId)) return
      working.add(threadId)
      try {
        for (;;) {
          const u = this.unsent.find((x) => x.threadId === threadId && x.state !== 'failed')
          if (!u) break
          // (the room's first message still on its first try — send() has it: the ones behind it wait)
          if (u.state === 'sending' && inFlight.has(u.id)) { await sleep(300); continue }
          if (Date.now() - (u.at || 0) > retryWindow()) { this.failUnsent(u, null, u.error); continue }
          if (u.tries) { u.state = 'retrying'; this.saveUnsent(); await sleep(backoff(u.tries)) }
          // (taken back or put aside meanwhile)
          const now = this.unsent.find((x) => x.id === u.id && x.state !== 'failed')
          if (!now) continue
          now.state = 'retrying'
          const r = await this.trySend(now)
          if (r.accepted) { tookChips.delete(now.id); continue }
          if (!this.unsent.some((x) => x.id === now.id)) continue
          if (retryable(r.error)) { now.tries = (now.tries || 0) + 1; now.error = why(r.error); this.saveUnsent(); continue }
          this.failUnsent(now, r.error)
        }
      } finally { working.delete(threadId) }
    },
    keepUnsent(u) { this.unsent = [...this.unsent.filter((x) => x.id !== u.id), u]; this.saveUnsent() },
    // a kept message changed in its place (the room's order stays)
    patchUnsent(id, patch) { this.unsent = this.unsent.map((x) => (x.id === id ? { ...x, ...patch } : x)); this.saveUnsent() },
    dropUnsent(id) { if (this.unsent.some((x) => x.id === id)) { this.unsent = this.unsent.filter((x) => x.id !== id); this.saveUnsent() } },
    saveUnsent() { saveUnsent(this.me?.user?.id, this.unsent) },
    // not taken, and not asked again (a refusal, the server away past the window, a sign-in gone): kept for the person — its line offers
    // 다시 보내기 · 입력창에 넣기 · 지우기, and an empty composer of its own conversation takes it back at once (Composer.vue)
    failUnsent(u, error, said) {
      const row = { ...u, state: 'failed', error: said || why(error) }
      this.unsent = this.unsent.some((x) => x.id === u.id) ? this.unsent.map((x) => (x.id === u.id ? row : x)) : [...this.unsent, row]
      this.dropLocalCopy(row)
      this.saveUnsent()
    },
    // a new project's message shown before its room existed (newProject): it is not in the room after all
    dropLocalCopy(u) {
      const list = this.messages[u.threadId]
      if (list?.some((m) => m.content?.local && m.content?.text === u.text)) this.messages[u.threadId] = list.filter((m) => !(m.content?.local && m.content?.text === u.text))
    },
    // 그만두기 · 입력창에 넣기: the message is not sent (an attempt under way stops); its words come back (the composer puts them in its
    // box), its files back among the composer's attachments, its dragged files back as chips → {text, threadId, key} or null
    takeBackUnsent(id) {
      const u = this.unsent.find((x) => x.id === id)
      if (!u) return null
      inFlight.get(id)?.abort()
      inFlight.delete(id)
      this.unsent = this.unsent.filter((x) => x.id !== id)
      this.saveUnsent()
      this.dropLocalCopy(u)
      takenBack.set(`${u.key}\n${u.text}`, { id: u.id, at: Date.now() })
      const chips = tookChips.get(id) || (u.files || []).map((f) => ({ id: newId(), name: f.name || '파일', size: f.size || 0, state: 'ready', result: f, error: '', job: Promise.resolve(f) }))
      tookChips.delete(id)
      if (chips.length) this.attachments = [...this.attachments, ...chips.filter((a) => !this.attachments.some((b) => b.id === a.id))]
      if (u.refs?.length) this.addFileRefs(u.refs)
      return { text: u.text, threadId: u.threadId, key: u.key }
    },
    // 다시 보내기 on a message kept for the person: asked again (a new window), in its place in the room's order
    retryUnsent(id) {
      const u = this.unsent.find((x) => x.id === id)
      if (!u) return
      this.patchUnsent(id, { state: 'retrying', tries: 0, at: Date.now(), error: '' })
      this.runUnsent(u.threadId)
    },
    // 지우기: the message is let go (its words are not kept anywhere any more)
    forgetUnsent(id) { tookChips.delete(id); this.dropUnsent(id) },
    // the key of the conversation the composer writes into now (as send() works it out): a message kept for it is given back here only
    composerKey(threadId = this.activeId) {
      const conv = this.convFilter && threadId === this.mainThread?.id ? this.convFilter
        : this.topicFilter && this.mode === 'project' && threadId === this.activeId ? this.topicFilter : null
      return chatKeyOf(threadId, conv || undefined)
    },
    // 멈추기: the answer being written in this thread (in a conversation view, only that conversation's)
    async stopTurn(threadId = this.activeId) {
      const conversation = this.convFilter && threadId === this.mainThread?.id ? this.convFilter
        : this.topicFilter && this.mode === 'project' && threadId === this.activeId ? this.topicFilter : undefined
      const r = await api(`/threads/${threadId}/stop`, { method: 'POST', body: { conversation } }).catch(() => null)
      if (r && !r.waiting) { this.status[threadId] = null }
      return r
    },
    // 새 프로젝트: the message and "생각하는 중" show at once, in a room that is not made yet — making it
    // (POST /threads, a title from the model) can take a while (recording 2026-11-21: 20 s of nothing).
    // → the new room's id, or null when it could not be made (the text goes back into the composer).
    newProject(text, refs = []) {
      // the folder chosen on the 새 프로젝트 screen: the project works on its own variation of it
      const f = this.newProjectFolder
      // the files attached for this message go with it, not with whatever is sent next while the room is made
      const att = this.attachments
      this.attachments = []
      const tmp = `draft-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      this.messages[tmp] = [{ id: `${tmp}-1`, thread_id: tmp, role: 'user', kind: 'text', content: { text, local: true }, created_at: new Date().toISOString() }]
      this.drafts[tmp] = ''
      // more: what was sent after it while the room is made (queueDraft) — shown, and sent in order once it exists
      const more = []
      this.draftProject = { tmp, id: null, more }
      this.notice = null
      this.activeId = tmp
      draftJob = (async () => {
        let t
        try {
          t = await api('/threads', { method: 'POST', body: { text, ...(f?.newName ? { newFolder: f.newName } : f?.id ? { folder: f.id } : {}) } })
        } catch (e) {
          delete this.messages[tmp]
          delete this.drafts[tmp]
          // still on that screen: the text goes back into the composer (elsewhere it would land in another chat)
          const here = this.activeId === tmp
          if (here) {
            this.activeId = null; this.prefill = [text, ...more.map((m) => m.text)].join('\n'); this.attachments = [...att, ...more.flatMap((m) => m.att), ...this.attachments]
            const back = [...refs, ...more.flatMap((m) => m.refs || [])]
            if (back.length) this.addFileRefs(back)
          }
          this.draftProject = null
          // a refusal the server explains (the folder) is said as it is; anything else plainly
          const why = e.status && e.status < 500 && /[가-힣]/.test(e.message || '') ? e.message : '프로젝트를 만들지 못했어요'
          this.notice = { text: here ? `${why} · 보낸 글은 입력창에 돌려놓았어요. 다시 보내 주세요.` : `${why} · 다시 보내 주세요.` }
          return null
        }
        this.newProjectFolder = null
        // what is on screen moves into the new room as it is (the server's copy replaces the message: onEvent)
        this.messages[t.id] = (this.messages[tmp] || []).map((m) => ({ ...m, thread_id: t.id }))
        this.drafts[t.id] = ''
        delete this.messages[tmp]
        delete this.drafts[tmp]
        if (!this.projects.some((p) => p.id === t.id)) this.projects.unshift(t)
        if (this.draftProject?.tmp === tmp) this.draftProject = { tmp, id: t.id, more }
        if (this.activeId === tmp) this.activeId = t.id
        this.send(text, t.id, undefined, att, { refs })
        // (a moment apart: the server keeps them in the order sent and answers them in turn — lib/turns.js)
        more.forEach((m, i) => setTimeout(() => this.send(m.text, t.id, undefined, m.att, { refs: m.refs || [] }), 400 * (i + 1)))
        return t.id
      })()
      return draftJob
    },
    // a second message sent while the room is still being made: on screen now, to the room once it exists
    queueDraft(text, refs = []) {
      const d = this.draftProject
      if (!d || d.id || !this.messages[d.tmp]) return this.send(text, undefined, undefined, undefined, { refs })
      // (its own files, taken now: a file attached for it must not leave with the first message)
      d.more.push({ text, att: this.attachments, refs })
      this.attachments = []
      this.messages[d.tmp].push({ id: `${d.tmp}-${d.more.length + 1}`, thread_id: d.tmp, role: 'user', kind: 'text', content: { text, local: true }, created_at: new Date().toISOString() })
      return draftJob
    },
    // 📎 폴더 붙이기: a folder for reference in this thread (the agent reads its main; a change goes to a variation)
    async attachFolder(folder, threadId = this.activeId) {
      const r = await api(`/threads/${threadId}/folder`, { method: 'POST', body: { folder: folder.id || folder.slug } })
      this.setThreadFolder(threadId, r.folder)
    },
    async detachFolder(threadId = this.activeId) {
      await api(`/threads/${threadId}/folder`, { method: 'DELETE' })
      this.setThreadFolder(threadId, null)
    },
    setThreadFolder(threadId, folder) {
      if (this.mainThread?.id === threadId) this.mainThread = { ...this.mainThread, folder }
      const i = this.projects.findIndex((p) => p.id === threadId)
      if (i >= 0) this.projects[i] = { ...this.projects[i], folder }
    },
    async open(id) {
      this.activeId = id
      // a project's sub-topics come beside its messages (not waited for: the chat shows at once)
      if (this.projects.some((p) => p.id === id)) this.loadTopics(id)
      if (!this.messages[id]) await this.load(id)
    },
    // a card button: the step's choice is submitted right there (with no choice the answer names the instance to open)
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
      // a work item's notice takes its Home card with it (the server remembers: lib/homeCards.js)
      if (n.todoId) this.todos = this.todos.map((t) => (t.id === n.todoId ? { ...t, home_hidden: true } : t))
      await api(`/notifications/${n.id}/dismiss`, { method: 'POST' })
    },
    runAction(a) { return api(`/actions/${a.id}/run`, { method: 'POST' }) },
    // a mail's card: the mail, a reply draft, the send — only on 보내기 (routes/mailReply.js)
    mailOfCard(id) { return api(`/actions/${id}/mail`) },
    // a chat chip of a mail (모닝 브리프 · 메일에서 찾은 요청 · 보낸 답장, server lib/mailFlow.js refOf): its card's mail sheet — the
    // card on Home, else the server's (a card put away from Home still opens its mail)
    async openMailCard(ref, from = 'chat') {
      const id = ref?.actionId
      let a = (id && this.actions.find((x) => x.id === id)) || (ref?.mailId && this.actions.find((x) => x.source?.mail_id === ref.mailId)) || null
      if (!a) a = await api(`/mail/card?${new URLSearchParams(Object.entries({ action: id || '', mail: ref?.mailId || '' }).filter(([, v]) => v))}`)
      this.mailCardFrom = from
      this.mailCard = a
      return a
    },
    // the mail's place in the work (lib/mailFlow.js): its instance, or what it may start or join — nothing starts until the person presses
    mailFlow(id) { return api(`/actions/${id}/flow`) },
    startMailFlow(id, body) { return api(`/actions/${id}/flow/start`, { method: 'POST', body }) },
    joinMailFlow(id, body) { return api(`/actions/${id}/flow/join`, { method: 'POST', body }) },
    declineMailFlow(id, undo = false) { return api(`/actions/${id}/flow/decline`, { method: 'POST', body: { undo } }) },
    draftReply(id) { return api(`/actions/${id}/reply-draft`, { method: 'POST' }) },
    sendReply(id, body) { return api(`/actions/${id}/reply`, { method: 'POST', body }) },
    // what the card is for (calendar · reply · task, decided once — lib/mailCard.js), the calendar card's event read from the mail,
    // and 「캘린더에 추가」 — made only when pressed
    mailCardKind(id) { return api(`/actions/${id}/kind`) },
    mailEvent(id, tz) { return api(`/actions/${id}/event${tz ? `?tz=${encodeURIComponent(tz)}` : ''}`) },
    addMailEvent(id, body) { return api(`/actions/${id}/event`, { method: 'POST', body }) },
    // not only a reply (server lib/mailFollow.js): the sheet's row of follow-up actions, and an agent action run when pressed
    mailFollow(id) { return api(`/actions/${id}/follow`) },
    runMailFollow(id, key, again = false) { return api(`/actions/${id}/follow/${encodeURIComponent(key)}`, { method: 'POST', body: { again } }) },
    // the mail to a conversation (server lib/mailRooms.js): the picker (only 'shared': where it is shared now), 보내기, and 끄기 (body · files · follow)
    mailRooms(id, { only } = {}) { return api(`/actions/${id}/rooms${only ? `?only=${only}` : ''}`) },
    shareMailToRoom(id, body) { return api(`/actions/${id}/rooms`, { method: 'POST', body }) },
    stopMailRoom(id, room, what) { return api(`/actions/${id}/rooms/${encodeURIComponent(room)}/stop`, { method: 'POST', body: { what } }) },
    // 「채팅에서 이어서」: the mail as a chip in the chat composer (src/fileDrag.js mailItem — the agent turn reads it), the composer focused
    async mailToChat(item) {
      await this.addFileRefs([item])
      this.focusTick = (this.focusTick || 0) + 1
    },
    dismissAction(a) {
      this.actions = this.actions.filter((x) => x.id !== a.id)
      return api(`/actions/${a.id}/dismiss`, { method: 'POST' })
    },
    // Home is notifications: a work item's card put away — the work item stays mine (루틴 lists it)
    dismissTodo(t) {
      this.todos = this.todos.map((x) => (x.id === t.id ? { ...x, home_hidden: true } : x))
      return api(`/todos/${t.id}/dismiss`, { method: 'POST' })
    },
    // 팀 메시지 › 받은 편지함: the cards made from mail, a card put away from Home among them
    mailCardList() { return api('/mail/cards') },
    async createPanel(description) {
      this.panelMode = false
      await this.send(`새 패널 만들기: ${description}`, this.mainThread.id)
    },
    // (in the desktop app this computer's local runner is let go first: it no longer runs this person's steps)
    async logout() {
      if (localRunner.desktop) await disconnectThis({ optOut: false }).catch(() => {})
      // (this device forgets the places kept for sharing, a share still waiting and the messenger's unsent words — src/shareTarget.js)
      try { forgetPlaces(window.localStorage, window.sessionStorage) } catch { /* nothing kept */ }
      // (and the messages kept before the server took them — src/sendQueue.js: their words, context, files): the tries stop first, so
      // none writes the list back while the page leaves
      for (const c of inFlight.values()) c?.abort()
      inFlight.clear()
      this.unsent = []
      forgetAllUnsent(window.localStorage)
      auth.clear(); location.href = BASE + '/login'
    },
  },
})
