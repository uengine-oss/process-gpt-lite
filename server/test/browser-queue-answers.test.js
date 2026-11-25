// 기다리는 브라우저 작업과 입력창의 말 · 줄 · 「마치고 해」 · 되풀이하는 일 · 짧은 결과 · 작업에 주는 지시 · 방 규칙 확인
// (2026-11-25 녹화 세 개, 프로젝트 방 「링크 슬라이드 팟캐스트」 — 「계속 이렇게 막히는 문제가 있어 … 여기서 마치고 해라 라고 했는데 마치기
// 전에 자꾸 다음 일을 하려고」 · 「이런거 필요없고 보고싶으면 볼 수 있겠으나」 · 「이걸 안하네요 … 끊김없이 이어져야 됩니다」).
// runTurn(lib/agent.js)부터 실제 Chromium 까지, 모델 없이:
//   · 판정은 가짜 판정 서버(PRO_JUDGE_URL) — 보기 키로 어떤 질문인지 알아보고 시험이 정한 확률을 돌려준다. 무엇을 물었는지도 본다
//   · 라우터 · 계획 · 브라우저 에이전트 · 규칙 받아 적기는 가짜 모델(fetch 가로채기), deepagents 는 빈 응답
//   · 사이트는 test/fixtures/notebooks.mjs(지어낸 노트북 목록 · 노트 사이트)
// 시험 사용자는 무작위 id(로그인 계정 아님), 끝나면 지움. DB 가 없으면 건너뜀.
//   BQ-I-01 기다리는 카드 + 입력창의 답 → 그 카드로(새 작업 없음, 라우터에 가지 않음), 보기와 맞으면 그 보기
//   BQ-I-02 답이 아닌 말 → 새 작업은 줄에 서고 카드가 세 갈래를 보여 줌(첫 단추 = 판정), 「뒤에 줄 서기」 · 「앞 작업 멈추고 이것부터」
//   BQ-I-03 카드의 「이 말을 앞 작업의 답으로」 → 그 말이 앞 작업으로 가고 새 작업은 시작하지 않음
//   BQ-I-04 「작업을 마치고 …」 → ① 멈춘 작업을 그 자리부터 새 한도로 → ② 다음 작업, 답이 순서를 말함
//   BQ-I-05 되풀이하는 삭제는 40번을 넘어 끝까지(진행 중 · N개 처리), 목록이 그대로인 되풀이는 「같은 화면에서 멈춤」
//   BQ-I-06 끝난 작업의 결과 메시지는 한두 줄, 한 일 · 긴 설명은 「자세히」 칸(did · detail)
//   BQ-I-07 기다리는 동안 준 지시(steer) → 그 작업으로, 기다림이 끊기고 다음 턴이 그 말을 읽음, 카드에 「받은 지시」
//   BQ-I-08 방금 끝난 작업이 제안한 다음 일을 시키는 말 → 원래 목표 · 입력 + 그 말로 새 작업 하나
//   BQ-I-09 규칙이 있는 방: 작업이 있을 때 규칙을 정하는 말은 0.85 에서만, 그래도 말없이 바꾸지 않고 확인 카드 — 「이번 작업에만」은 작업으로
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { startNotebooks } from './fixtures/notebooks.mjs'

// ---- the judge: scripted answers by what is asked (its option keys) ----
const judged = { active: [], resume: [], room: [], file: [] }
const judgeCalls = []
const kindOf = (keys) => keys.includes('set_rule') ? 'room' : keys.includes('steer') && keys.includes('replace') ? 'active'
  : keys.includes('none') && keys.some((k) => /^(then|only|more)\d+$/.test(k)) ? 'resume' : keys.includes('none') && keys.some((k) => /^f\d+$/.test(k)) ? 'file'
    : keys.includes('login_needed') ? 'wall' : keys.includes('idle') ? 'busy' : 'other'
const judgeServer = await new Promise((r) => {
  const s = http.createServer((req, res) => {
    if (!req.url.startsWith('/judge')) { req.resume(); res.writeHead(404); return res.end() }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const b = JSON.parse(raw)
      const kind = kindOf(b.options.map((o) => o.key))
      judgeCalls.push({ ...b, kind })
      const p = kind === 'wall' ? { ok: 1 } : kind === 'busy' ? { busy: 1 } : (judged[kind] || []).shift() || (kind === 'room' ? { other: 1 } : ['resume', 'file'].includes(kind) ? { none: 1 } : kind === 'active' ? { other: 1 } : { new: 1 })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ probabilities: p, model: 'scripted' }))
    })
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_JUDGE_URL = `http://127.0.0.1:${judgeServer.address().port}/judge`
process.env.PRO_JUDGE_LLM = '0'
const skillsDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bq-skills-'))
process.env.PRO_BROWSER_SKILLS_DIR = skillsDir
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const R = await import('../lib/roomRules.js')
const up = await q('select 1').then(() => true, () => false)

