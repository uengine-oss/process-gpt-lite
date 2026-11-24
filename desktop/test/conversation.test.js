'use strict'
// The run card's 「대화」 view and the end of a step (design docs/local-agents/design.md §5.11 · §6.2): pure parts first, then the runner with
// the fake interactive CLI (test/fixtures/fake-tui.js).
//   · transcript.js — a Claude Code session jsonl and a Codex rollout (realistic, fictional fixtures in test/fixtures/transcripts/) become
//     the conversation's items: prompts, words, thinking, tool calls with their results (a diff, an output), paths made the folder's own,
//     the CLI's bookkeeping and a subagent's sidechain left out
//   · prompts.js — what the CLI asks (its PermissionRequest hook · AskUserQuestion) and the keys that answer it (measured with the real
//     Claude Code 2.1.331: '1' · '2' · Esc · the option's number)
//   · settle.js — after a turn the run waits; a suggestion, an input, the owner's typing, a new turn start the wait again
//   · the runner: the items relayed over the link (tx), whose words a steer was, the ask answered by the owner's press (the keys reach
//     the CLI), 「끝내기」, the screen kept at the turn's end (term-keep), the wait the server is told of (idle)
// Run: cd desktop && node --test test/conversation.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const TX = require('../src/runner/transcript')
const ASK = require('../src/runner/prompts')
const { settleState, finishMsOf, DEFAULT_FINISH_MS } = require('../src/runner/settle')
const { Runner } = require('../src/runner/runner')
const P = require('../src/runner/pty')
const { gitServer, makeRepo } = require('./helpers/gitServer')
const { fakeBin, systemPath } = require('./helpers/fakeBin')

