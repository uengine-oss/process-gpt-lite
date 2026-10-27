// A-14 대화방 원격 회의 여정 — 실제 브라우저 둘(가짜 카메라·마이크)이 방에서 회의를 열고, 각자의 말이
// 화자별 자막이 되고, 도우미가 말에 맞는 자료(방에 공유된 견적서)를 두 사람 모두에게 띄우고, 한 사람이
// "모두에게 띄우기" 하면 두 무대가 같이 바뀌고, 부탁("…다시 만들어 주세요")이 시작/아니요 제안이 되어
// 시작한 사람의 에이전트가 결과를 내고, 회의를 끝내면 대화방에 회의록이 남는다.
// 말소리는 시험 때 OpenAI TTS 로 만들어 Chromium 가짜 마이크(--use-file-for-fake-audio-capture)에 넣는다.
// (server/lib/meetings/*, src/components/meetings/* · 설계 process-gpt/openspec/changes/pgpt-pro-meetings)
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { test, expect, api } from '../../lib/fixtures.js'
import { XLSX, MIME } from '../../lib/seed.js'
import { PGPT_URL, PGPT_ROOT } from '../../lib/env.js'

const member = async (c) => { await c.get('/team'); return c }
const RATE = 24000
function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  try { return /^OPENAI_API_KEY=(.*)$/m.exec(fs.readFileSync(path.join(PGPT_ROOT, '.env'), 'utf8'))?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '' } catch { return '' }
}
async function speech(text, voice) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${openaiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm' }),
  })
  if (!r.ok) throw new Error(`tts ${r.status}`)
  return new Int16Array(await r.arrayBuffer().then((b) => b.slice(0, b.byteLength - (b.byteLength % 2))))
}
// one person's microphone: their lines at their times on a shared timeline, silence elsewhere
function timelineWav(file, parts, total) {
  const pcm = new Int16Array(Math.ceil(total * RATE))
  for (const { at, samples } of parts) pcm.set(samples.subarray(0, Math.max(0, pcm.length - Math.floor(at * RATE))), Math.floor(at * RATE))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length * 2, 40)
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(pcm.buffer)]))
}

