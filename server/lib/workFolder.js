// 작업 폴더 · 버전 — where one turn's files go (2026-11-28 phone recording: one turn wrote 21 files flat in the conversation's output
// folder — README.md several times, curriculum.md twice — and the next request made more files beside them instead of changing the ones
// there. 「클로드 코드의 에이전트를 쓰면 이런 것 다 폴더로 관리해서 버전 1, 버전 2 … 특정 폴더 안에다가 담아 가지고 작업의 내용을 관리」 ·
// 「기존에 걸 수정하던지」 — spec openspec/specs/chat-artifacts 「한 턴의 결과물은 작업 폴더와 버전에」).
//
// At the start of a person's turn that will make deliverables, one small model call reads the request (and what the front plan understood)
// with this conversation's work folders — read from the paths of its earlier file cards (and, in a project with a shared folder, its
// working copy) — and answers {files, mode, folder, confidence}. The code then places the work:
//   new     <folder>/v1/ — a new work folder (a name already taken: its next version, or a name of its own)
//   redo    <folder>/v<n+1>/ — the person asks for the work again (redo, redesign, another way): the earlier version stays as it was
//   revise  the latest version <folder>/v<n>/, edited in place: no copies, no new files with the same content
// Names the app reads as something else never become a work folder's first segment: process-* (a process generation — agent.js
// generationArtifact), skill/ and skills/ (a skill — provenance.js workFile, agent.js's skill paths), folders/ (a shared folder's working
// copy — provenance.js checkoutFile, src/fileGroups.js relPath), uploads/ and dot names. Such a name gets the prefix 'work-'
// ('process-improvement-plan' → 'work-process-improvement-plan'). The work folders stay where they were (no fixed parent folder): their
// paths stay short and in the request's language, a shared folder keeps the layout its team made, and earlier work is read as it is.
// The rule for a light one-off: a turn the front plan read as light (a short answer, one lookup), or one the model says makes no file, or a
// single new file, has no work folder — its file goes where files always went. A revision is placed even for one file.
// The agent is told with one structural line, the way a project's workspace note says where outputs go (folders/threadFolders.js).
// What the request means (a redo? a revision?) is the model's; the code only reads paths, version numbers and the model's fields. No
// model (unreachable, refused, unsure — confidence under 0.7): no line, the turn goes as it did before.
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { chatJson } from './llm.js'
import { roomOf } from './provenance.js'
import { L } from './lang.js'

