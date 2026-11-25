// Speech-to-text self-test and the composer's server dictation (2026-11-25 사용자: 「지금 서버에 위스퍼모델이 없는 것 같아 위스퍼
// 모델이 있어야 바다쓰기 이런게 되는데 그것도 반영을 좀 해줘」): lib/meetings/transcribe.js transcribes the bundled clip through
// PRO_TRANSCRIBE_* and /api/config says what came of it (ok · model · ms · at · error code · fallback — no address, no key);
// routes/dictation.js turns one spoken piece into words with the same models. A fake OpenAI-compatible server; no database.
//   cd server && node --test test/transcribeSelfTest.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import express from 'express'

process.env.PRO_TRANSCRIBE_API_KEY = 'test-key-not-real'
process.env.PRO_TRANSCRIBE_TIMEOUT_MS = '400'
const T = await import('../lib/meetings/transcribe.js')

// an OpenAI-style /v1/audio/transcriptions whose answer each test sets: answer(model, form) → { status, body } | 'hang'
const seen = []
let answer = () => ({ status: 200, body: { text: '회의를 시작합니다.' } })
const fake = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const form = await new Request('http://fake' + req.url, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData()
  const file = form.get('file')
  const call = { path: req.url, auth: req.headers.authorization, model: form.get('model'), language: form.get('language'), fileName: file?.name, file: file ? Buffer.from(await file.arrayBuffer()) : null }
  seen.push(call)
  const a = answer(call.model, call)
  if (a === 'hang') return // never answers (the client's timeout ends it)
  res.writeHead(a.status, { 'Content-Type': 'application/json' })
  res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body))
})
await new Promise((ok) => fake.listen(0, '127.0.0.1', ok))
const BASE = `http://127.0.0.1:${fake.address().port}/v1`
test.after(() => { fake.closeAllConnections?.(); fake.close() })

function env({ model = 'whisper-1', fallback = '', base = BASE } = {}) {
  process.env.PRO_TRANSCRIBE_BASE_URL = base
  process.env.PRO_TRANSCRIBE_MODEL = model
  process.env.PRO_TRANSCRIBE_FALLBACK_MODEL = fallback
  seen.length = 0
}
const KEYS = ['ok', 'model', 'ms', 'at', 'error', 'fallback'].sort()

test('STT-U-01 묶은 시험 소리: 1.3초 · 16kHz 모노 16비트 WAV, 몇십 KB', () => {
  const buf = fs.readFileSync(T.SELFTEST_CLIP)
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buf.readUInt16LE(22), 1, 'mono')
  assert.equal(buf.readUInt32LE(24), 16000)
  assert.equal(buf.readUInt16LE(34), 16)
  const ms = T.wavMs(buf)
  assert.ok(ms > 900 && ms < 1600, `${ms} ms`)
  assert.ok(buf.length < 64 * 1024)
  assert.equal(T.SELFTEST_TEXT, '회의를 시작합니다')
})

test('STT-U-02 모델이 답하면 ok · 모델 · ms · 시각 — 그 요청은 /audio/transcriptions · 키 · 모델 · ko · 그 소리', async () => {
  env()
  answer = () => ({ status: 200, body: { text: '회의를 시작합니다.' } })
  const h = await T.selfTest()
  assert.deepEqual(Object.keys(h).sort(), KEYS)
  assert.equal(h.ok, true)
  assert.equal(h.model, 'whisper-1')
  assert.equal(h.error, null)
  assert.equal(h.fallback, false)
  assert.equal(typeof h.ms, 'number')
  assert.ok(!Number.isNaN(Date.parse(h.at)))
  assert.equal(seen.length, 1)
  const c = seen[0]
  assert.equal(c.path, '/v1/audio/transcriptions')
  assert.equal(c.auth, 'Bearer test-key-not-real')
  assert.deepEqual([c.model, c.language, c.fileName], ['whisper-1', 'ko', 'speech.wav'])
  assert.deepEqual(c.file, fs.readFileSync(T.SELFTEST_CLIP))
  // what /api/config gives out: a copy, and nothing that names the server or the key
  const shown = JSON.stringify(T.transcribeHealth())
  assert.doesNotMatch(shown, /127\.0\.0\.1|http|test-key|Bearer/)
})

test('STT-U-03 띄어쓰기 · 문장 부호가 달라도 ok, 다른 말 · 빈 답은 mismatch · empty', async () => {
  env()
  answer = () => ({ status: 200, body: { text: '회의를 시작 합니다' } })
  assert.equal((await T.selfTest()).ok, true)
  answer = () => ({ status: 200, body: { text: 'Thank you for watching!' } })
  assert.deepEqual([(await T.selfTest()).ok, T.health.error], [false, 'mismatch'])
  answer = () => ({ status: 200, body: { text: '' } })
  assert.deepEqual([(await T.selfTest()).ok, T.health.error], [false, 'empty'])
  answer = () => ({ status: 200, body: 'not json' })
  assert.deepEqual([(await T.selfTest()).ok, T.health.error], [false, 'bad-answer'])
  assert.equal(T.charErrorRate('회의를 시작합니다', '회의를 시작합니다.'), 0)
  assert.ok(T.charErrorRate('회의를 시작합니다', '회의 시작') <= 0.5)
})

