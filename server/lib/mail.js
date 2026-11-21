// Mail intake: periodically pulls new mail and lets the model decide what to do.
// Providers: gmail (OAuth tokens in the vault), imap (app password in the vault), demo.
import crypto from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { q } from './supa.js'
import { chatJson } from './llm.js'
import { getSecret, putItem } from './vault.js'
import { emit } from './bus.js'
import { mainThread, addMessage } from './store.js'
import { L, isEn, asUser, langInstruction } from './lang.js'
import { documentSkills, packSkill, outputOf, packsReady } from './skillInstallCatalog.js'
import { stepForSkill } from './mining/catalog.js'
import { extOf } from './mining/runners.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// ---------- Google OAuth (login + Gmail) ----------
export const GOOGLE_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
]
export const googleEnabled = () => !!(config.google.clientId && config.google.clientSecret)
const redirectUri = () => `${config.publicUrl}/api/auth/google/callback`

export function googleAuthUrl(state, { connectMail = false, verifier } = {}) {
  const p = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: redirectUri(), response_type: 'code',
    scope: (connectMail ? GOOGLE_SCOPES : GOOGLE_SCOPES.slice(0, 3)).join(' '),
    prompt: connectMail ? 'consent' : 'select_account', state,
    ...(connectMail ? { include_granted_scopes: 'true' } : {}),
    ...(connectMail ? { access_type: 'offline' } : {}),
    ...(verifier ? { code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`
}

export async function googleExchange(code, verifier) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code', ...(verifier ? { code_verifier: verifier } : {}) }),
  })
  const tok = await res.json()
  if (!res.ok || !tok.access_token) throw new Error('Google 인증 코드를 확인하지 못했어요. 다시 로그인해 주세요.')
  const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } })
  const me = await info.json()
  if (!info.ok || !me.sub || !me.email || me.email_verified !== true) throw new Error('Google에서 확인된 이메일 계정이 필요해요.')
  return { tok, me }
}

export async function googleAccessToken(userId) {
  const sec = await getSecret(userId, 'oauth', 'google')
  if (!sec) throw new Error('google not connected')
  if (sec.expires_at > Date.now() + 60000) return sec.access_token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: sec.refresh_token, grant_type: 'refresh_token' }),
  })
  const tok = await res.json()
  if (!res.ok || !tok.access_token) throw new Error('Google 연결이 만료됐어요. 메일을 다시 연결해 주세요.')
  const { id, site, ...saved } = sec
  await putItem(userId, 'oauth', 'google', { ...saved, access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000 }, { actor: 'mail' })
  return tok.access_token
}

// ---------- fetchers: each returns [{id, from, subject, date, text}] ----------
async function fetchGmail(userId) {
  const at = await googleAccessToken(userId)
  const api = (p) => fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${p}`, { headers: { Authorization: `Bearer ${at}` } }).then((r) => r.json())
  const list = await api('messages?maxResults=20&q=' + encodeURIComponent('newer_than:2d -category:promotions -category:social'))
  const out = []
  for (const m of list.messages || []) {
    const full = await api(`messages/${m.id}?format=full`)
    const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]))
    out.push({ id: m.id, from: h.from, subject: h.subject, date: h.date, text: full.snippet || '' })
  }
  return out
}

async function fetchImap(userId, acc) {
  const sec = await getSecret(userId, 'login', 'imap')
  if (!sec) throw new Error('imap credential missing')
  const client = new ImapFlow({ host: sec.host, port: 993, secure: true, auth: { user: sec.username, pass: sec.password }, logger: false })
  await client.connect()
  const out = []
  const lock = await client.getMailboxLock('INBOX')
  try {
    const since = new Date(Date.now() - 2 * 86400000)
    for await (const msg of client.fetch({ since }, { source: true, uid: true })) {
      const p = await simpleParser(msg.source)
      out.push({ id: String(msg.uid), from: p.from?.text, subject: p.subject, date: p.date?.toISOString(), text: (p.text || '').slice(0, 1500) })
    }
  } finally { lock.release(); await client.logout() }
  return out.slice(-20)
}

