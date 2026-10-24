// Missions: scheduled runs of a deepagents tenant skill, fired by pg_cron (see scheduler.js).
// Each run is a fresh deepagents conversation as the user (real JWT, so per-user connectors work).
// The skill ends with `MISSION_RESULT: {...}`; state carried between runs (e.g. seen video ids)
// lives in pro_schedules.state, and the chat only hears about a run when something changed.
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

const PGPT = PGPT_ROOT

// The sandbox sees /workspace; on the host that is deepagents/workspace/<tenant> (per-tenant since
// the 2026-10 deepagents), or deepagents/workspace on older builds.
export async function workspaceHostPath(dir) {
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

const now = () => new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'full', timeStyle: 'short' })

function parseResult(text) {
  const line = [...String(text).matchAll(/MISSION_RESULT:\s*(\{[\s\S]*?\})\s*$/gm)].pop()
  if (!line) return null
  try { return JSON.parse(line[1]) } catch { return null }
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
  const s = await createSchedule({ userId, name, cron, prompt: `프로세스 ${processId} 시작 (${JSON.stringify(params)})`, threadId })
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
    [run.id, `인스턴스 시작 · ${instName}`, { instId, instName, process: s.process_id }, instId])
  emit(s.user_id, 'mission', { scheduleId: s.id, run: done })
  const t = s.thread_id || (await mainThread(s.user_id)).id
  await addMessage(s.user_id, t, 'system', 'divider', { text: s.name, scheduleId: s.id })
  await addMessage(s.user_id, t, 'agent', 'process', { defId: s.process_id, name: instName, mode: 'start', state: 'started', instId, instName })
  return done
}

export async function createMission({ userId, name, cron, skill, params = {}, notify = 'on_change', threadId }) {
  const prompt = `스킬 ${skill} 실행 (${JSON.stringify(params)})`
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
        ? { client: 'pgpt-pro-mission', agent_cli: agent.cli || 'claude-code', agent_model: agent.model || '', agent_permission: agent.permission || 'command_exec' }
        : { client: 'pgpt-pro-mission' },
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
      if (j.type === 'error') text += `\n(오류: ${j.message || j.error || ''})`
    }
  }
  return { text: final || text, conversationId, tools }
}

export async function runMission(scheduleId, trigger = 'cron') {
  const [s] = await q('update pro_schedules set last_run=now() where id=$1 returning *', [scheduleId])
  if (!s || (s.paused && trigger === 'cron')) return null
  const [run] = await q(`insert into pro_mission_runs(schedule_id, trigger) values ($1,$2) returning *`, [s.id, trigger])
  emit(s.user_id, 'mission', { scheduleId: s.id, run })
  try {
    if (s.process_id) return await runProcessSchedule(s, run)
    const [p] = await q('select email, name from pro_profile where user_id=$1', [s.user_id])
    const { user, session } = await sessionFor(p.email, p.name)
    const input = { ...s.params, seen: s.state?.seen || [], now: now() }
    const ask = `사용자에게 되묻지 말고 이 스킬의 절차대로 끝까지 실행해 주세요.\n입력:\n${JSON.stringify(input, null, 1)}`
    // deepagents pins a skill from a leading '/skill-name'; cli-agent installs the tenant skills
    // into the run's project (.claude/skills, .agents/skills), so it is named instead.
    // a private skill (lib/folders/skills.js) is not installed: the owner's run reads its copy
    const own = await privateSkillFor(user, `/${s.skill}`).catch(() => null)
    const message = own ? `다음 스킬 문서의 절차대로 실행하세요: ${own.path} (같은 폴더의 파일도 참고). ${ask}`
      : s.agent?.orch === 'cliagents'
      ? `프로젝트에 설치된 \`${s.skill}\` 스킬을 읽고 사용하세요. ${ask}`
      : `/${s.skill} ${ask}`
    const out = await streamAgent({ user, session, message, agent: s.agent })
    const result = parseResult(out.text)
    const changed = !!result?.changed
    const summary = result?.summary || out.text.trim().split('\n').filter(Boolean).slice(-1)[0] || '결과를 확인하지 못했어요.'
    if (result?.seen_add?.length) {
      const seen = [...new Set([...(s.state?.seen || []), ...result.seen_add])].slice(-300)
      await q(`update pro_schedules set state = coalesce(state,'{}'::jsonb) || $2::jsonb where id=$1`, [s.id, JSON.stringify({ seen })])
    }
    const [done] = await q(`update pro_mission_runs set finished_at=now(), status=$2, changed=$3, summary=$4, result=$5, conversation_id=$6 where id=$1 returning *`,
      [run.id, result ? 'done' : 'failed', changed, summary, { ...(result || {}), tools: out.tools, agent: s.agent?.orch === 'cliagents' ? s.agent.cli || 'claude-code' : 'deepagents' }, out.conversationId])
    emit(s.user_id, 'mission', { scheduleId: s.id, run: done })
    // hark-style: stay quiet unless the run produced something new
    if (s.notify === 'always' || (s.notify !== 'never' && changed)) {
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
    return failed
  }
}

export async function listMissionRuns(userId, scheduleId, limit = 20) {
  return q(`select r.* from pro_mission_runs r join pro_schedules s on s.id=r.schedule_id
            where s.user_id=$1 and r.schedule_id=$2 order by r.started_at desc limit $3`, [userId, scheduleId, limit])
}
