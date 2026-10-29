// Meetings in a team room (server/routes/meetings.js): the lobby (consent), the live meeting (mesh
// WebRTC, my speech → transcription, the shared 자료 panel, the presenter's stage) and the room's
// meeting state for the messenger header and cards. Live updates come as 'meeting' events re-broadcast
// on the window by api.js events(), like the team store.
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { api, auth } from '../api.js'
import { Mesh } from '../components/meetings/rtc.js'
import { startCapture } from '../components/meetings/capture.js'
import { Interpreter } from '../components/meetings/interp.js'
import { useTeam } from './team.js'
import { useApp } from './app.js'
import { BASE } from '../base.js'

async function postAudio(id, blob) {
  const go = () => fetch(`${BASE}/api/meetings/${id}/audio`, { method: 'POST', body: blob, headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${auth.get()?.session?.access_token || ''}` } })
  let r = await go()
  // a sign-in check or a gateway that did not answer in time loses a whole spoken piece (and its
  // interpretation): once more, a moment later
  if (r.status === 401 || r.status === 502 || r.status === 503) { await new Promise((ok) => setTimeout(ok, 400)); r = await go() }
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || '받아쓰지 못했어요.'), { status: r.status })
  return r.json()
}

export const useMeetings = defineStore('meetings', {
  state: () => ({
    booted: false,
    rooms: {},            // roomId -> {id, count, people} | null (a live meeting in the room)
    lobby: null,          // {roomId, title, meetingId?} before joining
    consent: false,       // the lobby's / my current consent
    m: null,              // the joined meeting's state (server state())
    peers: {},            // peerId -> {id, name, consent, stream, state, media}
    local: null,          // my MediaStream (raw)
    mic: true, cam: true, screen: false,
    level: 0,             // my mic level 0..1
    tab: 'lines',         // side panel: lines | materials
    stage: null,          // {material, by, byId, message?, hidden?} — what everyone is looking at
    mine: null,           // a material I opened only for myself {material, message}
    mini: false,          // the meeting shrunk to a corner (an editor is open over the page)
    agentSay: '듣고 있어요',
    tasks: {},            // suggestion id -> {state, by, title}
    sending: 0,
    error: '',
    endedMinutes: null,   // {roomId, messageId} after the meeting ended
    flash: null,          // material id to highlight (just found / mentioned again)
    unseen: 0,            // materials found while the 자막 tab was open
    // live interpretation (통역): the meeting's state {on, setting, mixed, langs, available, voice, status,
    // listen}, what I hear ('interp' | 'original'), who is being interpreted to me right now
    interp: null,
    listen: 'interp',
    onAir: {},            // speakerId -> true while their interpretation plays for me
    interpNote: '',       // an honest notice (no key, quota, budget)
    showOriginal: false,  // subtitles: my language first (false) or the original first
  }),
  getters: {
    active: (s) => !!s.m,
    lines: (s) => s.m?.lines || [],
    materials: (s) => s.m?.materials || [],
    suggestions: (s) => (s.m?.suggestions || []).filter((x) => x.state !== 'open' || x.canStart),
    // the language I speak and read in the meeting
    myLang: (s) => s.m?.me?.lang || useApp().me?.mainLang || 'ko',
  },
  actions: {
    boot() {
      if (this.booted) return
      this.booted = true
      window.addEventListener('pgpt:event', (e) => {
        if (e.detail?.type === 'meeting') this.onEvent(e.detail.data)
        // team assist moves a meeting's suggestion along too (running → done / failed)
        else if (e.detail?.type === 'team' && e.detail.data?.type === 'assist' && e.detail.data.suggestion?.meetingId) this.syncSuggestion(e.detail.data.suggestion)
      })
      window.addEventListener('beforeunload', () => { if (this.m) navigator.sendBeacon?.(`${BASE}/api/meetings/${this.m.id}/leave?token=${encodeURIComponent(auth.get()?.session?.access_token || '')}`) })
    },
    async loadRoom(roomId) {
      this.boot()
      const r = await api(`/meetings/room/${roomId}`).catch(() => null)
      if (r) this.rooms[roomId] = r.meeting
      return r
    },

    // ---- lobby → join ----
    async openLobby(roomId, title) {
      this.boot()
      this.lobby = { roomId, title }
      this.error = ''
      // join waits for this: entering before the microphone is open offers a connection with no media
      this.opening = (async () => {
        try {
          this.local = markRaw(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: { width: 640, height: 360 } }))
        } catch {
          try { this.local = markRaw(await navigator.mediaDevices.getUserMedia({ audio: true })); this.cam = false } catch { this.error = '카메라·마이크를 열 수 없어요. 브라우저 권한을 확인해 주세요.' }
        }
      })()
      await this.opening
    },
    cancelLobby() { this.stopLocal(); this.lobby = null },
    async join() {
      await this.opening
      const roomId = this.lobby.roomId
      const s = await api(`/meetings/room/${roomId}/start`, { method: 'POST', body: { consent: this.consent } })
      this.lobby = null
      this.enter(s)
      return s
    },
    enter(s) {
      this.m = s
      this.peers = {}
      this.stage = s.presenting?.material || s.presenting?.hidden ? { ...s.presenting } : null
      this.mesh = markRaw(new Mesh({
        ice: s.ice,
        send: (to, kind, data) => api(`/meetings/${s.id}/signal`, { method: 'POST', body: { to, kind, data } }),
        onStream: (id, stream) => { const p = this.peers[id] || (this.peers[id] = { id }); p.stream = markRaw(stream) },
        onState: (id, st) => { const p = this.peers[id]; if (p) p.state = st },
      }))
      this.mesh.setLocal(this.local)
      this.applyTracks()
      for (const p of s.peers) {
        if (p.id === s.me.id) continue
        this.peers[p.id] = { ...p, state: 'connecting' }
        // of two people the larger id offers (rtc.js); the other waits for it
        if (s.me.id > p.id) this.mesh.connect(p.id).catch((e) => console.warn('[meeting] connect', e.message))
      }
      this.heart = setInterval(() => api(`/meetings/${s.id}/heartbeat`, { method: 'POST' }).then((r) => { if (!r.joined || !r.live) this.cleanup() }).catch(() => {}), 15000)
      this.startListening()
      this.interp = s.interp || null
      this.listen = s.interp?.listen || 'interp'
      this.noticeFor(this.interp)
      this.startVoice()
      if (this.stage?.material?.kind === 'file') this.loadStageFile(this.stage)
      this.rooms[s.roomId] = { id: s.id, count: s.peers.length, people: s.peers.map((p) => p.name) }
    },
    startListening() {
      this.stopListening()
      if (!this.m?.agent || !this.consent || !this.local) return
      this.stopCap = startCapture(this.local, {
        onLevel: (v) => { this.level = v },
        // the interpreter opens its sessions while I am still talking (lib/meetings/interpret.js warm)
        onStart: () => { if (this.m && this.mic && this.interp?.on) api(`/meetings/${this.m.id}/speaking`, { method: 'POST' }).catch(() => {}) },
        onPiece: async (blob) => {
          if (!this.m || !this.mic) return
          this.sending++
          try { await postAudio(this.m.id, blob) } catch (e) { if (e.status === 403) this.error = e.message } finally { this.sending-- }
        },
      })
    },
    stopListening() { this.stopCap?.(); this.stopCap = null; this.level = 0 },
    stopLocal() { for (const t of this.local?.getTracks() || []) t.stop(); this.local = null; this.screenStream?.getTracks().forEach((t) => t.stop()); this.screenStream = null },
    applyTracks() {
      for (const t of this.local?.getAudioTracks() || []) t.enabled = this.mic
      for (const t of this.local?.getVideoTracks() || []) t.enabled = this.cam
    },
    async toggle(what) {
      if (what === 'mic') this.mic = !this.mic
      if (what === 'cam') this.cam = !this.cam
      this.applyTracks()
      if (this.m) api(`/meetings/${this.m.id}/media`, { method: 'POST', body: { mic: this.mic, cam: this.cam, screen: this.screen } }).catch(() => {})
    },
    async toggleScreen() {
      if (!this.m) return
      if (this.screen) {
        this.screenStream?.getTracks().forEach((t) => t.stop()); this.screenStream = null
        this.screen = false
        await this.mesh.replaceVideo(this.local?.getVideoTracks()[0] || null)
      } else {
        try {
          const s = markRaw(await navigator.mediaDevices.getDisplayMedia({ video: true }))
          this.screenStream = s
          this.screen = true
          const t = s.getVideoTracks()[0]
          t.onended = () => { if (this.screen) this.toggleScreen() }
          await this.mesh.replaceVideo(t)
        } catch { return }
      }
      api(`/meetings/${this.m.id}/media`, { method: 'POST', body: { mic: this.mic, cam: this.cam, screen: this.screen } }).catch(() => {})
    },
    async setConsent(on) {
      this.consent = on
      if (!this.m) return
      await api(`/meetings/${this.m.id}/consent`, { method: 'PUT', body: { on } })
      this.m.me.consent = on
      on ? this.startListening() : this.stopListening()
    },
    async say(text) {
      if (!this.m || !text.trim()) return
      await api(`/meetings/${this.m.id}/lines`, { method: 'POST', body: { text } })
    },
    async leave() {
      const m = this.m
      if (!m) return
      this.mesh?.closeAll()
      await api(`/meetings/${m.id}/leave`, { method: 'POST' }).catch(() => {})
      this.cleanup()
    },
    async endAll() {
      const m = this.m
      if (!m) return
      this.mesh?.closeAll()
      await api(`/meetings/${m.id}/end`, { method: 'POST' }).catch(() => {})
      this.cleanup()
    },
    // ---- interpretation ----
    startVoice() {
      this.stopVoice()
      const id = this.m?.id
      if (!id || !this.interp?.available || !this.interp?.voice) return
      const ip = new Interpreter({
        ticket: async () => (await api(`/meetings/${id}/voice/ticket`, { method: 'POST' })).ticket,
        onNote: (n) => {
          if (n.type === 'start') this.onAir = { ...this.onAir, [n.speakerId]: true }
          else if (n.type === 'end') setTimeout(() => { if (!this.voice?.playing(n.speakerId)) { const o = { ...this.onAir }; delete o[n.speakerId]; this.onAir = o } }, 500)
        },
      })
      ip.setMode(this.listen)
      ip.setOn(!!this.interp.on)
      this.voice = markRaw(ip)
      ip.open().catch((e) => console.warn('[meeting] voice', e.message))
      for (const [pid, el] of Object.entries(this.els || {})) ip.register(pid, el)
    },
    stopVoice() { this.voice?.close(); this.voice = null; this.onAir = {} },
    // a tile's video element, so its voice can be lowered while it is interpreted (VideoTile @el)
    registerEl(peerId, el) {
      this.els = this.els || {}
      if (el) this.els[peerId] = el; else delete this.els[peerId]
      this.voice?.register(peerId, el)
    },
    async setListen(mode) {
      this.listen = mode === 'original' ? 'original' : 'interp'
      this.voice?.setMode(this.listen)
      if (this.m) await api(`/meetings/${this.m.id}/listen`, { method: 'PUT', body: { mode: this.listen } }).catch(() => {})
    },
    async setInterp(on) {
      if (!this.m) return
      const v = await api(`/meetings/${this.m.id}/interp`, { method: 'PUT', body: { on } })
      this.applyInterp(v)
    },
    applyInterp(v) {
      const was = this.interp
      this.interp = { ...v, listen: this.listen }
      this.voice?.setOn(!!v.on)
      this.noticeFor(v)
      if (v.available && v.voice && !this.voice) this.startVoice()
      if (was && !was.on && v.on) this.voice?.setMode(this.listen)
    },
    noticeFor(v) {
      if (!v || !v.mixed) { this.interpNote = ''; return }
      const st = v.status
      this.interpNote = !v.available
        ? (st === 'off' ? '이 서버에서 통역이 꺼져 있어요. 자막은 원문으로만 보여요.' : '통역 키가 설정되지 않아 통역을 쓸 수 없어요. 자막은 원문으로만 보여요.')
        : st === 'quota' ? '통역 사용 한도를 넘어 지금은 통역할 수 없어요. 자막은 원문으로 보여요.'
        : st === 'limit' ? '이 회의의 통역 사용량이 많아 잠시 통역 음성을 멈췄어요. 번역 자막은 계속돼요.'
        : st === 'subtitles' ? '통역 음성은 꺼져 있고 번역 자막만 보여요.'
        : ''
    },

    cleanup() {
      clearInterval(this.heart)
      this.stopListening()
      this.stopVoice()
      this.mesh?.closeAll?.()
      this.mesh = null
      this.stopLocal()
      if (this.m) this.endedMinutes = { roomId: this.m.roomId, pending: true }
      this.m = null; this.peers = {}; this.stage = null; this.mine = null; this.mini = false; this.screen = false
      this.interp = null; this.interpNote = ''; this.els = {}
    },

    // ---- materials ----
    async openFor(material, { me = true } = {}) {
      if (material.kind === 'file') {
        const r = await api(`/meetings/${this.m.id}/materials/${material.id}/open`, { method: 'POST' })
        return { material, message: r.message }
      }
      if (material.kind === 'result') return { material }
      const r = await api(`/meetings/${this.m.id}/materials/${material.id}/open`, { method: 'POST' })
      return { material: r.material || material, me }
    },
    async openMine(material) { this.mine = await this.openFor(material) },
    async present(material) { await api(`/meetings/${this.m.id}/materials/${material.id}/present`, { method: 'POST' }) },
    async clearStage() { await api(`/meetings/${this.m.id}/present/clear`, { method: 'POST' }) },
    async loadStageFile(st) {
      try { const r = await this.openFor(st.material); if (this.stage && this.stage.material?.id === st.material.id) this.stage = { ...this.stage, message: r.message } } catch (e) { this.error = e.message }
    },
    async startTask(s) {
      await api(`/meetings/${this.m.id}/suggestions/${s.id}/start`, { method: 'POST' })
    },
    async dismissTask(s) {
      this.m.suggestions = this.m.suggestions.filter((x) => x.id !== s.id)
      await api(`/meetings/${this.m.id}/suggestions/${s.id}/dismiss`, { method: 'POST' }).catch(() => {})
    },

    // ---- live events ----
    onEvent(d) {
      if (d.type === 'room') { this.rooms[d.roomId] = d.meeting; return }
      if (d.type === 'minutes') { this.endedMinutes = { roomId: d.roomId, messageId: d.messageId }; return }
      const m = this.m
      if (!m || d.meetingId !== m.id) return
      if (d.type === 'signal') { this.mesh?.onSignal(d).catch((e) => console.warn('[meeting] signal', e.message)); return }
      if (d.type === 'joined') {
        // (re)joined: a fresh connection; the larger id offers, the other answers when the offer comes
        const ex = this.peers[d.peer.id]
        this.peers[d.peer.id] = { ...(ex || {}), ...d.peer, state: 'connecting' }
        if (m.me.id > d.peer.id) { this.mesh?.close(d.peer.id); this.mesh?.connect(d.peer.id).catch((e) => console.warn('[meeting] connect', e.message)) }
        if (!m.peers.some((p) => p.id === d.peer.id)) m.peers.push(d.peer)
        this.agentSay = `${d.peer.name}님이 들어왔어요`
      } else if (d.type === 'left') {
        this.mesh?.close(d.peer.id)
        delete this.peers[d.peer.id]
        m.peers = m.peers.filter((p) => p.id !== d.peer.id)
      } else if (d.type === 'consent') {
        const p = this.peers[d.peer.id]; if (p) p.consent = d.peer.consent
        const q = m.peers.find((x) => x.id === d.peer.id); if (q) q.consent = d.peer.consent
      } else if (d.type === 'media') {
        const p = this.peers[d.peer.id]; if (p) p.media = d.media
      } else if (d.type === 'line') {
        if (!m.lines.some((l) => l.id === d.line.id)) m.lines.push({ tr: {}, ...d.line })
        if (m.lines.length > 200) m.lines.splice(0, m.lines.length - 200)
        this.agentSay = '듣고 있어요'
      } else if (d.type === 'line-tr') {
        const l = m.lines.find((x) => x.id === d.id)
        if (l) l.tr = { ...(l.tr || {}), [d.lang]: d.text }
      } else if (d.type === 'interp') {
        this.applyInterp(d.interp)
        if (d.by) this.agentSay = d.interp.on ? `${d.by}님이 통역을 켰어요` : `${d.by}님이 통역을 껐어요`
      } else if (d.type === 'interp-status') {
        if (this.interp) { this.interp = { ...this.interp, status: d.status }; this.noticeFor(this.interp) }
      } else if (d.type === 'material') {
        const i = m.materials.findIndex((x) => x.id === d.material.id)
        if (i >= 0) m.materials[i] = d.material; else m.materials.push(d.material)
        this.agentSay = `자료를 찾았어요 · ${d.material.title}`
        this.flash = d.material.id
        if (this.tab !== 'materials') this.unseen = (this.unseen || 0) + 1
      } else if (d.type === 'mentioned') {
        this.flash = d.materialId
      } else if (d.type === 'present') {
        if (!d.material && !d.hidden) { this.stage = null; return }
        this.stage = { material: d.material, hidden: !!d.hidden, by: d.by, byId: d.byId }
        this.mine = null
        if (d.material?.kind === 'file') this.loadStageFile(this.stage)
      } else if (d.type === 'suggestion') {
        const i = m.suggestions.findIndex((x) => x.id === d.suggestion.id)
        if (i >= 0) m.suggestions[i] = d.suggestion; else m.suggestions.push(d.suggestion)
        this.agentSay = `도와드릴 일이 있어요 · ${d.suggestion.title}`
      } else if (d.type === 'task') {
        this.tasks[d.id] = { state: d.state, by: d.by, title: d.title }
        const s = m.suggestions.find((x) => x.id === d.id)
        if (s) s.state = d.state === 'done' ? 'done' : 'running'
        this.agentSay = d.state === 'done' ? `${d.by}님의 에이전트가 ${d.title}를 마쳤어요` : `${d.by}님의 에이전트가 ${d.title} 중`
      } else if (d.type === 'ended') {
        this.cleanup()
      }
    },
    // the team store's assist events also move a meeting's suggestion along
    syncSuggestion(v) {
      const s = this.m?.suggestions.find((x) => x.id === v.id)
      if (s) Object.assign(s, v)
    },
    roomOf(roomId) { return this.rooms[roomId] || null },
    team() { return useTeam() },
  },
})
