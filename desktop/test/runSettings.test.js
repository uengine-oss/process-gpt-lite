'use strict'
// A folder's own run settings left off on this PC for a person who may not edit the folder (src/runner/runSettings.js — spec local-agents):
//   · settings files emptied; the front matter of every SKILL.md and of .claude/agents · .claude/commands files (nested folders too), found
//     exactly as Claude Code 2.1.332 finds it, read as YAML and written back without hooks · allowed-tools · shell · mcpServers ·
//     lspServers · permissionMode (any spelling) — the rest and the body as they were
//   · fail closed: a front matter that does not read as YAML, or names a run key js-yaml does not show at the top, is left off whole (an
//     empty one in its place); a file with none of those keys is not touched (byte for byte)
//   · which files: git's list (ignored files too — node_modules, the CLI's .claude/), a repository inside read from the disk; a long file's
//     head; refused (Incomplete) when the list cannot be whole
//   · the CLI's own reader (its pattern, its YAML fallback — js-yaml standing in for Bun.YAML; with Bun installed, Bun.YAML itself) reads
//     no run key in what is left, for the reviewer's cases (docs: an indented '...', a folded value, a '---' inside a line, …)
// Run: cd desktop && node --test test/runSettings.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const yaml = require('js-yaml')
const RS = require('../src/runner/runSettings')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-runsettings-'))
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const put = (dir, rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
const front = (text) => yaml.load(text.split(/\r?\n---\r?\n/)[0].replace(/^---\r?\n/, ''))
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
// a work folder as the runner has it: a git clone, its files committed (the CLI's places excluded, as runner.js excludeIn does)
function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'w-'))
  git(dir, 'init', '-q')
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.claude/\n.codex/\n.pgl-run/\n.tmp/\n')
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text)
  git(dir, 'add', '-A', '-f')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

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

// ---------- Claude Code 2.1.332's own reader (Yd · CDo · _u, as read from its binary) ----------
const KL = /^---\s*\n([\s\S]*?)---\s*\n?/
const Su = /[{}[\]*&#!|>%@`]|: /
function cliReader(parse) {
  const _u = (e) => {
    const r = []
    for (const g of e.split('\n')) {
      const h = g.match(/^([a-zA-Z_-]+):\s+(\S.*)$/)
      if (h) {
        const [, y, k] = h
        if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) { r.push(g); continue }
        if (k.startsWith('[') && k.endsWith(']')) try { if (Array.isArray(parse(k))) { r.push(g); continue } } catch { /* as below */ }
        if (Su.test(k)) { r.push(`${y}: "${k.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`); continue }
      }
      r.push(g)
    }
    return r.join('\n')
  }
  const CDo = (e) => { try { return { ok: true, value: parse(e) } } catch { try { return { ok: true, value: parse(_u(e).replace(/^\t+/gm, (r) => '  '.repeat(r.length))) } } catch { return { ok: false } } } }
  return (e) => {
    if (e.charCodeAt(0) === 65279) e = e.slice(1)
    const h = e.indexOf('---', 3) < 0 ? null : e.match(KL)
    if (!h) return {}
    const Y = CDo(h[1] || '')
    if (!Y.ok) return {}
    const v = Y.value
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }
}
const norm = (k) => String(k).toLowerCase().replace(/[-_]/g, '')
const RUNS = new Set(RS.FRONT_RUNS.map(norm))
const runKeys = (fm) => Object.keys(fm).filter((k) => RUNS.has(norm(k)))
const Yd = cliReader((s) => yaml.load(s))

