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
// A job of kind 'chat' (0.2.2 — server lib/localAgents/chat.js) is a chat message for this person's CLI: the same run, with a folder per
// chat (the person's own folder, or a project's), the chat's CLI session resumed when this computer still has it (a record per chat), its
// first message the person's own words, and at each turn's end the turn's files committed and pushed and the CLI's last words sent back
// ('reply') — no step note, no result file, no skills.
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { EventEmitter } = require('node:events')
const C = require('./clis')
const G = require('./git')
const SKL = require('./skills')
const RS = require('./runSettings')
const P = require('./pty')
const { CliSession, tookFirst, cliRecordOf, sizeOf, PROMPT_POINTER } = require('./session')
const { settleState, finishMsOf } = require('./settle')

const RUN_MS = 60 * 60_000
const FLUSH_MS = 800
const ACK_GRACE_MS = 20_000
// after the CLI says a turn ended the run waits for the people on the instance (settle.js): finishMs without anything new — a
// suggestion, an input, the owner typing, a new turn — and it ends (default 5 minutes: the desktop setting, or PGL_RUNNER_SETTLE_MS),
// or at once when the owner presses 「끝내기」
const OUT_FLUSH_MS = 40
const TX_FLUSH_MS = 120
// the conversation items a session keeps here (to announce again with its terminal when the link comes back — a restarted server)
const TX_KEEP = 600
// how long a job waits for the server to confirm it is still this desktop's (accept → accepted) before it is let go (the server offers it
// again); how long a finished run keeps its folder for the server's 'finished' and the follow of the line, at most
const ACCEPT_MS = Number(process.env.PGL_RUNNER_ACCEPT_MS || 60_000)
const HOLD_MS = 10 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const safePart = (s, n = 24) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '').slice(-n) || 'x'
const T = (lang, ko, en) => (lang === 'en' ? en : ko)
// a run refused because the folder's run settings could not all be found and left off (runSettings.js Incomplete) — what the chat shows
function refusedWhy(lang, e) {
  const at = String(e.detail || '').split(':')[0].slice(0, 200)
  const why = {
    list: T(lang, '작업 폴더의 파일 목록을 읽지 못했어요', "the work folder's files could not be listed"),
    link: T(lang, `${at}이(가) 다른 폴더로 연결되어 있어 그 안을 확인할 수 없어요`, `${at} leads to another folder, whose files cannot be checked`),
    inner: T(lang, `작업 폴더 안의 다른 저장소(${at})에 파일이 너무 많아요`, `the repository inside the work folder (${at}) has too many files`),
    write: T(lang, `${at} 파일에서 실행 설정을 지우려 했지만 변경 내용을 저장하지 못했어요`, `${at} could not be rewritten`),
  }[e.why] || e.message
  return T(lang, `이 템플릿 작업 폴더의 실행 설정을 모두 찾아 끌 수 있는지 확인하지 못해 실행하지 않았어요 — ${why}`,
    `Not run: the run settings in this template's work folder could not all be found and left off — ${why}`)
}
// a chat's own name on this computer (its folder, its session record): its key, hashed (a thread id and a conversation's)
const chatHash = (job) => crypto.createHash('sha1').update(String(job.chat?.key || job.id)).digest('hex').slice(0, 16)
// a chat's message as its CLI took it, kept in the run's record by its length and hash (not its words) — an empty one is no mark (nothing
// after it could be told apart from the message itself)
const markOf = (s) => { const t = String(s || ''); return t ? { n: t.length, h: crypto.createHash('sha1').update(t).digest('hex').slice(0, 16) } : undefined }
// what of a chat's message came after what its CLI took (words the server added while the run waited in its queue): the rest only — ''
// when nothing came after, when there is no mark, or when the message does not begin with the one taken
function newWords(message, mark) {
  const t = String(message || '')
  if (!mark || !Number.isInteger(mark.n) || mark.n <= 0 || t.length <= mark.n) return ''
  return markOf(t.slice(0, mark.n))?.h === mark.h ? t.slice(mark.n).trim() : ''
}
// a file written whole or not at all (a run's record read after a crash is never half of one): a file beside it, then renamed over it
// (Windows: a rename over a file another process has open fails for a moment — tried again)
function writeWhole(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return } catch (e) {
      if (process.platform !== 'win32' || i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }) } catch { /* gone */ } throw e }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}
// A run's record nothing wrote to for RECORD_DAYS (the app was off that long, or the server never offered the run again) keeps only what
// the run needs to go on in its session — never the CLI's words (its last words, unconfirmed answers) — and its session's folder (hooks
// file: the CLI's last words) goes; after RECORD_KEEP_DAYS the record goes too. (The server keeps a running run while its desktop is off:
// it may well offer it again after a week — the record then still says the CLI took the first message.)
const RECORD_DAYS = 7
const RECORD_KEEP_DAYS = 90
const RESUME_FIELDS = ['cli', 'agent', 'dir', 'start', 'outDir', 'given', 'turn', 'turns', 'resumed', 'txFrom', 'txFile', 'leftOff']
// paths git leaves out of the folder's commits (.git/info/exclude), added once
function excludeIn(dir, list) {
  const f = path.join(dir, '.git', 'info', 'exclude')
  let have = ''
  try { have = fs.readFileSync(f, 'utf8') } catch { /* none yet */ }
  const missing = list.filter((x) => !have.split('\n').includes(x))
  if (missing.length) fs.appendFileSync(f, `\n${missing.join('\n')}\n`)
}

