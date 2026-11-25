// The files a browser task may give to a site (2026-11-25, production: 「AI 로 만든 문서나 대화창에 올려진 파일 내용을 브라우저 쪽으로 업로드를
// 못시키네」 — a NotebookLM podcast from a 15-page PDF the agent had made earlier in the room stopped with 「이 작업에 … PDF 파일이 첨부되어
// 있지 않아 업로드할 수 없습니다」). Not only what was attached to the request that started it: what the person can see in this
// conversation —
//   · the room's file cards: what the agent made here (its outputs, the 산출물 stack) and what was posted in the chat
//   · the files of the folder the room is linked to (as a member of that folder: lib/folders/service.js access)
//   · files teammates shared with the person (lib/team/shares.js — as their recipient)
// Which one the words mean ("그 PDF", 「온톨로지 보고서」) is read by the judge over the candidates' names, kinds and sizes (lib/judge.js),
// never by matching names in code. Bytes come from where the person may read them — the workspace, private storage downloads, the
// folder's git, the share's own object — into the task's private temporary folder; never through a public address.
import path from 'node:path'
import { q } from './supa.js'
import { L } from './lang.js'
import { judge } from './judge.js'
import { config } from '../config.js'

export const FILE_BAR = 0.6 // one file is used without asking at this
export const FILE_MAYBE = 0.2 // files the judge gives at least this are offered on a card when none is sure
export const MAX_CANDIDATES = 30
const cap = (t, n = 120) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)
export const kindOf = (name) => { const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : '' }
const sizeText = (n) => (!n ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const FROM = { artifact: ['이 방에서 AI 가 만든 파일', 'made by the AI in this room'], chat: ['채팅에 올린 파일', 'posted in the chat'], folder: ['연결된 폴더의 파일', "in the room's folder"], share: ['동료가 공유한 파일', 'shared by a teammate'] }
export const fromText = (from) => L(FROM[from]?.[0] || from, FROM[from]?.[1] || from)

// → [{ id, name, kind, size, from, src }] newest first, one per name and place. deps: the folder and share helpers (tests)
export async function fileCandidates(user, threadId, { deps = {} } = {}) {
  const out = []
  const seen = new Set()
  const add = (c) => { const k = `${c.from}:${c.name}`; if (seen.has(k) || out.length >= MAX_CANDIDATES) return; seen.add(k); out.push({ ...c, kind: kindOf(c.name) }) }
  // the room's file cards — only in the person's own room
  const cards = await q(`select m.id, m.role, m.content from pro_messages m join pro_threads t on t.id=m.thread_id
    where m.thread_id=$1 and t.user_id=$2 and m.kind='file' order by m.created_at desc limit 80`, [threadId, user.id])
  for (const m of cards) {
    const c = m.content || {}
    const name = String(c.name || path.posix.basename(String(c.path || c.url || ''))).trim()
    if (!name) continue
    add({ id: `card:${m.id}`, name, size: Number(c.size) || 0, from: m.role === 'user' ? 'chat' : 'artifact', src: { card: m.id, path: c.path || '', url: c.url || '', key: c.key || '' } })
  }
  // the folder the room works in (its main), as a member
  const folders = deps.folders || await import('./folders/service.js')
  const link = deps.link !== undefined ? deps.link : await import('./folders/threadFolders.js').then((m) => m.linkOf(threadId)).catch(() => null)
  if (link?.slug) {
    try {
      const { folder } = await folders.access(link.slug, user, 'viewer')
      for (const f of (await folders.tree(folder, 'main')).filter((x) => x.kind !== 'tree' && x.kind !== 'dir').slice(0, 60)) {
        add({ id: `folder:${link.slug}:${f.path}`, name: path.posix.basename(f.path), size: Number(f.size) || 0, from: 'folder', src: { slug: link.slug, path: f.path } })
      }
    } catch { /* not a member: not offered */ }
  }
  // what teammates shared with this person (their recipient copy)
  const shares = deps.shares || (await q(`select id, name from pro_shares where recipient_id=$1 and revoked_at is null and tenant_id=$2 order by created_at desc limit 30`, [user.id, config.tenantId]).catch(() => []))
  for (const s of shares) if (s?.name) add({ id: `share:${s.id}`, name: s.name, size: Number(s.size) || 0, from: 'share', src: { share: s.id } })
  return out
}

// What the judge reads: the task (or what the person said), what the page wants (a kind, when known), and the candidates
export const FILE_QUESTION = () => L('이 작업이 사이트에 올려야 하는 파일은 아래 가운데 어느 것인가?', 'Which of these files is the one this task has to give to the site?')
export const fileOptions = (list) => [...list.map((c, i) => ({ key: `f${i}`, label: `${cap(c.name, 100)} · ${c.kind || L('형식 모름', 'unknown kind')}${c.size ? ` · ${sizeText(c.size)}` : ''} · ${fromText(c.from)}` })),
  { key: 'none', label: L('이 가운데 맞는 파일이 없다', 'None of these') }]
export const fileState = (goal, { want = '' } = {}) => [L(`작업: ${cap(goal, 600)}`, `Task: ${cap(goal, 600)}`), ...(want ? [L(`찾는 파일: ${cap(want, 200)}`, `The file it looks for: ${cap(want, 200)}`)] : [])].join('\n')
// probabilities → { pick: candidate | null, maybe: [candidates] (the ones worth offering when none is sure) }
export function filePick(probabilities, list, { bar = FILE_BAR, maybe = FILE_MAYBE } = {}) {
  const pr = probabilities || {}
  const ranked = list.map((c, i) => [c, pr[`f${i}`] || 0]).sort((a, b) => b[1] - a[1])
  const [best, second] = ranked
  if (best && best[1] >= bar && !(second && second[1] >= maybe)) return { pick: best[0], maybe: [] }
  return { pick: null, maybe: ranked.filter(([, p]) => p >= maybe).map(([c]) => c) }
}
// → { pick, maybe, probabilities, via, ms } — nothing to choose from, or a judge that cannot answer: no file
export async function readFile(list, goal, { want = '' } = {}) {
  const t0 = Date.now()
  if (!list.length) return { pick: null, maybe: [], probabilities: {}, ms: 0 }
  try {
    const r = await judge({ state: fileState(goal, { want }), question: FILE_QUESTION(), options: fileOptions(list) })
    return { ...filePick(r?.probabilities, list), probabilities: r?.probabilities || {}, via: r?.via || '', ms: Date.now() - t0 }
  } catch (e) {
    return { pick: null, maybe: [], probabilities: {}, via: 'none', ms: Date.now() - t0, error: e.message }
  }
}

// A candidate as one of the task's files (what attach_file uses): where its bytes are, never a public address for a page
export function asTaskFile(c) {
  return { name: c.name, ...(c.size ? { size: c.size } : {}), from: c.from, ...(c.src?.path ? { path: c.src.path } : {}), ...(c.src?.key ? { key: c.src.key } : {}), ...(c.src?.url ? { url: c.src.url } : {}),
    ...(c.src?.slug ? { folder: { slug: c.src.slug, path: c.src.path } } : {}), ...(c.src?.share ? { share: c.src.share } : {}) }
}
// The bytes of a folder file or a share, read as the person (the room's own cards go by their workspace path or storage key —
// lib/browser.js localCopy). → Buffer, or null when this is not one of those
export async function bytesOf(user, f, { deps = {} } = {}) {
  if (f.folder?.slug) {
    const folders = deps.folders || await import('./folders/service.js')
    const { folder } = await folders.access(f.folder.slug, user, 'viewer')
    return Buffer.from(await folders.readBlob(folder, 'main', f.folder.path))
  }
  if (f.share) {
    const shares = deps.shares || await import('./team/shares.js')
    return (await shares.bytes(user, f.share)).buf
  }
  return null
}
