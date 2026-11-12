// Work intake and the bolt line of a folder's AI-DLC project (docs/robo-dlc/plan-intake.md, plan-p3-impl.md).
// Anyone in the project asks for work in their own words; Lite proposes how it should enter (compose.js);
// the people who take in work approve it — start now, after the work in flight, or folded into it — and it
// joins the one line of bolts (line.js). A bolt can be moved between releases, held, stopped and discarded
// by the people the project gave that to; a running bolt's files go back to where it started (snapshot.js)
// and the AI-DLC record stays. Every such decision is kept in the folder's ledger and told to who it concerns.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { q } from '../supa.js'
import { config } from '../../config.js'
import { L, isEn } from '../lang.js'
import { emit } from '../bus.js'
import { notifyUser } from '../notify.js'
import * as F from '../folders/service.js'
import * as R from './record.js'
import * as M from './metrics.js'
import * as AS from './session.js'
import * as TM from './team.js'
import * as LN from './line.js'
import * as C from './compose.js'
import * as SNAP from './snapshot.js'
import { roleName } from './stages.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const run = promisify(execFile)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const oneLine = (s, n = 1500) => String(s || '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, n)
const nameOf = (folder) => AS.sessionName(T(), folder.slug)
const pub = (f) => ({ id: f.id, slug: f.slug, name: f.name })
const lineUrl = (slug, key) => `/apps/line/${slug}${key ? `?b=${encodeURIComponent(key)}` : ''}`
const intakeUrl = (slug, id) => `/apps/intake/${slug}${id ? `?r=${id}` : ''}`

// ---------- who may do what (plan-intake.md §11, D-1112-23) ----------
// by the AI-DLC role a person holds in the folder; the folder's owners may do all of it
export const MAY = {
  intake: ['product', 'team-lead'],    // take in work: approve a plan, order the line, release
  impact: ['architect', 'team-lead'],  // confirm what a request touches
  stop: ['team-lead', 'product'],      // hold, stop and discard a bolt
  archive: ['team-lead'],              // put a discarded intent away
}
export async function rightsOf(folder, user) {
  const role = user ? await F.roleOf(folder, user) : null
  const keys = user ? (await q('select role_key from pro_aidlc_roles where tenant_id=$1 and folder_id=$2 and user_id=$3', [T(), folder.id, user.id])).map((x) => x.role_key) : []
  const owner = role === 'owner'
  return { member: !!role, owner, roles: keys, ...Object.fromEntries(Object.entries(MAY).map(([k, list]) => [k, !!role && (owner || list.some((r) => keys.includes(r)))])) }
}
// the people a right belongs to: the roles' holders; with nobody in them, the folder's owners
async function holdersOf(folder, right) {
  const rows = await q(`select distinct r.user_id as id, coalesce(p.name, u.username, u.email) as name from pro_aidlc_roles r
                        left join users u on u.id = r.user_id and u.tenant_id = r.tenant_id left join pro_profile p on p.user_id = r.user_id
                        where r.tenant_id=$1 and r.folder_id=$2 and r.role_key = any($3)`, [T(), folder.id, MAY[right]])
  if (rows.length) return rows
  return (await F.members(folder.id)).filter((m) => m.type === 'user' && m.role === 'owner' && !m.is_agent).map((m) => ({ id: m.id, name: m.name }))
}
const must = async (folder, user, right) => {
  const r = await rightsOf(folder, user)
  if (!r[right]) throw err(403, L(`이 일은 ${MAY[right].map(roleName).join('·')} 역할이 할 수 있어요`, `This is for the ${MAY[right].map(roleName).join(' / ')} role`))
  return r
}

