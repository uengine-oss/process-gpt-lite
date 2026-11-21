// 업종 지식은 업무 팩에만 있다(2026-11-21 결정 3, 설계 4.5). 팩을 켜지 않은 회사의 프롬프트에는 업종 문장이 한
// 글자도 실리지 않고, 켠 회사에서는 팩의 스킬이 그 일을 맡는다(메일 분류가 고르는 목록, 초안 순서, 도면 배치 규칙).
// 사람 말을 읽어 정하는 코드도 없다: 문서 종류·형식은 분류 모델과 팩 데이터가, 단계 이름은 사례의 사실이 정한다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const { config } = await import('../config.js')
await import('../lib/systems.js') // (the server's own load order: systems before the CADCraft bridge lib/floorPlan.js uses)
const { withLang } = await import('../lib/lang.js')
const { setEnabledPacks, packSkill, readPack } = await import('../lib/skillInstallCatalog.js')
const mail = await import('../lib/mail.js')
const { panelPrompt } = await import('../lib/panels.js')
const { fallbackLayout } = await import('../lib/floorPlan.js')
const { stepsIn } = await import('../lib/mining/catalog.js')
const { pool, q } = await import('../lib/supa.js')
const { shareStep } = await import('../lib/mining/recorder.js')

const here = path.dirname(fileURLToPath(import.meta.url))
// words of the store-design trade and the services the panel reference names (a regression guard, not a rule)
const TRADE = /카페|인테리어|평면도|견적|제안서|매장|설계비|재무|finance\.yahoo|open-meteo|er-api|\bcafe\b|interior|floor ?plan|CADCraft|캐드크래프트/i
const on = () => setEnabledPacks(config.tenantId, ['store-design'])
const off = () => setEnabledPacks(config.tenantId, [])
const MAILS = [{ id: 'm1', from: 'A <a@x.example>', subject: 'request', date: '2026-11-21', text: 'please send the documents' }]
after(() => pool.end())

test('팩을 켜지 않은 회사: 메일 분류·패널·마이닝 단계의 프롬프트에 업종 문장이 없다', () => {
  off()
  for (const l of ['ko', 'en']) withLang(l, () => {
    assert.doesNotMatch(mail.triagePrompt(), TRADE, `${l} triage prompt`)
    const input = JSON.parse(mail.triageInput(MAILS))
    assert.deepEqual(input.document_skills, [], '고를 업종 스킬이 없다')
    assert.doesNotMatch(panelPrompt(), TRADE, `${l} panel prompt (references only by name until asked)`)
    assert.doesNotMatch(JSON.stringify(stepsIn(l)), TRADE, `${l} mining steps`)
  })
})

test('팩을 켠 회사: 메일 분류가 팩 스킬을 설명·형식과 함께 받고, 형식은 언어마다 팩이 정한다', () => {
  on()
  try {
    const ko = withLang('ko', () => JSON.parse(mail.triageInput(MAILS)).document_skills)
    assert.deepEqual(ko.map((s) => [s.name, s.output]), [['cadcraft-floor-plan', 'dxf'], ['store-design-proposal', 'hwpx'], ['quote-xlsx', 'xlsx']])
    assert.ok(ko.every((s) => s.description.length > 20), '고를 근거는 스킬 설명')
    const en = withLang('en', () => JSON.parse(mail.triageInput(MAILS)).document_skills)
    assert.equal(en.find((s) => s.name === 'store-design-proposal').output, 'docx')
    // the prompt itself still has no trade wording: what the skills are comes with the data
    assert.doesNotMatch(withLang('ko', () => mail.triagePrompt()), TRADE)
  } finally { off() }
})

test('초안 목록: 팩에 있는 스킬만 남기고, 형식은 스킬의 것, 먼저 필요한 스킬은 따라온다', () => {
  on()
  try {
    withLang('ko', () => {
      const items = mail.draftItems({ customer: '한빛', items: [
        { kind: '제안서', skill: 'store-design-proposal', name: '한빛 제안서.docx' }, // the skill's format wins
        { kind: '견적서', skill: 'quote-xlsx', name: '한빛 견적서.xlsx' },
        { kind: '일정표', skill: 'no-such-skill', name: '한빛 일정표.xlsx' }, // unknown skill: a plain document
        { kind: '도면', skill: '', name: '한빛 도면.dxf' }, // a format only a pack skill makes: dropped
      ] })
      assert.deepEqual(items.map((i) => [i.kind, i.skill?.name || '', i.name]), [
        ['평면도', 'cadcraft-floor-plan', '한빛 평면도.dxf'],
        ['제안서', 'store-design-proposal', '한빛 제안서.hwpx'],
        ['견적서', 'quote-xlsx', '한빛 견적서.xlsx'],
        ['일정표', '', '한빛 일정표.xlsx'],
      ])
      // the drawing first; the proposal (requires it) and the quote (after it) next, the plain sheet with the first round
      const waves = mail.draftWaves(items)
      assert.deepEqual(waves.map((w) => w.map((i) => i.kind)), [['평면도', '일정표'], ['제안서', '견적서']])
    })
  } finally { off() }
  // the same mail in a company without the pack: plain documents only, nothing added
  withLang('ko', () => {
    const items = mail.draftItems({ customer: '한빛', items: [{ kind: '제안서', skill: 'store-design-proposal', name: '한빛 제안서.hwpx' }, { kind: '도면', skill: '', name: '한빛 도면.dxf' }] })
    assert.deepEqual(items.map((i) => [i.kind, i.skill, i.name]), [['제안서', null, '한빛 제안서.hwpx']])
  })
})

