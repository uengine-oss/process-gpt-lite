// 이 일이 쓰는 양식과 그 양식의 형식 규칙(sql/043, skills/process-discovery rules.formats · prompts/format-rules.md).
//
// 일이 쓰는 양식: 관리자가 고른 것(pro_form_choices) → 일 정의의 내놓는 것에 적힌 양식(outputs[].template) → 메일에 가장 많이 오간,
// 파일이 있는 양식(자동). 화면은 「정해 둔 양식」 · 「가장 많이 쓴 양식(자동)」으로 말한다. 단계가 문서를 만들 때 이 양식 파일에서
// 시작한다(run.js runStep).
//
// 형식 규칙: 그 양식의 문서가 건마다 내용이 달라도 늘 지키는 것 — 머리글 · 첫 쪽의 그림(로고), 머리글 · 바닥글 글, 고정 문구(문의처 ·
// 회사 정보 · 면책 · 안내), 제목 붙이는 법, 파일 이름 붙이는 법. 규칙이 먼저 찾는다: 그 양식의 파일들(메일에서 남겨 둔 파일, 모자라면
// 그 양식이 붙은 다른 메일의 첨부를 메일함 주인의 연결로 읽기만 해서 — 디스크에 남기지 않는다)에서 같은 그림 · 같은 머리글 · 여러 파일에
// 되풀이되는 문장을 후보로. 모델(judge.js, 기본 Fable)은 후보마다 이름을 붙이고 꼭 지킬지 정할 뿐 후보에 없는 것을 더하지 못한다.
// 모델에는 문서 전체가 아니라 후보 글만, 사람 · 고객 이름과 연락처를 가린 채로 간다. 파일이 하나뿐이면 「파일 하나에서 찾았어요(낮은 확신)」.
// 결과는 SKILL.md 모양(kind: format)으로 (일, 양식)마다 남고, 관리자가 글을 고치거나 항목마다 꼭 지킬지를 바꾼다(결정 원장).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { maskPii } from '../policy/pii.js'
import { prompt, rules as skillRules, defaultRules, BUNDLED_DIR } from './discovery.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 12)
const R0 = () => defaultRules().formats || {}

