// Playwright fixtures shared by every tier:
//   as(area)      → API client signed in as pro-rt-<area>@uengine.org (onboarded)
//   pageAs(area)  → a page signed in the same way (session in localStorage 'pgpt-pro-session'),
//                   page errors collected in page.errors
//   db            → database helpers (test is skipped when no database is reachable)
//   cleanup(fn)   → runs after the test, even when it failed (reverse order)
//   lib(name)     → a server module imported in-process (fixed data without the model); skipped
//                   when the pgpt-pro server source is not next to this folder
import { test as base, expect } from '@playwright/test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as api from './api.js'
import * as dbm from './db.js'
import { PGPT_URL, RUN, SERVER_DIR, hasServerSource, LOCAL_API } from './env.js'
import fs from 'node:fs'

// PGL_LANG=ko|en forces the screen language (src/i18n/lang.js reads localStorage pgl-lang);
// RT_I18N_HARVEST=<file> (English runs) appends what the translator could not translate on each page
const LANG = process.env.PGL_LANG
const HARVEST = process.env.RT_I18N_HARVEST

const onboarded = new Set()
async function signedIn(area) {
  const c = await api.as(area)
  if (!onboarded.has(c.id)) {
    await c.post('/profile', { name: `회귀-${area}`, birth: '1990-01-01', onboarded: true })
    onboarded.add(c.id)
  }
  return c
}

export const test = base.extend({
  as: async ({}, use) => { await use(signedIn) },
  pageAs: async ({ browser }, use, testInfo) => {
    const contexts = []
    await use(async (area, { viewport, dpr = 1 } = {}) => {
      const c = await signedIn(area)
      const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 720 }, deviceScaleFactor: dpr, locale: 'ko-KR', baseURL: PGPT_URL })
      await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(c.s))
      if (LANG) await ctx.addInitScript((l) => { try { if (window.top === window) localStorage.setItem('pgl-lang', l) } catch { /* opaque origin */ } }, LANG)
      contexts.push(ctx)
      const page = await ctx.newPage()
      page.errors = []
      page.on('pageerror', (e) => { page.errors.push(String(e?.message || e)); if (process.env.RT_DEBUG_ERRORS) console.log('[pageerror]', e?.stack || e) })
      page.user = c
      return page
    })
    for (const ctx of contexts) {
      if (HARVEST) {
        for (const p of ctx.pages()) {
          const miss = await p.evaluate(() => (window.osI18n?.missing?.() || [])).catch(() => [])
          if (miss.length) fs.appendFileSync(HARVEST, JSON.stringify({ test: testInfo.title, url: p.url(), missing: miss }) + '\n')
        }
      }
      // keep a screenshot of every page on failure (the default fixture only covers `page`)
      if (testInfo.status !== testInfo.expectedStatus) {
        let i = 0
        for (const p of ctx.pages()) await testInfo.attach(`page-${i++}.png`, { body: await p.screenshot({ fullPage: false }).catch(() => Buffer.alloc(0)), contentType: 'image/png' }).catch(() => {})
      }
      await ctx.close().catch(() => {})
    }
  },
  db: async ({}, use, testInfo) => {
    if (!(await dbm.available())) testInfo.skip(true, '데이터베이스에 닿지 않음 (PGPT_DB_URL)')
    await use(dbm)
  },
  cleanup: async ({}, use) => {
    const fns = []
    await use((fn) => fns.push(fn))
    for (const fn of fns.reverse()) await Promise.resolve().then(fn).catch((e) => console.warn('[cleanup]', e.message))
  },
  lib: async ({}, use, testInfo) => {
    if (!hasServerSource() || !LOCAL_API) testInfo.skip(true, 'pgpt-pro server 소스/로컬 서버가 아님 (PGPT_SERVER_DIR)')
    const loaded = []
    // rel may carry ?query to load a fresh module instance (module-level settings read at load)
    await use(async (rel) => { const [file, query] = rel.split('?'); const m = await import(pathToFileURL(path.join(SERVER_DIR, file)).href + (query ? `?${query}` : '')); loaded.push(rel); return m })
  },
})
export { expect, api, RUN }
// unique, readable names for things a test creates
export const uniq = (label) => `${label}-${RUN}-${Math.random().toString(36).slice(2, 6)}`
