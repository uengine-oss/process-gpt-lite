// A step's output kept in the tenant's Google Drive — process-gpt saves deliverables there
// (docs.google.com/document/d/<id>/edit?…, drive.google.com/file/d/<id>/view) — opened in the app's own
// viewer, read-only (2026-11-18: "구글 드라이브에 원본이 들어있다 하더라도 기본적으로는 이음오피스로 열어서
// 보여주는 게 맞겠지" — on a phone the link handed the file to the Drive app).
// The file is fetched with the tenant's Google connection (process-gpt's tenant_oauth: the account that
// saved it), only when it is an output of an instance the person may see, and published to storage once
// per file version (the key carries Drive's modifiedTime).
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, admin } from './supa.js'
import { canSeeInstance } from './processes.js'
import { L } from './lang.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const MAX = 50 * 1024 * 1024

// the Drive file id in a Docs / Sheets / Slides / Drive link
export function driveIdOf(url) {
  const u = String(url || '')
  if (!/^https:\/\/(docs|drive)\.google\.com\//.test(u)) return null
  return /\/d\/([A-Za-z0-9_-]{20,})/.exec(u)?.[1] || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(u)?.[1] || null
}

// Google-native files are exported to the Office format the viewer opens
const EXPORT = {
  'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
}
const EXT = { 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx' }

// process-gpt's stored credentials: JSON, sometimes JSON inside a JSON string
export function parseCredentials(raw) {
  let c = raw
  for (let i = 0; i < 3 && typeof c === 'string'; i++) { try { c = JSON.parse(c) } catch { return null } }
  return c && typeof c === 'object' ? c : null
}

const tokens = new Map() // tenant -> {token, until}
async function accessToken() {
  const hit = tokens.get(T())
  if (hit && hit.until > Date.now()) return hit.token
  const [r] = await q(`select client_id, client_secret, google_credentials from tenant_oauth where tenant_id=$1 and provider='google' limit 1`, [T()])
  const c = parseCredentials(r?.google_credentials)
  if (!c?.refresh_token) throw err(404, L('회사 Google Drive 연결이 없어 이 산출물을 열 수 없어요.', "There is no company Google Drive connection to open this output."))
  const res = await fetch(c.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ client_id: c.client_id || r.client_id, client_secret: c.client_secret || r.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }),
  })
  const j = await res.json().catch(() => ({}))
  if (!j.access_token) throw err(502, L('회사 Google Drive 연결이 만료됐어요. ProcessGPT 설정에서 Google Drive 를 다시 연결해 주세요.', "The company's Google Drive connection has expired. Reconnect Google Drive in ProcessGPT settings."))
  tokens.set(T(), { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 })
  return j.access_token
}

// an output of an instance the person may see (todolist.output carries the link)
async function mayOpen(me, id) {
  const rows = await q(`select distinct proc_inst_id from todolist where tenant_id=$1 and proc_inst_id is not null
                        and (output::text like $2 or coalesce(output_url, '') like $2) limit 20`, [T(), `%${id}%`])
  for (const r of rows) if (await canSeeInstance(r.proc_inst_id, me)) return true
  return false
}

export async function openDriveOutput(me, url) {
  const id = driveIdOf(url)
  if (!id) throw err(400, L('Google Drive 링크가 아니에요.', 'This is not a Google Drive link.'))
  if (!(await mayOpen(me, id))) throw err(403, L('이 산출물을 볼 권한이 없어요.', "You don't have access to this output."))
  const token = await accessToken()
  const H = { Authorization: `Bearer ${token}` }
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,modifiedTime,size&supportsAllDrives=true`, { headers: H, signal: AbortSignal.timeout(10000) })
  if (!metaRes.ok) throw err(metaRes.status === 404 ? 404 : 502, L('Google Drive 에서 이 파일을 찾지 못했어요.', "Google Drive couldn't find this file."))
  const meta = await metaRes.json()
  const exp = EXPORT[meta.mimeType]
  const ext = exp ? exp[1] : (EXT[meta.mimeType] || String(meta.name || '').split('.').pop().toLowerCase() || 'bin')
  const base = String(meta.name || 'output').replace(/[\\/]/g, '_')
  const name = base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`
  const key = `pgpt-pro/drive/${T()}/${id}-${crypto.createHash('sha1').update(String(meta.modifiedTime || '')).digest('hex').slice(0, 10)}.${ext}`
  const publicUrl = `${config.supabaseUrl}/storage/v1/object/public/files/${key}`
  // already published for this version
  const head = await fetch(publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) }).catch(() => null)
  if (head?.ok) return { name, url: publicUrl, readOnly: true, source: 'drive' }
  if (Number(meta.size || 0) > MAX) throw err(413, L('50MB 보다 큰 파일은 여기서 열 수 없어요.', "Files over 50 MB can't be opened here."))
  const dl = await fetch(exp ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exp[0])}`
    : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: H, signal: AbortSignal.timeout(60000) })
  if (!dl.ok) throw err(502, L('Google Drive 에서 파일을 받지 못했어요.', "Couldn't download the file from Google Drive."))
  const buf = Buffer.from(await dl.arrayBuffer())
  if (buf.length > MAX) throw err(413, L('50MB 보다 큰 파일은 여기서 열 수 없어요.', "Files over 50 MB can't be opened here."))
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: exp?.[0] || meta.mimeType || 'application/octet-stream', upsert: true })
  if (error) throw err(502, error.message)
  return { name, url: publicUrl, readOnly: true, source: 'drive' }
}
