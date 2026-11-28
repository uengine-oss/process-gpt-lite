// 지킴이(lib/planGuard.js) — 한 턴에 몇 번 부르나 · 토큰과 비용 · 얼마나 맞나, 그리고 더 싼 설정. 서버를 띄우지 않고 planGuard.js 만
// 불러(server/index.js · agent.js 는 불러오지 않음) deepagents 스트림 모양의 턴 기록을 createGuard 에 흘려 넣는다.
//   시간: node:test 의 가상 시계(setTimeout · Date) — 도구 하나 = 모델 생각 7 초 + 도구 실행(종류별 1.5~12 초), 확인 한 번 5 초(끝 확인 6 초).
//     15 초 간격(GAP_MS) · 도구 4 개마다(EVERY_TOOLS)는 운영 기본값 그대로. MAX_CHECKS 는 잰 때 6 이었고(2026-11-28), 이 결과로 3 으로 줄였다.
//   확인 시점과 그때의 프롬프트는 가짜 모델(늘 「벗어나지 않음」)로 먼저 정하고, 실제 모델에는 그 프롬프트를 그대로 보낸다 —
//     멈추기 전까지의 확인은 판정에 따라 달라지지 않으므로 실시간으로 돌린 것과 같다(첫 멈춤에서 턴이 끝남).
//   plan_todos: 운영 deepagents(claude-opus-5-5)에는 write_todos 도구가 없어(프로세스 생성 때만 옴) 기본은 빼고, --todos 로 넣는다.
// 키는 PLAN_GUARD_ENV 의 .env 에서 PRO_LLM_* 만 읽고 출력하지 않는다.
//   cd server/eval/planGuard && PLAN_GUARD_ENV=<.env> node measure.mjs calls|cost|accuracy [--todos] [--out <dir>]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mock } from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '../..')
const args = process.argv.slice(2)
const MODE = args[0] || 'calls'
const WITH_TODOS = args.includes('--todos')
const OUT = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : path.join(HERE, 'out') })()
fs.mkdirSync(path.join(OUT, '_variants'), { recursive: true })