const FIX = path.join(__dirname, 'fixtures', 'transcripts')
const lines = (f) => fs.readFileSync(path.join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const WORK = '/Users/haneul/Library/Application Support/Process GPT Lite/local-agents/work/3f2a91c0d1/inst-moonlight-7c1e'
const rel = (s) => String(s).split(`${WORK}/`).join('')

test('Claude Code 세션 jsonl → 대화 항목: 프롬프트 · 말 · 생각 · 도구와 그 결과(차이 · 출력) — 기록 관리 항목과 하위 에이전트는 빠진다', () => {
  const items = lines('claude-session.jsonl').flatMap((e) => TX.fromClaude(e, { rel }))
  const kinds = items.map((i) => i.t)
  // (mode, permission-mode, file-history-snapshot, api-request(-blob), environment · skill listing attachments, isMeta, system, sidechain: none)
  assert.ok(!items.some((i) => /a copy the CLI keeps|subagent|Base directory/.test(JSON.stringify(i))), 'bookkeeping left out')
  assert.equal(kinds[0], 'user')
  assert.match(items[0].text, /^「산출물\/01_견적서 작성\/」 폴더 안에 두세요/)
  const think = items.find((i) => i.t === 'thinking')
  assert.match(think.text, /부가세 포함 금액으로/)
  assert.ok(items.some((i) => i.t === 'text' && i.text.includes('**요청 메일**')), 'markdown kept as it is')
  const tool = (name) => items.find((i) => i.t === 'tool' && i.name === name)
  const result = (call) => items.find((i) => i.t === 'result' && i.call === call)
  // Read: the folder's own path, its line count
  assert.equal(tool('Read').input.path, '메일/요청.md')
  assert.equal(result(tool('Read').call).out, '2')
  // Skill: its name
  assert.equal(tool('Skill').input.skill, '견적-규칙')
  // Write: the file and what it wrote (created)
  assert.equal(tool('Write').input.path, '산출물/01_견적서 작성/견적서.md')
  assert.match(tool('Write').input.content, /합계\(부가세 포함\)/)
  assert.equal(result(tool('Write').call).kind, 'create')
  // Edit: old and new, and the CLI's own structured patch (its +/- lines)
  const edit = tool('Edit')
  assert.equal(edit.input.old, '| 대관 | 1,100,000원 |')
  assert.deepEqual(result(edit.call).patch, [{ a: 4, b: 4, lines: [' |---|---|', ' | 대관 | 1,100,000원 |', '+| 할인 | -110,000원 |'] }])
  // Bash: the command and its output, paths made the folder's own
  const bash = tool('Bash')
  assert.equal(bash.input.command, 'wc -l "산출물/01_견적서 작성/견적서.md"')
  assert.equal(bash.input.description, '줄 수 세기')
  assert.equal(result(bash.call).out, '8 산출물/01_견적서 작성/견적서.md')
  assert.ok(!JSON.stringify(items).includes('/Users/haneul'), 'no path of this computer outside the work folder shows')
  // AskUserQuestion: its questions and options; its answer
  const q = tool('AskUserQuestion')
  assert.deepEqual(q.input.questions[0].options.map((o) => o.label), ['포함', '별도'])
  assert.deepEqual(result(q.call).answers, { '금액을 부가세 포함으로 적을까요?': '포함' })
  // a message queued while it worked, a slash command and its output, a refused tool use and the stopped turn
  assert.ok(items.some((i) => i.t === 'user' && i.text === '할인 줄을 따로 적어 주세요'))
  assert.ok(items.some((i) => i.t === 'user' && i.cmd && i.text === '/compact 견적만 남기기'))
  assert.ok(items.some((i) => i.t === 'note' && i.kind === 'command' && /Compacted/.test(i.text)))
  const refused = items.filter((i) => i.t === 'result' && i.ok === false)
  assert.equal(refused.length, 1)
  assert.equal(items.at(-1).t, 'note')
  assert.equal(items.at(-1).kind, 'interrupted')
  // every item has its own id
  assert.equal(new Set(items.map((i) => i.id)).size, items.length)
})

test('Codex rollout → 대화 항목: 사람의 말 · 생각 · 명령과 그 출력(종료 코드) · apply_patch 의 차이 — 같은 말을 되풀이하는 response_item 은 빠진다', () => {
  const items = lines('codex-rollout.jsonl').flatMap((e) => TX.fromCodex(e, { rel }))
  const users = items.filter((i) => i.t === 'user')
  assert.equal(users.length, 2, 'the user_message events only (not the environment context, not the response_item copy)')
  assert.match(users[0].text, /\.pgl-run\/prompt\.md/)
  assert.equal(items.filter((i) => i.t === 'thinking').length, 1)
  assert.equal(items.filter((i) => i.t === 'text').length, 1, 'agent_message once (the response_item message is its copy)')
  const shell = items.filter((i) => i.t === 'tool' && i.name === 'shell')
  assert.deepEqual(shell.map((s) => s.input.command), ['cat .pgl-run/prompt.md', 'ls 없는폴더'])
  const out = (call) => items.find((i) => i.t === 'result' && i.call === call)
  assert.equal(out('call_a1').ok, true)
  assert.match(out('call_a1').out, /견적 검토/)
  assert.equal(out('call_a3').ok, false, 'a command that exited 1')
  const patch = items.find((i) => i.t === 'tool' && i.name === 'apply_patch')
  assert.equal(patch.input.path, '산출물/02_견적 검토/검토.md')
  assert.equal(patch.input.op, 'add')
  assert.deepEqual(patch.patch[0].lines, ['+# 검토 의견', '+- 합계가 맞아요'])
  assert.equal(items.at(-1).kind, 'interrupted')
})

test('긴 글은 잘라서 보낸다: 한 항목이 링크를 채우지 않는다', () => {
  const big = 'ㄱ'.repeat(TX.LIMITS.TEXT_MAX + 500)
  const [it] = TX.fromClaude({ type: 'assistant', uuid: 'x', message: { content: [{ type: 'text', text: big }] } })
  assert.equal(it.text.length, TX.LIMITS.TEXT_MAX + 1)
  const [r] = TX.fromClaude({ type: 'user', uuid: 'y', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(50_000) }] } })
  assert.ok(r.out.length <= TX.LIMITS.OUT_MAX + 1)
})

