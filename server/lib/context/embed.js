// 뜻 비교: Process GPT judge 서버의 임베딩(bge-m3). 같은 글은 다시 부르지 않는다(프로세스 메모리).
// PRO_EMBED_URL='' (비워 둠) = 임베딩 없음: 자동 참고 · 같은 요청 알아보기는 기다리지 않고 건너뛴다(embeddingsOn).
// 임베딩 서버가 안 되면(연결 실패 · 오류 · 시간 초과) 1분 동안은 부르지 않는다 — 턴마다 기다리지 않게. 한 번 부른 것이 3초 넘게
// 답이 없을 때도 그동안은 없는 것으로 본다.
import crypto from 'node:crypto'

const JUDGE = process.env.PRO_JUDGE_URL ?? 'http://127.0.0.1:8896/judge'
export const EMBED_URL = process.env.PRO_EMBED_URL ?? (JUDGE ? JUDGE.replace(/\/judge\/?$/, '') + '/embeddings' : '')
const memo = new Map()
const DOWN_MS = Number(process.env.PRO_EMBED_DOWN_MS || 60000)
const SLOW_MS = 3000
let downUntil = 0
const inFlight = new Set() // the calls not answered yet: {at}

export class EmbedUnavailable extends Error {
  constructor(message) { super(message); this.code = 'EMBED_UNAVAILABLE' }
}
// whether a call now would be answered: a server is set, it did not just fail, and no call is hanging
export function embeddingsOn(now = Date.now()) {
  if (!EMBED_URL || now < downUntil) return false
  for (const c of inFlight) if (now - c.at > SLOW_MS) return false
  return true
}
// (tests)
export const resetEmbedState = () => { downUntil = 0; inFlight.clear() }

export async function vectors(texts) {
  if (!EMBED_URL) throw new EmbedUnavailable('임베딩 서버가 없습니다(PRO_EMBED_URL)')
  const keys = texts.map((t) => crypto.createHash('sha1').update(String(t)).digest('hex'))
  const need = new Map()
  keys.forEach((k, i) => { if (!memo.has(k) && !need.has(k)) need.set(k, String(texts[i]).slice(0, 2000)) })
  const list = [...need.entries()]
  if (list.length && !embeddingsOn()) throw new EmbedUnavailable('임베딩 서버가 잠시 답하지 않습니다')
  for (let i = 0; i < list.length; i += 32) {
    const part = list.slice(i, i + 32)
    const call = { at: Date.now() }
    inFlight.add(call)
    try {
      const r = await fetch(EMBED_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ input: part.map(([, t]) => t) }) })
      if (!r.ok) throw new Error(`embeddings ${r.status}`)
      const j = await r.json()
      const got = part.map((_, n) => j?.data?.[n]?.embedding)
      if (got.some((v) => !Array.isArray(v))) throw new Error('embeddings: no vectors in the answer')
      part.forEach(([k], n) => memo.set(k, got[n]))
    } catch (e) {
      downUntil = Date.now() + DOWN_MS
      throw new EmbedUnavailable(`임베딩 서버에 닿지 못했습니다(${e.cause?.code || e.message})`)
    } finally { inFlight.delete(call) }
  }
  while (memo.size > 8000) memo.delete(memo.keys().next().value)
  return keys.map((k) => memo.get(k))
}

export function cosine(a, b) {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na * nb) || 1)
}
