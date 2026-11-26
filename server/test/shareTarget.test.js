// 다른 앱의 「공유」로 Process GPT 에 넣기 (2026-11-26): the pure rules (src/shareTarget.js), the manifest's share_target and the service
// worker's share block (public/sw.js — run here in a sandbox with a stand-in for Cache Storage, the way Chrome hands it the POST).
// Spec: openspec/specs/share-target. The screens: e2e/tests/feature/share-target.spec.js (F-ST-…).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
  LIMITS, IDLE_MS, LAST_KEY, FOLDERS_KEY, PENDING_KEY, DRAFT_PREFIX, ID_RE, idTime, composeText, linkOf, firstLine, typeOf, fileName, skippedNotice, summary,
  askTitle, placeOf, readLast, writeLast, touchLast, isFresh, recentFolders, rememberFolder, forgetPlaces, pickTarget, chooserRows, pathOf,
} from '../../src/shareTarget.js'

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const memStore = () => {
  const m = new Map()
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size } }
}
const brokenStore = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
const HY = { uid: 'u-hayun', t: 'acme.process-gpt.io' }
const SY = { uid: 'u-seoyeon', t: 'acme.process-gpt.io' }

test('U-ST-01 공유한 글 — 제목 · 글 · 주소를 한 번씩, 주소는 자르지 않는다, 묻는 창에는 첫 줄', () => {
  assert.equal(composeText({ title: '', text: '견적 확인 부탁드려요', url: '' }), '견적 확인 부탁드려요')
  // (a browser's 「공유」 of a page: the title and the address; the address is kept whole)
  const long = `https://example.test/a/${'x'.repeat(600)}?q=1&r=%ED%95%9C`
  assert.equal(composeText({ title: '3분기 매출 보고', text: '', url: long }), `3분기 매출 보고\n${long}`)
  // many apps put the address in the text and the title in the text too: not twice
  assert.equal(composeText({ title: '하늘테크 소식', text: '하늘테크 소식 https://news.example.test/1', url: 'https://news.example.test/1' }), '하늘테크 소식 https://news.example.test/1')
  assert.equal(composeText({ title: 'https://a.test', text: '', url: 'https://a.test' }), 'https://a.test')
  assert.equal(composeText({ text: '줄1\r\n줄2\u0007' }), '줄1\n줄2')
  assert.equal(composeText({}), '')
  assert.equal(linkOf({ text: '보세요 https://a.test/x 끝' }), 'https://a.test/x')
  assert.equal(linkOf({ text: '주소 없음' }), '')
  assert.equal(firstLine('\n\n  첫 줄이에요\n\n둘째 줄\n셋째 줄'), '첫 줄이에요\n둘째 줄')
  assert.equal(firstLine('Invoice\nplease pay https://evil.example/x'), 'Invoice\nplease pay https://evil.example/x')
  assert.equal(firstLine('가'.repeat(200)).length, 120)
  assert.ok(firstLine('가'.repeat(200)).endsWith('…'))
  assert.equal(firstLine(''), '')
})

test('U-ST-02 파일 이름 · 종류는 확장자로만(html · svg · xml · 모르는 것은 그냥 바이트) · 무엇이 왔는지 한 줄', () => {
  assert.equal(fileName('견적서.pdf'), '견적서.pdf')
  assert.equal(fileName('../../etc/passwd'), '_.._etc_passwd')
  assert.equal(fileName('', 0), '공유한 파일')
  assert.equal(fileName('  ', 2), '공유한 파일 3')
  assert.equal(typeOf('하늘테크 견적서.PDF'), 'application/pdf')
  assert.equal(typeOf('photo.jpg'), 'image/jpeg')
  assert.equal(typeOf('보고서.hwpx'), 'application/hwp+zip')
  assert.equal(typeOf('회의.m4a'), 'audio/mp4')
  for (const n of ['page.html', 'page.htm', 'logo.svg', 'feed.xml', 'a.xhtml', 'run.js', 'noext', 'a.exe', '', 'x.svgz']) assert.equal(typeOf(n), 'application/octet-stream', n)
  assert.equal(summary({ files: [{ name: '견적서.pdf' }], text: '' }), '견적서.pdf')
  assert.equal(summary({ files: [{ name: 'a.pdf' }, { name: 'b.png' }], text: 'https://a.test' }), 'a.pdf 외 1개 · 링크')
  assert.equal(summary({ files: [], text: '보세요 https://a.test' }), '글 · 링크')
  assert.equal(summary({ files: [], text: '안녕하세요' }), '글')
})

