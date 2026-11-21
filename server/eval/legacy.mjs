// The baseline: how the old chat routing (main 84bd318) decides a message, for the same evaluation states.
// The old code is not copied here. Its expressions are read from that commit with `git show` when this
// runs (a commit never changes, so its line numbers are stable) and evaluated in a generated module in
// the system temp folder; this file only replays handleTurn's order (agent.js:199-427 of that commit)
// against the facts of a state, and maps each outcome to the evaluation's labels.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { config } from '../config.js'
import { chat } from '../lib/llm.js'
import { L, isEn, locale } from '../lib/lang.js'

const BASE = '84bd318'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const show = (p) => execFileSync('git', ['show', `${BASE}:${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })

const lines = (src, a, b) => src.split('\n').slice(a - 1, b).join('\n')
// a top-level statement starting at a line: until its brackets close
function statementAt(src, line) {
  const all = src.split('\n')
  let depth = 0, out = []
  for (let i = line - 1; i < all.length; i++) {
    const l = all[i]
    out.push(l)
    for (const ch of l.replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '')) {
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
    }
    if (depth <= 0 && /[)\]}'"`/\w]\s*$/.test(l)) break
  }
  return out.join('\n')
}
const declAt = (src, name) => {
  const i = src.split('\n').findIndex((l) => new RegExp(`^(export )?const ${name} =`).test(l))
  if (i < 0) throw new Error(`${name} not found in ${BASE}`)
  return statementAt(src, i + 1).replace(/^export /, '')
}
// the condition of an `if (…) {` line
const condAt = (src, line) => {
  const l = src.split('\n')[line - 1].trim()
  if (!l.startsWith('if (') || !l.endsWith(') {')) throw new Error(`line ${line} of ${BASE} is not an if: ${l.slice(0, 60)}`)
  return l.slice(4, -3)
}

let gen = null
async function generated() {
  if (gen) return gen
  const agent = show('server/lib/agent.js')
  const work = show('server/lib/folders/work.js')
  const tf = show('server/lib/folders/threadFolders.js')
  const office = show('server/lib/office.js')
  const panels = show('server/lib/panelApps/service.js')
  const skills = show('server/lib/folders/skills.js')
  const improve = show('server/lib/improve/service.js')
  const team = show('server/lib/team.js')
  const scheduleIntent = show('server/lib/scheduleIntent.js')
  const names = ['SKILL_REQUEST_EN', 'PANEL_REQUEST_EN', 'RECURRING', 'SITE_ACTION', 'DOC_REQUEST', 'DOC_REQUEST_EN', 'PROCESS_REQUEST_EN', 'IMPROVE_Q', 'IMPROVE_Q_EN', 'PANEL_WORDS', 'PANEL_WORDS_EN', 'CONNECTOR_HINTS', 'ROUTER_TOOLS', 'ARG_EN', 'PERSONA', 'PERSONA_EN']
  const ctx = 'const { namedApp, user, threadId, files, userId, doc, siteUrl, connectorFirst, generationPending, liveOpen } = c'
  const mod = [
    `import { isEn } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/lib/lang.js')).href)}`,
    `import { wantsRunNow } from './scheduleIntent.mjs'`,
    ...names.map((n) => declAt(agent, n)),
    lines(agent, 166, 172), // routerTools
    // folders/work.js: EDIT, EDIT_EN, words, folderMatch; the skill branch's word test
    declAt(work, 'EDIT'), declAt(work, 'EDIT_EN'), declAt(work, 'words'), statementAt(work, 57),
    `export const saysSkill = (text) => (${condAt(work, 38)})`,
    // (line 36 of work.js returns early unless one of the two edit patterns matches)
    `export const edits = (text) => EDIT.test(text) || EDIT_EN.test(text)`,
    // folders/threadFolders.js: CHANGE … asksChange, folderTarget
    lines(tf, 26, 48),
    // office.js: craftAppsFor
    lines(office, 119, 156),
    // panelApps/service.js: titleIn
    lines(panels, 259, 268),
    // folders/skills.js privateSkillFor's test
    `export function ownSkill(mine, t) { ${lines(skills, 175, 175)}; return hit || null }`,
    // improve/service.js resolveProcess's matching
    `export function resolveProcessIn(rows, k) { ${lines(improve, 283, 286).replace(/^\s*return /m, 'return ')} }`,
    // team.js resolveMember's name matching
    `export function memberIn(team, text) { ${lines(team, 108, 109).replace('return null', 'return null')}; ${lines(team, 111, 113).replace('if (hit) return { ...hit, via: \'name\' }', 'if (hit) return hit')}; return { s } }`,
    // agent.js handleTurn's conditions, line by line
    ...[225, 234, 265, 277, 287, 293, 301, 307].map((n) => `export async function c${n}(text, c) { ${ctx}; return (${condAt(agent, n)}) }`),
    `export const strayPanel = (text) => !PANEL_WORDS.test(text) && !PANEL_WORDS_EN.test(text)`,
    `export { ${names.join(', ')}, routerTools }`,
  ].join('\n\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-legacy-'))
  fs.writeFileSync(path.join(dir, 'legacy-gen.mjs'), mod)
  fs.writeFileSync(path.join(dir, 'scheduleIntent.mjs'), scheduleIntent)
  const G = await import(pathToFileURL(path.join(dir, 'legacy-gen.mjs')).href)
  const SI = await import(pathToFileURL(path.join(dir, 'scheduleIntent.mjs')).href)
  gen = { G, SI, dir }
  return gen
}

