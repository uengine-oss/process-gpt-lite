<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import StepTimeline from './StepTimeline.vue'
import FormCard from './FormCard.vue'
import Icon from './Icon.vue'
import BpmnView from './BpmnView.vue'
import { api } from '../api.js'

// Chat card for a process definition: what it is, how it flows, and its start form.
const props = defineProps({ msg: Object })
const router = useRouter()
const c = computed(() => props.msg.content)
const def = ref(null)
const showFlow = ref(props.msg.content.mode === 'view')
const busy = ref(false)
const view = ref('list')
const err = ref('')
const humanCount = computed(() => def.value?.steps.filter((s) => s.kind === 'human').length || 0)
const agentCount = computed(() => def.value?.steps.filter((s) => s.kind === 'agent').length || 0)

onMounted(async () => { def.value = await api(`/processes/${encodeURIComponent(c.value.defId)}`) })

// the card often sits at the bottom of the chat, under the composer: an opened flow is brought into
// view, or the button seems to do nothing
const flowEl = ref(null)
async function toggleFlow() {
  showFlow.value = !showFlow.value
  if (!showFlow.value) return
  await nextTick()
  flowEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

async function start(values = {}) {
  busy.value = true
  err.value = ''
  try {
    await api(`/processes/${encodeURIComponent(c.value.defId)}/start`, { method: 'POST', body: { values, messageId: props.msg.id } })
  } catch (e) { err.value = '시작하지 못했어요. ' + e.message.slice(0, 80) } finally { busy.value = false }
}
</script>

<template>
  <div class="proc" :class="{ started: c.state === 'started' }">
    <div class="head">
      <span class="badge">프로세스</span>
      <h3 class="serif">{{ def?.name || c.name }}</h3>
      <p v-if="def?.description" class="desc">{{ def.description }}</p>
      <div v-if="def" class="meta">
        <span>{{ def.steps.filter((s) => !['start', 'end', 'event'].includes(s.kind)).length }}단계</span>
        <span v-if="humanCount">· 사람 {{ humanCount }}</span>
        <span v-if="agentCount">· 에이전트 {{ agentCount }}</span>
        <button class="flow-btn" :aria-expanded="showFlow" @click="toggleFlow">{{ showFlow ? '흐름 접기' : '흐름 보기' }}</button>
      </div>
    </div>
    <div v-if="def && showFlow" ref="flowEl" class="flow inner">
      <span class="seg"><button :class="{ on: view === 'list' }" @click="view = 'list'">목록</button><button :class="{ on: view === 'bpmn' }" @click="view = 'bpmn'">다이어그램</button></span>
      <StepTimeline v-if="view === 'list'" :steps="def.steps" />
      <BpmnView v-else :def-id="def.id" :height="300" class="dg" />
    </div>

    <template v-if="c.state === 'started'">
      <button class="go press" @click="router.push(`/projects/p/${encodeURIComponent(c.instId)}`)">
        <Icon name="check" :size="16" /> 시작됨 · {{ c.instName }} <Icon name="chevron" :size="14" />
      </button>
    </template>
    <template v-else-if="def">
      <FormCard v-if="def.startForm?.fields?.length" class="start-form" :fields="def.startForm.fields" :values="c.prefill || {}" submit-label="시작" :busy="busy" @submit="start" />
      <button v-else class="dark-btn start" :disabled="busy" @click="start()">{{ busy ? '시작하는 중…' : '시작' }}</button>
    </template>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.proc { width: 424px; max-width: 100%; border-radius: 24px; padding: 8px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); display: flex; flex-direction: column; gap: 8px; }
.head { padding: 12px 14px 6px; }
.badge { font-size: 12px; color: var(--text-secondary); letter-spacing: .04em; }
h3 { margin: 4px 0 6px; font-size: 23px; line-height: 1.3; font-weight: 400; letter-spacing: .01em; }
.desc { margin: 0 0 8px; font-size: 14px; line-height: 1.5; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.meta { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--text-secondary); }
.flow-btn { margin-left: auto; font-size: 13px; color: var(--text-primary); text-decoration: underline; text-underline-offset: 3px; }
.inner { background: var(--field-bg); border-radius: 16px; padding: 14px 14px 2px; }
/* the composer floats over the chat's bottom edge */
.flow { scroll-margin-bottom: 140px; }
.start-form { box-shadow: none; --bubble-agent-bg: transparent; max-width: none; padding: 6px 10px 10px; }
.start { margin: 4px 6px 6px; }
:root[data-theme="dark"] .start { background: #f5f5f7; color: #1d1d1f; }
.go { display: flex; align-items: center; gap: 8px; height: 44px; margin: 0 6px 6px; padding: 0 16px; border-radius: 9999px; background: var(--field-bg); font-size: 14px; font-weight: 500; }
.seg { display: inline-flex; padding: 2px; border-radius: 9999px; background: var(--regular-solid-bg); margin-bottom: 12px; }
.seg button { height: 26px; padding: 0 12px; border-radius: 9999px; font-size: 12px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.dg { margin: 0 -8px 12px; }
.err { color: var(--color-error); font-size: 13px; margin: 0 12px 8px; }
</style>
