// 오늘의 배경 사진(lib/background) — 데이터베이스와 인터넷 없이. 날짜 → 24절기 · 계절 · 시간대 · 날씨, 그날의 주제 차례, 사진 사이트의
// 답 읽기(기록해 둔 답 — 사람 이름은 지어낸 것으로 바꿨다), 라이선스와 출처, 선택의 규칙(오늘만 · 계속), 후보 모으기(가짜 getJson).
// 회사 스위치 · 저장 · 회사와 날짜마다의 캐시는 background.integration.test.js(실제 DB · 로컬 가짜 사이트).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { solarTerm, seasonOf, partOfDay, weatherGroup, dayOf, kstDate, sunLongitude } from '../lib/background/calendar.js'
import { planDay, seedOf } from '../lib/background/themes.js'
import { licenseOk, commonsCredit, commonsAuthor, restricted, plain } from '../lib/background/credit.js'
import {
  parseCommons, parseUnsplash, parsePexels, commonsThumbAt, commonsSearch, commonsSearchUrl, commonsPotdUrl, imageUrlOk, getJson, apiBase, unsplashDownloadOk, ProviderError,
} from '../lib/background/providers.js'
import { activePhoto, cleanPhoto, prefOf, PrefError } from '../lib/background/prefs.js'
import { candidatesFor, _reset } from '../lib/background/service.js'
import { readSkillDir, bundledDir } from '../lib/skillPack.js'
import { personDate } from '../routes/background.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/background', n), 'utf8'))
const RULES = readSkillDir(bundledDir('daily-background')).rules

// ---------- the day ----------
test('24절기: 2026-11-22 소설(그날 시작) · 11-24 도 소설 · 다음은 12-07 대설, 한 해의 마디 날짜(한국 표준시)', () => {
  const t = solarTerm('2026-11-24')
  assert.equal(t.ko, '소설')
  assert.equal(t.start, '2026-11-22')
  assert.equal(t.today, false)
  assert.deepEqual([t.next.ko, t.next.start], ['대설', '2026-12-07'])
  assert.equal(solarTerm('2026-11-22').today, true)
  assert.equal(solarTerm('2026-11-21').ko, '입동')
  // 한국천문연구원이 낸 2026 · 2027 절기 날짜
  const known = { '2026-02-04': '입춘', '2026-03-20': '춘분', '2026-05-05': '입하', '2026-06-21': '하지', '2026-08-07': '입추', '2026-09-23': '추분',
    '2026-10-23': '상강', '2026-11-07': '입동', '2026-12-22': '동지', '2027-01-05': '소한', '2027-01-20': '대한', '2027-02-04': '입춘' }
  for (const [d, name] of Object.entries(known)) {
    const s = solarTerm(d)
    assert.equal(s.ko, name, d)
    assert.equal(s.today, true, `${d} 가 ${name} 의 첫날`)
  }
  // 황경: 춘분 무렵 0°, 하지 무렵 90°
  assert.ok(Math.abs(((sunLongitude(Date.UTC(2026, 2, 20, 14, 46)) + 180) % 360) - 180) < 0.1)
  assert.ok(Math.abs(sunLongitude(Date.UTC(2026, 5, 21, 8, 24)) - 90) < 0.1)
  assert.throws(() => solarTerm('2026-02-30'))
})

test('계절의 때: 입동 · 소설 = 초겨울, 소한 · 대한 = 한겨울, 입춘 = 이른 봄 · 시간대(시각 · 해의 고도) · 날씨 코드의 무리', () => {
  assert.equal(seasonOf('soseol').ko, '초겨울')
  assert.equal(seasonOf('daehan').ko, '한겨울')
  assert.equal(seasonOf('ipchun').ko, '이른 봄')
  assert.equal(seasonOf('chubun').ko, '가을')
  assert.equal(partOfDay(6), 'dawn')
  assert.equal(partOfDay(8), 'morning')
  assert.equal(partOfDay(14), 'day')
  assert.equal(partOfDay(18), 'evening')
  assert.equal(partOfDay(23), 'night')
  assert.equal(partOfDay(2), 'night')
  // the sun's altitude wins over the clock (a winter 17:30 is already night, a summer 19:30 still dusk)
  assert.equal(partOfDay(17, -12), 'night')
  assert.equal(partOfDay(19, 3), 'evening')
  assert.equal(partOfDay(7, 2), 'dawn')
  assert.equal(partOfDay(10, 30), 'morning')
  assert.deepEqual([0, 1, 2, 3, 45, 48, 51, 61, 80, 71, 85, 95, 99].map(weatherGroup),
    ['clear', 'clear', 'partly', 'cloudy', 'fog', 'fog', 'rain', 'rain', 'rain', 'snow', 'snow', 'storm', 'storm'])
  assert.equal(weatherGroup(null), null)
  assert.equal(weatherGroup('x'), null)
  assert.match(kstDate(Date.UTC(2026, 10, 23, 16, 0)), /^2026-11-24$/) // 01:00 KST
})

