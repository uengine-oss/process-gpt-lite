// E2E S1 「지도 그리기」 (spec pgpt-pro_process-ontology): over HTTP against a running server + the real Ontological DB.
// 장진영 connects the demo mailbox → the past mail is read (90 days) through the funnel → together with the chat handovers
// already in the tenant, the company's process map is built in Ontological → the map shows the tasks, the learned
// condition at the quote, the stale bypass, the rare legal review under θ, the automatic values, and a past point in time.
// Also measures how well the reading recovered the true flows (the demo archive's truth).
//
//   PRO_API=http://ax.localhost:8790 node test/ontology-map.e2e.mjs [--keep-graph]
//
// Needs: tenant ax-demo seeded (node scripts/ax-demo.mjs --reset --seed), PRO_ONTOLOGY_* in server/.env.
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { q, pool } from '../lib/supa.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
const ARCHIVE = JSON.parse(fs.readFileSync(new URL('../scripts/fixtures/ax-demo-mailbox.json', import.meta.url), 'utf8'))
let failed = 0
const out = {}
const step = async (name, fn) => {
  try { out[name] = await fn(); console.log(`✓ ${name}`, JSON.stringify(out[name]).slice(0, 400)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
async function call(tok, method, path, body) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}: ${JSON.stringify(j).slice(0, 200)}`)
  return { id: j.user.id, tok: j.session.access_token, email }
}
const wait = async (tok, id, ms = 20 * 60_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const j = (await call(tok, 'GET', `/ontology/jobs/${id}`)).body
    if (j.status && j.status !== 'running') return j
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`job ${id} did not finish`)
}
const edge = (m, from, to) => m.edges.find((e) => e.from === from && e.to === to)

const boss = await signIn('pro-ax-jinyoung@uengine.org')

await step('메일 연결 전: 지도 없음', async () => {
  const s = (await call(boss.tok, 'GET', '/ontology/status')).body
  assert.equal(s.enabled, true, 'Ontological 연결')
  assert.equal(s.admin, true)
  // the first screen reads the map too: an empty graph (also one a reset dropped under a running server) is no map, not an error
  const m = await call(boss.tok, 'GET', '/ontology/map')
  assert.equal(m.status, 200, JSON.stringify(m.body))
  assert.equal(m.body.tasks.length, 0)
  return { meta: s.meta, tasks: m.body.tasks.length }
})

let mailJob
await step('데모 메일함 연결 → 지난 메일 읽기가 저절로 시작된다', async () => {
  const r = await call(boss.tok, 'POST', '/mail/connect', { provider: 'demo' })
  assert.equal(r.status, 200)
  for (let i = 0; i < 30 && !mailJob; i++) {
    const s = (await call(boss.tok, 'GET', '/ontology/status')).body
    if (s.mail && new Date(s.mail.started_at) > new Date(Date.now() - 120_000)) mailJob = s.mail
    else await new Promise((x) => setTimeout(x, 1000))
  }
  assert.ok(mailJob, '메일 연결 뒤 mail_history 작업이 없다')
  return { job: mailJob.id }
})

await step('깔때기: 규칙이 뉴스레터·no-reply·초대를 거르고, 일인 메일만 남긴다', async () => {
  const j = await wait(boss.tok, mailJob.id)
  assert.equal(j.status, 'done', j.error || '')
  // the window is the last 90 days before the archive's today
  const cut = new Date(ARCHIVE.today).getTime() - 90 * 86_400_000
  const inWindow = ARCHIVE.mails.filter((x) => new Date(x.date).getTime() >= cut)
  const noise = inWindow.filter((m) => m.kind !== 'work').length
  assert.equal(j.total, inWindow.length)
  assert.ok(j.kept <= j.total - noise, `kept ${j.kept} > work mails`)
  assert.ok(j.kept >= (j.total - noise) * 0.7, `kept ${j.kept} of ${j.total - noise} work mails`)
  const [{ n }] = await q(`select count(*)::int n from pro_mail_history where tenant_id='ax-demo'`)
  return { total: j.total, noise, kept: j.kept, found: j.found, rows: n }
})

let m
await step('지도: 메일 이력과 채팅 핸드오버가 함께 셈해진다', async () => {
  for (let i = 0; i < 300; i++) {
    const s = (await call(boss.tok, 'GET', '/ontology/status')).body
    if (s.build?.status === 'done' && new Date(s.build.started_at) >= new Date(mailJob.started_at)) break
    if (s.build?.status === 'failed') throw new Error(`build failed: ${s.build.error}`)
    await new Promise((x) => setTimeout(x, 2000))
  }
  m = (await call(boss.tok, 'GET', '/ontology/map')).body
  assert.ok(m.tasks?.length >= 8, `tasks ${m.tasks?.length}`)
  const src = m.meta.sources
  assert.ok(src.mail_history > 0 && src.chat_handover > 0, JSON.stringify(src))
  const names = m.tasks.map((t) => t.key)
  for (const k of ['견적서 작성', '재무 검토', '고객 회신']) assert.ok(names.includes(k), `${k} 없음: ${names.join(', ')}`)
  return { tasks: names.length, edges: m.edges.length, processes: m.processes.map((b) => `${b.name}:${b.band}:${b.cases}`), sources: src }
})

await step('사건 · 소속 · 역할(v0.3): 요청 메일과 결과물이 일을 일으키고, 한 일이 여러 프로세스에, 역할마다 사람 · 지표', async () => {
  const m = (await call(boss.tok, 'GET', '/ontology/map')).body
  const mail = m.triggers.filter((t) => t.from === 'mail').sort((a, b) => b.n - a.n)
  assert.ok(mail.length && /요청/.test(mail[0].to), JSON.stringify(mail.slice(0, 3)))
  const quote = m.events.find((e) => e.key.startsWith('artifact:견적서 작성:'))
  assert.ok(quote, m.events.map((e) => e.key).join(','))
  const after = m.triggers.filter((t) => t.from === quote.key).map((t) => `${t.to}:${t.split}`)
  assert.ok(after.some((x) => x.startsWith('재무 검토')) && after.some((x) => x.startsWith('고객 회신')), after.join(','))
  const shared = m.tasks.filter((t) => (t.procs || []).length > 1).map((t) => t.key)
  assert.ok(shared.length > 0)
  const sales = m.roles.find((r) => r.key === '영업')
  assert.ok(sales?.members >= 1 && sales.tasks.length > 0, JSON.stringify(sales))
  return { mail: mail.slice(0, 2).map((t) => `${t.to} ${t.n}`), quote: `${quote.key} ${quote.n} → ${after.join(' · ')}`, shared, roles: m.roles.map((r) => `${r.key}(${r.members})`) }
})

// 본문 · 첨부를 읽어(design-v0.3 §15): 이도윤의 주간 공정 보고는 메일 날짜가 매주 월요일 아침이고 메일도 그렇게 말한다,
// 박서연의 월 결산 보고는 세 번뿐이라 날짜로는 모자라고 메일이 「매월 1일 오전에」라고 말한다. 둘 다 시계 없는 타이머 사건.
// 보낸 첨부의 칸은 그 일의 양식이 된다. 건이 이끄는 일(고객 회신 · 평면도 작성 …)은 매일 있어도 타이머가 아니다.
await step('메일에서 찾은 정해진 때: 주간 공정 보고(매주 월 9시) · 월 결산 보고(매월 1일 9시), 보낸 첨부의 칸이 양식', async () => {
  const m = (await call(boss.tok, 'GET', '/ontology/map')).body
  const mined = m.triggers.filter((t) => t.source === 'mined' && String(t.from).startsWith('timer:mined:'))
  const ev = new Map(m.events.map((e) => [e.key, e]))
  const got = mined.map((t) => ({ task: t.to, cron: ev.get(t.from)?.cron, when: ev.get(t.from)?.name, n: t.n, p: t.p, says: t.cond }))
  for (const want of ARCHIVE.truth.set_times) {
    const hit = got.find((g) => g.cron === want.cron && (want.task.includes('공정') ? /공정/.test(g.task) : /결산/.test(g.task)))
    assert.ok(hit, `${want.task} ${want.cron} 없음: ${JSON.stringify(got)}`)
  }
  // (a mail that asks for the weekly report, or promises it, is a request or a reply: its words name the report's clock, not its own)
  assert.ok(!got.some((g) => /회신|평면도|실측|제안서|요청 메일 접수/.test(g.task)), `건이 이끄는 일이 타이머로: ${JSON.stringify(got)}`)
  assert.ok(/매주|월요일|9시/.test(got.find((g) => /공정/.test(g.task)).says || ''), '공정 보고의 「메일이 한 말」이 때를 말하지 않는다')
  const report = got.find((g) => /공정/.test(g.task)).task
  const d = (await call(boss.tok, 'GET', `/ontology/tasks/${encodeURIComponent(report)}`)).body
  const form = (d.templates || []).find((x) => /공정/.test(x.name))
  assert.ok(form?.fields?.includes('공정률(%)') && form.fields.includes('다음 주 할 일'), JSON.stringify(d.templates))
  return { timers: got.map((g) => `${g.when} · ${g.task}(메일 ${g.n}, 규칙성 ${g.p}${g.says ? `, “${g.says}”` : ''})`), form: `${form.name} ${form.fields.join(' · ')}` }
})

await step('견적서 → 재무 검토: 메일에 적힌 합계로 배운 조건(1천만 원)', async () => {
  const e = edge(m, '견적서 작성', '재무 검토')
  assert.ok(e, '견적서 작성 → 재무 검토 없음')
  assert.match(e.cond || '', /10,000,000원 이상/, `cond: ${e.cond}`)
  assert.ok(e.cond_cases?.loo > e.cond_cases?.baseline, JSON.stringify(e.cond_cases))
  return { p: e.p, cond: e.cond, evidence: e.cond_cases }
})

await step('실측 없이 바로 가던 옛 경로는 은퇴 후보(포아송)', async () => {
  const bypass = m.edges.find((e) => /요청/.test(e.from) && e.to === '평면도 작성')
  assert.ok(bypass, '요청 → 평면도 작성 경로 없음')
  assert.equal(bypass.stale, true, JSON.stringify(bypass))
  assert.ok(bypass.expected > 3, `expected ${bypass.expected}`)
  return { from: bypass.from, n: bypass.n, gapDays: Math.round(bypass.gap_days), expected: bypass.expected }
})

await step('드문 경로: 견적서 작성 뒤 한 번뿐인 길은 θ 기본에서 빠지고 전체(θ 0)에만, 은퇴 후보도 아니다', async () => {
  const rare = m.edges.filter((e) => e.from === '견적서 작성' && e.to !== '__end__').sort((a, b) => a.p - b.p)[0]
  assert.ok(rare && rare.n <= 2, JSON.stringify(rare))
  const A = m.processes.find((b) => b.tasks.includes('견적서 작성'))
  assert.ok(rare.p < A.theta, `p ${rare.p} θ ${A.theta}`)
  assert.equal(rare.stale, false, '드문 경로를 은퇴 후보로 올리면 안 된다')
  return { to: rare.to, p: rare.p, n: rare.n, theta: A.theta }
})

await step('자동 값: θ 는 재생 적합도 곡선에서, 반감기는 로그 우도로, 띠는 1위 맞히기로', async () => {
  const a = m.processes.find((b) => b.tasks.includes('견적서 작성'))
  assert.ok([0, 0.01, 0.02, 0.05, 0.1, 0.2].includes(a.theta), `theta ${a.theta}`)
  assert.equal(a.curve.length, 6)
  assert.ok([14, 30, 60, 90, 180].includes(a.half_life))
  assert.ok(['paved', 'open', 'watch'].includes(a.band))
  if (a.band === 'paved') assert.ok(a.a1 >= 0.5)
  if (a.band === 'open') assert.ok(a.a1 < 0.5)
  return { name: a.name, theta: a.theta, thetaStart: a.theta_start, halfLife: a.half_life, band: a.bandName, a1: a.a1, a3: a.a3, held: a.held, curve: a.curve }
})

await step('시점 고르기: 9월 1일의 지도에서는 옛 경로가 아직 살아 있다', async () => {
  const then = (await call(boss.tok, 'GET', '/ontology/map?at=2026-09-01')).body
  const b = then.edges.find((e) => /요청/.test(e.from) && e.to === '평면도 작성')
  assert.ok(b, '9월 1일 지도에 옛 경로 없음')
  assert.equal(b.stale, false)
  const now = m.edges.find((e) => e.from === b.from && e.to === b.to)
  assert.ok(b.p > now.p, `9/1 p ${b.p} vs now ${now.p}`)
  return { at: '2026-09-01', p: b.p, now: now.p, tasks: then.tasks.length }
})

await step('일 이름 맞추기: 긴 지시문도 일 이름 하나로', async () => {
  const l = (await call(boss.tok, 'GET', '/ontology/labels')).body
  const long = l.filter((x) => x.raw.length > 40)
  assert.ok(long.length > 0)
  assert.ok(long.every((x) => x.task && x.task.length <= 30))
  return long.slice(0, 3).map((x) => `${x.raw.slice(0, 30)}… → ${x.task}`)
})

await step('측정: 메일로 읽어 낸 흐름이 실제 흐름(정답)을 얼마나 되찾았나', async () => {
  // each true step's mail → the task the reader gave it (pro_mail_history → the name it was matched to)
  // the same naming the build uses (the matched name, then reviews by the reviewer's role)
  const { taskOf } = await import('../lib/ontology/build.js')
  const rows = await q(`select h.mail_id, h.act, h.from_role, h.to_role, coalesce(l.task, h.activity_label) as task from pro_mail_history h
                        left join pro_onto_labels l on l.tenant_id=h.tenant_id and l.raw=h.activity_label where h.tenant_id='ax-demo'`)
  const read = new Map(rows.map((r) => [r.mail_id, taskOf(r.task, r.act, { fromRole: r.from_role, toRole: r.to_role })]))
  const votes = new Map()
  let named = 0, same = 0
  for (const c of ARCHIVE.truth.cases) for (const st of c.steps) {
    if (!st.mail || !read.has(st.mail)) continue
    named++
    if (read.get(st.mail) === st.task) same++
    if (!votes.has(st.task)) votes.set(st.task, new Map())
    votes.get(st.task).set(read.get(st.mail), (votes.get(st.task).get(read.get(st.mail)) || 0) + 1)
  }
  const as = new Map([...votes].map(([t, v]) => [t, [...v].sort((a, b) => b[1] - a[1])[0][0]]))
  const truth = new Map()
  for (const c of ARCHIVE.truth.cases) for (let i = 0; i < c.steps.length - 1; i++) {
    const k = `${as.get(c.steps[i].task) || c.steps[i].task}>${as.get(c.steps[i + 1].task) || c.steps[i + 1].task}`
    truth.set(k, (truth.get(k) || 0) + 1)
  }
  const got = new Set(m.edges.map((e) => `${e.from}>${e.to}`))
  const total = [...truth.values()].reduce((s, v) => s + v, 0)
  const hit = [...truth].filter(([k]) => got.has(k)).reduce((s, [, v]) => s + v, 0)
  const missing = [...truth].filter(([k]) => !got.has(k)).map(([k, v]) => `${k}×${v}`)
  const recall = hit / total
  assert.ok(recall >= 0.8, `transition recall ${recall.toFixed(2)}; missing ${missing.join(', ')}`)
  return { stepsNamedSame: Number((same / named).toFixed(3)), steps: named, names: Object.fromEntries([...as].filter(([a, b]) => a !== b)), recall: Number(recall.toFixed(3)), transitions: total, missing }
})

await step('온보딩 요약 카드: 일 N개 · 흐름 · 띠', async () => {
  let card
  for (let i = 0; i < 30 && !card; i++) {
    ;[card] = await q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='onto-summary' and m.created_at >= $2 order by m.created_at desc limit 1`, [boss.id, mailJob.started_at])
    if (!card) await new Promise((x) => setTimeout(x, 2000))
  }
  assert.ok(card, '요약 카드가 없다')
  assert.match(card.content.text, /일 \d+개, 흐름 \d+개/)
  return card.content.text
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
fs.writeFileSync(new URL('../.scratch/ontology-map.e2e.json', import.meta.url), JSON.stringify(out, null, 1))
await pool.end()
process.exit(failed ? 1 : 0)