// ---------- keys (read, never printed) ----------
if (process.env.PLAN_GUARD_ENV) {
  const env = Object.fromEntries(fs.readFileSync(process.env.PLAN_GUARD_ENV, 'utf8').split('\n')
    .filter((l) => /^PRO_LLM_(BASE_URL|API_KEY|MODEL|FAST_MODEL|FRONT_MODEL)=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  Object.assign(process.env, env)
}
process.env.PRO_LLM_KEYS = 'off'
process.env.PRO_PLAN_GUARD = 'on'

// ---------- every model call's usage (the response's own usage block), by the call that made it ----------
const als = new AsyncLocalStorage()
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const tag = als.getStore()
  const t0 = performance.now()
  const res = await realFetch(url, init)
  if (tag && /\/chat\/completions$/.test(String(url))) {
    tag.http = (tag.http || 0) + 1
    if (res.ok) { try { const j = await res.clone().json(); tag.usage = j.usage || null; tag.served = j.model || null; tag.httpMs = performance.now() - t0 } catch { /* not JSON */ } }
  }
  return res
}

const PG = await import('../../lib/planGuard.js')
const { config } = await import('../../config.js')
const { chatJson } = await import('../../lib/llm.js')
const { createTrail } = await import('../../lib/workTrail.js')

// ---------- copies of the small helpers agent.js / turnPlan.js use (those modules pull the database and the server in) ----------
// lib/turnPlan.js todosOf
function todosOf(list) {
  return (list || []).slice(0, 20).map((t, i) => {
    const text = String(t.content ?? t.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    const s = String(t.status ?? t.state ?? '').toLowerCase()
    const state = ['completed', 'complete', 'done'].includes(s) ? 'done' : ['in_progress', 'in-progress', 'active', 'running'].includes(s) ? 'active' : 'pending'
    return { id: `t${i + 1}`, text, state }
  }).filter((t) => t.text)
}
// lib/turnPlan.js bookkeeping · lib/agent.js toolPhase (Korean)
const bookkeeping = (tool) => /^(write_todos|think|todo)/i.test(String(tool || ''))
const PHASES = [
  [/^cadcraft_/, '도면 그리는 중'], [/^vectorcraft_/, '그림 만드는 중'], [/^photocraft_/, '이미지 편집하는 중'],
  [/^soundcraft_/, '소리 만드는 중'], [/^filmcraft_/, '영상 편집하는 중'], [/^folder_/, '폴더 살펴보는 중'],
  [/^office_live_(read|documents)|^office_guide/, '문서 읽는 중'], [/^office_live_/, '문서 고치는 중'],
  [/hwpx|docx|pptx|xlsx|office|document|render_hwp/i, '문서 만드는 중'], [/panel/i, '패널 만드는 중'],
  [/^send_mail_as_me$/, '보낼 메일 준비하는 중'], [/gmail|mail/i, '메일 확인하는 중'], [/calendar/i, '일정 확인하는 중'], [/youtube/i, '영상 정보 찾는 중'],
  [/slack|notion|github|drive/i, '연결된 서비스 확인하는 중'], [/search|web|fetch|browse|tavily/i, '찾아보는 중'],
  [/^(ls|glob|grep|read_file|read)$/i, '파일 살펴보는 중'], [/^(write_file|edit_file|write|edit)$/i, '파일 쓰는 중'],
  [/execute|shell|bash|python|run_code/i, '실행하는 중'], [/^task$|subagent/i, '나눠서 일하는 중'], [/todo/i, '할 일 정리하는 중'],
  [/process|bpmn|instance|workitem/i, '프로세스 확인하는 중'], [/skill/i, '스킬 쓰는 중'],
]
const toolPhase = (tool) => (PHASES.find(([re]) => re.test(String(tool || ''))) || [null, '작업하는 중'])[1]

// ---------- the virtual clock ----------
const THINK_MS = 7000, TODO_MS = 4000, ANSWER_MS = 15000, CHECK_LAT = 5000, FINAL_LAT = 6000
const DUR = (tool) => /office_create|hwpx|pptx|docx|xlsx/.test(tool) ? 12000 : /execute/.test(tool) ? 6000 : /fetch/.test(tool) ? 4000 : /search|drive|gmail|notion/.test(tool) ? 2500 : 1500
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)) }
async function advance(ms) { for (let left = ms; left > 0; left -= 100) { mock.timers.tick(Math.min(100, left)); await flush() } }
async function until(p) { let done = false; p.finally(() => { done = true }).catch(() => {}); while (!done) await advance(100); return p }

// a variant of planGuard.js (a trigger left out), written beside the results; the file itself is never changed
const PG_SRC = path.join(SERVER, 'lib/planGuard.js')
const NO_NOTE = ["notes.shift(); check('note') }", 'notes.shift() }']
const NO_FILE = ["if (files.length === 1) check('file')", '']
async function variantModule(name, patches) {
  if (!patches.length) return PG
  let src = fs.readFileSync(PG_SRC, 'utf8')
  for (const m of ['../config.js', './llm.js', './lang.js']) src = src.replace(`from '${m}'`, `from '${pathToFileURL(path.resolve(SERVER, 'lib', m)).href}'`)
  for (const [a, b] of patches) { if (!src.includes(a)) throw new Error(`variant ${name}: «${a}» is not in planGuard.js any more`); src = src.replace(a, b) }
  const file = path.join(OUT, '_variants', `planGuard.${name}.mjs`)
  fs.writeFileSync(file, src)
  return import(pathToFileURL(file).href)
}
// the settings compared (every one without plan_todos unless --todos): what each leaves out
const VARIANTS = [
  { name: 'prod', note: '운영 기본값: 첫 파일 · 도구 4개마다 · 중간 글 · (할 일 변경) + 끝, 6번까지 15초 간격', patches: [], opts: {} },
  { name: 'no-note', note: '중간 글에서는 확인하지 않음', patches: [NO_NOTE], opts: {} },
  { name: 'every8', note: '도구 8개마다', patches: [], opts: { every: 8 } },
  { name: 'max3', note: '중간 확인 3번까지', patches: [], opts: { max: 3 } },
  { name: 'no-note-max3', note: '중간 글 확인 없음 + 3번까지', patches: [NO_NOTE], opts: { max: 3 } },
  { name: 'file+final', note: '첫 파일과 끝만(중간 글 · 도구 수 확인 없음; 할 일 변경은 있으면 남음)', patches: [NO_NOTE], opts: { every: 1e9 } },
  { name: 'final-only', note: '끝 확인만(운영엔 할 일 목록이 없으니 「할 일 변경 + 끝」과 같음)', patches: [], opts: { max: 0 } },
]

