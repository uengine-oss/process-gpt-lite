// 업무 팩 설치 원장(lib/skillInstall.js · sql/028_skill_packs.sql)을 실제 데이터베이스로 본다. deepagents 는
// 메모리 속 가짜로 바꿔 끼운다(같은 네 동작: 목록·올리기·내용 해시·지우기). 시험 회사는 이 실행만의 테넌트.
//   - 처음 켜기: 팩의 스킬이 모두 올라가고 원장에 버전·내용 해시가 남는다
//   - 이름 충돌: 회사가 이미 가진 같은 이름 스킬은 덮어쓰지 않는다(conflict)
//   - 회사가 고친 스킬: 새 버전이 와도 그대로 둔다(diverged). 고치지 않은 것만 새 버전으로(overwrite)
//   - 끈 팩: 고치지 않은 사본만 지우고(disabled), 서버도 더는 쓰지 않는다. 뒤에서 다시 올리지 않는다
//   - 회사가 지운 스킬: 뒤에서 다시 올리지 않는다. 관리자가 다시 켜면 올린다
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const { pool, q } = await import('../lib/supa.js')
const { tenantStore } = await import('../lib/tenantStore.js')
const { contentHash, packsDir, enabledPacks, packSkill, documentSkills, forgetEnabledPacks } = await import('../lib/skillInstallCatalog.js')
const I = await import('../lib/skillInstall.js')

const TENANT = `rt-pack-${crypto.randomBytes(4).toString('hex')}`
const inTenant = (fn) => tenantStore.run({ tenant: TENANT }, fn)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-packs-'))
// v1: the repository's pack as it is; v2: the same pack one version up, with one skill's text changed
const v1 = path.join(tmp, 'v1'), v2 = path.join(tmp, 'v2')
fs.cpSync(path.join(packsDir(), 'store-design'), path.join(v1, 'store-design'), { recursive: true })
fs.cpSync(path.join(packsDir(), 'store-design'), path.join(v2, 'store-design'), { recursive: true })
{
  const pj = path.join(v2, 'store-design', 'pack.json')
  fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), version: '1.1.0' }, null, 2))
  for (const s of ['cadcraft-floor-plan', 'quote-xlsx', 'store-design-proposal']) fs.appendFileSync(path.join(v2, 'store-design', s, 'SKILL.md'), '\n<!-- 1.1.0 -->\n')
}

function fakeDeepagents() {
  const store = new Map()
  return {
    store,
    calls: [],
    async list() { return new Map([...store.keys()].map((n) => [n, { name: n }])) },
    async upload({ name, files, overwrite }) {
      this.calls.push(['upload', name, !!overwrite])
      if (store.has(name) && !overwrite) throw Object.assign(new Error(`skill '${name}' already exists`), { status: 409, code: 'SKILL_EXISTS' })
      store.set(name, { files, hash: contentHash(files) })
      return { registered: true }
    },
    async hash(name) { return store.get(name)?.hash ?? null },
    async remove(name) { this.calls.push(['remove', name]); store.delete(name) },
  }
}
const ledger = async () => Object.fromEntries((await q('select skill_name, state, version, sha256 from pro_skill_installs where tenant_id=$1', [TENANT])).map((r) => [r.skill_name, r]))

after(async () => {
  await q('delete from pro_skill_installs where tenant_id=$1', [TENANT])
  await q('delete from pro_skill_packs where tenant_id=$1', [TENANT])
  fs.rmSync(tmp, { recursive: true, force: true })
  await pool.end()
})

