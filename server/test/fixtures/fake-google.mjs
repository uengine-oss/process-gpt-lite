// A fake Google OAuth on 127.0.0.1 for the Google 연결 tests (PRO_GOOGLE_AUTH_URL / _TOKEN_URL / _USERINFO_URL /
// _GMAIL_URL point here). Nothing here talks to Google.
//   GET  /o/oauth2/v2/auth   the consent screen: an e-mail field and 「허용」 (or, with refuse on, a screen
//                            refusing this browser; with error on, Google's own 400 page — what the real one
//                            answered the production server's browser on 11-22). 허용 sets this "Google"'s own sign-in cookie (SID) and
//                            sends the browser to redirect_uri with a code and the state.
//   POST /token              authorization_code (client, secret, redirect_uri, PKCE checked) and refresh_token
//   GET  /userinfo           the account the code was given for
//   GET  /gmail/v1/users/me/messages   the mailbox (empty unless a test fills mailbox.messages): the list leaves out
//                                       what Gmail's search would (-in:sent: a message labelled SENT), newest first;
//        …/messages/<id>?format=full    one message (headers, a text/plain body, labels, internalDate)
//        …/threads/<id>                 a thread's messages oldest first (format=metadata: headers only)
//        …/settings/sendAs              the addresses the account may send as (its own, then mailbox.sendAs)
//   The mailbox answers only a token this "Google" gave out (401 otherwise); mailbox.log keeps the paths it was asked.
// The page is drawn for the server browser's 1280×800 view: the field and the button sit at fixed spots.
import http from 'node:http'
import crypto from 'node:crypto'

export const SPOTS = { email: { x: 640, y: 300 }, password: { x: 640, y: 365 }, allow: { x: 640, y: 430 } }
export const TITLES = { consent: 'Fake Google 로그인', refused: 'Fake Google 로그인할 수 없음', error: 'Fake Google Error 400 (Bad Request)' }

export async function startFakeGoogle({ clients = {} } = {}) {
  const codes = new Map() // code -> { email, client_id, redirect_uri, challenge, scope }
  const tokens = new Map() // access token -> email
  const log = { auth: [], token: [], userinfo: 0, approve: [] }
  const state = { refuse: false, error: false, scope: null, deny: false }
  // messages: [{ id, threadId, from, to, cc, replyTo, xOriginalSender, subject, text, labels, at (ms) }] · sendAs: [{ sendAsEmail, treatAsAlias?,
  // verificationStatus? }] (after the account's own, isPrimary) · sendAsStatus: an
  // HTTP status to refuse settings/sendAs with (an older grant)
  const mailbox = { messages: [], sendAs: [], sendAsStatus: 0, log: [] }
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;font-family:sans-serif;background:#fff;height:800px;overflow:hidden">${body}</body>`
  const consent = (q) => page(TITLES.consent, `
<h1 style="position:absolute;left:440px;top:120px;font-size:28px;margin:0">Google 계정으로 로그인</h1>
<p style="position:absolute;left:440px;top:180px;margin:0;color:#555">앱: ${(q.get('client_id') || '').replace(/[<>&"]/g, '')}</p>
<form method="post" action="/approve">
${['client_id', 'redirect_uri', 'state', 'code_challenge', 'scope'].map((k) => `<input type="hidden" name="${k}" value="${(q.get(k) || '').replace(/"/g, '&quot;')}">`).join('')}
<input name="email" type="email" autocomplete="username" placeholder="이메일" style="position:absolute;left:${SPOTS.email.x - 200}px;top:${SPOTS.email.y - 30}px;width:400px;height:60px;font-size:20px;border:2px solid #888;background:#e8f0fe">
<input name="password" type="password" autocomplete="current-password" placeholder="비밀번호" style="position:absolute;left:${SPOTS.password.x - 200}px;top:${SPOTS.password.y - 25}px;width:400px;height:50px;font-size:20px;border:2px solid #888">
<button style="position:absolute;left:${SPOTS.allow.x - 100}px;top:${SPOTS.allow.y - 30}px;width:200px;height:60px;border:0;background:#1a73e8;color:#fff;font-size:20px">허용</button>
</form>`)
  const refused = () => page(TITLES.refused, `<h1 style="position:absolute;left:300px;top:200px;font-size:28px">로그인할 수 없음</h1>
