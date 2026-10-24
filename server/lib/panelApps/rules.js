// Panel apps, tier "db": access rules → Postgres (RLS policies + a guard trigger).
// The model (or the owner in the "권한 규칙" sheet) only ever writes a declarative rule set in the
// app definition; nothing it writes reaches SQL as text. This module
//   - validates the rule set against a small fixed vocabulary,
//   - compiles it with fixed templates: identifiers are generated here (table from the app id,
//     columns c_<key> where key matched ^[a-z][a-z0-9_]{0,30}$), constants become quoted literals
//     checked against the field's type,
//   - mirrors the same rules in JS so the panel can grey out what the database would refuse.
//
// Vocabulary (a list = any one of its terms is enough; every rule also requires folder membership):
//   'member'            any folder member (role >= viewer)
//   'role>=viewer|runner|editor|owner'
//   'owner_of_row'      created_by = auth.uid()   (events: by = auth.uid())
//   'subject_is_me'     the record is about the caller (its subject person field / the event's entity)
//   'owner_of_ref'      events only: the event this one refers to (e.g. the request it cancels) is the caller's
//   'nobody'
//   {field_is_me: key}                    a person field holds the caller's user id
//   {field_equals: {field: key, value}}   a field equals a constant
//   {all: [terms]}                        every term holds (one level deep)
// access = {read, create, update, delete: [terms]}, fieldRules = {key: {update: [terms]}}
import { readersOf, restricted, subjectOf } from './privacy.js'
const err = (status, message) => Object.assign(new Error(message), { status })

export const ROLE_RANK = { viewer: 1, runner: 2, editor: 3, owner: 4 }
export const ACTIONS = ['read', 'create', 'update', 'delete']
export const DEFAULT_ACCESS = { read: ['member'], create: ['member'], update: ['owner_of_row', 'role>=owner'], delete: ['owner_of_row', 'role>=owner'] }
const KEY = /^[a-z][a-z0-9_]{0,30}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ---------- SQL quoting (only used on values that already passed validation) ----------
export const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw err(400, `잘못된 이름: ${s}`)
  return `"${s}"`
}
export function literal(v) {
  const s = String(v)
  if (s.includes('\0')) throw err(400, '값에 쓸 수 없는 글자가 있어요.')
  return `'${s.replace(/'/g, "''")}'` // standard_conforming_strings = on: backslashes are plain
}
export const col = (key) => { if (!KEY.test(key)) throw err(400, `항목 key 가 올바르지 않아요: ${String(key).slice(0, 40)}`); return ident(`c_${key}`) }
export const tableName = (appId) => { if (!UUID.test(appId)) throw err(400, 'app id'); return `app_${appId.replace(/-/g, '').slice(0, 16)}` }
export const qualified = (appId) => `panel_data.${ident(tableName(appId))}`

export const SQL_TYPE = { text: 'text', longtext: 'text', email: 'text', phone: 'text', person: 'text', choice: 'text', time: 'text', number: 'numeric', date: 'date', checkbox: 'boolean' }

// a constant for a field, checked against its type and rendered as a typed literal
export function constant(field, value) {
  const t = field.type
  if (t === 'number') { const n = Number(value); if (value === '' || value === null || !Number.isFinite(n)) throw err(400, `'${field.label}' 비교 값은 숫자여야 해요.`); return `${n}::numeric` }
  if (t === 'checkbox') { if (typeof value !== 'boolean' && !/^(true|false)$/.test(String(value))) throw err(400, `'${field.label}' 비교 값은 true/false 예요.`); return String(value) === 'true' ? 'true' : 'false' }
  if (t === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw err(400, `'${field.label}' 비교 값은 날짜예요.`); return `${literal(value)}::date` }
  if (t === 'choice' && !field.choices.includes(String(value))) throw err(400, `'${field.label}' 비교 값은 ${field.choices.join(', ')} 중 하나예요.`)
  if (String(value).length > 200) throw err(400, '비교 값이 너무 길어요.')
  return `${literal(value)}::text`
}

