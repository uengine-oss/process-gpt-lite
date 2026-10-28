// English mode (lib/lang.js) for panel apps, panels, shared folders and team rooms: what a person reads
// comes out in English when the language is en, and exactly as before when it is ko — no server or DB
import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { withLang } from '../lib/lang.js'
import * as E from '../lib/panelApps/events.js'
import * as PV from '../lib/panelApps/privacy.js'
import * as R from '../lib/panelApps/rules.js'
import * as X from '../lib/panelApps/sheet.js'
import * as P from '../lib/panelApps/service.js'
import * as A from '../lib/team/assist.js'
import * as S from '../lib/folders/service.js'
import { rules, RULES } from '../lib/folders/runner.js'

const hangul = (v) => /[가-힣]/.test(typeof v === 'string' ? v : JSON.stringify(v))
const en = (fn) => withLang('en', fn)
const ko = (fn) => withLang('ko', fn)

const enEvents = {
  kind: 'events', title: 'Leave days', entity: { key: 'member', label: 'Teammate', type: 'person' },
  fields: [{ key: 'days', label: 'Days', type: 'number' }, { key: 'start', label: 'Start date', type: 'date' }, { key: 'reason', label: 'Reason', type: 'longtext', sensitivity: 'public' }],
  events: [
    { type: 'grant', label: 'Grant leave', fields: ['days'], required: ['days'], manager: true },
    { type: 'request', label: 'Request leave', fields: ['start', 'days', 'reason'], required: ['days'] },
    { type: 'cancel', label: 'Cancel leave', fields: [], ref: { types: ['request'], mode: 'cancel', inherit: ['days'] } },
  ],
  projections: [
    { kind: 'balance', key: 'summary', label: 'Summary', columns: [{ key: 'granted', label: 'Granted', terms: [{ event: 'grant', field: 'days' }] }, { key: 'used', label: 'Used', terms: [{ event: 'request', field: 'days' }, { event: 'cancel', field: 'days', sign: -1 }] }], computed: [{ key: 'left', label: 'Days left', expr: 'granted - used' }] },
    { kind: 'open', key: 'pending', label: 'Open requests', event: 'request' },
  ],
  views: { main: 'summary', value: 'left', valueSuffix: 'days' },
}
const A1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const log = [
  { seq: 1, id: 'e1', at: '2026-10-01T00:00:00Z', by: 'm', type: 'grant', entity: A1, ref: null, days: 15 },
  { seq: 2, id: 'e2', at: '2026-10-02T00:00:00Z', by: A1, type: 'request', entity: A1, ref: null, days: 3, start: '2026-11-03', reason: 'clinic' },
]

test('privacy floor: English labels get the same protection; Korean labels exactly as before', () => {
  const d = X.normalizeDef({ title: 'Customers', fields: [{ key: 'name', label: 'Name' }, { key: 'phone_no', label: 'Phone number' }, { key: 'salary', label: 'Annual salary', type: 'number' }, { key: 'addr', label: 'Home address' }] }, { secure: true })
  const lv = Object.fromEntries(d.fields.map((f) => [f.key, f.sensitivity]))
  assert.equal(lv.salary, 'sensitive')
  assert.equal(lv.phone_no, 'personal')
  assert.equal(lv.addr, 'personal')
  assert.equal(d.tier, 'db')
  const k = X.normalizeDef({ title: '고객', fields: [{ key: 'name', label: '이름' }, { key: 'pay', label: '연봉', type: 'number' }, { key: 'note', label: 'Note 메모' }] }, { secure: true })
  assert.equal(k.fields.find((f) => f.key === 'pay').sensitivity, 'sensitive')
  // a label with Hangul is read with the Korean words only ('Note 메모': no English floor)
  assert.equal(k.fields.find((f) => f.key === 'note').sensitivity, 'internal')
})

