// One drag for every file in the app (2026-11-24 사용자: 「폴더내의 파일을 드래그앤드롭하면 멘션이 이루어져서 대화방에 공유됨」 · 「프로젝트나 채팅에서의
// 산출물을 끌어다 놓기도」 · 「대화창에 받은 파일에서 드래그하여 폴더에 넣기, AI 창에 넣기도 가능하지 (모두 멘션)」 — spec messenger-file-mention).
// Every file surface puts the same payload on the drag: a shared folder's file row, a chat or project file card, the artifact pile and
// list, a file received in the messenger (a mention card, a shared file), a meeting's material. Three places take it:
//   a messenger conversation   a link (a shared folder's file) or a share (an artifact of mine) — the composer's chip says which
//   the AI chat composer        a chip: the agent turn reads that file (with my access)
//   a folder                    the file goes into that folder (a commit in my name)
// A mail is an item of the same drag (2026-11-24 「채팅에 멘션해서 뭔가 후속 작업을 할 수 있어야」 — spec mail-card-actions): its Home card, the mail
// sheet's handle, a chat's mail chip. The AI chat takes it as a chip the agent reads; a messenger conversation as a mail mention (a summary
// for the others unless its owner shares the body — server lib/mailMention.js); a folder refuses it.
// What an item becomes is decided by the server with the person's own access (server/lib/fileRefs.js). Files from the computer
// ('Files') keep their own way everywhere. No browser state is needed to read a payload (tested in server/test/fileMention.test.js).

export const DRAG_TYPE = 'application/x-pgl-file'
// (src/base.js, read here without it: this file is also read outside Vite)
const BASE = String(import.meta.env?.BASE_URL || '/').replace(/\/$/, '')
export const MAX = 10
const UUID = /^[0-9a-f-]{36}$/i
const COMMIT = /^[0-9a-f]{40}$/
const s = (v, n = 400) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
const base = (p) => String(p || '').split('/').pop()

// ---------- items ----------
//   folder  a shared folder's file: {slug, folder (its name), path, commit? (main's, as the list showed it), variation?}
//   card    a file card of mine: {id} — `as` says what the drop will likely make of it (the server decides)
//   share   a file a teammate shared with me, or one I shared: {shareId}
//   ref     a file mention in a messenger message: {messageId, index}
//   mail    a mail of mine — its Home card: {id (the card's id), name (its subject), from (the sender's name)}
export const folderItem = (folder, file, { commit = null, variation = null } = {}) => ({ src: 'folder', slug: folder.slug, folder: folder.name, path: file.path, name: base(file.path),
  ...(COMMIT.test(commit || '') ? { commit } : {}), ...(variation ? { variation } : {}), as: 'link' })
