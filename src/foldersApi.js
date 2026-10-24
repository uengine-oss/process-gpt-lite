// Client for the shared-folder API (server/routes/folders.js).
import { api, auth, freshToken } from './api.js'

async function call(path, opts) {
  const r = await api(path, { ...opts, raw: true })
  const text = await r.text()
  let j = null
  try { j = text ? JSON.parse(text) : null } catch { /* not json */ }
  if (!r.ok) throw new Error(j?.error || text.slice(0, 200) || `오류 ${r.status}`)
  return j
}
const enc = encodeURIComponent

export const folders = {
  list: () => call('/folders'),
  create: (body) => call('/folders', { method: 'POST', body }),
  link: (body) => call('/folders/link', { method: 'POST', body }),
  search: (q) => call(`/folders/search?q=${enc(q)}`),
  people: () => call('/folders/people'),
  get: (slug) => call(`/folders/${enc(slug)}`),
  update: (slug, body) => call(`/folders/${enc(slug)}`, { method: 'PATCH', body }),
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
  commit: (slug, vid, body = {}) => call(`/folders/${enc(slug)}/variations/${vid}/commit`, { method: 'POST', body }),
  discard: (slug, vid) => call(`/folders/${enc(slug)}/variations/${vid}/discard`, { method: 'POST' }),
  handover: (slug, vid, body) => call(`/folders/${enc(slug)}/variations/${vid}/handover`, { method: 'POST', body }),
  merge: (slug, ids, policy) => call(`/folders/${enc(slug)}/merge`, { method: 'POST', body: { ids, policy } }),
  mergeSides: (slug, iid, path) => call(`/folders/${enc(slug)}/merge/${iid}/sides?path=${enc(path)}`),
  mergeChoose: (slug, iid, choices) => call(`/folders/${enc(slug)}/merge/${iid}/choose`, { method: 'POST', body: { choices } }),
  mergeAgent: (slug, iid) => call(`/folders/${enc(slug)}/merge/${iid}/agent`, { method: 'POST' }),
  mergeAbort: (slug, iid) => call(`/folders/${enc(slug)}/merge/${iid}/abort`, { method: 'POST' }),
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
  async upload(slug, path, file) {
    const go = async () => fetch(`/api/folders/${enc(slug)}/files?path=${enc(path)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${await freshToken()}` } })
    const r = await go()
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || '올리지 못했어요.')
    return j
  },
  async text(slug, path, ref = 'main') {
    const r = await fetch(rawUrl(slug, path, ref))
    if (!r.ok) throw new Error('파일을 읽지 못했어요.')
    return r.text()
  },
}
export const rawUrl = (slug, path, ref = 'main', download = false) =>
  `/api/folders/${enc(slug)}/raw?ref=${enc(ref)}&path=${enc(path)}&token=${enc(auth.get()?.session?.access_token || '')}${download ? '&download=1' : ''}`

// avatar colour from an id, so a person keeps theirs everywhere
const COLORS = ['#4a5f9a', '#b0567a', '#3f8a6b', '#7b5cd6', '#d97757', '#c2570c', '#0b6f88', '#8a6d3b']
export const colorOf = (id) => COLORS[[...String(id || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]
export const whoOf = (o) => (o ? { id: o.id, name: o.name || o.holder_name || '?', type: o.is_agent || o.isAgent || o.type === 'agent' ? 'agent' : 'person', engine: o.agent_type || o.engine || '에이전트', color: colorOf(o.id || o.name) } : null)
export const roleLabel = { owner: '소유', editor: '편집', runner: '실행', viewer: '보기' }
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
