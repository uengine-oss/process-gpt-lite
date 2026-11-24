// 「@AI …」 in a team room (2026-11-24 사용자: 「"@"하여 AI 를 지칭하여 대화를 해서 예를 들어 "장진영 이력서 첨부해" 같은 명령을 보내면 이러한 멘션이나
// 관련 자료를 첨부할 수 있음. 이는 회의실내에서도 AI 에게 도움을 요청하는 액션들과 동일함.」). The person addressed the AI: it answers in the
// room as 「AI」 with what it did — the same steps as a meeting's helper (lib/assistHelp.js, skill assist-help):
//   material  the files the asker may see that the request means → a shared folder's file as a file mention (a link, lib/fileRefs.js);
//             a file of mine as the share that exists (team/shares.js grant); a file already shared in this room as that share again.
//             Someone in the room who cannot read that folder is named, and their card offers 「권한 요청」.
//   work      a 시작/아니요 card for the asker (team/assist.js offer) — their agent does it with their access when they press 시작
//   answer    two or three sentences; what it could not find is said
// Only the asker's access is used: candidates are what they may see (meetings/materials.js), each one checked again as them. While it
// works, everyone in the room sees 「AI가 찾는 중…」 ('ai-status').
import crypto from 'node:crypto'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { L, langOf } from '../lang.js'
import * as M from './messenger.js'
import * as A from './assist.js'
import * as S from './shares.js'
import * as H from '../assistHelp.js'
import * as FR from '../fileRefs.js'
import * as FS from '../folders/service.js'
import { judge as askJudge } from '../judge.js'
import { judgeQuestion, judgeOptions } from '../meetings/intent.js'

const LIMIT_HOUR = Number(process.env.PRO_AI_HELP_PER_HOUR || 30)
const recent = new Map() // roomId -> [timestamps]
const short = (s, n = 40) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
// the page writes 「@AI 」 in front of what was asked (the chip's word, not a reading of the request)
export const requestOf = (body) => String(body || '').replace(/^\s*@AI\b\s*/i, '').trim()

async function status(roomId, messageId, ko, en) {
  for (const m of await M.membersOf(roomId)) emit(m.id, 'team', { type: 'ai-status', threadId: roomId, messageId, text: ko == null ? null : ((await langOf(m.id)) === 'en' ? en : ko) })
}

// the room's last lines before the request: names and words (no files, no ids)
async function before(roomId, uuid, n = 4) {
  const rows = await q(`select messages from chats where id=$1 and uuid <> $2 and coalesce(public.pro_chat_ts(messages), now()) <=
                          coalesce((select public.pro_chat_ts(messages) from chats where uuid=$2), now())
                        order by coalesce(public.pro_chat_ts(messages), now()) desc limit $3`, [roomId, uuid, n])
  return rows.reverse().map(({ messages: m }) => `${m.pgpt?.ai && m.role === 'assistant' ? 'AI' : m.userName || m.name || L('팀원', 'Teammate')}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}`)
}

// msg: the posted request as its sender sees it ({id, body}); deps: {judges, json, ask, pool} for tests
export async function answer(asker, roomId, msg, deps = {}) {
  const now = Date.now()
  const list = (recent.get(roomId) || []).filter((x) => now - x < 3600000)
  if (list.length >= LIMIT_HOUR) {
    await M.postAgent(roomId, { content: L('이 대화방에서 AI 를 너무 자주 불렀어요. 잠시 뒤에 다시 불러 주세요.', 'The AI was asked too often in this room. Please ask again in a while.'), pgpt: { kind: 'agent', ai: true, by: asker.id, byName: 'AI', artifacts: [], context: { ai: { request: msg.id, action: 'limit' } } } })
    return null
  }
  list.push(now); recent.set(roomId, list)
  await status(roomId, msg.id, 'AI가 찾는 중…', 'AI is looking…')
  const uuid = crypto.randomUUID()
  try {
    const said = requestOf(msg.body)
    const prev = await before(roomId, msg.id)
    const a = said ? await H.askedFor({ said, prev }, deps) : { action: 'answer' }
    let reply
    if (!a.action) reply = { content: L('지금은 부탁을 읽을 판정 모델이 응답하지 않아요. 잠시 뒤에 다시 불러 주세요.', "The model that reads requests isn't answering right now. Please ask again in a moment.") }
    else if (a.action === 'material') reply = await attach(asker, roomId, uuid, said, prev, deps)
    else if (a.action === 'work') reply = await handOver(asker, roomId, msg, said, prev, deps)
    else reply = { content: (said && await H.briefAnswer({ said, prev }, deps)) || L('무엇을 도와드릴지 알려 주세요. 「@AI 이력서 첨부해」처럼 찾을 자료를 말하거나, 맡길 일을 적어 주세요.', 'Tell me what to help with — name the material to find, like "@AI attach the resume", or the work to hand over.') }
    const row = await M.postAgent(roomId, { uuid, content: reply.content, pgpt: { kind: 'agent', ai: true, by: asker.id, byName: 'AI', artifacts: reply.artifacts || [], ...(reply.refs?.length ? { refs: reply.refs } : {}), context: { ai: { request: msg.id, action: a.action || null, p: a.p ?? null } } } })
    console.log(`[ai-help] ${a.action} (${Math.round((a.p || 0) * 100)}%) · ${short(said)} → ${(reply.refs || []).length} link(s) · ${(reply.artifacts || []).length} share(s)`)
    return { row, action: a.action }
  } finally { await status(roomId, msg.id, null) }
}

// what the asker may attach here: a shared folder's file (as a link), a file of theirs, a file already shared in this room — not a file
// someone else shared with them elsewhere (it is not theirs to pass on)
const attachable = (asker) => (c) => !!c.folderFile || (c.kind === 'file' && (!!c.ref?.artifacts?.length || c.ref?.ownerId === asker.id))

