// IeumOffice web editor (process-gpt office-host), ported from process-gpt-vue3
// src/utils/officeEditor.js. The host is proxied at /office on this origin (vite.config.js), so the
// editor page, its __ipc socket and document bytes all come from here.
import { auth } from './api.js'
import { BASE } from './base.js'

// which editor a file opens in: src/editorKinds.js (no browser state there, so it is tested without one)
import { CRAFT_APPS, officeEditorFor } from './editorKinds.js'
export { CRAFT_APPS, officeEditorFor }
// which ArtCraft web apps this install serves (/api/config craft; the Docker lite profile has none):
// a file whose app is missing opens as a plain link. Unknown yet = assume it is there.
let craftHave = null
if (typeof fetch === 'function') fetch(BASE + '/api/config').then((r) => (r.ok ? r.json() : null)).then((c) => { if (c?.craft) craftHave = c.craft }).catch(() => {})
export const craftMissing = (editor) => !!craftHave && CRAFT_APPS.has(editor) && craftHave[editor]?.web === false

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
  // English screens ask for English; the office host uses one language per process (IEUM_LANG) and ignores this
  // today — kept so a host that reads it opens the editor in the same language (i18n/HANDOFF.md)
  if (document.documentElement.lang === 'en') params.set('lang', 'en')
  return `${BASE}/office/${editor}/?${params.toString()}`
}

/** a message from the editor iframe */
export function isOfficeEditorMessage(event, frameWindow) {
  return !!frameWindow && event.source === frameWindow && event.data?.source === 'ieum-office'
}
