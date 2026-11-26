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
// Before sql/063 runs there is no seat table: everything here then answers as before seats existed (legacy), and says so once in the log.
import fs from 'node:fs'
import { config } from '../../config.js'
import { q, pool } from '../supa.js'
import { emit } from '../bus.js'
import { L, langOf, withLang } from '../lang.js'
import * as S from './service.js'
import * as G from './git.js'

const T = () => config.tenantId
export const MOVE_MS = 90_000
export const RECALL_WAIT_MS = 24 * 3600_000
export const MAX_DEVICE_SEATS = 20
const LIVE = ['open', 'ready', 'conflicted']
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })

// ---------- the rules (pure) ----------
// whose a variation is to open: a person's variation only by that person; an agent's (a run, an imported branch) by anyone who may run it
export function mayHold(v, actorId) {
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
// ev: {type: 'open', run, user} · {type: 'device', device, user, job} · {type: 'settle', epoch} · {type: 'release', by, epoch?, system?}
//     · {type: 'take', by, owner, online, epoch?} · {type: 'recall', by, why} · {type: 'drop'} · {type: 'expire'}
// → {ok: true, next (a row without epoch — null: none), bump (a new epoch), clear (the old server checkout is committed and taken off disk),
//    action} | {ok: false, why}
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
      if (!s) return { ok: true, next: { place: 'server', state: 'moving', run, user_id: String(ev.user), device_id: null, job_id: null, since: at, deadline: until }, bump: true, clear: false, action: 'open' }
      if (moving) return no('moving')
      if (s.place === 'device') return no(me(ev.user) ? 'device-mine' : 'device')
      if (!me(ev.user)) return no(s.run === 'agent' ? 'agent' : 'held')
      if (s.run === run) return { ok: true, next: s, bump: false, clear: false, action: 'same' }
      // the person's own: their agent's turn takes it from their workroom (what the workroom holds is committed first); their workroom
      // does not take it from a turn that is running
      if (s.run === 'agent') return no('agent')
      return { ok: true, next: { ...s, state: 'moving', run, since: at, deadline: until, recall: null }, bump: true, clear: true, action: 'move' }
    }
    case 'device': {
      // a computer of the seat's person (now a chat's 「내 PC」 run on a project's variation: held at once, the run's own push brings its
      // work in; the desktop's working copy will answer ready — design P1)
      const next = { place: 'device', state: ev.ready === false ? 'moving' : 'held', run: null, user_id: String(ev.user), device_id: String(ev.device), job_id: ev.job ? String(ev.job) : null,
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
    case 'recall':
      if (!s) return no('none')
      if (me(ev.by)) return no('self')
      if (s.run === 'agent' && s.place === 'server') return no('agent')
      return { ok: true, next: { ...s, recall: { by: String(ev.by), at: at.toISOString(), why: String(ev.why || '').slice(0, 300) } }, bump: false, clear: false, action: 'recall' }
    case 'drop':
      // a server checkout went off disk (its run committed and released it): its seat goes with it
      if (!seat || seat.place !== 'server' || seat.state !== 'held') return no('none')
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
      const { rows: [row] } = await c.query(`insert into pro_variation_seats (variation_id, tenant_id, folder_id, place, state, user_id, device_id, run, job_id, epoch, since, deadline, recall)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             on conflict (variation_id) do update set place=$4, state=$5, user_id=$6, device_id=$7, run=$8, job_id=$9, epoch=$10, since=$11, deadline=$12, recall=$13,
               dirty=case when pro_variation_seats.place=$4 and pro_variation_seats.device_id is not distinct from $7 then pro_variation_seats.dirty else 0 end,
               ahead=case when pro_variation_seats.place=$4 and pro_variation_seats.device_id is not distinct from $7 then pro_variation_seats.ahead else 0 end
             returning *`,
      [vid, T(), v.folder_id, n.place, n.state, String(n.user_id), n.device_id || null, n.run || null, n.job_id || null, epoch, n.since || new Date(), n.deadline || null, n.recall ? JSON.stringify(n.recall) : null])
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
  }[out.why] || L('지금은 이 변형의 작업본을 옮길 수 없어요.', "This variation's working copy can't move right now.")
  return err(409, text, { seat: view, why: out.why })
}

