// 구글로 로그인한 사람(같은 날 「프로필 사진은 기본적으로 social login 인 경우는 구글에 설정된 이미지가 나오는게」)은 구글 사진이 기본: 고른 것 → 구글 사진
// → 이름 첫 글자. 구글 사진은 인증 서버가 쓴 기록(구글 identity · app_metadata)에서만, 허용한 호스트(https *.googleusercontent.com)에서만.
// 프로필 사진(2026-11-25 「내 프로필 사진 어떻게 바꾸냐? Process GPT 버전과 일관성고려하여」): users.profile 하나를 Process GPT 와 같이 쓴다.
// 저장할 수 있는 것은 Process GPT 의 기본 사진 18장(같은 경로), 이 설치 저장소의 내 폴더(pgpt-pro/<나>/avatar/)에 올린 사진, 빈 값뿐이다 —
// 다른 사이트 주소(추적 픽셀) · 남의 사진 · data: · 다른 버킷은 400. 보여 주는 것은 이 사이트의 그림과 이 설치 저장소의 그림뿐이고,
// Process GPT 의 기본값(/images/defaultUser.png)과 그 밖의 것은 이름 첫 글자. 화면이 기본 사진을 어디서 불러오는지(사이트 뿌리 → Lite 의
// 사본)와 가운데 정사각형 자르기도 여기서 본다. 데이터베이스 · 네트워크 없이 (실제 저장 · 화면은 e2e F-AV-*).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkPicture, shownPicture, ownUploadKey, sniffImage, PRESETS, NO_PICTURE, uploadPrefix, uploadUrl,
  parseAvatarHosts, onAvatarHost, googlePictureOf, seedValue, defaultValue, resolvePicture,
} from '../lib/profilePicture.js'
import { PRESETS as SCREEN_PRESETS, faceSources, squareCrop, initialOf } from '../../src/profilePictures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(here, '../../public')
const SB = 'http://127.0.0.1:54321'
const ME = '3b8c1f2e-6a4d-4e0b-9c1a-7d2e5f6a8b90'
const OTHER = '9f0e1d2c-3b4a-4c5d-8e6f-0a1b2c3d4e5f'
const mine = (name) => `${SB}/storage/v1/object/public/files/pgpt-pro/${ME}/avatar/${name}`
const check = (v, o = {}) => checkPicture(v, { userId: ME, supabaseUrl: SB, ...o })
const refused = (v, o) => assert.throws(() => check(v, o), (e) => e.status === 400, String(v))

test('Process GPT 의 기본 사진 18장 — 같은 경로 · 같은 순서, Lite 에도 같은 파일(JPEG)이 있다', () => {
  assert.equal(PRESETS.length, 18)
  assert.deepEqual(SCREEN_PRESETS, PRESETS, '화면과 서버의 목록이 같다')
  assert.equal(PRESETS[0], '/assets/images/profile/1.jpg')
  assert.equal(PRESETS[8], '/assets/images/profile/user-1.jpg')
  assert.equal(PRESETS[17], '/assets/images/profile/user-10.jpg')
  for (const p of PRESETS) {
    const file = path.join(PUBLIC, p)
    assert.ok(fs.existsSync(file), file)
    assert.equal(sniffImage(fs.readFileSync(file)), 'image/jpeg', p)
  }
})

test('저장: 기본 사진은 그 경로 그대로, 빈 값은 사진 없음', () => {
  for (const p of PRESETS) assert.equal(check(p), p)
  assert.equal(check(` ${PRESETS[3]} `), PRESETS[3])
  for (const v of [null, undefined, '', '   ']) assert.equal(check(v), null, JSON.stringify(v))
})

test('저장: 이 설치 저장소의 내 폴더에 올린 사진(jpg · webp · png)만', () => {
  for (const n of ['5a1f0c3e-2b4d-4e6f-8a9b-0c1d2e3f4a5b.webp', 'a.jpg', 'b.jpeg', 'c.png']) assert.equal(check(mine(n)), mine(n), n)
  // (the install's address written with a trailing slash: the same place)
  assert.equal(check(mine('a.webp'), { supabaseUrl: `${SB}/` }), mine('a.webp'))
  assert.equal(uploadUrl(SB, `${uploadPrefix(ME)}x.webp`), mine('x.webp'))
})