test.describe('대화방 원격 회의 여정 (spec pgpt-pro-meetings)', () => {
  test('A-14 가짜 마이크 두 브라우저: 연결 → 화자별 자막 → 자료가 저절로 → 모두에게 띄우기 동기화 → 부탁 시작 → 결과 → 회의록', async ({ as, db, cleanup }, info) => {
    test.skip(!openaiKey(), 'OpenAI 키가 없어 시험용 말소리를 만들 수 없음')
    test.setTimeout(25 * 60_000)
    const a = await member(await as('mt-a14-owner')), b = await member(await as('mt-a14-mate'))
    const nameOf = async (c) => (await db.q('select name from pro_profile where user_id=$1', [c.id]))[0].name
    const [na, nb] = [await nameOf(a), await nameOf(b)]
    const g = (await a.post('/team/threads', { members: [b.id], title: '회귀 회의 여정' })).body
    cleanup(() => db.q('delete from chat_rooms where id=$1', [g.id]))
    const th = await db.mainThreadId(a.id)
    const up = await api.upload(a.token(), '회귀상사_견적서.xlsx', MIME.xlsx, await XLSX([['항목', '수량', '단가'], ['설계', 1, 500000], ['시공', 1, 3200000], ['가구', 10, 120000]]))
    const [card] = await db.addMessages(th, [{ role: 'agent', kind: 'file', content: { name: '회귀상사_견적서.xlsx', url: up.url } }])
    expect((await a.post(`/team/threads/${g.id}/messages`, { text: '회의 때 볼 견적서예요', artifactIds: [card.id] })).status).toBe(200)

    // the two microphones (lines after a lead that leaves time to join)
    const dir = info.outputPath('mics'); fs.mkdirSync(dir, { recursive: true })
    const s1 = await speech('지난번 회귀상사 견적서 다시 볼까요?', 'nova')
    const s2 = await speech('그 견적서 금액을 5퍼센트 낮춰서 다시 만들어 주세요.', 'onyx')
    timelineWav(path.join(dir, 'b.wav'), [{ at: 14, samples: s1 }], 40)
    timelineWav(path.join(dir, 'a.wav'), [{ at: 28, samples: s2 }], 40)
    const open = async (c, mic) => {
      const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}%noloop`, '--autoplay-policy=no-user-gesture-required'] })
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ko-KR', permissions: ['camera', 'microphone'], baseURL: PGPT_URL })
      await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(c.s))
      const page = await ctx.newPage()
      cleanup(() => browser.close())
      await page.goto('/chat')
      await page.locator('button.msg-btn').click()
      await page.locator('.tabs button', { hasText: '대화' }).click()
      await page.locator('button.th', { hasText: '회귀 회의 여정' }).first().click()
      return page
    }
    const [pa, pb] = await Promise.all([open(a, path.join(dir, 'a.wav')), open(b, path.join(dir, 'b.wav'))])
    // both open the lobby together (their microphones start here), agree to transcription, join
    await Promise.all([pa, pb].map((p) => p.locator('[data-test=meeting-start]').click()))
    for (const p of [pa, pb]) await p.locator('[data-test=consent]').check()
    await pa.locator('[data-test=join]').click()
    await pa.locator('[data-test=meeting-view]').waitFor()
    await pb.locator('[data-test=join]').click()
    await pb.locator('[data-test=meeting-view]').waitFor()
    // media: each sees the other's video
    for (const p of [pa, pb]) await expect.poll(() => p.evaluate(() => [...document.querySelectorAll('[data-test=meeting-view] .tile:not(.me) video')].filter((v) => v.readyState >= 2).length), { timeout: 30000 }).toBeGreaterThanOrEqual(1)
    await expect(pa.locator('[data-test=agent-tile]')).toContainText('프로세스 GPT 라이트 도우미')
    // speech → a line with the speaker's name, on both pages
    await expect(pa.locator('[data-test=lines] .ln', { hasText: '견적서' }).first()).toContainText(nb, { timeout: 40000 })
    // the material comes by itself, for both
    for (const p of [pa, pb]) { await p.locator('[data-test=tab-materials]').click(); await expect(p.locator('[data-test=material]', { hasText: '회귀상사_견적서' })).toBeVisible({ timeout: 20000 }) }
    // presenting syncs both stages
    await pa.locator('[data-test=material]', { hasText: '회귀상사_견적서' }).locator('[data-test=present]').click()
    await expect(pb.locator('[data-test=stage]')).toContainText(`${na}님이 모두에게 띄웠어요`, { timeout: 15000 })
    // the request → a suggestion; the owner starts it with his own agent
    await expect(pa.locator('[data-test=meeting-suggestion]')).toBeVisible({ timeout: 40000 })
    await expect(pb.locator('[data-test=meeting-suggestion]')).toBeVisible()
    await pa.locator('[data-test=suggestion-start]').click()
    await expect(pa.locator('[data-test=material][data-kind=result]')).toBeVisible({ timeout: 15 * 60_000 })
    await expect(pb.locator('[data-test=material][data-kind=result]')).toBeVisible({ timeout: 10000 })
    // end → the room's record: card, 회의록 block, material, minutes
    await pa.locator('[data-test=end]').click()
    await expect(pa.locator('[data-test=meeting-minutes]')).toBeVisible({ timeout: 120000 })
    for (const k of ['meeting', 'meeting-transcript', 'meeting-material']) await expect(pb.locator(`[data-test=${k}]`).first()).toBeVisible()
    const rows = await db.q(`select messages->'pgpt'->>'kind' as k, count(*)::int n from chats where id=$1 and messages->'pgpt'->>'kind' like 'meeting%' group by 1`, [g.id])
    const n = Object.fromEntries(rows.map((r) => [r.k, r.n]))
    expect(n).toMatchObject({ meeting: 1, 'meeting-transcript': 1, 'meeting-minutes': 1 })
    expect((await a.get('/meetings/stats')).body.detection.bigModelCalls).toBe(0)
  })
})
