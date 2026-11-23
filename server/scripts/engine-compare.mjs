// 실행 방식의 엔진 견주기: 건마다 어느 엔진으로 돌았는지, 실행 묶음 · bpm_proc_inst 행 · 프로세스 정의(proc_def) · 할 일(todolist) ·
// 단계(pro_case_steps) · 옮기기 · 되감기가 몇 개인지. 「프로세스 정의로(bpm)」는 건이 옮기거나 되감길 때마다 스냅샷과 인스턴스가 늘고,
// 「지도에서 바로(map)」는 처음부터 끝까지 인스턴스 하나(bpm_proc_inst 한 행)에 정의 없이 간다.
//   실행 묶음 = 건이 든 인스턴스 id(pro_po_cases.instances — todolist.proc_inst_id 로 할 일을 묶는 값) 개수
//   bpm_proc_inst 행 = 그 id 들 가운데 공용 인스턴스 테이블에 행이 있는 것 — 두 열은 같은 것을 다른 곳에서 센 것이고, 이제 두 엔진 모두 같다
//
//   cd server && PRO_TENANT_ID=jy-mail node scripts/engine-compare.mjs --case <건 id> [--case <건 id> …]
//   cd server && PRO_TENANT_ID=jy-mail node scripts/engine-compare.mjs --tenant [--limit 20]
//   (--json: 같은 내용을 JSON 으로)
process.env.DOTENV_CONFIG_QUIET = 'true'
const { q, pool } = await import('../lib/supa.js')
const { config } = await import('../config.js')

const argv = process.argv.slice(2)
const cases = argv.flatMap((a, i) => (a === '--case' && argv[i + 1] ? [argv[i + 1]] : []))
const all = argv.includes('--tenant')
const limit = Number(argv[argv.indexOf('--limit') + 1]) || 20
const json = argv.includes('--json')
const T = config.tenantId
if (!cases.length && !all) {
  console.log('쓰는 법: PRO_TENANT_ID=<테넌트> node scripts/engine-compare.mjs --case <건 id> … | --tenant [--limit 20] [--json]')
  process.exit(1)
}

const rows = cases.length
  ? await q(`select * from pro_po_cases where tenant_id=$1 and id::text = any($2) order by created_at`, [T, cases])
  : await q(`select * from pro_po_cases where tenant_id=$1 order by created_at desc limit $2`, [T, limit])
const out = []
for (const c of rows) {
  const insts = c.instances || []
  const n = async (sql, p) => Number((await q(sql, p))[0]?.n || 0)
  const defs = (c.snapshots || []).length ? await n(`select count(*) n from proc_def where tenant_id=$1 and id = any($2)`, [T, c.snapshots]) : 0
  const forms = (c.snapshots || []).length ? await n(`select count(*) n from form_def where tenant_id=$1 and proc_def_id = any($2)`, [T, c.snapshots]) : 0
  out.push({
    case: c.id, subject: c.trigger?.subject || '', trigger: c.trigger?.kind || '', engine: c.engine || 'bpm', status: c.status, entry: c.entry_task,
    mapPin: c.map_pin ? new Date(c.map_pin).toISOString() : null,
    bundles: insts.length, instances: insts.length,
    bpmProcInst: insts.length ? await n(`select count(*) n from bpm_proc_inst where proc_inst_id = any($1)`, [insts]) : 0,
    procDef: defs, formDef: forms,
    todolist: insts.length ? await n(`select count(*) n from todolist where proc_inst_id = any($1)`, [insts]) : 0,
    intake: insts.length ? await n(`select count(*) n from todolist where proc_inst_id = any($1) and activity_id='intake'`, [insts]) : 0,
    cancelled: insts.length ? await n(`select count(*) n from todolist where proc_inst_id = any($1) and status::text='CANCELLED'`, [insts]) : 0,
    steps: await n(`select count(*) n from pro_case_steps where case_id=$1`, [c.id]),
    moves: (c.history || []).filter((h) => h.state === 'moved').length,
    rewinds: (c.history || []).filter((h) => h.state === 'rewound').length,
  })
}
if (json) console.log(JSON.stringify(out, null, 1))
else {
  const cols = [['건', (r) => r.case.slice(0, 8)], ['엔진', (r) => r.engine], ['상태', (r) => r.status], ['시작', (r) => r.trigger], ['실행 묶음(건이 든 인스턴스 id)', (r) => r.bundles],
    ['bpm_proc_inst 행', (r) => r.bpmProcInst], ['proc_def', (r) => r.procDef], ['form_def', (r) => r.formDef], ['todolist', (r) => r.todolist],
    ['└ 요청 접수', (r) => r.intake], ['└ 닫힘', (r) => r.cancelled], ['단계', (r) => r.steps], ['옮기기', (r) => r.moves], ['되감기', (r) => r.rewinds], ['지도 고정', (r) => (r.mapPin ? '예' : '-')]]
  const w = (s) => [...String(s)].reduce((a, ch) => a + (/[ㄱ-힝]/.test(ch) ? 2 : 1), 0)
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)))
  const widths = cols.map(([h, f]) => Math.max(w(h), ...out.map((r) => w(f(r)))))
  console.log(`테넌트 ${T} · 건 ${out.length}개`)
  console.log(cols.map(([h], i) => pad(h, widths[i])).join('  '))
  for (const r of out) console.log(cols.map(([, f], i) => pad(f(r), widths[i])).join('  '))
  for (const r of out) console.log(`  ${r.case.slice(0, 8)} · ${r.engine} · 「${r.subject.slice(0, 50)}」 · ${r.entry}부터`)
}
await pool.end()
process.exit(0)