// ---------- validation ----------
function checkTerm(def, t, depth = 0) {
  if (typeof t === 'string') {
    if (['member', 'owner_of_row', 'nobody'].includes(t)) return t
    if (t === 'subject_is_me') { if (!subjectOf(def)) throw err(400, "'본인' 규칙에는 사람 항목(기록의 대상)이 필요해요."); return t }
    if (t === 'owner_of_ref') { if (def.kind !== 'events') throw err(400, "'참조한 기록의 주인' 규칙은 이벤트 앱에서만 써요."); return t }
    const m = t.match(/^role>=(viewer|runner|editor|owner)$/)
    if (m) return t
    throw err(400, `알 수 없는 규칙: ${t.slice(0, 40)}`)
  }
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw err(400, '규칙 형식이 올바르지 않아요.')
  const keys = Object.keys(t)
  if (keys.length !== 1) throw err(400, '규칙 하나에는 종류 하나만 써요.')
  const field = (k) => def.fields.find((f) => f.key === k) || (() => { throw err(400, `규칙이 없는 항목을 가리켜요: ${String(k).slice(0, 40)}`) })()
  if (t.field_is_me !== undefined) {
    const f = field(t.field_is_me)
    if (!['person', 'text'].includes(f.type)) throw err(400, `'${f.label}' 은(는) 사람 항목이 아니에요.`)
    return { field_is_me: f.key }
  }
  if (t.field_equals !== undefined) {
    const f = field(t.field_equals?.field)
    constant(f, t.field_equals.value) // throws when the value does not fit
    return { field_equals: { field: f.key, value: f.type === 'number' ? Number(t.field_equals.value) : f.type === 'checkbox' ? String(t.field_equals.value) === 'true' : String(t.field_equals.value) } }
  }
  if (t.all !== undefined) {
    if (depth > 0 || !Array.isArray(t.all) || !t.all.length || t.all.length > 4) throw err(400, "'모두' 규칙은 한 단계, 1~4개까지예요.")
    return { all: t.all.map((x) => checkTerm(def, x, depth + 1)) }
  }
  throw err(400, `알 수 없는 규칙: ${keys[0].slice(0, 40)}`)
}
const checkList = (def, list, name) => {
  if (!Array.isArray(list) || !list.length) throw err(400, `'${name}' 규칙이 비어 있어요.`)
  if (list.length > 6) throw err(400, `'${name}' 규칙이 너무 많아요.`)
  return list.map((t) => checkTerm(def, t))
}

// strict: the owner's edit is refused on any problem. lenient (model output): a bad list falls back
// to the default for that action, a bad field rule is dropped.
export function validateAccess(def, raw = {}, { strict = true } = {}) {
  for (const f of def.fields) if (!KEY.test(f.key)) throw err(400, `항목 key 가 올바르지 않아요: ${f.key}`)
  const access = {}
  for (const a of ACTIONS) {
    const list = raw.access?.[a] ?? DEFAULT_ACCESS[a]
    try { access[a] = checkList(def, list, a) } catch (e) { if (strict) throw e; access[a] = DEFAULT_ACCESS[a] }
  }
  const fieldRules = {}
  for (const [k, r] of Object.entries(raw.fieldRules || {})) {
    try {
      if (!def.fields.some((f) => f.key === k)) throw err(400, `규칙이 없는 항목을 가리켜요: ${String(k).slice(0, 40)}`)
      fieldRules[k] = { update: checkList(def, r?.update, `${k}.update`) }
    } catch (e) { if (strict) throw e }
  }
  return { access, fieldRules }
}