// ---- the scripted model ----
const realFetch = globalThis.fetch
const routes = [] // the router's browser_task arguments (null: DELEGATE)
const routerCalls = []
const scripts = {} // goal (first line) → moves
const bodies = [] // the browser agent's requests
const titles = {} // goal (first line) → plan title
const actions = []
const json = (v) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })
const answer = (message) => json({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }] })
const call = (name, args) => answer({ content: null, tool_calls: [{ id: `c_${crypto.randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const goalOf = (body) => (/Goal: (.*)/.exec(String(body.messages?.[0]?.content || ''))?.[1] || '').trim()
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.deepagentsUrl)) return json([])
  if (u.startsWith(config.llm.baseUrl)) {
    const body = JSON.parse(opts.body)
    const sys = String(body.messages?.[0]?.content || '')
    if (/Break a web task/.test(sys)) {
      const g = String(body.messages[1].content).split('\n')[0]
      return answer({ content: JSON.stringify({ title: titles[g] || g.slice(0, 30), steps: ['하나', '둘'] }) })
    }
    const names = (body.tools || []).map((t) => t.function.name)
    if (names.includes('browser_task')) {
      routerCalls.push(body)
      const a = routes.shift()
      return a ? call('browser_task', a) : answer({ content: 'DELEGATE' })
    }
    if (names.includes('finish')) {
      bodies.push(body)
      const g = goalOf(body)
      const s = scripts[g]
      if (!s) return call('finish', { summary: '끝.' })
      if (body.tool_choice?.function?.name === 'finish') return call('finish', { summary: s.closing || '끝났어요.' })
      const move = s.moves[Math.min(s.i++, s.moves.length - 1)]
      if (move === 'hang') return new Promise(() => {})
      const [name, args] = typeof move === 'function' ? move(body) : move
      return call(name, args)
    }
    if (body.response_format && sys.includes(R.ruleActionPrompt('').split('\n')[0])) return answer({ content: JSON.stringify(actions.shift() || {}) })
    return answer({ content: 'DELEGATE' })
  }
  if (/\/servers$|\/bindings$/.test(u)) return json([])
  return realFetch(url, opts)
}
const { runTurn } = await import('../lib/agent.js')
const browser = await import('../lib/browser.js')
const { PGPT_ROOT } = await import('../lib/paths.js')

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(80) } }
const stamp = crypto.randomBytes(3).toString('hex')
const user = { id: crypto.randomUUID(), email: `pro-bq-${stamp}@uengine.org`, name: '시험' }
const session = { access_token: 'test-token' }
let site
const threads = []
async function thread(kind = 'project') {
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,$2,'링크 슬라이드 팟캐스트') returning id`, [user.id, kind])
  threads.push(t.id)
  return t.id
}
const msgs = (tid) => q('select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at', [tid])
const tasks = async (tid) => (await msgs(tid)).filter((m) => m.kind === 'task')
const cardOf = async (tid, title) => (await tasks(tid)).filter((m) => m.content.title === title).at(-1)
const lastPage = (b) => { const m = [...b.messages].reverse().find((x) => x.role === 'user' && typeof x.content === 'string' && x.content.startsWith('{')); return m ? JSON.parse(m.content.split('\n')[0]) : { els: [], text: '' } }
const lastUserText = (b) => [...b.messages].reverse().find((x) => x.role === 'user' && typeof x.content === 'string' && x.content.startsWith('{'))?.content || ''
const pick = (b, text) => { const el = lastPage(b).els.find((e) => e.text === text); if (!el) throw new Error(`no element "${text}"`); return el.i }
const lastTool = (b) => String([...b.messages].reverse().find((m) => m.role === 'tool')?.content || '')
const Q = '기존 노트북 중 어느 것에 만들까요? 목록에 없으면 아까 쓰던 소스를 알려 주세요.'
const OPTS = ['AX 컨설팅 해설 1 · Capgemini', 'AX 컨설팅 해설 2 · Accenture']
// a task that asks a pick-one question on a card, then writes down the answer it got and finishes
function asker(goal, title) {
  titles[goal] = title
  scripts[goal] = { i: 0, moves: [['need_user', { reason: Q, options: OPTS }], (b) => ['note', { text: `받은 답: ${lastTool(b)}` }], ['finish', { summary: `${title}을(를) 마쳤어요.` }]] }
}
// the deletion rounds of the recording: the dialog's 「삭제」, else the menu's 「delete 삭제」, else a row's 「more_vert」, else finish
const deleter = (b) => {
  const els = lastPage(b).els
  const hit = (t) => els.find((e) => e.text === t)
  const e = hit('삭제') || hit('delete 삭제') || hit('more_vert')
  return e ? ['click', { i: e.i }] : ['finish', { summary: '제목 없는 노트북을 모두 삭제했어요.' }]
}
async function startAsker(tid, goal, title) {
  asker(goal, title)
  routes.push({ goal, start_url: `${site.url}/ask`, ack: '노트 사이트에서 할게요.' })
  await runTurn({ user, session, threadId: tid, text: `${title} 해 줘` })
  const card = await until(async () => { const c = await cardOf(tid, title); return c?.content.state === 'needs_input' && c })
  assert.ok(card, `${title} 카드가 입력을 기다린다`)
  const choice = await until(async () => (await msgs(tid)).find((m) => m.kind === 'choice' && m.content.taskId === card.id && m.content.state === 'pending'))
  assert.ok(choice, '보기 카드')
  return { card, choice }
}
const done = (tid, title, state = 'done') => until(async () => { const c = await cardOf(tid, title); return c?.content.state === state && c }, 60000)

before(async () => { site = await startNotebooks() })
after(async () => {
  globalThis.fetch = realFetch
  judgeServer.close()
  fs.rmSync(skillsDir, { recursive: true, force: true })
  await browser.close(user.id).catch(() => {})
  await site?.close()
  fs.rmSync(path.join(browser.PROFILES, user.id), { recursive: true, force: true })
  if (up && threads.length) await q('delete from pro_threads where id = any($1)', [threads])
  await pool.end()
})

test('BQ-I-01 기다리는 보기 카드에 입력창으로 「새로 만들어」 → 그 카드의 답(채팅으로 답함), 새 작업 없음 · 라우터에 가지 않음 — 보기와 맞는 말은 그 보기로', { skip: !up }, async () => {
  const tid = await thread()
  const { card, choice } = await startAsker(tid, 'NotebookLM 슬라이드 오디오 만들기', 'NotebookLM 슬라이드·오디오 오버뷰 생성')
  const r0 = routerCalls.length, j0 = judgeCalls.length
  judged.active.push({ o0: 0.02, o1: 0.03, answer: 0.88, steer: 0.03, replace: 0.02, other: 0.02 })
  const ack = await runTurn({ user, session, threadId: tid, text: '새로 만들어' })
  assert.equal(ack.content.text, "'NotebookLM 슬라이드·오디오 오버뷰 생성' 작업의 답으로 전했어요.")
  assert.equal(routerCalls.length, r0, '라우터에 가지 않는다')
  // what the judge read: the task, its question and options, and the words
  const jc = judgeCalls.slice(j0).find((c) => c.kind === 'active')
  assert.match(jc.state, /작업이 사람에게 물은 것: 기존 노트북 중 어느 것에/)
  assert.match(jc.state, /1\) AX 컨설팅 해설 1/)
  assert.match(jc.state, /사용자가 입력창에 쓴 말: 새로 만들어/)
  assert.deepEqual(jc.options.map((o) => o.key), ['o0', 'o1', 'answer', 'steer', 'replace', 'other'])
  const c = (await msgs(tid)).find((m) => m.id === choice.id)
  assert.equal(c.content.state, 'answered')
  assert.equal(c.content.value, '새로 만들어')
  assert.equal(c.content.typed, true)
  const end = await done(tid, card.content.title)
  assert.equal((await tasks(tid)).length, 1, '새 브라우저 작업을 만들지 않는다')
  assert.match(end.content.notes.join(' '), /answered in the chat instead of on the card: "새로 만들어"/)

  // the same with words that pick one of its options: the option itself
  const tid2 = await thread()
  const second = await startAsker(tid2, 'NotebookLM 두 번째 노트북', '두 번째 노트북에 만들기')
  judged.active.push({ o0: 0.03, o1: 0.85, answer: 0.06, steer: 0.02, replace: 0.02, other: 0.02 })
  await runTurn({ user, session, threadId: tid2, text: '액센츄어 걸로 해' })
  assert.equal((await msgs(tid2)).find((m) => m.id === second.choice.id).content.value, OPTS[1])
  const end2 = await done(tid2, second.card.content.title)
  assert.match(end2.content.notes.join(' '), /The user chose: AX 컨설팅 해설 2 · Accenture\./)
})

test('BQ-I-02 기다리는 작업 뒤의 새 작업은 말없이 줄 서지 않는다 — 카드에 앞 작업이 물은 것과 세 갈래(첫 단추 = 판정), 「뒤에 줄 서기」 · 「앞 작업 멈추고 이것부터」', { skip: !up }, async () => {
  const tid = await thread()
  const { card: a } = await startAsker(tid, '노트북 고르기 작업', '노트북 고르기')
  judged.active.push({ o0: 0.02, o1: 0.02, answer: 0.06, steer: 0.05, replace: 0.1, other: 0.75 })
  const goal = '노트 사이트 첫 화면 열고 제목 적기'
  titles[goal] = '노트 사이트 제목 적기'
  scripts[goal] = { i: 0, moves: [(b) => ['note', { text: lastPage(b).title }], ['finish', { summary: '제목을 적었어요.' }]] }
  routes.push({ goal, start_url: `${site.url}/ask`, ack: '노트 사이트를 열게요.' })
  await runTurn({ user, session, threadId: tid, text: '노트 사이트 제목도 적어 줘' })
  const b = await until(async () => { const c = await cardOf(tid, '노트 사이트 제목 적기'); return c?.content.state === 'queued' && c.content.offer && c })
  assert.ok(b, '줄에 선 카드')
  assert.deepEqual(b.content.offer, { default: 'after' })
  assert.equal(b.content.blocked.title, '노트북 고르기')
  assert.equal(b.content.blocked.question, Q)
  assert.match(b.content.reason, /앞 작업 '노트북 고르기'이\(가\) 입력을 기다리고 있어요/)
  assert.ok(!(await msgs(tid)).some((m) => m.kind === 'text' && /한 번에 한 작업만/.test(m.content.text)), '따로 채팅 줄 없음')
  // 「앞 작업 뒤에 줄 세우기」: it stays in line, the card stops offering
  assert.deepEqual(await browser.queueAction(user.id, b.id, 'after'), { ok: true })
  assert.equal((await cardOf(tid, '노트 사이트 제목 적기')).content.offer, null)
  // 「앞 작업 멈추고 이것부터」: the one ahead stops (saying why), this one runs
  assert.deepEqual(await browser.queueAction(user.id, b.id, 'first'), { ok: true })
  const stopped = await done(tid, a.content.title, 'cancelled')
  assert.match(stopped.content.summary, /'노트 사이트 제목 적기'부터 하려고 멈췄어요/)
  const ran = await done(tid, '노트 사이트 제목 적기')
  assert.deepEqual(ran.content.notes, ['노트 사이트'])
})

test('BQ-I-03 카드의 「이 말을 앞 작업의 답으로」 → 그 말이 앞 작업의 답이 되고, 새 작업은 시작하지 않는다(첫 단추가 그것이었다)', { skip: !up }, async () => {
  const tid = await thread()
  const { card: a, choice } = await startAsker(tid, '노트북 정하기 작업', '노트북 정하기')
  // the judge leans to an answer but not surely (0.62): nothing is delivered by itself, the card offers it first
  judged.active.push({ o0: 0.01, o1: 0.01, answer: 0.6, steer: 0.02, replace: 0.06, other: 0.3 })
  const goal = '새 노트북을 만든다'
  titles[goal] = '새 노트북 만들기'
  scripts[goal] = { i: 0, moves: [['finish', { summary: '시작되면 안 됨' }]] }
  routes.push({ goal, start_url: `${site.url}/ask`, ack: '새로 만들게요.' })
  await runTurn({ user, session, threadId: tid, text: '그냥 새 노트북으로' })
  const c = await until(async () => { const x = await cardOf(tid, '새 노트북 만들기'); return x?.content.state === 'queued' && x.content.offer && x })
  assert.deepEqual(c.content.offer, { default: 'answer' })
  assert.deepEqual(await browser.queueAction(user.id, c.id, 'answer'), { ok: true })
  const gone = await done(tid, '새 노트북 만들기', 'cancelled')
  assert.equal(gone.content.summary, "이 말은 앞 작업 '노트북 정하기'의 답으로 보냈어요.")
  assert.equal(scripts[goal].i, 0, '새 작업은 브라우저를 쓰지 않았다')
  assert.equal((await msgs(tid)).find((m) => m.id === choice.id).content.value, '그냥 새 노트북으로')
  const end = await done(tid, a.content.title)
  assert.match(end.content.notes.join(' '), /"그냥 새 노트북으로"/)
})

test('BQ-I-04 「작업을 마치고 아까 … 진행해」 → ① 멈춘 삭제를 그 자리부터 새 한도로 마저 끝내고 → ② 다음 작업, 답이 순서를 말한다', { skip: !up }, async () => {
  const tid = await thread()
  // the deletion, stopped part way by the person (one notebook gone)
  const del = "NotebookLM '제목없음' 노트북 모두 삭제"
  titles[del] = del
  scripts[del] = { i: 0, moves: [deleter, deleter, deleter, 'hang'] }
  const first = browser.runBrowserTask({ userId: user.id, threadId: tid, goal: del, startUrl: `${site.url}/notebooks?n=4`, own: true })
  const card = await until(async () => { const c = await cardOf(tid, del); return c && scripts[del].i >= 4 && c })
  browser.cancel(user.id, card.id)
  assert.equal((await first).state, 'cancelled')
  const stopped = await cardOf(tid, del)
  assert.equal(stopped.content.did.length, 3, '한 일은 카드에 남는다(이어서 할 때 쓴다)')
  // now: finish that, then the NotebookLM work
  scripts[del] = { i: 0, moves: [deleter] }
  const nb = 'NotebookLM 슬라이드·오디오 오버뷰 이어서 완료'
  titles[nb] = '슬라이드·오디오 오버뷰 완료'
  scripts[nb] = { i: 0, moves: [['note', { text: '슬라이드 시작' }], ['finish', { summary: '만들었어요.' }]] }
  const mark = bodies.length
  judged.resume.push({ then0: 0.91, only0: 0.04, more0: 0.02, none: 0.03 })
  routes.push({ goal: nb, skill: '', start_url: `${site.url}/ask`, ack: '네, 제목없음 노트북 삭제 작업이 끝나면 아까 하던 노트북LM 슬라이드·오디오 생성을 이어서 진행할게요.' })
  const j0 = judgeCalls.length
  const ack = await runTurn({ user, session, threadId: tid, text: '작업을 마치고 아까 노트북 엘엠 만들던거 진행해.' })
  assert.equal(ack.content.text, `① '${del}' 마저 끝내고 → ② '${nb}' 시작할게요.`)
  const jc = judgeCalls.slice(j0).find((c) => c.kind === 'resume')
  assert.match(jc.state, /NotebookLM '제목없음' 노트북 모두 삭제」 — 사람이 멈춤/)
  assert.match(jc.state, /마지막 동작: 'more_vert' 누르기, 'delete 삭제' 누르기, '삭제' 누르기/)
  // ② waits behind ①, saying so
  const second = await until(async () => { const c = await cardOf(tid, '슬라이드·오디오 오버뷰 완료'); return c?.content.state === 'queued' && c })
  assert.deepEqual(second.content.order, { n: 2, after: del })
  assert.match(second.content.reason, /① 'NotebookLM '제목없음' 노트북 모두 삭제'을\(를\) 마저 끝내면 이어서 시작해요/)
  // ① is the same card, again, and finishes the list
  const a = await done(tid, del)
  assert.equal(a.id, card.id, '같은 카드가 다시 돈다')
  assert.match(a.content.summary, /모두 삭제했어요/)
  const resumedBody = bodies.find((b) => goalOf(b) === del && b.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('This task was stopped before it was finished')))
  assert.ok(resumedBody, '멈춘 자리와 한 일을 알고 이어서 한다')
  assert.match(resumedBody.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('This task was stopped')).content, /'more_vert' 누르기/)
  await done(tid, '슬라이드·오디오 오버뷰 완료')
  // the model's turns in order: every one of ① before the first of ②
  const seq = bodies.slice(mark).map(goalOf)
  assert.ok(seq.lastIndexOf(del) < seq.indexOf(nb), seq.join(' · '))
  const order = (await tasks(tid)).map((t) => t.content.title)
  assert.deepEqual(order, [del, '슬라이드·오디오 오버뷰 완료'])
})

