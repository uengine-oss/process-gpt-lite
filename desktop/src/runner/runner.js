'use strict'
// Runs the process steps the Lite server sends this desktop (design docs/local-agents/design.md §4–5): for each job — its folder made
// current, the run's branch, the chosen CLI with the step's prompt, a person's steering while it goes, then commit and push, and the
// report to the server (kept until the server confirms it, so a link that drops does not lose a finished run).
// The CLI runs as the person's own interactive CLI in a terminal (session.js — a PTY, as agent-share runs it), so it does exactly what
// it does in their own terminal; its screen is relayed to the server for every viewer, and only this computer's person types into it.
// Where no terminal can be made (node-pty does not load) it runs headless instead (clis.command — the fallback).
// It only ever: runs jobs that came over its own link (the server sends only this person's), runs the fixed command of the named CLI
// (clis.js — nothing the server sends is run as a command), works in its own folders under <data>/work, and never writes a token to
// disk or to a log.
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { EventEmitter } = require('node:events')
const C = require('./clis')
const G = require('./git')
const SKL = require('./skills')
const P = require('./pty')
const { CliSession } = require('./session')

const RUN_MS = 60 * 60_000
const FLUSH_MS = 800
const ACK_GRACE_MS = 20_000
// after the CLI says a turn ended: how long nothing new may happen before the step is taken as done (a message typed meanwhile, a
// steer not yet in its transcript, the person typing — each starts the wait again), and the longest a typed-but-unsent line holds it
const SETTLE_MS = Number(process.env.PGL_RUNNER_SETTLE_MS || 3000)
const IDLE_FINISH_MS = Number(process.env.PGL_RUNNER_IDLE_FINISH_MS || 120_000)
const OUT_FLUSH_MS = 40
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const safePart = (s, n = 24) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '').slice(-n) || 'x'
const T = (lang, ko, en) => (lang === 'en' ? en : ko)

class Runner extends EventEmitter {
  // dataDir: the app's data folder (work folders and the outbox live under it) · server: the Lite base address (the folder's git path is
  // joined to it) · prefs(): {enabled, ask} · ask(job): the person's yes before a run (prefs.ask) · caps: from clis.detect
  // mode: 'auto' (a terminal when node-pty loads) | 'headless' · sessionEnv: extra environment for the CLI (e.g. its config folder)
  constructor({ dataDir, server, prefs = () => ({ enabled: true, ask: false }), ask = async () => true, searchPath = C.augmentedPath(), maxJobs = 2,
    log = () => {}, runMs = RUN_MS, caps = {}, mode = process.env.PGL_RUNNER_MODE || 'auto', sessionEnv = {}, settleMs = SETTLE_MS, idleFinishMs = IDLE_FINISH_MS,
    cols = 80, rows = 28 } = {}) {
    super()
    this.mode = mode
    this.sessionEnv = sessionEnv
    this.settleMs = settleMs
    this.idleFinishMs = idleFinishMs
    this.size = { cols, rows }
    this.sessions = new Map() // sid → {S, kind, ref, out, timer}
    this.dataDir = dataDir
    this.server = String(server || '').replace(/\/+$/, '')
    this.prefs = prefs
    this.askFn = ask
    this.searchPath = searchPath
    this.maxJobs = maxJobs
    this.runMs = runMs
    this.caps = caps
    this.jobs = new Map()
    this.link = null
    this.user = null
    this.locks = new Map()
    this.secrets = new Set()
    this.logFn = log
    this.outboxFile = path.join(dataDir, 'outbox.json')
    try { this.outbox = JSON.parse(fs.readFileSync(this.outboxFile, 'utf8')) || [] } catch { this.outbox = [] }
  }

  log(...a) { let s = a.join(' '); for (const t of this.secrets) if (t) s = s.split(t).join('***'); this.logFn(s) }
  send(msg) { return !!this.link && this.link.send(msg) }
  setLink(link) { this.link = link }
  activeIds() { return [...this.jobs.keys()] }
  status() {
    return [...this.jobs.values()].map((s) => ({ jobId: s.job.id, instId: s.job.instId, activity: s.job.activity, agent: s.job.agent, label: s.job.label || C.CLIS[s.job.agent]?.label, phase: s.phase,
      instName: s.job.instName || '', since: s.since }))
  }
  changed() { this.emit('state', this.status()) }