test('저장 거절(400): 남의 사진 · 다른 폴더 · 다른 버킷 · 다른 사이트 · 주소 장난 · 사진이 아닌 것', () => {
  const bad = [
    `${SB}/storage/v1/object/public/files/pgpt-pro/${OTHER}/avatar/a.webp`,      // someone else's upload
    `${SB}/storage/v1/object/public/files/pgpt-pro/${ME}/att/a.webp`,            // my files, not my pictures
    `${SB}/storage/v1/object/public/files/pgpt-pro/${ME}/a.webp`,
    `${SB}/storage/v1/object/public/chat-images/pgpt-pro/${ME}/avatar/a.webp`,   // another bucket
    `${SB}/storage/v1/object/sign/files/pgpt-pro/${ME}/avatar/a.webp`,
    `https://tracker.example.com/pixel.gif`,                                       // another site
    `https://tracker.example.com/storage/v1/object/public/files/pgpt-pro/${ME}/avatar/a.webp`,
    `http://127.0.0.1:54322/storage/v1/object/public/files/pgpt-pro/${ME}/avatar/a.webp`,
    `//tracker.example.com/a.jpg`,
    mine('a.webp?track=1'), mine('a.webp#x'), mine('../a.webp'), mine('%2e%2e/a.webp'), mine('sub/a.webp'), mine('a.svg'), mine('a.html'), mine('.webp'),
    `${SB}/storage/v1/object/public/files/pgpt-pro/${ME}/avatar/../../${OTHER}/avatar/a.webp`,
    'data:image/png;base64,iVBORw0KGgo=', 'javascript:alert(1)',
    NO_PICTURE,                                                                    // Process GPT's placeholder: "none" is null
    '/assets/images/profile/99.jpg', '/assets/images/profile/1.jpg?x', '/assets/images/profile/../../x.jpg', '/images/chat-icon.png',
    mine('a'.repeat(700) + '.webp'),
  ]
  for (const v of bad) refused(v)
  for (const v of [12, {}, ['/assets/images/profile/1.jpg'], true]) assert.throws(() => check(v), (e) => e.status === 400, JSON.stringify(v))
  // no person or no storage address: only presets and nothing
  refused(mine('a.webp'), { userId: 'not-a-uuid' })
  refused(mine('a.webp'), { supabaseUrl: '' })
  assert.equal(check(PRESETS[0], { userId: '', supabaseUrl: '' }), PRESETS[0])
})

test('내가 올린 사진의 저장소 열쇠(바꾸면 지울 것): 내 사진만', () => {
  assert.equal(ownUploadKey(mine('a.webp'), { userId: ME, supabaseUrl: SB }), `pgpt-pro/${ME}/avatar/a.webp`)
  assert.equal(ownUploadKey(PRESETS[0], { userId: ME, supabaseUrl: SB }), null)
  assert.equal(ownUploadKey(null, { userId: ME, supabaseUrl: SB }), null)
  assert.equal(ownUploadKey(mine('a.webp'), { userId: OTHER, supabaseUrl: SB }), null)
  assert.equal(ownUploadKey('https://tracker.example.com/a.webp', { userId: ME, supabaseUrl: SB }), null)
})

test('보여 주기: 어느 앱이 썼든 이 사이트의 그림 · 이 설치 저장소의 그림만, 나머지는 이름 첫 글자(null)', () => {
  const show = (v) => shownPicture(v, { supabaseUrl: SB })
  for (const v of [null, undefined, '', ' ', NO_PICTURE, 42]) assert.equal(show(v), null, String(v))
  for (const p of PRESETS) assert.equal(show(p), p)
  // Process GPT's own pictures on the same site, and anything in this install's public storage (Process GPT's chat images too)
  assert.equal(show('/images/chat-icon.png'), '/images/chat-icon.png')
  assert.equal(show('/assets/images/profile/user-3.jpg'), '/assets/images/profile/user-3.jpg')
  assert.equal(show(mine('a.webp')), mine('a.webp'))
  assert.equal(show(`${SB}/storage/v1/object/public/files/pgpt-pro/${OTHER}/avatar/b.jpg`), `${SB}/storage/v1/object/public/files/pgpt-pro/${OTHER}/avatar/b.jpg`)
  assert.equal(show(`${SB}/storage/v1/object/public/chat-images/x/y.png`), `${SB}/storage/v1/object/public/chat-images/x/y.png`)
  for (const v of ['https://tracker.example.com/pixel.gif', '//tracker.example.com/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '/api/me', '/images/../api/x.png',
    '/images//tracker.example.com/a.png', '/images/a.svg', `${SB}/storage/v1/object/public/`, `${SB}/storage/v1/object/public/files/a.png"onerror="x`,
    `${SB}/storage/v1/object/public/files/../../auth/v1/x.png`, `${SB}/storage/v1/object/public/files/a.png?t=1`, `${SB}/storage/v1/object/sign/files/a.png`]) assert.equal(show(v), null, v)
  // no storage address known: only same-site pictures
  assert.equal(shownPicture(mine('a.webp')), null)
})

