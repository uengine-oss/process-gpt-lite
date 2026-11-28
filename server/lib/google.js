// Google Calendar / Gmail / Drive calls made with the user's own OAuth token from the vault.
import { config } from '../config.js'
import { googleAccessToken } from './mail.js'
import { L } from './lang.js'

// token: an access token the caller already has (Drive resolves it once per call; the unit tests give one) instead of
// the person's from the vault on every request
// (every Drive · Calendar · Gmail call ends within GAPI_MS unless the caller gives its own signal — 2nd review #133)
const GAPI_MS = Number(process.env.PRO_GOOGLE_API_MS) || 30000
async function gapi(userId, url, { method = 'GET', body, raw, token, signal = AbortSignal.timeout(GAPI_MS) } = {}) {
  const at = token || await googleAccessToken(userId)
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${at}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    ...(signal ? { signal } : {}),
  })
  if (raw) return res
  const text = await res.text()
  if (!res.ok) {
    const msg = (() => { try { return JSON.parse(text).error?.message } catch { return text.slice(0, 200) } })()
    throw new Error(`Google ${res.status}: ${msg}`)
  }
  return text ? JSON.parse(text) : {}
}

const CAL = () => `${config.google.calendarUrl}/calendars`
const slimEvent = (e) => ({
  id: e.id, summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
  location: e.location, description: e.description?.slice(0, 500), htmlLink: e.htmlLink,
})

export async function calendarList(userId, { timeMin, timeMax, q, calendarId = 'primary', max = 50 }) {
  const p = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) })
  if (timeMin) p.set('timeMin', new Date(timeMin).toISOString())
  if (timeMax) p.set('timeMax', new Date(timeMax).toISOString())
  if (q) p.set('q', q)
  const r = await gapi(userId, `${CAL()}/${encodeURIComponent(calendarId)}/events?${p}`)
  return (r.items || []).map(slimEvent)
}

// all-day when only a date is given; otherwise a timed event in the given time zone (Asia/Seoul unless said)
function when(v, durationMin, timeZone = 'Asia/Seoul') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { start: { date: v }, end: { date: v } }
  const s = new Date(v)
  const e = new Date(s.getTime() + (durationMin || 60) * 60000)
  return { start: { dateTime: s.toISOString(), timeZone }, end: { dateTime: e.toISOString(), timeZone } }
}

export async function calendarCreate(userId, { summary, start, durationMin, description, location, timeZone, calendarId = 'primary' }) {
  const t = when(start, durationMin, timeZone || undefined)
  if (t.end.date) {
    // (the next day by the calendar date itself: a server west of UTC read the local date one day early)
    const d = new Date(`${t.end.date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)
    t.end.date = d.toISOString().slice(0, 10)
  }
  return slimEvent(await gapi(userId, `${CAL()}/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: { summary, description, location, ...t } }))
}

