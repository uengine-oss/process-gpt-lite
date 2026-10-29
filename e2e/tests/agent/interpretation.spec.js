// A-15 다국어 회의 여정 — 실제 브라우저 둘(가짜 카메라·마이크: 한국어 한지수, 영어 Emily Carter)과 일본어 화자
// 佐藤ゆき(브라우저 없이 자기 말 조각을 직접 올리고 음성 통로를 여는 참여자 — 무거운 기계에서 브라우저 셋은 버거움)가
// 각자 자기 말로 말한다. 듣는 사람마다 다른 화자의 말이 자기 주 언어의 자막(원문 + 번역)으로 뜨고, 통역 음성
// 조각이 음성 통로로 오고(자기 말의 통역은 오지 않음), 통역이 나오는 동안 그 화자의 원래 소리는 낮아졌다(끊기지 않고)
// 돌아온다. 회의를 끝내면 방에 회의록 블록(줄마다 언어·번역)과 각자 언어로 읽히는 회의록이 남고, 회의 뒤 한국어
// 메시지는 영어 독자에게 영어로 읽힌다. 말소리는 시험 때 OpenAI TTS 로 만들어 Chromium 가짜 마이크에 넣는다.
// INTERP_SHOTS=<dir>: 화면 넷을 그 폴더에 남긴다 (docs/demo/interpretation/).
// (server/lib/meetings/{interpret,voice,pairing}.js, src/components/meetings/{interp,duck}.js
//  · 설계 process-gpt/openspec/changes/pgpt-pro-meeting-interpretation)
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { chromium } from '@playwright/test'
import { test, expect } from '../../lib/fixtures.js'
import { person, openaiKey, speech, timelineWav, secs, HANGUL, KANA } from '../../lib/intl.js'
import { PGPT_URL, API_URL } from '../../lib/env.js'
import { call } from '../../lib/api.js'

const SHOTS = process.env.INTERP_SHOTS || ''
const LEAD = Number(process.env.INTERP_LEAD || 30)
// a 16 kHz mono WAV of a spoken line (what capture.js uploads)
function wav16k(pcm24) {
  const n = Math.floor(pcm24.length / 1.5)
  const out = Buffer.alloc(44 + n * 2)
  for (let i = 0; i < n; i++) out.writeInt16LE(pcm24[Math.min(pcm24.length - 1, Math.floor(i * 1.5))], 44 + i * 2)
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8); out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40)
  return new Uint8Array(out)
}