test('U-ST-03 넣지 못한 파일은 이름 · 크기와 까닭을 말한다 · 넣기 전에 묻는 말', () => {
  assert.equal(skippedNotice([]), '')
  assert.equal(skippedNotice([{ name: '현장 영상.mp4', size: 80 * 1048576, why: 'big' }]), '‘현장 영상.mp4’(80MB)는 50MB가 넘어서 넣지 못했어요.')
  assert.equal(skippedNotice([{ name: 'a', size: 1, why: 'big' }, { name: 'b', size: 1, why: 'big' }]), '파일 2개는 50MB가 넘어서 넣지 못했어요.')
  assert.match(skippedNotice([{ name: 'c', size: 1, why: 'many' }]), /한 번에 10개까지/)
  assert.match(skippedNotice([{ name: 'd', size: 1, why: 'total' }]), /200MB/)
  assert.equal(skippedNotice([{ name: '빈.txt', size: 0, why: 'empty' }]), '‘빈.txt’ 파일이 비어 있어서 넣지 못했어요.')
  assert.equal(askTitle({ files: 1, text: false }, '시니어그룹', 'room'), '공유한 파일 1개를 ‘시니어그룹’에 넣을까요?')
  assert.equal(askTitle({ files: 2, text: true }, 'Process GPT 채팅', 'chat'), '공유한 파일 2개와 글을 ‘Process GPT 채팅’에 넣을까요?')
  assert.equal(askTitle({ files: 0, text: true }, '시니어그룹', 'room'), '공유한 글을 ‘시니어그룹’에 넣을까요?')
  assert.equal(askTitle({ files: 1, text: true }, '영업 자료', 'folder'), '공유한 파일 1개를 ‘영업 자료’ 폴더에 넣을까요?')
})

test('U-ST-04 열려 있는 곳 — 메신저의 대화가 페이지보다 먼저, 설정 · 로그인은 그 앞의 곳을 그대로', () => {
  const chat = { path: '/chat', mode: 'chat', params: {} }
  assert.deepEqual(placeOf(chat, {}), { kind: 'chat', id: '' })
  assert.deepEqual(placeOf({ path: '/chat/c/abc', mode: 'chat', params: { cid: 'abc' } }), { kind: 'chat', id: 'abc' })
  assert.deepEqual(placeOf(chat, { open: true, tab: 'threads', active: 'room-1' }), { kind: 'room', id: 'room-1' })
  // the inbox tab, or the messenger closed: the page's own place
  assert.deepEqual(placeOf(chat, { open: true, tab: 'inbox', active: 'room-1' }), { kind: 'chat', id: '' })
  assert.deepEqual(placeOf(chat, { open: false, tab: 'threads', active: 'room-1' }), { kind: 'chat', id: '' })
  assert.deepEqual(placeOf({ path: '/projects/p1', mode: 'project', params: { id: 'p1' } }), { kind: 'project', id: 'p1' })
  assert.deepEqual(placeOf({ path: '/projects/p1/t/t2', mode: 'project', params: { id: 'p1', tid: 't2' } }), { kind: 'project', id: 'p1' })
  assert.equal(placeOf({ path: '/projects', mode: 'project', params: {} }), null)
  assert.deepEqual(placeOf({ path: '/routines/def.1', mode: 'routine', params: { instId: 'def.1' } }), { kind: 'routine', id: 'def.1' })
  assert.deepEqual(placeOf({ path: '/folders/sales', params: { slug: 'sales' } }), { kind: 'folder', id: 'sales' })
  // a folder's variation, the folder list, the process map: no place a file goes into by itself
  assert.equal(placeOf({ path: '/folders/sales/v/9', params: { slug: 'sales', variation: '9' } }), null)
  assert.equal(placeOf({ path: '/process-map', params: {} }), null)
  for (const r of [{ settings: true, mode: 'chat', path: '/settings' }, { public: true, path: '/login' }, { noTeam: true, path: '/welcome/age' }]) assert.equal(placeOf(r, { open: true, tab: 'threads', active: 'x' }), undefined)
})

