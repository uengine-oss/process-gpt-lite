// The router's action skills (skills/actions/*): their format, and that every name they use exists here
// (design 2.2: handler, facts, available_when, argument enums) — a skill that names something missing
// stops the server. Also the over-fitting rules of design 1.3 / 7.1 for their descriptions: no sentence
// from the recordings or the old code and tests, at most two quoted examples.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSkills, problemsOf, parseSkillMd, toolName } from '../lib/skills/registry.js'
import { HANDLERS } from '../lib/skills/handlers.js'
import { FACT_NAMES, CONDITIONS } from '../lib/skills/facts.js'
import { checkArgs, toolParameters } from '../lib/skills/schema.js'
import { nearForbidden } from '../eval/check-sets.mjs'

const skills = loadSkills()
const tables = { handlers: HANDLERS, facts: FACT_NAMES, conditions: CONDITIONS }

test('행동 스킬 11개가 모두 읽히고, 쓰는 이름(처리기·사실·조건·인자 목록)이 모두 이 서버에 있음', () => {
  assert.deepEqual(skills.map((s) => s.name), ['browser-task', 'folder-change', 'home-action-add', 'panel-create', 'panel-record', 'process-improve-explain', 'process-work', 'schedule-create', 'schedule-run-now', 'teammate-notify', 'telegram-delivery'])
  assert.deepEqual(problemsOf(skills, tables), [])
  for (const s of skills) {
    assert.ok(s.body.length > 40, `${s.name}: a body for the second stage`)
    assert.equal(s.tool, toolName(s.name))
    assert.match(s.tool, /^[a-z0-9_]{1,64}$/)
  }
})

test('이름이 없는 처리기·사실을 가리키는 스킬은 거부됨', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-skill-'))
  try {
    fs.mkdirSync(path.join(dir, 'bad-skill'))
    fs.writeFileSync(path.join(dir, 'bad-skill', 'SKILL.md'), '---\nname: bad-skill\ndescription: 시험용\nmetadata:\n  kind: action\n  handler: nothing\n  facts: [nowhere]\n  available_when: sometimes\n  disclosure: inline\n  misroute_cost: low\n---\n본문\n')
    const p = problemsOf(loadSkills(dir), tables)
    assert.ok(p.some((x) => x.includes("handler 'nothing'")))
    assert.ok(p.some((x) => x.includes("fact 'nowhere'")))
    assert.ok(p.some((x) => x.includes("available_when 'sometimes'")))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('frontmatter: 중첩 metadata, 흐름 목록·맵', () => {
  const s = parseSkillMd('---\nname: x\ndescription: d\nmetadata:\n  facts: [a, b]\n  stage2_if: { action: [add, update] }\n  agent_turn: false\n  version: 1.0.0\n---\n# body\n')
  assert.deepEqual(s.metadata, { facts: ['a', 'b'], stage2_if: { action: ['add', 'update'] }, agent_turn: false, version: '1.0.0' })
  assert.equal(s.body, '# body')
})

test('설명: 녹화·옛 코드·옛 시험의 문장이 없고, 따옴표 예문은 스킬당 둘 이하', () => {
  for (const s of skills) {
    for (const part of s.description.split(/[.。]\s*/)) assert.equal(nearForbidden(part), null, `${s.name}: ${part}`)
    const quoted = (s.description.match(/「[^」]*」|"[^"]*"/g) || []).filter((q) => !/^「(사실|내 |이 대화|변경|실행|팀원|에이전트)/.test(q))
    assert.ok(quoted.length <= 2, `${s.name}: ${quoted.join(' ')}`)
  }
})

test('인자: 사실의 id 만 받음 — 목록에 없는 값·형식이 틀린 값은 오류, 숫자·참거짓은 형식대로', () => {
  const run = skills.find((s) => s.name === 'schedule-run-now')
  assert.deepEqual(checkArgs(run.schema, { schedule: 'a1' }, { schedules: ['a1', 'b2'] }), { ok: true, args: { schedule: 'a1' }, errors: [] })
  assert.equal(checkArgs(run.schema, { schedule: 'zz' }, { schedules: ['a1'] }).ok, false)
  const create = skills.find((s) => s.name === 'schedule-create')
  const r = checkArgs(create.schema, { name: 'n', prompt: 'p', in_minutes: '5', once: 'true', notify: 'sometimes' }, {})
  assert.deepEqual(r.args, { name: 'n', prompt: 'p', in_minutes: 5, once: true })
  assert.ok(r.errors.some((e) => e.startsWith('notify:')))
  const browser = skills.find((s) => s.name === 'browser-task')
  assert.equal(checkArgs(browser.schema, { goal: 'g', start_url: 'not a url' }, {}).ok, false)
  // the router function's parameters: the facts' ids as an enum, only the asked-for arguments
  const p = toolParameters(run.schema, { schedules: ['a1', 'b2'] })
  assert.deepEqual(p.properties.schedule.enum, ['a1', 'b2'])
  assert.ok(!('x-enum-from' in p.properties.schedule))
  const rec = skills.find((s) => s.name === 'panel-record')
  assert.deepEqual(Object.keys(toolParameters(rec.schema, {}, { only: rec.metadata.stage1_args }).properties), ['app', 'action'])
})
