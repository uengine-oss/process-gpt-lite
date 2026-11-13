// 프로세스 찾기 스킬(skills/process-discovery, lib/ontology/discovery.js): 코드가 부르는 프롬프트 · 규칙이 기본 판에 모두 있고,
// 프롬프트는 서버가 읽는 JSON 키를 그대로 말한다(회사가 고쳐도 키는 바꾸지 않는다 — SKILL.md).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bundled, NAME } from '../lib/ontology/discovery.js'

test('기본 판: 코드가 부르는 프롬프트가 모두 있고, 규칙의 칸이 다 있다', () => {
  const s = bundled()
  assert.equal(path.basename(s.dir), NAME)
  const used = new Set()
  for (const f of fs.readdirSync(new URL('../lib/ontology/', import.meta.url))) {
    const src = fs.readFileSync(new URL(`../lib/ontology/${f}`, import.meta.url), 'utf8')
    for (const m of src.matchAll(/prompt\('([a-z-]+)'\)/g)) used.add(m[1])
  }
  assert.ok(used.size >= 9, [...used].join(','))
  for (const n of used) assert.ok(s.prompts[n], `prompts/${n}.md 없음`)
  for (const k of ['mailbox', 'filters', 'readAlone', 'forms', 'period', 'incoming']) assert.ok(s.rules[k], `rules.${k} 없음`)
  assert.match(s.version, /^[0-9a-f]{10}$/)
})

test('프롬프트는 서버가 읽는 JSON 키를 말한다', () => {
  const p = bundled().prompts
  assert.match(p['read-thread'], /"mails"/); assert.match(p['read-thread'], /"recur"/); assert.match(p['read-thread'], /"task"/)
  assert.match(p['incoming-recurrence'], /"recurring"/)
  assert.match(p['merge-names'], /groups|"name"/)
  assert.match(p['draft-role'], /"competencies"/)
})
