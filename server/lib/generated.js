// Saves a process-generation contract with process-gpt's own code (bridge/save_generated.py),
// run in the deepagents venv which already has the Supabase client.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import fs from 'node:fs/promises'
import { workspaceHostPath, saveSkillDraft } from './missions.js'
import { PGPT_ROOT } from './paths.js'

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

// The draft card shows the definition assembled from the generation folder, as saving will:
// the streamed process_result can be another contract the agent only quoted (a skill example).
// Without the bridge (local dev) the streamed one stays.
export async function assembleGenerated(contract, workDir) {
  if (!config.bridgeUrl || !workDir) return contract
  const workHost = await workspaceHostPath(workDir).catch(() => '')
  if (!workHost) return contract
  const { warn, ...out } = await viaBridge('assemble', contract, workHost)
  return out.processDefinition ? out : contract
}

export async function saveGenerated(contract, workDir) {
  const workHost = workDir ? await workspaceHostPath(workDir).catch(() => '') : ''
  if (config.bridgeUrl) return viaBridge('save', contract, workHost)
  return new Promise((resolve, reject) => {
    const py = spawn(`${PGPT}/services/deepagents/.venv/bin/python`, [path.join(here, '..', 'bridge', 'save_generated.py')], {
      env: { ...process.env, PGPT_ROOT: PGPT, TENANT_ID: config.tenantId, SUPABASE_URL: config.supabaseUrl, SERVICE_ROLE_KEY: config.serviceKey,
        WORK_DIR: workHost },
    })
    let out = '', err = ''
    py.stdout.on('data', (d) => { out += d })
    py.stderr.on('data', (d) => { err += d })
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.split('\n').filter(Boolean).slice(-3).join(' | ')))
      try { resolve({ ...JSON.parse(out.trim().split('\n').pop()), warn: err.trim() || undefined }) } catch { reject(new Error(out + err)) }
    })
    py.stdin.end(JSON.stringify(contract))
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
