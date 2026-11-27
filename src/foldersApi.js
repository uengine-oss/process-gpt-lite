// Client for the shared-folder API (server/routes/folders.js).
import { api, auth, freshToken, htmlPage } from './api.js'
import { BASE } from './base.js'
import { nameOf } from './people.js'
import { batchBody } from './folderDrop.js'

async function call(path, opts) {
  const r = await api(path, { ...opts, raw: true })
  const text = await r.text()
  let j = null
  try { j = text ? JSON.parse(text) : null } catch { /* not json */ }
  // (a refusal that carries a variation's seat — where its working copy is — keeps it: the screen offers 「돌려 달라고 하기」 from it)
  if (!r.ok) throw Object.assign(new Error(j?.error || (htmlPage(r, text) ? `서버가 응답하지 못했어요 (${r.status}). 잠시 후 다시 시도해 주세요.` : text.slice(0, 200)) || `오류 ${r.status}`), { status: r.status, seat: j?.seat, why: j?.why })
  return j
}
const enc = encodeURIComponent
let rulesOnce = null

export const folders = {
  list: () => call('/folders'),
  create: (body) => call('/folders', { method: 'POST', body }),
  link: (body) => call('/folders/link', { method: 'POST', body }),
  caps: () => call('/folders/caps'),
  search: (q) => call(`/folders/search?q=${enc(q)}`),
  people: () => call('/folders/people'),
  get: (slug) => call(`/folders/${enc(slug)}`),
  update: (slug, body) => call(`/folders/${enc(slug)}`, { method: 'PATCH', body }),
  // template folders (server lib/folders/templates.js): mark one, start a project from it (its own workspace), and from that workspace
  // the template files to send back (「원본에 반영 요청」 → a new variation of the template that its owner merges)
  setTemplate: (slug, on) => call(`/folders/${enc(slug)}`, { method: 'PATCH', body: { template: !!on } }),
  startProject: (slug, title) => call(`/folders/${enc(slug)}/start-project`, { method: 'POST', body: { title } }),
  proposal: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/proposal`),
  propose: (slug, vid, body) => call(`/folders/${enc(slug)}/variations/${vid}/propose`, { method: 'POST', body }),
  tree: (slug, ref = 'main') => call(`/folders/${enc(slug)}/tree?ref=${enc(ref)}`),
  file: (slug, path, ref = 'main') => call(`/folders/${enc(slug)}/file?ref=${enc(ref)}&path=${enc(path)}`),
  setMember: (slug, body) => call(`/folders/${enc(slug)}/members`, { method: 'POST', body }),
  removeMember: (slug, type, id) => call(`/folders/${enc(slug)}/members/${enc(type)}/${enc(id)}`, { method: 'DELETE' }),
  candidates: (slug) => call(`/folders/${enc(slug)}/candidates`),
  importBranches: (slug, branches) => call(`/folders/${enc(slug)}/import`, { method: 'POST', body: { branches } }),
  removeFile: (slug, path) => call(`/folders/${enc(slug)}/files?path=${enc(path)}`, { method: 'DELETE' }),
  newVariation: (slug, body) => call(`/folders/${enc(slug)}/variations`, { method: 'POST', body }),
  variation: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}`),
  diff: (slug, vid, path) => call(`/folders/${enc(slug)}/variations/${vid}/diff?path=${enc(path)}`),
  checkout: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/checkout`, { method: 'POST' }),
  // a variation's seat — where its working copy is (server lib/folders/seats.js): open it in my server workroom, put it away (돌려놓기),
  // a save point, take it back here (from my PC — or the owner after 「돌려 달라」 and a day), ask whoever has it for it back
  seat: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/seat`),
  openSeat: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/seat`, { method: 'POST', body: { to: 'server' } }),
  releaseSeat: (slug, vid, epoch) => call(`/folders/${enc(slug)}/variations/${vid}/seat/release`, { method: 'POST', body: { epoch } }),
  saveSeat: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/seat/save`, { method: 'POST' }),
  takeSeat: (slug, vid, epoch) => call(`/folders/${enc(slug)}/variations/${vid}/seat/take`, { method: 'POST', body: { epoch } }),
  recallSeat: (slug, vid, why = '') => call(`/folders/${enc(slug)}/variations/${vid}/seat/recall`, { method: 'POST', body: { why } }),
  // may this kept folder be downloaded (within the download limits — a refusal says which file or how much): asked before the download
  keptCheck: (slug, vid, id) => call(`/folders/${enc(slug)}/variations/${vid}/kept/${enc(id)}?check=1`),
  // 「이 PC 에서 작업」 (desktop 0.2.6): the seat to one of my linked computers — it makes the working copy and says ready (src/desktopSeats.js)
  // (head: the commit the trust check looked at — the server refuses with why 'moved' when the variation changed since)
  openOnPc: (slug, vid, deviceId, head = null) => call(`/folders/${enc(slug)}/variations/${vid}/seat`, { method: 'POST', body: { to: 'device', deviceId, ...(head ? { head } : {}) } }),
  // before 「이 PC 에서 작업」: the files of the variation that run things by themselves on a computer, and who changed each last
  seatTrust: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/trust`),
  seatPrefs: (slug, vid, body) => call(`/folders/${enc(slug)}/variations/${vid}/seat`, { method: 'PATCH', body }),
  // what the 작업실 sheet needs at once: my variations of the folder with their seats, my computers, whether I may open main
  workroom: (slug) => call(`/folders/${enc(slug)}/workroom`),
  commit: (slug, vid, body = {}) => call(`/folders/${enc(slug)}/variations/${vid}/commit`, { method: 'POST', body }),
  discard: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/discard`, { method: 'POST' }),
  handover: (slug, vid, body) => call(`/folders/${enc(slug)}/variations/${vid}/handover`, { method: 'POST', body }),
  merge: (slug, ids, policy) => call(`/folders/${enc(slug)}/merge`, { method: 'POST', body: { ids, policy } }),
  mergeSides: (slug, iid, path) => call(`/folders/${enc(slug)}/merge/${iid}/sides?path=${enc(path)}`),
  mergeChoose: (slug, iid, choices) => call(`/folders/${enc(slug)}/merge/${iid}/choose`, { method: 'POST', body: { choices } }),
  mergeAgent: (slug, iid) => call(`/folders/${enc(slug)}/merge/${iid}/agent`, { method: 'POST' }),
  mergeAbort: (slug, iid) => call(`/folders/${enc(slug)}/merge/${iid}/abort`, { method: 'POST' }),
  // champion folders (server lib/folders/kit.js · sources.js): the agent assets found in main, the computers that upload it, and the
  // removal of a folder whose upload did not happen (only while it is empty)
  kit: (slug) => call(`/folders/${enc(slug)}/kit`),
  sources: (slug) => call(`/folders/${enc(slug)}/sources`),
  setSource: (slug, id, state) => call(`/folders/${enc(slug)}/sources/${enc(id)}`, { method: 'PATCH', body: { state } }),
  removeSource: (slug, id) => call(`/folders/${enc(slug)}/sources/${enc(id)}`, { method: 'DELETE' }),
  discard: (slug) => call(`/folders/${enc(slug)}`, { method: 'DELETE' }),
  // files dragged on the folder (src/fileDrag.js items — server lib/fileRefs.js dropInto): each becomes a file of it, in my name
  drop: (slug, items, dir = '') => call(`/folders/${enc(slug)}/drop`, { method: 'POST', body: { items, dir } }),
  // reference slots (server lib/folders/refs.js): the slots as this person sees them, adding · renaming · removing one, and a locked
  // slot's 「접근 요청」 to the original's owners
  refs: (slug) => call(`/folders/${enc(slug)}/refs`),
  addRef: (slug, body) => call(`/folders/${enc(slug)}/refs`, { method: 'POST', body }),
  renameRef: (slug, id, body) => call(`/folders/${enc(slug)}/refs/${enc(id)}`, { method: 'PATCH', body }),
  removeRef: (slug, id) => call(`/folders/${enc(slug)}/refs/${enc(id)}`, { method: 'DELETE' }),
  requestRefAccess: (slug, id) => call(`/folders/${enc(slug)}/refs/${enc(id)}/request-access`, { method: 'POST' }),
  // skills as folders
  skills: () => call('/folders/skills'),
  openSkill: async (name) => (await call(`/folders/skills/${enc(name)}/open`, { method: 'POST' })).slug,
  skillInfo: (slug) => call(`/folders/${enc(slug)}/skill`),
  share: (slug) => call(`/folders/${enc(slug)}/share`, { method: 'POST' }),
  keepPrivate: (slug) => call(`/folders/${enc(slug)}/keep-private`, { method: 'POST' }),
  setBoss: (agentId, owner) => call(`/folders/agents/${enc(agentId)}/boss`, { method: 'POST', body: owner ? { owner } : {} }),
  requestMerge: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/request`, { method: 'POST' }),
  review: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/review`),
  verify: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/verify`, { method: 'POST' }),
  // IeumOffice / ArtCraft load from storage: a published copy of this version
  publish: async (slug, path, ref = 'main') => (await call(`/folders/${enc(slug)}/publish`, { method: 'POST', body: { path, ref } })).url,
  // the same, with the version's blob sha and whether this person may edit it in place (main, editor role)
  publishInfo: (slug, path, ref = 'main') => call(`/folders/${enc(slug)}/publish`, { method: 'POST', body: { path, ref } }),
  // an IeumOffice save of main's file → a commit in the folder ({path, sha, commit, copied, folded})
  officeSave: (slug, body) => call(`/folders/${enc(slug)}/office-save`, { method: 'POST', body }),
  async upload(slug, path, file) {
    const go = async () => fetch(`${BASE}/api/folders/${enc(slug)}/files?path=${enc(path)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${await freshToken()}` } })
    const r = await go()
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || '올리지 못했어요.')
    return j
  },
  // a folder from the computer (src/folderDrop.js): what is left out before it goes up (the champion folders' rules), and its files a
  // request at a time — one commit each (server S.uploadMany: {written, refused: [{path, reason, line}]}); signal stops it
  uploadRules: () => (rulesOnce ||= call('/folders/upload-rules').catch((e) => { rulesOnce = null; throw e })),
  // (a request of this person still on its way — one stopped a moment ago, the server finishing it — answers 429: this one waits its
  // turn, a while; a refusal that ends the connection before the answer is read comes as a network error and is said as such)
  async uploadBatch(slug, batch, meta, signal) {
    for (let wait = 0; ; wait++) {
      let r
      try {
        r = await fetch(`${BASE}/api/folders/${enc(slug)}/files/batch`, { method: 'POST', body: batchBody(batch, meta), signal,
          headers: { 'Content-Type': 'application/x-pgl-batch', Authorization: `Bearer ${await freshToken()}` } })
      } catch (e) {
        if (e.name === 'AbortError') throw e
        throw new Error('서버가 이 요청을 받지 않고 연결을 끊었어요 — 올리는 중인 것이 끝난 뒤, 한도 안에서 다시 해 주세요.')
      }
      const j = await r.json().catch(() => ({}))
      if (r.status === 429 && wait < 20 && !signal?.aborted) { await new Promise((ok) => setTimeout(ok, 1000)); continue }
      if (!r.ok) throw new Error(j.error || '올리지 못했어요.')
      return j
    }
  },
  async text(slug, path, ref = 'main') {
    const r = await fetch(rawUrl(slug, path, ref))
    if (!r.ok) throw new Error('파일을 읽지 못했어요.')
    return r.text()
  },
}
// a kept folder of a variation (what git does not carry, kept when its working copy left the disk) as a zip
export const keptUrl = (slug, vid, id) => `${BASE}/api/folders/${enc(slug)}/variations/${vid}/kept/${enc(id)}?token=${enc(auth.get()?.session?.access_token || '')}`
export const rawUrl = (slug, path, ref = 'main', download = false) =>
  `${BASE}/api/folders/${enc(slug)}/raw?ref=${enc(ref)}&path=${enc(path)}&token=${enc(auth.get()?.session?.access_token || '')}${download ? '&download=1' : ''}`

// avatar colour from an id, so a person keeps theirs everywhere
const COLORS = ['#4a5f9a', '#b0567a', '#3f8a6b', '#7b5cd6', '#d97757', '#c2570c', '#0b6f88', '#8a6d3b']
export const colorOf = (id) => COLORS[[...String(id || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]
export const whoOf = (o) => (o ? { id: o.id, name: o.name || o.holder_name || '?', type: o.is_agent || o.isAgent || o.type === 'agent' ? 'agent' : 'person', engine: o.agent_type || o.engine || '에이전트', color: colorOf(o.id || o.name) } : null)
// a variation's holder as the screens call them: a person by the name every screen uses (src/people.js — the stored holder_name is
// Process GPT's own), an agent by its own
export const holderName = (v) => (v?.holder_type === 'agent' ? v?.holder_name : nameOf(v?.holder_id, v?.holder_name)) || ''
export const roleLabel = { owner: '소유', editor: '편집', runner: '실행', viewer: '보기' }
// A seat as its pill says it, in parts (each its own text — the English dictionary translates each): {icon, tone, parts}
//   none → 보관 중 · server workroom → 서버 작업실에서 · <who> · a server agent → 서버 에이전트가 작업 중 · a computer → <who>의 PC 에서 · <its name>
//   · PC 꺼짐 · 저장 안 한 변경 N · 마지막 올림 … · moving → 넘기는 중…
// here: this very computer holds it (the desktop app's own working copy — src/desktopSeats.js pcSeatOf): 「이 PC 에서」, its counts as the
// app has them now (pc) rather than as last reported to the server
export function seatText(seat, { here = null } = {}) {
  if (!seat?.place) return { icon: 'archive', tone: 'none', parts: ['보관 중'] }
  if (seat.state && seat.state !== 'held') return { icon: 'handover', tone: 'moving', parts: ['넘기는 중…'] }
  const who = seat.who?.name || ''
  if (seat.place === 'server') return seat.run === 'agent' ? { icon: 'agent', tone: 'agent', parts: ['서버 에이전트가 작업 중'] } : { icon: 'terminal', tone: 'server', parts: ['서버 작업실에서', who].filter(Boolean) }
  const parts = here ? ['이 PC 에서'] : [`${who}의 PC 에서`, seat.device?.name || ''].filter(Boolean)
  if (!here && seat.device && !seat.device.online) parts.push('PC 꺼짐')
  const dirty = here ? here.dirty : seat.dirty
  const pushedAt = (here && here.pushedAt) || seat.pushedAt
  if (dirty) parts.push(`저장 안 한 변경 ${dirty}`)
  if (pushedAt) parts.push(ago(pushedAt) === '방금' ? '방금 올림' : `마지막 올림 ${ago(pushedAt)}`)
  return { icon: 'pc', tone: 'device', parts }
}
export const statusLabel = { open: '작업 중', ready: '반영 대기', conflicted: '충돌', merged: '반영됨', discarded: '버림' }
export const sourceLabel = { run: '실행', instance: '인스턴스', person: '사람', chat: '채팅', handover: '인계', imported: '가져옴' }
export const prLabel = { OPEN: '반영 요청됨', CHANGES_REQUESTED: '수정 요청', APPROVED: '승인', MERGED: '반영됨', CLOSED: '닫힘' }
export const indexLabel = { cards: '문서 카드', list: '파일 목록만', indexing: '색인 중' }
export function ago(at) {
  if (!at) return ''
  const s = (Date.now() - new Date(at).getTime()) / 1000
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`
  return new Date(at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}