class Runner extends EventEmitter {
  // dataDir: the app's data folder (work folders and the outbox live under it) · server: the Lite base address (the folder's git path is
  // joined to it) · prefs(): {enabled, ask} · ask(job): the person's yes before a run (prefs.ask) · caps: from clis.detect
  // mode: 'auto' (a terminal when node-pty loads) | 'headless' · sessionEnv: extra environment for the CLI (e.g. its config folder)
  constructor({ dataDir, server, prefs = () => ({ enabled: true, ask: false }), ask = async () => true, searchPath = C.augmentedPath(), maxJobs = 2,
    log = () => {}, runMs = RUN_MS, caps = {}, mode = process.env.PGL_RUNNER_MODE || 'auto', sessionEnv = {}, settleMs = null,
    cols = 80, rows = 28 } = {}) {
    super()
    this.mode = mode
    this.sessionEnv = sessionEnv
    // (null: the person's desktop setting, read at each wait — prefs().finishMinutes)
    this.settleMs = settleMs
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
    this.sweep()
  }
  // runs' records and their sessions' folders nothing touched for a while (RECORD_DAYS — the words go; RECORD_KEEP_DAYS — the record goes).
  // The chats' own records (which CLI session a chat goes on with — no words) stay.
  sweep({ days = RECORD_DAYS, keepDays = RECORD_KEEP_DAYS } = {}) {
    const dir = path.join(this.dataDir, 'sessions')
    const words = Date.now() - days * 86400_000
    const gone = Date.now() - keepDays * 86400_000
    let names = []
    try { names = fs.readdirSync(dir) } catch { return }
    for (const n of names) {
      if (!UUID.test(n.replace(/\.json(\..+\.tmp)?$/, ''))) continue
      const p = path.join(dir, n)
      try {
        const s = fs.statSync(p)
        let last = s.mtimeMs
        if (s.isDirectory()) for (const f of fs.readdirSync(p)) { try { last = Math.max(last, fs.statSync(path.join(p, f)).mtimeMs) } catch { /* gone */ } }
        // (a session's folder, a half-written file: the words in them go)
        if (s.isDirectory() || n.endsWith('.tmp')) { if (last < words) fs.rmSync(p, { recursive: true, force: true }); continue }
        if (last < gone) { fs.rmSync(p, { force: true }); continue }
        if (last >= words) continue
        let rec = null
        try { rec = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* not a record */ }
        if (!rec || typeof rec !== 'object' || !Object.keys(rec).some((k) => !RESUME_FIELDS.includes(k))) continue
        writeWhole(p, JSON.stringify(Object.fromEntries(RESUME_FIELDS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]))))
        // (when it was last written stays: the record goes RECORD_KEEP_DAYS after that)
        fs.utimesSync(p, s.atime, s.mtime)
      } catch { /* gone */ }
    }
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
    // (a chat's answers the server has not acknowledged: said again, before any report — the server takes each turn once, and no answer
    // after the run is over)
    for (const st of this.jobs.values()) for (const m of st.replies?.values() || []) this.send(m)
    for (const m of this.outbox) this.send(m)
    // (an accept the server may not have got: said again — its answer starts the run)
    for (const st of this.jobs.values()) if (st.awaiting) this.send({ type: 'accept', jobId: st.job.id })
    for (const [sid, x] of this.sessions) this.announce(sid, x)
    for (const st of this.jobs.values()) if (st.idleUntil) this.send({ type: 'idle', jobId: st.job.id, until: new Date(st.idleUntil).toISOString() })
  }
  // an open terminal said again: the screen so far and the conversation with it (the server builds its copy from them)
  announce(sid, x) {
    this.send({ type: 'term-open', sid, kind: x.kind, ref: x.ref, agent: x.S.agent, cli: x.S.cli, cols: x.S.cols, rows: x.S.rows, replay: x.S.buf.slice(-200_000), exited: x.S.exited })
    if (x.tx.length) this.send({ type: 'tx', sid, items: x.tx, replay: true })
  }
  // The server offers a run this app still has — its CLI session is alive here: the run stays as it is (nothing goes into the CLI again).
  // It is this desktop's again (accept), its terminal is announced again and its wait; a run already over says its report again. Words the
  // server added to a chat's message meanwhile (it held the run in its queue) go in as the person's input.
  again(job) {
    const jobId = job.id
    const st = this.jobs.get(jobId)
    if (!st || st.cancelled || st.phase === 'asking') return
    if (st.reported) { const m = this.outbox.find((o) => o.jobId === jobId); if (m) this.send(m); return }
    this.send({ type: 'accept', jobId })
    if (st.job.kind === 'chat') {
      const more = newWords(job.message, markOf(st.job.message))
      if (more) {
        st.job.message = String(job.message)
        if (typeof job.prompt === 'string' && job.prompt.trim()) st.job.prompt = job.prompt
        // (a CLI not started yet takes them with its first message — firstWords reads the run's message then)
        if (st.term && !st.term.exited) { if (st.term.ready) this.typeSteer(st, { steerId: '', text: more }); else st.early.push({ steerId: '', text: more }) }
      }
    }
    const x = st.term ? this.sessions.get(st.term.id) : null
    if (x) this.announce(st.term.id, x)
    if (st.idleUntil) this.send({ type: 'idle', jobId, until: new Date(st.idleUntil).toISOString() })
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
    // the server confirms the job is this desktop's: now it runs
    if (msg.type === 'accepted') { const st = this.jobs.get(msg.jobId); if (st?.awaiting) st.awaiting(true); return }
    // what the CLI's owner typed in a viewer of its terminal (the server sends only the owner's — anyone else's input is dropped there;
    // checked here again) and the size their view wants
    if (msg.type === 'pty-input') { const x = this.sessions.get(String(msg.sid || '')); if (x && this.owns(msg.byId)) { x.S.write(String(msg.data || '')); x.typedAt = Date.now(); this.stirred(x) } return }
    if (msg.type === 'pty-resize') { const x = this.sessions.get(String(msg.sid || '')); if (x) x.S.resize(msg.cols, msg.rows); return }
    // the owner's answer to what the CLI asks (a permission, a choice) — pressed on a card of the conversation: the keys go into the PTY
    // while that ask is still open (session.answer)
    if (msg.type === 'pty-answer') {
      const x = this.sessions.get(String(msg.sid || ''))
      if (!x || !this.owns(msg.byId)) return
      const r = x.S.answer(msg.ask, msg.answer, String(msg.by || ''))
      if (r !== true) this.send({ type: 'answer-failed', sid: x.S.id, ask: String(msg.ask || ''), reason: r })
      else { x.typedAt = Date.now(); this.stirred(x) }
      return
    }
    // a participant suggested a prompt for a run of this computer: the person hears of it (main shows a notification); it waits in the run's
    // stack on their screen — nothing goes into the CLI until they put it in. The run waits on for it (settle.js).
    if (msg.type === 'suggestion') {
      const st = this.jobs.get(msg.jobId)
      if (st) { st.lastInput = Date.now(); if (st.turnEnded) this.settle(st); this.emit('notice', { kind: 'suggestion', jobId: msg.jobId, activity: st.job.activity, by: String(msg.by || ''), text: String(msg.text || '').slice(0, 300) }) }
      return
    }
    // the owner pressed 「끝내기」: the run ends now (after the turn at hand, when the CLI is working)
    if (msg.type === 'finish') { const st = this.jobs.get(msg.jobId); if (st?.term && !st.ending) { st.finishNow = true; this.settle(st) } return }
    if (msg.type === 'finished') return this.finished(msg)
    // the server took a chat's answer in (its turn): not said again — and no longer kept in the run's record
    if (msg.type === 'replied') {
      const st = this.jobs.get(msg.jobId)
      if (st?.replies?.delete(Number(msg.turn))) this.keepReplies(st)
      // (one kept with the run's report, in the outbox)
      const left = this.outbox.filter((m) => !(m.type === 'reply' && m.jobId === msg.jobId && Number(m.turn) === Number(msg.turn)))
      if (left.length !== this.outbox.length) { this.outbox = left; this.saveOutbox() }
      return
    }
  }

  // ---------- a job arrives ----------
  valid(job) {
    if (!job || !UUID.test(String(job.id || ''))) return 'malformed'
    if (!C.CLIS[job.agent]) return 'unknown agent'
    const g = job.git || {}
    if (!g.token || !g.base || !g.branch || !String(g.branch).startsWith('pgpt-agent/') || !UUID.test(String(g.folder?.id || ''))) return 'no folder'
    if (!g.url && !/^\/api\/(local-)?git\//.test(String(g.path || ''))) return 'no folder'
    if (typeof job.prompt !== 'string' || !job.prompt.trim()) return 'no prompt'
    if (job.kind === 'chat') return typeof job.chat?.key === 'string' && job.chat.key ? null : 'no chat'
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
    // (a chat: one folder per chat and folder — its CLI session lives on in it, so the next run resumes it there)
    if (job.kind === 'chat') return path.join(this.dataDir, 'work', key, `chat-${chatHash(job)}-${String(job.git.folder.id).slice(0, 8)}`)
    return path.join(this.dataDir, 'work', key, `${safePart(job.instId)}-${String(job.git.folder.id).slice(0, 8)}`)
  }

  async take(job) {
    const bad = this.valid(job)
    if (bad) { this.log('[runner] refused a job:', bad); if (UUID.test(String(job?.id || ''))) this.send({ type: 'decline', jobId: job.id, reason: 'invalid' }); return }
    if (this.jobs.has(job.id)) return this.again(job)
    if (this.user?.id && job.person?.id && String(job.person.id) !== String(this.user.id)) { this.send({ type: 'decline', jobId: job.id, reason: 'invalid' }); return }
    const prefs = this.prefs() || {}
    if (prefs.enabled === false) { this.send({ type: 'decline', jobId: job.id, reason: 'disabled' }); return }
    const cap = this.caps[job.agent]
    if (!cap?.installed || cap.runnable === false) { this.send({ type: 'decline', jobId: job.id, reason: 'unable' }); return }
    if (this.jobs.size >= this.maxJobs) { this.send({ type: 'decline', jobId: job.id, reason: 'busy' }); return }
    this.secrets.add(job.git.token)
    const st = { job, phase: 'asking', since: new Date().toISOString(), lines: [], early: [], resume: [], live: [], sent: 0, acked: 0, cancelled: false }
    // (released when the server took the result in and the folder followed the line — or the run was let go)
    st.released = new Promise((res) => { st.release = res })
    // the same run again after this app restarted (the server offers it with the CLI's session): it goes on in that session, in the
    // folder as it was left — when this computer still has both
    if (job.resume?.sessionId) {
      // (a chat: this run's own record after a restart, else the chat's — its last run's session, in the same folder)
      const own = this.record(job.id)
      const rec = own || (job.kind === 'chat' ? this.chatRecord(job) : null)
      const here = job.kind !== 'chat' || (rec && path.resolve(rec.dir || '') === path.resolve(this.dirFor(job)))
      if (rec && here && rec.cli === String(job.resume.sessionId) && rec.agent === job.agent && fs.existsSync(path.join(rec.dir || '', '.git'))) {
        let from = { ...rec, own: rec === own }
        if (from.own && from.given === false) {
          // (the record says the CLI never took the run's first message — but the app may have gone off after the CLI took it and before
          // its hook was read: the CLI's own record of the session, after where it stood at the start, tells — then it was working. Only
          // that message counts there, not a command typed in its terminal.)
          const t = tookFirst({ agent: job.agent, cli: rec.cli, env: C.cliEnv(this.sessionEnv, this.searchPath), from: rec.txFrom || 0, file: rec.txFile || null,
            texts: [job.prompt, job.message, PROMPT_POINTER] })
          if (t.took === 'took') from = { ...from, given: true, turn: 'working' }
          // (the CLI's record is not what it was — another file, or shorter: whether it took it cannot be told. The first message goes in
          // again — losing it would be worse than saying it twice — in the same session, so the CLI sees what it did before)
          else if (t.took === 'unknown' && t.exists) from = { ...from, keepSession: true }
        }
        // (this run's own session, whose CLI never took the run's first message — the app went off before: the run starts as a new one,
        // its first message given then; a session it went on with — a chat's earlier one — goes on)
        if (from.own && from.given === false && !from.resumed && !from.keepSession) this.log(`[runner] ${job.activity}: its first message never got in — started anew`)
        else st.resumeFrom = from
      }
    }
    this.jobs.set(job.id, st)
    this.changed()
    // (a chat message is its person's own request, just sent from their chat: not asked about again)
    if (prefs.ask && job.kind !== 'chat') {
      let ok = false
      try { ok = await this.askFn(job) } catch { ok = false }
      if (!ok || st.cancelled) { this.jobs.delete(job.id); this.changed(); this.send({ type: 'decline', jobId: job.id, reason: 'declined' }); return }
    }
    // nothing is touched until the server says the job is still this desktop's (it may have been handed elsewhere meanwhile — a link
    // that blinked, an offer that ran out): accept → accepted, or cancel
    const ok = await new Promise((res) => {
      const timer = setTimeout(() => res(false), ACCEPT_MS)
      st.awaiting = (yes) => { clearTimeout(timer); st.awaiting = null; res(yes) }
      this.send({ type: 'accept', jobId: job.id })
    })
    if (!ok || st.cancelled) { this.log(`[runner] ${job.activity}: not confirmed by the server — let go`); st.release(); this.jobs.delete(job.id); this.changed(); return }
    st.phase = 'syncing'
    this.changed()
    // one run at a time in one folder (two steps of an instance side by side): the second waits until the first is taken in and its
    // folder followed the line (finished) — never while the first's follow checks the folder out
    const dir = this.dirFor(job)
    const prev = this.locks.get(dir) || Promise.resolve()
    const done = prev.then(() => this.execute(st, dir)).catch((e) => this.failed(st, e))
    const held = done.then(() => Promise.race([st.released, new Promise((res) => { const t = setTimeout(res, HOLD_MS); t.unref?.() })]))
    this.locks.set(dir, held.finally(() => { if (this.locks.get(dir) === held) this.locks.delete(dir) }))
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
    const chat = job.kind === 'chat'
    let start
    // the same run after this app restarted (a step, or a chat's own run): the folder as it was left — what the run had done is there,
    // uncommitted (a turn cut off, a turn's commit not pushed yet): nothing is reset. (A chat's next run resumes the chat's CLI session,
    // never its folder: each turn was committed and pushed, so that folder starts from the line again.)
    const from = st.resumeFrom
    let kept = !!(from && (!chat || from.own) && from.start)
    // (a chat's record an older app wrote — no given — or a template run's that does not say which files it left off: on the line, as
    // that app did — a kept folder's left-off files would otherwise go back changed)
    if (kept && chat && (typeof from.given !== 'boolean' || (job.projectSettings === false && !Array.isArray(from.leftOff)))) kept = false
    // (another run may have used the folder meanwhile — a chat's Claude Code and Codex share it: it is still this run's only when it is on
    // the run's branch with where the run began in its history; else it starts on the line, and the CLI is told)
    if (kept && !(await G.stillOn(dir, g.branch, from.start).catch(() => false))) {
      kept = false
      if (from.given) st.folderNote = T(lang, '[알림] 앱이 다시 켜지는 사이 이 작업 폴더를 다른 실행이 썼어요. 그래서 서버에 있는 상태로 다시 맞췄어요. 아직 올리지 않았던 파일은 없을 수 있으니 확인하고 이어서 하세요.',
        '[Note] While the app was restarting, another run used this work folder, so it was brought back to what the server has. Files not pushed yet may be missing — check before you go on.')
      this.log(`[runner] ${job.activity}: the folder was used by another run meanwhile — started on the line`)
    }
    if (kept) {
      start = from.start
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
    if (chat) {
      // the CLI's own places (its settings, a trust or permission it keeps per folder) and the app's are never committed into the folder
      excludeIn(dir, ['.claude/', '.codex/', '.pgl-run/', '.tmp/'])
      // the folder's own run settings, for a person who may not edit the folder: left off for this run (runSettings.js — the server tells
      // the person in the chat), never committed back; when they cannot all be found, the run is refused, never started with them on
      let off = { paths: [], files: [], front: [] }
      if (job.projectSettings === false) {
        try { off = await RS.leaveOff(dir) } catch (e) { throw e.code === 'RUN_SETTINGS_INCOMPLETE' ? new Error(refusedWhy(lang, e)) : e }
      }
      // (a kept folder: the files left off before are left off still — leaveOff finds nothing more to change in them now)
      st.leftOff = kept && Array.isArray(from.leftOff) ? [...new Set([...from.leftOff, ...off.paths])] : off.paths
      if (st.leftOff.length) this.log(`[runner] ${job.activity}: the folder's run settings left off — ${off.files.join(', ')}${off.front.length ? ` · front matter of ${off.front.length} file(s)` : ''}`)
      st.dir = dir
      try { st.realDir = fs.realpathSync(dir) } catch { st.realDir = null }
      st.start = start
      st.phase = 'running'
      this.changed()
      if (!this.interactive()) throw new Error(T(lang, '이 PC 에서는 터미널을 열 수 없어 채팅 에이전트를 실행하지 못해요', 'No terminal can be opened on this computer, so the chat agent cannot run'))
      return this.finish(st, await this.runInteractive(st))
    }
    // the company's skills for this work, current from their folders, where this CLI reads them (skills.js)
    for (const k of job.skills || []) if (k?.token) this.secrets.add(k.token)
    const key = crypto.createHash('sha1').update(this.server).digest('hex').slice(0, 10)
    st.skills = await SKL.place({ dir, agent: job.agent, skills: job.skills || [], server: this.server, cacheRoot: path.join(this.dataDir, 'skills', key), lang, log: (m) => this.log(m) })
    if (st.skills.names.length) this.progress(st, 'status', T(lang, `스킬 ${st.skills.names.length}개를 받았어요: ${st.skills.names.join(', ')}`, `Got ${st.skills.names.length} skill(s): ${st.skills.names.join(', ')}`))
    for (const n of st.skills.skipped || []) this.progress(st, 'status', T(lang, `스킬 「${n}」은 작업 폴더에 같은 자리의 스킬이 있어 그것을 써요`, `Skill "${n}": the work folder has its own there — that one is used`))
    // (Codex in a folder with its own AGENTS.md: the pointer to the skills goes with the prompt)
    if (st.skills.pointer) job.prompt = `${job.prompt}\n\n${st.skills.pointer}`
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
    const start = st.start
    if (st.cancelled) return this.dropped(st)
    if (!r.ok) throw new Error(r.why || T(lang, `${job.label || job.agent} 가 끝내지 못했어요`, `${job.label || job.agent} did not finish`))
    if (job.kind === 'chat') return this.finishChat(st)
    const out = this.outPath(job, dir)
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

  // A chat's session ended (the wait after its turn ran out, 「끝내기」): the turns' own commits and pushes first, then what changed after
  // the last one (the owner typed into the terminal), and the report — the chat's record stays: its next run resumes the session
  async finishChat(st) {
    const { job } = st
    const g = job.git
    await (st.gitChain || Promise.resolve()).catch(() => {})
    if (st.cancelled) return this.dropped(st)
    st.phase = 'pushing'
    this.changed()
    this.flush(st)
    fs.rmSync(path.join(st.dir, '.tmp'), { recursive: true, force: true })
    const before = await G.head(st.dir)
    const commit = await G.commit(st.dir, `${job.label || job.agent} — ${job.activity || 'chat'}`, { name: job.person?.name, email: job.person?.email }, { except: st.leftOff || [] })
    const files = commit ? await G.changed(st.dir, before) : []
    const pushed = (await G.changed(st.dir, st.start)).length ? await G.push(st.dir, g.branch, { token: g.token }) : false
    this.report(st, { type: 'done', jobId: job.id, branch: g.branch, commit: commit || before, pushed, files, summary: (st.summary || '').trim(), sessionId: st.session || null,
      agentVersion: this.caps[job.agent]?.version || null, terminal: !!st.term })
    this.forget(job.id)
  }
  // A chat's turn ended: what it changed is committed and pushed on the run's branch, then its last words go to the server with the files
  // ('reply' — kept until the server says it has the turn: a link that drops does not lose an answer). One turn at a time, in order.
  // From the turn's end until the server has it, the turn is kept in the run's record too (keepReplies): an app that goes off before the
  // answer was made — or before it reached the server — makes it, or says it, again when the run comes back (again: that turn, where its
  // commit began).
  chatTurn(st, text, again = null) {
    const { job } = st
    const n = again ? again.turn : (st.turnNo = (st.turnNo || 0) + 1)
    const words = String(text || '').slice(0, 16000)
    st.replies ||= new Map()
    st.pending ||= new Map()
    if (!again) { st.pending.set(n, { turn: n, text: words }); this.keepReplies(st) }
    st.gitChain = (st.gitChain || Promise.resolve()).then(async () => {
      let commit = null
      let files = []
      let pushed = false
      try {
        const before = again?.before || await G.head(st.dir)
        if (!again?.before) { st.pending.set(n, { turn: n, text: words, before }); this.keepReplies(st) }
        commit = await G.commit(st.dir, `${job.label || job.agent} — ${job.activity || 'chat'}`, { name: job.person?.name, email: job.person?.email }, { except: st.leftOff || [] })
        // (a turn made again after a restart: its commit may be there already, not yet pushed)
        const head = commit || (again ? await G.head(st.dir) : null)
        if (head && head !== before) { commit = head; files = await G.changed(st.dir, before); pushed = await G.push(st.dir, job.git.branch, { token: job.git.token }) }
      } catch (e) { this.log(`[runner] ${job.activity}: turn ${n} — ${e.message}`); this.progress(st, 'error', e.message) }
      const m = { type: 'reply', jobId: job.id, turn: n, text: words, branch: job.git.branch, commit, pushed, files }
      st.pending.delete(n)
      st.replies.set(n, m)
      this.keepReplies(st)
      this.send(m)
    }).catch((e) => this.log(`[runner] chat turn: ${e.message}`))
    return st.gitChain
  }
  // the chat's turns the server does not have yet, in the run's record: a turn whose answer is being made (its words, where its commit
  // began), and an answer made but not acknowledged ('replied')
  keepReplies(st) {
    this.mark(st, { replies: [...(st.pending?.values() || []), ...(st.replies?.values() || [])].sort((a, b) => a.turn - b.turn) })
  }
  // after a restart, the chat's own run: what its record kept of turns the server does not have — an answer made is said again, a turn
  // whose answer was not made yet is made now (its files committed and pushed from where its commit began)
  carryReplies(st) {
    const kept = Array.isArray(st.resumeFrom?.replies) && st.resumeFrom.own ? st.resumeFrom.replies : []
    st.replies ||= new Map()
    st.pending ||= new Map()
    for (const r of kept) {
      if (!Number.isInteger(r?.turn)) continue
      if (r.type === 'reply' && r.jobId === st.job.id) st.replies.set(r.turn, r)
      else st.pending.set(r.turn, { turn: r.turn, text: String(r.text || ''), ...(r.before ? { before: String(r.before) } : {}) })
      st.turnNo = Math.max(st.turnNo || 0, r.turn)
    }
    for (const m of st.replies.values()) this.send(m)
    for (const p of [...st.pending.values()]) this.chatTurn(st, p.text, p)
  }

  // ---------- the interactive CLI (a terminal) ----------
  // One session of the person's CLI for the step, relayed as kind 'step'. The prompt goes in as a person would paste it once the CLI can
  // take input; the step is done when the CLI says its turn ended (its own hook or transcript) and nothing new comes for a moment.
  runInteractive(st) {
    const { job } = st
    const lang = job.lang
    const chat = job.kind === 'chat'
    const from = st.resumeFrom
    const resume = from?.cli || null
    const { prompt, wait } = this.firstWords(st)
    // (what this computer keeps of the session — the run's record: carried on from before a restart when it is this run's own; a resumed
    // session is known by its id from the start — Codex says it only for a new one)
    st.rec = from?.own ? { cli: from.cli, given: from.given, turn: from.turn, turns: from.turns, msg: from.msg, summary: from.summary, replies: from.replies, txFrom: from.txFrom,
      txFile: from.txFile, resumed: !!from.resumed } : { given: false, resumed: !!resume, ...(resume ? { cli: resume } : {}) }
    // (the files the run leaves off — a template's run: never committed, after a restart too)
    if (Array.isArray(st.leftOff)) st.rec.leftOff = st.leftOff
    // (where the CLI's own record of the session stood before this run gave it anything, and which file it is: what it took after that is
    // this run's — take)
    if (!Number.isInteger(st.rec.txFrom)) {
      const f = resume ? cliRecordOf({ agent: job.agent, cli: resume, env: C.cliEnv(this.sessionEnv, this.searchPath) }) : null
      st.rec.txFrom = sizeOf(f)
      if (f) st.rec.txFile = f
    }
    if (from?.own) {
      // (a chat's turns go on from their number — the server takes each turn once; the step's or chat's last words before the restart)
      if (chat && Number.isInteger(from.turns)) st.turnNo = from.turns
      if (from.summary) st.summary = from.summary
    }
    // (a chat's turns the server does not have yet: said again, or made now)
    if (chat) this.carryReplies(st)
    return new Promise((resolve) => {
      let S
      const end = (r) => { if (st.ending) return; st.ending = true; clearTimeout(st.settle); clearTimeout(st.runTimer); resolve(r) }
      st.endRun = end
      try {
        S = this.openSession({ kind: chat ? 'chat' : 'step', ref: job.id, agent: job.agent, cwd: st.dir, resume, prompt, lang,
          stateDir: path.join(this.dataDir, 'sessions', safePart(job.id, 40)), start: false,
          // a message the CLI took that was a steer: whose words it was (the conversation shows 「<제안한 사람> 제안 · <작업자> 입력」)
          annotate: (it) => {
            if (it.t !== 'user' || it.first) return it
            const t = String(it.text || '')
            const s = (st.live || []).find((x) => { const head = x.text.trim().slice(0, 80); return head && t.includes(head) })
            return s ? { ...it, steerId: s.steerId, by: s.by || undefined, from: s.from || undefined } : { ...it, by: job.person?.name || undefined }
          } })
      } catch (e) { return resolve({ ok: false, why: e.message }) }
      st.term = S
      // (a chat that went on that long closes as it would after its wait: its next message resumes the session)
      st.runTimer = setTimeout(() => { st.timedOut = true; end(chat ? { ok: true } : { ok: false, why: T(lang, `실행이 ${Math.round(this.runMs / 60000)}분을 넘어 멈췄어요`, `The run went over ${Math.round(this.runMs / 60000)} minutes and was stopped`) }) }, this.runMs)
      S.on('session', (id) => {
        if (!id || id === st.session) return
        st.session = id
        this.send({ type: 'session', jobId: job.id, sessionId: id })
        this.mark(st, { cli: id })
        if (chat) this.rememberChat(job, { cli: id, agent: job.agent, dir: st.dir, at: new Date().toISOString() })
      })
      S.on('ready', () => {
        this.progress(st, 'status', T(lang, `${job.label || job.agent} 시작`, `${job.label || job.agent} started`))
        // steers that came before it could take input follow the prompt, in order
        for (const s of st.early.splice(0)) this.typeSteer(st, s)
        // (its turn had ended before the app went off: it waits for its people again as after that turn — 「끝내기」, or the wait)
        if (wait && !st.turnEnded && !S.busy) { st.turnEnded = Date.now(); this.settle(st) }
      })
      S.on('text', ({ text }) => { st.lastText = text; this.progress(st, 'text', text) })
      S.on('tool', ({ name, brief }) => this.progress(st, 'tool', `${name}${brief ? ` · ${this.rel(st, brief)}` : ''}`))
      S.on('prompt', ({ text }) => this.applied(st, text))
      S.on('turn-start', () => {
        clearTimeout(st.settle); st.turnEnded = 0; this.idle(st, null)
        // (the CLI took a message — the run's first one at the first turn: never given again after a restart)
        this.mark(st, { given: true, turn: 'working', ...(chat ? { msg: markOf(job.message) } : {}) })
      })
      S.on('turn-end', ({ summary }) => {
        if (summary) st.summary = summary
        // (a chat: the answer and the turn's files go back now — the session stays open for the next message)
        if (chat) this.chatTurn(st, summary)
        st.turnEnded = Date.now()
        this.mark(st, { given: true, turn: 'ended', summary: String(st.summary || '').slice(0, 8000) || undefined, ...(chat ? { turns: st.turnNo } : {}) })
        // (the screen as the turn left it: what a viewer sees of the run once it is over — before the CLI clears it on its way out)
        this.sessions.get(S.id)?.keep()
        this.settle(st)
      })
      // (stopped mid-turn — Esc, a refused tool use: it waits for its person as after a turn)
      S.on('turn-interrupted', () => { st.turnEnded = Date.now(); this.mark(st, { turn: 'ended' }); this.settle(st) })
      S.on('turn-failed', ({ error }) => { this.progress(st, 'error', error); end({ ok: false, why: error }) })
      S.on('attention', ({ message }) => { if (message) { this.progress(st, 'status', message); this.emit('notice', { kind: 'attention', jobId: job.id, activity: job.activity, text: message }) } })
      S.on('exit', ({ code }) => { if (!st.ending) end(st.cancelled ? { ok: false, interrupted: true } : { ok: false, why: T(lang, `${job.label || job.agent} 가 끝났어요 (코드 ${code})`, `${job.label || job.agent} exited (code ${code})`) }) })
      try { S.start() } catch (e) { end({ ok: false, why: e.message }) }
    }).then((r) => {
      // (the last screen kept before the CLI is closed — it clears its screen on the way out)
      if (st.term && !st.term.exited) { this.sessions.get(st.term.id)?.keep(); st.term.kill() }
      this.idle(st, null)
      return r
    })
  }
  // What goes into the CLI first, as the person would paste it → {prompt, wait}. A run that starts: its prompt. The chat's next run in the
  // chat's session: the person's words. A run that goes on after this app restarted is judged by its record (sessions/<job>.json — what
  // the CLI did with this run), never by what the words say:
  //   · the CLI never took its first message — that message (a run whose own new session never took it starts anew instead: take)
  //   · the CLI was working when the app went off — a line that says to finish the work (and a chat's words the server added, after it)
  //   · the turn had ended (the run waited for 「끝내기」) — nothing: it waits again (wait); only a chat's words the server added after
  //     the message the CLI took go in
  //   (a record an older app wrote, without these: as that app did)
  firstWords(st) {
    const { job } = st
    const chat = job.kind === 'chat'
    const from = st.resumeFrom
    const goOn = T(job.lang, '이 앱이 다시 켜져서 같은 세션을 이어서 해요. 하던 일을 마저 끝내세요.', 'This app was restarted and this session goes on. Finish the work you were doing.')
    if (!from) return { prompt: job.prompt, wait: false }
    if (!from.own || typeof from.given !== 'boolean') return { prompt: chat ? job.message || job.prompt : goOn, wait: false }
    // (its first message as it was given: the person's words in a session that had the chat before, else the whole prompt)
    if (!from.given) return { prompt: chat && from.resumed ? job.message || job.prompt : job.prompt, wait: false }
    const more = chat ? newWords(job.message, from.msg) : ''
    // (the folder was brought back to the line — another run had used it: the CLI hears that first; with nothing to give now, with the
    // next words it is given — typeSteer)
    const note = st.folderNote ? `${st.folderNote}\n\n` : ''
    if (from.turn === 'working') { st.folderNote = null; return { prompt: `${note}${more ? `${goOn}\n\n${more}` : goOn}`, wait: false } }
    if (more) st.folderNote = null
    return { prompt: more ? `${note}${more}` : '', wait: !more }
  }
  // the run's record (sessions/<job>.json) brought up to date: where its session is, and what the CLI did with the run
  mark(st, patch) {
    st.rec = { ...(st.rec || {}), ...patch }
    const r = st.rec
    // (a run that reported is over: its record went with it — a late answer's acknowledgement does not bring it back)
    if (!r.cli || st.reported) return
    this.remember(st.job.id, { cli: r.cli, agent: st.job.agent, dir: st.dir, start: st.start, outDir: st.job.outDir,
      given: r.given, turn: r.turn, turns: r.turns, msg: r.msg, summary: r.summary, resumed: r.resumed, txFrom: r.txFrom, txFile: r.txFile,
      leftOff: Array.isArray(r.leftOff) ? r.leftOff : undefined, replies: r.replies?.length ? r.replies : undefined })
  }
  // after a turn: the run waits for its people, and ends when nothing new came for finishMs, or when its owner says so (settle.js);
  // the server hears when it would end by itself (the card: 「끝내기」 · 「N분 동안 새 입력이 없으면 저절로 끝나요」)
  finishMs() { return finishMsOf({ explicit: this.settleMs, minutes: (this.prefs() || {}).finishMinutes }) }
  settle(st) {
    clearTimeout(st.settle)
    if (st.ending) return
    const x = this.sessions.get(st.term?.id)
    const now = Date.now()
    const r = settleState({ now, turnEnded: st.turnEnded, busy: !!st.term?.busy, lastInput: st.lastInput || 0,
      typedAt: Math.max(x?.typedAt || 0, st.term?.lastInputAt && st.term.lastInputAt > (st.turnEnded || 0) ? st.term.lastInputAt : 0),
      pending: (st.live || []).some((s) => !s.acked && now - s.typedAt < ACK_GRACE_MS), finishNow: !!st.finishNow, finishMs: this.finishMs() })
    if (r.done) { this.idle(st, null); return st.endRun({ ok: true }) }
    this.idle(st, r.until)
    if (r.check != null) st.settle = setTimeout(() => this.settle(st), Math.max(50, r.check))
  }
  // what the server shows of the wait: until when the run waits by itself (null: it works, or it is over)
  idle(st, until) {
    const v = until ? Math.round(until) : null
    if ((st.idleUntil || null) === v) return
    // (the owner typing moves it with every key: the server hears of it when it moved by a second or more)
    if (v && st.idleUntil && Math.abs(v - st.idleUntil) < 1000) return
    st.idleUntil = v
    this.send({ type: 'idle', jobId: st.job.id, until: v ? new Date(v).toISOString() : null })
  }
  // the owner did something in a step's terminal (typed, answered): that run's wait starts again
  stirred(x) {
    if (x.kind !== 'step' && x.kind !== 'chat') return
    const st = this.jobs.get(x.ref)
    if (st?.turnEnded && !st.ending) this.settle(st)
  }
  owns(byId) { return !byId || !this.user?.id || String(byId) === String(this.user.id) }
  // a steer typed into the terminal as a person would (bracketed paste, Enter); it counts as taken when its words are in the transcript
  typeSteer(st, s) {
    const S = st.term
    if (!S || S.exited) return false
    // (the folder was brought back to the line after a restart and the CLI has not heard of it yet: it does with these words)
    const text = st.folderNote ? `${st.folderNote}\n\n${s.text}` : s.text
    st.folderNote = null
    st.live.push({ ...s, typedAt: Date.now(), acked: false })
    st.lastInput = Date.now()
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
        if (s.steerId) this.send({ type: 'steered', jobId: st.job.id, steerId: s.steerId, how: 'live' })
        ;(st.steered ||= []).push({ ...s, how: 'live', histAt: (st.history || []).length })
      }
    }
  }

  // ---------- relayed sessions (generic: a step's run is kind 'step'; other kinds can come — a developer's session in a repo) ----------
  // The PTY's bytes, its hook events and the watched files go to the server over this app's own link (never from the CLI to the server
  // directly); the server relays the screen to every viewer and the owner's typing back here.
  // (start false: the caller listens first, then calls S.start())
  openSession({ kind, ref, agent, cwd, resume = null, prompt = '', stateDir, watch = [], env = {}, start = true, annotate = null }) {
    if (!this.interactive()) throw new Error(`no terminal here: ${P.why() || 'headless mode'}`)
    const S = new CliSession({ agent, cwd, resume, prompt, stateDir, trustRoot: this.dataDir, searchPath: this.searchPath, env: { ...this.sessionEnv, ...env },
      watch, cols: this.size.cols, rows: this.size.rows, log: (m) => this.log(m), version: this.caps[agent]?.version || null, annotate })
    const x = { S, kind, ref, out: '', timer: null, typedAt: 0, tx: [], txOut: [], txTimer: null }
    this.sessions.set(S.id, x)
    const flush = () => { x.timer = null; if (x.out) { this.send({ type: 'pty', sid: S.id, data: x.out }); x.out = '' } }
    // the conversation (transcript.js), item by item, a little at a time — and kept here to be announced again with the terminal
    const flushTx = () => { clearTimeout(x.txTimer); x.txTimer = null; if (x.txOut.length) this.send({ type: 'tx', sid: S.id, items: x.txOut.splice(0) }) }
    S.on('tx', (items) => {
      x.tx.push(...items)
      if (x.tx.length > TX_KEEP) x.tx.splice(0, x.tx.length - TX_KEEP)
      x.txOut.push(...items)
      if (!x.txTimer) x.txTimer = setTimeout(flushTx, TX_FLUSH_MS)
    })
    // the screen as it is now is the one to keep (a turn ended, the run is about to close the CLI): what the terminal showed so far goes
    // first, then the mark
    x.keep = () => { flush(); flushTx(); this.send({ type: 'term-keep', sid: S.id }) }
    S.on('data', (d) => { x.out += d; if (!x.timer) x.timer = setTimeout(flush, OUT_FLUSH_MS) })
    S.on('hook', (h) => this.send({ type: 'hook', sid: S.id, event: h.event, data: h.data }))
    S.on('files', (files) => this.send({ type: 'files', sid: S.id, files }))
    S.on('session', (id) => this.send({ type: 'term-session', sid: S.id, cli: id }))
    S.on('exit', ({ code }) => { flush(); flushTx(); this.send({ type: 'term-exit', sid: S.id, code }); setTimeout(() => this.sessions.delete(S.id), 1000).unref?.() })
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
  remember(jobId, rec) { try { writeWhole(this.recordFile(jobId), JSON.stringify(rec)) } catch (e) { this.log('[runner] record', e.message) } }
  forget(jobId) { try { fs.rmSync(this.recordFile(jobId), { force: true }) } catch { /* gone */ } }
  // a chat's CLI session on this computer (one per chat and agent — the next run of the chat resumes it in the same folder)
  chatRecordFile(job) { return path.join(this.dataDir, 'sessions', `chat-${chatHash(job)}-${safePart(job.agent, 16)}.json`) }
  chatRecord(job) { try { return JSON.parse(fs.readFileSync(this.chatRecordFile(job), 'utf8')) } catch { return null } }
  rememberChat(job, rec) { try { writeWhole(this.chatRecordFile(job), JSON.stringify(rec)) } catch (e) { this.log('[runner] chat record', e.message) } }

  // what the run learned, for the server's know-how candidates: each steer (who, how it was taken, what the run did right after it), and
  // what the CLI changed in its skills or wrote into its own memory (skills.js changes)
  learned(st) {
    const steers = (st.steered || []).map((s) => ({ steerId: s.steerId, text: s.text, by: s.by, ...(s.from ? { from: s.from } : {}), how: s.how || null,
      after: (st.history || []).slice(s.histAt || 0).filter((l) => l.kind === 'tool' || l.kind === 'text').slice(0, 6).map((l) => l.text) }))
    const own = st.skills ? SKL.changes({ dir: st.dir, placed: st.skills.placed, agents: st.skills.agents, before: st.skills.before }) : { skills: [], memory: [] }
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
      // (Windows: claude.cmd · codex.cmd through cmd.exe — clis.startSpec)
      const s = C.startSpec(bin, spec.args)
      const child = spawn(s.file, s.args, { cwd: st.dir, env: C.cliEnv({ TMPDIR: tmp, TMP: tmp, TEMP: tmp }, this.searchPath), stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: s.verbatim, windowsHide: true })
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
    // (Windows: the CLI may spell the folder with either slash)
    // (the longer spelling first: /private/var/… before /var/… on macOS)
    const dirs = [st.dir, st.realDir].filter(Boolean).sort((a, b) => b.length - a.length)
    const prefixes = path.sep === '\\' ? dirs.flatMap((d) => [`${d}\\`, `${d.replace(/\\/g, '/')}/`]) : dirs.map((d) => `${d}/`)
    for (const p of prefixes) t = t.split(p).join('')
    return t
  }
  endInput(st) { if (st.child && st.stdinOpen) { st.stdinOpen = false; try { st.child.stdin.end() } catch { /* gone */ } } }
  // SIGINT first (Codex saves its session and stops); Windows has no signal to send, so there the CLI and its children stop at once
  // (taskkill /T — a CLI started through cmd.exe would otherwise live on)
  kill(child) {
    if (process.platform === 'win32') { C.killTree(child.pid); return }
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
    st.lastInput = Date.now()
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
    if (st.awaiting) st.awaiting(false)
    if (st.child) { st.interrupted = true; this.kill(st.child) }
    if (st.term) st.term.kill()
    this.forget(jobId)
  }
  dropped(st) { this.log(`[runner] ${st.job.activity}: cancelled`); this.jobs.delete(st.job.id); st.release?.(); this.changed() }

  failed(st, e) {
    if (st.cancelled) return this.dropped(st)
    this.log(`[runner] ${st.job.activity}: ${e.message}`)
    this.progress(st, 'error', e.message)
    this.flush(st)
    this.report(st, { type: 'failed', jobId: st.job.id, error: String(e.message).slice(0, 800) })
    // (a run that failed is not offered again: its record — the CLI's last words with it — goes)
    this.forget(st.job.id)
  }

  // what finished stays in the outbox until the server confirms it ('finished')
  // (a chat's answers the server has not confirmed go first and stay with the report: the server takes no answer once the run is over)
  report(st, msg) {
    st.reported = true
    st.phase = msg.type === 'done' ? 'done' : 'failed'
    const before = [...(st.replies?.values() || [])].sort((a, b) => a.turn - b.turn)
    this.outbox = [...this.outbox.filter((m) => m.jobId !== msg.jobId), ...before, msg]
    this.saveOutbox()
    for (const m of before) this.send(m)
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
    st.release?.()
    this.emit('finished', { jobId: msg.jobId, state: msg.state })
  }

  // the app quits: what runs stops (the server offers it again when the app is back)
  // (a terminal's session is kept on this computer — sessions/<job>.json — so the run goes on in it when the server offers it again)
  stop() { for (const st of this.jobs.values()) { st.cancelled = true; if (st.child) this.kill(st.child); if (st.term) st.term.kill() } }
}

module.exports = { Runner }
