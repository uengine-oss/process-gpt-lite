// The newest desktop app the server offers to pages inside an older one (lib/localAgents/desktopRelease.js): which release counts,
// version order, a look that never waits for GitHub, and no offer when GitHub cannot be reached.
//   node --test test/desktopRelease.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { older, pickLatest, latestDesktop, pending, _reset } from '../lib/localAgents/desktopRelease.js'

const saved = { latest: process.env.PRO_DESKTOP_LATEST, repo: process.env.PRO_DESKTOP_RELEASES_REPO }
test.afterEach(() => {
  _reset()
  for (const [k, v] of [['PRO_DESKTOP_LATEST', saved.latest], ['PRO_DESKTOP_RELEASES_REPO', saved.repo]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('version order: by number, not by text', () => {
  assert.equal(older('0.1.0', '0.2.2'), true)
  assert.equal(older('0.2.2', '0.2.10'), true)
  assert.equal(older('0.2.10', '0.2.9'), false)
  assert.equal(older('0.2.2', '0.2.2'), false)
  assert.equal(older('v0.2.1', '0.2.2'), true)
  // not x.y.z: never "older" (no offer from a version the app did not report)
  assert.equal(older('', '0.2.2'), false)
  assert.equal(older('0.2', '0.2.2'), false)
  assert.equal(older('0.2.2', null), false)
})

test('the newest published desktop release, not the server release, a draft or a pre-release', () => {
  const releases = [
    { tag_name: 'desktop-v0.2.4', draft: true },
    { tag_name: 'desktop-v0.3.0-rc1', prerelease: true },
    { tag_name: 'desktop-v0.3.0', prerelease: true },
    { tag_name: 'v0.9.0' },
    { tag_name: 'desktop-v0.2.10' },
    { tag_name: 'desktop-v0.2.9' },
  ]
  assert.equal(pickLatest(releases), '0.2.10')
  assert.equal(pickLatest([]), null)
  assert.equal(pickLatest(null), null)
})

test('a look returns at once; the release list is read in the background and kept', async () => {
  delete process.env.PRO_DESKTOP_LATEST
  process.env.PRO_DESKTOP_RELEASES_REPO = 'example/repo'
  const calls = []
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => [{ tag_name: 'desktop-v0.2.3' }, { tag_name: 'desktop-v0.2.2' }] } }
  assert.equal(latestDesktop({ fetchImpl, now: 1000 }), null)
  await pending()
  assert.deepEqual(calls, ['https://api.github.com/repos/example/repo/releases?per_page=30'])
  assert.equal(latestDesktop({ fetchImpl, now: 2000 }), '0.2.3')
  // kept for hours: no second read
  await pending()
  assert.equal(calls.length, 1)
  assert.equal(latestDesktop({ fetchImpl, now: 1000 + 7 * 3600e3 }), '0.2.3')
  await pending()
  assert.equal(calls.length, 2)
})

test('GitHub out of reach or refusing: no offer, and the next try waits', async () => {
  delete process.env.PRO_DESKTOP_LATEST
  process.env.PRO_DESKTOP_RELEASES_REPO = 'example/repo'
  let n = 0
  const down = async () => { n++; throw new Error('ENOTFOUND') }
  assert.equal(latestDesktop({ fetchImpl: down, now: 1000 }), null)
  await pending()
  assert.equal(latestDesktop({ fetchImpl: down, now: 2000 }), null)
  await pending()
  assert.equal(n, 1)
  const refused = async () => ({ ok: false, status: 403, json: async () => ({}) })
  assert.equal(latestDesktop({ fetchImpl: refused, now: 1000 + 11 * 60e3 }), null)
  await pending()
  assert.equal(latestDesktop({ fetchImpl: refused, now: 1000 + 12 * 60e3 }), null)
})

test('a fixed version, or no offer at all', () => {
  process.env.PRO_DESKTOP_LATEST = 'v0.2.5'
  assert.equal(latestDesktop({ fetchImpl: () => { throw new Error('must not be called') } }), '0.2.5')
  process.env.PRO_DESKTOP_LATEST = 'not-a-version'
  assert.equal(latestDesktop(), null)
  delete process.env.PRO_DESKTOP_LATEST
  process.env.PRO_DESKTOP_RELEASES_REPO = 'off'
  assert.equal(latestDesktop({ fetchImpl: () => { throw new Error('must not be called') } }), null)
})
