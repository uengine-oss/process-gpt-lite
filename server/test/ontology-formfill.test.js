// 회사 엑셀 양식 채우기(lib/mining/worker.js form-fill · xlsxSheets): 양식 파일의 칸을 시트 XML 에서 그대로 읽는다 — 공유 문자열 ·
// 인라인 문자열 · 숫자 참조(&#50976;) · 수식. 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { xlsxSheets } from '../lib/mining/worker.js'

test('양식의 칸: 라벨 · 지난 값 · 수식을 시트 XML 에서', async () => {
  const { sheets } = await xlsxSheets(fs.readFileSync(new URL('../scripts/fixtures/ax-demo-templates/견적서_양식.xlsx', import.meta.url)))
  const cells = sheets.flatMap((s) => s.cells.map((c) => c.value))
  for (const l of ['고객명', '견적일', '프로젝트']) assert.ok(cells.some((v) => v.includes(l)), l)
  assert.ok(cells.some((v) => v.startsWith('=')), '수식 칸이 없다')
})
