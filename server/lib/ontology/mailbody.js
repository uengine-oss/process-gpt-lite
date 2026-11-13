// 메일 본문 · 첨부 읽기 (design-v0.3 §15): 미리보기(snippet) 대신 본문 전체와 첨부를 읽는다 — 답할 때 쓰는 양식(보낸 첨부의
// 칸 이름)과, 그 메일이 정해진 때마다 하는 일인지(타이머 사건)를 알아내려면 둘 다 있어야 한다.
//   partsOf      Gmail payload → 본문(text/plain, 없으면 html 을 글로) · 첨부 목록(이름 · 종류 · 크기 · attachmentId)
//   newPart      그 메일에서 보낸 사람이 지금 쓴 부분(인용된 앞 메일은 잘라 냄)
//   readFile     첨부 파일 → 칸 이름(labels)과 앞부분 글(text): xlsx · docx · pptx · hwpx · csv · txt
//   formFields   같은 양식의 첨부 여러 개에 늘 있는 칸 이름 = 그 양식의 칸(고객마다 다른 값은 빠진다)
//   periodOf     한 일의 메일 날짜들 → 매일(평일) · 매주 무슨 요일 · 매월 며칠, 몇 시(KST)와 규칙성
// 파일 · 네트워크 없이 시험한다(test/ontology-mailbody.test.js). Gmail 을 부르는 쪽은 history.js · mail.js.
import JSZip from 'jszip'
import { defaultRules } from './discovery.js'

const DAY = 86_400_000
const KST = 9

export const b64u = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64')

export function partsOf(payload) {
  const out = { text: '', html: '', attachments: [] }
  const walk = (p) => {
    if (!p) return
    const mime = String(p.mimeType || '').toLowerCase()
    if (p.filename) out.attachments.push({ name: p.filename, mime, size: p.body?.size || 0, attachmentId: p.body?.attachmentId || null, data: p.body?.data || null })
    else if (mime === 'text/plain' && p.body?.data && !out.text) out.text = b64u(p.body.data).toString('utf8')
    else if (mime === 'text/html' && p.body?.data && !out.html) out.html = b64u(p.body.data).toString('utf8')
    for (const c of p.parts || []) walk(c)
  }
  walk(payload)
  return out
}

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }
export function htmlText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d|table|blockquote)>/gi, '\n').replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export const bodyOf = (parts) => (parts.text ? parts.text : htmlText(parts.html))

