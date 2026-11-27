// The chat composer's voice dictation where the browser has no speech service of its own — the desktop app (its Chromium
// has none), the Android app's WebView, Firefox — (src/serverDictation.js): one spoken piece (WAV from the person's own microphone, cut by
// src/components/meetings/capture.js) in, its words out, through the same transcription as meetings
// (lib/meetings/transcribe.js, PRO_TRANSCRIBE_*). Nothing is kept: the words go back to the composer they came from.
// The language is the person's main language (lib/mainLang.js), like their meeting pieces.
import express from 'express'
import { transcribe } from '../lib/meetings/transcribe.js'
import { mainLangOf } from '../lib/mainLang.js'
import { L } from '../lib/lang.js'

// pieces one person may have in flight (each holds a transcription server's CPU for a second or two)
export const MAX_IN_FLIGHT = 3
const busy = new Map()

export function dictationRoutes(auth) {
  const r = express.Router()
  r.post('/dictation', auth, express.raw({ type: () => true, limit: '3mb' }), async (req, res) => {
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length < 1600) return res.status(400).json({ error: L('소리가 너무 짧아요.', 'The audio is too short.') })
    const me = req.user.id
    if ((busy.get(me) || 0) >= MAX_IN_FLIGHT) return res.status(429).json({ error: L('받아 적는 중인 말이 많아요. 잠시 뒤 다시 말씀해 주세요.', 'Still writing down what you said. Try again in a moment.') })
    busy.set(me, (busy.get(me) || 0) + 1)
    try {
      const type = String(req.headers['content-type'] || '')
      const t = await transcribe(buf, { type: /webm|ogg/.test(type) ? type : 'audio/wav', language: await mainLangOf(me) })
      res.json({ text: t.text, ms: t.ms })
    } catch (e) {
      // transcribe's own reasons are for people (no key · not answering); anything else is not said as it is
      if (!e.status) console.warn('[dictation]', e.message)
      res.status(e.status || 500).json({ error: e.status ? e.message : L('받아 적지 못했어요.', "Couldn't write that down.") })
    } finally {
      const n = (busy.get(me) || 1) - 1
      if (n > 0) busy.set(me, n); else busy.delete(me)
    }
  })
  return r
}
