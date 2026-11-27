// The folder index (design 8장): tier 0 file list on every commit of main, tier 1 document cards
// (memento's doc_card shape + keywords, made here with the fast model, skipped when the blob did
// not change), tier 2 full text once a folder outgrows a card list (200 documents / ~12k tokens of
// cards / 5MB of text, or switched on) — then memento indexes it as well when it is reachable.
// Also the per-variation "바뀐 점" card and the search people and agents use.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import JSZip from 'jszip'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chat } from '../llm.js'
import { L, isEn } from '../lang.js'
import * as G from './git.js'
import { readableFolderIds } from './service.js'
import { withTenant, tenants } from '../tenant.js'
import { discover as discoverKit } from './kit.js'
import { summaries as refSummaries, slotsOf, underSlot } from './refs.js'

const DOC = /\.(md|markdown|txt|csv|docx|xlsx|pptx|hwpx|pdf)$/i
export const kindOf = (p) => (String(p).split('.').pop() || '').toLowerCase()
const isDoc = (p) => DOC.test(p)
const DOC_KINDS = ['md', 'markdown', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'hwpx', 'pdf']
// full-text tier thresholds (approved 2026-10-24)
export const FULLTEXT = { docs: 200, cardTokens: 12000, textBytes: 5 * 1024 * 1024 }
const MEMENTO = process.env.PRO_MEMENTO_URL || 'http://127.0.0.1:8005'
// Copies of full-text documents in memento (the knowledge base) only when asked for: Lite's own search
// never reads them, and a new version or a removed file leaves the old copy there — duplicates and
// stale versions in the knowledge base. Off until the knowledge base and shared folders are settled
// (process-gpt docs/decisions/2026-11.md D-1123-06).
const TO_MEMENTO = process.env.PRO_FOLDERS_TO_MEMENTO === '1'

const run = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60000, ...opts }, (e, out) => resolve(e ? '' : String(out))))
const strip = (xml) => xml.replace(/<\/(w:p|a:p|hp:p|si|row)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim()

// plain text of a document blob, with a page count where the format has one. The Office and
// Hangul formats are zip packages read with jszip (the server image has no unzip: before, every
// docx/pptx/xlsx/hwpx came out empty in production — no card, no keywords, "바이너리"); PDF needs
// poppler's pdftotext (in the image since 2026-11-23).
const PARTS = {
  docx: (n) => n === 'word/document.xml',
  pptx: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n),
  xlsx: (n) => n === 'xl/sharedStrings.xml',
  hwpx: (n) => /^Contents\/section\d+\.xml$/.test(n),
}
const num = (n) => Number(/(\d+)\.xml$/.exec(n)?.[1] || 0)
// a part is inflated only up to a limit (a small file can unpack to gigabytes): the stream stops being
// read past it, which stops the inflating; the sizes the zip declares are checked first
const PART_MAX = 32 * 1024 * 1024, TOTAL_MAX = 64 * 1024 * 1024
const readCapped = (f, cap) => new Promise((resolve) => {
  if (f.dir || cap <= 0 || f._data?.uncompressedSize > cap) return resolve(null)
  const parts = []
  let n = 0, done = false
  const end = (v) => { if (!done) { done = true; resolve(v) } }
  const st = f.nodeStream('nodebuffer')
  st.on('data', (c) => {
    if (done) return
    n += c.length
    if (n > cap) { st.pause(); st.removeAllListeners('data'); return end(null) }
    parts.push(c)
  })
  st.on('end', () => end(Buffer.concat(parts).toString('utf8')))
  st.on('error', () => end(null))
})
export async function extract(name, buf) {
  const ext = kindOf(name)
  if (['md', 'markdown', 'txt', 'csv'].includes(ext)) { const t = buf.toString('utf8'); return { text: t, pages: Math.max(1, Math.ceil(t.length / 1800)) } }
  if (PARTS[ext]) {
    const zip = await JSZip.loadAsync(buf).catch(() => null)
    if (!zip) return { text: '', pages: 1 }
    const names = Object.keys(zip.files).filter(PARTS[ext]).sort((a, b) => num(a) - num(b))
    let text = '', used = 0
    for (const n of names) {
      const xml = await readCapped(zip.files[n], Math.min(PART_MAX, TOTAL_MAX - used))
      if (xml == null) break
      used += xml.length
      text += strip(xml) + '\n\n'
    }
    text = text.trim()
    const pages = ext === 'pptx' ? Math.max(1, names.length) : Math.max(1, Math.ceil(text.length / 1800))
    return { text, pages }
  }
  if (ext !== 'pdf') return { text: '', pages: 1 }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-fold-'))
  const f = path.join(tmp, 'doc.pdf')
  try {
    await fs.writeFile(f, buf)
    const text = await run('pdftotext', ['-layout', f, '-'])
    const info = await run('pdfinfo', [f])
    return { text, pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1]) || 1 }
  } finally { fs.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
}