test('CLI 가 묻는 것과 답하는 키: 허락은 1 · 앞으로 묻지 않기는 2 · 거절은 Esc, 물음은 고른 항목의 번호 (실측 2.1.331)', () => {
  const perm = ASK.fromPermissionRequest({ tool_name: 'Bash', tool_input: { command: `python3 "${WORK}/계산.py"`, description: '계산' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'python3 *' }], behavior: 'allow' }] }, { rel })
  assert.equal(perm.kind, 'permission')
  assert.equal(perm.brief, 'python3 "계산.py"')
  assert.deepEqual(perm.choices, ['yes', 'always', 'no'])
  assert.deepEqual(ASK.keysFor(perm, 'yes'), ['1'])
  assert.deepEqual(ASK.keysFor(perm, 'always'), ['2'])
  assert.deepEqual(ASK.keysFor(perm, 'no'), ['\x1b'])
  assert.deepEqual(ASK.keysFor(perm, 'auto'), [], 'auto mode is never offered')
  // no suggestion → no "don't ask again"
  const once = ASK.fromPermissionRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.test/a' } })
  assert.deepEqual(once.choices, ['yes', 'no'])
  assert.deepEqual(ASK.keysFor(once, 'always'), [])
  // AskUserQuestion: the number of the option, per question
  const q = ASK.fromPermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '통화는?', header: '통화', options: [{ label: '원' }, { label: '달러' }] }, { question: '부가세?', options: [{ label: '포함' }, { label: '별도' }] }] } })
  assert.equal(q.kind, 'question')
  assert.deepEqual(ASK.keysFor(q, [1, 0]), ['2', '1', '\r'], 'each question\'s number, then Enter on the review (measured)')
  assert.deepEqual(ASK.keysFor(q, [1]), [], 'an answer for every question')
  assert.deepEqual(ASK.keysFor(q, [5, 0]), [], 'no such option')
  assert.equal(ASK.answerText(q, [1, 0]), '달러 · 포함')
  // an older Claude Code: its Notification hook, for the call that waits
  const n = ASK.fromNotification({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, { name: 'Bash', input: { command: 'make' } })
  assert.deepEqual([n.tool, n.brief, n.choices], ['Bash', 'make', ['yes', 'no']])
  assert.equal(ASK.fromNotification({ notification_type: 'idle_prompt' }, null), null)
})

test('턴이 끝난 뒤 기다리기: 기본 5분, 새 제안 · 입력 · 타자 · 새 턴이 기다림을 다시 시작하고, 끝내기는 바로', () => {
  const t0 = 1_000_000
  const M = 60_000
  assert.equal(DEFAULT_FINISH_MS, 5 * M)
  // the CLI works, or no turn ended yet: no wait
  assert.deepEqual(settleState({ now: t0, turnEnded: 0 }), { done: false, until: null, check: null })
  assert.deepEqual(settleState({ now: t0, turnEnded: t0 - 1000, busy: true }), { done: false, until: null, check: null })
  // the turn ended: it waits five minutes
  assert.deepEqual(settleState({ now: t0 + 1000, turnEnded: t0, finishMs: 5 * M }), { done: false, until: t0 + 5 * M, check: 5 * M - 1000 })
  assert.equal(settleState({ now: t0 + 5 * M, turnEnded: t0, finishMs: 5 * M }).done, true)
  // a suggestion (or a steer) at minute 4 starts the wait again
  const s = settleState({ now: t0 + 5 * M, turnEnded: t0, lastInput: t0 + 4 * M, finishMs: 5 * M })
  assert.deepEqual([s.done, s.until], [false, t0 + 9 * M])
  // the owner typing in the terminal too
  assert.equal(settleState({ now: t0 + 6 * M, turnEnded: t0, typedAt: t0 + 3 * M, finishMs: 5 * M }).done, false)
  // a steer typed in but not yet in the CLI's records holds it
  assert.deepEqual(settleState({ now: t0 + 10 * M, turnEnded: t0, pending: true }), { done: false, until: null, check: 500 })
  // 「끝내기」: at once (not while the CLI works)
  assert.equal(settleState({ now: t0 + 1000, turnEnded: t0, finishNow: true }).done, true)
  assert.equal(settleState({ now: t0 + 1000, turnEnded: t0, finishNow: true, busy: true }).done, false)
  // how long: an explicit value (tests, PGL_RUNNER_SETTLE_MS) over the desktop setting, else 5 minutes
  assert.equal(finishMsOf({ explicit: 800, env: '9000', minutes: 10 }), 800)
  assert.equal(finishMsOf({ explicit: null, env: '9000', minutes: 10 }), 9000)
  assert.equal(finishMsOf({ explicit: null, env: undefined, minutes: 10 }), 10 * M)
  assert.equal(finishMsOf({ explicit: null, env: undefined, minutes: null }), 5 * M)
})

