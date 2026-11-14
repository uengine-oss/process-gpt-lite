// 중요한 판단을 더 센 모델로(design-v0.3 §24 · §25): AI 후보 · 갈림길 조건처럼 사람이 그대로 믿고 쓸 판단은 스킬 규칙의 judge 설정을 따른다.
// via: claude-cli 면 이 기기의 claude CLI 로 그 모델(기본 Fable)에 묻는다 — 회사 게이트웨이를 가리키는 환경값은 빼고, 빈 폴더에서, 도구 없이.
// CLI 가 없거나 실패하면 fallback 이 gateway 일 때 Lite 의 모델로 묻는다. PRO_CANDIDATES_JUDGE=gateway 면 늘 Lite 의 모델. 누가 판단했는지 돌려준다.
import { spawn } from 'node:child_process'
import os from 'node:os'
import { config } from '../../config.js'
import { chatJson } from '../llm.js'

export function claudeJson(system, user, { model, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY']) delete env[k]
    const p = spawn(process.env.PRO_CLAUDE_BIN || 'claude', ['-p', '--model', model, '--output-format', 'json', '--system-prompt', system, '--tools', ''], { cwd: os.tmpdir(), env })
    let out = '', errText = ''
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('claude cli timed out')) }, timeoutMs)
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { errText += d })
    p.on('error', (e) => { clearTimeout(t); reject(e) })
    p.on('close', () => {
      clearTimeout(t)
      try {
        const r = JSON.parse(out)
        if (r.is_error) throw new Error(String(r.result).slice(0, 200))
        const text = String(r.result || ''), a = text.indexOf('{'), b = text.lastIndexOf('}')
        resolve(JSON.parse(text.slice(a, b + 1)))
      } catch (e) { reject(new Error(`claude cli: ${e.message} ${errText.slice(0, 200)}`)) }
    })
    p.stdin.end(user)
  })
}
export async function judge(system, user, R) {
  const J = R.judge || {}
  if (J.via === 'claude-cli' && process.env.PRO_CANDIDATES_JUDGE !== 'gateway') {
    try { return { r: await claudeJson(system, user, { model: J.model, timeoutMs: R.timeoutMs }), model: J.model } } catch (e) {
      console.warn('[ontology] candidates judge', e.message)
      if (J.fallback !== 'gateway') throw e
    }
  }
  return { r: await chatJson(system, user, { timeoutMs: R.timeoutMs || 180000, temperature: 0 }), model: config.llm.model }
}