// tier 0 for main, then the cards that are missing or stale (in the background)
// a file being edited in place (IeumOffice autosave) changes every few seconds: its card is made once
// the edits settle, not for every save
const cardTimers = new Map()
export function cardsSoon(folder, ms = 60_000) {
  clearTimeout(cardTimers.get(folder.id))
  const t = setTimeout(() => { cardTimers.delete(folder.id); cardQueue(folder) }, ms)
  t.unref?.()
  cardTimers.set(folder.id, t)
}

// A folder's index brought up to date a moment after a run of changes (a folder going up request by request — routes/folders.js
// files/batch): one run at a time per folder; changes during a run make one more run after it, never more.
const later = new Map() // folder id → {timer, running, again, folder}
export function reindexSoon(folder, ms = 600) {
  let s = later.get(folder.id)
  if (!s) later.set(folder.id, (s = { timer: null, running: false, again: false, folder }))
  s.folder = folder
  if (s.running) { s.again = true; return }
  clearTimeout(s.timer)
  s.timer = setTimeout(async () => {
    s.timer = null
    s.running = true
    try { await reindex(s.folder) } catch (e) { console.warn('[folders] index', s.folder.slug, e.message) }
    s.running = false
    if (s.again) { s.again = false; reindexSoon(s.folder, ms) } else if (!s.timer) later.delete(folder.id)
  }, ms)
  s.timer.unref?.()
}

let kitMissing = 0
export async function reindex(folder, { cards = true } = {}) {
  const ref = folder.default_branch
  // (the .gitattributes this server writes is not a file of the folder — a champion folder's own one is: its attributes live elsewhere)
  const files = (await G.lsTree(folder.repo_path, ref)).filter((f) => f.path !== '.gitattributes' || folder.settings?.champion)
  const touched = await G.lastTouch(folder.repo_path, ref)
  const old = new Map((await q('select path, sha, card_sha from pro_folder_files where folder_id=$1', [folder.id])).map((r) => [r.path, r]))
  const keep = new Set()
  for (const f of files) {
    keep.add(f.path)
    const t = touched.get(f.path)
    await q(`insert into pro_folder_files (folder_id, path, kind, size, sha, mtime, author, updated_at) values ($1,$2,$3,$4,$5,$6,$7,now())
             on conflict (folder_id, path) do update set kind=$3, size=$4, sha=$5, mtime=$6, author=$7, updated_at=now()`,
    [folder.id, f.path, kindOf(f.path), f.size, f.sha, t?.at || null, t?.name || null])
  }
  for (const p of old.keys()) if (!keep.has(p)) await q('delete from pro_folder_files where folder_id=$1 and path=$2', [folder.id, p])
  // the agent platforms' files in main (skills, instructions, rules, specs — kit.js, by where they are)
  // (before sql/059 is applied the table is missing: said once)
  await discoverKit(folder, files).catch((e) => { if (e.code !== '42P01' || !kitMissing++) console.warn('[folders] kit', folder.slug, e.message) })
  await updateState(folder)
  if (cards && folder.kind !== 'linked') cardQueue(folder)
  else if (cards && folder.kind === 'linked') cardQueue(folder, { only: (p) => /(^|\/)(README|readme)\.md$|^docs\/[^/]+\.md$/.test(p) })
  return files.length
}

