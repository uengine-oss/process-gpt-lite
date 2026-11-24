// The desktop app's local runner, as the page sees it (desktop/src/runner, design docs/local-agents/design.md). Only inside the desktop
// app (window.pglDesktop.localRunner, its preload bridge): the signed-in page pairs this computer — it asks its server for a device token
// and hands it to the app's main process — and shows what runs. Main never reads this page's storage; the page never sees the CLIs.
//   pairing: once per person on this computer, by itself after sign-in — unless the person disconnected this computer here
//   logout:  this computer's token is revoked and forgotten (another person signing in pairs it for themselves)
import { reactive } from 'vue'
import { api } from './api.js'

export const runner = reactive({ desktop: false, status: null, error: '' })
const bridge = () => (typeof window !== 'undefined' ? window.pglDesktop?.localRunner || null : null)
let listening = false

export async function startDesktopRunner(me) {
  const b = bridge()
  const uid = me?.user?.id
  if (!b || !uid) return
  runner.desktop = true
  if (!listening) { listening = true; b.onState((st) => { runner.status = st }) }
  let st = await b.status().catch(() => null)
  runner.status = st
  // not paired, or paired for someone else on this computer: pair it for this person (unless they disconnected it here)
  if ((!st?.paired || st.userId !== uid) && await b.mayPair(uid).catch(() => false)) st = await pairThis(me, st).catch((e) => { runner.error = e.message; return st })
  return st
}

export async function pairThis(me, st = runner.status) {
  const b = bridge()
  if (!b) return null
  const r = await api('/local-agents/devices', { method: 'POST', body: { name: st?.deviceName || '', platform: st?.platform || '', appVersion: window.pglDesktop?.version || '' } })
  const ok = await b.pair({ token: r.token, deviceId: r.device.id, userId: me.user.id, userName: me.user.name || '' })
  if (!ok?.ok) throw new Error(ok?.reason || 'pair')
  runner.error = ''
  runner.status = await b.status()
  return runner.status
}

// disconnect this computer: its token revoked on the server and forgotten here; optOut keeps it from pairing again by itself
export async function disconnectThis({ optOut = true } = {}) {
  const b = bridge()
  if (!b) return
  const id = runner.status?.deviceId
  if (id) await api(`/local-agents/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
  await b.forget({ optOut })
  runner.status = await b.status().catch(() => null)
}

export async function setPrefs(p) {
  const b = bridge()
  if (!b) return
  await b.setPrefs({ ...(runner.status?.prefs || {}), ...p })
  runner.status = await b.status()
}
export async function detectClis() {
  const b = bridge()
  if (b) runner.status = await b.detect()
}
