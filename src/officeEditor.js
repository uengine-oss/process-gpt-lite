// IeumOffice web editor (process-gpt office-host), ported from process-gpt-vue3
// src/utils/officeEditor.js. The host is proxied at /office on this origin (vite.config.js), so the
// editor page, its __ipc socket and document bytes all come from here.
import { auth } from './api.js'
import { BASE } from './base.js'

const EDITOR_BY_EXT = {
  docx: 'docs', odt: 'docs', xlsx: 'sheets', xlsm: 'sheets', xls: 'sheets', csv: 'sheets', pptx: 'slides',
  pdf: 'pdf', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', xmind: 'mindmap', hwp: 'hwp', hwpx: 'hwp',
  // ArtCraft web apps, not IeumOffice (CraftEditorFrame.vue)
  dxf: 'cadcraft', dwg: 'cadcraft',
  svg: 'vectorcraft', vectorcraft: 'vectorcraft',
  psd: 'photocraft', psb: 'photocraft', pcraft: 'photocraft', photocraft: 'photocraft', png: 'photocraft', jpg: 'photocraft', jpeg: 'photocraft', webp: 'photocraft',
  wav: 'soundcraft', mp3: 'soundcraft', flac: 'soundcraft', ogg: 'soundcraft', soundcraft: 'soundcraft', scraftz: 'soundcraft',
  mp4: 'filmcraft', mov: 'filmcraft', webm: 'filmcraft', fcproj: 'filmcraft', filmcraft: 'filmcraft',
}
export const CRAFT_APPS = new Set(['cadcraft', 'vectorcraft', 'photocraft', 'soundcraft', 'filmcraft'])
// which ArtCraft web apps this install serves (/api/config craft; the Docker lite profile has none):
// a file whose app is missing opens as a plain link. Unknown yet = assume it is there.
let craftHave = null
if (typeof fetch === 'function') fetch(BASE + '/api/config').then((r) => (r.ok ? r.json() : null)).then((c) => { if (c?.craft) craftHave = c.craft }).catch(() => {})
export const craftMissing = (editor) => !!craftHave && CRAFT_APPS.has(editor) && craftHave[editor]?.web === false

function extOf(nameOrUrl) {
  const clean = String(nameOrUrl || '').split('?')[0].split('#')[0]
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

/** the editor for this file name (or URL); null when it cannot be edited */
export function officeEditorFor(nameOrUrl) { return EDITOR_BY_EXT[extOf(nameOrUrl)] || null }

/** editor iframe address; the host checks the login token when the editor connects */
// assistant: 'parent' — the editor's own AI dock stays hidden and its AI buttons ask this page (one
// assistant: pgpt's chat edits the open document through office_live_*)
export function officeEditorUrl({ fileUrl, name, readOnly = false, assistant = '', token = auth.get()?.session?.access_token }) {
  const editor = officeEditorFor(name || fileUrl)
  if (!editor || CRAFT_APPS.has(editor) || !/^https?:\/\//i.test(fileUrl || '')) return ''
  const params = new URLSearchParams({ src: fileUrl })
  if (name) params.set('name', name)
  if (readOnly) params.set('readonly', '1')
  if (assistant && !readOnly) params.set('assistant', assistant)
  if (token) params.set('token', token)
  return `${BASE}/office/${editor}/?${params.toString()}`
}

/** a message from the editor iframe */
export function isOfficeEditorMessage(event, frameWindow) {
  return !!frameWindow && event.source === frameWindow && event.data?.source === 'ieum-office'
}
