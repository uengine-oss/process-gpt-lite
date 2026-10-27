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

export async function saveGenerated(contract, workDir) {
  const workHost = workDir ? await workspaceHostPath(workDir).catch(() => '') : ''
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
