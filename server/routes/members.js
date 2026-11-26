// A company's membership, for its administrators (lib/membership.js — invite-only, 2026-11-25):
//   POST /api/team/invites {emails, admin?}        「초대」: one or more addresses → [{email, result, mailed?}] (Process GPT's invite)
//   GET  /api/team/requests                        「가입 요청」: the people waiting — [{id, email, name, askedAt}]
//   POST /api/team/requests/:id/approve            승인: the person comes in (and onto the team)
//   POST /api/team/requests/:id/reject             거절: the request ends ('rejected')
//   POST /api/team/members/:id/remove              「내보내기」: the membership ends ('rejected'), off the team — not oneself, not the
//                                                  company's owner, not the last administrator
// Administrators only (users.is_admin of an approved row, or tenants.owner — the check every admin screen uses), in the request's
// company only: a person of another company is not found here.
import express from 'express'
import * as team from '../lib/team.js'
import * as members from '../lib/membership.js'
import { L } from '../lib/lang.js'

export function memberRoutes(auth) {
  const r = express.Router()
  const adminOnly = async (req, res, next) => ((await team.isAdmin(req.user)) ? next()
    : res.status(403).json({ error: L('회사 관리자만 할 수 있어요.', 'Only a company administrator can do this.') }))
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) { console.warn('[members]', req.method, req.path, e.message); return res.status(500).json({ error: L('처리하지 못했어요.', "Couldn't do that.") }) }
      res.status(e.status).json({ error: e.message })
    }
  }

  r.post('/team/invites', auth, adminOnly, h((req) => members.invite(req.user, req.body?.emails, { admin: req.body?.admin === true })))
  r.get('/team/requests', auth, adminOnly, h(() => members.listRequests()))
  r.post('/team/requests/:id/approve', auth, adminOnly, h((req) => members.approve(req.user, req.params.id)))
  r.post('/team/requests/:id/reject', auth, adminOnly, h((req) => members.reject(req.user, req.params.id)))
  r.post('/team/members/:id/remove', auth, adminOnly, h((req) => members.remove(req.user, req.params.id)))
  return r
}
