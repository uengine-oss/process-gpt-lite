// 간선 조건(lib/ontology/edgecond.js) HTTP e2e — 꼭 · 선택을 이벤트 → 태스크 간선에서 프로세스마다 정하고, map 엔진(「지도에서 바로」)이 그대로 따르는지.
// 돌고 있는 Lite 서버에 화면이 부르는 API 그대로(간선 설정 패널 · 시작 카드 · 단계 카드의 진행/건너뛰기)를 부른다. 메일 · 에이전트 작업은 하지 않는다
// (건은 「제안」 단계라 단계마다 사람을 기다리고, 넘길 때는 건너뛰기만 쓴다).
//
//   cd server && node test/ontology-edgecond.e2e.mjs [--proc process:…] [--other process:…] [--as email]
//     기본: 간선이 가장 많은 프로세스(P)와, P 와 같은 태스크를 쓰는 다른 프로세스(Q)를 간선 목록에서 고른다
//   1  간선 설정 저장 · 다시 열기: P 의 한 간선에 「해도 되고 안 해도 되는 단계」 + 「금액 100만원 이상 → 꼭」을 저장하면 다시 읽어도 그대로, 이력 · 결정 원장에 남는다
//   2  다른 프로세스: 1 과 3 에서 P 의 간선을 바꾸는 동안 같은 태스크를 쓰는 Q 의 간선 설정 · 표시는 하나도 바뀌지 않는다
//   3  map 엔진, 실행 중에 바꾼 설정: 건을 W 에서 시작해 기다리는 동안 W → Y 간선을 꼭으로 바꾸고 W 를 건너뛰면, 지도가 Y 를 「꼭 하는 간선」으로 고른다
//   4  map 엔진, 중간 시작: Y 로 들어오는 간선이 꼭이면 Y 부터 시작한 건도 Y 가 꼭이고, 건너뛰려 하면 까닭을 묻기만 하고 건너뛰지 않는다
//   끝나면 바꾼 간선 설정 · 프로세스 단계 · 엔진을 처음대로 되돌린다(되돌린 것도 이력에 남는다). 만든 건은 멈춰 두고 지우지 않는다.
process.env.DOTENV_CONFIG_QUIET = 'true'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { q } = await import('../lib/supa.js')
const { withTenant } = await import('../lib/tenant.js')
const { cypher, closeOntology } = await import('../lib/ontology/store.js')
const { procGraph } = await import('../lib/ontology/run.js')
const { waysOut } = await import('../lib/ontology/mapengine.js')

const API = process.env.API_URL || `http://localhost:${process.env.PRO_PORT || 8787}/api`
const T = process.env.PRO_TENANT_ID || 'localhost'
const argv = process.argv.slice(2)
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null)
const BOSS = arg('--as') || process.env.E2E_ADMIN || 'resume-e2e@localhost.dev'
const START = new Date()
const OUT = { startedAt: START.toISOString(), checks: [], cases: [] }
const OUTFILE = process.env.E2E_OUT || path.join(HERE, '..', '..', '.scratch', 'edgecond-e2e.out.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function check(label, ok, detail = '') {
  OUT.checks.push({ label, ok: !!ok, detail })
  log(ok ? '  ✓' : '  ✗', label, detail ? `— ${detail}` : '')
  if (!ok) throw new Error(`실패: ${label} ${detail}`)
}
const save = () => { fs.mkdirSync(path.dirname(OUTFILE), { recursive: true }); fs.writeFileSync(OUTFILE, JSON.stringify(OUT, null, 1)) }

async function call(tok, method, p, body) {
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${j.error || ''}`), { status: r.status, body: j })
  return j
}
async function signIn(email) {
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}: ${JSON.stringify(j).slice(0, 160)}`)
  return { id: j.user.id, tok: j.session.access_token, email }
}
async function waitFor(what, fn, { timeout = 120_000, every = 2000 } = {}) {
  const until = Date.now() + timeout
  for (;;) {
    const v = await fn().catch((e) => { log('  (wait)', e.message); return null })
    if (v) return v
    if (Date.now() > until) throw new Error(`시간 초과: ${what}`)
    await sleep(every)
  }
}