export async function calendarUpdate(userId, { eventId, summary, start, durationMin, description, location, calendarId = 'primary' }) {
  const patch = { ...(summary && { summary }), ...(description && { description }), ...(location && { location }), ...(start && when(start, durationMin)) }
  return slimEvent(await gapi(userId, `${CAL()}/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: 'PATCH', body: patch }))
}

const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
const header = (m, n) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value

function bodyText(part) {
  if (!part) return ''
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8')
  for (const p of part.parts || []) { const t = bodyText(p); if (t) return t }
  if (part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ')
  return ''
}

export async function gmailSearch(userId, { query, max = 10 }) {
  const list = await gapi(userId, `${GM}/messages?maxResults=${max}&q=${encodeURIComponent(query || '')}`)
  const out = []
  for (const { id } of list.messages || []) {
    const m = await gapi(userId, `${GM}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
    out.push({ id, from: header(m, 'from'), subject: header(m, 'subject'), date: header(m, 'date'), snippet: m.snippet })
  }
  return out
}

export async function gmailRead(userId, { id }) {
  const m = await gapi(userId, `${GM}/messages/${id}?format=full`)
  return { id, from: header(m, 'from'), to: header(m, 'to'), subject: header(m, 'subject'), date: header(m, 'date'), text: bodyText(m.payload).slice(0, 12000) }
}

// Draft only — sending stays a human action in Gmail.
export async function gmailDraft(userId, { to, subject, body }) {
  const mime = [`To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', body].join('\r\n')
  const r = await gapi(userId, `${GM}/drafts`, { method: 'POST', body: { message: { raw: Buffer.from(mime).toString('base64url') } } })
  return { draftId: r.id, link: 'https://mail.google.com/mail/#drafts' }
}

// ---------- Drive ----------
// Search looks in My Drive, the files shared with the person and the shared drives they are a member of
// (corpora=allDrives), by name and by contents. Before 2026-11-28 it sent the whole request as one
// `fullText contains '…'` phrase to My Drive only (recording 11-28 20:49): a course's proposal deck whose name held
// three of the four words asked for never matched, shared-drive files never came back, and a found .pptx read as
// '(binary file)'.
const DR = 'https://www.googleapis.com/drive/v3'
const FOLDER = 'application/vnd.google-apps.folder'
const SHORTCUT = 'application/vnd.google-apps.shortcut'
export const DRIVE_SEARCH = { maxWords: 8, maxResults: 30, fetch: 100 }
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,size,owners(displayName),driveId,parents,shortcutDetails(targetId,targetMimeType)'

// a value inside a Drive query's single quotes: backslash and quote escaped
export const driveQuoted = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
// the agent's words as given, split on white space — nothing is read into them. Format only: double quotes go (inside
// a Drive value they would make a phrase), and a token with no letter or digit (a lone dash, "·") is not a word.
export const driveWords = (query) => [...new Set(String(query ?? '').replace(/["\u201C\u201D]/g, ' ').trim().split(/\s+/)
  .filter((w) => /[\p{L}\p{N}]/u.test(w)))].slice(0, DRIVE_SEARCH.maxWords)
// 'all': every word is in the name or the contents; 'any': at least one of them is
export function driveQuery(words, mode = 'all') {
  const terms = words.map((w) => `(name contains ${driveQuoted(w)} or fullText contains ${driveQuoted(w)})`)
  const body = mode === 'all' || terms.length === 1 ? terms.join(' and ') : `(${terms.join(' or ')})`
  return `${body} and trashed = false`
}
// files.list over every drive the person can see (shared drives need all three parameters)
export function driveListUrl(q, pageSize) {
  const p = new URLSearchParams({ q, pageSize: String(pageSize), corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', fields: `incompleteSearch,files(${FILE_FIELDS})` })
  return `${DR}/files?${p}`
}
// How many of the words the name holds, counted the way Drive matches a name: `name contains` matches from the start
// of a word of the name (words split at anything that is not a letter or digit), so 「교육」 is in 「교육과정」 but
// 「과정」 is not, and 「자료를」 is not in 「자료」. (fullText matches whole words of the contents; that is not counted here.)
const nameTokens = (name) => String(name || '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
export const nameHits = (name, words) => {
  const toks = nameTokens(name)
  return words.filter((w) => { const x = w.toLocaleLowerCase(); return toks.some((t) => t.startsWith(x)) }).length
}

// at most `limit` calls at a time
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// the shared drive's name and the parent folder's name, one call per distinct id, five at a time; a failed lookup
// leaves it out. A file at the top of a shared drive has the drive itself as its parent: no folder lookup for it.
export const DRIVE_NAME_LOOKUPS = 5
async function placeNames(userId, files, token) {
  const one = (url) => gapi(userId, url, { token }).then((r) => r?.name || null, () => null)
  const drives = [...new Set(files.map((f) => f.driveId).filter(Boolean))]
  const parents = [...new Set(files.filter((f) => f.parents?.[0] && f.parents[0] !== f.driveId).map((f) => f.parents[0]))]
  const jobs = [...drives.map((id) => ['d', id, `${DR}/drives/${encodeURIComponent(id)}?fields=name`]),
    ...parents.map((id) => ['f', id, `${DR}/files/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`])]
  const names = await mapLimit(jobs, DRIVE_NAME_LOOKUPS, ([, , url]) => one(url))
  const drive = new Map(), folder = new Map()
  jobs.forEach(([kind, id], i) => (kind === 'd' ? drive : folder).set(id, names[i]))
  return { drive, folder }
}

// deps.token: see gapi
// Every word (all_words) and any of the words (any_word) are asked at the same time: a file whose contents hold all of
// them must not hide one that has most of them in its name (11-28: the deck had three of the four words in its name).
// The two lists are merged by id and ordered by words in the name, then files with every word, then Drive's order.
export async function driveSearch(userId, { query, max = 10 } = {}, { token } = {}) {
  const words = driveWords(query)
  if (!words.length) throw new Error(L('찾을 낱말을 주세요.', 'Give the words to search for.'))
  const n = Math.max(1, Math.min(DRIVE_SEARCH.maxResults, Math.trunc(Number(max)) || 10))
  const tok = token || await googleAccessToken(userId)
  // (both lists the same length, so a file deep in the every-word list keeps all_words; a failed any-word list does not sink a search
  // the every-word list answered — 2nd review #133)
  const [all, any] = await Promise.all([
    gapi(userId, driveListUrl(driveQuery(words, 'all'), DRIVE_SEARCH.fetch), { token: tok }),
    words.length > 1 ? gapi(userId, driveListUrl(driveQuery(words, 'any'), DRIVE_SEARCH.fetch), { token: tok }).catch(() => null) : null,
  ])
  const seen = new Map()
  for (const f of all.files || []) seen.set(f.id, { f, every: true })
  for (const f of any?.files || []) if (!seen.has(f.id)) seen.set(f.id, { f, every: false })
  // (a file from the second list whose name alone holds every word has them all: the first list's page just ended before it)
  const ranked = [...seen.values()].map((x, i) => { const hits = nameHits(x.f.name, words); return { ...x, every: x.every || hits === words.length, i, hits } })
    .sort((a, b) => b.hits - a.hits || Number(b.every) - Number(a.every) || a.i - b.i)
  // a few every-word files always make the cut: files with one common word in the name must not push them all out (2nd review #133)
  const keepEvery = Math.min(ranked.filter((x) => x.every).length, Math.max(3, Math.ceil(n / 3)))
  const found = ranked.slice(0, n)
  for (const x of ranked.slice(n).filter((y) => y.every)) {
    if (found.filter((y) => y.every).length >= keepEvery) break
    const out = found.map((y, k) => [y, k]).reverse().find(([y]) => !y.every)
    if (!out) break
    found.splice(out[1], 1)
    found.push(x)
  }
  found.sort((a, b) => b.hits - a.hits || Number(b.every) - Number(a.every) || a.i - b.i)
  const everyCount = found.filter((x) => x.every).length
  // (「no file has every word」 only when the every-word list itself came back empty)
  const match = !found.length ? 'none' : everyCount === found.length ? 'all_words' : (all.files || []).length || everyCount ? 'mixed' : 'any_word'
  const { drive, folder } = await placeNames(userId, found.map((x) => x.f), tok)
  const note = {
    all_words: L('낱말이 모두 이름이나 내용에 있는 파일이에요(내 드라이브 · 공유받은 파일 · 공유 드라이브). 이름에 낱말이 많은 파일이 먼저예요.',
      'Files with every word in the name or the contents (My Drive, shared with me, shared drives). Files with more of the words in the name come first.'),
    mixed: L('낱말이 모두 든 파일(all_words: true)과 일부만 든 파일(all_words: false)이 섞여 있어요. 이름에 낱말이 많은 파일이 먼저예요.',
      'Files with every word (all_words: true) and files with only some of them (all_words: false). Files with more of the words in the name come first.'),
    any_word: L('낱말이 모두 들어 있는 파일은 없어서, 낱말이 하나라도 있는 파일을 보여 줘요. 이름에 낱말이 많은 파일이 먼저예요.',
      'No file has every word, so these have at least one of them. Files with more of the words in the name come first.'),
    none: L('내 드라이브 · 공유받은 파일 · 공유 드라이브의 이름과 내용에서 찾지 못했어요. 조사를 뺀 짧은 낱말, 붙은 말은 나눈 낱말(교육과정 → 교육 과정)로 다시 찾아보세요.',
      'Nothing in the names or contents of My Drive, files shared with me or shared drives. Try again with short base words, and with compound words split apart.'),
  }[match]
  return {
    match, words, note,
    ...(all.incompleteSearch || any?.incompleteSearch ? { incomplete: true } : {}),
    files: found.map(({ f, hits, every }) => ({
      id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink,
      ...(f.size ? { size: Number(f.size) } : {}),
      ...(f.driveId ? { drive: drive.get(f.driveId) || f.driveId } : { owner: f.owners?.[0]?.displayName }),
      ...(folder.get(f.parents?.[0]) ? { folder: folder.get(f.parents[0]) } : {}),
      ...(f.shortcutDetails?.targetId ? { target: f.shortcutDetails.targetId } : {}),
      words_in_name: hits, all_words: every,
    })),
  }
}

// Google's own files are exported as text; Office · PDF · Hangul files are downloaded (up to maxBytes) and their
// text is taken out the way the shared folders' index does (lib/folders/indexer.js extract)
export const DRIVE_READ = { maxBytes: 50 * 1024 * 1024, maxChars: 20000, timeoutMs: 60_000 }
const EXPORT = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }
const MIME_EXT = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/pdf': 'pdf', 'application/haansofthwpx': 'hwpx', 'application/vnd.hancom.hwpx': 'hwpx', 'application/hwp+zip': 'hwpx',
  'text/markdown': 'md', 'text/csv': 'csv', 'text/plain': 'txt',
}
const READABLE = new Set(['pptx', 'docx', 'xlsx', 'pdf', 'hwpx', 'md', 'markdown', 'txt', 'csv'])
const mb = (b) => `${Math.round(b / 1024 / 1024)}MB`

async function driveFail(res) {
  const t = await res.text().catch(() => '')
  const msg = (() => { try { return JSON.parse(t).error?.message } catch { return t.slice(0, 200) } })()
  return new Error(`Drive ${res.status}${msg ? `: ${msg}` : ''}`)
}
// the body up to cap bytes; null when it is bigger (the rest is not read)
async function readCapped(res, cap) {
  if (Number(res.headers.get('content-length') || 0) > cap) { await res.body?.cancel().catch(() => {}); return null }
  const parts = []
  let n = 0
  for await (const c of res.body || []) {
    n += c.byteLength
    if (n > cap) return null
    parts.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength))
  }
  return Buffer.concat(parts, n)
}

export async function driveRead(userId, { fileId } = {}, { token } = {}) {
  const tok = token || await googleAccessToken(userId)
  const metaOf = (id) => gapi(userId, `${DR}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, { token: tok })
  let meta = await metaOf(fileId)
  if (meta.mimeType === SHORTCUT && meta.shortcutDetails?.targetId) meta = await metaOf(meta.shortcutDetails.targetId)
  const base = { id: meta.id, name: meta.name, mimeType: meta.mimeType, modifiedTime: meta.modifiedTime, webViewLink: meta.webViewLink }
  const size = Number(meta.size || 0)
  const out = (text, extra = {}, ext = '') => {
    const t = String(text || '')
    if (!t.trim()) return { ...base, ...extra, text: '', no_text: true, note: ext === 'pdf'
      ? L('이 PDF 에서는 글을 찾지 못했어요. 스캔한 PDF 이거나, 이 설치에 PDF 글 꺼내기 도구(poppler 의 pdftotext)가 없을 수 있어요.',
        'No text was found in this PDF. It may be a scanned PDF, or this install may not have the PDF text tool (poppler\'s pdftotext).')
      : L('이 파일에서는 글을 찾지 못했어요(그림으로만 된 슬라이드일 수 있어요).', 'No text was found in this file (it may be image-only slides).') }
    const cut = t.length > DRIVE_READ.maxChars
    return { ...base, ...extra, text: t.slice(0, DRIVE_READ.maxChars),
      ...(cut ? { truncated: true, chars: t.length, note: L(`앞의 ${DRIVE_READ.maxChars}자만 실었어요(전체 ${t.length}자).`, `Only the first ${DRIVE_READ.maxChars} characters are here (of ${t.length}).`) } : {}) }
  }
  const tooBig = () => ({ ...base, ...(size ? { size } : {}), text: '', too_big: true,
    note: L(`파일이 너무 커서 읽지 않았어요(${size ? mb(size) : `${mb(DRIVE_READ.maxBytes)} 넘음`}, 최대 ${mb(DRIVE_READ.maxBytes)}). Drive 에서 직접 열어 보세요: ${meta.webViewLink || ''}`,
      `The file is too large to read (${size ? mb(size) : `over ${mb(DRIVE_READ.maxBytes)}`}; the limit is ${mb(DRIVE_READ.maxBytes)}). Open it in Drive: ${meta.webViewLink || ''}`) })

  if (meta.mimeType === FOLDER) return { ...base, text: '', note: L('폴더예요 — 안의 파일은 drive_search 로 찾아 읽으세요.', 'This is a folder: find the files in it with drive_search.') }
  // a download that has not finished in timeoutMs is cut off (the stream errors with a TimeoutError)
  const signal = AbortSignal.timeout(DRIVE_READ.timeoutMs)
  const slow = (e) => {
    if (e?.name !== 'TimeoutError' && e?.name !== 'AbortError') throw e
    throw new Error(L(`Drive 에서 파일을 ${Math.round(DRIVE_READ.timeoutMs / 1000)}초 안에 받지 못했어요. 잠시 뒤 다시 읽어 보세요: ${meta.webViewLink || ''}`,
      `Drive did not send the file within ${Math.round(DRIVE_READ.timeoutMs / 1000)} seconds. Try reading it again later: ${meta.webViewLink || ''}`))
  }
  const exportAs = EXPORT[meta.mimeType]
  if (exportAs) {
    const text = await (async () => {
      const res = await gapi(userId, `${DR}/files/${encodeURIComponent(meta.id)}/export?mimeType=${encodeURIComponent(exportAs)}`, { raw: true, token: tok, signal })
      if (!res.ok) throw await driveFail(res)
      return res.text()
    })().catch(slow)
    return out(text)
  }
  const { extract, kindOf } = await import('./folders/indexer.js')
  const ext = READABLE.has(kindOf(meta.name)) ? kindOf(meta.name) : MIME_EXT[meta.mimeType] || (/^text\/|json$/.test(meta.mimeType || '') ? 'txt' : null)
  if (!ext) return { ...base, text: '', no_text: true, note: L(`이 형식(${meta.mimeType})의 파일에서는 글을 읽을 수 없어요. 읽을 수 있는 것: Google 문서 · 시트 · 슬라이드, PowerPoint · Word · Excel(.pptx · .docx · .xlsx), PDF, 한글(.hwpx), 글 파일.`,
    `Text can't be read from this kind of file (${meta.mimeType}). Readable: Google Docs, Sheets and Slides, PowerPoint, Word and Excel (.pptx, .docx, .xlsx), PDF, Hangul (.hwpx) and text files.`) }
  if (size > DRIVE_READ.maxBytes) return tooBig()
  const buf = await (async () => {
    const res = await gapi(userId, `${DR}/files/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`, { raw: true, token: tok, signal })
    if (!res.ok) throw await driveFail(res)
    return readCapped(res, DRIVE_READ.maxBytes)
  })().catch(slow)
  if (!buf) return tooBig()
  const { text, pages } = await extract(`file.${ext}`, buf)
  return out(text, ext === 'pptx' || ext === 'pdf' ? { pages } : {}, ext)
}