  // the server knows this link now: what finished while it was away goes again, and every open terminal is announced again (its
  // screen so far with it — a restarted server builds its copy from that)
  welcome(info = {}) {
    this.user = info.user || null
    for (const m of this.outbox) this.send(m)
    for (const [sid, x] of this.sessions) this.send({ type: 'term-open', sid, kind: x.kind, ref: x.ref, agent: x.S.agent, cli: x.S.cli, cols: x.S.cols, rows: x.S.rows, replay: x.S.buf.slice(-200_000), exited: x.S.exited })
  }
  // whether runs use a terminal here (else headless)
  interactive() { return this.mode !== 'headless' && !!P.load() }

  async handle(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'job') return this.take(msg.job)
    if (msg.type === 'steer') {
      // the server learns at once whether the steer reached the run (received), and later whether the CLI took it (steered)
      const why = this.steer(msg.jobId, msg.steerId, msg.text, msg.by, msg.byId, msg.from)
      this.send(why === true ? { type: 'steer-received', jobId: msg.jobId, steerId: msg.steerId } : { type: 'steer-failed', jobId: msg.jobId, steerId: msg.steerId, reason: why })
      return
    }
    if (msg.type === 'cancel') return this.cancel(msg.jobId)
    // what the CLI's owner typed in a viewer of its terminal (the server sends only the owner's — anyone else's input is dropped there;
    // checked here again) and the size their view wants
    if (msg.type === 'pty-input') { const x = this.sessions.get(String(msg.sid || '')); if (x && (!msg.byId || !this.user?.id || String(msg.byId) === String(this.user.id))) { x.S.write(String(msg.data || '')); x.typedAt = Date.now() } return }
    if (msg.type === 'pty-resize') { const x = this.sessions.get(String(msg.sid || '')); if (x) x.S.resize(msg.cols, msg.rows); return }
    // a participant suggested a prompt for a run of this computer: the person hears of it (main shows a notification); it waits in the run's
    // stack on their screen — nothing goes into the CLI until they put it in
    if (msg.type === 'suggestion') { const st = this.jobs.get(msg.jobId); if (st) this.emit('notice', { kind: 'suggestion', jobId: msg.jobId, activity: st.job.activity, by: String(msg.by || ''), text: String(msg.text || '').slice(0, 300) }); return }
    if (msg.type === 'finished') return this.finished(msg)
  }

  // ---------- a job arrives ----------
  valid(job) {
    if (!job || !UUID.test(String(job.id || ''))) return 'malformed'
    if (!C.CLIS[job.agent]) return 'unknown agent'
    const g = job.git || {}
    if (!g.token || !g.base || !g.branch || !String(g.branch).startsWith('pgpt-agent/') || !UUID.test(String(g.folder?.id || ''))) return 'no folder'
    if (!g.url && !String(g.path || '').startsWith('/api/git/')) return 'no folder'
    if (typeof job.prompt !== 'string' || !job.prompt.trim()) return 'no prompt'
    if (!this.outPath(job)) return 'bad output folder'
    return null
  }
  // the step's output folder inside the work folder (never outside it)
  outPath(job, dir = '/w') {
    const rel = String(job.outDir || '').replace(/\\/g, '/')
    if (!rel || rel.startsWith('/') || rel.split('/').some((p) => p === '..' || p === '.git')) return null
    const p = path.resolve(dir, rel)
    return p.startsWith(path.resolve(dir) + path.sep) ? p : null
  }
  dirFor(job) {
    const key = crypto.createHash('sha1').update(this.server).digest('hex').slice(0, 10)
    return path.join(this.dataDir, 'work', key, `${safePart(job.instId)}-${String(job.git.folder.id).slice(0, 8)}`)
  }

  async take(job) {
    const bad = this.valid(job)
    if (bad) { this.log('[runner] refused a job:', bad); if (UUID.test(String(job?.id || ''))) this.send({ type: 'decline', jobId: job.id, reason: 'invalid' }); return }
    if (this.jobs.has(job.id)) return
    if (this.user?.id && job.person?.id && String(job.person.id) !== String(this.user.id)) { this.send({ type: 'decline', jobId: job.id, reason: 'invalid' }); return }
    const prefs = this.prefs() || {}
    if (prefs.enabled === false) { this.send({ type: 'decline', jobId: job.id, reason: 'disabled' }); return }
    const cap = this.caps[job.agent]
    if (!cap?.installed || cap.runnable === false) { this.send({ type: 'decline', jobId: job.id, reason: 'unable' }); return }
    if (this.jobs.size >= this.maxJobs) { this.send({ type: 'decline', jobId: job.id, reason: 'busy' }); return }
    this.secrets.add(job.git.token)
    const st = { job, phase: 'asking', since: new Date().toISOString(), lines: [], early: [], resume: [], live: [], sent: 0, acked: 0, cancelled: false }
    // the same run again after this app restarted (the server offers it with the CLI's session): it goes on in that session, in the
    // folder as it was left — when this computer still has both
    if (job.resume?.sessionId) {
      const rec = this.record(job.id)
      if (rec && rec.cli === String(job.resume.sessionId) && rec.agent === job.agent && fs.existsSync(path.join(rec.dir || '', '.git'))) st.resumeFrom = rec
    }
    this.jobs.set(job.id, st)
    this.changed()
    if (prefs.ask) {
      let ok = false
      try { ok = await this.askFn(job) } catch { ok = false }
      if (!ok || st.cancelled) { this.jobs.delete(job.id); this.changed(); this.send({ type: 'decline', jobId: job.id, reason: 'declined' }); return }
    }
    st.phase = 'syncing'
    this.send({ type: 'accept', jobId: job.id })
    this.changed()
    // one run at a time in one folder (two steps of an instance side by side): the second waits for the first
    const dir = this.dirFor(job)
    const prev = this.locks.get(dir) || Promise.resolve()
    const done = prev.then(() => this.execute(st, dir)).catch((e) => this.failed(st, e))
    this.locks.set(dir, done.finally(() => { if (this.locks.get(dir) === done) this.locks.delete(dir) }))
    return done
  }

  progress(st, kind, text) {
    const t = String(text || '').trim()
    if (!t) return
    st.lines.push({ kind, text: t.slice(0, 600), at: new Date().toISOString() })
    ;(st.history ||= []).push({ kind, text: t.slice(0, 300) })
    if (st.history.length > 400) st.history.splice(0, st.history.length - 400)
    if (!st.flush) st.flush = setTimeout(() => this.flush(st), FLUSH_MS)
  }
  flush(st) {
    clearTimeout(st.flush); st.flush = null
    if (!st.lines.length) return
    this.send({ type: 'progress', jobId: st.job.id, lines: st.lines.splice(0) })
  }

  // ---------- the run ----------
  async execute(st, dir) {
    const { job } = st
    const lang = job.lang
    const g = job.git
    const url = g.url || `${this.server}${g.path}`
    const auth = { url, token: g.token, base: g.base }
    let start
    if (st.resumeFrom) {
      // (what the run had done is in the folder, uncommitted: nothing is reset)
      start = st.resumeFrom.start
      this.progress(st, 'status', T(lang, '앱이 다시 켜져 같은 세션을 이어서 해요', 'The app is back: going on in the same session'))
    } else {
      this.progress(st, 'status', T(lang, '작업 폴더를 서버와 맞추는 중', 'Bringing the work folder up to date'))
      const first = await G.sync(dir, auth)
      start = await G.branch(dir, g.branch, g.base)
      // right before the CLI starts: the line may have moved while the job waited (a person's yes, the queue, another step)
      const again = await G.sync(dir, auth)
      if (again !== first) {
        start = await G.branch(dir, g.branch, g.base)
        this.progress(st, 'status', T(lang, '앞 단계 결과가 바뀌어 작업 폴더를 다시 맞췄어요', 'Earlier results changed: the work folder was brought up to date again'))
      }
    }
    if (st.cancelled) return this.dropped(st)
    // the company's skills for this work, current from their folders, where this CLI reads them (skills.js)
    for (const k of job.skills || []) if (k?.token) this.secrets.add(k.token)
    const key = crypto.createHash('sha1').update(this.server).digest('hex').slice(0, 10)
    st.skills = await SKL.place({ dir, agent: job.agent, skills: job.skills || [], server: this.server, cacheRoot: path.join(this.dataDir, 'skills', key), lang, log: (m) => this.log(m) })
    if (st.skills.names.length) this.progress(st, 'status', T(lang, `스킬 ${st.skills.names.length}개를 받았어요: ${st.skills.names.join(', ')}`, `Got ${st.skills.names.length} skill(s): ${st.skills.names.join(', ')}`))
    if (st.resumeFrom?.outDir) job.outDir = st.resumeFrom.outDir
    const out = this.outPath(job, dir)
    fs.mkdirSync(out, { recursive: true })
    st.dir = dir
    try { st.realDir = fs.realpathSync(dir) } catch { st.realDir = null }
    st.start = start
    st.phase = 'running'
    this.changed()
    if (this.interactive()) {
      const r = await this.runInteractive(st)
      return this.finish(st, r)
    }
    if (job.agent === 'claude-code') { st.session = crypto.randomUUID(); this.send({ type: 'session', jobId: job.id, sessionId: st.session }) }
    // steers that came before the CLI started are part of its first message
    const early = st.early.splice(0)
    let prompt = job.prompt
    if (early.length) prompt += `\n\n${early.map((s) => this.steerText(job, s.text, s.by)).join('\n\n')}`
    this.progress(st, 'status', T(lang, `${job.label || job.agent} 시작`, `${job.label || job.agent} started`))
    for (const s of early) this.send({ type: 'steered', jobId: job.id, steerId: s.steerId, how: 'before-start' })
    ;(st.steered ||= []).push(...early.map((s) => ({ ...s, how: 'before-start', histAt: (st.history || []).length })))
    let r = await this.spawnCli(st, 'start', prompt)
    while (!st.cancelled && st.resume.length) {
      const next = st.resume.splice(0)
      const words = next.map((s) => this.steerText(job, s.text, s.by)).join('\n\n')
      // (stopped before it said which session it is: it starts again with the steer after the prompt)
      const how = st.session ? 'resume' : 'restart'
      ;(st.steered ||= []).push(...next.map((s) => ({ ...s, how, histAt: (st.history || []).length })))
      for (const s of next) this.send({ type: 'steered', jobId: job.id, steerId: s.steerId, how })
      this.progress(st, 'steer', how === 'resume' ? T(lang, '방향을 바꿔 같은 세션을 이어서 실행해요', 'Going on in the same session with the new direction')
        : T(lang, '방향을 바꿔 다시 시작해요', 'Starting again with the new direction'))
      r = how === 'resume' ? await this.spawnCli(st, 'resume', words) : await this.spawnCli(st, 'start', `${prompt}\n\n${words}`)
    }
    return this.finish(st, r)
  }

  // the run ended: the step's own note in its output folder, then everything goes back as the run's branch
  async finish(st, r) {
    const { job } = st
    const lang = job.lang
    const g = job.git
    const dir = st.dir
    const out = this.outPath(job, dir)
    const start = st.start
    if (st.cancelled) return this.dropped(st)
    if (!r.ok) throw new Error(r.why || T(lang, `${job.label || job.agent} 가 끝내지 못했어요`, `${job.label || job.agent} did not finish`))
    const summary = (st.summary || '').trim()
    fs.writeFileSync(path.join(out, String(job.resultFile || (lang === 'en' ? 'result.md' : '결과.md')).replace(/[\\/]/g, '_')), this.resultMd(st, summary))
    fs.rmSync(path.join(dir, '.tmp'), { recursive: true, force: true })
    st.phase = 'pushing'
    this.changed()
    this.flush(st)
    const commit = await G.commit(dir, `${job.activity || 'step'} — ${job.label || job.agent}`, { name: job.person?.name, email: job.person?.email })
    const files = await G.changed(dir, start)
    const pushed = files.length ? await G.push(dir, g.branch, { token: g.token }) : false
    this.report(st, { type: 'done', jobId: job.id, branch: g.branch, commit, pushed, files, summary, sessionId: st.session || null,
      agentVersion: this.caps[job.agent]?.version || null, knowhow: this.learned(st), terminal: !!st.term })
    this.forget(job.id)
  }

  // ---------- the interactive CLI (a terminal) ----------
  // One session of the person's CLI for the step, relayed as kind 'step'. The prompt goes in as a person would paste it once the CLI can
  // take input; the step is done when the CLI says its turn ended (its own hook or transcript) and nothing new comes for a moment.
  runInteractive(st) {
    const { job } = st
    const lang = job.lang
    const resume = st.resumeFrom?.cli || null
    const prompt = resume
      ? T(lang, '이 앱이 다시 켜져서 같은 세션을 이어서 해요. 하던 일을 마저 끝내세요.', 'This app was restarted and this session goes on. Finish the work you were doing.')
      : job.prompt
    return new Promise((resolve) => {
      let S
      const end = (r) => { if (st.ending) return; st.ending = true; clearTimeout(st.settle); clearTimeout(st.runTimer); resolve(r) }
      st.endRun = end
      try {
        S = this.openSession({ kind: 'step', ref: job.id, agent: job.agent, cwd: st.dir, resume, prompt, lang,
          stateDir: path.join(this.dataDir, 'sessions', safePart(job.id, 40)), start: false })
      } catch (e) { return resolve({ ok: false, why: e.message }) }
      st.term = S
      st.runTimer = setTimeout(() => { st.timedOut = true; end({ ok: false, why: T(lang, `실행이 ${Math.round(this.runMs / 60000)}분을 넘어 멈췄어요`, `The run went over ${Math.round(this.runMs / 60000)} minutes and was stopped`) }) }, this.runMs)
      S.on('session', (id) => {
        if (!id || id === st.session) return
        st.session = id
        this.send({ type: 'session', jobId: job.id, sessionId: id })
        this.remember(job.id, { cli: id, agent: job.agent, dir: st.dir, start: st.start, outDir: job.outDir })
      })
      S.on('ready', () => {
        this.progress(st, 'status', T(lang, `${job.label || job.agent} 시작`, `${job.label || job.agent} started`))
        // steers that came before it could take input follow the prompt, in order
        for (const s of st.early.splice(0)) this.typeSteer(st, s)
      })
      S.on('text', ({ text }) => { st.lastText = text; this.progress(st, 'text', text) })
      S.on('tool', ({ name, brief }) => this.progress(st, 'tool', `${name}${brief ? ` · ${this.rel(st, brief)}` : ''}`))
      S.on('prompt', ({ text }) => this.applied(st, text))
      S.on('turn-start', () => { clearTimeout(st.settle); st.turnEnded = 0 })
      S.on('turn-end', ({ summary }) => {
        if (summary) st.summary = summary
        st.turnEnded = Date.now()
        this.settle(st)
      })
      S.on('turn-failed', ({ error }) => { this.progress(st, 'error', error); end({ ok: false, why: error }) })
      S.on('attention', ({ message }) => { if (message) { this.progress(st, 'status', message); this.emit('notice', { kind: 'attention', jobId: job.id, activity: job.activity, text: message }) } })
      S.on('exit', ({ code }) => { if (!st.ending) end(st.cancelled ? { ok: false, interrupted: true } : { ok: false, why: T(lang, `${job.label || job.agent} 가 끝났어요 (코드 ${code})`, `${job.label || job.agent} exited (code ${code})`) }) })
      try { S.start() } catch (e) { end({ ok: false, why: e.message }) }
    }).then((r) => { if (st.term && !st.term.exited) st.term.kill(); return r })
  }
  // a turn ended: done when, for a moment, nothing new came — no new turn, every steer typed in is in its transcript, and the person
  // is not typing (a line typed but not sent holds it up to IDLE_FINISH_MS)
  settle(st) {
    clearTimeout(st.settle)
    st.settle = setTimeout(() => {
      if (st.ending || !st.turnEnded) return
      const x = this.sessions.get(st.term?.id)
      const typed = Math.max(st.term?.lastInputAt || 0, x?.typedAt || 0)
      const pending = (st.live || []).some((s) => !s.acked && Date.now() - s.typedAt < ACK_GRACE_MS)
      if (st.term?.busy || pending || (typed > st.turnEnded && Date.now() - typed < this.idleFinishMs)) return this.settle(st)
      st.endRun({ ok: true })
    }, this.settleMs)
  }
  // a steer typed into the terminal as a person would (bracketed paste, Enter); it counts as taken when its words are in the transcript
  typeSteer(st, s) {
    const S = st.term
    if (!S || S.exited) return false
    const text = s.text
    st.live.push({ ...s, typedAt: Date.now(), acked: false })
    S.submit(text)
    return true
  }
  applied(st, text) {
    const t = String(text || '')
    for (const s of st.live || []) {
      if (s.acked) continue
      const head = s.text.trim().slice(0, 80)
      if (head && t.includes(head)) {
        s.acked = true
        this.send({ type: 'steered', jobId: st.job.id, steerId: s.steerId, how: 'live' })
        ;(st.steered ||= []).push({ ...s, how: 'live', histAt: (st.history || []).length })
      }
    }
  }

  // ---------- relayed sessions (generic: a step's run is kind 'step'; other kinds can come — a developer's session in a repo) ----------
  // The PTY's bytes, its hook events and the watched files go to the server over this app's own link (never from the CLI to the server
  // directly); the server relays the screen to every viewer and the owner's typing back here.
  // (start false: the caller listens first, then calls S.start())
  openSession({ kind, ref, agent, cwd, resume = null, prompt = '', stateDir, watch = [], env = {}, start = true }) {
    if (!this.interactive()) throw new Error(`no terminal here: ${P.why() || 'headless mode'}`)
    const S = new CliSession({ agent, cwd, resume, prompt, stateDir, trustRoot: this.dataDir, searchPath: this.searchPath, env: { ...this.sessionEnv, ...env },
      watch, cols: this.size.cols, rows: this.size.rows, log: (m) => this.log(m) })
    const x = { S, kind, ref, out: '', timer: null, typedAt: 0 }
    this.sessions.set(S.id, x)
    const flush = () => { x.timer = null; if (x.out) { this.send({ type: 'pty', sid: S.id, data: x.out }); x.out = '' } }
    S.on('data', (d) => { x.out += d; if (!x.timer) x.timer = setTimeout(flush, OUT_FLUSH_MS) })
    S.on('hook', (h) => this.send({ type: 'hook', sid: S.id, event: h.event, data: h.data }))
    S.on('files', (files) => this.send({ type: 'files', sid: S.id, files }))
    S.on('session', (id) => this.send({ type: 'term-session', sid: S.id, cli: id }))
    S.on('exit', ({ code }) => { flush(); this.send({ type: 'term-exit', sid: S.id, code }); setTimeout(() => this.sessions.delete(S.id), 1000).unref?.() })
    const announce = () => this.send({ type: 'term-open', sid: S.id, kind, ref, agent, cli: S.cli || resume || null, cols: S.cols, rows: S.rows })
    // (announced when it starts: its CLI session id is known by then)
    const go = S.start.bind(S)
    S.start = () => { const out = go(); announce(); return out }
    if (start) S.start()
    return S
  }

  // what this computer keeps of a running step's session (to go on with it after a restart): the CLI's session, the folder, where it began
  recordFile(jobId) { return path.join(this.dataDir, 'sessions', `${safePart(jobId, 40)}.json`) }
  record(jobId) { try { return JSON.parse(fs.readFileSync(this.recordFile(jobId), 'utf8')) } catch { return null } }
  remember(jobId, rec) { try { fs.mkdirSync(path.dirname(this.recordFile(jobId)), { recursive: true }); fs.writeFileSync(this.recordFile(jobId), JSON.stringify(rec), { mode: 0o600 }) } catch (e) { this.log('[runner] record', e.message) } }
  forget(jobId) { try { fs.rmSync(this.recordFile(jobId), { force: true }) } catch { /* gone */ } }

  // what the run learned, for the server's know-how candidates: each steer (who, how it was taken, what the run did right after it), and
  // what the CLI changed in its skills or wrote into its own memory (skills.js changes)
  learned(st) {
    const steers = (st.steered || []).map((s) => ({ steerId: s.steerId, text: s.text, by: s.by, ...(s.from ? { from: s.from } : {}), how: s.how || null,
      after: (st.history || []).slice(s.histAt || 0).filter((l) => l.kind === 'tool' || l.kind === 'text').slice(0, 6).map((l) => l.text) }))
    const own = st.skills ? SKL.changes({ dir: st.dir, placed: st.skills.placed, agents: st.skills.agents }) : { skills: [], memory: [] }
    return { steers, memory: own.memory, skills: own.skills }
  }

  resultMd(st, summary) {
    const { job } = st
    const en = job.lang === 'en'
    const steers = (st.steered || []).map((s) => `- ${s.by ? `${s.by}: ` : ''}${s.text}`)
    return [`# ${job.activity || ''}`, '',
      `- ${en ? 'Done by' : '한 일'}: ${job.label || job.agent} (${en ? `on ${job.person?.name || 'the assignee'}'s computer` : `${job.person?.name || '담당자'} 님의 컴퓨터`})`,
      `- ${en ? 'Finished' : '끝난 때'}: ${new Date().toISOString()}`,
      ...(steers.length ? ['', `## ${en ? 'Steered while it ran' : '실행 중에 바꾼 방향'}`, '', ...steers] : []),
      '', `## ${en ? 'Summary' : '요약'}`, '', summary || (en ? '(no summary)' : '(요약 없음)'), ''].join('\n')
  }

  steerText(job, text, by) {
    return job.lang === 'en'
      ? `[A person changed the direction while you work${by ? ` (${by})` : ''}] Keep what you have done so far and follow this from now on:\n${text}`
      : `[사람이 실행 중에 방향을 바꿨어요${by ? ` — ${by}` : ''}] 지금까지 한 일을 바탕으로, 이제부터 다음을 따르세요:\n${text}`
  }

  // one CLI process (the first run, or a resume) → {ok, why}
  spawnCli(st, phase, text) {
    const { job } = st
    const spec = C.command(job.agent, { phase, session: st.session, cwd: st.dir })
    const bin = C.which(spec.bin, this.searchPath)
    if (!bin) return Promise.resolve({ ok: false, why: `${spec.bin} not found` })
    const tmp = path.join(st.dir, '.tmp')
    fs.mkdirSync(tmp, { recursive: true })
    return new Promise((resolve) => {
      const child = spawn(bin, spec.args, { cwd: st.dir, env: C.cliEnv({ TMPDIR: tmp, TMP: tmp, TEMP: tmp }, this.searchPath), stdio: ['pipe', 'pipe', 'pipe'] })
      st.child = child
      st.interrupted = false
      st.result = null
      st.stdinOpen = spec.input === 'stream'
      let err = ''
      child.stdin.on('error', () => {})
      if (spec.input === 'stream') { st.sent = 1; st.acked = 0; st.live = []; child.stdin.write(C.userLine(text)) } else child.stdin.end(text)
      const timer = setTimeout(() => { st.timedOut = true; this.kill(child) }, this.runMs)
      this.log(`[runner] ${job.activity}: ${bin} ${spec.args.join(' ')}`)
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        this.emit('raw', { jobId: job.id, phase, line })
        for (const ev of C.parse(job.agent, line)) this.event(st, ev)
      })
      child.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
      child.on('error', (e) => { err += e.message })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        clearTimeout(st.ackTimer)
        st.child = null
        st.stdinOpen = false
        // a Claude Code steer it had not taken when it ended: the same session goes on with it
        for (const s of st.live.filter((x) => !x.acked)) st.resume.push(s)
        st.live = []
        if (st.interrupted) return resolve({ ok: false, interrupted: true })
        if (st.timedOut) return resolve({ ok: false, why: T(job.lang, `실행이 ${Math.round(this.runMs / 60000)}분을 넘어 멈췄어요`, `The run went over ${Math.round(this.runMs / 60000)} minutes and was stopped`) })
        // (Codex: a clean exit is a finished turn even when its last event was not read)
        const ok = code === 0 && (st.result ? !st.result.error : job.agent === 'codex')
        resolve(ok ? { ok: true } : { ok: false, why: (st.result?.error && st.result.text) || st.failure || `exit ${code ?? signal}: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 300)}` })
      })
    })
  }

  event(st, ev) {
    const { job } = st
    if (ev.type === 'session') { if (ev.id && ev.id !== st.session) { st.session = ev.id; this.send({ type: 'session', jobId: job.id, sessionId: ev.id }) } return }
    if (ev.type === 'text') { st.lastText = ev.text; this.progress(st, 'text', ev.text); return }
    if (ev.type === 'tool') { this.progress(st, 'tool', `${ev.name}${ev.brief ? ` · ${this.rel(st, ev.brief)}` : ''}`); return }
    if (ev.type === 'failed') { st.failure = ev.text; this.progress(st, 'error', ev.text); return }
    if (ev.type === 'ack') {
      st.acked++
      // our n-th message taken: a steer waiting for it is in the session now
      for (const s of st.live) if (!s.acked && s.at <= st.acked) { s.acked = true; this.send({ type: 'steered', jobId: job.id, steerId: s.steerId, how: 'live' }); (st.steered ||= []).push({ ...s, how: 'live', histAt: (st.history || []).length }) }
      return
    }
    if (ev.type === 'result') {
      st.result = { text: ev.text, error: ev.error }
      if (ev.text || st.lastText) st.summary = ev.text || st.lastText
      if (job.agent === 'claude-code' && st.child && st.stdinOpen) {
        // every message it was sent was taken: the session is done; a steer not yet taken gets its turn first (with a limit)
        if (st.acked >= st.sent) this.endInput(st)
        else { clearTimeout(st.ackTimer); st.ackTimer = setTimeout(() => this.endInput(st), ACK_GRACE_MS) }
      }
    }
  }
  // a path in the work folder as the folder's own (산출물/… rather than /Users/…/work/…)
  rel(st, text) {
    let t = String(text || '')
    for (const d of [st.dir, st.realDir].filter(Boolean)) t = t.split(`${d}${path.sep}`).join('')
    return t
  }
  endInput(st) { if (st.child && st.stdinOpen) { st.stdinOpen = false; try { st.child.stdin.end() } catch { /* gone */ } } }
  kill(child) {
    try { child.kill('SIGINT') } catch { /* gone */ }
    setTimeout(() => { if (child.exitCode == null && child.signalCode == null) try { child.kill('SIGTERM') } catch { /* gone */ } }, 8000).unref?.()
  }

  // ---------- steering ----------
  steer(jobId, steerId, text, by = '', byId = '', from = '') {
    const st = this.jobs.get(jobId)
    const t = String(text || '').trim()
    if (!st) return 'not-running'
    if (!t) return 'refused'
    if (st.phase === 'pushing' || st.reported) return 'finishing'
    const s = { steerId: String(steerId || ''), text: t.slice(0, 4000), by: String(by || '').slice(0, 60), ...(from ? { from: String(from).slice(0, 60) } : {}) }
    // (only this computer's person puts words in — the server refuses anyone else; a steer from someone else is not expected, and is told)
    if (byId && this.user?.id && String(byId) !== String(this.user.id)) this.emit('notice', { kind: 'steer', jobId, activity: st.job.activity, by: s.by, text: t.slice(0, 300) })
    this.log(`[runner] ${st.job.activity}: steer from ${s.by || 'someone'} — ${t.slice(0, 200)}`)
    this.progress(st, 'steer', t)
    // the terminal: typed in as the person would (before the CLI can take input, it waits right behind the prompt)
    if (st.term || (this.interactive() && !st.child)) {
      if (st.term?.ready && !st.term.exited) this.typeSteer(st, s)
      else if (st.term?.exited) return 'finishing'
      else st.early.push(s)
      return true
    }
    if (!st.child) { (st.session ? st.resume : st.early).push(s); return true }
    if (st.job.agent === 'claude-code' && st.stdinOpen) {
      // into the running session: it takes it at its next step (acknowledged by its replay)
      st.sent++
      st.live.push({ ...s, at: st.sent })
      clearTimeout(st.ackTimer)
      st.child.stdin.write(C.userLine(this.steerText(st.job, s.text, s.by)))
      return true
    }
    // Codex (no input while it runs), or a session already closing: stop it and go on in the same session with the steer
    st.resume.push(s)
    if (st.job.agent !== 'claude-code' && st.child) { st.interrupted = true; this.kill(st.child) }
    return true
  }

  cancel(jobId) {
    const st = this.jobs.get(jobId)
    if (!st) return
    st.cancelled = true
    if (st.child) { st.interrupted = true; this.kill(st.child) }
    if (st.term) st.term.kill()
    this.forget(jobId)
  }
  dropped(st) { this.log(`[runner] ${st.job.activity}: cancelled`); this.jobs.delete(st.job.id); this.changed() }

  failed(st, e) {
    if (st.cancelled) return this.dropped(st)
    this.log(`[runner] ${st.job.activity}: ${e.message}`)
    this.progress(st, 'error', e.message)
    this.flush(st)
    this.report(st, { type: 'failed', jobId: st.job.id, error: String(e.message).slice(0, 800) })
  }

  // what finished stays in the outbox until the server confirms it ('finished')
  report(st, msg) {
    st.reported = true
    st.phase = msg.type === 'done' ? 'done' : 'failed'
    this.outbox = [...this.outbox.filter((m) => m.jobId !== msg.jobId), msg]
    this.saveOutbox()
    this.send(msg)
    this.changed()
  }
  saveOutbox() {
    try { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(this.outboxFile, JSON.stringify(this.outbox), { mode: 0o600 }) } catch (e) { this.log('[runner] outbox', e.message) }
  }

  async finished(msg) {
    this.outbox = this.outbox.filter((m) => m.jobId !== msg.jobId)
    this.saveOutbox()
    const st = this.jobs.get(msg.jobId)
    if (!st) return
    this.jobs.delete(msg.jobId)
    this.changed()
    // the folder follows the line the server just moved (the next step on this computer starts there)
    if (msg.state === 'done' && st.dir && st.job.git.line) {
      await G.follow(st.dir, { token: st.job.git.token, base: st.job.git.line }).catch((e) => this.log('[runner] follow', e.message))
    }
    this.emit('finished', { jobId: msg.jobId, state: msg.state })
  }

  // the app quits: what runs stops (the server offers it again when the app is back)
  // (a terminal's session is kept on this computer — sessions/<job>.json — so the run goes on in it when the server offers it again)
  stop() { for (const st of this.jobs.values()) { st.cancelled = true; if (st.child) this.kill(st.child); if (st.term) st.term.kill() } }
}

module.exports = { Runner }