// ---------- compile ----------
export function termSql(def, t, { fid, row = '', table }) {
  if (t === 'member') return `panel_data.folder_role(${literal(fid)}::uuid) >= 1`
  if (t === 'nobody') return 'false'
  if (t === 'owner_of_row') return def.kind === 'events' ? `${row}"by" = auth.uid()` : `${row}created_by = auth.uid()`
  if (t === 'subject_is_me') return `${row}${def.kind === 'events' ? '"entity"' : col(subjectOf(def))} = auth.uid()::text`
  if (t === 'owner_of_ref') return `exists (select 1 from ${table} r where r.id = ${row}"ref" and r."by" = auth.uid())`
  if (typeof t === 'string') return `panel_data.folder_role(${literal(fid)}::uuid) >= ${ROLE_RANK[t.slice(6)]}`
  if (t.field_is_me) return `${row}${col(t.field_is_me)} = auth.uid()::text`
  if (t.field_equals) { const f = def.fields.find((x) => x.key === t.field_equals.field); return `${row}${col(f.key)} = ${constant(f, t.field_equals.value)}` }
  if (t.all) return `(${t.all.map((x) => termSql(def, x, { fid, row })).join(' and ')})`
  throw err(400, 'rule')
}
export const listSql = (def, list, ctx) => `(panel_data.folder_role(${literal(ctx.fid)}::uuid) >= 1 and (${list.map((t) => termSql(def, t, ctx)).join(' or ')}))`

function columnSql(f) {
  let s = `${col(f.key)} ${SQL_TYPE[f.type] || 'text'}`
  if (f.type === 'choice') s += ` check (${col(f.key)} is null or ${col(f.key)} in (${f.choices.map(literal).join(', ')}))`
  if (f.type === 'time') s += ` check (${col(f.key)} is null or ${col(f.key)} ~ '^[0-2][0-9]:[0-5][0-9]$')`
  return s
}

// the guard trigger: who made a row and when cannot be forged; fieldRules hold per field
function guardSql(def, rules, appId, fid) {
  const T = tableName(appId)
  const checks = Object.entries(rules.fieldRules).map(([k, r]) =>
    `    if new.${col(k)} is distinct from old.${col(k)} and not (${r.update.map((t) => termSql(def, t, { fid, row: 'old.' })).join(' or ')}) then
      raise exception using errcode = '42501', message = ${literal(`panel_field_denied:${k}`)};
    end if;`).join('\n')
  return `create or replace function panel_data.${ident(`${T}_guard`)}() returns trigger language plpgsql set search_path = pg_catalog, public as $guard$
begin
  if tg_op = 'INSERT' then
    new.folder_id := ${literal(fid)}::uuid;
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := coalesce(case when auth.uid() is null then new.created_at end, now());
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by, new.created_by);
    return new;
  end if;
  new.id := old.id; new.folder_id := old.folder_id; new.created_by := old.created_by; new.created_at := old.created_at;
  new.updated_at := now(); new.updated_by := coalesce(auth.uid(), new.updated_by);
  if auth.uid() is not null then
${checks || '    null;'}
  end if;
  return new;
end $guard$`
}

function policySql(def, rules, appId, fid) {
  const Q = qualified(appId)
  const c = { fid }
  return [
    ...['pa_read', 'pa_create', 'pa_update', 'pa_delete'].map((p) => `drop policy if exists ${ident(p)} on ${Q}`),
    `create policy "pa_read" on ${Q} for select to authenticated using ${listSql(def, rules.access.read, c)}`,
    `create policy "pa_create" on ${Q} for insert to authenticated with check ${listSql(def, rules.access.create, c)}`,
    `create policy "pa_update" on ${Q} for update to authenticated using ${listSql(def, rules.access.update, c)} with check ${listSql(def, rules.access.update, c)}`,
    `create policy "pa_delete" on ${Q} for delete to authenticated using ${listSql(def, rules.access.delete, c)}`,
  ]
}