test('그날의 주제: 소설 · 초겨울 아침 · 안개 → 절기 둘 · 「초겨울 아침 안개」 · 「안개 낀 날」 · 계절 · 오늘의 사진 · 멋진 풍경, 날마다 같은 차례', () => {
  const day = dayOf({ date: '2026-11-24', hour: 8, wx: 45 })
  const plan = planDay(day, RULES)
  assert.deepEqual(plan.map((t) => t.kind), ['term', 'part', 'weather', 'term', 'season', 'potd', 'landscape'])
  assert.ok(plan.find((t) => t.kind === 'part').label === '초겨울 아침 안개')
  assert.ok(plan.find((t) => t.kind === 'weather').label === '안개 낀 날')
  assert.ok(plan.filter((t) => t.kind === 'term').every((t) => t.label.startsWith('소설 · ')))
  assert.equal(plan.find((t) => t.kind === 'potd').label, '오늘의 사진')
  assert.deepEqual(planDay(day, RULES), plan, '같은 날은 같은 차례')
  // the part of day's search: the season's word over the Featured pictures of fog
  const part = plan.find((t) => t.kind === 'part')
  assert.equal(part.q, 'winter')
  assert.deepEqual(part.cats, ['fog'])
  // a mood: its two themes first, then the themes tagged with it
  const warm = planDay(day, RULES, { mood: 'warm' })
  assert.deepEqual(warm.slice(0, 2).map((t) => t.kind), ['mood', 'mood'])
  assert.deepEqual(warm.slice(0, 2).map((t) => t.label), ['노을빛', '햇살 드는 숲'])
  assert.deepEqual(warm.slice(-2).map((t) => t.kind), ['potd', 'landscape'])
  // English labels
  const en = planDay(day, RULES, { en: true })
  assert.equal(en.find((t) => t.kind === 'part').label, 'Early winter morning mist')
  assert.equal(en.find((t) => t.kind === 'potd').label, 'Picture of the day')
  // clear night: no weather theme for an unknown code, the night sky for the part
  const night = planDay(dayOf({ date: '2026-12-22', hour: 22, wx: null }), RULES)
  assert.ok(!night.some((t) => t.kind === 'weather'))
  assert.equal(night.find((t) => t.kind === 'part').label, '겨울 밤하늘')
  assert.equal(seedOf('2026-11-24'), seedOf('2026-11-24'))
  assert.notEqual(seedOf('2026-11-24'), seedOf('2026-11-25'))
})

// ---------- the sites' answers ----------
test('Commons 검색 답 읽기: 세로 사진 · 작은 원본은 빼고, 330px 썸네일과 표준 너비(960 · 1280 · 1920), 작가 · 라이선스 · 출처', () => {
  const photos = parseCommons(fixture('commons-search-snow.json'))
  const titles = photos.map((p) => p.title)
  assert.ok(!titles.some((t) => /Kolomenskoe/.test(t)), '세로(2708×3840)는 빠진다')
  assert.equal(photos.length, 11)
  const first = photos[0]
  assert.equal(first.id, 'commons:' + fixture('commons-search-snow.json').query.pages.find((p) => p.index === 1).pageid)
  assert.equal(first.provider, 'commons')
  assert.equal(first.license, 'CC BY-SA 4.0')
  assert.equal(first.author, 'Haneul Park')
  assert.equal(first.authorUrl, 'https://commons.wikimedia.org/wiki/User:Haneul_Park')
  assert.match(first.thumb, /^https:\/\/thumb\.wikimedia\.org\/wikipedia\/commons\/thumb\/.+\/330px-[^?]+$/)
  assert.deepEqual(Object.keys(first.src).map(Number), [960, 1280, 1920])
  assert.ok(Object.values(first.src).every((u) => !u.includes('utm_')), 'Wikimedia 의 utm 은 떼고')
  assert.match(first.sourceUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/)
  assert.equal(first.sourceName, 'Wikimedia Commons')
  // a photographer's creator template (Wikidata link, no user page): the short name and its link
  const creator = photos.find((p) => p.author === 'Hyun Oh')
  assert.equal(creator.authorUrl, 'https://www.wikidata.org/wiki/Q4115189')
  // public domain is used too
  assert.ok(photos.some((p) => p.license === 'Public domain'))
})

