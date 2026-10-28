// The folder index (design 8장): tier 0 file list on every commit of main, tier 1 document cards
// (memento's doc_card shape + keywords, made here with the fast model, skipped when the blob did
// not change), tier 2 full text once a folder outgrows a card list (200 documents / ~12k tokens of
// cards / 5MB of text, or switched on) — then memento indexes it as well when it is reachable.
// Also the per-variation "바뀐 점" card and the search people and agents use.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chat } from '../llm.js'
import { L, isEn } from '../lang.js'
import * as G from './git.js'
import { readableFolderIds } from './service.js'

const DOC = /\.(md|markdown|txt|csv|docx|xlsx|pptx|hwpx|pdf)$/i
export const kindOf = (p) => (String(p).split('.').pop() || '').toLowerCase()
const isDoc = (p) => DOC.test(p)
// full-text tier thresholds (approved 2026-10-24)
export const FULLTEXT = { docs: 200, cardTokens: 12000, textBytes: 5 * 1024 * 1024 }
const MEMENTO = process.env.PRO_MEMENTO_URL || 'http://127.0.0.1:8005'

const run = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60000, ...opts }, (e, out) => resolve(e ? '' : String(out))))
const strip = (xml) => xml.replace(/<\/(w:p|a:p|hp:p|si|row)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim()

// plain text of a document blob, with a page count where the format has one
export async function extract(name, buf) {
  const ext = kindOf(name)
  if (['md', 'markdown', 'txt', 'csv'].includes(ext)) { const t = buf.toString('utf8'); return { text: t, pages: Math.max(1, Math.ceil(t.length / 1800)) } }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-fold-'))
  const f = path.join(tmp, `doc.${ext}`)
  try {
    await fs.writeFile(f, buf)
    if (ext === 'pdf') {
      const text = await run('pdftotext', ['-layout', f, '-'])
      const info = await run('pdfinfo', [f])
      return { text, pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1]) || 1 }
    }
    const list = await run('unzip', ['-Z1', f])
    const parts = {
      docx: list.split('\n').filter((x) => /^word\/document\.xml$/.test(x)),
      pptx: list.split('\n').filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/))),
      xlsx: list.split('\n').filter((x) => /^xl\/sharedStrings\.xml$/.test(x)),
      hwpx: list.split('\n').filter((x) => /^Contents\/section\d+\.xml$/.test(x)),
    }[ext] || []
    let text = ''
    for (const p of parts) text += strip(await run('unzip', ['-p', f, p])) + '\n\n'
    const pages = ext === 'pptx' ? parts.length : Math.max(1, Math.ceil(text.length / 1800))
    return { text: text.trim(), pages }
  } finally { fs.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
}

// tier 0 for main, then the cards that are missing or stale (in the background)
export async function reindex(folder, { cards = true } = {}) {
  const ref = folder.default_branch
  const files = (await G.lsTree(folder.repo_path, ref)).filter((f) => f.path !== '.gitattributes')
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
  queues.set(folder.id, job)
  ;(async () => {
    do {
      job.again = false
      const rows = await q(`select path, sha from pro_folder_files where folder_id=$1 and (card_sha is distinct from sha) order by mtime desc nulls last limit 60`, [folder.id])
      const todo = rows.filter((r) => isDoc(r.path) && (!only || only(r.path)))
      if (todo.length) await updateState(folder, { state: 'indexing', pending: todo.length })
      for (const r of todo) await makeCard(folder, r).catch((e) => console.warn('[folders] card', r.path, e.message))
      await updateState(folder)
    } while (job.again)
  })().catch((e) => console.warn('[folders] index', e.message)).finally(() => queues.delete(folder.id))
}

const CARD_PROMPT = `다음은 어떤 문서의 앞부분과 마지막 부분이다. JSON 으로만 답하라:
{"abstract": "이 문서가 무엇인지 1~2문장 한국어 평문(해요체). 여기에 없는 사실은 추가하지 마라", "keywords": ["문서를 찾을 때 쓸 핵심 낱말 3~6개"]}`

