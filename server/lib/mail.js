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

function fetchDemo() {
  const file = path.join(here, '..', 'fixtures', 'demo-mail.json')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ---------- triage ----------
const TRIAGE = `You read a user's newest emails and decide what their assistant should do.
Return JSON {"actions":[{"mail_id","verb","text","icon_domain","due","prompt"}],"brief":"..."}.
- verb: one English word that reads as a button: Reply, Pay, Release, Remind, Add, Review, Call, Book, Sign.
- text: Korean, one line, specific (who/what/amount/date). Continue naturally after the verb.
- icon_domain: sender's company domain for a logo (e.g. lgcns.com), or "".
- prompt: the full instruction the assistant will execute when the user taps the button.
- Skip newsletters, ads and anything not needing action. 0-4 actions.
- brief: 1-3 Korean 해요체 sentences on what matters most, or "" when nothing does.`

export async function pollUser(userId, { announce } = {}) {
  const [acc] = await q('select * from pro_mail_accounts where user_id=$1', [userId])
  if (!acc) return { skipped: 'no account' }
  const mails = acc.provider === 'gmail' ? await fetchGmail(userId)
    : acc.provider === 'imap' ? await fetchImap(userId, acc) : fetchDemo()
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
  return { fresh: fresh.length, actions: (r.actions || []).length }
}

export function startPoller() {
  setInterval(async () => {
    for (const { user_id } of await q('select user_id from pro_mail_accounts')) {
      await pollUser(user_id).catch((e) => console.warn('[mail]', user_id, e.message))
    }
  }, config.mailPollSeconds * 1000)
}