// everything for a new app table
export function createSql(def, appId, fid) {
  if (!UUID.test(fid)) throw err(400, 'folder id')
  const rules = validateAccess(def, def, { strict: true })
  const Q = qualified(appId)
  const T = tableName(appId)
  return [
    `create table ${Q} (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null default ${literal(fid)}::uuid,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid${def.fields.map((f) => `,\n  ${columnSql(f)}`).join('')}
)`,
    `alter table ${Q} enable row level security`,
    guardSql(def, rules, appId, fid),
    `create trigger "guard" before insert or update on ${Q} for each row execute function panel_data.${ident(`${T}_guard`)}()`,
    ...policySql(def, rules, appId, fid),
    ...grantSql(def, appId),
    ...viewSql(def, rules, appId, fid),
  ]
}

// column privileges: a restricted (personal / sensitive) column cannot be selected from the table at
// all — not even through PostgREST; it is read only through the masked view below
function grantSql(def, appId) {
  const Q = qualified(appId)
  const open = ['id', 'folder_id', 'created_by', 'created_at', 'updated_at', 'updated_by', ...def.fields.filter((f) => !restricted(f)).map((f) => `c_${f.key}`)]
  return [
    `revoke all on ${Q} from public, anon, authenticated`,
    `grant select (${open.map(ident).join(', ')}) on ${Q} to authenticated`,
    `grant insert, update, delete on ${Q} to authenticated`,
  ]
}

// the masked view: rows the read rules allow, restricted values only for their readers, and
// _hidden naming what was masked. Owned by the database owner, so it re-applies the read rules
// itself (security_barrier keeps callers' predicates from running before them).
export const viewName = (appId) => `${tableName(appId)}_v`
function viewSql(def, rules, appId, fid) {
  const Q = qualified(appId)
  const V = `panel_data.${ident(viewName(appId))}`
  const ctx = { fid, table: Q }
  const cols = def.fields.map((f) => {
    const r = readersOf(def, f)
    return r ? `case when ${listSql(def, r, ctx)} then ${col(f.key)} end as ${col(f.key)}` : col(f.key)
  })
  const hidden = def.fields.filter((f) => readersOf(def, f)).map((f) => `case when not ${listSql(def, readersOf(def, f), ctx)} then ${literal(f.key)} end`)
  return [
    `drop view if exists ${V}`,
    `create view ${V} with (security_barrier = true) as select id, created_by, created_at, updated_at, ${cols.join(', ')}, ${hidden.length ? `array_remove(array[${hidden.join(', ')}]::text[], null)` : `'{}'::text[]`} as _hidden from ${Q} where ${listSql(def, rules.access.read, ctx)}`,
    `revoke all on ${V} from public, anon`,
    `grant select on ${V} to authenticated`,
  ]
}

// rules changed (fields unchanged): new policies and guard
export function rulesSql(def, appId, fid) {
  const rules = validateAccess(def, def, { strict: true })
  return [guardSql(def, rules, appId, fid), ...policySql(def, rules, appId, fid), ...grantSql(def, appId), ...viewSql(def, rules, appId, fid)]
}

// fields changed: add / retype / drop columns. Drops are destructive and need confirmation.
export function alterSql(oldDef, def, appId, fid) {
  const Q = qualified(appId)
  const before = new Map(oldDef.fields.map((f) => [f.key, f]))
  const after = new Map(def.fields.map((f) => [f.key, f]))
  const out = [], destructive = []
  for (const f of def.fields) {
    const o = before.get(f.key)
    if (!o) out.push(`alter table ${Q} add column ${columnSql(f)}`)
    else if (SQL_TYPE[o.type] !== SQL_TYPE[f.type]) {
      out.push(`alter table ${Q} alter column ${col(f.key)} type ${SQL_TYPE[f.type]} using nullif(${col(f.key)}::text, '')::${SQL_TYPE[f.type]}`)
    }
    if (o && (f.type === 'choice' || o.type === 'choice') && JSON.stringify(o.choices) !== JSON.stringify(f.choices)) {
      // the inline check constraint is named <table>_c_<key>_check
      out.push(`alter table ${Q} drop constraint if exists ${ident(`${tableName(appId)}_c_${f.key}_check`.slice(0, 63))}`)
      if (f.type === 'choice') out.push(`alter table ${Q} add constraint ${ident(`${tableName(appId)}_c_${f.key}_check`.slice(0, 63))} check (${col(f.key)} is null or ${col(f.key)} in (${f.choices.map(literal).join(', ')}))`)
    }
  }
  for (const o of oldDef.fields) if (!after.has(o.key)) destructive.push(`alter table ${Q} drop column ${col(o.key)}`)
  // the view reads the columns: it goes first and comes back with the new shape
  return { statements: [`drop view if exists panel_data.${ident(viewName(appId))}`, ...out, ...rulesSql(def, appId, fid)], destructive: destructive.length ? [`drop view if exists panel_data.${ident(viewName(appId))}`, ...destructive] : [] }
}

