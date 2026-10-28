// Panel apps (패널 앱) — the app definition and its spreadsheet.
// The data lives in an xlsx in a shared folder: row 1 = field labels, column A = hidden row ID,
// computed columns are Excel formulas. Reading maps columns by header label (people may reorder
// columns in the sheet editor); writing changes only the row it is about, in the existing workbook,
// so whatever else people did in the sheet (formatting, other sheets) stays.
import crypto from 'node:crypto'
import ExcelJS from 'exceljs'
import { validateAccess } from './rules.js'
import { classify, needsDb, defaultAccess, LEVELS } from './privacy.js'
import { L } from '../lang.js'

export const TYPES = ['text', 'longtext', 'number', 'date', 'time', 'choice', 'checkbox', 'email', 'phone', 'person']
const ID_HEADER = 'ID'
const err = (status, message) => Object.assign(new Error(message), { status })

// ---------- computed expressions: field keys, numbers, + - * / and parentheses ----------
function tokenize(expr) {
  const out = []
  const s = String(expr || '')
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; out.push({ t: 'num', v: Number(s.slice(i, j)) }); i = j; continue }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; out.push({ t: 'id', v: s.slice(i, j) }); i = j; continue }
    if ('+-*/()'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    throw err(400, L(`계산 식에 쓸 수 없는 글자가 있어요: ${c}`, `The formula has a character it cannot use: ${c}`))
  }
  return out
}
// recursive descent → a tiny AST
export function parseExpr(expr) {
  const toks = tokenize(expr)
  let p = 0
  const peek = () => toks[p]
  const primary = () => {
    const t = toks[p++]
    if (!t) throw err(400, L('계산 식이 끝나지 않았어요.', 'The formula is incomplete.'))
    if (t.t === 'num') return { n: t.v }
    if (t.t === 'id') return { id: t.v }
    if (t.v === '(') { const e = sum(); if (toks[p++]?.v !== ')') throw err(400, L('괄호가 맞지 않아요.', "The brackets don't match.")); return e }
    if (t.v === '-') return { op: '-', a: { n: 0 }, b: primary() }
    throw err(400, L('계산 식을 읽지 못했어요.', "I couldn't read the formula."))
  }
  const prod = () => { let a = primary(); while (peek()?.t === 'op' && '*/'.includes(peek().v)) { const op = toks[p++].v; a = { op, a, b: primary() } } return a }
  const sum = () => { let a = prod(); while (peek()?.t === 'op' && '+-'.includes(peek().v)) { const op = toks[p++].v; a = { op, a, b: prod() } } return a }
  const ast = sum()
  if (p !== toks.length) throw err(400, L('계산 식을 읽지 못했어요.', "I couldn't read the formula."))
  return ast
}
export const exprIds = (ast, out = new Set()) => { if (ast.id) out.add(ast.id); if (ast.a) exprIds(ast.a, out); if (ast.b) exprIds(ast.b, out); return out }
export function evalExpr(ast, vals) {
  if ('n' in ast) return ast.n
  if (ast.id) { const v = Number(vals[ast.id]); return Number.isFinite(v) ? v : 0 }
  const a = evalExpr(ast.a, vals), b = evalExpr(ast.b, vals)
  const r = ast.op === '+' ? a + b : ast.op === '-' ? a - b : ast.op === '*' ? a * b : b === 0 ? 0 : a / b
  return Math.round(r * 1e6) / 1e6
}
const toFormula = (ast, cellOf) => ('n' in ast ? String(ast.n) : ast.id ? cellOf(ast.id) : `(${toFormula(ast.a, cellOf)}${ast.op}${toFormula(ast.b, cellOf)})`)

