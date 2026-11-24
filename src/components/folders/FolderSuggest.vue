<script setup>
// 폴더에 정리 (server lib/folders/filing.js): under a document that came in — a file card in the chat (attached or made by the
// agent), a file a teammate sent in the messenger, a mail's attachment — the judge's folder: 「‘견적서’에 정리할까요? (확신 87%)」,
// one press files it there; 「새 폴더 만들기: …」 when nothing fits; 「다른 폴더 고르기」 to pick by hand. Asked only once the line is
// on screen, and once per document (the server keeps the verdict on its card); a filed one says where: 「‘견적서’에 정리했어요 · 열기」.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'
import { useTeam } from '../../stores/team.js'

// one of: messageId (my file card) · shareId (a file sent to me) · actionId + attachment (a mail's attachment)
// filing: what the card already knows (its content.filing) — no request when it has a verdict
// label: which file this line is about, where one message carries several
const props = defineProps({ messageId: String, shareId: String, actionId: String, attachment: String, filing: Object, compact: Boolean, label: String })
const router = useRouter()
const app = useApp()
const team = useTeam()
const el = ref(null)
const state = ref('idle')          // idle | loading | ready | error
const sug = ref(props.filing?.suggestion || null)
const filed = ref(props.filing?.filed || null)
const err = ref('')
const busy = ref(false)
const picking = ref(false)
const list = ref(null)
const newName = ref('')

const ref_ = computed(() => (props.messageId ? { messageId: props.messageId } : props.shareId ? { shareId: props.shareId } : { actionId: props.actionId, attachment: props.attachment }))
const where = computed(() => (sug.value?.folder ? `${sug.value.folder.name}${sug.value.sub ? `/${sug.value.sub}` : ''}` : ''))
const pct = computed(() => Math.round((sug.value?.confidence || 0) * 100))
watch(() => props.filing, (f) => { if (f?.suggestion) sug.value = f.suggestion; if (f?.filed) filed.value = f.filed })

// a few at once over the whole page (a chat with many file cards asks one by one)
const queue = (globalThis.__filingQueue ||= { running: 0, waiting: [] })
const turn = (fn) => new Promise((resolve, reject) => {
  const go = () => { queue.running++; fn().then(resolve, reject).finally(() => { queue.running--; queue.waiting.shift()?.() }) }
  if (queue.running < 2) go(); else queue.waiting.push(go)
})
const take = (r) => { if (r?.suggestion) sug.value = r.suggestion; if (r?.filed) filed.value = r.filed }
async function load() {
  if (state.value !== 'idle') return
  if (filed.value || (sug.value && (sug.value.folder || sug.value.newFolder))) { state.value = 'ready'; return }
  state.value = 'loading'
  try { take(await turn(() => api('/filing/suggest', { method: 'POST', body: ref_.value }))); state.value = 'ready' } catch (e) { err.value = e.message; state.value = 'error' }
}
let io = null
onMounted(() => {
  if (!('IntersectionObserver' in window)) return load()
  io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); io = null; load() } })
  if (el.value) io.observe(el.value)
})
onBeforeUnmount(() => io?.disconnect())

