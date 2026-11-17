<script setup>
// 📎 in the composer: files, or — where a folder fits (채팅, a project without its own folder, 새 프로젝트) —
// a small menu with 「파일 첨부」 and 「폴더 붙이기」 (folders/FolderAttach.vue shows the list)
import { ref, computed, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import FIcon from './folders/FIcon.vue'
import { useApp } from '../stores/app.js'

const props = defineProps({ folders: Boolean })
const emit = defineEmits(['files'])
const app = useApp()
const open = ref(false)
const root = ref(null)
const newProject = computed(() => app.mode === 'project' && !app.activeId && !app.instance)
const offer = computed(() => props.folders && !app.instance && (newProject.value || app.active?.kind === 'chat' || (app.active?.kind === 'project' && app.active?.folder?.mode !== 'project')))
const outside = (e) => { if (!root.value?.contains(e.target)) close() }
function close() { open.value = false; document.removeEventListener('pointerdown', outside, true) }
function tap() {
  if (!offer.value) return emit('files')
  if (open.value) return close()
  open.value = true
  document.addEventListener('pointerdown', outside, true)
}
function files() { close(); emit('files') }
function folder() { close(); app.folderPicker = true }
onBeforeUnmount(close)
</script>

<template>
  <span ref="root" class="clip">
    <button class="ic press" aria-label="파일 첨부" :aria-expanded="offer ? open : undefined" :title="offer ? '파일 첨부 · 폴더 붙이기' : '파일 첨부 (끌어다 놓기·붙여넣기도 돼요)'" data-testid="composer-clip" @click="tap"><Icon name="clip" :size="19" /></button>
    <Transition name="fade">
      <div v-if="open" class="menu glass" role="menu">
        <button role="menuitem" @click="files"><Icon name="doc" :size="17" /><span>파일 첨부</span></button>
        <button role="menuitem" data-testid="menu-attach-folder" @click="folder"><FIcon name="folder" :size="17" /><span>{{ newProject ? '폴더 고르기' : '폴더 붙이기' }}</span></button>
      </div>
    </Transition>
  </span>
</template>

<style scoped>
.clip { position: relative; display: inline-flex; }
.ic { width: 36px; height: 36px; margin: 6px 2px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-secondary); }
.ic:hover { color: var(--text-primary); }
.menu { position: absolute; right: -4px; bottom: calc(100% + 6px); z-index: 30; border-radius: 16px; padding: 6px; display: flex; flex-direction: column; min-width: 168px;
  box-shadow: var(--shadow-card); --regular-bg: var(--regular-solid-bg); }
.menu button { display: flex; align-items: center; gap: 10px; text-align: left; min-height: 44px; padding: 10px 12px; border-radius: 10px; font-size: 14.5px; color: var(--text-primary); white-space: nowrap; }
.menu button:hover { background: var(--cell-bg); }
</style>