// ---------- definition ----------
const keyOf = (s, i) => (String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f$1').slice(0, 24) || `f${i + 1}`)

// The model's design, made safe: keys are ascii, labels unique, expressions only name fields,
// views and form only point at keys that exist.
export function normalizeDef(raw, opts = {}) {
  let d = raw || {}
  const title = String(d.title || '').trim().slice(0, 40)
  if (!title) throw err(400, L('앱 이름이 없어요.', 'The app has no name.'))
  const seenK = new Set(), seenL = new Set([ID_HEADER])
  const fields = []
  for (const [i, f] of (Array.isArray(d.fields) ? d.fields : []).entries()) {
    let key = keyOf(f.key || f.label, i)
    while (seenK.has(key)) key += '_'
    const label = String(f.label || f.key || key).trim().slice(0, 30)
    if (!label || seenL.has(label)) continue
    const type = TYPES.includes(f.type) ? f.type : 'text'
    const out = { key, label, type }
    if (f.required) out.required = true
    if (type === 'choice') {
      out.choices = [...new Set((Array.isArray(f.choices) ? f.choices : []).map((c) => String(c).trim()).filter(Boolean))].slice(0, 20)
      if (!out.choices.length) out.type = 'text'
    }
    if (f.default !== undefined && f.default !== null && f.default !== '') out.default = f.default
    if (f.help) out.help = String(f.help).slice(0, 80)
    if (LEVELS.includes(f.sensitivity)) out.sensitivity = f.sensitivity
    seenK.add(key); seenL.add(label); fields.push(out)
    if (fields.length >= 14) break
  }
  if (fields.length < 1) throw err(400, L('항목이 하나도 없어요.', 'The app has no fields.'))
  if (!fields.some((f) => f.required)) fields[0].required = true
  const numeric = new Set(fields.filter((f) => f.type === 'number').map((f) => f.key))
  const computed = []
  for (const [i, c] of (Array.isArray(d.computed) ? d.computed : []).entries()) {
    try {
      const ast = parseExpr(c.expr)
      const ids = [...exprIds(ast)]
      if (!ids.length || ids.some((x) => !numeric.has(x))) continue
      let key = keyOf(c.key || c.label, i + 50)
      while (seenK.has(key)) key += '_'
      const label = String(c.label || key).trim().slice(0, 30)
      if (seenL.has(label)) continue
      seenK.add(key); seenL.add(label)
      computed.push({ key, label, expr: String(c.expr), type: 'number' })
    } catch { /* an expression we cannot read is dropped */ }
    if (computed.length >= 4) break
  }
  const all = new Set([...fields, ...computed].map((f) => f.key))
  const has = (k) => all.has(k)
  const lv = d.views?.list || {}
  const list = {
    title: has(lv.title) ? lv.title : fields[0].key,
    subtitle: (Array.isArray(lv.subtitle) ? lv.subtitle : [lv.subtitle]).filter(has).slice(0, 3),
  }
  if (has(lv.value)) { list.value = lv.value; if (lv.valueSuffix) list.valueSuffix = String(lv.valueSuffix).slice(0, 6) }
  if (has(lv.badge)) list.badge = lv.badge
  if (has(lv.sort?.key)) list.sort = { key: lv.sort.key, dir: lv.sort.dir === 'desc' ? 'desc' : 'asc' }
  const summary = (Array.isArray(d.views?.summary) ? d.views.summary : []).map((s) => {
    const agg = ['count', 'sum', 'avg', 'count_where'].includes(s.agg) ? s.agg : 'count'
    if (agg !== 'count' && !has(s.field)) return null
    const out = { label: String(s.label || '').slice(0, 20) || L('개수', 'Count'), agg }
    if (agg !== 'count') out.field = s.field
    if (agg === 'count_where') out.eq = String(s.eq ?? '')
    if (s.suffix) out.suffix = String(s.suffix).slice(0, 6)
    return out
  }).filter(Boolean).slice(0, 3)
  if (!summary.length) summary.push(L({ label: '전체', agg: 'count', suffix: '건' }, { label: 'Total', agg: 'count' }))
  const form = (Array.isArray(d.form) ? d.form : []).filter((k) => fields.some((f) => f.key === k))
  for (const f of fields) if (!form.includes(f.key)) form.push(f.key)
  const out = {
    version: 1, title, icon: String((d.icon && !/^[\p{L}\p{N}\s]+$/u.test(d.icon) && d.icon) || '📋').slice(0, 4), description: String(d.description || '').slice(0, 200),
    sheet: String(d.sheet || L('데이터', 'Data')).replace(/[\\/?*[\]:]/g, '').slice(0, 28) || L('데이터', 'Data'),
    fields, computed, views: { list, summary }, form,
    tier: d.tier === 'db' || d.access || d.fieldRules ? 'db' : 'sheet',
  }
  if (d.subject) out.subject = String(d.subject)
  // a new design is secure by default (lib/panelApps/privacy.js): sensitivity floor, and the database
  // tier with "your own records" rules when anything must stay hidden from some members
  if (opts.secure) {
    Object.assign(out, classify(out))
    if (needsDb(out)) out.tier = 'db'
    if (out.tier === 'db' && !d.access) d = { ...d, access: defaultAccess(out) }
    // the folder owner (the team's manager) can always correct a record they can see
    if (out.tier === 'db') for (const a of ['update', 'delete']) if (Array.isArray(d.access?.[a]) && !d.access[a].includes('role>=owner')) d = { ...d, access: { ...d.access, [a]: [...d.access[a], 'role>=owner'] } }
  } else if (out.tier === 'db') Object.assign(out, classify(out))
  // tier db: row-level rules (lib/panelApps/rules.js); a model's bad rule falls back to the default
  if (out.tier === 'db') Object.assign(out, validateAccess(out, d, { strict: !!opts.strict }))
  return out
}

// ---------- values ----------
// "3,800만 원", "1억 2천만원", "3천8백만", "1.5억", "약 5천 원", "38,000,000원", "15일", "12%" → a number
// (Korean numeric units 조·억·만 and 천·백·십 on top of digits); anything else → NaN
const BIG = { 조: 1e12, 억: 1e8, 만: 1e4 }
const SMALL = { 천: 1e3, 백: 1e2, 십: 10 }
export function parseKoNumber(raw) {
  const n = parseKoOnly(raw)
  return Number.isFinite(n) ? n : parseEnNumber(raw)
}
// "15 days", "₩30,000", "30K", "1.2M", "$1,200" (English mode's own way of writing amounts)
function parseEnNumber(raw) {
  const m = String(raw ?? '').replace(/[\s,₩$]/g, '').replace(/^(about|approx\.?|total|~)/i, '')
    .replace(/(won|krw|usd|days?|pcs|items?|people|persons?|hours?|hrs?|times|%|percent)$/i, '').match(/^([-+]?\d+(?:\.\d+)?)([kmb])?$/i)
  if (!m) return NaN
  const x = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] || 1)
  return Math.round(x * 100) / 100
}
function parseKoOnly(raw) {
  let s = String(raw ?? '').replace(/[\s,₩]/g, '').replace(/^(약|대략|총|금)/u, '')
    .replace(/(원정?|원|일|개|명|건|회|대|권|시간|%|퍼센트)$/u, '')
  if (!s) return NaN
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return Number(s)
  let sign = 1
  if (/^[-+]/.test(s)) { if (s[0] === '-') sign = -1; s = s.slice(1) }
  let total = 0, block = 0, num = null, seen = false
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)|([조억만천백십])|(.)/gu)) {
    if (m[3]) return NaN
    if (m[1]) { if (num !== null) return NaN; num = Number(m[1]); continue }
    seen = true
    const u = m[2]
    if (SMALL[u]) { block += (num ?? 1) * SMALL[u]; num = null } else { block += num ?? 0; total += (block || 1) * BIG[u]; block = 0; num = null }
  }
  if (!seen) return NaN
  return sign * Math.round((total + block + (num ?? 0)) * 100) / 100
}

