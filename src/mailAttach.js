// A mail's attachments are things you can act on (2026-11-25 사용자: 「메일 첨부를 곧바로 이음오피스 등의 도구로 열어보거나 채팅으로 해당 메일에
// 대한 질의/액션을 취할 수 있는 뭔가 흐름이 있어야」 — spec mail-attachments). Wherever a mail's attachments are listed (the mail sheet, the
// messenger's mail card, a sent message's chip) a tap opens the attachment in the right tool here:
//   a document (xlsx · docx · pptx · hwp · pdf · md …)  the IeumOffice panel — the folder's copy when the mail was filed (its saves go into
//                                                        the folder), else the mail's private copy (a save becomes my own private file card)
//   a picture · sound · video                            the app's viewer (MediaViewer.vue)
//   anything else                                        a calm 「내려받기」
// The server decides from the person's own access (server lib/mailAttachments.js); every address it hands out is signed and short-lived,
// never a public storage address. 「이 첨부로 묻기」 puts the mail and the attachment in the AI chat's composer as chips.
import { api } from './api.js'
import { BASE } from './base.js'
import { viewMedia } from './artifacts.js'
import { mailItem } from './fileDrag.js'

// attachment n of a mail card as an item of the app's one drag (src/fileDrag.js): {src: 'mailatt', id (the card's id), i, name}
export const attItem = (card, a, i) => {
  const id = card?.id || card?.actionId
  return id && Number.isInteger(i) ? { src: 'mailatt', id, i, name: a?.name || String(a || ''), subject: card?.source?.subject || card?.subject || '', as: 'mailatt' } : null
}
// an address of this server's (the signed route) as the page uses it; a signed storage address as it is
export const pageUrl = (u) => (String(u || '').startsWith('/') ? `${BASE}/api${u}` : String(u || ''))
// the chip's badge
const KIND = { hwp: '한글', hwpx: '한글', docx: 'DOC', doc: 'DOC', odt: 'DOC', xlsx: 'XLS', xlsm: 'XLS', xls: 'XLS', csv: 'XLS', pptx: 'PPT', ppt: 'PPT', pdf: 'PDF', md: 'MD', txt: 'TXT',
  png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG', svg: 'IMG', tif: 'IMG', tiff: 'IMG', mp3: 'AUD', m4a: 'AUD', wav: 'AUD', mp4: 'VID', mov: 'VID', webm: 'VID', zip: 'ZIP' }
export const attBadge = (name) => KIND[String(name || '').split('.').pop().toLowerCase()] || 'FILE'
export const sizeText = (n) => (!n ? '' : n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${Math.round(n / 1024)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`)

// Carries out a plan the server gave ({how, url, name, …}) → {how, opened, url?}: 'download' is not opened by itself — the caller shows a
// 「내려받기」 link (a window opened after a wait is blocked by the browser without a word).
export async function carryOut(app, plan, att = null) {
  if (plan.how === 'office') {
    const doc = { url: plan.url, name: plan.name, private: true,
      ...(plan.message?.id ? { msgId: plan.message.id } : {}),
      ...(plan.folder ? { folder: plan.folder, readOnly: plan.folder.editable !== true } : {}),
      ...(plan.readOnly ? { readOnly: true } : {}),
      ...(att && plan.from === 'mail' && !plan.readOnly ? { mailAtt: { actionId: att.actionId, i: att.i, name: plan.name } } : {}) }
    const opened = await app.setOfficeDoc(doc)
    return { how: 'office', opened: opened !== false, reason: opened === false ? '열린 문서를 아직 저장하지 못해 그대로 두었어요. 한 번 더 누르면 바꿔요.' : '' }
  }
  if (plan.how === 'view') return { how: 'view', opened: viewMedia(app, { kind: plan.media, url: pageUrl(plan.url), name: plan.name }) }
  return { how: 'download', opened: false, url: pageUrl(plan.url), name: plan.name }
}
// the owner opens attachment i of their mail card → what happened ({how, opened, url?, reason?}); download: a 「내려받기」 address whatever it is
export async function openMailAttachment(app, { actionId, i, name }, { download = false } = {}) {
  const plan = await api(`/mail/attachments/${encodeURIComponent(actionId)}/${i}/open`, { method: 'POST', body: { name, ...(download ? { download: true } : {}) } })
  return carryOut(app, plan, { actionId, i })
}
// 「이 첨부로 묻기」: the AI chat's composer gets the mail and the attachment(s) as chips (the agent turn reads each through its private copy)
export async function askInChat(app, card, list) {
  const items = [mailItem(card), ...list.map(({ a, i }) => attItem(card, a, i))].filter(Boolean)
  await app.addFileRefs(items)
  app.focusTick = (app.focusTick || 0) + 1
}