test('BQ-I-05 되풀이하는 삭제는 동작 40번을 넘어 끝까지 간다(「진행 중 · N개 처리」) — 목록이 그대로인 되풀이는 그대로 「같은 화면에서 멈춤」', { skip: !up }, async () => {
  const tid = await thread()
  const goal = '제목 없는 노트북 16개 모두 삭제'
  titles[goal] = goal
  scripts[goal] = { i: 0, moves: [deleter] }
  const seen = new Set()
  const watch = setInterval(async () => { const c = await cardOf(tid, goal).catch(() => null); if (c?.content.need) seen.add(c.content.need); if (c?.content.progress?.count) seen.add(`n${c.content.progress.count}`) }, 150)
  const r = await browser.runBrowserTask({ userId: user.id, threadId: tid, goal, startUrl: `${site.url}/notebooks?n=16`, own: true })
  clearInterval(watch)
  assert.equal(r.state, 'done', r.summary)
  assert.ok(r.stats.turns > 40, `${r.stats.turns} 턴`)
  assert.ok(r.stats.extended >= 1, '한도가 늘었다')
  const c = await cardOf(tid, goal)
  assert.equal(c.content.state, 'done')
  assert.ok(c.content.progress.count >= 14, JSON.stringify(c.content.progress))
  assert.ok(![...seen].some((x) => ['stuck', 'limit'].includes(x)), `멈춤이 없었다: ${[...seen]}`)
  assert.ok([...seen].some((x) => /^n\d+$/.test(x)), '돌 때 처리한 수를 보였다')
  // the same rounds on a list that never changes: stuck, as before
  const stuck = '삭제가 안 되는 목록'
  titles[stuck] = stuck
  scripts[stuck] = { i: 0, moves: [deleter] }
  const run = browser.runBrowserTask({ userId: user.id, threadId: tid, goal: stuck, startUrl: `${site.url}/notebooks?n=5&broken=1`, own: true })
  const s = await until(async () => { const x = await cardOf(tid, stuck); return x?.content.state === 'needs_input' && x })
  assert.equal(s.content.need, 'stuck')
  assert.match(s.content.reason, /같은 화면으로 돌아와 같은 동작을 세 번 되풀이해 멈췄어요/)
  assert.ok(scripts[stuck].i <= 12, `${scripts[stuck].i}번 움직이고서야 멈췄다`)
  browser.cancel(user.id, s.id)
  assert.equal((await run).state, 'cancelled')
})