async function updateState(folder, extra = {}) {
  const [s] = await q(`select count(*)::int as files, count(card)::int as cards, coalesce(sum(size),0)::bigint as size,
                         count(*) filter (where kind = any($2))::int as docs,
                         coalesce(sum(length(card->>'abstract')),0)::int as card_chars, coalesce(sum(length(body)),0)::bigint as text_bytes
                       from pro_folder_files where folder_id=$1`, [folder.id, ['md', 'markdown', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'hwpx', 'pdf']])
  const [{ settings }] = await q('select settings from pro_folders where id=$1', [folder.id])
  const fulltext = !!settings?.fulltext || s.docs > FULLTEXT.docs || s.card_chars / 1.5 > FULLTEXT.cardTokens || Number(s.text_bytes) > FULLTEXT.textBytes
  const state = folder.kind === 'linked' && !s.cards ? 'list' : 'cards'
  const index = { state, files: s.files, cards: s.cards, docs: s.docs, size: Number(s.size), fulltext, at: new Date().toISOString(), ...extra }
  await q('update pro_folders set index_state=$2 where id=$1', [folder.id, index])
  return index
}

// one queue per folder: cards are made one at a time, newest change first
const queues = new Map()
function cardQueue(folder, { only } = {}) {
  if (queues.get(folder.id)) { queues.get(folder.id).again = true; return }
  const job = { again: false }
  const tried = new Set()
  queues.set(folder.id, job)
  ;(async () => {
    do {
      job.again = false
      // documents only (other files never get a card: they would hold these 60 places for ever); a full
      // batch goes round again, a row that could not even be read is not tried twice in one run
      const rows = (await q(`select path, sha from pro_folder_files where folder_id=$1 and (card_sha is distinct from sha) and kind = any($2) order by mtime desc nulls last limit 60`, [folder.id, DOC_KINDS]))
        .filter((r) => !tried.has(`${r.path}@${r.sha}`))
      const todo = rows.filter((r) => isDoc(r.path) && (!only || only(r.path)))
      if (todo.length) await updateState(folder, { state: 'indexing', pending: todo.length })
      for (const r of todo) { tried.add(`${r.path}@${r.sha}`); await makeCard(folder, r).catch((e) => console.warn('[folders] card', r.path, e.message)) }
      if (rows.length === 60 && todo.length) job.again = true
      await updateState(folder)
    } while (job.again)
  })().catch((e) => console.warn('[folders] index', e.message)).finally(() => queues.delete(folder.id))
}

// Documents whose text could not be read (until 2026-11-23 the server image had no unzip, so every
// docx/pptx/xlsx/hwpx came out empty): their cards are made again after a start. One still unreadable
// (a scanned PDF) is only read again — nothing goes to the model without text.
const UNREAD = ['본문을 읽지 못했어요', "Couldn't read the text"]
// Only this server's folders: the companies it serves (behind the ProcessGPT gateway, any) and
// repositories on this machine — another server on the same database keeps its own.
export async function retryUnreadCards() {
  const served = config.tenantFromHeader ? null : tenants()
  const rows = await q(`select distinct f.id, f.tenant_id, f.repo_path from pro_folder_files x join pro_folders f on f.id=x.folder_id
                         where x.card is null and x.card_error = any($1) and x.kind = any($2) and f.kind <> 'linked' and ($3::text[] is null or f.tenant_id = any($3))`,
  [UNREAD, ['docx', 'xlsx', 'pptx', 'hwpx', 'pdf'], served])
  let n = 0
  for (const r of rows) {
    if (!(await fs.stat(path.join(r.repo_path, '.git')).catch(() => fs.stat(path.join(r.repo_path, 'HEAD')).catch(() => null)))) continue
    const [f] = await q('select * from pro_folders where id=$1', [r.id])
    await q('update pro_folder_files set card_sha=null where folder_id=$1 and card is null and card_error = any($2)', [f.id, UNREAD])
    // the folder's own company (a server may serve more than one)
    withTenant(f.tenant_id, () => cardQueue(f))
    n += 1
  }
  return n
}

const CARD_PROMPT = `다음은 어떤 문서의 앞부분과 마지막 부분이다. JSON 으로만 답하라:
{"abstract": "이 문서가 무엇인지 1~2문장 한국어 평문(해요체). 여기에 없는 사실은 추가하지 마라", "keywords": ["문서를 찾을 때 쓸 핵심 낱말 3~6개"]}`