export const MIN_CONFIDENCE = 0.7
// the model's own limit
const ASK_MS = Number(process.env.PRO_WORK_FOLDER_MS || 4000)
// how long the turn waits for the reading after its plan block is ready; a reading that comes later is dropped (the turn goes as before).
// The reading starts when the message comes, beside the front plan — so it is usually ready by then (PR #135 confirmation review: a plan at
// 1.5 s and a model at 0.4–1.5 s were always late with 300 ms when the reading waited for the plan first)
export const GRACE_MS = Number(process.env.PRO_WORK_FOLDER_GRACE_MS || 1500)
// how long the reading waits for a front plan still coming, to see whether it is light: the front call's own budget (lib/turnPlan.js
// FRONT_MS) and the 300 ms its plan block gives it
const PLAN_MS = (Number(process.env.PRO_FRONT_PLAN_MS) || 4000) + 300
// tries for a name of its own (name-2 … name-50) before giving up on a work folder
const FREE_TRIES = 50
// PRO_WORK_FOLDERS=0 turns it off (no model call, no line)
const enabled = () => process.env.PRO_WORK_FOLDERS !== '0'
const VERSION = /^v(\d{1,4})$/i
const segs = (p) => String(p || '').split('/').filter(Boolean)
const norm = (s) => String(s || '').normalize('NFC').toLowerCase()
// a first segment the app reads as something else (see the head of this file)
const SPECIAL = new Set(['skill', 'skills', 'folders', 'uploads'])
export const reserved = (seg) => { const s = norm(seg); return !s || s.startsWith('.') || s.startsWith('process-') || SPECIAL.has(s) }
// a name that can stand in the line's '…/' quoting (an existing folder's name came from a path: it may hold anything)
const quotable = (n) => !/['"`\u0000-\u001f]/.test(String(n))
const later = (ms, v) => new Promise((ok) => { const t = setTimeout(() => ok(v), ms); t.unref?.() })

// p relative to base ('a/b.md'), or null when it is not under it
export function under(p, base) {
  const b = `${String(base || '').replace(/\/+$/, '')}/`
  const s = String(p || '')
  return base && s.startsWith(b) ? s.slice(b.length) : null
}

// The work folders under base, from file paths (earlier file cards, a working copy): [{name, versions:[1,2], latest, files:[names of the
// latest version — or of the folder when it has no versions]}] in the order first seen, and loose: the names of files in no folder.
export function workFolders(paths, base) {
  const map = new Map()
  const loose = []
  for (const p of paths || []) {
    const rel = under(p, base)
    if (rel == null) continue
    const s = segs(rel)
    if (s.some((x) => x.startsWith('.'))) continue
    if (s.length === 1) { if (!loose.includes(s[0]) && quotable(s[0])) loose.push(s[0]); continue }
    const name = s[0]
    // (a process generation, a skill, a working copy … — not work this note can place; a name its quoting cannot hold)
    if (reserved(name) || !quotable(name)) continue
    if (!map.has(name)) map.set(name, { name, versions: new Set(), byVersion: new Map() })
    const f = map.get(name)
    const v = s.length > 2 && VERSION.test(s[1]) ? Number(VERSION.exec(s[1])[1]) : 0
    if (v) f.versions.add(v)
    if (!f.byVersion.has(v)) f.byVersion.set(v, [])
    const file = s.slice(v ? 2 : 1).join('/')
    if (!f.byVersion.get(v).includes(file)) f.byVersion.get(v).push(file)
  }
  const folders = [...map.values()].map((f) => {
    const versions = [...f.versions].sort((a, b) => a - b)
    const latest = versions.length ? versions[versions.length - 1] : 0
    return { name: f.name, versions, latest, files: (f.byVersion.get(latest) || []).slice(0, 8) }
  })
  return { folders, loose: loose.slice(0, 12) }
}

// the version after a folder's latest (a folder without versions holds the first: its redo is v2)
export const nextVersion = (folder) => (folder?.latest ? folder.latest + 1 : 2)

// a folder name the model gave: one path segment — no slashes, quotes (the line quotes paths with '…/'), control characters; spaces as
// hyphens (the agent's shell commands); 40 characters, cut between characters (never inside a surrogate pair) and then trimmed, so it
// never ends with '.' or '-'
export function cleanName(raw) {
  const one = String(raw ?? '').normalize('NFC').replace(/[\\/:*?"'`<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, '-')
  return Array.from(one).slice(0, 40).join('').replace(/^[.-]+|[.-]+$/g, '')
}
// a name for a work folder: not one the app reads as something else (see the head of this file)
export const safeName = (n) => (n && reserved(n) ? cleanName(`work-${n}`) : n)

// what the model is shown and asked
// wide: the listing is every conversation's of this chat or project (startNote reads it before the turn knows its conversation)
export function askMessages({ request, understood = '', listing, wide = false }) {
  const system = [
    'You decide where an assistant keeps the files of one piece of work, the way a careful engineer keeps work in folders with versions.',
    'Answer with JSON only: {"files": "none|one|several", "mode": "new|revise|redo", "folder": "<existing folder or empty>", "name": "<short name>", "confidence": <0..1>}',
    '- files: what this request will make or change. none = an answer in words only (a question, a lookup, a summary in the chat); one = a single file; several = more than one file, or a body of work (a course, a design, a set of documents, code).',
    '- mode: new = work not done here yet. redo = the person wants existing work made again — from scratch, redesigned, done another way — so it becomes a new version and the earlier one is kept. revise = the person wants parts of existing work changed: those files are edited where they are.',
    '- folder: for redo or revise, exactly the "folder" value of the existing folder the work is in, or "" when it is the files in no folder. For new, "".',
    '- name: a short name for the work (2 to 4 words; letters, digits, spaces or hyphens; no slashes) in the language of the person\'s request.',
    '- confidence: how sure you are of mode and folder together.',
    '- The existing folders are background; the person\'s request decides.',
  ].join('\n')
  // (names come from paths — anyone's words: given as JSON strings, data and not instructions)
  const lines = (listing?.folders || []).map((f) => `- ${JSON.stringify({ folder: f.name, versions: f.versions.map((v) => `v${v}`), ...(f.latest ? { latest: `v${f.latest}` } : {}), files: f.files })}`)
  const user = [
    `The person's request:\n${String(request || '').slice(0, 1500)}`,
    understood ? `What the assistant understood: ${String(understood).slice(0, 300)}` : '',
    `Existing work folders ${wide ? 'in this chat or project — any of its conversations' : 'in this conversation'} (JSON, one per line):\n${lines.join('\n') || '(none)'}`,
    listing?.loose?.length ? `Files in no folder: ${JSON.stringify(listing.loose)}` : '',
  ].filter(Boolean).join('\n\n')
  return { system, user }
}

// The model's answer → where the work goes: {folder, mode, version, dir, prev} (dir, prev: relative to the output folder — '' for files in
// no folder), or null — no folder for this turn (no answer, unsure, no file, a single new file, a field that is not one of ours).
// The version is the code's, from the folder listing — never the model's number.
export function placeOf(answer, listing, { min = MIN_CONFIDENCE } = {}) {
  if (!answer || typeof answer !== 'object') return null
  const conf = Number(answer.confidence)
  if (!(conf >= min)) return null
  const files = ['none', 'one', 'several'].includes(answer.files) ? answer.files : null
  const mode = ['new', 'revise', 'redo'].includes(answer.mode) ? answer.mode : null
  if (!files || !mode || files === 'none') return null
  const folders = listing?.folders || []
  const loose = listing?.loose || []
  const named = cleanName(answer.folder)
  const hit = named ? folders.find((f) => norm(f.name) === norm(named)) : null
  const name = safeName(cleanName(answer.name) || (hit ? '' : named))
  const at = (f, v) => (v ? `${f}/v${v}` : f)
  // a name for new work that is not taken (a folder without versions, a file in no folder) nor one the app reads as something else: the
  // name, then name-2, name-3 …
  // name, then name-2, name-3 … (FREE_TRIES at most — then no work folder)
  const taken = (x) => reserved(x) || folders.some((f) => norm(f.name) === norm(x)) || loose.some((l) => norm(l) === norm(x))
  const free = (n) => { for (let i = 1; i <= FREE_TRIES; i++) { const x = i === 1 ? n : `${n}-${i}`; if (!taken(x)) return x } return null }
  if (mode === 'revise') {
    // (a revision of files in no folder, or of a folder this conversation does not have: edited where they are — no folder named)
    if (!hit) return { folder: '', mode, version: null, dir: '', prev: null, confidence: conf }
    return { folder: hit.name, mode, version: hit.latest || null, dir: at(hit.name, hit.latest), prev: null, confidence: conf }
  }
  if (mode === 'redo') {
    if (hit) { const v = nextVersion(hit); return { folder: hit.name, mode, version: v, dir: at(hit.name, v), prev: at(hit.name, hit.latest), confidence: conf } }
    // (work made before folders — files in no folder: its second version gets a folder of its own; the files stay where they are)
    if (!named && loose.length && name) { const f = free(name); return f ? { folder: f, mode, version: 2, dir: at(f, 2), prev: '', confidence: conf } : null }
  }
  // new work: its own folder, the first version — a single new file needs none
  if (files === 'one' || !name) return null
  const same = folders.find((f) => norm(f.name) === norm(name))
  if (same?.latest) { const v = nextVersion(same); return { folder: same.name, mode: 'new', version: v, dir: at(same.name, v), prev: null, confidence: conf } }
  const f = free(name)
  return f ? { folder: f, mode: 'new', version: 1, dir: at(f, 1), prev: null, confidence: conf } : null
}

// The line the agent gets (after the plan block): base — the absolute folder the work folder is in (a project's working copy), or null
// for this conversation's own output folder (the file-location line names that one).
export function noteOf(place, { base = null } = {}) {
  if (!place) return ''
  const where = (d) => (base ? `'${base.replace(/\/+$/, '')}/${d}/'` : L(`산출물 폴더 안의 '${d}/'`, `'${d}/' inside the output folder`))
  if (place.mode === 'revise' && !place.dir) {
    return L('\n\n(작업 폴더: 이번 요청은 이미 만든 파일을 고치는 일이에요. 고칠 파일을 그 자리에서 고치고, 같은 내용의 새 파일이나 사본(-v2 · -수정본 같은)은 만들지 마세요.)',
      '\n\n(Work folder: this request changes files already made. Edit those files where they are; do not make new files with the same content or copies (like -v2 or -edited).)')
  }
  if (place.mode === 'revise') {
    return L(`\n\n(작업 폴더: 이번 요청은 ${where(place.dir)} 의 파일을 고치는 일이에요. 고칠 파일을 그 자리에서 고치고, 같은 내용의 새 파일이나 사본(-v2 · -수정본 같은)은 만들지 마세요. 꼭 새로 필요한 파일만 같은 폴더에 더하세요.)`,
      `\n\n(Work folder: this request changes the files in ${where(place.dir)}. Edit those files where they are; do not make new files with the same content or copies (like -v2 or -edited). Add a new file to that folder only when one is really needed.)`)
  }
  if (place.mode === 'redo') {
    const prevKo = place.prev ? `이전 버전 ${where(place.prev)} 의 파일은` : '이전 결과물(폴더 밖의 파일)은'
    const prevEn = place.prev ? `the earlier version ${where(place.prev)}` : 'the earlier files (the ones in no folder)'
    return L(`\n\n(작업 폴더: 이 일을 다시 하는 것이니 새 버전 ${where(place.dir)} 에 두세요(버전 ${place.version}). ${prevKo} 고치거나 지우지 말고 그대로 두세요 — 참고로 읽기만 하세요.)`,
      `\n\n(Work folder: this does the work again, so put it in the new version ${where(place.dir)} (version ${place.version}). Leave ${prevEn} as it is — do not change or delete those files; read them only for reference.)`)
  }
  return L(`\n\n(작업 폴더: 이번 결과물은 ${where(place.dir)} 에 두세요(이 일의 버전 ${place.version}). 파일이 많으면 그 안에서 하위 폴더로 나누고, 산출물 폴더 바로 아래에 흩어 두지 마세요.)`,
    `\n\n(Work folder: put this work's files in ${where(place.dir)} (version ${place.version} of this work). With many files, use subfolders inside it; do not scatter them at the top of the output folder.)`)
}

// the model's call (fast model, a few seconds) → its JSON answer
export async function askModel({ request, understood, listing, wide = false, call = chatJson, timeoutMs = ASK_MS, signal = null }) {
  const { system, user } = askMessages({ request, understood, listing, wide })
  return call(system, user, { model: config.llm.fastModel, temperature: 0, think: false, effort: 'low', maxTokens: 300, timeoutMs, ...(signal ? { signal } : {}) })
}

// Where this turn's files sit: a project's working copy (a template's workspace: its outputs folder there), else this conversation's
// output folder → {base (sandbox path, or null), disk (this server's copy of it, to list), absolute (the line names base itself)}
async function baseOf({ conv, projectWork }) {
  if (projectWork?.container) {
    const { isWorkspace, outputsOf } = await import('./folders/templates.js')
    const out = isWorkspace(projectWork.v) ? outputsOf(projectWork.v.source.template.outputs) : ''
    return { base: out ? `${projectWork.container}/${out}` : projectWork.container, disk: projectWork.dir ? (out ? path.join(projectWork.dir, out) : projectWork.dir) : null, absolute: true }
  }
  return { base: roomOf(conv), disk: null, absolute: false }
}
// The files of a working copy on this server's disk, as sandbox paths: walked folder by folder, nearest first (every top folder before
// what is deep in one), never into a dot folder (.git, .claude) or node_modules, and stopped at the cap — not a full listing cut afterwards.
export async function diskPaths(disk, base, max = 400) {
  if (!disk) return []
  const out = []
  const queue = [['', disk]]
  while (queue.length && out.length < max) {
    const [rel, dir] = queue.shift()
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) queue.push([r, path.join(dir, e.name)])
      else if (e.isFile()) { out.push(`${base}/${r}`); if (out.length >= max) break }
    }
  }
  return out
}
const cardPaths = async (query, threadId, base) => (await query(
  `select content->>'path' as path from pro_messages where thread_id = $1 and kind = 'file' and starts_with(content->>'path', $2) order by created_at desc limit 400`,
  [threadId, `${base}/`])).map((r) => r.path)
// every file card of the thread, each relative to the folder its work folders are in — its conversation's, a project's working copy in it,
// a template project's outputs folder there (PR #135 confirmation review: the same frame as the conversation's own listing, roomListing) —
// read before the turn knows its conversation (the router, a project's sub-topic, its checkout come later): the model sees the thread's
// work folders; where the work goes is then placed against the conversation's own (placeOf)
const WIDE = '/w'
async function threadPaths(query, threadId) {
  const [rows, out] = await Promise.all([
    query(`select content->>'path' as path from pro_messages where thread_id = $1 and kind = 'file' and starts_with(content->>'path', '/workspace/.bpmn/') order by created_at desc limit 400`, [threadId]),
    templateOutputs(query, threadId),
  ])
  const rel = (p) => {
    const m = /^\/workspace\/\.bpmn\/[^/]+\/(?:(folders\/[^/]+)\/)?(.+)$/.exec(p || '')
    if (!m) return null
    if (!m[1] || !out) return m[2]
    // (a template's workspace: only its outputs folder holds work folders — its forms and notes are the template's)
    return m[2].startsWith(`${out}/`) ? m[2].slice(out.length + 1) : null
  }
  return rows.map((r) => rel(r.path)).filter(Boolean).map((x) => `${WIDE}/${x}`)
}
// a project working in a template's workspace: its outputs folder (folders/templates.js), else ''
async function templateOutputs(query, threadId) {
  const [row] = await query(`select v.source from pro_thread_folders l join pro_folder_variations v on v.id = l.variation_id where l.thread_id = $1 and l.mode = 'project'`, [threadId]).catch(() => [])
  if (!row?.source?.template) return ''
  const { outputsOf } = await import('./folders/templates.js')
  return outputsOf(row.source.template.outputs)
}

// The front plan a turn's view has: the plan when it is already there, else the promise of it (lib/turnPlan.js begin — the view's `ready`)
export const planOf = (view) => view?.plan || view?.ready || null
// a plan, or its promise for at most `ms` → the front plan, or null (none in time, the call off, a stand-in plan that says nothing)
async function settle(plan, ms) {
  const p = plan && typeof plan.then === 'function' ? await Promise.race([Promise.resolve(plan).catch(() => null), later(ms, null)]) : plan
  return p?.source === 'front' ? p : null
}
// where the turn works → {base, disk, absolute} and that folder's own work folders
async function roomListing(at, threadId, run) {
  const { base, disk, absolute } = await baseOf(at || {})
  const paths = base ? [...await cardPaths(run, threadId, base), ...await diskPaths(disk, base)] : []
  return { base, absolute, listing: workFolders(paths, base) }
}

// One reading → the line ('' — no work folder). Never throws.
//   plan    the front plan, or its promise (planOf). Only a plan already there gives the model what it understood; one still coming is
//           waited for (at most PLAN_MS) beside the model's answer — a light plan stops the reading, the turn needs no work folder
//   where   {conv, projectWork}, or a promise of it: conv — the conversation the turn goes to (in the main chat the router may decide later:
//           the one the thread is in); projectWork — a project's shared-folder work (folders/threadFolders.js prepareProjectWork)
//   wide    ask before `where` is known, with the thread's work folders (threadPaths) — startNote; else with the conversation's own
//   signal  the reading is dropped
async function read({ threadId, request, plan, where, wide = false, call, query, log, signal, planMs }) {
  if (!enabled() || !String(request || '').trim()) return ''
  const t0 = Date.now()
  const now = plan && typeof plan.then !== 'function' ? (plan.source === 'front' ? plan : null) : undefined
  // (the front plan's model read it as a light one: a short answer, one lookup — no work folder)
  if (now?.tier === 'light') return ''
  const ac = new AbortController()
  const stop = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal
  const planned = now !== undefined ? Promise.resolve(now) : settle(plan, planMs)
  planned.then((f) => { if (f?.tier === 'light') ac.abort() }, () => {})
  try {
    const run = query || (await import('./supa.js')).q
    let room = null, listing
    if (wide) listing = workFolders(await threadPaths(run, threadId), WIDE)
    else { room = await roomListing(await where, threadId, run); listing = room.listing }
    if (stop.aborted) return ''
    const answer = await askModel({ request, understood: now?.understood || '', listing, wide, call, signal: stop })
    const front = await planned
    if (front?.tier === 'light' || stop.aborted) return ''
    if (!room) room = await roomListing(await where, threadId, run)
    if (stop.aborted) return ''
    const place = placeOf(answer, room.listing)
    log.log?.(`[work-folder] ${place ? `${place.mode} '${place.dir || '(in place)'}'` : 'none'} (${answer?.mode || '-'} ${answer?.files || '-'} ${Number(answer?.confidence) || 0}) folders=${room.listing.folders.length}${now ? '' : ' (plan not in yet)'} ${Date.now() - t0} ms thread=${String(threadId).slice(0, 8)}`)
    return noteOf(place, { base: room.absolute ? room.base : null })
  } catch (e) {
    if (!stop.aborted) log.warn?.(`[work-folder] no decision (${String(e.message || e).slice(0, 120)}) — as before`)
    return ''
  }
}

// The line for a turn whose place is known (conv, projectWork) — the reading at once, with that conversation's work folders.
export async function turnNote({ threadId, conv = null, projectWork = null, request = '', plan = null, call = chatJson, query = null, log = console, signal = null, planMs = PLAN_MS }) {
  return read({ threadId, request, plan, where: { conv, projectWork }, call, query, log, signal, planMs })
}

// A turn's reading, started when the person's message is saved — beside the front plan, the router and the turn's preparation (lib/agent.js
// handleTurn, next to the plan's begin): it lists the thread's work folders and asks the model at once, without waiting for the plan (a
// light plan coming meanwhile stops it). The turn says where it works with at({conv, projectWork}) once it knows (delegate: before its
// repeat check — a project's once its folder is checked out); take() is the note when it is ready by GRACE_MS after the turn's plan block,
// else '' — the reading is stopped and the late note dropped (logged), so the turn waits at most GRACE_MS. A turn that never reaches the
// agent drops it (runTurn's end). signal: the turn's own.
export function startNote({ threadId, request, plan, signal = null, call = chatJson, query = null, log = console, grace = GRACE_MS, planMs = PLAN_MS }) {
  const ac = new AbortController()
  const stop = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal
  let place
  const where = new Promise((ok) => { place = ok })
  const t0 = Date.now()
  const note = read({ threadId, request, plan, where, wide: true, call, query, log, signal: stop, planMs })
  return {
    at: (w) => place(w || {}),
    drop: () => ac.abort(),
    async take() {
      const LATE = Symbol('late')
      const r = await Promise.race([note, later(grace, LATE)])
      if (r !== LATE) return r
      ac.abort()
      log.log?.(`[work-folder] late — dropped after ${Date.now() - t0} ms (the turn does not wait) thread=${String(threadId).slice(0, 8)}`)
      return ''
    },
  }
}
