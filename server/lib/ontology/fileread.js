// 사람 단계에 낸 PDF · 그림 파일을 뒤 단계가 읽는 글로(stepfiles.js fileText). 별도 OCR 프로그램 없이:
//   글이 든 PDF  — 쪽마다 글을 바로 뽑는다(pdfjs-dist)
//   스캔 PDF     — 글이 거의 없는 쪽만 그림으로 그려(@napi-rs/canvas, pdfjs-dist 와 함께 깔리는 미리 빌드된 모듈) 그림을 읽는 모델에게 보인다
//   사진 · 그림  — jpg · png · webp · gif 를 그대로 그림을 읽는 모델에게 보인다
// 모델이 읽은 글은 틀릴 수 있다 — 뒤 단계는 'image' 로 읽은 것을 그렇게 받고(run.js mapPrev), 금액 확정은 사람 단계에서 한다.
// 읽지 못한 파일(암호 PDF · HEIC 같은 형식 · 모델이 못 읽음)은 read 'none' 과 까닭으로 — 뒤 단계에는 그 표시와 원본 링크가 간다.
import { chat } from '../llm.js'
import { config } from '../../config.js'

const IMAGE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
const extOf = (name) => (String(name || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
// the files this module reads (others go on to events.js readUpload — docx · xlsx · pptx · hwpx · csv · txt · md)
export const readsHere = (name) => extOf(name) === 'pdf' || !!IMAGE[extOf(name)] || /^(heic|heif|tiff?|bmp)$/.test(extOf(name))

export const RULES = {
  minPageChars: 25, // a page with fewer letters and digits than this reads as a scan (its picture goes to the model)
  maxImagePages: 4, // scanned pages shown to the model per file
  pageWidth: 1400, // the drawn page's width in pixels
  maxImageBytes: 15 * 1024 * 1024,
  timeoutMs: 120_000,
}

const CANT = '읽을 수 없음'
const ASK = `그림은 회사 업무 단계에 사람이 낸 파일(영수증 · 증빙 · 문서)을 찍거나 스캔한 것입니다. 보이는 글을 그대로 옮겨 적으세요.
- 상호 · 날짜 · 품목 · 수량 · 금액 · 합계 · 결제 수단 · 승인번호는 보이는 그대로(숫자의 쉼표 · 단위 포함) 적는다.
- 줄과 칸의 순서를 지키고, 표는 한 줄에 한 행으로 「 | 」로 칸을 나눈다.
- 흐리거나 가려진 글자는 [?] 로 적는다. 보이지 않는 내용을 짐작해 채우지 않는다.
- 설명 · 요약 · 인사말 없이 옮긴 글만 답한다.
- 글이 없거나 전혀 알아볼 수 없으면 정확히 「${CANT}」 한 마디만 답한다.`

// pictures → the words the model reads in them ('' when it could not)
async function look(images, name) {
  const content = [{ type: 'text', text: `${ASK}\n\n파일 이름: ${name}${images.length > 1 ? ` (${images.length}쪽)` : ''}` },
    ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.type};base64,${im.buf.toString('base64')}` } }))]
  const msg = await chat({ messages: [{ role: 'user', content }], model: config.llm.visionModel || config.llm.model, temperature: 0, maxTokens: 4000, effort: 'low', timeoutMs: RULES.timeoutMs })
  const text = String(msg?.content || '').trim()
  return !text || text.replace(/[「」"'.\s]/g, '') === CANT.replace(/\s/g, '') ? '' : text
}

let pdfjs = null
async function loadPdf(buf) {
  pdfjs ||= await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise
}
// a page's words in reading order. pdfjs gives runs (a browser's PDF: often one glyph each); a run starts a new word only when it
// starts clearly after the last one ended, a new line when it is on another line (or the last ended one)
async function pageText(page) {
  const tc = await page.getTextContent()
  let s = '', last = null
  for (const it of tc.items) {
    const [, , , d, x, y] = it.transform || [0, 0, 0, 0, 0, 0]
    const size = Math.abs(d) || it.height || 10
    if (last && !last.eol && it.str) {
      if (Math.abs(y - last.y) > size * 0.5) s += '\n'
      else if (x - last.end > size * 0.2 && !/\s$/.test(s)) s += ' '
    }
    s += it.str || ''
    if (it.hasEOL) s += '\n'
    if (it.str || it.hasEOL) last = { y, end: x + (it.width || 0), eol: !!it.hasEOL }
  }
  return s.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
async function pagePicture(page) {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: Math.min(4, RULES.pageWidth / base.width) })
  const { createCanvas } = await import('@napi-rs/canvas')
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  return { type: 'image/jpeg', buf: await canvas.encode('jpeg', 85) }
}
const letters = (s) => (String(s).match(/[\p{L}\p{N}]/gu) || []).length

// → { text, read: 'text' | 'image' | 'none', why? }   read 'text': words taken from the file · 'image': read by the model from its picture
export async function readPdf(buf, name) {
  let doc
  try { doc = await loadPdf(buf) } catch (e) {
    const why = e?.name === 'PasswordException' ? '암호가 걸린 PDF라 열지 못했어요' : `PDF를 열지 못했어요(${String(e?.message || e).slice(0, 80)})`
    return { text: '', read: 'none', why }
  }
  try {
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const text = await pageText(page).catch(() => '')
      pages.push({ i, page, text, scan: letters(text) < RULES.minPageChars })
    }
    const scans = pages.filter((p) => p.scan)
    // the scanned pages, drawn and shown to the model (all at once — one receipt can run over two pages)
    let seen = '', why = ''
    if (scans.length) {
      try {
        const pics = []
        for (const p of scans.slice(0, RULES.maxImagePages)) pics.push(await pagePicture(p.page))
        seen = await look(pics, name)
        if (!seen) why = '스캔한 쪽의 글을 알아보지 못했어요'
      } catch (e) { why = `스캔한 쪽을 읽지 못했어요(${String(e?.message || e).slice(0, 80)})`; console.warn('[fileread] pdf scan', name, e.message) }
    }
    const typed = pages.filter((p) => !p.scan && p.text).map((p) => (pages.length > 1 ? `[${p.i}쪽]\n${p.text}` : p.text))
    const text = [...typed, seen && (pages.length > 1 ? `[스캔한 쪽 ${scans.slice(0, RULES.maxImagePages).map((p) => p.i).join(', ')}]\n${seen}` : seen)].filter(Boolean).join('\n\n')
    if (!text) return { text: '', read: 'none', why: why || '글이 없는 PDF예요' }
    return { text, read: seen ? 'image' : 'text', ...(why ? { why } : {}) }
  } finally { doc.destroy().catch(() => {}) }
}

export async function readImage(buf, name) {
  const type = IMAGE[extOf(name)]
  if (!type) return { text: '', read: 'none', why: `${extOf(name).toUpperCase()} 그림은 읽지 못해요 — JPG · PNG로 다시 올려 주세요` }
  if (buf.length > RULES.maxImageBytes) return { text: '', read: 'none', why: '그림이 너무 커요' }
  try {
    const text = await look([{ type, buf }], name)
    return text ? { text, read: 'image' } : { text: '', read: 'none', why: '그림의 글을 알아보지 못했어요' }
  } catch (e) {
    console.warn('[fileread] image', name, e.message)
    return { text: '', read: 'none', why: `그림을 읽지 못했어요(${String(e?.message || e).slice(0, 80)})`, retry: true }
  }
}

export async function readPdfOrImage(buf, name) {
  return extOf(name) === 'pdf' ? readPdf(buf, name) : readImage(buf, name)
}

// a file as a later step is told about it (run.js mapPrev · the draft step · steprule.js caseState): what was read, how, and the
// original's link — a picture's reading may be wrong (the amounts are confirmed in a person's step), a file not read says so
export const READ_KO = { text: '파일의 글', image: '그림을 모델이 읽은 글 — 잘못 읽었을 수 있어요(금액은 원본으로 확인)', none: '읽지 못한 파일' }
export function forNextStep(f, chars = 1500) {
  const read = f.read || (String(f.text || '').trim() ? 'text' : 'none')
  return { name: f.name, read: READ_KO[read],
    text: read === 'none' ? `(읽지 못한 파일${f.why ? ` — ${f.why}` : ''}. 원본을 열어 확인하세요)` : String(f.text || '').slice(0, chars),
    ...(f.url ? { original: f.url } : {}), ...(f.path ? { path: f.path } : {}) }
}
export function fileLine(f, chars = 500) {
  const x = forNextStep(f, chars)
  return `  · 낸 파일 「${x.name}」(${x.read}): ${String(x.text).replace(/\s+/g, ' ').trim()}${x.original ? ` [원본: ${x.original}]` : ''}`
}
// what the agent of a later step is told about such files (run.js runStep): '' when every file was read as text
export function filesNote(prev) {
  const files = (prev?.steps || []).flatMap((x) => x.files || [])
  const seen = files.filter((f) => f.read === READ_KO.image).map((f) => `「${f.name}」`)
  const none = files.filter((f) => f.read === READ_KO.none).map((f) => `「${f.name}」`)
  return [
    seen.length ? `\n앞 단계 파일 ${seen.join(' · ')}은 스캔 · 사진을 모델이 읽은 글이에요. 그 금액을 쓰되 원본 확인이 필요하다고 결과에 밝혀 주세요.` : '',
    none.length ? `\n앞 단계 파일 ${none.join(' · ')}은 읽지 못했어요. 결과에 읽지 못했다고 적고 그 원본 링크(original)를 남긴 뒤, 나머지 자료로 이 단계를 끝까지 해 주세요.` : '',
  ].join('')
}