// a file the agent wrote in a project's folder checkout (server threadFolders.js) — it lives in the project's variation
export const projectFile = (p) => /^\/workspace\/\.bpmn\/[^/]+\/folders\/[^/]+\/.+/.test(String(p || ''))
export const cardItem = (msg) => {
  const c = msg?.content || {}
  return { src: 'card', id: msg.id, name: c.name || base(c.path || c.url), as: c.folder?.slug || projectFile(c.path) ? 'link' : 'share', ...(c.folder?.name ? { folder: c.folder.name } : {}) }
}
export const shareItem = (a) => ({ src: 'share', shareId: a.shareId, name: a.name, as: 'share' })
export const refItem = (m, r, i) => ({ src: 'ref', messageId: m.id, index: i, name: r.name, folder: r.folder, as: 'link' })
// a mail's Home card (or a chip naming it: {actionId, text}) → the mail as an item
const senderName = (f) => String(f || '').split('<')[0].replace(/"/g, '').trim() || String(f || '').replace(/[<>]/g, '').trim()
export const mailItem = (a) => (a?.id || a?.actionId ? { src: 'mail', id: a.id || a.actionId, name: a.source?.subject || a.subject || a.text || '메일',
  from: senderName(a.source?.from || a.from), as: 'mail' } : null)

// one item as it came off a drag → the item, or null when it is not one (a payload from another page, a hand-made one)
export function validItem(x) {
  if (!x || typeof x !== 'object') return null
  const name = s(x.name, 200)
  const as = x.as === 'link' || x.as === 'share' ? x.as : undefined
  if (x.src === 'folder' && s(x.slug) && s(x.path, 1000) && !s(x.path, 1000).split('/').includes('..')) {
    return { src: 'folder', slug: s(x.slug, 120), folder: s(x.folder, 120), path: s(x.path, 1000), name: name || base(x.path), ...(COMMIT.test(x.commit || '') ? { commit: x.commit } : {}),
      ...(UUID.test(String(x.variation || '')) ? { variation: String(x.variation) } : {}), as: 'link' }
  }
  if (x.src === 'card' && UUID.test(String(x.id || ''))) return { src: 'card', id: String(x.id), name, ...(as ? { as } : {}), ...(s(x.folder) ? { folder: s(x.folder, 120) } : {}) }
  if (x.src === 'share' && UUID.test(String(x.shareId || ''))) return { src: 'share', shareId: String(x.shareId), name, as: 'share' }
  if (x.src === 'ref' && /^[\w.:-]{1,120}$/.test(String(x.messageId || '')) && Number.isInteger(x.index) && x.index >= 0 && x.index < MAX) {
    return { src: 'ref', messageId: String(x.messageId), index: x.index, name, ...(s(x.folder) ? { folder: s(x.folder, 120) } : {}), as: 'link' }
  }
  if (x.src === 'mail' && UUID.test(String(x.id || ''))) return { src: 'mail', id: String(x.id), name, ...(s(x.from) ? { from: s(x.from, 120) } : {}), as: 'mail' }
  return null
}
// the payload's text → its items ([] when it is not ours)
export function parsePayload(text) {
  let j
  try { j = JSON.parse(String(text || '')) } catch { return [] }
  const list = Array.isArray(j) ? j : j && j.v === 1 && Array.isArray(j.items) ? j.items : []
  const out = []
  for (const x of list.slice(0, MAX)) { const it = validItem(x); if (it && !out.some((y) => same(y, it))) out.push(it) }
  return out
}
export const same = (a, b) => a.src === b.src && (a.src === 'folder' ? a.slug === b.slug && a.path === b.path && (a.variation || '') === (b.variation || '')
  : a.src === 'card' || a.src === 'mail' ? a.id === b.id : a.src === 'share' ? a.shareId === b.shareId : a.messageId === b.messageId && a.index === b.index)
export const payload = (items) => JSON.stringify({ v: 1, items: items.slice(0, MAX) })

// a link of this app to a folder's file (text/uri-list — a drag from another window of the app): /folders/<slug>?file=<path>[&ref=]
export function itemFromUrl(u, origin) {
  let url
  try { url = new URL(String(u || '').split(/\r?\n/).find((l) => l && !l.startsWith('#')) || '', origin) } catch { return null }
  if (origin && url.origin !== new URL(origin).origin) return null
  const m = /\/folders\/([^/?#]+)$/.exec(url.pathname)
  const file = url.searchParams.get('file')
  if (!m || !file) return null
  const ref = url.searchParams.get('ref') || ''
  let slug
  try { slug = decodeURIComponent(m[1]) } catch { return null }
  return validItem({ src: 'folder', slug, path: file, ...(COMMIT.test(ref) ? { commit: ref } : UUID.test(ref) ? { variation: ref } : {}) })
}

// what is being dragged, from its types alone (all a dragover may read): 'pgl' (files of this app), 'files' (from the computer), null
export function dragKind(types) {
  const t = [...(types || [])]
  if (t.includes(DRAG_TYPE)) return 'pgl'
  if (t.includes('Files')) return 'files'
  return null
}
// what the drop will likely make of these items in a conversation: 'link' · 'share' · 'mixed'
export function asOf(items) {
  const kinds = new Set((items || []).map((x) => x.as || (x.src === 'share' ? 'share' : 'link')))
  return kinds.size === 1 ? [...kinds][0] : kinds.size ? 'mixed' : 'link'
}
// the words a drop zone shows while these items are over it
export function zoneWords(target, items) {
  const mail = (items || []).length > 0 && items.every((x) => x.src === 'mail')
  if (target === 'chat') return mail ? 'AI에게 이 메일로 묻기' : 'AI에게 이 파일로 묻기'
  if (target === 'folder') return mail ? '메일은 폴더에 넣지 않아요' : '이 폴더에 넣기'
  if (mail) return '여기에 놓으면 메일을 멘션해요'
  const a = asOf(items)
  return a === 'share' ? '여기에 놓으면 공유해요' : a === 'mixed' ? '여기에 놓으면 링크로 멘션하거나 공유해요' : '여기에 놓으면 링크로 멘션해요'
}

// ---------- in the browser ----------
// the items of a drag that started on this page (a dragover cannot read the payload; the zone's words need it)
let current = null
export const dragging = () => current
export function startDrag(e, items) {
  const list = items.filter(Boolean).slice(0, MAX)
  if (!list.length || !e.dataTransfer) return
  current = list
  const dt = e.dataTransfer
  dt.effectAllowed = 'copyLink'
  dt.setData(DRAG_TYPE, payload(list))
  dt.setData('text/plain', list.map((x) => x.name).join('\n'))
  const links = list.filter((x) => x.src === 'folder').map((x) => `${location.origin}${BASE}/folders/${encodeURIComponent(x.slug)}?file=${encodeURIComponent(x.path)}`)
  if (links.length) dt.setData('text/uri-list', links.join('\r\n'))
  ghost(dt, list)
  // (dragend may not come when the source is taken off the page mid-drag)
  const clear = () => { current = null; window.removeEventListener('dragend', clear, true); window.removeEventListener('drop', later, true) }
  const later = () => setTimeout(clear, 0)
  window.addEventListener('dragend', clear, true)
  window.addEventListener('drop', later, true)
}
// the items a drop carries (ours, or a folder link from another window of the app)
export function itemsOf(e) {
  const dt = e.dataTransfer
  if (!dt) return []
  const ours = parsePayload(dt.getData(DRAG_TYPE))
  if (ours.length) return ours
  const it = itemFromUrl(dt.getData('text/uri-list'), location.origin)
  return it ? [it] : []
}
// what follows the pointer: a small pill with the file's name (or how many), not the row's screenshot
const KIND = { hwp: '한글', hwpx: '한글', docx: 'DOC', doc: 'DOC', xlsx: 'XLS', xls: 'XLS', csv: 'XLS', pptx: 'PPT', ppt: 'PPT', pdf: 'PDF', md: 'MD', txt: 'TXT', png: 'IMG', jpg: 'IMG', jpeg: 'IMG' }
function ghost(dt, list) {
  if (typeof document === 'undefined' || !dt.setDragImage) return
  const el = document.createElement('div')
  const ext = String(list[0].name || '').split('.').pop().toLowerCase()
  el.className = 'pgl-drag-ghost'
  const mail = list[0].src === 'mail'
  el.innerHTML = `<i>${mail ? '✉' : KIND[ext] || 'FILE'}</i><b></b>${list.length > 1 ? `<em>+${list.length - 1}</em>` : ''}`
  el.querySelector('b').textContent = mail ? `${list[0].from ? `${list[0].from} · ` : ''}${list[0].name || '메일'}` : list[0].name || '파일'
  Object.assign(el.style, { position: 'fixed', top: '-200px', left: '-400px', zIndex: 9999, display: 'inline-flex', alignItems: 'center', gap: '8px', maxWidth: '280px',
    padding: '6px 12px 6px 6px', borderRadius: '14px', background: 'rgba(29,29,31,.88)', color: '#fff', font: '500 13px/1.2 system-ui, sans-serif', boxShadow: '0 10px 30px rgba(0,0,0,.25)' })
  const i = el.querySelector('i')
  Object.assign(i.style, { fontStyle: 'normal', width: '26px', height: '26px', borderRadius: '8px', display: 'grid', placeItems: 'center', fontSize: mail ? '14px' : '9px', fontWeight: '700', background: mail ? '#7a5af5' : '#2a78d6' })
  Object.assign(el.querySelector('b').style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  const em = el.querySelector('em')
  if (em) Object.assign(em.style, { fontStyle: 'normal', fontSize: '11.5px', padding: '1px 7px', borderRadius: '9px', background: 'rgba(255,255,255,.18)' })
  document.body.appendChild(el)
  try { dt.setDragImage(el, 18, 18) } catch { /* a synthetic drag */ }
  setTimeout(() => el.remove(), 0)
}
