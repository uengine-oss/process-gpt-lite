// How a file card opens — decided here without a browser, carried out by artifacts.js openArtifact (and tested in
// server/test/openPlan.test.js). A document opens in the app's own office panel (IeumOffice, or an ArtCraft app);
// what has no viewer here is a link the person opens themselves; nothing ever happens without a word.
//   drive    — a Google Drive / Docs link: the server fetches a copy with the company's connection, then the panel
//   fetch    — a file the agent left loose in its workspace: the server publishes a copy first, then decide again
//   office   — the panel, with `editor`
//   workroom — a file in a conversation's work folder: that workroom with the file open
//   link     — no viewer here (or its ArtCraft app is not installed): the URL, with `reason`
//   none     — nothing to open (`reason`)
import { officeEditorFor, CRAFT_NAMES } from './editorKinds.js'

export const isDrive = (url) => /^https:\/\/(docs|drive)\.google\.com\/.*(\/d\/|[?&]id=)[A-Za-z0-9_-]{20,}/.test(String(url || ''))
// a file the agent left in its conversation folder opens in that folder's workroom
export const roomOf = (p) => /^\/workspace\/\.bpmn\/([^/]+)\/(.+)$/.exec(p || '')
// a file elsewhere in the workspace (/workspace/메모.txt) has no workroom: the server publishes a copy
export const loose = (p) => /^\/workspace\//.test(p || '') && !roomOf(p)

// c: a file card's content {name, url, path}; craftMissing(editor): that ArtCraft app is not served by this install
export function openPlan(c, { craftMissing = () => false } = {}) {
  const f = c || {}
  if (isDrive(f.url)) return { how: 'drive' }
  if (!f.url && loose(f.path)) return { how: 'fetch' }
  const editor = officeEditorFor(f.name || f.url)
  if (f.url && editor && !craftMissing(editor)) return { how: 'office', editor }
  if (f.url) {
    return { how: 'link', url: f.url, reason: editor ? `이 설치에는 ${CRAFT_NAMES[editor] || editor} 앱이 없어 앱 안에서 열 수 없어요.` : '앱 안에서 열 수 없는 형식이에요.' }
  }
  const r = roomOf(f.path)
  if (r) return { how: 'workroom', room: r[1], file: r[2] }
  return { how: 'none', reason: '열 파일을 찾지 못했어요.' }
}

// Whether opening a file from the messenger puts the messenger away: only the floating sheet does (it lies over the place the
// document opens). A docked messenger stays where it is, so the conversation goes on beside the document.
export const closesMessenger = (plan, dock) => dock === 'float' && ['office', 'drive', 'workroom'].includes(plan?.how)