// One turn through createGuard on the virtual clock, the model faked as "not off": when each check runs and with what prompt.
// → [{final, why, at (s), system, user}]
async function schedule(mod, c, opts = {}, { todos = WITH_TODOS } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const t0 = Date.now()
  const prompts = []
  const whys = []
  const log = console.log
  console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[plan-guard]')) whys.push(s.split(' ')[1]); else log(...a) }
  try {
    const view = { plan: { understood: c.understood, steps: c.steps.map((text, i) => ({ id: `p${i + 1}`, text })), source: 'front' }, todos: [], notes: [], ended: null }
    const ask = (system, user, o) => new Promise((res) => {
      prompts.push({ final: o.maxTokens === 1200, at: (Date.now() - t0) / 1000, system, user })
      setTimeout(() => res({ off: false, step: 0, kind: 'none', what: '', question: '', options: [], confidence: 0.05, steps: c.steps.map((_, i) => ({ n: i + 1, state: 'done' })) }), o.maxTokens === 1200 ? FINAL_LAT : CHECK_LAT)
    })
    const g = mod.createGuard({ view, request: c.request, ask, enabled: true, ...opts })
    const trail = createTrail(30)
    let note = null
    for (const e of c.events) {
      if (e.todos) {
        if (!todos) continue
        await advance(TODO_MS)
        const list = todosOf(e.todos.map(([content, status]) => ({ content, status })))
        view.todos = list
        g.todos(list)
      } else if (e.note) note = e.note
      else if (e.tool) {
        await advance(THINK_MS)
        // (agent.js: the text before a tool is cut into a note at its tool_start, before the tool is recorded)
        if (note) { g.note(note); note = null }
        const phase = toolPhase(e.tool)
        const entry = trail.add(e.tool, e.in, phase)
        if (!bookkeeping(e.tool)) g.tool(entry || { tool: e.tool, phase })
        if (e.noEnd) break
        await advance(e.dur ?? DUR(e.tool))
        if (!bookkeeping(e.tool)) g.result(e.out, e.tool)
      } else if (e.file) g.file(e.file)
    }
    // (text after the last tool is the answer, not a note)
    await advance(ANSWER_MS)
    g.close()
    await until(g.settle())
    if (!c.hitl && g.canSettle()) await until(g.final(c.answer))
  } finally {
    console.log = log
    mock.timers.reset()
  }
  prompts.forEach((p, i) => { p.why = p.final ? 'final' : whys[i] || '?' })
  return prompts
}