test('STT-U-04 모델이 없으면(운영 11-25: LiteLLM 에 받아쓰기 모델 없음) http-<상태>, 답이 없으면 timeout, 닿지 않으면 unreachable', async () => {
  env({ model: 'gpt-4o-mini-transcribe' })
  answer = () => ({ status: 400, body: { error: { message: 'Invalid model name passed in model=gpt-4o-mini-transcribe' } } })
  const h = await T.selfTest()
  assert.deepEqual([h.ok, h.model, h.error, h.fallback], [false, 'gpt-4o-mini-transcribe', 'http-400', false])
  assert.doesNotMatch(JSON.stringify(T.transcribeHealth()), /Invalid model/)
  env()
  answer = () => 'hang'
  assert.deepEqual([(await T.selfTest()).ok, T.health.error], [false, 'timeout'])
  env({ base: 'http://127.0.0.1:9/v1' })
  assert.deepEqual([(await T.selfTest()).ok, T.health.error], [false, 'unreachable'])
})

test('STT-U-05 첫 모델이 안 되고 둘째가 되면 ok + fallback, 첫 모델의 까닭은 남는다 · 둘 다 안 되면 첫 모델 기준', async () => {
  env({ model: 'gpt-4o-mini-transcribe', fallback: 'whisper-1' })
  answer = (model) => (model === 'whisper-1' ? { status: 200, body: { text: '회의를 시작합니다' } } : { status: 404, body: {} })
  const h = await T.selfTest()
  assert.deepEqual([h.ok, h.model, h.error, h.fallback], [true, 'whisper-1', 'http-404', true])
  assert.deepEqual(seen.map((c) => c.model), ['gpt-4o-mini-transcribe', 'whisper-1'])
  env({ model: 'gpt-4o-mini-transcribe', fallback: 'whisper-1' })
  answer = () => ({ status: 503, body: {} })
  const h2 = await T.selfTest()
  assert.deepEqual([h2.ok, h2.model, h2.error, h2.fallback], [false, 'gpt-4o-mini-transcribe', 'http-503', false])
})

test('STT-U-06 같이 불러도 시험은 한 번', async () => {
  env()
  answer = () => ({ status: 200, body: { text: '회의를 시작합니다' } })
  const [a, b] = await Promise.all([T.selfTest(), T.selfTest()])
  assert.equal(a, b)
  assert.equal(seen.length, 1)
})

test('STT-U-07 시작할 때 한 번(repeat false) · PRO_TRANSCRIBE_SELFTEST_MIN=0 이면 하지 않는다', async () => {
  env()
  answer = () => ({ status: 200, body: { text: '회의를 시작합니다' } })
  process.env.PRO_TRANSCRIBE_SELFTEST_MIN = '0'
  T.startSelfTest({ firstMs: 10, repeat: false })
  await new Promise((ok) => setTimeout(ok, 120))
  assert.equal(seen.length, 0)
  process.env.PRO_TRANSCRIBE_SELFTEST_MIN = '10'
  T.health.ok = null
  T.startSelfTest({ firstMs: 10, repeat: false })
  for (let i = 0; i < 50 && T.health.ok === null; i++) await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(T.health.ok, true)
  assert.equal(seen.length, 1)
  T.stopSelfTest()
})

test('STT-U-08 회의 조각도 같은 길: 모델이 없으면 까닭은 사람의 말로(서버 주소 · 원문 없음), 상태 503', async () => {
  env({ model: 'gpt-4o-mini-transcribe' })
  answer = () => ({ status: 400, body: { error: { message: 'Invalid model name … api_base=http://litellm-proxy:4000' } } })
  await assert.rejects(T.transcribe(fs.readFileSync(T.SELFTEST_CLIP), { language: 'ko' }), (e) => e.status === 503 && /응답하지 않아요|not answering/.test(e.message) && !/litellm|http/.test(e.message))
  assert.match(T.lastError.message, /400/)
})