test('U-ST-05 이 기기에 남기는 것은 종류 · id · 누구의 것 · 언제 — 다른 사람 · 다른 주소의 것은 없는 것, 로그아웃하면 잊는다', () => {
  const s = memStore()
  assert.equal(readLast(s, HY), null)
  writeLast(s, { kind: 'room', id: 'r1', title: '시니어그룹', extra: 1 }, HY, 1000)
  assert.deepEqual(JSON.parse(s.m.get(LAST_KEY)), { kind: 'room', id: 'r1', uid: 'u-hayun', t: 'acme.process-gpt.io', at: 1000 })
  assert.deepEqual(readLast(s, HY), { kind: 'room', id: 'r1', at: 1000 })
  // another person signed in on this phone, the same person at another company's address, nobody signed in: not theirs
  assert.equal(readLast(s, SY), null)
  assert.equal(readLast(s, { ...HY, t: 'other.process-gpt.io' }), null)
  assert.equal(readLast(s, { uid: null, t: HY.t }), null)
  // (an entry from before this rule — no person on it — counts for no one)
  s.setItem(LAST_KEY, '{"kind":"room","id":"r1"}')
  assert.equal(readLast(s, HY), null)
  // gone into the background: its time is now
  writeLast(s, { kind: 'chat', id: '' }, HY, 1000)
  touchLast(s, HY, 5000)
  assert.equal(readLast(s, HY).at, 5000)
  touchLast(s, SY, 9000)
  assert.equal(readLast(s, HY).at, 5000)
  writeLast(s, null, HY)
  assert.equal(readLast(s, HY), null)
  s.setItem(LAST_KEY, 'not json')
  assert.equal(readLast(s, HY), null)
  // a private window: nothing kept, nothing thrown
  assert.doesNotThrow(() => writeLast(brokenStore, { kind: 'chat', id: '' }, HY))
  assert.equal(readLast(brokenStore, HY), null)
  assert.equal(readLast(null, HY), null)
  for (const slug of ['a', 'b', 'a', 'c', 'd', 'e', 'f']) rememberFolder(s, slug, HY)
  assert.deepEqual(recentFolders(s, HY), ['f', 'e', 'd', 'c', 'a'])
  assert.deepEqual(recentFolders(s, SY), [])
  assert.deepEqual(recentFolders(brokenStore, HY), [])
  // signed out: the places, a share still waiting and the messenger's unsent words go; nothing else
  writeLast(s, { kind: 'room', id: 'r1' }, HY)
  s.setItem(PENDING_KEY, '{"id":"x"}')
  s.setItem('pgpt-pro-theme', 'dark')
  const ss = memStore()
  ss.setItem(`${DRAFT_PREFIX}u-hayun:r1`, '보낼 말')
  ss.setItem('other', 'keep')
  forgetPlaces(s, ss)
  assert.deepEqual([...s.m.keys()], ['pgpt-pro-theme'])
  assert.deepEqual([...ss.m.keys()], ['other'])
  assert.ok(!s.m.has(FOLDERS_KEY))
  assert.doesNotThrow(() => forgetPlaces(brokenStore, brokenStore))
})

