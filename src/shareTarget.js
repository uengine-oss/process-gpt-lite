// 다른 앱의 「공유」로 Process GPT 에 넣기 (2026-11-26, 사용자 휴대폰 녹화 「우리가 파일을 공유할 때 여기 앱으로 process GPT가 들어가면
// 좋겠어.」 · 「현재 열려있는 공간의 첨부를 바로 할 수 있겠지.」) — the pure rules. No Vue and no window at import time, so
// server/test/shareTarget.test.js runs them in node.
//   - what was shared (the service worker's record, public/sw.js) → the files (their type from the extension) and the words
//   - the place the person last had open on this device (a team room, the chat or one of its conversations, a project, a routine,
//     a folder): its kind and id, whose it is (the signed-in person, this address) and when it was last open — in localStorage
//   - whether that place can take this share now, else null; and whether it was open lately enough to offer it first (30 minutes)
//   - the words of the one question asked before anything goes in (「넣기」 · 「다른 곳에」): another site can post the same form
// The browser side (the cache the service worker wrote, the ?share= address, the screens): src/shareInbox.js, ShareArrival.vue.

// The service worker keeps to the same numbers (public/sw.js PGL_SHARE — the unit test compares them): what the composers take at once
// (10 files), the upload routes' own limit (50MB a file: /api/attachments, /api/team/uploads), and a total the phone's storage keeps.
export const LIMITS = { files: 10, fileBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, keepMs: 24 * 3600 * 1000 }
// a place left longer ago than this is offered first in the chooser, not taken by itself (「지금 현재 대화창이 열려 있다고 치면」)
export const IDLE_MS = 30 * 60 * 1000
export const LAST_KEY = 'pgl-last-place'
export const FOLDERS_KEY = 'pgl-recent-folders'
// a share waiting for its person to sign in: this window's sessionStorage only (src/shareInbox.js)
export const PENDING_KEY = 'pgl-share-pending'
// the messenger's unsent words per room (sessionStorage: this window only — a share reloads it): `${DRAFT_PREFIX}<user>:<room>`
export const DRAFT_PREFIX = 'pgl-msg-draft:'
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
/** The words' first lines (two, each short) — what the question shows of them, so the person sees what came in. */
export const firstLine = (text, n = 120, lines = 2) => clean(text).split('\n').filter((x) => x.trim()).slice(0, lines)
  .map((l) => (l.length > n ? `${l.slice(0, n - 1)}…` : l)).join('\n')

// The type a file is given here, from its extension only — never what the sharing app (or another site) said. A page, a picture that can
// run script or an XML document (html, svg, xml, xhtml …) and anything unknown go as plain bytes.
const TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg',
  wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json', zip: 'application/zip',
  hwp: 'application/x-hwp', hwpx: 'application/hwp+zip', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
export const typeOf = (name) => TYPES[/\.([a-z0-9]{1,8})$/i.exec(String(name || ''))?.[1]?.toLowerCase()] || 'application/octet-stream'

