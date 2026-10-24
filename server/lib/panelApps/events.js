// Panel apps, kind "events" (이벤트 소싱): nothing is overwritten. Every change is an event appended
// to a log — 휴가 부여 / 휴가 신청 / 휴가 취소 — and what the panel shows (balances, open items) is a
// projection replayed from the log. A mistake is corrected by another event (취소·정정), so the whole
// history stays.
//
// Definition (declarative; the server validates it — no model-written code anywhere):
//   entity      {key, label, type: person|text}   whom/what each event is about (the subject)
//   fields      payload field catalog [{key, label, type, choices, sensitivity}]
//   events      [{type, label, fields: [keys], required: [keys], who: [rule terms],
//                 ref: {types: [event types], mode: cancel|close, inherit: [keys]}}]
//               an event with ref amends an earlier one: its entity (and the inherited fields) are
//               copied from it; cancel = it no longer counts as open, close = done (e.g. 승인)
//   projections [{kind: balance, key, label, columns: [{key, label, terms: [{event, field, op: sum|count|min|max, sign: 1|-1}]}],
//                 computed: [{key, label, expr}]}             per entity, e.g. 부여 − 사용 = 남은 일수
//                {kind: open, key, label, event, closedBy: [types]}   e.g. 신청 not yet cancelled
//                {kind: latest, key, label, columns: [{key, label, event, field}]}  latest value per entity
//   views       {main: balance projection key, value: its column, valueSuffix}
// Replay is deterministic: events in log order (seq), cancellations are events themselves (a 취소
// carries the 일수 of the 신청 it cancels, so 사용 = Σ신청 − Σ취소 — the same sum a SUMIFS formula in
// the sheet computes).
import crypto from 'node:crypto'
import ExcelJS from 'exceljs'
import { coerce, validate as validateValues, parseExpr, exprIds, evalExpr } from './sheet.js'
import { classify, needsDb, LEVELS, restricted, K_ANON } from './privacy.js'
import * as R from './rules.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const keyOf = (s, i) => (String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f$1').slice(0, 24) || `f${i + 1}`)
export const LOG_SHEET = '이벤트'
const TYPES = ['text', 'longtext', 'number', 'date', 'time', 'choice', 'checkbox', 'email', 'phone', 'person']

