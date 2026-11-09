// Mob Elaboration / Mob Construction in Lite (docs/robo-dlc/plan-team.md): the people in a folder's
// AI-DLC roles meet in one group conversation (a meeting there: transcription, materials, minutes —
// lib/meetings). The questions the stage is waiting on go into the room; when a meeting in that room
// ends, the answers the team agreed on are read from its transcript and minutes and proposed on the
// decision page, where the person in the role confirms them into the question file.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { L, isEn } from '../lang.js'
import { chatJson } from '../llm.js'
import { notifyUser } from '../notify.js'
import * as F from '../folders/service.js'
import * as M from '../team/messenger.js'
import * as R from './record.js'
import * as TM from './team.js'
import { ROLE_KEYS } from './stages.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })

// the room the folder's mob meets in (made once, for everyone in a role and the person asking)
export async function startMob(slug, user) {
  const { folder } = await F.access(R.safeName(slug), user, 'viewer')
  const cur = await TM.currentIntent(folder.repo_path)
  if (!cur) throw err(404, 'no AI-DLC work in this folder')
  const files = (await R.listQuestions(cur.dir)).filter((f) => f.open > 0 && f.stage === cur.stage.slug)
  const people = new Map([[user.id, user]])
  for (const k of ROLE_KEYS) for (const p of await TM.holders(folder.id, k)) if (await F.roleOf(folder, { id: p.id })) people.set(p.id, p)
  if (people.size < 2) throw err(400, L('몹 회의에는 역할을 맡은 팀원이 둘 이상 있어야 해요. 폴더 화면의 「역할」에서 정해 주세요.', 'A mob needs at least two people in roles. Set them under 「Roles」 on the folder screen.'))
  const [known] = await q(`select room_id from pro_aidlc_mobs where tenant_id=$1 and folder_id=$2 order by created_at desc limit 1`, [T(), folder.id])
  let room = known ? await M.memberThread(user, known.room_id) : null
  if (!room) room = await M.groupThread(user, [...people.keys()].filter((id) => id !== user.id), `${folder.name} · ${L('AI-DLC 몹', 'AI-DLC mob')}`.slice(0, 60))
  const f = files[0]
  await q(`insert into pro_aidlc_mobs(tenant_id,folder_id,room_id,stage,questions_path,started_by) values ($1,$2,$3,$4,$5,$6)`, [T(), folder.id, room.id, cur.stage.slug, f?.path || null, user.id])
  const lines = f ? f.questions.filter((x) => !x.answer).map((x) => `${x.id}. ${x.text}${x.options.length ? `\n   ${x.options.map((o) => `${o.key}. ${o.text}`).join(' · ')}` : ''}`) : []
  const body = f
    ? L(`🧩 몹 정교화 · ${cur.stage.name} — 답을 기다리는 질문 ${lines.length}개예요. 회의에서 함께 정하면, 끝난 뒤 합의한 답을 정리해 담당자(${cur.stage.role})가 확인하고 질문 파일에 적어요.\n\n${lines.join('\n')}\n\n(${f.path})`,
      `🧩 Mob elaboration · ${cur.stage.name} — ${lines.length} question(s) wait for answers. Decide them together in a meeting; afterwards the agreed answers are collected for the ${cur.stage.role} to confirm into the question file.\n\n${lines.join('\n')}\n\n(${f.path})`)
    : L(`🧩 몹 회의 · ${cur.stage.name} — 지금 단계의 산출물과 결정을 함께 봐요.`, `🧩 Mob meeting · ${cur.stage.name} — let's review this stage's artifacts and decisions together.`)
  await M.post(user, room.id, { body })
  return { roomId: room.id, stage: cur.stage.slug, questions: f?.path || null }
}