// ---------- the server's own places ----------
// one line of git work per variation at a time in this process (a commit, a checkout, a removal): the row lock orders the decisions,
// this orders what follows them on disk
const disk = new Map()
const onDisk = (vid, fn) => {
  const run = (disk.get(vid) || Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  disk.set(vid, tail)
  tail.then(() => { if (disk.get(vid) === tail) disk.delete(vid) })
  return run
}
async function personOf(id, v) {
  if (!id) return { name: v?.holder_name || 'Process GPT Lite', email: undefined }
  const [p] = await q('select name, email from pro_profile where user_id::text=$1', [String(id)]).catch(() => [])
  if (p) return { name: p.name || p.email || v?.holder_name || 'Process GPT Lite', email: p.email || undefined }
  const [u] = await q('select username, email from users where id::text=$1', [String(id)]).catch(() => [])
  return { name: u?.username || v?.holder_name || 'Process GPT Lite', email: u?.email || `${String(id).slice(0, 8)}@agents.pgpt-pro.local` }
}
// What a server checkout holds, committed as it is (its person the author — nothing reset, nothing cleaned), the variation's head
// following; its status is left as it is. → the new head, or null when nothing was there to commit
export async function commitAsIs(folder, v, { author, message } = {}) {
  const cur = await S.variationById(v.id)
  if (!cur?.worktree_path || !fs.existsSync(cur.worktree_path)) return null
  const sha = await G.commitAll(cur.worktree_path, message || L('작업실에서 옮김', 'Moved from the workroom'), author || await personOf(cur.holder_id, cur))
    .catch((e) => { console.warn('[seats] commit as is', e.message); return null })
  const head = await G.head(folder.repo_path, `refs/heads/${cur.branch}`)
  await q('update pro_folder_variations set head_commit=$2, updated_at=now() where id=$1', [cur.id, head])
  if (sha) await S.touch(folder)
  return sha
}
// the old server place goes: committed as it is (by the seat's person), its shells closed with a word to whoever watches, off disk
async function clearServer(folder, v, prev, { reason, by } = {}) {
  const author = await personOf(prev?.user_id || v.holder_id, v)
  const sha = await commitAsIs(folder, v, { author, message: L('작업실에서 옮김', 'Moved from the workroom') })
  const W = await import('../workroom.js')
  W.closeRoom('variation', String(v.id), reason || L('작업본이 다른 곳으로 옮겨져 이 작업실을 닫았어요.', 'The working copy moved elsewhere, so this workroom was closed.'))
  const cur = await S.variationById(v.id)
  if (cur?.worktree_path) await S.release(folder, cur, { seat: false })
  if (by) emit(String(by), 'folders', { slug: folder.slug, variation: v.id })
  return sha
}
const room = (folder) => ({ slug: folder.slug })

// Open a variation in a server place: the web workroom of its person (run 'workroom') or a server agent run (run 'agent'), its branch on
// disk at `dir` (S.checkout). Refused (409, with the seat) when its seat is someone else's, a computer's, or moving.
export async function openServer(folder, v, { user, run = 'agent', dir }) {
  if (run === 'workroom') {
    if (!mayHold(v, user.id)) throw await refusal({ ok: false, why: 'not-yours', v, seat: await seatOf(v.id) }, folder, { me: user })
    const [busy] = await q(`select 1 from pro_folder_integrations where folder_id=$1 and status in ('running','conflicted','resolving') and $2 = any(variation_ids) limit 1`, [folder.id, v.id])
    if (busy) throw await refusal({ ok: false, why: 'integrating', v }, folder, { me: user })
  }
  return onDisk(String(v.id), async () => {
    const out = await transition(v.id, (vv, seat) => decide(seat, { type: 'open', run, user: user.id }, { v: vv }), { by: user.id })
    if (out.legacy) { await S.checkout(folder, await S.variationById(v.id), dir); return out }
    if (!out.ok) throw await refusal(out, folder, { me: user })
    try {
      if (out.clear) await clearServer(folder, out.v, out.prev, { reason: run === 'agent' ? L('에이전트가 이 변형에서 일을 시작해 작업실을 닫았어요 — 고친 것은 저장했어요.', 'An agent started working on this variation, so the workroom was closed — what you changed is saved.') : undefined })
      await S.checkout(folder, await S.variationById(v.id), dir)
      if (out.action === 'same') return out
      const done = await transition(v.id, (vv, seat) => decide(seat, { type: 'settle', epoch: out.epoch }, { v: vv }), { by: user.id })
      if (!done.ok) throw await refusal(done, folder, { me: user })
      return { ...out, seat: done.seat }
    } catch (e) {
      if (out.action !== 'same') await transition(v.id, (vv, seat) => (seat && Number(seat.epoch) === Number(out.epoch) ? { ok: true, next: null, bump: false, action: 'fail' } : { ok: false, why: 'none' }), { by: user.id, note: String(e.message).slice(0, 200) }).catch(() => {})
      throw e
    }
  })
}

// Put a server place away (돌려놓기 · 작업실 닫기): what it holds is committed as it is, it goes off disk, the seat is none (보관 중) and the
// variation is ready to review. by: who asks (the seat's person, unless system); epoch: the one the page saw.
export async function closeServer(folder, v, { by, epoch = null, system = false, status = 'ready', reason, me = null } = {}) {
  return onDisk(String(v.id), async () => {
    const out = await transition(v.id, (vv, seat) => decide(seat, { type: 'release', by, epoch, system }, { v: vv }), { by })
    if (out.legacy) {
      const cur = await S.variationById(v.id)
      if (cur.worktree_path) { await commitAsIs(folder, cur, { author: await personOf(by, cur), message: L('작업실 닫기', 'Close the workroom') }); await S.release(folder, cur) }
      return { ok: true, action: 'release' }
    }
    if (!out.ok) throw await refusal(out, folder, { me: me || (by ? { id: by } : null) })
    if (out.action === 'none') return out
    if (out.prev?.place === 'server') {
      await clearServer(folder, out.v, out.prev, { reason: reason || L('작업본을 보관했어요 — 고친 것은 저장했어요.', 'The working copy was put away — what was changed is saved.'), by })
      await transition(v.id, (vv, seat) => (seat && Number(seat.epoch) === Number(out.epoch) ? { ok: true, next: null, bump: false, action: 'none' } : { ok: false, why: 'none' }))
    }
    if (status) await q(`update pro_folder_variations set status=$2, updated_at=now() where id=$1 and status in ('open','conflicted')`, [v.id, status])
    return out
  })
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

// A server agent run's checkout went (S.release): its seat goes with it
export async function dropServer(vid, by = null) {
  const out = await transition(vid, (vv, seat) => decide(seat, { type: 'drop' }, { v: vv }), { by }).catch((e) => { console.warn('[seats] drop', e.message); return null })
  return out?.ok ? out : null
}

// ---------- a computer's place ----------
// A computer of the seat's person takes the variation (now: a chat's 「내 PC」 run on its project's variation — localAgents/chat.js prepare):
// their own web workroom gives it up (committed as it is); a server agent's turn, someone else, or another run is refused.
export async function claimDevice(folder, v, { user, device, job = null, ready = true }) {
  const [{ n } = { n: 0 }] = await q(`select count(*)::int as n from pro_variation_seats where tenant_id=$1 and user_id=$2 and place='device' and variation_id <> $3`, [T(), String(user.id), v.id])
    .catch((e) => { if (isLegacy(e)) return [{ n: 0 }]; throw e })
  if (n >= MAX_DEVICE_SEATS) throw await refusal({ ok: false, why: 'limit', v }, folder, { me: user })
  return onDisk(String(v.id), async () => {
    const out = await transition(v.id, (vv, seat) => decide(seat, { type: 'device', device, user: user.id, job, ready }, { v: vv }), { by: user.id })
    if (out.legacy) return out
    if (!out.ok) throw await refusal(out, folder, { me: user })
    if (out.clear && out.prev?.place === 'server') await clearServer(folder, out.v, out.prev, { reason: L('이 변형을 내 PC 로 옮겨 작업실을 닫았어요 — 고친 것은 저장했어요.', 'This variation moved to your PC, so the workroom was closed — what you changed is saved.'), by: user.id })
    if (out.action !== 'same') emit(String(user.id), 'folders', { slug: folder.slug, variation: v.id })
    return out
  })
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
  if (/^[0-9a-f-]{36}$/i.test(to)) {
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
  return onDisk(String(v.id), async () => {
    const out = await transition(v.id, (vv, seat) => decide(seat, { type: 'take', by: by.id, owner: role === 'owner', online, epoch }, { v: vv }), { by: by.id })
    if (out.legacy) return out
    if (!out.ok) throw await refusal(out, folder, { me: by, role })
    if (out.prev?.place === 'server') {
      await clearServer(folder, out.v, out.prev, { reason: L('폴더 소유자가 작업본을 가져가 작업실을 닫았어요 — 고친 것은 저장했어요.', 'The folder owner took the working copy, so the workroom was closed — what was changed is saved.'), by: by.id })
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
  })
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
// moves that ran out of time end as 보관 중 (what the old place held was committed before it went); a server agent's seat from before this
// process started is a run that died with it: committed as it is and put away
const STARTED = new Date()
export async function sweep({ restart = false } = {}) {
  let rows
  try {
    rows = await q(`select s.*, v.worktree_path from pro_variation_seats s join pro_folder_variations v on v.id=s.variation_id
                    where s.tenant_id=$1 and ((s.state in ('moving','returning') and s.deadline < now()) or (s.place='server' and s.state='held' and v.worktree_path is null)
                      or ($2 and s.place='server' and s.run='agent' and s.since < $3))`, [T(), restart, STARTED])
  } catch (e) { if (isLegacy(e)) return 0; throw e }
  for (const s of rows) {
    const v = await S.variationById(s.variation_id)
    const f = v && await S.folderById(v.folder_id)
    if (!f) continue
    if (s.place === 'server' && s.run === 'agent' && s.state === 'held' && v.worktree_path) {
      await closeServer(f, v, { system: true, status: null, reason: L('서버가 다시 시작돼 에이전트의 작업본을 보관했어요.', "The server restarted, so the agent's working copy was put away.") }).catch((e) => console.warn('[seats] sweep', e.message))
      continue
    }
    await transition(s.variation_id, (vv, seat) => decide(seat, { type: 'expire' }, { v: vv }), { note: 'deadline' }).catch((e) => console.warn('[seats] expire', e.message))
  }
  return rows.length
}
let timer = null
export function startSeatSweep(each, { restart = true } = {}) {
  if (timer) return
  const tick = () => each(() => sweep()).catch((e) => console.warn('[seats] sweep', e.message)).finally(() => { timer = setTimeout(tick, 30_000) })
  timer = setTimeout(() => each(() => sweep({ restart })).catch(() => {}).finally(() => { timer = setTimeout(tick, 30_000) }), 20_000)
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
