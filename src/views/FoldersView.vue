<script setup>
// 공유 폴더
//   /folders                       폴더 목록·색인 검색
//   /folders/:slug                 폴더: main 파일 트리 + 변형 + 일괄 반영
//   /folders/:slug/v/:variation    변형: main 과의 차이, 인계, 반영
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
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

onMounted(async () => {
  app.mode = 'folders'
  if (!app.me) app.me = await api('/me').catch(() => null)
})
</script>

<template>
  <div class="folders">
    <TopBar />
    <div class="content" :class="{ scroll: !slug }">
      <VariationView v-if="vid" :key="vid" :slug="slug" :vid="vid" @preview="open" />
      <FolderDetail v-else-if="slug" :key="slug" :slug="slug" @preview="open" />
      <FolderList v-else @preview="open" />
    </div>
    <FilePreview v-if="preview" :file="preview.file" :folder="preview.folder" :ref_="preview.ref" :ref-label="preview.refLabel" @close="preview = null" />
  </div>
</template>

<style scoped>
.folders { position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.content.scroll { overflow-y: auto; }
</style>