const TELEGRAM = { alerts: 'alerts_on', off: 'alerts_off', send: 'send_last_answer', connect: 'connect' }
const TOOL = { process: 'process-work', browser_task: 'browser-task', schedule_task: 'schedule-create', run_schedule_now: 'schedule-run-now', notify_member: 'teammate-notify', create_panel: 'panel-create', panel_record: 'panel-record', add_action: 'home-action-add' }

// The old hints (agent.js:317-322 and their builders), from a state's facts — the same wording
function hints(f) {
  const skillHint = f.agentSkills.length ? `\n${L('사용 가능한 스킬(주기 작업에 쓸 수 있음)', 'Available skills (usable for recurring tasks)')}: ${f.agentSkills.map((k) => `${k.name} — ${k.description.slice(0, 80)}`).join(' / ')}` : ''
  const processHint = f.processes.length ? `\n${L('주기적으로 시작할 수 있는 프로세스', 'Processes that can be started on a schedule')}: ${f.processes.map((d) => `${d.id} — ${d.name}${d.startKeys?.length ? L(` (첫 단계 입력: ${d.startKeys.join(', ')})`, ` (first-step inputs: ${d.startKeys.join(', ')})`) : ''}`).join(' / ')}` : ''
  const teamHint = f.team.length ? `\n${L('팀원(알림 대상)', 'Teammates (can be notified)')}: ${f.team.map((m) => `${m.name}${m.roles?.length ? `(${m.roles.join(', ')})` : ''}`).join(', ')}` : ''
  const appHint = f.apps.length ? `\n${L('사용자의 패널 앱(행 추가·수정은 panel_record)', "The user's panel apps (add/change rows with panel_record)")}: ${f.apps.map((a) => `${a.title} [${a.fields}]`).join(' / ')}` : ''
  const schedHint = f.schedules.length ? L(`\n내 예약 작업(지금 한 번 실행은 run_schedule_now, 새 예약이 아님): ${f.schedules.slice(0, 12).map((s) => `${s.id} ${s.name}${s.paused ? '(멈춤)' : ''}`).join(' / ')}`, `\nMy scheduled tasks (run one now with run_schedule_now, not a new schedule): ${f.schedules.slice(0, 12).map((s) => `${s.id} ${s.name}${s.paused ? ' (paused)' : ''}`).join(' / ')}`) : ''
  return { skillHint, processHint, teamHint, appHint, schedHint }
}