// ---------- the real model ----------
const cache = new Map()
// the guard asks for 700 (mid) / 1200 (end) tokens; production's litellm-proxy hook raises any limit under 2048 to 2048 for Claude 5.5
// (its thinking counts in it). The company gateway model thinks too and runs out of 700 often, so it is measured at the production
// limit; codeCut says whether the answer would have been cut off at the code's own limit.
const MAX_TOKENS = Number(process.env.GUARD_MAX_TOKENS) || 2048
const reasoningOf = (u) => u?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens ?? 0
let calls = 0, failures = 0
const hash = (p) => crypto.createHash('sha1').update(p.system + '\n\u0000' + p.user).digest('hex').slice(0, 16)
async function judge(p, run) {
  const key = `${run}|${hash(p)}`
  if (cache.has(key)) return cache.get(key)
  const job = (async () => {
    if (failures >= 5) throw new Error('stopped: 5 model calls failed')
    const tag = {}
    const t0 = performance.now()
    calls++
    let j = null, err = null
    try {
      j = await als.run(tag, () => chatJson(p.system, p.user, { model: config.llm.frontModel, temperature: 0, timeoutMs: 120000, maxTokens: MAX_TOKENS, effort: 'low' }))
    } catch (e) { err = String(e.message || e).slice(0, 200); failures++ }
    const v = j ? PG.readVerdict(j, 0) : null
    return { key, final: p.final, why: p.why, v, raw: j, err, ms: Math.round(performance.now() - t0), usage: tag.usage || null, reasoning: reasoningOf(tag.usage), codeCut: (tag.usage?.completion_tokens || 0) > (p.final ? 1200 : 700), http: tag.http || 0, served: tag.served || null, userChars: p.user.length, systemChars: p.system.length }
  })()
  cache.set(key, job)
  return job
}
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } }))
  return out
}
// a turn's decision: the first mid check at or over the bar stops the run (later checks never happen); else the end check's
async function decide(prompts, run) {
  const seen = []
  for (const p of prompts) {
    const r = await judge(p, run)
    seen.push(r)
    if (PG.stops(r.v)) return { stop: true, at: p.final ? 'final' : `mid:${p.why}@${p.at.toFixed(0)}s`, verdict: r.v, seen }
  }
  return { stop: false, at: null, verdict: null, seen }
}

