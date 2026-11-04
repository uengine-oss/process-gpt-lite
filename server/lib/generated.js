// Saves a process-generation contract with process-gpt's own code (bridge/save_generated.py),
// run in the deepagents venv which already has the Supabase client.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import fs from 'node:fs/promises'
import { workspaceHostPath, saveSkillDraft } from './missions.js'
import { PGPT_ROOT } from './paths.js'
import { L } from './lang.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PGPT = PGPT_ROOT

// Docker bundle: the server image has no Python, so the bridge service (deepagents image) runs it.
// The bridge mounts the workspace elsewhere: it gets the folder relative to the workspace root.
async function viaBridge(action, contract, workHost) {
  const root = `${PGPT}/services/deepagents/workspace`
  const workRel = workHost.startsWith(`${root}/`) ? workHost.slice(root.length) : ''
  const r = await fetch(`${config.bridgeUrl}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract, work_rel: workRel }), signal: AbortSignal.timeout(620_000),
  })
  const out = await r.json().catch(() => ({ error: `bridge ${r.status}` }))
  if (!r.ok) throw new Error(out.error || `bridge ${r.status}`)
  return out
}

// No bridge (PRO_BRIDGE_URL) and no deepagents venv on this host (a server image deployed without the
// bridge service): saving cannot run. The caller gets this error (500 — not 502/503, which Cloudflare in
// front of production replaces with its own page) instead of the server process dying on the spawn's
// unhandled 'error' event (ENOENT), which took every user's session down with it.
export const saveUnavailable = () => Object.assign(
  new Error(L('프로세스 정의를 저장할 곳이 설정되지 않아 저장하지 못했어요. 관리자에게 알려 주세요.',
    "There is nowhere set up to save process definitions, so it wasn't saved. Please tell your administrator.")),
  { status: 500, code: 'SAVE_UNAVAILABLE' })

export async function saveGenerated(contract, workDir, { python = `${PGPT}/services/deepagents/.venv/bin/python` } = {}) {
  const workHost = workDir ? await workspaceHostPath(workDir).catch(() => '') : ''
  if (config.bridgeUrl) return viaBridge('save', contract, workHost)
  return new Promise((resolve, reject) => {
    const py = spawn(python, [path.join(here, '..', 'bridge', 'save_generated.py')], {
      env: { ...process.env, PGPT_ROOT: PGPT, TENANT_ID: config.tenantId, SUPABASE_URL: config.supabaseUrl, SERVICE_ROLE_KEY: config.serviceKey,
        WORK_DIR: workHost },
    })
    let out = '', err = ''
    py.on('error', (e) => {
      console.warn('[process] save', e.code || e.message)
      reject(e.code === 'ENOENT' ? saveUnavailable() : e)
    })
    // (writing the contract to a process that never started fails too: that is the 'error' above)
    py.stdin.on('error', () => {})
    py.stdout.on('data', (d) => { out += d })
    py.stderr.on('data', (d) => { err += d })
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.split('\n').filter(Boolean).slice(-3).join(' | ')))
      try { resolve({ ...JSON.parse(out.trim().split('\n').pop()), warn: err.trim() || undefined }) } catch { reject(new Error(out + err)) }
    })
    py.stdin.end(JSON.stringify(contract))
  })
}

// The contract a generation folder holds, assembled the way saving assembles it (save_generated.py
// CONTRACT_ONLY: deepagents' _complete_one_process, no database) — what the chat's draft card shows.
// Docker bundle: the bridge's /assemble runs it.
export async function generatedContract(workDir) {
  const workHost = workDir ? await workspaceHostPath(workDir).catch(() => '') : ''
  if (!workHost) return null
  if (config.bridgeUrl) {
    const { warn, ...out } = await viaBridge('assemble', {}, workHost).catch((e) => { console.warn('[process] assemble', e.message); return {} })
    return out.processDefinition ? out : null
  }
  return new Promise((resolve) => {
    const py = spawn(`${PGPT}/services/deepagents/.venv/bin/python`, [path.join(here, '..', 'bridge', 'save_generated.py')], {
      env: { ...process.env, PGPT_ROOT: PGPT, TENANT_ID: config.tenantId, WORK_DIR: workHost, CONTRACT_ONLY: '1' },
    })
    let out = ''
    py.stdout.on('data', (d) => { out += d })
    py.stderr.on('data', () => {})
    py.on('error', () => resolve(null))
    py.on('close', () => {
      try { const c = JSON.parse(out.trim().split('\n').pop()); resolve(c?.processDefinition ? c : null) } catch { resolve(null) }
    })
    py.stdin.end('{}')
  })
}

// The skills a process generation wrote (<work>/skills/<name>/SKILL.md) are installed for the tenant
// through deepagents' own upload (the process-gpt UI's skill save), so the agent steps that name them
// find them. A skill that already exists is left as it is.
export async function installGeneratedSkills(workDir, { jwt, ownerId }) {
  if (!workDir) return []
  const host = await workspaceHostPath(workDir).catch(() => '')
  if (!host) return []
  const names = await fs.readdir(path.join(host, 'skills')).catch(() => [])
  const out = []
  for (const name of names) {
    if (!(await fs.access(path.join(host, 'skills', name, 'SKILL.md')).then(() => true, () => false))) continue
    const dir = `${workDir.replace(/\/$/, '')}/skills/${name}`
    try { await saveSkillDraft({ dir, name, jwt, ownerId }); out.push({ name, installed: true }) } catch (e) {
      out.push({ name, installed: false, ...(/already exists|이미/.test(e.message) ? { exists: true } : { error: e.message.slice(0, 160) }) })
    }
  }
  return out
}
