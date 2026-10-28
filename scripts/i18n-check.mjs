// English mode check: signs in a fresh test account (pro-en-ui-<run>@uengine.org), opens every screen
// with ?lang=en and reports the Korean still visible per screen — what the translator could not
// translate (osI18n.missing()) and any Hangul left in the page text outside user content
// (e2e/lib/hangul.js). Chat cards of every kind are seeded into the account's main chat first, as the
// server would have left them. Screenshots and report.json in i18n/check/.
//   node scripts/i18n-check.mjs                       # WEB=http://localhost:5180 API=http://localhost:8787
//   WEB=http://localhost:5181 node scripts/i18n-check.mjs --only chat,settings-accounts
// Needs the e2e folder's packages (cd e2e && npm install) and, for card seeding, the dev database.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const E2E = path.join(ROOT, 'e2e')
const require = createRequire(path.join(E2E, 'package.json'))
const { chromium } = require('playwright-core')
const { visibleHangul, dataOf, isData } = await import(pathToFileURL(path.join(E2E, 'lib/hangul.js')).href)
const db = await import(pathToFileURL(path.join(E2E, 'lib/db.js')).href)

const WEB = (process.env.WEB || 'http://localhost:5180').replace(/\/$/, '')
const API = (process.env.API || 'http://localhost:8787').replace(/\/$/, '')
const RUN = process.env.RUN || Date.now().toString(36)
const EMAIL = process.env.I18N_EMAIL || `pro-en-ui-${RUN}@uengine.org`
const OUT = path.join(ROOT, 'i18n', 'check')
const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1].split(',') : null })()
const headed = process.argv.includes('--headed')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!/^pro-en-ui-[a-z0-9-]+@uengine\.org$/.test(EMAIL)) throw new Error('test accounts only: pro-en-ui-*@uengine.org')

