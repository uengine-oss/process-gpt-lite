<script setup>
// The composer's folder: on 새 프로젝트 the folder the project will work in (its own variation of it),
// in a chat the folder attached for reference (📎 폴더 붙이기) — 「참고」, or 「변형 작업 중」 while a change
// asked of it waits in a variation. The list opens from the chip or from the 📎 menu (app.folderPicker).
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import FIcon from './FIcon.vue'
import { useApp } from '../../stores/app.js'
import { folders as F } from '../../foldersApi.js'

const app = useApp()
const router = useRouter()
const newProject = computed(() => app.mode === 'project' && !app.activeId && !app.instance)
const link = computed(() => (newProject.value ? null : app.active?.folder || null))
const chosen = computed(() => (newProject.value ? app.newProjectFolder : null))
const list = ref(null)
const loading = ref(false)
const error = ref('')
const naming = ref(false)
const newName = ref('')
const nameBox = ref(null)

// a project's folder needs a role that may make a variation; a reference only reading
const CAN_VARY = ['owner', 'editor', 'runner']
const shown = computed(() => (list.value || []).filter((f) => !newProject.value || CAN_VARY.includes(f.role)))

watch(() => app.folderPicker, async (open) => {
  if (!open) { naming.value = false; error.value = ''; return }
  loading.value = true
  try { list.value = await F.list() } catch (e) { error.value = e.message } finally { loading.value = false }
}, { immediate: true })
// leaving the screen closes the list
watch(() => [app.activeId, app.mode], () => { app.folderPicker = false })

async function pick(f) {
  error.value = ''
  if (newProject.value) { app.newProjectFolder = { id: f.id, slug: f.slug, name: f.name }; app.folderPicker = false; return }
  try { await app.attachFolder(f); app.folderPicker = false } catch (e) { error.value = e.message }
}
async function startNaming() { naming.value = true; await nextTick(); nameBox.value?.focus() }
function makeNew() {
  const n = newName.value.trim()
  if (!n) return
  if ((list.value || []).some((f) => f.name === n)) { error.value = '같은 이름의 폴더가 이미 있어요.'; return }
  app.newProjectFolder = { newName: n, name: n }
  newName.value = ''
  app.folderPicker = false
}
async function remove() {
  if (newProject.value) { app.newProjectFolder = null; return }
  try { await app.detachFolder() } catch (e) { error.value = e.message }
}
function openVariation() { if (link.value?.working && link.value.variation?.url) router.push(link.value.variation.url) }
const roleText = { owner: '소유자', editor: '편집', runner: '실행', viewer: '보기' }
</script>