// ---------- the same rules in JS (UI hints only — the database decides) ----------
function termHolds(t, row, me) {
  if (t === 'member') return me.rank >= 1
  if (t === 'nobody') return false
  if (t === 'owner_of_row') return !!row && (row._created_by ?? row._by) === me.id
  if (t === 'subject_is_me') return !!row && String(row._subject ?? '') === me.id
  if (t === 'owner_of_ref') return !!row && row._ref_by === me.id
  if (typeof t === 'string') return me.rank >= ROLE_RANK[t.slice(6)]
  if (t.field_is_me) return !!row && String(row[t.field_is_me] ?? '') === me.id
  if (t.field_equals) return !!row && String(row[t.field_equals.field] ?? '') === String(t.field_equals.value)
  if (t.all) return t.all.every((x) => termHolds(x, row, me))
  return false
}
export const allows = (list, row, me) => me.rank >= 1 && list.some((t) => termHolds(t, row, me))
export function rowCan(def, row, me) {
  const r = validateAccess(def, def, { strict: false })
  const fields = {}
  for (const f of def.fields) fields[f.key] = !r.fieldRules[f.key] || allows(r.fieldRules[f.key].update, row, me)
  return { update: allows(r.access.update, row, me), delete: allows(r.access.delete, row, me), fields }
}

// ---------- words ----------
const ROLE_KO = { viewer: '보기 권한 이상', runner: '실행 권한 이상', editor: '편집 권한 이상', owner: '폴더 소유자' }
function termKo(def, t) {
  const label = (k) => def.fields.find((f) => f.key === k)?.label || k
  if (t === 'member') return '구성원 모두'
  if (t === 'nobody') return '아무도 못 함'
  if (t === 'owner_of_row') return def.kind === 'events' ? '기록한 사람' : '만든 사람'
  if (t === 'subject_is_me') return '본인(기록의 대상)'
  if (t === 'owner_of_ref') return '원래 기록을 한 사람'
  if (typeof t === 'string') return ROLE_KO[t.slice(6)]
  if (t.field_is_me) return `'${label(t.field_is_me)}'이(가) 본인인 경우`
  if (t.field_equals) return `'${label(t.field_equals.field)}'이(가) '${t.field_equals.value === true ? '예' : t.field_equals.value === false ? '아니오' : t.field_equals.value}'인 경우`
  if (t.all) return t.all.map((x) => termKo(def, x)).join(' 이면서 ')
  return '?'
}
export function describeRules(def) {
  const r = validateAccess(def, def, { strict: false })
  const A = { read: '보기', create: '만들기', update: '고치기', delete: '지우기' }
  const lines = ACTIONS.map((a) => ({ action: a, label: A[a], text: r.access[a].map((t) => termKo(def, t)).join(' 또는 ') }))
  for (const [k, fr] of Object.entries(r.fieldRules)) lines.push({ action: `field:${k}`, label: `'${def.fields.find((f) => f.key === k)?.label}' 바꾸기`, text: fr.update.map((t) => termKo(def, t)).join(' 또는 ') })
  return lines
}