// ---------- pure: reading a document's parts ----------
const unesc = (t) => String(t).replace(/<[^>]+>/g, '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
export const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
// innermost paragraphs of an OOXML / OWPML part (w:p · a:p · hp:p), each with its text runs (w:t · a:t · hp:t)
export function paragraphsOf(xml, ns) {
  const re = new RegExp(`<${ns}:p\\b[^>]*?(?:/>|>(?:(?!<${ns}:p\\b)[\\s\\S])*?</${ns}:p>)`, 'g')
  const tRe = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>`, 'g')
  const out = []
  for (const m of xml.matchAll(re)) {
    const ts = [...m[0].matchAll(tRe)]
    out.push({ start: m.index, end: m.index + m[0].length, xml: m[0], text: ts.map((t) => unesc(t[1])).join(''), runs: ts.length })
  }
  return out
}
const relsOf = (xml) => new Map([...String(xml || '').matchAll(/<Relationship\b[^>]*?>/g)].map((m) => [m[0].match(/\bId="([^"]+)"/)?.[1], m[0].match(/\bTarget="([^"]+)"/)?.[1]]).filter(([a, b]) => a && b))
const joinPath = (dir, target) => (target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(dir, target)))
const IMG = /\.(png|jpe?g|gif|bmp|emf|wmf|svg|tiff?)$/i
// an xlsx header/footer string (&L&"Arial"&12 회사 &C&P) as text
export const hfText = (s) => clean(unesc(String(s || '')).replace(/&[LCR]/g, ' | ').replace(/&"[^"]*"/g, '').replace(/&\d+/g, '')
  .replace(/&[PNDTFA]/g, (m) => ({ '&P': '[쪽]', '&N': '[전체 쪽]', '&D': '[날짜]', '&T': '[시각]', '&F': '[파일 이름]', '&A': '[시트 이름]' }[m]))).replace(/^\|\s*|\s*\|$/g, '').trim()

// a file → what a format rule can be about: {kind, name, header, footer, body, slides, master, images:[{where, hash, size}]}
export async function docFacts(name, buf, { firstParagraphs = 8 } = {}) {
  const kind = String(name).split('.').pop().toLowerCase()
  const zip = await JSZip.loadAsync(buf)
  const read = async (p) => (zip.file(p) ? zip.file(p).async('string') : '')
  const bytes = async (p) => (zip.file(p) ? zip.file(p).async('nodebuffer') : null)
  const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const out = { kind, name, header: [], footer: [], body: [], slides: [], master: [], images: [] }
  const lines = (ps) => ps.map((p) => clean(p.text)).filter(Boolean)
  const imageOf = async (part, rid, where) => {
    const rels = relsOf(await read(path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`)))
    const t = rels.get(rid)
    if (!t || !IMG.test(t)) return
    const b = await bytes(joinPath(path.posix.dirname(part), t))
    if (b) out.images.push({ where, hash: sha(b), size: b.length, media: path.posix.basename(t) })
  }
  const imagesIn = async (part, xml, where) => { for (const m of String(xml).matchAll(/\br:(?:embed|id|link)="([^"]+)"/g)) await imageOf(part, m[1], where) }
  if (kind === 'docx') {
    for (const p of files.filter((f) => /^word\/header\d*\.xml$/.test(f))) { const x = await read(p); out.header.push(...lines(paragraphsOf(x, 'w'))); await imagesIn(p, x, 'header') }
    for (const p of files.filter((f) => /^word\/footer\d*\.xml$/.test(f))) { const x = await read(p); out.footer.push(...lines(paragraphsOf(x, 'w'))); await imagesIn(p, x, 'footer') }
    const x = await read('word/document.xml')
    const ps = paragraphsOf(x, 'w')
    out.body = lines(ps)
    // a picture in the first paragraphs is on the first page (a cover logo); the rest are the body's
    const cut = ps[Math.min(firstParagraphs, ps.length) - 1]?.end ?? 0
    await imagesIn('word/document.xml', x.slice(0, cut), 'first-page')
    await imagesIn('word/document.xml', x.slice(cut), 'body')
  } else if (kind === 'pptx') {
    for (const p of files.filter((f) => /^ppt\/(slideMasters\/slideMaster|slideLayouts\/slideLayout)\d+\.xml$/.test(f))) {
      const x = await read(p)
      // a master's own placeholder prompts (마스터 제목 스타일 편집 · Click to edit …) are PowerPoint's, not the company's
      out.master.push(...lines(paragraphsOf(x, 'a')).filter((l) => !/마스터|수준|편집|Master|level|Click to|‹#›|<#>/i.test(l)))
      await imagesIn(p, x, 'master')
    }
    const slides = files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    for (const [i, p] of slides.entries()) {
      const x = await read(p)
      const ls = lines(paragraphsOf(x, 'a'))
      out.slides.push(ls)
      out.body.push(...ls)
      await imagesIn(p, x, i === 0 ? 'first-page' : `slide${i + 1}`)
    }
    out.master = [...new Set(out.master)]
  } else if (kind === 'xlsx') {
    const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => clean(unesc(m[1])))
    for (const p of files.filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
      const x = await read(p)
      for (const m of x.matchAll(/<(?:odd|even|first)Header>([\s\S]*?)<\/(?:odd|even|first)Header>/g)) { const t = hfText(m[1]); if (t) out.header.push(t) }
      for (const m of x.matchAll(/<(?:odd|even|first)Footer>([\s\S]*?)<\/(?:odd|even|first)Footer>/g)) { const t = hfText(m[1]); if (t) out.footer.push(t) }
      for (const c of x.matchAll(/<c r="[A-Z]+\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const t = c[1].match(/\bt="([^"]+)"/)?.[1] || '', inner = c[2] || ''
        if (/<f[\s>]/.test(inner)) continue
        const v = t === 's' ? shared[Number(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1])] : t === 'inlineStr' ? clean(unesc(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] || '')) : ''
        if (v) out.body.push(v)
      }
    }
    for (const p of files.filter((f) => /^xl\/drawings\/drawing\d+\.xml$/.test(f))) await imagesIn(p, await read(p), 'sheet')
    out.header = [...new Set(out.header)]; out.footer = [...new Set(out.footer)]
  } else if (kind === 'hwpx') {
    const manifest = await read('Contents/content.hpf')
    const bin = new Map([...manifest.matchAll(/<opf:item\b[^>]*?>/g)].map((m) => [m[0].match(/\bid="([^"]+)"/)?.[1], m[0].match(/\bhref="([^"]+)"/)?.[1]]).filter(([a, b]) => a && b))
    const pics = async (x, where) => { for (const m of String(x).matchAll(/binaryItemIDRef="([^"]+)"/g)) { const h = bin.get(m[1]); const b = h && IMG.test(h) ? await bytes(h) : null; if (b) out.images.push({ where, hash: sha(b), size: b.length, media: path.posix.basename(h) }) } }
    for (const p of files.filter((f) => /^Contents\/section\d+\.xml$/.test(f))) {
      let x = await read(p)
      for (const [tag, key] of [['header', 'header'], ['footer', 'footer']]) {
        for (const m of x.matchAll(new RegExp(`<hp:${tag}\\b[\\s\\S]*?</hp:${tag}>`, 'g'))) { out[key].push(...lines(paragraphsOf(m[0], 'hp'))); await pics(m[0], key) }
        x = x.replace(new RegExp(`<hp:${tag}\\b[\\s\\S]*?</hp:${tag}>`, 'g'), '')
      }
      const ps = paragraphsOf(x, 'hp')
      out.body.push(...lines(ps))
      const cut = ps[Math.min(firstParagraphs, ps.length) - 1]?.end ?? 0
      await pics(x.slice(0, cut), 'first-page'); await pics(x.slice(cut), 'body')
    }
  }
  return out
}

// ---------- pure: what repeats ----------
const tokens = (s, sep) => (sep === '_' ? String(s).split(/[_\s]+/) : String(s).split(/\s+/)).map((x) => x.trim()).filter(Boolean)
function lcs(a, b) {
  const m = a.length, n = b.length
  const d = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1])
  const out = []
  for (let i = 0, j = 0; i < m && j < n;) { if (a[i] === b[j]) { out.push(a[i]); i++; j++ } else if (d[i + 1][j] >= d[i][j + 1]) i++; else j++ }
  return out
}
// the part several texts share, in order: 「경남대학교 피지컬 AI PBL | 고모텍 과제 정의서」 · 「… | 디케이 과제 정의서」 →
// {pattern: '경남대학교 피지컬 AI PBL | … 과제 정의서', fixed: ['경남대학교 피지컬 AI PBL |', '과제 정의서']}
export function commonPattern(texts, sep = ' ') {
  const ts = texts.map((t) => tokens(t, sep).slice(0, 80)).filter((t) => t.length)
  if (!ts.length) return { pattern: '', fixed: [] }
  let common = ts[0]
  for (const t of ts.slice(1)) common = lcs(common, t)
  if (!common.length) return { pattern: '…', fixed: [] }
  // where each text has the shared words; a gap is where any text has words of its own
  const pos = ts.map((t) => { const p = []; let j = 0; for (const c of common) { while (j < t.length && t[j] !== c) j++; p.push(j); j++ } return p })
  const gapBefore = (i) => (i === 0 ? pos.some((p) => p[0] > 0) : pos.some((p) => p[i] - p[i - 1] > 1))
  const gapAfter = pos.some((p, x) => p.at(-1) < ts[x].length - 1)
  const fixed = [], pattern = gapBefore(0) ? ['…'] : []
  let run = [common[0]]
  for (let i = 1; i < common.length; i++) {
    if (gapBefore(i)) { fixed.push(run.join(sep)); pattern.push(run.join(sep), '…'); run = [] }
    run.push(common[i])
  }
  fixed.push(run.join(sep)); pattern.push(run.join(sep))
  if (gapAfter) pattern.push('…')
  return { pattern: pattern.join(sep), fixed }
}
// sentences in at least `share` of the files (and `minFiles` of them): a fixed phrase, not a label (it reads as a sentence or a
// line of company information) and not too long to be a phrase
export function repeatedSentences(bodies, { share = 0.6, minFiles = 2, minChars = 8, maxChars = 240 } = {}) {
  const docs = bodies.filter((b) => b?.length)
  if (docs.length < minFiles) return []
  const need = Math.max(minFiles, Math.ceil(docs.length * share))
  const n = new Map()
  for (const d of docs) for (const l of new Set(d.map(clean))) {
    if (l.length < minChars || l.length > maxChars) continue
    if (!/\s/.test(l) && !/[.。!?:：]/.test(l)) continue
    n.set(l, (n.get(l) || 0) + 1)
  }
  const order = new Map(docs[0].map((l, i) => [clean(l), i]))
  return [...n].filter(([, k]) => k >= need).map(([text, files]) => ({ text, files })).sort((a, b) => (order.get(a.text) ?? 1e9) - (order.get(b.text) ?? 1e9))
}
// every line that is on `share` of a deck's slides (a footer, the company's name, 「대외비」)
export function everySlide(slides, share = 0.6) {
  if (slides.length < 2) return []
  const n = new Map()
  for (const s of slides) for (const l of new Set(s.map(clean))) if (l.length >= 2) n.set(l, (n.get(l) || 0) + 1)
  return [...n].filter(([, k]) => k >= Math.max(2, Math.ceil(slides.length * share))).map(([l]) => l)
}

