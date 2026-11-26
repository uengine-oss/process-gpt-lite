// A variation's seat (작업본은 한 곳에 — spec openspec/specs/variation-seats, sql/063). The user's request (2026-11-26): 「폴더내 작업실을 누르면
// 일렉트론에 연결된 모바일이나 일렉트론내 해당 워크트리를 클론하여 작업할 수 있고 로컬 폴더 작업 결과를 서버로 동기화 할 수 있다. 작업본이 여러군데
// 흩어져서는 안되니 잘 설계해」.
// A variation (one branch of a shared folder) is the original; a working copy of it on some disk is where it can be changed. The seat is
// where that working copy is, and a variation has one at most (pro_variation_seats is keyed by the variation):
//   none                          보관 중 — only the branch; nobody changes it
//   server · workroom             서버 작업실에서 — its person, in the web workroom's files and shell (<root>/.people/<who>/<variation>)
//   server · agent                서버 에이전트가 — a server agent run's checkout (a project turn, a chat change, a step, a handover receiver)
//   device                        ○○의 PC 에서 — one computer of its person (now: a chat's 「내 PC」 run on a project's variation; next: the
//                                 desktop's own working copy — design P1)
//   moving · returning            넘기는 중 — nobody changes it until it ends (MOVE_MS; past it the seat is gone: 보관 중)
// Moving a seat commits what the old place holds as it is (nothing reset, nothing thrown away) and takes that place off disk before the next
// place gets it, so there is never a moment with two places that can change the variation. Every change of seat raises the variation's
// epoch (pro_folder_variations.seat_epoch): a write, a terminal or a push that comes from an older epoch is refused.
// The rules are pure (decide); the database is changed under a row lock on the variation (transition), so two claims at once never both win.
// What follows a decision on disk (a commit, a checkout, a removal) holds a database lock of that variation (onDisk), so two servers never
// work on the same checkout at once. A move whose commit fails changes nothing (the seat is put back, the folder stays); a checkout leaves
// the disk only when git carries everything in it — otherwise it is moved aside next to where it was, never deleted (S.release).
// A server agent's seat names its run (work: turn · chat · step · handover · knowhow, ref: that run's id); a run ends only its own seat
// (its epoch) and leaves its result as a variation of its own when its seat moved meanwhile (finishRun). Runs of this process say every
// BEAT_MS that they still run; a turn, a handover or a know-how edit whose process stopped saying so is put away by the sweep. A step that
// deepagents runs outside this server, and a chat change (recoverChatRuns has those), are never put away that way.
// Before sql/063 runs there is no seat table: everything here then answers as before seats existed (legacy), and says so once in the log.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { Readable } from 'node:stream'
import { config } from '../../config.js'
import { q, qQuick, pool } from '../supa.js'
import { emit } from '../bus.js'
import { L, langOf, withLang } from '../lang.js'
import * as S from './service.js'
import * as G from './git.js'
import { leaseStore, stillHeld, withoutLease } from './diskLease.js'

const T = () => config.tenantId
export const MOVE_MS = 90_000
export const RECALL_WAIT_MS = 24 * 3600_000
export const MAX_DEVICE_SEATS = 20
export const BEAT_MS = 30_000
export const DEAD_MS = 3 * 60_000
export const RECALL_NOTIFY_MS = 4 * 3600_000
// the server agent runs that hold a seat, and which of them the sweep puts away when their process stopped saying they run
export const RUNS = ['turn', 'chat', 'step', 'handover', 'knowhow']
const SWEPT = ['turn', 'handover', 'knowhow']
const LIVE = ['open', 'ready', 'conflicted']
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })

// ---------- the rules (pure) ----------
// whose a variation is to open: a person's variation only by that person; an agent's (a run, an imported branch) by anyone who may run it
// (a process instance's line — inst/<id> — is written by its steps and mails, never opened in a workroom: read only for everyone)
export function mayHold(v, actorId) {
  if (v?.kind === 'instance') return false
  if (v?.holder_type === 'user' && v.holder_id) return String(v.holder_id) === String(actorId)
  return true
}
// a seat that no longer stands: a move that ran out of time, or a server seat whose checkout is gone
export function stale(seat, v, now = Date.now()) {
  if (!seat) return false
  if (['moving', 'returning'].includes(seat.state)) return !!seat.deadline && new Date(seat.deadline).getTime() < now
  return seat.place === 'server' && seat.state === 'held' && !!v && !v.worktree_path
}
// May the folder's owner take a seat that is not theirs? Only after asking for it (돌려 달라) a day ago without an answer, and — a computer's
// seat — while that computer is off (when it is on, its person can give it back). The seat's own person always may (take).
export function ownerMayTake(seat, { now = Date.now(), online = false } = {}) {
  if (!seat?.recall?.at) return { ok: false, why: 'ask-first' }
  const waited = now - new Date(seat.recall.at).getTime()
  if (waited < RECALL_WAIT_MS) return { ok: false, why: 'wait', left: RECALL_WAIT_MS - waited }
  if (seat.place === 'device' && online) return { ok: false, why: 'online' }
  return { ok: true }
}

// The next seat for an event, or why not. seat: the row (null: 보관 중 — a stale one counts as none), v: the variation.
// ev: {type: 'open', run, user, work?, ref?} · {type: 'device', device, user, job} · {type: 'settle', epoch} · {type: 'release', by, epoch?,
//     system?} · {type: 'take', by, owner, online, epoch?} · {type: 'recall', by, why} · {type: 'drop', epoch} · {type: 'expire'}
// → {ok: true, next (a row without epoch — null: none), bump (a new epoch), clear (the old server checkout is committed and taken off disk),
//    action, notify?} | {ok: false, why}
export function decide(seat, ev, { v = null, now = Date.now() } = {}) {
  const s = seat && !stale(seat, v, now) ? seat : null
  const me = (id) => !!s && String(s.user_id) === String(id)
  const moving = !!s && s.state !== 'held'
  const no = (why, extra = {}) => ({ ok: false, why, ...extra })
  const at = new Date(now)
  const until = new Date(now + MOVE_MS)
  switch (ev.type) {
    case 'open': {
      // a server place: the web workroom of its person, or a server agent run
      const run = ev.run === 'workroom' ? 'workroom' : 'agent'
      const work = run === 'agent' ? (RUNS.includes(ev.work) ? ev.work : 'turn') : null
      const ref = run === 'agent' && ev.ref != null ? String(ev.ref).slice(0, 200) : null
      const next = { place: 'server', state: 'moving', run, work, ref, user_id: String(ev.user), device_id: null, job_id: null, since: at, deadline: until, recall: null }
      if (!s) return { ok: true, next, bump: true, clear: false, action: 'open' }
      if (moving) return no('moving')
      if (s.place === 'device') return no(me(ev.user) ? 'device-mine' : 'device')
      if (!me(ev.user)) return no(s.run === 'agent' ? 'agent' : 'held')
      // the same place again: the same workroom, or the same run (its kind and id)
      if (s.run === run && (run === 'workroom' || (String(s.work || 'turn') === work && String(s.ref ?? '') === String(ref ?? '')))) return { ok: true, next: s, bump: false, clear: false, action: 'same' }
      // the person's own: their agent's turn takes it from their workroom (what the workroom holds is committed first); their workroom
      // does not take it from a turn that is running; another run of theirs (the next turn of the project, in another conversation)
      // takes it from the last one, whose checkout is committed and put away first
      if (s.run === 'agent' && run === 'workroom') return no('agent')
      return { ok: true, next, bump: true, clear: true, action: 'move' }
    }
    case 'device': {
      // a computer of the seat's person (now a chat's 「내 PC」 run on a project's variation: held at once, the run's own push brings its
      // work in; the desktop's working copy will answer ready — design P1)
      const next = { place: 'device', state: ev.ready === false ? 'moving' : 'held', run: null, work: null, ref: null, user_id: String(ev.user), device_id: String(ev.device), job_id: ev.job ? String(ev.job) : null,
        since: at, deadline: ev.ready === false ? until : null, recall: null }
      if (!s) return { ok: true, next, bump: true, clear: false, action: 'open' }
      if (s.place === 'device' && ev.job && String(s.job_id || '') === String(ev.job) && me(ev.user)) {
        if (String(s.device_id) === String(ev.device)) return { ok: true, next: s, bump: false, clear: false, action: 'same' }
        return { ok: true, next, bump: true, clear: false, action: 'move' }
      }
      if (moving) return no('moving')
      if (s.place === 'device') return no(me(ev.user) ? 'device-mine' : 'device')
      if (s.run === 'agent') return no('agent')
      if (!me(ev.user)) return no('held')
      return { ok: true, next, bump: true, clear: true, action: 'move' }
    }
    case 'settle':
      if (!seat || seat.state !== 'moving' || Number(seat.epoch) !== Number(ev.epoch)) return no('stale')
      return { ok: true, next: { ...seat, state: 'held', deadline: null }, bump: false, clear: false, action: 'held' }
    case 'release': {
      if (!s) return { ok: true, next: null, bump: false, clear: false, action: 'none' }
      if (ev.epoch != null && Number(ev.epoch) !== Number(s.epoch)) return no('stale')
      if (!ev.system && !me(ev.by)) return no('not-holder')
      // (a server agent's place ends with its run — finishRun — never by a person's 「돌려놓기」, even of their own project's turn)
      if (!ev.system && s.place === 'server' && s.run !== 'workroom') return no('agent')
      if (moving) return no('moving')
      // a server place: committed as it is and taken off disk while it is 'returning'; then none
      if (s.place === 'server') return { ok: true, next: { ...s, state: 'returning', since: at, deadline: until }, bump: true, clear: true, action: 'release' }
      // a computer gives its place back itself (its run ends; the desktop's 「돌려놓기」 — P1); from elsewhere its person takes it (take)
      if (!ev.system) return no('device-mine')
      return { ok: true, next: null, bump: true, clear: false, action: 'release' }
    }
    case 'take': {
      if (!s) return no('none')
      if (ev.epoch != null && Number(ev.epoch) !== Number(s.epoch)) return no('stale')
      if (s.run === 'agent' && s.place === 'server') return no('agent')
      if (!me(ev.by)) {
        if (!ev.owner) return no('not-holder')
        const may = ownerMayTake(s, { now, online: !!ev.online })
        if (!may.ok) return no(may.why, may.left ? { left: may.left } : {})
      } else if (s.place === 'server') return no('same')
      // from where its last saved state is: a server place is committed as it is first; a computer's later work comes back as a variation of
      // its own (leftover)
      if (s.place === 'server') return { ok: true, next: { ...s, state: 'returning', since: at, deadline: until }, bump: true, clear: true, action: 'take' }
      return { ok: true, next: null, bump: true, clear: false, action: 'take' }
    }
    case 'recall': {
      if (!s) return no('none')
      if (me(ev.by)) return no('self')
      if (s.run === 'agent' && s.place === 'server') return no('agent')
      // the first ask starts the owner's day and keeps it (asking again does not restart it); each asker notifies at most once in
      // RECALL_NOTIFY_MS
      const by = String(ev.by)
      const asks = { ...(s.recall?.asks || {}) }
      const last = asks[by] ? new Date(asks[by]).getTime() : 0
      const notify = now - last >= RECALL_NOTIFY_MS
      if (notify) asks[by] = at.toISOString()
      const recall = { by: s.recall?.by || by, at: s.recall?.at || at.toISOString(), why: s.recall?.why || String(ev.why || '').slice(0, 300), asks }
      return { ok: true, next: { ...s, recall }, bump: false, clear: false, action: 'recall', notify }
    }
    case 'drop':
      // a server agent run ended and took its checkout off disk: its seat goes with it — only its own (its epoch), never a person's
      if (!seat || seat.place !== 'server' || seat.run !== 'agent' || seat.state !== 'held') return no('none')
      if (ev.epoch == null || Number(ev.epoch) !== Number(seat.epoch)) return no('stale')
      return { ok: true, next: null, bump: true, clear: false, action: 'release' }
    case 'expire':
      if (!seat || s) return no('none')
      return { ok: true, next: null, bump: true, clear: false, action: 'expire' }
    default:
      return no('unknown')
  }
}

