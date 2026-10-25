// 서버 단위 시험 재사용 — pgpt-pro/server/test 의 모델·외부 계정 없이 도는 시험(보관함 봉투 암호화·KEK/DEK 교체,
// 패널 규칙 컴파일·이벤트 재계산, 브라우저↔보관함: 모델 요청에 비밀 0건)을 이 스위트에서 함께 돌린다.
import { test, expect } from '../../lib/fixtures.js'
import { spawnSync } from 'node:child_process'
import { SERVER_DIR, hasServerSource } from '../../lib/env.js'

test.describe.configure({ retries: 2 })
const SUITES = [
  ['F-UT-01 보관함: 봉투 암호화·검증·KEK/DEK 교체 (server/test/vault.test.js)', ['test/vault.test.js']],
  ['F-UT-02 패널 앱: 정의·규칙 컴파일·이벤트 재계산 (panelApps/panelRules/panelEvents)', ['test/panelApps.test.js', 'test/panelRules.test.js', 'test/panelEvents.test.js']],
  ['F-UT-03 브라우저 에이전트↔보관함: 로그인·OTP·결제에서 모델 요청에 비밀 0건 (browser-vault.test.js)', ['test/browser-vault.test.js']],
  ['F-UT-04 Google 로그인 토큰 검증 (google.test.js)', ['test/google.test.js']],
]
for (const [name, files] of SUITES) {
  // the browser one drives a real Chromium against a local shop: on a busy machine give it a second go
  test(name, { annotation: files[0].includes('browser') ? [{ type: 'flaky', description: '부하가 크면 느려짐' }] : [] }, async () => {
    test.skip(!hasServerSource(), 'server 소스 없음')
    test.setTimeout(180_000)
    // a clean environment: not Playwright's loader (NODE_OPTIONS) nor settings an in-process server
    // module already read into this worker's process.env (server/.env)
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_OPTIONS|PW_|PLAYWRIGHT_|TEST_|PRO_|RT_)/.test(k)))
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: SERVER_DIR, encoding: 'utf8', timeout: 170_000, env })
    await test.info().attach('node-test-output.txt', { body: `${r.stdout}\n${r.stderr}`, contentType: 'text/plain' })
    expect(r.status, (r.stdout + r.stderr).split('\n').filter((l) => /^not ok|✖|fail \d/.test(l)).join('\n')).toBe(0)
    expect(r.stdout).toMatch(/ℹ fail 0/)
  })
}