const enc = encodeURIComponent
const edgesOf = async (who, proc) => call(who.tok, 'GET', `/ontology/processes/${enc(proc)}/edge-conditions`)
// the edge panel's reading of one edge, as {requirement, rules, class} (null when nothing is set)
const asSetting = (v) => (v.requirement || v.rules?.length || v.class ? { requirement: v.requirement, rules: v.rules || [], class: v.class } : null)
const edgeOf = async (who, proc, e) => asSetting(await call(who.tok, 'GET', `/ontology/processes/${enc(proc)}/edge-condition?event=${enc(e.event)}&task=${enc(e.task)}`))
const decidedCls = (s) => (s?.class?.decided ? s.class.class : null)
// what the events view shows for every edge of a process — compared before and after
const face = (list) => list.edges.map((e) => `${e.event}→${e.task}|${e.mark || ''}|${e.setting?.requirement || ''}|${JSON.stringify((e.setting?.rules || []).map((r) => [r.when, r.then]))}|${decidedCls(e.setting) || ''}`).sort()

// every edge this run touches: its setting before, put back at the end
const touched = new Map()
// one save per edge (as the panel does), each keeping its own decided class — the run changes only 꼭 · 선택
async function setEdges(who, proc, edges, setting, reason) {
  let last = null
  for (const e of edges) {
    const k = `${proc}\u0000${e.event}\u0000${e.task}`
    if (!touched.has(k)) touched.set(k, { proc, event: e.event, task: e.task, was: await edgeOf(who, proc, e) })
    last = await call(who.tok, 'PUT', `/ontology/processes/${enc(proc)}/edge-condition`, { event: e.event, task: e.task, ...setting, class: decidedCls(touched.get(k).was), reason })
  }
  return last
}
async function putBack(who) {
  for (const t of touched.values()) {
    const w = t.was
    await call(who.tok, 'PUT', `/ontology/processes/${enc(t.proc)}/edge-condition`, { event: t.event, task: t.task, requirement: w?.requirement || null,
      rules: (w?.rules || []).map((r) => ({ when: r.when, then: r.then })), class: decidedCls(w), reason: 'e2e: 원래대로' }).catch((e) => log('  되돌리기 실패', t.event, t.task, e.message))
  }
}

const stepOf = async (caseId, task, states) => (await q(`select * from pro_case_steps where case_id=$1 and task=$2 ${states ? 'and state = any($3)' : ''} order by created_at desc limit 1`, states ? [caseId, task, states] : [caseId, task]))[0]
const waiting = (caseId, task) => waitFor(`「${task}」 단계가 사람을 기다림`, async () => { const s = await stepOf(caseId, task, ['waiting']); return s?.message_id ? s : null })
async function startCase(who, proc, entry, subject) {
  const r = await call(who.tok, 'POST', '/ontology/cases', { proc, entry, subject, body: `${subject}(간선 조건 e2e — 단계는 건너뛰기만 해요)`, from: '시험 <e2e@example.test>', kind: 'manual' })
  OUT.cases.push(r.caseId); save()
  return r.caseId
}

const procStatus = async (proc) => (await withTenant(T, () => cypher(`MATCH (b:Process {key:$key}) RETURN b.status AS status, b.name AS name`, { key: proc })))[0] || {}

