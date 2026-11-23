// 문서 양식 채우기(도구 없이)와 글을 워드 파일로 — 프로세스 지도의 단계가 문서를 만들 때(run.js runStep).
// 워드 · 파워포인트 · 한글 양식: 회사 파일의 문단 목록과 이 건을 Lite 의 모델에 보내(prompts/fill-document.md) 바꿀 문단 · 더할 문단만 받고,
// 그 문단의 글(w:t · a:t · hp:t)만 파일의 XML 에서 고친다 — 그림 · 표 · 서식 · 머리글의 로고는 그대로. 형식 규칙의 꼭 지킬 글이 든 문단은
// 모델이 바꾸라고 해도 그대로 둔다. 에이전트(도구를 가진 deepagents)에 맡기지 않으니 메일 · 일정 · 메신저에 아무것도 하지 않는다.
// 양식 파일은 회사가 보낸 지난 건 그대로라 그 건의 고객 · 사람 이름, 날짜, 금액이 들어 있다(앞 건의 값): 규칙이 먼저 찾아(파일 이름의 고객 부분 ·
// 같은 양식의 다른 파일과 같은 자리에서 다른 글 · 칸 이름 옆의 값 · 머리글과 첫 문단의 날짜, 못 찾으면 모델이 적은 것) 모델에 알리고, 머리글 ·
// 바닥글과 그 값이 든 문단은 긴 본문에 밀리지 않고 늘 보낸다. 채운 뒤에도 남았으면 그 문단만 한 번 더 묻고, 그래도 남으면 단계 결과에
// 못 지킨 점검(「앞 건의 이름이 남았어요: …」)으로 남긴다 — 조용히 넘어가지 않는다.
// 양식 파일이 없으면 doc-draft 가 쓴 글(마크다운)을 간단한 워드 파일로 만든다(새 의존성 없이 jszip 으로).
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { paragraphsOf, clean, commonPattern, customersOf, docFacts } from './formats.js'

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const SPEC = {
  docx: { ns: 'w', parts: (n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n), part: (n) => (n === 'word/document.xml' ? 'body' : n.includes('header') ? 'header' : 'footer'), add: true, empty: true },
  pptx: { ns: 'a', parts: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n), part: (n) => `slide${n.match(/slide(\d+)\.xml$/)[1]}`, add: true, empty: true },
  hwpx: { ns: 'hp', parts: (n) => /^Contents\/section\d+\.xml$/.test(n), part: () => 'body', add: false, empty: false },
}
export const fillable = (kind) => !!SPEC[kind]

// a document's fillable parts as they are now in the zip (the body first, then headers and footers), each paragraph numbered
async function readParts(zip, S) {
  const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir && S.parts(n))
  const rank = (n) => ({ body: 0, header: 1, footer: 2 }[S.part(n)] ?? 0)
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }))
  const parts = []
  let i = 0
  for (const [f, file] of files.entries()) {
    const xml = await zip.file(file).async('string')
    const span = (tag) => (S.empty ? [...xml.matchAll(new RegExp(`<${S.ns}:${tag}\\b[\\s\\S]*?</${S.ns}:${tag}>`, 'g'))].map((m) => [m.index, m.index + m[0].length]) : [])
    const cells = span('tc'), rows = span('tr')
    const paras = paragraphsOf(xml, S.ns).map((p) => {
      const c = cells.findIndex(([a, b]) => p.start >= a && p.end <= b)
      const r = c < 0 ? -1 : rows.findIndex(([a, b]) => cells[c][0] >= a && cells[c][1] <= b)
      // (a table cell's place: its row and its column in that row — a label cell and the value beside it)
      const at = r < 0 ? {} : { row: `${f}:${r}`, col: cells.filter(([a]) => a >= rows[r][0] && a < cells[c][0]).length }
      return { ...p, i: i++, part: S.part(file), cell: c >= 0, ...at }
    })
    parts.push({ file, xml, paras })
  }
  return parts
}
const FRAME_PART = new Set(['header', 'footer'])
// the paragraphs a model is shown, in the document's order: every header · footer paragraph and every paragraph `must` names (one that
// holds a value of the form's own case) always — a long body must not push them out — then the body up to `max`
export function pickParagraphs(parts, { max = 400, chars = 400, empty = true, must = () => false } = {}) {
  const all = parts.flatMap((p) => p.paras).filter((p) => clean(p.text) || (empty && p.cell))
  const need = new Set(all.filter((p) => clean(p.text) && (FRAME_PART.has(p.part) || must(p))).map((p) => p.i))
  let room = Math.max(0, max - need.size)
  return all.filter((p) => need.has(p.i) || (room > 0 && room--)).map((p) => ({ i: p.i, part: p.part, text: clean(p.text).slice(0, chars), ...(p.cell ? { cell: true } : {}) }))
}
// the paragraphs a model may change: with text, or (docx · pptx) an empty one in a table cell — a blank to fill in
export async function docParagraphs(buf, kind, { max = 400, chars = 400, must } = {}) {
  const S = SPEC[kind]
  const zip = await JSZip.loadAsync(buf)
  const parts = await readParts(zip, S)
  return { zip, parts, list: pickParagraphs(parts, { max, chars, empty: S.empty, must }) }
}