// English mode: the same mails (same ids, senders' addresses, amounts and dates) written in English
const fixture = (name) => path.join(here, '..', 'fixtures', isEn() ? name.replace(/\.json$/, '-en.json') : name)

async function fetchDemo(userId) {
  const file = fixture('demo-mail.json')
  const arrived = await q('select mail_id, sender, subject, body, created_at from pro_demo_mail where user_id=$1 order by created_at', [userId])
  // the fixture's sample mails only make cards; drafts are for mail that arrives
  return [...JSON.parse(fs.readFileSync(file, 'utf8')).map((m) => ({ ...m, fixture: true })),
    ...arrived.map((m) => ({ id: m.mail_id, from: m.sender, subject: m.subject, date: m.created_at.toISOString(), text: m.body }))]
}

// 연습 메일 (Settings): fictional mails a demo mailbox can receive, so a tutorial reader gets one
// without the developer console. Senders use reserved example domains (RFC 2606), never a company's.
export function demoTemplates() {
  const file = fixture('demo-practice-mail.json')
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
}

// A demo mailbox gets a (fictional) message, then is polled as a real inbox would be
// ({template} picks one of demoTemplates(); otherwise from/subject/text as given)
export async function demoArrive(userId, body) {
  const [acc] = await q('select provider from pro_mail_accounts where user_id=$1', [userId])
  if (acc?.provider !== 'demo') throw new Error(L('데모 메일함에서만 쓸 수 있어요', 'This only works with the demo mailbox'))
  let { from, subject, text } = body || {}
  if (body?.template) {
    const t = demoTemplates().find((x) => x.id === body.template)
    if (!t) throw new Error(L('없는 연습 메일이에요', "There's no such practice mail"))
    ;({ from, subject, text } = t)
  }
  if (!String(from || '').trim() || !String(subject || '').trim()) throw new Error(L('보낸 사람과 제목을 적어 주세요', 'Please fill in the sender and the subject'))
  const id = `demo-${crypto.randomBytes(6).toString('hex')}`
  await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [userId, id, String(from).slice(0, 200), String(subject).slice(0, 300), String(text).slice(0, 4000)])
  return pollUser(userId)
}

// ---------- triage ----------
// What documents a mail asks for is the model's to say; how each is made is a skill's. The prompt carries
// no table of document kinds and formats: the skills of the business packs this company has on come with
// the mails (document_skills: name, what it does, the format it makes), and the model picks one by its
// description, or none. A document no pack skill makes is drafted by the agent in an office format.
const DRAFTS_RULE = (en) => `Also return "drafts":[{"mail_id","customer","items":[{"kind","skill","name"}],"summary"}] for mails that ask the user to
send documents back, one item per document: kind is what the mail calls that document, in ${en ? 'English, lower case' : 'Korean'} (a short noun);
skill is the name of the entry in document_skills whose description fits the document, or "" when none does (an entry's
description may also say when it is needed although the mail does not name it); name is a file name "<customer> <kind>.<ext>" whose
ext is that skill's output, else the format the mail names, else one of xlsx|docx|pptx|hwpx that suits the document;
customer the sender's company in ${en ? 'English' : 'Korean'}, summary one ${en ? 'English' : 'Korean'} line of what they need. [] when none.`
const TRIAGE = `You read a user's newest emails (mails) and decide what their assistant should do.
Return JSON {"actions":[{"mail_id","verb","text","icon_domain","due","prompt"}],"brief":"..."}.
- verb: one English word that reads as a button: Reply, Pay, Release, Remind, Add, Review, Call, Book, Sign.
- text: Korean, one line, specific (who/what/amount/date). Continue naturally after the verb.
- icon_domain: sender's company domain for a logo (e.g. lgcns.com), or "".
- prompt: the full instruction the assistant will execute when the user taps the button.
- Skip newsletters, ads and anything not needing action. 0-4 actions.
- brief: 1-3 Korean 해요체 sentences on what matters most, or "" when nothing does.
${DRAFTS_RULE(false)}`

