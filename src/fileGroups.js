// One turn's many files read as one card, and every file list tells same-named files apart by their folder (2026-11-28 phone
// recording: one turn wrote 21 files — README.md several times, curriculum.md twice, ADR-001…004 — and the chat stacked 21 big cards;
// 「이 프로젝트의 산출물 21개」 showed README.md again and again with nothing to tell them apart. 「클로드 코드의 에이전트를 쓰면 이런 것 다
// 폴더로 관리해서 버전 1, 버전 2 … 특정 폴더 안에다가 담아 가지고 작업의 내용을 관리」 — spec openspec/specs/chat-artifacts 「한 턴의
// 많은 파일은 카드 하나」). The pure rules, without a browser (server/test/fileGroups.test.js):
//   relPath      where a file card's file sits, relative to its conversation's output folder (or a project's working copy)
//   fileRuns     which file messages of the chat on screen are one turn's run of more than three documents — one card stands for them
//   fileTree     a run's folders: the common folder (its work folder and version), then one section per folder, its files inside
//   folderHints  same-named files: the folder that tells each apart (「README.md · starter/」)
//   workFolderOf a file's work folder and version (<folder>/v<n>/ — server lib/workFolder.js puts a turn's files there)
//   artifactSections  the right column's list: files of one work folder and version together under its name
// Nothing here reads what a file or a message says — only paths, names, kinds and times.
import { mediaKindOf } from './mediaKind.js'

// more than three files of one turn: one card (three or fewer keep their own cards)
export const GROUP_FROM = 4
// one turn posts its files one after another as it ends (server lib/agent.js): a longer pause between two is another turn's
export const TURN_GAP_MS = 30_000
// a section of a group shows this many rows, the rest behind 「n개 더 보기」 — unless it has only a few more
export const ROWS_SHOWN = 6
export const ROWS_ALL = 8

const VERSION = /^v(\d{1,4})$/i
const segs = (p) => String(p || '').split('/').filter(Boolean)

// Where a file card's file sits, from its sandbox path: inside a conversation's folder (/workspace/.bpmn/<room>/…), inside a project's
// shared-folder working copy there (…/folders/<slug>/…), in an upload folder, or at the top of the workspace. A card with no path
// (a document a tool published) is its name alone.
export function relPath(c) {
  const name = String(c?.name || '')
  const p = String(c?.path || '').replace(/\\/g, '/')
  if (!p) return name
  let m = /^\/workspace\/\.bpmn\/[^/]+\/folders\/[^/]+\/(.+)$/.exec(p) || /^\/workspace\/\.bpmn\/[^/]+\/(.+)$/.exec(p)
    || /^\/workspace\/uploads\/[^/]+\/(.+)$/.exec(p) || /^\/workspace\/(.+)$/.exec(p)
  const rel = m ? m[1] : p.replace(/^\/+/, '')
  return rel || name
}
// the folder part of a relative path ('' at the top)
export const dirOf = (rel) => segs(rel).slice(0, -1).join('/')

const convKey = (c) => String(c?.conv || c?.context?.conversationId || '')
const timeOf = (m) => { const t = Date.parse(m?.created_at || ''); return Number.isFinite(t) ? t : null }
// a file card the agent made (not one a teammate shared, not a mail's private attachment — those come one by one)
const agentFile = (m) => m?.kind === 'file' && m.role === 'agent' && !!m.content?.name && !m.content.shared && !m.content.private
// a picture, a sound or a video keeps its own card: its preview under the card is the point (spec chat-media-preview)
export const groupable = (m) => agentFile(m) && !mediaKindOf(m.content)

// The file messages of `list` (the chat on screen, in order) that one card stands for: a run is consecutive agent file messages of the
// same conversation, each within TURN_GAP_MS of the one before — one turn's files. A run with GROUP_FROM or more documents is one card:
// lead (its first document's id → the run's documents) and member (the others' ids — not drawn on their own). Pictures · sounds ·
// videos in the run stay where they are.
export function fileRuns(list, { from = GROUP_FROM, gap = TURN_GAP_MS } = {}) {
  const lead = new Map()
  const member = new Set()
  let run = []
  const close = () => {
    const docs = run.filter(groupable)
    if (docs.length >= from) {
      lead.set(docs[0].id, docs)
      for (const m of docs.slice(1)) member.add(m.id)
    }
    run = []
  }
  for (const m of list || []) {
    if (!agentFile(m)) { close(); continue }
    const prev = run[run.length - 1]
    if (prev) {
      const a = timeOf(prev), b = timeOf(m)
      if (convKey(prev.content) !== convKey(m.content) || (a != null && b != null && Math.abs(b - a) > gap)) close()
    }
    run.push(m)
  }
  close()
  return { lead, member }
}

// The folder that tells each same-named file apart: for every name that more than one item has, the shortest end of their folder paths
// that differs ('starter/', 'v1/', 'curriculum/v2/'), '' at the top. items: [{id, name, dir}] → Map id → hint ('' for a top-level file).
// Names that appear once get no hint.
export function folderHints(items) {
  const byName = new Map()
  for (const x of items || []) {
    const k = String(x.name || '').normalize('NFC')
    if (!byName.has(k)) byName.set(k, [])
    byName.get(k).push(x)
  }
  const out = new Map()
  for (const same of byName.values()) {
    if (same.length < 2) continue
    const parts = same.map((x) => segs(x.dir))
    const deepest = Math.max(...parts.map((p) => p.length))
    let k = 1
    for (; k < deepest; k++) {
      const ends = parts.map((p) => p.slice(-k).join('/'))
      if (new Set(ends).size === ends.length) break
    }
    same.forEach((x, i) => out.set(x.id, parts[i].length ? `${parts[i].slice(-k).join('/')}/` : ''))
  }
  return out
}

