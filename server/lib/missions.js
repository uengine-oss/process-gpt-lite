// Missions: scheduled runs of a deepagents tenant skill, fired by pg_cron (see scheduler.js).
// Each run is a fresh deepagents conversation as the user (real JWT, so per-user connectors work).
// The run is asked to end with `MISSION_RESULT: {...}`; state carried between runs (e.g. seen video
// ids) lives in pro_schedules.state. A run that finished without that line still succeeded (whether
// anything changed is then unknown, so the person hears about it); the chat stays quiet only for a
// successful run that found nothing new. A failed run — a skill, a process or a plain prompt — is
// recorded in the task's run history and announced in chat and on Home.
import { config } from '../config.js'
import { q, sessionFor } from './supa.js'
import { emit } from './bus.js'
import { notifyUser } from './notify.js'
import { mainThread, addMessage } from './store.js'
import { createSchedule } from './scheduler.js'
import { startProcess } from './engine.js'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { privateSkillFor } from './folders/skills.js'
import { PGPT_ROOT } from './paths.js'
import { L, isEn, locale, asUser, langInstruction } from './lang.js'

const PGPT = PGPT_ROOT

// The sandbox sees /workspace; on the host that is deepagents/workspace/<tenant> (per-tenant since
// the 2026-10 deepagents), or deepagents/workspace on older builds.
export async function workspaceHostPath(dir) {
  // deepagents reports some files relative to the workspace root (/.bpmn/<room>/process-…/ for a
  // process generation folder): those live under /workspace too
  if (/^\/\.bpmn\//.test(dir)) dir = `/workspace${dir}`
  if (!dir.startsWith('/workspace')) return dir
  const rest = dir.slice('/workspace'.length)
  for (const base of [`${PGPT}/services/deepagents/workspace/${config.tenantId}`, `${PGPT}/services/deepagents/workspace`]) {
    try { await fs.access(base + rest); return base + rest } catch { /* try next */ }
  }
  throw new Error(`workspace folder not found: ${dir}`)
}

// Save a skill-creator draft (a folder in the deepagents workspace) as a tenant skill through
// deepagents' own POST /skills/upload, exactly like the process-gpt UI's save button.
export async function saveSkillDraft({ dir, name, jwt, ownerId }) {
  const host = await workspaceHostPath(dir)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-skill-'))
  const zip = path.join(tmp, `${name}.zip`)
  try {
    await new Promise((resolve, reject) => execFile('zip', ['-qr', zip, path.basename(host)], { cwd: path.dirname(host) }, (e) => (e ? reject(e) : resolve())))
    const form = new FormData()
    form.set('tenant_id', config.tenantId)
    form.set('owner_id', ownerId)
    form.set('file', new Blob([await fs.readFile(zip)]), `${name}.zip`)
    const r = await fetch(`${config.deepagentsUrl}/skills/upload`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `upload ${r.status}`)
    return j
  } finally { await fs.rm(tmp, { recursive: true, force: true }) }
}

const now = () => new Date().toLocaleString(locale(), { timeZone: 'Asia/Seoul', dateStyle: 'full', timeStyle: 'short' })

export function parseResult(text) {
  const line = [...String(text).matchAll(/MISSION_RESULT:\s*(\{[\s\S]*?\})\s*$/gm)].pop()
  if (!line) return null
  try { return JSON.parse(line[1]) } catch { return null }
}

// the line every mission run is asked to end with (skill-creator's drafts do not add it on their own)
export const RESULT_LINE_EN = 'When you are done, write the result on the very last line, as one line: MISSION_RESULT: {"changed": true|false, "summary": "one English sentence with the result"} — changed is true when something is new or different since the previous run. If the skill document gives its own result-line format, follow that format (with the summary in English).'
export const RESULT_LINE = '끝나면 맨 마지막 줄에 결과를 한 줄로 적으세요: MISSION_RESULT: {"changed": true|false, "summary": "결과 한 문장(해요체)"} — changed 는 직전 실행 뒤로 새로 생기거나 바뀐 것이 있으면 true. 스킬 문서에 결과 줄 형식이 따로 있으면 그 형식을 따르세요.'

// A skill saved to run on a schedule gets the result step when its SKILL.md has none (skill-creator
// does not add it): missions then know whether anything changed.
export async function ensureResultLine(hostDir) {
  const file = path.join(hostDir, 'SKILL.md')
  const md = await fs.readFile(file, 'utf8').catch(() => null)
  if (md === null || /MISSION_RESULT/.test(md)) return false
  // (the result step in the language the skill was written in)
  if (isEn() && !/[가-힣]/.test(md)) {
    await fs.writeFile(file, `${md.replace(/\s*$/, '')}\n\n## Scheduled run result\n\nWhen it runs on a schedule (as a mission), print the result as one line on the very last line, after all the steps:\n\n\`\`\`\nMISSION_RESULT: {"changed": true, "summary": "one sentence with the result"}\n\`\`\`\n\n- changed: true when something is new or different since the previous run, otherwise false\n- summary: one sentence with the result to tell the user\n`)
    return true
  }
  await fs.writeFile(file, `${md.replace(/\s*$/, '')}\n\n## 예약 실행 결과\n\n예약 실행(미션)으로 돌 때는 모든 단계를 마친 뒤 맨 마지막 줄에 결과를 한 줄로 출력한다:\n\n\`\`\`\nMISSION_RESULT: {"changed": true, "summary": "결과 한 문장"}\n\`\`\`\n\n- changed: 직전 실행 뒤로 새로 생기거나 바뀐 것이 있으면 true, 없으면 false\n- summary: 사용자에게 알릴 결과 한 문장(해요체)\n`)
  return true
}

// An agent's answer without a result line, read as a run's outcome: an error or nothing at all is a
// failure; any other answer finished the job (changed unknown). Summary: the last sentence that says
// something (not a bare path, link or code line).
export function outcomeOf(text) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, summary: L('에이전트가 아무 답도 남기지 않고 끝났어요.', 'The agent finished without leaving any answer.') }
  const err = /\((?:오류|error):\s*([^)]*)\)/.exec(t)
  if (err && t.replace(err[0], '').trim().length < 40) return { ok: false, summary: L(`실행 중 오류: ${err[1].trim() || '원인 미상'}`, `Error while running: ${err[1].trim() || 'unknown cause'}`).slice(0, 300) }
  const lines = t.replace(/```[\s\S]*?```/g, '').split('\n').map((l) => l.replace(/^[\s#>*\-•\d.]+/, '').replace(/\*\*|`/g, '').trim())
    .filter((l) => l.length >= 6 && !/^(\/|~\/|https?:\/\/)\S*$/.test(l) && !/^[\w./-]+\.\w{1,5}$/.test(l) && /[가-힣a-zA-Z]{2}/.test(l))
  return { ok: true, summary: (lines.at(-1) || t.split('\n').filter(Boolean).at(-1) || '').slice(0, 300) }
}

// deepagents' skills API is tenant-guarded: call it with the user's JWT.
export async function listSkills(jwt) {
  try {
    const r = await (await fetch(`${config.deepagentsUrl}/skills?tenant_id=${encodeURIComponent(config.tenantId)}`, { headers: { Authorization: `Bearer ${jwt}` } })).json()
    // path on the deepagents host → the same folder as the sandbox mounts it (/skills/<tenant>/…)
    return (Array.isArray(r) ? r : r.skills || []).map((s) => ({
      name: s.name, description: s.description || '',
      sandboxPath: s.path ? s.path.replace(/^.*\/skills\//, '/skills/') : null,
    }))
  } catch { return [] }
}

export async function createProcessSchedule({ userId, name, cron, processId, params = {}, threadId }) {
  const s = await createSchedule({ userId, name, cron, prompt: L(`프로세스 ${processId} 시작 (${JSON.stringify(params)})`, `Start process ${processId} (${JSON.stringify(params)})`), threadId })
  await q('update pro_schedules set process_id=$2, params=$3, notify=$4 where id=$1', [s.id, processId, params, 'always'])
  return { ...s, process_id: processId, params, notify: 'always' }
}

// A scheduled process run starts one instance; its own steps (agents, people) carry it from there,
// so the run is done once the instance exists and the chat gets a card to follow it.
async function runProcessSchedule(s, run) {
  const [p] = await q('select email, name from pro_profile where user_id=$1', [s.user_id])
  const { request, ...values } = s.params || {}
  const { instId, instName } = await startProcess({ me: { id: s.user_id, email: p.email, name: p.name }, defId: s.process_id, values })
  const [done] = await q(`update pro_mission_runs set finished_at=now(), status='done', changed=true, summary=$2, result=$3, conversation_id=$4 where id=$1 returning *`,
    [run.id, L(`인스턴스 시작 · ${instName}`, `Instance started · ${instName}`), { instId, instName, process: s.process_id }, instId])
  emit(s.user_id, 'mission', { scheduleId: s.id, run: done })
  const t = s.thread_id || (await mainThread(s.user_id)).id
  await addMessage(s.user_id, t, 'system', 'divider', { text: s.name, scheduleId: s.id })
  await addMessage(s.user_id, t, 'agent', 'process', { defId: s.process_id, name: instName, mode: 'start', state: 'started', instId, instName })
  return done
}

export async function createMission({ userId, name, cron, skill, params = {}, notify = 'on_change', threadId }) {
  const prompt = L(`스킬 ${skill} 실행 (${JSON.stringify(params)})`, `Run skill ${skill} (${JSON.stringify(params)})`)
  const s = await createSchedule({ userId, name, cron, prompt, threadId })
  await q('update pro_schedules set skill=$2, params=$3, notify=$4 where id=$1', [s.id, skill, params, notify])
  return { ...s, skill, params, notify }
}

// Both process-gpt agent types serve the SDK's chat SSE, so one reader covers them. deepagents
// streams 'token' chunks; cli-agent streams 'text' chunks and puts the whole answer on 'done'.
async function streamAgent({ user, session, message, agent }) {
  const cli = agent?.orch === 'cliagents'
  const base = cli ? config.cliAgentUrl : config.deepagentsUrl
  const res = await fetch(`${base}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({
      message, message_uuid: crypto.randomUUID(), tenant_id: config.tenantId,
      user_uid: user.id, user_email: user.email, user_name: user.name, user_jwt: session.access_token,
      conversation_id: null, stream: true,
      metadata: cli
        ? { client: 'pgpt-pro-mission', agent_cli: agent.cli || 'claude-code', agent_model: agent.model || '', agent_permission: agent.permission || 'command_exec', ...(isEn() ? { language: 'en' } : {}) }
        : { client: 'pgpt-pro-mission', ...(isEn() ? { language: 'en', style: 'English, concise.' } : {}) },
    }),
  })
  if (!res.ok) throw new Error(`${cli ? 'cli-agent' : 'deepagents'} ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', text = '', final = '', conversationId = null
  const tools = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      let j
      try { j = JSON.parse(line.slice(5)) } catch { continue }
      if (j.conversation_id && !conversationId) conversationId = j.conversation_id
      if ((j.type === 'token' || j.type === 'text') && j.content) text += j.content
      if (j.type === 'done' && j.content) final = j.content
      if (j.type === 'tool_start') tools.push(j.tool_name || j.name || j.tool)
      if (j.type === 'error') text += L(`\n(오류: ${j.message || j.error || ''})`, `\n(error: ${j.message || j.error || ''})`)
    }
  }
  return { text: final || text, conversationId, tools }
}

// A plain prompt on a schedule ("매일 아침 8시에 …"): the answer goes to the chat as an agent turn; a run
// that found nothing new posts nothing, but every run — and every failure — is in the run history.
async function runPromptSchedule(s, run) {
  const [p] = await q('select email, name from pro_profile where user_id=$1', [s.user_id])
  const { user, session } = await sessionFor(p.email, p.name)
  const threadId = s.thread_id || (await mainThread(s.user_id)).id
  const text = L(`${s.prompt}\n\n(예약 실행입니다. 직전 실행에서 공유한 것과 달라진 게 없으면 다른 말 없이 정확히 "변동 없음"만 답하세요. 공유할 때는 과정 설명 없이 결과만 쓰세요.)`,
    `${s.prompt}\n\n(This is a scheduled run. If nothing differs from what you shared in the previous run, answer exactly "No change" and nothing else. When you share, write only the result, without describing the process.)`)
  const { delegate } = await import('./agent.js')
  const msg = await delegate({ user, session, threadId, text, divider: { text: s.name, scheduleId: s.id }, quietIfUnchanged: true })
  const body = String(msg?.content?.text || '')
  const out = msg ? outcomeOf(body) : { ok: true, summary: L('변동 없음', 'No change') }
  // the answer is already in the chat: a failure is announced by the caller, not repeated here
  const [done] = await q(`update pro_mission_runs set finished_at=now(), status=$2, changed=$3, summary=$4, result=$5 where id=$1 returning *`,
    [run.id, out.ok ? 'done' : 'failed', out.ok ? !!msg : null, out.summary, { agent: 'deepagents', posted: !!msg }])
  emit(s.user_id, 'mission', { scheduleId: s.id, run: done })
  if (!out.ok) await announceFailure(s, done, { posted: !!msg })
  return done
}

// a failed run is never silent: a line in the task's chat and a Home card (the run history has it too)
async function announceFailure(s, run, { posted = false } = {}) {
  if (s.notify === 'never') return
  const reason = String(run?.summary || L('원인을 알 수 없어요.', 'The cause is unknown.')).slice(0, 200)
  if (!posted) {
    const t = s.thread_id || (await mainThread(s.user_id)).id
    await addMessage(s.user_id, t, 'system', 'divider', { text: s.name, scheduleId: s.id })
    await addMessage(s.user_id, t, 'agent', 'text', { text: L(`예약 실행이 실패했어요: ${reason}\n다음 예약 시각에 다시 실행해요. 「${s.name} 관리」에서 실행 기록을 보거나 지금 다시 실행할 수 있어요.`,
      `The scheduled run failed: ${reason}\nIt will run again at the next scheduled time. In "Manage ${s.name}" you can see the run history or run it again now.`) })
  }
  await notifyUser(s.user_id, { type: 'mission_failed', title: L(`예약 실행 실패: ${s.name}`, `Scheduled run failed: ${s.name}`), text: reason, url: `/settings/schedules?open=${s.id}` })
}

// pg_cron's tick (POST /api/cron/fire). When the database cannot even record the run (recovery mode,
// a restart), the tick is tried again a little later instead of being lost without a trace.
export async function fireSchedule(scheduleId, attempt = 0) {
  try { return await runMission(scheduleId, attempt ? 'retry' : 'cron') } catch (e) {
    if (attempt >= 3) { console.warn(`[cron] ${scheduleId.slice(0, 8)} gave up: ${e.message}`); return null }
    const min = 2 ** attempt
    console.warn(`[cron] ${scheduleId.slice(0, 8)} could not start (${e.message}) — again in ${min} min`)
    await new Promise((r) => setTimeout(r, min * 60000))
    return fireSchedule(scheduleId, attempt + 1)
  }
}

// every run in its owner's saved language (pg_cron's tick carries no person; a manual run from the page
// is the owner's too): the agent's answer, the run summary, the chat lines and the notification
export async function runMission(scheduleId, trigger = 'cron') {
  const [s] = await q('update pro_schedules set last_run=now() where id=$1 returning *', [scheduleId])
  if (!s || (s.paused && trigger !== 'manual')) return null
  return asUser(s.user_id, () => runMissionAs(s, trigger))
}
async function runMissionAs(s, trigger) {
  const [run] = await q(`insert into pro_mission_runs(schedule_id, trigger) values ($1,$2) returning *`, [s.id, trigger])
  emit(s.user_id, 'mission', { scheduleId: s.id, run })
  try {
    if (s.process_id) return await runProcessSchedule(s, run)
    if (!s.skill) return await runPromptSchedule(s, run)
    const [p] = await q('select email, name from pro_profile where user_id=$1', [s.user_id])
    const { user, session } = await sessionFor(p.email, p.name)
    const input = { ...s.params, seen: s.state?.seen || [], now: now() }
    const ask = L(`사용자에게 되묻지 말고 이 스킬의 절차대로 끝까지 실행해 주세요.\n입력:\n${JSON.stringify(input, null, 1)}\n${RESULT_LINE}`,
      `Run this skill's procedure to the end without asking the user anything.\nInput:\n${JSON.stringify(input, null, 1)}\n${RESULT_LINE_EN}`)
    // deepagents pins a skill from a leading '/skill-name'; cli-agent installs the tenant skills
    // into the run's project (.claude/skills, .agents/skills), so it is named instead.
    // a private skill (lib/folders/skills.js) is not installed: the owner's run reads its copy
    const own = await privateSkillFor(user, `/${s.skill}`).catch(() => null)
    const message = (own ? L(`다음 스킬 문서의 절차대로 실행하세요: ${own.path} (같은 폴더의 파일도 참고). ${ask}`, `Follow the procedure in this skill document: ${own.path} (see the files in the same folder too). ${ask}`)
      : s.agent?.orch === 'cliagents'
      ? L(`프로젝트에 설치된 \`${s.skill}\` 스킬을 읽고 사용하세요. ${ask}`, `Read and use the \`${s.skill}\` skill installed in the project. ${ask}`)
      : `/${s.skill} ${ask}`) + langInstruction()
    const out = await streamAgent({ user, session, message, agent: s.agent })
    const result = parseResult(out.text)
    // no result line: the run still finished (or not) — read the answer itself
    const plain = result ? null : outcomeOf(out.text)
    const ok = !!result || plain.ok
    const changed = result ? !!result.changed : null // null: unknown
    const summary = result?.summary || plain?.summary || L('결과를 확인하지 못했어요.', "I couldn't check the result.")
    if (result?.seen_add?.length) {
      const seen = [...new Set([...(s.state?.seen || []), ...result.seen_add])].slice(-300)
      await q(`update pro_schedules set state = coalesce(state,'{}'::jsonb) || $2::jsonb where id=$1`, [s.id, JSON.stringify({ seen })])
    }
    const [done] = await q(`update pro_mission_runs set finished_at=now(), status=$2, changed=$3, summary=$4, result=$5, conversation_id=$6 where id=$1 returning *`,
      [run.id, ok ? 'done' : 'failed', changed, summary, { ...(result || {}), ...(result ? {} : { result_line: false }), tools: out.tools, agent: s.agent?.orch === 'cliagents' ? s.agent.cli || 'claude-code' : 'deepagents' }, out.conversationId])
    emit(s.user_id, 'mission', { scheduleId: s.id, run: done })
    if (!ok) { await announceFailure(s, done); return done }
    // hark-style: stay quiet only when the run says nothing changed (unknown → the person hears about it)
    if (s.notify === 'always' || (s.notify !== 'never' && changed !== false)) {
      const t = s.thread_id || (await mainThread(s.user_id)).id
      await addMessage(s.user_id, t, 'system', 'divider', { text: s.name, scheduleId: s.id })
      const created = (result?.created || []).map((c) => `- ${c.date} ${c.summary}`).join('\n')
      await addMessage(s.user_id, t, 'agent', 'text', { text: `${summary}${created ? `\n\n${created}` : ''}` })
      // a skill run is the owner's own job: only the person who set it up hears about it
      await notifyUser(s.user_id, { type: 'mission', title: s.name, text: summary, url: `/pro/threads/${t}` })
    }
    return done
  } catch (e) {
    const [failed] = await q(`update pro_mission_runs set finished_at=now(), status='failed', summary=$2 where id=$1 returning *`, [run.id, e.message.slice(0, 300)])
    emit(s.user_id, 'mission', { scheduleId: s.id, run: failed })
    await announceFailure(s, failed).catch((x) => console.warn('[mission] announce', x.message))
    return failed
  }
}

export async function listMissionRuns(userId, scheduleId, limit = 20) {
  return q(`select r.* from pro_mission_runs r join pro_schedules s on s.id=r.schedule_id
            where s.user_id=$1 and r.schedule_id=$2 order by r.started_at desc limit $3`, [userId, scheduleId, limit])
}
