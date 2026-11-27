// Handing a variation to someone, wired into process-gpt's own handover the way its frontend does
// it (ProcessGPTBackend.createChatHandover): the receiver's chat room carries context.handover with
// the thread root (origin_room_id) and the artifacts, a briefing message, an ad-hoc todolist item
// for the receiver, a handover_events row (process-miner reads it), and a notification. The
// artifact is not a copy of files but the variation itself: {type: 'folder_variation', …}.
//   이어받기 (continue): same branch, the holder changes.   갈래 만들기 (fork): a new variation
// from the variation's head, held by the receiver.
// An agent receiver works on it at once: a deepagents run on the variation's checkout in the
// receiver's room; the result is committed and the todo closes with the variation in its output.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q, pool, ENGINE_NOW } from '../supa.js'
import { emit } from '../bus.js'
import * as S from './service.js'
import { changeCard } from './indexer.js'
import { runAgent, RULES, rules } from './runner.js'
import { L, lang, langOf } from '../lang.js'
import { pushRoomDir, pullRoomChanges } from '../roomStore.js'
import { localPart, person } from '../people.js'
import * as SE from './seats.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })

async function resolveOrigin(fromRoomId) {
  if (!fromRoomId) return null
  const [room] = await q('select context from chat_rooms where id=$1', [fromRoomId])
  const h = room?.context?.handover
  if (h?.origin_room_id) return { origin: h.origin_room_id, caseId: h.case_id || h.origin_room_id }
  const [ev] = await q(`select case_id, origin_room_id from handover_events where tenant_id=$1 and to_room_id=$2 order by occurred_at limit 1`, [T(), fromRoomId])
  if (ev) return { origin: ev.origin_room_id || ev.case_id, caseId: ev.case_id || ev.origin_room_id }
  return { origin: fromRoomId, caseId: fromRoomId }
}

async function latency(caseId) {
  const [r] = await q(`select occurred_at from handover_events where tenant_id=$1 and case_id=$2 order by occurred_at desc limit 1`, [T(), caseId])
  return r ? Math.max(0, Math.round((Date.now() - new Date(r.occurred_at).getTime()) / 1000)) : null
}

// The receiver as Process GPT has them: their users row in this tenant — users.username is what its todolist, handover events and
// rooms (and the variation's holder) carry, an agent's own name for an agent. Only the id comes from the page: the name it sends is
// the screens' (lib/people.js, 2026-11-25) and could be any text, so it is never written.
export async function receiverOf(id) {
  const [u] = await q(`select id::text as id, username, email, coalesce(is_agent, false) as is_agent, description from users where id::text=$1 and tenant_id=$2`,
    [String(id || ''), T()])
  return u ? { id: u.id, name: u.username || localPart(u.email), email: u.email || '', isAgent: !!u.is_agent, description: u.description || '' } : null
}

