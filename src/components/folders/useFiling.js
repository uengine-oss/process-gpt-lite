// 폴더에 정리 (server lib/folders/filing.js) — what one document's filing knows and does, shared by the line under a document
// (FolderSuggest.vue: a teammate's file in the messenger, a mail's attachment) and a chat file card's own menu (FileCardMenu.vue —
// the card keeps only a dot while a suggestion waits, 2026-11-28 「화면이 정신없으니 … 폴더 정리 등 모든 것들 콘텍스트 메뉴로」).
// The judge is asked once the document is on screen, once per document (the server keeps the verdict on its card).
import { reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'
import { useTeam } from '../../stores/team.js'

// a few at once over the whole page (a chat with many file cards asks one by one)
const queue = (globalThis.__filingQueue ||= { running: 0, waiting: [] })
const turn = (fn) => new Promise((resolve, reject) => {
  const go = () => { queue.running++; fn().then(resolve, reject).finally(() => { queue.running--; queue.waiting.shift()?.() }) }
  if (queue.running < 2) go(); else queue.waiting.push(go)
})

// target(): {messageId} (my file card) · {shareId} (a file sent to me) · {actionId, attachment} (a mail's attachment), or null (nothing to file)
// initial(): what the card already knows (its content.filing) — no request when it has a verdict
// el(): the element whose coming on screen asks the judge
export function useFiling(target, initial, el) {
  const router = useRouter()
  const app = useApp()
  const team = useTeam()
  const f = reactive({
    state: 'idle',            // idle | loading | ready | error
    sug: initial()?.suggestion || null,
    filed: initial()?.filed || null,
    err: '',
    busy: false,
    list: null,               // the folders 「다른 폴더 고르기」 offers
    newName: '',
  })
  f.where = computed(() => (f.sug?.folder ? `${f.sug.folder.name}${f.sug.sub ? `/${f.sug.sub}` : ''}` : ''))
  f.pct = computed(() => Math.round((f.sug?.confidence || 0) * 100))
  // a suggestion waiting for the person (the card's dot)
  f.pending = computed(() => !f.filed && !!(f.sug?.folder || f.sug?.newFolder))
  watch(initial, (x) => { if (x?.suggestion) f.sug = x.suggestion; if (x?.filed) f.filed = x.filed })

  const take = (r) => { if (r?.suggestion) f.sug = r.suggestion; if (r?.filed) f.filed = r.filed }
  f.load = async () => {
    const to = target()
    if (!to || f.state !== 'idle') return
    if (f.filed || (f.sug && (f.sug.folder || f.sug.newFolder))) { f.state = 'ready'; return }
    f.state = 'loading'
    try { take(await turn(() => api('/filing/suggest', { method: 'POST', body: to }))); f.state = 'ready' } catch (e) { f.err = e.message; f.state = 'error' }
  }
  // true when it was filed
  f.fileIt = async (to) => {
    f.busy = true; f.err = ''
    try { take(await api('/filing/file', { method: 'POST', body: { ...target(), ...to } })); return !!f.filed } catch (e) { f.err = e.message; return false } finally { f.busy = false }
  }
  f.loadList = async () => {
    if (f.list) return
    const q = new URLSearchParams(Object.entries(target() || {}).filter(([, v]) => v))
    try { f.list = await api(`/filing/folders?${q}`) } catch (e) { f.list = []; f.err = e.message }
    f.newName ||= f.sug?.newFolder?.name || ''
  }
  f.openFolder = () => {
    const x = f.filed
    if (!x) return
    // the floating messenger goes away; a docked one stays beside the folder (src/messengerDock.js)
    if (team.dockNow === 'float') team.open = false
    app.mailCard = null
    router.push({ path: `/folders/${encodeURIComponent(x.slug)}`, query: { file: x.path } })
  }

  // (a card whose file comes after it is drawn — its address published later — is asked then, if it is on screen by now)
  let io = null, inView = false
  onMounted(() => {
    const node = el()
    if (!('IntersectionObserver' in window) || !node) { inView = true; return f.load() }
    io = new IntersectionObserver((es) => {
      inView = es.some((x) => x.isIntersecting)
      if (inView && target()) { io?.disconnect(); io = null; f.load() }
    })
    io.observe(node)
  })
  watch(() => !!target(), (ok) => { if (ok && inView) f.load() })
  onBeforeUnmount(() => io?.disconnect())
  return f
}
