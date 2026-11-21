// 업무 팩을 회사(테넌트)에 설치하는 장치(설계 docs/mobile-review-1121/skill-routing-design.md 4.4).
// 팩의 스킬은 deepagents 의 테넌트 스킬로 올린다(POST /skills/upload — 본판 화면의 스킬 저장과 같은 길).
// Lite 쪽 원장(pro_skill_installs)이 무엇을 언제 어느 내용으로 올렸는지 적는다(sql/028_skill_packs.sql).
//
// 지키는 것
//   - 이름 충돌: 같은 이름의 스킬이 이미 있고 원장에 우리 것으로 없으면 덮어쓰지 않는다(conflict).
//   - 회사가 고친 스킬: 받아 본 내용의 해시가 올린 때와 다르면 그대로 두고(diverged) 새 버전을 올리지 않는다.
//   - 끈 팩: 관리자가 끄면 우리가 올린 그대로인 스킬만 지우고(disabled), 다시 켜기 전에는 올리지 않는다.
//     회사가 고친 스킬은 끄더라도 지우지 않는다(회사의 일).
//   - 버전 올림: 켜 둔 팩의 버전이 오르면, 고치지 않은 스킬만 overwrite=true 로 새로 올린다.
// deepagents 를 부르는 일은 `api` 로 묶어 두어 시험에서 바꿔 끼울 수 있다.
import JSZip from 'jszip'
import { config } from '../config.js'
import { q } from './supa.js'
import { allPacks, contentHash, dirFiles, readPack, packNames, setEnabledPacks, forgetEnabledPacks } from './skillInstallCatalog.js'

const T = () => config.tenantId
const fail = (status, message, code) => Object.assign(new Error(message), { status, code })
const da = (p) => `${config.deepagentsUrl}${p}${p.includes('?') ? '&' : '?'}tenant_id=${encodeURIComponent(T())}`

async function zipOf(name, files) {
  const zip = new JSZip()
  for (const f of files) zip.file(`${name}/${f.path}`, f.data)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// deepagents' skills API (tenant-guarded: the caller's JWT). Errors carry the HTTP status.
export const deepagentsApi = {
  // name → where it is (tenant skills and the service's system skills alike)
  async list(jwt) {
    const r = await fetch(da('/skills'), { headers: { Authorization: `Bearer ${jwt}` } })
    if (!r.ok) throw fail(r.status, `skills ${r.status}`, 'SKILLS_UNAVAILABLE')
    const j = await r.json()
    return new Map((Array.isArray(j) ? j : j.skills || []).map((s) => [s.name, s]))
  },
  async upload({ name, files, jwt, ownerId, overwrite = false }) {
    const form = new FormData()
    form.set('tenant_id', T())
    if (ownerId) form.set('owner_id', ownerId)
    form.set('skill_name', name)
    if (overwrite) form.set('overwrite', 'true')
    form.set('file', new Blob([await zipOf(name, files)]), `${name}.zip`)
    const r = await fetch(`${config.deepagentsUrl}/skills/upload`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form })
    const j = await r.json().catch(() => ({}))
    if (r.status === 409) throw fail(409, j.error || 'skill exists', 'SKILL_EXISTS')
    if (!r.ok) throw fail(r.status, j.error || `upload ${r.status}`, 'UPLOAD_FAILED')
    return j
  },
  // the installed skill's content hash (null: there is none)
  async hash(name, jwt) {
    const r = await fetch(da(`/skills/${encodeURIComponent(name)}/export`), { headers: { Authorization: `Bearer ${jwt}` } })
    if (r.status === 404) return null
    if (!r.ok) throw fail(r.status, `export ${name}: ${r.status}`, 'EXPORT_FAILED')
    const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()))
    const files = []
    for (const [p, e] of Object.entries(zip.files)) if (!e.dir) files.push({ path: p, data: await e.async('nodebuffer') })
    return contentHash(files)
  },
  async remove(name, jwt) {
    const r = await fetch(da(`/skills/${encodeURIComponent(name)}`), { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'local' }) })
    if (!r.ok && r.status !== 404) throw fail(r.status, `delete ${name}: ${r.status}`, 'DELETE_FAILED')
  },
}

// a skill folder on this host uploaded as a tenant skill (lib/generated.js: a process generation's own
// skills). A name that is taken comes back as status 409 / code SKILL_EXISTS.
export async function uploadSkillFolder({ dir, name, jwt, ownerId, overwrite = false, api = deepagentsApi }) {
  return api.upload({ name, files: dirFiles(dir), jwt, ownerId, overwrite })
}

