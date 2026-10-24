<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { marked } from 'marked'
import Message from './Message.vue'
import Composer from './Composer.vue'
import EdgeBlur from './EdgeBlur.vue'
import { useApp } from '../stores/app.js'

const props = defineProps({ placeholder: String, emptyText: String, keepTop: Boolean })
const emit = defineEmits(['send', 'connect'])
const app = useApp()
const scroller = ref(null)
const list = computed(() => app.thread)
const draft = computed(() => app.drafts[app.activeId])
const status = computed(() => app.status[app.activeId] || (app.active?.status === 'working' ? '작업하는 중' : null))
const md = (t) => marked.parse(String(t || '').replace(/</g, '&lt;'), { breaks: true })
// hark: a quiet date line where the day changes, and "읽음" under the last thing the user said
const dayOf = (m) => new Date(m.created_at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })
const newDay = (i) => i > 0 && dayOf(list.value[i]) !== dayOf(list.value[i - 1])
const lastUser = computed(() => [...list.value].reverse().find((m) => m.role === 'user')?.id)
const seen = (m) => m.id === lastUser.value && (status.value || draft.value != null || list.value[list.value.length - 1]?.id !== m.id)
const needsInput = computed(() => app.active?.status === 'needs_input')
const working = computed(() => status.value || (draft.value === '' ? '생각하는 중' : null))
function toPending() {
  const el = scroller.value?.querySelector('.k-vault, .k-choice, .needs')
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

let stick = !props.keepTop
function onScroll() {
  const el = scroller.value
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 120
}
async function toBottom(force) {
  await nextTick()
  const el = scroller.value
  if (el && (stick || force)) el.scrollTo({ top: el.scrollHeight, behavior: force ? 'instant' : 'smooth' })
}
watch(() => [list.value.length, draft.value], () => toBottom(false))
watch(() => app.activeId, () => toBottom(!props.keepTop), { immediate: true })
</script>

<template>
  <section class="col">
    <EdgeBlur side="top" />
    <div ref="scroller" class="scroll msgs" :class="{ dim: app.panelMode }" @scroll="onScroll">
      <div class="inner">
        <slot name="header" />
        <p v-if="!list.length && emptyText" class="empty serif">{{ emptyText }}</p>
        <template v-for="(m, i) in list" :key="m.id">
          <div v-if="newDay(i)" class="day">{{ dayOf(m) }}</div>
          <Message :msg="m" @connect="emit('connect')" />
          <div v-if="seen(m)" class="seen">··· 읽음</div>
        </template>
        <div v-if="draft" class="row"><div class="bubble md" v-html="md(draft)" /></div>
      </div>
    </div>
    <EdgeBlur side="bottom" :height="120" />
    <div class="foot">
      <!-- what the agent is doing right now, above the composer (hark's "패널 만드는 중") -->
      <Transition name="pill"><div v-if="working" :key="working" class="working"><span class="shimmer-text">{{ working }}</span></div></Transition>
      <button v-if="needsInput" class="attn press" aria-label="조치 필요" @click="toPending"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z" /></svg></button>
      <Composer :placeholder="placeholder" @send="(t) => emit('send', t)" />
    </div>
  </section>
</template>

<style scoped>
.col { position: absolute; inset: 0; }
.msgs { position: absolute; inset: 0; padding: 96px 0 130px; transition: filter .5s, opacity .5s; }
.msgs.dim { filter: blur(14px); opacity: .55; pointer-events: none; }
.inner { width: 512px; max-width: calc(100% - 32px); margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.empty { text-align: center; color: var(--text-secondary); font-size: 22px; margin-top: 30vh; line-height: 1.4; }
.row { animation: blur-in .4s var(--spring) both; }
.bubble { max-width: 424px; border-radius: 24px; padding: 13px 18px; line-height: 1.6; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); }
.md :deep(p) { margin: 0 0 .6em; } .md :deep(p:last-child) { margin: 0; }
.status { font-size: 15px; padding: 4px 6px; color: var(--text-tertiary); }
.day { text-align: center; font-size: 12.5px; color: var(--text-tertiary); margin: 6px 0 -4px; }
.seen { align-self: flex-end; font-size: 12px; color: var(--text-tertiary); margin: -8px 6px 0; }
.attn { position: absolute; right: calc(100% + 10px); bottom: 6px; width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; background: var(--color-attention); color: #fff; box-shadow: 0 4px 16px rgba(0 0 0 / .18); animation: pop-in .4s var(--spring); }
@media (max-width: 760px) { .foot:has(.attn) { padding-left: 56px; } .attn { right: auto; left: 0; } }
.working { position: absolute; left: 4px; bottom: calc(100% + 12px); height: 38px; padding: 0 18px; border-radius: 19px; display: inline-flex; align-items: center;
  border: 1px solid var(--hairline, rgba(127, 127, 127, .3)); background: rgba(127, 127, 127, .06); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); font-size: 14.5px; color: var(--text-tertiary); white-space: nowrap; }
.pill-enter-active, .pill-leave-active { transition: opacity .25s, translate .25s; }
.pill-enter-from, .pill-leave-to { opacity: 0; translate: 0 6px; }
.foot { position: absolute; z-index: 6; left: 50%; bottom: 32px; translate: -50% 0; width: 512px; max-width: calc(100% - 32px); }
</style>
