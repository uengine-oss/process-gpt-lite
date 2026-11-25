// 받아쓰기(speech-to-text)가 이 설치에서 실제로 된다 (spec openspec/specs/speech-to-text). No sign-in, read only: GET <lite>/api/config.
// 2026-11-25 사용자: 「지금 서버에 위스퍼모델이 없는 것 같아 위스퍼 모델이 있어야 바다쓰기 이런게 되는데 그것도 반영을 좀 해줘」.
// Whether speech-to-text worked in production could only be learned by speaking in a meeting. litellm-proxy serves
// gpt-4o-mini-transcribe and whisper-1 from its database (not in the GitOps file), and a key answers only the models it is allowed:
// the services' key had gpt-4o-mini-transcribe, not whisper-1. The server now transcribes a bundled 1.3 s clip (「회의를 시작합니다」)
// with the same base, key and models at start and every 10 minutes (server/lib/meetings/transcribe.js selfTest), and /api/config
// carries the outcome: transcribe { ok, model, ms, at, error, fallback }.
//   - D-STT-01  the self-test passed with the configured model (not only the fallback, which every piece waits for)
//   - D-STT-02  the answer names no address and no key (codes only)
//   - D-STT-03  the clip came back fast enough for dictation (a 5 s piece is a few times the clip's work)
//   PGPT_ROOT_URL=https://uengine.process-gpt.io npx playwright test --project=deploy tests/deploy/stt.spec.js
//   (a local server: PGPT_LITE_URL=http://localhost:8787; a Docker install: PGPT_LITE_URL=http://localhost:18080)
import { test, expect } from '@playwright/test'

const LITE = (process.env.PGPT_LITE_URL || `${(process.env.PGPT_ROOT_URL || 'http://localhost:8088').replace(/\/$/, '')}/lite`).replace(/\/$/, '')
// the clip (1.3 s of speech) takes 1–3 s through litellm-proxy to OpenAI; over this the pieces people speak wait long
const FAST_MS = Number(process.env.STT_FAST_MS || 5000)
const TOO_OLD = `this install's server is too old to report transcribe (${LITE}/api/config has no transcribe field) — deploy a server with the `
  + 'speech-to-text self-test (lib/meetings/transcribe.js selfTest) and run again; until then nothing says dictation and meeting captions work'
// what each error code means for the operator (lib/meetings/transcribe.js codeOf · tryModel)
const WHY = {
  'no-key': 'the server has no transcription key (PRO_TRANSCRIBE_API_KEY / OPENAI_API_KEY)',
  timeout: 'the transcription endpoint did not answer within the try limit (PRO_TRANSCRIBE_TIMEOUT_MS, 15 s) — litellm-proxy retrying a failing upstream (num_retries), or the upstream slow',
  unreachable: 'the transcription endpoint (PRO_TRANSCRIBE_BASE_URL) could not be reached',
  'bad-answer': 'the transcription endpoint answered something that is not JSON',
  empty: 'the model answered with no text for a clear spoken clip',
  mismatch: 'the model answered, but not with the clip\'s words (another language, or not a speech model)',
  'http-400': 'litellm-proxy has no model of that name (its config file or its database — Models in the LiteLLM UI)',
  'http-401': 'the key was refused for this model — a LiteLLM virtual key answers only its allowed models (PRO_TRANSCRIBE_API_KEY = litellm-proxy-secret LLM_PROXY_API_KEY: add the model to that key, or name a model it has), or the key itself is not valid',
  'http-404': 'the model is not there upstream',
  'http-429': 'rate limit or budget reached (the key, its team, or the provider)',
}
const why = (code) => WHY[code] || (/^http-5/.test(code || '') ? 'the transcription endpoint failed (litellm-proxy, or the provider behind it — its key or credit)' : code)

let t = null
test.beforeAll(async ({ request }) => {
  // a server that just started runs its first test a few seconds in: wait for it (at most a minute and a half)
  for (let i = 0; i < 30; i++) {
    const r = await request.get(`${LITE}/api/config`)
    expect(r.status(), `${LITE}/api/config`).toBe(200)
    t = (await r.json()).transcribe
    if (!t || t.ok !== null) break
    await new Promise((ok) => setTimeout(ok, 3000))
  }
})

test('D-STT-01 받아쓰기 자가 시험이 설정한 모델로 통과한다', async () => {
  expect(t, TOO_OLD).toBeTruthy()
  expect(t.ok, 'the self-test has not run yet (PRO_TRANSCRIBE_SELFTEST_MIN=0?)').not.toBeNull()
  expect(t.ok, `speech-to-text is not working here: model ${t.model}, error ${t.error} — ${why(t.error)} (tested at ${t.at}). `
    + 'Without it the composer\'s server dictation, meeting captions and minutes get no words.').toBe(true)
  expect(t.fallback, `only the fallback model ${t.model} answered (the first one failed: ${t.error} — ${why(t.error)}): every spoken piece waits `
    + 'for the first model\'s try limit before it is written down. Set PRO_TRANSCRIBE_MODEL to the model that answers.').toBe(false)
})

test('D-STT-02 답에 주소 · 키가 없다', async () => {
  expect(t, TOO_OLD).toBeTruthy()
  expect(Object.keys(t).sort()).toEqual(['at', 'error', 'fallback', 'model', 'ms', 'ok'])
  expect(JSON.stringify(t)).not.toMatch(/https?:|Bearer|sk-|litellm|:\d{2,5}\//)
})

test('D-STT-03 시험 소리(1.3초)가 빨리 받아 적힌다', async () => {
  expect(t?.ok, 'D-STT-01 first').toBe(true)
  expect(t.ms, `the 1.3 s clip took ${t.ms} ms through ${t.model} — a 5 s dictation piece takes a few times that; `
    + 'check that litellm-proxy is not retrying a failing upstream (num_retries) and how fast the provider answers').toBeLessThan(FAST_MS)
})
