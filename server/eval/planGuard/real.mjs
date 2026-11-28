// 지킴이 판정을 실제 모델로 — 녹화 20:49 의 상황(드라이브에서 못 찾고 다른 자료로 감) · 아직 찾는 중 · 찾아서 쓰는 중.
// 키는 PLAN_GUARD_ENV 의 .env 에서 PRO_LLM_* 만 읽고 출력하지 않는다. cd server/eval/planGuard && PLAN_GUARD_ENV=<.env> node real.mjs
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(process.env.PLAN_GUARD_ENV || '.env', 'utf8').split('\n').filter((l) => /^PRO_LLM_(BASE_URL|API_KEY|MODEL|FAST_MODEL)=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')] }))
Object.assign(process.env, env)
const PG = await import('../../lib/planGuard.js')
const { config } = await import('../../config.js')
console.log('model', config.llm.frontModel)
const plan = { understood: '드라이브의 가나정밀 교육 자료를 참고해 Spec Kit 기반 교육과정을 다시 설계해 드릴게요.', source: 'front', steps: [{ text: '구글 드라이브에서 가나정밀 교육 자료 찾기' }, { text: '자료를 바탕으로 Spec Kit 과정 설계' }, { text: '커리큘럼 · 실라버스 정리' }, { text: '결과 전달' }] }
const request = '내 구글 드라이브를 찾아보면 최근에 했던 가나정밀 교육이 있어. 거기 스펙 주도 개발 과정 내용을 참고해서 이 과정도 커리큘럼과 실라버스로 만들어 봐'
const cases = {
  wentOn: { evidence: [{ tool: 'drive_search', phase: '드라이브 찾기', query: '가나정밀 교육 자료', out: '[]' }, { tool: 'drive_search', phase: '드라이브 찾기', query: '가나정밀 교육', out: '[{"name":"연차 관리대장.xlsx"}]' }, { tool: 'fetch_url', phase: '웹 읽기', hosts: ['github.com'], out: '<html>github/spec-kit README…</html>' }], notes: ['드라이브에서 가나정밀 교육 자료는 찾지 못했어요. Spec Kit 공식 흐름(github/spec-kit)을 기준으로 잡을게요.'], files: [] },
  searching: { evidence: [{ tool: 'drive_search', phase: '드라이브 찾기', query: '가나정밀 교육 자료', out: '[]' }], notes: ['첫 검색에서는 나오지 않았어요. 다른 낱말로 다시 찾아볼게요.'], files: [] },
  fine: { evidence: [{ tool: 'drive_search', phase: '드라이브 찾기', query: '가나정밀 교육', out: '[{"name":"가나정밀 교육과정 제안서.pptx"}]' }, { tool: 'drive_read', phase: '드라이브 읽기', out: '{"text":"1일차 Spec Kit 소개 …"}' }], notes: ['제안서를 찾았어요. 이 흐름을 바탕으로 설계할게요.'], files: ['curriculum.md'] },
}
for (const [k, c] of Object.entries(cases)) {
  const { system, user } = PG.guardMessages({ request, plan, steps: plan.steps, ...c })
  const { chatJson } = await import('../../lib/llm.js')
  const t0 = Date.now()
  const j = await chatJson(system, user, { model: config.llm.frontModel, temperature: 0, timeoutMs: 60000, maxTokens: 1500, effort: 'low' }).catch((e) => ({ error: e.message }))
  const v = PG.readVerdict(j, 4)
  console.log(k, Date.now() - t0, 'ms', JSON.stringify(v))
}