test('U-ST-06 열려 있던 곳이 지금 받을 수 있으면 그곳(루틴도 열 수 있을 때만), 아니면 고르기(null) · 30분이 지난 곳은 묻지 않고 고르기에서 먼저', () => {
  const files = { files: 1, text: false }, words = { files: 0, text: true }
  assert.deepEqual(pickTarget({ kind: 'room', id: 'r1' }, files, { rooms: ['r1', 'r2'] }), { kind: 'room', id: 'r1' })
  // a room I left (or that is gone): ask
  assert.equal(pickTarget({ kind: 'room', id: 'r9' }, files, { rooms: ['r1'] }), null)
  assert.deepEqual(pickTarget({ kind: 'chat', id: '' }, words, {}), { kind: 'chat', id: '' })
  assert.deepEqual(pickTarget({ kind: 'chat', id: 'c1' }, words, { conversations: ['c1'] }), { kind: 'chat', id: 'c1' })
  // a conversation no longer there: the main chat
  assert.deepEqual(pickTarget({ kind: 'chat', id: 'c9' }, words, { conversations: ['c1'] }), { kind: 'chat', id: '' })
  assert.deepEqual(pickTarget({ kind: 'project', id: 'p1' }, files, { projects: ['p1'] }), { kind: 'project', id: 'p1' })
  assert.equal(pickTarget({ kind: 'project', id: 'p9' }, files, { projects: ['p1'] }), null)
  // a routine: only one this person can open now
  assert.deepEqual(pickTarget({ kind: 'routine', id: 'd.1' }, files, { routines: ['d.1'] }), { kind: 'routine', id: 'd.1' })
  assert.equal(pickTarget({ kind: 'routine', id: 'd.1' }, files, {}), null)
  // a folder: files only, and only where I may write
  assert.deepEqual(pickTarget({ kind: 'folder', id: 'sales' }, files, { folder: { slug: 'sales', role: 'editor' } }), { kind: 'folder', id: 'sales' })
  assert.equal(pickTarget({ kind: 'folder', id: 'sales' }, files, { folder: { slug: 'sales', role: 'viewer' } }), null)
  assert.equal(pickTarget({ kind: 'folder', id: 'sales' }, words, { folder: { slug: 'sales', role: 'owner' } }), null)
  assert.equal(pickTarget({ kind: 'folder', id: 'sales' }, files, { folder: null }), null)
  // nothing open, or nothing came
  assert.equal(pickTarget(null, files, {}), null)
  assert.equal(pickTarget({ kind: 'chat', id: '' }, { files: 0, text: false }, {}), null)
  // open a moment ago vs. left a while ago
  const now = 10 * IDLE_MS
  assert.equal(isFresh({ at: now - 60_000 }, now), true)
  assert.equal(isFresh({ at: now - IDLE_MS - 1 }, now), false)
  assert.equal(isFresh({}, now), false)
  assert.equal(isFresh(null, now), false)
})

test('U-ST-07 「어디에 넣을까요?」의 줄 — 마지막으로 연 곳(오래된) 먼저, 최근 대화, 내 채팅, 파일이면 쓸 수 있는 폴더', () => {
  const me = 'u-me'
  const rooms = [
    { id: 'g1', kind: 'group', title: '시니어그룹', members: [{ id: me, name: '나' }, { id: 'u2', name: '김서연' }, { id: 'u3', name: '박도윤' }] },
    { id: 'd1', kind: 'direct', title: '김서연', members: [{ id: me, name: '나' }, { id: 'u2', name: '김서연' }] },
  ]
  const folders = [{ slug: 'pub', name: '공지', role: 'viewer' }, { slug: 'new', name: '새 자료', role: 'editor' }, { slug: 'old', name: '영업 자료', role: 'owner' }]
  const r = chooserRows({ rooms, folders, recent: ['old', 'pub'], meId: me, files: 2 })
  assert.equal(r.first, null)
  assert.deepEqual(r.rooms.map((x) => [x.id, x.title, x.sub]), [['g1', '시니어그룹', '단체방 · 3명'], ['d1', '김서연', '1:1 대화']])
  assert.equal(r.rooms[1].other.id, 'u2')
  assert.deepEqual(r.folders.map((x) => [x.id, x.sub]), [['old', '최근에 연 폴더'], ['new', '공유 폴더']])
  assert.equal(r.chat.sub, 'AI에게 이 파일로 질문하기')
  // words only: no folders
  assert.deepEqual(chooserRows({ rooms, folders, recent: [], meId: me, files: 0 }).folders, [])
  // the place left a while ago comes first (and not again below)
  const f = chooserRows({ rooms, folders, recent: [], meId: me, files: 1, first: { kind: 'room', id: 'g1', title: '시니어그룹' } })
  assert.deepEqual([f.first.kind, f.first.id, f.first.title, f.first.sub, f.first.group], ['room', 'g1', '시니어그룹', '단체방 · 3명', true])
  assert.deepEqual(f.rooms.map((x) => x.id), ['d1'])
  const c = chooserRows({ rooms, folders, recent: [], meId: me, files: 1, first: { kind: 'chat', id: '', title: 'Process GPT 채팅' } })
  assert.equal(c.chat, null)
  assert.equal(c.first.sub, 'AI에게 이 파일로 질문하기')
  // a place the lists do not show (a project, a routine): its kind
  assert.equal(chooserRows({ rooms, files: 1, first: { kind: 'routine', id: 'd.1', title: '견적 승인' } }).first.sub, '루틴')
  assert.deepEqual(pathOf({ kind: 'chat', id: '' }), '/chat')
  assert.equal(pathOf({ kind: 'chat', id: 'a b' }), '/chat/c/a%20b')
  assert.equal(pathOf({ kind: 'room', id: 'r' }), null)
  assert.equal(pathOf({ kind: 'folder', id: 'sales' }), '/folders/sales')
})

