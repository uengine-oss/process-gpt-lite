// A file the agent made: its badge and how it opens — shared by the chat card (Message.vue) and the
// conversation's artifact stack (ArtifactStack.vue), so both open it the same way.
import { officeEditorFor, craftMissing } from './officeEditor.js'
import { api } from './api.js'

export const kindOf = (n) => ({ hwp: 'hwp', hwpx: 'hwp', docx: 'doc', odt: 'doc', xlsx: 'xls', xlsm: 'xls', xls: 'xls', csv: 'xls', pptx: 'ppt', pdf: 'pdf', md: 'md', markdown: 'md', txt: 'txt', html: 'web', htm: 'web', xmind: 'map', dxf: 'cad', dwg: 'cad', svg: 'vec', vectorcraft: 'vec', psd: 'img', psb: 'img', pcraft: 'img', png: 'img', jpg: 'img', jpeg: 'img', webp: 'img', wav: 'snd', mp3: 'snd', flac: 'snd', ogg: 'snd', soundcraft: 'snd', scraftz: 'snd', mp4: 'vid', mov: 'vid', webm: 'vid', fcproj: 'vid' })[String(n || '').split('.').pop().toLowerCase()] || 'etc'
export const kindLabel = { hwp: '한글', doc: 'DOC', xls: 'XLS', ppt: 'PPT', pdf: 'PDF', md: 'MD', txt: 'TXT', web: 'HTML', map: 'MAP', cad: 'CAD', vec: 'SVG', img: 'IMG', snd: 'AUD', vid: 'VID' }

// a file the agent left in its conversation folder opens in that folder's workroom
const room = (p) => /^\/workspace\/\.bpmn\/([^/]+)\/(.+)$/.exec(p || '')

// a file elsewhere in the workspace (/workspace/메모.txt) has no workroom: the server publishes a copy
const loose = (p) => /^\/workspace\//.test(p || '') && !room(p)
// what the card says it does
export const openHint = (c) => (c.url ? '열기' : loose(c.path) ? '눌러서 열기' : '작업실에서 열기')

// A step's output or a form's file (instance page, FormCard) is looked at inside the app, read-only: a
// link to a .docx/.hwpx in a new tab makes a phone download it and hand it to another app (Android:
// Google Docs, which asks for an account). inApp false: no viewer here, the caller offers a download.
// A Google Drive / Docs link (process-gpt keeps step outputs there) opens in the same viewer: the server
// fetches it with the company's Drive connection and publishes a copy (server/lib/driveOutputs.js) —
// before, a phone handed it to the Drive app (2026-11-18).
export const isDrive = (url) => /^https:\/\/(docs|drive)\.google\.com\/.*(\/d\/|[?&]id=)[A-Za-z0-9_-]{20,}/.test(String(url || ''))
export const inApp = (f) => { if (isDrive(f?.url)) return true; const ed = officeEditorFor(f?.name || f?.url); return !!(f?.url && ed && !craftMissing(ed)) }
export async function openDrive(app, url, fallbackName) {
  try {
    const d = await api('/outputs/drive', { method: 'POST', body: { url } })
    app.officeDoc = { url: d.url, name: d.name || fallbackName, readOnly: true }
    return true
  } catch (e) {
    // no company connection or no access: the link itself, as before (said first)
    if (window.confirm(`앱 안에서 열지 못했어요 (${e.message}). Google Drive 에서 열까요?`)) window.open(url, '_blank', 'noopener')
    return false
  }
}
export function openOutput(app, f) {
  if (!inApp(f)) return false
  if (isDrive(f.url)) { openDrive(app, f.url, f.name); return true }
  app.officeDoc = { url: f.url, name: f.name || decodeURIComponent(f.url.split('?')[0].split('/').pop()), readOnly: true }
  return true
}

// a document opens in the editor in place; anything else opens its URL
export async function openArtifact(app, router, msg) {
  let c = msg.content || {}
  if (!c.url && loose(c.path) && msg.id) {
    try { c = await api(`/messages/${encodeURIComponent(msg.id)}/open-file`, { method: 'POST' }) } catch (e) { window.alert(`파일을 열지 못했어요. ${e.message}`); return }
  }
  const ed = officeEditorFor(c.name)
  if (isDrive(c.url)) return openDrive(app, c.url, c.name)
  if (c.url && ed && !craftMissing(ed)) app.officeDoc = { msgId: msg.id, url: c.url, name: c.name }
  else if (c.url) window.open(c.url, '_blank', 'noopener')
  else if (room(c.path)) router.push({ path: `/workroom/chat/${room(c.path)[1]}`, query: { open: room(c.path)[2] } })
}