// the reviewer's cases (scratchpad fm/cases.js · cases2.js)
const H = 'hooks:\n  PreToolUse:\n    - matcher: "*"\n      hooks:\n        - type: command\n          command: touch /tmp/x\n'
const CASES = {
  plain: `---\nname: a\ndescription: b\n${H}allowed-tools: Bash\n---\nbody\n`,
  docEnd: `---\nname: a\ndescription: b\n...\n${H}allowed-tools: Bash\n---\nbody\n`,
  docEndIndented: `---\nname: a\ndescription: b\n  ...\n${H}---\nbody\n`,
  indentedDashes: `---\nname: a\ndescription: |\n  text\n  ---\n${H}---\nbody\n`,
  midLineDashes: `---\nname: a---b\n${H}---\nbody\n`,
  dup: `---\nname: a\nhooks: {}\n${H}---\nbody\n`,
  caseVar: `---\nname: a\nHooks:\n  PreToolUse: []\nallowed_tools: Bash\nallowedTools: Bash\nAllowed-Tools: Bash\n---\nbody\n`,
  merge: `---\nname: a\nbase: &b\n  allowed-tools: Bash\n<<: *b\n---\nbody\n`,
  crlf: `---\r\nname: a\r\nallowed-tools: Bash\r\n---\r\nbody\r\n`,
  bom: `﻿---\nname: a\nallowed-tools: Bash\n---\nbody\n`,
  leadingBlank: `\n---\nname: a\nallowed-tools: Bash\n---\nbody\n`,
  tabs: `---\nname: a\nallowed-tools:\tBash\n---\nbody\n`,
  quotedMulti: `---\nname: a\ndescription: "x\nallowed-tools: Bash\ny"\n---\nbody\n`,
  noClose: `---\nname: a\nallowed-tools: Bash\n`,
  openTrailing: `---   \nname: a\nallowed-tools: Bash\n---\nbody\n`,
  docStartDirective: `---\n%YAML 1.2\nname: a\nallowed-tools: Bash\n---\nbody\n`,
  explicitKey: `---\nname: a\n? allowed-tools\n: Bash\n---\nbody\n`,
  escapedKey: `---\nname: a\n"allowed\\x2dtools": Bash\n---\nbody\n`,
  jsonFlow: `---\n{"name": "a", "allowed-tools": "Bash"}\n---\nbody\n`,
  commentClose: `---\nname: a # ---\nallowed-tools: Bash\n---\nbody\n`,
  sp1: `---\nname: a\ndescription: b\n ...\n${H}---\nbody\n`,
  tab: `---\nname: a\ndescription: b\n\t...\n${H}---\nbody\n`,
  folded: `---\nname: a\ndescription: >\n  b\n  ...\n${H}---\nbody\n`,
  inList: `---\nname: a\ntags:\n  - x\n  ...\n${H}---\nbody\n`,
  quoted: `---\nname: a\ndescription: "b\n  ..."\n${H}---\nbody\n`,
  allowedOnly: `---\nname: a\ndescription: b\n  ...\nallowed-tools: Bash\n---\nbody\n`,
  dashTrail: `---\nname: a\ndescription: b\n  ---x\n${H}---\nbody\n`,
  flowNoSpace: `---\n{"name": "a", "hooks":{}}\n---\nbody\n`,
}
const after = (text) => RS.stripFront(text)?.text ?? text

test('머리말은 CLI 와 똑같이 찾는다 — 그 정규식 그대로(BOM 제외 · 셋째 글자 뒤의 --- · 줄 안의 --- 에서 끝 · ... 은 끝이 아님)', () => {
  for (const [k, t] of Object.entries(CASES)) {
    const e = t.charCodeAt(0) === 65279 ? t.slice(1) : t
    const h = e.indexOf('---', 3) < 0 ? null : e.match(KL)
    const c = RS.cliBlock(t)
    assert.equal(c ? c.block : null, h ? h[1] : null, k)
    if (c) assert.equal(c.end, (t.length - e.length) + h[0].length, k)
  }
})

test('검토 사례 전부: 남긴 머리말을 CLI 의 읽기(YAML 읽기 실패 시 다시 따옴표 · 탭 처리까지)로 읽어도 실행 키가 없다 — 들여쓴 ... · 한 칸 · 접힌 값', () => {
  for (const [k, t] of Object.entries(CASES)) assert.deepEqual(runKeys(Yd(after(t))), [], k)
  // (the reviewer's three: the CLI read hooks there before — now they are gone, and name · description stay)
  for (const k of ['docEndIndented', 'sp1', 'folded']) {
    assert.deepEqual(runKeys(Yd(CASES[k])), ['hooks'], `${k}: the CLI reads hooks in the original`)
    assert.deepEqual(RS.stripFront(CASES[k]).removed, ['hooks'], k)
    assert.deepEqual(Object.keys(Yd(after(CASES[k]))), ['name', 'description'], k)
  }
  // (a '---' inside a line ends it for the CLI: what comes after is body, and the file is left as it is)
  for (const k of ['midLineDashes', 'indentedDashes', 'dashTrail', 'commentClose', 'noClose', 'leadingBlank']) assert.equal(RS.stripFront(CASES[k]), null, k)
  assert.deepEqual(RS.stripFront(CASES.caseVar).removed, ['Hooks', 'allowed_tools', 'allowedTools', 'Allowed-Tools'], '대소문자 · _ · camelCase')
  assert.equal(after(CASES.crlf), '---\r\nname: a\r\n---\r\nbody\r\n')
  assert.equal(after(CASES.bom), '﻿---\nname: a\n---\nbody\n')
  // (YAML that js-yaml does not read, or a run key it does not show at the top: an empty front matter in its place, the body after it)
  for (const k of ['docEnd', 'dup', 'quotedMulti', 'tab', 'inList', 'docStartDirective']) assert.deepEqual(RS.stripFront(CASES[k]).removed, ['(front matter)'], k)
  assert.equal(after(CASES.dup), '---\n---\nbody\n')
})