// English mode: the card in English (the same prompt otherwise)
const CARD_PROMPT_EN = `Below are the start and the end of a document. Answer with JSON only:
{"abstract": "what this document is, in 1-2 plain English sentences. Add no fact that is not here", "keywords": ["3-6 key words to find the document by"]}`
const CHANGE_PROMPT = '공유 폴더의 변형이 기준본(main)에서 무엇을 바꿨는지 알려 준다. JSON 으로만: {"title": "무엇을 바꿨는지 8~24자 명사구(예: 안내문 사전 신청 문구 추가)", "summary": "전체 한 문장(해요체)", "files": {"<경로>": "그 파일에서 바뀐 점 한 문장(해요체)"}}. 이 변형은 폴더 주인이 반영하기 전의 변경안이다: summary 와 files 는 \'삭제했어요\', \'추가했어요\'처럼 이미 끝난 일로 쓰지 말고 반영하면 일어날 일로 써라(예: \'반영하면 공지.md 가 지워져요\', \'안내문에 사전 신청 문구를 추가하는 변경안이에요\'). 차이에 없는 내용은 지어내지 마라.'
const CHANGE_PROMPT_EN = 'Say what a variation of a shared folder changed compared with main. JSON only: {"title": "what changed, a 3-8 word English noun phrase (e.g. Pre-registration line added to the notice)", "summary": "one English sentence for the whole change", "files": {"<path>": "one English sentence on what changed in that file"}}. The variation is a proposal the folder owner has not merged yet: do not write summary and files as done ("deleted", "added") — say what merging it does (e.g. "Merging removes notice.md", "Proposes adding a pre-registration line to the notice"). Make up nothing that is not in the diff.'

async function makeCard(folder, row) {
  const buf = await G.git(folder.repo_path, ['cat-file', 'blob', row.sha], { buffer: true })
  const { text, pages } = await extract(row.path, buf)
  const [{ index_state }] = await q('select index_state from pro_folders where id=$1', [folder.id])
  const body = index_state?.fulltext ? text : null
  if (!text.trim()) {
    await q('update pro_folder_files set card=null, card_sha=$3, card_error=$4, body=$5 where folder_id=$1 and path=$2', [folder.id, row.path, row.sha, L('본문을 읽지 못했어요', "Couldn't read the text"), body])
    return
  }
  const head = text.slice(0, 3500), tail = text.length > 5000 ? text.slice(-1200) : ''
  try {
    const m = await chat({ model: config.llm.fastModel, temperature: 0, json: true, messages: [
      { role: 'system', content: isEn() ? CARD_PROMPT_EN : CARD_PROMPT },
      { role: 'user', content: L(`파일: ${row.path}\n\n[앞부분]\n${head}${tail ? `\n\n[마지막 부분]\n${tail}` : ''}`, `File: ${row.path}\n\n[Start]\n${head}${tail ? `\n\n[End]\n${tail}` : ''}`) }] })
    const j = JSON.parse(m.content)
    const card = { abstract: String(j.abstract || '').trim() || null, keywords: (Array.isArray(j.keywords) ? j.keywords : []).map(String).slice(0, 8), n_pages: pages, generated_at: new Date().toISOString(), generation_model: config.llm.fastModel }
    await q('update pro_folder_files set card=$3, card_sha=$4, card_error=null, body=$5 where folder_id=$1 and path=$2', [folder.id, row.path, card, row.sha, body])
  } catch (e) {
    // a failed card leaves the file in the list (tier 0); it is tried again on its next change
    await q('update pro_folder_files set card_sha=$3, card_error=$4, body=$5 where folder_id=$1 and path=$2', [folder.id, row.path, row.sha, e.message.slice(0, 200), body])
  }
  // (a champion folder's documents stay out of the company-wide knowledge base: they are a person's folder until it is opened up)
  if (body && TO_MEMENTO && !folder.settings?.champion) mementoUpload(folder, row.path, buf).catch(() => {})
}

