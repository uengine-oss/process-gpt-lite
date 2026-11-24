// 링크 미리보기의 회사 스위치(pro_link_preview_settings, sql/051) — 실제 DB. 행이 없으면 켬, 관리자가 끄면 그 회사는 아무것도 읽지 않고
// 기억해 둔 카드도 내주지 않는다, 다른 회사는 그대로. 페이지는 로컬 가짜 서버.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'

const { q, pool } = await import('../lib/supa.js')
const { previewFor, enabledFor, setEnabled, _reset } = await import('../lib/linkPreview.js')

const A = `rt-lp-a-${crypto.randomUUID().slice(0, 8)}`, B = `rt-lp-b-${crypto.randomUUID().slice(0, 8)}`
let server, base, hits = 0
before(async () => {
  server = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<head><meta property="og:title" content="회사 스위치"></head>') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await q('delete from pro_link_preview_settings where tenant_id = any($1)', [[A, B]])
  server.close()
  await pool.end()
})
const ask = (tenant) => previewFor({ userId: 'u1', tenant, url: `${base}/p` }, { allowHosts: new Set([new URL(base).host]), lookup: () => { throw new Error('no dns') } })

test('행이 없으면 켬 → 끄면 그 회사는 읽지 않고(기억한 카드도 없음), 다른 회사는 그대로 → 다시 켜면 읽는다', async () => {
  _reset()
  assert.equal(await enabledFor(A), true)
  assert.equal((await ask(A)).preview.title, '회사 스위치')
  assert.equal(hits, 1)
  assert.deepEqual(await setEnabled(A, false, null), { enabled: false })
  const [row] = await q('select enabled from pro_link_preview_settings where tenant_id=$1', [A])
  assert.equal(row.enabled, false)
  assert.equal(await enabledFor(A), false)
  assert.deepEqual(await ask(A), { preview: null, reason: 'off' })
  assert.equal(hits, 1, '끈 회사는 읽지 않는다')
  assert.equal((await ask(B)).preview.title, '회사 스위치', '다른 회사는 그대로')
  assert.equal(hits, 2)
  await setEnabled(A, true, null)
  assert.equal((await ask(A)).preview.title, '회사 스위치')
  assert.equal(hits, 3, '끌 때 지운 카드는 다시 읽는다')
})

test('설정은 잠깐 기억했다가 다시 읽는다 — 다른 서버(파드)가 바꾼 값도 곧 따른다', async () => {
  _reset()
  await q(`insert into pro_link_preview_settings(tenant_id, enabled) values ($1, false) on conflict (tenant_id) do update set enabled=false`, [B])
  assert.equal(await enabledFor(B), false)
  await q('update pro_link_preview_settings set enabled=true where tenant_id=$1', [B])
  assert.equal(await enabledFor(B), false, '30초 안에는 기억한 값')
  _reset()
  assert.equal(await enabledFor(B), true)
})
