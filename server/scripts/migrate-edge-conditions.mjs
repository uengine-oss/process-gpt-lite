// 이전(edge-step-condition): 「단계 규칙」(pro_step_requirements)과 다듬기 「단계 가르기」(pro_refine_reviews.classes)의 설정을 간선 설정
// (pro_edge_conditions, sql/047)으로 옮긴다. 프로세스마다 그 흐름의 진입 간선(edgecond.js entryEdgesOf)에 — 단계 설정은 그 단계로 들어오는
// 모든 간선에, 확정한 관문은 꼭으로(단계 규칙이 있으면 단계 규칙을 따르고 버린 관문은 원장에), 그 밖의 분류는 AI 제안 · 확정 여부 그대로.
// 이미 간선 설정이 있는 간선은 건드리지 않는다(여러 번 돌려도 된다). 다듬기가 건 태스크 고정(「다듬기: 꼭 하는 관문」)은 푼다.
// 옛 표는 지우지 않는다(되돌림용).
//   node scripts/migrate-edge-conditions.mjs [--as 관리자메일] [--dry]
import { config } from '../config.js'
import { q } from '../lib/supa.js'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const asEmail = args.includes('--as') ? args[args.indexOf('--as') + 1] : ''
const T = config.tenantId
const GATE_PIN = '다듬기: 꼭 하는 관문'

const EC = await import('../lib/ontology/edgecond.js')
const { procGraph } = await import('../lib/ontology/run.js')
const { ledger, pinTask } = await import('../lib/ontology/review.js')
const { normRule } = await import('../lib/ontology/steprule.js')

let me = { id: null, email: 'migrate-edge-conditions' }
if (asEmail) {
  const [p] = await q(`select user_id, email from pro_profile where email=$1`, [asEmail]).catch(() => [])
  if (p) me = { id: p.user_id, email: p.email }
  else console.warn(`[이전] ${asEmail} 계정을 찾지 못했어요 — 원장 기록 없이 진행해요`)
}

const reqRows = await q(`select proc_key, task, requirement, rules from pro_step_requirements where tenant_id=$1`, [T]).catch(() => [])
const classRows = await q(`select proc_key, classes from pro_refine_reviews where tenant_id=$1`, [T]).catch(() => [])
const procs = [...new Set([...reqRows.map((r) => r.proc_key), ...classRows.filter((r) => Object.keys(r.classes || {}).length).map((r) => r.proc_key)])]
const sum = { procs: 0, rows: 0, dropped: 0, unpinned: 0, skipped: [] }

for (const procKey of procs) {
  let view
  try { view = await procGraph(procKey) } catch (e) { sum.skipped.push(`${procKey}: ${e.message}`); continue }
  const entries = EC.entryEdgesOf(view)
  const reqs = new Map(reqRows.filter((r) => r.proc_key === procKey).map((r) => [r.task, { requirement: r.requirement || null, rules: (r.rules || []).map(normRule).filter(Boolean) }]))
  const classes = classRows.find((r) => r.proc_key === procKey)?.classes || {}
  const existing = new Set((await q(`select distinct event, task from pro_edge_conditions where tenant_id=$1 and proc_key=$2`, [T, procKey])).map((r) => EC.edgeKey(r.event, r.task)))
  const { rows, dropped, unpin } = EC.migrationRows({ entries, reqs, classes, existing })
  sum.procs++
  console.log(`\n「${view.proc.name}」(${procKey}) — 진입 간선 ${entries.length}개, 옮길 설정 ${rows.length}개`)
  for (const r of rows) console.log(`  ${r.event} → ${r.task}: ${r.requirement || '지도대로'}${r.rules.length ? ` · 규칙 ${r.rules.length}` : ''}${r.class ? ` · ${r.class.class}${r.class.decided ? '(확정)' : '(제안)'}` : ''}`)
  for (const d of dropped) console.log(`  버린 관문 「${d.task}」 — ${d.why}`)
  // a step whose old setting found no way in (not in the flow any more) is told, not lost — the old tables stay
  const lost = [...reqs.keys()].filter((k) => !entries.some((e) => e.step === k || e.task === k))
  for (const k of lost) console.log(`  단계 규칙 「${k}」 — 이 흐름에 들어오는 간선이 없어 옮기지 못했어요(옛 표에 남아요)`)
  if (dry) continue
  for (const r of rows) {
    await q(`insert into pro_edge_conditions (tenant_id, proc_key, event, task, requirement, rules, class, cleared, reason, by_user) values ($1,$2,$3,$4,$5,$6,$7,false,$8,$9)`,
      [T, procKey, r.event, r.task, r.requirement, JSON.stringify(r.rules), r.class ? JSON.stringify(r.class) : null, r.reason, me.email])
  }
  sum.rows += rows.length
  for (const d of dropped) {
    sum.dropped++
    if (me.id) await ledger(me, 'ontology.edgecond', `「${view.proc.name}」 「${d.task}」 관문은 옮기지 않았어요 — ${d.why}`, { process: procKey, task: d.task, action: 'migrate-drop-gate' })
  }
  for (const k of unpin) {
    const t = view.all.tasks.find((x) => x.key === k)
    if (t?.pinned && t.pin_reason === GATE_PIN) { await pinTask(me, k, { pinned: false, reason: '간선 설정으로 옮김: 관문 고정 풀기' }); sum.unpinned++; console.log(`  「${k}」 고정을 풀었어요`) }
  }
  if (me.id && rows.length) await ledger(me, 'ontology.edgecond', `「${view.proc.name}」 단계 규칙 · 단계 가르기 설정 ${rows.length}개를 간선 설정으로 옮겼어요`, { process: procKey, action: 'migrate', rows: rows.length })
}

console.log(`\n${dry ? '[미리 보기] ' : ''}프로세스 ${sum.procs}개 · 옮긴 설정 ${sum.rows}개 · 버린 관문 ${sum.dropped}개 · 푼 고정 ${sum.unpinned}개`)
for (const s of sum.skipped) console.log(`  건너뜀 ${s}`)
process.exit(0)
