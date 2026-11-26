// 다른 앱의 「공유」로 Process GPT 에 넣기 (2026-11-26, 사용자 휴대폰 녹화 「우리가 파일을 공유할 때 여기 앱으로 process GPT가 들어가면
// 좋겠어.」 · 「현재 열려있는 공간의 첨부를 바로 할 수 있겠지.」) — the pure rules. No Vue and no window at import time, so
// server/test/shareTarget.test.js runs them in node.
//   - what was shared (the service worker's record, public/sw.js) → the files and the words for a composer
//   - the place the person last had open on this device (a team room, the chat or one of its conversations, a project, a routine,
//     a folder): only its kind and id are kept, in localStorage
//   - whether that place can take this share now, else null (the app asks 「어디에 넣을까요?」)
// The browser side (the cache the service worker wrote, the ?share= address, the screens): src/shareInbox.js, ShareArrival.vue.

// The service worker keeps to the same numbers (public/sw.js PGL_SHARE — the unit test compares them): what the composers take at once
// (10 files), the upload routes' own limit (50MB a file: /api/attachments, /api/team/uploads), and a total the phone's storage keeps.
export const LIMITS = { files: 10, fileBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, keepMs: 24 * 3600 * 1000 }
export const LAST_KEY = 'pgl-last-place'
export const FOLDERS_KEY = 'pgl-recent-folders'
export const PENDING_KEY = 'pgl-share-pending'
// a share's id as the service worker makes it: base-36 time, a dash, a random part
export const ID_RE = /^[0-9a-z]{6,12}-[0-9a-z]{4,16}$/
export const KINDS = ['room', 'chat', 'project', 'routine', 'folder']

/** When a share id was made (ms), from the id itself — 0 when it is not one. */
export function idTime(id) {
  if (!ID_RE.test(String(id || ''))) return 0
  const t = parseInt(String(id).split('-')[0], 36)
  return Number.isFinite(t) ? t : 0
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i
const clean = (s, n = 20000) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n)

/**
 * The words a share brings, for a composer: the title (when the text does not already say it), the text, and the address — kept
 * whole, never cut, and not twice (many apps put the address in the text and leave url empty, some send it in both).
 */
export function composeText({ title, text, url } = {}) {
  const t = clean(title, 300), x = clean(text), u = clean(url, 4000)
  const lines = []
  if (t && !x.includes(t) && !(u && t === u)) lines.push(t)
  if (x) lines.push(x)
  if (u && !x.includes(u)) lines.push(u)
  return lines.join('\n')
}

/** The address in what was shared, if there is one (a link share: the words are mostly it). */
export const linkOf = (share) => (URL_RE.exec([share?.url, share?.text].filter(Boolean).join(' '))?.[0] || '')

/** A file name the places take: no folder separators or control characters, never empty. */
export function fileName(name, n = 0, type = '') {
  const base = clean(name, 200).replace(/[\\/]+/g, '_').replace(/^\.+/, '').trim()
  if (base) return base
  const ext = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'text/plain': '.txt' }[String(type).toLowerCase()] || ''
  return `공유한 파일${n ? ` ${n + 1}` : ''}${ext}`
}

const mb = (n) => `${Math.max(1, Math.round(Number(n || 0) / 1048576))}MB`
/**
 * Why files did not come, in one or two short sentences (empty when all came). skipped: [{name, size, why: big | total | many | empty}].
 */
export function skippedNotice(skipped = []) {
  if (!skipped?.length) return ''
  const by = (w) => skipped.filter((s) => s.why === w)
  const big = by('big'), total = by('total'), many = by('many'), empty = by('empty')
  const out = []
  // (「(80MB)는」: the size in brackets is read last, so the particle never depends on the file's name)
  if (big.length === 1) out.push(`‘${big[0].name || '파일'}’(${mb(big[0].size)})는 50MB가 넘어서 넣지 못했어요.`)
  else if (big.length) out.push(`파일 ${big.length}개는 50MB가 넘어서 넣지 못했어요.`)
  if (total.length) out.push(`파일 ${total.length}개는 한 번에 받을 수 있는 200MB를 넘어서 넣지 못했어요.`)
  if (many.length) out.push(`파일은 한 번에 ${LIMITS.files}개까지 받아요. ${many.length}개는 넣지 못했어요.`)
  if (empty.length === 1) out.push(`‘${empty[0].name || '파일'}’ 파일이 비어 있어서 넣지 못했어요.`)
  else if (empty.length) out.push(`빈 파일 ${empty.length}개는 넣지 못했어요.`)
  return out.join(' ')
}

/** What a share holds, in a few words for a sheet's subtitle: 「견적서.pdf 외 1개」 · 「링크」 · 「글」 — each part on its own (the English
 * screen translates the words, never the file's name). */
export function summaryParts({ files = [], text = '' } = {}) {
  const parts = []
  if (files.length) parts.push(files.length === 1 ? files[0].name : `${files[0].name} 외 ${files.length - 1}개`)
  if (text) parts.push(URL_RE.test(text) && text.replace(URL_RE, '').trim().length < 2 ? '링크' : URL_RE.test(text) ? '글 · 링크' : '글')
  return parts
}
export const summary = (share) => summaryParts(share).join(' · ')

/**
 * The open place, read from the screen: the team messenger's conversation while it is open over the page, else the page's own place.
 * route: { path, mode, settings, public, noTeam, params }; messenger: { open, tab, active }.
 * Returns {kind, id} — or undefined where the page says nothing (settings over the page, sign-in, onboarding, the workroom: the
 * place before still counts) and null on a page with no place to put a file (the process map, the strategy page …).
 */
