// A real run of this computer's own `claude` and `codex` through the local runner (spec openspec/specs/local-agents, results in its
// e2e/results/): a real Lite BFF (PRO_BACKGROUND=0, tenant localagent-smoke, a throwaway folder), one person's desktop runner (the desktop
// app's own code) with the real CLIs, and one tiny step for each — then one steer while it runs. It uses the person's own CLI sign-in
// (subscriptions): keep it to this one run each.
//   node test/localAgents.smoke.mjs [claude|codex|both|skill|tty]   (default both; LA_SMOKE_OUT=<dir> for the records)
//     claude · codex · both · skill — the headless fallback (mode 'headless': claude -p stream-json · codex exec --json); skill: one Claude
//       Code run with a company skill from the server, no steer
//     tty — the main path: the interactive `claude` in a terminal (node-pty) with the company skill, the prompt pasted once its
//       SessionStart hook says it is ready, a steer typed into its terminal while it works, the turn's end from its Stop hook. With
//       LA_SMOKE_GATEWAY=1 it runs on a model gateway (LA_SMOKE_ANTHROPIC_BASE_URL · _AUTH_TOKEN · _MODEL, Anthropic Messages API) with a
//       throwaway Claude Code config folder (onboarding marked done) — for a computer whose subscription sign-in cannot be used unattended;
//       the gateway's address and key never go into the record.
// What it records (no tokens, no account names): the exact CLI command lines the runner ran, the runner's progress lines, the CLI's
// events (type and a short text), what the steer did, the files the step left on the instance line, and how long it took.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const REPO = path.resolve(SERVER, '..')
const require = createRequire(import.meta.url)
const { createLocalRunner } = require(path.join(REPO, 'desktop/src/runner/index.js'))
const C = require(path.join(REPO, 'desktop/src/runner/clis.js'))
const WHICH = (process.argv[2] || 'both').toLowerCase()
const OUT = process.env.LA_SMOKE_OUT || path.join(REPO, 'openspec/specs/local-agents/e2e/results')
const AVOID = new Set([5199, 5195, 8795, 8777, 8794, 8796, 8797, 27790, 8088, 8787, 8798])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const PORT = Array.from({ length: 19 }, (_, i) => 8851 + i).find((p) => !AVOID.has(p) && portFree(p))
const BASE = `http://127.0.0.1:${PORT}`
const TENANT = 'localagent-smoke'
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-smoke-'))
Object.assign(process.env, { PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '', PRO_FOLDERS_ROOT: path.join(ROOT, 'folders') })
const { q, pool } = await import('../lib/supa.js')
const HOME = os.homedir()
const SECRETS = []
const clean = (s) => SECRETS.reduce((x, v) => x.split(v).join('<gateway>'), String(s ?? '')).split(HOME).join('~').split(ROOT).join('<tmp>').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>').replace(/pgf1\.[\w.-]+/g, '<token>').replace(/pld1_[\w-]+/g, '<token>')

