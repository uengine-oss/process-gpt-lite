// 검수: after the agent edits an image or a document the person has open, check that the result
// does what was asked and that nothing went missing, before the person takes it further.
//
// A capture is taken before the turn and after it (the app open in the page, lib/craftLive.js, or the
// IeumOffice document through office-host's live tools):
//   PhotoCraft · VectorCraft  the picture (PNG) → stroke coverage (pixels away from the background)
//   CADCraft                  entity counts by type (drawing.inspect)
//   SoundCraft · FilmCraft    tracks/clips in the session or sequence
//   워드 · 한글                text length, blocks/tables (and table rows), pictures
//   엑셀                      filled cells and formulas in the used range
// Deterministic checks flag losses (strokes under 70%, fewer entities/rows/formulas, much shorter
// text) unless the request asked to remove something. For pictures the in-house model, which reads
// images, also compares before/after with the request; for documents it compares the texts.
// A failed picture recolour is redone once by the background-mask method; if it still fails it is
// put back as it was. The outcome is a short note in the chat (and the dial), kept for the card.
import zlib from 'node:zlib'
import { config } from '../config.js'
import { chat } from './llm.js'
import { liveFor, pageCall } from './craftLive.js'
import { withClient } from '../mcp/office.js'
import { addMessage } from './store.js'
import { emit } from './bus.js'

const clip = (t, n = 70) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s }
const REMOVE = /(지워|삭제|빼\s*줘|없애|제거|줄여|합쳐)/
const lastReview = new Map() // `${userId}:${file}` → { ok, summary, at }
export const reviewFor = (userId, file) => lastReview.get(`${userId}:${file}`) || null
export function recordReview(userId, file, r) { if (file) lastReview.set(`${userId}:${file}`, { ...r, at: Date.now() }) }

// ---- PNG → RGBA (8-bit RGB/RGBA, non-interlaced: what the apps' screenshots are)
export function decodePng(buf) {
  let p = 8, w = 0, h = 0, type = 0, depth = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9] }
    else if (kind === 'IDAT') idat.push(data)
    else if (kind === 'IEND') break
    p += 12 + len
  }
  if (depth !== 8 || ![2, 6].includes(type)) throw new Error(`png: unsupported ${depth}-bit type ${type}`)
  const bpp = type === 6 ? 4 : 3, stride = w * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(w * h * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
      line[i] = (line[i] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255
    }
    for (let x = 0; x < w; x++) { out[(y * w + x) * 4] = line[x * bpp]; out[(y * w + x) * 4 + 1] = line[x * bpp + 1]; out[(y * w + x) * 4 + 2] = line[x * bpp + 2]; out[(y * w + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255 }
    prev = line
  }
  return { w, h, rgba: out }
}
/** pixels clearly away from the background (the corner colour), every second pixel */
export function strokeCoverage(png) {
  const { w, h, rgba } = decodePng(png)
  const b = (3 * w + 3) * 4
  let n = 0
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * 4
    if (Math.abs(rgba[i] - rgba[b]) + Math.abs(rgba[i + 1] - rgba[b + 1]) + Math.abs(rgba[i + 2] - rgba[b + 2]) > 60) n++
  }
  return { strokes: n, ground: [rgba[b], rgba[b + 1], rgba[b + 2]] }
}

