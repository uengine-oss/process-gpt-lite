// 문서 양식 채우기(도구 없이)와 글을 워드 파일로 — 프로세스 지도의 단계가 문서를 만들 때(run.js runStep).
// 워드 · 파워포인트 · 한글 양식: 회사 파일의 문단 목록과 이 건을 Lite 의 모델에 보내(prompts/fill-document.md) 바꿀 문단 · 더할 문단만 받고,
// 그 문단의 글(w:t · a:t · hp:t)만 파일의 XML 에서 고친다 — 그림 · 표 · 서식 · 머리글의 로고는 그대로. 형식 규칙의 꼭 지킬 글이 든 문단은
// 모델이 바꾸라고 해도 그대로 둔다. 에이전트(도구를 가진 deepagents)에 맡기지 않으니 메일 · 일정 · 메신저에 아무것도 하지 않는다.
// 양식 파일이 없으면 doc-draft 가 쓴 글(마크다운)을 간단한 워드 파일로 만든다(새 의존성 없이 jszip 으로).
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { paragraphsOf, clean } from './formats.js'

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const SPEC = {
  docx: { ns: 'w', parts: (n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n), part: (n) => (n === 'word/document.xml' ? 'body' : n.includes('header') ? 'header' : 'footer'), add: true, empty: true },
  pptx: { ns: 'a', parts: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n), part: (n) => `slide${n.match(/slide(\d+)\.xml$/)[1]}`, add: true, empty: true },
  hwpx: { ns: 'hp', parts: (n) => /^Contents\/section\d+\.xml$/.test(n), part: () => 'body', add: false, empty: false },
}
export const fillable = (kind) => !!SPEC[kind]

// the paragraphs a model may change: with text, or (docx · pptx) an empty one in a table cell — a blank to fill in
export async function docParagraphs(buf, kind, { max = 400, chars = 400 } = {}) {
  const S = SPEC[kind]
  const zip = await JSZip.loadAsync(buf)
  const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir && S.parts(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  // the body first, then headers and footers
  const rank = (n) => ({ body: 0, header: 1, footer: 2 }[S.part(n)] ?? 0)
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }))
  const parts = [], list = []
  let i = 0
  for (const file of files) {
    const xml = await zip.file(file).async('string')
    const cells = S.empty ? [...xml.matchAll(new RegExp(`<${S.ns}:tc\\b[\\s\\S]*?</${S.ns}:tc>`, 'g'))].map((m) => [m.index, m.index + m[0].length]) : []
    const paras = paragraphsOf(xml, S.ns).map((p) => ({ ...p, i: i++, part: S.part(file), cell: cells.some(([a, b]) => p.start >= a && p.end <= b) }))
    parts.push({ file, xml, paras })
    for (const p of paras) if (list.length < max && (clean(p.text) || (S.empty && p.cell))) list.push({ i: p.i, part: p.part, text: clean(p.text).slice(0, chars), ...(p.cell ? { cell: true } : {}) })
  }
  return { zip, parts, list }
}