test('the Security & privacy defaults card: English in en, the Korean lines in ko', () => {
  const def = E.normalizeEventsDef(enEvents, { secure: true })
  const lines = en(() => PV.describePrivacy(def))
  assert.ok(lines.length >= 3)
  for (const l of lines) assert.ok(!hangul(l.text), l.text)
  assert.match(lines.find((l) => l.field === 'reason').text, /'Reason' is sensitive information.*'Private'/)
  const k = ko(() => PV.describePrivacy(def))
  assert.equal(k[0].text, '폴더 구성원만 이 앱을 볼 수 있어요. 구성원이 아니면 목록·데이터·건수 모두 보이지 않아요.')
  // no language set at all = ko
  assert.deepEqual(PV.describePrivacy(def), k)
})

test('access rules and record permissions in words', () => {
  const d = X.normalizeDef({ title: 'Shared calendar', tier: 'db', fields: [{ key: 'title', label: 'Title', required: true }, { key: 'visibility', label: 'Visibility', type: 'choice', choices: ['Public', 'Private'] }],
    access: { read: ['owner_of_row', { field_equals: { field: 'visibility', value: 'Public' } }], update: ['owner_of_row', 'role>=owner'] } }, { strict: true })
  const lines = en(() => R.describeRules(d))
  assert.deepEqual(lines.map((l) => l.label), ['View', 'Create', 'Edit', 'Delete'])
  assert.equal(lines[0].text, "whoever created it or when 'Visibility' is 'Public'")
  for (const l of lines) assert.ok(!hangul(l), JSON.stringify(l))
  assert.equal(ko(() => R.describeRules(d))[0].label, '보기')
  const ev = E.normalizeEventsDef(enEvents, { secure: true })
  for (const w of en(() => E.describeEvents(ev))) assert.ok(!hangul(w.who), w.who)
  assert.match(ko(() => E.describeEvents(ev))[0].who, /편집 권한 이상/)
})

test('a new app\'s defaults (sheet name, summary) and validation messages follow the language', () => {
  const d = en(() => X.normalizeDef({ title: 'Lead tracker', fields: [{ key: 'company', label: 'Company' }] }))
  assert.equal(d.sheet, 'Data')
  assert.deepEqual(d.views.summary, [{ label: 'Total', agg: 'count' }])
  const k = ko(() => X.normalizeDef({ title: '리드 관리', fields: [{ key: 'company', label: '회사' }] }))
  assert.equal(k.sheet, '데이터')
  assert.deepEqual(k.views.summary, [{ label: '전체', agg: 'count', suffix: '건' }])
  const amount = { title: 'Quotes', fields: [{ key: 'amount', label: 'Amount', type: 'number', required: true }, { key: 'due', label: 'Due', type: 'date' }] }
  assert.throws(() => en(() => X.validate(X.normalizeDef(amount), { due: 'soon' })), (e) => !hangul(e.message) && /Please fill in 'Amount'/.test(e.message))
  assert.throws(() => ko(() => X.validate(X.normalizeDef(amount), { due: 'soon' })), /'Amount' 을\(를\) 적어 주세요/)
})

test('English amounts and dates are read like Korean ones', () => {
  assert.equal(X.parseKoNumber('30K'), 30000)
  assert.equal(X.parseKoNumber('1.2M'), 1200000)
  assert.equal(X.parseKoNumber('15 days'), 15)
  assert.equal(X.parseKoNumber('₩30,000'), 30000)
  assert.equal(X.parseKoNumber('3,800만 원'), 38000000)
  assert.ok(Number.isNaN(X.parseKoNumber('soon')))
  assert.equal(X.coerce({ type: 'date' }, 'Nov 3, 2026'), '2026-11-03')
  assert.equal(X.coerce({ type: 'date' }, '2026년 11월 3일'), '2026-11-03')
})

