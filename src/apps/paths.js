// What a sandboxed app may reach through the bridge (src/apps/bridge.js); no imports, so tests read it too.
// an app's own routes only: a relative path below /api/apps/<id>/, no '..', no encoded slashes or dots
const APP_PATH = /^[A-Za-z0-9._~%-]+(\/[A-Za-z0-9._~%-]+)*(\?[A-Za-z0-9._~%=&+,:-]*)?$/
export function appApiPath(id, p) {
  const s = String(p || '').replace(/^\/+/, '')
  // (the query may carry an encoded record path: the checks below are for the route part)
  const route = s.split('?')[0]
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id) || !APP_PATH.test(s) || /(^|\/)\.{1,2}(\/|$)/.test(route) || /%2[ef]|%5c/i.test(route) || route.startsWith('ui/')) throw new Error('app api: path not allowed')
  return `/apps/${id}/${s}`
}
// the Lite screens an app may move the person to
const NAV = /^\/(workroom\/aidlc\/[A-Za-z0-9._-]+|aidlc\/[A-Za-z0-9._-]+\/decide|apps\/[a-z][a-z0-9-]{1,30}\/[A-Za-z0-9._-]+|folders\/[A-Za-z0-9._-]+)(\?[^#\s]*)?$/
export const navAllowed = (url) => NAV.test(String(url || ''))