// ---------- the runner, with the fake interactive CLI ----------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-conv-'))
const BIN = fakeBin(path.join(ROOT, 'bin'))
const SEARCH = [BIN, ...systemPath()].join(path.delimiter)
const ENV = { CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex') }
fs.mkdirSync(ENV.CLAUDE_CONFIG_DIR, { recursive: true })
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const FOLDER = crypto.randomUUID()
const USER = crypto.randomUUID()
const LOG = path.join(ROOT, 'fake.log')
let srv
test.before(async () => {
  process.env.FAKE_CLI_LOG = LOG
  const origin = makeRepo(path.join(ROOT, 'srv', 'f'), { '안내문.md': '# 안내문\n' })
  origin.git('checkout', '-q', '-b', 'inst/c')
  origin.git('checkout', '-q', 'main')
  srv = await gitServer({ repo: origin.dir, token: TOKEN })
})
test.after(async () => { await srv?.close(); try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* left */ } })
const sent = []
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) } }
const fakeLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
function runner(opts = {}) {
  const r = new Runner({ dataDir: path.join(ROOT, 'data'), server: srv.base, searchPath: SEARCH, sessionEnv: ENV, settleMs: 600,
    caps: { 'claude-code': { installed: true, runnable: true, version: '2.1.331' }, codex: { installed: true, runnable: true, version: '0.162.1' } }, ...opts })
  r.setLink({ send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); if (m.type === 'accept') setImmediate(() => r.handle({ type: 'accepted', jobId: m.jobId })); return true } })
  r.welcome({ user: { id: USER, name: '윤태호' } })
  return r
}
let n = 0
function job(prompt) {
  n++
  return { id: crypto.randomUUID(), todoId: `c${n}`, instId: `inst-c-${n}`, instName: '세미나 견적', activity: `견적서 작성 ${n}`, agent: 'claude-code', label: 'Claude Code',
    mode: 'complete', lang: 'ko', prompt: `「산출물/0${n}_견적서/」 폴더 안에 두세요.\n${prompt}`, outDir: `산출물/0${n}_견적서`, resultFile: '결과.md',
    person: { id: USER, name: '윤태호', email: 'yoon@example.test' },
    git: { path: srv.path, token: TOKEN, line: 'inst/c', base: 'inst/c', branch: `pgpt-agent/conv-${n}-${Date.now().toString(36)}`, folder: { id: FOLDER, slug: 'f', name: 'f' } } }
}
const sidOf = (jobId) => sent.find((m) => m.type === 'term-open' && m.ref === jobId)?.sid
const txOf = (sid) => sent.filter((m) => m.type === 'tx' && m.sid === sid).flatMap((m) => m.items)
const of = (id, type) => sent.filter((m) => m.jobId === id && (!type || m.type === type))