test('켜기·이름 충돌·회사가 고친 스킬·버전 올림·끄기·회사가 지운 스킬', async () => inTenant(async () => {
  const api = fakeDeepagents()
  // the company already has its own skill named like one of the pack's
  const theirs = [{ path: 'SKILL.md', data: Buffer.from('---\nname: quote-xlsx\ndescription: our own\n---\n') }]
  api.store.set('quote-xlsx', { files: theirs, hash: contentHash(theirs) })

  forgetEnabledPacks(TENANT)
  assert.equal((await enabledPacks()).size, 0, '처음엔 꺼져 있다')
  assert.equal(documentSkills('ko').length, 0, '꺼진 팩의 스킬은 메일 분류에 실리지 않는다')

  // 1) turned on
  const on = await I.enablePack('store-design', { jwt: 'x', by: null, api, dir: v1 })
  assert.deepEqual(on.skills, { 'cadcraft-floor-plan': 'installed', 'store-design-proposal': 'installed', 'quote-xlsx': 'conflict' })
  assert.equal(api.store.get('quote-xlsx').hash, contentHash(theirs), '회사 스킬은 그대로')
  let L = await ledger()
  assert.equal(L['cadcraft-floor-plan'].version, '1.0.0')
  assert.equal(L['cadcraft-floor-plan'].sha256, api.store.get('cadcraft-floor-plan').hash)
  assert.equal(L['quote-xlsx'].state, 'conflict')
  assert.ok((await enabledPacks()).has('store-design'), '켠 팩을 서버가 쓴다')
  assert.ok(packSkill('cadcraft-floor-plan'), '켠 팩의 스킬을 찾는다')

  // 2) the company edits one of ours; the pack goes up a version
  const edited = [...api.store.get('cadcraft-floor-plan').files, { path: 'references/ours.md', data: Buffer.from('회사 메모') }]
  api.store.set('cadcraft-floor-plan', { files: edited, hash: contentHash(edited) })
  api.calls.length = 0
  const [up] = await I.ensurePacksCurrent({ jwt: 'x', api, dir: v2 })
  assert.equal(up.version, '1.1.0')
  assert.equal(up.skills['cadcraft-floor-plan'], 'diverged', '회사가 고친 스킬은 되돌리지 않는다')
  assert.equal(up.skills['store-design-proposal'], 'upgraded', '고치지 않은 스킬은 새 버전으로')
  assert.equal(up.skills['quote-xlsx'], 'conflict', '충돌은 그대로')
  assert.deepEqual(api.calls, [['upload', 'store-design-proposal', true]], '덮어쓰기는 고치지 않은 것 하나뿐')
  assert.equal(api.store.get('cadcraft-floor-plan').hash, contentHash(edited))
  L = await ledger()
  assert.equal(L['store-design-proposal'].version, '1.1.0')
  assert.equal(L['cadcraft-floor-plan'].state, 'diverged')
  assert.equal(L['cadcraft-floor-plan'].version, '1.0.0', '원장은 올린 버전을 기억한다')
  // checked once per version: a second check does nothing
  api.calls.length = 0
  assert.deepEqual(await I.ensurePacksCurrent({ jwt: 'x', api, dir: v2 }), [])
  assert.deepEqual(api.calls, [])

  // 3) turned off: our untouched copy goes, the company's edit and its own skill stay
  const off = await I.disablePack('store-design', { jwt: 'x', api, dir: v2 })
  assert.equal(off.skills['store-design-proposal'], 'disabled')
  assert.equal(off.skills['cadcraft-floor-plan'], 'diverged')
  assert.ok(!api.store.has('store-design-proposal'))
  assert.ok(api.store.has('cadcraft-floor-plan') && api.store.has('quote-xlsx'))
  assert.equal((await enabledPacks()).size, 0, '끈 팩을 서버가 더는 쓰지 않는다')
  assert.equal(packSkill('store-design-proposal'), null)
  api.calls.length = 0
  assert.deepEqual(await I.ensurePacksCurrent({ jwt: 'x', api, dir: v2 }), [], '꺼진 팩은 뒤에서 다시 올리지 않는다')
  assert.deepEqual(api.calls, [])

  // 4) on again (the admin's choice): what the pack's turning off took away comes back
  const again = await I.enablePack('store-design', { jwt: 'x', api, dir: v2 })
  assert.equal(again.skills['store-design-proposal'], 'installed')
  assert.equal(again.skills['cadcraft-floor-plan'], 'diverged')
  assert.equal(again.skills['quote-xlsx'], 'conflict')

  // 5) the company deletes one of ours: a background check leaves it out
  api.store.delete('store-design-proposal')
  const v3 = path.join(tmp, 'v3')
  fs.cpSync(path.join(v2, 'store-design'), path.join(v3, 'store-design'), { recursive: true })
  const pj = path.join(v3, 'store-design', 'pack.json')
  fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), version: '1.2.0' }, null, 2))
  fs.appendFileSync(path.join(v3, 'store-design', 'store-design-proposal', 'SKILL.md'), '\n<!-- 1.2.0 -->\n')
  api.calls.length = 0
  const [bg] = await I.ensurePacksCurrent({ jwt: 'x', api, dir: v3 })
  assert.equal(bg.skills['store-design-proposal'], 'disabled', '회사가 지운 스킬은 다시 올리지 않는다')
  assert.ok(!api.calls.some(([k]) => k === 'upload'))
  // the settings screen's view of it
  const [st] = (await I.packStatus({ dir: v3 })).filter((p) => p.name === 'store-design')
  assert.equal(st.enabled, true)
  assert.deepEqual(Object.fromEntries(st.skills.map((s) => [s.name, s.state])), { 'cadcraft-floor-plan': 'diverged', 'store-design-proposal': 'disabled', 'quote-xlsx': 'conflict' })
}))

test('공정 생성이 쓴 스킬: 이미 있으면 409 로 알아본다 (오류 문구를 읽지 않는다)', async () => {
  const { installGeneratedSkills } = await import('../lib/generated.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-gen-'))
  for (const n of ['have', 'fresh', 'broken']) {
    fs.mkdirSync(path.join(dir, 'skills', n), { recursive: true })
    fs.writeFileSync(path.join(dir, 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: test\n---\n`)
  }
  const api = {
    async upload({ name }) {
      if (name === 'have') throw Object.assign(new Error('무엇이든 — 문구는 보지 않는다'), { status: 409 })
      if (name === 'broken') throw Object.assign(new Error('already exists (but a 500)'), { status: 500 })
      return {}
    },
  }
  try {
    const out = Object.fromEntries((await installGeneratedSkills(dir, { jwt: 'x', ownerId: 'u', api })).map((r) => [r.name, r]))
    assert.equal(out.have.exists, true)
    assert.equal(out.fresh.installed, true)
    assert.equal(out.broken.exists, undefined, '문구에 already exists 가 있어도 409 가 아니면 있는 것이 아니다')
    assert.match(out.broken.error, /500/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