export function coerce(f, v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object' && !(v instanceof Date)) v = v.text ?? v.result ?? ''
  if (f.type === 'number') {
    if (v === '') return ''
    if (typeof v === 'number') return v
    const n = parseKoNumber(v)
    return Number.isFinite(n) ? n : String(v)
  }
  if (f.type === 'checkbox') return v === true || /^(true|1|y|yes|예|o|✓|☑)$/i.test(String(v).trim())
  if (f.type === 'time') {
    // a spreadsheet may turn 10:00 into a day fraction or a Date
    if (typeof v === 'number' && v >= 0 && v < 1) { const m = Math.round(v * 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }
    if (v instanceof Date) return v.toISOString().slice(11, 16)
    return String(v).trim()
  }
  if (f.type === 'date') {
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10)
    const m = String(v).trim().match(/^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/)
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    // English dates ("Nov 3, 2026", "3 November 2026"): the calendar day as written
    const s = String(v).trim()
    if (/[a-z]/i.test(s) && /\d{4}/.test(s) && !/[가-힣]/.test(s)) {
      const t = new Date(s)
      if (!Number.isNaN(t.getTime())) return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
    }
    return s
  }
  return String(v).trim()
}

// what a person (or the model) typed, checked against the definition; returns the clean values
export function validate(def, input, { partial = false } = {}) {
  const out = {}
  const problems = []
  for (const f of def.fields) {
    // a model or a person may write the label without its spaces ("견적금액" for "견적 금액")
    const loose = Object.keys(input || {}).find((k) => k.replace(/\s/g, '') === String(f.label).replace(/\s/g, ''))
    const has = Object.prototype.hasOwnProperty.call(input || {}, f.key) || Object.prototype.hasOwnProperty.call(input || {}, f.label) || !!loose
    if (partial && !has) continue
    let v = input?.[f.key] ?? input?.[f.label] ?? (loose ? input[loose] : undefined)
    if ((v === undefined || v === '') && !partial && f.default !== undefined) v = f.default
    v = coerce(f, v)
    if (f.required && (v === '' || v === false && f.type !== 'checkbox')) { problems.push(L(`'${f.label}' 을(를) 적어 주세요.`, `Please fill in '${f.label}'.`)); continue }
    if (v !== '' && f.type === 'number' && typeof v !== 'number') problems.push(L(`'${f.label}' 은(는) 숫자로 적어 주세요.`, `'${f.label}' must be a number.`))
    if (v !== '' && f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) problems.push(L(`'${f.label}' 은(는) 2026-10-24 처럼 날짜로 적어 주세요.`, `'${f.label}' must be a date like 2026-10-24.`))
    if (v !== '' && f.type === 'choice' && !f.choices.includes(v)) {
      const hit = f.choices.find((c) => c.replace(/\s/g, '') === String(v).replace(/\s/g, ''))
      if (hit) v = hit; else problems.push(L(`'${f.label}' 은(는) ${f.choices.join(', ')} 중 하나예요.`, `'${f.label}' is one of ${f.choices.join(', ')}.`))
    }
    if (v !== '' && f.type === 'time') { const m = String(v).match(/^(\d{1,2}):(\d{2})/); if (m && +m[1] < 24 && +m[2] < 60) v = `${m[1].padStart(2, '0')}:${m[2]}`; else problems.push(L(`'${f.label}' 은(는) 14:30 처럼 시각으로 적어 주세요.`, `'${f.label}' must be a time like 14:30.`)) }
    if (v !== '' && f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) problems.push(L(`'${f.label}' 이메일 형식이 아니에요.`, `'${f.label}' is not an e-mail address.`))
    out[f.key] = v
  }
  if (problems.length) throw Object.assign(err(422, problems.join(' ')), { problems })
  return out
}

