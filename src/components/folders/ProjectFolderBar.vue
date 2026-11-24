<script setup>
// A project's folder above its conversation: the folder, the project's variation (its turns and its
// process steps work there) and 「반영」 — the variation's review screen in 폴더, where it is merged into main.
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import FIcon from './FIcon.vue'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'
// a file of the app (a chat card, a received file, another folder's file — src/fileDrag.js) dropped on the bar goes into this folder's
// main, in my name (server lib/fileRefs.js dropInto) — the project's own files go in with 「반영」 instead
import { dragKind, itemsOf, zoneWords } from '../../fileDrag.js'
import { folders as F } from '../../foldersApi.js'

const props = defineProps({ thread: Object })
const app = useApp()
const router = useRouter()
const f = computed(() => props.thread?.folder)
const v = computed(() => f.value?.variation)
const live = computed(() => v.value && ['open', 'ready', 'conflicted'].includes(v.value.status))
const state = computed(() => {
  if (!v.value || !live.value) return '첫 작업 때 변형을 만들어요'
  if (v.value.status === 'open') return '에이전트가 작업하는 중'
  if (v.value.status === 'conflicted') return '반영하다 부딪친 곳이 있어요'
  return v.value.ahead ? `바뀐 것 ${v.value.ahead}건 · 반영 전` : '아직 바뀐 것 없음'
})
const canMerge = computed(() => live.value && v.value.status !== 'open' && (v.value.ahead > 0 || v.value.status === 'conflicted'))
// the payload in the list can be older than the folder (merged in 폴더, a turn just committed)
async function refresh() {
  const id = props.thread?.id
  if (!id) return
  const r = await api(`/threads/${id}/folder`).catch(() => null)
  if (r) app.setThreadFolder(id, r.folder)
}
onMounted(refresh)
const over = ref(false)
let depth = 0
const isPgl = (e) => dragKind(e.dataTransfer?.types) === 'pgl'
function enter(e) { if (!isPgl(e)) return; e.preventDefault(); e.stopPropagation(); depth++; over.value = true }
function move(e) { if (!isPgl(e)) return; e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy' }
function leave(e) { if (!isPgl(e)) return; if (--depth <= 0) { depth = 0; over.value = false } }
async function drop(e) {
  if (!isPgl(e)) return
  e.preventDefault(); e.stopPropagation(); depth = 0; over.value = false
  try {
    const r = await F.drop(f.value.slug, itemsOf(e))
    const done = r.items.filter((x) => x.ok), bad = r.items.filter((x) => !x.ok)
    app.notice = { text: [done.length ? `‘${f.value.name}’에 넣었어요 · ${done.map((x) => x.filed?.path).join(', ')}` : '', bad.map((x) => `${x.name || '파일'}: ${x.error}`).join(' · ')].filter(Boolean).join(' · ') }
  } catch (err) { app.notice = { text: err.message } }
}
watch(() => props.thread?.status, (s, was) => { if (was === 'working' && !s) refresh() })
</script>

<template>
  <div v-if="f" class="pfb glass-thin" :class="{ over }" data-testid="project-folder-bar" @dragenter="enter" @dragover="move" @dragleave="leave" @drop="drop">
    <span v-if="over" class="dropword" data-test="project-folder-drop">{{ zoneWords('folder') }}</span>
    <button class="fold press" :title="`${f.name} 폴더 열기`" @click="router.push(`/folders/${f.slug}`)">
      <FIcon name="folder" :size="17" /><b data-no-i18n>{{ f.name }}</b>
    </button>
    <span class="var">
      <FIcon name="branch" :size="15" />
      <span v-if="live" class="br" data-no-i18n>{{ v.branch }}</span>
      <small :class="{ busy: v?.status === 'open', warn: v?.status === 'conflicted' }">{{ state }}</small>
    </span>
    <button class="merge press" :disabled="!canMerge" data-testid="project-merge" :title="canMerge ? '검토하고 원본에 반영해요' : '반영할 변경이 아직 없어요'" @click="router.push(v.url)">
      <FIcon name="merge" :size="15" />반영
    </button>
  </div>
</template>

<style scoped>
.pfb.over { position: relative; outline: 2.5px dashed rgba(42, 120, 214, .75); outline-offset: -2px; background: rgba(42, 120, 214, .1); }
.dropword { position: absolute; right: 12px; top: 50%; translate: 0 -50%; z-index: 2; padding: 5px 12px; border-radius: 11px; font-size: 13px; font-weight: 600; color: #fff; background: #2a78d6; pointer-events: none; }
.pfb { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 8px 8px 8px 14px; border-radius: 20px; margin-bottom: 4px; font-size: 13.5px; }
.fold { display: inline-flex; align-items: center; gap: 7px; min-width: 0; max-width: 100%; color: var(--text-primary); }
.fold b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.var { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 160px; color: var(--text-secondary); }
.br { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 150px; }
.var small { font-size: 12.5px; white-space: nowrap; }
.var small.busy { color: var(--color-info); }
.var small.warn { color: var(--color-attention, #d97706); }
.merge { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 17px; margin-left: auto; background: #1d1d1f; color: #fff; font-size: 13.5px; font-weight: 500; flex: none; }
:root[data-theme="dark"] .merge { background: #f5f5f7; color: #1d1d1f; }
.merge:disabled { opacity: .35; cursor: default; }
/* phone: the folder on its own line, the state and 반영 under it (the branch name only on wide screens) */
@media (max-width: 560px) {
  .fold { flex-basis: 100%; }
  .br { display: none; }
}
</style>