const bun = (() => { const r = spawnSync('bun', ['-e', 'process.stdout.write(typeof Bun.YAML?.parse)'], { encoding: 'utf8' }); return r.status === 0 && r.stdout === 'function' })()
test('Bun 이 있으면: CLI 의 읽기를 Bun.YAML 그대로 — 남긴 머리말에 실행 키가 없다', { skip: !bun && 'no bun with Bun.YAML on this computer' }, () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'bun-'))
  fs.writeFileSync(path.join(dir, 'in.json'), JSON.stringify(Object.fromEntries(Object.entries(CASES).map(([k, t]) => [k, [t, after(t)]]))))
  fs.writeFileSync(path.join(dir, 'read.js'), `${cliReader.toString()}\nconst KL = ${KL}\nconst Su = ${Su}\nconst Yd = cliReader((s) => Bun.YAML.parse(s))\n` +
    `const C = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dir, 'in.json'))}, 'utf8'))\n` +
    'const out = {}; for (const [k, [a, b]] of Object.entries(C)) out[k] = [Object.keys(Yd(a)), Object.keys(Yd(b))]\nconsole.log(JSON.stringify(out))\n')
  const r = spawnSync('bun', [path.join(dir, 'read.js')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  for (const [k, [, b]] of Object.entries(out)) assert.deepEqual(b.filter((x) => RUNS.has(norm(x))), [], k)
  for (const k of ['docEndIndented', 'sp1', 'folded']) assert.ok(out[k][0].includes('hooks'), `${k}: Bun reads hooks in the original`)
})

