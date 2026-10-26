// 보안 울타리 — 모델 없이 빠르게: 작업실 권한, 터미널·라이브 웹소켓의 티켓/출처 검사, 라이브 제어 포트의
// pid 검사, MCP 의 JWT 검사, 보관함 응답에 비밀 없음, 남의 파일을 모델 화면에 띄우지 않는 CSP.
import { test, expect, api, uniq } from '../../lib/fixtures.js'
import { upgrade, nextMessage, serverPid, listeningPorts, talk } from '../../lib/net.js'
import { removeFolder } from '../../lib/seed.js'
import { LOCAL_API, MCP_URL } from '../../lib/env.js'

test.describe('작업실 접근 (spec agent-workroom: 작업실 접근 권한 · 터미널 연결)', () => {
  test('S-20 남의 공유 폴더 작업실은 403, 주인은 200', async ({ as, db, cleanup }) => {
    const owner = await as('sec-owner'), stranger = await as('sec-stranger')
    const f = await owner.post('/folders', { name: uniq('회귀 보안 폴더') })
    cleanup(() => removeFolder(db, f.body.slug))
    expect((await owner.get(`/workroom/folder/${f.body.slug}`)).status).toBe(200)
    const r = await stranger.get(`/workroom/folder/${f.body.slug}`)
    expect(r.status).toBe(403)
    expect((await stranger.get(`/workroom/folder/${f.body.slug}/file?path=.gitattributes`)).status).toBe(403)
    expect((await stranger.post(`/workroom/folder/${f.body.slug}/ticket`, { mode: 'shell' })).status).toBe(403)
  })

  test('S-21 남의 대화 작업 폴더(chat)도 403', async ({ as, db }) => {
    const owner = await as('sec-owner'), stranger = await as('sec-stranger')
    const room = await db.mainThreadId(owner.id)
    const r = await stranger.get(`/workroom/chat/${room}`)
    expect([403, 404]).toContain(r.status)
    expect(r.status).not.toBe(200)
  })

  test('S-22 작업실 파일 경로는 폴더 밖으로 나갈 수 없다', async ({ as, db, cleanup }) => {
    const owner = await as('sec-owner')
    const f = await owner.post('/folders', { name: uniq('회귀 경로 폴더') })
    cleanup(() => removeFolder(db, f.body.slug))
    for (const p of ['../../../../etc/passwd', '/etc/passwd', '.git/config/../../../x']) {
      const r = await owner.get(`/workroom/folder/${f.body.slug}/file?path=${encodeURIComponent(p)}`)
      expect(r.status, p).toBeGreaterThanOrEqual(400)
      expect(r.text).not.toContain('root:')
    }
  })

  test('S-23 터미널 웹소켓: 티켓 없음 401 · 다른 출처 403 · 티켓 재사용 401', async ({ as, db, cleanup }) => {
    const owner = await as('sec-owner')
    const f = await owner.post('/folders', { name: uniq('회귀 터미널 폴더') })
    cleanup(() => removeFolder(db, f.body.slug))
    expect((await upgrade('/api/workroom/term')).status).toBe(401)
    const t1 = (await owner.post(`/workroom/folder/${f.body.slug}/ticket`, { mode: 'shell' })).body.ticket
    expect((await upgrade(`/api/workroom/term?ticket=${t1}`, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await upgrade(`/api/workroom/term?ticket=${t1}`, { origin: '' })).status).toBe(403)
    const t2 = (await owner.post(`/workroom/folder/${f.body.slug}/ticket`, { mode: 'shell' })).body.ticket
    const ok = await upgrade(`/api/workroom/term?ticket=${t2}`)
    expect(ok.status).toBe(101)
    ok.ws.close()
    expect((await upgrade(`/api/workroom/term?ticket=${t2}`)).status).toBe(401)
  })
})

test.describe('라이브 공동 편집 울타리 (spec craft-apps: 라이브 제어 포트는 그 사용자의 CLI 만)', () => {
  test('S-24 라이브 웹소켓: 티켓 없음 401 · 다른 출처 403 · 재사용 401', async ({ as }) => {
    const u = await as('sec-owner')
    expect((await upgrade('/api/craft/live')).status).toBe(401)
    const t = (await u.post('/craft/live/ticket')).body.ticket
    expect((await upgrade(`/api/craft/live?ticket=${t}`, { origin: 'https://evil.example' })).status).toBe(403)
    const t2 = (await u.post('/craft/live/ticket')).body.ticket
    const ok = await upgrade(`/api/craft/live?ticket=${t2}`)
    expect(ok.status).toBe(101)
    ok.ws.close()
    expect((await upgrade(`/api/craft/live?ticket=${t2}`)).status).toBe(401)
    expect((await api.call(null, 'POST', '/craft/live/ticket')).status).toBe(401)
  })

  for (const app of ['vectorcraft', 'photocraft', 'soundcraft', 'cadcraft', 'filmcraft']) {
    test(`S-25 ${app} 라이브 제어 포트: CLI 가 아닌 프로세스의 접속은 끊긴다`, async ({ as }) => {
      test.skip(!LOCAL_API, '로컬 서버에서만 (lsof)')
      const pid = serverPid()
      test.skip(!pid, 'BFF(node) pid 를 못 찾음 — 컨테이너로 도는 설치 스택은 호스트에서 라이브 제어 포트를 볼 수 없음')
      const u = await as('sec-owner')
      const before = listeningPorts(pid)
      const t = (await u.post('/craft/live/ticket')).body.ticket
      const { ws } = await upgrade(`/api/craft/live?ticket=${t}`)
      try {
        ws.send(JSON.stringify({ type: 'open', app, file: `rt-${app}.bin` }))
        expect((await nextMessage(ws, (m) => m.type === 'live' || m.type === 'error')).type).toBe('live')
        const fresh = [...listeningPorts(pid)].filter((p) => !before.has(p))
        expect(fresh.length, 'a new loopback control port').toBeGreaterThan(0)
        for (const port of fresh) {
          // the right auth shape (PhotoCraft/FilmCraft token first) with a wrong token, then a call
          const r = await talk(port, [{ id: 1, method: 'auth', params: { token: '0'.repeat(64) } }, { id: 2, token: '0'.repeat(64), method: 'ui.inspect' }])
          expect(r.closed, `port ${port} closed the connection`).toBe(true)
          expect(r.data).not.toMatch(/"ok":\s*true/)
        }
        // the page side saw no call: nothing reached the app
        await expect(nextMessage(ws, (m) => m.type === 'call', 1500)).rejects.toThrow()
      } finally { ws.close() }
    })
  }
})

test.describe('MCP 게이트웨이의 사용자 확인', () => {
  for (const p of ['/mcp/photocraft', '/mcp/vectorcraft', '/mcp/cadcraft', '/mcp/soundcraft', '/mcp/filmcraft', '/mcp/office', '/mcp/panelapps', '/mcp/folders']) {
    test(`S-26 ${p}: 틀린 JWT 401, JWT 없이 도구 호출은 unauthorized`, async () => {
      test.skip(!LOCAL_API && !process.env.MCP_URL, 'MCP 는 BFF 에 직접 닿아야 함 (MCP_URL)')
      expect((await api.mcp(p, 'tools/list', {}, 'bogus.jwt.value')).status).toBe(401)
      const tool = { '/mcp/office': 'office_live_status', '/mcp/panelapps': 'panel_app_list', '/mcp/folders': 'folder_catalog' }[p] || `${p.split('/').pop()}_start`
      const r = await api.mcp(p, 'tools/call', { name: tool, arguments: {} }, null)
      expect(r.status).toBe(200)
      expect(r.body.result?.isError ?? !!r.body.error).toBe(true)
      expect(api.toolText(r) || JSON.stringify(r.body)).toMatch(/unauthori[sz]ed/i)
    })
  }
})

test.describe('보관함 (spec credential-vault: 비밀 값을 돌려주지 않는 조회와 응답)', () => {
  test('S-27 로그인·카드 저장 → 어떤 응답에도 비밀번호·카드 번호가 없다', async ({ as, cleanup }) => {
    const u = await as('sec-vault')
    const pw = `RT-pw-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const login = await u.post('/vault', { kind: 'login', site: 'rt-shop.example', data: { username: 'rt-user', password: pw } })
    expect(login.status, login.text).toBe(200)
    cleanup(() => u.del(`/vault/${login.body.id}`))
    const card = await u.post('/vault', { kind: 'card', site: 'rt-shop.example', data: { number: '4242424242424242', exp: '12/39', cvv: '123', holder: 'RT TEST' } })
    expect(card.status, card.text).toBe(200)
    cleanup(() => u.del(`/vault/${card.body.id}`))
    const texts = [login.text, card.text]
    for (const p of ['/vault', '/vault/audit', '/vault/proof']) texts.push((await u.get(p)).text)
    for (const t of texts) {
      expect(t).not.toContain(pw)
      expect(t).not.toContain('4242424242424242')
      expect(t).not.toMatch(/"cvv"\s*:\s*"123"/)
    }
    expect((await u.get('/vault')).text).toContain('4242') // last four only
  })

  test('S-28 잘못된 카드 번호·만료된 카드는 거절', async ({ as }) => {
    const u = await as('sec-vault')
    const bad = await u.post('/vault', { kind: 'card', site: 'rt-shop.example', data: { number: '4242424242424241', exp: '12/39', cvc: '123' } })
    expect(bad.status).toBe(400)
    const old = await u.post('/vault', { kind: 'card', site: 'rt-shop.example', data: { number: '4242424242424242', exp: '01/20', cvc: '123' } })
    expect(old.status).toBe(400)
  })

  test('S-29 남의 보관함 항목은 고치거나 지울 수 없다', async ({ as, cleanup }) => {
    const a = await as('sec-vault'), b = await as('sec-stranger')
    const it = await a.post('/vault', { kind: 'login', site: 'rt-other.example', data: { username: 'a', password: 'pw-a-123456' } })
    cleanup(() => a.del(`/vault/${it.body.id}`))
    const patch = await b.patch(`/vault/${it.body.id}`, { data: { password: 'hijack-123456' } })
    expect(patch.status).toBeGreaterThanOrEqual(400)
    await b.del(`/vault/${it.body.id}`)
    expect((await a.get('/vault')).body.some((x) => x.id === it.body.id)).toBe(true)
  })
})

test.describe('정적 경로', () => {
  for (const app of ['cadcraft', 'vectorcraft', 'photocraft', 'soundcraft', 'filmcraft']) {
    test(`S-30 /craft/${app}/ 가 뜨고 wasm·js 는 gzip 으로 온다`, async ({ request }) => {
      test.skip(!(await api.craftHas(app)), api.craftSkip(app))
      const r = await request.get(`/craft/${app}/`)
      expect(r.status()).toBe(200)
      const html = await r.text()
      const asset = /(?:src|href)="\.?\/?([^"]+\.(?:js|wasm))"/.exec(html)?.[1] || /import\(\s*["']\.\/([^"']+\.js)/.exec(html)?.[1]
      expect(asset, 'index.html references a script').toBeTruthy()
      const a = await request.get(`/craft/${app}/${asset.replace(/^\//, '')}`, { headers: { 'Accept-Encoding': 'gzip' } })
      expect(a.status()).toBe(200)
      const enc = a.headers()['content-encoding'] || ''
      expect(enc === 'gzip' || Number(a.headers()['content-length'] || 0) < 200_000, `content-encoding=${enc}`).toBe(true)
    })
  }
  test('S-31 이음오피스 편집기 경로(/office/<편집기>/) 가 뜬다', async ({ request }) => {
    for (const ed of ['docs', 'sheets', 'slides', 'hwp']) expect((await request.get(`/office/${ed}/`)).status(), ed).toBe(200)
  })
  test('S-32 폴더의 HTML/SVG 원본은 스크립트를 못 돌리게(CSP sandbox) 내려간다', async ({ as, db, cleanup }) => {
    const u = await as('sec-owner')
    const f = await u.post('/folders', { name: uniq('회귀 CSP 폴더') })
    cleanup(() => removeFolder(db, f.body.slug))
    const up = await u.post(`/folders/${f.body.slug}/files?path=x.html`, new TextEncoder().encode('<script>alert(1)</script>'), { headers: { 'Content-Type': 'text/html' } })
    expect(up.status, up.text).toBe(200)
    const r = await u.get(`/folders/${f.body.slug}/raw?path=x.html`)
    expect(r.headers.get('content-security-policy')).toContain('sandbox')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

test.describe('프로세스 인스턴스 열람 범위', () => {
  test('S-33 참여하지 않은 사람은 남의 인스턴스 상세·산출물을 볼 수 없어야 한다', async ({ as, db }) => {
    const stranger = await as('sec-stranger')
    const [inst] = await db.q(`select i.proc_inst_id from bpm_proc_inst i where i.tenant_id=$1 and not coalesce(i.is_deleted,false)
      and not exists (select 1 from todolist t where t.proc_inst_id=i.proc_inst_id and (t.user_id like '%'||$2||'%' or t.user_id like '%'||$3||'%'))
      and not ($2 = any(coalesce(i.participants, '{}'))) order by i.start_date desc nulls last limit 1`, [db.tenant, stranger.id, stranger.email])
    test.skip(!inst, '남의 인스턴스가 없음')
    const list = await stranger.get('/instances')
    const detail = await stranger.get(`/instances/${encodeURIComponent(inst.proc_inst_id)}`)
    expect.soft(list.body.some((i) => i.proc_inst_id === inst.proc_inst_id), 'listed in /api/instances').toBe(false)
    expect(detail.status, 'GET /api/instances/:id').toBeGreaterThanOrEqual(403)
  })
})

test.describe('공개 접속 (spec agent-workroom: 공개 접속)', () => {
  test('S-34 공개 주소(터널 도메인)로 들어온 요청은 접근 암호 없이는 401, 이 PC(localhost)는 통과', async () => {
    test.skip(!/:5180$/.test(new URL((await import('../../lib/env.js')).PGPT_URL).host) && !process.env.RT_PUBLIC_GATE, 'Vite 개발 서버의 공개 게이트 (RT_PUBLIC_GATE=1 로 강제)')
    const http = await import('node:http')
    const { PGPT_URL } = await import('../../lib/env.js')
    const u = new URL(PGPT_URL)
    const get = (host, auth) => new Promise((resolve) => {
      const r = http.request({ host: u.hostname === 'localhost' ? '::1' : u.hostname, port: u.port, path: '/chat', headers: { Host: host, ...(auth ? { Authorization: auth } : {}) } }, (res) => { res.resume(); resolve(res.statusCode) })
      r.on('error', () => resolve(0)); r.end()
    })
    expect(await get('rt-test.trycloudflare.com')).toBe(401)
    expect(await get('rt-test.trycloudflare.com', 'Basic ' + Buffer.from('wrong:pair').toString('base64'))).toBe(401)
    expect(await get(u.host)).toBe(200)
  })
})