// ---------- definition ----------
export function normalizeEventsDef(raw, opts = {}) {
  const d = raw || {}
  const title = String(d.title || '').trim().slice(0, 40)
  if (!title) throw err(400, '앱 이름이 없어요.')
  const entity = {
    key: keyOf(d.entity?.key || d.entity?.label || 'subject', 0),
    label: String(d.entity?.label || '대상').slice(0, 20),
    type: d.entity?.type === 'text' ? 'text' : 'person',
  }
  const seen = new Set([entity.key, 'id', 'at', 'by', 'type', 'entity', 'ref', 'seq'])
  const labels = new Set([entity.label])
  const fields = []
  for (const [i, f] of (Array.isArray(d.fields) ? d.fields : []).entries()) {
    let key = keyOf(f.key || f.label, i)
    while (seen.has(key)) key += '_'
    const label = String(f.label || key).slice(0, 30)
    if (labels.has(label)) continue
    const out = { key, label, type: TYPES.includes(f.type) ? f.type : 'text' }
    if (out.type === 'choice') { out.choices = [...new Set((f.choices || []).map(String).filter(Boolean))].slice(0, 20); if (!out.choices.length) out.type = 'text' }
    if (LEVELS.includes(f.sensitivity)) out.sensitivity = f.sensitivity
    seen.add(key); labels.add(label); fields.push(out)
    if (fields.length >= 14) break
  }
  const fieldKeys = new Set(fields.map((f) => f.key))
  const types = new Set()
  const events = []
  for (const [i, e] of (Array.isArray(d.events) ? d.events : []).entries()) {
    let type = keyOf(e.type || e.label, i)
    while (types.has(type)) type += '_'
    const label = String(e.label || type).slice(0, 20)
    const ef = (e.fields || []).filter((k) => fieldKeys.has(k))
    const out = { type, label, fields: ef, required: (e.required || []).filter((k) => ef.includes(k)) }
    if (e.ref) out.ref = { types: (e.ref.types || []).map(String), mode: e.ref.mode === 'close' ? 'close' : 'cancel', inherit: (e.ref.inherit || []).filter((k) => fieldKeys.has(k)) }
    if (Array.isArray(e.who)) out.who = e.who
    if (e.manager) out.manager = true
    types.add(type); events.push(out)
    if (events.length >= 8) break
  }
  if (!events.length) throw err(400, '이벤트 종류가 하나도 없어요.')
  // references only to known, non-referencing types (no cancel of a cancel)
  for (const e of events) if (e.ref) {
    e.ref.types = e.ref.types.filter((t) => types.has(t) && !events.find((x) => x.type === t)?.ref)
    if (!e.ref.types.length) delete e.ref
  }
  const evType = (t) => events.find((e) => e.type === t)
  const projections = []
  for (const [i, p] of (Array.isArray(d.projections) ? d.projections : []).entries()) {
    const key = keyOf(p.key || p.label, i)
    const label = String(p.label || key).replace(/[\\/?*[\]:]/g, '').slice(0, 24)
    if (label === LOG_SHEET || projections.some((x) => x.label === label || x.key === key)) continue
    if (p.kind === 'balance') {
      const columns = []
      for (const [j, c] of (p.columns || []).entries()) {
        const terms = (c.terms || []).map((t) => ({ event: t.event, field: t.field, op: ['sum', 'count', 'min', 'max'].includes(t.op) ? t.op : t.field ? 'sum' : 'count', sign: Number(t.sign) === -1 ? -1 : 1 }))
          .filter((t) => evType(t.event) && (t.op === 'count' || (fieldKeys.has(t.field) && fields.find((f) => f.key === t.field).type === 'number' && (evType(t.event).fields.includes(t.field) || evType(t.event).ref?.inherit.includes(t.field)))))
        if (!terms.length) continue
        columns.push({ key: keyOf(c.key || c.label, j), label: String(c.label || c.key).slice(0, 20), terms })
      }
      if (!columns.length) continue
      const ck = new Set(columns.map((c) => c.key))
      const computed = (p.computed || []).map((c, j) => {
        try { const ids = [...exprIds(parseExpr(c.expr))]; if (!ids.length || ids.some((x) => !ck.has(x))) return null } catch { return null }
        return { key: keyOf(c.key || c.label, j + 30), label: String(c.label || c.key).slice(0, 20), expr: String(c.expr) }
      }).filter(Boolean).slice(0, 3)
      projections.push({ kind: 'balance', key, label, columns, computed })
    } else if (p.kind === 'open' && evType(p.event)) {
      projections.push({ kind: 'open', key, label, event: p.event, closedBy: (p.closedBy || events.filter((e) => e.ref?.types.includes(p.event)).map((e) => e.type)).filter((t) => evType(t)?.ref?.types.includes(p.event)) })
    } else if (p.kind === 'latest') {
      const columns = (p.columns || []).filter((c) => evType(c.event) && fieldKeys.has(c.field)).map((c, j) => ({ key: keyOf(c.key || c.label, j), label: String(c.label || c.key).slice(0, 20), event: c.event, field: c.field }))
      if (columns.length) projections.push({ kind: 'latest', key, label, columns })
    }
    if (projections.length >= 4) break
  }
  const main = projections.find((p) => p.key === d.views?.main && p.kind === 'balance') || projections.find((p) => p.kind === 'balance')
  const mainCols = main ? [...main.columns, ...main.computed].map((c) => c.key) : []
  let out = {
    kind: 'events', version: 1, title, icon: String(d.icon || '🗂️').slice(0, 4), description: String(d.description || '').slice(0, 200),
    entity, fields, events, projections,
    views: { main: main?.key || null, value: mainCols.includes(d.views?.value) ? d.views.value : mainCols.at(-1) || null, valueSuffix: String(d.views?.valueSuffix || '').slice(0, 6) },
    tier: d.tier === 'db' ? 'db' : 'sheet',
  }
  if (opts.secure || out.tier === 'db') out = { ...out, ...classify(out) }
  if (opts.secure && needsDb(out)) out.tier = 'db'
  // who may append each event type (secure default: about yourself, unless you manage the folder;
  // events the model marks as a manager's job — 부여 — need editor; amendments: the original's author)
  for (const e of out.events) {
    const fallback = e.ref ? ['owner_of_ref', 'role>=owner'] : e.manager ? ['role>=editor'] : entity.type === 'person' ? ['subject_is_me', 'role>=editor'] : ['member']
    e.who = checkWho(out, e.who, fallback, !!opts.strict)
  }
  out.access = { read: checkWho(out, d.access?.read, ['member'], !!opts.strict) }
  return out
}
function checkWho(def, list, fallback, strict) {
  if (!list) return fallback
  try { return R.validateAccess({ ...def, fields: [...def.fields, { key: def.entity.key, label: def.entity.label, type: def.entity.type }] }, { access: { read: list } }, { strict: true }).access.read } catch (e) { if (strict) throw e; return fallback }
}

