// Browser agent with and without the fast decision gates (page state, goal done), on fixed tasks.
// node scripts/bench-browser-gates.mjs [runs=1] > out.json
import { sessionFor } from '../lib/supa.js'
import { mainThread } from '../lib/store.js'
import { runBrowserTask, close } from '../lib/browser.js'

const TASKS = [
  {
    id: 'books-travel', unattended: false, start: 'http://books.toscrape.com/',
    goal: 'books.toscrape.com 의 Travel 카테고리에서 처음 세 권의 제목과 가격을 알려줘.',
    expect: ['Himalayas', '45.17', "Noah", '49.43', 'See America', '48.87'],
  },
  {
    id: 'quotes-delayed', unattended: false, start: 'https://quotes.toscrape.com/js-delayed/',
    goal: '이 페이지에 나오는 첫 번째 명언과 그 저자를 알려줘. (페이지는 늦게 뜰 수 있다)',
    expect: ['Einstein'],
  },
  {
    id: 'facebook-wall', unattended: true, start: 'https://www.facebook.com/groups/aiproductkr/',
    goal: '페이스북 그룹 최근 글 중 가장 반응이 많은 글의 주제를 알려줘. 페이스북에 들어갈 수 없으면 대신 http://localhost:5180/demo-feed/index.html 의 피드에서 찾아라.',
    expect: ['RMF'],
  },
]

const runs = Number(process.argv[2] || 1)
const { user } = await sessionFor('bench-browser@example.com', '벤치 사용자')
const thread = await mainThread(user.id)
const out = []
for (let r = 0; r < runs; r++) {
  for (const t of TASKS) {
    for (const gates of [false, true]) {
      await close(user.id) // fresh profile state per run (no cached page)
      const res = await runBrowserTask({ userId: user.id, threadId: thread.id, goal: t.goal, startUrl: t.start, unattended: t.unattended, gates })
      const text = `${res.summary}\n${(res.notes || []).join('\n')}`
      const hit = t.expect.filter((e) => text.includes(e)).length
      const row = { task: t.id, run: r, gates, state: res.state, correct: hit === t.expect.length, hit: `${hit}/${t.expect.length}`, ...res.stats, summary: (res.summary || '').slice(0, 300) }
      console.error(JSON.stringify({ task: row.task, gates, correct: row.correct, turns: row.turns, llm: row.llm, gate_calls: row.gate_calls, ms: row.ms, early: row.early_finish, waits: row.waits, hints: row.hints }))
      out.push(row)
    }
  }
}
await close(user.id)
console.log(JSON.stringify(out, null, 2))
process.exit(0)
