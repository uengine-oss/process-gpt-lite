// 약속 읽기 사례(test/agenda-cases.json, 22건) — 판정 → 읽기 → 서버의 확인(lib/agenda/read.js)을 사례마다 끝까지 돌린다.
//   기본: 가짜 모델 서버(OpenAI 호환 — 첫 글자 확률 · JSON 답)가 사례의 fake 를 그대로 답한다. 결정적이고 모델을 부르지 않는다:
//         판정의 문턱(0.3 아래는 읽지 않음) · 모델이 보는 입력 · 서버의 확인(지난 날 · 같은 약속 · 열쇠 → id)을 본다.
//   AGENDA_EVAL=1 (또는 PLANS_EVAL=1): .env 의 모델 게이트웨이로 같은 사례를 실제 모델이 읽는다. 정확도를 표로 내고
//         openspec/specs/agenda-reminders/e2e/results/model-eval.json 에 남긴다(AGENDA_EVAL_FLOOR 가 있으면 그 아래면 실패).
// 맞음의 기준(expect.ops): 일의 수가 같고, 일마다 op · 약속(plan) · 날짜 · 시각 · 종일이 같고, 곳 · 챙길 것 · 링크는 그 말을 담고, 사람은 그 이름들.
// 이름은 지어낸 것.
//   cd server && node --test test/agenda-read.test.js
//   cd server && AGENDA_EVAL=1 node --test test/agenda-read.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EVAL = process.env.AGENDA_EVAL === '1' || process.env.PLANS_EVAL === '1'
process.env.PRO_TENANT_ID = 'agenda-read'
process.env.PRO_BACKGROUND = '0'
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_JUDGE_URL = ''
const CASES = JSON.parse(fs.readFileSync(new URL('./agenda-cases.json', import.meta.url)))
let current = null
const calls = []
let server = null
if (!EVAL) {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const b = JSON.parse(raw || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (b.max_tokens === 1 && b.logprobs) {
        calls.push({ case: current?.name, kind: 'gate', prompt: b.messages?.[0]?.content || '' })
        const p = current?.fake?.gate ?? 0
        return res.end(JSON.stringify({ choices: [{ message: { content: p >= 0.5 ? 'A' : 'B' }, logprobs: { content: [{ token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(Math.max(p, 1e-6)) }, { token: 'B', logprob: Math.log(Math.max(1 - p, 1e-6)) }] }] } }] }))
      }
      calls.push({ case: current?.name, kind: 'read', system: b.messages?.[0]?.content || '', input: JSON.parse(b.messages?.[1]?.content || '{}') })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ ops: current?.fake?.ops || [] }) }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  process.env.PRO_LLM_API_KEY = 'test'
}
const R = await import('../lib/agenda/read.js')
const { pool } = await import('../lib/supa.js')
const sk = await R.agendaSkill()
after(async () => { server?.close(); await pool.end().catch(() => {}) })