// tier 2 with memento (best effort: the folder search falls back to the text kept here)
async function mementoUpload(folder, rel, buf) {
  const form = new FormData()
  form.set('tenant_id', config.tenantId)
  form.set('folder_path', `pgpt-folders/${folder.slug}/${path.posix.dirname(rel)}`)
  form.set('file', new Blob([buf]), path.posix.basename(rel))
  const r = await fetch(`${MEMENTO}/knowledge/files/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`memento ${r.status}`)
}

// "바뀐 점": one sentence for the variation and one per changed document, from the diff
export async function changeCard(folder, v) {
  const changes = (await G.changes(folder.repo_path, folder.default_branch, v.branch)).slice(0, 6)
  if (!changes.length) return null
  const base = await G.mergeBase(folder.repo_path, folder.default_branch, v.branch)
  const parts = []
  for (const c of changes) {
    const a = c.change !== 'A' && base ? await G.show(folder.repo_path, base, c.path).catch(() => null) : null
    const b = c.change !== 'D' ? await G.show(folder.repo_path, v.branch, c.path).catch(() => null) : null
    const ta = a && isDoc(c.path) ? (await extract(c.path, a)).text : ''
    const tb = b && isDoc(c.path) ? (await extract(c.path, b)).text : ''
    parts.push(L(`### ${c.path} (${{ A: '추가', M: '수정', D: '삭제' }[c.change] || c.change})\n${isDoc(c.path) ? textDiff(ta, tb).slice(0, 2500) : '(문서가 아닌 파일)'}`,
      `### ${c.path} (${{ A: 'added', M: 'modified', D: 'deleted' }[c.change] || c.change})\n${isDoc(c.path) ? textDiff(ta, tb).slice(0, 2500) : '(not a document)'}`))
  }
  try {
    const m = await chat({ model: config.llm.fastModel, temperature: 0, json: true, messages: [
      { role: 'system', content: isEn() ? CHANGE_PROMPT_EN : CHANGE_PROMPT },
      { role: 'user', content: parts.join('\n\n') }] })
    const j = JSON.parse(m.content)
    // (an English 3-8 word title runs past 40 characters: cut there it ended mid-phrase, "…requirement and")
    const card = { title: String(j.title || '').slice(0, isEn() ? 72 : 40), summary: String(j.summary || ''), files: j.files && typeof j.files === 'object' ? j.files : {}, generated_at: new Date().toISOString(), head: v.head_commit }
    await q('update pro_folder_variations set change_card=$2 where id=$1', [v.id, card])
    return card
  } catch (e) {
    console.warn('[folders] change card', e.message)
    return null
  }
}
// small line diff for the prompt (removed/added lines only)
function textDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n')
  const setA = new Set(A), setB = new Set(B)
  return [...A.filter((l) => l.trim() && !setB.has(l)).map((l) => `- ${l}`), ...B.filter((l) => l.trim() && !setA.has(l)).map((l) => `+ ${l}`)].join('\n')
}

// The words of a query, each looked for on its own: "장진영 이력서" is not in any one name, but
// 장진영 is in 장진영_프로필.docx and 이력서 is its folder's name (2026-11-23: the agent found nothing
// until the person attached the folder). Words of one letter only when nothing longer is given.
export function words(text) {
  const all = [...new Set(String(text || '').split(/[\s,;|/·]+/).map((w) => w.trim()).filter(Boolean))]
  const long = all.filter((w) => [...w].length >= 2)
  return (long.length ? long : all).slice(0, 8)
}
const likeOf = (w) => `%${w.replace(/[%_\\]/g, (c) => '\\' + c)}%`