let server
const serverLog = []
const record = { at: new Date().toISOString(), host: { platform: process.platform, node: process.version }, clis: {}, runs: [] }
const waitFor = async (fn, ms, what) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 300)) } }
const api = async (token, p, { method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
let runner
async function cleanup() {
  try { runner?.stop() } catch { /* gone */ }
  if (server && server.exitCode == null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)) }
  for (const t of ['todolist', 'bpm_proc_inst', 'proc_def', 'pro_local_jobs', 'pro_local_devices', 'pro_folders']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
}

try {
  server = spawn(process.execPath, ['index.js'], { cwd: SERVER, env: { ...process.env, PRO_PORT: String(PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off',
    PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [server.stdout, server.stderr]) s.on('data', (d) => serverLog.push(String(d)))
  await waitFor(async () => (await fetch(`${BASE}/api/config`).catch(() => null))?.ok, 60000, 'BFF')
  const me = await api(null, '/auth/email/verify', { method: 'POST', body: { email: 'pro-rt-local-smoke@uengine.org', code: '000000' } })
  const token = me.session.access_token
  const dev = await api(token, '/local-agents/devices', { method: 'POST', body: { name: '스모크 맥', platform: process.platform, appVersion: 'smoke' } })
  const cmds = []
  const raw = []
  const TTY = WHICH === 'tty'
  let sessionEnv
  if (TTY && process.env.LA_SMOKE_GATEWAY === '1') {
    const conf = path.join(ROOT, 'claude-config')
    await fs.mkdir(conf, { recursive: true })
    await fs.writeFile(path.join(conf, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }))
    const m = process.env.LA_SMOKE_ANTHROPIC_MODEL
    sessionEnv = { CLAUDE_CONFIG_DIR: conf, ANTHROPIC_BASE_URL: process.env.LA_SMOKE_ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: process.env.LA_SMOKE_ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_MODEL: m, ANTHROPIC_DEFAULT_HAIKU_MODEL: m, ANTHROPIC_DEFAULT_SONNET_MODEL: m, ANTHROPIC_DEFAULT_OPUS_MODEL: m, CLAUDE_CODE_EFFORT_LEVEL: 'low', MAX_THINKING_TOKENS: '0' }
    for (const v of [process.env.LA_SMOKE_ANTHROPIC_BASE_URL, process.env.LA_SMOKE_ANTHROPIC_AUTH_TOKEN]) if (v) SECRETS.push(v)
    record.gateway = 'a company model gateway (Anthropic Messages API), throwaway Claude Code config folder'
  }
  const relayed = []
  runner = createLocalRunner({ server: BASE, token: dev.token, dataDir: path.join(ROOT, 'desktop'), device: { name: '스모크 맥' }, prefs: () => ({ enabled: true, ask: false }),
    log: (s) => { if (/^\[runner\] .*: \//.test(s) || /^\[session /.test(s)) cmds.push(clean(s)) }, mode: TTY ? 'auto' : 'headless', ...(sessionEnv ? { sessionEnv } : {}) })
  runner.runner.on('raw', (r) => raw.push(r))
  // (what the runner relays: the hook events, and when each came)
  const send0 = runner.runner.send.bind(runner.runner)
  runner.runner.send = (m) => { if (m.type === 'hook' || m.type === 'term-open' || m.type === 'term-exit') relayed.push({ type: m.type, event: m.event || null, t: Date.now() }); return send0(m) }
  await runner.start()
  await waitFor(() => runner.status().connected, 15000, 'link')
  record.clis = Object.fromEntries(Object.entries(runner.status().clis).map(([k, c]) => [k, { installed: c.installed, version: c.version, loggedIn: c.loggedIn, runnable: c.runnable }]))

  const DEF = `la_smoke_${Date.now().toString(36)}`
  const INST = `${DEF}.${crypto.randomUUID()}`
  const acts = {
    'claude-code': { id: 'claude', name: '인사말 쓰기 (Claude Code)', instruction: '「인사.md」 파일을 만들고 한 줄로 "안녕하세요 — 로컬 Claude Code" 라고 쓰세요. 그다음 「체크.md」 파일을 만들고 "1차 완료" 라고 쓰세요. 다른 일은 하지 마세요.' },
    codex: { id: 'codex', name: '인사말 쓰기 (Codex)', instruction: '「인사.md」 파일을 만들고 한 줄로 "안녕하세요 — 로컬 Codex" 라고 쓰세요. 그다음 「체크.md」 파일을 만들고 "1차 완료" 라고 쓰세요. 다른 일은 하지 마세요.' },
  }
  // a company skill on the server (its folder, kind skill): the activity 「인사말 쓰기 (회사 스킬)」 names it — node test/localAgents.smoke.mjs skill
  {
    const S = await import('../lib/folders/service.js')
    const f = await S.createFolder({ id: me.user.id, name: 'smoke', email: 'pro-rt-local-smoke@uengine.org' }, { name: `인사말-규칙 스킬 ${Date.now()}` })
    await S.upload(f, { id: me.user.id, name: 'smoke' }, 'SKILL.md', Buffer.from('---\nname: 인사말-규칙\ndescription: 회사 인사말 · 안내 문구를 쓸 때 지키는 규칙. 인사말 파일을 만들 때 쓴다.\n---\n# 인사말 규칙\n- 인사말은 「안녕하세요, 달빛상사입니다.」로 시작한다.\n- 파일의 맨 끝 줄에 「— 달빛상사 인사 규칙 v1」을 붙인다.\n'))
    await q(`update pro_folders set kind='skill', settings = settings || $2 where id=$1`, [f.id, { skill_name: '인사말-규칙' }])
  }
  acts.skill = { id: 'skill', name: '인사말 쓰기 (회사 스킬)', skills: ['인사말-규칙'], instruction: '「인사.md」 파일을 만들고 한 줄 인사말을 쓰세요. 이 일에 쓰는 회사 스킬이 있으면 그 규칙을 따르세요. 다른 일은 하지 마세요.' }
  const STEER = '방향을 바꿔 주세요: 「조종.md」 파일을 하나 더 만들고 "조종 받음 — 사람이 실행 중에 바꾼 방향" 이라고 쓰세요. 이미 만든 파일은 그대로 두세요.'
  await q(`insert into proc_def (id, name, definition, tenant_id) values ($1,$2,$3,$4)`, [DEF, '로컬 에이전트 스모크', { activities: Object.values(acts) }, TENANT])
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, tenant_id, participants) values ($1,$2,$3,'RUNNING',$4,$5)`, [INST, '로컬 에이전트 스모크', DEF, TENANT, [me.user.id]])
  const agents = WHICH === 'both' ? ['claude-code', 'codex'] : WHICH === 'skill' || TTY ? ['claude-code'] : [WHICH === 'claude' ? 'claude-code' : WHICH]
  for (const agent of agents) {
    if (!runner.status().clis[agent]?.installed) { record.runs.push({ agent, skipped: 'not installed' }); continue }
    const act = WHICH === 'skill' || TTY ? acts.skill : acts[agent]
    const t0 = Date.now()
    const [t] = await q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, agent_mode, agent_orch, agent_config, start_date)
                         values (gen_random_uuid(), $1, $2, $3, $3, $4, $5, $6, 'IN_PROGRESS', 'COMPLETE', 'pgpt-pro-local', $7, now()) returning id::text as id`,
    [TENANT, me.user.id, INST, DEF, act.id, act.name, { local: { agent, offline: 'wait' } }])
    const job = await waitFor(async () => (await q('select * from pro_local_jobs where todo_id=$1', [t.id]))[0], 20000, 'job')
    // the steer: as soon as the CLI shows it is at work (its session, then its first event), from the instance's conversation
    await waitFor(async () => { const j = (await q('select state, session_id from pro_local_jobs where id=$1', [job.id]))[0]; return j.state === 'running' && j.session_id }, 120000, 'running')
    if (TTY) {
      // the terminal: the steer typed into it (from the instance's conversation) once the CLI is at work — its first tool line
      await waitFor(async () => ((await q('select lines from pro_local_jobs where id=$1', [job.id]))[0].lines || []).some((l) => l.kind === 'tool' || l.kind === 'text'), 180000, 'first tool line')
      const steerAt = Date.now() - t0
      const [th] = await waitFor(async () => { const r = await q('select id from pro_threads where user_id=$1 and ref=$2', [me.user.id, INST]); return r.length ? r : null }, 10000, 'thread')
      const sse = await (await fetch(`${BASE}/api/threads/${th.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ text: STEER }) })).text()
      const end = await waitFor(async () => { const j = (await q('select * from pro_local_jobs where id=$1', [job.id]))[0]; return ['done', 'failed'].includes(j.state) ? j : null }, 10 * 60_000, 'done')
      const f = (await q(`select * from pro_folders where tenant_id=$1 and settings ? 'work' and (settings->'work'->'instances') ? $2`, [TENANT, INST]))[0]
      const files = {}
      for (const p of end.result?.files || []) { try { files[p] = execFileSync('git', ['show', `${f.settings.work.line}:${p}`], { cwd: f.repo_path }).toString().slice(0, 600) } catch { files[p] = null } }
      // the last screen, as every viewer saw it (the job keeps its tail): plain text
      // eslint-disable-next-line no-control-regex
      const screen = clean(String(end.screen || '').replace(/\x1b\[[0-9;?>]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\r/g, '\n')).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-30)
      record.runs.push({ agent, mode: 'tty', version: runner.status().clis[agent].version, terminal: end.terminal, state: end.state, error: clean(end.error || ''), seconds: (Date.now() - t0) / 1000,
        steerSentAfterSeconds: steerAt / 1000, steerReply: /"steered":true/.test(sse), steers: (end.steers || []).map((x) => ({ text: x.text, sent: x.sent, applied: x.applied || null, failed: x.failed || false, reason: x.reason || null })),
        session: end.session_id ? `${end.session_id.slice(0, 8)}…` : null, commands: cmds, hooks: relayed.filter((r) => r.type === 'hook').map((r) => `${((r.t - t0) / 1000).toFixed(1)}s ${r.event}`),
        progress: (end.lines || []).map((l) => `${l.kind}: ${clean(l.text).slice(0, 200)}`), summary: clean(end.result?.summary || ''), files, screen })
      console.log(`${agent} (tty): ${end.state} in ${((Date.now() - t0) / 1000).toFixed(1)}s · steer ${(end.steers || []).map((x) => x.applied || x.reason).join(',')} · files ${Object.keys(files).join(', ')}`)
      continue
    }
    if (WHICH === 'skill') {
      // (no steer: this run shows a server skill used by the local CLI)
      const end = await waitFor(async () => { const j = (await q('select * from pro_local_jobs where id=$1', [job.id]))[0]; return ['done', 'failed'].includes(j.state) ? j : null }, 10 * 60_000, 'done')
      const f = (await q(`select * from pro_folders where tenant_id=$1 and settings ? 'work' and (settings->'work'->'instances') ? $2`, [TENANT, INST]))[0]
      const files = {}
      for (const p of end.result?.files || []) { try { files[p] = execFileSync('git', ['show', `${f.settings.work.line}:${p}`], { cwd: f.repo_path }).toString().slice(0, 600) } catch { files[p] = null } }
      const events = raw.filter((r) => r.jobId === job.id).map((r) => { let e = {}; try { e = JSON.parse(r.line) } catch { return null } const c = e.message?.content
        return { type: e.type, ...(e.subtype ? { subtype: e.subtype } : {}), ...(Array.isArray(c) ? { brief: clean(c.map((b) => (b.type === 'text' ? `text: ${b.text}` : b.type === 'tool_use' ? `tool_use ${b.name} ${JSON.stringify(b.input || {}).slice(0, 160)}` : b.type)).join(' | ')).slice(0, 260) } : {}) } }).filter(Boolean)
      record.runs.push({ agent, mode: 'skill', version: runner.status().clis[agent].version, state: end.state, error: clean(end.error || ''), seconds: (Date.now() - t0) / 1000,
        skills: (end.lines || []).filter((l) => /스킬/.test(l.text)).map((l) => l.text), commands: cmds.filter((c) => c.includes(act.name)), summary: clean(end.result?.summary || ''), files, events,
        knowhow: (end.knowhow || []).map((k) => ({ kind: k.kind, text: k.text })) })
      console.log(`${agent} (skill): ${end.state} · files ${Object.keys(files).join(', ')}`)
      continue
    }
    await waitFor(() => raw.some((r) => r.jobId === job.id && /"type":"(assistant|item\.(started|completed))"/.test(r.line)), 120000, 'first event')
    const steerAt = Date.now() - t0
    const [th] = await waitFor(async () => { const r = await q('select id from pro_threads where user_id=$1 and ref=$2', [me.user.id, INST]); return r.length ? r : null }, 10000, 'thread')
    const sse = await (await fetch(`${BASE}/api/threads/${th.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ text: STEER }) })).text()
    const end = await waitFor(async () => { const j = (await q('select * from pro_local_jobs where id=$1', [job.id]))[0]; return ['done', 'failed'].includes(j.state) ? j : null }, 10 * 60_000, 'done')
    const f = (await q(`select * from pro_folders where tenant_id=$1 and settings ? 'work' and (settings->'work'->'instances') ? $2`, [TENANT, INST]))[0]
    const files = {}
    for (const p of end.result?.files || []) {
      try { files[p] = execFileSync('git', ['show', `${f.settings.work.line}:${p}`], { cwd: f.repo_path }).toString().slice(0, 600) } catch { files[p] = null }
    }
    const events = raw.filter((r) => r.jobId === job.id).map((r) => {
      let e = {}
      try { e = JSON.parse(r.line) } catch { return { phase: r.phase, unparsed: clean(r.line).slice(0, 160) } }
      const c = e.message?.content
      const brief = Array.isArray(c) ? c.map((b) => (b.type === 'text' ? `text: ${b.text}` : b.type === 'tool_use' ? `tool_use ${b.name} ${JSON.stringify(b.input || {}).slice(0, 120)}` : b.type)).join(' | ')
        : typeof c === 'string' ? `user: ${c}` : e.item ? `${e.item.type}${e.item.command ? `: ${e.item.command}` : ''}${e.item.text ? `: ${e.item.text}` : ''}${e.item.changes ? `: ${e.item.changes.map((x) => x.path).join(', ')}` : ''}` : e.result ? `result: ${e.result}` : ''
      return { phase: r.phase, type: e.type, ...(e.subtype ? { subtype: e.subtype } : {}), ...(e.isReplay ? { replay: true } : {}), ...(brief ? { brief: clean(brief).slice(0, 220) } : {}) }
    })
    const run = { agent, version: runner.status().clis[agent].version, todo: t.id, state: end.state, error: clean(end.error || ''), seconds: (Date.now() - t0) / 1000, steerSentAfterSeconds: steerAt / 1000,
      steerReply: /"steered":true/.test(sse), steers: (end.steers || []).map((s) => ({ text: s.text, sent: s.sent, applied: s.applied || null })), session: end.session_id ? `${end.session_id.slice(0, 8)}…` : null,
      commands: cmds.filter((c) => c.includes(act.name)), progress: (end.lines || []).map((l) => `${l.kind}: ${clean(l.text).slice(0, 200)}`), summary: clean(end.result?.summary || ''),
      files, events }
    record.runs.push(run)
    console.log(`${agent}: ${end.state} in ${run.seconds.toFixed(1)}s · steer ${run.steers.map((s) => s.applied).join(',')} · files ${Object.keys(files).join(', ')}`)
  }
} catch (e) {
  record.error = clean(e.stack || e.message)
  console.log('FAILED', e.message)
  console.log(serverLog.join('').split('\n').slice(-40).join('\n'))
} finally {
  await fs.mkdir(OUT, { recursive: true })
  const name = `smoke-${WHICH}-${record.at.slice(0, 10)}.json`
  await fs.writeFile(path.join(OUT, name), JSON.stringify(record, null, 2))
  console.log(`→ ${path.join(OUT, name)}`)
  await cleanup()
}
