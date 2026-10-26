// A file the agent made: its badge and how it opens — shared by the chat card (Message.vue) and the
// conversation's artifact stack (ArtifactStack.vue), so both open it the same way.
import { officeEditorFor, craftMissing } from './officeEditor.js'

export const kindOf = (n) => ({ hwp: 'hwp', hwpx: 'hwp', docx: 'doc', odt: 'doc', xlsx: 'xls', xls: 'xls', csv: 'xls', pptx: 'ppt', pdf: 'pdf', dxf: 'cad', dwg: 'cad', svg: 'vec', vectorcraft: 'vec', psd: 'img', psb: 'img', pcraft: 'img', png: 'img', jpg: 'img', jpeg: 'img', webp: 'img', wav: 'snd', mp3: 'snd', flac: 'snd', ogg: 'snd', soundcraft: 'snd', scraftz: 'snd', mp4: 'vid', mov: 'vid', webm: 'vid', fcproj: 'vid' })[String(n || '').split('.').pop().toLowerCase()] || 'etc'
export const kindLabel = { hwp: '한글', doc: 'DOC', xls: 'XLS', ppt: 'PPT', pdf: 'PDF', cad: 'CAD', vec: 'SVG', img: 'IMG', snd: 'AUD', vid: 'VID' }

// a file the agent left in its conversation folder opens in that folder's workroom
const room = (p) => /^\/workspace\/\.bpmn\/([^/]+)\/(.+)$/.exec(p || '')

// a document opens in the editor in place; anything else opens its URL
export function openArtifact(app, router, msg) {
  const c = msg.content || {}
  const ed = officeEditorFor(c.name)
  if (c.url && ed && !craftMissing(ed)) app.officeDoc = { msgId: msg.id, url: c.url, name: c.name }
  else if (c.url) window.open(c.url, '_blank', 'noopener')
  else if (room(c.path)) router.push({ path: `/workroom/chat/${room(c.path)[1]}`, query: { open: room(c.path)[2] } })
}
