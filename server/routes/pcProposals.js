// 「스킬을 등록할까요?」 · 「폴더를 올릴까요?」 — a person's own CLI proposes a skill or a folder of their PC (lib/localAgents/pcTools.js).
// Two sides:
//   the desktop app, with a chat run's tool token (Authorization: Bearer plt1.… — that person, that device, that run while it is on;
//   mounted ahead of the session, the body parser and the tenant middleware: the token is the whole of the auth and names the company).
//   The token — and that its device and run are still on — is checked before any body is read; only a skill's proposal may carry 16 MB,
//   a folder's preview 1 MB, the lists none
//     GET  /api/local-agents/tools/skills            the person's skills on the server (read-only)
//     GET  /api/local-agents/tools/folders           the shared folders they are a member of (read-only)
//     POST /api/local-agents/tools/skills/propose    a skill folder's files → a proposal and its card (16 MB body at most)
//     POST /api/local-agents/tools/folders/propose   a folder's preview (no path) → a proposal and its card
//   the card, signed in (only the proposal's person — anyone else's is 404)
//     GET  /api/pc-proposals/:id                     what the card shows, with a confirmation bound to it
//     POST /api/pc-proposals/:id/register            {scope: mine | company, confirm, companyOk, name} — 「등록」 (a skill; 「회사 스킬」 needs
//                                                     companyOk — the card's second check — always)
//     POST /api/pc-proposals/:id/upload              {confirm, name} — 「올리기」 (a folder: the PC uploads it)
//     POST /api/pc-proposals/:id/drop                「그만두기」
import express from 'express'
import * as P from '../lib/localAgents/pcTools.js'
import { withTenant } from '../lib/tenant.js'
import { withLang, langOf, normLang, L } from '../lib/lang.js'
import { hidePaths } from './folders.js'

// (a server failure says what failed, never where on the server — the whole message goes to the log only)
const failed = (res, e) => {
  const status = e.status || 500
  if (status >= 500) console.warn('[pc-tools]', e.message)
  res.status(status).json({ error: !e.status ? L('처리하지 못했어요. 잠시 후 다시 시도해 주세요.', "Couldn't do that. Please try again in a moment.") : status >= 500 ? hidePaths(e.message) : e.message,
    ...(e.code ? { code: e.code } : {}) })
}

export function pcToolRoutes() {
  const r = express.Router()
  // the run first: its token (signed, in its time), then — in its company — that its device is linked and the run is on; nothing of the
  // body is read before that
  r.use((req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))
    const claims = m ? P.verifyToken(m[1]) : null
    if (!claims) return res.status(401).json({ error: 'invalid or expired tool token', code: 'token' })
    return withTenant(claims.tenant, async () => {
      try { req.pcRun = { claims, ctx: await P.access(claims) } } catch (e) { return failed(res, e) }
      next()
    })
  })
  // (a body parser's callbacks leave the request's async context: the company and language are entered again for the work itself)
  const withRun = (fn) => (req, res) => withTenant(req.pcRun.claims.tenant, async () => {
    try {
      const { ctx } = req.pcRun
      // (the person's language: what the card says — the app's header first, else their saved one)
      const lang = normLang(req.headers['x-pgl-lang']) || await langOf(ctx.user.id).catch(() => 'ko')
      res.json(await withLang(lang, () => fn(ctx, req)))
    } catch (e) { failed(res, e) }
  })
  r.get('/skills', withRun((ctx) => P.mySkills(ctx)))
  r.get('/folders', withRun((ctx) => P.myFolders(ctx)))
  r.post('/skills/propose', express.json({ limit: '16mb' }), withRun((ctx, req) => P.proposeSkill(ctx, req.body || {})))
  r.post('/folders/propose', express.json({ limit: '1mb' }), withRun((ctx, req) => P.proposeFolder(ctx, req.body || {})))
  // (a body too large, or not JSON, for the one route that reads it)
  r.use((e, req, res, next) => (e?.type === 'entity.too.large' ? res.status(413).json({ error: 'too large', code: 'too_big' }) : e?.type === 'entity.parse.failed' ? res.status(400).json({ error: 'not JSON', code: 'bad_body' }) : next(e)))
  return r
}

export function pcProposalRoutes(auth) {
  const r = express.Router()
  const h = (fn) => (req, res) => fn(req).then((x) => res.json(x)).catch((e) => failed(res, e))
  const user = (req) => ({ id: req.user.id, name: req.user.name, email: req.user.email })
  r.get('/pc-proposals/:id', auth, h((req) => P.view(user(req), req.params.id)))
  r.post('/pc-proposals/:id/register', auth, h((req) => P.register(user(req), req.params.id, {
    scope: req.body?.scope === 'company' ? 'company' : 'mine', confirm: req.body?.confirm, companyOk: req.body?.companyOk === true,
    name: typeof req.body?.name === 'string' ? req.body.name : null, jwt: req.session?.access_token || null })))
  r.post('/pc-proposals/:id/upload', auth, h((req) => P.upload(user(req), req.params.id, { confirm: req.body?.confirm, name: typeof req.body?.name === 'string' ? req.body.name : null })))
  r.post('/pc-proposals/:id/drop', auth, h((req) => P.drop(user(req), req.params.id)))
  return r
}
