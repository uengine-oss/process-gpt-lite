// 실제 판정 모델로 벽 판정을 한 번씩 본다(2차 지시: 벽은 모델 판단으로). 판정 서버 없이 LLM(server/.env 의 모델) — 운영과 같음.
// 새 Chromium(로그인 없는 빈 프로필)으로 주소를 열기만 한다: 아무것도 누르지 않고, 로그인을 시도하지 않는다.
//   node test/browser-walls.live.mjs [--state] ["주소|할 일" ...]
//   기본: NotebookLM 첫 화면(슬라이드·팟캐스트 만들기) → login_needed 기대, example.com(제목 읽기) → ok 기대
process.env.PRO_JUDGE_URL = ''
process.env.PRO_CONTEXT_ROUTER_URL = ''
const { chromium } = await import('playwright')
const { snapshotOf, judgeWall, pageName, wallState } = await import('../lib/browser.js')
const { config } = await import('../config.js')
const { pool } = await import('../lib/supa.js')

const args = process.argv.slice(2)
const showState = args.includes('--state')
const given = args.filter((a) => a !== '--state').map((a) => { const [url, goal = ''] = a.split('|'); return { url, goal } })
const cases = given.length ? given : [
  { url: 'https://notebook.google.com/', goal: '이 유튜브 링크를 NotebookLM 에 넣어 슬라이드와 팟캐스트를 만들어 줘: https://youtu.be/rt1121abc' },
  { url: 'https://example.com/', goal: '이 페이지의 제목과 첫 문장을 알려 줘' },
]
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR' })
console.log(`judge: LLM ${config.llm.fastModel} (no judge server)`)
try {
  for (const { url, goal } of cases) {
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto', e.message))
    await page.waitForTimeout(2500)
    const snap = await snapshotOf(page)
    if (showState) console.log(wallState(snap, goal))
    const task = { goal, stats: { wall_checks: [] }, secrets: new Set() }
    const wall = await judgeWall(snap, task)
    const [c] = task.stats.wall_checks
    console.log(JSON.stringify({ asked: url, landed: snap.url, title: snap.title, siteName: pageName(snap), fields: snap.fields,
      verdict: c?.key || null, p: c?.p ?? null, ms: c?.ms ?? null, via: c?.via, wall: wall?.need || 'none (agent goes on)' }))
    await page.close()
  }
} finally {
  await browser.close()
  await pool.end().catch(() => {})
}
