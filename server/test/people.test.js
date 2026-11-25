// 사람은 어디서나 같은 이름 · 같은 얼굴(2026-11-25 운영, 두 동료와의 방): 내 에이전트의 결과 메시지 옆에 내 사진 대신 주소 첫 글자 동그라미가,
// 방 머리에는 내 주소 앞부분이 떴다 — Lite 의 다른 곳은 같은 사람을 이름으로 부르는데(여기 이름 · 주소는 지어낸 것). 메신저는 Process GPT 의
// users.username(여기서는 주소의 앞부분)을, 로그인한 사람의 이름은 Lite 의 프로필을 읽었다. 이제 lib/people.js 하나가 정한다:
// Lite 의 프로필 이름 → Process GPT 의 username(주소 앞부분뿐이면 이름이 아님) → 인증 기록의 이름(name · full_name) → 주소 앞부분.
// 사진은 프로필 사진의 규칙(users.profile → 구글 사진). 데이터베이스 없이: 질의는 가짜 함수로 (실제 화면은 e2e F-PP-*).
import test from 'node:test'
import assert from 'node:assert/strict'
import { displayName, personFrom, makeResolver, localPart } from '../lib/people.js'
import { parseAvatarHosts } from '../lib/profilePicture.js'

const MAIL = 'sjhan@example.test'

test('이름: Lite 프로필 이름이 먼저 — Process GPT 의 username 이 주소 앞부분이어도', () => {
  assert.equal(displayName({ profileName: '한서준', username: 'sjhan', email: MAIL }), '한서준')
  assert.equal(displayName({ profileName: '  한서준 ', username: '서준', email: MAIL }), '한서준')
})

test('이름: username 이 주소 앞부분이면 이름이 아니다(대소문자 무관) — 인증 기록의 이름으로, 없으면 주소 앞부분', () => {
  assert.equal(displayName({ username: 'sjhan', email: MAIL, metaName: '한서준' }), '한서준')
  assert.equal(displayName({ username: 'SJHan', email: MAIL, metaFullName: '한서준' }), '한서준')
  assert.equal(displayName({ username: 'sjhan', email: MAIL }), 'sjhan')
  // an address is not a name either
  assert.equal(displayName({ username: MAIL, email: MAIL, metaName: '한서준' }), '한서준')
})

test('이름: 프로필이 없으면(Lite 를 연 적 없는 사람) Process GPT 의 username', () => {
  assert.equal(displayName({ profileName: null, username: '윤가람', email: 'gryoon@example.test', metaName: 'gryoon' }), '윤가람')
  assert.equal(displayName({ username: '윤가람', email: 'gryoon@example.test' }), '윤가람')
})

test('이름: 메일 코드로 들어와 이름을 아직 적지 않은 사람(프로필 이름 = 주소 앞부분)은 Process GPT 의 username 이 이긴다', () => {
  assert.equal(displayName({ profileName: 'mjoh', username: '오민재', email: 'mjoh@example.test' }), '오민재')
  assert.equal(displayName({ profileName: 'mjoh', username: 'mjoh', email: 'mjoh@example.test', metaName: 'mjoh', metaFullName: '오민재' }), '오민재')
})

test('이름: 아무것도 없으면 주소 앞부분, 주소도 없으면 있는 값', () => {
  assert.equal(displayName({ email: MAIL }), 'sjhan')
  assert.equal(displayName({ username: '', profileName: ' ', email: MAIL }), 'sjhan')
  assert.equal(displayName({ username: 'sjhan' }), 'sjhan')
  assert.equal(displayName({}), '')
  assert.equal(localPart(MAIL), 'sjhan')
})

const OPTS = { supabaseUrl: 'https://db.example.test', avatarHosts: parseAvatarHosts('*.googleusercontent.com') }
const G = 'https://lh3.googleusercontent.com/a/abc=s96-c'
const row = (o = {}) => ({ id: '11111111-1111-4111-8111-111111111111', email: MAIL, username: 'sjhan', profile: '/images/defaultUser.png', profile_name: null, ...o })

test('사람: 사진은 고른 것 → 구글 사진(구글 identity · Lite 의 구글 로그인) → 없음, 다른 사이트는 없음', () => {
  assert.deepEqual(personFrom(row({ profile_name: '한서준', profile: '/assets/images/profile/5.jpg' }), OPTS),
    { id: row().id, email: MAIL, name: '한서준', picture: '/assets/images/profile/5.jpg' })
  assert.equal(personFrom(row({ google: { picture: G } }), OPTS).picture, G)
  assert.equal(personFrom(row({ app_google: G }), OPTS).picture, G)
  // a chosen picture wins over the Google one
  assert.equal(personFrom(row({ profile: '/assets/images/profile/user-3.jpg', google: { picture: G } }), OPTS).picture, '/assets/images/profile/user-3.jpg')
  assert.equal(personFrom(row({ profile: 'https://tracker.example.com/p.gif' }), OPTS).picture, null)
  assert.equal(personFrom(row({ google: { picture: 'https://evil.example.com/a.png' } }), OPTS).picture, null)
  assert.equal(personFrom(row(), OPTS).picture, null)
})