test('BQ-I-06 끝난 작업의 결과 메시지는 한두 줄 — 한 일과 긴 설명은 「자세히」(did · detail), 에이전트가 다시 읽는 글에는 클릭 기록이 없다', { skip: !up }, async () => {
  const tid = await thread()
  const goal = 'Medium 글로 새 노트북 만들기'
  titles[goal] = 'NotebookLM 새 노트북 생성 및 소스 추가'
  const summary = '새 노트북은 만들었지만, Medium 글은 소스로 들어가지 않았습니다. 사이트가 가져오기를 막아 소스 0개로 남았어요. 글 본문을 복사해 텍스트 소스로 넣거나 PDF로 저장해 올리면 추가할 수 있습니다. 원하시면 그 방식으로 이어서 해 드릴게요.'
  scripts[goal] = { i: 0, moves: [(b) => ['click', { i: pick(b, '새 노트북') }], ['scroll', { dy: 300 }], ['note', { text: '노트북 만듦' }], ['finish', { summary }]] }
  routes.push({ goal, start_url: `${site.url}/ask`, ack: '노트 사이트에서 할게요.' })
  await runTurn({ user, session, threadId: tid, text: '이 글로 노트북 만들어 줘 https://blocked.example/agentic' })
  const msg = await until(async () => (await msgs(tid)).find((m) => m.kind === 'text' && m.role === 'agent' && m.content.taskId), 60000)
  assert.equal(msg.content.text, '새 노트북은 만들었지만, Medium 글은 소스로 들어가지 않았습니다.\n원하시면 그 방식으로 이어서 해 드릴게요.')
  assert.doesNotMatch(msg.content.text, /실제로 한 일|누르기/)
  assert.deepEqual(msg.content.did.map((d) => d.text), ["'새 노트북' 누르기", '화면 내리기'])
  assert.equal(msg.content.detail, summary)
  const card = await cardOf(tid, 'NotebookLM 새 노트북 생성 및 소스 추가')
  assert.equal(card.content.summary, msg.content.text, '카드의 결과도 짧다')
  assert.equal(card.content.did.length, 2)
})