// ---------- realistic turn shapes (calls per turn, cost) ----------
function shapeTurn(name) {
  const kinds = {
    light: ['gmail_search', 'gmail_read'],
    research: ['web_search', 'fetch_url', 'fetch_url', 'web_search', 'fetch_url', 'web_search', 'fetch_url', 'fetch_url', 'web_search', 'write_file'],
    doc: ['google_drive_search', 'google_drive_read', 'google_drive_read', ...Array(6).fill(['web_search', 'fetch_url']).flat(), 'execute', 'execute', 'execute',
      'office_create_docx', 'office_live_read', 'office_create_xlsx', 'office_live_read', 'office_create_pptx', 'office_live_read', 'office_create_docx'],
    long: ['google_drive_search', 'google_drive_read', 'google_drive_read', ...Array(10).fill(['web_search', 'fetch_url', 'fetch_url']).flat(), 'read_file', 'read_file', 'grep', 'read_file', 'grep', 'read_file',
      ...Array(8).fill('execute'), 'write_file', 'office_create_docx', 'write_file', 'office_create_xlsx', 'write_file', 'office_create_pptx', 'office_live_read', 'edit_file', 'office_live_read', 'edit_file', 'office_live_read', 'edit_file', 'edit_file'],
  }[name]
  const steps = { light: ['메일함에서 견적 메일 찾기', '총액·납기 알려 드리기'], research: ['자료 찾기', '수치·출처 대조', '요약 md 작성', '결과 전달'],
    doc: ['드라이브에서 지난 분기 자료 찾기', '시장 자료 조사', '수치 분석', '보고서 · 표 · 발표 자료 만들기', '결과 전달'],
    long: ['드라이브에서 기존 자료 찾기', '경쟁사 · 시장 조사', '내부 자료 분석', '분석 실행', '문서 3종 만들기', '검토 · 다듬기'] }[name]
  const moves = { light: [1], research: [4, 8], doc: [8, 15, 21], long: [6, 15, 25, 36, 44, 52] }[name]
  const sample = (tool, i) => {
    if (/search/.test(tool)) return { in: { query: `${['협동로봇', '스마트팩토리', 'MES 도입', '설비 예지보전', '공정 자동화'][i % 5]} 시장 동향 ${2024 + (i % 3)}` },
      out: JSON.stringify([{ title: `${i}번째 결과 — 산업 동향 보고서`, url: `https://www.example-news${i % 4}.co.kr/article/${1000 + i}`, snippet: '국내 제조업의 자동화 투자가 늘면서 관련 시장이 연평균 10% 넘게 성장하고 있다는 분석이 나왔다 …' }, { title: '정부 지원 사업 안내', url: `https://www.kiria.org/notice/${i}` }]) }
    if (/fetch/.test(tool)) return { in: { url: `https://www.example-news${i % 4}.co.kr/article/${1000 + i}` }, out: `<html><head><title>산업 동향</title></head><body><article>${'국내 제조 현장의 자동화 수요가 커지고 있다. 업계는 내년 시장 규모가 크게 늘 것으로 본다. '.repeat(30)}</article></body></html>` }
    if (/drive_search/.test(tool)) return { in: { query: '2026 3분기 실적' }, out: JSON.stringify([{ id: '1aQ', name: '2026 3분기 실적.xlsx', modified: '2026-10-08' }, { id: '1bR', name: '2026 2분기 실적.xlsx' }]) }
    if (/drive_read|read_file|folder_read/.test(tool)) return { in: { file_id: `f${i}` }, out: JSON.stringify({ rows: Array.from({ length: 30 }, (_, k) => [`항목${k}`, 1000 + k * 37, 900 + k * 29]) }) }
    if (/gmail_search/.test(tool)) return { in: { query: 'from:gana-precision.co.kr 견적' }, out: '[{"id":"18c2a","subject":"[견적] 정밀 가공 부품 3종 견적서 송부","date":"2026-11-20"}]' }
    if (/gmail_read/.test(tool)) return { in: { id: '18c2a' }, out: '{"body":"합계 18,450,000원(VAT 별도), 납기는 발주 후 4주입니다. 상세 단가는 첨부 견적서를 확인해 주세요."}' }
    if (/grep/.test(tool)) return { in: { pattern: '매출|영업이익' }, out: Array.from({ length: 12 }, (_, k) => `${k * 7}: 매출 ${k}분기 …`).join('\n') }
    if (/execute/.test(tool)) return { in: { command: `python3 /workspace/.tmp/a${i}.py` }, out: Array.from({ length: 10 }, (_, k) => `사업부${k}  ${3000 + k * 120}  ${3200 + k * 110}  +${(k % 7) + 1}.${k}%`).join('\n') }
    if (/office_create/.test(tool)) return { in: { file_name: `보고서_${i}.${tool.split('_').pop()}` }, out: `{"ok":true,"file":"보고서_${i}.${tool.split('_').pop()}","pages":6}`, file: `보고서_${i}.${tool.split('_').pop()}` }
    if (/office_live_read/.test(tool)) return { in: { file_name: `보고서_${i - 1}` }, out: '{"headings":["1. 요약","2. 시장","3. 실적","4. 시사점"]}' }
    if (/write_file/.test(tool)) return { in: { file_path: `/workspace/정리_${i}.md` }, out: `Updated file /workspace/정리_${i}.md`, file: `정리_${i}.md` }
    if (/edit_file/.test(tool)) return { in: { file_path: `/workspace/정리_${i}.md` }, out: 'Successfully replaced 2 instance(s)' }
    return { in: {}, out: 'ok' }
  }
  const NOTES = ['먼저 관련 자료부터 찾아볼게요.', '찾은 자료를 하나씩 읽어 볼게요.', '수치를 맞춰 보려고 표로 계산해 볼게요.', '이제 문서로 정리할게요.', '만든 문서가 제대로 열리는지 확인할게요.', '빠진 출처가 없는지 한 번 더 볼게요.']
  const todoList = (done) => steps.map((s, k) => [s, k < done ? 'completed' : k === done ? 'in_progress' : 'pending'])
  const events = [{ todos: todoList(0) }]
  kinds.forEach((tool, i) => {
    if (moves.includes(i)) events.push({ todos: todoList(moves.indexOf(i) + 1) })
    if (i % 3 === 0) events.push({ note: NOTES[(i / 3) % NOTES.length], chatty: true })
    const s = sample(tool, i)
    events.push({ tool, in: s.in, out: s.out })
    if (s.file) events.push({ file: s.file })
  })
  const answer = `${steps.map((s, k) => `${k + 1}. ${s} — 마쳤어요.`).join('\n')}\n\n${'요청하신 내용을 자료 기준으로 정리했어요. 수치와 출처는 문서 안에 모두 달았어요. '.repeat(name === 'light' ? 1 : 12)}`
  return { id: name, request: { light: '지난주 가나정밀 견적 메일 찾아서 총액이랑 납기만 알려 줘', research: '국내 협동로봇 시장 규모를 최근 3년 자료로 찾아 출처 단 한 쪽 요약 md 로 정리해 줘',
    doc: '드라이브의 지난 분기 실적 자료와 시장 자료로 3분기 경영 보고서(워드) · 실적 표(엑셀) · 발표 자료(파워포인트)를 만들어 줘',
    long: '드라이브의 기존 자료와 경쟁사 조사를 바탕으로 내년 사업 계획 초안 문서 3종을 만들고 검토해서 다듬어 줘' }[name],
    understood: '요청하신 자료로 정리해 드릴게요.', steps, events, answer, tools: kinds.length, files: events.filter((e) => e.file).length }
}
const SHAPES = ['light', 'research', 'doc', 'long']
const quiet = (t) => ({ ...t, events: t.events.filter((e) => !e.chatty) })