// English mode: the card in English (the same prompt otherwise)
const CARD_PROMPT_EN = `Below are the start and the end of a document. Answer with JSON only:
{"abstract": "what this document is, in 1-2 plain English sentences. Add no fact that is not here", "keywords": ["3-6 key words to find the document by"]}`
const CHANGE_PROMPT = '공유 폴더의 변형이 기준본(main)에서 무엇을 바꿨는지 알려 준다. JSON 으로만: {"title": "무엇을 바꿨는지 8~24자 명사구(예: 안내문 사전 신청 문구 추가)", "summary": "전체 한 문장(해요체)", "files": {"<경로>": "그 파일에서 바뀐 점 한 문장(해요체)"}}. 차이에 없는 내용은 지어내지 마라.'
const CHANGE_PROMPT_EN = 'Say what a variation of a shared folder changed compared with main. JSON only: {"title": "what changed, a 3-8 word English noun phrase (e.g. Pre-registration line added to the notice)", "summary": "one English sentence for the whole change", "files": {"<path>": "one English sentence on what changed in that file"}}. Make up nothing that is not in the diff.'

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
  if (body) mementoUpload(folder, row.path, buf).catch(() => {})
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
    const card = { title: String(j.title || '').slice(0, 40), summary: String(j.summary || ''), files: j.files && typeof j.files === 'object' ? j.files : {}, generated_at: new Date().toISOString(), head: v.head_commit }
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

// search: folder names, file paths, card abstracts and keywords; full text where it is on.
// Only folders the user can read.
export async function search(userId, text, limit = 20) {
  const k = String(text || '').trim()
  if (!k) return []
  const ids = await readableFolderIds(userId)
  if (!ids.length) return []
  const like = `%${k.replace(/[%_\\]/g, (c) => '\\' + c)}%`
  const folders = await q(`select id, slug, name, description, kind from pro_folders where id = any($1) and (name ilike $2 or description ilike $2) limit 10`, [ids, like])
  const files = await q(`select f.folder_id, p.slug, p.name as folder_name, f.path, f.kind, f.size, f.card,
                           case when f.path ilike $2 then 'name' when (f.card->>'abstract') ilike $2 or (f.card->>'keywords') ilike $2 then 'card' else 'text' end as by,
                           case when f.body ilike $2 then substr(f.body, greatest(1, position(lower($3) in lower(f.body)) - 60), 180) end as snippet
                         from pro_folder_files f join pro_folders p on p.id=f.folder_id
                         where f.folder_id = any($1) and (f.path ilike $2 or (f.card->>'abstract') ilike $2 or (f.card->>'keywords') ilike $2
                           or ((p.index_state->>'fulltext')::boolean and f.body ilike $2))
                         order by (f.path ilike $2) desc, f.mtime desc nulls last limit $4`, [ids, like, k, limit])
  return [...folders.map((f) => ({ type: 'folder', folder: f })), ...files.map((f) => ({ type: 'file', folder: { id: f.folder_id, slug: f.slug, name: f.folder_name }, file: { path: f.path, kind: f.kind, size: f.size, card: f.card }, by: f.by, snippet: f.snippet }))]
}

// the catalog an agent reads first: folders it may use, each with its files and their cards
export async function catalog(userId, query) {
  const ids = await readableFolderIds(userId)
  if (!ids.length) return []
  const folders = await q('select id, slug, name, description, kind, index_state from pro_folders where id = any($1) order by updated_at desc', [ids])
  const hits = query ? await search(userId, query, 40) : null
  const out = []
  for (const f of folders) {
    let files = await q(`select path, kind, size, card from pro_folder_files where folder_id=$1 order by path limit 200`, [f.id])
    if (hits) {
      const inFolder = new Set(hits.filter((h) => h.type === 'file' && h.folder.id === f.id).map((h) => h.file.path))
      const folderHit = hits.some((h) => h.type === 'folder' && h.folder.id === f.id)
      if (!inFolder.size && !folderHit) continue
      if (inFolder.size) files = files.filter((x) => inFolder.has(x.path))
    }
    out.push({ slug: f.slug, name: f.name, description: f.description, kind: f.kind, index: f.index_state?.state, files: files.map((x) => ({ path: x.path, size: x.size, summary: x.card?.abstract || null, keywords: x.card?.keywords || [] })) })
  }
  return out
}