test('BQ-I-07 기다리는 동안 준 지시(steer) → 그 작업으로: 2분 기다림이 바로 끊기고 다음 턴이 그 말을 읽으며, 카드에 「받은 지시」', { skip: !up }, async () => {
  const tid = await thread()
  const goal = 'Medium 글을 소스로 넣기'
  titles[goal] = 'NotebookLM 새 노트북 생성 및 소스 추가'
  let heard = ''
  scripts[goal] = { i: 0, moves: [['wait_for_page', { minutes: 2, gone_text: '노트 사이트' }], (b) => { heard = lastUserText(b); return ['note', { text: '지시를 받음' }] }, ['finish', { summary: '지시대로 했어요.' }]] }
  routes.push({ goal, start_url: `${site.url}/ask`, ack: '할게요.' })
  await runTurn({ user, session, threadId: tid, text: '이 글을 소스로 넣어 줘' })
  await until(async () => scripts[goal].i >= 1 && browser.activeIn(user.id, tid))
  await sleep(600)
  const said = '미디엄은 접근 권한 문제가 있으니, 내 계정으로 접근해서 인쇄시킨 후, pdf 등으로 만든후에 노트북엘엠에 넣어야 해.'
  judged.active.push({ steer: 0.86, replace: 0.04, other: 0.1 })
  const t0 = Date.now()
  const ack = await runTurn({ user, session, threadId: tid, text: said })
  assert.equal(ack.content.text, "'NotebookLM 새 노트북 생성 및 소스 추가' 작업에 그대로 전했어요. 그 말대로 이어서 해요.")
  const card = await until(async () => (await cardOf(tid, 'NotebookLM 새 노트북 생성 및 소스 추가'))?.content.steered && await cardOf(tid, 'NotebookLM 새 노트북 생성 및 소스 추가'))
  assert.equal(card.content.steered.text, said)
  const end = await done(tid, 'NotebookLM 새 노트북 생성 및 소스 추가')
  assert.ok(Date.now() - t0 < 20000, '2분을 다 기다리지 않았다')
  assert.match(heard, /The person said in the chat while you were working/)
  assert.ok(heard.includes(said))
  assert.equal(end.content.steered, null, '끝나면 줄은 지운다')
})

