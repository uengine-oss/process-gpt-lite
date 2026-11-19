// 운영 bridge(server/bridge/serve.py): 서비스 키로 DB 에 프로세스 정의를 쓰는 서비스라 같은 키를 Bearer 로
// 보낸 요청만 받고, 여러 테넌트를 한 bridge 가 받으므로 요청이 보낸 tenant_id 로 저장한다.
// save_generated.py 대신 받은 환경(TENANT_ID)을 그대로 돌려주는 스크립트를 BRIDGE_SCRIPT 로 끼워 본다.
// Lite 서버의 saveGenerated 도 PRO_BRIDGE_URL 로 이 bridge 를 불러 키와 테넌트를 넘기는지 본다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVE = path.join(here, '../bridge/serve.py')
const KEY = 'test-service-role-key'

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

async function startBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'))
  const stub = path.join(dir, 'stub.py')
  fs.writeFileSync(stub, 'import json, os, sys\nsys.stdin.read()\nprint(json.dumps({"tenant": os.environ.get("TENANT_ID"), "proc_def_id": "stub"}))\n')
  const port = await freePort()
  const p = spawn('python3', [SERVE], { env: { ...process.env, BRIDGE_PORT: String(port), BRIDGE_SCRIPT: stub, SERVICE_ROLE_KEY: KEY, TENANT_ID: '', BRIDGE_TOKEN: '' }, stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return { url, stop: () => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

const post = (url, body, auth) => fetch(`${url}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }))

test('bridge 는 서비스 키 없이 쓰지 않고, 요청한 테넌트로 저장한다', async () => {
  const b = await startBridge()
  try {
    assert.equal((await post(b.url, { contract: {}, tenant_id: 'ohsy' })).status, 401)
    assert.equal((await post(b.url, { contract: {}, tenant_id: 'ohsy' }, 'Bearer wrong-key')).status, 401)
    assert.equal((await post(b.url, { contract: {} }, `Bearer ${KEY}`)).status, 400, '테넌트 없이는 저장하지 않는다')
    assert.equal((await post(b.url, { contract: {}, tenant_id: '../x' }, `Bearer ${KEY}`)).status, 400)
    const ok = await post(b.url, { contract: {}, tenant_id: 'ohsy' }, `Bearer ${KEY}`)
    assert.equal(ok.status, 200)
    assert.equal(ok.body.tenant, 'ohsy')
  } finally { b.stop() }
})

test('Lite 서버의 saveGenerated 는 bridge 에 서비스 키와 그 요청의 테넌트를 넘긴다', async () => {
  const b = await startBridge()
  try {
    const lib = pathToFileURL(path.join(here, '../lib/generated.js')).href
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { saveGenerated } = await import(${JSON.stringify(lib)}); console.log(JSON.stringify(await saveGenerated({ processDefinition: {} })))`],
    { env: { ...process.env, PRO_BRIDGE_URL: b.url, SERVICE_ROLE_KEY: KEY, PRO_TENANT_ID: 'tenant-b' }, encoding: 'utf8' })
    assert.equal(JSON.parse(out.trim().split('\n').pop()).tenant, 'tenant-b')
  } finally { b.stop() }
})
