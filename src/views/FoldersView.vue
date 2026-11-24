<script setup>
// 공유 폴더
//   /folders                       폴더 목록·색인 검색
//   /folders/:slug                 폴더: main 파일 트리 + 변형 + 일괄 반영
//   /folders/:slug/v/:variation    변형: main 과의 차이, 인계, 반영
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import FolderList from '../components/folders/FolderList.vue'
import FolderDetail from '../components/folders/FolderDetail.vue'
import VariationView from '../components/folders/VariationView.vue'
import FilePreview from '../components/folders/FilePreview.vue'
import { useApp } from '../stores/app.js'
import { api } from '../api.js'

const app = useApp()
const route = useRoute()
const slug = computed(() => route.params.slug || '')
const vid = computed(() => route.params.variation || '')
const preview = ref(null)   // { folder, file, ref, refLabel }
function open(p) { preview.value = { ref: 'main', ...p } }
// a document edited in place was saved into the folder: the file list and 이력 follow
const detail = ref(null)
const refresh = () => detail.value?.load?.()
// a document being edited in the preview is saved before the screen changes (false: it stays, said there)
const sheet = ref(null)
const leaving = async () => (preview.value && sheet.value?.leave ? sheet.value.leave() : true)
onBeforeRouteLeave(leaving)
onBeforeRouteUpdate(leaving)

onMounted(async () => {
  app.mode = 'folders'
  if (!app.me) app.me = await api('/me').catch(() => null)
})
// /folders/<slug>?file=<path>: the file opens in the preview (a document just filed there — 폴더에 정리 · 열기)
watch(() => [slug.value, route.query.file], async ([s, file]) => {
  if (!s || !file || vid.value) return
  const [folder, row] = await Promise.all([api(`/folders/${encodeURIComponent(s)}`).catch(() => null), api(`/folders/${encodeURIComponent(s)}/file?path=${encodeURIComponent(file)}`).catch(() => null)])
  if (folder && row && slug.value === s) open({ folder, file: { path: String(file), ...row } })
}, { immediate: true })
</script>

<template>
  <div class="folders">
    <TopBar />
    <div class="content" :class="{ scroll: !slug }">
      <VariationView v-if="vid" :key="vid" :slug="slug" :vid="vid" @preview="open" />
      <FolderDetail v-else-if="slug" ref="detail" :key="slug" :slug="slug" @preview="open" />
      <FolderList v-else @preview="open" />
    </div>
    <FilePreview v-if="preview" ref="sheet" :file="preview.file" :folder="preview.folder" :ref_="preview.ref" :ref-label="preview.refLabel" @close="preview = null" @changed="refresh" />
  </div>
</template>

<style scoped>
.folders { position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.content.scroll { overflow-y: auto; }
</style>