test('U-ST-08 매니페스트 — share_target 이 앱 범위 안, POST · multipart, 모든 파일', () => {
  const m = JSON.parse(fs.readFileSync(root('public/manifest.webmanifest'), 'utf8'))
  const t = m.share_target
  assert.equal(t.method, 'POST')
  assert.equal(t.enctype, 'multipart/form-data')
  assert.deepEqual(t.params, { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['*/*'] }] })
  // behind the gateway: /lite/manifest.webmanifest → the action and the start page under /lite/
  for (const at of ['https://acme.process-gpt.io/lite/manifest.webmanifest', 'http://localhost:5180/manifest.webmanifest']) {
    const scope = new URL(m.scope, at).href, action = new URL(t.action, at).href
    assert.ok(action.startsWith(scope), `${action} in ${scope}`)
    assert.ok(new URL(m.start_url, at).href.startsWith(scope))
  }
  // installable: name, icons 192 · 512, standalone
  assert.ok(m.name && m.short_name && m.display === 'standalone')
  assert.ok(['192x192', '512x512'].every((s) => m.icons.some((i) => i.sizes === s)))
})

// ---- the service worker's share block, in a sandbox ----
function caches({ failOn = null } = {}) {
  const stores = new Map()
  const key = (r) => (typeof r === 'string' ? r : r.url)
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) {
        const m = new Map()
        stores.set(name, {
          m,
          async put(r, res) {
            if (failOn && failOn(key(r))) throw new Error('QuotaExceededError')
            m.set(key(r), { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') })
          },
          async match(r) { const v = m.get(key(r)); return v ? new Response(v.body, { headers: { 'Content-Type': v.type } }) : undefined },
          async keys() { return [...m.keys()].map((url) => ({ url })) },
          async delete(r) { return m.delete(key(r)) },
        })
      }
      return stores.get(name)
    },
  }
}
// routes: the browser has static routing (InstallEvent.addRoutes — Chrome 123+); false: Safari · Firefox
function worker(scope = 'https://acme.process-gpt.io/lite/', { routes = true, failOn = null } = {}) {
  const handlers = {}
  const c = caches({ failOn })
  class InstallEvent {}
  if (routes) InstallEvent.prototype.addRoutes = function addRoutes() {}
  const self = { addEventListener: (t, f) => { (handlers[t] ||= []).push(f) }, registration: { scope }, navigator: {}, clients: {}, skipWaiting() {}, crypto: globalThis.crypto, InstallEvent }
  // (Blob is watched: the worker must not gather a body into one — U-ST-14)
  const blobs = []
  class WatchedBlob extends Blob { constructor(parts, o) { super(parts, o); blobs.push(this.size) } }
  const ctx = vm.createContext({ self, caches: c, Response, Request, FormData, File, Blob: WatchedBlob, TransformStream, URL, JSON, Date, Math, String, Number, Error, Promise, parseInt, console })
  vm.runInContext(fs.readFileSync(root('public/sw.js'), 'utf8'), ctx)
  // a fetch event as Chrome hands it: respondWith(promise) or nothing (the network)
  const fetchEvent = async (request) => {
    let answered = null
    for (const h of handlers.fetch || []) h({ request, respondWith: (p) => { answered = p } })
    return answered ? await answered : null
  }
  return { handlers, caches: c, fetchEvent, scope, ctx, blobs }
}
const sharePost = (scope, fill) => { const fd = new FormData(); fill(fd); return new Request(`${scope}share-target`, { method: 'POST', body: fd }) }