// one paragraph's text: the first text run takes it, the others are emptied (their formatting, pictures and fields stay); a paragraph
// with no text run gets one
export function setParagraphText(pxml, ns, text) {
  const tRe = new RegExp(`(<${ns}:t(?:\\s[^>]*)?>)([\\s\\S]*?)(</${ns}:t>)`, 'g')
  let first = true, any = false
  const out = pxml.replace(tRe, (all, open, inner, close) => {
    any = true
    const v = first ? esc(text) : ''
    first = false
    const o = ns === 'w' && v && !/xml:space=/.test(open) ? open.replace(/>$/, ' xml:space="preserve">') : open
    return `${o}${v}${close}`
  })
  if (any || !String(text || '').length) return out
  const run = ns === 'w' ? `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : ns === 'a' ? `<a:r><a:t>${esc(text)}</a:t></a:r>` : `<hp:run charPrIDRef="0"><hp:t>${esc(text)}</hp:t></hp:run>`
  if (/\/>$/.test(pxml) && !new RegExp(`</${ns}:p>$`).test(pxml)) return pxml.replace(/\s*\/>$/, `>${run}</${ns}:p>`)
  if (ns === 'a' && /<a:endParaRPr\b/.test(pxml)) return pxml.replace(/<a:endParaRPr\b/, `${run}<a:endParaRPr`)
  return pxml.replace(new RegExp(`</${ns}:p>$`), `${run}</${ns}:p>`)
}
// a copy of a paragraph for text added after it: its look, without its pictures or bookmarks (their ids must stay unique)
export function cloneParagraph(pxml, ns, text) {
  const bare = pxml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>|<w:pict>[\s\S]*?<\/w:pict>|<mc:AlternateContent>[\s\S]*?<\/mc:AlternateContent>|<w:bookmark(?:Start|End)\b[^>]*\/>/g, '')
  return setParagraphText(bare, ns, text)
}
// the edits a model gave, applied to one part's XML (paragraph ranges from docParagraphs)
export function applyEdits(xml, paras, edits, ns, { allowAdd = true } = {}) {
  let out = '', at = 0
  for (const p of paras) {
    const e = edits.get(p.i)
    if (!e) continue
    out += xml.slice(at, p.start)
    let next = e.text != null ? setParagraphText(p.xml, ns, e.text) : p.xml
    if (allowAdd && e.add?.length) next += e.add.map((t) => cloneParagraph(p.xml, ns, t)).join('')
    out += next
    at = p.end
  }
  return out + xml.slice(at)
}

const normK = (s) => String(s || '').replace(/[\s_·|:：\-–—.,()[\]…「」'"]+/g, '').toLowerCase()
// a model's answer → edits by paragraph number; a paragraph that holds a format rule's fixed text stays as it is
export function editsOf(answer, list, keep = []) {
  const known = new Map(list.map((p) => [p.i, p]))
  const fixed = keep.map(normK).filter((k) => k.length >= 4)
  const edits = new Map(), kept = []
  for (const x of answer?.paragraphs || []) {
    const i = Number(x?.i)
    const p = known.get(i)
    if (!p) continue
    const text = x.text == null ? null : String(x.text).replace(/\r/g, '')
    const lines = text == null ? [] : text.split('\n')
    if (p.text && fixed.some((k) => normK(p.text).includes(k))) {
      if (text != null && normK(text) !== normK(p.text)) kept.push(i)
      if (!Array.isArray(x.add) || !x.add.length) continue
      edits.set(i, { text: null, add: x.add.map(String).slice(0, 40) })
      continue
    }
    if (text != null && clean(text) === clean(p.text) && !x.add?.length) continue
    edits.set(i, { text: text == null ? null : lines[0], add: [...lines.slice(1), ...(Array.isArray(x.add) ? x.add.map(String) : [])].filter((l, k, a) => l.trim() || k < a.length - 1).slice(0, 40) })
  }
  return { edits, kept }
}

// fill a company form (docx · pptx · hwpx) for this case, no tools → {buf, changed, added, summary, assumptions, title, kept}
export async function fillDocument({ template, kind, input, keep = [], ask, max = 400, chars = 400 }) {
  const buf = await fsp.readFile(template.path)
  const { zip, parts, list } = await docParagraphs(buf, kind, { max, chars })
  const r = await ask({ ...input, keep: keep.slice(0, 20), paragraphs: list })
  const { edits, kept } = editsOf(r, list, keep)
  if (!edits.size) throw new Error('양식에서 바꿀 문단을 정하지 못했어요')
  const S = SPEC[kind]
  for (const p of parts) {
    const mine = new Map([...edits].filter(([i]) => p.paras.some((x) => x.i === i)))
    if (mine.size) zip.file(p.file, applyEdits(p.xml, p.paras, mine, S.ns, { allowAdd: S.add }))
  }
  const added = [...edits.values()].reduce((s, e) => s + (S.add ? e.add?.length || 0 : 0), 0)
  return { buf: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), changed: [...edits.values()].filter((e) => e.text != null).length, added, kept: kept.length,
    summary: String(r?.summary || '').slice(0, 200), assumptions: (r?.assumptions || []).map(String).slice(0, 8), title: String(r?.title || '').slice(0, 120) }
}

// ---------- 글 → 워드 ----------
const run = (t, { b = false } = {}) => `<w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`
// **굵게** as bold runs
const runs = (s) => String(s).split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((x) => (/^\*\*[^*]+\*\*$/.test(x) ? run(x.slice(2, -2), { b: true }) : run(x.replace(/`/g, '')))).join('')
const para = (s, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs(s)}</w:p>`
function table(rows) {
  const cells = rows.map((r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))
  const n = Math.max(...cells.map((r) => r.length))
  const w = Math.floor(9000 / n)
  const tr = (r, head) => `<w:tr>${Array.from({ length: n }, (_, k) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF7"/>' : ''}</w:tcPr><w:p>${head ? run(r[k] || '', { b: true }) : runs(r[k] || '')}</w:p></w:tc>`).join('')}</w:tr>`
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFC5CE"/>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: n }, () => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${cells.map((r, i) => tr(r, i === 0)).join('')}</w:tbl>`
}
export function markdownBody(text) {
  const out = []
  const lines = String(text || '').replace(/\r/g, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(lines[i]); i++ }
      i--
      if (rows.length) out.push(table(rows))
      continue
    }
    const h = l.match(/^(#{1,3})\s+(.*)$/)
    if (h) { out.push(para(h[2], `Heading${h[1].length}`)); continue }
    const li = l.match(/^\s*[-*•]\s+(.*)$/)
    if (li) { out.push(para(`• ${li[1]}`, 'ListParagraph')); continue }
    if (!l.trim()) continue
    out.push(para(l.trim()))
  }
  return out.join('')
}
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/><w:sz w:val="21"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style>
</w:styles>`
// a draft's text as a Word file: the title, then the markdown's headings, lists, tables and paragraphs
export async function textDocx({ title = '', text = '' }) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
  zip.file('word/styles.xml', STYLES)
  // the text's own first heading is the title when it says the same
  const body = String(text || '').replace(/^\s*#\s+(.+)\n/, (m, h) => (clean(h) === clean(title) ? '' : m))
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${title ? para(title, 'Title') : ''}${markdownBody(body)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1300" w:bottom="1440" w:left="1300" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// a made file into the owner's workspace, published for the editor and put on the case's conversation (the way the xlsx form fill does)
export async function keepFile(owner, threadId, name, buf) {
  const { workspaceHostPath } = await import('../missions.js')
  const { publish } = await import('../office.js')
  const { addMessage } = await import('../store.js')
  const safe = String(name).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
  const rel = `/workspace/forms-out/${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}/${safe}`
  const host = await workspaceHostPath('/workspace') + rel.slice('/workspace'.length)
  await fsp.mkdir(path.dirname(host), { recursive: true })
  await fsp.writeFile(host, buf)
  const doc = await publish(owner, rel)
  if (threadId) await addMessage(owner, threadId, 'agent', 'file', { ...doc, path: rel })
  return { name: doc.name, url: doc.url }
}