async function login() {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: process.env.PGPT_LOGIN_CODE || '000000' }) })
  if (!r.ok) throw new Error(`login ${r.status} ${await r.text()}`)
  return r.json()
}
const call = async (s, method, p, body) => {
  const r = await fetch(`${API}/api${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-PGL-Lang': 'en', Authorization: `Bearer ${s.session.access_token}` }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}

// chat cards of every kind, with neutral (English) data so what is left in Korean is the app's own
// text; the server-built texts (status lines, notices) are in Korean as the server writes them
function cards() {
  const at = new Date().toISOString()
  return [
    { role: 'user', kind: 'text', content: { text: 'Check the Moonlight Coffee quote', queued: true } },
    { role: 'agent', kind: 'text', content: { text: '서버가 다시 시작되어 작업이 중단됐어요.' } },
    { role: 'agent', kind: 'divider', content: { text: 'Morning briefing' } },
    { role: 'agent', kind: 'chip', content: { text: 'Saved', icon: 'check' } },
    { role: 'agent', kind: 'connect', content: { text: '메일 연결하기', state: 'pending' } },
    { role: 'agent', kind: 'task', content: { title: 'Issue a tax invoice', state: 'running', steps: ['Open the portal', 'Log in', 'Issue the invoice'], step: 1, url: 'https://partners.example.com' } },
    { role: 'agent', kind: 'task', content: { title: 'Issue a tax invoice', state: 'needs_input', need: 'Approve the payment', steps: ['Open the portal', 'Log in'], step: 1 } },
    { role: 'agent', kind: 'task', content: { title: 'Look up prices', state: 'done', summary: 'Found 3 prices.', steps: ['Open the site', 'Collect prices'], step: 2 } },
    { role: 'agent', kind: 'task', content: { title: 'Log in to the portal', state: 'failed', summary: '브라우저에서 아무 동작도 하지 못한 채 작업이 끝났어요.' } },
    { role: 'agent', kind: 'vault', content: { site: 'partners.example.com', state: 'pending', fields: ['username', 'password'] } },
    { role: 'agent', kind: 'choice', content: { question: 'Which store?', options: ['Store #1', 'Store #2'] } },
    { role: 'agent', kind: 'catalog', content: { items: [{ id: 'demo', name: 'Travel expense settlement', description: 'Submit and approve travel expenses' }] } },
    { role: 'agent', kind: 'instances', content: { items: [] } },
    { role: 'agent', kind: 'file', content: { name: 'Quote.xlsx', url: '/api/files/none/Quote.xlsx', size: 1200, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } },
    { role: 'agent', kind: 'skill_draft', content: { name: 'weekly-report', description: 'Writes the weekly report', state: 'draft' } },
    { role: 'agent', kind: 'process_draft', content: { name: 'Store design proposal', steps: ['Receive request', 'Draw floor plan', 'Write proposal'], state: 'draft' } },
  ].map((m) => ({ ...m, created_at: at }))
}

async function seedChat(user, s) {
  if (!(await db.available())) return 'no database: cards not seeded'
  const th = await db.mainThreadId(user.id)
  const extra = []
  // a spreadsheet the agent "made": its card opens the IeumOffice sheet editor
  try {
    const { XLSX, MIME } = await import(pathToFileURL(path.join(E2E, 'lib/seed.js')).href)
    const buf = await XLSX([['Item', 'Qty', 'Price'], ['Espresso machine', 1, 4200000], ['Grinder', 2, 650000]])
    const r = await fetch(`${API}/api/attachments`, { method: 'POST', body: buf, headers: { 'Content-Type': MIME.xlsx, 'X-File-Name': encodeURIComponent('Quote.xlsx'), Authorization: `Bearer ${s.session.access_token}` } })
    if (r.ok) { const f = await r.json(); extra.push({ role: 'agent', kind: 'file', content: { name: 'Moonlight Coffee quote.xlsx', url: f.url } }) }
  } catch (e) { console.warn('file card:', e.message) }
  await db.addMessages(th, [...cards(), ...extra])
  return `seeded ${cards().length + extra.length} cards`
}

// Tenant data (teammates, skills, processes …) is reported apart as "data" (e2e/lib/hangul.js)
const tenantData = (s, extra) => dataOf(async (p) => (await call(s, 'GET', p)).body, extra)

// A process with about ten weeks of history owned by this account (the improve screens need one):
// the improve tutorial's simulation (server/lib/improve/demoProcess.js) written the way the engine
// writes it (shape.js), as e2e/tests/feature/improve.spec.js does. Removed again at the end.
async function seedImprove(s) {
  if (!(await db.available())) return null
  const lib = (f) => import(pathToFileURL(path.join(ROOT, 'server', f)).href)
  const { simulate, contract } = await lib('lib/improve/demoProcess.js')
  const { writeInstance, flatDefinition } = await lib('lib/improve/shape.js')
  const mate = async (who) => (await (await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `pro-en-ui-${RUN}-${who}@uengine.org`, code: process.env.PGPT_LOGIN_CODE || '000000' }) })).json()).user
  const people = { jang: s.user.id, minji: (await mate('minji')).id, seoyeon: (await mate('seoyeon')).id }
  const names = { jang: 'Jinyoung Jang', minji: 'Minji Kim', seoyeon: 'Seoyeon Park' }
  const DEF = `en_ui_improve_${RUN}`.toLowerCase()
  const c = contract(people, { lang: 'en' })
  c.processDefinition.processDefinitionId = DEF
  const def = flatDefinition(c)
  await db.q(`insert into proc_def (id, name, definition, type, tenant_id, owner, isdeleted) values ($1,$2,$3,'bpmn',$4,$5,false)`, [DEF, `Moonlight Coffee proposal (EN check ${RUN})`, def, db.tenant, s.user.id])
  await db.q(`insert into proc_def_version (arcv_id, proc_def_id, version, version_tag, "timeStamp", definition, message, tenant_id, is_draft) values ($1,$2,'1.0','major',now(),$3,'EN check v1',$4,false)`, [`${DEF}_1.0`, DEF, def, db.tenant])
  const now = Date.now()
  for (const sim of simulate({ people, names, from: now - 70 * 86400_000, to: now - 3600_000, seed: 7, defId: DEF, lang: 'en' })) {
    await writeInstance(db.q, { tenant: db.tenant, defId: DEF, sim, arcv: `${DEF}_1.0`, version: '1.0', roles: def.roles })
  }
  return DEF
}
async function removeImprove(DEF) {
  const insts = (await db.q('select proc_inst_id from bpm_proc_inst where proc_def_id=$1', [DEF])).map((r) => r.proc_inst_id)
  for (const t of ['events', 'todolist_status_history', 'task_execution_properties', 'todolist']) await db.q(`delete from ${t} where proc_inst_id = any($1)`, [insts]).catch(() => {})
  await db.q('delete from bpm_proc_inst where proc_def_id=$1', [DEF])
  for (const t of ['proc_def_version', 'form_def', 'pro_improve_state', 'pro_improve_runs']) await db.q(`delete from ${t} where proc_def_id=$1`, [DEF]).catch(() => {})
  await db.q('delete from notifications where url=$1', [`/improve/${DEF}`]).catch(() => {})
  await db.q('delete from proc_def where id=$1', [DEF])
}

const SETTINGS = ['schedules', 'team', 'skills', 'accounts', 'wallet', 'system', 'security', 'profile']
function screens(ctx) {
  const list = [
    { name: 'login', path: '/login', anon: true },
    { name: 'login-code', path: '/login', anon: true, act: async (p) => { await p.fill('input.field', EMAIL); await p.click('.stack .dark-btn:not(:first-child)'); await sleep(1500) } },
    { name: 'onboard-age', path: '/welcome/age' },
    { name: 'onboard-intro', path: '/welcome/intro', wait: 6000 },
    { name: 'chat', path: '/chat', wait: 4000 },
    { name: 'chat-search', path: '/chat', act: async (p) => { await p.locator('header.top button[aria-label]').filter({ has: p.locator('svg') }).nth(1).click().catch(() => {}); await sleep(800) } },
    { name: 'messenger', path: '/chat', act: async (p) => { await p.locator('header.top .team, header.top button.msgs, header.top [aria-label*="Team"], header.top [aria-label*="팀"]').first().click().catch(() => {}); await sleep(1200) } },
    { name: 'messenger-new', path: '/chat', act: async (p) => { await p.getByRole('button', { name: 'Messages' }).first().click(); await sleep(1000); await p.getByRole('button', { name: /New conversation/ }).first().click(); await sleep(1000) } },
    { name: 'search-typed', path: '/chat', act: async (p) => { await p.getByRole('button', { name: 'Search' }).first().click(); await sleep(800); await p.keyboard.type('quote'); await sleep(2000) } },
    { name: 'panel-mode', path: '/chat', act: async (p) => { await p.getByRole('button', { name: /New panel/ }).first().click(); await sleep(1000) } },
    { name: 'home-collapsed', path: '/chat', act: async (p) => { await p.locator('header.top button.home').last().click(); await sleep(1000) } },
    { name: 'office-editor', path: '/chat', wait: 3000, act: async (p) => { await p.locator('.k-file button.file').last().click(); await sleep(9000) } },
    { name: 'projects', path: '/projects' },
    { name: 'settings', path: '/settings' },
    ...SETTINGS.map((k) => ({ name: `settings-${k}`, path: `/settings/${k}`, wait: 2500 })),
    { name: 'settings-accounts-new', path: '/settings/accounts/new' },
    { name: 'settings-accounts-key', path: '/settings/accounts/key' },
    { name: 'settings-wallet-new', path: '/settings/wallet/new' },
    { name: 'folders', path: '/folders' },
    ctx.slug && { name: 'folder-detail', path: `/folders/${ctx.slug}`, wait: 3000 },
    ctx.slug && { name: 'folder-share', path: `/folders/${ctx.slug}`, wait: 3000, act: async (p) => { await p.getByRole('button', { name: 'Share' }).first().click(); await sleep(1200) } },
    ctx.slug && { name: 'folder-variation', path: `/folders/${ctx.slug}`, wait: 3000, act: async (p) => { await p.getByRole('button', { name: /New variation/ }).first().click(); await sleep(1200) } },
    ctx.slug && { name: 'folder-history', path: `/folders/${ctx.slug}`, wait: 3000, act: async (p) => { await p.getByRole('button', { name: 'History' }).first().click(); await sleep(1500) } },
    ctx.slug && { name: 'folder-index', path: `/folders/${ctx.slug}`, wait: 3000, act: async (p) => { await p.getByRole('button', { name: 'Index' }).first().click(); await sleep(1500) } },
    ctx.slug && { name: 'workroom', path: `/workroom/folder/${ctx.slug}`, wait: 3000 },
    ctx.skill && { name: 'settings-skill-detail', path: `/settings/skills/${encodeURIComponent(ctx.skill)}`, wait: 3000 },
    { name: 'mining', path: '/mining', wait: 3000 },
    { name: 'improve', path: '/improve', wait: 3000 },
    ctx.defId && { name: 'improve-def', path: `/improve/${encodeURIComponent(ctx.defId)}`, wait: 8000 },
    ...(ctx.defId ? ['vsm', 'toc', 'cpm', 'run'].map((tab, i) => ({ name: `improve-def-${tab}`, path: `/improve/${encodeURIComponent(ctx.defId)}`, wait: 8000,
      act: async (p) => { await p.locator('nav.tabs.glass-thin button').nth(i + 1).click(); await sleep(2500) } })) : []),
    { name: 'mobile-home', path: '/chat', viewport: { width: 390, height: 844 } },
  ].filter(Boolean)
  return only ? list.filter((s) => only.some((o) => s.name === o || s.name.startsWith(o + '-') || s.name.startsWith(o))) : list
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const s = await login()
  const me = s.user
  const ctx = {}
  ctx.seed = await seedChat(me, s).catch((e) => `seed failed: ${e.message}`)
  const sk = await call(s, 'GET', '/skills')
  ctx.skill = (Array.isArray(sk.body) ? sk.body : sk.body?.skills || []).map((x) => x.name || x.id).find(Boolean)
  const f = await call(s, 'POST', '/folders', { name: `EN check ${RUN}` })
  if (f.status === 200) ctx.slug = f.body.slug
  ctx.defId = process.env.I18N_DEF || (only && !only.some((o) => o.startsWith('improve')) ? null : await seedImprove(s).catch((e) => { console.warn('improve seed:', e.message); return null }))
  const seededDef = !process.env.I18N_DEF && ctx.defId
  const data = await tenantData(s, ctx.skill ? [`/skills/${encodeURIComponent(ctx.skill)}`] : [])
  const browser = await chromium.launch({ headless: !headed, args: ['--lang=en-US'] })
  const report = { account: EMAIL, web: WEB, seed: ctx.seed, defId: ctx.defId || null, screens: {} }
  let onboarded = false
  try {
    for (const sc of screens(ctx)) {
      if (!sc.anon && !sc.name.startsWith('onboard') && !onboarded) {
        await call(s, 'POST', '/profile', { name: 'Jinyoung Jang', birth: '1990-01-01', onboarded: true })
        onboarded = true
      }
      const c = await browser.newContext({ viewport: sc.viewport || { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'Asia/Seoul' })
      if (!sc.anon) await c.addInitScript((v) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', v) }, JSON.stringify(s))
      const page = await c.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${WEB}${sc.path}${sc.path.includes('?') ? '&' : '?'}lang=en&hour=14`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      await sleep(sc.wait || 2000)
      if (sc.act) await sc.act(page).catch((e) => errors.push(`act: ${e.message}`))
      await page.screenshot({ path: path.join(OUT, `${sc.name}.png`) }).catch(() => {})
      const r = await visibleHangul(page).catch((e) => ({ error: e.message }))
      report.screens[sc.name] = { ...r, errors }
      await c.close()
    }
    // tenant data again (other accounts may have added teammates or skills meanwhile), then split
    const after = await tenantData(s, ctx.skill ? [`/skills/${encodeURIComponent(ctx.skill)}`] : [])
    const all = [...new Set([...data, ...after])].sort((a, b) => b.length - a.length)
    for (const v of Object.values(report.screens)) {
      const left = v.left || []
      v.data = left.filter((l) => isData(l.text, all)).map((l) => l.text)
      v.left = left.filter((l) => !isData(l.text, all))
      v.missing = (v.missing || []).filter((m) => !isData(m, all))
    }
  } finally {
    await browser.close()
    if (ctx.slug) await call(s, 'DELETE', `/folders/${ctx.slug}`).catch(() => {})
    if (seededDef) await removeImprove(seededDef).catch((e) => console.warn('improve cleanup:', e.message))
    await db.end?.()
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1))
  }
  let total = 0
  console.log(`account ${EMAIL} · ${ctx.seed} · improve def ${ctx.defId || '-'}`)
  for (const [k, v] of Object.entries(report.screens)) {
    const n = (v.left || []).length
    total += n
    console.log(`${k.padEnd(24)} lang=${v.lang} left=${n} data=${(v.data || []).length} missing=${(v.missing || []).length}${v.errors?.length ? ' errors=' + v.errors.length : ''}${v.error ? ' ' + v.error : ''}`)
    for (const l of (v.left || []).slice(0, 12)) console.log('   ·', l.text.slice(0, 110).replace(/\n/g, ' ⏎ '), ' ‹', l.where, '›')
  }
  console.log(`total left: ${total}`)
  if (process.argv.includes('--strict') && total) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