// English mode: the same contract, every text a person reads in English
const TRIAGE_EN = `You read a user's newest emails (mails) and decide what their assistant should do.
Return JSON {"actions":[{"mail_id","verb","text","icon_domain","due","prompt"}],"brief":"..."}.
- verb: one English word that reads as a button: Reply, Pay, Release, Remind, Add, Review, Call, Book, Sign.
- text: English, one line, specific (who/what/amount/date). Continue naturally after the verb.
- icon_domain: sender's company domain for a logo (e.g. lgcns.com), or "".
- prompt: the full instruction the assistant will execute when the user taps the button, in English.
- Skip newsletters, ads and anything not needing action. 0-4 actions.
- brief: 1-3 friendly English sentences on what matters most, or "" when nothing does.
${DRAFTS_RULE(true)}
Write every text in English even when a mail is written in Korean.`
// the prompts as a poll sends them (tests)
export const triagePrompt = () => (isEn() ? TRIAGE_EN : TRIAGE)

// The mails new to this poll. A mail is new to the poll that marks it seen: two polls at once (two
// mails arriving together, a timer and a button) both read it as unseen, and each made its drafts and
// recorded its case steps ('요청 메일 접수' twice in one case — the mined definition lost the step order).
// the triage's input: the fresh mails and the document skills of the packs this company has on
export function triageInput(fresh) {
  return JSON.stringify({
    mails: fresh.map(({ id, from, subject, date, text }) => ({ id, from, subject, date, text: (text || '').slice(0, 800) })),
    document_skills: documentSkills(isEn() ? 'en' : 'ko').map((x) => ({ name: x.name, description: String(x.description || '').slice(0, 400), output: x.output })),
  })
}

export async function claimFresh(userId, mails) {
  const seen = new Set((await q('select mail_id from pro_mail_seen where user_id=$1', [userId])).map((r) => r.mail_id))
  const fresh = []
  for (const m of mails.filter((x) => !seen.has(x.id))) {
    if ((await q('insert into pro_mail_seen values ($1,$2) on conflict do nothing returning mail_id', [userId, m.id])).length) fresh.push(m)
  }
  return fresh
}