test('올린 바이트의 형식은 앞 바이트로: JPEG · WebP · PNG, 나머지는 null', () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])), 'image/jpeg')
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')])), 'image/webp')
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])), 'image/png')
  for (const b of [Buffer.from('GIF89a......'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), Buffer.from('<!doctype html><script>'), Buffer.from([0xff, 0xd8]), Buffer.alloc(0), null]) {
    assert.equal(sniffImage(b), null, String(b))
  }
})

test('화면: 기본 사진은 사이트 뿌리(게이트웨이 뒤 Process GPT 의 파일) 다음 Lite 의 사본, 그 밖의 사진은 그 주소 하나', () => {
  const p = '/assets/images/profile/2.jpg'
  assert.deepEqual(faceSources(p, '/lite'), [p, '/lite/assets/images/profile/2.jpg'])
  assert.deepEqual(faceSources(p, '/lite/'), [p, '/lite/assets/images/profile/2.jpg'])
  // Lite at a domain's root: the root is Lite's own copy
  assert.deepEqual(faceSources(p, ''), [p])
  assert.deepEqual(faceSources(mine('a.webp'), '/lite'), [mine('a.webp')])
  assert.deepEqual(faceSources('/images/chat-icon.png', '/lite'), ['/images/chat-icon.png'])
  for (const v of [null, undefined, '', 0]) assert.deepEqual(faceSources(v, '/lite'), [])
})

test('화면: 가운데 정사각형으로 자르기, 이름 첫 글자', () => {
  assert.deepEqual(squareCrop(400, 300), { sx: 50, sy: 0, s: 300 })
  assert.deepEqual(squareCrop(3024, 4032), { sx: 0, sy: 504, s: 3024 })
  assert.deepEqual(squareCrop(256, 256), { sx: 0, sy: 0, s: 256 })
  assert.deepEqual(squareCrop(301, 300), { sx: 0, sy: 0, s: 300 })
  assert.equal(initialOf('한지민'), '한')
  assert.equal(initialOf(' Yuna'), 'Y')
  for (const v of [null, '', '  ']) assert.equal(initialOf(v), '?')
})

// a Google account's picture, the way Google serves them
const G1 = 'https://lh3.googleusercontent.com/a/ACg8ocKfictional1=s96-c'
const G2 = 'https://lh3.googleusercontent.com/a/ACg8ocKfictional2=s96-c'
const googleUser = (identity, extra = {}) => ({ id: ME, identities: [{ provider: 'email', identity_data: { email: 'a@example.test' } }, { provider: 'google', identity_data: identity }], ...extra })

test('사진을 둘 수 있는 호스트(PRO_AVATAR_HOSTS): 기본은 https *.googleusercontent.com, http 는 이 PC(시험의 가짜 호스트)만', () => {
  assert.deepEqual(parseAvatarHosts(), [{ host: 'googleusercontent.com', sub: true }])
  assert.deepEqual(parseAvatarHosts('http://127.0.0.1:59981, http://avatars.example.com, https://img.example.com:8443, cdn.example.com, *.example.org, bad host, http://'),
    [{ origin: 'http://127.0.0.1:59981' }, { origin: 'https://img.example.com:8443' }, { host: 'cdn.example.com', sub: false }, { host: 'example.org', sub: true }])
  for (const v of [G1, 'https://lh4.googleusercontent.com/x/y.jpg?sz=50', 'https://googleusercontent.com/a.png']) assert.equal(onAvatarHost(v), true, v)
  for (const v of ['http://lh3.googleusercontent.com/a/x', 'https://googleusercontent.com.evil.example/a', 'https://evilgoogleusercontent.com/a', 'https://lh3.googleusercontent.com@evil.example/a',
    'https://u:p@lh3.googleusercontent.com/a', '//lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com/a"onerror="x', 'https://lh3.googleusercontent.com/a b',
    'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://tracker.example.com/p.gif', null, 7]) assert.equal(onAvatarHost(v), false, String(v))
  const test = { avatarHosts: 'http://127.0.0.1:59981' }
  assert.equal(onAvatarHost('http://127.0.0.1:59981/a/1.png', test), true)
  assert.equal(onAvatarHost('http://127.0.0.1:59982/a/1.png', test), false)
  assert.equal(onAvatarHost(G1, test), false, 'the setting replaces the default')
})

