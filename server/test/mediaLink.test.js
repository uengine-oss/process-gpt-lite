// 메신저의 그림 · 소리 · 영상 주소에 로그인 토큰(JWT)을 넣지 않는다(2026-11-25 검토): 공유 하나 · 사람 하나 · 15분짜리 서명 주소.
// 서명은 회사 · 공유 · 사람 · 만료 · inline 을 묶고, 서버만 아는 키(서비스 키에서 고정 표지로 끌어낸 HMAC 키)로 만든다.
// 서명이 맞아도 그 사람의 권한은 경로가 다시 본다(공유가 거둬졌거나 남의 것이면 404 — e2e F-MP-06 · 08). 화면 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { linkKey, signLink, verifyLink, linkPath, linkExpiry, LINK_TTL_S } from '../lib/team/mediaLink.js'

const KEY = linkKey('test-only-secret-not-a-real-key')
const T = 'acme'
const SHARE = '3f1d2c4b-1111-4a2b-9c3d-000000000001'
const OTHER_SHARE = '3f1d2c4b-1111-4a2b-9c3d-000000000002'
const JM = 'a1b2c3d4-2222-4e5f-8a9b-00000000000a'
const MJ = 'a1b2c3d4-2222-4e5f-8a9b-00000000000b'
const NOW = Date.UTC(2026, 10, 25, 9, 1, 0)
const sign = (o = {}) => signLink({ key: KEY, tenant: T, id: SHARE, userId: JM, inline: true, now: NOW, ...o })
const check = (l, o = {}) => verifyLink({ key: KEY, tenant: T, id: SHARE, u: l.u, exp: l.exp, sig: l.sig, inline: l.inline, now: NOW, ...o })
// one character of the signature changed (still base64url, same length)
const flip = (sig) => sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11)

test('서명한 주소는 그 사람 · 그 공유 · inline 그대로일 때만 맞고, 15~20분 뒤에 만료된다', () => {
  const l = sign()
  assert.equal(check(l), 'ok')
  assert.equal(l.u, JM)
  assert.equal(l.inline, true)
  assert.match(l.sig, /^[A-Za-z0-9_-]{43}$/)
  const left = l.exp - NOW / 1000
  assert.ok(left >= LINK_TTL_S && left <= LINK_TTL_S + 300, `${left}s`)
  assert.equal(l.exp % 300, 0, 'expiries fall on 5-minute marks')
  // the same address for a while (the browser keeps the picture)
  assert.deepEqual(sign({ now: NOW + 120_000 }), l)
  assert.equal(check(l, { now: (l.exp - 1) * 1000 }), 'ok')
})

test('바꾼 주소는 맞지 않는다: 서명 · 만료 · 공유 · 사람 · inline · 회사', () => {
  const l = sign()
  assert.equal(check({ ...l, sig: flip(l.sig) }), 'bad', 'signature')
  assert.equal(check({ ...l, exp: l.exp + 300 }), 'bad', 'a later expiry')
  assert.equal(check({ ...l, exp: l.exp - 300 }), 'bad', 'an earlier expiry')
  assert.equal(check(l, { id: OTHER_SHARE }), 'bad', 'another share')
  assert.equal(check({ ...l, u: MJ }), 'bad', 'another person with this signature')
  assert.equal(check({ ...l, inline: false }), 'bad', 'inline dropped')
  assert.equal(check(sign({ inline: false }), { inline: true }), 'bad', 'inline added')
  assert.equal(check(sign({ inline: false })), 'ok', 'a download address is its own signature')
  assert.equal(check(l, { tenant: 'other-co' }), 'bad', 'another company')
  // another key (another install, or the service key itself instead of the derived one)
  assert.equal(check(l, { key: linkKey('another-secret') }), 'bad')
  assert.equal(check(l, { key: Buffer.from('test-only-secret-not-a-real-key') }), 'bad')
})

test('만료된 주소: expired — 서명이 맞을 때만 (바꾼 만료 주소는 bad)', () => {
  const l = sign()
  assert.equal(check(l, { now: l.exp * 1000 }), 'expired')
  assert.equal(check(l, { now: (l.exp + 3600) * 1000 }), 'expired')
  assert.equal(check({ ...l, sig: flip(l.sig) }, { now: (l.exp + 10) * 1000 }), 'bad')
  // signed with a far expiry (not one of ours): refused
  const far = sign({ exp: Math.floor(NOW / 1000) + 24 * 3600 })
  assert.equal(check(far), 'bad')
})

test('모양이 틀린 값은 계산 전에 bad (빈 값 · 잘린 서명 · 숫자 아닌 만료 · uuid 아닌 사람)', () => {
  const l = sign()
  for (const bad of [{ sig: '' }, { sig: l.sig.slice(0, 42) }, { sig: `${l.sig}A` }, { sig: l.sig.replace(/.$/, '+') }, { exp: '' }, { exp: 'soon' }, { exp: '1e12' }, { u: '' }, { u: 'admin' }, { u: undefined }]) {
    assert.equal(check({ ...l, ...bad }), 'bad', JSON.stringify(bad))
  }
  assert.equal(check(l, { id: '../x' }), 'bad')
  assert.throws(() => signLink({ key: KEY, tenant: T, id: 'x', userId: JM }))
  assert.throws(() => linkKey(''), /no secret/)
})

test('키는 비밀에서 끌어내고(비밀 자체가 아님), 주소에는 사람 id · 만료 · 서명만', () => {
  const k = linkKey('s3cret')
  assert.equal(k.length, 32)
  assert.deepEqual(linkKey('s3cret'), k, 'the same on every pod')
  assert.notDeepEqual(k, Buffer.from('s3cret'))
  const l = sign()
  const p = linkPath(SHARE, l)
  assert.equal(p, `/team/shares/${SHARE}/raw?u=${JM}&exp=${l.exp}&inline=1&sig=${l.sig}`)
  assert.equal(linkExpiry(p), l.exp)
  assert.doesNotMatch(p, /token=|eyJ|secret/)
  assert.equal(linkPath(SHARE, sign({ inline: false })).includes('inline'), false)
  assert.equal(linkExpiry('/x?y=1'), 0)
})
