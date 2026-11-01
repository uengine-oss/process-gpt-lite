// 뜻 비교: Process GPT judge 서버의 임베딩(bge-m3). 같은 글은 다시 부르지 않는다(프로세스 메모리).
import crypto from 'node:crypto'

const JUDGE = process.env.PRO_JUDGE_URL ?? 'http://127.0.0.1:8896/judge'
export const EMBED_URL = process.env.PRO_EMBED_URL ?? (JUDGE ? JUDGE.replace(/\/judge\/?$/, '') + '/embeddings' : '')
const memo = new Map()

export async function vectors(texts) {
  if (!EMBED_URL) throw new Error('임베딩 서버가 없습니다(PRO_EMBED_URL)')
  const keys = texts.map((t) => crypto.createHash('sha1').update(String(t)).digest('hex'))
  const need = new Map()
  keys.forEach((k, i) => { if (!memo.has(k) && !need.has(k)) need.set(k, String(texts[i]).slice(0, 2000)) })
  const list = [...need.entries()]
  for (let i = 0; i < list.length; i += 32) {
    const part = list.slice(i, i + 32)
    const r = await fetch(EMBED_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ input: part.map(([, t]) => t) }) })
    if (!r.ok) throw new Error(`embeddings ${r.status}`)
    const j = await r.json()
    part.forEach(([k], n) => memo.set(k, j.data[n].embedding))
  }
  while (memo.size > 8000) memo.delete(memo.keys().next().value)
  return keys.map((k) => memo.get(k))
}

export function cosine(a, b) {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na * nb) || 1)
}