export async function pollUser(userId, { announce } = {}) {
  const [acc] = await q('select * from pro_mail_accounts where user_id=$1', [userId])
  if (!acc) return { skipped: 'no account' }
  const mails = acc.provider === 'gmail' ? await fetchGmail(userId)
    : acc.provider === 'imap' ? await fetchImap(userId, acc) : await fetchDemo(userId)
  const fresh = await claimFresh(userId, mails)
  await q('update pro_mail_accounts set last_poll=now() where user_id=$1', [userId])
  if (!fresh.length) return { fresh: 0 }

  await packsReady()
  const r = await chatJson(triagePrompt(), triageInput(fresh))
  for (const a of r.actions || []) {
    const src = fresh.find((m) => m.id === a.mail_id)
    const [row] = await q(
      `insert into pro_actions(user_id,verb,text,icon,due,prompt,source) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [userId, a.verb, a.text, iconDomain(acc.provider, src, a.icon_domain), a.due || null, a.prompt, src ? { mail_id: src.id, from: src.from, subject: src.subject } : null])
    emit(userId, 'action', row)
  }
  if (r.brief) {
    const t = await mainThread(userId)
    const h = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false }))
    await addMessage(userId, t.id, 'system', 'divider', { text: h < 12 ? L('모닝 브리프', 'Morning brief') : h < 18 ? L('오후 브리프', 'Afternoon brief') : L('이브닝 브리프', 'Evening brief') })
    await addMessage(userId, t.id, 'agent', 'text', { text: r.brief })
  } else if (announce) {
    const t = await mainThread(userId)
    await addMessage(userId, t.id, 'agent', 'text', { text: L('메일함을 살펴봤는데 지금 급한 건 없어요. 새 메일이 오면 다시 볼게요.', "I looked through your inbox and nothing is urgent right now. I'll check again when new mail comes in.") })
  }
  // documents the mail asks for: drafts are made right away, before anyone asks (the person reviews them)
  for (const d of r.drafts || []) {
    const src = fresh.find((m) => m.id === d.mail_id)
    // a process registered from mining takes the mail when it matches (lib/mining); else the ad-hoc drafts
    if (src && !src.fixture && d.items?.length) import('./mining/service.js').then((m) => m.routeMail(userId, src, d)).catch((e) => { console.warn('[mail] route', e.message); return false })
      .then((routed) => routed || draftFromMail(userId, src, d)).catch((e) => console.warn('[mail] drafts', e.message))
  }
  return { fresh: fresh.length, actions: (r.actions || []).length }
}

// The logo domain on a Home card. The model guesses a company domain from the sender ("aurora-mfg.com"),
// which for a demo mailbox's fictional senders can be a real company: a demo mailbox only ever gets
// the sender's own (reserved example) domain, which the card shows as a letter tile. A real mailbox
// keeps the model's domain only when it is the sender's, so a card never shows someone else's logo.
export function iconDomain(provider, src, guess) {
  const sender = /@([^>\s]+)>?\s*$/.exec(String(src?.from || ''))?.[1]?.toLowerCase() || ''
  if (provider === 'demo') return sender || null
  const g = String(guess || '').toLowerCase().replace(/^www\./, '')
  if (!g) return null
  return !sender || sender === g || sender.endsWith(`.${g}`) || g.endsWith(`.${sender}`) ? g : sender
}

export function startPoller() {
  setInterval(async () => {
    // each mailbox in its owner's saved language (cards, brief, drafts)
    for (const { user_id } of await q('select user_id from pro_mail_accounts')) {
      await asUser(user_id, () => pollUser(user_id)).catch((e) => console.warn('[mail]', user_id, e.message))
    }
  }, config.mailPollSeconds * 1000)
}

// ---------- drafts a mail asks for ----------
// Made right away, before anyone asks: each document by the business pack skill the triage picked
// (lib/mining/runners.js — the CADCraft drawing, the company's Hangul template, the agent with the skill
// pinned), or — no pack skill makes it — by the agent with its own document skills.
// A Hangul template filled by office-mcp (generate_hwpx, called from here). description: what to fill in
// (the pack skill's wording, runners.js); templateUrl: a template with a picture in it (designTemplate)
export async function hwpxDraft(userId, threadId, mail, { name, description, templateUrl } = {}) {
  const args = {
    template_url: templateUrl || config.proposalTemplateUrl || config.hwpxTemplateUrl,
    report_topic: String(name || '').replace(/\.hwpx$/i, ''),
    report_description: description || '',
    reference_text: L(`보낸 사람: ${mail.from}\n제목: ${mail.subject}\n${String(mail.text || '').slice(0, 2500)}`, `From: ${mail.from}\nSubject: ${mail.subject}\n${String(mail.text || '').slice(0, 2500)}`),
    image_generation_enabled: false, image_reference_enabled: false, tenant_id: config.tenantId,
  }
  const [job] = await q('insert into pro_draft_jobs(user_id, thread_id, args) values ($1,$2,$3) returning id', [userId, threadId, { tool: args, name, mail_id: mail.id, ...(isEn() ? { lang: 'en' } : {}) }])
  return runHwpxJob(job.id, userId, threadId, args, name, mail.id)
}
// mailId: the mail whose draft this is, kept on the card (lib/mining/recorder.js finds the case by it)
async function runHwpxJob(id, userId, threadId, args, name, mailId) {
  const { callOfficeMcp } = await import('./officeMcp.js')
  try {
    const r = await callOfficeMcp('generate_hwpx', args)
    const url = r.file_url || r.url || r.download_url
    if (!url) throw new Error(`generate_hwpx gave no file: ${JSON.stringify(r).slice(0, 200)}`)
    await addMessage(userId, threadId, 'agent', 'file', { ext: 'hwpx', url, name, draft: true, ...(mailId ? { mail_id: mailId } : {}) })
    await q(`update pro_draft_jobs set status='done' where id=$1`, [id])
  } catch (e) {
    await q(`update pro_draft_jobs set status='failed' where id=$1`, [id])
    throw e
  }
}
// a restart of this server mid-way: the 한글 drafts still running start over
export async function resumeDrafts() {
  for (const j of await q(`update pro_draft_jobs set status='running' where status='running' and created_at > now() - interval '1 hour' returning *`)) {
    console.log(`[mail] resuming draft ${j.args.name}`)
    asUser(j.user_id, () => runHwpxJob(j.id, j.user_id, j.thread_id, j.args.tool, j.args.name, j.args.mail_id).catch(async (e) => {
      console.warn('[mail] resumed draft', e.message)
      await addMessage(j.user_id, j.thread_id, 'agent', 'text', { text: L(`${j.args.name} 초안을 만들지 못했어요: ${e.message}`, `I couldn't make the draft of ${j.args.name}: ${e.message}`) })
    }))
  }
}
// the drawing as a picture for a document: CADCraft renders the DXF on its dark canvas, PhotoCraft
// turns it into ink on paper. Resolves with the PNG's path (in `dir`).
async function renderPlan(dxfUrl, dir) {
  const { execFile } = await import('node:child_process')
  const dxf = path.join(dir, 'plan.dxf'), png = path.join(dir, 'plan.png')
  await fs.promises.writeFile(dxf, Buffer.from(await (await fetch(dxfUrl)).arrayBuffer()))
  await new Promise((res, rej) => execFile(config.craftCli.cadcraft, ['convert', dxf, png], { timeout: 120_000 }, (e) => (e ? rej(e) : res())))
  // CADCraft renders on its dark canvas in layer colours; a document wants ink on paper: every stroke
  // charcoal on white, by distance from the background (not brightness — red lines are as dark as the ground)
  const light = path.join(dir, 'plan-light.png')
  const steps = [['select.magicWand', { x: 3, y: 3, tolerance: 14, contiguous: false, antiAlias: false }], ['edit.fill', { contents: 'color', color: '#ffffff' }],
    ['select.inverse'], ['select.modify.expand', { radius: 1 }], ['edit.fill', { contents: 'color', color: '#2b2f36' }], ['select.deselect']]
  const args = ['run', png, ...steps.flatMap(([id, params]) => ['--cmd', id, ...(params ? ['--params', JSON.stringify(params)] : [])]), '--out', light]
  const lit = await new Promise((res) => execFile(config.craftCli.photocraft, args, { timeout: 120_000 }, (e) => res(!e)))
  return lit ? light : png
}

