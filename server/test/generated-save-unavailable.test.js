// 정식 등록·프로세스 생성·개선 적용이 쓰는 saveGenerated: 저장 경로(PRO_BRIDGE_URL)가 없고 이 호스트에
// deepagents 의 Python 도 없으면(운영 k8s 서버 이미지) 오류로 돌려준다. 예전에는 spawn 의 'error'
// 이벤트(ENOENT)를 받는 곳이 없어 서버 프로세스가 통째로 죽었다(2026-11-04 운영 정식 등록 502).
// 별도 프로세스에서 돌려, 서버가 죽는지(종료 코드)까지 본다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const lib = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib/generated.js')).href

test('저장 경로가 없으면 서버가 죽지 않고 안내 오류(500)를 돌려준다', () => {
  const script = `
    const { saveGenerated } = await import(${JSON.stringify(lib)})
    try {
      await saveGenerated({ processDefinition: {} }, '', { python: '/nonexistent/pgpt-lite-test/python' })
      console.log(JSON.stringify({ resolved: true }))
    } catch (e) {
      console.log(JSON.stringify({ code: e.code, status: e.status, message: e.message }))
    }
    // a crash on the unhandled 'error' event would never get here
    setTimeout(() => process.exit(0), 50)
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PRO_BRIDGE_URL: '' }, encoding: 'utf8',
  })
  const r = JSON.parse(out.trim().split('\n').pop())
  assert.equal(r.code, 'SAVE_UNAVAILABLE')
  assert.equal(r.status, 500)
  assert.match(r.message, /저장할 곳이 설정되지 않아|nowhere set up to save/)
})