// ---------- telling people ----------
// open screens of the folder look again (both apps listen: lite.on('aidlc.intake'))
async function tell(folder, what, data = {}) {
  for (const m of await F.members(folder.id)) if (m.type === 'user' && !m.is_agent) emit(m.id, 'app', { app: '*', folder: folder.slug, type: 'aidlc.intake', data: { what, ...data } })
}
async function card(folder, people, { title, text, url }, except = null) {
  const told = new Set()
  for (const p of people) {
    if (!p?.id || p.id === except || told.has(p.id)) continue
    told.add(p.id)
    await notifyUser(p.id, { type: 'aidlc', title: `${folder.name} · ${title}`, text: String(text || '').slice(0, 400), url }).catch((e) => console.warn('[aidlc intake] card', e.message))
  }
}
// kinds: intake | triage | impact | line | stop | discard
async function record(folder, user, { intent = null, kind, question, choice, note }) {
  await q(`insert into pro_aidlc_decisions(tenant_id,folder_id,intent,stage,kind,question,choice,note,user_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [T(), folder.id, intent, null, kind, String(question || '').slice(0, 1000) || null, String(choice || '').slice(0, 500) || null, String(note || '').slice(0, 2000) || null, user.id])
}
export const LEDGER_KINDS = ['intake', 'triage', 'impact', 'line', 'stop', 'discard']
async function ledgerOf(folder, limit = 30) {
  return q(`select d.kind, d.intent, d.question, d.choice, d.note, d.created_at as at, coalesce(p.name, u.username, u.email) as who from pro_aidlc_decisions d
            left join users u on u.id = d.user_id and u.tenant_id = d.tenant_id left join pro_profile p on p.user_id = d.user_id
            where d.tenant_id=$1 and d.folder_id=$2 and d.kind = any($3) order by d.created_at desc limit $4`, [T(), folder.id, LEDGER_KINDS, limit])
}

// ---------- reading the project ----------
const isDone = (intent, state) => intent?.status === 'complete' || /^complete/i.test(state?.status || '')
// the first words of what the intent was started with
const titleOf = (text) => { const t = String(text || '').split(/\s[—–-]\s|[.\n]/)[0].trim(); return t.length > 28 ? `${t.slice(0, 27)}…` : t }
const pubReq = (r) => ({
  id: r.id, body: r.body, title: r.title || titleOf(r.body), status: r.status, source: r.source, scope: r.scope, startMode: r.start_mode, fast: !!r.fast,
  intent: r.intent, note: r.note || '', at: r.created_at, decidedAt: r.decided_at, asker: { id: r.user_id, name: r.asker || '' }, decidedBy: r.decider || null, estimate: r.estimate || null,
})
const REQ = `select r.*, coalesce(p.name, u.username, u.email) as asker, coalesce(dp.name, du.username, du.email) as decider from pro_aidlc_requests r
             left join users u on u.id = r.user_id and u.tenant_id = r.tenant_id left join pro_profile p on p.user_id = r.user_id
             left join users du on du.id = r.decided_by and du.tenant_id = r.tenant_id left join pro_profile dp on dp.user_id = r.decided_by`
async function requestsOf(folder) {
  return q(`${REQ} where r.tenant_id=$1 and r.folder_id=$2 order by r.created_at`, [T(), folder.id])
}
async function one(folder, id) {
  if (!UUID.test(String(id || ''))) throw err(400, 'bad request id')
  const [r] = await q(`${REQ} where r.tenant_id=$1 and r.folder_id=$2 and r.id=$3`, [T(), folder.id, id])
  if (!r) throw err(404, 'request not found')
  return r
}
const marksOf = async (folder) => Object.fromEntries((await q('select * from pro_aidlc_line where tenant_id=$1 and folder_id=$2', [T(), folder.id])).map((m) => [m.bolt_key, m]))
async function mark(folder, key, set) {
  const cols = Object.keys(set)
  const json = new Set(['restored', 'snapshot_untracked'])
  const vals = cols.map((c) => (json.has(c) && set[c] != null ? JSON.stringify(set[c]) : set[c]))
  await q(`insert into pro_aidlc_line(tenant_id,folder_id,bolt_key,${cols.join(',')}) values ($1,$2,$3,${cols.map((_, i) => `$${i + 4}`).join(',')})
           on conflict (tenant_id,folder_id,bolt_key) do update set ${cols.map((c) => `${c}=excluded.${c}`).join(',')}, updated_at=now()`, [T(), folder.id, key, ...vals])
}

// everything the line is built from: the record's intents, the requests, what people decided about a bolt
async function inputs(folder) {
  const root = folder.repo_path
  const cur = await TM.currentIntent(root).catch(() => null)
  const rows = await requestsOf(folder)
  const marks = await marksOf(folder)
  const intents = []
  for (const i of await R.listIntents(root)) {
    const dir = path.join(root, 'aidlc', 'spaces', i.space, 'intents', i.dirName)
    const state = await R.readState(dir).catch(() => null)
    if (!state) continue
    const units = await R.readUnits(dir).catch(() => [])
    const names = units.map((u) => u.name)
    const done = isDone(i, state)
    const metrics = units.length && !done ? Object.fromEntries(M.unitMetrics(await R.readAudit(dir), units).map((u) => [u.name, u])) : {}
    // an intent put away after a discard stays on the line as what was discarded
    const kept = Object.keys(marks).some((k) => k.startsWith(`i:${i.dirName}:`) && marks[k].discarded_at)
    intents.push({ dir: i.dirName, space: i.space, slug: i.slug, scope: i.scope || state.scope || null, title: titleOf(state.project) || i.slug, done, archived: i.archived && !kept, away: i.archived,
      units, contracts: await R.readContracts(dir, names).catch(() => []), bolts: await R.readBolts(dir, names).catch(() => []), metrics,
      running: !done && !i.archived && cur?.dirName === i.dirName, path: dir })
  }
  const requests = rows.map((r) => ({ ...pubReq(r), at: r.decided_at || r.created_at }))
  const line = LN.buildLine({ intents, requests, marks })
  // in flight: an intent of the record not finished — unless every bolt it has left was discarded — or a
  // request typed into the session whose intent is not there yet
  const open_ = !!cur && !cur.archived && !isDone(cur, cur.state)
  const left = open_ && line.bolts.some((b) => b.intent === cur.dirName && !b.discarded && b.state !== 'done')
  const busy = left || rows.some((r) => r.status === 'started' && !r.intent && line.bolts.some((b) => b.request === r.id && !b.discarded))
  return { cur, busy, intents, requests, marks, rows, line }
}
const lineOf = (inp) => inp.line

async function open(slug, user, need = 'viewer') {
  const { folder, role } = await F.access(R.safeName(slug), user, need)
  if (!folder.repo_path || !(await R.hasAidlc(folder.repo_path))) throw err(404, 'no AI-DLC record in this folder')
  return { folder, role }
}

// ---------- the view both screens read ----------
export async function view(slug, user) {
  const { folder } = await open(slug, user)
  const inp = await inputs(folder)
  const line = lineOf(inp)
  const rights = await rightsOf(folder, user)
  const names = Object.fromEntries((await F.members(folder.id)).filter((m) => m.type === 'user').map((m) => [m.id, m.name]))
  const reqById = Object.fromEntries(inp.requests.map((r) => [r.id, r]))
  for (const b of line.bolts) {
    const m = inp.marks[b.key]
    b.asker = reqById[b.request]?.asker?.name || ''
    b.stop = m?.stop_at ? { by: names[m.stop_by] || '', reason: m.stop_reason || '', at: m.stop_at, security: !!m.stop_security } : null
    b.canRestore = !!m?.snapshot
    if (b.discarded) { b.discarded.by = names[b.discarded.by] || ''; b.discarded.forTitle = reqById[b.discarded.for]?.title || ''; b.discarded.restored = m?.restored || null }
  }
  const cur = inp.cur
  const people = {}
  for (const k of Object.keys(MAY)) people[k] = (await holdersOf(folder, k)).map((p) => p.name)
  return {
    folder: pub(folder), me: user.id, rights, people, roles: Object.fromEntries(Object.entries(MAY).map(([k, list]) => [k, list.map(roleName)])),
    head: {
      busy: inp.busy, session: await AS.has(nameOf(folder)), next: LN.nextUp(line),
      intent: inp.busy && cur ? { dir: cur.dirName, scope: cur.scope, title: inp.intents.find((i) => i.dir === cur.dirName)?.title || cur.slug, stage: cur.stage?.name || '', unit: cur.unit?.unit || null,
        request: inp.requests.find((r) => r.intent === cur.dirName)?.id || null } : null,
    },
    requests: inp.requests.map((r) => {
      const mine = line.bolts.filter((b) => b.request === r.id)
      return { ...r, mine: r.asker.id === user.id, done: !!r.intent && !!inp.intents.find((i) => i.dir === r.intent)?.done, discarded: mine.length > 0 && mine.every((b) => b.discarded) }
    }),
    line, scopes: await C.scopes(folder.repo_path), ledger: await ledgerOf(folder),
  }
}

// what this person may do here and who takes in work (the chat says which of the two the asker is)
export async function rights(slug, user) {
  const { folder } = await open(slug, user)
  return { folder: pub(folder), rights: await rightsOf(folder, user), intake: (await holdersOf(folder, 'intake')).map((p) => p.name) }
}

// ---------- a request ----------
// anyone in the project asks; the plan is worked out behind (a minute or so) and the screens are told
export async function propose(slug, user, { body, source = 'app' }) {
  const { folder } = await open(slug, user)
  const text = String(body || '').trim().slice(0, 4000)
  if (text.length < 4) throw err(400, L('무엇을 하고 싶은지 적어 주세요', 'Say what you want done'))
  const [row] = await q(`insert into pro_aidlc_requests(tenant_id,folder_id,user_id,source,body,title) values ($1,$2,$3,$4,$5,$6) returning *`,
    [T(), folder.id, user.id, source === 'chat' ? 'chat' : 'app', text, titleOf(text)])
  // (started inside this request: the tenant and the language go with it)
  estimating.set(row.id, runEstimate(folder, row.id, isEn() ? 'en' : 'ko').finally(() => estimating.delete(row.id)))
  await tell(folder, 'requests', { id: row.id })
  return pubReq({ ...row, asker: user.name })
}
// estimates under way in this process (a test waits on one; a restart leaves the row for `again`)
const estimating = new Map()
export const settled = (id) => estimating.get(id) || Promise.resolve()

async function knownOf(inp) {
  const units = [...new Set(inp.intents.flatMap((i) => i.units.map((u) => u.name)))]
  const contracts = [...new Set(inp.intents.flatMap((i) => i.contracts.map((c) => c.id)))]
  let requirements = ''
  for (const i of inp.intents) {
    const d = path.join(i.path, 'inception', 'requirements-analysis')
    for (const f of (await fs.readdir(d).catch(() => [])).filter((x) => x.endsWith('.md'))) requirements += await fs.readFile(path.join(d, f), 'utf8').catch(() => '')
  }
  return { units, contracts, requirements }
}

async function runEstimate(folder, id, lang) {
  try {
    const req = await one(folder, id)
    const inp = await inputs(folder)
    const est = await C.estimate({ root: folder.repo_path, request: req.body, line: lineOf(inp), requests: inp.requests, known: await knownOf(inp), lang })
    // a person who may take in work sees their own plan and decides; anyone else's request waits in the inbox
    const mine = (await rightsOf(folder, { id: req.user_id })).intake
    const [row] = await q(`update pro_aidlc_requests set estimate=$3, title=$4, scope=$5, status=$6, updated_at=now() where id=$1 and tenant_id=$2 and status='estimating' returning id`,
      [id, T(), JSON.stringify(est), est.title || req.title, est.scope, mine ? 'proposed' : 'inbox'])
    if (!row) return
    const clash = est.conflicts.filter((c) => !c.compatible).length
    if (mine) {
      await card(folder, [{ id: req.user_id }], { title: L(`「${est.title}」 계획안이 나왔어요`, `The plan for "${est.title}" is ready`),
        text: `${est.summary}${clash ? L(` · 진행 중인 볼트 ${clash}개와 부딪혀요`, ` · clashes with ${clash} bolt(s) in the line`) : ''}`, url: intakeUrl(folder.slug, id) })
    } else {
      await card(folder, await holdersOf(folder, 'intake'), { title: L('새 요청이 접수를 기다려요', 'A new request waits to be taken in'),
        text: `${req.asker}: ${est.title} — ${est.summary}`, url: intakeUrl(folder.slug, id) }, req.user_id)
    }
  } catch (e) {
    console.warn('[aidlc intake] estimate', id, e.message)
    await q(`update pro_aidlc_requests set status='failed', note=$3, updated_at=now() where id=$1 and tenant_id=$2 and status='estimating'`, [id, T(), String(e.message).slice(0, 500)]).catch(() => {})
  }
  await tell(folder, 'requests', { id })
}
// work the plan out again (it failed, or the server restarted in the middle): the asker or the people who take in work
export async function again(slug, user, id) {
  const { folder } = await open(slug, user)
  const req = await one(folder, id)
  if (req.user_id !== user.id) await must(folder, user, 'intake')
  if (!['failed', 'estimating'].includes(req.status) || estimating.has(id)) throw err(409, 'nothing to do again')
  await q(`update pro_aidlc_requests set status='estimating', note=null, updated_at=now() where id=$1 and tenant_id=$2`, [id, T()])
  estimating.set(id, runEstimate(folder, id, isEn() ? 'en' : 'ko').finally(() => estimating.delete(id)))
  await tell(folder, 'requests', { id })
  return true
}

// the architect corrects or confirms what the request touches (the units the record has)
export async function confirmImpact(slug, user, id, { units, note = '' } = {}) {
  const { folder } = await open(slug, user)
  await must(folder, user, 'impact')
  const req = await one(folder, id)
  if (!req.estimate || !['proposed', 'inbox', 'later', 'queued'].includes(req.status)) throw err(409, 'not open')
  const known = (await knownOf(await inputs(folder))).units
  const est = req.estimate
  const next = Array.isArray(units) ? [...new Set(units)].filter((u) => known.includes(u)) : est.touches.units
  const changed = JSON.stringify(next) !== JSON.stringify(est.touches.units)
  est.confirmed = { by: user.id, name: user.name, at: new Date().toISOString(), note: String(note).slice(0, 500), was: changed ? est.touches.units : undefined }
  est.touches.units = next
  await q('update pro_aidlc_requests set estimate=$3, updated_at=now() where id=$1 and tenant_id=$2', [id, T(), JSON.stringify(est)])
  await record(folder, user, { kind: 'impact', question: req.title, choice: next.join(', ') || L('유닛 없음', 'no unit'), note: changed ? L(`고침: ${est.confirmed.was.join(', ') || '없음'} → ${next.join(', ') || '없음'}. ${note}`, `corrected: ${est.confirmed.was.join(', ') || 'none'} → ${next.join(', ') || 'none'}. ${note}`) : note })
  await tell(folder, 'requests', { id })
  return true
}

// ---------- taking it in ----------
const MODES = ['now', 'after', 'merge']
export async function approve(slug, user, id, { scope, mode = 'after', fast = false, note = '' } = {}) {
  const { folder } = await open(slug, user)
  await must(folder, user, 'intake')
  if (!MODES.includes(mode)) throw err(400, 'unknown start mode')
  const req = await one(folder, id)
  if (!['proposed', 'inbox', 'later', 'queued'].includes(req.status)) throw err(409, L('이미 처리된 요청이에요', 'This request was handled already'))
  const scopes = await C.scopes(folder.repo_path)
  const sc = scope || req.scope || req.estimate?.scope
  if (!sc || (scopes.length && !scopes.some((s) => s.name === sc))) throw err(400, 'unknown scope')
  let out
  if (mode === 'now') out = await begin(folder, user, req, sc, { fast, note })
  else if (mode === 'merge') out = await merge(folder, user, req, note)
  else {
    await q(`update pro_aidlc_requests set status='queued', scope=$3, start_mode='after', fast=$4, decided_by=$5, decided_at=now(), note=$6, head_told_at=null, updated_at=now() where id=$1 and tenant_id=$2`,
      [id, T(), sc, !!fast, user.id, String(note).slice(0, 1000) || null])
    await record(folder, user, { kind: 'intake', question: req.title, choice: L(`줄 끝에 세움 · ${sc}${fast ? ' · 빠른 줄' : ''}`, `queued · ${sc}${fast ? ' · fast lane' : ''}`), note })
    out = { status: 'queued', scope: sc }
  }
  await card(folder, [{ id: req.user_id }], { title: L(`「${req.title}」 요청이 접수됐어요`, `"${req.title}" was taken in`),
    text: out.status === 'queued' ? L(`${user.name} 님이 앞 작업 다음에 시작하기로 했어요.`, `${user.name} queued it after the work in flight.`)
      : out.status === 'merged' ? L(`${user.name} 님이 지금 진행 중인 작업에 합쳤어요.`, `${user.name} folded it into the work in flight.`)
        : L(`${user.name} 님이 바로 시작했어요.`, `${user.name} started it.`), url: lineUrl(folder.slug) }, user.id)
  // the "head is free" cards for it have done their job
  await q(`update notifications set is_checked=true where tenant_id=$1 and type='aidlc' and url=$2 and not coalesce(is_checked,false)`, [T(), intakeUrl(folder.slug, id)]).catch(() => {})
  await tell(folder, 'line', { id })
  return out
}

// the session is at its prompt with nothing asked (a new session shows the prompt after a few seconds)
async function ready(name, ms = 60000) {
  const until = Date.now() + ms
  for (;;) {
    const text = await AS.screen(name).catch(() => '')
    if (AS.parseChoice(text)) throw err(409, L('세션이 먼저 답을 기다리고 있어요. 그 결정을 한 뒤에 시작해 주세요', 'The session waits for an answer first'))
    if (/^\s*[❯>]/m.test(text)) return
    if (Date.now() > until) throw err(504, L('세션이 준비되지 않았어요', 'The session did not come up'))
    await sleep(1000)
  }
}

// start it in the team session: the files as they are now are kept, then the request is typed in
async function begin(folder, user, req, scope, { fast = false, note = '' } = {}) {
  const inp = await inputs(folder)
  if (inp.busy) throw err(409, L('진행 중인 작업이 있어요. 그 뒤에 세우거나 지금 작업에 합칠 수 있어요', 'Work is in flight: queue this after it, or fold it in'))
  const name = nameOf(folder)
  await AS.start({ name, cwd: folder.repo_path, lang: isEn() ? 'en' : 'ko' })
  await ready(name)
  const queued = req.status === 'queued'
  await q(`update pro_aidlc_requests set status='started', scope=$3, start_mode=coalesce(start_mode,'now'), fast=$4, decided_by=coalesce(decided_by,$5), decided_at=coalesce(decided_at,now()),
           note=coalesce($6,note), known_intents=$7, updated_at=now() where id=$1 and tenant_id=$2`,
    [req.id, T(), scope, queued ? req.fast : !!fast, user.id, String(note).slice(0, 1000) || null, JSON.stringify((await R.listIntents(folder.repo_path)).map((i) => i.dirName))])
  // "the tail" was where it waited: started, its bolts are this release's unless a person put them in the next
  await q(`update pro_aidlc_line set bucket=null, updated_at=now() where tenant_id=$1 and folder_id=$2 and bolt_key like $3 and bucket='tail'`, [T(), folder.id, `r:${req.id}:%`])
  // what its first bolt can be put back to
  const first = lineOf(await inputs(folder)).bolts.find((b) => b.request === req.id && !b.discarded)
  if (first) {
    const snap = await SNAP.take(folder.repo_path, first.key).catch((e) => { console.warn('[aidlc intake] snapshot', e.message); return null })
    if (snap) await mark(folder, first.key, { snapshot: snap.object, snapshot_head: snap.head, snapshot_untracked: snap.untracked })
  }
  await AS.sendText(name, `/aidlc ${scope} "${oneLine(req.body)}"`)
  await record(folder, user, { kind: 'intake', question: req.title, choice: L(`시작 · ${scope}`, `started · ${scope}`), note })
  return { status: 'started', scope }
}

// fold it into the work in flight: the request is said to the session, which takes it from there
async function merge(folder, user, req, note) {
  const inp = await inputs(folder)
  const name = nameOf(folder)
  if (!inp.busy || !inp.cur || !(await AS.has(name))) throw err(409, L('합칠 진행 중인 작업이 없어요', 'No work in flight to fold this into'))
  await AS.sendText(name, L(`[추가 요청 — 지금 작업에 합쳐 주세요] ${oneLine(req.body)}`, `[Added request — fold it into this work] ${oneLine(req.body)}`))
  await q(`update pro_aidlc_requests set status='merged', start_mode='merge', intent=$3, decided_by=$4, decided_at=now(), note=$5, updated_at=now() where id=$1 and tenant_id=$2`,
    [req.id, T(), inp.cur.dirName, user.id, String(note).slice(0, 1000) || null])
  await record(folder, user, { intent: inp.cur.dirName, kind: 'intake', question: req.title, choice: L('진행 중인 작업에 합침', 'folded into the work in flight'), note })
  return { status: 'merged' }
}

// not now, or not at all — with the reason, told to who asked; the asker may take their own request back
export async function triage(slug, user, id, { action, note = '' } = {}) {
  const { folder } = await open(slug, user)
  const req = await one(folder, id)
  if (!['later', 'decline', 'withdraw'].includes(action)) throw err(400, 'unknown action')
  if (action === 'withdraw') { if (req.user_id !== user.id) throw err(403, 'not your request') } else await must(folder, user, 'intake')
  if (!['proposed', 'inbox', 'later', 'queued', 'failed'].includes(req.status)) throw err(409, L('이미 처리된 요청이에요', 'This request was handled already'))
  if (action !== 'withdraw' && String(note).trim().length < 2) throw err(400, L('까닭을 적어 주세요', 'Give the reason'))
  const status = action === 'later' ? 'later' : 'declined'
  await q(`update pro_aidlc_requests set status=$3, decided_by=$4, decided_at=now(), note=$5, updated_at=now() where id=$1 and tenant_id=$2`, [id, T(), status, user.id, String(note).slice(0, 1000) || null])
  await q('delete from pro_aidlc_line where tenant_id=$1 and folder_id=$2 and bolt_key like $3', [T(), folder.id, `r:${id}:%`])
  await record(folder, user, { kind: 'triage', question: req.title, choice: action === 'later' ? L('나중에', 'later') : action === 'withdraw' ? L('요청 거둠', 'withdrawn') : L('받지 않음', 'declined'), note })
  if (action !== 'withdraw') {
    await card(folder, [{ id: req.user_id }], { title: action === 'later' ? L(`「${req.title}」 요청은 나중에 하기로 했어요`, `"${req.title}" was put off`) : L(`「${req.title}」 요청은 받지 않기로 했어요`, `"${req.title}" was declined`),
      text: `${user.name}: ${note}`, url: intakeUrl(folder.slug, id) }, user.id)
  }
  await tell(folder, 'requests', { id })
  return { status }
}

// ---------- the line ----------
const boltOf = (line, key) => { const b = line.bolts.find((x) => x.key === key); if (!b) throw err(404, 'no such bolt'); return b }
const boltName = (b) => (b.unit === LN.WHOLE ? `「${b.title}」` : `「${b.title}」 ${b.unit}`)
const BUCKET = { shipped: ['출시됨', 'released'], now: ['이번 릴리스', 'this release'], next: ['다음 릴리스', 'next release'], tail: ['줄 끝', 'the tail'] }
const bucketName = (k) => L(BUCKET[k][0], BUCKET[k][1])

// move a bolt to another release. A move that would break a dependency is not made: what stands in the way
// comes back, with the bolts that would have to move along (together: true moves them all).
export async function move(slug, user, { key, bucket, together = false }) {
  const { folder } = await open(slug, user)
  await must(folder, user, 'intake')
  const line = lineOf(await inputs(folder))
  const b = boltOf(line, key)
  const chk = LN.checkMove(line, key, bucket)
  if (chk.error) throw err(400, chk.error === 'shipped' ? L('출시된 볼트는 옮길 수 없어요', 'A released bolt cannot be moved') : 'unknown release')
  if (!chk.ok && !together) return { moved: [], ...chk }
  if (!chk.together.length) throw err(409, L('이미 출시된 볼트에 묶여 있어 옮길 수 없어요', 'Tied to a bolt already released'))
  const keys = chk.ok ? [key] : chk.together
  for (const k of keys) await mark(folder, k, { bucket })
  await record(folder, user, { intent: b.intent, kind: 'line', question: keys.map((k) => boltName(boltOf(line, k))).join(' · '),
    choice: `${bucketName(b.bucket)} → ${bucketName(bucket)}`, note: keys.length > 1 ? L(`의존하는 볼트 ${keys.length}개를 함께 옮김`, `${keys.length} dependent bolts moved together`) : '' })
  await tell(folder, 'line')
  return { moved: keys, ok: true, blockers: [], together: keys }
}

// hold a bolt where it is (it does not start), or let it go on
export async function hold(slug, user, { key, hold: on = true, reason = '' }) {
  const { folder } = await open(slug, user)
  await must(folder, user, 'stop')
  const line = lineOf(await inputs(folder))
  const b = boltOf(line, key)
  if (b.state === 'done') throw err(409, L('끝난 볼트예요', 'This bolt is finished'))
  const name = nameOf(folder)
  if (on) {
    if (b.state === 'running' && (await AS.has(name))) await AS.sendKey(name, 'Escape')
    await mark(folder, key, { hold: true })
  } else {
    await mark(folder, key, { hold: false, stop_by: null, stop_reason: null, stop_at: null, stop_security: false })
    if (b.state === 'running' && (await AS.has(name))) await AS.sendText(name, L('[Lite] 멈춤이 풀렸어요. 하던 작업을 이어서 진행해 주세요.', '[Lite] The hold is lifted. Carry on with the work.'))
  }
  await record(folder, user, { intent: b.intent, kind: 'stop', question: boltName(b), choice: on ? L('멈춰 둠', 'held') : L('다시 진행', 'resumed'), note: reason })
  await tell(folder, 'line')
  return true
}

// anyone in the project asks for a bolt to be stopped. A security reason pauses it at once (D-1112-24);
// either way the people who may stop and discard get a card and decide what happens next.
export async function stopRequest(slug, user, { key, reason, security = false }) {
  const { folder } = await open(slug, user)
  const why = String(reason || '').trim().slice(0, 1000)
  if (why.length < 2) throw err(400, L('까닭을 적어 주세요', 'Give the reason'))
  const line = lineOf(await inputs(folder))
  const b = boltOf(line, key)
  if (b.state === 'done' || b.discarded) throw err(409, L('멈출 수 있는 볼트가 아니에요', 'This bolt cannot be stopped'))
  const name = nameOf(folder)
  let paused = false
  if (security) {
    if (b.state === 'running' && (await AS.has(name))) { await AS.sendKey(name, 'Escape'); paused = true }
    await mark(folder, key, { hold: true, stop_by: user.id, stop_reason: why, stop_at: new Date(), stop_security: true })
  } else await mark(folder, key, { stop_by: user.id, stop_reason: why, stop_at: new Date(), stop_security: false })
  await record(folder, user, { intent: b.intent, kind: 'stop', question: boltName(b), choice: security ? L('보안 사유로 바로 멈춤', 'paused at once for a security reason') : L('멈춤 요청', 'stop requested'), note: why })
  await card(folder, await holdersOf(folder, 'stop'), {
    title: security ? L('보안 사유로 작업을 멈췄어요', 'Work was paused for a security reason') : L('볼트를 멈춰 달라는 요청이 왔어요', 'Someone asks for a bolt to be stopped'),
    text: `${user.name}: ${why} — ${boltName(b)}`, url: lineUrl(folder.slug, key) }, user.id)
  await tell(folder, 'line')
  return { paused, held: !!security }
}

// release: every bolt of the release is finished, and nothing it waits for is left behind
export async function release(slug, user, { bucket = 'now' } = {}) {
  const { folder } = await open(slug, user)
  await must(folder, user, 'intake')
  if (!['now', 'next', 'tail'].includes(bucket)) throw err(400, 'unknown release')
  const line = lineOf(await inputs(folder))
  const mine = line.bolts.filter((b) => b.bucket === bucket)
  const live = mine.filter((b) => !b.discarded)
  if (!live.length) throw err(409, L('내보낼 볼트가 없어요', 'Nothing to release'))
  const open_ = live.filter((b) => b.state !== 'done')
  if (open_.length) throw err(409, L(`아직 끝나지 않은 볼트가 ${open_.length}개 있어요`, `${open_.length} bolt(s) are not finished`))
  if (LN.violations(line, Object.fromEntries(live.map((b) => [b.key, 'shipped']))).length) throw err(409, L('앞 릴리스에 이 볼트들이 기다리는 볼트가 남아 있어요', 'A bolt these wait for is still in an earlier release'))
  for (const b of mine) await mark(folder, b.key, { bucket: 'shipped' })
  // the next release moves up
  if (bucket === 'now') for (const b of line.bolts.filter((x) => x.bucket === 'next')) await mark(folder, b.key, { bucket: 'now' })
  await record(folder, user, { kind: 'line', question: live.map(boltName).join(' · '), choice: L(`${bucketName(bucket)} 내보냄 · 볼트 ${live.length}개`, `released ${bucketName(bucket)} · ${live.length} bolt(s)`) })
  await tell(folder, 'line')
  return { released: live.map((b) => b.key) }
}

// ---------- discarding ----------
const snapOf = (m) => (m?.snapshot ? { object: m.snapshot, head: m.snapshot_head, untracked: m.snapshot_untracked || [], ref: null } : null)
// what discarding this bolt would mean, before anyone presses the button
export async function discardPreview(slug, user, key) {
  const { folder } = await open(slug, user)
  const inp = await inputs(folder)
  const line = lineOf(inp)
  const b = boltOf(line, key)
  const kind = LN.discardKind(b)
  const snap = kind === 'stop' ? snapOf(inp.marks[key]) : null
  const files = snap ? await SNAP.since(folder.repo_path, snap).catch(() => null) : null
  const rest = line.bolts.filter((x) => x.intent && x.intent === b.intent && !x.discarded && x.key !== key && x.state !== 'done')
  return {
    kind, bolt: { key: b.key, n: b.n, title: b.title, unit: b.unit, state: b.state },
    dependents: LN.dependents(line, key, true, true).map((k) => boltOf(line, k)).map((d) => ({ key: d.key, n: d.n, title: d.title, unit: d.unit, state: d.state, via: d.deps.find((x) => x.key === key)?.via || '' })),
    files: files && { changed: files.changed, made: files.made, moved: files.moved }, snapshot: !!snap,
    // the whole intent goes with its last bolt: it can be put away in the record
    whole: !!b.intent && !rest.length, rights: await rightsOf(folder, user),
  }
}

// the engine puts the intent away (its record stays under the archive)
async function archiveIntent(root, intent, reason) {
  try {
    const { stdout } = await run('aidlc', ['engine', 'orchestrate', 'next', 'intent', 'archive', intent, '--reason', oneLine(reason, 300)], { cwd: root, env: AS.cleanEnv(), timeout: 30000 })
    return { ok: true, message: stdout.trim().slice(0, 300) }
  } catch (e) {
    return { ok: false, message: String(e.stderr || e.message).trim().slice(0, 300) }
  }
}

// dependents: 'hold' (default) | 'discard' | 'keep' — what happens to the bolts that wait for this one
// forRequest: the request this bolt gives way to · archive: put the intent away when its last bolt goes
export async function discard(slug, user, { key, reason, dependents = 'hold', forRequest = null, archive = false }) {
  const { folder } = await open(slug, user)
  const rights = await must(folder, user, 'stop')
  const why = String(reason || '').trim().slice(0, 1000)
  if (why.length < 2) throw err(400, L('폐기하는 까닭을 적어 주세요', 'Give the reason for discarding'))
  if (forRequest && !UUID.test(forRequest)) throw err(400, 'bad request id')
  const inp = await inputs(folder)
  const line = lineOf(inp)
  const b = boltOf(line, key)
  if (b.discarded) throw err(409, L('이미 폐기한 볼트예요', 'Already discarded'))
  const kind = LN.discardKind(b)
  const req = b.request ? inp.rows.find((r) => r.id === b.request) : null
  const out = { kind, restored: null, archived: null, request: null, dependents: [] }

  if (kind === 'revert') {
    // finished work is taken back by new work: a request whose first bolt reverts this unit
    const title = L(`되돌리기: ${b.title}`, `Revert: ${b.title}`)
    const body = L(`「${b.title}」 에서 한 ${b.unit === LN.WHOLE ? '' : `${b.unit} `}작업을 되돌려 주세요. 까닭: ${why}`, `Revert the ${b.unit === LN.WHOLE ? '' : `${b.unit} `}work done in "${b.title}". Reason: ${why}`)
    const scopes = await C.scopes(folder.repo_path)
    const scope = ['express', 'bugfix', 'feature'].find((s) => !scopes.length || scopes.some((x) => x.name === s)) || scopes[0]?.name
    const units = b.unit === LN.WHOLE ? [] : [b.unit]
    const est = { title, kind: 'change', scores: null, ars: null, touches: { units, contracts: [], requirements: [], paths: [] }, newUnits: [], conflicts: [], reverts: units,
      summary: body, dropped: {}, scopes, scope, scopeWhy: 'revert', revertOf: key, cost: null }
    const [row] = await q(`insert into pro_aidlc_requests(tenant_id,folder_id,user_id,source,body,title,status,estimate,scope) values ($1,$2,$3,'app',$4,$5,$6,$7,$8) returning id`,
      [T(), folder.id, user.id, body, title, rights.intake ? 'proposed' : 'inbox', JSON.stringify(est), scope])
    out.request = row.id
    await record(folder, user, { intent: b.intent, kind: 'discard', question: boltName(b), choice: L('끝난 볼트 — 되돌리는 요청을 만듦', 'finished — a revert request was made'), note: why })
    if (!rights.intake) await card(folder, await holdersOf(folder, 'intake'), { title: L('끝난 작업을 되돌리자는 요청이 왔어요', 'A request to revert finished work'), text: `${user.name}: ${why} — ${boltName(b)}`, url: intakeUrl(folder.slug, row.id) }, user.id)
    await tell(folder, 'requests', { id: row.id })
    return out
  }

  const name = nameOf(folder)
  const live = await AS.has(name)
  if (b.kind === 'request' && b.state === 'estimated') {
    // nothing was spent: the request leaves the line and goes back to the inbox with the reason
    await q(`update pro_aidlc_requests set status='inbox', start_mode=null, fast=false, note=$3, head_told_at=null, updated_at=now() where id=$1 and tenant_id=$2`, [b.request, T(), `${user.name}: ${why}`])
    await q('delete from pro_aidlc_line where tenant_id=$1 and folder_id=$2 and bolt_key like $3', [T(), folder.id, `r:${b.request}:%`])
  } else {
    if (b.state === 'running') {
      if (live) { await AS.sendKey(name, 'Escape'); await sleep(1500) }
      const snap = snapOf(inp.marks[key])
      if (snap) out.restored = await SNAP.restore(folder.repo_path, snap, key).catch((e) => ({ error: e.message }))
    }
    await mark(folder, key, { discarded_at: new Date(), discarded_by: user.id, discard_reason: why, discarded_for: forRequest, restored: out.restored, hold: false })
    const whole = !line.bolts.some((x) => x.intent && x.intent === b.intent && !x.discarded && x.key !== key && x.state !== 'done') && !!b.intent
    if (whole && archive && rights.archive) out.archived = await archiveIntent(folder.repo_path, b.intent, `${user.name}: ${why}`)
    if (live) {
      const what = b.unit === LN.WHOLE || whole ? L('이 작업', 'this work') : L(`유닛 ${b.unit}`, `unit ${b.unit}`)
      const files = out.restored && !out.restored.error && !out.restored.moved ? L(' 바뀐 파일은 시작 전으로 되돌렸고 새로 만든 파일은 치워 두었어요.', ' The changed files were put back and the new files set aside.') : ''
      await AS.sendText(name, L(`[Lite] ${what}은 폐기하기로 했어요(${user.name}: ${oneLine(why, 300)}).${files} 더 진행하지 말고 여기서 멈춰 주세요. 코드는 다시 만들지 마세요.`,
        `[Lite] ${what} was discarded (${user.name}: ${oneLine(why, 300)}).${files} Stop here and do not go on. Do not write the code again.`))
    }
  }

  // the bolts that waited for it
  for (const k of LN.dependents(line, key, true, true)) {
    const d = boltOf(line, k)
    if (d.state === 'done' || d.discarded) continue
    if (dependents === 'hold') await mark(folder, k, { hold: true })
    else if (dependents === 'discard' && d.kind === 'request' && d.state === 'estimated') {
      await q(`update pro_aidlc_requests set status='inbox', start_mode=null, note=$3, updated_at=now() where id=$1 and tenant_id=$2 and status='queued'`, [d.request, T(), L(`앞 볼트 폐기: ${why}`, `the bolt before it was discarded: ${why}`)])
      await q('delete from pro_aidlc_line where tenant_id=$1 and folder_id=$2 and bolt_key like $3', [T(), folder.id, `r:${d.request}:%`])
    } else if (dependents === 'discard' && d.state === 'planned') {
      await mark(folder, k, { discarded_at: new Date(), discarded_by: user.id, discard_reason: L(`앞 볼트 폐기: ${why}`, `the bolt before it was discarded: ${why}`), discarded_for: forRequest })
    } else continue
    out.dependents.push(k)
  }

  const restoredText = out.restored?.moved ? L(` · 커밋 ${out.restored.moved.commits}개는 사람이 되돌려야 해요`, ` · ${out.restored.moved.commits} commit(s) are left for a person to revert`)
    : out.restored && !out.restored.error ? L(` · 파일 ${out.restored.restored.length}개 되돌림, ${out.restored.removed.length}개 치움`, ` · ${out.restored.restored.length} file(s) put back, ${out.restored.removed.length} set aside`) : ''
  await record(folder, user, { intent: b.intent, kind: 'discard', question: boltName(b),
    choice: `${kind === 'stop' ? L('진행 중이던 볼트를 멈추고 폐기', 'stopped and discarded') : L('시작 전 볼트를 폐기', 'discarded before it started')}${restoredText}${out.archived?.ok ? L(' · 인텐트 보관', ' · intent archived') : ''}`,
    note: `${why}${out.dependents.length ? L(` (기다리던 볼트 ${out.dependents.length}개: ${dependents === 'hold' ? '멈춰 둠' : '함께 폐기'})`, ` (${out.dependents.length} dependent bolt(s): ${dependents === 'hold' ? 'held' : 'discarded too'})`) : ''}` })
  const forTitle = forRequest ? inp.requests.find((r) => r.id === forRequest)?.title : ''
  await card(folder, [req && { id: req.user_id }, ...(await holdersOf(folder, 'intake'))].filter(Boolean), {
    title: L(`${boltName(b)} 볼트를 폐기했어요`, `The bolt ${boltName(b)} was discarded`),
    text: `${user.name}: ${why}${forTitle ? L(` — 「${forTitle}」 요청에 자리를 내줬어요`, ` — it gave way to "${forTitle}"`) : ''}`, url: lineUrl(folder.slug, key) }, user.id)
  await tell(folder, 'line')
  return out
}

// ---------- the watcher's part (lib/aidlc/watch.js, every scan of a folder) ----------
export async function tick(folder) {
  const root = folder.repo_path
  let changed = false
  // a started request and the intent the record got for it
  const started = await q(`select id, known_intents, decided_at, updated_at from pro_aidlc_requests where tenant_id=$1 and folder_id=$2 and status='started' and intent is null`, [T(), folder.id])
  if (started.length) {
    const taken = new Set((await q('select intent from pro_aidlc_requests where tenant_id=$1 and folder_id=$2 and intent is not null', [T(), folder.id])).map((x) => x.intent))
    const list = await R.listIntents(root)
    for (const r of started) {
      const before = new Set(r.known_intents || [])
      const hit = list.find((i) => !before.has(i.dirName) && !taken.has(i.dirName))
      if (hit) {
        taken.add(hit.dirName)
        await q('update pro_aidlc_requests set intent=$3, updated_at=now() where id=$1 and tenant_id=$2', [r.id, T(), hit.dirName])
        // what was decided about its expected bolts goes with them
        const from = `r:${r.id}:`
        await q(`update pro_aidlc_line set bolt_key = $4 || substr(bolt_key, $5) where tenant_id=$1 and folder_id=$2 and bolt_key like $3`, [T(), folder.id, `${from}%`, `i:${hit.dirName}:`, from.length + 1])
          .catch((e) => console.warn('[aidlc intake] marks', e.message))
        changed = true
      } else if (Date.now() - new Date(r.updated_at).getTime() > 15 * 60 * 1000) {
        // typed into the session a quarter of an hour ago and the record has no intent for it — it did not
        // start, or it was discarded before the record knew it
        const [gone] = await q('select discard_reason from pro_aidlc_line where tenant_id=$1 and folder_id=$2 and bolt_key like $3 and discarded_at is not null limit 1', [T(), folder.id, `r:${r.id}:%`])
        await q(`update pro_aidlc_requests set status=$3, note=$4, updated_at=now() where id=$1 and tenant_id=$2`,
          [r.id, T(), gone ? 'declined' : 'failed', gone ? L(`폐기: ${gone.discard_reason || ''}`, `discarded: ${gone.discard_reason || ''}`) : L('세션에서 작업이 시작되지 않았어요', 'The work did not start in the session')])
        changed = true
      }
    }
  }
  // a unit that starts working: the files as they are, so that the bolt can be put back
  const cur = await TM.currentIntent(root).catch(() => null)
  const busy = !!cur && !cur.archived && !isDone(cur, cur.state)
  if (busy && cur.unit?.open) {
    const key = LN.intentKey(cur.dirName, cur.unit.unit)
    const [m] = await q('select snapshot, discarded_at from pro_aidlc_line where tenant_id=$1 and folder_id=$2 and bolt_key=$3', [T(), folder.id, key])
    if (!m?.snapshot && !m?.discarded_at) {
      const snap = await SNAP.take(root, key).catch(() => null)
      if (snap) await mark(folder, key, { snapshot: snap.object, snapshot_head: snap.head, snapshot_untracked: snap.untracked })
    }
  }
  // the head of the line is free: the people who take in work are asked to start what is next (nothing starts by itself)
  // (an intent whose bolts were all discarded no longer holds the head: inputs() knows)
  const [gone] = busy ? await q('select 1 from pro_aidlc_line where tenant_id=$1 and folder_id=$2 and bolt_key like $3 and discarded_at is not null limit 1', [T(), folder.id, `i:${cur.dirName}:%`]) : []
  if ((!busy || gone) && !started.length) {
    const [waiting] = await q(`select 1 from pro_aidlc_requests where tenant_id=$1 and folder_id=$2 and status='queued' and head_told_at is null limit 1`, [T(), folder.id])
    if (waiting) {
      const inp = await inputs(folder)
      const next = !inp.busy && LN.nextUp(lineOf(inp))
      const [r] = next ? await q(`update pro_aidlc_requests set head_told_at=now() where id=$1 and tenant_id=$2 and head_told_at is null returning title`, [next, T()]) : []
      if (r) {
        await card(folder, await holdersOf(folder, 'intake'), { title: L('앞 작업이 끝났어요. 다음 작업을 시작할 수 있어요', 'The work in front is finished: the next can start'),
          text: L(`줄의 다음 작업: 「${r.title}」. 시작은 사람이 눌러요.`, `Next in line: "${r.title}". A person presses start.`), url: intakeUrl(folder.slug, next) })
        changed = true
      }
    }
  }
  if (changed) await tell(folder, 'line')
  return { changed }
}