async function main() {
  const boss = await signIn(BOSS)
  log(`관리자 ${BOSS} · ${API} · 테넌트 ${T}`)
  const engine0 = await call(boss.tok, 'GET', '/ontology/engine')
  check('관리자 계정', engine0.admin === true)

  // P (the process changed) and Q (another process using one of P's tasks)
  let P = arg('--proc'), Q = arg('--other')
  const procs = (await withTenant(T, () => cypher(`MATCH (b:Process) WHERE b.status IN ['adopted','suggested'] AND coalesce(b.kind,'') <> 'routine' RETURN b.key AS key`, {}))).map((x) => x.key)
  const lists = new Map()
  const listOf = async (k) => { if (!lists.has(k)) lists.set(k, await edgesOf(boss, k).catch(() => null)); return lists.get(k) }
  if (!P) { let best = 0; for (const k of procs) { const l = await listOf(k); if (l && l.edges.length > best) { best = l.edges.length; P = k } } }
  const pl = await listOf(P)
  const tasksP = new Set(pl.edges.filter((e) => e.kind !== 'start').map((e) => e.task))
  if (!Q) for (const k of procs) { if (k === P) continue; const l = await listOf(k); if (l?.edges.some((e) => e.kind !== 'start' && tasksP.has(e.task))) { Q = k; break } }
  check('같은 태스크를 쓰는 두 프로세스', P && Q, `${P} · ${Q}`)
  const ql0 = await edgesOf(boss, Q)
  const X = ql0.edges.find((e) => e.kind !== 'start' && tasksP.has(e.task)).task
  log(`P 「${pl.proc.name}」 · Q 「${ql0.proc.name}」 · 같은 태스크 「${X}」`)
  OUT.p = P; OUT.q = Q; OUT.shared = X

  // the run reads the map engine and asks at every step (a 「제안」 process): set both for the run, put back at the end
  const st0 = await procStatus(P)
  if (engine0.engine !== 'map') await call(boss.tok, 'PUT', '/ontology/engine', { engine: 'map' })
  if (st0.status !== 'suggested') await call(boss.tok, 'POST', '/ontology/processes/status', { key: P, status: 'suggested', name: st0.name })
  try {
    log('— 1 간선 설정 저장 · 다시 열기')
    const e1 = pl.edges.find((e) => e.kind !== 'start' && e.task === X)
    const rows0 = Number((await q(`select count(*) n from pro_edge_conditions where tenant_id=$1 and proc_key=$2 and event=$3 and task=$4`, [T, P, e1.event, e1.task]))[0].n)
    const saved = await setEdges(boss, P, [e1], { requirement: 'optional', rules: [{ when: { field: 'amount', op: '>=', value: 1000000 }, then: 'required' }] }, 'e2e: 저장 · 다시 열기')
    check('저장한 화면이 돌려준 설정', saved.requirement === 'optional' && saved.rules?.[0]?.then === 'required', JSON.stringify(saved.rules))
    const again = await edgeOf(boss, P, e1)
    check('다시 열어도 그대로(해도 되고 안 해도 되는 단계 · 금액 100만원 이상 → 꼭)', again?.requirement === 'optional' && again.rules.length === 1 && again.rules[0].when?.value === 1000000 && again.rules[0].text?.includes('100만'),
      again?.rules?.[0]?.text)
    const shown = (await edgesOf(boss, P)).edges.find((e) => e.event === e1.event && e.task === e1.task)
    check('사건 보기의 간선 표시: 사안에 따라(꼭이 될 수 있음)', ['cond', 'opt'].includes(shown.mark), shown.mark)
    const rows1 = Number((await q(`select count(*) n from pro_edge_conditions where tenant_id=$1 and proc_key=$2 and event=$3 and task=$4`, [T, P, e1.event, e1.task]))[0].n)
    check('저장마다 이력 한 줄', rows1 === rows0 + 1, `${rows0} → ${rows1}`)
    const led = await q(`select 1 from pro_policy_decisions where tenant_id=$1 and action_kind='ontology.edgecond' and created_at >= $2 and facts->>'process'=$3 and facts->>'task'=$4 limit 1`, [T, START, P, e1.task])
    check('결정 원장에 남음', led.length === 1)

    log('— 3 map 엔진: 실행 중에 바꾼 설정')
    // W: a task of P with two or more next tasks to choose between (not opened side by side — run.js parallelPair), none of them 꼭 yet;
    // Y: one of them (not the first listed)
    const view = await withTenant(T, () => procGraph(P))
    const sideBySide = (ys) => (view.edges || []).some((e) => e.parallel && ys.includes(e.from) && ys.includes(e.to))
    const next = new Map()
    for (const e of pl.edges) { const m = e.event.match(/^(?:artifact|done):([^:]+)/); if (m && m[1] !== e.task) { if (!next.has(m[1])) next.set(m[1], []); next.get(m[1]).push(e) } }
    // (the ways the map engine itself sees from W — mapengine.js waysOut, after θ — must still be two or more)
    const seen = (w) => waysOut(view, w, view.proc?.theta ?? 0.05).outs.map((o) => o.to)
    const [W, outs] = [...next].find(([w, es]) => { const ys = [...new Set(es.map((e) => e.task))].filter((y) => seen(w).includes(y)); return ys.length >= 2 && !sideBySide(ys) && !es.some((e) => ['req', 'cond'].includes(e.mark)) && pl.edges.some((x) => x.task === w) }) || []
    check('지도 엔진이 보는 갈래(하나를 고름)가 둘 이상이고 꼭인 간선이 없는 태스크', !!W, W)
    // Y: the rarest of the ways the engine sees — left to itself it would not take it
    const ways0 = waysOut(view, W, view.proc?.theta ?? 0.05).outs
    const ys = [...new Set(outs.map((e) => e.task))].filter((y) => seen(W).includes(y))
    const Y = [...ys].sort((a, b) => (ways0.find((o) => o.to === a)?.p || 0) - (ways0.find((o) => o.to === b)?.p || 0))[0]
    log(`  W 「${W}」 → ${ways0.map((o) => `${o.to} ${Math.round((o.p || 0) * 100)}%`).join(' · ')} · Y 「${Y}」`)
    await setEdges(boss, P, pl.edges.filter((e) => e.task === W), { requirement: 'optional', rules: [] }, 'e2e: 건너뛸 수 있게')
    const c1 = await startCase(boss, P, W, `[e2e] 실행 중에 바꾼 간선 조건 ${START.toISOString().slice(11, 16)}`)
    const w1 = await waiting(c1, W)
    const caseRow = (await q(`select engine, run_mode from pro_po_cases where id=$1`, [c1]))[0]
    check('건은 map 엔진 · 단계마다 사람이 정함', caseRow.engine === 'map' && caseRow.run_mode === 'hitl', JSON.stringify(caseRow))
    check(`「${W}」: 해도 되고 안 해도 되는 단계로 읽음`, w1.requirement === 'optional', w1.requirement)
    // the case is already running: now W → Y becomes 꼭
    await setEdges(boss, P, outs.filter((e) => e.task === Y), { requirement: 'required', rules: [] }, 'e2e: 실행 중에 꼭으로')
    const sk = await call(boss.tok, 'POST', `/ontology/steps/${w1.id}`, { action: 'skip', reason: 'e2e: 건너뜀' })
    check(`「${W}」 건너뛰기`, sk.skipped === true)
    const y1 = await waiting(c1, Y)
    // (unfold drops the ways around a 꼭 way, so it reads as the one way left — or, with a loop keeping another, as 꼭 하는 간선)
    const viaOk = y1.via?.from === W && (y1.via.how === 'required' || (y1.via.how === 'single' && (y1.via.outs || []).every((o) => o.to === Y)))
    check(`지도가 가장 드문 「${Y}」를 고름 — 건을 시작한 뒤 꼭으로 바꾼 간선을 따르고 다른 갈래는 빠짐`, viaOk, JSON.stringify({ how: y1.via?.how, outs: y1.via?.outs?.map((o) => o.to) }))
    check(`「${Y}」: 꼭 하는 단계로 읽음`, y1.requirement === 'required', y1.requirement)
    const tryY = await call(boss.tok, 'POST', `/ontology/steps/${y1.id}`, { action: 'skip' })
    check('꼭 하는 단계는 건너뛰기를 누르면 까닭을 묻기만 함', tryY.confirm === true && tryY.required === true && !tryY.skipped, JSON.stringify(tryY))
    check('단계는 그대로 기다림', (await stepOf(c1, Y)).state === 'waiting')
    await call(boss.tok, 'POST', `/ontology/cases/${c1}/pause`).catch(() => {})

    log('— 4 map 엔진: 중간 시작')
    const intoY = pl.edges.filter((e) => e.task === Y)
    await setEdges(boss, P, intoY, { requirement: 'required', rules: [] }, 'e2e: 중간 시작 시험')
    const c2 = await startCase(boss, P, Y, `[e2e] 중간 시작 간선 조건 ${START.toISOString().slice(11, 16)}`)
    const h = (await q(`select entry_task, history from pro_po_cases where id=$1`, [c2]))[0]
    const skipped = (h.history || []).filter((x) => x.state === 'skipped').map((x) => x.task)
    const y2 = await waiting(c2, Y)
    check(`「${Y}」부터 시작한 건(앞 단계 ${skipped.join(' · ') || '없음'} 건너뜀)도 꼭 하는 단계`, y2.requirement === 'required', `${y2.requirement} · ${JSON.stringify(y2.matched?.edge || y2.matched || null)}`)
    const try2 = await call(boss.tok, 'POST', `/ontology/steps/${y2.id}`, { action: 'skip' })
    check('중간 시작한 건도 건너뛰지 않고 까닭을 물음', try2.confirm === true && try2.required === true, JSON.stringify(try2))
    await call(boss.tok, 'POST', `/ontology/cases/${c2}/pause`).catch(() => {})

    log('— 2 다른 프로세스')
    const ql1 = await edgesOf(boss, Q)
    const a = face(ql0), b = face(ql1)
    const gone = a.filter((x) => !b.includes(x)), came = b.filter((x) => !a.includes(x))
    check(`「${ql0.proc.name}」의 간선 설정 · 표시가 하나도 바뀌지 않음(같은 태스크 「${X}」 포함)`, !gone.length && !came.length, `전: ${gone.join(' / ')} · 뒤: ${came.join(' / ')}`)
    const qRows = Number((await q(`select count(*) n from pro_edge_conditions where tenant_id=$1 and proc_key=$2 and at >= $3`, [T, Q, START]))[0].n)
    check(`「${ql0.proc.name}」에 이 시험이 쓴 설정 0줄`, qRows === 0, String(qRows))
  } finally {
    await putBack(boss)
    const back = await edgesOf(boss, P)
    const changed = [...touched.values()].filter((t) => { const e = back.edges.find((x) => x.event === t.event && x.task === t.task); return (e?.setting?.requirement || null) !== (t.was?.requirement || null) || JSON.stringify((e?.setting?.rules || []).map((r) => [r.when, r.then])) !== JSON.stringify((t.was?.rules || []).map((r) => [r.when, r.then])) || decidedCls(e?.setting) !== decidedCls(t.was) })
    log(changed.length ? `  ✗ 되돌리지 못한 간선 ${changed.map((t) => `${t.event}→${t.task}`).join(', ')}` : `  ✓ 바꾼 간선 ${touched.size}개를 처음대로`)
    if (st0.status && st0.status !== 'suggested') await call(boss.tok, 'POST', '/ontology/processes/status', { key: P, status: st0.status, name: st0.name }).catch((e) => log('  단계 되돌리기', e.message))
    if (engine0.engine !== 'map') await call(boss.tok, 'PUT', '/ontology/engine', { engine: engine0.engine }).catch((e) => log('  엔진 되돌리기', e.message))
    save()
  }
}

let failed = false
try { await main(); log(`통과 ${OUT.checks.filter((c) => c.ok).length}개 · 건 ${OUT.cases.join(', ')} (멈춰 둠)`) } catch (e) { failed = true; log('실패', e.message) }
await closeOntology().catch(() => {})
process.exit(failed ? 1 : 0)
