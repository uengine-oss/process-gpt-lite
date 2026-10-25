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

async function fetchDemo(userId) {
  const file = path.join(here, '..', 'fixtures', 'demo-mail.json')
  const arrived = await q('select mail_id, sender, subject, body, created_at from pro_demo_mail where user_id=$1 order by created_at', [userId])
  // the fixture's sample mails only make cards; drafts are for mail that arrives
  return [...JSON.parse(fs.readFileSync(file, 'utf8')).map((m) => ({ ...m, fixture: true })),
    ...arrived.map((m) => ({ id: m.mail_id, from: m.sender, subject: m.subject, date: m.created_at.toISOString(), text: m.body }))]
}

// A demo mailbox gets a (fictional) message, then is polled as a real inbox would be
export async function demoArrive(userId, { from, subject, text }) {
  const [acc] = await q('select provider from pro_mail_accounts where user_id=$1', [userId])
  if (acc?.provider !== 'demo') throw new Error('데모 메일함에서만 쓸 수 있어요')
  const id = `demo-${crypto.randomBytes(6).toString('hex')}`
  await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [userId, id, String(from).slice(0, 200), String(subject).slice(0, 300), String(text).slice(0, 4000)])
  return pollUser(userId)
}

// ---------- triage ----------
const TRIAGE = `You read a user's newest emails and decide what their assistant should do.
Return JSON {"actions":[{"mail_id","verb","text","icon_domain","due","prompt"}],"brief":"..."}.
- verb: one English word that reads as a button: Reply, Pay, Release, Remind, Add, Review, Call, Book, Sign.
- text: Korean, one line, specific (who/what/amount/date). Continue naturally after the verb.
- icon_domain: sender's company domain for a logo (e.g. lgcns.com), or "".
- prompt: the full instruction the assistant will execute when the user taps the button.
- Skip newsletters, ads and anything not needing action. 0-4 actions.
- brief: 1-3 Korean 해요체 sentences on what matters most, or "" when nothing does.
Also return "drafts":[{"mail_id","customer","items":[{"kind","format","name"}],"summary"}] for mails that ask the user to
send documents back (견적서·제안서·계획서·보고서·설계도 …): kind is the Korean document word, format one of xlsx|hwpx|docx|pptx|dxf
(견적서·예산·단가표 → xlsx; 제안서·계획서·공문 → hwpx unless the mail names another format; 설계도·평면도·도면·배치도 → dxf,
also when a design proposal needs a drawing the mail does not name), name a file name like
"<customer> 견적서.xlsx", customer the sender's company in Korean, summary one Korean line of what they need. [] when none.`

