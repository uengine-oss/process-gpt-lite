// English mode — the agents answer and name their files in English (server/lib/lang.js: the person's saved
// language, or the X-PGL-Lang header). Test accounts pro-en-srv-*@uengine.org only. Durable outcomes, as the
// other journeys: file cards of the kinds asked for, ASCII (English) file names, no Hangul in what the
// assistant wrote. (The Korean journeys stay as they are; this tier runs them in Korean.)
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect, api } from '../../lib/fixtures.js'
import { since, waitFor } from '../../lib/agent.js'
import { SERVER_DIR } from '../../lib/env.js'

test.describe.configure({ mode: 'parallel' })
test.beforeEach(async () => {
  await expect.poll(async () => (await api.call(null, 'GET', '/config', null, { timeout: 5000 }).catch(() => ({ status: 0 }))).status, { timeout: 180_000, intervals: [3000] }).toBe(200)
})

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/
// an English-mode test account: signed in with the demo code, onboarded, its saved language English
async function english(area) {
  const email = `pro-en-srv-${area}@uengine.org`
  if (!/^pro-en-srv-[a-z0-9-]+@uengine\.org$/.test(email)) throw new Error(`not an English test account: ${email}`)
  const r = await api.call(null, 'POST', '/auth/email/verify', { email, code: process.env.PGPT_LOGIN_CODE || '000000' })
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.text}`)
  const u = api.client(r.body)
  await u.post('/profile', { name: 'Jinyoung Jang', birth: '1990-01-01', onboarded: true })
  const saved = await u.put('/me/lang', { lang: 'en' })
  expect(saved.status, saved.text).toBe(200)
  expect((await u.get('/me')).body.lang).toBe('en')
  return u
}
// everything the assistant wrote since t0 (text, documents, chips), for the no-Hangul check
const agentText = (rows) => rows.filter((m) => m.role === 'agent').map((m) => [m.content?.text, m.content?.name, m.content?.title].filter(Boolean).join(' ')).join('\n')

test('A-EN-01 [flaky] English mode: Moonlight Coffee floor plan, proposal and quote → English file names, no Hangul in the answer', async ({ db }) => {
  test.setTimeout(50 * 60_000)
  const u = await english('ag-moonlight')
  const th = await db.mainThreadId(u.id)
  // a turn left running by an earlier, interrupted run would hold this one in line (대기) or be continued
  await u.post(`/threads/${th}/stop`, {})
  await db.clearMain(u.id)
  const t0 = new Date()
  const wantPlan = await api.craftHas('cadcraft', ['cli'])
  const ask = 'For Moonlight Coffee Store #2 in Seongsu-dong, Seoul (12 m wide × 9 m deep, about 108 ㎡): a hall with about 40 seats, '
    + 'an order and coffee bar, a bean storage room, a staff lounge and one restroom, in a warm wood tone. '
    + `${wantPlan ? 'Draw the floor plan, then write' : 'Write'} the store design proposal as a Word document (docx) and make the quote as an Excel file (xlsx). `
    + "Don't ask me questions, just make them."
  // drawing, a Word proposal and an Excel quote in one turn: often longer than the default 15 minutes
  const r = await api.sendChat(u.token(), th, ask, { timeout: 40 * 60_000 })
  expect(r.error, JSON.stringify(r.error)).toBeNull()
  const files = await waitFor(async () => {
    const f = await since(db, th, t0, 'file')
    const has = (ext) => f.some((m) => new RegExp(`\\.${ext}$`, 'i').test(m.content.name || ''))
    return has('docx') && has('xlsx') && (!wantPlan || has('dxf')) ? f : null
  }, { timeout: 30 * 60_000 })
  const all = await since(db, th, t0, 'file')
  test.info().annotations.push({ type: 'files', description: all.map((m) => m.content.name).join(' | ') })
  expect(files, `file cards: ${all.map((m) => m.content.name).join(', ')}`).toBeTruthy()
  for (const m of files) {
    expect(m.content.name, 'an English (ASCII) file name').toMatch(/^[\x20-\x7E]+$/)
    expect(m.content.url).toMatch(/^https?:\/\//)
  }
  // the documents' names say what they are, in English
  const names = files.map((m) => m.content.name).join(' ')
  expect(names).toMatch(/proposal|design/i)
  expect(names).toMatch(/quote|quotation|estimate/i)
  // the answer the person reads
  const answer = String(r.done?.content?.text || '')
  test.info().annotations.push({ type: 'answer', description: answer.slice(0, 800) })
  expect(answer.length).toBeGreaterThan(0)
  expect(HANGUL.test(answer), `Hangul in the answer: ${answer.slice(0, 300)}`).toBe(false)
  const written = agentText(await since(db, th, t0))
  expect(HANGUL.test(written), `Hangul in what the assistant wrote: ${(written.match(new RegExp(`.{0,40}${HANGUL.source}.{0,40}`)) || [''])[0]}`).toBe(false)
})

test('A-EN-02 [flaky] English mode: the Moonlight Coffee practice mail → English drafts (floor plan, Word proposal, Excel quote) and an English review card', async ({ db, cleanup }) => {
  test.setTimeout(40 * 60_000)
  const u = await english('ag-mail')
  const th = await db.clearMain(u.id)
  // a demo mailbox whose sample mails are already seen: only the practice mail is fresh
  const fixture = JSON.parse(await fs.readFile(path.join(SERVER_DIR, 'fixtures', 'demo-mail-en.json'), 'utf8').catch(() => 'null'))
  test.skip(!fixture, 'English demo mail fixture (server/fixtures/demo-mail-en.json) missing')
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  for (const m of fixture) await db.q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, m.id])
  cleanup(async () => {
    await db.q('delete from pro_mail_accounts where user_id=$1', [u.id])
    await db.q('delete from pro_demo_mail where user_id=$1', [u.id])
    await db.q('delete from pro_mail_seen where user_id=$1', [u.id])
    await db.q('delete from pro_actions where user_id=$1', [u.id]).catch(() => {})
    await db.q('delete from pro_mining_cases where user_id=$1', [u.id]).catch(() => {})
  })
  // the practice mails a reader can send themselves (Settings) are English for an English-mode person
  const templates = (await u.get('/mail/demo-templates')).body
  const tpl = templates.find((t) => t.id === 'dalbit-2-proposal')
  expect(tpl?.label).toMatch(/Moonlight Coffee/)
  expect(HANGUL.test(JSON.stringify(templates))).toBe(false)
  const t0 = new Date()
  const arrived = await u.post('/mail/demo-arrive', { template: 'dalbit-2-proposal' }, { timeout: 300_000 })
  expect(arrived.status, arrived.text).toBe(200)
  const wantPlan = await api.craftHas('cadcraft', ['cli'])
  // the Home card to review the drafts, in English
  const card = await waitFor(async () => (await db.q(`select * from pro_actions where user_id=$1 and verb='Review' and created_at >= $2`, [u.id, t0]))[0], { timeout: 5 * 60_000 })
  expect(card, 'a Review card on Home').toBeTruthy()
  expect(HANGUL.test(`${card.text} ${card.prompt}`), card.text).toBe(false)
  const files = await waitFor(async () => {
    const f = await since(db, th, t0, 'file')
    const has = (ext) => f.some((m) => new RegExp(`\\.${ext}$`, 'i').test(m.content.name || ''))
    return has('docx') && has('xlsx') && (!wantPlan || has('dxf')) ? f : null
  }, { timeout: 30 * 60_000 })
  const all = await since(db, th, t0, 'file')
  test.info().annotations.push({ type: 'files', description: all.map((m) => m.content.name).join(' | ') })
  expect(files, `draft file cards: ${all.map((m) => m.content.name).join(', ')}`).toBeTruthy()
  for (const m of files) expect(m.content.name, 'an English (ASCII) file name').toMatch(/^[\x20-\x7E]+$/)
  expect(files.map((m) => m.content.name).join(' ')).toMatch(/Moonlight/i)
  const written = agentText(await since(db, th, t0))
  expect(HANGUL.test(written), `Hangul in what the assistant wrote: ${(written.match(new RegExp(`.{0,40}${HANGUL.source}.{0,40}`)) || [''])[0]}`).toBe(false)
})
