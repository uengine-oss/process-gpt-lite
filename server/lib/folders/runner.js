// A deepagents turn run in the background on a folder checkout (a variation handed to an agent, a
// merge conflict handed to a resolving agent). The checkout sits inside the conversation's run
// folder, so the sandbox's per-run scope already covers it; git stays with this server.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { L, isEn, langInstruction } from '../lang.js'

export const RULES = '이 폴더 안의 파일만 읽고 고치세요. git 명령(commit, checkout, merge 등)은 쓰지 마세요 — 바뀐 내용은 시스템이 변형에 커밋합니다. 새 파일을 만들 때도 이 폴더 안에 두세요.'
export const RULES_EN = 'Read and change only the files in this folder. Do not use git commands (commit, checkout, merge …) — the system commits the changes to the variation. Put any new file in this folder too.'
export const rules = () => L(RULES, RULES_EN)

// signal: stops waiting (a verification's deadline); the agent's own turn is left to deepagents
export async function runAgent({ jwt, user, conversationId, message, onText, signal }) {
  const res = await fetch(`${config.deepagentsUrl}/chat/stream`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Tenant-Id': config.tenantId },
    body: JSON.stringify({
      // English mode (lib/lang.js): the agent is told to answer and write in English
      message: message + langInstruction(), message_uuid: crypto.randomUUID(), tenant_id: config.tenantId,
      user_uid: user.id, user_email: user.email, user_name: user.name, user_jwt: jwt,
      conversation_id: conversationId, stream: true,
      metadata: { client: 'pgpt-pro', origin: 'pgpt-pro-folders', style: isEn() ? 'English, concise.' : 'Korean 해요체, concise.' },
    }),
  })
  if (!res.ok) throw new Error(`deepagents ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      let j
      try { j = JSON.parse(line.slice(5)) } catch { continue }
      if (j.type === 'token' && j.content) { out += j.content; onText?.(j.content) }
      if (j.type === 'error') out += L(`\n(오류: ${j.message || j.error || ''})`, `\n(error: ${j.message || j.error || ''})`)
    }
  }
  return out.trim()
}