const DEFAULT_NAME = { image: '그림(로고)', header: '머리글', footer: '바닥글', phrase: '고정 문구', title: '제목', filename: '파일 이름' }
const FRAME = new Set(['header', 'footer', 'master', 'first-page', 'every-slide'])
// the rule-found candidates of a form's files (facts, from docFacts) — no model
export function candidatesOf(facts, { fileNames = [], form = '' } = {}, R = R0()) {
  const N = facts.length
  const multi = N >= (R.minFiles || 2)
  const need = multi ? Math.max(R.minFiles || 2, Math.ceil(N * (R.share ?? 0.6))) : 1
  const fixedRe = R.fixed ? new RegExp(R.fixed) : null
  const out = []
  const seen = new Set()
  const add = (c) => { const k = `${c.kind}:${c.text}`; if (seen.has(k) || !c.text) return; seen.add(k); out.push({ ...c, of: N }) }
  // pictures: the same one in the files (a logo), or — one file — one in its header, master or first page
  const imgs = new Map()
  for (const [i, f] of facts.entries()) for (const im of f.images) {
    const g = imgs.get(im.hash) || { where: im.where, size: im.size, files: new Set(), media: im.media }
    g.files.add(i); if (FRAME.has(im.where) && !FRAME.has(g.where)) g.where = im.where
    imgs.set(im.hash, g)
  }
  for (const [hash, g] of imgs) {
    if (g.files.size < need || (!multi && !FRAME.has(g.where)) || (multi && !FRAME.has(g.where) && g.files.size < N)) continue
    add({ kind: 'image', where: g.where, text: `그림 ${g.media} · ${Math.max(1, Math.round(g.size / 1024))}KB`, hash, files: g.files.size })
  }
  // header · footer: what the files share there (one file: its lines)
  for (const part of ['header', 'footer']) {
    const texts = facts.map((f) => f[part].join(' | ')).filter(Boolean)
    if (multi) {
      if (texts.length < need) continue
      const p = commonPattern(texts)
      if (p.fixed.join('').replace(/[\s|]/g, '').length >= 2) add({ kind: part, where: part, text: p.pattern, fixed: p.fixed, files: texts.length })
    } else for (const l of facts[0]?.[part] || []) if (l.replace(/[\s|_]/g, '').length >= 2) add({ kind: part, where: part, text: l, fixed: [l], files: 1 })
  }
  // a deck's master and the lines on every slide
  const masters = new Map()
  for (const f of facts) for (const l of new Set([...(f.master || []), ...everySlide(f.slides || [], R.slideShare ?? 0.6)])) masters.set(l, (masters.get(l) || 0) + 1)
  for (const [l, k] of masters) if (k >= need) add({ kind: 'phrase', where: facts.some((f) => (f.master || []).includes(l)) ? 'master' : 'every-slide', text: l, fixed: [l], files: k })
  // the body: sentences that repeat across the files; one file: fixed-looking lines on its first and last paragraphs
  if (multi) {
    // (a sheet's short cells that repeat are its labels and choice lists — the form's fields, kept by the cell fill anyway; a sheet's
    // fixed phrase is a sentence or a line of company information)
    const sheet = facts[0]?.kind === 'xlsx'
    for (const s of repeatedSentences(facts.map((f) => f.body), R)) {
      if (sheet && s.text.length < (R.sheetPhraseChars || 20) && !fixedRe?.test(s.text)) continue
      add({ kind: 'phrase', where: 'body', text: s.text, fixed: [s.text], files: s.files })
    }
  } else if (facts[0] && fixedRe) {
    const b = facts[0].body
    const firstN = R.firstParagraphs || 8, lastN = R.lastParagraphs || 8
    b.slice(0, firstN).forEach((l) => { if (fixedRe.test(l) && l.length <= (R.maxChars || 240)) add({ kind: 'phrase', where: 'first-page', text: l, fixed: [l], files: 1 }) })
    b.slice(Math.max(firstN, b.length - lastN)).forEach((l) => { if (fixedRe.test(l) && l.length <= (R.maxChars || 240)) add({ kind: 'phrase', where: 'last-page', text: l, fixed: [l], files: 1 }) })
  }
  // the title: the first line the files share (one file: its first line)
  const firsts = facts.map((f) => f.body[0]).filter(Boolean)
  if (multi && firsts.length >= need) { const p = commonPattern(firsts); if (p.fixed.join('').length >= 2) add({ kind: 'title', where: 'first-page', text: p.pattern, fixed: p.fixed, files: firsts.length }) }
  else if (!multi && firsts[0] && firsts[0].length <= 120) add({ kind: 'title', where: 'first-page', text: firsts[0], fixed: [firsts[0]], files: 1 })
  // the file name: what the names the company gave this form's files share
  const stems = [...new Set(fileNames.map((n) => String(n).replace(/\.[a-z0-9]+$/i, '')))]
  if (stems.length >= 2) { const p = commonPattern(stems, '_'); if (p.fixed.join('').length >= 2) add({ kind: 'filename', where: 'name', text: `${p.pattern}.${facts[0]?.kind || ''}`.replace(/\.$/, ''), fixed: p.fixed, files: stems.length }) }
  else if (stems[0]) {
    const formStem = String(form).replace(/\.[a-z0-9]+$/i, '')
    const fixed = tokens(formStem, ' ').filter((w) => stems[0].includes(w))
    add({ kind: 'filename', where: 'name', text: fileNames[0], fixed: fixed.length ? fixed : [stems[0]], files: 1 })
  }
  return out.slice(0, R.maxCandidates || 30).map((c, i) => ({ id: `c${i + 1}`, ...c }))
}