test.describe('다국어 회의 여정 (spec pgpt-pro-meeting-interpretation)', () => {
  test('A-15 한·영·일 가짜 마이크 셋: 각자 언어의 자막·통역 음성(자기 말 제외)·덕킹 → 언어별 회의록 → 메신저 번역', async ({ db, cleanup }, info) => {
    test.skip(!openaiKey(), 'OpenAI 키가 없어 시험용 말소리를 만들 수 없음')
    test.setTimeout(15 * 60_000)
    const ko = await person('ko'), en = await person('en'), ja = await person('ja')
    const g = (await ko.post('/team/threads', { members: [en.id, ja.id], title: 'Global Moonlight team' })).body
    cleanup(() => db.q('delete from chat_rooms where id=$1', [g.id]))

    // the three microphones on one timeline (silence while the others speak and the interpreter answers)
    const dir = info.outputPath('mics'); fs.mkdirSync(dir, { recursive: true })
    const say = [
      [ko, '자, 달빛커피 성수점 제안 건 시작해 볼게요. 견적서 금액은 5퍼센트 낮추기로 했어요.'],
      [en, 'Thanks. I reviewed the floor plan yesterday, and the bar counter should move closer to the window.'],
      [ja, '見積書の金額はまだ少し高いと思います。もう一度確認してもらえますか。'],
      [ko, '네, 금요일까지 수정 견적서를 다시 보내 드릴게요.'],
    ]
    const parts = { ko: [], en: [], ja: [] }
    let at = LEAD
    const timeline = []
    for (const [who, text] of say) {
      const s = await speech(text, who.voice, dir)
      parts[who.key].push({ at, samples: s })
      timeline.push({ who: who.key, at, dur: +secs(s).toFixed(2), text })
      // the next speaker waits for the interpretation to finish (talking over it is double-talk the echo
      // canceller turns down, and on a loaded machine the pieces come slowly)
      at += secs(s) * 2.3 + 5
    }
    const total = at + 4
    for (const k of Object.keys(parts)) timelineWav(path.join(dir, `${k}.wav`), parts[k], total)
    await info.attach('timeline.json', { body: JSON.stringify(timeline, null, 1), contentType: 'application/json' })

    const open = async (c) => {
      const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(dir, `${c.key}.wav`)}%noloop`, '--autoplay-policy=no-user-gesture-required'] })
      cleanup(() => browser.close())
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: c.locale, permissions: ['camera', 'microphone'], baseURL: PGPT_URL })
      await ctx.addInitScript(([s, l]) => { if (window.top === window) { localStorage.setItem('pgpt-pro-session', s); localStorage.setItem('pgl-lang', l) } }, [JSON.stringify(c.s), c.ui])
      const page = await ctx.newPage()
      page.errors = []
      page.on('pageerror', (e) => page.errors.push(e.message))
      if (process.env.RT_DEBUG) {
        page.on('console', (m) => console.log(c.key, m.type(), m.text().slice(0, 160)))
        page.on('response', async (r) => { if (r.url().includes('/api/') && r.status() >= 400) console.log(c.key, r.status(), r.request().method(), r.url().replace(/^.*\/api/, ''), (await r.text().catch(() => '')).slice(0, 120)) })
        page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log(c.key, 'navigated', f.url()) })
      }
      await page.goto('/chat')
      await page.locator('button.msg-btn').click()
      await page.locator('.tabs button', { hasText: /Conversation|대화/ }).click()
      await page.locator('button.th', { hasText: 'Global Moonlight team' }).first().click()
      return page
    }
    const [pk, pe] = await Promise.all([open(ko), open(en)])
    const pages = { ko: pk, en: pe }
    // the lobbies open together (the microphones start there): the main language is there, consent, join
    const t0 = Date.now()
    const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
    for (const [k, p] of Object.entries(pages)) {
      p.on('request', (r) => { if (r.url().includes('/audio')) console.log(`[A-15] ${since()} ${k} piece up`) })
      p.on('response', async (r) => { if (r.url().includes('/audio')) console.log(`[A-15] ${since()} ${k} piece ${r.status()} ${(await r.text().catch(() => '')).slice(0, 90)}`) })
    }
    await Promise.all([pk, pe].map((p) => p.locator('[data-test=meeting-start]').click()))
    await expect(pk.locator('[data-test=lobby-lang]')).toHaveValue('ko')
    await expect(pe.locator('[data-test=lobby-lang]')).toHaveValue('en')
    for (const p of [pk, pe]) await p.locator('[data-test=consent]').check()
    for (const p of [pk, pe]) { await p.locator('[data-test=join]').click(); await p.locator('[data-test=meeting-view]').waitFor({ timeout: 90000 }) }
    // 佐藤ゆき joins from her own client: consent, her voice channel, her pieces at her times
    const mid = (await ko.get(`/meetings/room/${g.id}`)).body.meeting.id
    expect((await ja.post(`/meetings/${mid}/join`, { consent: true })).status).toBe(200)
    const jaVoice = { bySpeaker: {}, first: [], notes: [] }
    const ticket = (await ja.post(`/meetings/${mid}/voice/ticket`)).body.ticket
    const jws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/api/meetings/voice?ticket=${ticket}`, { headers: { Origin: new URL(PGPT_URL).origin } })
    jws.on('message', (d, bin) => {
      if (bin) { const n = d[0]; const h = JSON.parse(d.subarray(1, 1 + n).toString()); jaVoice.bySpeaker[h.s] = (jaVoice.bySpeaker[h.s] || 0) + 1 } else { const m = JSON.parse(d.toString()); jaVoice.notes.push(m.type); if (m.type === 'start') jaVoice.first.push(m.firstMs) }
    })
    cleanup(() => jws.close())
    const jaBeat = setInterval(() => ja.post(`/meetings/${mid}/heartbeat`).catch(() => {}), 10000)
    cleanup(() => clearInterval(jaBeat))
    for (const t of timeline.filter((x) => x.who === 'ja')) {
      const due = t0 + 1500 + (t.at + t.dur + 0.8) * 1000
      setTimeout(async () => {
        await ja.post(`/meetings/${mid}/speaking`).catch(() => {})
        const r = await call(ja.token(), 'POST', `/meetings/${mid}/audio`, wav16k(parts.ja.find((x) => x.at === t.at).samples), { headers: { 'Content-Type': 'audio/wav' } })
        console.log(`[A-15] ${since()} ja piece ${r.status} ${String(r.text).slice(0, 90)}`)
      }, Math.max(0, due - Date.now()))
    }
    console.log(`[A-15] ${since()} all three in the meeting (the first line is at ${LEAD}s of the microphones)`)
    // media up, and the meeting says it is interpreted (three languages)
    // (the mesh between three loaded browsers can be slow; interpretation does not ride on it — the voice
    // comes over the server's channel — so a missing video is logged, not failed)
    const videos = async (p) => p.evaluate(() => [...document.querySelectorAll('[data-test=meeting-view] .tile:not(.me) video')].filter((v) => v.readyState >= 2).length)
    await expect.poll(async () => Math.min(...(await Promise.all([pk, pe].map(videos)))), { timeout: 40000 }).toBeGreaterThanOrEqual(1).catch(async () => console.warn('[A-15] mesh video', await Promise.all([pk, pe].map(videos))))
    for (const p of [pk, pe]) await expect(p.locator('[data-test=ai-interp]')).toBeVisible({ timeout: 15000 })
    await expect(pe.locator('[data-test=ai-interp]')).toContainText('AI interpretation')
    await expect(pk.locator('[data-test=ai-interp]')).toContainText('AI 통역')

    // the AI 통역 badge on 한지수's tile on the English page while the interpreter speaks for her
    await expect(pe.locator('[data-test=ai-interp-badge]')).toBeVisible({ timeout: (LEAD + 40) * 1000 })

    // subtitles: each listener reads the others in their own language, the original under it
    const trLine = (p, lang) => p.locator(`[data-test=line][data-lang=${lang}] [data-test=line-tr]`).first()
    await expect(trLine(pe, 'ko')).toBeVisible({ timeout: 30000 })
    expect(await trLine(pe, 'ko').textContent()).not.toMatch(HANGUL)
    await expect(pe.locator('[data-test=line][data-lang=ko] [data-test=line-orig]').first()).toContainText(/[가-힣]/)
    await expect(trLine(pk, 'en')).toContainText(HANGUL, { timeout: 60000 })
    await expect(trLine(pk, 'ja')).toContainText(HANGUL, { timeout: 60000 })
    await expect(trLine(pe, 'ja')).toBeVisible({ timeout: 30000 })
    // the English listener's screen while the interpreter speaks (badge on the speaker, bilingual subtitles)
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true })
      await expect(pe.locator('[data-test=ai-interp-badge]')).toBeVisible({ timeout: 60000 }).catch(() => {})
      await pe.screenshot({ path: path.join(SHOTS, '01-meeting-en-listener.png') })
    }
    expect(await trLine(pe, 'ja').textContent()).not.toMatch(/[가-힣぀-ヿ]/)
    // no translation into the speaker's own language: the Korean page shows 한지수's lines as they are
    await expect(pk.locator('[data-test=line][data-lang=ko] [data-test=line-tr]')).toHaveCount(0)
    if (SHOTS) await pk.screenshot({ path: path.join(SHOTS, '02-meeting-ko-listener.png') })

    // the Japanese reader's subtitles (her client reads the meeting's lines): Korean and English in Japanese
    await expect.poll(async () => {
      const ls = (await ja.get(`/meetings/${mid}`)).body.lines || []
      return ls.filter((l) => l.lang !== 'ja').length > 0 && ls.filter((l) => l.lang !== 'ja').every((l) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(l.tr?.ja || ''))
    }, { timeout: 30000 }).toBe(true)
    // wait for the last line's interpretation, then read the voice counters on each page
    await expect.poll(async () => pe.locator('[data-test=line][data-lang=ko]').count(), { timeout: 90000 }).toBeGreaterThanOrEqual(2)
    await pe.waitForTimeout(6000)
    const voice = { ja: jaVoice }
    for (const [k, p] of Object.entries(pages)) voice[k] = await p.evaluate(() => { const v = window.__pglVoice; return v ? { ...v.stats, connected: v.connected } : null })
    await info.attach('voice.json', { body: JSON.stringify(voice, null, 1), contentType: 'application/json' })
    fs.writeFileSync(info.outputPath('voice.json'), JSON.stringify({ voice, server: (await ko.get('/meetings/stats')).body.interpretation }, null, 1))
    // translated audio chunks reached each listener, from the others only
    expect(voice.en.bySpeaker[ko.id]).toBeGreaterThan(3)
    expect(voice.en.bySpeaker[ja.id]).toBeGreaterThan(1)
    expect(voice.ko.bySpeaker[en.id]).toBeGreaterThan(1)
    expect(voice.ja.bySpeaker[ko.id]).toBeGreaterThan(1)
    for (const [k, c] of [['ko', ko], ['en', en], ['ja', ja]]) expect(voice[k].bySpeaker[c.id] || 0, `${k} never hears their own interpretation`).toBe(0)
    // ducking: 한지수's own voice went down on the English page while her interpretation played — not to zero
    expect(voice.en.minVolume[ko.id]).toBeLessThan(0.5)
    expect(voice.en.minVolume[ko.id]).toBeGreaterThan(0)
    // and back up once her interpretation is over
    await expect.poll(() => pe.evaluate((id) => window.__pglVoice?.vol?.[id], ko.id), { timeout: 30000 }).toBe(1)
    const first = [...voice.en.first, ...voice.ko.first, ...voice.ja.first]
    console.log(`[A-15] interpretation: first sound ${first.join(', ')} ms after the piece reached the server (+ ~0.8 s of silence that ends a piece)`)

    // hear the original instead: Emily switches; the server records it (no more voice is planned for her)
    const [put] = await Promise.all([pe.waitForResponse((r) => r.url().includes(`/meetings/${mid}/listen`), { timeout: 30000 }), pe.locator('[data-test=listen-toggle]').click()])
    expect(put.status()).toBe(200)
    await expect(pe.locator('[data-test=listen-toggle]')).toContainText(/original/i)
    await expect.poll(async () => (await db.q('select listen from pro_meeting_participants where meeting_id=$1 and user_id=$2', [mid, en.id]))[0]?.listen, { timeout: 20000 }).toBe('original')
    await Promise.all([pe.waitForResponse((r) => r.url().includes(`/meetings/${mid}/listen`), { timeout: 30000 }), pe.locator('[data-test=listen-toggle]').click()])

    // end → the room's record in each reader's language
    await pk.locator('[data-test=end]').click()
    let minutes
    await expect.poll(async () => { [minutes] = await db.q(`select uuid, messages from chats where id=$1 and messages->'pgpt'->>'kind'='meeting-minutes'`, [g.id]); return !!minutes }, { timeout: 240000 }).toBe(true) // (the summary model has 180 s, then rules)
    const mm = minutes.messages.pgpt.meeting
    expect(Object.keys(mm.tr || {}).sort()).toEqual(['en', 'ja'])
    const [block] = await db.q(`select messages from chats where id=$1 and messages->'pgpt'->>'kind'='meeting-transcript' order by public.pro_chat_ts(messages) limit 1`, [g.id])
    const langs = block.messages.pgpt.meeting.lines.map((l) => l.lang)
    expect(new Set(langs)).toEqual(new Set(['ko', 'en', 'ja']))
    expect(block.messages.pgpt.meeting.lines.every((l) => Object.keys(l.tr || {}).length === 2)).toBe(true)
    // the English reader: minutes and record lines in English, the original a click away
    // (the room opened again: on a development server without the room feed the cards come with the load)
    for (const p of [pk, pe]) {
      await p.locator('[data-test=meeting-view]').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
      await p.locator('button.th', { hasText: 'Global Moonlight team' }).first().click()
    }
    await expect(pe.locator('[data-test=meeting-minutes] [data-test=minutes-summary]')).toBeVisible({ timeout: 30000 })
    await expect.poll(async () => HANGUL.test(await pe.locator('[data-test=minutes-summary]').textContent()), { timeout: 30000 }).toBe(false)
    await expect(pk.locator('[data-test=minutes-summary]')).toContainText(HANGUL, { timeout: 30000 })
    expect(mm.tr.ja.summary).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/)
    await expect(pe.locator('[data-test=meeting-transcript] [data-test=record-tr]').first()).toBeVisible()
    await pe.locator('[data-test=meeting-minutes]').scrollIntoViewIfNeeded()
    if (SHOTS) await pe.screenshot({ path: path.join(SHOTS, '03-room-minutes-en-reader.png') })
    await pe.locator('[data-test=minutes-original]').click()
    await expect(pe.locator('[data-test=minutes-summary]')).toContainText(HANGUL)
    await pe.locator('[data-test=minutes-original]').click()

    // after the meeting: a Korean message reads in English for Emily, the original one click away
    await ko.post(`/team/threads/${g.id}/messages`, { text: '회의록 확인했어요. 수정 견적서는 금요일 오전에 보낼게요.' })
    const b = pe.locator('.msg', { has: pe.locator('[data-test=msg-tr]') }).last()
    await expect(b.locator('[data-test=msg-text]')).toContainText(/Friday/i, { timeout: 30000 })
    await b.scrollIntoViewIfNeeded()
    if (SHOTS) await pe.screenshot({ path: path.join(SHOTS, '04-messenger-en-reader.png') })
    await b.locator('[data-test=show-original]').click()
    await expect(b.locator('[data-test=msg-text]')).toContainText('금요일')
    for (const [k, p] of Object.entries(pages)) expect(p.errors, `${k} page errors`).toEqual([])
  })
})