export function withComputed(def, vals) {
  const out = { ...vals }
  for (const c of def.computed) out[c.key] = evalExpr(parseExpr(c.expr), vals)
  return out
}
// the version a client read; a change is refused when the row no longer has it
export const rowHash = (def, vals) => crypto.createHash('sha1').update(JSON.stringify(def.fields.map((f) => vals[f.key] ?? ''))).digest('hex').slice(0, 12)
export const newRowId = () => 'r_' + crypto.randomBytes(4).toString('hex')

// ---------- workbook ----------
const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
function cellText(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('')
    if ('result' in v) return v.result ?? ''
    if ('text' in v) return v.text
    if ('error' in v) return ''
    return ''
  }
  return v
}

function sheetOf(wb, def) {
  return wb.getWorksheet(def.sheet) || wb.worksheets.find((w) => w.state !== 'veryHidden' && w.name !== '_panel') || null
}

// header label → column number; fields not found by label fall back to their defined position
function columns(ws, def) {
  const head = new Map()
  const row = ws.getRow(1)
  for (let c = 1; c <= Math.max(ws.columnCount, row.cellCount); c++) {
    const t = String(cellText(row.getCell(c).value) ?? '').trim()
    if (t && !head.has(t)) head.set(t, c)
  }
  const idCol = head.get(ID_HEADER) || null
  const cols = {}
  const used = new Set(idCol ? [idCol] : [])
  for (const f of [...def.fields, ...def.computed]) { const c = head.get(f.label); if (c) { cols[f.key] = c; used.add(c) } }
  let next = idCol ? 2 : 1
  for (const f of [...def.fields, ...def.computed]) {
    if (cols[f.key]) continue
    while (used.has(next)) next++
    cols[f.key] = next; used.add(next)
  }
  return { idCol, cols }
}

const lastDataRow = (ws) => { for (let r = ws.rowCount; r >= 2; r--) if (ws.getRow(r).values.some((v) => cellText(v) !== '')) return r; return 1 }

export async function readBook(buf) {
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(buf) } catch (e) { throw err(422, L(`스프레드시트를 읽지 못했어요: ${e.message}`, `I couldn't read the spreadsheet: ${e.message}`)) }
  return wb
}
export const bookBuffer = async (wb) => Buffer.from(await wb.xlsx.writeBuffer())