const ID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
function fake(rowsById, { deny = false } = {}) {
  const calls = []
  const query = async (sql, params) => {
    calls.push({ sql, params })
    if (deny && /auth\.users/.test(sql)) throw new Error('permission denied for schema auth')
    const ids = params[1] || Object.keys(rowsById)
    return ids.filter((id) => rowsById[id] && (!rowsById[id].tenant || rowsById[id].tenant === params[0]))
      .map((id) => ({ id, ...rowsById[id], ...(/auth\.users/.test(sql) ? {} : { meta_name: undefined, meta_full_name: undefined, google: undefined, app_google: undefined }) }))
  }
  return { query, calls }
}

test('조회: 여러 사람을 한 번에 — 프로필 없는 사람 · username 이 주소 앞부분인 사람 · 없는 사람', async () => {
  const db = fake({
    [ID(1)]: { email: 'sjhan@example.test', username: 'sjhan', profile_name: '한서준', profile: '/assets/images/profile/5.jpg' },
    [ID(2)]: { email: 'gryoon@example.test', username: '윤가람', profile_name: null },
    [ID(3)]: { email: 'mjoh@example.test', username: 'mjoh', profile_name: null, meta_full_name: '오민재', google: { picture: G } },
  })
  const R = makeResolver({ query: db.query, tenant: () => 't1', opts: () => OPTS })
  const got = await R.people([ID(1), ID(2), ID(3), ID(4), 'not-an-id', ID(1)])
  assert.deepEqual([...got.keys()].sort(), [ID(1), ID(2), ID(3)])
  assert.equal(got.get(ID(1)).name, '한서준')
  assert.equal(got.get(ID(1)).picture, '/assets/images/profile/5.jpg')
  assert.equal(got.get(ID(2)).name, '윤가람')
  assert.equal(got.get(ID(2)).picture, null)
  assert.equal(got.get(ID(3)).name, '오민재')
  assert.equal(got.get(ID(3)).picture, G)
  assert.equal(db.calls.length, 1)
  assert.deepEqual(db.calls[0].params, ['t1', [ID(1), ID(2), ID(3), ID(4)]])
})

test('조회: 잠깐 기억한다(없는 사람도) — 시간이 지나거나 forget 하면 다시 읽는다, 회사마다 따로', async () => {
  let t = 0
  const db = fake({ [ID(1)]: { email: MAIL, username: 'sjhan', profile_name: '한서준' } })
  let tenant = 't1'
  const R = makeResolver({ query: db.query, tenant: () => tenant, opts: () => OPTS, ttl: 1000, now: () => t })
  await R.people([ID(1), ID(4)])
  await R.people([ID(1), ID(4)])
  assert.equal(db.calls.length, 1)
  t = 1500
  await R.people([ID(1)])
  assert.equal(db.calls.length, 2)
  R.forget(ID(1))
  await R.people([ID(1)])
  assert.equal(db.calls.length, 3)
  tenant = 't2'
  await R.people([ID(1)])
  assert.equal(db.calls.length, 4)
  assert.equal(db.calls[3].params[0], 't2')
})

test('조회: 인증 스키마를 읽을 수 없는 데이터베이스에서도 이름 · 사진은 나온다(그것 없이)', async () => {
  const db = fake({ [ID(1)]: { email: MAIL, username: 'sjhan', profile_name: '한서준' }, [ID(2)]: { email: 'a@b.c', username: 'a', profile_name: null } }, { deny: true })
  const R = makeResolver({ query: db.query, tenant: () => 't1', opts: () => OPTS })
  const got = await R.people([ID(1), ID(2)])
  assert.equal(got.get(ID(1)).name, '한서준')
  assert.equal(got.get(ID(2)).name, 'a')
  // asked the auth schema once, then never again
  await R.people([ID(3)])
  assert.equal(db.calls.filter((c) => /auth\.users/.test(c.sql)).length, 1)
  assert.equal(db.calls.length, 3)
})

test('조회: 회사의 모든 사람(에이전트 빼고)은 늘 새로 읽고, 한 사람씩의 기억도 채운다', async () => {
  const db = fake({ [ID(1)]: { email: MAIL, username: 'sjhan', profile_name: '한서준' }, [ID(2)]: { email: 'gryoon@example.test', username: '윤가람' } })
  const R = makeResolver({ query: db.query, tenant: () => 't1', opts: () => OPTS })
  const all = await R.everyone()
  assert.deepEqual(all.map((p) => p.name).sort(), ['윤가람', '한서준'])
  assert.match(db.calls[0].sql, /not coalesce\(u\.is_agent, false\)/)
  await R.everyone()
  assert.equal(db.calls.length, 2)
  await R.people([ID(1), ID(2)])
  assert.equal(db.calls.length, 2)
})
