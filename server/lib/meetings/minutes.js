// The final minutes (최종 회의록), made when a meeting ends — nobody presses anything.
// Summary, decisions and action items come from one big-model call (lib/llm.js, JSON) over the
// consented transcript: this is after-meeting writing, not detection. Without a model (or on failure)
// a rule summary stands in. Action items become team-assist suggestions (pro_room_suggestions) anchored
// on the minutes row, offered to the person named for them (else everyone who was there).
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { chatJson } from '../llm.js'
import { WORKS, view as suggestionView } from '../team/assist.js'
import * as R from './record.js'

const T = () => config.tenantId
const JUDGE_URL = process.env.PRO_JUDGE_URL ?? 'http://127.0.0.1:8896/judge'
const hhmm = (d) => new Date(d).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' })
const KIND_WORD = { file: '파일', process: '진행 상황', panel: '앱 데이터', folder: '폴더 문서', result: '에이전트 결과' }

async function summarize(lines, people, materials) {
  if (!lines.length) return null
  const transcript = lines.map((l) => `${l.speaker}: ${l.text}`).join('\n').slice(-9000)
  const sys = '너는 회의록을 쓰는 비서야. 받아쓴 회의 대화를 읽고 JSON 으로만 답해. 모든 문장은 해요체("…했어요", "…하기로 했어요")로 짧게 써. "합니다/했습니다/하다" 로 끝내지 마. 지어내지 말고 대화에 나온 것만. ' +
    '할 일은 회의에서 누군가 하기로 하거나 부탁한 일만 많아야 4개, "…하기" 로 끝나는 명사형으로. 자료를 본 것 자체는 할 일이 아니야.'
  const user = `참석자: ${people.join(', ')}\n띄운 자료: ${materials.map((m) => m.title).join(', ') || '없음'}\n\n회의 대화:\n${transcript}\n\n` +
    '형식 예: {"summary":"견적서와 평면도를 다시 보고 금액을 낮추기로 했어요.","decisions":["견적 금액을 5% 낮추기로 했어요"],"actions":[{"title":"수정 견적서 고객에게 보내기","owner":"김민지"}]}'
  const out = await chatJson(sys, user, { temperature: 0.2 })
  return {
    summary: String(out.summary || '').slice(0, 600),
    decisions: (Array.isArray(out.decisions) ? out.decisions : []).map((d) => String(d).slice(0, 160)).filter(Boolean).slice(0, 8),
    actions: (Array.isArray(out.actions) ? out.actions : []).map((a) => ({ title: String(a.title || a).slice(0, 60), owner: String(a.owner || '') })).filter((a) => a.title).slice(0, 4),
  }
}

function ruleSummary(lines, people, materials, tasks) {
  const by = {}
  for (const l of lines) by[l.speaker] = (by[l.speaker] || 0) + 1
  return {
    summary: lines.length ? `${people.join(', ')}님이 이야기를 나눴어요. ${Object.entries(by).map(([k, n]) => `${k} ${n}번`).join(', ')} 말했어요.` : '받아쓰기 없이 진행했어요.',
    decisions: [],
    actions: tasks.map((t) => ({ title: t.title, owner: '' })),
  }
}

// which work an action item is (the judge, like assist.js stage 2b) — cheap, a guess is fine
async function workOf(title) {
  if (!JUDGE_URL) return 'CreateDocument'
  try {
    const r = await fetch(JUDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ state: `할 일: ${title}`, question: '이 할 일을 AI 비서가 돕는다면 어떤 종류인가요?', options: Object.entries(WORKS).filter(([k]) => k !== 'StartProcessInstance').map(([key, w]) => ({ key, label: w.label })) }) })
    const j = await r.json()
    return Object.entries(j.probabilities || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'CreateDocument'
  } catch { return 'CreateDocument' }
}