// a drawing as a picture an agent can put in a document: saved where the agent's sandbox sees it;
// resolves with its sandbox path
export async function planPicture(dxfUrl) {
  const os = await import('node:os')
  const { workspaceHostPath } = await import('./missions.js')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pgpt-plan-'))
  try {
    const png = await renderPlan(dxfUrl, dir)
    const rel = `/workspace/pgpt-drafts/${crypto.randomUUID()}/picture.png`
    const host = path.join(await workspaceHostPath('/workspace'), rel.slice('/workspace/'.length))
    await fs.promises.mkdir(path.dirname(host), { recursive: true })
    await fs.promises.copyFile(png, host)
    return rel
  } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

// the company template with a drawing in its picture (a 3:2 slot, config.designTemplatePath), as a URL office-mcp can fill
export async function designTemplate(userId, dxfUrl) {
  const os = await import('node:os')
  const { default: JSZip } = await import('jszip')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pgpt-plan-'))
  try {
    const picture = await renderPlan(dxfUrl, dir)
    const zip = await JSZip.loadAsync(await fs.promises.readFile(config.designTemplatePath))
    zip.file('BinData/image1.png', await fs.promises.readFile(picture))
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/hwp+zip' })
    const { admin } = await import('./supa.js')
    const key = `pgpt-pro/${userId}/${crypto.randomUUID()}.hwpx`
    const { error } = await admin.storage.from('files').upload(key, buf, { contentType: 'application/octet-stream', upsert: false })
    if (error) throw error
    return `${config.supabaseUrl}/storage/v1/object/public/files/${key}`
  } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

// the formats the agent drafts with its own document skills when no pack skill makes the document
const PLAIN = new Set(['xlsx', 'docx', 'pptx', 'hwpx'])
const stem = (n) => String(n || '').replace(/\.[A-Za-z0-9]{2,5}$/, '')

// the documents to make, from the triage's items: a skill is kept only when an enabled pack has it; its
// format is the skill's; a skill that needs another's result first brings that one (pack.json requires)
export function draftItems(d, lg = isEn() ? 'en' : 'ko') {
  const customer = String(d?.customer || L('고객', 'Customer')).trim()
  const items = []
  for (const i of d?.items || []) {
    const skill = packSkill(i.skill)
    const format = skill ? outputOf(skill, lg) : extOf(i.name)
    if (!format || (!skill && !PLAIN.has(format))) continue
    if (skill && items.some((x) => x.skill?.name === skill.name)) continue
    items.push({ kind: String(i.kind || stem(i.name) || format), skill, step: skill ? stepForSkill(skill.name, lg) : null, name: `${stem(i.name) || `${customer} ${i.kind}`}.${format}`, format })
  }
  for (const it of [...items]) {
    for (const need of it.skill?.lite?.requires || []) {
      if (items.some((x) => x.skill?.name === need)) continue
      const skill = packSkill(need)
      if (!skill) continue
      const step = stepForSkill(skill.name, lg)
      const kind = step?.document || skill.name
      items.unshift({ kind, skill, step, name: `${customer} ${kind}.${outputOf(skill, lg)}`, format: outputOf(skill, lg) })
    }
  }
  return items.slice(0, 4)
}
// an item runs after the items its skill needs (pack.json requires · after) that are also being made
const needsOf = (it, items) => [...(it.skill?.lite?.requires || []), ...(it.skill?.lite?.after || [])].filter((n) => items.some((x) => x.skill?.name === n))
export function draftWaves(items) {
  const first = items.filter((it) => !needsOf(it, items).length)
  const rest = items.filter((it) => !first.includes(it))
  return rest.length ? [first, rest] : [first]
}

async function draftFromMail(userId, mail, d) {
  await packsReady()
  const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
  if (!p?.email) return
  const t = await mainThread(userId)
  const lg = isEn() ? 'en' : 'ko'
  let items = draftItems(d, lg)
  if (!items.length) return
  // an install without the app a skill draws in (Docker lite without CADCraft): the other drafts still come
  const { craftAvailable } = await import('../mcp/craft.js')
  // (pack.json "app": the app's id, and its name to show)
  const appOf = (i) => { const a = i.skill?.lite?.app; return !a ? null : typeof a === 'string' ? { id: a, name: a } : { id: a.id, name: a.name?.[lg] || a.name?.ko || a.id } }
  const missing = items.filter((i) => appOf(i) && !craftAvailable(appOf(i).id))
  items = items.filter((i) => !missing.includes(i))
  if (!items.length) return
  const what = items.map((i) => i.kind).join(L('·', ', '))
  const customer = d.customer || L('고객', 'Customer')
  await addMessage(userId, t.id, 'system', 'divider', { text: L(`메일 · ${customer} ${what} 요청`, `Mail · ${customer} ${what} request`) })
  await addMessage(userId, t.id, 'agent', 'text', { text: L(`${customer} 메일에서 ${what} 요청을 찾았어요. 회신할 초안을 먼저 만들어 둘게요.`, `I found a request for ${what} in the mail from ${customer}. I'll make drafts for the reply first.`), mail: { from: mail.from, subject: mail.subject } })
  if (missing.length) {
    const apps = [...new Set(missing.map((i) => appOf(i).name))].join(', ')
    const { josa } = await import('./improve/focus.js')
    await addMessage(userId, t.id, 'agent', 'text', { text: L(`이 설치에는 ${josa(apps, '이/가')} 없어서 ${josa(missing.map((i) => i.kind).join('·'), '은/는')} 만들지 않았어요. 나머지 초안만 만들게요.`, `This install has no ${apps}, so I didn't make the ${missing.map((i) => i.kind).join(', ')}. I'll make the other drafts only.`) })
  }
  const [row] = await q(
    `insert into pro_actions(user_id,verb,text,icon,due,prompt,source) values ($1,'Review',$2,null,null,$3,$4) returning *`,
    [userId, L(`${customer} ${what} 초안 검토하고 회신하기`, `the ${what} drafts for ${customer} and reply`), L(`${customer}에게 보낼 ${what} 초안을 검토했어요. 회신 메일 초안을 써 줘.`, `I've reviewed the ${what} drafts for ${customer}. Please write a draft reply mail.`), { mail_id: mail.id, from: mail.from, subject: mail.subject, drafts: items.map((i) => i.name) }])
  emit(userId, 'action', row)
  // the mail is one case of ad-hoc work: its steps leave handover records process mining reads (lib/mining)
  const mining = await import('./mining/recorder.js')
  const caseId = await mining.openCase({ userId, mail, customer, files: items.map((i) => i.name), items: items.map((i) => ({ kind: i.kind, skill: i.skill?.name || '', name: i.name, format: i.format })) })
    .catch((e) => console.warn('[mining] case', e.message))
  if (caseId) await mining.recordStep(caseId, '요청 메일 접수', { to: { id: userId, name: p.name } }).catch((e) => console.warn('[mining] step', e.message)) // (the case's own language: lib/mining/recorder.js)
  try { await runDrafts(userId, t, mail, d, items, p) } finally {
    await mining.recordDrafts(t.id, mail.id).catch((e) => console.warn('[mining] drafts', e.message))
  }
}

// the drafts in their order: what others need first, then the rest together — the agent's documents of
// one round in one agent turn, the drawing and the Hangul template by their own runners alongside
async function runDrafts(userId, t, mail, d, items, profile) {
  const { runSkill, runAgentItems, runnerFor, fieldLabels } = await import('./mining/runners.js')
  const { stepsIn } = await import('./mining/catalog.js')
  if (items.some((i) => i.skill)) {
    // a business pack in use: a newer version of it goes over the copies the company has not changed (in the background)
    const { sessionFor } = await import('./supa.js')
    const { checkPacksSoon } = await import('./skillInstall.js')
    sessionFor(profile.email, profile.name).then(({ session }) => checkPacksSoon(session.access_token, userId)).catch(() => {})
  }
  const lg = isEn() ? 'en' : 'ko'
  const labels = fieldLabels(stepsIn(lg))
  const prev = { customer: d.customer || L('고객', 'Customer'), sender: mail.from || '', subject: mail.subject || '', body: String(mail.text || '').slice(0, 3000) }
  const fileTag = { draft: true, mail_id: mail.id }
  const status = (text) => emit(userId, 'status', { threadId: t.id, text })
  const failed = async (names, e) => {
    console.warn('[mail] draft', names.join(', '), e.message)
    await addMessage(userId, t.id, 'agent', 'text', { text: L(`${names.join(', ')} 초안을 만들지 못했어요: ${e.message}`, `I couldn't make the draft of ${names.join(', ')}: ${e.message}`) })
  }
  const waves = draftWaves(items)
  for (const [w, wave] of waves.entries()) {
    const agentItems = wave.filter((i) => runnerFor(i.skill, i.format) === 'agent')
    const own = wave.filter((i) => !agentItems.includes(i))
    const jobs = own.map((i) => runSkill({ skill: i.skill, step: i.step, format: i.format, owner: userId, threadId: t.id, prev, name: i.name, kind: i.kind, labels, fileTag, status })
      .then(async (r) => {
        Object.assign(prev, r.values)
        if (r.say) await addMessage(userId, t.id, 'agent', 'text', { text: `${r.say}${w < waves.length - 1 ? L(' 이 결과로 나머지 문서를 만들게요.', " I'll make the other documents from it.") : ''}` })
      })
      .catch((e) => failed([i.name], e)))
    if (agentItems.length) {
      const others = own.map((i) => i.name)
      jobs.push(runAgentItems({ items: agentItems, owner: userId, threadId: t.id, prev, labels, fileTag,
        intro: [L('아래 고객 메일이 요청한 문서의 초안을, 사람이 따로 요청하기 전에 미리 만들어 두세요. 담당자가 열어서 검토하고 고칠 초안입니다.',
          'Make drafts of the documents the customer mail below asks for, before anyone asks. They are drafts the person in charge will open, review and correct.'),
        others.length ? L(`(${others.join(', ')} 는 따로 만들고 있으니 만들지 마세요.)`, `(${others.join(', ')} ${others.length > 1 ? 'are' : 'is'} being made separately — do not make ${others.length > 1 ? 'them' : 'it'}.)`) : ''].filter(Boolean).join(' '),
        status }).then((r) => Object.assign(prev, r.values)).catch((e) => failed(agentItems.map((i) => i.name), e)))
    }
    await Promise.all(jobs)
  }
}
