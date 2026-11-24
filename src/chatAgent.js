// Who answers a chat message (server lib/localAgents/chat.js): 「기본」 (the server's business agent) or a CLI on the person's own PC —
// 「Claude Code · 내 PC」 · 「Codex · 내 PC」, as their desktop app reports them. The composer's picker (ComposerAgent.vue) shows what is
// available now and why not; the choice is kept per chat — the main chat, each of its conversations (/chat/c/:cid), each project — on the
// server (the same on the web, a phone and the desktop app) and in this browser (so it shows at once before the server answers).
// A chat's key: its thread id, and ':<conversation>' for one conversation of the main chat (the server makes the same key).
import { reactive } from 'vue'
import { api } from './api.js'

const CACHE = 'pgl.chatAgent'
const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE) || '{}') || {} } catch { return {} } }
const writeCache = (m) => { try { localStorage.setItem(CACHE, JSON.stringify(m)) } catch { /* private mode */ } }

export const chatAgents = reactive({
  agents: [{ id: 'default', label: '기본', where: '서버의 업무 에이전트', available: true }],
  desktop: null,   // {linked, online, names}
  download: '',
  loaded: false,
  error: '',
  choices: readCache(), // key → agent
})
export const keyOf = (threadId, conv = null) => (threadId ? (conv ? `${threadId}:${conv}` : String(threadId)) : null)
export const isLocal = (agent) => !!agent && agent !== 'default'

// what the picker offers now (and, for a chat, the choice the server keeps — it wins over this browser's)
let loading = null
// (a choice made here while a look was on its way wins over what that look brings back)
let picks = 0
export function refreshAgents(key = null) {
  const seen = picks
  const p = (async () => {
    try {
      const r = await api(`/local-agents/chat${key ? `?key=${encodeURIComponent(key)}` : ''}`)
      chatAgents.agents = r.agents || chatAgents.agents
      chatAgents.desktop = r.desktop || null
      chatAgents.download = r.download || ''
      chatAgents.loaded = true
      chatAgents.error = ''
      if (key && r.choice && seen === picks) remember(key, r.choice)
    } catch (e) { chatAgents.error = e.message }
  })()
  loading = p
  return p
}
export const agentsReady = () => loading || Promise.resolve()
function remember(key, agent) {
  chatAgents.choices = { ...chatAgents.choices, [key]: agent }
  const m = readCache()
  if (agent === 'default') delete m[key]
  else m[key] = agent
  writeCache(m)
}
export const choiceOf = (key) => (key && chatAgents.choices[key]) || 'default'
export async function choose(key, agent) {
  if (!key) return
  picks++
  remember(key, agent)
  await api('/local-agents/chat/choice', { method: 'PUT', body: { key, agent } }).catch((e) => { chatAgents.error = e.message })
}
// the agent a message goes to: the chat's choice, while the picker knows it (a CLI no desktop reports any more is no longer offered —
// such a message goes to 기본); one the picker shows off (the PC app is off) still goes: its run waits for the PC, and its card offers
// 「기본으로 다시 보내기」
export function agentFor(key) {
  const a = choiceOf(key)
  if (!isLocal(a)) return 'default'
  if (chatAgents.loaded && !chatAgents.agents.some((x) => x.id === a)) return 'default'
  return a
}
export const agentInfo = (id) => chatAgents.agents.find((x) => x.id === id) || null