// ---- captures
const IMAGE_APPS = new Set(['photocraft', 'vectorcraft'])
async function captureCraft(userId, app) {
  const live = liveFor(userId, app)
  if (!live) return null
  if (IMAGE_APPS.has(app)) {
    const r = await pageCall(live, 'ui.screenshot', {})
    const b64 = r?.base64 || r?.png_base64 || r?.pngBase64
    if (!b64) return null
    const png = Buffer.from(b64, 'base64')
    return { kind: 'image', app, png, ...strokeCoverage(png) }
  }
  if (app === 'cadcraft') {
    const d = await pageCall(live, 'drawing.inspect', { limit: 1 })
    return { kind: 'cad', app, counts: d?.counts || {}, total: Object.values(d?.counts || {}).reduce((a, b) => a + b, 0), layers: (d?.layers || []).length }
  }
  if (app === 'soundcraft') {
    const s = await pageCall(live, 'session.inspect', {})
    return { kind: 'session', app, tracks: (s?.tracks || []).length, clips: (s?.tracks || []).reduce((a, t) => a + (t.clips || []).length, 0) }
  }
  if (app === 'filmcraft') {
    const s = await pageCall(live, 'engine.execute', { command: 'sequence.inspect', params: {} }).catch(() => null)
    const text = JSON.stringify(s || {})
    return { kind: 'sequence', app, clips: (text.match(/"clipId"|"clip_id"|"kind":"clip"/g) || []).length, size: text.length }
  }
  return null
}
const callText = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args })
  const t = (r.content || []).find((x) => x.type === 'text')?.text || ''
  try { return JSON.parse(t) } catch { return t }
}
const cols = (n) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s }
async function captureOffice(jwt, open) {
  return withClient(jwt, async (c) => {
    const docs = (await callText(c, 'office_live_documents', {}))?.documents || []
    const d = [...docs].reverse().find((x) => x.file_name === open.file) || docs.at(-1)
    if (!d) return null
    const read = await callText(c, 'office_live_read', { session_id: d.session_id })
    if (d.editor === 'sheets') {
      const range = /([A-Z]+)(\d+):([A-Z]+)(\d+)/.exec(read?.summary?.loadedRange || read?.loadedRange || JSON.stringify(read).match(/"loadedRange":"([^"]+)"/)?.[1] || '')
      const lastCol = range ? range[3].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : 5
      const lastRow = range ? Math.min(Number(range[4]), 80) : 30
      const addresses = []
      for (let r = 1; r <= lastRow; r++) for (let k = 0; k <= Math.min(lastCol, 12); k++) addresses.push(`${cols(k)}${r}`)
      const cells = (await callText(c, 'office_live_read', { session_id: d.session_id, addresses }))?.cells || {}
      const vals = Object.values(cells)
      return { kind: 'sheet', editor: 'sheets', filled: vals.filter((v) => v && v.value != null && v.value !== '').length, formulas: vals.filter((v) => v?.formula).length,
        text: vals.map((v) => v?.display ?? v?.value ?? '').join(' ').slice(0, 4000) }
    }
    if (d.editor === 'hwp') {
      const tables = read?.tables?.tables || []
      return { kind: 'doc', editor: 'hwp', text: String(read?.text || ''), length: String(read?.text || '').length, tables: tables.length,
        rows: Object.fromEntries(tables.map((t) => [t.table, t.rows])), pictures: (read?.pictures || []).length }
    }
    const text = typeof read === 'string' ? read : String(read?.text || JSON.stringify(read))
    return { kind: 'doc', editor: 'docs', text, length: text.length, tables: (text.match(/\|table\|/g) || []).length, blocks: (text.match(/^\d+\|/gm) || []).length }
  })
}
export async function capture({ userId, jwt, open }) {
  if (!open) return null
  try {
    return open.app === 'ieumoffice' ? await captureOffice(jwt, open) : await captureCraft(userId, open.app)
  } catch (e) { console.warn('[review] capture', e.message); return null }
}

// ---- the model's look (it reads images): did the edit do what was asked, is anything missing?
async function askModel(content) {
  // through chat(): the arguments each model refuses (reasoning_effort, temperature, max_tokens) are dropped
  const msg = await chat({ messages: [{ role: 'user', content }], maxTokens: 1500, effort: 'low', temperature: 0, timeoutMs: 90_000 })
  const text = msg?.content || ''
  const m = text.match(/\{[\s\S]*\}/)
  return m ? JSON.parse(m[0]) : null
}
const ASK = (request, what) => `너는 편집 결과를 검수한다. 사용자 요청: "${request}". ${what}
JSON 하나만 답하라: {"met": true|false, "missing": ["원본에 있었는데 결과에서 사라지거나 알아볼 수 없게 된 요소(예: 테이블, 의자, 벽, 문, 실 이름, 치수)"], "changes": "무엇이 바뀌었는지 한 줄", "kept": "그대로 남은 주요 요소 한 줄"}. 한국어로.`
async function visionCheck(request, before, after) {
  return askModel([
    { type: 'text', text: ASK(request, '첫 그림이 편집 전, 둘째 그림이 편집 후다.') },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${before.png.toString('base64')}` } },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${after.png.toString('base64')}` } },
  ])
}
async function textCheck(request, before, after) {
  return askModel(ASK(request, `편집 전 내용:\n${String(before.text).slice(0, 3000)}\n\n편집 후 내용:\n${String(after.text).slice(0, 3000)}`))
}

