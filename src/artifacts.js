// A file the agent made: its badge and how it opens — shared by the chat card (Message.vue) and the
// conversation's artifact stack (ArtifactStack.vue), so both open it the same way.
import { officeEditorFor, craftMissing } from './officeEditor.js'
import { api } from './api.js'
import { officeDocOf } from './stores/app.js'
// the decision itself, without a browser (src/openPlan.js)
import { openPlan, isDrive, loose } from './openPlan.js'
export { isDrive }

export const kindOf = (n) => ({ hwp: 'hwp', hwpx: 'hwp', docx: 'doc', odt: 'doc', xlsx: 'xls', xlsm: 'xls', xls: 'xls', csv: 'xls', pptx: 'ppt', pdf: 'pdf', md: 'md', markdown: 'md', txt: 'txt', html: 'web', htm: 'web', xmind: 'map', dxf: 'cad', dwg: 'cad', svg: 'vec', vectorcraft: 'vec', psd: 'img', psb: 'img', pcraft: 'img', png: 'img', jpg: 'img', jpeg: 'img', webp: 'img', wav: 'snd', mp3: 'snd', flac: 'snd', ogg: 'snd', soundcraft: 'snd', scraftz: 'snd', mp4: 'vid', mov: 'vid', webm: 'vid', fcproj: 'vid' })[String(n || '').split('.').pop().toLowerCase()] || 'etc'
export const kindLabel = { hwp: '한글', doc: 'DOC', xls: 'XLS', ppt: 'PPT', pdf: 'PDF', md: 'MD', txt: 'TXT', web: 'HTML', map: 'MAP', cad: 'CAD', vec: 'SVG', img: 'IMG', snd: 'AUD', vid: 'VID' }

// what the card says it does
export const openHint = (c) => (c.url ? '열기' : loose(c.path) ? '눌러서 열기' : '작업실에서 열기')

// A step's output or a form's file (instance page, FormCard) is looked at inside the app, read-only: a
// link to a .docx/.hwpx in a new tab makes a phone download it and hand it to another app (Android:
// Google Docs, which asks for an account). inApp false: no viewer here, the caller offers a download.
// A Google Drive / Docs link (process-gpt keeps step outputs there) opens in the same viewer: the server
// fetches it with the company's Drive connection and publishes a copy (server/lib/driveOutputs.js) —
// before, a phone handed it to the Drive app (2026-11-18).
export const inApp = (f) => { if (isDrive(f?.url)) return true; const ed = officeEditorFor(f?.name || f?.url); return !!(f?.url && ed && !craftMissing(ed)) }
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
  app.setOfficeDoc({ url: f.url, name: f.name || decodeURIComponent(f.url.split('?')[0].split('/').pop()), readOnly: true })
  return true
}

// A document opens in the office panel in place; anything else opens its URL. Answers what happened — {how, opened, reason}:
// the messenger shows the reason beside the file when it did not open, and keeps itself open when it is docked (openPlan.js).
// link: false — do not open a link by itself (after a wait the browser may block the window without a word): the caller
// shows the reason with a link the person clicks.
export async function openArtifact(app, router, msg, { link = true } = {}) {
  let c = msg.content || {}
  let plan = openPlan(c, { craftMissing })
  if (plan.how === 'fetch' && msg.id) {
    try { c = await api(`/messages/${encodeURIComponent(msg.id)}/open-file`, { method: 'POST' }) } catch (e) {
      const reason = `파일을 열지 못했어요. ${e.message}`
      if (link) window.alert(reason)
      return { how: 'none', opened: false, reason }
    }
    plan = openPlan(c, { craftMissing })
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