export function placeOf(route = {}, messenger = {}) {
  if (route.public || route.noTeam || route.settings) return undefined
  if (messenger.open && messenger.tab === 'threads' && messenger.active) return { kind: 'room', id: String(messenger.active) }
  const p = route.params || {}
  if (route.mode === 'chat' && /^\/chat(\/|$)/.test(route.path || '')) return { kind: 'chat', id: p.cid ? String(p.cid) : '' }
  if (route.mode === 'project' && p.id) return { kind: 'project', id: String(p.id) }
  if (route.mode === 'routine' && p.instId) return { kind: 'routine', id: String(p.instId) }
  if (/^\/folders\/[^/]+$/.test(route.path || '') && p.slug) return { kind: 'folder', id: String(p.slug) }
  return null
}

const okPlace = (v) => !!v && typeof v === 'object' && KINDS.includes(v.kind) && typeof v.id === 'string' && v.id.length <= 200 && (v.kind === 'chat' || !!v.id)
/** The place kept on this device ({kind, id}), or null. storage: localStorage (or what stands in for it); never throws. */
export function readLast(storage) {
  try { const v = JSON.parse(storage?.getItem(LAST_KEY) || 'null'); return okPlace(v) ? { kind: v.kind, id: v.id } : null } catch { return null }
}
/** Keeps the open place (only its kind and id) — null: nothing is open now. Never throws (a private window keeps nothing). */
export function writeLast(storage, place) {
  try {
    if (place && okPlace(place)) storage?.setItem(LAST_KEY, JSON.stringify({ kind: place.kind, id: place.id }))
    else storage?.removeItem(LAST_KEY)
  } catch { /* nothing kept: the next share asks where */ }
}
/** The folders opened lately on this device (their slugs, newest first, at most 5). */
export function recentFolders(storage) {
  try { const v = JSON.parse(storage?.getItem(FOLDERS_KEY) || '[]'); return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s && s.length <= 200).slice(0, 5) : [] } catch { return [] }
}
export function rememberFolder(storage, slug) {
  if (!slug) return
  try { storage?.setItem(FOLDERS_KEY, JSON.stringify([String(slug), ...recentFolders(storage).filter((s) => s !== String(slug))].slice(0, 5))) } catch { /* not kept */ }
}

const WRITE = new Set(['editor', 'owner'])
/**
 * Where a share goes by itself: the place last open, when it can take it now — else null (the chooser).
 * last: {kind, id} | null. what: { files: n, text: bool }. known: what the app knows now —
 *   rooms: [thread ids], projects: [ids], conversations: [ids of the main chat's conversations], folder: {slug, role} of last.id (or null).
 * A folder takes files only (it has no box for words): a share with only words never goes to one; a folder I may not write to neither.
 */
export function pickTarget(last, what = {}, known = {}) {
  if (!last || !KINDS.includes(last.kind)) return null
  const files = Number(what.files || 0), text = !!what.text
  if (!files && !text) return null
  if (last.kind === 'room') return (known.rooms || []).includes(last.id) ? { kind: 'room', id: last.id } : null
  if (last.kind === 'chat') return { kind: 'chat', id: last.id && (known.conversations || []).includes(last.id) ? last.id : '' }
  if (last.kind === 'project') return (known.projects || []).includes(last.id) ? { kind: 'project', id: last.id } : null
  if (last.kind === 'routine') return { kind: 'routine', id: last.id }
  if (last.kind === 'folder') return files && known.folder?.slug === last.id && WRITE.has(known.folder.role) ? { kind: 'folder', id: last.id } : null
  return null
}

/**
 * The chooser's rows (「어디에 넣을까요?」): the rooms I talked in lately (newest first), my chat, and — when files came — the
 * folders I opened lately and can write to (else the ones changed lately). rooms: GET /team/threads; folders: GET /folders.
 */
export function chooserRows({ rooms = [], folders = [], recent = [], meId = null, files = 0, max = { rooms: 5, folders: 3 } } = {}) {
  const roomRows = rooms.slice(0, max.rooms).map((t) => {
    const others = (t.members || []).filter((m) => m.id !== meId)
    return { kind: 'room', id: String(t.id), title: t.title || others.map((m) => m.name).join(', ') || '대화', group: t.kind === 'group', other: others.length === 1 ? others[0] : null,
      sub: t.kind === 'group' ? `단체방 · ${(t.members || []).length}명` : '1:1 대화' }
  })
  const writable = folders.filter((f) => WRITE.has(f.role))
  const seen = recent.map((s) => writable.find((f) => f.slug === s)).filter(Boolean)
  const folderRows = files ? [...seen, ...writable.filter((f) => !seen.includes(f))].slice(0, max.folders)
    .map((f) => ({ kind: 'folder', id: String(f.slug), title: f.name || f.slug, sub: seen.includes(f) ? '최근에 연 폴더' : '공유 폴더' })) : []
  return { rooms: roomRows, chat: { kind: 'chat', id: '', title: 'Process GPT 채팅', sub: files ? 'AI에게 이 파일로 질문하기' : 'AI에게 이 글로 질문하기' }, folders: folderRows }
}

/** The address a place opens at (null: the messenger's room — it is not a page). */
export function pathOf(t) {
  if (!t) return null
  if (t.kind === 'chat') return t.id ? `/chat/c/${encodeURIComponent(t.id)}` : '/chat'
  if (t.kind === 'project') return `/projects/${encodeURIComponent(t.id)}`
  if (t.kind === 'routine') return `/routines/${encodeURIComponent(t.id)}`
  if (t.kind === 'folder') return `/folders/${encodeURIComponent(t.id)}`
  return null
}
