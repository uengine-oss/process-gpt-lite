<script setup>
// One file's content, shared by the agent workroom and the shared-folder preview: text and code
// (editable when the host allows it), markdown, CSV, images, video, audio, and office documents /
// CAD / design / media in their editors (IeumOffice read-only, ArtCraft). The host supplies the
// bytes: `text` for text files, `url` for media (same-origin is fine), and `editorUrl()` for the
// editors, which load from storage (a published copy).
import { ref, computed, watch } from 'vue'
import { marked } from 'marked'
import OfficeEditorFrame from '../OfficeEditorFrame.vue'
import CraftEditorFrame from '../CraftEditorFrame.vue'
import { viewOf, baseName, highlight, parseCsv } from '../folders/fileKind.js'

const props = defineProps({
  path: { type: String, required: true },
  text: { type: String, default: null },       // contents of a text file
  url: { type: String, default: '' },          // media the browser loads directly
  editorUrl: { type: Function, default: null }, // async () => storage URL for office / ArtCraft editors
  editable: { type: Boolean, default: false },  // text files: edit in place (emit 'save')
  mode: { type: String, default: 'preview' },   // 'preview' | 'edit' (text files)
  dark: { type: Boolean, default: false },
})
const emit = defineEmits(['save', 'dirty'])

const view = computed(() => {
  const v = viewOf(props.path)
  // SVG and PSD open in VectorCraft / PhotoCraft; a light <img> is enough for the others
  if (v === 'image' && /\.(svg|psd)$/i.test(props.path)) return 'craft'
  return v === 'none' && props.text != null ? 'text' : v
})
const isText = computed(() => ['markdown', 'code', 'text', 'csv'].includes(view.value))
const draft = ref('')
watch(() => [props.path, props.text], () => { draft.value = props.text ?? '' }, { immediate: true })
const dirty = computed(() => isText.value && draft.value !== (props.text ?? ''))
watch(dirty, (d) => emit('dirty', d))
const editing = computed(() => props.editable && isText.value && (props.mode === 'edit' || ['code', 'text'].includes(view.value)))
function onKey(e) { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty.value) emit('save', draft.value) } }

const html = computed(() => (view.value === 'markdown' ? marked.parse(draft.value) : ''))
const codeLines = computed(() => draft.value.replace(/\n$/, '').split('\n'))
const csv = computed(() => (view.value === 'csv' ? parseCsv(draft.value) : []))
const lines = computed(() => Math.max(1, draft.value.split('\n').length))

// office documents and ArtCraft files: ask the host for a storage URL once per file
const frameUrl = ref('')
const frameErr = ref('')
watch(() => [props.path, view.value], async () => {
  frameUrl.value = ''; frameErr.value = ''
  if (!['office', 'craft'].includes(view.value)) return
  try { frameUrl.value = props.editorUrl ? await props.editorUrl() : props.url }
  catch (e) { frameErr.value = `편집기로 열 파일을 준비하지 못했어요: ${e.message}` }
}, { immediate: true })
defineExpose({ draft, dirty })
</script>

<template>
  <div class="fv" :class="[view, { dark }]">
    <template v-if="view === 'office' || view === 'craft'">
      <p v-if="frameErr" class="none">{{ frameErr }}</p>
      <p v-else-if="!frameUrl" class="none">여는 중…</p>
      <OfficeEditorFrame v-else-if="view === 'office'" class="frame" :file-url="frameUrl" :name="baseName(path)" read-only />
      <CraftEditorFrame v-else class="frame" :file-url="frameUrl" :name="baseName(path)" />
    </template>
    <div v-else-if="editing" class="ed">
      <pre class="gut">{{ Array.from({ length: lines }, (_, i) => i + 1).join('\n') }}</pre>
      <textarea v-model="draft" class="code" spellcheck="false" @keydown="onKey" />
    </div>
    <div v-else-if="view === 'markdown'" class="mdv" v-html="html" />
    <div v-else-if="view === 'code' || view === 'text'" class="codev">
      <div v-for="(l, i) in codeLines" :key="i" class="ln"><span class="no">{{ i + 1 }}</span><span class="tx" v-html="view === 'code' ? highlight(l) : l.replace(/&/g, '&amp;').replace(/</g, '&lt;')" /></div>
    </div>
    <div v-else-if="view === 'csv'" class="tbl">
      <table><thead><tr><th v-for="(h, i) in csv[0]" :key="i">{{ h }}</th></tr></thead>
        <tbody><tr v-for="(r, i) in csv.slice(1)" :key="i"><td v-for="(c, j) in r" :key="j">{{ c }}</td></tr></tbody></table>
    </div>
    <div v-else-if="view === 'image'" class="media checker"><img :src="url" :alt="baseName(path)" /></div>
    <div v-else-if="view === 'video'" class="media blk"><video :src="url" controls /></div>
    <div v-else-if="view === 'audio'" class="media"><audio :src="url" controls /></div>
    <p v-else class="none">미리 볼 수 없는 형식이에요. '원본' 으로 받아 보세요.</p>
  </div>
