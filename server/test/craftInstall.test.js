// ArtCraft 앱이 든 설치(Docker --with-craft, 운영 k8s 의 craft initContainer)가 앱을 정말 갖고 있는지.
//   - 늘: craftStatus 는 웹(<웹 루트>/<앱>/index.html)과 CLI(실행 가능한 파일)를 앱마다 따로 본다 — 하나가 빠지면 그 앱만 없다
//   - PRO_CRAFT_WEB_ROOT 를 준 실행(설치된 서버 이미지 안 · 그 /data 를 붙인 컨테이너): 다섯 앱 모두 index.html 이 있고
//     PRO_<앱>_CLI 가 실행되며(--version) MCP 로 initialize · tools/list 에 답한다. 하나라도 빠지면 실패.
//     docker run --rm -v <craft 가 담긴 볼륨>:/data -e PRO_CRAFT_WEB_ROOT=/data/craft -e PRO_CADCRAFT_CLI=/data/craft-bin/cadcraft-cli … \
//       ghcr.io/uengine-oss/process-gpt-lite-server:<태그> node --test test/craftInstall.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

process.env.SERVICE_ROLE_KEY ||= 'test-service-key'
process.env.ANON_KEY ||= 'test-anon-key'
const installed = process.env.PRO_CRAFT_WEB_ROOT
const { config } = await import('../config.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
const APPS = ['cadcraft', 'vectorcraft', 'photocraft', 'soundcraft', 'filmcraft']
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'craft-install-test-'))
after(() => fs.rm(tmp, { recursive: true, force: true }))

// craftStatus keeps its answer for a minute: a fresh copy of the module for each look (after the module
// itself, so the copies find its imports already evaluated; and that one entered the way the server's
// imports reach it — mcp/craft.js first would meet lib/systems.js reading CRAFT_APPS mid-cycle)
await import('../lib/craftWork.js')
await import('../mcp/craft.js')
let n = 0
const status = async () => (await import(`../mcp/craft.js?look=${++n}`)).craftStatus()

test('craftStatus: 웹과 CLI 를 앱마다 본다 — 빠진 것만 없다고 한다', async () => {
  const saved = { web: config.craftWebRoot, cli: { ...config.craftCli } }
  try {
    config.craftWebRoot = path.join(tmp, 'web')
    for (const app of APPS) {
      await fs.mkdir(path.join(tmp, 'web', app), { recursive: true })
      await fs.writeFile(path.join(tmp, 'web', app, 'index.html'), '<!doctype html>')
      const cli = path.join(tmp, 'bin', `${app}-cli`)
      await fs.mkdir(path.dirname(cli), { recursive: true })
      await fs.writeFile(cli, '#!/bin/sh\necho ok\n', { mode: 0o755 })
      config.craftCli[app] = cli
    }
    assert.deepEqual(await status(), Object.fromEntries(APPS.map((a) => [a, { web: true, cli: true }])))
    await fs.rm(path.join(tmp, 'web', 'photocraft', 'index.html'))
    await fs.chmod(config.craftCli.filmcraft, 0o644)
    config.craftCli.soundcraft = path.join(tmp, 'bin', 'missing-cli')
    const s = await status()
    assert.deepEqual(s.photocraft, { web: false, cli: true })
    assert.deepEqual(s.filmcraft, { web: true, cli: false })
    assert.deepEqual(s.soundcraft, { web: true, cli: false })
    assert.deepEqual(s.cadcraft, { web: true, cli: true })
  } finally {
    config.craftWebRoot = saved.web
    Object.assign(config.craftCli, saved.cli)
  }
})

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 60_000 }, (e, out, err) => resolve({ code: e ? e.code ?? 1 : 0, out: String(out || err || '') })))
const ROOTS = { vectorcraft: ['--headless', 'roots'], photocraft: ['roots'], soundcraft: ['roots'] }

for (const app of APPS) {
  test(`설치된 ${app}: 웹 index.html · CLI --version · MCP tools/list`, { skip: !installed && 'PRO_CRAFT_WEB_ROOT 가 없음 (ArtCraft 가 든 설치에서만)' }, async () => {
    const index = path.join(config.craftWebRoot, app, 'index.html')
    assert.ok(await fs.stat(index).catch(() => null), `${index} 가 없음`)
    const cli = config.craftCli[app]
    const v = await run(cli, ['--version'])
    assert.equal(v.code, 0, `${cli} --version: ${v.out.slice(0, 200)}`)
    const ws = await fs.mkdtemp(path.join(tmp, `${app}-`))
    const args = ['mcp', ...(ROOTS[app] || []).flatMap((x) => (x === 'roots' ? ['--automation-read-root', ws, '--automation-write-root', ws] : [x]))]
    const c = new Client({ name: 'craft-install-test', version: '1.0.0' })
    await c.connect(new StdioClientTransport({ command: cli, args, cwd: ws, stderr: 'ignore' }))
    try {
      const { tools } = await c.listTools()
      assert.ok(tools.length > 0, `${app} MCP 가 도구를 내놓지 않음`)
    } finally { await c.close().catch(() => {}) }
  })
}
