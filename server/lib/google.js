// Google Calendar / Gmail / Drive calls made with the user's own OAuth token from the vault.
import { googleAccessToken } from './mail.js'

async function gapi(userId, url, { method = 'GET', body, raw } = {}) {
  const at = await googleAccessToken(userId)
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${at}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (raw) return res
  const text = await res.text()
  if (!res.ok) {
    const msg = (() => { try { return JSON.parse(text).error?.message } catch { return text.slice(0, 200) } })()
    throw new Error(`Google ${res.status}: ${msg}`)
  }
  return text ? JSON.parse(text) : {}
}

const CAL = 'https://www.googleapis.com/calendar/v3/calendars'
const slimEvent = (e) => ({
  id: e.id, summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
  location: e.location, description: e.description?.slice(0, 500), htmlLink: e.htmlLink,
})

export async function calendarList(userId, { timeMin, timeMax, q, calendarId = 'primary', max = 50 }) {
  const p = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) })
  if (timeMin) p.set('timeMin', new Date(timeMin).toISOString())
  if (timeMax) p.set('timeMax', new Date(timeMax).toISOString())
  if (q) p.set('q', q)
  const r = await gapi(userId, `${CAL}/${encodeURIComponent(calendarId)}/events?${p}`)
  return (r.items || []).map(slimEvent)
}

// all-day when only a date is given; otherwise a timed event in Asia/Seoul
function when(v, durationMin) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { start: { date: v }, end: { date: v } }
  const s = new Date(v)
  const e = new Date(s.getTime() + (durationMin || 60) * 60000)
  return { start: { dateTime: s.toISOString(), timeZone: 'Asia/Seoul' }, end: { dateTime: e.toISOString(), timeZone: 'Asia/Seoul' } }
}

export async function calendarCreate(userId, { summary, start, durationMin, description, location, calendarId = 'primary' }) {
  const t = when(start, durationMin)
  if (t.end.date) {
    const d = new Date(t.end.date); d.setDate(d.getDate() + 1)
    t.end.date = d.toISOString().slice(0, 10)
  }
  return slimEvent(await gapi(userId, `${CAL}/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: { summary, description, location, ...t } }))
}

export async function calendarUpdate(userId, { eventId, summary, start, durationMin, description, location, calendarId = 'primary' }) {
  const patch = { ...(summary && { summary }), ...(description && { description }), ...(location && { location }), ...(start && when(start, durationMin)) }
  return slimEvent(await gapi(userId, `${CAL}/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: 'PATCH', body: patch }))
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

const DR = 'https://www.googleapis.com/drive/v3/files'
export async function driveSearch(userId, { query, max = 10 }) {
  const qq = `fullText contains '${String(query).replace(/'/g, "\\'")}' and trashed = false`
  const r = await gapi(userId, `${DR}?pageSize=${max}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${encodeURIComponent(qq)}`)
  return r.files || []
}

export async function driveRead(userId, { fileId }) {
  const meta = await gapi(userId, `${DR}/${fileId}?fields=id,name,mimeType`)
  const exportAs = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }[meta.mimeType]
  const url = exportAs ? `${DR}/${fileId}/export?mimeType=${encodeURIComponent(exportAs)}` : `${DR}/${fileId}?alt=media`
  const res = await gapi(userId, url, { raw: true })
  if (!res.ok) throw new Error(`Drive ${res.status}`)
  const text = /^text|json|csv/.test(res.headers.get('content-type') || '') || exportAs ? await res.text() : '(binary file)'
  return { ...meta, text: text.slice(0, 20000) }
}