// ---------- events ----------
export const newEventId = () => crypto.randomUUID()
// what a person (or the model, or a new sheet row) asked to append, checked against the definition
export function validateEvent(def, input, { refEvent } = {}) {
  const e = def.events.find((x) => x.type === input.type || x.label === input.type)
  if (!e) throw err(422, `알 수 없는 기록 종류예요: ${input.type}`)
  const out = { type: e.type, ref: null, entity: null }
  if (e.ref) {
    if (!input.ref) throw err(422, `'${e.label}'은(는) 대상 기록을 골라야 해요.`)
    if (refEvent) {
      if (!e.ref.types.includes(refEvent.type)) throw err(422, `'${e.label}'은(는) ${e.ref.types.map((t) => def.events.find((x) => x.type === t)?.label).join('·')} 기록에만 쓸 수 있어요.`)
      out.entity = refEvent.entity
    }
    out.ref = String(input.ref)
  } else {
    const ent = coerce({ type: def.entity.type === 'person' ? 'text' : 'text' }, input.entity ?? input[def.entity.key] ?? input[def.entity.label])
    if (!ent) throw err(422, `'${def.entity.label}'을(를) 적어 주세요.`)
    out.entity = ent
  }
  // payload: only this type's fields; required ones present
  const allowed = new Set([...e.fields, ...(e.ref?.inherit || [])])
  const sub = { ...def, fields: def.fields.filter((f) => e.fields.includes(f.key)).map((f) => ({ ...f, required: e.required.includes(f.key) })) }
  const vals = validateValues(sub, input.values || {})
  for (const k of e.ref?.inherit || []) if (refEvent) vals[k] = refEvent[k]
  out.values = Object.fromEntries(Object.entries(vals).filter(([k]) => allowed.has(k)))
  return out
}

// ---------- replay ----------
// events: [{id, seq, at, by, type, entity, ref, ...payload}] → projections. Pure and deterministic.
export function replay(def, events) {
  const log = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.id).localeCompare(String(b.id)))
  const typeOf = (t) => def.events.find((e) => e.type === t)
  const closedBy = new Map() // event id -> the event that cancelled / closed it (first one wins)
  for (const ev of log) {
    const t = typeOf(ev.type)
    if (t?.ref && ev.ref && !closedBy.has(ev.ref)) closedBy.set(ev.ref, { id: ev.id, type: ev.type, mode: t.ref.mode, label: t.label })
  }
  const entities = [...new Set(log.map((e) => e.entity).filter(Boolean))]
  const projections = {}
  for (const p of def.projections) {
    if (p.kind === 'balance') {
      projections[p.key] = entities.map((ent) => {
        const mine = log.filter((e) => e.entity === ent)
        const row = { entity: ent }
        for (const c of p.columns) {
          let v = 0
          for (const t of c.terms) {
            const xs = mine.filter((e) => e.type === t.event)
            if (t.op === 'count') v += t.sign * xs.length
            else if (t.op === 'sum') v += t.sign * xs.reduce((a, e) => a + (Number(e[t.field]) || 0), 0)
            else if (xs.length) v += t.sign * Math[t.op](...xs.map((e) => Number(e[t.field]) || 0))
          }
          row[c.key] = Math.round(v * 1e6) / 1e6
        }
        for (const c of p.computed) row[c.key] = evalExpr(parseExpr(c.expr), row)
        return row
      })
    } else if (p.kind === 'open') {
      projections[p.key] = log.filter((e) => e.type === p.event && !(closedBy.has(e.id) && p.closedBy.includes(closedBy.get(e.id).type)))
    } else if (p.kind === 'latest') {
      projections[p.key] = entities.map((ent) => {
        const row = { entity: ent }
        for (const c of p.columns) row[c.key] = [...log].reverse().find((e) => e.entity === ent && e.type === c.event && e[c.field] !== '' && e[c.field] != null)?.[c.field] ?? ''
        return row
      })
    }
  }
  return { projections, closedBy: Object.fromEntries(closedBy), entities }
}