export async function pollUser(userId, { announce } = {}) {
  const [acc] = await q('select * from pro_mail_accounts where user_id=$1', [userId])
  if (!acc) return { skipped: 'no account' }
  const mails = acc.provider === 'gmail' ? await fetchGmail(userId)
    : acc.provider === 'imap' ? await fetchImap(userId, acc) : await fetchDemo(userId)
  const seen = new Set((await q('select mail_id from pro_mail_seen where user_id=$1', [userId])).map((r) => r.mail_id))
  const fresh = mails.filter((m) => !seen.has(m.id))
  for (const m of fresh) await q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [userId, m.id])
  await q('update pro_mail_accounts set last_poll=now() where user_id=$1', [userId])
  if (!fresh.length) return { fresh: 0 }

  const r = await chatJson(TRIAGE, JSON.stringify(fresh.map(({ id, from, subject, date, text }) => ({ id, from, subject, date, text: (text || '').slice(0, 800) }))))
  for (const a of r.actions || []) {
    const src = fresh.find((m) => m.id === a.mail_id)
    const [row] = await q(
      `insert into pro_actions(user_id,verb,text,icon,due,prompt,source) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [userId, a.verb, a.text, a.icon_domain || null, a.due || null, a.prompt, src ? { mail_id: src.id, from: src.from, subject: src.subject } : null])
    emit(userId, 'action', row)
  }
  if (r.brief) {
    const t = await mainThread(userId)
    const h = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false }))
    await addMessage(userId, t.id, 'system', 'divider', { text: h < 12 ? '모닝 브리프' : h < 18 ? '오후 브리프' : '이브닝 브리프' })
    await addMessage(userId, t.id, 'agent', 'text', { text: r.brief })
  } else if (announce) {
    const t = await mainThread(userId)
    await addMessage(userId, t.id, 'agent', 'text', { text: '메일함을 살펴봤는데 지금 급한 건 없어요. 새 메일이 오면 다시 볼게요.' })
  }
  // documents the mail asks for: drafts are made right away, before anyone asks (the person reviews them)
  for (const d of r.drafts || []) {
    const src = fresh.find((m) => m.id === d.mail_id)
    if (src && !src.fixture && d.items?.length) draftFromMail(userId, src, d).catch((e) => console.warn('[mail] drafts', e.message))
  }
  return { fresh: fresh.length, actions: (r.actions || []).length }
}

export function startPoller() {
  setInterval(async () => {
    for (const { user_id } of await q('select user_id from pro_mail_accounts')) {
      await pollUser(user_id).catch((e) => console.warn('[mail]', user_id, e.message))
    }
  }, config.mailPollSeconds * 1000)
}

// ---------- drafts a mail asks for ----------
// Made right away, before anyone asks: 한글 documents by filling a template with office-mcp
// (generate_hwpx, called from here), the others by the agent with its document skills.
const SKILL_RULES = {
  xlsx: (name) => `엑셀(xlsx) 스킬로 /workspace/${name} 를 만드세요: 위에 제목·수신·발신·견적일·유효기간, 품목 표(품목·규격·수량·단가·금액 열, 금액은 =수량*단가 수식), 그 아래 공급가액 소계·부가세(10%)·합계 행(모두 수식), 숫자는 천 단위 쉼표 서식, 머리글은 색으로 구분. 메일의 수량·조건을 그대로 쓰고, 단가는 합리적인 가정값으로 채우세요.`,
  docx: (name) => `워드(docx) 스킬로 /workspace/${name} 를 만드세요.`,
  pptx: (name) => `파워포인트(pptx) 스킬로 /workspace/${name} 를 만드세요.`,
}
async function hwpxDraft(userId, threadId, mail, item, customer, { templateUrl, extra } = {}) {
  const args = {
    template_url: templateUrl || config.proposalTemplateUrl || config.hwpxTemplateUrl,
    report_topic: item.name.replace(/\.hwpx$/i, ''),
    report_description: `${customer || '고객'}에게 보내는 ${item.kind}. 메일 요구사항을 모두 반영: ${String(mail.text || '').slice(0, 1500)}. 표의 행 수는 템플릿 그대로 두고 칸을 이 고객에 맞게 채우세요. 그림은 그대로 둡니다.${extra ? ` ${extra}` : ''}`,
    reference_text: `보낸 사람: ${mail.from}\n제목: ${mail.subject}\n${String(mail.text || '').slice(0, 2500)}`,
    image_generation_enabled: false, image_reference_enabled: false, tenant_id: config.tenantId,
  }
  const [job] = await q('insert into pro_draft_jobs(user_id, thread_id, args) values ($1,$2,$3) returning id', [userId, threadId, { tool: args, name: item.name }])
  return runHwpxJob(job.id, userId, threadId, args, item.name)
}
async function runHwpxJob(id, userId, threadId, args, name) {
  const { callOfficeMcp } = await import('./officeMcp.js')
  try {
    const r = await callOfficeMcp('generate_hwpx', args)
    const url = r.file_url || r.url || r.download_url
    if (!url) throw new Error(`generate_hwpx gave no file: ${JSON.stringify(r).slice(0, 200)}`)
    await addMessage(userId, threadId, 'agent', 'file', { ext: 'hwpx', url, name, draft: true })
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
    runHwpxJob(j.id, j.user_id, j.thread_id, j.args.tool, j.args.name).catch(async (e) => {
      console.warn('[mail] resumed draft', e.message)
      await addMessage(j.user_id, j.thread_id, 'agent', 'text', { text: `${j.args.name} 초안을 만들지 못했어요: ${e.message}` })
    })
  }
}
// A design request (a floor plan with the proposal): CADCraft draws it first (the agent, through
// its MCP); the drawing, rendered to PNG, goes into the proposal template's picture before office-mcp
// fills it, with the room schedule from the drawing; the quote is worked out from the same areas.
async function designDrafts(userId, t, mail, d, items) {
  const { sessionFor } = await import('./supa.js')
  const { delegate } = await import('./agent.js')
  const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
  const { user, session } = await sessionFor(p.email, p.name)
  const customer = d.customer || '고객'
  const plan = items.find((i) => i.format === 'dxf')
  const body = String(mail.text || '').slice(0, 2500)
  // 1) the floor plan, drawn in CADCraft through its MCP (lib/floorPlan.js)
  const status = (text) => emit(userId, 'status', { threadId: t.id, text })
  status('도면 배치 정하는 중')
  const { layoutFromMail, drawFloorPlan } = await import('./floorPlan.js')
  const { publish } = await import('./office.js')
  const layout = await layoutFromMail(mail)
  let drawn = null
  try {
    drawn = await drawFloorPlan(userId, layout, plan.name, (step) => status(`캐드크래프트로 도면 그리는 중 · ${step}`))
  } finally { status(null) }
  const doc = await publish(userId, drawn.path)
  const card = { content: { ...doc, path: drawn.path } }
  await addMessage(userId, t.id, 'agent', 'file', { ...doc, path: drawn.path, draft: true })
  const rooms = drawn.rooms.map((r) => `${r.name} | ${r.area}㎡ | ${r.use}`).join(' / ')
  await addMessage(userId, t.id, 'agent', 'text', { text: `캐드크래프트로 평면도(${drawn.width}m × ${drawn.depth}m)를 그렸어요. 실별 면적은 ${drawn.rooms.map((r) => `${r.name} ${r.area}㎡`).join(', ')}이에요. 이 도면으로 제안서와 견적서를 만들게요.` })
  let templateUrl = config.proposalTemplateUrl || config.hwpxTemplateUrl
  if (card?.content?.url) {
    try { templateUrl = await designTemplate(userId, card.content.url) } catch (e) { console.warn('[mail] design template', e.message) }
  }
  const jobs = []
  for (const i of items.filter((x) => x.format === 'hwpx')) {
    jobs.push(hwpxDraft(userId, t.id, mail, i, customer, { templateUrl,
      extra: `평면도(${plan.name})를 2번 '설계 평면도' 그림으로 그대로 두고, '공간 구성' 표는 평면도의 실별 면적으로 채우세요: ${rooms}` })
      .catch(async (e) => { console.warn('[mail] hwpx draft', e.message); await addMessage(userId, t.id, 'agent', 'text', { text: `${i.name} 초안을 만들지 못했어요: ${e.message}` }) }))
  }
  const others = items.filter((x) => SKILL_RULES[x.format])
  if (others.length) {
    jobs.push(delegate({ user, session, threadId: t.id, silent: true,
      text: `같은 고객 메일(${mail.subject})에 회신할 문서 초안을 미리 만드세요. 방금 그린 평면도의 실별 면적: ${rooms}\n메일 본문: ${body}\n\n` +
        others.map((i, k) => `${k + 1}) ${i.kind} — 파일 이름 "${i.name}". ${i.format === 'xlsx'
          ? `엑셀(xlsx) 스킬로 /workspace/${i.name} 를 만드세요: 위에 제목·수신·발신·견적일·유효기간, 품목 표(구분·품목·수량·단위·단가·금액, 금액은 =수량*단가 수식) — 설계비(평면·마감 설계, 1식), 실별 인테리어 공사(면적 ㎡ × ㎡당 단가, 실마다 한 줄), 가구·집기(좌석 수 기준), 전기·설비(1식), 그 아래 공급가액 소계·부가세(10%)·합계 행(모두 수식), 천 단위 쉼표, 머리글 색 구분. 단가는 합리적인 가정값.`
          : SKILL_RULES[i.format](i.name)}`).join('\n') +
        `\n\n(평면도와 한글 제안서는 이미 따로 만들고 있으니 만들지 마세요.) 다 만들면 파일 이름과 가정한 단가를 두세 줄로 적으세요. 진행 설명과 답은 모두 한국어(해요체)로 쓰세요.` })
      .catch((e) => console.warn('[mail] drafts', e.message)))
  }
  await Promise.all(jobs)
}

// the proposal template with the drawing in its picture (a 3:2 slot), as a URL office-mcp can fill
async function designTemplate(userId, dxfUrl) {
  const os = await import('node:os')
  const { execFile } = await import('node:child_process')
  const { default: JSZip } = await import('jszip')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pgpt-plan-'))
  try {
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
    const zip = await JSZip.loadAsync(await fs.promises.readFile(config.designTemplatePath))
    zip.file('BinData/image1.png', await fs.promises.readFile(lit ? light : png))
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/hwp+zip' })
    const { admin } = await import('./supa.js')
    const key = `pgpt-pro/${userId}/${crypto.randomUUID()}.hwpx`
    const { error } = await admin.storage.from('files').upload(key, buf, { contentType: 'application/octet-stream', upsert: false })
    if (error) throw error
    return `${config.supabaseUrl}/storage/v1/object/public/files/${key}`
  } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

async function draftFromMail(userId, mail, d) {
  const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
  if (!p?.email) return
  const t = await mainThread(userId)
  const items = d.items.filter((i) => i.format === 'hwpx' || i.format === 'dxf' || SKILL_RULES[i.format]).slice(0, 4)
  if (!items.length) return
  // a design proposal needs its drawing, whether or not the mail lists one
  if (!items.some((i) => i.format === 'dxf') && /평면도|설계도|도면|배치도|인테리어|설계\s*제안/.test(`${mail.subject} ${mail.text}`)) {
    items.unshift({ kind: '평면도', format: 'dxf', name: `${(d.customer || '고객').trim()} 평면도.dxf` })
  }
  const rank = { dxf: 0, hwpx: 1, xlsx: 2 }
  items.sort((a, b) => (rank[a.format] ?? 3) - (rank[b.format] ?? 3))
  const what = items.map((i) => i.kind).join('·')
  const customer = d.customer || '고객'
  await addMessage(userId, t.id, 'system', 'divider', { text: `메일 · ${customer} ${what} 요청` })
  await addMessage(userId, t.id, 'agent', 'text', { text: `${customer} 메일에서 ${what} 요청을 찾았어요. 회신할 초안을 먼저 만들어 둘게요.`, mail: { from: mail.from, subject: mail.subject } })
  const [row] = await q(
    `insert into pro_actions(user_id,verb,text,icon,due,prompt,source) values ($1,'Review',$2,null,null,$3,$4) returning *`,
    [userId, `${customer} ${what} 초안 검토하고 회신하기`, `${customer}에게 보낼 ${what} 초안을 검토했어요. 회신 메일 초안을 써 줘.`, { mail_id: mail.id, from: mail.from, subject: mail.subject, drafts: items.map((i) => i.name) }])
  emit(userId, 'action', row)
  if (items.some((i) => i.format === 'dxf')) return designDrafts(userId, t, mail, d, items)
  const jobs = items.filter((i) => i.format === 'hwpx').map((i) => hwpxDraft(userId, t.id, mail, i, customer)
    .catch(async (e) => { console.warn('[mail] hwpx draft', e.message); await addMessage(userId, t.id, 'agent', 'text', { text: `${i.name} 초안을 만들지 못했어요: ${e.message}` }) }))
  const others = items.filter((i) => SKILL_RULES[i.format])
  if (others.length) {
    const { sessionFor } = await import('./supa.js')
    const { delegate } = await import('./agent.js')
    const { user, session } = await sessionFor(p.email, p.name)
    const text = `아래 고객 메일이 요청한 문서의 초안을, 사람이 따로 요청하기 전에 미리 만들어 두세요. 담당자가 열어서 검토하고 고칠 초안입니다.\n\n` +
      `메일 — 보낸 사람: ${mail.from}\n제목: ${mail.subject}\n본문: ${String(mail.text || '').slice(0, 2500)}\n\n` +
      others.map((i, k) => `${k + 1}) ${i.kind} — 파일 이름 "${i.name}". ${SKILL_RULES[i.format](i.name)}`).join('\n') +
      `\n\n(한글 문서는 따로 만들고 있으니 만들지 마세요.) 다 만들면 파일 이름만 짧게 알리고, 검토할 점(가정한 단가 등)을 두세 줄로 적으세요. 진행 설명과 답은 모두 한국어(해요체)로 쓰세요.`
    jobs.push(delegate({ user, session, threadId: t.id, text, silent: true }).catch((e) => console.warn('[mail] drafts', e.message)))
  }
  await Promise.all(jobs)
}