test('U-ST-09 서비스 워커 — 공유 POST 는 캐시에 두고(파일은 그냥 바이트로) 303 으로 앱, 다른 요청은 그대로 네트워크', async () => {
  const w = worker()
  const res = await w.fetchEvent(sharePost(w.scope, (fd) => {
    fd.append('title', '견적서')
    fd.append('text', '확인 부탁드려요')
    fd.append('url', 'https://example.test/q')
    fd.append('files', new File([Buffer.from('%PDF-1.4 견적')], '하늘테크 견적서.pdf', { type: 'application/pdf' }))
    // (what another site would send: a picture's name with a page's type)
    fd.append('files', new File([Buffer.from('<script>alert(1)</script>')], 'photo.jpg', { type: 'text/html' }))
  }))
  assert.equal(res.status, 303)
  const loc = new URL(res.headers.get('location'))
  assert.equal(loc.origin + loc.pathname, `${w.scope}chat`)
  const id = loc.searchParams.get('share')
  assert.match(id, ID_RE)
  assert.ok(Math.abs(idTime(id) - Date.now()) < 5000)
  const cache = w.caches.stores.get('pgl-share-v1')
  const meta = JSON.parse(cache.m.get(`${w.scope}share-target/${id}/meta`).body.toString())
  assert.deepEqual({ title: meta.title, text: meta.text, url: meta.url, skipped: meta.skipped }, { title: '견적서', text: '확인 부탁드려요', url: 'https://example.test/q', skipped: [] })
  // the sharing app's type is not kept anywhere: the record names the files, the bytes are plain bytes
  assert.deepEqual(meta.files, [{ n: 0, name: '하늘테크 견적서.pdf', size: 15 }, { n: 1, name: 'photo.jpg', size: 25 }])
  for (const n of [0, 1]) assert.equal(cache.m.get(`${w.scope}share-target/${id}/${n}`).type, 'application/octet-stream')
  assert.equal(cache.m.get(`${w.scope}share-target/${id}/0`).body.toString(), '%PDF-1.4 견적')
  // …and the app names them from the extension
  assert.deepEqual(meta.files.map((f) => typeOf(f.name)), ['application/pdf', 'image/jpeg'])
  assert.equal(composeText(meta), '견적서\n확인 부탁드려요\nhttps://example.test/q')
  // not ours: a GET of the same address, a POST elsewhere, another origin's address
  assert.equal(await w.fetchEvent(new Request(`${w.scope}share-target`)), null)
  assert.equal(await w.fetchEvent(new Request(`${w.scope}api/attachments`, { method: 'POST', body: 'x' })), null)
  assert.equal(await w.fetchEvent(new Request('https://other.test/lite/share-target', { method: 'POST', body: 'x' })), null)
})