// ---------- 원장 ----------
const rowsOf = async (pack) => Object.fromEntries((await q('select * from pro_skill_installs where tenant_id=$1 and pack=$2', [T(), pack])).map((r) => [r.skill_name, r]))
async function put(skill, pack, { state, version = null, sha256 = null, note = null, by = null, installed = false }) {
  await q(`insert into pro_skill_installs (tenant_id, skill_name, pack, version, sha256, state, note, installed_by, installed_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8, case when $9 then now() end, now())
           on conflict (tenant_id, skill_name) do update set pack=excluded.pack, state=excluded.state, note=excluded.note, updated_at=now(),
             version = case when $9 then excluded.version else pro_skill_installs.version end,
             sha256 = case when $9 then excluded.sha256 else pro_skill_installs.sha256 end,
             installed_by = case when $9 then excluded.installed_by else pro_skill_installs.installed_by end,
             installed_at = case when $9 then now() else pro_skill_installs.installed_at end`,
  [T(), skill, pack, version, sha256, state, note, by, installed])
}

// one skill of a pack brought to where the pack wants it. explicit: the admin turned the pack on just now
// (a skill we took away when it was turned off goes back; a background check never brings one back).
async function reconcile(s, pack, row, remote, { jwt, by, explicit, api }) {
  const ours = row && row.state !== 'conflict'
  const upload = async (overwrite) => {
    try {
      await api.upload({ name: s.name, files: s.files, jwt, ownerId: by, overwrite })
      await put(s.name, pack.name, { state: 'installed', version: pack.version, sha256: s.sha256, by, installed: true })
      return overwrite ? 'upgraded' : 'installed'
    } catch (e) {
      // someone made the same name between the listing and the upload: theirs, not ours
      if (e.status === 409) { await put(s.name, pack.name, { state: 'conflict', note: 'exists' }); return 'conflict' }
      await put(s.name, pack.name, { state: 'failed', note: String(e.message).slice(0, 300) })
      return 'failed'
    }
  }
  if (remote && !ours) {
    // a skill of this name that is not ours (or still not ours): never overwritten
    await put(s.name, pack.name, { state: 'conflict', note: 'exists' })
    return 'conflict'
  }
  const now = remote ? await api.hash(s.name, jwt) : null
  if (!now) {
    // not there: a new install, or a conflicting skill that has gone. Ours that is gone — taken away when
    // the pack was turned off, or deleted by the company — comes back only when the admin turns the pack on.
    if (!row || row.state === 'failed' || row.state === 'conflict' || explicit) return upload(false)
    if (row.state !== 'disabled') await put(s.name, pack.name, { state: 'disabled', note: 'removed by the company' })
    return 'disabled'
  }
  if (now === s.sha256) {
    // exactly this version's content (also: the company put back what we gave)
    if (row.state !== 'installed' || row.version !== pack.version || row.sha256 !== s.sha256) await put(s.name, pack.name, { state: 'installed', version: pack.version, sha256: s.sha256, by, installed: true })
    return 'installed'
  }
  // what we uploaded, untouched: the new version goes over it
  if (now === row.sha256) return upload(true)
  // changed by the company since we uploaded it: kept as it is, the new version only noted
  await put(s.name, pack.name, { state: 'diverged', note: row.version !== pack.version ? `pack ${pack.version} available` : 'changed by the company' })
  return 'diverged'
}

const locks = new Map()
const locked = (key, fn) => {
  const prev = locks.get(key) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(key, next.finally(() => { if (locks.get(key) === next) locks.delete(key) }))
  return next
}

// the admin turns a pack on (or a seed does): every skill of it installed where that is allowed
export async function enablePack(name, { jwt, by = null, api = deepagentsApi, dir } = {}) {
  if (!packNames({ dir }).includes(name)) throw fail(404, `no pack '${name}'`, 'NO_PACK')
  const pack = readPack(name, { dir })
  return locked(`${T()}:${name}`, async () => {
    await q(`insert into pro_skill_packs (tenant_id, pack, enabled, version, updated_by, updated_at) values ($1,$2,true,$3,$4,now())
             on conflict (tenant_id, pack) do update set enabled=true, version=excluded.version, updated_by=excluded.updated_by, updated_at=now()`, [T(), name, pack.version, by])
    forgetEnabledPacks(T())
    const remote = await api.list(jwt)
    const rows = await rowsOf(name)
    const skills = {}
    for (const s of pack.skills) skills[s.name] = await reconcile(s, pack, rows[s.name] || null, remote.get(s.name) || null, { jwt, by, explicit: true, api })
    return { pack: name, version: pack.version, enabled: true, skills }
  })
}