async function attach(asker, roomId, uuid, said, prev, deps) {
  const found = await H.findMaterials({ said, prev, roomId, asker, kinds: attachable(asker) }, { judges: deps.judges, pool: deps.pool })
  if (found.failed) return { content: L('지금은 어느 자료인지 고를 판정 모델이 응답하지 않아요. 잠시 뒤에 다시 불러 주시거나 폴더에서 끌어다 놓아 주세요.', "The model that picks the material isn't answering right now. Ask again in a moment, or drag the file in from the folder.") }
  if (found.notFound) {
    return { content: L(`"${short(said)}"에 맞는 자료를 ${asker.name}님이 볼 수 있는 공유 폴더 · 이 대화방의 파일 · 내 산출물에서 찾지 못했어요. 파일 이름을 조금 더 알려 주시거나 폴더에서 끌어다 놓아 주세요.`,
      `I couldn't find anything matching "${short(said)}" in the shared folders, this room's files or the outputs ${asker.name} can see. Tell me more of the file's name, or drag it in from the folder.`) }
  }
  const members = await M.membersOf(roomId)
  const others = members.filter((m) => m.id !== asker.id)
  const refs = [], artifacts = [], warn = []
  for (const c of found.picks) {
    if (c.folderFile) {
      // (checked again as the asker: only a folder they read)
      const r = await FR.folderRef(asker, { slug: c.ref.slug, path: c.ref.path }).catch(() => null)
      if (!r || refs.some((x) => x.folderId === r.folderId && x.path === r.path)) continue
      refs.push(r)
      const folder = await FS.folderById(r.folderId)
      const lacking = []
      for (const o of others) if (!(await FS.roleOf(folder, o).catch(() => null))) lacking.push(o.name)
      if (lacking.length) warn.push(L(`${lacking.join(', ')}님은 「${r.folder}」 폴더 권한이 없어 「${r.name}」을(를) 바로 열 수 없어요. 카드의 「권한 요청」으로 요청할 수 있어요.`,
        `${lacking.join(', ')} can't open "${r.name}" yet — no access to the "${r.folder}" folder. The card's "Request access" asks for it.`))
    } else if (c.ref?.artifacts?.length) {
      // already shared in this room: the same share again (its people already hold it)
      artifacts.push(...c.ref.artifacts)
    } else {
      // a file card of the asker: a folder's file is a link, anything else is shared the way any of their files is
      const x = await FR.resolveOne(asker, { src: 'card', id: c.ref.sourceId }).catch(() => null)
      if (x?.as === 'link') { if (!refs.some((y) => y.folderId === x.ref.folderId && y.path === x.ref.path)) refs.push(x.ref); continue }
      const files = x ? await S.myFiles(asker, [x.cardId], { lenient: true }) : []
      if (!files.length) continue
      artifacts.push(...(others.length ? await S.grant(asker, others, files, { note: said, dmMessageId: uuid, roomId }) : files.map((f) => ({ name: f.name, kind: f.name.split('.').pop(), sourceId: f.sourceId, shares: {} }))))
    }
  }
  const names = [...refs.map((r) => r.name), ...artifacts.map((a) => a.name)]
  if (!names.length) return { content: L(`"${short(said)}"에 맞는 자료를 찾았지만 이 대화에 붙일 수 없었어요.`, `I found something for "${short(said)}" but couldn't attach it here.`) }
  const what = [refs.length ? L(`${refs.map((r) => `「${r.name}」`).join(', ')}을(를) 링크로 멘션했어요`, `I linked ${refs.map((r) => `"${r.name}"`).join(', ')}`) : '',
    artifacts.length ? L(`${artifacts.map((a) => `「${a.name}」`).join(', ')}을(를) 공유했어요`, `I shared ${artifacts.map((a) => `"${a.name}"`).join(', ')}`) : ''].filter(Boolean).join(L(' · ', ' · '))
  return { content: [`${what}.`, ...warn].join('\n'), refs, artifacts }
}

// the asker's own judge for the kind of work (the meeting asks its counted one — the same question and options, lib/assistHelp.js)
const ask = (state, question, options) => askJudge({ state: state.slice(0, 1200), question: judgeQuestion(question), options: judgeOptions(options) })

async function handOver(asker, roomId, msg, said, prev, deps) {
  const w = await H.workOf(H.stateOf(said, prev), { ask: deps.ask || ask }).catch(() => null)
  if (!w?.work || w.p < 0.45) return { content: (await H.briefAnswer({ said, prev }, deps)) || L('어떤 일을 맡길지 조금 더 알려 주세요.', 'Tell me a little more about the work to hand over.') }
  const title = A.titleOfWork(w.work, said)
  const s = await A.offer({ roomId, chatUuid: msg.id, work: w.work, title, audience: [asker.id],
    reason: L(`${asker.name}님이 AI 에게 한 부탁 "${short(said, 60)}" · 판정 모델 ${Math.round(w.p * 100)}%`, `${asker.name}'s request to the AI "${short(said, 60)}" · routing model ${Math.round(w.p * 100)}%`),
    judge: { p: Math.round(w.p * 100) / 100, ms: w.ms, model: w.model, via: 'ai' } })
  return { content: s
    ? L(`「${title}」을(를) 맡을 수 있어요. 아래 카드의 「시작」을 누르면 ${asker.name}님의 에이전트가 ${asker.name}님의 권한으로 해요.`, `I can take "${title}". Press Start on the card below and ${asker.name}'s agent does it with ${asker.name}'s access.`)
    : L(`「${title}」은(는) 이미 제안해 두었어요.`, `"${title}" is already suggested.`) }
}