<template>
  <div class="fa">
    <!-- 새 프로젝트: pick the folder before starting -->
    <div v-if="newProject" class="chips">
      <span v-if="chosen" class="fchip glass-thin" data-testid="project-folder-chip">
        <FIcon name="folder" :size="15" /><b data-no-i18n>{{ chosen.name }}</b><small>{{ chosen.newName ? '· 새 폴더' : '· 이 폴더에서 작업' }}</small>
        <button class="x" aria-label="폴더 빼기" @click="remove">×</button>
      </span>
      <button v-else class="fchip pick glass-thin press" data-testid="project-folder-pick" @click="app.folderPicker = !app.folderPicker">
        <FIcon name="folder" :size="15" /><span>폴더 고르기</span><small>· 없어도 돼요</small>
      </button>
    </div>
    <!-- a chat's attached folder -->
    <div v-else-if="link?.mode === 'ref'" class="chips">
      <span class="fchip glass-thin" :class="{ working: link.working }" data-testid="chat-folder-chip">
        <button class="fname" :disabled="!link.working" :title="link.working ? '변형 보기' : link.name" @click="openVariation"><FIcon name="folder" :size="15" /><b data-no-i18n>{{ link.name }}</b></button>
        <small>{{ link.working ? '· 변형 작업 중' : '· 참고' }}</small>
        <button class="x" aria-label="폴더 떼기" @click="remove">×</button>
      </span>
    </div>

    <Transition name="fade">
      <div v-if="app.folderPicker" class="picker glass" role="dialog" :aria-label="newProject ? '프로젝트 폴더 고르기' : '폴더 붙이기'" data-testid="folder-picker">
        <div class="ph">
          <b>{{ newProject ? '이 프로젝트가 작업할 폴더' : '폴더 붙이기' }}</b>
          <button class="x" aria-label="닫기" @click="app.folderPicker = false">×</button>
        </div>
        <p class="hint">{{ newProject ? '프로젝트는 이 폴더의 변형에서 작업하고, 「반영」해야 원본에 들어가요.' : '에이전트가 이 폴더를 읽어요. 바꿔 달라고 할 때만 변형을 만들어요.' }}</p>
        <div class="rows">
          <p v-if="loading" class="muted">불러오는 중…</p>
          <p v-else-if="!shown.length && !naming" class="muted">{{ newProject ? '작업할 수 있는 폴더가 없어요. 새 폴더를 만들어 보세요.' : '쓸 수 있는 폴더가 없어요.' }}</p>
          <button v-for="f in shown" :key="f.id" class="row press" :class="{ on: link?.id === f.id || chosen?.id === f.id }" @click="pick(f)">
            <FIcon name="folder" :size="17" />
            <span class="nm" data-no-i18n>{{ f.name }}</span>
            <small>{{ roleText[f.role] || f.role }}</small>
          </button>
        </div>
        <template v-if="newProject">
          <form v-if="naming" class="new" @submit.prevent="makeNew">
            <input ref="nameBox" v-model="newName" maxlength="80" placeholder="새 폴더 이름" aria-label="새 폴더 이름" />
            <button class="mk press" :disabled="!newName.trim()">만들기</button>
          </form>
          <button v-else class="row add press" data-testid="folder-new" @click="startNaming"><span class="plus">＋</span><span class="nm">새 폴더</span></button>
        </template>
        <p v-if="error" class="err">{{ error }}</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fa { position: static; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.fchip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; height: 32px; padding: 0 6px 0 12px; border-radius: 16px; font-size: 13px; color: var(--text-primary); }
.fchip.pick { padding-right: 12px; color: var(--text-secondary); }
.fchip.pick:hover { color: var(--text-primary); }
.fchip b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 200px; }
.fchip small { color: var(--text-secondary); white-space: nowrap; flex: none; }
.fchip.working small { color: var(--color-info); }
.fname { display: inline-flex; align-items: center; gap: 6px; min-width: 0; cursor: default; }
.fchip.working .fname { cursor: pointer; }
.x { width: 22px; height: 22px; flex: none; border-radius: 11px; color: var(--text-secondary); font-size: 16px; line-height: 20px; }
.x:hover { color: var(--text-primary); }
.picker { position: absolute; left: 0; right: 0; bottom: calc(100% + 10px); z-index: 30; border-radius: 20px; padding: 12px; box-shadow: var(--shadow-card); --regular-bg: var(--regular-solid-bg);
  max-height: min(420px, 55vh); display: flex; flex-direction: column; }
.ph { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px 0 8px; font-size: 15px; }
.hint { margin: 4px 8px 8px; font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); }
.rows { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; }
.row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 8px 10px; border-radius: 12px; text-align: left; font-size: 14.5px; color: var(--text-primary); }
.row:hover, .row.on { background: var(--cell-bg); }
.row .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row small { color: var(--text-tertiary); font-size: 12px; flex: none; }
.row.add { color: var(--text-secondary); margin-top: 4px; border-top: 1px solid var(--hairline); border-radius: 0 0 12px 12px; }
.plus { width: 17px; text-align: center; }
.new { display: flex; gap: 8px; margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--hairline); }
.new input { flex: 1; min-width: 0; height: 40px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--cell-bg); padding: 0 12px; font-size: 14.5px; outline: 0; }
.mk { height: 40px; padding: 0 16px; border-radius: 12px; background: #1d1d1f; color: #fff; font-size: 14px; flex: none; }
:root[data-theme="dark"] .mk { background: #f5f5f7; color: #1d1d1f; }
.mk:disabled { opacity: .45; }
.muted { margin: 8px; font-size: 13.5px; color: var(--text-secondary); }
.err { margin: 8px 8px 0; font-size: 13px; color: var(--color-error); }
</style>