// what goes to the model: no whole documents — the candidates' text, with people · customers · contacts hidden
export function customersOf(fileNames, form = '') {
  const keep = new Set(tokens(String(form).replace(/\.[a-z0-9]+$/i, ''), ' '))
  const stems = fileNames.map((n) => String(n).replace(/\.[a-z0-9]+$/i, ''))
  const common = new Set(stems.length >= 2 ? commonPattern(stems, '_').fixed.flatMap((f) => tokens(f, '_')) : [])
  const out = new Set()
  for (const s of stems) for (const w of tokens(s, '_').flatMap((x) => x.split(/[\s()[\]·,]+/))) {
    if (w.length < 2 || keep.has(w) || common.has(w) || /^[\d.\-v]+$/i.test(w) || /^\d{2,4}(년|월|일)/.test(w) || /^(최종|수정|초안|사본|복사본|final|draft|copy|ver)/i.test(w)) continue
    if ([...keep].some((k) => k.includes(w) || w.includes(k))) continue
    out.add(w)
  }
  return [...out]
}
export function maskText(text, { customers = [], people } = {}) {
  let t = maskPii(String(text || ''))
  if (people) t = t.replace(new RegExp(people, 'g'), (m, title) => `○○○ ${title || ''}`.trim())
  for (const c of customers) t = t.split(c).join('(고객)')
  return t
}

// the model's answer, only for the candidates it was given (it may not add an element the rules did not find)
export function judgedItems(candidates, answer, { lowConfidence = false } = {}) {
  const byId = new Map((answer?.items || []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]))
  const out = []
  for (const c of candidates) {
    const a = byId.get(c.id)
    if (a && a.keep === false) continue
    const frame = c.kind === 'image' || c.kind === 'header' || c.kind === 'footer' || c.where === 'master'
    out.push({ ...c, name: String(a?.name || DEFAULT_NAME[c.kind] || '형식').slice(0, 60),
      mandatory: a ? a.mandatory === true && (!lowConfidence || frame || c.kind === 'filename' || c.kind === 'title') : frame && (!lowConfidence || FRAME.has(c.where)),
      why: String(a?.why || (a ? '' : '규칙으로 찾았어요(모델 판단 없음)')).slice(0, 200), by: a ? 'ai' : 'rule' })
  }
  return out
}