// ---------- modes ----------
const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8')).cases
const save = (name, data) => fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 1))
const count = (ps) => { const by = {}; for (const p of ps) by[p.why] = (by[p.why] || 0) + 1; return by }

async function callsMode() {
  const rows = []
  for (const v of VARIANTS) {
    const mod = await variantModule(v.name, v.patches)
    for (const s of SHAPES) for (const narr of ['quiet', 'chatty']) for (const todos of [false, true]) {
      const t = narr === 'quiet' ? quiet(shapeTurn(s)) : shapeTurn(s)
      const ps = await schedule(mod, t, v.opts, { todos })
      rows.push({ variant: v.name, shape: s, tools: t.tools, files: t.files, narr, todos, checks: ps.length, mid: ps.filter((p) => !p.final).length, by: count(ps), at: ps.map((p) => Math.round(p.at)),
        maxUserChars: Math.max(0, ...ps.map((p) => p.user.length)), sumChars: ps.reduce((a, p) => a + p.user.length + p.system.length, 0) })
    }
  }
  // and with no gap or limit: how many triggers a turn would fire if each one were a call
  for (const s of SHAPES) for (const narr of ['quiet', 'chatty']) {
    const t = narr === 'quiet' ? quiet(shapeTurn(s)) : shapeTurn(s)
    const ps = await schedule(PG, t, { gap: 0, max: 1e9 }, { todos: false })
    rows.push({ variant: 'no-gap-no-max', shape: s, tools: t.tools, files: t.files, narr, todos: false, checks: ps.length, mid: ps.filter((p) => !p.final).length, by: count(ps) })
  }
  save('calls.json', rows)
  const line = (r) => `${r.variant.padEnd(14)} ${r.shape.padEnd(9)} ${String(r.tools).padStart(3)} tools ${r.narr.padEnd(6)} todos=${r.todos ? 'y' : 'n'} → ${String(r.checks).padStart(2)} calls (mid ${r.mid}) ${JSON.stringify(r.by)}`
  console.log(rows.map(line).join('\n'))
}

