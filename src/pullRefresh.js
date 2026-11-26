// Pull to refresh on the Home list (2026-11-18 phone review: "스크롤을 끝까지 밀어 내리면 한 번 더 스크롤을
// 유도시키면 리프레시가 되면서, 이메일하고 연결이 되어 있으면 이메일을 읽어 들여오는 메시지가 상단에 표시가 되면서…").
//   usePullRefresh — the gesture on a scroll container, by touch only (a mouse never starts it): a drag
//     down that starts with the list at its top pulls an indicator out with some resistance; let go past
//     the threshold and the refresh runs. Our touchmove takes the drag (preventDefault) and the scroller
//     has overscroll-behavior-y: contain (HomeDock), so the browser's own pull-to-refresh — which would
//     reload the whole page in a Chrome tab — never sees it. Any other drag (up, sideways, a list already
//     scrolled, two fingers) is left to the browser untouched.
//   refreshHome — what a pull does: the Home lists again and, with a mailbox connected, new mail
//     (POST /api/mail/poll, which turns it into Home cards). The banner on top of the list says what is
//     happening; its state lives here so a run survives a switch away from the Home tab and back.
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { api } from './api.js'

export const PULL_THRESHOLD = 68
const LIMIT = PULL_THRESHOLD + 48 // the furthest the list follows the finger
const HOLD = 52 // where the indicator rests while the refresh runs
const MIN_SPIN = 450 // a refresh that answers at once still shows its spinner this long
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))

// half the finger's travel up to the threshold, then stiffer
const resist = (dy) => {
  const d = dy * 0.5
  return Math.min(LIMIT, d <= PULL_THRESHOLD ? d : PULL_THRESHOLD + (d - PULL_THRESHOLD) * 0.4)
}

// target: a template ref (element or component); refresh: () => Promise, the indicator spins until it settles
export function usePullRefresh(target, refresh, { enabled = () => true } = {}) {
  const pull = ref(0) // how far the list is pulled down, px
  const state = ref('idle') // idle | pulling | armed | running
  const dragging = ref(false) // the list follows the finger (no easing)
  let g = null // the current touch: { x, y, top, mode: null | 'pull' | 'skip' }

  const el = () => target.value?.$el || target.value

  function start(e) {
    if (state.value === 'running' || e.touches.length !== 1 || !enabled()) { g = null; return }
    const t = e.touches[0]
    g = { x: t.clientX, y: t.clientY, top: (el()?.scrollTop ?? 1) <= 0, mode: null }
  }
  function move(e) {
    if (!g || g.mode === 'skip') return
    if (e.touches.length !== 1) return settle()
    const t = e.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y
    if (!g.mode) {
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return
      // ours only while the browser still lets us keep it (cancelable: it has not started scrolling)
      g.mode = g.top && dy > 0 && dy >= Math.abs(dx) && (el()?.scrollTop ?? 1) <= 0 && e.cancelable ? 'pull' : 'skip'
      if (g.mode === 'skip') return
      dragging.value = true
    }
    if (e.cancelable) e.preventDefault()
    pull.value = resist(Math.max(0, dy))
    state.value = pull.value >= PULL_THRESHOLD ? 'armed' : 'pulling'
  }
  function end() {
    if (g?.mode === 'pull' && state.value === 'armed') { g = null; dragging.value = false; run() } else settle()
  }
  function settle() {
    const mine = g?.mode === 'pull'
    g = null
    if (!mine) return
    dragging.value = false
    pull.value = 0
    state.value = 'idle'
  }
  async function run() {
    state.value = 'running'
    pull.value = HOLD
    try { await Promise.all([Promise.resolve().then(refresh).catch((e) => console.warn('[refresh]', e?.message)), wait(MIN_SPIN)]) } finally {
      pull.value = 0
      state.value = 'idle'
    }
  }

  let bound = null
  onMounted(() => {
    bound = el()
    if (!bound) return
    bound.addEventListener('touchstart', start, { passive: true })
    bound.addEventListener('touchmove', move, { passive: false })
    bound.addEventListener('touchend', end, { passive: true })
    bound.addEventListener('touchcancel', settle, { passive: true })
  })
  onBeforeUnmount(() => {
    if (!bound) return
    bound.removeEventListener('touchstart', start)
    bound.removeEventListener('touchmove', move)
    bound.removeEventListener('touchend', end)
    bound.removeEventListener('touchcancel', settle)
    bound = null
  })
  return { pull, state, dragging }
}

// ---------- what a pull on Home does ----------
// banner: { text, kind: 'busy' | 'done' | 'info' | 'error' } | null — shown on top of the Home list
export const homeBanner = ref(null)
export const mailBusy = ref(false)
const BANNER_MS = 2500
const MAIL_TIMEOUT = 90000 // a mailbox that does not answer: the banner does not spin forever
let hideTimer = 0

function show(text, kind = 'done') {
  clearTimeout(hideTimer)
  homeBanner.value = { text, kind }
  if (kind !== 'busy') hideTimer = setTimeout(() => { homeBanner.value = null }, BANNER_MS)
}

// app: the useApp() store. Resolves once the Home lists are back (the indicator goes then); the mail
// fetch, which can take several seconds when new mail is sorted into cards, goes on under the banner.
export async function refreshHome(app) {
  const lists = Promise.allSettled([app.loadNotifications(), app.loadProcesses(), app.loadActions(), app.loadPanels(), app.loadPanelApps(), app.loadAgenda()])
  let mail = app.me?.mail
  if (!mail) {
    // a mailbox connected after this page loaded (the onboarding sheet does not read /me again)
    const me = await api('/me').catch(() => null)
    if (me?.mail && app.me) { app.me = { ...app.me, mail: me.mail }; mail = me.mail }
  }
  if (!mail) {
    await lists
    show('새로고침했어요')
    return
  }
  pollMail(app)
  await lists
}

async function pollMail(app) {
  mailBusy.value = true
  show('메일을 가져오는 중…', 'busy')
  let timer = 0
  try {
    const late = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('timeout'), { late: true })), MAIL_TIMEOUT) })
    // the fetching banner stays long enough to be read, even when the mailbox answers at once
    const [r] = await Promise.all([Promise.race([api('/mail/poll', { method: 'POST' }), late]), wait(900)])
    if (r?.skipped) show('새로고침했어요')
    else if (r?.fresh > 0) {
      show(r.actions > 0 ? `새 메일 ${r.fresh}통 · 할 일 ${r.actions}개` : `새 메일 ${r.fresh}통`)
      // the cards arrive as events too; read again in case this tab's event stream missed them
      await Promise.allSettled([app.loadActions(), app.loadNotifications()])
    } else show('새 메일이 없어요')
  } catch (e) {
    if (e?.late) show('메일은 뒤에서 계속 가져오고 있어요', 'info')
    else show('메일을 가져오지 못했어요', 'error')
  } finally {
    clearTimeout(timer)
    mailBusy.value = false
  }
}