// ---------- the database ----------
let legacyWarned = false
const isLegacy = (e) => e?.code === '42P01' || (e?.code === '42703' && /seat_epoch/.test(String(e.message)))
function legacy(e) {
  if (!isLegacy(e)) throw e
  if (!legacyWarned) { legacyWarned = true; console.warn('[seats] sql/063_variation_seats.sql has not run here: variations have no seats (as before)') }
  return { ok: true, legacy: true }
}
// whether this server has seats (sql/063 ran): before it, the screens show no seat at all rather than 「보관 중」 for every variation
export const seatsOn = () => !legacyWarned
// the seat of a variation (null: none — a stale one too), or undefined before sql/063
export async function seatOf(vid, { v = null } = {}) {
  try {
    const [s] = await q('select * from pro_variation_seats where variation_id=$1', [vid])
    if (!s) return null
    const vv = v || (await S.variationById(vid))
    return stale(s, vv) ? null : s
  } catch (e) { if (isLegacy(e)) { legacy(e); return undefined } throw e }
}
export async function seatsOfFolder(folderId) {
  try { return await q('select * from pro_variation_seats where folder_id=$1 and tenant_id=$2', [folderId, T()]) } catch (e) { if (isLegacy(e)) { legacy(e); return [] } throw e }
}

// one change of seat, under a row lock on the variation: decideFn(v, seat) → decide's answer. → {...answer, v, prev, seat, epoch}
export async function transition(vid, decideFn, { by = null, note = null } = {}) {
  let c
  try { c = await pool.connect() } catch (e) { throw e }
  try {
    await c.query('begin')
    const { rows: [v] } = await c.query('select * from pro_folder_variations where id=$1 for update', [vid])
    if (!v) { await c.query('rollback'); throw err(404, L('변형을 찾지 못했어요.', "I couldn't find that variation.")) }
    const { rows: [raw] } = await c.query('select * from pro_variation_seats where variation_id=$1', [vid])
    const prev = raw || null
    const out = decideFn(v, prev)
    if (!out.ok) { await c.query('rollback'); return { ...out, v, prev, seat: prev && !stale(prev, v) ? prev : null } }
    let epoch = Number(v.seat_epoch) || 0
    if (out.bump) { epoch += 1; await c.query('update pro_folder_variations set seat_epoch=$2 where id=$1', [vid, epoch]) }
    let seat = null
    if (out.next === null) {
      if (prev) await c.query('delete from pro_variation_seats where variation_id=$1', [vid])
    } else if (out.next !== prev) {
      const n = out.next
      const { rows: [row] } = await c.query(`insert into pro_variation_seats (variation_id, tenant_id, folder_id, place, state, user_id, device_id, run, job_id, epoch, since, deadline, recall, work, ref, seen_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
             on conflict (variation_id) do update set place=$4, state=$5, user_id=$6, device_id=$7, run=$8, job_id=$9, epoch=$10, since=$11, deadline=$12, recall=$13, work=$14, ref=$15, seen_at=now(),
               dirty=case when pro_variation_seats.place=$4 and pro_variation_seats.device_id is not distinct from $7 then pro_variation_seats.dirty else 0 end,
               ahead=case when pro_variation_seats.place=$4 and pro_variation_seats.device_id is not distinct from $7 then pro_variation_seats.ahead else 0 end
             returning *`,
      [vid, T(), v.folder_id, n.place, n.state, String(n.user_id), n.device_id || null, n.run || null, n.job_id || null, epoch, n.since || new Date(), n.deadline || null, n.recall ? JSON.stringify(n.recall) : null,
        n.work || null, n.ref ?? null])
      seat = row
    } else seat = prev
    if (out.action !== 'same' && out.action !== 'none') {
      await c.query(`insert into pro_variation_seat_log (tenant_id, variation_id, folder_id, by_user, action, from_place, to_place, device_id, epoch, head, note)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [T(), vid, v.folder_id, by ? String(by) : null, out.action, prev ? placeName(prev) : null, seat ? placeName(seat) : null, seat?.device_id || prev?.device_id || null, epoch, v.head_commit || null, note])
    }
    await c.query('commit')
    return { ...out, v: { ...v, seat_epoch: epoch }, prev, seat, epoch }
  } catch (e) {
    await c.query('rollback').catch(() => {})
    if (isLegacy(e)) return { ...legacy(e), v: await S.variationById(vid), prev: null, seat: null, epoch: 0 }
    throw e
  } finally { c.release() }
}
const placeName = (s) => (s.place === 'server' ? `server:${s.run || 'workroom'}` : 'device')

// ---------- what people see ----------
// The seat as every screen shows it — where, who, which computer by its name and whether it is on, the counts it reported — never a path
// or a device id. me: who asks; role: their role in the folder.
export async function viewOf(seat, v, { me = null, role = null, names = null } = {}) {
  const s = seat && !stale(seat, v) ? seat : null
  const rank = S.RANK[role] || 0
  const live = !!v && LIVE.includes(v.status)
  const mine = !!s && !!me && String(s.user_id) === String(me.id)
  const out = {
    place: s?.place || null, state: s?.state || null, run: s?.run || null, epoch: Number(v?.seat_epoch) || 0,
    who: null, device: null, dirty: s?.dirty || 0, ahead: s?.ahead || 0, pushedAt: s?.pushed_at || null, since: s?.since || null,
    mine, recall: null, can: { open: false, release: false, take: false, recall: false },
  }
  if (s) {
    const nm = names || await namesOf([s.user_id, s.recall?.by].filter(Boolean), v)
    out.who = { id: String(s.user_id), name: nm.get(String(s.user_id)) || (s.run === 'agent' ? v?.holder_name || L('에이전트', 'Agent') : '') }
    if (s.device_id) {
      const [d] = await q('select name from pro_local_devices where id=$1', [s.device_id]).catch(() => [])
      const H = await import('../localAgents/hub.js')
      out.device = { name: d?.name || L('PC', 'PC'), online: !!H.linkOf(T(), String(s.device_id)) }
    }
    if (s.recall) out.recall = { by: { id: String(s.recall.by), name: nm.get(String(s.recall.by)) || '' }, at: s.recall.at, why: s.recall.why || '' }
  }
  const held = !!s && s.state === 'held'
  out.can.open = live && rank >= S.RANK.runner && !!me && mayHold(v, me.id) && (!s || (mine && held && s.place === 'server' && s.run === 'workroom'))
  out.can.release = mine && held && s.place === 'server' && s.run === 'workroom'
  out.can.take = !!s && held && !(s.place === 'server' && s.run === 'agent') && ((mine && s.place === 'device') || (!mine && role === 'owner' && ownerMayTake(s, { online: !!out.device?.online }).ok))
  out.can.recall = !!s && held && !mine && rank >= S.RANK.editor && !(s.place === 'server' && s.run === 'agent')
  return out
}
// the names every screen uses (lib/people.js), an agent by its own
async function namesOf(ids, v) {
  const { people } = await import('../people.js')
  const uuids = [...new Set(ids.map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x))
  const by = uuids.length ? await people(uuids).catch(() => new Map()) : new Map()
  const out = new Map()
  for (const id of ids.map(String)) out.set(id, by.get(id)?.name || (v && String(v.holder_id) === id ? v.holder_name : '') || '')
  if (uuids.some((x) => !out.get(x))) {
    const rows = await q('select id::text as id, username from users where id::text = any($1)', [uuids]).catch(() => [])
    for (const r of rows) if (!out.get(r.id)) out.set(r.id, r.username || '')
  }
  return out
}
// the seats of a folder's variations as views, for its list (one lookup of names for all)
export async function viewsOf(folder, variations, { me, role }) {
  const seats = new Map((await seatsOfFolder(folder.id)).map((s) => [String(s.variation_id), s]))
  if (!seatsOn()) return new Map()
  const ids = [...seats.values()].flatMap((s) => [s.user_id, s.recall?.by]).filter(Boolean)
  const names = ids.length ? await namesOf(ids, null) : new Map()
  const out = new Map()
  for (const v of variations) out.set(String(v.id), await viewOf(seats.get(String(v.id)) || null, v, { me, role, names: new Map([...names, [String(v.holder_id), names.get(String(v.holder_id)) || v.holder_name || '']]) }))
  return out
}

// why a seat refused, in words (and the seat itself for the page's 「돌려 달라고 하기」)
export async function refusal(out, folder, { me = null, role = null } = {}) {
  const view = out.v ? await viewOf(out.seat, out.v, { me, role }).catch(() => null) : null
  const who = view?.who?.name || ''
  const dev = view?.device?.name || 'PC'
  const text = {
    held: L(`${who} 님이 서버 작업실에서 이 변형을 고치는 중이에요 — 돌려 달라고 할 수 있어요.`, `${who} is changing this variation in the server workroom — you can ask for it back.`),
    agent: L('서버 에이전트가 이 변형에서 일하는 중이에요 — 끝나면 저절로 보관돼요.', 'A server agent is working on this variation — it is put away by itself when done.'),
    device: L(`${who} 님의 PC(${dev})에서 이 변형을 고치는 중이에요 — 돌려 달라고 할 수 있어요.`, `${who} is changing this variation on their PC (${dev}) — you can ask for it back.`),
    'device-mine': L(`이 변형은 내 PC(${dev})에서 작업 중이에요 — 그쪽에서 끝내거나 「여기로 가져오기」를 눌러 주세요.`, `This variation is being worked on on your PC (${dev}) — finish there, or press "Bring it here".`),
    moving: L('이 변형의 작업본을 넘기는 중이에요 — 잠시 뒤에 다시 해 주세요.', "This variation's working copy is moving — try again in a moment."),
    stale: L('그사이 작업본이 다른 곳으로 옮겨졌어요 — 새로 고쳐 보고 다시 해 주세요.', 'The working copy moved somewhere else meanwhile — reload and try again.'),
    'not-holder': L('작업본을 가진 사람만 할 수 있어요.', 'Only the person who has the working copy can do that.'),
    'not-yours': L(`이 변형은 ${out.v?.holder_name || ''} 님의 것이라 그 사람만 작업실에서 고칠 수 있어요 — 읽기 전용으로 볼 수 있어요.`, `This variation is ${out.v?.holder_name || ''}'s, so only they change it in the workroom — you can look at it read only.`),
    none: L('이 변형은 보관 중이에요.', 'This variation is put away.'),
    self: L('내가 가진 작업본이에요.', 'You have this working copy.'),
    same: L('이미 서버 작업실에 있어요.', 'It is already in the server workroom.'),
    'ask-first': L('먼저 돌려 달라고 해 주세요 — 하루 동안 답이 없으면 소유자가 가져올 수 있어요.', 'Ask for it back first — the owner can take it when there is no answer for a day.'),
    wait: L(`돌려 달라고 한 지 아직 하루가 안 됐어요 — ${Math.ceil((out.left || 0) / 3600_000)}시간 뒤에 가져올 수 있어요.`, `It has not been a day since you asked — you can take it in ${Math.ceil((out.left || 0) / 3600_000)} hours.`),
    online: L(`${who} 님의 PC 가 켜져 있어요 — 그 PC 에서 돌려놓기를 기다려 주세요.`, `${who}'s PC is on — wait for it to be given back there.`),
    limit: L(`PC 에 둔 작업본이 너무 많아요(${MAX_DEVICE_SEATS}개) — 몇 개를 돌려놓은 뒤에 해 주세요.`, `Too many working copies on PCs (${MAX_DEVICE_SEATS}) — give some back first.`),
    integrating: L('이 변형을 반영하는 중이에요 — 끝난 뒤에 열어 주세요.', 'This variation is being merged — open it when that is done.'),
    line: L('프로세스 인스턴스의 줄은 단계 결과가 이어지는 곳이라 작업실에서 고치지 않아요 — 읽기 전용으로 볼 수 있어요.', "A process instance's line is where its steps' results go on, so it is not changed in a workroom — you can look at it read only."),
  }[out.why] || L('지금은 이 변형의 작업본을 옮길 수 없어요.', "This variation's working copy can't move right now.")
  return err(409, text, { seat: view, why: out.why })
}

// ---------- the server's own places ----------
// What follows a decision on disk, one at a time per variation: in this process (a queue) and across servers (a lease row of the variation,
// pro_variation_locks — renewed while the work goes on, free once its time passed: no database connection is held through the work).
// wait: how long to wait for it — a person's action a few seconds (then 409 busy), a save its own budget, the server's own work longer;
// tryOnly: not at all ({busy: true}) — the sweep never waits for a move in progress, nor expires it.
export const USER_WAIT_MS = 5_000
export const SAVE_WAIT_MS = 15_000
export const SYSTEM_WAIT_MS = 10 * 60_000
export const LEASE_MS = 60_000
const LOCK_OWNER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const busy = () => err(409, L('이 변형의 작업본을 지금 다른 곳에서 옮기거나 저장하는 중이에요 — 잠시 뒤에 다시 해 주세요.', "This variation's working copy is being moved or saved elsewhere right now — try again in a moment."), { why: 'busy' })
let lockLegacy = false
// (the lease queries go through their own few connections with time limits — supa.js quickPool: a busy pool or a stalled database makes
// them fail within seconds, never wait)
async function takeLease(vid, owner) {
  if (lockLegacy) return true
  try {
    const rows = await qQuick(`insert into pro_variation_locks (variation_id, owner, until) values ($1, $2, now() + ($3 || ' milliseconds')::interval)
                          on conflict (variation_id) do update set owner = excluded.owner, until = excluded.until
                            where pro_variation_locks.until < now() or pro_variation_locks.owner = excluded.owner
                          returning owner`, [vid, owner, String(LEASE_MS)])
    return rows.length > 0
  } catch (e) { if (e.code === '42P01') { lockLegacy = true; return true } throw e }
}
// a renewal only extends a lease that is still this work's and still running: it never takes the row again (a row that ran out, or that
// another server took — and maybe gave back — since, is not this lease any more)
async function renewLease(vid, owner) {
  if (lockLegacy) return true
  const rows = await qQuick(`update pro_variation_locks set until = now() + ($3 || ' milliseconds')::interval
                             where variation_id=$1 and owner=$2 and until > now() returning owner`, [vid, owner, String(LEASE_MS)])
  return rows.length > 0
}
// the lease of one piece of work: taken (waiting up to `wait`), renewed every third of its time, given back at the end. A renewal the
// database refuses means another server has the variation now: the lease is lost for good (recorded — check() refuses from then on). A
// renewal that could not reach the database leaves it held until its own time runs out (fresh, a few seconds short of the row's).
// check(step): renewed once more and refused (409 busy) when lost — what removes, checks out or commits asks it first (diskLease.stillHeld).
const LEASE_SPARE_MS = 5_000
const leaseLost = (step) => err(409, L('이 변형의 작업본을 맡은 시간이 만료되어 다른 서버가 이어받았어요. 여기서는 더 이상 옮기거나 저장하지 않았어요. 잠시 후 다시 시도해 주세요.',
  'The time this server had the working copy ran out and another server took it over — nothing more was moved or saved here. Try again in a moment.'), { why: 'busy', step: step || null })
async function lease(vid, wait) {
  const owner = `${LOCK_OWNER}:${crypto.randomBytes(3).toString('hex')}`
  const until = Date.now() + wait
  let sent
  for (;;) {
    sent = Date.now()
    // (no connection for it in time, or no answer in time: not taken now — the work then waits its turn or says busy, never a 500)
    let got = false
    try { got = await takeLease(vid, owner) } catch (e) { if (!/timeout exceeded when trying to connect|query read timeout/i.test(String(e?.message))) throw e }
    if (got) break
    if (Date.now() >= until) return null
    await pause(Math.min(250, Math.max(10, until - Date.now())))
  }
  // (released: something the work left running after its end asks no more — it never renews the lease again)
  let fresh = sent + LEASE_MS, lost = false, released = false
  const inFlight = new Set()
  const renewNow = async () => {
    if (lockLegacy || released) return true
    if (lost) return false
    const t = Date.now()
    const ask = renewLease(vid, owner)
    inFlight.add(ask)
    try {
      if (await ask) { fresh = Math.max(fresh, t + LEASE_MS); return true }
    } catch {
      if (Date.now() < fresh - LEASE_SPARE_MS) return true
    } finally { inFlight.delete(ask) }
    lost = true
    console.warn(`[seats] the disk lease of variation ${vid} was lost — another server may have it now; this work stops before changing the disk`)
    return false
  }
  const timer = setInterval(() => { renewNow().catch(() => {}) }, LEASE_MS / 3)
  timer.unref?.()
  return {
    lost: () => lost,
    check: async (step) => { if (!(await renewNow())) throw leaseLost(step) },
    // (every renewal still on its way is waited for first, then the row is given back)
    release: async () => {
      released = true
      clearInterval(timer)
      await Promise.allSettled([...inFlight])
      if (!lockLegacy) await qQuick('delete from pro_variation_locks where variation_id=$1 and owner=$2', [vid, owner]).catch(() => {})
    },
  }
}
const disk = new Map()
export function onDisk(vid, fn, { wait = SYSTEM_WAIT_MS, tryOnly = false } = {}) {
  if (tryOnly && disk.has(vid)) return Promise.resolve({ busy: true })
  const until = Date.now() + (tryOnly ? 0 : wait)
  let gaveUp = false, started = false
  const work = async () => {
    if (gaveUp) return undefined
    started = true
    const l = await lease(vid, tryOnly ? 0 : Math.max(0, until - Date.now()))
    if (!l) { if (tryOnly) return { busy: true }; throw busy() }
    // (the lease goes with the work: what removes, checks out or commits under it asks it first — diskLease.stillHeld)
    try { return await leaseStore.run(l, fn) } finally { await l.release() }
  }
  const run = (disk.get(vid) || Promise.resolve()).then(work, work)
  const tail = run.catch(() => {})
  disk.set(vid, tail)
  tail.then(() => { if (disk.get(vid) === tail) disk.delete(vid) })
  if (tryOnly) return run
  // (waiting in this process's queue counts against the same budget: a person's action does not wait behind a long run's end)
  let timer
  // (only the wait in the queue: work that started runs to its end — the lease has the same budget)
  const late = new Promise((_, reject) => { timer = setTimeout(() => { if (!started) { gaveUp = true; reject(busy()) } }, Math.max(0, until - Date.now()) + 50); timer.unref?.() })
  return Promise.race([run, late]).finally(() => clearTimeout(timer))
}
// a move in progress says it still goes on before each of its steps on disk (a slow commit or checkout does not run out its time)
async function renew(vid, epoch) {
  await q(`update pro_variation_seats set deadline = now() + ($3 || ' milliseconds')::interval where variation_id=$1 and epoch=$2 and state in ('moving','returning')`, [vid, epoch, String(MOVE_MS)])
    .catch((e) => { if (!isLegacy(e)) throw e })
}

// the runs of this process that hold a server seat say so every BEAT_MS (seen_at) — each for its own seat (its epoch): a run that lost its
// seat never keeps the next holder alive; a run whose process stopped is put away by the sweep
const beats = new Map() // `${variation}:${epoch}` → {vid, epoch}
let beatTimer = null
function beat(vid, epoch) {
  beats.set(`${vid}:${epoch}`, { vid: String(vid), epoch: Number(epoch) })
  if (beatTimer) return
  beatTimer = setInterval(() => { beatNow().catch(() => {}) }, BEAT_MS)
  beatTimer.unref?.()
}
export async function beatNow() {
  const all = [...beats.values()]
  if (!all.length) return 0
  const rows = await q(`update pro_variation_seats s set seen_at=now() from unnest($1::uuid[], $2::int[]) as b(vid, ep)
                        where s.variation_id=b.vid and s.epoch=b.ep and s.place='server' and s.run='agent' returning s.variation_id`, [all.map((b) => b.vid), all.map((b) => b.epoch)]).catch(() => [])
  return rows.length
}
export const beating = (vid, epoch = null) => [...beats.values()].some((b) => b.vid === String(vid) && (epoch == null || b.epoch === Number(epoch)))
// (a run that ended — epoch: only that run's; none: every run of the variation in this process, or a test that plays a process that stopped)
export function forget(vid, epoch = null) { for (const [k, b] of beats) if (b.vid === String(vid) && (epoch == null || b.epoch === Number(epoch))) beats.delete(k) }

async function personOf(id, v) {
  if (!id) return { name: v?.holder_name || 'Process GPT Lite', email: undefined }
  const [p] = await q('select name, email from pro_profile where user_id::text=$1', [String(id)]).catch(() => [])
  if (p) return { name: p.name || p.email || v?.holder_name || 'Process GPT Lite', email: p.email || undefined }
  const [u] = await q('select username, email from users where id::text=$1', [String(id)]).catch(() => [])
  return { name: u?.username || v?.holder_name || 'Process GPT Lite', email: u?.email || `${String(id).slice(0, 8)}@agents.pgpt-pro.local` }
}
// a commit that did not happen stops the move: nothing is taken off disk and the seat is put back (409 'unsaved', git's first words)
// (git's own words: its first error line — 「error: open("…"): Permission denied」 · 「'안쪽/' does not have a commit checked out」 — else its last)
// (no server path goes out: an absolute path is cut to its last part)
export const gitWhy = (e) => {
  const ls = String(e?.stderr || e?.message || '').trim().split('\n').map((x) => x.trim()).filter(Boolean)
  return (ls.find((x) => /^error:/.test(x)) || ls.pop() || '').replace(/(?:[A-Za-z]:)?(?:\/[^\s'"/]+)+\/?/g, (m) => `…/${path.basename(m)}`).slice(0, 200)
}
const unsaved = (e) => err(409, L(`작업본의 변경을 저장하지 못해 옮기지 않았어요 — 작업본은 그대로예요 (${gitWhy(e)})`,
  `The working copy's changes could not be saved, so it did not move — it is as it was (${gitWhy(e)})`), { why: 'unsaved' })
// What a server checkout holds, committed as it is (its person the author — nothing reset, nothing cleaned), the variation's head
// following; its status is left as it is. → the new head, or null when there was nothing to commit. Throws (409 'unsaved') when git could
// not commit: the caller does not move anything then.
export async function commitAsIs(folder, v, { author, message } = {}) {
  const cur = await S.variationById(v.id)
  if (!cur?.worktree_path || !fs.existsSync(cur.worktree_path)) return null
  let sha
  // (a lock left by a git that was killed would refuse every commit from then on: removed when it is surely stale)
  await stillHeld('commit')
  await S.clearStaleLocks(cur.worktree_path, cur.branch).catch(() => 0)
  try { sha = await G.commitAll(cur.worktree_path, message || L('작업실에서 옮김', 'Moved from the workroom'), author || await personOf(cur.holder_id, cur)) } catch (e) { throw unsaved(e) }
  const head = await G.head(folder.repo_path, `refs/heads/${cur.branch}`)
  await q('update pro_folder_variations set head_commit=$2, updated_at=now() where id=$1', [cur.id, head])
  if (sha) await S.touch(folder)
  return sha
}
// The old server place goes: its shells and Claude Code are closed first (nothing writes there any more), what it holds is committed as it
// is (by the seat's person — a failure stops here, the folder untouched), then it leaves the disk (S.release: moved aside when git does
// not carry everything in it). → {sha, kept}
async function clearServer(folder, v, prev, { reason, by } = {}) {
  const W = await import('../workroom.js')
  W.closeRoom('variation', String(v.id), reason || L('작업본이 다른 곳으로 옮겨져 이 작업실을 닫았어요.', 'The working copy moved elsewhere, so this workroom was closed.'))
  const author = await personOf(prev?.user_id || v.holder_id, v)
  const sha = await commitAsIs(folder, v, { author, message: L('작업실에서 옮김', 'Moved from the workroom') })
  const cur = await S.variationById(v.id)
  const gone = cur?.worktree_path ? await S.release(folder, cur, { mode: prev?.run === 'agent' ? 'agent' : 'person', who: prev?.user_id || null }) : { kept: 0 }
  forget(v.id)
  if (by) emit(String(by), 'folders', { slug: folder.slug, variation: v.id })
  return { sha, kept: gone?.kept || 0 }
}
// Before a move takes a server place off disk, what it holds is saved first — outside any change of seat: a commit git refuses ends here
// with nothing changed (no new epoch, no record, no shell closed). (The move commits once more after closing the shells.)
async function saveFirst(folder, v, seat) {
  if (!seat || seat.place !== 'server') return null
  const cur = await S.variationById(v.id)
  if (!cur?.worktree_path) return null
  return commitAsIs(folder, cur, { author: await personOf(seat.user_id, cur), message: L('작업실에서 옮김', 'Moved from the workroom') })
}
// A move that could not finish (its commit failed, the checkout failed): the seat goes back to where it was when that place is still on
// disk (a new epoch: whatever was read before the move is refused), else to none
async function putBack(vid, out, note) {
  await transition(vid, (vv, seat) => {
    if (!seat || Number(seat.epoch) !== Number(out.epoch)) return { ok: false, why: 'none' }
    const p = out.prev && !stale(out.prev, vv) && (out.prev.place !== 'server' || !!vv.worktree_path) ? out.prev : null
    return { ok: true, next: p ? { ...p, state: 'held', deadline: null } : null, bump: true, action: 'putback' }
  }, { note: String(note || '').slice(0, 200) }).catch((e) => console.warn('[seats] put back', e.message))
}
// is a variation part of a merge that is not over (no place takes it then)
export async function integrating(folder, vid) {
  const [busy] = await q(`select 1 from pro_folder_integrations where folder_id=$1 and status in ('running','conflicted','resolving') and $2 = any(variation_ids) limit 1`, [folder.id, vid])
  return !!busy
}
const room = (folder) => ({ slug: folder.slug })

// Open a variation in a server place: the web workroom of its person (run 'workroom') or a server agent run (run 'agent' — work: what runs,
// ref: its id), its branch on disk at `dir` (S.checkout). Refused (409, with the seat) when its seat is someone else's, a computer's,
// moving, or the variation is being merged. → {epoch, base (the variation's head when the run got it), work, ref, seat, action}: what the
// run passes to finishRun / endRun.
export async function openServer(folder, v, { user, run = 'agent', dir, work = null, ref = null }) {
  if (run === 'workroom' && !mayHold(v, user.id)) throw await refusal({ ok: false, why: v.kind === 'instance' ? 'line' : 'not-yours', v, seat: await seatOf(v.id) }, folder, { me: user })
  if (await integrating(folder, v.id)) throw await refusal({ ok: false, why: 'integrating', v }, folder, { me: user })
  const kind = run === 'workroom' ? null : (RUNS.includes(work) ? work : 'turn')
  const ev = { type: 'open', run, user: user.id, work: kind, ref }
  return onDisk(String(v.id), async () => {
    const peek = await seatOf(v.id)
    const pre = peek ? decide(peek, ev, { v: await S.variationById(v.id) }) : null
    if (pre?.ok && pre.clear) await saveFirst(folder, v, peek)
    const out = await transition(v.id, (vv, seat) => decide(seat, ev, { v: vv }), { by: user.id })
    if (out.legacy) { await S.checkout(folder, await S.variationById(v.id), dir); return { ...out, epoch: 0, work: kind, ref, base: await G.head(folder.repo_path, `refs/heads/${v.branch}`) } }
    if (!out.ok) throw await refusal(out, folder, { me: user })
    let cleared = false
    try {
      if (out.clear) { await clearServer(folder, out.v, out.prev, { reason: run === 'agent' ? L('에이전트가 이 변형에서 일을 시작해 작업실을 닫았어요 — 고친 것은 저장했어요.', 'An agent started working on this variation, so the workroom was closed — what you changed is saved.') : undefined }); cleared = true }
      if (out.action !== 'same') await renew(v.id, out.epoch)
      await S.checkout(folder, await S.variationById(v.id), dir)
      const base = await G.head(folder.repo_path, `refs/heads/${v.branch}`)
      const res = { ...out, work: kind, ref, base }
      if (out.action === 'same') { if (kind) beat(v.id, out.epoch); return res }
      const done = await transition(v.id, (vv, seat) => decide(seat, { type: 'settle', epoch: out.epoch }, { v: vv }), { by: user.id })
      if (!done.ok) throw await refusal(done, folder, { me: user })
      if (kind) beat(v.id, out.epoch)
      return { ...res, seat: done.seat }
    } catch (e) {
      if (out.action !== 'same') await putBack(v.id, cleared ? { ...out, prev: null } : out, e.message)
      throw e
    }
  }, { wait: run === 'workroom' ? USER_WAIT_MS : SYSTEM_WAIT_MS })
}
// open a server agent run and set it up (a seed upload, a prompt): a setup that fails gives the seat back and takes the checkout off disk
export async function withRun(folder, v, opts, setup) {
  const run = await openServer(folder, v, { run: 'agent', ...opts })
  try { if (setup) await setup(run) } catch (e) {
    await endRun(folder, await S.variationById(v.id), run).catch((x) => console.warn('[seats] end after a failed setup', x.message))
    throw e
  }
  return run
}
// The run a seat names (its kind and id), as finishRun takes it — for a run that outlived the process that opened it (a step deepagents runs
// outside this server; a chat change finished after a restart). → {epoch, work, ref, base} — legacy: before sql/063 · unseated: a checkout
// of it with no seat at all (from before seats) · none: no seat and nothing on disk · epoch -1: someone else has the variation now
export async function runOf(vid, { work, ref }) {
  const s = await seatOf(vid)
  const v = await S.variationById(vid)
  const base = v?.base_commit || null
  if (s === undefined) return { epoch: null, work, ref, base, legacy: true }
  if (s && s.place === 'server' && s.run === 'agent' && s.state === 'held' && String(s.work || 'turn') === work && String(s.ref ?? '') === String(ref ?? '')) return { epoch: Number(s.epoch), work, ref, base }
  if (!s && v?.worktree_path) return { epoch: null, work, ref, base, unseated: true }
  if (!s) return { epoch: -1, work, ref, base, none: true }
  return { epoch: -1, work, ref, base }
}
// does this run still hold the variation's seat (a server agent's seat of its kind and id, at its epoch)
export async function holdsRun(vid, run) {
  if (!run) return false
  const s = await seatOf(vid)
  if (s === undefined || run.legacy) return s === undefined // before sql/063
  if (run.unseated) return !s && !!(await S.variationById(vid))?.worktree_path
  return !!s && s.place === 'server' && s.run === 'agent' && s.state === 'held' && (run.epoch == null || Number(s.epoch) === Number(run.epoch))
    && (!run.work || String(s.work || 'turn') === run.work) && (run.ref == null || String(s.ref ?? '') === String(run.ref))
}
// a run ends: its checkout leaves the disk and its seat goes — only while the seat is still its own (another place that took the variation
// since is not touched)
export async function endRun(folder, v, run) {
  return onDisk(String(v.id), () => endRunNow(folder, v, run))
}
async function endRunNow(folder, v, run, { mode = 'agent', why = null } = {}) {
  forget(v.id, run?.epoch)
  if (!(await holdsRun(v.id, run))) return { held: false }
  const cur = await S.variationById(v.id)
  const seat = await seatOf(v.id)
  // (a run's ignored files — caches, logs — are dropped; everything is kept when its result could not be committed)
  const gone = cur?.worktree_path ? await S.release(folder, cur, { mode, who: seat?.user_id || null, why }) : { kept: 0 }
  if (run.epoch > 0) await transition(v.id, (vv, seat) => decide(seat, { type: 'drop', epoch: run.epoch }, { v: vv }), { note: run.work || null })
  return { held: true, kept: gone?.kept || 0 }
}
// A run's end with its result: while it still holds the seat, fill (bring what the agent made into the checkout) → commit → end; when the
// seat moved meanwhile its result is never mixed in nor lost — it is filled into a checkout of where the run started and becomes a variation
// of its own (leftover). A commit that fails (commit should throw then — S.commitVariation {strict: true}) ends the run all the same, with
// everything its checkout held kept and recorded on the variation (saved: false) — never mixed in, never a silent copy. → {held, saved,
// sha?, kept?, left?}
export async function finishRun(folder, v, run, { fill = null, commit = null, user = null, where = '' } = {}) {
  try {
    return await onDisk(String(v.id), async () => {
      // (the lease is asked once more before the result comes in: when another server has the variation now, the result goes where a
      // run's result goes when its seat moved — a variation of its own; the live checkout is not touched)
      const lost = async () => { try { await stillHeld('fill'); return false } catch (e) { if (e.why === 'busy') return true; throw e } }
      if (await holdsRun(v.id, run) && !(fill && await lost())) {
        const cur = await S.variationById(v.id)
        if (fill && cur?.worktree_path) await fill(cur.worktree_path)
        let sha = null, failed = null
        try { sha = commit ? await commit(await S.variationById(v.id)) : null } catch (e) { failed = e; console.warn('[seats] a run\'s result could not be committed:', gitWhy(e)) }
        const end = await endRunNow(folder, v, run, failed ? { mode: 'all', why: `commit failed: ${gitWhy(failed)}` } : {})
        return { held: true, saved: !failed, sha, kept: end.kept || 0 }
      }
      const left = fill ? await leftoverFrom(folder, v, run?.base || v.base_commit, fill, { user, where }).catch((e) => { console.warn('[seats] leftover', e.message); return null }) : null
      return { held: false, saved: !!left, left }
    })
  } finally { forget(v.id, run?.epoch) }
}
// a fresh checkout of `base` (detached, next to the folders), filled and committed → a leftover variation of v from that commit. What git
// does not carry in it is kept and recorded like any place's (S.release): on the new variation, else on v — all of it when the result
// could not be committed (listed in 「따로 남긴 파일」, never a copy nobody sees). (A scratch checkout of this server's own: it is no
// variation's place, so it asks no lease.)
async function leftoverFrom(folder, v, base, fill, { user, where }) {
  const tmp = path.join(S.foldersRoot(), '.leftover', `${String(v.id).slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}`)
  await fsp.mkdir(path.dirname(tmp), { recursive: true })
  await G.git(folder.repo_path, ['worktree', 'add', '-q', '--detach', tmp, base || `refs/heads/${v.branch}`])
  let made = null, failed = null
  try {
    await fill(tmp)
    const me = await personOf(user, v)
    const sha = await G.commitAll(tmp, L(`${where || '실행'}에 남아 있던 변경`, `Changes left on ${where || 'a run'}`), me)
    made = sha ? await leftover(folder, v, sha, { user, where }) : null
    return made
  } catch (e) { failed = e; throw e } finally {
    await withoutLease(() => S.release(folder, { id: made?.id || v.id, worktree_path: tmp }, { keep: true, mode: failed ? 'all' : 'agent', who: user || null, why: failed ? `commit failed: ${gitWhy(failed)}` : null }))
      .catch((e) => console.warn('[seats] leftover checkout', e.message))
  }
}

// Put a server place away (돌려놓기 · 작업실 닫기): what it holds is committed as it is, it goes off disk, the seat is none (보관 중) and the
// variation is ready to review. by: who asks (the seat's person, unless system); epoch: the one the page saw. A commit that fails puts the
// seat back (409 'unsaved'). A checkout with no seat (from before seats, or left by a crash) is put away the same way. → {action, kept}
export async function closeServer(folder, v, { by, epoch = null, system = false, status = 'ready', reason, me = null, wait = null } = {}) {
  const ev = { type: 'release', by, epoch, system }
  return onDisk(String(v.id), async () => {
    const peek = await seatOf(v.id)
    const pre = peek ? decide(peek, ev, { v: await S.variationById(v.id) }) : null
    if (pre?.ok && pre.clear) await saveFirst(folder, v, peek)
    const out = await transition(v.id, (vv, seat) => decide(seat, ev, { v: vv }), { by })
    if (out.legacy || (out.ok && out.action === 'none')) {
      // no seat: a checkout still on disk is put away (its person, or the system)
      const cur = await S.variationById(v.id)
      if (!cur?.worktree_path || (!system && !mayHold(cur, by))) return { ...out, kept: 0 }
      const W = await import('../workroom.js')
      W.closeRoom('variation', String(v.id), reason || L('작업본을 보관했어요 — 고친 것은 저장했어요.', 'The working copy was put away — what was changed is saved.'))
      await commitAsIs(folder, cur, { author: await personOf(by || cur.holder_id, cur), message: L('작업실 닫기', 'Close the workroom') })
      const gone = await S.release(folder, await S.variationById(v.id), { mode: 'person', who: by || cur.holder_id })
      if (status) await q(`update pro_folder_variations set status=$2, updated_at=now() where id=$1 and status in ('open','conflicted')`, [v.id, status])
      return { ok: true, action: 'release', kept: gone?.kept || 0 }
    }
    if (!out.ok) throw await refusal(out, folder, { me: me || (by ? { id: by } : null) })
    let kept = 0
    if (out.prev?.place === 'server') {
      try {
        await renew(v.id, out.epoch)
        kept = (await clearServer(folder, out.v, out.prev, { reason: reason || L('작업본을 보관했어요 — 고친 것은 저장했어요.', 'The working copy was put away — what was changed is saved.'), by })).kept
      } catch (e) { await putBack(v.id, out, e.message); throw e }
      await transition(v.id, (vv, seat) => (seat && Number(seat.epoch) === Number(out.epoch) ? { ok: true, next: null, bump: false, action: 'none' } : { ok: false, why: 'none' }))
    }
    if (status) await q(`update pro_folder_variations set status=$2, updated_at=now() where id=$1 and status in ('open','conflicted')`, [v.id, status])
    return { ...out, kept }
  }, { wait: wait ?? (system ? SYSTEM_WAIT_MS : USER_WAIT_MS) })
}

// Before a merge, a discard or a handover of a variation: the actor's own server place is put away first (committed as it is), so what goes
// on is everything; someone else's place, a computer's, or a running agent's is refused (ask for it back).
export async function forMove(folder, v, actor, { role = null } = {}) {
  return (await checkMove(folder, v, actor, { role })) ? closeMine(folder, v, actor) : null
}
// the same check without changing anything (a caller with more to check first): 'mine' — the actor's own server workroom, to be put away
// (closeMine) —, null — no seat, or refused with the seat
export async function checkMove(folder, v, actor, { role = null } = {}) {
  const seat = await seatOf(v.id, { v })
  if (!seat) return null
  if (seat.place === 'server' && seat.run === 'workroom' && seat.state === 'held' && String(seat.user_id) === String(actor.id)) return 'mine'
  const why = seat.state !== 'held' ? 'moving' : seat.place === 'device' ? (String(seat.user_id) === String(actor.id) ? 'device-mine' : 'device') : seat.run === 'agent' ? 'agent' : 'held'
  throw await refusal({ ok: false, why, v: await S.variationById(v.id), seat }, folder, { me: actor, role })
}
export const closeMine = (folder, v, actor) => closeServer(folder, v, { by: actor.id, me: actor,
  reason: L('이 변형을 넘기거나 반영해서 작업실을 닫았어요 — 고친 것은 저장했어요.', 'This variation was handed over or merged, so the workroom was closed — what you changed is saved.') })

// A server agent run's seat goes (its run ended and its checkout is off disk) — only with that run's epoch
export async function dropServer(vid, { epoch = null, by = null } = {}) {
  const out = await transition(vid, (vv, seat) => decide(seat, { type: 'drop', epoch }, { v: vv }), { by }).catch((e) => { console.warn('[seats] drop', e.message); return null })
  if (out?.ok) forget(vid)
  return out?.ok ? out : null
}

// A write into a person's server workroom (the workroom's PUT): one at a time with the moves of that variation, and only while the room is
// still that person's at the epoch it was read in — a write that comes after a move is refused, never landing in a folder that left
export async function guardedWrite(room, user, fn) {
  return onDisk(String(room.variation), async () => {
    const s = await seatOf(room.variation)
    const v = await S.variationById(room.variation)
    const ok = !!s && s.place === 'server' && s.run === 'workroom' && s.state === 'held' && String(s.user_id) === String(user?.id) && Number(s.epoch) === Number(room.epoch)
      && !!v?.worktree_path && v.worktree_path === room.root && fs.existsSync(room.root)
    if (!ok) throw err(409, L('그사이 작업본이 다른 곳으로 옮겨졌어요 — 새로 고쳐 보고 다시 해 주세요.', 'The working copy moved somewhere else meanwhile — reload and try again.'), { readonly: true })
    return fn()
  }, { wait: SAVE_WAIT_MS })
}

// ---------- a computer's place ----------
// A computer of the seat's person takes the variation (now: a chat's 「내 PC」 run on its project's variation — localAgents/chat.js prepare):
// their own web workroom gives it up (committed as it is); a server agent's turn, someone else, or another run is refused.
export async function claimDevice(folder, v, { user, device, job = null, ready = true }) {
  const [{ n } = { n: 0 }] = await q(`select count(*)::int as n from pro_variation_seats where tenant_id=$1 and user_id=$2 and place='device' and variation_id <> $3`, [T(), String(user.id), v.id])
    .catch((e) => { if (isLegacy(e)) return [{ n: 0 }]; throw e })
  if (n >= MAX_DEVICE_SEATS) throw await refusal({ ok: false, why: 'limit', v }, folder, { me: user })
  if (await integrating(folder, v.id)) throw await refusal({ ok: false, why: 'integrating', v }, folder, { me: user })
  const ev = { type: 'device', device, user: user.id, job, ready }
  return onDisk(String(v.id), async () => {
    const peek = await seatOf(v.id)
    const pre = peek ? decide(peek, ev, { v: await S.variationById(v.id) }) : null
    if (pre?.ok && pre.clear) await saveFirst(folder, v, peek)
    const out = await transition(v.id, (vv, seat) => decide(seat, ev, { v: vv }), { by: user.id })
    if (out.legacy) return out
    if (!out.ok) throw await refusal(out, folder, { me: user })
    if (out.clear && out.prev?.place === 'server') {
      try { await clearServer(folder, out.v, out.prev, { reason: L('이 변형을 내 PC 로 옮겨 작업실을 닫았어요 — 고친 것은 저장했어요.', 'This variation moved to your PC, so the workroom was closed — what you changed is saved.'), by: user.id }) }
      catch (e) { await putBack(v.id, out, e.message); throw e }
    }
    if (out.action !== 'same') emit(String(user.id), 'folders', { slug: folder.slug, variation: v.id })
    return out
  }, { wait: USER_WAIT_MS })
}
// a local run ended (done · failed · stopped · handed to the server): the seat it held goes (보관 중)
export async function releaseJob(job) {
  if (!job?.id) return null
  const rows = await q('select variation_id from pro_variation_seats where job_id=$1', [job.id]).catch((e) => { if (isLegacy(e)) return []; throw e })
  for (const r of rows) {
    const out = await transition(r.variation_id, (vv, seat) => (seat && String(seat.job_id || '') === String(job.id) ? { ok: true, next: null, bump: true, action: 'release' } : { ok: false, why: 'none' }),
      { by: job.user_id, note: `job ${String(job.id).slice(0, 8)} ${job.state}` })
    if (out.ok) {
      const v = out.v
      if (v.status === 'open') await q(`update pro_folder_variations set status='ready', updated_at=now() where id=$1 and status='open'`, [v.id])
      const f = await S.folderById(v.folder_id)
      if (f) emit(String(job.user_id), 'folders', { slug: f.slug, variation: v.id })
    }
  }
  return rows.length
}
// what a computer's place brought in (a run's push moved the variation): its last push, for 「방금 올림 · 마지막 올림 …」
export async function pushed(vid, head) {
  await q('update pro_variation_seats set pushed_at=now(), head=$2 where variation_id=$1', [vid, head || null]).catch((e) => { if (!isLegacy(e)) throw e })
}
// whether a local run still holds its variation's seat (its pushes come into the variation only then)
export async function jobHolds(vid, jobId) {
  const s = await seatOf(vid)
  if (s === undefined || s === null) return s === undefined ? true : null
  return String(s.job_id || '') === String(jobId)
}

// What a place that lost its seat still had (a computer that comes back after its seat was taken, a run whose result arrives after that):
// never thrown away and never mixed in silently — a variation of its own, 「<title> — <where> 에 남아 있던 변경」, held by that person, merged
// only through the batch merge like any other.
export async function leftover(folder, v, head, { user, where = '' } = {}) {
  if (!head) return null
  const base = await G.head(folder.repo_path, `refs/heads/${v.branch}`)
  if (base && (await G.mergeBase(folder.repo_path, head, base)) === head) return null // nothing the variation does not have
  const me = await personOf(user, v)
  const title = L(`${v.title} — ${where || 'PC'}에 남아 있던 변경`, `${v.title} — changes left on ${where || 'the PC'}`).slice(0, 120)
  const branch = `var/u/${String(user || 'me').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}/left-${String(v.id).slice(0, 8)}-${Date.now().toString(36)}`
  await G.git(folder.repo_path, ['branch', branch, head])
  const [nv] = await q(`insert into pro_folder_variations (folder_id, branch, title, kind, status, base_commit, head_commit, holder_type, holder_id, holder_name, source, created_by)
                        values ($1,$2,$3,'imported','ready',$4,$5,'user',$6,$7,$8,$9) returning *`,
  [folder.id, branch, title, await G.mergeBase(folder.repo_path, folder.default_branch, head), head, String(user || ''), me.name,
    { label: L(`${where || 'PC'}에 남아 있던 변경`, `Changes left on ${where || 'the PC'}`), left_of: v.id, device_name: where || null }, /^[0-9a-f-]{36}$/i.test(String(user || '')) ? user : null])
  await q(`insert into pro_variation_seat_log (tenant_id, variation_id, folder_id, by_user, action, note, head) values ($1,$2,$3,$4,'left',$5,$6)`, [T(), v.id, folder.id, String(user || ''), nv.id, head]).catch(() => {})
  await S.touch(folder)
  if (user) emit(String(user), 'folders', { slug: folder.slug, variation: nv.id })
  return nv
}

// ---------- people's actions ----------
// 「돌려 달라고 하기」: the seat's person is told (Home card · notification); the folder's owner may take it after a day without an answer
export async function recall(folder, v, by, { why = '', role = null } = {}) {
  const out = await transition(v.id, (vv, seat) => decide(seat, { type: 'recall', by: by.id, why }, { v: vv }), { by: by.id, note: String(why || '').slice(0, 200) })
  if (out.legacy) return { ok: false }
  if (!out.ok) throw await refusal(out, folder, { me: by, role })
  const to = String(out.seat.user_id)
  if (out.notify !== false && /^[0-9a-f-]{36}$/i.test(to)) {
    await withLang(await langOf(to).catch(() => 'ko'), async () => {
      const name = (await namesOf([by.id], v)).get(String(by.id)) || by.name || ''
      await q(`insert into notifications (id, user_id, title, type, description, url, from_user_id, tenant_id) values (gen_random_uuid(),$1,$2,'seat_recall',$3,$4,$5,$6)`,
        [to, L(`${name} 님이 「${v.title}」 작업본을 돌려 달라고 해요`, `${name} asks for "${v.title}" back`),
          L(`'${folder.name}' 폴더 · ${why ? `「${String(why).slice(0, 200)}」 · ` : ''}돌려놓으면 반영 · 인계를 이어 갈 수 있어요.`, `Folder '${folder.name}' · ${why ? `"${String(why).slice(0, 200)}" · ` : ''}give it back so the merge or handover can go on.`),
          `/folders/${folder.slug}/v/${v.id}`, by.email || null, T()]).catch((e) => console.warn('[seats] recall notice', e.message))
    })
    emit(to, 'notifications', {})
    emit(to, 'folders', { slug: folder.slug, variation: v.id })
  }
  return out
}

// 「여기로 가져오기」 (the seat's person, from wherever) or the owner's take (after a day without an answer, the computer off): the seat is none
// (보관 중) from its last saved state; a computer's later work comes back as a variation of its own. A local run that held it is asked to end.
export async function take(folder, v, by, { role = null, epoch = null } = {}) {
  const cur = await seatOf(v.id, { v })
  const H = await import('../localAgents/hub.js')
  const online = !!(cur?.device_id && H.linkOf(T(), String(cur.device_id)))
  const ev = { type: 'take', by: by.id, owner: role === 'owner', online, epoch }
  return onDisk(String(v.id), async () => {
    const peek = await seatOf(v.id)
    const pre = peek ? decide(peek, ev, { v: await S.variationById(v.id) }) : null
    if (pre?.ok && pre.clear) await saveFirst(folder, v, peek)
    const out = await transition(v.id, (vv, seat) => decide(seat, ev, { v: vv }), { by: by.id })
    if (out.legacy) return out
    if (!out.ok) throw await refusal(out, folder, { me: by, role })
    if (out.prev?.place === 'server') {
      try { await clearServer(folder, out.v, out.prev, { reason: L('폴더 소유자가 작업본을 가져가 작업실을 닫았어요 — 고친 것은 저장했어요.', 'The folder owner took the working copy, so the workroom was closed — what was changed is saved.'), by: by.id }) }
      catch (e) { await putBack(v.id, out, e.message); throw e }
      await transition(v.id, (vv, seat) => (seat && Number(seat.epoch) === Number(out.epoch) ? { ok: true, next: null, bump: false, action: 'none' } : { ok: false, why: 'none' }))
    }
    if (out.prev?.job_id) {
      const J = await import('../localAgents/jobs.js')
      const j = await J.byId(String(out.prev.job_id)).catch(() => null)
      if (j && ['queued', 'offered'].includes(j.state)) await J.cancel(j, 'taken').catch(() => {})
      else if (j?.state === 'running') { try { J.finish(j) } catch { /* its PC is off: its result comes back as a variation of its own */ } }
    }
    await q(`update pro_folder_variations set status='ready', updated_at=now() where id=$1 and status='open'`, [v.id])
    if (out.prev && String(out.prev.user_id) !== String(by.id) && /^[0-9a-f-]{36}$/i.test(String(out.prev.user_id))) emit(String(out.prev.user_id), 'folders', { slug: folder.slug, variation: v.id })
    return out
  }, { wait: USER_WAIT_MS })
}

// the seat's person's own switches (자동으로 올리기 · 같이 보기 — used by the desktop's working copy, design P1 · P2)
export async function setPrefs(folder, v, by, { autoSave, watch } = {}) {
  const s = await seatOf(v.id, { v })
  if (!s) throw err(409, L('이 변형은 보관 중이에요.', 'This variation is put away.'))
  if (String(s.user_id) !== String(by.id)) throw err(403, L('작업본을 가진 사람만 바꿀 수 있어요.', 'Only the person who has the working copy can change that.'))
  const [row] = await q(`update pro_variation_seats set auto_save=coalesce($2, auto_save), watch=coalesce($3, watch) where variation_id=$1 returning *`,
    [v.id, typeof autoSave === 'boolean' ? autoSave : null, ['me', 'folder'].includes(watch) ? watch : null])
  return row
}

// ---------- the sweep ----------
// Every 30 s, per tenant, and only where no other work holds the variation's lease (tryOnly — a move in progress elsewhere is left alone):
//   · moves that ran out of time end as 보관 중 (what the old place held was committed before it went), server seats whose checkout is gone
//   · a turn, a handover or a know-how edit whose process stopped saying it runs (seen_at older than DEAD_MS) — committed as it is, put
//     away. Never a step deepagents runs outside this server (its own end — stepTick — brings its result in), nor a chat change (its
//     process's next start finishes it: recoverChatRuns). On two servers a turn in another sub-topic of the same project may take the seat
//     from a turn still running on the other one: nothing is lost — that turn's result becomes a variation of its own (finishRun)
//   · a checkout with no seat at all (from before seats, or left by a crash) that nobody touched for ORPHAN_MS: committed as it is, put
//     away — not a step's or a chat change's (those end by their own paths), not while the variation is being merged
//   · kept folders older than keptDays are removed
// A variation whose checkout cannot be saved (a lock git still holds, a file it cannot read) is tried again later and later (BACKOFF), never
// with a new epoch or a record for the attempt that failed.
const ORPHAN_MS = 10 * 60_000
const failures = new Map() // variation id → {n, next}
export const backoffOf = (vid) => failures.get(String(vid)) || null
const BACKOFF = (n) => Math.min(30 * 60_000, 30_000 * 2 ** n)
function failed(vid, e) {
  const f = failures.get(String(vid)) || { n: 0 }
  f.n += 1
  f.next = Date.now() + BACKOFF(f.n)
  failures.set(String(vid), f)
  console.warn(`[seats] ${String(vid).slice(0, 8)} could not be put away (${f.n}×, again in ${Math.round(BACKOFF(f.n) / 1000)} s): ${e.message}`)
}
const waiting = (vid) => (failures.get(String(vid))?.next || 0) > Date.now()
export async function sweep() {
  let rows, orphans
  try {
    rows = await q(`select s.variation_id, s.place, s.run, s.state, s.work, s.epoch, v.worktree_path from pro_variation_seats s join pro_folder_variations v on v.id=s.variation_id
                    where s.tenant_id=$1 and ((s.state in ('moving','returning') and s.deadline < now()) or (s.place='server' and s.state='held' and v.worktree_path is null)
                      or (s.place='server' and s.run='agent' and s.state='held' and s.work = any($2) and coalesce(s.seen_at, s.since) < now() - ($3 || ' milliseconds')::interval))`,
    [T(), SWEPT, String(DEAD_MS)])
    orphans = await q(`select v.id from pro_folder_variations v join pro_folders f on f.id=v.folder_id
                       where f.tenant_id=$1 and v.worktree_path is not null and v.status in ('open','ready','conflicted') and v.kind not in ('run','chat','instance')
                         and v.updated_at < now() - ($2 || ' milliseconds')::interval
                         and not exists (select 1 from pro_variation_seats s where s.variation_id=v.id)
                         and not exists (select 1 from pro_folder_integrations i where i.folder_id=v.folder_id and i.status in ('running','conflicted','resolving') and v.id = any(i.variation_ids))`,
    [T(), String(ORPHAN_MS)])
  } catch (e) { if (isLegacy(e)) return 0; throw e }
  let n = 0
  for (const s of rows) {
    if (beating(s.variation_id, s.epoch) || waiting(s.variation_id)) continue // (this process runs it · tried a moment ago)
    const v = await S.variationById(s.variation_id)
    const f = v && await S.folderById(v.folder_id)
    if (!f) continue
    const dead = s.place === 'server' && s.run === 'agent' && s.state === 'held' && !!v.worktree_path
    const done = await onDisk(String(v.id), async () => {
      if (dead) {
        // (saved first: a checkout that cannot be saved changes nothing — no new epoch, no record — and is tried again later)
        await saveFirst(f, v, s)
        const out = await transition(v.id, (vv, seat) => (seat && seat.state === 'held' && seat.run === 'agent' && SWEPT.includes(seat.work) && Number(seat.epoch) === Number(s.epoch) ? { ok: true, next: { ...seat, state: 'returning', deadline: new Date(Date.now() + MOVE_MS) }, bump: true, action: 'expire' } : { ok: false, why: 'none' }), { note: `${s.work} stopped` })
        if (!out.ok) return null
        try { await clearServer(f, out.v, out.prev, { reason: L('에이전트의 실행이 멈춰 작업본을 보관했어요.', "The agent's run stopped, so its working copy was put away.") }) } catch (e) { await putBack(v.id, out, e.message); throw e }
        return transition(v.id, (vv, seat) => (seat && Number(seat.epoch) === Number(out.epoch) ? { ok: true, next: null, bump: false, action: 'none' } : { ok: false, why: 'none' }))
      }
      return transition(v.id, (vv, seat) => decide(seat, { type: 'expire' }, { v: vv }), { note: 'deadline' })
    }, { tryOnly: true }).catch((e) => { failed(v.id, e); return null })
    if (done && !done.busy) { n++; failures.delete(String(v.id)) }
  }
  for (const o of orphans) {
    if (waiting(o.id)) continue
    const v = await S.variationById(o.id)
    const f = v && await S.folderById(v.folder_id)
    if (!f) continue
    const done = await closeServer(f, v, { system: true, status: null, wait: 0, reason: L('아무도 쓰지 않던 작업본을 보관했어요.', 'A working copy nobody used was put away.') }).catch((e) => { if (e.why !== 'busy') failed(v.id, e); return null })
    if (done) { n++; failures.delete(String(v.id)) }
  }
  n += await freeStoppedEverywhere().catch((e) => { console.warn('[seats] stopped retires', e.message); return 0 })
  n += await S.keepStoppedStagings().catch((e) => { console.warn('[seats] stopped retires\' copies', e.message); return 0 })
  n += await dropOldKept().catch((e) => { console.warn('[seats] kept', e.message); return 0 })
  return n
}
// every few minutes: the worktree entries that retires left locked when their server stopped mid-way (S.freeStoppedRetires), in every
// folder of this company
const RETIRE_SCAN_MS = 5 * 60_000
const scanned = new Map() // company → when
async function freeStoppedEverywhere() {
  if (Date.now() - (scanned.get(T()) || 0) < RETIRE_SCAN_MS) return 0
  scanned.set(T(), Date.now())
  let n = 0
  for (const f of await q('select repo_path from pro_folders where tenant_id=$1', [T()])) {
    if (f.repo_path) n += (await S.freeStoppedRetires(f.repo_path).catch(() => ({ freed: 0 }))).freed
  }
  return n
}

// ---------- what was kept ----------
// What git does not carry, kept when a server place left the disk (S.release → retire: <folders>/.kept/<variation>/<time>): a person's
// workroom keeps it all, a server agent run only what is not .gitignore'd (its caches and logs are dropped), a run whose commit failed
// everything. Recorded on the variation (pro_variation_seat_log action 'kept'), listed on its screen with a download, removed keptDays
// (PRO_KEPT_DAYS, 14 by default) after it was kept: its record's time (what the screen shows), else the time in its folder's name, else
// that folder's own time (a whole checkout moved there may carry an old one).
export const keptDays = () => Math.max(1, Number(process.env.PRO_KEPT_DAYS) || 14)
const timeInName = (n) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(n)
  const t = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN
  return Number.isFinite(t) ? t : null
}
export async function dropOldKept() {
  const root = S.keptRootOf()
  let n = 0
  const cut = Date.now() - keptDays() * 86400_000
  const vids = await fsp.readdir(root).catch(() => [])
  const recorded = new Map()
  const ids = vids.filter((x) => /^[0-9a-f-]{36}$/i.test(x))
  if (ids.length) {
    for (const r of await q(`select at, note from pro_variation_seat_log where action='kept' and variation_id = any($1::uuid[])`, [ids]).catch(() => [])) {
      try { const d = JSON.parse(r.note || '{}').dir; if (d) recorded.set(path.normalize(d), new Date(r.at).getTime()) } catch { /* an old row */ }
    }
  }
  for (const vid of vids) {
    for (const at of await fsp.readdir(path.join(root, vid)).catch(() => [])) {
      const p = path.join(root, vid, at)
      const t = recorded.get(path.join(vid, at)) ?? timeInName(at) ?? (await fsp.stat(p).catch(() => null))?.mtimeMs
      if (t != null && t < cut) { await fsp.rm(p, { recursive: true, force: true }); n++ }
    }
    if (!(await fsp.readdir(path.join(root, vid)).catch(() => [])).length) await fsp.rmdir(path.join(root, vid)).catch(() => {})
  }
  return n
}
// may this person see it: whose place it was, the variation's own person, or the folder's owner
const mayGetKept = (row, v, { me, role }) => role === 'owner' || (!!me && (String(row.by_user || '') === String(me.id) || (v.holder_type === 'user' && String(v.holder_id) === String(me.id))))
const keptPath = (row) => { try { const n = JSON.parse(row.note || '{}'); return n.dir ? path.join(S.keptRootOf(), n.dir) : null } catch { return null } }
// the variation's kept folders that are still there: [{id, at, until, count, bytes, from, why, canGet}] — no path
export async function keptOf(folder, v, { me = null, role = null } = {}) {
  const rows = await q(`select id, at, by_user, note from pro_variation_seat_log where variation_id=$1 and action='kept' order by at desc limit 20`, [v.id]).catch(() => [])
  const out = []
  for (const r of rows) {
    const p = keptPath(r)
    if (!p || !p.startsWith(S.keptRootOf() + path.sep) || !(await fsp.stat(p).catch(() => null))) continue
    let n = {}
    try { n = JSON.parse(r.note || '{}') } catch { /* an old row */ }
    out.push({ id: String(r.id), at: r.at, until: new Date(new Date(r.at).getTime() + keptDays() * 86400_000).toISOString(), count: n.count ?? null, bytes: n.bytes || 0,
      from: n.mode === 'agent' || n.mode === 'all' ? 'agent' : 'workroom', why: n.why ? 'unsaved' : null, canGet: mayGetKept(r, v, { me, role }) })
  }
  return out
}
// A kept folder goes down as one zip within limits — PRO_KEPT_ZIP_MAX_MB (200 MB in all) and PRO_KEPT_FILE_MAX_MB (100 MB a file) — its
// size counted at that moment (what was recorded is not trusted: a whole folder kept before recorded none). Past a limit it is refused
// (413 'too-big': which file, how much, the limit); the files stay on the server until their days pass. A few zips at once on a server
// (PRO_KEPT_ZIPS_AT_ONCE, 2 — 409 busy past it). Each file is opened only when the zip comes to it and read as it streams out (lazyFile).
const MB = 1024 * 1024
const limitMb = (x, d) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : d }
export const keptZipMaxMb = () => limitMb(process.env.PRO_KEPT_ZIP_MAX_MB, 200)
export const keptFileMaxMb = () => limitMb(process.env.PRO_KEPT_FILE_MAX_MB, 100)
const zipsAtOnce = () => Math.max(1, Math.floor(Number(process.env.PRO_KEPT_ZIPS_AT_ONCE)) || 2)
export const keptZipMaxFiles = () => Math.max(1, Math.floor(Number(process.env.PRO_KEPT_ZIP_MAX_FILES)) || 20_000)
let zipping = 0
export const zipsGoing = () => zipping
const mbText = (bytes) => { const m = bytes / MB; return `${m >= 10 ? Math.round(m) : m.toFixed(1)} MB` }
const keptGone = () => err(404, L('남겨 둔 파일을 찾지 못했어요(보관 기간이 지났을 수 있어요).', 'The kept files are not there (their time may have passed).'), { why: 'gone' })
const zipsBusy = () => err(409, L('지금 다른 내려받기 파일을 만들고 있어요. 잠시 후 다시 시도해 주세요.', 'Other downloads are being made right now. Try again in a moment.'), { why: 'busy' })
// the files of a kept folder, a link never followed → {files: [{rel, full, size}], bytes, big: the first file past its limit, over}; a
// folder that went away meanwhile (the sweep) → 404 'gone'
async function keptFiles(dir, { fileMax, allMax, filesMax = Infinity }) {
  const out = { files: [], bytes: 0, big: null, over: false, many: false }
  const walk = async (d, rel) => {
    const ents = await fsp.readdir(d, { withFileTypes: true }).catch((e) => { throw ['ENOENT', 'ENOTDIR'].includes(e.code) ? keptGone() : e })
    for (const e of ents) {
      if (out.big || out.many) return
      const full = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { await walk(full, r); continue }
      const st = e.isFile() ? await fsp.lstat(full).catch(() => null) : null
      if (!st?.isFile()) continue
      if (st.size > fileMax) { out.big = { rel: r, size: st.size }; return }
      out.bytes += st.size
      if (out.bytes > allMax) out.over = true
      if (!out.over) out.files.push({ rel: r, full, size: st.size })
      if (out.files.length > filesMax) { out.many = true; return }
    }
  }
  await walk(dir, '')
  return out
}
// One kept file as the zip reads it: opened only then (never following a link put in its place since it was counted — O_NOFOLLOW), read
// up to the size counted. A file that grew meanwhile (something still writing it) goes in as it was counted; one that is not a plain file
// of at least that size any more (shorter, gone, a link) fails the zip — never a wrong or empty copy inside it. A stream given up while it
// opens its file closes that file.
const CHUNK = 64 * 1024
function lazyFile(full, size) {
  let fh = null, done = 0
  const changed = () => Object.assign(new Error('a kept file changed while it was being zipped'), { code: 'KEPT_CHANGED' })
  return new Readable({
    highWaterMark: CHUNK,
    async read() {
      try {
        if (!fh) {
          const h = await fsp.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
          if (this.destroyed) { await h.close().catch(() => {}); return }
          fh = h
          const st = await fh.stat()
          if (!st.isFile() || st.size < size) throw changed()
        }
        if (done >= size) {
          const h = fh
          fh = null
          await h.close().catch(() => {})
          this.push(null)
          return
        }
        const want = Math.min(CHUNK, size - done)
        const { bytesRead, buffer } = await fh.read(Buffer.alloc(want), 0, want, done)
        if (!bytesRead) throw changed()
        done += bytesRead
        this.push(buffer.subarray(0, bytesRead))
      } catch (e) { this.destroy(e.code === 'ELOOP' || e.code === 'ENOENT' ? changed() : e) }
    },
    destroy(e, cb) {
      const h = fh
      fh = null
      if (!h) return cb(e)
      h.close().catch(() => {}).finally(() => cb(e))
    },
  })
}
// one kept folder as a zip (files only — a link is not followed) → {stream (a Node Readable), name, bytes, count}; check: only whether it
// may now (→ {ok, bytes, count} — the page asks before it downloads, so a refusal is said on the page)
export async function keptZip(folder, v, id, { me = null, role = null, check = false } = {}) {
  const [r] = await q(`select id, at, by_user, note from pro_variation_seat_log where id=$1 and variation_id=$2 and action='kept'`, [String(id).replace(/\D/g, '') || 0, v.id])
  const p = r && keptPath(r)
  if (!p || !p.startsWith(S.keptRootOf() + path.sep) || !(await fsp.stat(p).catch(() => null))) throw keptGone()
  if (!mayGetKept(r, v, { me, role })) throw err(403, L('그 작업본을 가졌던 사람과 폴더 소유자만 내려받을 수 있어요.', 'Only whoever had that working copy and the folder owner can download it.'))
  const fileMb = keptFileMaxMb(), allMb = keptZipMaxMb(), filesMax = keptZipMaxFiles()
  const got = await keptFiles(p, { fileMax: fileMb * MB, allMax: allMb * MB, filesMax })
  if (got.many) {
    throw err(413, L(`남긴 파일이 ${filesMax.toLocaleString('ko-KR')}개를 넘어 한 번에 내려받을 수 있는 개수 한도를 넘었어요. 남긴 파일은 보관 기간 동안 서버에 그대로 있으니 관리자에게 파일을 꺼내 달라고 요청해 주세요.`,
      `There are more than ${filesMax.toLocaleString('en-US')} kept files, more than can be downloaded at once. They stay on the server until their days pass — ask an administrator to get them out.`), { why: 'too-big' })
  }
  if (got.big) {
    throw err(413, L(`「${got.big.rel}」 파일의 크기가 ${mbText(got.big.size)}로, 한 번에 내려받을 수 있는 한도(파일 하나에 ${fileMb} MB)를 넘었어요. 남긴 파일은 보관 기간 동안 서버에 그대로 있으니 관리자에게 파일을 꺼내 달라고 요청해 주세요.`,
      `"${got.big.rel}" is ${mbText(got.big.size)}, more than can be downloaded at once (${fileMb} MB a file). The kept files stay on the server until their days pass — ask an administrator to get them out.`), { why: 'too-big' })
  }
  if (got.over) {
    throw err(413, L(`남긴 파일의 전체 크기가 ${mbText(got.bytes)}로, 한 번에 내려받을 수 있는 한도(${allMb} MB)를 넘었어요. 남긴 파일은 보관 기간 동안 서버에 그대로 있으니 관리자에게 파일을 꺼내 달라고 요청해 주세요.`,
      `The kept files come to ${mbText(got.bytes)}, more than can be downloaded at once (${allMb} MB). They stay on the server until their days pass — ask an administrator to get them out.`), { why: 'too-big' })
  }
  if (zipping >= zipsAtOnce()) throw zipsBusy()
  if (check) return { ok: true, bytes: got.bytes, count: got.files.length }
  // (the zip counts from here until it is over — read to the end, failed, or given up by the one downloading it — and its files are
  // closed then; nothing is made before it is read)
  zipping++
  let zip, files
  try {
    const JSZip = (await import('jszip')).default
    zip = new JSZip()
    files = got.files.map((f) => { const s = lazyFile(f.full, f.size); zip.file(f.rel, s); return s })
  } catch (e) { zipping--; throw e }
  let inner = null
  const out = new Readable({
    read() {
      if (inner) { inner.resume(); return }
      inner = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' })
      inner.on('data', (c) => { if (!out.push(c)) inner.pause() })
      inner.on('end', () => out.push(null))
      inner.on('error', (e) => out.destroy(e))
    },
    destroy(e, cb) {
      zipping--
      inner?.pause()
      for (const f of files) f.destroy()
      cb(e)
    },
  })
  return { stream: out, bytes: got.bytes, count: got.files.length, name: `${String(v.title || 'kept').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}-kept.zip` }
}
let timer = null
// (the second argument is kept for the callers of P0 — every sweep is the same now: a process that stopped is told by its silence)
export function startSeatSweep(each, _opts = {}) {
  if (timer) return
  const tick = () => each(() => sweep()).catch((e) => console.warn('[seats] sweep', e.message)).finally(() => { timer = setTimeout(tick, 30_000) })
  timer = setTimeout(tick, 20_000)
}

// what the folder header's 「작업실」 sheet needs at once (design §2 — the sheet itself comes with the desktop's working copy, P1 · P2): my
// live variations with their seats, my computers by name (on or off, their CLIs — no id of a computer is a path), and whether I may open main
export async function workroomChoices(folder, me, role) {
  const vs = await q(`select * from pro_folder_variations where folder_id=$1 and holder_type='user' and holder_id=$2 and status in ('open','ready','conflicted') order by updated_at desc limit 30`, [folder.id, String(me.id)])
  const views = await viewsOf(folder, vs, { me, role })
  const H = await import('../localAgents/hub.js')
  const D = await import('../localAgents/devices.js')
  const on = new Set(H.linksOf(T(), me.id).map((l) => String(l.id)))
  const devices = (await D.list(me).catch(() => [])).filter((d) => !d.revoked).map((d) => ({ name: d.name, online: on.has(String(d.id)),
    clis: Object.entries(d.caps?.clis || {}).filter(([, c]) => c.installed).map(([k]) => k), seats: !!d.caps?.seats }))
  return { mine: vs.map((v) => ({ id: v.id, title: v.title, branch: v.branch, status: v.status, seat: views.get(String(v.id)) })), devices,
    canMain: (S.RANK[role] || 0) >= S.RANK.editor && folder.kind === 'managed', ...room(folder) }
}
