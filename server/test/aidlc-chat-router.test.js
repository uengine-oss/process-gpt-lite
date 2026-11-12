// Robo-DLC Lite P3, the chat entry's judgement (aidlc-chat-cases.json): which words become a work request of
// the project, which are asked about first, and which are left to the agent as before. Each case is one turn
// through runTurn in this process — the router model is the real one, the agent service is a scripted stream,
// the estimate is the stand-in file — so a change of the tool's wording or of the model shows here.
// Needs the database, PRO_AIDLC_COMPOSE_STUB and the router model; skipped without them.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { q, pool } from '../lib/supa.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { about, cases } = JSON.parse(await fs.readFile(path.join(HERE, 'aidlc-chat-cases.json'), 'utf8'))
const up = !!config.aidlcComposeStub && !!config.llm?.fastModel && await q('select 1').then(() => true, () => false)

// the agent service answers one short line: a turn that is not work for the project ends there
const realFetch = globalThis.fetch
const enc = new TextEncoder()
let delegated = 0
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.deepagentsUrl) || (config.contextRouterUrl && u.startsWith(config.contextRouterUrl))) {
    if (u.endsWith('/chat/stream')) {
      delegated++
      const body = opts.body ? JSON.parse(opts.body) : {}
      const rs = new ReadableStream({ start(c) {
        const push = (event, data) => c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        if (body.conversation_id) push('metadata', { conversation_id: body.conversation_id })
        push('message', { type: 'token', content: '에이전트의 답이에요.' })
        c.close()
      } })
      return new Response(rs, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  }
  if (/\/servers$|\/bindings$/.test(u)) return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
  return realFetch(url, opts)
}
const { runTurn } = await import('../lib/agent.js')
const S = await import('../lib/folders/service.js')

const stamp = crypto.randomBytes(3).toString('hex')
const user = { id: crypto.randomUUID(), email: `rdlc-router-${stamp}@pgpt.test`, name: '시험' }
const session = { access_token: 'test-token' }
let repo, folder
const threads = []

test('준비: AI-DLC 기록이 있는 저장소 하나를 「회의실 예약」으로 연결', { skip: !up }, async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-router-'))
  await fs.cp(path.join(HERE, 'fixtures', 'aidlc-line'), repo, { recursive: true })
  const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@pgpt.test', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'room booking')
  await fs.writeFile(config.aidlcComposeStub, JSON.stringify([{ match: '.', estimate: { title: '사례', kind: 'change', scores: Object.fromEntries(['iae', 'csu', 've', 'r', 'ua'].map((k) => [k, { score: 0.2, why: '대역' }])), touches: { units: [], contracts: [], requirements: [], paths: [] }, newUnits: [], conflicts: [], summary: '사례' } }]))
  folder = await S.linkRepo(user, { repoPath: repo, name: '회의실 예약' })
  assert.ok(folder.id, about)
})

for (const c of cases) {
  test(`${c.want} · ${c.why}: ${c.text}`, { skip: !up }, async () => {
    const [t] = await q(`insert into pro_threads(user_id,kind,title,conversation_id) values ($1,'project','시험',$2) returning id`, [user.id, `rdlc-router-${stamp}-${threads.length}`])
    threads.push(t.id)
    const before = delegated
    await runTurn({ user, session, threadId: t.id, text: c.text })
    const rows = await q(`select kind, content from pro_messages where thread_id=$1 and role='agent' order by created_at`, [t.id])
    const got = rows.some((m) => m.kind === 'app' && m.content.app === 'intake') ? 'made'
      : rows.some((m) => m.kind === 'text' && /작업으로 접수할까요/.test(m.content.text)) ? 'asked' : 'not'
    const fine = { made: ['made'], taken: ['made', 'asked'], 'asked-or-not': ['asked', 'not'], not: ['not'] }[c.want]
    assert.ok(fine.includes(got), `${c.want} 이어야 하는데 ${got}: ${JSON.stringify(rows.map((m) => m.content.text || m.kind))}`)
    // what is not taken in goes on to the agent as before
    if (got === 'not') assert.equal(delegated, before + 1)
    // the request holds the person's own words
    if (got === 'made') assert.equal((await q('select body, source from pro_aidlc_requests where folder_id=$1 order by created_at desc limit 1', [folder.id]))[0].body, c.text)
  })
}

after(async () => {
  globalThis.fetch = realFetch
  if (up) {
    // the estimates run on after the turn: let them settle before the rows go
    for (let i = 0; i < 40 && folder && (await q(`select 1 from pro_aidlc_requests where folder_id=$1 and status='estimating'`, [folder.id])).length; i++) await new Promise((r) => setTimeout(r, 250))
    await fs.writeFile(config.aidlcComposeStub, '[]').catch(() => {})
    if (threads.length) await q('delete from pro_threads where id = any($1)', [threads])
    if (folder) {
      for (const t of ['pro_aidlc_roles', 'pro_aidlc_requests', 'pro_aidlc_line']) await q(`delete from ${t} where folder_id=$1`, [folder.id]).catch(() => {})
      await q('delete from pro_folder_members where folder_id=$1', [folder.id]).catch(() => {})
      await q('delete from pro_folders where id=$1', [folder.id]).catch(() => {})
    }
  }
  if (repo) await fs.rm(repo, { recursive: true, force: true })
  await pool.end().catch(() => {})
})