const SEOUL = 'Asia/Seoul'
const NAMES = ['정하윤', '김서연', '박도윤', '이지후']
const members = NAMES.map((name, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 1}`, name }))
const nameOf = (id) => members.find((m) => m.id === id)?.name

function setup(c) {
  const now = new Date(c.now || '2026-11-26T14:00:00+09:00')
  const plans = (c.plans || []).map((p, i) => ({ id: `p-${i + 1}`, tz: SEOUL, allDay: !p.start, durationMin: 60, link: '', bring: '', notes: '', audience: c.where === 'mail' ? 'owner' : 'room',
    participants: c.where === 'mail' ? [members[0].id] : members.map((m) => m.id), ...p }))
  const messages = (c.messages || []).map((m, i) => ({ uuid: `u-${i + 1}`, who: m.who, at: new Date(m.at), text: m.text, fresh: !!m.new }))
  const { input, keys } = R.inputFor({ where: c.where, now, tz: SEOUL, plans, members: c.where === 'room' ? members : [], messages, mail: c.mail ? { ...c.mail, date: new Date(c.mail.date) } : null, rules: sk.rules })
  return { now, input, keys, last: messages.filter((m) => m.fresh).at(-1)?.uuid || null }
}
async function run(c) {
  current = c
  const { now, input, keys, last } = setup(c)
  const t = Date.now()
  const gate = await R.gate(input, { skill: sk })
  if (!gate) return { error: 'gate unreadable', ms: Date.now() - t }
  if (!gate.pass) return { gate, ops: [], read: false, ms: Date.now() - t }
  let raw
  try { raw = await R.extract(input, { skill: sk }) } catch (e) { return { gate, error: e.message, ms: Date.now() - t } }
  const { ops, skipped } = R.checkOps(raw, { where: c.where, now, tz: SEOUL, keys, rules: sk.rules, lastMessage: last })
  return { gate, raw, ops, skipped, read: true, ms: Date.now() - t }
}
// one checked op against one expected one → '' when it fits, else why not
function differs(e, o) {
  if (e.op !== o.op) return `op ${o.op}≠${e.op}`
  if (e.plan && o.id !== `p-${Number(e.plan.slice(1))}`) return `plan ${o.id}≠${e.plan}`
  const it = o.item || {}
  for (const k of ['date', 'start']) if (e[k] !== undefined && it[k] !== e[k]) return `${k} ${it[k]}≠${e[k]}`
  if (e.allDay !== undefined && !!it.allDay !== e.allDay) return `allDay ${it.allDay}`
  if (e.place && !String(it.location || '').includes(e.place)) return `place 「${it.location}」∌${e.place}`
  if (e.bring && !String(it.bring || '').includes(e.bring)) return `bring 「${it.bring}」∌${e.bring}`
  if (e.link && !String(it.link || '').includes(e.link)) return `link 「${it.link}」∌${e.link}`
  if (e.people && [...(o.people || [])].map(nameOf).sort().join() !== [...e.people].sort().join()) return `people ${(o.people || []).map(nameOf)}≠${e.people}`
  return ''
}
function judge(c, r) {
  if (r.error) return `error: ${r.error}`
  const want = c.expect.ops, got = r.ops
  if (want.length !== got.length) return `ops ${got.length}≠${want.length} (${got.map((o) => o.op).join(',') || '없음'})`
  const left = [...got]
  for (const e of want) {
    const i = left.findIndex((o) => !differs(e, o))
    if (i < 0) return `no match for ${JSON.stringify(e)}: ${left.map((o) => differs(e, o)).join(' / ')}`
    left.splice(i, 1)
  }
  return ''
}

if (!EVAL) {
  for (const c of CASES) {
    test(`사례 · ${c.name}`, async () => {
      const before = calls.length
      const r = await run(c)
      assert.equal(judge(c, r), '', JSON.stringify(r))
      const mine = calls.slice(before)
      assert.equal(mine[0].kind, 'gate', '판정을 먼저 묻는다')
      assert.equal(mine.some((x) => x.kind === 'read'), (c.fake.gate ?? 0) >= sk.rules.gateMin, '문턱 아래면 읽지 않는다')
      const read = mine.find((x) => x.kind === 'read')
      if (read) {
        assert.equal(read.system, sk.prompts['read-plans'])
        assert.equal(read.input.today, '2026-11-26 (목)')
        assert.equal(read.input.calendar.length, sk.rules.calendarDays)
        assert.equal(read.input.plans.length, (c.plans || []).length)
        if (c.where === 'room') assert.deepEqual(read.input.members.map((m) => m.name), NAMES)
        else assert.equal(read.input.mail.subject, c.mail.subject)
      }
    })
  }
  test('판정이 보는 것: 정해 둔 약속과 새 메시지(새 표시) — 메일은 보낸 사람 · 제목 · 본문 앞부분', () => {
    const g = calls.find((x) => x.case === CASES[2].name && x.kind === 'gate').prompt
    assert.match(g, /- P1 시니어그룹 모임 · 2026-12-01 \(화\) 15:00 · 강남역 스타벅스/)
    assert.match(g, /#2 \[새\] 김서연 \(2026-11-26 \(목\) 13:58\): 장소 바뀌었어요 역삼역으로/)
    assert.match(g, /^#1 김서연/m, '앞의 맥락은 새 표시 없이')
    assert.match(g, /A\) 있다/)
    const mail = calls.find((x) => x.case === CASES[16].name && x.kind === 'gate').prompt
    assert.match(mail, /제목: 12월 정기 모임 안내/)
  })
} else {
  test(`실제 모델로 약속 읽기 사례 ${CASES.length}건`, { timeout: 30 * 60_000 }, async () => {
    const rows = []
    for (const c of CASES) {
      const r = await run(c)
      const why = judge(c, r)
      rows.push({ name: c.name, ok: !why, why, gate: r.gate?.p ?? null, by: r.gate?.by || null, read: !!r.read, ms: r.ms,
        got: (r.ops || []).map((o) => ({ op: o.op, ...(o.id ? { plan: o.id } : {}), ...(o.item ? { title: o.item.title, date: o.item.date, start: o.item.start, allDay: o.item.allDay, location: o.item.location, bring: o.item.bring, link: o.item.link } : {}), ...(o.people ? { people: o.people.map(nameOf) } : {}) })),
        skipped: r.skipped || [], ...(r.error ? { error: r.error } : {}) })
      console.log(`${!why ? 'ok  ' : 'MISS'} ${c.name}${why ? ` — ${why}` : ''} (gate ${r.gate?.p ?? '-'} ${r.gate?.by || ''}, ${r.ms} ms)`)
    }
    const ok = rows.filter((x) => x.ok).length
    const none = CASES.filter((c) => !c.expect.ops.length)
    const gatedRight = rows.filter((x, i) => !CASES[i].expect.ops.length && !x.read).length
    const summary = { at: new Date().toISOString(), model: (await import('../config.js')).config.llm.model, oddsModel: (await import('../config.js')).config.llm.oddsModel || null,
      skill: sk.version, cases: CASES.length, correct: ok, accuracy: Math.round((ok / CASES.length) * 1000) / 1000,
      noPlanCases: none.length, stoppedAtGate: gatedRight, readMsMedian: rows.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)], rows }
    const here = path.dirname(fileURLToPath(import.meta.url))
    const out = path.join(here, '..', '..', 'openspec', 'specs', 'agenda-reminders', 'e2e', 'results', 'model-eval.json')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(summary, null, 1) + '\n')
    console.log(`accuracy ${ok}/${CASES.length} = ${summary.accuracy} · 약속 없는 사례 ${none.length}건 중 판정에서 멈춤 ${gatedRight}건 · ${out}`)
    if (process.env.AGENDA_EVAL_FLOOR) assert.ok(summary.accuracy >= Number(process.env.AGENDA_EVAL_FLOOR), `accuracy ${summary.accuracy}`)
  })
}