// the admin turns a pack off: the server stops using it at once; our untouched copies leave the tenant
export async function disablePack(name, { jwt, by = null, api = deepagentsApi, dir } = {}) {
  if (!packNames({ dir }).includes(name)) throw fail(404, `no pack '${name}'`, 'NO_PACK')
  const pack = readPack(name, { dir })
  return locked(`${T()}:${name}`, async () => {
    await q(`insert into pro_skill_packs (tenant_id, pack, enabled, version, updated_by, updated_at) values ($1,$2,false,$3,$4,now())
             on conflict (tenant_id, pack) do update set enabled=false, updated_by=excluded.updated_by, updated_at=now()`, [T(), name, pack.version, by])
    forgetEnabledPacks(T())
    const rows = await rowsOf(name)
    const skills = {}
    for (const s of pack.skills) {
      const row = rows[s.name]
      if (!row || row.state === 'conflict' || row.state === 'disabled') { skills[s.name] = row?.state || 'absent'; continue }
      const now = await api.hash(s.name, jwt).catch(() => undefined)
      if (now === undefined) { skills[s.name] = row.state; continue }
      if (now && now !== row.sha256) { await put(s.name, name, { state: 'diverged', note: 'kept: changed by the company' }); skills[s.name] = 'diverged'; continue }
      if (now) await api.remove(s.name, jwt)
      await put(s.name, name, { state: 'disabled', note: null })
      skills[s.name] = 'disabled'
    }
    return { pack: name, version: pack.version, enabled: false, skills }
  })
}

// in the background, for the packs this tenant has on: a newer pack version goes over the copies the
// company has not changed. Checked once per pack version and tenant in this process.
const current = new Set()
export async function ensurePacksCurrent({ jwt, by = null, api = deepagentsApi, dir } = {}) {
  if (!jwt) return []
  const on = await q('select pack, version from pro_skill_packs where tenant_id=$1 and enabled', [T()]).catch(() => [])
  const out = []
  for (const r of on) {
    if (!packNames({ dir }).includes(r.pack)) continue
    const pack = readPack(r.pack, { dir })
    const key = `${T()}:${r.pack}:${pack.sha256}`
    if (current.has(key)) continue
    out.push(await locked(`${T()}:${r.pack}`, async () => {
      const remote = await api.list(jwt)
      const rows = await rowsOf(r.pack)
      const skills = {}
      for (const s of pack.skills) {
        const row = rows[s.name]
        // only what is ours and in place: a skill we never got in (failed) is tried again; a removed,
        // conflicting or changed one stays as it is
        if (row && !['installed', 'failed'].includes(row.state)) { skills[s.name] = row.state; continue }
        skills[s.name] = await reconcile(s, pack, row || null, remote.get(s.name) || null, { jwt, by, explicit: false, api })
      }
      await q('update pro_skill_packs set version=$3, updated_at=now() where tenant_id=$1 and pack=$2', [T(), r.pack, pack.version])
      current.add(key)
      return { pack: r.pack, version: pack.version, skills }
    }))
  }
  return out
}
// fire and forget (a mail poll, a process step): never holds the work up
export const checkPacksSoon = (jwt, by) => { ensurePacksCurrent({ jwt, by }).catch((e) => console.warn('[packs] version check', e.message)) }

// what the settings screen shows: every pack this install has, whether this company has it on, and each skill's state
export async function packStatus({ dir } = {}) {
  const on = Object.fromEntries((await q('select pack, enabled, version, updated_at from pro_skill_packs where tenant_id=$1', [T()])).map((r) => [r.pack, r]))
  const rows = Object.fromEntries((await q('select skill_name, pack, version, state, note, updated_at from pro_skill_installs where tenant_id=$1', [T()])).map((r) => [r.skill_name, r]))
  const packs = allPacks({ dir })
  setEnabledPacks(T(), packs.filter((p) => on[p.name]?.enabled).map((p) => p.name), { pinned: false })
  return packs.map((p) => ({
    name: p.name, version: p.version, title: p.title, summary: p.summary,
    enabled: !!on[p.name]?.enabled, installedVersion: on[p.name]?.version || null,
    skills: p.skills.map((s) => ({ name: s.name, description: s.description, state: rows[s.name]?.pack === p.name ? rows[s.name].state : 'absent', version: rows[s.name]?.version || null, note: rows[s.name]?.note || null })),
  }))
}

// a seed script's one line: the pack on for the tenant the script entered, installed as that admin
// (scripts/seed-mining-demo.mjs, scripts/seed-improve-demo.mjs — the demo company's trade knowledge)
export async function enablePackAs(email, name, displayName) {
  const { sessionFor } = await import('./supa.js')
  const { user, session } = await sessionFor(email, displayName)
  const r = await enablePack(name, { jwt: session.access_token, by: user.id })
  console.log(`[packs] ${name} ${r.version} on for ${T()}: ${Object.entries(r.skills).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  return r
}
