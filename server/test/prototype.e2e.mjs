// 시작품 요청 HTTP E2E: 실제 BFF·실제 DB·실제 모델·실제 도구. spec pgpt-pro_prototype-request
//   API_URL=http://localhost:8792 node test/prototype.e2e.mjs   (BFF: PRO_BACKGROUND=0, 데모 로그인 코드 000000, Craft CLI 네 개)
// 연습 메일 하나로 회로 검토·3D·2D·제안서·견적서가 나오는지, 값이 도구가 낸 값과 맞는지 본다.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { q, pool } from '../lib/supa.js'

const API = `${process.env.API_URL || 'http://localhost:8792'}/api`
const CODE = process.env.PGPT_LOGIN_CODE || '000000'
const LIMIT_MS = Number(process.env.PROTO_LIMIT_MS || 25 * 60000)
const JSONH = { 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-'))
let n = 0
async function step(name, fn) {
  n++
  try { await fn(); console.log(`ok ${n} - ${name}`) } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); process.exit(1) }
}
const login = await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: JSONH, body: JSON.stringify({ email: 'pro-rt-proto@uengine.org', code: CODE }) })).json()
const user = login.user.id, H = { Authorization: `Bearer ${login.session.access_token}`, ...JSONH }
const post = (p, b) => fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
await post('/profile', { name: '회귀-시작품', birth: '1990-01-01', onboarded: true })
const [acc] = await q('select provider from pro_mail_accounts where user_id=$1', [user])
if (acc?.provider !== 'demo') { assert.equal((await post('/mail/connect', { provider: 'demo' })).status, 200); await sleep(20000) }
const [th] = await q("select id from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1", [user])
await q('delete from pro_messages where thread_id=$1', [th.id])
await q('update pro_threads set conversation_id=null, status=null where id=$1', [th.id])
await q('delete from pro_demo_mail where user_id=$1', [user])
const rows = () => q('select role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at', [th.id])
const texts = async () => (await rows()).filter((m) => m.kind === 'text').map((m) => m.content.text)
const files = async () => (await rows()).filter((m) => m.kind === 'file').map((m) => m.content)
const fileLike = async (re) => (await files()).filter((f) => re.test(f.name))
const until = async (fn, what, ms = LIMIT_MS) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}. 메시지: ${(await rows()).map((m) => m.content.name || (m.content.text || '').slice(0, 60)).join(' | ')}`); await sleep(3000) } }
const get = async (f) => { const b = Buffer.from(await (await fetch(f.url)).arrayBuffer()); const p = path.join(tmp, f.name.replace(/[^\w.]+/g, '_')); fs.writeFileSync(p, b); return p }

const t0 = Date.now()
await step('연습 메일이 첨부와 함께 오면 시작품 요청으로 알아본다(등록된 다른 프로세스가 가져가지 않는다)', async () => {
  const r = fetch(`${API}/mail/demo-arrive`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'hanbit-sensor-prototype' }) }).then((x) => x.status)
  await until(async () => (await texts()).some((t) => /첨부 3개를 받았어요/.test(t)), '첨부 3개', 240000)
  assert.ok((await texts()).some((t) => /시작품 자료 요청/.test(t)))
  assert.ok(!(await rows()).some((m) => m.kind === 'process'), '프로세스 카드가 없어야 한다')
  assert.equal(await r, 200)
})
await step('회로: 고객 PSpice 파일을 돌려 잰 이득과 대역폭을 말한다(손 계산과 비교)', async () => {
  const said = await until(async () => (await texts()).find((t) => /PSpice 회로를 돌렸어요/.test(t)), '회로 요약', 240000)
  const m = /RF=100k: 이득 ([\d.]+) dB\(([\d.]+)배\), 대역폭 ([\d.]+) kHz/.exec(said)
  assert.ok(m, said)
  assert.ok(Math.abs(Number(m[2]) - 9.9) < 0.2, `이득 ${m[2]}`)
  assert.ok(Number(m[3]) > 90 && Number(m[3]) < 110, `대역폭 ${m[3]} kHz (극점 두 개 159 kHz → 102 kHz, op-amp 한계로 조금 낮다)`)
  assert.match(said, /RF=220k: 이득 26\.\d dB/)
  assert.match(said, /LIMIT/, '근사한 것을 알린다')
  const cir = (await fileLike(/\.cir$/))[0]
  assert.deepEqual(cir.companions.map((c) => c.name), ['HS-200.lib'], '회로 카드에 라이브러리가 붙는다')
  assert.equal((await fileLike(/응답\.png$/)).length, 2)
})
await step('3D: STEP·IGES 를 다른 도구로 재면 메일의 치수다', async () => {
  await until(async () => (await fileLike(/\.igs$/)).length, 'IGES', 240000)
  const py = fileURLToPath(new URL('../../craft/solidcraft/test/.venv/bin/python', import.meta.url))
  const check = fileURLToPath(new URL('../../craft/solidcraft/test/check_geometry.py', import.meta.url))
  if (fs.existsSync(py)) {
    const step = JSON.parse(execFileSync(py, [check, await get((await fileLike(/\.step$/))[0])], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('{')))
    assert.deepEqual(step.bbox.size.map((x) => Math.round(x)), [90, 60, 30])
    assert.ok(step.solids >= 2, `솔리드 ${step.solids}`)
    const iges = JSON.parse(execFileSync(py, [check, await get((await fileLike(/\.igs$/))[0])], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('{')))
    assert.deepEqual(iges.bbox.size.map((x) => Math.round(x)), [90, 60, 30])
  } else console.log('  # 형상 검사 건너뜀: craft/solidcraft/test/.venv 없음')
  const said = (await texts()).find((t) => /외함을 90 × 60 × 30 mm/.test(t))
  assert.match(said, /HS-200_pcb\.step/, '고객 PCB 를 넣었다고 말한다')
  // 몸체 26225 + 뚜껑 10800 mm³ × 2.7 g/cm³ = 100 g
  assert.match(said, /약 100 g/, said)
})
await step('2D: 같은 치수의 DXF 가 온다', async () => {
  const f = (await until(() => fileLike(/\.dxf$/).then((x) => x.length && x), 'DXF', 240000))[0]
  const dxf = fs.readFileSync(await get(f), 'utf8')
  assert.ok(dxf.includes('HS-200'), '표제란'); assert.match(dxf, /DIMENSION/)
  for (const v of ['90 × 60 × 30']) assert.ok(dxf.includes(v) || dxf.includes(v.replace(/×/g, '\\U+00D7')), v)
})
await step('제안서·견적서: 잰 값을 그대로 쓰고, 그림이 들어가고, 단가는 가정이라고 적는다', async () => {
  const docx = (await until(() => fileLike(/\.docx$/).then((x) => x.length && x), 'docx'))[0]
  const xlsx = (await until(() => fileLike(/\.xlsx$/).then((x) => x.length && x), 'xlsx'))[0]
  const d = await get(docx), x = await get(xlsx)
  const unz = (f, inner) => execFileSync('unzip', ['-p', f, inner], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const body = unz(d, 'word/document.xml').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.ok(/95\.2/.test(body) && /19\.9/.test(body), `시뮬레이션 값이 제안서에 없다: ${body.slice(0, 300)}`)
  const pics = execFileSync('unzip', ['-l', d], { encoding: 'utf8' }).split('\n').filter((l) => /word\/media\//.test(l)).length
  assert.ok(pics >= 3, `그림 ${pics}개`)
  const shared = (() => { try { return unz(x, 'xl/sharedStrings.xml') } catch { return '' } })(), sheet = unz(x, 'xl/worksheets/sheet1.xml')
  const all = (shared + sheet).replace(/<[^>]+>/g, ' ')
  assert.match(all, /C1608C0G1H100D080AA/, '메일의 부품 번호')
  assert.ok((sheet.match(/<f[ >]/g) || []).length >= 5, '금액은 수식')
  assert.match(all, /가정/, '단가가 가정값이라고 적는다')
})
console.log(`  # 전체 ${Math.round((Date.now() - t0) / 1000)}초`)
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`1..${n}`)
await pool.end()
process.exit(0)
