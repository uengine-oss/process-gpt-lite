// Messenger auto-translation (메신저 자동 번역): in team rooms and 1:1 chats, a message in another language
// than the reader's main language (lib/mainLang.js) reads translated, with the original one click away
// (원문 보기 / Show original). Each (text, target language) is translated once (lib/translate.js cache).
//   messages  a page of messages carries what is already known (attachCached: cache only, no model);
//             the page asks for the rest — only what it shows — with POST /team/translate {ids}
//   meetings  a 회의록 block's lines carry the translations made during the meeting (pgpt.meeting.lines[].tr)
//             and the minutes theirs (pgpt.meeting.tr); a reader whose language was not there gets the
//             missing ones here, the same way
//   cards     agent and assistant rows (results, "맡겼어요") are translated on display like messages;
//             meeting and material cards are drawn by the page in the screen's language
// Only for the room's people (message → memberThread), only what the reader can see, a budget per reader.
import { config } from '../../config.js'
import * as TR from '../translate.js'
import { mainLangOf } from '../mainLang.js'

export const enabled = () => process.env.PRO_MSG_TRANSLATE !== '0' && TR.enabled()
// the messenger and the database, loaded when first needed (partsOf is pure — test/interp.test.js)
const q = async (...a) => (await import('../supa.js')).q(...a)
const M = { message: async (...a) => (await import('./messenger.js')).message(...a), memberThread: async (...a) => (await import('./messenger.js')).memberThread(...a) }
const BODY_KINDS = new Set(['text', 'agent', 'share', 'mention'])
const MAX_IDS = 40

// the parts of one message a reader of `to` needs translated: [{key, text, from, hint, kind}]
export function partsOf(v, to, { senderLang = null } = {}) {
  if (v.kind === 'meeting-transcript') {
    return (v.meeting?.lines || []).flatMap((l, i) => (l.lang && l.lang !== to && !l.tr?.[to] && l.text ? [{ key: `l${i}`, text: l.text, from: l.lang, kind: 'speech' }] : []))
  }
  if (v.kind === 'meeting-minutes') {
    const mm = v.meeting || {}
    const base = mm.lang || 'ko'
    if (base === to || mm.tr?.[to]) return []
    return [
      ...(mm.summary ? [{ key: 'summary', text: mm.summary, from: base }] : []),
      ...(mm.decisions || []).map((d, i) => ({ key: `d${i}`, text: d, from: base })),
      ...(mm.actions || []).map((a, i) => ({ key: `a${i}`, text: a.title, from: base })),
    ].filter((p) => p.text)
  }
  if (!BODY_KINDS.has(v.kind) || v.mine || !v.body) return []
  if (TR.needs(v.body, to, senderLang) === false) return []
  return [{ key: 'body', text: v.body, hint: senderLang, kind: 'chat' }]
}

// what is already translated for this reader, put on the views (no model call)
export async function attachCached(me, views) {
  if (!enabled() || !views.length) return views
  const to = await mainLangOf(me.id)
  const want = []
  for (const v of views) {
    const sl = v.sender?.id && !v.sender.agent ? await mainLangOf(v.sender.id) : null
    const ps = partsOf(v, to, { senderLang: sl })
    if (!ps.length) continue
    v.trNeeded = true
    if (ps.length === 1 && ps[0].key === 'body') want.push({ id: v.id, text: v.body, kind: 'chat' })
  }
  const hit = await TR.cachedMany(want, to)
  for (const v of views) {
    const h = hit[v.id]
    if (!h) continue
    v.trNeeded = false
    if (!h.same) v.tr = { lang: to, from: h.lang, body: h.text }
  }
  return views
}

// POST /team/translate {ids, suggestions}: the reader's translations of these messages and of the
// assistant's suggestion cards in their rooms (made now when missing)
export async function translateFor(me, ids, suggestions = []) {
  if (!enabled()) return { enabled: false, to: await mainLangOf(me.id), items: {} }
  const to = await mainLangOf(me.id)
  const items = {}
  let limited = false, quota = false
  // a suggestion card (lib/team/assist.js): its title and reason, written in its requester's language
  for (const sid of [...new Set((Array.isArray(suggestions) ? suggestions : []).map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20)) {
    const [sg] = await q('select id, room_id, title, reason from pro_room_suggestions where id=$1 and tenant_id=$2', [sid, config.tenantId])
    if (!sg || !(await M.memberThread(me, sg.room_id))) continue
    const out = {}
    for (const k of ['title', 'reason']) {
      if (!sg[k] || TR.needs(sg[k], to) === false) continue
      const r = await TR.translate(sg[k], { to, kind: 'chat', budget: `reader:${me.id}` })
      if (r.error === 'quota') quota = true
      if (!r.same && !r.error && !r.limited && !r.off && r.text) out[k] = r.text
    }
    items[`s:${sid}`] = Object.keys(out).length ? out : { same: true }
  }
  for (const id of [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, MAX_IDS)) {
    const v = await M.message(me, id)
    if (!v) continue
    const sl = v.sender?.id && !v.sender.agent ? await mainLangOf(v.sender.id) : null
    const ps = partsOf(v, to, { senderLang: sl })
    if (!ps.length) { items[id] = { same: true }; continue }
    const out = {}
    await Promise.all(ps.map(async (p) => {
      const r = await TR.translate(p.text, { to, from: p.from || null, hint: p.hint || null, kind: p.kind || 'chat', budget: `reader:${me.id}` })
      if (r.limited) limited = true
      if (r.error === 'quota') quota = true
      if (!r.same && !r.error && !r.limited && !r.off && r.text) out[p.key] = r.text
      else if (p.key === 'body' && r.same) out.same = true
      if (p.key === 'body' && r.lang) out.from = r.lang
    }))
    if (v.kind === 'meeting-transcript') {
      items[id] = { lines: Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith('l')).map(([k, t]) => [k.slice(1), t])) }
    } else if (v.kind === 'meeting-minutes') {
      const mm = v.meeting || {}
      items[id] = out.summary ? { minutes: { summary: out.summary, decisions: (mm.decisions || []).map((d, i) => out[`d${i}`] || d), actions: (mm.actions || []).map((a, i) => out[`a${i}`] || a.title) } } : {}
    } else items[id] = out.body ? { body: out.body, from: out.from || null } : { same: !!out.same, from: out.from || null }
  }
  return { enabled: true, to, items, ...(limited ? { limited } : {}), ...(quota ? { quota } : {}) }
}