async function fileIt(to) {
  busy.value = true; err.value = ''
  try { take(await api('/filing/file', { method: 'POST', body: { ...ref_.value, ...to } })); picking.value = false } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function openPicker() {
  picking.value = !picking.value
  if (!picking.value || list.value) return
  const q = new URLSearchParams(Object.entries(ref_.value).filter(([, v]) => v))
  try { list.value = await api(`/filing/folders?${q}`) } catch (e) { list.value = []; err.value = e.message }
  newName.value = sug.value?.newFolder?.name || ''
}
function openFolder() {
  const f = filed.value
  // the floating messenger goes away; a docked one stays beside the folder (src/messengerDock.js)
  if (team.dockNow === 'float') team.open = false
  app.mailCard = null
  router.push({ path: `/folders/${encodeURIComponent(f.slug)}`, query: { file: f.path } })
}
</script>

<template>
  <div ref="el" class="fsg" :class="{ compact }" data-test="folder-suggest" :data-state="filed ? 'filed' : state" @click.stop>
    <template v-if="filed">
      <span class="tx"><Icon name="check" :size="14" /><span v-if="label" class="lb" data-no-i18n>{{ label }} →</span><span data-test="filing-done">{{ filed.already ? `이미 ‘${filed.name}’에 있어요` : `‘${filed.name}’에 정리했어요` }}</span></span>
      <button class="lnk press" data-test="filing-open" @click="openFolder">열기</button>
    </template>
    <template v-else-if="state === 'loading'">
      <span class="tx muted"><Icon name="folder" :size="14" />폴더에 정리 · 알맞은 폴더를 찾는 중…</span>
    </template>
    <template v-else-if="sug?.folder">
      <span class="tx"><Icon name="folder" :size="14" /><span v-if="label" class="lb" data-no-i18n>{{ label }} →</span><span data-test="filing-say">‘{{ where }}’에 정리할까요? <small>(확신 {{ pct }}%)</small></span></span>
      <button class="go press" data-test="filing-go" :disabled="busy" @click="fileIt({ slug: sug.folder.slug, sub: sug.sub || '' })">{{ busy ? '정리하는 중…' : '정리' }}</button>
      <button class="lnk press" data-test="filing-other" @click="openPicker">다른 폴더 고르기</button>
    </template>
    <template v-else-if="sug?.newFolder">
      <span class="tx"><Icon name="folder" :size="14" /><span v-if="label" class="lb" data-no-i18n>{{ label }} →</span><span data-test="filing-say">새 폴더 만들기: <b>{{ sug.newFolder.name }}</b></span></span>
      <button class="go press" data-test="filing-new" :disabled="busy" @click="fileIt({ newFolder: sug.newFolder.name })">{{ busy ? '만드는 중…' : '만들고 정리' }}</button>
      <button class="lnk press" data-test="filing-other" @click="openPicker">다른 폴더 고르기</button>
    </template>
    <template v-else>
      <span class="tx muted"><Icon name="folder" :size="14" />폴더에 정리</span>
      <button v-if="state !== 'idle'" class="lnk press" data-test="filing-other" @click="openPicker">폴더 고르기</button>
    </template>
    <small v-if="err" class="err" data-test="filing-error">{{ err }}</small>
    <div v-if="picking && !filed" class="pick" data-test="filing-pick">
      <p v-if="list && !list.length" class="none">정리할 수 있는 폴더가 없어요(편집 권한이 있는 폴더만).</p>
      <button v-for="f in list || []" :key="f.slug" class="row press" :disabled="busy" @click="fileIt({ slug: f.slug })"><Icon name="folder" :size="14" /> {{ f.name }}</button>
      <form class="nf" @submit.prevent="newName.trim() && fileIt({ newFolder: newName.trim() })">
        <input v-model="newName" placeholder="새 폴더 이름" maxlength="40" data-test="filing-new-name" />
        <button class="go press" type="submit" :disabled="busy || !newName.trim()">새 폴더에 정리</button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.fsg { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; max-width: 560px; font-size: 12.5px; color: var(--text-secondary); }
.tx { min-width: 0; color: var(--text-primary); overflow-wrap: anywhere; }
.tx > :deep(svg) { display: inline-block; vertical-align: -2px; margin-right: 5px; opacity: .8; }
.tx.muted { color: var(--text-secondary); }
.tx small { color: var(--text-secondary); }
.tx .lb { margin-right: 5px; color: var(--text-secondary); }
.go { height: 26px; padding: 0 11px; border-radius: 13px; font-size: 12.5px; font-weight: 500; background: #2a78d6; color: #fff; }
.go:disabled { opacity: .55; }
.lnk { height: 26px; padding: 0 6px; border-radius: 8px; font-size: 12.5px; color: #2a78d6; background: transparent; }
.err { flex-basis: 100%; color: #c62828; }
.pick { flex-basis: 100%; display: flex; flex-direction: column; gap: 4px; margin-top: 4px; padding: 8px; border-radius: 14px; background: var(--field-bg, rgba(127, 127, 127, .1)); }
.pick .row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; padding: 7px 8px; border-radius: 10px; font-size: 13px; color: var(--text-primary); }
.pick .row:hover { background: rgba(127, 127, 127, .12); }
.pick .none { margin: 2px 4px; }
.nf { display: flex; gap: 6px; margin-top: 2px; }
.nf input { flex: 1; min-width: 0; height: 30px; padding: 0 10px; border-radius: 10px; border: 1px solid rgba(127, 127, 127, .3); background: transparent; color: var(--text-primary); font-size: 13px; }
.compact { font-size: 12px; }
</style>