async function costMode() {
  // the prompts the production settings send on the four shapes (no todos; quiet and chatty), each sent once
  // (with --todos the with-todos schedules are sent instead; the per-check size barely changes, so the count from `calls` × the
  // per-check tokens here is enough for that column)
  const runs = []
  for (const s of SHAPES) for (const narr of ['quiet', 'chatty']) for (const todos of [WITH_TODOS]) {
    const t = narr === 'quiet' ? quiet(shapeTurn(s)) : shapeTurn(s)
    runs.push({ shape: s, narr, todos, prompts: await schedule(PG, t, {}, { todos }) })
  }
  // the largest a prompt can get: 16 tools shown with 280-character results, 4 notes, 10 files, a 1,500-character request, 6 steps, a 3,000-character answer
  const big = { request: '가'.repeat(1500), plan: { understood: '나'.repeat(240), source: 'front' }, steps: Array.from({ length: 6 }, (_, i) => ({ text: `${i + 1}단계 `.padEnd(120, '다') })),
    evidence: Array.from({ length: 16 }, (_, i) => ({ tool: 'fetch_url', phase: '찾아보는 중', hosts: ['www.example-news.co.kr'], query: '협동로봇 시장 규모 2025 국내 실태조사 결과 요약', out: PG.excerpt('국내 제조 현장의 자동화 수요가 커지고 있다. '.repeat(40)) })),
    notes: Array.from({ length: 4 }, () => '찾은 자료를 하나씩 읽어 보고 수치를 맞춰 볼게요. '.repeat(10)), files: Array.from({ length: 10 }, (_, i) => `보고서_${i}.docx`) }
  const bigMid = { final: false, why: 'max-size', at: 0, ...PG.guardMessages(big) }
  const bigFinal = { final: true, why: 'max-size', at: 0, ...PG.guardMessages({ ...big, answer: '요청하신 내용을 정리했어요. '.repeat(200), final: true }) }
  const uniq = new Map()
  for (const r of runs) for (const p of r.prompts) uniq.set(hash(p), p)
  uniq.set(hash(bigMid), bigMid); uniq.set(hash(bigFinal), bigFinal)
  console.log(`model ${config.llm.frontModel} · ${uniq.size} prompts`)
  const res = await pool([...uniq.values()], 3, (p) => judge(p, 'cost'))
  const by = new Map(res.map((r) => [r.key.split('|')[1], r]))
  const turns = runs.map((r) => {
    const rs = r.prompts.map((p) => by.get(hash(p)))
    const sum = (f) => rs.reduce((a, x) => a + (f(x) || 0), 0)
    return { shape: r.shape, narr: r.narr, todos: r.todos, checks: rs.length, in: sum((x) => x.usage?.prompt_tokens), out: sum((x) => x.usage?.completion_tokens), reasoning: sum((x) => x.reasoning), codeCut: rs.filter((x) => x.codeCut).length, ms: sum((x) => x.ms), maxMs: Math.max(0, ...rs.map((x) => x.ms)), errors: rs.filter((x) => x.err).length,
      perCheck: rs.map((x) => ({ why: x.why, in: x.usage?.prompt_tokens, out: x.usage?.completion_tokens, reasoning: x.reasoning, ms: x.ms, chars: x.userChars + x.systemChars, codeCut: x.codeCut, err: x.err })) }
  })
  const max = [by.get(hash(bigMid)), by.get(hash(bigFinal))].map((x) => ({ final: x.final, in: x.usage?.prompt_tokens, out: x.usage?.completion_tokens, reasoning: x.reasoning, chars: x.userChars + x.systemChars, ms: x.ms, err: x.err }))
  save('cost.json', { model: config.llm.frontModel, served: res.find((x) => x.served)?.served, calls, failures, turns, max, raw: res.map(({ raw, ...x }) => ({ ...x, off: x.v?.off, confidence: x.v?.confidence })) })
  for (const t of turns) console.log(`${t.shape.padEnd(9)} ${t.narr.padEnd(6)} todos=${t.todos ? 'y' : 'n'} ${String(t.checks).padStart(2)} calls  in ${t.in}  out ${t.out} (reasoning ${t.reasoning})  ${t.ms} ms (max ${t.maxMs}) cut@code ${t.codeCut}${t.errors ? ` errors ${t.errors}` : ''}`)
  console.log('max-size prompt', JSON.stringify(max), `· calls ${calls} failures ${failures}`)
}

