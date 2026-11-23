// 이전(gallimgil-merge): 말로 고치기의 길 조건(set_cond)과 말로 만든 프로세스의 길 조건(new_process ways[].when)을 간선 설정의
// 「사안에 따라」로 옮긴다(edgecond.js setWayCondition — X 에서 Y 로 들어오는 간선에 「…이면 → 꼭」, 끝이면 「…이면 여기서 끝」).
// 지도 오버레이는 이제 길 조건을 그리지 않는다(refine.js). 옮긴 set_cond 기록에는 was 를 남겨 되돌리기가 간선 설정을 되돌리게 한다.
// 이미 옮긴 것(was 가 있는 set_cond, 규칙이 있는 간선)은 건드리지 않는다(여러 번 돌려도 된다).
//   node scripts/migrate-way-conditions.mjs [--as 관리자메일] [--dry]
import { config } from '../config.js'
import { q } from '../lib/supa.js'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const asEmail = args.includes('--as') ? args[args.indexOf('--as') + 1] : ''
const T = config.tenantId
const EC = await import('../lib/ontology/edgecond.js')
const { procGraph } = await import('../lib/ontology/run.js')

let me = { id: null, email: 'migrate-way-conditions' }
if (asEmail) {
  const [p] = await q(`select user_id, email from pro_profile where email=$1`, [asEmail]).catch(() => [])
  if (p) me = { id: p.user_id, email: p.email }
}

const rows = await q(`select id::text as id, proc_key, op, args from pro_corrections where tenant_id=$1 and op in ('set_cond','new_process') order by at, id`, [T])
let moved = 0, kept = 0
const lost = []
for (const r of rows) {
  const a = r.args || {}
  const ways = r.op === 'set_cond' ? (Array.isArray(a.was) ? [] : [{ from: a.from, to: a.to, when: a.when ?? null }]) : (a.ways || []).filter((w) => w.when)
  if (!ways.length) continue
  let view
  try { view = await procGraph(r.proc_key) } catch (e) { lost.push(`${r.proc_key}: ${e.message}`); continue }
  const set = await EC.edgeConditionsOf(r.proc_key)
  const wasAll = []
  for (const w of ways) {
    const edges = EC.waysBetween(view, w.from, w.to)
    if (!edges.length) { lost.push(`「${view.proc.name}」 ${w.from} → ${w.to}: 이 흐름에 그 길이 없어요`); continue }
    if (edges.some((e) => set.get(EC.edgeKey(e.event, e.task))?.rules?.length)) { kept++; console.log(`  그대로 「${view.proc.name}」 ${w.from} → ${w.to}: 간선에 이미 규칙이 있어요`); continue }
    console.log(`  옮김 「${view.proc.name}」 ${w.from} → ${w.to}: ${w.when ? JSON.stringify(w.when) : '지움'}${dry ? ' (미리 보기)' : ''}`)
    if (dry) continue
    wasAll.push(...await EC.setWayCondition(me, r.proc_key, w.from, w.to, w.when, { reason: '길 조건을 간선 설정으로 옮김' }))
    moved++
  }
  if (!dry && r.op === 'set_cond') await q(`update pro_corrections set args = args || jsonb_build_object('was', $2::jsonb) where id::text=$1`, [r.id, JSON.stringify(wasAll)])
}
console.log(`\n${dry ? '[미리 보기] ' : ''}옮긴 길 조건 ${moved}개 · 그대로 ${kept}개`)
for (const l of lost) console.log(`  옮기지 못함 ${l}`)
process.exit(0)
