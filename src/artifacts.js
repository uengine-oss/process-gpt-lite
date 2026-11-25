// A file the agent made: its badge and how it opens — shared by the chat card (Message.vue) and the
// conversation's artifact stack (ArtifactStack.vue), so both open it the same way.
import { officeEditorFor, craftMissing } from './officeEditor.js'
import { api } from './api.js'
import { officeDocOf } from './stores/app.js'
// the decision itself, without a browser (src/openPlan.js)
import { openPlan, isDrive, loose } from './openPlan.js'
import { mediaKindOf } from './mediaKind.js'
export { isDrive, mediaKindOf }

export const kindOf = (n) => ({ hwp: 'hwp', hwpx: 'hwp', docx: 'doc', odt: 'doc', xlsx: 'xls', xlsm: 'xls', xls: 'xls', csv: 'xls', pptx: 'ppt', pdf: 'pdf', md: 'md', markdown: 'md', txt: 'txt', html: 'web', htm: 'web', xmind: 'map', dxf: 'cad', dwg: 'cad', svg: 'vec', vectorcraft: 'vec', psd: 'img', psb: 'img', pcraft: 'img', png: 'img', jpg: 'img', jpeg: 'img', webp: 'img', gif: 'img', avif: 'img', bmp: 'img', wav: 'snd', mp3: 'snd', m4a: 'snd', aac: 'snd', opus: 'snd', oga: 'snd', flac: 'snd', ogg: 'snd', weba: 'snd', soundcraft: 'snd', scraftz: 'snd', mp4: 'vid', m4v: 'vid', mov: 'vid', webm: 'vid', fcproj: 'vid' })[String(n || '').split('.').pop().toLowerCase()] || 'etc'
// the badge of a file card {name, type}: by its name, else (a site's 「download」 stored as audio/mp4) by what it plays as
const MEDIA_KIND = { image: 'img', audio: 'snd', video: 'vid' }
export const cardKind = (c) => { const k = kindOf(c?.name); return k !== 'etc' ? k : MEDIA_KIND[mediaKindOf(c)] || 'etc' }
export const kindLabel = { hwp: '한글', doc: 'DOC', xls: 'XLS', ppt: 'PPT', pdf: 'PDF', md: 'MD', txt: 'TXT', web: 'HTML', map: 'MAP', cad: 'CAD', vec: 'SVG', img: 'IMG', snd: 'AUD', vid: 'VID' }

// what the card says it does
// (a private card — a mail's attachment, its edit: server lib/mailAttachments.js — has no address: it is opened by a signed one)
export const openHint = (c) => (c.url ? '열기' : c.private ? (c.edited ? '편집본 · 나만 볼 수 있어요' : '나만 볼 수 있어요') : loose(c.path) ? '눌러서 열기' : '작업실에서 열기')
// a picture or a video is looked at, a sound listened to — not edited (src/openPlan.js 'view')
export const viewHint = (media, c) => `${c?.edited ? '편집본 · ' : ''}${media === 'audio' ? '눌러서 열기' : '눌러서 크게 보기'}`

// The viewer of a picture · sound · video (MediaViewer.vue, App.vue): {kind, url, name, editWith, edit}. edit — the person's
// 「… 로 편집」, given only where this install has the ArtCraft app for it (editWith).
export function viewMedia(app, { kind, url, name, editWith = '', edit = null }) {
  app.media = { kind, url, name: name || decodeURIComponent(String(url || '').split('?')[0].split('/').pop() || ''), editWith: edit ? editWith : '', edit: editWith ? edit : null }
  return true
}

// A step's output or a form's file (instance page, FormCard) is looked at inside the app, read-only: a
// link to a .docx/.hwpx in a new tab makes a phone download it and hand it to another app (Android:
// Google Docs, which asks for an account). inApp false: no viewer here, the caller offers a download.
// A Google Drive / Docs link (process-gpt keeps step outputs there) opens in the same viewer: the server
// fetches it with the company's Drive connection and publishes a copy (server/lib/driveOutputs.js) —
// before, a phone handed it to the Drive app (2026-11-18).
// A picture, a sound or a video opens in the viewer (read-only here: no 「편집」).
export const inApp = (f) => { if (isDrive(f?.url)) return true; if (f?.url && mediaKindOf(f)) return true; const ed = officeEditorFor(f?.name || f?.url); return !!(f?.url && ed && !craftMissing(ed)) }
export async function openDrive(app, url, fallbackName) {
  try {
    const d = await api('/outputs/drive', { method: 'POST', body: { url } })
    app.setOfficeDoc({ url: d.url, name: d.name || fallbackName, readOnly: true })
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
  const media = mediaKindOf(f)
  if (media) return viewMedia(app, { kind: media, url: f.url, name: f.name })
  app.setOfficeDoc({ url: f.url, name: f.name || decodeURIComponent(f.url.split('?')[0].split('/').pop()), readOnly: true })
  return true
}

// A document opens in the office panel in place; a picture, a sound or a video in the viewer (its ArtCraft app only from the
// viewer's 「… 로 편집」); anything else opens its URL. Answers what happened — {how, opened, reason}:
// the messenger shows the reason beside the file when it did not open, and keeps itself open when it is docked (openPlan.js).
// link: false — do not open a link by itself (after a wait the browser may block the window without a word): the caller
// shows the reason with a link the person clicks. edit: the person asked to edit it (opens the ArtCraft app of a picture…).
export async function openArtifact(app, router, msg, { link = true, edit = false } = {}) {
  let c = msg.content || {}
  let plan = openPlan(c, { craftMissing, edit })
  if (plan.how === 'fetch' && msg.id) {
    try { c = await api(`/messages/${encodeURIComponent(msg.id)}/open-file`, { method: 'POST' }) } catch (e) {
      const reason = `파일을 열지 못했어요. ${e.message}`
      if (link) window.alert(reason)
      return { how: 'none', opened: false, reason }
    }
    plan = openPlan(c, { craftMissing, edit })
  }
  if (plan.how === 'view') {
    const card = { ...msg, content: c }
    viewMedia(app, { kind: plan.media, url: plan.url, name: c.name, editWith: plan.editWith, edit: () => openArtifact(app, router, card, { link, edit: true }) })
    return { ...plan, opened: true }
  }
  if (plan.how === 'drive') return { ...plan, opened: await openDrive(app, c.url, c.name) }
  if (plan.how === 'office') {
    // false: the open document could not be saved yet and stays (its sheet says so; a second try replaces it)
    const opened = await app.setOfficeDoc(officeDocOf(msg.id, c))
    return { ...plan, opened: opened !== false, reason: opened === false ? '열린 문서를 아직 저장하지 못해 그대로 두었어요. 한 번 더 누르면 바꿔요.' : '' }
  }
  if (plan.how === 'link') {
    if (link) window.open(plan.url, '_blank', 'noopener')
    return { ...plan, opened: link }
  }
  if (plan.how === 'workroom') {
    await router.push({ path: `/workroom/chat/${plan.room}`, query: { open: plan.file } })
    return { ...plan, opened: true }
  }
  return { ...plan, opened: false }
}