export async function finalize(m) {
  const people = await q('select user_id::text as id, name, consent_ever, joined_at, left_at from pro_meeting_participants where meeting_id=$1 order by joined_at', [m.id])
  const segs = await q('select speaker, user_id::text as user_id, text, at from pro_meeting_segments where meeting_id=$1 order by id', [m.id])
  const mats = await q('select * from pro_meeting_materials where meeting_id=$1 order by created_at', [m.id])
  const tasks = await q(`select id, title, state, started_by, result_uuid from pro_room_suggestions where meeting_id=$1 and chat_uuid like 'meeting:%' and state <> 'open' order by created_at`, [m.id])
  const names = people.map((p) => p.name)
  const declined = people.filter((p) => !p.consent_ever).map((p) => p.name)
  const shown = mats.filter((x) => x.presented_at || x.chat_uuid)
  let s = null, by = 'model'
  if (m.agent && segs.length) s = await summarize(segs, names, shown).catch((e) => { console.warn('[meetings] minutes model', e.message); return null })
  if (!s) { s = ruleSummary(segs, names, shown, tasks); by = 'rules' }
  const mins = Math.max(1, Math.round((new Date(m.ended_at || Date.now()) - new Date(m.started_at)) / 60000))
  const md = [
    `📝 회의록 · ${hhmm(m.started_at)}–${hhmm(m.ended_at || new Date())} (${mins}분)`,
    '',
    `참여: ${names.join(', ')}`,
    declined.length ? `받아쓰기에 동의하지 않은 분: ${declined.join(', ')} — 이분들의 말은 기록하지 않았어요.` : null,
    '',
    `요약: ${s.summary}`,
    s.decisions.length ? `\n결정\n${s.decisions.map((d) => `- ${d}`).join('\n')}` : null,
    s.actions.length ? `\n할 일\n${s.actions.map((a) => `- ${a.title}${a.owner ? ` (${a.owner})` : ''}`).join('\n')}` : null,
    shown.length ? `\n띄운 자료\n${shown.map((x) => `- ${KIND_WORD[x.kind] || '자료'} · ${x.title}`).join('\n')}` : null,
    tasks.length ? `\n회의 중 맡긴 작업\n${tasks.map((t) => `- ${t.title} · ${t.state === 'done' ? '끝남' : t.state === 'failed' ? '실패' : '진행 중'}`).join('\n')}` : null,
  ].filter((x) => x !== null).join('\n')
  const quiet = []
  const uuid = await R.minutesRow(m, md, {
    summary: s.summary, decisions: s.decisions, actions: s.actions, people: names, declined, minutes: mins, by,
    startedAt: m.started_at, endedAt: m.ended_at, lines: segs.length,
    materials: shown.map((x) => ({ id: x.id, kind: x.kind, title: x.title, roomCard: x.chat_uuid || null })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, state: t.state, resultMessageId: t.result_uuid })),
  }, quiet)
  // action items → suggestion cards under the minutes (시작 runs it as the person who presses it)
  const all = people.map((p) => p.id)
  const made = []
  for (const [i, a] of s.actions.entries()) {
    const owner = people.find((p) => a.owner && (a.owner.includes(p.name) || p.name.includes(a.owner)))
    const work = await workOf(a.title)
    const [row] = await q(`insert into pro_room_suggestions(tenant_id,room_id,chat_uuid,anchor_uuid,meeting_id,work,title,reason,audience,judge)
                           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (chat_uuid) do nothing returning *`,
    [T(), m.room_id, `minutes:${m.id}:${i}`, uuid, m.id, work, a.title, `회의록의 할 일${a.owner ? ` · ${a.owner}님` : ''}`, owner ? [owner.id] : all, { from: 'minutes' }])
    if (row) made.push(row)
  }
  const members = await q(`select p->>'id' as id from chat_rooms r, jsonb_array_elements(r.participants) p where r.id=$1 and p->>'id' ~ '^[0-9a-f-]{36}$'`, [m.room_id])
  for (const sg of made) for (const p of members) emit(p.id, 'team', { type: 'assist', threadId: m.room_id, suggestion: suggestionView(p.id, sg) })
  await q('update pro_meetings set summary=$2 where id=$1', [m.id, { ...s, by, declined, minutes: mins }])
  return uuid
}