async function accuracyMode() {
  // the schedules first (virtual clock), then the model
  const plans = {}
  for (const v of VARIANTS) {
    const mod = await variantModule(v.name, v.patches)
    plans[v.name] = []
    for (const c of cases) plans[v.name].push(await schedule(mod, c, v.opts))
  }
  console.log(`model ${config.llm.frontModel} · todos ${WITH_TODOS ? 'in' : 'left out (production)'} · checks per case (prod): ${plans.prod.map((ps) => ps.length).join(' ')}`)
  if (args.includes('--dry')) { for (const v of VARIANTS) console.log(v.name.padEnd(13), plans[v.name].map((ps, i) => `${cases[i].id}:${ps.map((p) => p.why[0]).join('')}`).join(' ')); return }
  const RUNS = [1, 2]
  const out = {}
  for (const v of VARIANTS) {
    const before = calls
    // (the cheaper settings: run 1 only, reusing run 1's verdicts wherever the prompt is the same)
    const tasks = cases.flatMap((c, i) => (v.name === 'prod' ? RUNS : [1]).map((run) => ({ c, i, run })))
    const ds = await pool(tasks, 4, async ({ c, i, run }) => ({ id: c.id, run, ...(await decide(plans[v.name][i], run)) }))
    out[v.name] = { note: v.note, newCalls: calls - before, checks: plans[v.name].map((ps) => ps.length), decisions: ds }
    console.log(`${v.name}: ${calls - before} new calls (failures ${failures})`)
    if (failures >= 5) break
  }
  // every verdict the model gave (both runs), for the confidence spread and run-to-run agreement
  const all = await Promise.all([...cache.values()])
  save(`accuracy${WITH_TODOS ? '-todos' : ''}.json`, { model: config.llm.frontModel, served: all.find((x) => x.served)?.served, calls, failures, cases: cases.map(({ events, ...c }) => c), schedules: Object.fromEntries(Object.entries(plans).map(([k, v]) => [k, v.map((ps) => ps.map((p) => ({ final: p.final, why: p.why, at: p.at })))])), variants: out,
    verdicts: all.map(({ raw, ...x }) => ({ ...x, what: x.v?.what, kind: x.v?.kind, off: x.v?.off, confidence: x.v?.confidence, steps: raw?.steps })) })
  // ---- summary ----
  const label = Object.fromEntries(cases.map((c) => [c.id, c]))
  const lines = []
  for (const [name, r] of Object.entries(out)) {
    for (const run of RUNS) {
      const ds = r.decisions.filter((d) => d.run === run)
      if (!ds.length) continue
      const tp = ds.filter((d) => d.stop && label[d.id].stop).length, fp = ds.filter((d) => d.stop && !label[d.id].stop).length
      const fn = ds.filter((d) => !d.stop && label[d.id].stop).length
      lines.push(`${name.padEnd(13)} run ${run}: stops ${tp + fp} · TP ${tp} FP ${fp} FN ${fn} · precision ${(tp / Math.max(1, tp + fp)).toFixed(2)} recall ${(tp / Math.max(1, tp + fn)).toFixed(2)} · calls ${r.checks.reduce((a, b) => a + b, 0)} max/turn`)
    }
    const agree = cases.filter((c) => { const [a, b] = RUNS.map((run) => r.decisions.find((d) => d.id === c.id && d.run === run)?.stop); return a === b }).length
    if (name === 'prod') lines.push(`${name.padEnd(13)} same decision in both runs: ${agree}/${cases.length}`)
  }
  for (const d of out.prod?.decisions || []) {
    const c = label[d.id]
    if (d.stop !== c.stop) lines.push(`  ${d.stop ? 'FALSE STOP' : 'MISS'} ${d.id} run ${d.run} ${d.at || ''} — ${d.stop ? `${d.verdict.kind} ${d.verdict.confidence} 「${d.verdict.what}」` : d.seen.map((x) => `${x.why}:${x.v ? `${x.v.off ? 'off' : 'ok'} ${x.v.confidence}` : `err ${x.err}`}`).join(' ')}`)
  }
  save(`accuracy${WITH_TODOS ? '-todos' : ''}.txt`, lines.join('\n'))
  console.log(lines.join('\n'))
  console.log(`calls ${calls} failures ${failures}`)
}

if (MODE === 'calls') await callsMode()
else if (MODE === 'cost') await costMode()
else if (MODE === 'accuracy') await accuracyMode()
else { console.error(`unknown mode ${MODE}`); process.exit(2) }
process.exit(0)