const WHERE_KO = { header: '머리글', footer: '바닥글', 'first-page': '첫 쪽', body: '본문', 'last-page': '끝 쪽', master: '슬라이드 마스터', 'every-slide': '모든 슬라이드', sheet: '시트', name: '파일 이름' }
export const whereKo = (w) => WHERE_KO[w] || (/^slide\d+$/.test(w) ? `슬라이드 ${w.slice(5)}` : w || '')
const slug = (s) => String(s).normalize('NFKC').replace(/\.[a-z0-9]+$/i, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'form'
// the format skill as a SKILL.md (kind: format): what the document must carry, then what is good to keep
export function skillText({ task, form, type = '', items = [], source = {} }) {
  const line = (x) => `${x.name} — ${x.kind === 'image' ? `${whereKo(x.where)}에 양식의 그림(${x.text.replace(/^그림\s*/, '')})` : x.kind === 'filename' ? `「${x.text}」처럼` : `${whereKo(x.where)}에 「${x.text}」`}${x.files && x.of > 1 ? ` (파일 ${x.of}개 중 ${x.files}개)` : ''}`
  const must = items.filter((x) => x.mandatory), may = items.filter((x) => !x.mandatory)
  const from = source.n ? `파일 ${source.n}개(${(source.files || []).map((f) => f.name).slice(0, 4).join(' · ')}${(source.files || []).length > 4 ? ' …' : ''})` : '파일 없음'
  return `---
name: format-${slug(task)}-${slug(form)}
description: 「${String(form).replace(/\.[a-z0-9]+$/i, '')}」 양식으로 만드는 문서가 건마다 늘 지키는 형식 — 그림 · 머리글 · 바닥글 · 고정 문구 · 제목 · 파일 이름
kind: format
task: ${task}
form: ${form}
type: ${type}
source: ${from}${source.lowConfidence ? ' · 파일 하나에서 찾았어요(낮은 확신)' : ''}
---

# 「${String(form).replace(/\.[a-z0-9]+$/i, '')}」 형식 규칙

「${task}」에서 이 양식으로 문서를 만들 때는 건마다 내용이 달라도 아래를 지켜요. 양식은 출발점이고, 이 건의 요청에 맞게 내용은 바꿔요.
${source.lowConfidence ? '\n> 양식 파일이 하나뿐이라 무엇이 건마다 같은지 견주지 못했어요. 파일이 더 모이면 다시 찾으세요.\n' : ''}
## 꼭 지킬 것
${must.length ? must.map((x, i) => `${i + 1}. ${line(x)}`).join('\n') : '(없음)'}

## 있으면 좋은 것
${may.length ? may.map((x) => `- ${line(x)}`).join('\n') : '(없음)'}
`
}

// a made document against the form's format items (the mandatory ones): a phrase where it belongs, the form's picture
const norm = (s) => String(s || '').replace(/[\s_·|:：\-–—.,()[\]…「」'"]+/g, '').toLowerCase()
export function checkFormat(items, facts, fileName = '') {
  const all = (f) => [...f.header, ...f.footer, ...f.body, ...(f.master || [])].join('\n')
  return (items || []).filter((x) => x.mandatory).map((x) => {
    if (x.kind === 'image') {
      const same = facts.images.some((im) => im.hash === x.hash)
      const there = facts.images.some((im) => im.where === x.where || (x.where === 'first-page' && /^(first-page|header)$/.test(im.where)))
      return { id: x.id, item: x.name, ok: same, note: same ? '양식의 그림이 그대로 있어요' : there ? '그림은 있지만 양식의 그림과 달라요' : `${whereKo(x.where)}에 그림이 없어요` }
    }
    const hay = norm(x.kind === 'filename' ? fileName : x.where === 'header' ? facts.header.join('\n') : x.where === 'footer' ? facts.footer.join('\n') : x.kind === 'title' ? facts.body.slice(0, 4).join('\n') : all(facts))
    const parts = (x.fixed?.length ? x.fixed : [x.text]).filter((p) => norm(p).length >= 2)
    const missing = parts.filter((p) => !hay.includes(norm(p)))
    return { id: x.id, item: x.name, ok: !missing.length, note: missing.length ? `「${missing[0].slice(0, 40)}」이 ${whereKo(x.where)}에 없어요` : `${whereKo(x.where)}에 있어요` }
  })
}

// which form a work uses (the order above) — forms: templatesOf(task), others: forms of another task a person picked
export function resolveChosen({ choice = null, definitionTemplate = '', forms = [], picked = null } = {}) {
  const withFile = forms.filter((x) => x.file)
  if (choice) {
    const f = picked || forms.find((x) => x.name === choice.form)
    if (f?.file) return { form: f, chosenBy: 'person', ofTask: choice.of_task || null, by: choice.by_email || '', at: choice.at || null }
    if (f) return { form: withFile[0] || null, chosenBy: withFile[0] ? 'auto' : null, wanted: { name: f.name, chosenBy: 'person', why: 'no-file' } }
  }
  if (definitionTemplate) {
    const f = forms.find((x) => x.name === definitionTemplate)
    if (f?.file) return { form: f, chosenBy: 'definition' }
    if (f || withFile.length) return { form: withFile[0] || null, chosenBy: withFile[0] ? 'auto' : null, wanted: { name: definitionTemplate, chosenBy: 'definition', why: f ? 'no-file' : 'not-found' } }
  }
  return withFile[0] ? { form: withFile[0], chosenBy: 'auto' } : { form: null, chosenBy: null }
}
export const CHOSEN_KO = { person: '정해 둔 양식', definition: '정해 둔 양식', auto: '가장 많이 쓴 양식(자동)' }

// ---------- the database and the files ----------
async function choiceOf(task) {
  const [c] = await q(`select form, of_task, by_email, at from pro_form_choices where tenant_id=$1 and task=$2`, [T(), task]).catch(() => [])
  return c || null
}
async function definitionTemplateOf(task, act = null) {
  if (act) return (act.outputs || []).find((o) => o?.template)?.template || ''
  const { cypher, parseTask } = await import('./store.js')
  const [r] = await cypher('MATCH (t:Task {key:$key}) RETURN t', { key: task }).catch(() => [])
  const { taskDefinition } = await import('./taskdef.js')
  const d = r ? await taskDefinition(task, parseTask(r.t)) : { outputs: [] }
  return (d.outputs || []).find((o) => o?.template)?.template || ''
}
// the form the work uses: {form, chosenBy, …} (act: the snapshot's activity — its outputs as the case runs them)
export async function chosenForm(task, act = null) {
  const { templatesOf } = await import('./taskdef.js')
  const forms = await templatesOf(task)
  const choice = await choiceOf(task)
  const picked = choice?.of_task && choice.of_task !== task ? (await templatesOf(choice.of_task)).find((x) => x.name === choice.form) || null : null
  return resolveChosen({ choice, definitionTemplate: await definitionTemplateOf(task, act), forms, picked })
}

async function formatRow(task, form) {
  const [r] = await q(`select task, form, skill_md, items, source, by, decided, by_user::text as by_user, at from pro_form_formats where tenant_id=$1 and task=$2 and form=$3`, [T(), task, form]).catch(() => [])
  return r || null
}
// (a form picked from another work keeps that work's rules until this work has its own)
export async function formatOf(task, form, ofTask = null) { return (await formatRow(task, form)) || (ofTask && ofTask !== task ? formatRow(ofTask, form) : null) }

const isAdminOf = async (me) => (await import('./service.js')).isAdmin(me)
const dayKo = (d) => (d ? new Date(d).toLocaleDateString('sv-SE', { timeZone: process.env.PRO_TZ || 'Asia/Seoul' }) : '')

// the 「메일에서 본 양식」 of a work: which one it uses and why, each form's mails (subjects · file names · links: their owner's),
// whether its file is kept, and its format rules
export async function formsView(me, task) {
  const { templatesOf } = await import('./taskdef.js')
  const forms = await templatesOf(task)
  const choice = await choiceOf(task)
  const picked = choice?.of_task && choice.of_task !== task ? (await templatesOf(choice.of_task)).find((x) => x.name === choice.form) || null : null
  const chosen = resolveChosen({ choice, definitionTemplate: await definitionTemplateOf(task), forms, picked })
  const admin = await isAdminOf(me)
  const ids = [...new Set([...forms, ...(picked ? [picked] : [])].flatMap((f) => f.sources.filter((s) => String(s.owner) === String(me.id) && !String(s.mail).startsWith('chat:')).map((s) => s.mail)))]
  const subj = new Map((ids.length ? await q(`select mail_id, subject, provider from pro_mail_archive where tenant_id=$1 and owner_id::text=$2 and mail_id = any($3)`, [T(), String(me.id), ids]).catch(() => []) : []).map((r) => [r.mail_id, r]))
  const rows = new Map((await q(`select task, form, items, source, by, decided, at from pro_form_formats where tenant_id=$1 and task = any($2)`, [T(), [task, choice?.of_task || task]]).catch(() => [])).map((r) => [`${r.task}\u0000${r.form}`, r]))
  const shape = (f, ofTask = null) => {
    const srcs = [...f.sources].sort((a, b) => new Date(b.at) - new Date(a.at))
    const fr = rows.get(`${task}\u0000${f.name}`) || (ofTask ? rows.get(`${ofTask}\u0000${f.name}`) : null)
    return {
      name: f.name, type: f.type, seen: f.seen, fileNames: f.fileNames, fields: f.fields, hasFile: !!f.file, files: f.files.length, ofTask,
      lastAt: srcs[0]?.at || null, firstAt: srcs.at(-1)?.at || null,
      chosen: chosen.form?.name === f.name && (!ofTask || chosen.ofTask === ofTask),
      // the mails themselves: their owner's — others see when and how many
      mails: srcs.slice(0, 12).map((s) => {
        const mine = String(s.owner) === String(me.id)
        const a = mine ? subj.get(s.mail) : null
        return { at: s.at, chat: String(s.mail).startsWith('chat:'), mine, kept: !!s.file, fileName: mine ? s.name : null, subject: a?.subject || null,
          link: mine && a?.provider === 'gmail' && /^[0-9a-f]{10,}$/i.test(String(s.mail)) ? `https://mail.google.com/mail/#all/${s.mail}` : null }
      }),
      canOpen: !!f.file && (admin || f.sources.some((s) => String(s.owner) === String(me.id))),
      format: fr ? { by: fr.by, decided: fr.decided, at: fr.at, items: (fr.items || []).length, mandatory: (fr.items || []).filter((x) => x.mandatory).length, lowConfidence: !!fr.source?.lowConfidence, n: fr.source?.n || 0 } : null,
    }
  }
  const list = forms.map((f) => shape(f))
  if (picked && !list.some((x) => x.chosen)) list.unshift(shape(picked, choice.of_task))
  return {
    task, admin,
    chosen: chosen.form ? { name: chosen.form.name, chosenBy: chosen.chosenBy, label: CHOSEN_KO[chosen.chosenBy] || '', ofTask: chosen.ofTask || null, by: chosen.by || '', at: chosen.at || null } : null,
    wanted: chosen.wanted || null,
    choice: choice ? { form: choice.form, ofTask: choice.of_task || null, by: choice.by_email || '', at: choice.at } : null,
    forms: list,
  }
}

// the company's other forms (an admin picks one for a work whose mail showed none — a work found in chats). A list: no model call
// and nothing written — a form not named yet goes by the rule's name (unnamed) and is named when a person picks it (chooseForm)
export async function companyForms(exceptTask = '') {
  const { templatesOf } = await import('./taskdef.js')
  const tasks = (await q(`select activity_label as task, count(*)::int n from pro_mail_history where tenant_id=$1 and artifacts::text like '%"file"%' group by 1 order by 2 desc limit 30`, [T()])).map((r) => r.task).filter((t) => t !== exceptTask)
  const out = []
  for (const t of tasks) for (const f of await templatesOf(t, { model: false })) if (f.file) out.push({ task: t, name: f.name, type: f.type, seen: f.seen, keys: f.keys, ...(f.unnamed ? { unnamed: true } : {}), lastAt: [...f.sources].sort((a, b) => new Date(b.at) - new Date(a.at))[0]?.at || null })
  return out
}
// our own company in the forms' file names (「유엔진_바이켐_견적서」 — the sender, not the customer): the tenant's own company name when
// one is kept (company: the billing subscription's · the org chart's top), else a name the file names of forms of two or more
// different works share (byTask: [{task, forms: [{name, fileNames}]}])
export function ownNamesOf(byTask = [], company = []) {
  if (company.length) return company
  const seen = new Map()
  // (each file name by itself: a form's names all start with 유엔진솔루션즈_ — customersOf of them together would drop what they share)
  for (const { task, forms = [] } of byTask) for (const f of forms) for (const w of new Set((f.fileNames || []).flatMap((n) => customersOf([n], f.name)))) {
    if (!seen.has(w)) seen.set(w, new Set())
    seen.get(w).add(task)
  }
  return [...seen].filter(([, ts]) => ts.size >= 2).map(([w]) => w)
}
// (the org chart's top is named after the tenant id until a person names it; 「Globex (영문 데모)」 → also 「Globex」)
export async function ownNames() {
  const [b] = await q(`select company_name from pro_billing_subscriptions where tenant_id=$1`, [T()]).catch(() => [])
  const [o] = await q(`select value->'chart'->'data'->>'name' as name from configuration where key='organization' and tenant_id=$1`, [T()]).catch(() => [])
  const company = [...new Set([b?.company_name, o?.name !== T() ? o?.name : null].map(clean).filter(Boolean).flatMap((n) => [n, clean(n.replace(/\s*[(（][^)）]*[)）]\s*$/, ''))]).filter(Boolean))]
  if (company.length) return company
  const { templatesOf } = await import('./taskdef.js')
  const tasks = (await q(`select distinct activity_label as task from pro_mail_history where tenant_id=$1 and jsonb_array_length(coalesce(artifacts,'[]'::jsonb)) > 0 limit 80`, [T()]).catch(() => [])).map((r) => r.task).filter(Boolean)
  const byTask = []
  for (const t of tasks) byTask.push({ task: t, forms: (await templatesOf(t, { model: false }).catch(() => [])).map((f) => ({ name: f.name, fileNames: [...new Set(f.sources.map((s) => s.name))] })) })
  return ownNamesOf(byTask)
}
// a work's form by its name — or by its file-name keys (the company list shows a form not named yet by the rule's name): read without
// the model, then the model names that one form only (and keeps the name)
async function pickedForm(task, form, keys = null) {
  const { templatesOf } = await import('./taskdef.js')
  const has = (x) => Array.isArray(keys) && keys.length && x.keys?.some((k) => keys.includes(k))
  const list = await templatesOf(task, { model: false })
  const f = list.find((x) => has(x)) || list.find((x) => x.name === form)
  if (!f?.unnamed) return f || null
  return (await templatesOf(task, { model: f.keys })).find((x) => x.keys?.some((k) => f.keys.includes(k))) || null
}

export async function chooseForm(me, task, { form = null, ofTask = null, keys = null } = {}) {
  const { ledger } = await import('./review.js')
  if (!form) {
    await q(`delete from pro_form_choices where tenant_id=$1 and task=$2`, [T(), task])
    await ledger(me, 'ontology.form.choose', `양식 고르기 풀기: ${task} (가장 많이 쓴 양식으로)`, { task, form: null })
    return formsView(me, task)
  }
  const from = ofTask && ofTask !== task ? ofTask : task
  const f = await pickedForm(from, form, keys)
  if (!f) throw err(404, '그 양식을 찾지 못했어요.')
  if (!f.file) throw err(400, '그 양식은 메일에서 남겨 둔 파일이 없어 문서를 만들 수 없어요.')
  form = f.name   // (a form the list showed by the rule's name: the name the model gave it now)
  await q(`insert into pro_form_choices (tenant_id, task, form, of_task, by_user, by_email, at) values ($1,$2,$3,$4,$5,$6,now())
           on conflict (tenant_id, task) do update set form=excluded.form, of_task=excluded.of_task, by_user=excluded.by_user, by_email=excluded.by_email, at=now()`,
  [T(), task, form, from === task ? null : from, me.id, me.email || ''])
  await ledger(me, 'ontology.form.choose', `이 일이 쓰는 양식: ${task} → ${form}${from !== task ? ` (「${from}」의 양식)` : ''}`, { task, form, ofTask: from === task ? null : from })
  return formsView(me, task)
}

async function formByName(task, form) {
  const { templatesOf } = await import('./taskdef.js')
  const own = (await templatesOf(task)).find((x) => x.name === form)
  if (own) return { form: own, ofTask: null }
  const c = await choiceOf(task)
  if (c?.of_task && c.form === form) { const f = (await templatesOf(c.of_task)).find((x) => x.name === form); if (f) return { form: f, ofTask: c.of_task } }
  throw err(404, '그 양식을 찾지 못했어요.')
}

// a kept form file opened in 이음오피스: a copy published the way every document the editor opens is (lib/office.js) — the mailbox's
// owner or an admin only (the file is the company's last case as it was sent)
const opened = new Map()
export async function openForm(me, task, form) {
  const { form: f } = await formByName(task, form)
  if (!f.file) throw err(404, '이 양식은 메일에서 남겨 둔 파일이 없어요.')
  if (!(await isAdminOf(me)) && !f.sources.some((s) => String(s.owner) === String(me.id))) throw err(403, '양식 파일은 그 메일함의 주인이나 관리자만 열 수 있어요.')
  const { templatePath } = await import('./taskdef.js')
  const p = templatePath(f.file)
  const st = await fs.promises.stat(p).catch(() => null)
  if (!st) throw err(404, '양식 파일이 없어졌어요. 메일을 다시 읽으면 다시 남겨요.')
  const key = `${T()}:${p}:${st.mtimeMs}`
  if (opened.has(key)) return opened.get(key)
  const { publishBuffer } = await import('../office.js')
  const name = `양식_${f.name}`.replace(/[\\/:*?"<>|]/g, ' ')
  const doc = await publishBuffer(me.id, name.endsWith(`.${f.type}`) ? name : `${name}.${f.type}`, await fs.promises.readFile(p))
  opened.set(key, doc)
  return doc
}

// ---------- mining ----------
// the form's files: the kept ones, then — up to maxFiles — the same form's attachments on other mails, read once from the owner's
// mailbox (an attachment id kept in the mail archive) and not kept on disk
async function filesOfForm(f, R, { fetchMail = true } = {}) {
  const { templatePath } = await import('./taskdef.js')
  const out = [], hashes = new Set()
  for (const rel of f.files || []) {
    const p = templatePath(rel)
    if (!fs.existsSync(p)) continue
    const buf = fs.readFileSync(p), h = sha(buf)
    if (hashes.has(h)) continue
    hashes.add(h); out.push({ name: path.basename(p), buf, from: 'kept' })
  }
  const max = R.maxFiles || 6
  if (!fetchMail || R.fetchFromMail === false || out.length >= max) return out
  const srcs = [...f.sources].filter((s) => s.mail && !String(s.mail).startsWith('chat:')).sort((a, b) => new Date(b.at) - new Date(a.at))
  const tokens = new Map()
  const names = new Set()
  for (const s of srcs) {
    if (out.length >= max) break
    if (names.has(s.name) && srcs.some((x) => !names.has(x.name))) continue
    try {
      const [a] = await q(`select provider, attachments from pro_mail_archive where tenant_id=$1 and owner_id::text=$2 and mail_id=$3`, [T(), String(s.owner), s.mail])
      const att = (a?.attachments || []).find((x) => x.name === s.name && x.attachment_id)
      if (a?.provider !== 'gmail' || !att) continue
      if (!tokens.has(s.owner)) tokens.set(s.owner, await (await import('../mail.js')).googleAccessToken(s.owner).catch(() => null))
      const tok = tokens.get(s.owner)
      if (!tok) continue
      const { gmailApi } = await import('./history.js')
      const r = await fetch(`${gmailApi()}/messages/${encodeURIComponent(s.mail)}/attachments/${encodeURIComponent(att.attachment_id)}`, { headers: { Authorization: `Bearer ${tok}` } })
      if (!r.ok) continue
      const j = await r.json()
      const buf = Buffer.from(String(j.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      const h = sha(buf)
      names.add(s.name)
      if (!buf.length || hashes.has(h)) continue
      hashes.add(h); out.push({ name: s.name, buf, from: 'mail' })
    } catch (e) { console.warn('[formats] mail file', e.message) }
  }
  return out
}

// rule-first, then one model reading of the candidates (judge.js) — stored as the AI's (not decided) until a person saves it
export async function mineFormat(me, task, form, { fetchMail = true } = {}) {
  const R = (await skillRules()).formats || R0()
  const { form: f, ofTask } = await formByName(task, form)
  const files = await filesOfForm(f, R, { fetchMail })
  if (!files.length) throw err(400, '이 양식은 읽을 파일이 없어 형식 규칙을 찾지 못해요.')
  const facts = []
  for (const x of files) { try { facts.push(await docFacts(x.name, x.buf, R)) } catch (e) { console.warn('[formats] read', x.name, e.message) } }
  if (!facts.length) throw err(400, '양식 파일을 읽지 못했어요.')
  const fileNames = [...new Set((f.sources || []).map((s) => s.name))]
  const cands = candidatesOf(facts, { fileNames, form: f.name }, R)
  const lowConfidence = facts.length < (R.minFiles || 2)
  const customers = customersOf(fileNames, f.name)
  let answer = null, model = null
  if (cands.length) {
    try {
      const { judge } = await import('./judge.js')
      const input = { form: f.name, type: f.type, files: facts.length, low_confidence: lowConfidence,
        candidates: cands.map((c) => ({ id: c.id, kind: c.kind, where: whereKo(c.where), text: maskText(c.text, { customers, people: R.people }).slice(0, 300), in_files: `${c.files}/${c.of}` })) }
      const r = await judge(await prompt('format-rules'), JSON.stringify(input), R)
      answer = r.r; model = r.model
    } catch (e) { console.warn('[formats] judge', e.message) }
  }
  const items = judgedItems(cands, answer, { lowConfidence })
  const source = { n: facts.length, kept: files.filter((x) => x.from === 'kept').length, fetched: files.filter((x) => x.from === 'mail').length, files: files.map((x) => ({ name: x.name, from: x.from })),
    lowConfidence, candidates: cands.length, model, ofTask, at: new Date().toISOString() }
  const md = skillText({ task, form: f.name, type: f.type, items, source })
  await q(`insert into pro_form_formats (tenant_id, task, form, skill_md, items, source, by, decided, by_user, at) values ($1,$2,$3,$4,$5,$6,'ai',false,$7,now())
           on conflict (tenant_id, task, form) do update set skill_md=excluded.skill_md, items=excluded.items, source=excluded.source, by='ai', decided=false, by_user=excluded.by_user, at=now()`,
  [T(), task, f.name, md, JSON.stringify(items), JSON.stringify(source), me?.id || null])
  return formatView(me, task, f.name)
}

// the rules of a form this work picked from another work are that work's until this one saves or finds its own
async function ownOrPicked(task, form) {
  const c = await choiceOf(task)
  return formatOf(task, form, c?.form === form ? c.of_task : null)
}
export async function formatView(me, task, form) {
  const r = await ownOrPicked(task, form)
  return { task, form, admin: me ? await isAdminOf(me) : false, format: r ? { ...r, whereKo: Object.fromEntries((r.items || []).map((x) => [x.id, whereKo(x.where)])) } : null }
}

// a person's edit: the items' mandatory ticks (the skill text is written again from them) or the skill text itself (kept as written)
export async function saveFormat(me, task, form, { items = null, skill_md = null } = {}) {
  const r = await ownOrPicked(task, form)
  if (!r) throw err(404, '아직 이 양식의 형식 규칙이 없어요. 먼저 찾아 주세요.')
  let next = r.items || []
  if (Array.isArray(items)) {
    const want = new Map(items.filter((x) => x?.id).map((x) => [x.id, x]))
    next = next.filter((x) => !(want.get(x.id)?.removed)).map((x) => (want.has(x.id) ? { ...x, mandatory: want.get(x.id).mandatory === true, ...(want.get(x.id).name ? { name: String(want.get(x.id).name).slice(0, 60) } : {}), by: 'person' } : x))
  }
  const md = typeof skill_md === 'string' && skill_md.trim() ? skill_md : skillText({ task, form, type: String(form).split('.').pop(), items: next, source: r.source || {} })
  await q(`insert into pro_form_formats (tenant_id, task, form, skill_md, items, source, by, decided, by_user, at) values ($1,$2,$3,$5,$4,$7,'person',true,$6,now())
           on conflict (tenant_id, task, form) do update set items=excluded.items, skill_md=excluded.skill_md, by='person', decided=true, by_user=excluded.by_user, at=now()`,
  [T(), task, form, JSON.stringify(next), md, me.id, JSON.stringify(r.source || {})])
  const { ledger } = await import('./review.js')
  await ledger(me, 'ontology.form.format', `형식 규칙 저장: ${task} · ${form} (꼭 지킬 것 ${next.filter((x) => x.mandatory).length}개)`, { task, form, mandatory: next.filter((x) => x.mandatory).map((x) => x.name), text: typeof skill_md === 'string' })
  return formatView(me, task, form)
}

// a made file checked against its form's mandatory items → [{item, ok, note}] (no rules yet → [])
export async function checkFile(task, form, { name, buf = null, url = null, ofTask = null } = {}) {
  const r = await formatOf(task, form, ofTask)
  if (!r || !(r.items || []).some((x) => x.mandatory)) return []
  try {
    const b = buf || Buffer.from(await (await fetch(url)).arrayBuffer())
    const facts = await docFacts(name, b, (await skillRules()).formats || R0())
    return checkFormat(r.items, facts, name).map(({ item, ok, note }) => ({ item, ok, note }))
  } catch (e) { return r.items.filter((x) => x.mandatory).map((x) => ({ item: x.name, ok: null, note: `파일을 읽지 못했어요(${e.message.slice(0, 60)})` })) }
}

// ---------- 스킬 보기: the text of a skill a work's definition names ----------
// the step skills Lite runs itself (run.js ONTO_SKILLS · mining/worker.js SKILLS): a short description of what the code does
export const STEP_SKILLS_DIR = path.join(BUNDLED_DIR, 'step-skills')
export async function skillTextOf(me, name, { jwt = '' } = {}) {
  const n = String(name || '').trim()
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,80}$/u.test(n)) throw err(400, '스킬 이름이 올바르지 않아요.')
  const builtIn = path.join(STEP_SKILLS_DIR, `${n}.md`)
  if (fs.existsSync(builtIn)) return { name: n, kind: 'step', source: 'Lite 에 들어 있는 단계 스킬', markdown: fs.readFileSync(builtIn, 'utf8'), editable: false }
  // a tenant skill (a way the company picked, ways.js; or one installed in the skills screen): deepagents serves its SKILL.md
  if (jwt) {
    try {
      const { getSkill } = await import('../skills.js')
      const s = await getSkill(jwt, n)
      return { name: n, kind: 'tenant', source: '회사 스킬', markdown: s.markdown, files: s.files || [], editable: false }
    } catch { /* not served: what the way stored */ }
  }
  const W = await import('./ways.js')
  const w = (await W.waysFor(null).catch(() => [])).find((x) => x.skill === n || x.skill_name === n || W.skillOf(x).name === n)
  if (w) return { name: n, kind: 'tenant', source: '회사가 고른 방법(스킬 서버에서 읽지 못해, 그 방법으로 다시 쓴 글)', markdown: W.skillOf(w).md, editable: false }
  const known = ((await skillRules()).candidates?.skills || []).find((x) => x.name === n)
  return { name: n, kind: 'none', source: '', markdown: `# ${n}\n\n이 이름의 스킬은 아직 없어요.${known ? ` 지도가 「${known.does}」에 쓰는 스킬 이름으로 제안한 것이에요.` : ''} 지금은 에이전트가 일 정의의 지침대로 해요.\n`, editable: false }
}