<p style="position:absolute;left:300px;top:260px;width:680px;font-size:18px">이 브라우저 또는 앱은 안전하지 않을 수 있습니다. 다른 브라우저를 사용해 보세요.</p>`)
  const failed = () => page(TITLES.error, `<p style="position:absolute;left:340px;top:200px;width:380px;font-size:15px"><b>400.</b> 오류가 발생했습니다.<br><br>요청 형식이 잘못되어 서버에서 요청을 처리할 수 없습니다. 다시 시도하지 마세요. 다른 원인은 확인할 수 없습니다.</p>`)
  const body = (req) => new Promise((r) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => r(new URLSearchParams(raw))) })
  const json = (res, code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)) }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/o/oauth2/v2/auth') {
      log.auth.push(Object.fromEntries(u.searchParams))
      res.writeHead(state.error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(state.error ? failed() : state.refuse ? refused() : consent(u.searchParams))
    }
    if (u.pathname === '/approve' && req.method === 'POST') {
      const f = await body(req)
      log.approve.push({ email: f.get('email') || '', password: f.get('password') ? 'given' : '' })
      const back = new URL(f.get('redirect_uri'))
      if (state.deny) back.searchParams.set('error', 'access_denied')
      else {
        const code = crypto.randomBytes(12).toString('hex')
        codes.set(code, { email: f.get('email') || 'someone@example.com', client_id: f.get('client_id'), redirect_uri: f.get('redirect_uri'), challenge: f.get('code_challenge'), scope: state.scope ?? f.get('scope') })
        back.searchParams.set('code', code)
      }
      back.searchParams.set('state', f.get('state'))
      // this "Google" signs the browser in, as the real one does
      res.writeHead(302, { Location: back.href, 'Set-Cookie': `SID=fake-google-session-${crypto.randomBytes(4).toString('hex')}; Path=/; HttpOnly; Max-Age=3600` })
      return res.end()
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const f = await body(req)
      const entry = Object.fromEntries(f)
      log.token.push({ ...entry, client_secret: entry.client_secret ? '(given)' : '', secretOk: clients[entry.client_id] === entry.client_secret })
      if (clients[f.get('client_id')] !== f.get('client_secret')) return json(res, 401, { error: 'invalid_client' })
      if (f.get('grant_type') === 'refresh_token') {
        const at = `at-${crypto.randomBytes(8).toString('hex')}`
        tokens.set(at, tokens.get(f.get('refresh_token')) || 'someone@example.com')
        return json(res, 200, { access_token: at, expires_in: 3600, token_type: 'Bearer' })
      }
      const c = codes.get(f.get('code'))
      codes.delete(f.get('code'))
      if (!c || c.client_id !== f.get('client_id') || c.redirect_uri !== f.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' })
      if (crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' })
      const at = `at-${crypto.randomBytes(8).toString('hex')}`, rt = `rt-${crypto.randomBytes(8).toString('hex')}`
      tokens.set(at, c.email); tokens.set(rt, c.email)
      return json(res, 200, { access_token: at, refresh_token: rt, expires_in: 3600, scope: c.scope, token_type: 'Bearer' })
    }
    if (u.pathname === '/userinfo') {
      log.userinfo++
      const email = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''))
      if (!email) return json(res, 401, { error: 'invalid_token' })
      return json(res, 200, { sub: crypto.createHash('sha1').update(email).digest('hex'), email, email_verified: true, name: email.split('@')[0] })
    }
    if (u.pathname.startsWith('/gmail/v1/users/me/')) {
      const who = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''))
      mailbox.log.push(`${u.pathname.slice('/gmail/v1/users/me'.length)}${u.search}`)
      if (!who) return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } })
      const rest = u.pathname.slice('/gmail/v1/users/me/'.length).split('/').map(decodeURIComponent)
      const headers = (m, only) => [['From', m.from], ['To', m.to], ['Cc', m.cc], ['Reply-To', m.replyTo], ['X-Original-Sender', m.xOriginalSender], ['Subject', m.subject], ['Date', new Date(m.at || Date.now()).toUTCString()]]
        .filter(([n, v]) => v && (!only || only.includes(n))).map(([name, value]) => ({ name, value }))
      const shape = (m, metadata, only) => ({ id: m.id, threadId: m.threadId || `t-${m.id}`, labelIds: m.labels || ['INBOX'], internalDate: String(m.at || 0), snippet: String(m.text || '').slice(0, 100),
        payload: metadata ? { headers: headers(m, only) } : { mimeType: 'text/plain', headers: headers(m), body: { data: Buffer.from(String(m.text || '')).toString('base64url') } } })
      if (rest[0] === 'messages' && rest.length === 1) {
        const qs = String(u.searchParams.get('q') || '')
        const list = mailbox.messages.filter((m) => !(/(^|\s)-in:sent(\s|$)/.test(qs) && (m.labels || []).includes('SENT')))
          .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, Number(u.searchParams.get('maxResults')) || 100)
        return json(res, 200, { messages: list.map((m) => ({ id: m.id, threadId: m.threadId || `t-${m.id}` })), resultSizeEstimate: list.length })
      }
      if (rest[0] === 'messages' && rest.length === 2) {
        const m = mailbox.messages.find((x) => x.id === rest[1])
        return m ? json(res, 200, shape(m, u.searchParams.get('format') === 'metadata', u.searchParams.getAll('metadataHeaders'))) : json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } })
      }
      if (rest[0] === 'threads' && rest.length === 2) {
        const ms = mailbox.messages.filter((x) => (x.threadId || `t-${x.id}`) === rest[1]).sort((a, b) => (a.at || 0) - (b.at || 0))
        const meta = u.searchParams.get('format') === 'metadata'
        return ms.length ? json(res, 200, { id: rest[1], messages: ms.map((m) => shape(m, meta, meta ? u.searchParams.getAll('metadataHeaders') : null)) }) : json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } })
      }
      if (rest.join('/') === 'settings/sendAs') {
        if (mailbox.sendAsStatus) return json(res, mailbox.sendAsStatus, { error: { code: mailbox.sendAsStatus, message: 'Request had insufficient authentication scopes.' } })
        return json(res, 200, { sendAs: [{ sendAsEmail: who, isPrimary: true, isDefault: true }, ...mailbox.sendAs] })
      }
      return json(res, 404, { error: { code: 404, message: 'Not found' } })
    }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url, state, log, codes, mailbox,
    env: { PRO_GOOGLE_AUTH_URL: `${url}/o/oauth2/v2/auth`, PRO_GOOGLE_TOKEN_URL: `${url}/token`, PRO_GOOGLE_USERINFO_URL: `${url}/userinfo`, PRO_GOOGLE_GMAIL_URL: `${url}/gmail/v1` },
    // approve as a person would, without a browser: → the redirect_uri the browser would be sent to
    async approve(authUrl, email) {
      const q = new URL(authUrl).searchParams
      const form = new URLSearchParams({ client_id: q.get('client_id'), redirect_uri: q.get('redirect_uri'), state: q.get('state'), code_challenge: q.get('code_challenge'), scope: q.get('scope'), email })
      const r = await fetch(`${url}/approve`, { method: 'POST', body: form, redirect: 'manual' })
      return r.headers.get('location')
    },
    close: () => new Promise((r) => server.close(r)),
  }
}
