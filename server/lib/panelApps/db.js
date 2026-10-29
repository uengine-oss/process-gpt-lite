// Panel apps, tier "db": data in panel_data.app_<id> guarded by RLS.
// Every read and write of a person runs in a transaction that has become that person:
//   set local role authenticated; request.jwt.claims = the claims of their (already verified) JWT
// so the database — the policies and the guard trigger compiled in rules.js — decides what they
// may see and change, not this code. Only schema changes and the server's own maintenance (the
// first import when an app is upgraded from a sheet) run as the database owner.
import { pool, q } from '../supa.js'
import * as R from './rules.js'
import { withComputed } from './sheet.js'
import { subjectOf } from './privacy.js'
import * as E from './events.js'
import { L } from '../lang.js'

const err = (status, message) => Object.assign(new Error(message), { status })

function claimsOf(user) {
  // the JWT was verified by Supabase auth before it got here (auth middleware / MCP gateway)
  let c = {}
  try { c = JSON.parse(Buffer.from(String(user.jwt || '').split('.')[1] || '', 'base64url').toString('utf8')) } catch { c = {} }
  if (c.sub && c.sub !== user.id) throw err(401, L('JWT 와 사용자가 맞지 않아요.', "The JWT doesn't match the user."))
  return { ...c, sub: user.id, role: 'authenticated', email: user.email }
}

export async function asUser(user, fn, labels) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role authenticated')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsOf(user))])
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw mapError(e, labels)
  } finally {
    // the local set_config leaves 'request.jwt.claims' defined as '' on this pooled connection after the
    // transaction, and tenant_id() ('' ::jsonb) then fails "invalid input syntax for type json" for the next
    // statement that uses it on this connection (chats insert → notifications default): leave valid JSON
    await c.query(`select set_config('request.jwt.claims', '{}', false)`).catch(() => {})
    c.release()
  }
}

export async function asOwner(statements) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    for (const s of statements) await c.query(s)
    // PostgREST (panel_data is exposed through pgrst.db_schemas) re-reads its schema cache
    if (statements.some((s) => /^\s*(create|alter|drop)\b/i.test(s))) await c.query(`notify pgrst, 'reload schema'`)
    await c.query('commit')
  } catch (e) { await c.query('rollback').catch(() => {}); throw e } finally { c.release() }
}

function mapError(e, labels) {
  if (e.status) return e
  const m = String(e.message || '')
  const denied = m.match(/panel_field_denied:([a-z0-9_]+)/)
  if (denied) return err(403, L(`'${labels?.[denied[1]] || denied[1]}' 항목은 바꿀 권한이 없어요(데이터베이스가 거절했어요).`, `You may not change '${labels?.[denied[1]] || denied[1]}' (the database refused).`))
  if (/panel_append_only/.test(m)) return err(403, L('기록은 고치거나 지울 수 없어요. 취소·정정 기록을 더해 주세요.', "Records can't be changed or deleted. Add a cancellation or correction instead."))
  if (/panel_ref_closed/.test(m)) return err(409, L('이미 취소(또는 처리)된 기록이에요.', 'That record has already been canceled (or handled).'))
  if (/panel_ref_invalid/.test(m)) return err(422, L('대상 기록을 찾지 못했어요(볼 수 없거나 종류가 맞지 않아요).', "I couldn't find the record it applies to (you can't see it, or it's the wrong type)."))
  if (/panel_entity_required/.test(m)) return err(422, L('누구(무엇)에 관한 기록인지 적어 주세요.', 'Please say who (or what) the record is about.'))
  if (e.code === '42501' && /permission denied/.test(m)) return err(403, L('이 항목을 볼 권한이 없어요(데이터베이스가 거절했어요).', 'You may not see this field (the database refused).'))
  if (e.code === '42501' || /row-level security/.test(m)) return err(403, L('이 작업을 할 권한이 없어요(데이터베이스가 거절했어요).', 'You may not do this (the database refused).'))
  if (e.code === '23514') return err(422, L('값이 항목 조건(선택지·형식)에 맞지 않아요.', "The value doesn't fit the field (its choices or format)."))
  if (e.code === '22P02' || e.code === '22007' || e.code === '22008') return err(422, L('값의 형식이 맞지 않아요.', 'The value is in the wrong format.'))
  return e
}

const labelsOf = (app) => Object.fromEntries(app.def.fields.map((f) => [f.key, f.label]))
// reads go through the masked view (restricted columns have no select privilege on the table)
const V = (app) => `panel_data.${R.ident(R.viewName(app.id))}`
const selectList = (def) => ['id', 'created_by', 'created_at', 'updated_at::text as _v', '_hidden',
  ...def.fields.map((f) => {
    const c = R.col(f.key)
    return f.type === 'date' ? `to_char(${c}, 'YYYY-MM-DD') as ${c}` : f.type === 'number' ? `${c}::float8 as ${c}` : c
  })].join(', ')