// the part of a mail its sender wrote now: a reply quotes the earlier mails under 「On … wrote:」, 「… 님이 작성:」,
// 「-----Original Message-----」, an Outlook header block (보낸 사람: · From:) or 「>」 lines
export function newPart(text) {
  const out = []
  for (const l of String(text || '').replace(/\r/g, '').split('\n')) {
    if (/^\s*-{2,}\s*(original message|원본 메시지|forwarded message|전달된 메시지)\s*-{2,}/i.test(l)) break
    if (/^\s*On .{4,160} wrote:\s*$/i.test(l) || /님이 작성(했습니다)?\s*[:：]?\s*$/.test(l) || /^\s*20\d\d[.\-/년 ].{0,80}(작성|wrote)\s*[:：]?\s*$/.test(l)) break
    if (/^\s*(보낸 사람|From)\s*[:：]/i.test(l) && out.some((x) => x.trim())) break
    if (/^\s*>/.test(l)) continue
    out.push(l)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------- 첨부 ----------
export const kindOf = (name) => String(name || '').toLowerCase().split('.').pop()
// a label of a form: a short piece of text that is not a number, an amount, a date or an address
// (a title spaced out letter by letter, 「견 적 서」, is the sheet's heading, not a label)
const LABELISH = (s) => s.length >= 1 && s.length <= 24 && !/^[\d\s.,:/\-+()₩원%]+$/.test(s) && !/@|https?:/.test(s) && !/^\d{2,4}[.\-/년]/.test(s) && !/^(\S\s+){2,}\S$/.test(s)
const uniq = (xs) => [...new Set(xs.map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean))]

async function xlsxRead(buf) {
  const ExcelJS = (await import('exceljs')).default
  const { cellText } = await import('./taskdef.js')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const lines = [], labels = []
  wb.eachSheet((ws) => ws.eachRow((row, r) => {
    if (r > 80) return
    const cells = []
    row.eachCell((c) => { if (c.isMerged && c.master.address !== c.address) return; const t = cellText(c.value).trim(); if (t) cells.push(t) })
    if (!cells.length) return
    lines.push(cells.join(' | '))
    for (const t of cells) if (LABELISH(t) && !t.startsWith('=')) labels.push(t)
  }))
  return { labels: uniq(labels), text: lines.join('\n') }
}
// text runs of an OOXML / OWPML part, one line per paragraph (w:p · a:p · hp:p)
function xmlLines(xml, para, run) {
  const lines = []
  for (const p of xml.split(new RegExp(`</${para}>`))) {
    const t = [...p.matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, 'g'))].map((m) => m[1]).join('')
    if (t.trim()) lines.push(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim())
  }
  return lines
}
async function zipRead(buf, kind) {
  const zip = await JSZip.loadAsync(buf)
  const pick = (re) => Object.keys(zip.files).filter((n) => re.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const spec = kind === 'docx' ? { files: pick(/^word\/document\.xml$/), para: 'w:p', run: 'w:t' }
    : kind === 'pptx' ? { files: pick(/^ppt\/slides\/slide\d+\.xml$/), para: 'a:p', run: 'a:t' }
    : { files: pick(/^Contents\/section\d+\.xml$/), para: 'hp:p', run: 'hp:t' }
  const lines = []
  for (const f of spec.files.slice(0, 30)) lines.push(...xmlLines(await zip.file(f).async('string'), spec.para, spec.run))
  // a line that ends with a colon, or a short line, reads as a label (「현장 주소 :」, 「공사 기간」)
  const labels = lines.flatMap((l) => (/[:：]\s*\S/.test(l) ? [l.split(/[:：]/)[0]] : [l])).map((s) => s.trim()).filter(LABELISH)
  return { labels: uniq(labels), text: lines.join('\n') }
}
export async function readFile(name, buf) {
  const kind = kindOf(name)
  try {
    if (kind === 'xlsx') return { kind, ...(await xlsxRead(buf)) }
    if (['docx', 'pptx', 'hwpx'].includes(kind)) return { kind, ...(await zipRead(buf, kind)) }
    if (kind === 'csv' || kind === 'txt') {
      const text = buf.toString('utf8')
      return { kind, labels: kind === 'csv' ? uniq(text.split('\n')[0].split(',')).filter(LABELISH) : [], text }
    }
  } catch (e) { return { kind, labels: [], text: '', error: e.message } }
  return { kind, labels: [], text: '' }
}

// the name of a form: the part of the file name before the customer's part (「견적서_달빛커피_2호점.xlsx」 → 견적서.xlsx,
// 「주간공정보고_도담학원_0907.xlsx」 → 주간공정보고.xlsx)
export const formKey = (name) => `${String(name).split(/[_\s(]/)[0].replace(/\.[a-z0-9]+$/i, '')}.${kindOf(name)}`

// the labels a form always has: in at least 60% of its attachments (and at least two of them) — a customer's name, a
// site address or an amount differ from file to file and drop out
export function formFields(labelSets, { share = 0.6, minFiles = 2 } = defaultRules().forms) {
  const sets = labelSets.filter((s) => s?.length)
  if (sets.length < minFiles) return []
  const n = new Map()
  for (const s of sets) for (const l of new Set(s)) n.set(l, (n.get(l) || 0) + 1)
  const need = Math.max(minFiles, Math.ceil(sets.length * share))
  return [...n].filter(([, k]) => k >= need).map(([l]) => l)
}

// ---------- 정해진 때마다 하는 일 ----------
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const modeOf = (xs) => { const n = new Map(); for (const x of xs) n.set(x, (n.get(x) || 0) + 1); return [...n].sort((a, b) => b[1] - a[1])[0] || [null, 0] }

// dates of one series (the same work by the same role to the same counterpart) → the clock it keeps, or null.
// A clock is not just frequent work: work that cases drive comes at any hour and several times a day. So a series keeps
// a clock only when (1) it has four or more mails, (2) they come at about the same time of day (70% within 90 minutes of the
// median) and (3) once per day · week · month (at most 10% of those with two). Then weekly when the gaps are about seven
// days (70%+) on one weekday (60%+), monthly when about a month on one day of the month, daily when about a day (weekdays
// only → 평일). The hour is the median KST hour.
export function periodOf(dates, P = defaultRules().period) {
  const ts = [...new Set(dates.map((d) => new Date(d).getTime()).filter(Number.isFinite))].sort((a, b) => a - b)
  if (ts.length < P.minMails) return null
  const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / DAY)
  const med = median(gaps)
  const local = ts.map((t) => new Date(t + KST * 3_600_000))
  const mins = local.map((d) => d.getUTCHours() * 60 + d.getUTCMinutes())
  const atMin = median(mins)
  if (mins.filter((m) => Math.abs(m - atMin) <= P.sameTimeMinutes).length / mins.length < P.sameTimeShare) return null
  const hour = Math.min(23, Math.floor(atMin / 60))
  const share = (f) => gaps.filter(f).length / gaps.length
  const once = (bucket) => { const n = new Map(); for (const d of local) n.set(bucket(d), (n.get(bucket(d)) || 0) + 1); return [...n.values()].filter((k) => k > 1).length / n.size <= P.twiceInBucketMax }
  const ymd = (d) => d.toISOString().slice(0, 10)
  const week = (d) => ymd(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY))
  const base = { n: ts.length, hour, first: new Date(ts[0]).toISOString(), last: new Date(ts.at(-1)).toISOString() }
  const W = P.weekly, M = P.monthly
  if (Math.abs(med - W.gapDays) <= 1 && once(week)) {
    const regular = share((g) => Math.abs(g - W.gapDays) <= W.gapTolerance)
    const [dow, k] = modeOf(local.map((d) => d.getUTCDay()))
    if (regular >= W.regular && k / ts.length >= W.sameWeekday) return { ...base, every: 'week', dow, regular, cron: `0 ${hour} * * ${dow}` }
  }
  if (Math.abs(med - M.gapDays) <= 3.5 && once((d) => ymd(d).slice(0, 7))) {
    const regular = share((g) => Math.abs(g - M.gapDays) <= M.gapTolerance)
    const [dom, k] = modeOf(local.map((d) => d.getUTCDate()))
    if (regular >= M.regular && k / ts.length >= M.sameDay) return { ...base, every: 'month', dom, regular, cron: `0 ${hour} ${dom} * *` }
  }
  if (med <= 1.5 && once(ymd)) {
    const days = local.map((d) => d.getUTCDay())
    const weekdays = days.every((d) => d >= 1 && d <= 5)
    const regular = share((g) => g <= (weekdays ? 3.2 : 1.5))
    if (regular >= P.daily.regular) return { ...base, every: 'day', regular, cron: `0 ${hour} * * ${weekdays ? '1-5' : '*'}` }
  }
  return null
}