test('오늘의 사진(POTD): 파노라마(30349×8999)는 POTD 비율에서만, 긴 안내 표가 든 작가 칸에서 이름만 · 3840 은 파노라마에만', () => {
  const potd = fixture('commons-potd-2026-11-24.json')
  assert.equal(parseCommons(potd).length, 0, '보통 비율(1.3~2.6)로는 너무 넓다')
  const [p] = parseCommons(potd, { ratio: [1.25, 3.6] })
  assert.equal(p.author, 'Eunji Song')
  assert.equal(p.authorUrl, 'https://commons.wikimedia.org/wiki/User:Bora_Han')
  assert.ok(!JSON.stringify(p).includes('mailto'), '작가 칸의 메일 주소는 나오지 않는다')
  assert.deepEqual(Object.keys(p.src).map(Number), [960, 1280, 1920, 3840])
  assert.equal(p.title, 'South Panorama Taza Morocco Nov25 A7CR 09655-62 PanoC')
  const [bird] = parseCommons(fixture('commons-potd-2026-11-22.json'), { ratio: [1.25, 3.6] })
  assert.equal(bird.author, 'Siwoo Baek')
  assert.deepEqual(Object.keys(bird.src).map(Number), [960, 1280, 1920])
})

test('썸네일 주소: 마지막 조각의 <너비>px- 만 바꾸고(TIFF 의 lossy-page1- 도), 너비가 없는 원본 주소는 null · 검색 문자열', () => {
  const u = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/46/A_B.jpg/1920px-A_B.jpg?utm_source=x'
  assert.equal(commonsThumbAt(u, 960), 'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/46/A_B.jpg/960px-A_B.jpg')
  assert.equal(commonsThumbAt('https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e6/X.tif/lossy-page1-1920px-X.tif.jpg', 330),
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e6/X.tif/lossy-page1-330px-X.tif.jpg')
  assert.equal(commonsThumbAt('https://upload.wikimedia.org/wikipedia/commons/4/46/A_B.jpg', 960), null)
  assert.equal(commonsSearch({ q: 'winter', cats: ['fog', 'the Milky Way'] }), 'winter incategory:"Featured_pictures_of_fog|Featured_pictures_of_the_Milky_Way" filetype:bitmap')
  assert.equal(commonsSearch({ q: 'a"b\\c', cats: [] }), 'a b c filetype:bitmap')
  const url = new URL(commonsSearchUrl({ q: '', cats: ['snow'], offset: 60 }))
  assert.equal(url.host, 'commons.wikimedia.org')
  assert.equal(url.searchParams.get('gsroffset'), '60')
  assert.equal(url.searchParams.get('iiurlwidth'), '1920')
  assert.equal(new URL(commonsPotdUrl('2026-11-24')).searchParams.get('titles'), 'Template:Potd/2026-11-24')
})

test('라이선스: 다시 써도 되는 것만(CC0 · PD · CC BY · CC BY-SA · FAL · KOGL 제1유형), NC · ND · GFDL 만 · 모르는 것 · 제한 표시는 쓰지 않는다', () => {
  for (const ok of ['CC0', 'Public domain', 'PD-USGov', 'CC BY 2.0', 'CC BY-SA 4.0', 'CC BY-SA 3.0 at', 'CC BY-SA 2.5', 'FAL', 'KOGL Type 1', 'Attribution', 'Copyrighted free use']) assert.equal(licenseOk(ok), true, ok)
  for (const no of ['CC BY-NC 4.0', 'CC BY-NC-SA 2.0', 'CC BY-ND 2.0', 'GFDL', 'GFDL 1.2', '', null, 'All rights reserved', 'Fair use', 'KOGL Type 2']) assert.equal(licenseOk(no), false, String(no))
  assert.equal(restricted({ Restrictions: { value: 'personality' } }), true)
  assert.equal(restricted({ Restrictions: { value: '' } }), false)
  assert.equal(commonsCredit({ title: 'File:X.jpg', extmetadata: { LicenseShortName: { value: 'CC BY-NC 4.0' } } }), null)
  assert.equal(commonsCredit({ title: 'File:X.jpg', extmetadata: { LicenseShortName: { value: 'CC BY 4.0' }, Restrictions: { value: 'trademarked' } } }), null)
  const c = commonsCredit({ title: 'File:Morning_fog in Seoul.jpg', extmetadata: { LicenseShortName: { value: 'CC BY 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0' } }, user: 'Nari Jung' })
  assert.deepEqual(c, { title: 'Morning fog in Seoul', author: 'Nari Jung', authorUrl: 'https://commons.wikimedia.org/wiki/User:Nari_Jung', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0' })
  // the author: a written-out address is not part of the name; a long text without a user link falls back to the uploader
  assert.equal(commonsAuthor({ Artist: { value: 'Yuna Seo ( https://example.org/yuna )' } }).author, 'Yuna Seo')
  assert.equal(commonsAuthor({ Artist: { value: 'x'.repeat(200) } }, 'Jiho Kang').author, 'Jiho Kang')
  assert.equal(plain('<b>A&amp;B</b>\n<script>x</script> c'), 'A&B c')
})

test('Unsplash · Pexels 답 읽기: 그 사이트 CDN 의 그림만, 너비 파라미터, 「사진 · 작가 on Unsplash」 링크(utm), 내려받기 알림 주소', () => {
  const u = parseUnsplash(fixture('unsplash-search.json'))
  assert.equal(u.length, 1, '세로 사진과 다른 호스트의 그림은 빠진다')
  const [a] = u
  assert.equal(a.id, 'unsplash:Fk2mHq9xT0a')
  assert.equal(a.author, 'Nari Jung')
  assert.equal(a.authorUrl, 'https://unsplash.com/@nari_jung?utm_source=process_gpt_lite&utm_medium=referral')
  assert.match(a.sourceUrl, /^https:\/\/unsplash\.com\/photos\/frosted-reeds-Fk2mHq9xT0a\?utm_source=process_gpt_lite&utm_medium=referral$/)
  assert.equal(a.license, 'Unsplash License')
  assert.equal(a.sourceName, 'Unsplash')
  assert.equal(a.color, '#c0c8d8')
  assert.equal(new URL(a.src[1920]).searchParams.get('w'), '1920')
  assert.equal(new URL(a.src[1920]).searchParams.get('ixid'), 'M3w1MDAwMDB8MHwxfHNlYXJjaHwxfHxmcm9zdHxlbnwwfDB8fHwxNzY0MDAwMDAwfDA', 'ixid 는 그대로(핫링크)')
  assert.equal(new URL(a.thumb).searchParams.get('w'), '330')
  assert.ok(unsplashDownloadOk(a.downloadLocation))
  assert.equal(unsplashDownloadOk('https://api.unsplash.com/users/x'), false)
  assert.equal(unsplashDownloadOk('https://evil.example.com/photos/x/download'), false)
  const p = parsePexels(fixture('pexels-search.json'))
  assert.equal(p.length, 1)
  assert.equal(p[0].id, 'pexels:1234567')
  assert.equal(p[0].author, 'Bora Han')
  assert.equal(p[0].authorUrl, 'https://www.pexels.com/@bora-han')
  assert.equal(p[0].license, 'Pexels License')
  assert.equal(p[0].sourceUrl, 'https://www.pexels.com/photo/misty-forest-morning-1234567/')
  assert.equal(p[0].src[960], 'https://images.pexels.com/photos/1234567/pexels-photo-1234567.jpeg?auto=compress&cs=tinysrgb&w=960')
})

test('그림 주소는 그 사이트의 CDN 만(시험용 주소는 게이트웨이 뒤에서 무시) · 서버는 정해진 API 호스트에만 묻는다', async () => {
  assert.equal(imageUrlOk('commons', 'https://upload.wikimedia.org/a.jpg'), true)
  assert.equal(imageUrlOk('commons', 'https://thumb.wikimedia.org/a.jpg'), true)
  assert.equal(imageUrlOk('commons', 'http://upload.wikimedia.org/a.jpg'), false, 'CDN 은 https 만')
  assert.equal(imageUrlOk('commons', 'https://images.unsplash.com/a.jpg'), false, '다른 사이트의 CDN')
  assert.equal(imageUrlOk('unsplash', 'https://user:pw@images.unsplash.com/a.jpg'), false)
  const test = { tenantFromHeader: false, background: { commonsApi: 'http://127.0.0.1:59971/w/api.php' } }
  assert.equal(apiBase('commons', test), 'http://127.0.0.1:59971/w/api.php')
  assert.equal(imageUrlOk('commons', 'http://127.0.0.1:59971/thumb/x/960px-x.jpg', test), true)
  const gateway = { ...test, tenantFromHeader: true }
  assert.equal(apiBase('commons', gateway), 'https://commons.wikimedia.org/w/api.php')
  assert.equal(imageUrlOk('commons', 'http://127.0.0.1:59971/thumb/x/960px-x.jpg', gateway), false)
  let called = 0
  await assert.rejects(getJson('https://evil.example.com/w/api.php', { fetchImpl: () => { called++ } }), ProviderError)
  await assert.rejects(getJson('http://commons.wikimedia.org/w/api.php', { fetchImpl: () => { called++ } }), ProviderError)
  assert.equal(called, 0, '다른 호스트 · https 아닌 고정 호스트에는 요청이 없다')
})

// ---------- the person's choice ----------
test('선택의 규칙: 「오늘만」은 고른 날(그 사람의 날짜)에만, 다음 날은 하늘 · 「계속」은 바꿀 때까지 · 없으면 하늘', () => {
  const photo = parseCommons(fixture('commons-search-snow.json'))[0]
  const today = prefOf({ photo: { ...photo, label: '소설 · 첫눈 무렵' }, keep: 'today', day: '2026-11-24' })
  assert.equal(activePhoto(today, '2026-11-24').id, photo.id)
  assert.equal(activePhoto(today, '2026-11-25'), null, '자정이 지나면 하늘')
  assert.equal(activePhoto(today, '2026-11-23'), null)
  const always = prefOf({ photo, keep: 'always', day: '2026-11-24' })
  assert.equal(activePhoto(always, '2027-03-01').id, photo.id)
  assert.equal(activePhoto(null, '2026-11-24'), null)
  assert.equal(activePhoto({ photo: null, keep: 'always' }, '2026-11-24'), null)
  assert.equal(today.photo.label, '소설 · 첫눈 무렵')
  assert.throws(() => prefOf({ photo, keep: 'forever', day: '2026-11-24' }), PrefError)
  assert.throws(() => prefOf({ photo, keep: 'today', day: 'tomorrow' }), PrefError)
})

test('화면이 보낸 사진은 다시 본다: 다른 호스트 · 사이트와 다른 id · NC 라이선스 · 이상한 너비는 거절, 글은 줄여서', () => {
  const photo = parseCommons(fixture('commons-search-snow.json'))[0]
  const clean = cleanPhoto({ ...photo, title: `<b>${'긴 제목 '.repeat(40)}</b>`, extra: 'dropped', authorUrl: 'javascript:alert(1)' })
  assert.ok(clean.title.length <= 120 && !clean.title.includes('<'))
  assert.equal(clean.extra, undefined)
  assert.equal(clean.authorUrl, null)
  assert.throws(() => cleanPhoto({ ...photo, src: { 1920: 'https://evil.example.com/x.jpg' } }), PrefError)
  assert.throws(() => cleanPhoto({ ...photo, thumb: 'https://evil.example.com/x.jpg' }), PrefError)
  assert.throws(() => cleanPhoto({ ...photo, id: 'unsplash:abc' }), PrefError)
  assert.throws(() => cleanPhoto({ ...photo, license: 'CC BY-NC 4.0' }), PrefError)
  assert.throws(() => cleanPhoto({ ...photo, src: { 12: photo.src[960] } }), PrefError)
  assert.throws(() => cleanPhoto({ ...photo, provider: 'flickr' }), PrefError)
  assert.throws(() => cleanPhoto(null), PrefError)
  const u = parseUnsplash(fixture('unsplash-search.json'))[0]
  assert.equal(cleanPhoto(u).downloadLocation, u.downloadLocation)
  assert.throws(() => cleanPhoto({ ...u, license: 'CC0' }), PrefError)
  assert.equal(cleanPhoto({ ...u, downloadLocation: 'https://evil.example.com/photos/x/download' }).downloadLocation, undefined)
})

test('그 사람의 날짜: 지금 지구 어디의 날짜(UTC−12~+14)면 그대로, 아니면 한국 날짜', () => {
  const now = Date.UTC(2026, 10, 24, 3, 0) // 12:00 KST
  assert.equal(personDate('2026-11-24', now), '2026-11-24')
  assert.equal(personDate('2026-11-23', now), '2026-11-23')
  assert.equal(personDate('2026-11-25', now), '2026-11-25')
  assert.equal(personDate('2026-11-27', now), '2026-11-24')
  assert.equal(personDate('2026-13-01', now), '2026-11-24')
  assert.equal(personDate(undefined, now), '2026-11-24')
})

// ---------- the day's candidates (fake sites, no network) ----------
function fakeSites({ fail = () => false } = {}) {
  const calls = []
  const snow = fixture('commons-search-snow.json')
  const potd = fixture('commons-potd-2026-11-24.json')
  const getJson = async (url) => {
    calls.push(url)
    const u = new URL(url)
    if (fail(u)) throw new ProviderError('status 503', 503)
    if (u.searchParams.get('generator') === 'images') return u.searchParams.get('titles') === 'Template:Potd/2026-11-24' ? potd : { batchcomplete: true }
    // every search answers the same ten photos, the page shifted by the search string so themes differ
    const k = seedOf(u.searchParams.get('gsrsearch') + u.searchParams.get('gsroffset')) % 5
    const pages = snow.query.pages.map((p, i) => ({ ...p, index: ((i + k) % snow.query.pages.length) + 1 }))
    return { query: { pages } }
  }
  return { calls, getJson }
}

test('그날의 후보: 6~10장, 주제 이름이 붙고, 같은 날 같은 회사는 같은 사진(사이트에 다시 묻지 않음) · 사진이 겹치지 않음', async () => {
  _reset()
  const f = fakeSites()
  const deps = { getJson: f.getJson, keys: () => ({}), rules: RULES }
  const a = await candidatesFor({ tenant: 't-unit', date: '2026-11-24', hour: 8, wx: 45 }, deps)
  assert.ok(a.photos.length >= 6 && a.photos.length <= 10, `${a.photos.length}장`)
  assert.equal(new Set(a.photos.map((p) => p.id)).size, a.photos.length, '겹치지 않음')
  assert.ok(a.photos.some((p) => p.label === '초겨울 아침 안개'))
  assert.ok(a.photos.some((p) => p.label === '오늘의 사진' && p.theme === 'potd'))
  assert.ok(a.photos.every((p) => p.label && p.license && p.author && p.thumb && p.sourceUrl))
  const n = f.calls.length
  const b = await candidatesFor({ tenant: 't-unit', date: '2026-11-24', hour: 8, wx: 45 }, deps)
  assert.deepEqual(b.photos.map((p) => p.id), a.photos.map((p) => p.id))
  assert.equal(f.calls.length, n, '두 번째는 메모리에서')
  // a mood puts its themes first
  const warm = await candidatesFor({ tenant: 't-unit', date: '2026-11-24', hour: 8, wx: 45, mood: 'warm' }, deps)
  assert.deepEqual(warm.photos.slice(0, 2).map((p) => p.theme), ['mood', 'mood'])
})

test('사이트가 실패하면: 오늘의 사진이 없으면 지난 며칠의 것(「이번 주의 사진」), 검색이 다 실패해도 오류가 아니라 빈 목록', async () => {
  _reset()
  const f = fakeSites()
  const deps = { getJson: f.getJson, keys: () => ({}), rules: RULES }
  const r = await candidatesFor({ tenant: 't-unit', date: '2026-11-25', hour: 14, wx: 0 }, deps)
  const potd = r.photos.find((p) => p.theme === 'potd')
  assert.equal(potd.label, '이번 주의 사진', '11-25 의 POTD 가 없어 11-24 의 것')
  _reset()
  const down = fakeSites({ fail: () => true })
  const none = await candidatesFor({ tenant: 't-unit', date: '2026-11-24', hour: 8, wx: 45 }, { getJson: down.getJson, keys: () => ({}), rules: RULES })
  assert.deepEqual(none.photos, [])
})