</template>

<style scoped>
.fv { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: auto; background: #fff; color: #1f2328; }
.fv.office, .fv.craft { overflow: hidden; }
.frame { flex: 1; }
.frame :deep(.bar .name), .frame :deep(.bar .ic) { display: none; }
.ed { flex: 1; min-height: 0; display: flex; overflow: auto; }
.gut { margin: 0; padding: 12px 8px 12px 12px; text-align: right; color: #a9a9a2; font: 12.5px/1.6 "SF Mono", Menlo, monospace; user-select: none; background: #fafaf8; }
.code { flex: 1; border: 0; outline: 0; resize: none; padding: 12px 14px; font: 12.5px/1.6 "SF Mono", Menlo, monospace; white-space: pre; overflow: visible; min-height: 100%; color: inherit; background: transparent; }
.mdv { padding: 26px 40px; max-width: 920px; font-size: 15px; line-height: 1.75; }
.mdv :deep(h1) { font-size: 26px; margin: 4px 0 14px; padding-bottom: 10px; border-bottom: 1px solid rgba(127, 127, 127, .25); }
.mdv :deep(h2) { font-size: 19px; margin: 24px 0 8px; }
.mdv :deep(code) { padding: 1px 6px; border-radius: 6px; background: rgba(127, 127, 127, .14); font-size: .9em; }
.mdv :deep(pre) { padding: 14px 16px; border-radius: 10px; background: rgba(127, 127, 127, .12); overflow: auto; }
.mdv :deep(pre code) { background: none; padding: 0; }
.mdv :deep(table) { border-collapse: collapse; } .mdv :deep(th), .mdv :deep(td) { border: 1px solid rgba(127, 127, 127, .3); padding: 6px 12px; }
.codev { padding: 12px 0; font: 12.5px/1.7 "SF Mono", Menlo, monospace; }
.ln { display: flex; white-space: pre; }
.no { flex: none; width: 46px; padding-right: 12px; text-align: right; color: #a9a9a2; user-select: none; }
.tx :deep(.k) { color: #cf222e; font-style: normal; } .tx :deep(.s) { color: #0a3069; font-style: normal; } .tx :deep(.c) { color: #6e7781; font-style: italic; } .tx :deep(.n) { color: #0550ae; font-style: normal; }
.tbl { padding: 16px; }
table { border-collapse: collapse; font-size: 13.5px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(127, 127, 127, .25); white-space: nowrap; }
th { font-weight: 600; opacity: .7; font-size: 12.5px; }
.media { flex: 1; min-height: 0; display: grid; place-items: center; padding: 20px; }
.media img, .media video { max-width: 100%; max-height: 100%; border-radius: 8px; }
.checker { background: repeating-conic-gradient(rgba(127 127 127 / .12) 0 25%, transparent 0 50%) 0 0 / 20px 20px; }
.blk { background: #111; }
.none { margin: auto; padding: 24px; opacity: .65; font-size: 14px; }
/* the workroom's dark theme (agent-share) */
.fv.dark { background: #1b1d24; color: #d8dbe2; }
.fv.dark .gut { background: #191b21; color: #5d6370; }
.fv.dark .tx :deep(.k) { color: #ff7b72; } .fv.dark .tx :deep(.s) { color: #a5d6ff; } .fv.dark .tx :deep(.c) { color: #8b949e; } .fv.dark .tx :deep(.n) { color: #79c0ff; }
.fv.dark .mdv :deep(h1), .fv.dark .mdv :deep(h2) { color: #8ab4ff; }
</style>