test('U-ST-10 서비스 워커 — 50MB 넘는 파일 · 11번째 · 빈 파일은 넣지 않고 까닭을 남긴다, 하루 지난 것은 지운다', async () => {
  const w = worker('http://127.0.0.1:5374/')
  const cache = await w.caches.open('pgl-share-v1')
  // a day-old share left over (its record and a file), and one whose record never got written
  const old = `${(Date.now() - LIMITS.keepMs - 60_000).toString(36)}-abcdef1234`
  for (const k of ['meta', '0']) await cache.put(`${w.scope}share-target/${old}/${k}`, new Response('x'))
  const fresh = `${(Date.now() - 60_000).toString(36)}-fedcba4321`
  await cache.put(`${w.scope}share-target/${fresh}/0`, new Response('y'))
  const res = await w.fetchEvent(sharePost(w.scope, (fd) => {
    fd.append('files', new File([new Uint8Array(LIMITS.fileBytes + 1048576)], '현장 영상.mp4', { type: 'video/mp4' }))
    fd.append('files', new File([], '빈.txt', { type: 'text/plain' }))
    for (let i = 0; i < 11; i++) fd.append('files', new File([`파일 ${i}`], `메모 ${i}.txt`, { type: 'text/plain' }))
  }))
  const id = new URL(res.headers.get('location')).searchParams.get('share')
  const meta = JSON.parse(cache.m.get(`${w.scope}share-target/${id}/meta`).body.toString())
  assert.equal(meta.files.length, LIMITS.files)
  assert.deepEqual(meta.skipped.map((s) => [s.name, s.why]), [['현장 영상.mp4', 'big'], ['빈.txt', 'empty'], ['메모 10.txt', 'many']])
  assert.equal(skippedNotice(meta.skipped), '‘현장 영상.mp4’(51MB)는 50MB가 넘어서 넣지 못했어요. 파일은 한 번에 10개까지 받아요. 1개는 넣지 못했어요. ‘빈.txt’ 파일이 비어 있어서 넣지 못했어요.')
  // the big one was never written
  assert.equal([...cache.m.keys()].filter((k) => k.includes(`${id}/`)).length, LIMITS.files + 1)
  assert.equal([...cache.m.keys()].some((k) => k.includes(old)), false)
  assert.equal([...cache.m.keys()].some((k) => k.includes(fresh)), true)
})

test('U-ST-11 서비스 워커 — 읽을 수 없는 POST 는 ?share=failed, 저장이 실패하면 이미 쓴 것도 지운다, 수치는 앱과 같다', async () => {
  const w = worker()
  const res = await w.fetchEvent(new Request(`${w.scope}share-target`, { method: 'POST', body: 'not a form', headers: { 'Content-Type': 'text/plain' } }))
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), `${w.scope}chat?share=failed`)
  // the phone's storage fills up at the second file: the first one written goes too, nothing of this share stays
  const q = worker('https://acme.process-gpt.io/lite/', { failOn: (k) => /\/1$/.test(k) })
  const r2 = await q.fetchEvent(sharePost(q.scope, (fd) => { fd.append('files', new File(['a'], 'a.txt')); fd.append('files', new File(['b'], 'b.txt')) }))
  assert.equal(r2.headers.get('location'), `${q.scope}chat?share=failed`)
  assert.deepEqual([...q.caches.stores.get('pgl-share-v1').m.keys()], [])
  const sw = fs.readFileSync(root('public/sw.js'), 'utf8')
  const nums = /const PGL_SHARE = (\{[^}]+\})/.exec(sw)[1]
  const v = vm.runInNewContext(`(${nums})`)
  assert.deepEqual({ files: v.files, fileBytes: v.fileBytes, totalBytes: v.totalBytes, keepMs: v.keepMs }, LIMITS)
})

test('U-ST-12 서비스 워커 — 합계 200MB 를 넘는 본문은 읽지 않고(길이를 알리든 안 알리든) ?share=failed:big', async () => {
  const w = worker()
  const over = LIMITS.totalBytes + 2 * 1048576
  // a declared length over the total: not read at all (formData() would throw on this fake body)
  const told = new Request(`${w.scope}share-target`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'multipart/form-data; boundary=b' } })
  Object.defineProperty(told, 'headers', { value: new Headers({ 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(over) }) })
  Object.defineProperty(told, 'formData', { value: () => { throw new Error('read') } })
  assert.equal((await w.fetchEvent(told)).headers.get('location'), `${w.scope}chat?share=failed:big`)
  // no length: read until it goes over, then stopped (a stream of 1MB pieces that never ends)
  let pulled = 0, cancelled = false
  const chunk = new Uint8Array(1048576)
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(chunk) }, cancel() { cancelled = true } })
  const streamed = new Request(`${w.scope}share-target`, { method: 'POST', body, duplex: 'half', headers: { 'Content-Type': 'multipart/form-data; boundary=b' } })
  assert.equal((await w.fetchEvent(streamed)).headers.get('location'), `${w.scope}chat?share=failed:big`)
  assert.ok(cancelled)
  assert.ok(pulled <= 205, `pulled ${pulled}MB`)
  assert.equal(w.caches.stores.size, 0)
})