test('머리말의 실행 키만 빼고, 나머지 머리말과 본문은 그대로 — 스킬 · 하위 폴더의 스킬 · 에이전트 · 명령', async () => {
  const dir = repo({
    '.claude/skills/제안서/SKILL.md': SKILL,
    '부서/영업/.claude/skills/견적/SKILL.md': SKILL.replace('제안서', '견적'),
    '.claude/agents/팀/검토자.md': '---\nname: 검토자\ndescription: 제안서를 검토한다\npermissionMode: bypassPermissions\nmcpServers:\n  - probe: {command: sh}\ntools: Read, Grep\n---\n검토한다\n',
    '.claude/commands/배포/올리기.md': '---\ndescription: 올린다\nallowed-tools: Bash(git push:*)\nlspServers: {x: {command: sh}}\n---\n!`git push`\n',
  })
  const r = await RS.leaveOff(dir)
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

test('YAML 로 읽히지 않는 머리말은 빈 머리말로(본문은 남김), 실행 키가 없는 파일은 손대지 않는다 · 별칭으로 합친 키도 뺀다', async () => {
  const plain = '---\nname: 그대로\ndescription: 손대지 않음\n---\n본문\r\n'
  const dir = repo({
    '.claude/skills/중복/SKILL.md': '---\nname: 중복\nhooks: {}\nhooks: {PreToolUse: []}\n---\n본문\n',
    '.claude/skills/그대로/SKILL.md': plain,
    '.claude/skills/별칭/SKILL.md': '---\nbase: &b\n  allowed-tools: Bash\nname: 별칭\n<<: *b\n---\n본문\n',
    'docs/SKILL.txt': '---\nhooks: {}\n---\n',
  })
  const r = await RS.leaveOff(dir)
  assert.equal(read(dir, '.claude/skills/중복/SKILL.md'), '---\n---\n본문\n')
  assert.deepEqual(r.front.find((x) => x.path === '.claude/skills/중복/SKILL.md').removed, ['(front matter)'])
  assert.equal(read(dir, '.claude/skills/그대로/SKILL.md'), plain, '바이트 그대로')
  assert.ok(!('allowed-tools' in front(read(dir, '.claude/skills/별칭/SKILL.md'))))
  assert.equal(read(dir, 'docs/SKILL.txt'), '---\nhooks: {}\n---\n')
  assert.ok(!r.paths.includes('.claude/skills/그대로/SKILL.md'))
})

test('빠뜨리지 않는다: git 에서 무시되는 node_modules · CLI 의 .claude/ 아래 파일 · 안쪽 저장소 · 아주 긴 파일(앞부분만 읽고 나머지는 그대로) · 하드 링크는 새 파일로', async () => {
  const dir = repo({ '.gitignore': '/node_modules\n', 'README.md': '# 템플릿\n' })
  put(dir, 'node_modules/도구/.claude/skills/x/SKILL.md', '---\nname: x\nhooks: {}\n---\n')
  put(dir, 'node_modules/도구/SKILL.md', '---\nname: y\nallowed-tools: Bash\n---\n')
  put(dir, '.claude/agents/나중.md', '---\nname: 나중\npermissionMode: bypassPermissions\n---\n')
  // a repository inside (another run's clone) — read from the disk, its own git never run
  const inner = path.join(dir, '받은것')
  fs.mkdirSync(inner)
  git(inner, 'init', '-q')
  fs.writeFileSync(path.join(inner, '.git', 'config'), '[core]\n\tfsmonitor = touch ' + JSON.stringify(path.join(ROOT, 'fsmonitor-ran')) + '\n', { flag: 'a' })
  put(inner, '.claude/skills/z/SKILL.md', '---\nname: z\nshell: /bin/zsh\n---\n')
  // long files: a front matter in the head, a body of 3 MB after it; one whose front matter does not end in the head
  const body = crypto.randomBytes(3 * 1024 * 1024).toString('base64')
  put(dir, '.claude/skills/긴/SKILL.md', `---\nname: 긴\nhooks: {}\n---\n${body}`)
  put(dir, '.claude/skills/더긴/SKILL.md', `---\nname: 더긴\ndescription: ${'가'.repeat(RS.HEAD_MAX)}\nhooks: {}\n---\n본문\n`)
  // a hard link to a file elsewhere: replaced, never written through
  const elsewhere = path.join(ROOT, `mine-${crypto.randomUUID()}.md`)
  fs.writeFileSync(elsewhere, '---\nname: 내것\nhooks: {}\n---\n')
  fs.mkdirSync(path.join(dir, '.claude/skills/링크'), { recursive: true })
  fs.linkSync(elsewhere, path.join(dir, '.claude/skills/링크/SKILL.md'))
  const r = await RS.leaveOff(dir)
  assert.deepEqual(r.front.map((x) => x.path).sort(), ['.claude/agents/나중.md', '.claude/skills/긴/SKILL.md', '.claude/skills/더긴/SKILL.md', '.claude/skills/링크/SKILL.md',
    'node_modules/도구/.claude/skills/x/SKILL.md', 'node_modules/도구/SKILL.md', '받은것/.claude/skills/z/SKILL.md'].sort())
  assert.equal(read(dir, 'node_modules/도구/.claude/skills/x/SKILL.md'), '---\nname: x\n---\n')
  assert.equal(read(dir, '받은것/.claude/skills/z/SKILL.md'), '---\nname: z\n---\n')
  assert.ok(!fs.existsSync(path.join(ROOT, 'fsmonitor-ran')), 'the inner repository\'s git was not run')
  assert.equal(read(dir, '.claude/skills/긴/SKILL.md'), `---\nname: 긴\n---\n${body}`)
  assert.ok(read(dir, '.claude/skills/더긴/SKILL.md').startsWith('---\n---\nname: 더긴\ndescription: 가가'))
  assert.deepEqual(runKeys(Yd(read(dir, '.claude/skills/더긴/SKILL.md'))), [])
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '---\nname: 내것\nhooks: {}\n---\n', 'the other name of the file is as it was')
  assert.equal(read(dir, '.claude/skills/링크/SKILL.md'), '---\nname: 내것\n---\n')
  assert.ok(!fs.readdirSync(path.join(dir, '.claude/skills/긴')).some((f) => f.endsWith('.tmp')), 'no temporary file left')
})

test('작업 폴더 밖으로 이어진 링크 폴더: .codex(사람의 ~/.codex)는 따라가 쓰지 않고, .claude 아래의 링크 폴더는 목록이 닿지 않아 실행을 거절 · git 이 아니면 거절', { skip: process.platform === 'win32' && 'links need rights on Windows' }, async () => {
  const home = fs.mkdtempSync(path.join(ROOT, 'home-'))
  put(home, 'codex/config.toml', 'model = "mine"\n')
  put(home, 'claude/settings.json', '{"theme":"dark"}\n')
  put(home, 'claude/skills/내것/SKILL.md', '---\nname: 내것\nhooks: {}\n---\n')
  put(home, 'mcp.json', '{"mcpServers":{"mine":{}}}\n')
  const dir = repo()
  fs.symlinkSync(path.join(home, 'codex'), path.join(dir, '.codex'))
  fs.symlinkSync(path.join(home, 'mcp.json'), path.join(dir, '.mcp.json'))
  const r = await RS.leaveOff(dir)
  assert.equal(read(home, 'codex/config.toml'), 'model = "mine"\n')
  // (.mcp.json itself a link: the link goes and an empty file takes its place — what it pointed at stays)
  assert.equal(read(home, 'mcp.json'), '{"mcpServers":{"mine":{}}}\n')
  assert.ok(!fs.lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink())
  assert.deepEqual(r.files, ['.mcp.json'])
  assert.deepEqual(r.front, [])
  // a link folder under .claude: refused
  const d2 = repo()
  fs.symlinkSync(path.join(home, 'claude'), path.join(d2, '.claude'))
  await assert.rejects(RS.leaveOff(d2), (e) => e.code === 'RUN_SETTINGS_INCOMPLETE' && e.why === 'link' && e.detail === '.claude')
  assert.equal(read(home, 'claude/settings.json'), '{"theme":"dark"}\n')
  assert.equal(read(home, 'claude/skills/내것/SKILL.md'), '---\nname: 내것\nhooks: {}\n---\n')
  const d3 = repo()
  fs.mkdirSync(path.join(d3, '.claude/skills'), { recursive: true })
  fs.symlinkSync(path.join(home, 'claude/skills/내것'), path.join(d3, '.claude/skills/내것'))
  await assert.rejects(RS.leaveOff(d3), (e) => e.why === 'link' && e.detail === '.claude/skills/내것')
  // not a git work folder: the list cannot be made
  const d4 = fs.mkdtempSync(path.join(ROOT, 'plain-'))
  await assert.rejects(RS.leaveOff(d4), (e) => e.code === 'RUN_SETTINGS_INCOMPLETE' && e.why === 'list')
})

test('배지의 읽기: CLI 가 찾는 머리말에 실행 키가 있으면(어디에 있든 · 어떤 표기든) 그 키 — 서버의 kit.js 와 같은 목록 · 앞부분만 읽었으면 끝나지 않은 머리말은 전부', () => {
  assert.deepEqual(RS.frontRuns(SKILL), ['hooks', 'allowed-tools', 'shell'])
  assert.deepEqual(RS.frontRuns('---\n{name: x, "permissionMode": plan}\n---\n'), ['permissionMode'])
  assert.deepEqual(RS.frontRuns('---\n{"name": "x", "hooks":{}}\n---\n'), ['hooks'])
  assert.deepEqual(RS.frontRuns('---\nname: x\n---\nhooks: 본문에만\n'), [])
  assert.deepEqual(RS.frontRuns(CASES.sp1), ['hooks'], '들여쓴 ... 뒤도')
  assert.deepEqual(RS.frontRuns(CASES.caseVar), ['hooks', 'allowed-tools'])
  assert.deepEqual(RS.frontRuns(CASES.explicitKey), ['allowed-tools'])
  assert.deepEqual(RS.frontRuns('---\nname: x\ndescription: 길다'), [])
  assert.deepEqual(RS.frontRuns('---\nname: x\ndescription: 길다', { truncated: true }), RS.FRONT_RUNS)
  assert.deepEqual(RS.FRONT_RUNS, require('../../server/lib/folders/kit-places.json').frontMatterRuns)
})
