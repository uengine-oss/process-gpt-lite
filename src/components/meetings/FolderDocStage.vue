<script setup>
// A shared folder's document on the meeting's stage — opened the way the folder screen opens it
// (FilePreview): text read from the folder, office documents and PDFs in the editor from a published copy,
// media straight from the folder. Each person reads it through their own folder access.
import { ref, computed, watch } from 'vue'
import FileView from '../files/FileView.vue'
import { folders as F, rawUrl } from '../../foldersApi.js'
import { viewOf } from '../folders/fileKind.js'

const props = defineProps({ folder: Object }) // material.folder: {slug, name, path}
const text = ref(null)
const err = ref('')
const isText = computed(() => ['markdown', 'code', 'text', 'csv', 'none'].includes(viewOf(props.folder.path)))
const url = computed(() => rawUrl(props.folder.slug, props.folder.path))
const editorUrl = () => F.publish(props.folder.slug, props.folder.path)
watch(() => props.folder.path, async () => {
  text.value = null; err.value = ''
  if (isText.value) try { text.value = await F.text(props.folder.slug, props.folder.path) } catch (e) { err.value = e.message }
}, { immediate: true })
</script>

<template>
  <p v-if="err" class="none">{{ err }}</p>
  <p v-else-if="isText && text === null" class="none">여는 중…</p>
  <FileView v-else :path="folder.path" :text="text" :url="url" :editor-url="editorUrl" mode="preview" />
</template>

<style scoped>
.none { margin: 24px; color: var(--text-tertiary); font-size: 13px; }
</style>
