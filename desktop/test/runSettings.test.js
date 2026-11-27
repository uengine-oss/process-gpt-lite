'use strict'
// A folder's own run settings left off on this PC for a person who may not edit the folder (src/runner/runSettings.js — spec local-agents):
//   · settings files emptied; the front matter of every SKILL.md and of .claude/agents · .claude/commands files (nested folders too) read as
//     YAML and written back without hooks · allowed-tools · shell · mcpServers · lspServers · permissionMode — the rest and the body as they were
//   · a front matter that does not read as YAML is left off whole; a file with none of those keys is not touched (byte for byte)
//   · a folder on the way that is a link out of the work folder (.codex → the person's own ~/.codex) is never written through
// Run: cd desktop && node --test test/runSettings.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const yaml = require('js-yaml')
const RS = require('../src/runner/runSettings')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-runsettings-'))
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const put = (dir, rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
const front = (text) => yaml.load(text.split(/\r?\n---\r?\n/)[0].replace(/^---\r?\n/, ''))

const SKILL = `---
name: 제안서
description: "회사 양식: 표지 · 본문"
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: touch /tmp/never
allowed-tools: Bash, Read
shell: /bin/zsh
model: inherit
---
# 양식

본문은 그대로 — \`!echo 이 줄도\`
`

test('머리말의 실행 키만 빼고, 나머지 머리말과 본문은 그대로 — 스킬 · 하위 폴더의 스킬 · 에이전트 · 명령', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'w-'))
  put(dir, '.claude/skills/제안서/SKILL.md', SKILL)
  put(dir, '부서/영업/.claude/skills/견적/SKILL.md', SKILL.replace('제안서', '견적'))
  put(dir, '.claude/agents/팀/검토자.md', '---\nname: 검토자\ndescription: 제안서를 검토한다\npermissionMode: bypassPermissions\nmcpServers:\n  - probe: {command: sh}\ntools: Read, Grep\n---\n검토한다\n')
  put(dir, '.claude/commands/배포/올리기.md', '---\ndescription: 올린다\nallowed-tools: Bash(git push:*)\nlspServers: {x: {command: sh}}\n---\n!`git push`\n')
  const r = RS.leaveOff(dir)
  assert.deepEqual(r.front.map((x) => x.path).sort(), ['.claude/agents/팀/검토자.md', '.claude/commands/배포/올리기.md', '.claude/skills/제안서/SKILL.md', '부서/영업/.claude/skills/견적/SKILL.md'].sort())
  const s = read(dir, '.claude/skills/제안서/SKILL.md')
  assert.deepEqual(front(s), { name: '제안서', description: '회사 양식: 표지 · 본문', model: 'inherit' })
  assert.ok(s.endsWith('---\n# 양식\n\n본문은 그대로 — `!echo 이 줄도`\n'), s)
  assert.deepEqual(r.front.find((x) => x.path === '.claude/skills/제안서/SKILL.md').removed, ['hooks', 'allowed-tools', 'shell'])
  assert.deepEqual(front(read(dir, '부서/영업/.claude/skills/견적/SKILL.md')).name, '견적')
  assert.deepEqual(front(read(dir, '.claude/agents/팀/검토자.md')), { name: '검토자', description: '제안서를 검토한다', tools: 'Read, Grep' })
  assert.deepEqual(front(read(dir, '.claude/commands/배포/올리기.md')), { description: '올린다' })
  assert.ok(read(dir, '.claude/commands/배포/올리기.md').endsWith('!`git push`\n'))
  // every touched path goes to the commit's except list
  assert.deepEqual(r.paths.sort(), r.front.map((x) => x.path).sort())
})

test('YAML 로 읽히지 않는 머리말은 통째로 빼고(본문은 남김), 실행 키가 없는 파일은 손대지 않는다 · 별칭으로 합친 키도 뺀다', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'w-'))
  put(dir, '.claude/skills/중복/SKILL.md', '---\nname: 중복\nhooks: {}\nhooks: {PreToolUse: []}\n---\n본문\n')
  const plain = '---\nname: 그대로\ndescription: 손대지 않음\n---\n본문\r\n'
  put(dir, '.claude/skills/그대로/SKILL.md', plain)
  put(dir, '.claude/skills/별칭/SKILL.md', '---\nbase: &b\n  allowed-tools: Bash\nname: 별칭\n<<: *b\n---\n본문\n')
  put(dir, 'docs/SKILL.txt', '---\nhooks: {}\n---\n')
  const r = RS.leaveOff(dir)
  assert.equal(read(dir, '.claude/skills/중복/SKILL.md'), '본문\n')
  assert.deepEqual(r.front.find((x) => x.path === '.claude/skills/중복/SKILL.md').removed, ['(front matter)'])
  assert.equal(read(dir, '.claude/skills/그대로/SKILL.md'), plain, '바이트 그대로')
  assert.ok(!('allowed-tools' in front(read(dir, '.claude/skills/별칭/SKILL.md'))))
  assert.equal(read(dir, 'docs/SKILL.txt'), '---\nhooks: {}\n---\n')
  assert.ok(!r.paths.includes('.claude/skills/그대로/SKILL.md'))
})

test('작업 폴더 밖으로 이어진 링크 폴더(.codex → 사람의 ~/.codex, .claude → 밖)는 따라가 쓰지 않는다 · 설정 파일 자체가 링크면 링크만 바꾼다', { skip: process.platform === 'win32' && 'links need rights on Windows' }, () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'w-'))
  const home = fs.mkdtempSync(path.join(ROOT, 'home-'))
  put(home, 'codex/config.toml', 'model = "mine"\n')
  put(home, 'claude/settings.json', '{"theme":"dark"}\n')
  put(home, 'claude/skills/내것/SKILL.md', '---\nname: 내것\nhooks: {}\n---\n')
  put(home, 'mcp.json', '{"mcpServers":{"mine":{}}}\n')
  fs.symlinkSync(path.join(home, 'codex'), path.join(dir, '.codex'))
  fs.symlinkSync(path.join(home, 'claude'), path.join(dir, '.claude'))
  fs.symlinkSync(path.join(home, 'mcp.json'), path.join(dir, '.mcp.json'))
  const r = RS.leaveOff(dir)
  assert.equal(read(home, 'codex/config.toml'), 'model = "mine"\n')
  assert.equal(read(home, 'claude/settings.json'), '{"theme":"dark"}\n')
  assert.equal(read(home, 'claude/skills/내것/SKILL.md'), '---\nname: 내것\nhooks: {}\n---\n')
  // (.mcp.json itself a link: the link goes and an empty file takes its place — what it pointed at stays)
  assert.equal(read(home, 'mcp.json'), '{"mcpServers":{"mine":{}}}\n')
  assert.ok(!fs.lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink())
  assert.deepEqual(r.files, ['.mcp.json'])
  assert.deepEqual(r.front, [])
})

test('배지의 읽기: 머리말에 실행 키가 있으면(어디에 있든) 그 키 — 서버의 kit.js 와 같은 목록', () => {
  assert.deepEqual(RS.frontRuns(SKILL), ['hooks', 'allowed-tools', 'shell'])
  assert.deepEqual(RS.frontRuns('---\n{name: x, "permissionMode": plan}\n---\n'), ['permissionMode'])
  assert.deepEqual(RS.frontRuns('---\nname: x\n---\nhooks: 본문에만\n'), [])
  assert.deepEqual(RS.FRONT_RUNS, require('../../server/lib/folders/kit-places.json').frontMatterRuns)
})
