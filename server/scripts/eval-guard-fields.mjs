// 패널 앱 필드 민감도: 지금의 낱말 하한(lib/panelApps/privacy.js floorOf)과 모델이 앱 설명과 함께 읽은 값을 견준다(spec pgpt-pro_guardrail-reading, 측정만 — 코드는 낱말 하한 그대로).
import { readFileSync, writeFileSync } from 'node:fs'
import { oddsOf } from '../lib/decide.js'
import { floorOf } from '../lib/panelApps/privacy.js'
const rows = JSON.parse(readFileSync(new URL('../test/guard-eval/field-labels.json', import.meta.url)))
const OPTS = [
  { key: 'sensitive', label: '사람의 보수·평가·건강·징계·계좌·주민번호·종교 같은 민감 정보' },
  { key: 'personal', label: '사람의 연락처·생년월일·사번 같은 개인 정보' },
  { key: 'ordinary', label: '사람과 상관없는 일반 정보, 또는 비슷한 낱말을 다른 뜻으로 쓴 것(제품 평가, 칸반 카드 번호, 장애 사유, 웹 주소 등)' },
]
const out = []
for (const r of rows) {
  const d = await oddsOf(`앱: ${r.app}\n컬럼 이름: ${r.label}`, '이 앱에서 이 컬럼에 들어가는 값은 어떤 정보인가?', OPTS)
  const floor = floorOf({ fields: [] }, { label: r.label, key: '', type: 'text' }, null)
  out.push({ ...r, floor: floor === 'public' ? 'ordinary' : floor, model: d?.choice || null, p: d?.confidence ?? null })
}
const restricted = (v) => v === 'sensitive' || v === 'personal'
function score(name, f) {
  const miss = out.filter((r) => restricted(r.level) && !restricted(f(r))), over = out.filter((r) => !restricted(r.level) && restricted(f(r)))
  const exact = out.filter((r) => f(r) === r.level).length
  console.log(`${name.padEnd(14)} 보호할 칸 놓침 ${miss.length}/${out.filter((r) => restricted(r.level)).length} · 일반 칸 과잉 ${over.length}/${out.filter((r) => !restricted(r.level)).length} · 등급까지 일치 ${exact}/${out.length}`)
  return { miss, over }
}
const a = score('낱말 하한', (r) => r.floor), b = score('모델', (r) => r.model), c = score('낱말 또는 모델', (r) => (restricted(r.floor) ? r.floor : r.model))
console.log('낱말 하한이 놓친 칸:', a.miss.map((r) => `${r.label}(${r.app.slice(0, 14)})`).join(' / ').slice(0, 600))
console.log('낱말 하한의 과잉:', a.over.map((r) => `${r.label}(${r.app.slice(0, 14)})`).join(' / ').slice(0, 600))
console.log('모델이 놓친 칸:', b.miss.map((r) => `${r.label}(${r.app.slice(0, 14)})`).join(' / ').slice(0, 400))
console.log('모델의 과잉:', b.over.map((r) => `${r.label}(${r.app.slice(0, 14)})`).join(' / ').slice(0, 400))
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1))
process.exit(0)
