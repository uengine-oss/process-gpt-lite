// The work order for a suggestion that came from a meeting (assist.workOrder hands over here):
// the transcript lines around the request (or the minutes and the action item), and the meeting's
// file materials the person who pressed 시작 can open — their own cards or their copies.
import { q } from '../supa.js'
import * as MAT from './materials.js'
import { L, withLang } from '../lang.js'
import { meetingLang } from './record.js'

// in the meeting's language (the work order is what the agent reads; its result goes back to the room)
export async function meetingOrder(me, s) {
  const [mt] = await q('select summary from pro_meetings where id=$1', [s.meeting_id])
  return withLang(meetingLang(mt), () => orderOf(me, s, mt))
}
async function orderOf(me, s, m) {
  let lines = []
  const seg = /^meeting:(\d+)$/.exec(s.chat_uuid || '')
  if (seg) {
    const rows = await q('select speaker, text from pro_meeting_segments where meeting_id=$1 and id <= $2 order by id desc limit 4', [s.meeting_id, Number(seg[1])])
    lines = rows.reverse().map((r) => `${r.speaker}: ${String(r.text).slice(0, 300)}`)
  } else {
    lines = [m?.summary?.summary ? `${L('회의 요약', 'Meeting summary')}: ${m.summary.summary}` : '', ...(m?.summary?.decisions || []).map((d) => `${L('결정', 'Decision')}: ${d}`), `${L('할 일', 'Action item')}: ${s.title}`].filter(Boolean)
  }
  // only the files the request is about, else the one on the stage: other materials shown in the meeting
  // would pull the agent into work nobody asked for. Which one it is about is the model's pick (no names
  // matched here); with one file there is nothing to pick.
  const ask = lines[lines.length - 1] || s.title
  const all = await q(`select * from pro_meeting_materials where meeting_id=$1 and kind='file' order by presented_at desc nulls last, created_at desc limit 6`, [s.meeting_id])
  let mats = all.filter((m) => m.presented_at).slice(0, 1)
  if (all.length > 1) {
    const r = await MAT.pick(`${ask} ${s.title}`, null, { list: all.map((m) => ({ kind: 'file', id: m.id, title: m.title })) }).catch(() => null)
    if (r?.pick) mats = all.filter((m) => m.id === r.pick.id)
  } else mats = all
  const files = []
  for (const mat of mats) {
    if (files.length >= 4 || !(await MAT.canSee(me, mat))) continue
    const msg = await MAT.openFile(me, mat).catch(() => null)
    if (msg?.content?.url) files.push({ name: msg.content.name, url: msg.content.url, path: msg.content.path })
  }
  return { lines, files }
}