test('an event app\'s workbook: English tab and envelope in en, read back in either language', async () => {
  const def = E.normalizeEventsDef(enEvents, { secure: true })
  const enBook = await en(() => E.eventsBook(def, log))
  assert.ok(enBook.getWorksheet('Events'))
  assert.equal(enBook.getWorksheet('이벤트'), undefined)
  const head = enBook.getWorksheet('Events').getRow(1).values.slice(1)
  assert.deepEqual(head.slice(0, 6), ['ID', 'Time', 'Recorded by', 'Type', 'Teammate', 'Target record'])
  const summary = enBook.getWorksheet('Summary')
  assert.match(String(summary.getRow(2).getCell(2).value.formula), /^SUMIFS\('Events'!/)
  // a round trip through the file (the sheet editor) and a Korean member reading it
  const buf = Buffer.from(await enBook.xlsx.writeBuffer())
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf)
  const back = ko(() => E.readLog(wb, def))
  assert.deepEqual(back.map((e) => [e.id, e.type, e.days]), [['e1', 'grant', 15], ['e2', 'request', 3]])
  const koBook = await ko(() => E.eventsBook(def, log))
  assert.ok(koBook.getWorksheet('이벤트'))
  assert.deepEqual(koBook.getWorksheet('이벤트').getRow(1).values.slice(1, 7), ['ID', '시각', '기록한 사람', '종류', 'Teammate', '대상 기록'])
  assert.equal(en(() => E.readLog(koBook, def)).length, 2)
  // masked values count as unchanged in either language
  const masked = [{ ...log[1], reason: 'Private' }]
  assert.equal(E.diffLog(def, [log[1]], masked).rejected.length, 0)
})

test('panel-app design prompts: English examples in en, the Korean prompt untouched in ko', () => {
  const e = en(() => P.designPrompts())
  assert.match(e.design, /short English app name/)
  assert.match(e.design, /\["Public","Private"\] default "Public"/)
  assert.match(e.events, /"label":"Grant leave"/)
  assert.ok(!/"label":"휴가 부여"/.test(e.events))
  const k = ko(() => P.designPrompts())
  assert.match(k.design, /"title":"짧은 한국어 앱 이름\(예: 리드 관리, 휴가 일수 관리\)"/)
  assert.ok(!/English/.test(k.design))
  const def = X.normalizeDef({ title: 'Leads', fields: [{ key: 'stage', label: 'Stage', type: 'choice', choices: ['New', 'Won'] }, { key: 'amount', label: 'Amount', type: 'number' }] })
  assert.equal(en(() => P.describe(def)), 'Stage(New/Won)*, Amount(number)')
  assert.equal(ko(() => P.describe(def)), 'Stage(New/Won)*, Amount(숫자)')
})

test('room assist: English requests pass the rules, chit-chat does not; Korean exactly as before', () => {
  for (const t of ['Can you draft the quote for Moonlight Coffee Store #2?', 'Please summarize this conversation for me', 'Could you set up a meeting with Minji next week?'])
    assert.equal(A.prefilter(t).pass, true, t)
  for (const [t, why] of [['thanks!', 'short'], ['ok sounds good to me', 'chat'], ['lunch at 12, anyone?', 'smalltalk'], ['I finished the floor plan yesterday', 'not-a-request'], ['heading home now, see you tomorrow', 'no-work']])
    assert.equal(A.prefilter(t).why, why, t)
  assert.equal(A.prefilter('견적서 초안 만들어 줄 수 있어요?').pass, true)
  assert.equal(A.prefilter('점심 뭐 먹을까요 다들').why, 'smalltalk')
  const s = { id: 's', room_id: 'r', chat_uuid: 'c', work: 'CreateSpreadsheet', title: 'Draft the quote', reason: '', state: 'open', audience: ['u'], dismissed: [], judge: {} }
  assert.equal(en(() => A.view('u', s)).kind, 'Table')
  assert.equal(ko(() => A.view('u', s)).kind, '표')
  for (const w of Object.values(A.WORKS_EN)) assert.ok(!hangul(w), JSON.stringify(w))
  assert.deepEqual(Object.keys(A.WORKS_EN), Object.keys(A.WORKS))
})

test('shared folders: status words and the agent rules follow the language', () => {
  assert.equal(en(() => S.statusText('ready')), 'ready to merge')
  assert.equal(ko(() => S.statusText('ready')), '반영 대기')
  assert.ok(!hangul(en(() => rules())))
  assert.equal(ko(() => rules()), RULES)
})
