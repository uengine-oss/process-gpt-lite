<script setup>
// 프로세스 지도에서 문서 하나를 이음오피스로 보기(읽기만) — 메일에서 남겨 둔 양식 파일, 건의 단계가 만든 파일.
// 파일 미리보기(FilePreview → FileView)와 같은 길: 스토리지에 올린 사본의 주소를 받아 OfficeEditorFrame 을 read-only 로 연다.
// url 이 있으면 그대로, 없으면 load() 가 {name, url} 을 준다(서버가 사본을 올림). 지도 화면에도 채팅 화면에도 그대로 뜬다(body 로 Teleport).
import { ref, onMounted, onBeforeUnmount } from 'vue'
import OfficeEditorFrame from '../OfficeEditorFrame.vue'
import { officeEditorFor } from '../../officeEditor.js'

const props = defineProps({ name: { type: String, default: '' }, url: { type: String, default: '' }, load: { type: Function, default: null }, note: { type: String, default: '' } })
const emit = defineEmits(['close'])
const doc = ref(props.url ? { name: props.name, url: props.url } : null)
const err = ref('')
const maximized = ref(false)
onMounted(async () => {
  window.addEventListener('keydown', onKey)
  if (doc.value || !props.load) return
  try { doc.value = await props.load() } catch (e) { err.value = e.message }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
function onKey(e) { if (e.key === 'Escape') emit('close') }
const openable = (d) => !!officeEditorFor(d?.name || d?.url)
</script>

<template>
  <Teleport to="body">
    <div class="veil" :class="{ max: maximized }" data-testid="onto-doc-sheet" @click.self="emit('close')">
      <div class="sheet" :class="{ max: maximized }">
        <p v-if="note && !maximized" class="note">{{ note }}</p>
        <p v-if="err" class="msg err">파일을 열지 못했어요. {{ err }}</p>
        <p v-else-if="!doc" class="msg">여는 중…</p>
        <template v-else-if="openable(doc)">
          <OfficeEditorFrame class="frame" :file-url="doc.url" :name="doc.name" read-only v-model:maximized="maximized" @close="emit('close')" />
        </template>
        <p v-else class="msg">이 파일은 이음오피스로 열 수 없어요. <a :href="doc.url" target="_blank" rel="noopener">내려받기</a></p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 210; background: rgba(20, 24, 32, .28); display: flex; justify-content: center; align-items: stretch; padding: 56px 16px 16px; }
.veil.max { padding: 0; }
.sheet { position: relative; width: min(1080px, 100%); border-radius: 18px; overflow: hidden; display: flex; flex-direction: column; background: #fff; box-shadow: 0 18px 60px rgba(0, 0, 0, .25); }
.sheet.max { width: 100%; border-radius: 0; }
.frame { flex: 1; min-height: 0; }
.note { margin: 0; padding: 8px 14px; font-size: 12.5px; color: #3c4043; background: #f1f4f9; border-bottom: 1px solid rgba(0, 0, 0, .06); }
.msg { margin: auto; padding: 24px; font-size: 14px; color: #5f6368; text-align: center; }
.msg.err { color: #c62828; }
@media (max-width: 760px) { .veil { padding: 40px 0 0; } .sheet { border-radius: 18px 18px 0 0; } }
</style>