function toRow(def, r) {
  const vals = {}
  for (const f of def.fields) { const v = r[`c_${f.key}`]; vals[f.key] = v === null || v === undefined ? (f.type === 'checkbox' ? false : '') : v }
  const subject = subjectOf(def)
  for (const k of r._hidden || []) vals[k] = ''
  return { _id: r.id, _v: r._v, _created_by: r.created_by, _created_at: r.created_at, _hidden: r._hidden || [], _subject: subject ? vals[subject] : null, ...withComputed(def, vals) }
}
const dbValue = (f, v) => (v === '' || v === undefined ? null : v)

export async function rows(user, app) {
  return asUser(user, async (c) => (await c.query(`select ${selectList(app.def)} from ${V(app)} order by created_at`)).rows.map((r) => toRow(app.def, r)))
}

export async function insert(user, app, vals) {
  const keys = app.def.fields.filter((f) => f.key in vals).map((f) => f.key)
  return asUser(user, async (c) => {
    const r = await c.query(`insert into ${R.qualified(app.id)} (${keys.map(R.col).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      keys.map((k) => dbValue(app.def.fields.find((f) => f.key === k), vals[k])))
    const back = await c.query(`select ${selectList(app.def)} from ${V(app)} where id = $1`, [r.rows[0].id])
    return back.rows[0] ? toRow(app.def, back.rows[0]) : { _id: r.rows[0].id }
  }, labelsOf(app))
}

// v = the row's updated_at as the client read it; nothing is written when it moved on
export async function update(user, app, id, v, vals) {
  const keys = app.def.fields.filter((f) => f.key in vals).map((f) => f.key)
  if (!keys.length) throw err(400, L('바꿀 항목이 없어요.', 'Nothing to change.'))
  return asUser(user, async (c) => {
    const params = keys.map((k) => dbValue(app.def.fields.find((f) => f.key === k), vals[k]))
    params.push(id)
    let where = `id = $${params.length}::uuid`
    if (v) { params.push(v); where += ` and updated_at::text = $${params.length}` }
    const r = await c.query(`update ${R.qualified(app.id)} set ${keys.map((k, i) => `${R.col(k)} = $${i + 1}`).join(', ')} where ${where} returning id`, params)
    if (r.rows.length) { const back = await c.query(`select ${selectList(app.def)} from ${V(app)} where id = $1`, [id]); return back.rows[0] ? toRow(app.def, back.rows[0]) : { _id: id } }
    return explain(c, app, id, v, L('고칠', 'edit'))
  }, labelsOf(app))
}

export async function remove(user, app, id, v) {
  return asUser(user, async (c) => {
    const params = [id]
    let where = 'id = $1::uuid'
    if (v) { params.push(v); where += ' and updated_at::text = $2' }
    const r = await c.query(`delete from ${R.qualified(app.id)} where ${where} returning id`, params)
    if (r.rows.length) return { id }
    return explain(c, app, id, v, L('지울', 'delete'))
  })
}

// nothing matched: the row is gone or hidden, it changed since it was read, or RLS said no
async function explain(c, app, id, v, verb) {
  const seen = await c.query(`select updated_at::text as _v from ${R.qualified(app.id)} where id = $1::uuid`, [id])
  if (!seen.rows.length) throw err(404, L('그 행이 없거나 볼 수 없어요.', "That row isn't there, or you can't see it."))
  if (v && seen.rows[0]._v !== v) throw err(409, L('다른 사람이 먼저 고쳤어요. 새로 불러온 값을 확인해 주세요.', 'Someone else changed it first. Please check the values just loaded.'))
  throw err(403, L(`이 행을 ${verb} 권한이 없어요(데이터베이스가 거절했어요).`, `You may not ${verb} this row (the database refused).`))
}

// ---------- schema ----------
export async function logMigration(app, kind, statements, { destructive = false, user, note } = {}) {
  const [{ v }] = await q('select coalesce(max(version), 0) + 1 as v from pro_panel_app_migrations where app_id=$1', [app.id])
  await q(`insert into pro_panel_app_migrations (app_id, version, kind, statements, destructive, applied_by, note) values ($1,$2,$3,$4,$5,$6,$7)`,
    [app.id, v, kind, statements, destructive, user?.id || null, note || null])
  return v
}

export async function createTable(app, folderId, user) {
  const statements = R.createSql(app.def, app.id, folderId)
  await asOwner(statements)
  await q('update pro_panel_apps set tier=$2, db_table=$3 where id=$1', [app.id, 'db', `panel_data.${R.tableName(app.id)}`])
  await logMigration(app, 'create', statements, { user })
  return statements
}

// the server's own import (sheet → db upgrade): rows keep their author when known
export async function importRows(app, rows, ownerId) {
  const keys = app.def.fields.map((f) => f.key)
  const statements = []
  const c = await pool.connect()
  try {
    await c.query('begin')
    for (const r of rows) {
      const params = [r._author || ownerId, ...keys.map((k) => dbValue(null, r[k]))]
      await c.query(`insert into ${R.qualified(app.id)} (created_by, ${keys.map(R.col).join(', ')}) values ($1::uuid, ${keys.map((_, i) => `$${i + 2}`).join(', ')})`, params)
    }
    await c.query('commit')
    statements.push(`-- ${rows.length} rows imported from the sheet`)
  } catch (e) { await c.query('rollback').catch(() => {}); throw mapError(e, labelsOf(app)) } finally { c.release() }
  return statements
}

// every row, as the database owner — only for the folder snapshot, filtered by rules.allows()
export async function allRowsAsOwner(app) {
  return (await q(`select ${selectList(app.def).replace("'_hidden', ", '').replace('_hidden, ', '')} from ${R.qualified(app.id)} order by created_at`)).map((r) => toRow(app.def, r))
}

// ---------- events (kind events) ----------
const evSelect = (def) => ['seq::int as seq', 'id', 'at', '"by"', '"type"', '"entity"', '"ref"',
  ...def.fields.map((f) => { const c = R.col(f.key); return f.type === 'date' ? `to_char(${c}, 'YYYY-MM-DD') as ${c}` : f.type === 'number' ? `${c}::float8 as ${c}` : c })]
function toEvent(def, r) {
  const e = { seq: r.seq, id: r.id, at: r.at instanceof Date ? r.at.toISOString() : r.at, by: r.by, type: r.type, entity: r.entity, ref: r.ref, _hidden: r._hidden || [] }
  for (const f of def.fields) { const v = r[`c_${f.key}`]; e[f.key] = v === null || v === undefined ? '' : v }
  return e
}
export async function events(user, app) {
  return asUser(user, async (c) => (await c.query(`select ${evSelect(app.def).join(', ')}, _hidden from ${V(app)} order by seq`)).rows.map((r) => toEvent(app.def, r)), labelsOf(app))
}
export async function eventsAsOwner(app) {
  return (await q(`select ${evSelect(app.def).join(', ')} from ${R.qualified(app.id)} order by seq`)).map((r) => toEvent(app.def, r))
}
// one event appended as this person: the policies decide whether they may append this type about
// this subject, the trigger fills id/at/by and copies what an amendment inherits
export async function append(user, app, ev) {
  const keys = app.def.fields.filter((f) => f.key in ev.values).map((f) => f.key)
  return asUser(user, async (c) => {
    const r = await c.query(`insert into ${R.qualified(app.id)} ("type", "entity", "ref"${keys.map((k) => `, ${R.col(k)}`).join('')}) values ($1, $2, $3${keys.map((_, i) => `, $${i + 4}`).join('')}) returning id`,
      [ev.type, ev.entity, ev.ref, ...keys.map((k) => dbValue(null, ev.values[k]))])
    const back = await c.query(`select ${evSelect(app.def).join(', ')}, _hidden from ${V(app)} where id = $1`, [r.rows[0].id])
    return back.rows[0] ? toEvent(app.def, back.rows[0]) : { id: r.rows[0].id }
  }, labelsOf(app))
}
export async function createEventsTable(app, folderId, user) {
  const statements = E.createEventsSql(app.def, app.id, folderId)
  await asOwner(statements)
  await q('update pro_panel_apps set tier=$2, db_table=$3, kind=$4 where id=$1', [app.id, 'db', `panel_data.${R.tableName(app.id)}`, 'events'])
  await logMigration(app, 'create', statements, { user })
  return statements
}
// the server's own import (a list app converted to events): kept author, time and order
export async function importEvents(app, evs) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    for (const e of evs) {
      const keys = app.def.fields.filter((f) => e[f.key] !== undefined && e[f.key] !== '').map((f) => f.key)
      await c.query(`insert into ${R.qualified(app.id)} (id, at, "by", "type", "entity", "ref"${keys.map((k) => `, ${R.col(k)}`).join('')}) values ($1, $2, $3, $4, $5, $6${keys.map((_, i) => `, $${i + 7}`).join('')})`,
        [e.id, e.at, e.by, e.type, e.entity, e.ref || null, ...keys.map((k) => e[k])])
    }
    await c.query('commit')
  } catch (e) { await c.query('rollback').catch(() => {}); throw mapError(e, labelsOf(app)) } finally { c.release() }
}

export async function dropTable(app) {
  const T = R.tableName(app.id)
  const statements = [`drop table if exists ${R.qualified(app.id)} cascade`, `drop function if exists panel_data.${R.ident(`${T}_guard`)}()`]
  await asOwner(statements)
  return statements
}
