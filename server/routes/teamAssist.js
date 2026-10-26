// Routes for team assist (lib/team/assist.js): the suggestions in a room, 시작 / 아니요, the per-room
// switch and the detector's counters. Mounted inside teamRoutes (same team check).
// 시작 runs as the person who pressed it, through process-gpt's chat-room path: their agent (deepagents
// /chat/stream) with the room as conversation_id, so the agent's answer is persisted into the room's
// chats like any process-gpt agent reply; StartProcessInstance starts the matched proc_def.
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q } from '../lib/supa.js'
import { emit } from '../lib/bus.js'
import { delegate } from '../lib/agent.js'
import { startProcess } from '../lib/engine.js'
import { attachmentHint } from '../lib/attachments.js'
import * as A from '../lib/team/assist.js'
import * as S from '../lib/team/shares.js'
import * as M from '../lib/team/messenger.js'

const T = () => config.tenantId
// storage links in an agent's text are not how people in the room get files: the grants are
const noLinks = (t) => String(t || '').replace(/\(?https?:\/\/[^\s)]*\/storage\/v1\/object\/[^\s)]*\)?/g, '').replace(/^#+\s*/gm, '').replace(/\*\*/g, '').trim()

// a chats row in process-gpt's agent shape (what the SDK persists for an agent reply)
async function agentRow(me, roomId, content, pgpt, uuid = crypto.randomUUID()) {
  const msg = { uuid, id: 'process-gpt-agent', name: 'Process GPT Agent', role: 'assistant', email: 'agent:process-gpt-agent', agentId: 'process-gpt-agent',
    userName: 'Process GPT Agent', profile: '/images/chat-icon.png', content, timeStamp: new Date().toISOString(), pgpt }
  await q('insert into chats(uuid, id, messages, tenant_id, thread_id) values ($1,$2,$3,$4,$2)', [uuid, roomId, msg, T()])
  return uuid
}

function runAs(me, session) {
  return async (s) => {
    const members = await M.membersOf(s.room_id)
    const others = members.filter((m) => m.id !== me.id)
    const tick = (text) => { for (const m of members) emit(m.id, 'team', { type: 'assist-status', threadId: s.room_id, id: s.id, text }) }
    const by = { by: me.id, byName: `${me.name}님의 에이전트` }
    tick(`${me.name}님의 에이전트가 맥락을 읽는 중`)
    // the hand-off is a room message too, so process-gpt's UI shows who set the agent to work
    await M.post(me, s.room_id, { kind: 'assist', body: `에이전트에게 맡겼어요 · ${s.title}`, context: { assist: s.id, work: s.work } })
    if (s.work === 'StartProcessInstance' && s.process_id) {
      const [d] = await q('select name from proc_def where id=$1 and tenant_id=$2', [s.process_id, T()])
      const r = await startProcess({ me, defId: s.process_id, values: {} })
      const inst = r?.instId || r?.proc_inst_id || r?.instance_id || ''
      return agentRow(me, s.room_id, `'${d?.name || s.process_id}' 프로세스를 시작했어요.${inst ? ` (인스턴스 ${inst})` : ''} 첫 단계는 담당자에게 배정됐어요.`,
        { kind: 'agent', ...by, context: { assist: s.id, title: s.title, process: s.process_id, instance: inst || null } })
    }
    const { lines, files } = await A.workOrder(me, s)
    // the person's own work room for this run, tied to the chat room: conversation_id = room id
    const [t] = await q(`insert into pro_threads(user_id,kind,title,ref,conversation_id) values ($1,'team',$2,$3,$4) returning *`, [me.id, `팀 대화 · ${s.title}`, `assist:${s.id}`, s.room_id])
    const started = new Date()
    tick(`${me.name}님의 에이전트가 ${s.title.replace(/하기$/, '')} 중`)
    const task = `팀원 대화방에서 요청받은 일을 해 주세요: ${s.title}\n\n— 대화 (마지막 줄이 요청) —\n${lines.join('\n')}\n\n결과는 대화방 사람들이 바로 읽을 수 있게 핵심만 짧게 정리하고, 표나 문서를 만들면 파일로 남겨 주세요.${attachmentHint(files)}`
    await delegate({ user: me, session, threadId: t.id, text: task, silent: true })
    const out = await q(`select id, kind, content from pro_messages where thread_id=$1 and created_at >= $2 and role='agent' order by created_at`, [t.id, started])
    const answer = noLinks(out.filter((m) => ['text', 'doc'].includes(m.kind)).map((m) => m.content.text).pop() || '작업을 마쳤어요.')
    const made = await S.myFiles(me, out.filter((m) => m.kind === 'file').map((m) => m.id), { lenient: true })
    // the agent's reply process-gpt persisted into the room (SDK: role assistant, thread_id = room)
    const [persisted] = await q(`select uuid from chats where id=$1 and messages->>'role'='assistant' and coalesce(public.pro_chat_ts(messages), now()) >= $2
                                 order by coalesce(public.pro_chat_ts(messages), now()) desc limit 1`, [s.room_id, new Date(started.getTime() - 2000)])
    const uuid = persisted?.uuid || crypto.randomUUID()
    const artifacts = made.length && others.length ? await S.grant(me, others, made, { note: s.title, dmMessageId: uuid, roomId: s.room_id }) : made.map((f) => ({ name: f.name, kind: f.name.split('.').pop(), sourceId: f.sourceId, shares: {} }))
    const pgpt = { kind: 'agent', ...by, artifacts, context: { assist: s.id, title: s.title } }
    if (persisted) {
      await q(`update chats set messages = messages || $2::jsonb where uuid=$1`, [uuid, JSON.stringify({ content: answer.length > 3000 ? `${answer.slice(0, 3000)}…` : answer, pgpt })])
    } else {
      await agentRow(me, s.room_id, answer, pgpt, uuid)
    }
    await q(`update chat_rooms set message=$2 where id=$1`, [s.room_id, { msg: answer.slice(0, 50), type: 'text', createdAt: new Date().toISOString() }])
    // the agent's result handed to the others is a handover, like a share (process mining)
    if (made.length) import('../lib/mining/recorder.js').then((m) => m.recordShare(me, made, others, s.title)).catch((e) => console.warn('[mining] assist', e.message))
    return uuid
  }
}

export function assistRoutes(r, auth, h) {
  r.get('/team/threads/:id/suggestions', auth, h((req) => A.list(req.user, req.params.id)))
  r.put('/team/threads/:id/assist', auth, h((req) => A.setThreadAssist(req.user, req.params.id, req.body.on)))
  r.post('/team/suggestions/:id/dismiss', auth, h((req) => A.dismiss(req.user, req.params.id)))
  r.post('/team/suggestions/:id/start', auth, h((req) => A.start(req.user, req.params.id, runAs(req.user, req.session))))
  r.get('/team/assist/stats', auth, h(() => {
    const pct = (list, p) => { const ms = [...list].sort((a, b) => a - b); return ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : null }
    return { ...A.stats, judge: A.judgeConfigured(), judgeMs: undefined, detectMs: undefined,
      judgeLatency: { n: A.stats.judgeMs.length, p50: pct(A.stats.judgeMs, 0.5), p90: pct(A.stats.judgeMs, 0.9) },
      detectLatency: { n: A.stats.detectMs.length, p50: pct(A.stats.detectMs, 0.5), p90: pct(A.stats.detectMs, 0.9) },
      enabled: process.env.PRO_TEAM_ASSIST !== '0' }
  }))
}
