// Process-mining demo setup: the three test accounts (영업 담당 · 재무 담당 · 관리자) on the team, the
// admin flag, the 재무 담당 role, and three earlier mail cases as handover records (marked demo).
// The fourth case is made live through the real mail → drafts → share → reply flow.
//   node scripts/seed-mining-demo.mjs <sales-email> <finance-email> <admin-email> [--reset]
// --reset removes what the demo made: mining rows, its handover records, the registered process.
import { q, pool } from '../lib/supa.js'
import { config } from '../config.js'
import { openCase, recordStep } from '../lib/mining/recorder.js'
import { ensureAgents } from '../lib/mining/service.js'

const T = config.tenantId
const [sales, fin, adm] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const reset = process.argv.includes('--reset')
const user = async (email) => {
  const [u] = await q(`select u.id::text as id, coalesce(p.name, u.username) as name from users u left join pro_profile p on p.user_id::text=u.id::text
                       where u.email=$1 and u.tenant_id=$2`, [email, T])
  if (!u) throw new Error(`${email}: log in once first (/api/auth/email/verify)`)
  return u
}

if (reset) {
  const sug = await q('select process_id, proc_def_id, pr_id, version_uuid from pro_mining_suggestions where tenant_id=$1', [T])
  for (const s of sug) {
    const id = s.proc_def_id || s.process_id
    for (const sql of [
      'delete from todolist where proc_def_id=$1', 'delete from bpm_proc_inst where proc_def_id=$1', 'delete from form_def where proc_def_id=$1',
      'delete from proc_def_version where proc_def_id=$1', 'delete from proc_def where id=$1', 'delete from pro_role_assignments where proc_def_id=$1']) await q(sql, [id]).catch((e) => console.warn(sql, e.message))
    if (s.pr_id) await q('delete from resource_pull_requests where id=$1', [s.pr_id])
  }
  await q(`delete from notifications where tenant_id=$1 and type='mining'`, [T])
  await q('delete from pro_mining_runs where tenant_id=$1', [T])
  await q('delete from pro_mining_suggestions where tenant_id=$1', [T])
  await q(`delete from handover_events where tenant_id=$1 and reason like 'pgpt-pro%'`, [T])
  await q('delete from pro_mining_cases where tenant_id=$1', [T])
  console.log('reset done', sug.length, 'suggestions')
}

if (sales) {
  const S = await user(sales), F = await user(fin), A = await user(adm)
  await q('update users set is_admin=true where id::text=$1 and tenant_id=$2', [A.id, T])
  for (const u of [S, F, A]) await q('insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing', [T, u.id])
  await q(`insert into pro_role_assignments(tenant_id,proc_def_id,role,user_id,updated_by) values ($1,'*','재무 담당',$2,$3)
           on conflict (tenant_id,proc_def_id,role) do update set user_id=excluded.user_id`, [T, F.id, A.id])
  await ensureAgents()

  // three earlier customers, a week apart (fictional companies)
  const past = [
    { id: 'demo-hanbit-dental', from: '최서윤 <seoyun.choi@hanbit-dental.example>', customer: '한빛치과', subject: '[한빛치과] 서현점 인테리어 설계 제안·견적 요청', day: '2026-10-05' },
    { id: 'demo-onsaemiro', from: '정다은 <daeun@onsaemiro-bakery.example>', customer: '온새미로 베이커리', subject: '온새미로 베이커리 망원점 설계 제안과 견적 부탁드려요', day: '2026-10-12' },
    { id: 'demo-greenfit', from: '한지호 <jiho.han@greenfit.example>', customer: '그린핏 필라테스', subject: '[그린핏] 판교 스튜디오 평면도·제안서·견적서 요청', day: '2026-10-19' },
  ]
  for (const m of past) {
    const at = (h, min = 0) => new Date(`${m.day}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+09:00`).toISOString()
    const files = { plan: `${m.customer} 평면도.dxf`, prop: `${m.customer} 제안서.hwpx`, quote: `${m.customer} 견적서.xlsx` }
    const caseId = await openCase({ userId: S.id, mail: { id: m.id, subject: m.subject }, customer: m.customer, files: Object.values(files), demo: true, at: at(9, 10) })
    const done = await q('select count(*)::int as n from handover_events where case_id=$1', [caseId])
    if (done[0].n) continue
    await recordStep(caseId, '요청 메일 접수', { to: { id: S.id, name: S.name }, at: at(9, 12), demo: true })
    await recordStep(caseId, '평면도 작성', { artifacts: [{ name: files.plan }], at: at(9, 20), demo: true })
    await recordStep(caseId, '제안서 작성', { artifacts: [{ name: files.prop }], at: at(9, 31), demo: true })
    await recordStep(caseId, '견적서 작성', { artifacts: [{ name: files.quote }], at: at(9, 38), demo: true })
    await recordStep(caseId, '재무 검토', { to: { id: F.id, name: F.name }, artifacts: [{ name: files.quote }, { name: files.prop }], at: at(10, 5), demo: true, note: '견적 금액과 부가세 확인 부탁드려요.' })
    await recordStep(caseId, '고객 회신', { to: { id: S.id, name: S.name }, at: at(14, 40), demo: true })
  }
  console.log({ sales: S, finance: F, admin: A })
  console.log(await q(`select case_id, count(*) from handover_events where tenant_id=$1 and reason like 'pgpt-pro%' group by 1`, [T]))
}
await pool.end()