test('구글 사진은 인증 서버가 쓴 기록에서만: 구글 identity(picture → avatar_url), Lite 의 구글 로그인이 쓴 app_metadata — user_metadata 는 읽지 않음', () => {
  assert.equal(googlePictureOf(googleUser({ picture: G1, avatar_url: G2 })), G1)
  assert.equal(googlePictureOf(googleUser({ avatar_url: G2 })), G2)
  assert.equal(googlePictureOf({ id: ME, identities: [], app_metadata: { google_picture: G2 } }), G2)
  // the person can write user_metadata themselves (supabase.auth.updateUser): never read
  assert.equal(googlePictureOf({ id: ME, identities: [{ provider: 'email', identity_data: {} }], user_metadata: { avatar_url: G1, picture: G1 } }), null)
  // not on an avatar host: none (the next one is tried)
  assert.equal(googlePictureOf(googleUser({ picture: 'https://tracker.example.com/p.gif', avatar_url: G2 })), G2)
  assert.equal(googlePictureOf(googleUser({ picture: 'http://lh3.googleusercontent.com/a/x' })), null)
  // an e-mail sign-in, no Google account; no user at all
  assert.equal(googlePictureOf({ id: ME, identities: [{ provider: 'email', identity_data: { picture: G1 } }] }), null)
  for (const u of [null, undefined, {}]) assert.equal(googlePictureOf(u), null)
})

test('보여 주는 순서: 고른 사진 → 구글 사진 → 이름 첫 글자(null)', () => {
  const o = { supabaseUrl: SB }
  assert.equal(resolvePicture(PRESETS[2], G1, o), PRESETS[2], 'a preset wins')
  assert.equal(resolvePicture(mine('a.webp'), G1, o), mine('a.webp'), 'an upload wins')
  assert.equal(resolvePicture(NO_PICTURE, G1, o), G1, 'nothing chosen: Google')
  assert.equal(resolvePicture(null, G1, o), G1)
  assert.equal(resolvePicture('https://tracker.example.com/p.gif', G1, o), G1, 'something unshowable: Google')
  assert.equal(resolvePicture(G2, G1, o), G2, 'a Google address stored (by the sign-in or Process GPT) shows as it is')
  assert.equal(resolvePicture(NO_PICTURE, null, o), null, 'no Google picture: the initial')
  // other people's stored Google pictures show (the team list, the messenger)
  assert.equal(shownPicture(G1, o), G1)
})

test('채우기: 비어 있을 때만 구글 사진을 쓰고, 구글 주소가 든 동안은 계정의 지금 사진을 따름 — 고른 것은 건드리지 않음', () => {
  for (const empty of [null, undefined, '', '  ', NO_PICTURE]) assert.equal(seedValue(empty, G1), G1, String(empty))
  assert.equal(seedValue(G1, G1), null, 'already there')
  assert.equal(seedValue(G2, G1), G1, 'the Google account changed its picture')
  for (const chosen of [PRESETS[0], mine('a.webp'), '/images/chat-icon.png', 'https://tracker.example.com/p.gif']) assert.equal(seedValue(chosen, G1), null, chosen)
  for (const v of [null, NO_PICTURE, PRESETS[0]]) assert.equal(seedValue(v, null), null, 'no Google picture: nothing to write')
  // clearing a choice writes the default back: Google's, else the column default (null)
  assert.equal(defaultValue(G1), G1)
  assert.equal(defaultValue(null), null)
  // a Google address is never a choice the page may save
  refused(G1)
})