// the model's reading of a mail that says the work repeats (「매주 월요일 오전에 …」) → a cron, or null
export function cronOfHint(h) {
  if (!h || !h.every) return null
  const hour = Number.isInteger(h.hour) && h.hour >= 0 && h.hour <= 23 ? h.hour : 9
  if (h.every === 'day') return `0 ${hour} * * ${h.weekdays === false ? '*' : '1-5'}`
  if (h.every === 'week' && Number.isInteger(h.dow) && h.dow >= 0 && h.dow <= 6) return `0 ${hour} * * ${h.dow}`
  if (h.every === 'month' && Number.isInteger(h.dom) && h.dom >= 1 && h.dom <= 28) return `0 ${hour} ${h.dom} * *`
  return null
}

// Gmail's refusal in words a person can act on (a 403 that says the API is off in the Google project, an expired grant, a
// rate limit) — the caller throws it instead of reading an error body as an empty mailbox
export function gmailError(status, body) {
  const msg = String(body?.error?.message || '')
  const project = msg.match(/project (\d+)/)?.[1]
  const e = new Error(status === 403 && /has not been used|is disabled/i.test(msg)
    ? `Gmail API 가 이 Google 프로젝트${project ? `(${project})` : ''}에서 꺼져 있어요. Google Cloud 콘솔에서 Gmail API 를 켜 주세요.`
    : status === 401 ? 'Google 연결이 만료됐어요. 메일을 다시 연결해 주세요.'
      : status === 429 ? 'Gmail 이 잠시 요청을 막았어요(너무 많은 요청). 조금 뒤에 다시 읽어요.'
        : `Gmail 이 요청을 거절했어요(${status}${msg ? `: ${msg.slice(0, 120)}` : ''}).`)
  return Object.assign(e, { status: status === 401 ? 401 : 502, gmail: { status, project: project || null } })
}