// A file's work folder and version: the folder right before a version folder (커리큘럼/v2/…, outputs/커리큘럼/v1/… in a template's
// workspace), else the first folder of its path; null for a file at the top.
export function workFolderOf(rel) {
  const s = segs(rel).slice(0, -1)
  if (!s.length) return null
  const at = s.findIndex((x, i) => i > 0 && VERSION.test(x))
  if (at > 0) return { folder: s[at - 1], version: Number(VERSION.exec(s[at])[1]), key: s.slice(0, at + 1).join('/') }
  return { folder: s[0], version: null, key: s[0] }
}
export const versionOf = (seg) => { const m = VERSION.exec(String(seg || '')); return m ? Number(m[1]) : null }

// A run's tree: {files, folders, common, work, sections:[{dir, rows:[{msg, rel, name, hint}]}]} — hint: null for a name that is alone,
// '' for a same-named file at the top, else its folder hint. common: the folder every file is in
// (its rows start inside it; '' when they share none) — work: its work folder and version when it is one. Sections: the top first, then
// the folders by path; rows by name (numbers in names in order: ADR-2 before ADR-10).
const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
export function fileTree(msgs) {
  const rows = (msgs || []).map((m) => ({ msg: m, rel: relPath(m.content), name: String(m.content?.name || '') }))
  let common = null
  for (const r of rows) {
    const d = segs(dirOf(r.rel))
    if (common == null) { common = d; continue }
    let i = 0
    while (i < common.length && i < d.length && common[i] === d[i]) i++
    common = common.slice(0, i)
  }
  common = (common || []).join('/')
  const cut = common ? common.length + 1 : 0
  const sections = new Map()
  for (const r of rows) {
    const dir = dirOf(r.rel).slice(cut)
    if (!sections.has(dir)) sections.set(dir, [])
    sections.get(dir).push({ ...r, dir })
  }
  // (the folder inside the card's common folder: 'starter/', '' at its top)
  const hints = folderHints(rows.map((r) => ({ id: r.msg.id, name: r.name, dir: dirOf(r.rel).slice(cut) })))
  const list = [...sections.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : cmp(a, b)))
    .map(([dir, rs]) => ({ dir, rows: rs.sort((x, y) => cmp(x.name, y.name) || cmp(x.rel, y.rel)).map((r) => ({ ...r, hint: hints.has(r.msg.id) ? hints.get(r.msg.id) : null })) }))
  const work = common ? workFolderOf(`${common}/x`) : null
  return { files: rows.length, folders: list.filter((s) => s.dir).length, common, work: work?.version != null ? work : null, sections: list }
}

// how many rows a section shows folded to 「n개 더 보기」: all of a few, else the first ROWS_SHOWN
export const shownRows = (n, open = false) => (open || n <= ROWS_ALL ? n : ROWS_SHOWN)

// The right column's list in sections: the files of one work folder and version together under its name ({key, folder, version, items}),
// at the place of its newest file; a file in no folder is a section of its own with no name (key: its message id). items: the list's
// rows, newest first ({msg, conv, convTitle}). A row whose name is not alone gets its folder hint: inside a folder's section, its folder
// there ('starter/', '' at the section's top) when the section has that name more than once — the section's name tells it from other
// sections'; a file in no folder, among the whole list ('' — at the top).
export function artifactSections(items) {
  const rows = (items || []).map((x) => ({ ...x, rel: relPath(x.msg?.content) }))
  const hints = folderHints(rows.map((x) => ({ id: x.msg?.id, name: x.msg?.content?.name, dir: dirOf(x.rel) })))
  const out = []
  const at = new Map()
  for (const x of rows) {
    const w = workFolderOf(x.rel)
    if (!w) { out.push({ key: x.msg?.id, folder: null, version: null, items: [{ ...x, hint: hints.has(x.msg?.id) ? hints.get(x.msg.id) : null }] }); continue }
    // (one work folder of one conversation: the same folder name in two conversations is two works)
    const key = `${x.conv || ''}\u0000${w.key}`
    if (!at.has(key)) { at.set(key, out.length); out.push({ key, folder: w.folder, version: w.version, inner: w.key.length + 1, items: [] }) }
    out[at.get(key)].items.push(x)
  }
  for (const sec of out) {
    if (!sec.folder) continue
    const inner = folderHints(sec.items.map((x) => ({ id: x.msg?.id, name: x.msg?.content?.name, dir: dirOf(x.rel).slice(sec.inner) })))
    sec.items = sec.items.map((x) => ({ ...x, hint: inner.has(x.msg?.id) ? inner.get(x.msg.id) : null }))
    delete sec.inner
  }
  // a folder's older versions fold by default: the newest version of each folder is the one open (versions of the same folder in this list)
  const newest = new Map()
  for (const s of out) if (s.folder && s.version != null) newest.set(s.folder, Math.max(newest.get(s.folder) ?? -1, s.version))
  return out.map((s) => ({ ...s, older: !!s.folder && s.version != null && s.version < newest.get(s.folder) }))
}
