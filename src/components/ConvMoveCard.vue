<script setup>
// 「이 대화를 프로젝트로 옮길까요?」 — 말로 한 「이 대화 프로젝트로 옮겨 줘」(채팅의 라우터가 move_to_project 를 고름 — server lib/conversationMove.js
// offerByWords, spec thread-to-project). Nothing moves from here: its buttons open the same picker and the same notice as the conversation
// bar's 「프로젝트로 옮기기」 (ConversationMoveSheet.vue) — straight at the confirmation for the project the person named, when the judge read
// one. The card goes along with the conversation and says where it went.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { topicPath } from '../projectTopics.js'
import { ro } from '../josa.js'
import { api } from '../api.js'

const props = defineProps({ msg: Object })
const app = useApp()
const router = useRouter()
const c = computed(() => props.msg.content || {})
const busy = ref(false)
const err = ref('')
const state = computed(() => c.value.state || 'offered')
const named = computed(() => c.value.suggest?.title ? `「${c.value.suggest.title}」${ro(`「${c.value.suggest.title}」`)} 옮기기` : '')
function openSheet(project = null) {
  const m = c.value.moveOf || {}
  app.moveSheet = { conv: m.id, title: m.title, count: m.count, ...(project ? { project } : {}) }
}
// 「아니요」: the card says so (server lib/conversationMove.js declineCard)
async function no() {
  busy.value = true; err.value = ''
  try { await api(`/conv-move-cards/${props.msg.id}/decline`, { method: 'POST' }) } catch (e) { err.value = e.message } finally { busy.value = false }
}
const open = () => c.value.project?.id && router.push(topicPath(c.value.project.id, c.value.moveOf?.id))
</script>

<template>
  <div class="cmv glass" data-test="conv-move-card" :data-state="state">
    <header>
      <span class="pi"><Icon name="folder" :size="17" /></span>
      <div class="ph">
        <b>{{ state === 'moved' ? '대화를 프로젝트로 옮겼어요' : state === 'declined' ? '옮기지 않았어요' : '이 대화를 프로젝트로 옮길까요?' }}</b>
        <small v-if="state === 'offered'">아직 옮기지 않았어요 · 프로젝트를 고르고 확인하면 옮겨요</small>
      </div>
    </header>
    <p class="conv"><span data-no-i18n>「{{ c.moveOf?.title }}」</span> · 메시지 {{ c.moveOf?.count || 0 }}개</p>
    <template v-if="state === 'offered'">
      <p v-if="err" class="err" role="alert">{{ err }}</p>
      <footer>
        <button class="sub press" :disabled="busy" data-test="conv-move-no" @click="no">아니요</button>
        <button v-if="named" class="sub press" :disabled="busy" data-test="conv-move-pick" @click="openSheet()">다른 프로젝트 고르기</button>
        <button v-if="named" class="go press" :disabled="busy" data-test="conv-move-named" :data-project="c.suggest.id" @click="openSheet(c.suggest.id)"><span>{{ named }}</span></button>
        <button v-else class="go press" :disabled="busy" data-test="conv-move-pick" @click="openSheet()">프로젝트 고르기</button>
      </footer>
    </template>
    <div v-else-if="state === 'moved'" class="done">
      <p>프로젝트 <b data-no-i18n>「{{ c.project?.title }}」</b></p>
      <button class="go press" data-test="conv-move-open" @click="open">열기 <Icon name="chevron" :size="13" /></button>
    </div>
  </div>
</template>

<style scoped>
.cmv { width: min(560px, 100%); box-sizing: border-box; border-radius: 22px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; color: var(--text-primary); }
header { display: flex; align-items: flex-start; gap: 10px; }
.pi { width: 32px; height: 32px; border-radius: 11px; display: grid; place-items: center; background: var(--field-bg); flex: none; }
.ph { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ph b { font-size: 15px; font-weight: 600; }
.ph small { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
.conv { margin: 0; font-size: 13.5px; overflow-wrap: anywhere; }
.err { margin: 0; color: var(--color-error, #c62828); font-size: 12.5px; overflow-wrap: anywhere; }
footer { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.sub { height: 36px; padding: 0 14px; border-radius: 18px; background: var(--field-bg); font-size: 13.5px; }
.go { height: 36px; padding: 0 16px; border-radius: 18px; background: var(--text-primary); color: var(--ink-inverse, #fff); font-size: 13.5px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; max-width: 100%; }
.go span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.go:disabled, .sub:disabled { opacity: .5; }
.done { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.done p { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
</style>
