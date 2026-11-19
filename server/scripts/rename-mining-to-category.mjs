// 이미 있는 마이닝 추천의 이름을 업무 범주로 바꾼다 (2026-11-12, 한 번 돌리는 정리).
//
// 추천 이름은 업무 범주다(service.js nameFor). 그 전에는 단계 목록에서 이름을 지어, 하는 일이 전혀 다른
// 두 추천이 '요청 메일·견적서 작성'(교육 일정표) · '요청 접수·견적 회신'(사무실 이전 견적)처럼 비슷했다.
//   - 추천·보류: 추천 이름만 바꾼다
//   - 정식 등록: 프로세스 정의 이름도 바꿔, Lite 의 저장 경로(saveVersion)로 새 버전을 저장한다
// 범주가 같은 추천이 둘이면 뒤엣것에 ' 2' 를 붙인다(새 추천과 같은 규칙).
//
// 실행: cd server && node scripts/rename-mining-to-category.mjs <관리자 이메일> [--dry]
import { config } from '../config.js'
import { q } from '../lib/supa.js'
import { definitionOf, nameFor, saveVersion } from '../lib/mining/service.js'
import { withLang } from '../lib/lang.js'

const [email, flag] = process.argv.slice(2)
const dry = flag === '--dry'
if (!email) {
  console.error('관리자 이메일이 필요합니다')
  process.exit(2)
}
const T = config.tenantId
const [admin] = await q('select id, is_admin from users where email=$1 and tenant_id=$2', [email, T])
if (!admin?.is_admin) {
  console.error(`${email} 은(는) ${T} 의 관리자가 아닙니다`)
  process.exit(2)
}

const rows = await q(`select id, name, status, proc_def_id, pattern, definition from pro_mining_suggestions
                      where tenant_id=$1 order by created_at`, [T])
const taken = new Set()
for (const s of rows) {
  if (!s.pattern?.category) {
    taken.add(s.name)
    continue
  }
  let name = withLang('ko', () => nameFor(s.pattern))
  for (let n = 2; taken.has(name); n++) name = `${withLang('ko', () => nameFor(s.pattern))} ${n}`
  taken.add(name)
  if (name === s.name) {
    console.log(`그대로  ${s.name}`)
    continue
  }
  console.log(`${dry ? '(미리보기) ' : ''}${s.status}  ${s.name} → ${name}`)
  if (dry) continue
  if (s.status === 'registered' && s.proc_def_id) {
    const def = await definitionOf(s)
    const saved = await saveVersion({ id: admin.id }, s.proc_def_id, def, `프로세스 이름을 업무 범주로: ${s.name} → ${name}`, name)
    console.log(`        정의 새 버전 ${saved.version}`)
  }
  await q('update pro_mining_suggestions set name=$2 where id=$1', [s.id, name])
}
process.exit(0)