// search: folder names, file paths, card abstracts and keywords; full text where it is on. A file
// matches when any word does — in its path, its card or its text — and ranks by how many words it
// matched (then a name match, then the newest). A folder matches by its name or description (its files
// are not hits for that: a folder of 120 files would crowd out every other hit). Only folders the user
// can read.
export async function search(userId, text, limit = 20) {
  const ws = words(text)
  if (!ws.length) return []
  const ids = await readableFolderIds(userId)
  if (!ids.length) return []
  const likes = ws.map(likeOf)
  const folders = await q(`select id, slug, name, description, kind from pro_folders where id = any($1) and (name ilike any($2) or description ilike any($2)) limit 10`, [ids, likes])
  const files = await q(`select * from (
      select f.folder_id, p.slug, p.name as folder_name, f.path, f.kind, f.size, f.card, f.mtime,
             (select count(*) from unnest($2::text[]) w where f.path ilike w or (f.card->>'abstract') ilike w or (f.card->>'keywords') ilike w
                or ((p.index_state->>'fulltext')::boolean and f.body ilike w))::int as score,
             f.path ilike any($2) as name_hit,
             case when f.path ilike any($2) then 'name' when (f.card->>'abstract') ilike any($2) or (f.card->>'keywords') ilike any($2) then 'card' else 'text' end as by,
             case when (p.index_state->>'fulltext')::boolean then (select substr(f.body, greatest(1, position(lower(x) in lower(f.body)) - 60), 180)
                  from unnest($4::text[]) x where position(lower(x) in lower(coalesce(f.body, ''))) > 0 limit 1) end as snippet
        from pro_folder_files f join pro_folders p on p.id=f.folder_id
       where f.folder_id = any($1)) m
     where score > 0 order by score desc, name_hit desc, mtime desc nulls last limit $3`, [ids, likes, limit, ws])
  // (a file of a folder under one of its reference slots is not one of its files while the slot is there — the slot wins)
  const slots = await slotsOf([...new Set(files.map((f) => f.folder_id))]).catch(() => new Map())
  const shown = slots.size ? files.filter((f) => !underSlot(slots.get(String(f.folder_id)), f.path)) : files
  return [...folders.map((f) => ({ type: 'folder', folder: f })), ...shown.map((f) => ({ type: 'file', folder: { id: f.folder_id, slug: f.slug, name: f.folder_name }, file: { path: f.path, kind: f.kind, size: f.size, card: f.card }, by: f.by, score: f.score, words: ws.length, snippet: f.snippet }))]
}

// the catalog an agent reads first: folders it may use, each with its files and their cards. With a
// query: only what matched, best first. matched = how many of the query's words a file matched, its
// folder's name counted in ("장진영 이력서": 장진영 in the file name + 이력서 the folder = 2). A folder
// that matched by name keeps all its files, the ones that matched first. refs: each folder's reference slots too (the agent's folder_catalog;
// finding a folder by name does not look at its slots' sources)
export async function catalog(userId, query, { refs = false } = {}) {
  const ids = await readableFolderIds(userId)
  if (!ids.length) return []
  const folders = await q('select id, slug, name, description, kind, index_state from pro_folders where id = any($1) order by updated_at desc', [ids])
  const hits = query ? await search(userId, query, 40) : null
  const ws = query ? words(query).map((w) => w.toLowerCase()) : []
  // each folder's reference slots as this person sees them (name and state; the source's name only for a reader of it — refs.js).
  // What a slot holds is never copied into this index: it is read through folder_files · folder_read.
  const slots = refs ? await refSummaries(folders.map((f) => f.id), { id: userId }).catch((e) => { console.warn('[folders] refs catalog', e.message); return new Map() }) : new Map()
  const under = await slotsOf(folders.map((f) => f.id)).catch(() => new Map())
  const out = []
  for (const f of folders) {
    let files = await q(`select path, kind, size, card from pro_folder_files where folder_id=$1 order by path limit 200`, [f.id])
    if (under.has(String(f.id))) files = files.filter((x) => !underSlot(under.get(String(f.id)), x.path))
    let best = 0
    if (hits) {
      const score = new Map(hits.filter((h) => h.type === 'file' && h.folder.id === f.id).map((h) => [h.file.path, h.score]))
      const named = ws.filter((w) => `${f.name} ${f.description || ''}`.toLowerCase().includes(w)).length
      if (!score.size && !named) continue
      if (!named) files = files.filter((x) => score.has(x.path))
      files = files.map((x) => ({ ...x, matched: (score.get(x.path) || 0) + named })).sort((a, b) => b.matched - a.matched)
      best = files[0]?.matched || named
    }
    out.push({ slug: f.slug, name: f.name, description: f.description, kind: f.kind, index: f.index_state?.state, best,
      files: files.map((x) => ({ path: x.path, size: x.size, summary: x.card?.abstract || null, keywords: x.card?.keywords || [], ...(hits ? { matched: x.matched } : {}) })),
      ...(slots.get(String(f.id))?.length ? { refs: slots.get(String(f.id)) } : {}) })
  }
  if (hits) out.sort((a, b) => b.best - a.best)
  return out.map(({ best, ...f }) => f)
}