// ---- deterministic comparison
export function losses(request, b, a) {
  const out = [], ok = []
  const removing = REMOVE.test(request)
  if (b.kind === 'image') {
    const kept = b.strokes ? a.strokes / b.strokes : 1
    ;(kept < 0.7 ? out : ok).push(`선 ${Math.round(kept * 100)}% 유지`)
  } else if (b.kind === 'cad') {
    for (const [t, n] of Object.entries(b.counts)) if ((a.counts[t] || 0) < n && !removing) out.push(`${t} ${n}→${a.counts[t] || 0}`)
    ok.push(`객체 ${b.total}→${a.total}`)
  } else if (b.kind === 'session' || b.kind === 'sequence') {
    if (!removing && (a.clips < b.clips || (a.tracks ?? 0) < (b.tracks ?? 0))) out.push(`클립 ${b.clips}→${a.clips}`)
    else ok.push(`클립 ${b.clips}→${a.clips}`)
  } else if (b.kind === 'sheet') {
    if (a.formulas < b.formulas && !removing) out.push(`수식 ${b.formulas}→${a.formulas}`)
    else ok.push(`수식 ${a.formulas}개 유지`)
    if (a.filled < b.filled * 0.8 && !removing) out.push(`채운 칸 ${b.filled}→${a.filled}`)
  } else if (b.kind === 'doc') {
    if (a.tables < b.tables && !removing) out.push(`표 ${b.tables}→${a.tables}`)
    for (const [t, n] of Object.entries(b.rows || {})) if ((a.rows?.[t] || 0) < n && !removing) out.push(`표 ${t} 행 ${n}→${a.rows?.[t] || 0}`)
    if (b.pictures && (a.pictures || 0) < b.pictures && !removing) out.push(`그림 ${b.pictures}→${a.pictures}`)
    if (a.length < b.length * 0.6 && !removing) out.push(`글 ${b.length}→${a.length}자`)
    if (!out.length) ok.push(`표 ${a.tables}개${b.rows ? '·행' : ''} 유지`)
  }
  return { out, ok }
}

// colour by distance from the background (gradientMap-style recolours drop strokes as dark as the ground)
const RECOLOR = /(색|톤|컬러|color|색상|칠)/i
async function maskRecolor(live, request) {
  const navy = /검정|검은/.test(request) ? '#222222' : '#1f3a6e'
  const ground = /흰|하얀|white/i.test(request) ? '#ffffff' : '#eef5fc'
  for (const [command, params] of [['select.all'], ['edit.fillHistory'], ['select.deselect'],
    ['select.magicWand', { x: 3, y: 3, tolerance: 14, contiguous: false, antiAlias: false }], ['edit.fill', { contents: 'color', color: ground }],
    ['select.inverse'], ['select.modify.expand', { radius: 1 }], ['edit.fill', { contents: 'color', color: navy }], ['select.deselect']]) {
    await pageCall(live, 'engine.execute', { command, params: params || {} })
  }
}
async function restore(live) {
  for (const command of ['select.all', 'edit.fillHistory', 'select.deselect']) await pageCall(live, 'engine.execute', { command, params: {} })
}

/** review one turn; posts the note and returns { ok, summary } */
export async function reviewTurn({ user, session, threadId, request, open, before }) {
  if (!open || !before) return null
  const status = (t) => emit(user.id, 'status', { threadId, text: t })
  status('결과 검수하는 중')
  try {
    let after = await capture({ userId: user.id, jwt: session.access_token, open })
    if (!after) return null
    const det = () => losses(request, before, after)
    let { out, ok } = det()
    let look = null, how = '픽셀·개수 검사'
    if (after.kind === 'image') { look = await visionCheck(request, before, after).catch(() => null); if (look) how = '그림 비교(사내 모델)·픽셀 검사' }
    else if (after.kind === 'doc' || after.kind === 'sheet') { look = await textCheck(request, before, after).catch(() => null); if (look) how = '내용 비교(사내 모델)·개수 검사' }
    const missing = () => [...out, ...(look?.missing || []).filter(Boolean).map((x) => `${x} 사라짐`)]
    let fixed = ''
    if (missing().length && after.kind === 'image' && open.app === 'photocraft' && RECOLOR.test(request)) {
      // once more, by the background mask, then look again
      const live = liveFor(user.id, open.app)
      status('검수: 다시 칠하는 중')
      await maskRecolor(live, request)
      after = await capture({ userId: user.id, jwt: session.access_token, open })
      ;({ out, ok } = det())
      look = await visionCheck(request, before, after).catch(() => null)
      fixed = missing().length ? '' : '바탕색 기준으로 다시 칠함'
      if (missing().length) { await restore(live); fixed = '원래 그림으로 되돌림' }
    }
    const miss = missing()
    const okNow = !miss.length && look?.met !== false
    const parts = okNow
      ? [...ok, look?.kept && `유지: ${clip(look.kept)}`, look?.changes && `바뀜: ${clip(look.changes)}`].filter(Boolean)
      : [`빠진 것: ${miss.join(', ') || '요청이 반영되지 않음'}`, fixed].filter(Boolean)
    const summary = `검수(${how}): ${parts.join(' · ')}${okNow ? ' ✓' : ' ⚠'}${okNow && fixed ? ` (처음 결과는 선이 사라져 ${fixed})` : ''}`
    await addMessage(user.id, threadId, 'agent', 'text', { text: summary, review: { ok: okNow, app: open.app, file: open.file } })
    recordReview(user.id, open.file, { ok: okNow, summary })
    return { ok: okNow, summary }
  } catch (e) {
    console.warn('[review]', e.message)
    return null
  } finally { status(null) }
}