// restricted numbers in balances: a person's value only for that person (and the folder owner,
// rank 4); team totals of restricted columns only from the full log and only with >= K_ANON people.
// Mutates the viewer's projections (masked → null, listed in row._masked); returns the totals.
export function maskBalances(def, projections, fullProjections, me) {
  const restrictedKeys = new Set(def.fields.filter(restricted).map((f) => f.key))
  const totals = {}
  for (const p of def.projections.filter((x) => x.kind === 'balance')) {
    const t = (totals[p.key] = {})
    const rows = projections[p.key] || []
    for (const c of p.columns) {
      if (c.terms.some((x) => x.field && restrictedKeys.has(x.field))) {
        if (me.rank < 4) for (const row of rows) if (row.entity !== me.id) { row[c.key] = null; (row._masked ||= []).push(c.key) }
        const all = fullProjections?.[p.key] || []
        t[c.key] = all.length >= K_ANON ? all.reduce((a, r) => a + (Number(r[c.key]) || 0), 0) : null
      } else t[c.key] = rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0)
    }
    for (const c of p.computed) {
      const ids = [...exprIds(parseExpr(c.expr))]
      for (const row of rows) if (ids.some((k) => row._masked?.includes(k))) { row[c.key] = null; row._masked.push(c.key) }
      t[c.key] = ids.some((k) => t[k] === null) ? null : evalExpr(parseExpr(c.expr), t)
    }
  }
  return totals
}

// ---------- workbook: 이벤트 tab (append-only log) + one tab per projection ----------
const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }
const ENVELOPE = ['ID', '시각', '기록한 사람', '종류']
export function logHeaders(def) { return [...ENVELOPE, def.entity.label, '대상 기록', ...def.fields.map((f) => f.label)] }
const q = (s) => `"${String(s).replace(/"/g, '""')}"`