test('U-ST-13 서비스 워커 — fetch 처리기는 정적 라우팅이 있는 브라우저에만, 공유 POST 말고는 모두 네트워크로 · 알림 처리기는 그대로', async () => {
  const w = worker()
  assert.equal(w.handlers.fetch.length, 1)
  assert.ok(w.handlers.push?.length && w.handlers.notificationclick?.length)
  // the install: one rule — everything but the share's POST goes to the network; the install waits on it and never fails over it
  const routes = []
  let waited
  const install = (addRoutes) => { waited = null; for (const h of w.handlers.install) h({ addRoutes, waitUntil: (p) => { waited = p } }) }
  // (the rules are made in the worker's own realm: compared as data)
  const plain = (x) => JSON.parse(JSON.stringify(x))
  install((r) => { routes.push(plain(r)) })
  await waited
  assert.deepEqual(routes, [[{ condition: { not: { requestMethod: 'POST', urlPattern: { pathname: '/lite/share-target' } } }, source: 'network' }]])
  // a browser without the `not` condition: the GETs at least
  routes.length = 0
  install((r) => { routes.push(plain(r)); if (r[0].condition.not) throw new TypeError('not') })
  await waited
  assert.deepEqual(routes.map((r) => r[0].condition), [{ not: { requestMethod: 'POST', urlPattern: { pathname: '/lite/share-target' } } }, { requestMethod: 'GET' }])
  install(() => Promise.reject(new TypeError('no')))
  await assert.doesNotReject(waited)
  // Safari · Firefox (no static routing): no fetch handler at all — every request goes as if there were no worker; push still works
  const s = worker('https://acme.process-gpt.io/lite/', { routes: false })
  assert.equal(s.handlers.fetch, undefined)
  assert.ok(s.handlers.push?.length && s.handlers.notificationclick?.length && s.handlers.install?.length)
})

test('U-ST-14 서비스 워커 — 길이를 알리지 않는 본문도 한 번만 흘려 읽는다(조각을 모아 Blob 으로 만들지 않는다), 받는 것은 그대로', async () => {
  const w = worker()
  const fd = new FormData()
  fd.append('title', '현장 보고')
  fd.append('files', new File([new Uint8Array(3 * 1048576).fill(7)], '현장 영상.mp4', { type: 'video/mp4' }))
  fd.append('files', new File(['메모'], '메모.txt', { type: 'text/plain' }))
  // the form as a stream with no length (as a navigation's body can come)
  const made = new Request(`${w.scope}share-target`, { method: 'POST', body: fd })
  const req = new Request(`${w.scope}share-target`, { method: 'POST', body: made.body, duplex: 'half', headers: { 'Content-Type': made.headers.get('content-type') } })
  assert.equal(req.headers.get('content-length'), null)
  const res = await w.fetchEvent(req)
  const id = new URL(res.headers.get('location')).searchParams.get('share')
  assert.match(id, ID_RE)
  const cache = w.caches.stores.get('pgl-share-v1')
  const meta = JSON.parse(cache.m.get(`${w.scope}share-target/${id}/meta`).body.toString())
  assert.deepEqual(meta.files.map((f) => [f.name, f.size]), [['현장 영상.mp4', 3 * 1048576], ['메모.txt', 6]])
  assert.equal(meta.title, '현장 보고')
  // no copy of the whole body made in the worker (the parts, then a Blob of them, then the form: three times its size before)
  assert.deepEqual(w.blobs.filter((n) => n >= 1048576), [])
})
