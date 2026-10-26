// 설치 번들(install/) — Docker Compose 한 줄 설치가 깨지지 않았는지: 스크립트 문법, compose 해석(lite·full 프로필),
// nginx 가 /api·/office·/craft 를 넘기는지. 실제 설치 스택에 대고는 PGPT_URL=http://localhost:18080 으로 이 스위트 전체를 돌린다.
import { test, expect } from '../../lib/fixtures.js'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIR = [process.env.PGPT_INSTALL_DIR, path.resolve(here, '../../../install'), path.resolve(here, '../../../../process-gpt-lite/install')].find((d) => d && fs.existsSync(path.join(d, 'docker-compose.yml')))
const compose = (...args) => spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '--env-file', '.env.example', ...args], { cwd: DIR, encoding: 'utf8', env: { ...process.env, LITE_INSTALL_DIR: DIR } })

test.describe('설치 번들', () => {
  test.skip(!DIR, 'install/ 이 없음 (PGPT_INSTALL_DIR)')

  test('S-50 install.sh · get.sh 문법', async () => {
    for (const f of ['install.sh', 'get.sh']) {
      const r = spawnSync('bash', ['-n', f], { cwd: DIR, encoding: 'utf8' })
      expect(r.status, `${f}: ${r.stderr}`).toBe(0)
    }
    expect(fs.readFileSync(path.join(DIR, 'get.sh'), 'utf8')).toContain('process-gpt-lite')
  })

  test('S-51 docker compose 해석: lite·full·mining 프로필의 서비스', async () => {
    test.skip(spawnSync('docker', ['compose', 'version']).status !== 0, 'docker compose 없음')
    const lite = compose('config', '--quiet')
    expect(lite.status, lite.stderr).toBe(0)
    const full = compose('--profile', 'full', 'config', '--services')
    expect(full.status, full.stderr).toBe(0)
    const services = full.stdout.split('\n').filter(Boolean)
    expect(services).toEqual(expect.arrayContaining(['db', 'auth', 'rest', 'storage', 'kong', 'server', 'web', 'deepagents', 'office-host', 'office-mcp', 'migrate', 'completion', 'polling', 'mcp-hub']))
    // the optional mining profile adds process-miner and nothing else; lite alone has no miner
    const mining = compose('--profile', 'lite', '--profile', 'mining', 'config', '--services')
    expect(mining.status, mining.stderr).toBe(0)
    expect(mining.stdout.split('\n')).toContain('process-miner')
    expect(compose('--profile', 'lite', 'config', '--services').stdout.split('\n')).not.toContain('process-miner')
    // the handover log the miner reads is created by the bundle's migration (db/compat)
    expect(fs.readFileSync(path.join(DIR, 'db/compat/03_handover_events.sql'), 'utf8')).toContain('create table if not exists public.handover_events')
  })

  test('S-52 web(nginx) 이 /api·/office·/craft·/auth|rest|storage 를 넘긴다', async () => {
    const nginx = fs.readFileSync(path.join(DIR, 'docker/nginx.conf'), 'utf8')
    for (const loc of ['location /api/', 'location /office/', 'location /craft/', '(auth|rest|storage)/v1/']) expect(nginx).toContain(loc)
    // SSE needs buffering off on /api
    expect(nginx).toMatch(/proxy_buffering\s+off/)
  })
})
