// 링크 미리보기(server lib/linkPreview.js)의 화면 쪽: 메시지 글에서 카드를 달 링크를 고르고, 링크마다 서버에 한 번만 묻는다.
//   - 메시지의 처음 세 개(같은 링크는 하나로), 코드 블록 · 인라인 코드 안의 링크는 빼고
//   - 이 앱 자신의 주소(같은 호스트)와 파일(Storage 객체 · 내려받는 파일 링크)은 이미 카드가 있으니 빼고
//   - 서명 · 사설 주소 같은 나머지 규칙은 서버가 정한다(여기서 묻기만 하고, 못 만들면 아무것도 보이지 않는다)
import { marked } from 'marked'

export const MAX_CARDS = 3
const FILE = /\/storage\/v1\/|\.(pdf|docx?|xlsx?|pptx?|hwpx?|hwp|zip|csv|txt|json|png|jpe?g|gif|webp|svg|mp3|m4a|wav|mp4|mov|webm|dxf|dwg|step|stp|igs|iges)$/i
const HANGUL = 'ᄀ-ᇿ㄰-㆏가-힯'
// "https://example.com에서" — 주소 바로 뒤에 붙여 쓴 한국어는 문장이지 호스트가 아니다(한국어 도메인 "한국.kr"은 그대로)
const GLUED = new RegExp(`^(https?://[^/?#\\s${HANGUL}]*\\.[a-z]{2,})[${HANGUL}]`, 'i')

function collect(tokens, out) {
  for (const t of tokens || []) {
    if (t.type === 'code' || t.type === 'codespan' || t.type === 'html') continue
    if (t.type === 'link' && t.href) out.push(t.href)
    if (t.tokens) collect(t.tokens, out)
    if (t.items) collect(t.items, out)
    if (t.type === 'table') {
      for (const c of t.header || []) collect(c.tokens, out)
      for (const row of t.rows || []) for (const c of row) collect(c.tokens, out)
    }
  }
}

// The links in a message that get a card, in the order they appear.
export function linksIn(text, { here = typeof location !== 'undefined' ? location : null, max = MAX_CARDS } = {}) {
  const s = String(text || '')
  if (!/https?:\/\/|www\./i.test(s)) return []
  const found = []
  try { collect(marked.lexer(s), found) } catch { return [] }
  const out = []
  const seen = new Set()
  for (const raw of found) {
    const href = (GLUED.exec(raw)?.[1]) || raw
    let u
    try { u = new URL(href) } catch { continue }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    if (here && (u.hostname === here.hostname)) continue
    if (FILE.test(u.pathname)) continue
    u.hash = ''
    if (seen.has(u.href)) continue
    seen.add(u.href)
    out.push(href)
    if (out.length >= max) break
  }
  return out
}

// one question per link for the life of the page (a failed one is asked again the next time it is shown)
const memo = new Map()
export function previewOf(url) {
  if (memo.has(url)) return memo.get(url)
  // (api.js read on use: linksIn stays a plain function node can load — F-LP-05 checks it without a browser)
  const p = import('./api.js').then(({ api }) => api(`/link-preview?url=${encodeURIComponent(url)}`)).then((r) => r?.preview || null, () => { memo.delete(url); return null })
  memo.set(url, p)
  if (memo.size > 300) memo.delete(memo.keys().next().value)
  return p
}
// what is already known (a card drawn again — a re-render, the messenger reopened — shows at once, no skeleton)
const known = new Map()
export const knownPreview = (url) => known.get(url)
export async function loadPreview(url) {
  const p = await previewOf(url)
  if (memo.has(url)) {
    known.set(url, p)
    if (known.size > 300) known.delete(known.keys().next().value)
  }
  return p
}
