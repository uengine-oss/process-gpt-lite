<script setup>
// The files earlier steps of this work item's instance produced, as chips that open where the reviewer
// is — IeumOffice for documents, the ArtCraft app for drawings (openArtifact). Opening one gives the
// reviewer their own file card, so their edits never touch the step's file.
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'
import { openArtifact, kindOf, kindLabel } from '../../artifacts.js'

const props = defineProps({ todoId: String })
const app = useApp()
const router = useRouter()
const files = ref([])
const busy = ref('')
onMounted(async () => { try { files.value = (await api(`/todos/${props.todoId}/outputs`)).files } catch { files.value = [] } })
async function open(f) {
  busy.value = f.url
  try { openArtifact(app, router, await api(`/todos/${props.todoId}/outputs/open`, { method: 'POST', body: { url: f.url } })) } finally { busy.value = '' }
}
</script>

<template>
  <div v-if="files.length" class="outs">
    <span class="lb">앞 단계 산출물</span>
    <button v-for="f in files" :key="f.url" class="chip press" :class="{ busy: busy === f.url }" :title="`${f.step} · ${f.name}`" @click.stop="open(f)">
      <span class="fic" :class="kindOf(f.name)">{{ kindLabel[kindOf(f.name)] || 'FILE' }}</span>{{ f.name }}
    </button>
  </div>
</template>

<style scoped>
.outs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; align-items: center; }
.lb { width: 100%; font-size: 12px; color: var(--text-secondary); }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px 0 4px; border-radius: 15px; background: rgba(0, 0, 0, .06); font-size: 13px; color: var(--text-primary); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip.busy { opacity: .6; }
.fic { flex: none; height: 22px; min-width: 30px; padding: 0 5px; border-radius: 11px; display: inline-grid; place-items: center; font-size: 10.5px; font-weight: 600; color: #fff; background: #6b7280; }
.fic.xls { background: #1d7a46; } .fic.hwp { background: #2b6fd6; } .fic.cad { background: #b4542a; } .fic.doc { background: #2b579a; } .fic.ppt { background: #c4502b; }
</style>