test('대화가 링크로 간다: 단계 프롬프트 · 생각 · 고침(차이) · 명령 · 스킬 · 말, 입력은 누구의 것인지(제안한 사람 · 작업자)와 함께', { skip: !P.load() && 'no node-pty' }, async () => {
  const r = runner()
  const j = job('THINK :: 요청 메일을 먼저 읽자\nWRITE_OUT 견적서.md :: | 대관 | 1,000,000원 |\nEDIT 견적서.md :: 1,000,000원 => 1,100,000원\nBASH wc -l 견적서.md :: 1 견적서.md\nSKILL 견적-규칙\nSLEEP 1500\nSAY :: 견적서를 **만들었어요**\\n- 합계 1,100,000원')
  r.handle({ type: 'job', job: j })
  const sid = await waitFor(() => sidOf(j.id))
  await waitFor(() => txOf(sid).some((i) => i.t === 'tool' && i.name === 'Bash'))
  r.steer(j.id, 's1', 'WRITE_OUT 하린.md :: 할인 줄을 따로', '윤태호', USER, '서하린')
  await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 30000)
  assert.equal(of(j.id, 'done')[0]?.type, 'done', JSON.stringify(of(j.id, 'failed')[0]))
  const items = txOf(sid)
  const first = items.find((i) => i.t === 'user')
  assert.equal(first.first, true, 'the step\'s own prompt')
  assert.ok(items.some((i) => i.t === 'thinking' && i.text === '요청 메일을 먼저 읽자'))
  const edit = items.find((i) => i.t === 'tool' && i.name === 'Edit')
  assert.equal(edit.input.path, `${j.outDir}/견적서.md`, 'the folder\'s own path')
  const er = items.find((i) => i.t === 'result' && i.call === edit.call)
  assert.ok(er.patch[0].lines.includes('+| 대관 | 1,100,000원 |'), JSON.stringify(er))
  assert.equal(items.find((i) => i.t === 'tool' && i.name === 'Skill').input.skill, '견적-규칙')
  assert.ok(items.some((i) => i.t === 'text' && i.text.includes('**만들었어요**')))
  // the steer as the CLI took it: whose suggestion, who put it in
  const steer = items.find((i) => i.t === 'user' && i.steerId === 's1')
  assert.deepEqual([steer.from, steer.by], ['서하린', '윤태호'])
  // turns from the CLI's hooks: start … end
  assert.deepEqual(items.filter((i) => i.t === 'turn').map((i) => i.state).slice(0, 1), ['start'])
  assert.ok(items.some((i) => i.t === 'turn' && i.state === 'end'))
  // the screen kept at the turn's end, before the CLI was closed; the wait the server was told of, then its end
  assert.ok(sent.findIndex((m) => m.type === 'term-keep' && m.sid === sid) < sent.findIndex((m) => m.type === 'term-exit' && m.sid === sid))
  const idles = of(j.id, 'idle')
  assert.ok(idles.some((m) => m.until) && idles.at(-1).until === null, JSON.stringify(idles))
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
})

test('CLI 가 허락을 물으면 카드가 생기고, 작업자의 「허락」이 그 터미널에 1 을 누른다 · 「거절」은 Esc — 턴이 멈춰도 단계는 사람을 기다린다', { skip: !P.load() && 'no node-pty' }, async () => {
  const r = runner({ settleMs: 1500 })
  const j = job('ASK python3 -c "print(42)"\nWRITE_OUT 다음.md :: 허락 뒤\nASK rm -rf 임시\nWRITE_OUT 안씀.md :: 거절 뒤에는 쓰지 않음')
  r.handle({ type: 'job', job: j })
  const sid = await waitFor(() => sidOf(j.id))
  const ask1 = await waitFor(() => txOf(sid).find((i) => i.t === 'ask'))
  assert.equal(ask1.ask.kind, 'permission')
  assert.equal(ask1.ask.tool, 'Bash')
  assert.equal(ask1.ask.brief, 'python3 -c "print(42)"')
  assert.deepEqual(ask1.ask.choices, ['yes', 'always', 'no'])
  // someone else's press (the server would not send it) is not taken
  await r.handle({ type: 'pty-answer', sid, ask: ask1.ask.id, answer: 'yes', byId: crypto.randomUUID() })
  await new Promise((res) => setTimeout(res, 400))
  assert.ok(!fakeLog().some((x) => x.answered), 'nothing pressed for someone else')
  // the owner's 「허락」
  await r.handle({ type: 'pty-answer', sid, ask: ask1.ask.id, answer: 'yes', byId: USER, by: '윤태호' })
  await waitFor(() => fakeLog().some((x) => x.answered === '1'))
  await waitFor(() => txOf(sid).some((i) => i.t === 'ask-done' && i.ask === ask1.ask.id && i.answer === 'yes'))
  // the same ask again: closed
  await r.handle({ type: 'pty-answer', sid, ask: ask1.ask.id, answer: 'yes', byId: USER })
  assert.equal(sent.filter((m) => m.type === 'answer-failed' && m.ask === ask1.ask.id).at(-1)?.reason, 'closed')
  // the second: 「거절」 → Esc; the turn stops (no Stop hook) and the run waits for its person, then ends (here: 1.5 s)
  const ask2 = await waitFor(() => txOf(sid).filter((i) => i.t === 'ask').find((i) => i.ask.id !== ask1.ask.id))
  await r.handle({ type: 'pty-answer', sid, ask: ask2.ask.id, answer: 'no', byId: USER })
  await waitFor(() => fakeLog().some((x) => x.answered === 'esc'))
  await waitFor(() => txOf(sid).some((i) => i.t === 'turn' && i.state === 'interrupted'))
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 20000)
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.ok(done.files.some((f) => f.endsWith('/다음.md')))
  assert.ok(!done.files.some((f) => f.endsWith('/안씀.md')), 'nothing after the refusal')
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
})