/** A file name the places take: no folder separators or control characters, never empty. */
export function fileName(name, n = 0) {
  const base = clean(name, 200).replace(/[\\/]+/g, '_').replace(/^\.+/, '').trim()
  return base || `공유한 파일${n ? ` ${n + 1}` : ''}`
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
 * The one question before a share goes in: 「공유한 파일 2개와 글을 ‘시니어그룹’에 넣을까요?」 (a folder takes the files only).
 * files: how many came, text: whether words came, label: the place's name, kind: its kind.
 */
export function askTitle({ files = 0, text = false } = {}, label = '', kind = '') {
  if (kind === 'folder') return `공유한 파일 ${files}개를 ‘${label}’ 폴더에 넣을까요?`
  const what = files && text ? `파일 ${files}개와 글을` : files ? `파일 ${files}개를` : '글을'
  return `공유한 ${what} ‘${label}’에 넣을까요?`
}

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

// whose a kept place is: who = { uid: the signed-in person (the session's subject), t: this address — one company's host }
const mine = (v, who) => !!who?.uid && v?.uid === who.uid && v?.t === (who.t || '')
const okPlace = (v) => !!v && typeof v === 'object' && KINDS.includes(v.kind) && typeof v.id === 'string' && v.id.length <= 200 && (v.kind === 'chat' || !!v.id)
/** The place kept on this device for this person ({kind, id, at}), or null — someone else's, or none. Never throws. */
export function readLast(storage, who) {
  try {
    const v = JSON.parse(storage?.getItem(LAST_KEY) || 'null')
    return okPlace(v) && mine(v, who) ? { kind: v.kind, id: v.id, at: Number(v.at) || 0 } : null
  } catch { return null }
}
/** Keeps the open place (its kind and id, whose, when) — null: nothing is open now. Never throws (a private window keeps nothing). */
export function writeLast(storage, place, who, now = Date.now()) {
  try {
    if (place && okPlace(place) && who?.uid) storage?.setItem(LAST_KEY, JSON.stringify({ kind: place.kind, id: place.id, uid: who.uid, t: who.t || '', at: now }))
    else storage?.removeItem(LAST_KEY)
  } catch { /* nothing kept: the next share asks where */ }
}
/** The kept place, still open as the app goes to the background (another app's 「공유」 begins there): its time is now. */
export function touchLast(storage, who, now = Date.now()) {
  const v = readLast(storage, who)
  if (v) writeLast(storage, v, who, now)
}
/** Whether a kept place was open lately enough to take a share by itself (else the chooser offers it first). */
export const isFresh = (last, now = Date.now()) => !!last && now - Number(last.at || 0) < IDLE_MS

/** The folders this person opened lately on this device (their slugs, newest first, at most 5). */
export function recentFolders(storage, who) {
  try {
    const v = JSON.parse(storage?.getItem(FOLDERS_KEY) || 'null')
    return v && mine(v, who) && Array.isArray(v.slugs) ? v.slugs.filter((s) => typeof s === 'string' && s && s.length <= 200).slice(0, 5) : []
  } catch { return [] }
}
export function rememberFolder(storage, slug, who) {
  if (!slug || !who?.uid) return
  try { storage?.setItem(FOLDERS_KEY, JSON.stringify({ uid: who.uid, t: who.t || '', slugs: [String(slug), ...recentFolders(storage, who).filter((s) => s !== String(slug))].slice(0, 5) })) } catch { /* not kept */ }
}
/** Signed out (or another person's session taken over): this device forgets the places, the waiting share and the unsent words. */
export function forgetPlaces(local, session) {
  for (const k of [LAST_KEY, FOLDERS_KEY, PENDING_KEY]) { try { local?.removeItem(k) } catch { /* nothing kept */ } }
  try { session?.removeItem(PENDING_KEY) } catch { /* nothing kept */ }
  try {
    const keys = []
    for (let i = 0; i < (session?.length || 0); i++) { const k = session.key(i); if (k?.startsWith(DRAFT_PREFIX)) keys.push(k) }
    for (const k of keys) session.removeItem(k)
  } catch { /* nothing kept */ }
}

const WRITE = new Set(['editor', 'owner'])
/**
 * Where a share would go: the place last open, when it can take it now — else null (the chooser).
 * last: {kind, id} | null. what: { files: n, text: bool }. known: what the app knows now —
 *   rooms: [thread ids], projects: [ids], conversations: [ids of the main chat's conversations], routines: [instance ids I can open],
 *   folder: {slug, role} of last.id (or null).
 * A folder takes files only (it has no box for words): a share with only words never goes to one; a folder I may not write to neither.
 */
export function pickTarget(last, what = {}, known = {}) {
  if (!last || !KINDS.includes(last.kind)) return null
  const files = Number(what.files || 0), text = !!what.text
  if (!files && !text) return null
  if (last.kind === 'room') return (known.rooms || []).includes(last.id) ? { kind: 'room', id: last.id } : null
  if (last.kind === 'chat') return { kind: 'chat', id: last.id && (known.conversations || []).includes(last.id) ? last.id : '' }
  if (last.kind === 'project') return (known.projects || []).includes(last.id) ? { kind: 'project', id: last.id } : null
  if (last.kind === 'routine') return (known.routines || []).includes(last.id) ? { kind: 'routine', id: last.id } : null
  if (last.kind === 'folder') return files && known.folder?.slug === last.id && WRITE.has(known.folder.role) ? { kind: 'folder', id: last.id } : null
  return null
}

/**
 * The chooser's rows (「어디에 넣을까요?」): the place last open when it was a while ago (first), the rooms I talked in lately (newest first),
 * my chat, and — when files came — the folders I opened lately and can write to (else the ones changed lately).
 * rooms: GET /team/threads; folders: GET /folders; first: {kind, id, title} or null.
 */
export function chooserRows({ rooms = [], folders = [], recent = [], meId = null, files = 0, first = null, max = { rooms: 5, folders: 3 } } = {}) {
  const same = (r) => !!first && r.kind === first.kind && r.id === first.id
  const roomRows = rooms.map((t) => {
    const others = (t.members || []).filter((m) => m.id !== meId)
    return { kind: 'room', id: String(t.id), title: t.title || others.map((m) => m.name).join(', ') || '대화', group: t.kind === 'group', other: others.length === 1 ? others[0] : null,
      sub: t.kind === 'group' ? `단체방 · ${(t.members || []).length}명` : '1:1 대화' }
  })
  const writable = folders.filter((f) => WRITE.has(f.role))
  const seen = recent.map((s) => writable.find((f) => f.slug === s)).filter(Boolean)
  const folderRows = files ? [...seen, ...writable.filter((f) => !seen.includes(f))]
    .map((f) => ({ kind: 'folder', id: String(f.slug), title: f.name || f.slug, sub: seen.includes(f) ? '최근에 연 폴더' : '공유 폴더' })) : []
  const chat = { kind: 'chat', id: '', title: 'Process GPT 채팅', sub: files ? 'AI에게 이 파일로 질문하기' : 'AI에게 이 글로 질문하기' }
  // (the place offered first keeps the look and the line of its kind: a room's face and 「단체방 · 3명」, a folder's icon …)
  const KIND = { room: '대화', chat: '채팅의 대화', project: '프로젝트', routine: '루틴', folder: '공유 폴더' }
  const base = first ? (first.kind === 'room' ? roomRows.find(same) : first.kind === 'folder' ? folderRows.find(same) : first.kind === 'chat' && !first.id ? chat : null) : null
  const firstRow = first ? { ...(base || {}), ...first, sub: base?.sub || KIND[first.kind] || '' } : null
  return {
    first: firstRow,
    rooms: roomRows.filter((r) => !same(r)).slice(0, max.rooms),
    chat: first && same(chat) ? null : chat,
    folders: folderRows.filter((r) => !same(r)).slice(0, max.folders),
  }
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