// After a meeting in a mob room: the answers agreed on, proposed on the decision page.
export async function afterMinutes(m, summary, segs) {
  const [mob] = await q(`select * from pro_aidlc_mobs where tenant_id=$1 and room_id=$2 and questions_path is not null order by created_at desc limit 1`, [T(), m.room_id])
  if (!mob) return null
  const folder = await F.folderById(mob.folder_id)
  const cur = folder && await TM.currentIntent(folder.repo_path)
  if (!cur) return null
  const f = (await R.listQuestions(cur.dir)).find((x) => x.path === mob.questions_path)
  const open = f ? f.questions.filter((x) => !x.answer) : []
  if (!open.length || !segs.length) return null
  const answers = await agreed(open, segs, summary)
  if (!Object.keys(answers).length) return null
  const [p] = await q(`insert into pro_aidlc_proposals(tenant_id,folder_id,questions_path,answers,meeting_id,room_id) values ($1,$2,$3,$4,$5,$6) returning id`,
    [T(), folder.id, f.path, answers, m.id, m.room_id])
  const n = Object.keys(answers).length
  for (const d of await TM.deciders(folder, cur.stage.roleKey)) {
    if (d.id) await notifyUser(d.id, { type: 'aidlc', title: `${folder.name} · ${L(`몹 회의에서 답 ${n}개를 정했어요`, `The mob agreed on ${n} answer(s)`)}`,
      text: L('확인하고 질문 파일에 적으면 세션이 이어서 진행해요.', 'Confirm them into the question file and the session carries on.'), url: `/aidlc/${folder.slug}/decide?p=${p.id}` })
  }
  const starter = await q('select id, email, username as name from users where id=$1 and tenant_id=$2', [mob.started_by, T()])
  if (starter[0]) await M.post({ id: starter[0].id, email: starter[0].email, name: starter[0].name }, m.room_id, {
    body: L(`✅ 회의에서 합의한 답 ${n}개를 정리했어요 — ${Object.entries(answers).map(([k, a]) => `${k}: ${a.answer}`).join(' · ')}. 담당자가 「결정하기」에서 확인하고 질문 파일에 적어요.`,
      `✅ ${n} agreed answer(s) collected — ${Object.entries(answers).map(([k, a]) => `${k}: ${a.answer}`).join(' · ')}. The person in the role confirms them under 「Decide」.`),
  }).catch((e) => console.warn('[aidlc mob] post', e.message))
  return { proposalId: p.id, answers }
}

// what the transcript shows the team agreed on, per question: an option key (or "X: text" for Other);
// a question the team did not settle is left out
export async function agreed(open, segs, summary) {
  const sys = isEn()
    ? 'You read a team meeting transcript and its minutes and decide, for each question, which answer the team agreed on. Only answers the team clearly settled; skip a question that stayed open. Reply as JSON {"answers": {"Q1": {"answer": "A", "why": "who said what, one short sentence"}}}. The answer is one option key, several keys like "A, C" when the question allows several, or "X: <text>" for an answer that is none of the options.'
    : '팀 회의 받아쓰기와 회의록을 읽고, 질문마다 팀이 합의한 답을 고릅니다. 팀이 분명히 정한 것만 고르고, 정하지 못한 질문은 뺍니다. JSON {"answers": {"Q1": {"answer": "A", "why": "누가 어떻게 말했는지 짧은 한 문장"}}} 으로 답합니다. answer 는 선택지 기호 하나, 여러 개를 고르는 질문이면 "A, C" 처럼, 어느 선택지도 아니면 "X: 내용" 입니다.'
  const user = JSON.stringify({
    questions: open.map((x) => ({ id: x.id, text: x.text, options: x.options.map((o) => `${o.key}. ${o.text}`) })),
    transcript: segs.slice(-120).map((s) => `${s.speaker}: ${s.text}`),
    minutes: { summary: summary?.summary, decisions: summary?.decisions },
  })
  const out = await chatJson(sys, user, { temperature: 0 }).catch((e) => { console.warn('[aidlc mob] agreed', e.message); return {} })
  const keys = new Map(open.map((x) => [x.id, new Set(x.options.map((o) => o.key))]))
  const res = {}
  for (const [id, a] of Object.entries(out.answers || {})) {
    const ans = String(a?.answer || '').trim()
    if (!keys.has(id) || !ans) continue
    const picked = ans.split(/\s*,\s*/).map((k) => k.split(':')[0].trim())
    if (!picked.every((k) => keys.get(id).has(k) || k === 'X')) continue
    res[id] = { answer: ans.slice(0, 300), why: String(a?.why || '').slice(0, 300) }
  }
  return res
}