test('도면 배치 규칙과 대체 배치는 팩 스킬의 references 에 있다 (치수 "W × D" 만 형식으로 읽는다)', () => {
  on()
  try {
    const skill = packSkill('cadcraft-floor-plan')
    assert.ok(fs.readFileSync(path.join(skill.dir, 'references', 'layout.md'), 'utf8').includes('Rooms tile the whole'))
    const plan = JSON.parse(fs.readFileSync(path.join(skill.dir, 'references', 'fallback-layout.json'), 'utf8'))
    const l = withLang('ko', () => fallbackLayout({ text: '가로세로 10 x 6 공간' }, plan))
    assert.equal(l.width, 10)
    assert.equal(l.depth, 6)
    const area = l.rooms.reduce((s, r) => s + r.w * r.h, 0)
    assert.ok(Math.abs(area - 60) < 0.01, '실이 전체를 채운다')
    assert.equal(l.rooms[0].name, plan.main.name.ko)
    assert.equal(withLang('en', () => fallbackLayout({ text: '' }, plan)).width, plan.default_size_m.width)
    const bare = withLang('ko', () => fallbackLayout({ text: '' }, null))
    assert.equal(bare.rooms.length, 1, '규칙이 없으면 한 칸')
  } finally { off() }
})

test('팩의 모든 SKILL.md 는 deepagents 형식(name·description·metadata)이고 관리 표시가 있다', () => {
  const pack = readPack('store-design')
  assert.match(pack.version, /^\d+\.\d+\.\d+$/)
  for (const s of pack.skills) {
    assert.ok(s.description.length >= 40, `${s.name}: description`)
    assert.equal(s.metadata.managed_by, 'process-gpt-lite', s.name)
    assert.equal(s.metadata.pack, 'store-design', s.name)
    // a description deepagents' YAML parser reads as one string (quoted; an unquoted ': ' would break it)
    const head = fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8').split('\n').find((x) => x.startsWith('description:'))
    assert.match(head, /^description: ".*"$/, s.name)
  }
})

test('검토 단계 이름: 공유 요청이 고른 종류 → 팩의 문서 형식 → 사례가 요청한 문서 → 역할 → 팀원 검토', async () => {
  const someone = { id: crypto.randomUUID() }
  off()
  assert.equal((await shareStep(someone, '', 'ko', ['x.xlsx'])).label, '팀원 검토', '팩도 사례 문서도 역할도 없으면')
  assert.equal((await shareStep(someone, '', 'ko', ['한빛 일정표.xlsx'], { items: [{ kind: '일정표', skill: '', name: '한빛 일정표.xlsx', format: 'xlsx' }] })).label, '일정표 검토', '사례가 요청한 문서')
  assert.equal((await shareStep(someone, '', 'en', ['s.xlsx'], { items: [{ kind: 'schedule', name: 's.xlsx', format: 'xlsx' }] })).label, 'schedule review')
  assert.equal((await shareStep(someone, '', 'ko', ['x.xlsx'], { review: '법무 확인' })).label, '법무 확인', '공유가 고른 종류(구조화 필드)')
  on()
  try {
    assert.equal((await shareStep(someone, '', 'ko', ['한빛 견적서.xlsx'])).label, '견적서 검토', '팩의 문서 형식')
    assert.equal((await shareStep(someone, '', 'en', ['quote.xlsx'])).label, 'Quote review')
  } finally { off() }
  // a role from the tenant's data names the review as it is (no word of it is cut off)
  await q(`insert into pro_role_assignments(tenant_id,proc_def_id,role,user_id,updated_by) values ($1,'*',$2,$3,$3)`, [config.tenantId, `rt-역할-${someone.id.slice(0, 6)}`, someone.id])
  try {
    assert.equal((await shareStep(someone, '', 'ko', ['x.txt'])).label, `rt-역할-${someone.id.slice(0, 6)} 검토`)
  } finally { await q('delete from pro_role_assignments where tenant_id=$1 and user_id=$2', [config.tenantId, someone.id]) }
})

test('코드에 업종 문장이 없다: 메일·마이닝·도면·패널 모듈의 코드 줄(주석 제외)', () => {
  const words = /카페|인테리어|평면도|견적|제안서|매장|설계비|재무|finance\.yahoo|open-meteo|er-api|\bcafe\b|interior/i
  const files = ['../lib/mail.js', '../lib/floorPlan.js', '../lib/panels.js', ...fs.readdirSync(path.join(here, '../lib/mining')).map((f) => `../lib/mining/${f}`)]
  const hits = []
  for (const f of files) {
    const src = fs.readFileSync(path.join(here, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    src.split('\n').forEach((line, i) => { const code = line.replace(/(^|[^:'"`])\/\/.*$/, '$1'); if (words.test(code)) hits.push(`${f}:${i + 1}: ${code.trim().slice(0, 120)}`) })
  }
  assert.deepEqual(hits, [])
})
