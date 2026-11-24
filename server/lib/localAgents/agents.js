// Which agent does an activity: the company process map's activity settings (the task definition's front matter) name it.
//   agent: local:claude-code | local:codex | local:openhands   — the assignee's own CLI on their desktop (lib/localAgents)
//          onto | deepagents | cliagents                         — a server agent, as before (onto: Lite's 업무 에이전트)
//   when_offline: server | wait      — the assignee's desktop is off: hand the step to the server agent, or wait for the desktop
//   server_agent: onto | deepagents | cliagents   — the server agent for that (default onto)
//   wait_minutes: 120                — waiting longer than this hands it to the server agent (empty: wait as long as it takes)
// Pure: no database here (test/localAgents.test.js).

export const ORCH = 'pgpt-pro-local'
export const LOCAL = ['claude-code', 'codex', 'openhands']
export const SERVER = ['onto', 'deepagents', 'cliagents']
export const LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', openhands: 'OpenHands', onto: '업무 에이전트', deepagents: 'deepagents', cliagents: 'Claude Code (서버)' }
export const LABEL_EN = { 'claude-code': 'Claude Code', codex: 'Codex', openhands: 'OpenHands', onto: 'Business agent', deepagents: 'deepagents', cliagents: 'Claude Code (server)' }
export const OFFLINE = ['server', 'wait']

// "local:claude-code" → "claude-code"; anything else → null
export function localOf(agent) {
  const m = /^local:([a-z-]+)$/.exec(String(agent || '').trim())
  return m && LOCAL.includes(m[1]) ? m[1] : null
}

const int = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 60 * 24 * 14) : null }

// local settings in their one shape {agent, offline, serverAgent, waitMinutes} (an act's localAgent, a work item's agent_config.local),
// from that shape or a front matter's keys → null when it is not a local agent
export function normalize(s) {
  if (!s || typeof s !== 'object') return null
  const agent = LOCAL.includes(s.agent) ? s.agent : localOf(s.agent)
  if (!agent) return null
  const offline = OFFLINE.includes(s.offline) ? s.offline : 'server'
  return { agent, offline, serverAgent: SERVER.includes(s.serverAgent) ? s.serverAgent : 'onto', waitMinutes: offline === 'wait' ? int(s.waitMinutes) : null }
}
export function settingsOf(front = {}) {
  const f = front || {}
  if (!localOf(f.agent)) return null
  return normalize({ agent: f.agent, offline: f.when_offline, serverAgent: f.server_agent, waitMinutes: f.wait_minutes })
}

// a request from the settings screen → the front matter keys to set ({} clears them: back to the server agent)
export function frontOf(body = {}) {
  const agent = String(body.agent || '').trim()
  if (!agent || SERVER.includes(agent)) return { agent: agent && agent !== 'onto' ? agent : null, when_offline: null, server_agent: null, wait_minutes: null }
  if (!localOf(agent)) throw Object.assign(new Error('agent 는 local:claude-code · local:codex · local:openhands 이거나 서버 에이전트(onto · deepagents · cliagents)예요.'), { status: 400 })
  const offline = OFFLINE.includes(body.whenOffline) ? body.whenOffline : 'server'
  const serverAgent = SERVER.includes(body.serverAgent) ? body.serverAgent : 'onto'
  const wait = offline === 'wait' ? int(body.waitMinutes) : null
  return { agent, when_offline: offline, server_agent: serverAgent, wait_minutes: wait }
}

// the front matter with these keys set (null removes one), keeping the order of the others
export function withFront(front, patch) {
  const out = { ...front }
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') delete out[k]
    else out[k] = v
  }
  return out
}

// whose desktop runs a step: the first person among its assignees (todolist.user_id: ids or e-mails, comma separated), not an agent
export function assigneeOf(userIds, { agents = new Set(), emails = new Map() } = {}) {
  for (const raw of String(userIds || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (agents.has(raw)) continue
    if (/^[0-9a-f-]{36}$/i.test(raw)) return raw
    if (emails.has(raw.toLowerCase())) return emails.get(raw.toLowerCase())
  }
  return null
}

// what a desktop says it can run (caps.clis[agent] = {installed, version, loggedIn}) and whether it runs anything now (prefs.enabled)
export function canRun(device, agent) {
  if (!device || device.prefs?.enabled === false) return false
  const c = device.caps?.clis?.[agent]
  return !!c?.installed && c.runnable !== false
}

// the queue's order: oldest first; a desktop takes at most `limit` at once
export function pickNext(queued, running, limit = 2) {
  if (running >= limit) return []
  return [...queued].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, limit - running)
}

// a waiting job past its wait time
export function overdue(job, now = Date.now()) {
  if (job.state !== 'queued' || job.offline !== 'wait' || !job.wait_minutes) return false
  return now - new Date(job.created_at).getTime() >= job.wait_minutes * 60_000
}