test('고르기 물음(AskUserQuestion): 작업자가 고른 항목의 번호가 눌리고 CLI 가 그 답으로 이어간다', { skip: !P.load() && 'no node-pty' }, async () => {
  const r = runner()
  const j = job('CHOOSE 금액을 부가세 포함으로 적을까요? :: 포함 | 별도\nCHOOSE 통화는? :: 원 | 달러 ;; 할인 줄은? :: 따로 | 합쳐서')
  r.handle({ type: 'job', job: j })
  const sid = await waitFor(() => sidOf(j.id))
  const a = await waitFor(() => txOf(sid).find((i) => i.t === 'ask'))
  assert.equal(a.ask.kind, 'question')
  assert.deepEqual(a.ask.questions[0].options.map((o) => o.label), ['포함', '별도'])
  await r.handle({ type: 'pty-answer', sid, ask: a.ask.id, answer: [1], byId: USER })
  // two questions at once: a number for each, then Enter on the review
  const b = await waitFor(() => txOf(sid).find((i) => i.t === 'ask' && i.ask.id !== a.ask.id))
  assert.equal(b.ask.questions.length, 2)
  await r.handle({ type: 'pty-answer', sid, ask: b.ask.id, answer: [1, 0], byId: USER })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 20000)
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.match(done.summary, /고른 것: 별도/)
  assert.match(done.summary, /고른 것: 달러, 따로/)
  assert.ok(fakeLog().some((x) => x.answered === 'enter'), 'the review submitted with Enter')
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
})

test('턴이 끝나면 기다리고, 제안이 오면 기다림이 다시 시작되며, 「끝내기」로 바로 끝난다', { skip: !P.load() && 'no node-pty' }, async () => {
  const r = runner({ settleMs: 60_000 })
  const j = job('WRITE_OUT 초안.md :: 첫 초안')
  r.handle({ type: 'job', job: j })
  const first = await waitFor(() => of(j.id, 'idle').find((m) => m.until))
  const until1 = Date.parse(first.until)
  assert.ok(until1 - Date.now() > 50_000 && until1 - Date.now() <= 60_000, 'it waits the minute it was given')
  await new Promise((res) => setTimeout(res, 1500))
  // a participant's suggestion: the wait starts again (the server hears of a move of a second or more)
  await r.handle({ type: 'suggestion', jobId: j.id, by: '서하린', text: '목차를 맨 앞에' })
  const later = await waitFor(() => of(j.id, 'idle').find((m) => m.until && Date.parse(m.until) > until1))
  assert.ok(Date.parse(later.until) - until1 >= 1000)
  assert.equal(of(j.id, 'done').length, 0, 'still waiting')
  // 「끝내기」
  await r.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 10000)
  assert.equal(done.type, 'done')
  assert.equal(of(j.id, 'idle').at(-1).until, null)
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
})
