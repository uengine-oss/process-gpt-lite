// The editor's picture request (components/OfficeSheet.vue): a request about a picture in an open Hangul or
// Word document either changes the picture itself (it goes to PhotoCraft) or its place in the document
// (it stays with the document). Which one is the judge's to say (lib/judge.js), never a list of words.
// Mounted from routes/process.js until index.js mounts it itself.
import express from 'express'
import { judge, judgeAvailable } from '../lib/judge.js'

const OPTIONS = [
  { key: 'image', label: 'edit the content of this same picture — its pixels: colours, light, retouching, drawing, writing or erasing something inside it — the picture stays, what it shows changes' },
  { key: 'document', label: "handle the picture as a part of the document — move it, take it out, put another image file in its place, caption it, set its size or alignment on the page, or change the text or table around it" },
]
// 'image' (PhotoCraft) or 'document' (stays); unsure, no judge, or nothing said: 'document' (nothing leaves the document)
// throws: let a failed judge call through (evaluation counts it)
export async function pictureIntent(text, picture = '', { throws = false } = {}) {
  const t = String(text || '').slice(0, 1000)
  if (!t.trim() || !judgeAvailable()) return { edit: 'document', via: 'default' }
  try {
    const j = await judge({ state: JSON.stringify({ request: t, picture: String(picture || '').slice(0, 80) }),
      question: 'The user pointed at a picture in an open document and wrote this request. What does it ask for?', options: OPTIONS })
    const p = j.probabilities || {}
    return { edit: (p.image || 0) >= 0.6 ? 'image' : 'document', p: p.image || 0, via: j.via }
  } catch (e) { if (throws) throw e; console.warn('[office] picture intent', e.message); return { edit: 'document', via: 'default' } }
}

export function officePictureRoutes(auth) {
  const r = express.Router()
  r.post('/office/picture-intent', auth, async (req, res) => res.json(await pictureIntent(req.body?.text, req.body?.picture)))
  return r
}