// names: id -> display name (people), so the sheet shows names, not user ids
export async function eventsBook(def, events, { names = (x) => x, hidden = new Set() } = {}) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'process gpt 패널 앱'
  const ws = wb.addWorksheet(LOG_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  const heads = logHeaders(def)
  ws.addRow(heads)
  ws.getRow(1).font = { bold: true }
  heads.forEach((h, i) => { ws.getColumn(i + 1).width = i === 0 ? 12 : i === 1 ? 18 : Math.min(30, Math.max(10, h.length * 2 + 4)) })
  const log = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  for (const e of log) {
    const label = def.events.find((x) => x.type === e.type)?.label || e.type
    ws.addRow([e.id, String(e.at || '').slice(0, 19).replace('T', ' '), names(e.by), label, def.entity.type === 'person' ? names(e.entity) : e.entity, e.ref || '',
      ...def.fields.map((f) => (hidden.has(`${e.id}:${f.key}`) || (e._hidden || []).includes(f.key) ? '비공개' : e[f.key] === '' || e[f.key] == null ? null : e[f.key]))])
  }
  const { projections } = replay(def, events)
  const L = (i) => `${q(LOG_SHEET).replace(/"/g, "'")}!$${colLetter(i)}:$${colLetter(i)}`
  const typeCol = 4, entCol = 5
  for (const p of def.projections) {
    const pw = wb.addWorksheet(p.label)
    if (p.kind === 'balance') {
      const hs = [def.entity.label, ...p.columns.map((c) => c.label), ...p.computed.map((c) => c.label)]
      pw.addRow(hs); pw.getRow(1).font = { bold: true }
      hs.forEach((h, i) => { pw.getColumn(i + 1).width = Math.max(10, h.length * 2 + 4) })
      projections[p.key].forEach((row, i) => {
        const r = i + 2
        const cells = [def.entity.type === 'person' ? names(row.entity) : row.entity]
        // SUMIFS / COUNTIFS over the log: still right when a row is appended in the sheet editor
        for (const c of p.columns) {
          const parts = c.terms.map((t) => {
            const crit = `${L(typeCol)},${q(def.events.find((e) => e.type === t.event).label)},${L(entCol)},$A${r}`
            const body = t.op === 'count' ? `COUNTIFS(${crit})` : t.op === 'sum' ? `SUMIFS(${L(7 + def.fields.findIndex((f) => f.key === t.field))},${crit})` : null
            return body ? `${t.sign < 0 ? '-' : '+'}${body}` : null
          })
          cells.push(parts.every(Boolean) ? { formula: parts.join('').replace(/^\+/, ''), result: row[c.key] } : row[c.key])
        }
        for (const c of p.computed) {
          const f = c.expr.replace(/[a-z_][a-z0-9_]*/g, (k) => { const j = p.columns.findIndex((x) => x.key === k); return j >= 0 ? `${colLetter(j + 2)}${r}` : k })
          cells.push({ formula: f, result: row[c.key] })
        }
        pw.addRow(cells)
      })
    } else if (p.kind === 'open') {
      const ev = def.events.find((e) => e.type === p.event)
      const fs = def.fields.filter((f) => ev.fields.includes(f.key))
      pw.addRow(['ID', '시각', def.entity.label, ...fs.map((f) => f.label)]); pw.getRow(1).font = { bold: true }
      for (const e of projections[p.key]) pw.addRow([e.id, String(e.at || '').slice(0, 19).replace('T', ' '), def.entity.type === 'person' ? names(e.entity) : e.entity, ...fs.map((f) => ((e._hidden || []).includes(f.key) ? '비공개' : e[f.key] ?? ''))])
    } else if (p.kind === 'latest') {
      pw.addRow([def.entity.label, ...p.columns.map((c) => c.label)]); pw.getRow(1).font = { bold: true }
      for (const row of projections[p.key]) pw.addRow([def.entity.type === 'person' ? names(row.entity) : row.entity, ...p.columns.map((c) => row[c.key])])
    }
    pw.addRow([])
    pw.addRow([`이 탭은 '${LOG_SHEET}' 탭을 다시 계산(replay)한 결과예요. 고치려면 '${LOG_SHEET}' 탭 맨 아래에 기록을 더하세요.`]).font = { italic: true, color: { argb: 'FF888888' } }
  }
  return wb
}

// the log as it is in a (possibly edited) workbook; unknown ids → new rows
export function readLog(wb, def, { ids = (x) => x } = {}) {
  const ws = wb.getWorksheet(LOG_SHEET)
  if (!ws) throw err(422, `'${LOG_SHEET}' 탭이 없어요.`)
  const head = new Map()
  ws.getRow(1).eachCell((c, i) => head.set(String(c.value ?? '').trim(), i))
  const at = (row, label) => { const i = head.get(label); if (!i) return ''; const v = row.getCell(i).value; return v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join('') : '')) : v ?? '' }
  const out = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const typeLabel = String(at(row, '종류') || '').trim()
    const entity = String(at(row, def.entity.label) || '').trim()
    if (!typeLabel && !entity) continue
    const when = at(row, '시각')
    const e = { _row: r, seq: r, at: when instanceof Date ? when.toISOString() : String(when || '').trim(), by: ids(String(at(row, '기록한 사람') || '').trim()), id: String(at(row, 'ID') || '').trim(), type: def.events.find((x) => x.label === typeLabel || x.type === typeLabel)?.type || typeLabel, entity: def.entity.type === 'person' ? ids(entity) : entity, ref: String(at(row, '대상 기록') || '').trim() || null }
    for (const f of def.fields) e[f.key] = coerce(f, at(row, f.label))
    out.push(e)
  }
  return out
}