test('BQ-I-08 방금 끝난 작업이 제안한 다음 일 → 원래 목표 · 입력 · 페이지에 그 말을 더한 새 작업 하나(방 규칙으로 받아 적지 않음)', { skip: !up }, async () => {
  const tid = await thread()
  const goal = 'https://blocked.example/agentic 글로 노트북 만들기'
  titles[goal] = '노트북 만들기(Medium)'
  scripts[goal] = { i: 0, moves: [(b) => ['click', { i: pick(b, '새 노트북') }], ['finish', { summary: '새 노트북은 만들었지만 Medium 글은 소스로 들어가지 않았어요. 원하시면 PDF 로 저장해 올리는 방식으로 이어서 해 드릴게요.' }]] }
  routes.push({ goal, start_url: `${site.url}/ask`, ack: '할게요.' })
  await runTurn({ user, session, threadId: tid, text: goal })
  const a = await done(tid, '노트북 만들기(Medium)')
  await until(async () => (await msgs(tid)).some((m) => m.content?.taskId === a.id))
  const said = '미디엄은 접근 권한 문제가 있으니 인쇄해서 pdf 로 만든 후에 넣어'
  const cont = `${goal}\n\n이어서 할 일: ${said}`
  titles[goal] = '노트북에 PDF 넣기'
  let context = ''
  scripts[goal] = { i: 0, moves: [(b) => { context = b.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'); return ['note', { text: 'ok' }] }, ['finish', { summary: 'PDF 로 넣었어요.' }]] }
  judged.resume.push({ more0: 0.9, none: 0.1 })
  const j0 = judgeCalls.length
  const r0 = routerCalls.length
  const ack = await runTurn({ user, session, threadId: tid, text: said })
  assert.equal(ack.content.text, "'노트북 만들기(Medium)' 작업을 말씀하신 대로 이어서 할게요.")
  const jc = judgeCalls.slice(j0).find((c) => c.kind === 'resume')
  assert.match(jc.state, /끝맺은 말: 원하시면 PDF 로 저장해 올리는 방식으로 이어서 해 드릴게요\./)
  assert.ok(!judgeCalls.slice(j0).some((c) => c.kind === 'room'), '방 판정까지 가지 않는다')
  assert.equal(routerCalls.length, r0)
  const b = await done(tid, '노트북에 PDF 넣기')
  assert.notEqual(b.id, a.id, '새 작업 하나')
  assert.equal(b.content.from, a.id)
  assert.equal(b.content.goal, cont)
  assert.match(context, /This continues an earlier browser task \("노트북 만들기\(Medium\)"\)/)
  assert.match(context, /The person's new instruction for it: 미디엄은/)
  assert.match(context, /The page it was on last: http:\/\/127\.0\.0\.1:\d+\/ask/)
  assert.equal(await R.ruleOf(user.id, tid), null, '규칙이 생기지 않았다')
})

test('BQ-I-09 규칙이 있는 방: 작업이 있으면 규칙을 정하는 말은 0.85 에서만, 그래도 말없이 바꾸지 않고 「규칙을 바꿀까요?」 — 「이번 작업에만 적용」은 작업으로, 「바꾸기」는 새 규칙', { skip: !up }, async () => {
  const tid = await thread()
  await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2)`, [tid, { text: '알겠습니다.', roomRule: { said: '링크는 슬라이드 팟캐스트로', action: '이 링크로 노트북 LM 의 슬라이드와 팟캐스트를 만든다', skill: '', runs: 3 } }])
  const goal = '노트북에 소스 넣기'
  titles[goal] = goal
  scripts[goal] = { i: 0, moves: [['note', { text: '소스 0개' }], ['finish', { summary: '소스가 들어가지 않았어요. 원하시면 다른 방식으로 이어서 해 드릴게요.' }]] }
  await browser.runBrowserTask({ userId: user.id, threadId: tid, goal, startUrl: `${site.url}/ask`, own: true })
  const said = '미디엄은 접근 권한 문제가 있으니 pdf 로 만든 후에 넣어야 해'
  // 0.8 while a task just ended here: below the 0.85 the rule needs then — not a rule (the usual path, DELEGATE)
  judged.room.push({ set_rule: 0.8, run_rule: 0.05, steer: 0.1, other: 0.05 })
  let j0 = judgeCalls.length
  await runTurn({ user, session, threadId: tid, text: said })
  const rc = judgeCalls.slice(j0).find((c) => c.kind === 'room')
  assert.deepEqual(rc.options.map((o) => o.key), ['set_rule', 'run_rule', 'steer', 'other'])
  assert.match(rc.state, /최근에 끝났거나 멈춘 브라우저 작업:\n1\. 「노트북에 소스 넣기」 — 끝남/)
  assert.match(rc.state, /끝맺은 말: 원하시면 다른 방식으로 이어서 해 드릴게요\./)
  assert.equal((await R.ruleOf(user.id, tid)).action, '이 링크로 노트북 LM 의 슬라이드와 팟캐스트를 만든다')
  // 0.9: a rule — but the room has one: asked, never replaced silently
  judged.room.push({ set_rule: 0.9, run_rule: 0.02, steer: 0.05, other: 0.03 })
  actions.push({ action: '이 링크는 PDF 로 저장해 노트북 LM 에 넣는다', skill: '' })
  const ask = await runTurn({ user, session, threadId: tid, text: said })
  assert.deepEqual(ask.content.ruleConfirm, { said, now: '이 링크로 노트북 LM 의 슬라이드와 팟캐스트를 만든다', next: '이 링크는 PDF 로 저장해 노트북 LM 에 넣는다', skill: '', state: 'pending' })
  assert.equal(ask.content.text, '규칙을 바꿀까요?\n지금: 이 링크로 노트북 LM 의 슬라이드와 팟캐스트를 만든다\n새: 이 링크는 PDF 로 저장해 노트북 LM 에 넣는다')
  assert.equal((await R.ruleOf(user.id, tid)).action, '이 링크로 노트북 LM 의 슬라이드와 팟캐스트를 만든다', '아직 그대로')
  // 「이번 작업에만 적용」: the rule stays, the words go to the task that just ended (it carries on with them)
  const { onceTurn } = await import('../lib/agent.js')
  const settled = await R.settleRuleConfirm(user.id, ask.id, 'once')
  assert.equal(settled.message.content.ruleConfirm.state, 'once')
  scripts[`${goal}`] = { i: 0, moves: [['note', { text: 'pdf' }], ['finish', { summary: 'PDF 로 넣었어요.' }]] }
  const once = await onceTurn({ user, session, threadId: tid, text: settled.said })
  assert.equal(once.content.text, "'노트북에 소스 넣기' 작업을 말씀하신 대로 이어서 할게요.")
  await until(async () => (await tasks(tid)).length === 2 && (await tasks(tid))[1].content.state === 'done', 30000)
  assert.equal((await tasks(tid))[1].content.goal, `${goal}\n\n이어서 할 일: ${said}`)
  assert.equal((await R.ruleOf(user.id, tid)).action, '이 링크로 노트북 LM 의 슬라이드와 팟캐스트를 만든다')
  assert.equal((await R.settleRuleConfirm(user.id, ask.id, 'replace')).already, true, '한 번 고른 카드는 다시 고르지 않는다')
  // 「바꾸기」: that card holds the new rule
  judged.room.push({ set_rule: 0.95, other: 0.05 })
  actions.push({ action: '이 링크는 PDF 로 저장해 노트북 LM 에 넣는다', skill: '' })
  j0 = judgeCalls.length
  const ask2 = await runTurn({ user, session, threadId: tid, text: '앞으로 이 방 링크는 PDF 로 저장해서 노트북에 넣어' })
  assert.equal(ask2.content.ruleConfirm.state, 'pending')
  await R.settleRuleConfirm(user.id, ask2.id, 'replace')
  assert.equal((await R.ruleOf(user.id, tid)).action, '이 링크는 PDF 로 저장해 노트북 LM 에 넣는다')
})

test('BQ-I-10 웹사이트 소스가 「소스 0개」에 머무는 사이트: 글을 열어 PDF 로 저장(save_pdf)하고 「파일 업로드」로 넣는다 — 진짜 Chromium 의 인쇄 · 파일 선택', { skip: !up }, async () => {
  const tid = await thread()
  const goal = 'blocked.example 글을 NotebookLM 소스로 넣기'
  titles[goal] = goal
  const byType = (b, type) => lastPage(b).els.find((e) => e.type === type)?.i
  scripts[goal] = { i: 0, moves: [
    (b) => ['click', { i: pick(b, '웹사이트') }],
    (b) => ['type', { i: pick(b, 'URL 붙여넣기'), text: `${site.url}/article?host=blocked` }],
    (b) => ['click', { i: pick(b, '삽입') }],
    ['wait_for_page', { minutes: 0.05, gone_text: '소스 0개' }],
    ['goto', { url: `${site.url}/article` }],
    ['save_pdf', { name: 'Agentic AI in practice' }],
    ['goto', { url: `${site.url}/nb` }],
    (b) => ['click', { i: pick(b, '파일 업로드') }],
    (b) => ['attach_file', { i: byType(b, 'file'), name: 'Agentic AI in practice.pdf' }],
    ['wait_for_page', { minutes: 0.2, until_text: '소스 1개' }],
    (b) => ['note', { text: lastPage(b).text.split('\n').find((l) => l.startsWith('소스')) }],
    ['finish', { summary: 'Medium 글을 PDF 로 저장해 소스로 넣었어요.' }],
  ] }
  const r = await browser.runBrowserTask({ userId: user.id, threadId: tid, goal, startUrl: `${site.url}/nb`, own: true })
  assert.equal(r.state, 'done', r.summary)
  assert.ok(bodies.some((b) => goalOf(b) === goal && /still waiting after/.test(lastTool(b))), '웹사이트 소스는 들어가지 않았다')
  assert.equal(r.notes.at(-1), '소스 1개: Agentic AI in practice.pdf')
  const file = (await msgs(tid)).find((m) => m.kind === 'file' && m.content.type === 'application/pdf')
  assert.equal(file.content.name, 'Agentic AI in practice.pdf')
  const card = await cardOf(tid, goal)
  assert.ok(card.content.files.some((f) => f.name === 'Agentic AI in practice.pdf'), '카드가 이 작업의 파일로 기억한다')
  assert.deepEqual(card.content.did.map((d) => d.text).filter((t) => /PDF|저장|올리기/.test(t)), ['Agentic AI in practice.pdf 저장', 'Agentic AI in practice.pdf 올리기'])
})

// ---- the conversation's files (2026-11-25 production: 「AI 로 만든 문서나 대화창에 올려진 파일 내용을 브라우저 쪽으로 업로드를 못시키네」) ----
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
// a PDF the agent made in this room: in its workspace, and its file card in the chat
async function madePdf(tid, name, dir) {
  const rel = `/workspace/.bpmn/bq-${stamp}-${dir}/${name}`
  const host = path.join(PGPT_ROOT, 'services/deepagents/workspace', config.tenantId, rel.slice('/workspace/'.length))
  fs.mkdirSync(path.dirname(host), { recursive: true })
  fs.writeFileSync(host, PDF)
  made.push(path.dirname(host))
  await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2)`, [tid, { name, path: rel, size: PDF.length }])
}
const made = []
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
const byType = (b, type) => lastPage(b).els.find((e) => e.type === type)?.i
const uploader = (goal, file, extra = []) => ({ i: 0, moves: [...extra, (b) => ['click', { i: pick(b, '파일 업로드') }], (b) => ['attach_file', { i: byType(b, 'file'), name: file }],
  ['wait_for_page', { minutes: 0.2, until_text: '소스 1개' }], (b) => ['note', { text: lastPage(b).text.split('\n').find((l) => l.startsWith('소스')) }], ['finish', { summary: '소스로 넣었어요.' }]] })

test('BQ-I-11 이 방에서 AI 가 만든 PDF 하나 → 「이 PDF로 NotebookLM 팟캐스트」: 묻지 않고 그 파일이 작업의 파일이 되어 사이트에 올라간다', { skip: !up }, async () => {
  const tid = await thread()
  const name = '통신망 장애 온톨로지·광선로 단선 진단 보고서.pdf'
  await madePdf(tid, name, 'one')
  const goal = 'NotebookLM 에 그 PDF 를 소스로 넣고 팟캐스트 만들기'
  titles[goal] = 'NotebookLM 팟캐스트'
  scripts[goal] = uploader(goal, name)
  routes.push({ goal, start_url: `${site.url}/nb`, ack: '네, NotebookLM 브라우저를 열어 PDF를 소스로 넣고 팟캐스트를 만들게요.' })
  judged.file.push({ f0: 0.93, none: 0.07 })
  const j0 = judgeCalls.length
  await runTurn({ user, session, threadId: tid, text: '이 PDF로 NotebookLM 팟캐스트 만들어 줘' })
  const c = await done(tid, 'NotebookLM 팟캐스트')
  const fc = judgeCalls.slice(j0).find((x) => x.kind === 'file')
  assert.match(fc.options[0].label, /통신망 장애 온톨로지·광선로 단선 진단 보고서\.pdf · pdf · 1 KB · 이 방에서 AI 가 만든 파일/)
  assert.deepEqual(c.content.files.map((f) => f.name), [name])
  assert.equal(c.content.notes.at(-1), `소스 1개: ${name}`)
  assert.ok(!(await msgs(tid)).some((m) => m.kind === 'choice'), '하나뿐이면 묻지 않는다')
  assert.ok(bodies.some((b) => goalOf(b) === goal && /Files of this task \(give them to a site with attach_file\): 통신망/.test(b.messages[0].content)))
})

test('BQ-I-12 그럴듯한 PDF 가 둘이면 작업 안의 「파일 고르기」 카드 — 고른 파일이 올라가고, 맞는 것이 없으면 어디서 찾았는지 말한다(「이 작업에 첨부」라고 하지 않음)', { skip: !up }, async () => {
  const tid = await thread()
  await madePdf(tid, '온톨로지 보고서 1부.pdf', 'two-a')
  await madePdf(tid, '온톨로지 보고서 2부.pdf', 'two-b')
  const goal = 'NotebookLM 에 온톨로지 보고서를 소스로 넣기'
  titles[goal] = '보고서 소스 넣기'
  scripts[goal] = uploader(goal, '온톨로지 보고서 1부.pdf', [['pick_file', { want: '온톨로지 보고서 PDF' }]])
  judged.file.push({ f0: 0.45, f1: 0.45, none: 0.1 }) // at planning: none sure
  judged.file.push({ f0: 0.46, f1: 0.44, none: 0.1 }) // pick_file: still two — the person picks
  const run = browser.runBrowserTask({ userId: user.id, threadId: tid, goal, startUrl: `${site.url}/nb`, own: true })
  const choice = await until(async () => (await msgs(tid)).find((m) => m.kind === 'choice' && m.content.state === 'pending'))
  assert.equal(choice.content.question, '파일 고르기 · 온톨로지 보고서 PDF')
  assert.deepEqual([...choice.content.options].sort(), ['온톨로지 보고서 1부.pdf', '온톨로지 보고서 2부.pdf'])
  browser.resume(user.id, 'The user chose: 온톨로지 보고서 1부.pdf. Continue with that choice.')
  assert.equal((await run).state, 'done')
  const c = await done(tid, '보고서 소스 넣기')
  assert.equal(c.content.notes.at(-1), '소스 1개: 온톨로지 보고서 1부.pdf')
  assert.ok(c.content.did.some((d) => d.text === '파일 고르기: 온톨로지 보고서 1부.pdf'))
  // nothing of this conversation fits: the agent hears where it looked, never "attach it to this task"
  const t2 = await thread()
  const g2 = '빈 방에서 PDF 올리기'
  titles[g2] = g2
  let heard = ''
  scripts[g2] = { i: 0, moves: [['pick_file', { want: 'PDF' }], (b) => { heard = lastTool(b); return ['attach_file', { i: 1, name: '없는 파일.pdf' }] }, (b) => { heard += `\n${lastTool(b)}`; return ['finish', { summary: '파일이 없어요.' }] }] }
  await browser.runBrowserTask({ userId: user.id, threadId: t2, goal: g2, startUrl: `${site.url}/nb`, own: true })
  assert.match(heard, /^none: no file of this conversation fits \(looked in the files posted in this chat, what the AI made in this room, the room's linked folder and files teammates shared\)/)
  assert.match(heard, /this task has no file yet — call pick_file with what file the work needs; never ask the person to attach a file to this task/)
  assert.doesNotMatch(heard, /no file was attached to this task/)
})
