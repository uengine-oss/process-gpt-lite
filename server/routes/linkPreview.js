// 링크 미리보기(lib/linkPreview.js): 화면이 대화의 링크마다 묻는 카드, 그리고 회사 관리자의 켜고 끄기.
import express from 'express'
import { config } from '../config.js'
import { L } from '../lib/lang.js'
import * as team from '../lib/team.js'
import { previewFor, enabledFor, setEnabled } from '../lib/linkPreview.js'

const hostOf = (s) => { try { return new URL(s).hostname.toLowerCase() } catch { return '' } }
// this app's own host names (the page's, the configured address, Supabase's): their links are this app's, not a page to read
const ownHosts = (req) => [
  ...[req.headers['x-forwarded-host'], req.headers.host].flatMap((h) => String(h || '').split(',')).map((h) => h.trim().toLowerCase().replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/:\d+$/, '')),
  hostOf(config.publicUrl), hostOf(config.supabaseUrl),
].filter(Boolean)

export function linkPreviewRoutes(auth) {
  const r = express.Router()
  r.get('/link-preview', auth, async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : ''
    if (!url || url.length > 2048) return res.status(400).json({ error: L('링크 주소가 필요해요.', 'A link address is needed.') })
    try {
      const out = await previewFor({ userId: req.user.id, tenant: config.tenantId, url, own: ownHosts(req) })
      // the same answer for a while in this browser (the server keeps it for a day)
      res.set('Cache-Control', 'private, max-age=600').json(out)
    } catch (e) {
      if (e.status === 429) return res.status(429).set('Retry-After', '60').json({ error: L('잠시 뒤에 다시 볼게요.', 'Try again in a moment.') })
      console.warn('[link-preview]', e.message)
      res.status(500).json({ error: L('미리보기를 만들지 못했어요.', "Couldn't make a preview.") })
    }
  })
  // the company switch (Settings › 시스템 설정, administrators)
  const adminOnly = async (req, res, next) => (await team.isAdmin(req.user)) ? next() : res.status(403).json({ error: L('회사 관리자만 바꿀 수 있어요.', 'Only a company administrator can change this.') })
  r.get('/admin/link-preview', auth, adminOnly, async (req, res) => res.json({ enabled: await enabledFor(config.tenantId) }))
  r.put('/admin/link-preview', auth, adminOnly, async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: L('켜기 · 끄기 중 하나를 골라 주세요.', 'Choose on or off.') })
    try { res.json(await setEnabled(config.tenantId, req.body.enabled, req.user.id)) } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
  })
  return r
}