// compare a saved log with the current one: existing events must be untouched (append-only); rows
// below with no (or an unknown) id are new events. Changed/removed events are reported, not applied.
export function diffLog(def, current, saved, { names = (x) => x } = {}) {
  const byId = new Map(current.map((e) => [e.id, e]))
  const same = (a, b) => a.type === b.type && String(a.entity ?? '') === String(b.entity ?? '') && String(a.ref ?? '') === String(b.ref ?? '') &&
    def.fields.every((f) => String(b[f.key] ?? '') === '비공개' || String(a[f.key] ?? '') === String(b[f.key] ?? ''))
  const rejected = [], added = []
  const kept = new Set()
  for (const s of saved) {
    const cur = s.id && byId.get(s.id)
    if (cur) { kept.add(s.id); if (!same(cur, s)) rejected.push({ id: s.id, reason: '이미 있는 기록은 고칠 수 없어요(정정·취소 기록을 더해 주세요).', row: labelOf(def, cur, names) }) }
    else added.push(s)
  }
  for (const c of current) if (!kept.has(c.id)) rejected.push({ id: c.id, reason: '기록은 지울 수 없어요(취소 기록을 더해 주세요).', row: labelOf(def, c, names) })
  return { added, rejected }
}
const labelOf = (def, e, names = (x) => x) => `${def.events.find((x) => x.type === e.type)?.label || e.type} · ${names(e.entity) || ''}`.slice(0, 40)

// ---------- database (tier db): an append-only events table ----------
export function createEventsSql(def, appId, fid) {
  const Q = R.qualified(appId)
  const T = R.tableName(appId)
  const types = def.events.map((e) => R.literal(e.type)).join(', ')
  const ctx = { fid, table: Q, row: `${Q}.` }
  const fieldsSql = def.fields.map((f) => `${R.col(f.key)} ${R.SQL_TYPE[f.type] || 'text'}${f.type === 'choice' ? ` check (${R.col(f.key)} is null or ${R.col(f.key)} in (${f.choices.map(R.literal).join(', ')}))` : ''}`)
  const refChecks = def.events.map((e) => {
    const keep = new Set([...e.fields, ...(e.ref?.inherit || [])])
    const clear = def.fields.filter((f) => !keep.has(f.key)).map((f) => `new.${R.col(f.key)} := null;`).join(' ')
    if (!e.ref) return `  if new."type" = ${R.literal(e.type)} then
    if new."ref" is not null then raise exception using errcode = '22023', message = 'panel_ref_unexpected'; end if;
    ${clear}
  end if;`
    const closers = def.events.filter((x) => x.ref && x.ref.types.some((t) => e.ref.types.includes(t))).map((x) => R.literal(x.type)).join(', ')
    return `  if new."type" = ${R.literal(e.type)} then
    select * into r from ${Q} where id = new."ref";
    if not found or r."type" not in (${e.ref.types.map(R.literal).join(', ')}) then raise exception using errcode = '22023', message = 'panel_ref_invalid'; end if;
    if exists (select 1 from ${Q} c where c."ref" = new."ref" and c."type" in (${closers})) then raise exception using errcode = '22023', message = 'panel_ref_closed'; end if;
    new."entity" := r."entity";
    ${e.ref.inherit.map((k) => `new.${R.col(k)} := r.${R.col(k)};`).join(' ')}
    ${clear}
  end if;`
  }).join('\n')
  return [
    `create table ${Q} (
  seq bigserial unique,
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null default ${R.literal(fid)}::uuid,
  at timestamptz not null default now(),
  "by" uuid not null default auth.uid(),
  "type" text not null check ("type" in (${types})),
  "entity" text,
  "ref" uuid references ${Q}(id)${fieldsSql.map((x) => `,\n  ${x}`).join('')}
)`,
    `alter table ${Q} enable row level security`,
    // append-only: no update/delete policy or privilege, and a trigger that refuses them anyway
    `create or replace function panel_data.${R.ident(`${T}_guard`)}() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $guard$
declare r record;
begin
  if tg_op <> 'INSERT' then raise exception using errcode = '42501', message = 'panel_append_only'; end if;
  new.folder_id := ${R.literal(fid)}::uuid;
  if auth.uid() is not null then new.id := gen_random_uuid(); new.at := now(); new."by" := auth.uid(); end if;
${refChecks}
  if new."entity" is null or new."entity" = '' then raise exception using errcode = '22023', message = 'panel_entity_required'; end if;
  return new;
end $guard$`,
    `create trigger "guard" before insert or update or delete on ${Q} for each row execute function panel_data.${R.ident(`${T}_guard`)}()`,
    ...eventsPolicySql(def, appId, fid),
  ]
}

