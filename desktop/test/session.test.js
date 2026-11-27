'use strict'
// The web app's sign-in kept by the app (desktop 0.2.6 — settings.js webSession, main.js pgl:session:*): sealed with the system's keychain
// (safeStorage — here a stand-in that changes every byte), per server origin, never written as it is; nothing kept when it cannot be sealed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const settings = require('../src/settings')

const flip = (b) => Buffer.from([...b].map((x) => x ^ 0x5a))
function keychain({ available = true, refuse = false, backend } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => { if (refuse) throw new Error('the keychain said no'); return Buffer.concat([Buffer.from('v10'), flip(Buffer.from(s))]) },
    decryptString: (b) => { if (refuse) throw new Error('the keychain said no'); return flip(b.subarray(3)).toString() },
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
  }
}
const session = JSON.stringify({ session: { access_token: 'eyJhbGciOi.access-token-value.sig', refresh_token: 'refresh-token-value-1234', expires_at: 1 } })
function inDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-web-session-'))
  try { return fn(dir, () => fs.readFileSync(path.join(dir, 'desktop-settings.json'), 'utf8')) } finally { settings.setNoSeal(false); fs.rmSync(dir, { recursive: true, force: true }) }
}

test('로그인은 키체인으로 봉인해 출처마다 둔다 — 설정 파일에는 토큰이 그대로 없고, 앱을 다시 켜도 읽힌다 · 지우면 그 출처만', () => inDir((dir, file) => {
  settings.init(dir, keychain())
  assert.equal(settings.canSealWeb(), true)
  assert.equal(settings.webSession('http://127.0.0.1:5391'), null)
  assert.equal(settings.setWebSession('http://127.0.0.1:5391', session), true)
  assert.equal(settings.setWebSession('https://acme.process-gpt.io', '{"other":1}'), true)
  const raw = file()
  for (const secret of ['access-token-value', 'refresh-token-value-1234', 'refresh_token']) assert.ok(!raw.includes(secret), secret)
  assert.equal(JSON.parse(raw).webSession['http://127.0.0.1:5391'].enc, true)
  settings.init(dir, keychain())
  assert.equal(settings.webSession('http://127.0.0.1:5391'), session, '다시 켜도')
  settings.forgetWebSession('http://127.0.0.1:5391')
  assert.equal(settings.webSession('http://127.0.0.1:5391'), null)
  assert.equal(settings.webSession('https://acme.process-gpt.io'), '{"other":1}', '다른 서버의 것은 그대로')
  assert.equal(settings.setWebSession('https://acme.process-gpt.io', 'x'.repeat(settings.MAX_WEB_SESSION + 1)), false, '너무 긴 값')
  assert.equal(settings.setWebSession('', session), false)
}))

test('봉인할 수 없으면 아무것도 두지 않는다 — 키체인이 없거나(일부 Linux · basic_text) 거절하면 페이지가 지금처럼 스스로 둔다', () => inDir((dir, file) => {
  settings.init(dir, keychain({ available: false }))
  assert.equal(settings.canSealWeb(), false)
  assert.equal(settings.setWebSession('http://127.0.0.1:5391', session), false)
  assert.ok(!fs.existsSync(path.join(dir, 'desktop-settings.json')) || !file().includes('access-token-value'))
  // the device token's way (base64 where there is no keychain) is not the sign-in's
  assert.equal(settings.get().webSession, undefined)
  settings.init(dir, keychain({ refuse: true }))
  assert.equal(settings.setWebSession('http://127.0.0.1:5391', session), false, '키체인이 거절')
  const keep = process.platform
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    settings.init(dir, keychain({ backend: 'basic_text' }))
    assert.equal(settings.canSealWeb(), false, 'basic_text: 어디서나 같은 열쇠')
    settings.init(dir, keychain({ backend: 'gnome_libsecret' }))
    assert.equal(settings.canSealWeb(), true)
  } finally { Object.defineProperty(process, 'platform', { value: keep }) }
  // (tests: as a computer without a keychain)
  settings.init(dir, keychain())
  settings.setNoSeal(true)
  assert.equal(settings.canSealWeb(), false)
  assert.equal(settings.webSession('http://127.0.0.1:5391'), null)
}))
