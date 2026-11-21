// The sentences no evaluation item and no skill description may use (design 7.1): what the phone
// recordings and the review said, and every quoted sentence in the old routing code (main 84bd318) and
// the tests written against it. Run once; the list is kept in forbidden.txt.
//   node server/eval/build-forbidden.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const BASE = '84bd318'
const show = (p) => { try { return execFileSync('git', ['show', `${BASE}:${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) } catch { return '' } }
const files = [
  'server/lib/agent.js', 'server/lib/scheduleIntent.js', 'server/lib/marketHint.js', 'server/lib/office.js', 'server/lib/folders/work.js',
  'server/lib/folders/threadFolders.js', 'server/lib/folders/skills.js', 'server/lib/panelApps/service.js', 'server/lib/missions.js',
  'server/test/mobile-review-1121.test.js', 'server/test/threadFolders.test.js', 'server/test/threadFolders.e2e.test.js', 'server/test/capture-fixes.test.js',
  'server/test/agentTurn.integration.test.js', 'server/test/en-fix.test.js', 'server/test/lang.test.js', 'server/test/replies.test.js',
  'e2e/tests/feature/mobile-review-1121.spec.js', 'e2e/tests/agent/journeys.spec.js', 'src/replies.js',
]
const out = new Set([
  // the recordings (docs/mobile-review-1121/findings.md) and the review brief
  '곧바로 하나 정도 한번 실행해 봐', '급등락이 감지되면 내 텔레그램 봇으로 알려줘', 'ast 모바일', 'AST 모바일', '코스피 코스닥 그리고 테슬라',
  '9시 18분이니까 1분 후에 하겠다 그 뜻으로 보이네요', '주식 관련 API가 제가 제공한 게 없는데 어떤 식으로 지금 작업하고 있는지 모르겠어요',
  '코드가 확인되지 않았다 이거는 좀 확인해 봐야 되고', '이것도 안되네요 학프로에서는 다 되던 것들입니다',
  '코스피 코스닥 그리고 테슬라, ast 모바일 주가를 1시간 주기로 파악해서 5일 누적 급락과 급등(5프로)가 있으면 내게 알려줘',
])
const keep = (s) => {
  const t = s.replace(/\\n/g, ' ').replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length < 6 || t.length > 200) return
  if (/^[\w./:@#-]+$/.test(t)) return // identifiers, paths
  const hangul = (t.match(/[가-힣]/g) || []).length
  const words = t.split(' ').filter((w) => /^[A-Za-z']{2,}$/.test(w)).length
  if (hangul >= 4 || words >= 4) out.add(t)
}
for (const f of files) {
  const src = show(f)
  // string literals and quotes in comments: '…', "…", `…`, 「…」, “…”
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.){6,200})'|"((?:[^"\\\n]|\\.){6,200})"|`([^`]{6,200})`|「([^」\n]{4,200})」|“([^”\n]{4,200})”/g)) keep(m[1] || m[2] || m[3] || m[4] || m[5] || '')
}
const list = [...out].sort()
fs.writeFileSync(path.join(ROOT, 'server/eval/forbidden.txt'), `# 평가 문항·스킬 설명에 쓰지 않는 문장 (build-forbidden.mjs 가 ${BASE} 에서 모음, ${list.length}개)\n${list.join('\n')}\n`)
console.log(list.length)