// one message, decided the old way: { route, args, via, timings }
export async function legacyDecide({ text, messages, facts: f, llm = chat, model = config.llm.fastModel, now = new Date() }) {
  const { G, SI } = await generated()
  const files = f.files || []
  const generationPending = () => !!f.generation
  // the old context carried "(첨부: …)" for attachments
  const recentIds = (f.recentFull || f.recentSchedules || [])
  const sched = f.schedules.map((s) => ({ id: s.id, name: s.name, paused: s.paused }))
  const c = { user: {}, threadId: 't', files, userId: 'u', doc: f.openDoc, generationPending, liveOpen: () => null, craftAppsFor: G.craftAppsFor }
  // (connectorFirst: no connector is connected in these states, so only "no panel apps" lets it through)
  c.connectorFirst = async (_u, t) => G.CONNECTOR_HINTS.some(([re]) => re.test(t)) && !f.apps.length
  if (await G.c225(text, c)) return { route: 'delegate', via: 'skill-words' }
  if (await G.c234(text, c)) return { route: 'panel-create', via: 'panel-words' }
  const namedApp = f.apps.filter((a) => G.titleIn(a.title, text)).sort((a, b) => b.title.length - a.title.length)[0] || null
  c.namedApp = namedApp
  const blocked = !!f.noFolder || !!namedApp || generationPending() || !!files.length
  let named = null
  if (!blocked && G.edits(text)) {
    if (G.saysSkill(text)) {
      const norm = (x) => String(x).toLowerCase().replace(/[-_\s]+/g, '')
      const hit = f.folders.filter((x) => x.kind === 'skill' && norm(text).includes(norm(x.name))).sort((a, b) => b.name.length - a.name.length)[0]
      if (hit) named = hit
    }
    named ||= G.folderMatch(text, f.folders.filter((x) => x.kind === 'managed'))
  }
  const link = f.attachedFolder ? { mode: 'ref', folder_id: 'att', slug: f.attachedFolder.slug, name: f.attachedFolder.name } : null
  const target = G.folderTarget({ link, named, text, blocked, canChange: !!f.attachedFolder?.canChange })
  if (target) return { route: 'folder-change', args: { folder: target.attached ? 'attached' : target.slug }, via: 'folder-words' }
  if (!generationPending() && G.ownSkill(f.mySkills.map((k) => ({ skill_name: k.name })), text)) return { route: 'delegate', via: 'own-skill-words' }
  if (await G.c265(text, c)) {
    const s = SI.pickSchedule(sched, text, recentIds, { only: false })
    if (s) return { route: 'schedule-run-now', args: { schedule: s.id }, via: 'run-now-words' }
  }
  const tg = !files.length ? SI.telegramIntent(text) : null
  if (tg) {
    const s = SI.pickSchedule(sched, text, recentIds, { only: false })
    if ((tg === 'alerts' || tg === 'off') && !s) return { route: sched.length ? 'ask' : 'telegram-delivery', args: { action: TELEGRAM[tg] }, via: 'telegram-words' }
    return { route: 'telegram-delivery', args: { action: TELEGRAM[tg], ...(s ? { schedule: s.id } : {}) }, via: 'telegram-words' }
  }
  if (await G.c277(text, c)) return { route: 'delegate', via: 'connector-words' }
  if (generationPending()) return { route: 'delegate', via: 'generation' }
  if (await G.c287(text, c)) return { route: 'delegate', via: 'craft-words' }
  if (await G.c293(text, c)) {
    const p = G.resolveProcessIn(f.improvable, text)
    if (p) return { route: 'process-improve-explain', args: { process: p.id }, via: 'improve-words' }
  }
  if (await G.c301(text, c)) return { route: 'delegate', via: 'doc-words' }
  c.siteUrl = /https?:\/\/[^\s)'"]+/i.exec(text)?.[0]
  if (await G.c307(text, c)) return { route: 'browser-task', via: 'site-words' }
  // the old router call
  const h = hints(f)
  const tools = G.routerTools(h.appHint ? G.ROUTER_TOOLS : G.ROUTER_TOOLS.filter((t) => t.function.name !== 'panel_record'))
  const nowS = now.toLocaleString(locale(), { timeZone: 'Asia/Seoul' })
  const t0 = Date.now()
  const route = await llm({ model, temperature: 0, tools, messages: [
    { role: 'system', content: isEn()
      ? G.PERSONA_EN.replace('{now}', nowS) + h.skillHint + h.processHint + h.teamHint + h.appHint + h.schedHint + '\nCall a tool only when a specific tool is needed; for any other question, document writing, analysis or work, answer with the single word "DELEGATE" and no tool.'
      : G.PERSONA.replace('{now}', nowS) + h.skillHint + h.processHint + h.teamHint + h.appHint + h.schedHint + '\n특정 도구가 필요할 때만 도구를 호출하고, 그 외 질문·문서작성·분석·업무 처리는 도구 없이 "DELEGATE" 한 단어만 답해.' },
    ...messages.slice(-8)] })
  const timings = { stage1: Date.now() - t0 }
  const call = route.tool_calls?.[0]
  if (!call || (call.function.name === 'create_panel' && G.strayPanel(text))) return { route: 'delegate', via: call ? 'stray-panel' : 'router', timings }
  let args = {}
  try { args = JSON.parse(call.function.arguments || '{}') } catch { /* none */ }
  const name = TOOL[call.function.name] || 'delegate'
  if (name === 'schedule-run-now') {
    const s = sched.find((x) => x.id === args.schedule || (String(args.schedule || '').length >= 8 && x.id.startsWith(String(args.schedule || '')))) || SI.pickSchedule(sched, `${args.schedule || ''} ${text}`, recentIds)
    return s ? { route: name, args: { schedule: s.id }, via: 'router', timings } : { route: 'ask', via: 'router-run-now-unresolved', timings }
  }
  if (name === 'panel-record') {
    const app = f.apps.find((a) => a.title === args.app) || f.apps.filter((a) => G.titleIn(a.title, `${args.app} ${text}`))[0]
    return { route: name, args: { ...(app ? { app: app.id } : {}), action: args.action }, via: 'router', timings }
  }
  if (name === 'teammate-notify') {
    const m = G.memberIn(f.team, args.member)
    const role = !m?.name ? f.team.find((x) => (x.roles || []).some((r) => r.toLowerCase() === String(m?.s || '').toLowerCase() || String(m?.s || '').toLowerCase().includes(r.toLowerCase()))) : null
    return { route: name, args: { ...(m?.name ? { member: m.name } : role ? { member: role.name } : {}) }, via: 'router', timings }
  }
  if (name === 'process-work') {
    let process
    if ((args.intent === 'start' || args.intent === 'view') && f.processes.length) {
      const m = await llm({ model, temperature: 0, json: true, messages: [
        { role: 'system', content: 'Pick the process the user means. Reply JSON {"id": "<id or null>"}' },
        { role: 'user', content: `${L('요청', 'Request')}: ${args.query || ''}\n\n${L('목록', 'List')}:\n${f.processes.map((d) => `${d.id} | ${d.name}`).join('\n')}` }] }).catch(() => null)
      try { process = f.processes.find((d) => d.id === JSON.parse(m.content).id)?.id } catch { /* none */ }
    }
    return { route: name, args: { intent: args.intent, ...(process ? { process } : {}) }, via: 'router', timings }
  }
  return { route: name, args: {}, via: 'router', timings }
}
