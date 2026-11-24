// 「앱 설치」 안내, the browser side (2026-11-24): the browser's install offer kept for our own button, what
// this device answered before, and the one place the cards (InstallNudge.vue) ask "show or not".
// The rules themselves are pure, in installEnv.js. watchInstall() runs from main.js before the app mounts:
// Chrome may offer the install (beforeinstallprompt) as soon as the page loads.
import { reactive } from 'vue'
import { detect, guideKind, shouldNudge, answered, openInBrowser } from './installEnv.js'

const KEY = 'pgl-install' // this device's answers: { snoozeUntil, never, installedAt }
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { return {} } }

export const install = reactive({
  prompt: null, // the deferred beforeinstallprompt event: our 「앱 설치」 calls its prompt()
  related: false, // the browser reports an installed copy (getInstalledRelatedApps)
  memo: load(),
})

function remember(patch) {
  install.memo = { ...install.memo, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(install.memo)) } catch { /* private mode: asked again next visit */ }
}

// opened as the installed app: display-mode standalone (and its relatives), iOS's home-screen flag, an
// Android Trusted Web Activity
export function standaloneNow(win = window) {
  try {
    if (['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some((m) => win.matchMedia?.(`(display-mode: ${m})`).matches)) return true
  } catch { /* old browser */ }
  return win.navigator?.standalone === true || String(win.document?.referrer || '').startsWith('android-app://')
}

/** This browser, read now (the desktop app marks <html> from its preload, the page may look before or after). */
export function currentEnv(win = window) {
  const cls = win.document?.documentElement?.classList
  return detect({
    ua: win.navigator?.userAgent || '',
    touchPoints: win.navigator?.maxTouchPoints || 0,
    standalone: standaloneNow(win),
    desktopApp: !!(cls && (cls.contains('pgl-desktop') || cls.contains('desktop'))),
    androidBridge: !!win.AndroidBridge,
  })
}

export const kindNow = (env = currentEnv()) => guideKind(env, { canPrompt: !!install.prompt })
/** Whether the card shows by itself on `place` ('login' | 'home'). */
export function nudgeHere(place, env = currentEnv()) {
  return shouldNudge(kindNow(env), env, place, install.memo, Date.now(), install.related)
}
export const linkOut = (env = currentEnv(), href = location.href) => openInBrowser(env, href)

/** 「나중에」 ('later': 7 days) or 「다시 보지 않기」 ('never'), on this device. */
export function dismiss(how) {
  install.memo = answered(install.memo, how)
  try { localStorage.setItem(KEY, JSON.stringify(install.memo)) } catch { /* private mode */ }
}

/** 「앱 설치」: the browser's own dialog. 'accepted' | 'dismissed' | 'unavailable'. */
export async function promptInstall() {
  const e = install.prompt
  if (!e) return 'unavailable'
  install.prompt = null // one offer, one dialog: the browser offers again on a later visit
  try {
    await e.prompt()
    const choice = await e.userChoice
    if (choice?.outcome === 'accepted') { remember({ installedAt: Date.now() }); return 'accepted' }
  } catch { /* the dialog could not open */ }
  // closed without installing: like 「나중에」
  dismiss('later')
  return 'dismissed'
}

let watching = false
export function watchInstall(win = window) {
  if (watching || typeof win?.addEventListener !== 'function') return
  watching = true
  win.addEventListener('beforeinstallprompt', (e) => {
    // ours to show (the card, settings › 앱 설치) instead of the browser's own bar; offered only while not installed
    e.preventDefault()
    install.prompt = e
    if (install.memo.installedAt) remember({ installedAt: null })
  })
  win.addEventListener('appinstalled', () => { install.prompt = null; remember({ installedAt: Date.now() }) })
  // opened as the app: the browser tab on this device knows from now on
  if (standaloneNow(win) && !install.memo.installedAt) remember({ installedAt: Date.now() })
  // Chrome on Android tells a page in the app's scope whether the app is installed (manifest related_applications)
  try {
    win.navigator?.getInstalledRelatedApps?.().then((list) => { if (list?.length) install.related = true }).catch(() => {})
  } catch { /* not here */ }
}