test('STT-U-11 운영 11-25: 키에 whisper-1 이 없으면 대체 모델은 401 — 첫 모델이 되면 ok, 둘 다 안 되면 회의 통계에 첫 모델의 까닭도 남는다', async () => {
  const refused = (model) => ({ status: 401, body: { error: { message: `key not allowed to access model. This key can only access models=['frentis-ai-model', 'gpt-4o-mini-transcribe']. Tried to access ${model}`, type: 'key_model_access_denied', code: '401' } } })
  // the services' key: gpt-4o-mini-transcribe allowed, whisper-1 not — the code's defaults
  env({ model: 'gpt-4o-mini-transcribe', fallback: 'whisper-1' })
  answer = (model) => (model === 'whisper-1' ? refused(model) : { status: 200, body: { text: '회의를 시작합니다.' } })
  const h = await T.selfTest()
  assert.deepEqual([h.ok, h.model, h.error, h.fallback], [true, 'gpt-4o-mini-transcribe', null, false])
  assert.deepEqual(seen.map((c) => c.model), ['gpt-4o-mini-transcribe'], 'the second model is not asked when the first answers')
  const clip = fs.readFileSync(T.SELFTEST_CLIP)
  assert.equal((await T.transcribe(clip, { language: 'ko' })).text, '회의를 시작합니다.')
  // the first model failing (here: OpenAI's own 500 behind the proxy) and the key refusing the second
  answer = (model) => (model === 'whisper-1' ? refused(model) : { status: 500, body: { error: { message: 'upstream error' } } })
  const h2 = await T.selfTest()
  assert.deepEqual([h2.ok, h2.model, h2.error, h2.fallback], [false, 'gpt-4o-mini-transcribe', 'http-500', false])
  await assert.rejects(T.transcribe(clip, { language: 'ko' }), (e) => e.status === 503)
  assert.equal(T.lastError.model, 'whisper-1')
  assert.match(T.lastError.message, /401/)
  assert.equal(T.lastError.first.model, 'gpt-4o-mini-transcribe')
  assert.match(T.lastError.first.message, /500/)
  // a key without the first model either: http-401 is what /api/config says
  answer = (model) => refused(model)
  assert.deepEqual([(await T.selfTest()).ok, T.health.error], [false, 'http-401'])
})

// routes/dictation.js behind a stand-in sign-in (req.user), the person's main language remembered (no database)
async function dictationApp() {
  const { dictationRoutes, MAX_IN_FLIGHT } = await import('../routes/dictation.js')
  const { rememberMain } = await import('../lib/mainLang.js')
  rememberMain('u-dict', 'ko')
  const app = express()
  const auth = (req, res, next) => (req.headers.authorization === 'Bearer ok' ? ((req.user = { id: 'u-dict' }), next()) : res.status(401).json({ error: 'unauthorized' }))
  app.use('/api', dictationRoutes(auth))
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  const url = `http://127.0.0.1:${srv.address().port}/api/dictation`
  const post = (body, auth = 'Bearer ok') => fetch(url, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Authorization: auth }, body })
  return { srv, post, MAX_IN_FLIGHT }
}

test('STT-U-09 POST /api/dictation: 로그인한 사람의 말 한 조각 → 글(주 언어로), 짧은 소리 400 · 로그인 없이 401 · 서버가 없으면 503 과 까닭', async () => {
  const { srv, post } = await dictationApp()
  try {
    env()
    answer = () => ({ status: 200, body: { text: '회의를 시작합니다.' } })
    const clip = fs.readFileSync(T.SELFTEST_CLIP)
    const r = await post(clip)
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.equal(j.text, '회의를 시작합니다.')
    assert.equal(typeof j.ms, 'number')
    assert.deepEqual([seen[0].model, seen[0].language], ['whisper-1', 'ko'])
    assert.equal((await post(Buffer.alloc(100))).status, 400)
    assert.equal((await post(clip, 'Bearer nope')).status, 401)
    // what Whisper makes up from silence is not written into the box
    answer = () => ({ status: 200, body: { text: '시청해 주셔서 감사합니다.' } })
    assert.equal((await (await post(clip)).json()).text, '')
    answer = () => ({ status: 404, body: { detail: "Model 'x' is not installed locally" } })
    const bad = await post(clip)
    assert.equal(bad.status, 503)
    const e = await bad.json()
    assert.match(e.error, /응답하지 않아요|not answering/)
    assert.doesNotMatch(e.error, /installed|127\.0\.0\.1/)
  } finally { srv.close() }
})

test('STT-U-10 한 사람이 동시에 보낼 수 있는 조각은 MAX_IN_FLIGHT 개, 넘치면 429', async () => {
  const { srv, post, MAX_IN_FLIGHT } = await dictationApp()
  try {
    env()
    process.env.PRO_TRANSCRIBE_TIMEOUT_MS = '1500'
    // (the server holds every piece until the client gives up: 1.5 s → 503)
    answer = () => 'hang'
    const clip = fs.readFileSync(T.SELFTEST_CLIP)
    const held = Array.from({ length: MAX_IN_FLIGHT }, () => post(clip))
    await new Promise((ok) => setTimeout(ok, 150))
    const over = await post(clip)
    assert.equal(over.status, 429)
    const done = await Promise.all(held)
    assert.deepEqual(done.map((r) => r.status), Array(MAX_IN_FLIGHT).fill(503))
  } finally { process.env.PRO_TRANSCRIBE_TIMEOUT_MS = '400'; srv.close() }
})
