// E2E S1b 「메일 보관함」 (spec pgpt-pro_process-ontology, design-v0.3 §16): after S1 read 장진영's mailbox, every mail read is in
// her own mail archive with its whole body and attachment list; the mail history and the map keep no sentence of it; another
// person cannot open it.
//   PRO_API=http://ax.localhost:8790 node test/ontology-archive.e2e.mjs      (after ontology-map.e2e.mjs)
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { q, pool } from '../lib/supa.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
const ARCHIVE = JSON.parse(fs.readFileSync(new URL('../scripts/fixtures/ax-demo-mailbox.json', import.meta.url), 'utf8'))
let failed = 0
const step = async (name, fn) => { try { console.log(`✓ ${name}`, JSON.stringify(await fn()).slice(0, 420)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) } }
async function call(tok, method, path, body) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function signIn(email) {
  const j = await (await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  return { id: j.user.id, tok: j.session.access_token }
}
const boss = await signIn('pro-ax-jinyoung@uengine.org')

// 메일 보관함(design-v0.3 §16): 읽은 메일은 주인 몫으로 본문 전체까지 남는다 — 회사 지도 · 메일 이력에는 원문이 없고, 다른 사람은 못 연다
await step('메일 보관함: 읽은 메일은 본문 전체로 주인 몫에 남고, 다른 사람은 열 수 없다', async () => {
  const cut = new Date(ARCHIVE.today).getTime() - 90 * 86_400_000
  const inWindow = ARCHIVE.mails.filter((x) => new Date(x.date).getTime() >= cut)
  const [{ n }] = await q(`select count(*)::int n from pro_mail_archive where tenant_id='ax-demo' and owner_id=$1 and source='history'`, [boss.id])
  assert.equal(n, inWindow.length)
  const found = (await call(boss.tok, 'GET', `/mail/archive?q=${encodeURIComponent('주간 공정 보고')}&limit=20`)).body.filter((x) => x.source === 'history' && /^\[주간 공정 보고\]/.test(x.subject))
  assert.ok(found.length >= 10, `found ${found.length}`)
  const one = (await call(boss.tok, 'GET', `/mail/archive/${encodeURIComponent(found[0].mail_id)}`)).body
  assert.match(one.body, /공정률/)
  assert.ok(one.attachments.some((f) => /주간공정보고/.test(f.name)))
  const minji = await signIn('pro-ax-minji@uengine.org')
  assert.equal((await call(minji.tok, 'GET', `/mail/archive/${encodeURIComponent(found[0].mail_id)}`)).status, 404)
  const [h] = await q(`select to_jsonb(h) j from pro_mail_history h where tenant_id='ax-demo' and mail_id=$1`, [found[0].mail_id])
  // (the history keeps the form's labels — 「공정률(%)」 — but not a sentence of the mail)
  const sentence = String(one.new_part || '').split(/[.。]/)[0].trim()
  assert.ok(sentence.length > 8 && !JSON.stringify(h?.j || {}).includes(sentence), `메일 이력에 본문이 남았다: ${sentence}`)
  return { archived: n, found: found.length, subject: one.subject, attachments: one.attachments.map((f) => f.name) }
})


await step('지도에도 메일 문장이 없다', async () => {
  const m = (await call(boss.tok, 'GET', '/ontology/map')).body
  const s = JSON.stringify(m)
  const leaked = ['공정률 100%', '이번 주 공정 보고드립니다', '결산 보고드립니다. 매월'].filter((x) => s.includes(x))
  assert.deepEqual(leaked, [])
  return { tasks: m.tasks.length, leaked }
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
await pool.end()
process.exit(failed ? 1 : 0)