// ---------- 앞 건의 값: a form file is the company's last case as it was sent — its customer's · people's names, dates and amounts ----------
const DATE = /(?:\d{4}|\d{2})\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?/g
const squash = (s) => String(s || '').replace(/\s+/g, '')
// a company's name to compare (유엔진㈜ · (주)유엔진 · 주식회사 유엔진 · uEngine → one)
export const coName = (s) => squash(s).replace(/㈜|\(주\)|（주）|주식회사/g, '').toLowerCase()
const blankish = (s) => !/[\p{L}\p{N}]/u.test(s) || /_{3,}|□|☐|■|○○/.test(s)
const LABELS = '기업명|회사명|업체명|고객명|고객사|기관명|대상기업|기업|회사|기관|학교|학과|대표자|설립|설립일|팀명|팀원|팀|담당자|작성자|요청자|신청자|진행자|기록자|응대자|성명|이름|작성일|제출일|요청일|방문일|일시|날짜|일자|기간|금액|합계|총액|과제명|프로젝트명|건명|사업명|강의명|과목명'
// labels whose value is a case's own name even when it reads like plain words (과제명(잠정) | 물류 최적화)
const NAME_LABELS = '과제명|프로젝트명|강의명|과목명|건명|사업명|기업명|회사명|업체명|고객명|기관명|성명|이름'
const GENERIC = '^(고객사?|회사|업체명?|기업|기관|양식|템플릿|서식|최종|수정|사본|초안|복사본|버전|자료|문서|파일|첨부|제출|작성|new|copy|final|draft)'
// the template's words outside what it shares with another file at the same place (its header · footer · title) — none when the two
// hardly share anything (different documents, not one form with different values)
function diffRuns(t, o) {
  const p = commonPattern([t, o])
  const n = clean(t).split(' ').length, shared = p.fixed.join(' ').split(/\s+/).filter(Boolean).length
  if (!shared || shared < Math.ceil(n * 0.3)) return []
  const runs = []
  let rest = clean(t)
  for (const f of p.fixed) { const k = rest.indexOf(f); if (k < 0) break; runs.push(rest.slice(0, k)); rest = rest.slice(k + f.length) }
  return [...runs, rest].map(clean).filter(Boolean)
}
// strings of the form file that belong to its own case, rule first: the customer part of the names the company gave the form's files and
// of the template file's own name · what differs from the form's other kept files at the same place · a value next to a case label
// (팀 명 | 1팀 · 작성일: 26.11.05) · a full date on the frame. Only what the template has, not what this case's request says too, and
// (with other files) not what every file of the form has. lines: the template's paragraphs [{text, part, cell}]; others: docFacts;
// own: our own company's names (formats.js ownNames — a file name's sender, the 업체명 beside our quote: never the last case's);
// sheet: a workbook's cells (xlsxLines) — a table's heading row reads like 「label | word」, so there a plain word beside a label is a
// value only under a name · person label.
export function sourceCaseStrings({ form = '', templateName = '', lines = [], others = [], fileNames = [], caseText = '', own = [], sheet = false, R = {} } = {}) {
  const label = new RegExp(`^[가-힣]{0,4}(?:${R.caseLabels || LABELS})$`)
  const generic = new RegExp(R.genericNames || GENERIC, 'i')
  const maxChars = R.caseValueChars || 40
  const all = lines.map((l) => clean(l.text)).filter(Boolean).join('\n')
  const otherTexts = others.map((f) => [...(f.header || []), ...(f.footer || []), ...(f.body || []), ...(f.master || [])].map(clean).join('\n'))
  const formStem = squash(String(form).replace(/\.[a-z0-9]+$/i, ''))
  const caseT = clean(caseText)
  const out = new Map()
  const ours = new Set(own.map(coName).filter(Boolean))
  const add = (t, why) => {
    const s = clean(t).replace(/^[\s|·:：,;()[\]「」'"-]+|[\s|·:：,;([「'"-]+$/g, '')
    if (s.length < 2 || s.length > maxChars || blankish(s) || out.has(s) || /^\d{1,3}$/.test(s) || ours.has(coName(s))) return
    if (generic.test(s) || formStem.includes(squash(s)) || !all.includes(s) || caseT.includes(s)) return
    if (otherTexts.length && otherTexts.every((o) => o.includes(s))) return
    out.set(s, why)
  }
  const nameLabel = new RegExp(`^[가-힣]{0,4}(?:${R.caseNameLabels || NAME_LABELS})$`)
  const keyOf = (x) => squash(x).replace(/[)）:：]/g, '')
  const labelWords = (s) => String(s).split(/[(/·（]/).map(keyOf).filter((k) => k.length >= 1 && k.length <= 10 && label.test(k))
  const isLabel = (s) => labelWords(s).length > 0
  // a value, not a column heading beside another: a number or date, a company mark, a name the rules found, a short name-like word
  // (김현석 · 한빛정밀), or anything short under a name label
  const nameRule = () => [...out].filter(([, w]) => w === 'name').map(([t]) => t)
  const personLabel = /(담당자|작성자|요청자|신청자|진행자|기록자|응대자|대표자|팀원)$/
  const valueLike = (v, labels) => /\d/.test(v) || /㈜|\(주\)|주식회사|\b(Inc|Co|Ltd|Corp)\b/i.test(v) || nameRule().some((n) => v.includes(n))
    || (!sheet && /^[가-힣A-Za-z]{2,8}$/.test(v)) || (labels.some((k) => nameLabel.test(k) || (sheet && personLabel.test(k))) && v.length <= 24)
  const value = (v, lab, why) => {
    const s = clean(v)
    if (!s || isLabel(s) || blankish(s)) return
    const labs = String(lab).split(/\s*\/\s*/), vals = s.split(/\s*\/\s*/)
    // 「기업명 / 대표자 / 설립」 | 「고모텍㈜ / 대표자 윤일진 / 1999년 3월 설립」: piece by piece
    const pairs = labs.length >= 2 && labs.length === vals.length ? labs.map((l, k) => [labelWords(l), vals[k]]) : [[labelWords(lab), s]]
    for (const [words, val] of pairs) {
      if (!words.length) continue
      let x = clean(val)
      for (const w of words) if (squash(x).startsWith(w) && squash(x) !== w) x = x.replace(new RegExp(`^${[...w].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')}\\s*[:：]?\\s*`), '')
      const pieces = x.split(/\s*[/,]\s*/).filter(Boolean)
      for (const p of pieces.length >= 2 && pieces.every((y) => y.length <= 12) ? pieces : [x]) if (valueLike(p, words)) add(p, why)
    }
  }
  // 1) names: the customer part of the file names (customersOf: what is not the form's name nor shared by all of them) and of the
  // template file's own name (forms/고모텍.docx) — not our own company's name (「유엔진_바이켐_견적서」: 유엔진 sent it — add skips it)
  for (const w of customersOf(fileNames, form)) add(w, 'name')
  for (const w of String(templateName).replace(/\.[a-z0-9]+$/i, '').split(/[_\s()[\]·,]+/)) if (!/^[\d.\-v]+$/i.test(w) && !/^\d{2,4}(년|월|일)/.test(w)) add(w, 'name')
  // 2) what differs from the other kept files at the same place
  const at = (part) => lines.filter((l) => l.part === part).map((l) => clean(l.text)).filter(Boolean).join(' | ')
  const body = lines.filter((l) => !FRAME_PART.has(l.part)).map((l) => clean(l.text)).filter(Boolean)
  const slots = { header: at('header'), footer: at('footer'), title: body[0] || '' }
  for (const f of others) {
    const theirs = { header: (f.header || []).join(' | '), footer: (f.footer || []).join(' | '), title: (f.body || [])[0] || '' }
    for (const k of Object.keys(slots)) if (slots[k] && theirs[k]) for (const r of diffRuns(slots[k], theirs[k])) add(r, 'differs')
  }
  // 3) a case's value by its label: 「작성일: 26.11.05」 in a line, or the table cell right beside a label cell in its row
  const cellText = new Map()
  for (const l of lines) if (l.row != null) { const k = `${l.row}\u0000${l.col}`; cellText.set(k, clean(`${cellText.get(k) || ''} ${l.text}`)) }
  const done = new Set()
  for (const l of lines) {
    for (const seg of String(l.text).split(/\s{2,}|\s[|｜]\s|\t/)) { const m = seg.match(/^\s*([^:：]{1,14}?)\s*[:：]\s*(.+)$/); if (m && isLabel(m[1])) value(m[2], m[1], 'label') }
    if (l.row == null || done.has(`${l.row}\u0000${l.col}`)) continue
    done.add(`${l.row}\u0000${l.col}`)
    const lab = cellText.get(`${l.row}\u0000${l.col}`) || ''
    const next = cellText.get(`${l.row}\u0000${l.col + 1}`) || ''
    if (lab.length <= 30 && isLabel(lab) && next && next.length <= maxChars * 2) value(next, lab, 'label')
  }
  // 4) a full date on the frame: the header · footer and the first paragraphs
  for (const t of [slots.header, slots.footer, ...body.slice(0, R.firstParagraphs || 8)]) for (const m of t.matchAll(DATE)) add(m[0], 'date')
  return [...out].map(([text, why]) => ({ text, why })).slice(0, R.caseStrings || 30)
}
// the paragraphs that still hold any of these strings (fixed: one a format rule protects — the fill leaves it as it is)
export function leftoversOf(parts, strings, keep = []) {
  const fixed = keep.map(normK).filter((k) => k.length >= 4)
  const out = []
  if (!strings.length) return out
  for (const p of parts) for (const x of p.paras) {
    const t = clean(x.text)
    const found = t ? strings.filter((s) => t.includes(s)) : []
    if (found.length) out.push({ i: x.i, part: x.part, text: t, found, ...(x.cell ? { cell: true } : {}), fixed: fixed.some((k) => normK(t).includes(k)) })
  }
  return out
}
const PART_KO = { body: '본문', header: '머리글', footer: '바닥글' }
export const partKo = (p) => PART_KO[p] || (/^slide\d+$/.test(p) ? `슬라이드 ${p.slice(5)}` : p)

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

function applyAll(zip, parts, edits, S) {
  for (const p of parts) {
    const mine = new Map([...edits].filter(([i]) => p.paras.some((x) => x.i === i)))
    if (mine.size) zip.file(p.file, applyEdits(p.xml, p.paras, mine, S.ns, { allowAdd: S.add }))
  }
}
const caseTextOf = (input) => [input?.case?.subject, input?.case?.body, input?.case?.customer].filter(Boolean).join('\n')
// what the model said of the form's own case, when the rules found nothing: only strings the form has, outside the format rules' text
export function modelCaseStrings(listed, { lines = [], keep = [], caseText = '', max = 30 } = {}) {
  const all = lines.map((l) => clean(l.text)).join('\n'), caseT = clean(caseText)
  const fixed = keep.map(normK).filter((k) => k.length >= 2)
  const out = []
  for (const x of Array.isArray(listed) ? listed : []) {
    const s = clean(x)
    if (s.length < 2 || s.length > 60 || out.includes(s) || !all.includes(s) || caseT.includes(s) || fixed.some((k) => k.includes(normK(s)))) continue
    out.push(s)
  }
  return out.slice(0, max)
}

// fill a company form (docx · pptx · hwpx) for this case, no tools → {buf, changed, added, summary, assumptions, title, kept, sourceCase,
// left, leftWhere, leftFixed, retried}. The form's own case (source: its other kept files and file names → sourceCaseStrings) is told to
// the model; after filling, a paragraph that still holds one of those strings is asked once more, and what stays is reported (left) —
// a document made for this case never passes silently with the last customer's name in it
export async function fillDocument({ template, kind, input, keep = [], ask, max = 400, chars = 400, source = {}, rules = {} }) {
  const S = SPEC[kind]
  const zip = await JSZip.loadAsync(await fsp.readFile(template.path))
  const parts = await readParts(zip, S)
  const lines = parts.flatMap((p) => p.paras.map((x) => ({ text: x.text, part: x.part, cell: x.cell, row: x.row, col: x.col })))
  const caseText = caseTextOf(input)
  const rule = sourceCaseStrings({ form: template.name || input?.form || '', templateName: path.basename(template.path), lines, others: source.others || [], fileNames: source.fileNames || [], own: source.own || [], caseText, R: rules })
  const given = rule.map((x) => x.text)
  const holds = (p) => given.some((s) => clean(p.text).includes(s))
  const list = pickParagraphs(parts, { max, chars, empty: S.empty, must: holds })
  const r = await ask({ ...input, keep: keep.slice(0, 20), source_case: given, paragraphs: list })
  const { edits, kept } = editsOf(r, list, keep)
  if (!edits.size) throw new Error('양식에서 바꿀 문단을 정하지 못했어요')
  applyAll(zip, parts, edits, S)
  // the strings to check: the rules', else the ones the model named
  const strings = given.length ? given : modelCaseStrings(r?.source_case, { lines, keep, caseText, max: rules.caseStrings || 30 })
  let now = await readParts(zip, S)
  let left = leftoversOf(now, strings, keep)
  let changed = [...edits.values()].filter((e) => e.text != null).length
  let added = [...edits.values()].reduce((s, e) => s + (S.add ? e.add?.length || 0 : 0), 0)
  let keptN = kept.length, retried = 0
  // once more, only those paragraphs (a format rule's paragraph stays as it is — it is reported, not changed)
  const again = left.filter((x) => !x.fixed).slice(0, 120)
  if (again.length) {
    retried = again.length
    try {
      const list2 = again.map(({ i, part, text, cell }) => ({ i, part, text: text.slice(0, chars), ...(cell ? { cell: true } : {}) }))
      const r2 = await ask({ ...input, keep: keep.slice(0, 20), source_case: strings, left: [...new Set(again.flatMap((x) => x.found))], paragraphs: list2 })
      const e2 = editsOf(r2, list2, keep)
      if (e2.edits.size) {
        applyAll(zip, now, e2.edits, S)
        changed += [...e2.edits.values()].filter((e) => e.text != null).length
        added += [...e2.edits.values()].reduce((s, e) => s + (S.add ? e.add?.length || 0 : 0), 0)
        keptN += e2.kept.length
        now = await readParts(zip, S)
        left = leftoversOf(now, strings, keep)
      }
    } catch (e) { console.warn('[docfill] again', e.message) }
  }
  return { buf: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), changed, added, kept: keptN,
    summary: String(r?.summary || '').slice(0, 200), assumptions: (r?.assumptions || []).map(String).slice(0, 8), title: String(r?.title || '').slice(0, 120),
    sourceCase: strings, sourceBy: given.length ? 'rule' : strings.length ? 'model' : null, retried,
    left: strings.filter((s) => left.some((x) => x.found.includes(s))), leftWhere: [...new Set(left.map((x) => partKo(x.part)))], leftFixed: left.some((x) => x.fixed) }
}
// ---------- 엑셀 양식: 칸 채우기(mining/worker.js) 뒤에 같은 점검 ----------
// a workbook's text as the lines sourceCaseStrings reads: the header · footer, then every cell with its row and its place in the row
// (col: the n-th cell with text, so a label's value is the next one even across merged or empty cells) — read from the sheet XML the
// way the fill reads it (mining/worker.js xlsxSheets; ExcelJS cannot open some company files), formulas left out (a formula keeps its
// last result until the file is opened and recalculated — not a value the fill left)
const colNo = (ref) => [...String(ref).match(/^[A-Z]+/)[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
export async function xlsxLines(buf) {
  const { xlsxSheets } = await import('../mining/worker.js')
  const facts = await docFacts('x.xlsx', buf)
  const { sheets } = await xlsxSheets(buf)
  const lines = [...facts.header.map((text) => ({ text, part: 'header' })), ...facts.footer.map((text) => ({ text, part: 'footer' }))]
  for (const [k, sh] of sheets.entries()) {
    const rows = new Map()
    for (const c of sh.cells) {
      if (c.value.startsWith('=')) continue
      const r = Number(c.cell.match(/\d+$/)[0])
      if (!rows.has(r)) rows.set(r, [])
      rows.get(r).push(c)
    }
    for (const r of [...rows.keys()].sort((a, b) => a - b)) {
      rows.get(r).sort((a, b) => colNo(a.cell) - colNo(b.cell)).forEach((c, col) => { const text = clean(c.value); if (text) lines.push({ text, part: sh.name, cell: true, row: `${k}:${r}`, col }) })
    }
  }
  return lines
}
// the filled workbook against the form's own case (the template's strings by the same rules as a document) → {sourceCase, left,
// leftWhere, leftFixed} — what leftoverCheck reports; nothing is changed (a sheet is filled once, cell by cell)
export async function xlsxLeftovers({ template, buf, source = {}, caseText = '', keep = [], rules = {} }) {
  const lines = await xlsxLines(await fsp.readFile(template.path))
  const strings = sourceCaseStrings({ form: template.name || '', templateName: path.basename(template.path), lines, others: source.others || [], fileNames: source.fileNames || [], own: source.own || [], sheet: true, caseText, R: rules }).map((x) => x.text)
  const now = await xlsxLines(buf)
  const left = leftoversOf([{ paras: now.map((l, i) => ({ i, part: l.part, text: l.text, cell: !!l.cell })) }], strings, keep)
  return { sourceCase: strings, left: strings.filter((s) => left.some((x) => x.found.includes(s))), leftWhere: [...new Set(left.map((x) => (FRAME_PART.has(x.part) ? partKo(x.part) : `시트 ${x.part}`)))], leftFixed: left.some((x) => x.fixed) }
}

// the step's failed check when the last case's strings stayed (it goes on the format-rule list the run view shows)
export function leftoverCheck(out) {
  if (!out?.left?.length) return null
  const names = out.left.slice(0, 4).join(' · ') + (out.left.length > 4 ? ` 외 ${out.left.length - 4}개` : '')
  return { item: '앞 건의 값', ok: false, kind: 'leftover', note: `앞 건의 이름이 남았어요: ${names} — ${out.leftWhere.join(' · ')}${out.leftFixed ? ' · 형식 규칙의 꼭 지킬 글 안이라 바꾸지 않았어요' : ''}` }
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
