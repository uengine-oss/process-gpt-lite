// 패널 앱 권한 규칙 컴파일러: 어휘 검증, 고정 템플릿, 이름·값 주입 시도
import test from 'node:test'
import assert from 'node:assert/strict'
import * as R from '../lib/panelApps/rules.js'
import { normalizeDef } from '../lib/panelApps/sheet.js'

const APP = '11111111-2222-3333-4444-555555555555'
const FID = '99999999-8888-7777-6666-555555555555'
const base = () => normalizeDef({
  title: '공유 캘린더', tier: 'db',
  fields: [
    { key: 'title', label: '제목', type: 'text', required: true },
    { key: 'visibility', label: '공개 범위', type: 'choice', choices: ['공개', '비공개'] },
    { key: 'owner', label: '담당자', type: 'person' },
    { key: 'approved', label: '승인', type: 'checkbox' },
  ],
  access: { read: ['owner_of_row', { field_equals: { field: 'visibility', value: '공개' } }], update: ['owner_of_row', 'role>=owner'] },
  fieldRules: { approved: { update: ['role>=editor'] } },
}, { strict: true })

test('규칙이 고정 템플릿으로 컴파일된다', () => {
  const sql = R.createSql(base(), APP, FID).join('\n')
  assert.match(sql, /create table panel_data\."app_1111111122223333"/)
  assert.match(sql, /create policy "pa_read" .* using \(panel_data\.folder_role\('99999999-8888-7777-6666-555555555555'::uuid\) >= 1 and \(created_by = auth\.uid\(\) or "c_visibility" = '공개'::text\)\)/)
  assert.match(sql, /panel_data\.folder_role\('[0-9a-f-]+'::uuid\) >= 4/)
  assert.match(sql, /raise exception using errcode = '42501', message = 'panel_field_denied:approved'/)
  assert.match(sql, /revoke all on .* from public, anon/)
})

test('알 수 없는 규칙·없는 항목·깊은 all 은 거절', () => {
  const d = base()
  assert.throws(() => R.validateAccess(d, { access: { read: ['everyone'] } }), /알 수 없는 규칙/)
  assert.throws(() => R.validateAccess(d, { access: { read: ['role>=admin'] } }), /알 수 없는 규칙/)
  assert.throws(() => R.validateAccess(d, { access: { read: [{ field_is_me: 'nope' }] } }), /없는 항목/)
  assert.throws(() => R.validateAccess(d, { access: { read: [{ all: [{ all: ['member'] }] }] } }), /한 단계/)
  assert.throws(() => R.validateAccess(d, { access: { read: [{ sql: 'true' }] } }), /알 수 없는 규칙/)
  assert.throws(() => R.validateAccess(d, { access: { read: [] } }), /비어/)
  // the model's output is lenient: a bad list falls back to the default
  assert.deepEqual(R.validateAccess(d, { access: { read: ['everyone'] } }, { strict: false }).access.read, ['member'])
})

test('항목 이름 주입: key 는 생성 규칙 밖이면 거절, 표 이름은 app id 에서만', () => {
  const d = base()
  const evil = { ...d, fields: [...d.fields, { key: 'x"; drop table users; --', label: '악성', type: 'text' }] }
  assert.throws(() => R.createSql(evil, APP, FID), /key 가 올바르지 않아요/)
  assert.throws(() => R.col('a b'), /올바르지 않아요/)
  assert.throws(() => R.tableName("1'; drop schema panel_data; --"), /app id/)
  assert.throws(() => R.createSql(d, APP, "x'::uuid); drop table pro_folders; --"), /folder id/)
  // normalizeDef turns whatever the model wrote into a safe key
  const n = normalizeDef({ title: 't', fields: [{ key: 'Robert"); DROP TABLE x;--', label: '이름' }] })
  assert.match(n.fields[0].key, /^[a-z][a-z0-9_]*$/)
})

test('값 주입: 선택지·비교 값은 따옴표가 두 번 쓰인 리터럴로만 들어간다', () => {
  const d = normalizeDef({
    title: 't', tier: 'db',
    fields: [{ key: 'stage', label: '단계', type: 'choice', choices: ["a'); drop table pro_folders; --", 'b\\'] }, { key: 'n', label: '수', type: 'number' }],
    access: { read: [{ field_equals: { field: 'stage', value: "a'); drop table pro_folders; --" } }] },
  }, { strict: true })
  const sql = R.createSql(d, APP, FID).join('\n')
  assert.ok(sql.includes("'a''); drop table pro_folders; --'"))
  assert.ok(!/[^']'\); drop table/.test(sql.replace(/''/g, '')))
  assert.ok(sql.includes("'b\\'")) // a backslash is a plain character (standard_conforming_strings)
  // a number comparison only takes numbers
  assert.throws(() => R.validateAccess(d, { access: { read: [{ field_equals: { field: 'n', value: '1; drop table x' } }] } }), /숫자/)
  // choice comparisons must be one of the choices
  assert.throws(() => R.validateAccess(d, { access: { read: [{ field_equals: { field: 'stage', value: 'zzz' } }] } }), /중 하나/)
  assert.throws(() => R.literal('a\0b'), /쓸 수 없는/)
})

test('JS 미러와 한국어 설명', () => {
  const d = base()
  const me = { id: 'u1', rank: 3 }
  assert.equal(R.rowCan(d, { _created_by: 'u1' }, me).update, true)
  assert.equal(R.rowCan(d, { _created_by: 'u2' }, me).update, false)
  assert.equal(R.rowCan(d, { _created_by: 'u2' }, { id: 'o', rank: 4 }).update, true)
  assert.equal(R.rowCan(d, { _created_by: 'u1' }, { id: 'u1', rank: 2 }).fields.approved, false)
  const lines = R.describeRules(d)
  assert.equal(lines.find((l) => l.action === 'read').text, "만든 사람 또는 '공개 범위'이(가) '공개'인 경우")
  assert.ok(lines.some((l) => l.action === 'field:approved'))
})

test('항목 변경: 추가는 바로, 삭제는 확인이 필요한 목록으로', () => {
  const d = base()
  const next = normalizeDef({ ...d, fields: [...d.fields.filter((f) => f.key !== 'owner'), { key: 'place', label: '장소', type: 'text' }] }, { strict: true })
  const { statements, destructive } = R.alterSql(d, next, APP, FID)
  assert.ok(statements.some((s) => /add column "c_place" text/.test(s)))
  assert.deepEqual(destructive, ['drop view if exists panel_data."app_1111111122223333_v"', 'alter table panel_data."app_1111111122223333" drop column "c_owner"'])
})