// who may read and append (and what is masked): recompiled whenever rules or sensitivity change
export function eventsPolicySql(def, appId, fid) {
  const Q = R.qualified(appId)
  const T = R.tableName(appId)
  const ctx = { fid, table: Q, row: `${Q}.` }
  const insertCheck = def.events.map((e) => `("type" = ${R.literal(e.type)} and (${e.who.map((t) => R.termSql(def, t, ctx)).join(' or ')}))`).join(' or ')
  const open = ['seq', 'id', 'folder_id', 'at', 'by', 'type', 'entity', 'ref', ...def.fields.filter((f) => !restricted(f)).map((f) => `c_${f.key}`)]
  const V = `panel_data.${R.ident(R.viewName(appId))}`
  const vctx = { fid, table: Q, row: 'e.' }
  const readers = (f) => readersFor(def, f)
  const cols = def.fields.map((f) => (readers(f) ? `case when ${R.listSql(def, readers(f), vctx)} then e.${R.col(f.key)} end as ${R.col(f.key)}` : `e.${R.col(f.key)}`))
  const hidden = def.fields.filter(readers).map((f) => `case when not ${R.listSql(def, readers(f), vctx)} then ${R.literal(f.key)} end`)
  return [
    `drop policy if exists "pa_read" on ${Q}`,
    `drop policy if exists "pa_append" on ${Q}`,
    `drop view if exists ${V}`,
    `create policy "pa_read" on ${Q} for select to authenticated using ${R.listSql(def, def.access.read, ctx)}`,
    `create policy "pa_append" on ${Q} for insert to authenticated with check (panel_data.folder_role(${R.literal(fid)}::uuid) >= 1 and (${insertCheck}))`,
    `revoke all on ${Q} from public, anon, authenticated`,
    `grant select (${open.map(R.ident).join(', ')}) on ${Q} to authenticated`,
    `grant insert on ${Q} to authenticated`,
    `grant usage on sequence panel_data.${R.ident(`${T}_seq_seq`)} to authenticated`,
    `create view ${V} with (security_barrier = true) as select e.seq, e.id, e.at, e."by", e."type", e."entity", e."ref", ${cols.join(', ')}, ${hidden.length ? `array_remove(array[${hidden.join(', ')}]::text[], null)` : `'{}'::text[]`} as _hidden from ${Q} e where ${R.listSql(def, def.access.read, vctx)}`,
    `revoke all on ${V} from public, anon`,
    `grant select on ${V} to authenticated`,
  ]
}
// field readers for events: the subject is the entity
function readersFor(def, f) {
  const lvl = f.sensitivity
  if (lvl !== 'personal' && lvl !== 'sensitive') return null
  const subj = def.entity.type === 'person'
  return lvl === 'personal' ? [...(subj ? ['subject_is_me'] : []), 'owner_of_row', 'role>=owner'] : [...(subj ? ['subject_is_me'] : ['owner_of_row']), 'role>=owner']
}
export { readersFor }

// ---------- words ----------
export function describeEvents(def, names = (x) => x) {
  return def.events.map((e) => ({
    type: e.type, label: e.label,
    who: e.who.map((t) => ({ member: '구성원 모두', owner_of_row: '기록한 사람', subject_is_me: `본인(${def.entity.label})`, owner_of_ref: '원래 기록을 한 사람', 'role>=editor': '편집 권한 이상', 'role>=owner': '폴더 소유자', 'role>=runner': '실행 권한 이상', 'role>=viewer': '보기 권한 이상', nobody: '아무도' }[t] || '조건')).join(' 또는 '),
  }))
}
