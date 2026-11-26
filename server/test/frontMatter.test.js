// A Markdown file's YAML front matter in the file view (src/frontMatter.js — components/files/FileView.vue, spec champion-folders
// F-CH-08): split from the body and shown as a small table of keys and values, never as a heading. The champion folders video
// (2026-11-26) showed a SKILL.md's `---` / `name: …` / `description: …` / `---` as a rule and a bold heading (marked's setext heading).
//   node --test test/frontMatter.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { marked } from 'marked'
import { splitFrontMatter } from '../../src/frontMatter.js'

const SKILL = '---\nname: 견적서-작성\ndescription: 고객 요청 메일에서 견적서를 만든다\n---\n\n# 견적서 작성\n\n1. 메일을 읽는다\n'

test('FM-01 SKILL.md: 이름 · 설명은 표의 줄로, 본문은 머리말 없이 — 그린 본문에 머리말의 제목이 없다', () => {
  const { meta, body } = splitFrontMatter(SKILL)
  assert.deepEqual(meta, [['name', '견적서-작성'], ['description', '고객 요청 메일에서 견적서를 만든다']])
  assert.equal(body, '# 견적서 작성\n\n1. 메일을 읽는다\n')
  const html = marked.parse(body)
  assert.doesNotMatch(html, /<hr|<h2|name:/)
  assert.match(html, /<h1>견적서 작성<\/h1>/)
  // (what the preview drew before: a rule and a bold heading made of the front matter)
  assert.match(marked.parse(SKILL), /<hr>[\s\S]*<h2>name: 견적서-작성/)
})

test('FM-02 YAML 의 작은 부분: 따옴표 · 주석 · [a, b] · 여러 줄(> · |) · 목록 · 안쪽 맵 · CRLF · BOM', () => {
  const t = '﻿---\r\nname: "견적 #2"\r\ndescription: >\r\n  여러 줄로\r\n  적은 설명\r\n\r\n  둘째 문단\r\nallowed-tools: [Read, "Bash(git:*)"]\r\n'
    + 'tags:\n- 영업\n- \'견적\'\nmetadata:\n  version: 1\n  owner: kim\nsteps: |\n  하나\n    둘\nplain: 값 # 주석\n# 줄 주석\nempty:\n---\n본문'
  const { meta, body } = splitFrontMatter(t)
  assert.deepEqual(meta, [
    ['name', '견적 #2'],
    ['description', '여러 줄로 적은 설명\n둘째 문단'],
    ['allowed-tools', 'Read, Bash(git:*)'],
    ['tags', '영업, 견적'],
    ['metadata', 'version: 1\nowner: kim'],
    ['steps', '하나\n  둘'],
    ['plain', '값'],
    ['empty', ''],
  ])
  assert.equal(body, '본문')
})

test('FM-03 머리말이 아닌 것은 그대로: 첫 줄이 아님 · 닫는 줄 없음 · 키 없는 글 · 빈 머리말은 숨김 · `...` 로 닫음', () => {
  for (const t of ['# 제목\n---\nname: x\n---\n', '---\nname: x\n닫는 줄 없음\n', '---\n그냥 문단\n---\n본문', '', 'name: x\n']) {
    assert.deepEqual(splitFrontMatter(t), { meta: null, body: t }, JSON.stringify(t))
  }
  assert.deepEqual(splitFrontMatter('---\n---\n본문'), { meta: [], body: '본문' })
  assert.deepEqual(splitFrontMatter('---\nname: x\n...\n본문'), { meta: [['name', 'x']], body: '본문' })
  assert.deepEqual(splitFrontMatter(null), { meta: null, body: '' })
  // (a rule further down the body is the body's)
  assert.equal(splitFrontMatter('---\nname: x\n---\n위\n\n---\n\n아래').body, '위\n\n---\n\n아래')
})

// a long or odd line is read in one pass: a shared folder's file never stalls the page that shows it (2026-11-26 review)
test('FM-04 hostile lines are read quickly and never throw', async () => {
  const { splitFrontMatter } = await import('../../src/frontMatter.js')
  const cases = [
    '---\nk:' + ' '.repeat(8000) + '\rx\n---\nbody',
    '---\nk:' + ' '.repeat(8000) + ' x\n---\nbody',
    '---\nk: ' + 'a '.repeat(32000) + '#c\n---\nbody',
    '---\nk: ' + '['.repeat(20000) + '\n---\nbody',
    '---\n' + 'key'.repeat(20000) + ': v\n---\nbody',
  ]
  for (const c of cases) {
    const t = performance.now()
    const r = splitFrontMatter(c)
    assert.ok(performance.now() - t < 50, `took ${Math.round(performance.now() - t)} ms`)
    assert.ok(r && typeof r.body === 'string')
  }
  assert.deepEqual(splitFrontMatter('---\ntools: [Read, "Grep"]  # 주석\n---\n# t').meta, [['tools', 'Read, Grep']])
})