// rows of the sheet: [{_id, _row, _v, ...values, ...computed}]
export function readRows(wb, def) {
  const ws = sheetOf(wb, def)
  if (!ws) return []
  const { idCol, cols } = columns(ws, def)
  const out = []
  const last = lastDataRow(ws)
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r)
    const vals = {}
    let any = false
    for (const f of def.fields) {
      const v = coerce(f, cellText(row.getCell(cols[f.key]).value))
      if (v !== '' && v !== false) any = true
      vals[f.key] = v
    }
    if (!any) continue
    const id = idCol ? String(cellText(row.getCell(idCol).value) || '').trim() : ''
    out.push({ _id: id || `row:${r}`, _row: r, _v: rowHash(def, vals), ...withComputed(def, vals) })
  }
  return out
}

function writeCells(ws, def, layout, r, id, vals) {
  const row = ws.getRow(r)
  if (layout.idCol) row.getCell(layout.idCol).value = id
  for (const f of def.fields) {
    if (!(f.key in vals)) continue
    const v = vals[f.key]
    const cell = row.getCell(layout.cols[f.key])
    cell.value = v === '' ? null : v
    if (f.type === 'number' && cell.numFmt) cell.numFmt = 'General'
  }
  const all = withComputed(def, Object.fromEntries(def.fields.map((f) => [f.key, coerce(f, cellText(row.getCell(layout.cols[f.key]).value))])))
  for (const c of def.computed) {
    const formula = toFormula(parseExpr(c.expr), (k) => `${colLetter(layout.cols[k])}${r}`)
    row.getCell(layout.cols[c.key]).value = { formula, result: all[c.key] }
  }
  row.commit()
}

// a new workbook for a new app (with the first rows, if the request had any)
export async function newBook(def, rows = []) {
  const wb = new ExcelJS.Workbook()
  wb.creator = L('process gpt 패널 앱', 'Process GPT Lite panel app')
  const ws = wb.addWorksheet(def.sheet, { views: [{ state: 'frozen', ySplit: 1 }] })
  const heads = [ID_HEADER, ...def.fields.map((f) => f.label), ...def.computed.map((c) => c.label)]
  ws.addRow(heads)
  ws.getRow(1).font = { bold: true }
  ws.getColumn(1).width = 11
  ws.getColumn(1).hidden = true
  heads.slice(1).forEach((h, i) => { ws.getColumn(i + 2).width = Math.min(40, Math.max(10, h.length * 2 + 4)) })
  const layout = columns(ws, def)
  // (choices are enforced by the panel and the server; sheet dropdowns are left out — exceljs writes
  // a shifted range for list validations)
  def.fields.forEach((f) => { if (f.type === 'longtext') ws.getColumn(layout.cols[f.key]).width = 30 })
  let r = 2
  for (const v of rows) { writeCells(ws, def, layout, r, v._id || newRowId(), v); r++ }
  return wb
}

// change one row in place. op: {add: vals} | {update: {id, v, vals}} | {remove: {id, v}}
// returns {id} of the row written; missing IDs of rows people added in the sheet are filled in
export function applyOp(wb, def, op) {
  const ws = sheetOf(wb, def)
  if (!ws) throw err(409, L(`'${def.sheet}' 시트를 찾지 못했어요.`, `I couldn't find the '${def.sheet}' sheet.`))
  const layout = columns(ws, def)
  if (!layout.idCol) {
    // the ID column was removed in the sheet editor: put it back in front
    ws.spliceColumns(1, 0, [ID_HEADER])
    ws.getColumn(1).hidden = true
    Object.assign(layout, columns(ws, def))
  }
  const rows = readRows(wb, def)
  for (const row of rows) if (row._id.startsWith('row:')) { const id = newRowId(); ws.getRow(row._row).getCell(layout.idCol).value = id; row._id = id }
  if (op.add) {
    const r = lastDataRow(ws) + 1
    const id = newRowId()
    writeCells(ws, def, layout, r, id, op.add)
    return { id }
  }
  const target = op.update || op.remove
  const row = rows.find((x) => x._id === target.id || (target.id?.startsWith('row:') && x._row === Number(target.id.slice(4))))
  if (!row) throw err(409, L('그 행이 없어요. 다른 사람이 지웠을 수 있어요.', "That row isn't there. Someone may have deleted it."))
  if (target.v && target.v !== row._v) throw err(409, L('다른 사람이 먼저 고쳤어요. 새로 불러온 값을 확인해 주세요.', 'Someone else changed it first. Please check the values just loaded.'))
  if (op.update) {
    const cur = Object.fromEntries(def.fields.map((f) => [f.key, row[f.key]]))
    writeCells(ws, def, layout, row._row, row._id, { ...cur, ...op.update.vals })
    return { id: row._id }
  }
  ws.spliceRows(row._row, 1)
  return { id: row._id }
}