// asked: {id, …} — who the page picked (lib/folders routes); only its id is used
export async function handover(folder, v, from, { to: asked, mode = 'continue', done = '', next, grant = false, jwt, role = null }) {
  if (!asked?.id) throw err(400, L('받을 사람을 골라 주세요.', 'Please choose who receives it.'))
  const to = await receiverOf(asked.id)
  if (!to) throw err(404, L('받을 사람을 찾지 못했어요.', "I couldn't find who receives it."))
  // (what only the screens show — a refusal, the fork's title — says the name every screen uses)
  const shown = to.isAgent ? to.name : (await person(to.id))?.name || to.name
  if (!String(next || '').trim()) throw err(400, L('다음에 할 일을 적어 주세요.', 'Please write what to do next.'))
  if (['merged', 'discarded'].includes(v.status)) throw err(409, L('이미 반영했거나 버린 변형이에요.', 'This variation was already merged or discarded.'))
  if (v.status === 'open' && v.worktree_path && v.kind !== 'person') throw err(409, L('아직 실행 중인 변형이에요. 끝난 뒤 넘겨 주세요.', 'This variation is still running. Hand it over when it is done.'))
  // where its working copy is (folders/seats.js): handing it on (이어받기) is refused while someone else, a computer or a running agent
  // has it (checked before anything changes); my own server workroom is put away below — saved as it is, so the receiver gets
  // everything. A fork starts from what is saved: my own workroom is saved first and stays mine.
  const mine = mode !== 'fork' ? await SE.checkMove(folder, v, from, { role }) : null
  const principalType = to.isAgent ? 'agent' : 'user'
  const [member] = await q('select role from pro_folder_members where folder_id=$1 and principal_type=$2 and principal_id=$3', [folder.id, principalType, String(to.id)])
  if (!member) {
    if (!grant) throw err(403, L(`${shown} 님은 이 폴더 구성원이 아니에요. 실행 권한을 함께 주어야 넘길 수 있어요.`, `${shown} is not a member of this folder. Give them the runner role as well to hand it over.`))
    await S.setMember(folder, from, { type: principalType, id: to.id, role: 'runner' })
  }

  if (mine) { await SE.closeMine(folder, v, from); v = await S.variationById(v.id) }
  if (mode === 'fork') {
    const seat = await SE.seatOf(v.id, { v })
    if (seat && seat.place === 'server' && seat.run === 'workroom' && String(seat.user_id) === String(from.id)) await SE.commitAsIs(folder, v, { author: { name: from.name, email: from.email }, message: L('넘기기 전에 저장', 'Saved before handing over') })
  }
  const holder = { type: principalType, id: to.id, name: to.name }
  // what the receiver reads (briefing, to-do, notification) is in the receiver's saved language; an
  // agent receiver works in the sender's (lib/lang.js)
  const rl = to.isAgent ? lang() : await langOf(to.id)
  const R = (ko, en) => (rl === 'en' ? en : ko)
  let target = v
  if (mode === 'fork') {
    target = await S.createVariation(folder, { title: `${v.title} — ${shown}`, kind: 'handover', base: v.id, holder, source: { label: L(`${from.name} 님이 넘긴 갈래`, `Fork handed over by ${from.name}`), from_variation: v.id, room_id: null }, createdBy: from.id })
    await S.setStatus(target, 'ready')
  } else if (v.worktree_path) {
    // (a checkout from before seats: what it holds goes with the variation)
    await S.keepWhatIsThere(folder, v.worktree_path, v.branch)
    await S.release(folder, v)
  }

  const thread = await resolveOrigin(v.source?.room_id)
  const toRoomId = crypto.randomUUID()
  const toTaskId = crypto.randomUUID()
  const originRoomId = thread?.origin || toRoomId
  const caseId = thread?.caseId || originRoomId
  const ref = { type: 'folder_variation', ref: `${folder.slug}@${target.branch}`, name: `${folder.name} · ${target.title}`, folder_id: folder.id, folder_slug: folder.slug, variation_id: target.id, branch: target.branch, commit: target.head_commit, mode, url: `/folders/${folder.slug}/v/${target.id}` }

  // one transaction for the records (room, briefing, todo, event, holder): all of them or none
  const c = await pool.connect()
  const tq = (text, params) => c.query(text, params)
  try {
    await tq('begin')
    await tq(`insert into chat_rooms (id, tenant_id, name, participants, primary_agent_id, message, context) values ($1,$2,$3,$4,$5,$6,$7)`, [
      toRoomId, T(), next, JSON.stringify([{ id: to.id, name: to.name, email: to.email || '', isAgent: !!to.isAgent }]), to.isAgent ? String(to.id) : null,
      { msg: 'NEW', type: 'handover', createdAt: new Date().toISOString() },
      { handover: { origin_room_id: originRoomId, case_id: caseId, from_room_id: v.source?.room_id || null, from_user_id: from.id, from_user_name: from.name, artifact_refs: [ref] } },
    ])
    const briefing = R([`**${from.name}** 님이 공유 폴더 변형을 넘겼어요.`, done ? `- 지금까지 한 일: ${done}` : '', `- 다음에 할 일: ${next}`,
      `- 변형: ${folder.name} / ${target.title} (\`${target.branch}\`, ${mode === 'fork' ? '갈래 만들기' : '이어받기'})`].filter(Boolean).join('\n'),
    [`**${from.name}** handed over a shared folder variation.`, done ? `- Done so far: ${done}` : '', `- Next: ${next}`,
      `- Variation: ${folder.name} / ${target.title} (\`${target.branch}\`, ${mode === 'fork' ? 'fork' : 'continue'})`].filter(Boolean).join('\n'))
    await tq(`insert into chats (uuid, id, tenant_id, messages) values ($1,$2,$3,$4)`, [crypto.randomUUID(), toRoomId, T(),
      { role: 'system', name: from.name, email: from.email, content: briefing, timeStamp: new Date().toISOString(), handover: { origin_room_id: originRoomId, case_id: caseId, from_room_id: v.source?.room_id || null } }])

    const query = [R(`[Handover] ${from.name} 님이 넘긴 업무`, `[Handover] Work handed over by ${from.name}`), done ? `[Done] ${done}` : '', `[Instruction]\n${next}`, `[InputData]\n${JSON.stringify([ref])}`, `[ChatRoom] ${toRoomId}`].filter(Boolean).join('\n\n')
    // an ad-hoc item has no process instance, but the todolist trigger (task_execution_properties)
    // needs one: the handover chain stands in for it, so one case's items stay together
    await tq(`insert into todolist (id, user_id, username, activity_id, activity_name, status, description, tenant_id, adhoc, reference_ids, query, start_date, agent_config, agent_orch, proc_inst_id, tool)
             values ($1,$2,$3,$4,$5,'TODO',$6,$7,true,$8,$9,${ENGINE_NOW},$10,$11,$12,'formHandler:defaultform')`, [
      toTaskId, String(to.id), to.name, `handover_${toTaskId}`, next, next, T(), v.source?.room_id ? [v.source.room_id] : [], query,
      { folder: folder.id, variation: target.id, base_ref: `var:${target.branch}` }, to.isAgent ? 'pgpt-pro-folders' : null, `handover.${caseId}`])

    await tq(`insert into handover_events (tenant_id, case_id, origin_room_id, source, is_explicit, from_room_id, to_room_id, to_task_id, from_user_id, from_user_name, from_is_agent,
               to_user_id, to_user_name, to_is_agent, agent_orch, activity_label, next_activity_label, instruction, artifact_refs, handover_latency_sec)
             values ($1,$2,$3,'chat_handover',true,$4,$5,$6,$7,$8,false,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
      T(), caseId, originRoomId, v.source?.room_id || null, toRoomId, toTaskId, from.id, from.name, String(to.id), to.name, !!to.isAgent, to.isAgent ? 'deepagents' : null,
      done || null, next, next, JSON.stringify([ref]), await latency(caseId)])
    if (mode !== 'fork') await tq(`update pro_folder_variations set holder_type=$2, holder_id=$3, holder_name=$4, locked=true, updated_at=now() where id=$1`, [v.id, principalType, String(to.id), to.name])
    await tq('commit')
  } catch (e) {
    await c.query('rollback').catch(() => {})
    if (mode === 'fork') await S.discard(folder, target).catch(() => {})
    throw e
  } finally { c.release() }

  if (!to.isAgent) {
    await q(`insert into notifications (id, user_id, title, type, description, url, from_user_id, tenant_id) values (gen_random_uuid(),$1,$2,'handover',$3,$4,$5,$6)`,
      [String(to.id), R(`[업무 인계] ${next}`, `[Handover] ${next}`), R(`${from.name} 님이 '${folder.name}' 폴더의 변형 '${target.title}' 을(를) 넘겼어요.`, `${from.name} handed over the variation '${target.title}' of the '${folder.name}' folder.`), ref.url, from.email, T()])
    emit(to.id, 'notifications', {})
  } else {
    // the agent starts right away, on the variation, in the room the handover made
    runReceiver({ folder, v: await S.variationById(target.id), from, to, next, done, toRoomId, toTaskId, jwt }).catch((e) => console.warn('[folders] handover run', e.message))
  }
  return { variation: await S.variationById(target.id), toRoomId, toTaskId, caseId, originRoomId }
}

async function runReceiver({ folder, v, from, to, next, done, toRoomId, toTaskId, jwt }) {
  const dir = S.runCheckoutDir(toRoomId, folder)
  // the receiving agent's run has the working copy until it commits and releases it (folders/seats.js)
  const run = await SE.openServer(folder, v, { user: { id: String(to.id), name: to.name }, run: 'agent', work: 'handover', ref: String(toTaskId), dir })
  await q(`update pro_folder_variations set status='open', source = source || $2, updated_at=now() where id=$1`, [v.id, { room_id: toRoomId, todo_id: toTaskId }])
  await q(`update todolist set status='IN_PROGRESS' where id=$1`, [toTaskId])
  const msg = L(`${to.description ? `너는 '${to.name}' 이야 — ${to.description}\n` : ''}${from.name} 님이 공유 폴더 '${folder.name}' 의 변형 '${v.title}' 을(를) 넘겼어요.
작업 폴더: ${S.runCheckoutContainer(toRoomId, folder)}
${done ? `지금까지 한 일: ${done}\n` : ''}할 일: ${next}
${RULES}
끝나면 무엇을 바꿨는지 해요체로 짧게 알려 주세요.`, `${to.description ? `You are '${to.name}' — ${to.description}\n` : ''}${from.name} handed over the variation '${v.title}' of the shared folder '${folder.name}'.
Working folder: ${S.runCheckoutContainer(toRoomId, folder)}
${done ? `Done so far: ${done}\n` : ''}To do: ${next}
${rules()}
When you are done, say briefly what you changed.`)
  // the agent may run on another pod, with no disk in common: it gets the files from storage, and what it left there comes back
  // (the chat's way — threadFolders.js prepareProjectWork)
  const container = S.runCheckoutContainer(toRoomId, folder)
  const seeded = await pushRoomDir(dir, container).catch((e) => { console.warn('[folders] handover seed', e.message); return null })
  let note = '', ran = false
  try { note = await runAgent({ jwt, user: from, conversationId: toRoomId, message: msg }); ran = true } catch (e) { note = L(`실행 실패: ${e.message}`, `Run failed: ${e.message}`) }
  // (only while this run still holds the variation's seat; when it moved meanwhile, what it made becomes a variation of its own)
  await SE.finishRun(folder, await S.variationById(v.id), run, {
    fill: seeded ? (d) => pullRoomChanges(container, seeded, d, { wait: ran }).catch((e) => console.warn('[folders] handover pull', e.message)) : null,
    commit: (cur) => S.commitVariation(folder, cur, { name: to.name, email: `${String(to.id).slice(0, 8)}@agents.pgpt-pro.local` }, `${to.name}: ${next}`, { strict: true }),
    user: String(to.id), where: L('인계받은 에이전트', 'the receiving agent'),
  })
  const after = await S.variationById(v.id)
  await changeCard(folder, after).catch(() => {})
  await q(`update todolist set status='DONE', end_date=${ENGINE_NOW}, output=$2 where id=$1`, [toTaskId,
    { folder_variation: { folder: folder.slug, variation: v.id, branch: v.branch, commit: after.head_commit, url: `/folders/${folder.slug}/v/${v.id}` }, text: note.slice(0, 4000) }])
  await q(`update handover_events set returned_at=now() where to_task_id=$1`, [toTaskId])
  emit(from.id, 'folders', { slug: folder.slug, variation: v.id })
}
