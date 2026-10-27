// A file the agent made: its badge and how it opens — shared by the chat card (Message.vue) and the
// conversation's artifact stack (ArtifactStack.vue), so both open it the same way.
import { officeEditorFor, craftMissing } from './officeEditor.js'
import { api } from './api.js'

export const kindOf = (n) => ({ hwp: 'hwp', hwpx: 'hwp', docx: 'doc', odt: 'doc', xlsx: 'xls', xls: 'xls', csv: 'xls', pptx: 'ppt', pdf: 'pdf', dxf: 'cad', dwg: 'cad', svg: 'vec', vectorcraft: 'vec', psd: 'img', psb: 'img', pcraft: 'img', png: 'img', jpg: 'img', jpeg: 'img', webp: 'img', wav: 'snd', mp3: 'snd', flac: 'snd', ogg: 'snd', soundcraft: 'snd', scraftz: 'snd', mp4: 'vid', mov: 'vid', webm: 'vid', fcproj: 'vid' })[String(n || '').split('.').pop().toLowerCase()] || 'etc'
export const kindLabel = { hwp: '한글', doc: 'DOC', xls: 'XLS', ppt: 'PPT', pdf: 'PDF', cad: 'CAD', vec: 'SVG', img: 'IMG', snd: 'AUD', vid: 'VID' }

// a file the agent left in its conversation folder opens in that folder's workroom
const room = (p) => /^\/workspace\/\.bpmn\/([^/]+)\/(.+)$/.exec(p || '')

// a file elsewhere in the workspace (/workspace/메모.txt) has no workroom: the server publishes a copy
const loose = (p) => /^\/workspace\//.test(p || '') && !room(p)
// what the card says it does
export const openHint = (c) => (c.url ? '열기' : loose(c.path) ? '눌러서 열기' : '작업실에서 열기')

// a document opens in the editor in place; anything else opens its URL
export async function openArtifact(app, router, msg) {
  let c = msg.content || {}
  if (!c.url && loose(c.path) && msg.id) {
    try { c = await api(`/messages/${encodeURIComponent(msg.id)}/open-file`, { method: 'POST' }) } catch (e) { window.alert(`파일을 열지 못했어요. ${e.message}`); return }
  }
  const ed = officeEditorFor(c.name)
  if (c.url && ed && !craftMissing(ed)) app.officeDoc = { msgId: msg.id, url: c.url, name: c.name }
  else if (c.url) window.open(c.url, '_blank', 'noopener')
  else if (room(c.path)) router.push({ path: `/workroom/chat/${room(c.path)[1]}`, query: { open: room(c.path)[2] } })
}
