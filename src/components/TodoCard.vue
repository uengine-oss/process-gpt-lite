<script setup>
import StepOutputs from './mining/StepOutputs.vue'
import { ref, computed, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue'
import FormCard from './FormCard.vue'
import BriefCard from './BriefCard.vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// the step's own input screen (server lib/stepUi — A2UI, made for this case and step): its renderer loads only when one is shown
const A2uiSurface = defineAsyncComponent(() => import('./a2ui/A2uiSurface.vue'))

// A work item (todolist row) to fill in and submit. Used in chat and in the instance view.
// A step of a map case may come with an input screen the agent made for it (data.ui): shown instead of the form, read-only with
// what was handed in once it is; while it is being made, a short wait (data.uiState 'making'); a screen that cannot be made or drawn
// leaves the form as it always was.
const props = defineProps({ todoId: String, msgId: String, done: Boolean })
const emit = defineEmits(['submitted'])
const data = ref(null)
const busy = ref(false)
const err = ref('')
const sent = ref(props.done)
// a decision brief / hand-over prepared for this item (Agentic BPM, server lib/scenarios/purchase): shown above
// the form, and what it prepared fills the form (nothing typed again)
const brief = ref(null)
// the screen could not be drawn here, or the person chose the plain field: the form
const plain = ref(false)
// what was handed in through the screen (shown read-only)
const handed = ref(null)
const useUi = computed(() => !!data.value?.ui && !plain.value)
const making = computed(() => data.value?.uiState === 'making' && !plain.value)
const readonlyValues = computed(() => handed.value || data.value?.uiValues || null)

let timer = 0, waitedFrom = 0, alive = true, first = true
async function load() {
  const [d, b] = await Promise.all([api(`/todos/${props.todoId}`), first ? api(`/purchase/briefs/${props.todoId}?open=1`).catch(() => null) : null])
  first = false
  if (b?.brief?.state === 'ready') { brief.value = b.brief; d.values = { ...(b.brief.prefill || {}), ...Object.fromEntries(Object.entries(d.values || {}).filter(([, v]) => v !== '' && v != null)) } }
  data.value = d
  if (['DONE', 'SUBMITTED'].includes(d.todo.status)) sent.value = true
  // the screen is being made: look again shortly; past its wait, the form
  clearTimeout(timer)
  if (d.uiState === 'making' && !sent.value && alive) {
    waitedFrom ||= Date.now()
    if (Date.now() - waitedFrom > (d.uiWait || 60) * 1000) plain.value = true
    else timer = setTimeout(() => load().catch(() => {}), 1500)
  }
}
onMounted(() => load())
onBeforeUnmount(() => { alive = false; clearTimeout(timer) })
function decided() { sent.value = true; emit('submitted') }
async function submit(values, a2ui = null) {
  busy.value = true
  err.value = ''
  try {
    await api(`/todos/${props.todoId}/submit`, { method: 'POST', body: { values, messageId: props.msgId, ...(a2ui ? { a2ui } : {}) } })
    if (a2ui) handed.value = values
    sent.value = true
    emit('submitted')
  } catch (e) { err.value = '제출하지 못했어요. ' + e.message.slice(0, 160) } finally { busy.value = false }
}
</script>

<template>
  <div v-if="!data" class="loading shimmer-text">불러오는 중</div>
  <template v-else-if="sent">
    <A2uiSurface v-if="useUi && readonlyValues" readonly :message="data.ui" :values="readonlyValues" :title="data.todo.activity_name" :subtitle="data.instName" class="todo blur-in">
      <div class="sent-note"><Icon name="check" :size="15" /> 제출됨</div>
    </A2uiSurface>
    <div v-else class="sent blur-in"><Icon name="check" :size="16" /> {{ data.todo.activity_name }} 제출됨</div>
  </template>
  <div v-else class="todo">
    <StepOutputs :todo-id="data.todo.id" class="outs-top" />
    <BriefCard v-if="brief" :brief="brief" compact class="brief-top" @decided="decided" />
    <div v-if="making" class="making glass" data-test="a2ui-making">
      <b class="serif">{{ data.todo.activity_name }}</b>
      <p class="shimmer-text">이 단계에 맞는 입력 화면을 준비하고 있어요</p>
      <button class="link press" @click="plain = true">글로 바로 쓸게요</button>
    </div>
    <A2uiSurface v-else-if="useUi" :message="data.ui" :busy="busy" :title="data.todo.activity_name" :subtitle="data.instName" @submit="(e) => submit(e.values, e.a2ui)" @failed="plain = true" />
    <FormCard v-else-if="data.form?.fields?.length" :title="data.todo.activity_name" :subtitle="data.instName" :fields="data.form.fields" :values="data.values" :busy="busy" @submit="submit" />
    <div v-else class="plain glass">
      <b class="serif">{{ data.todo.activity_name }}</b>
      <p>{{ data.todo.description || '확인 후 완료로 표시하세요.' }}</p>
      <button class="dark-btn" :disabled="busy" @click="submit({})">완료</button>
    </div>
    <p v-if="err" class="err" data-test="todo-error">{{ err }}</p>
  </div>
</template>

<style scoped>
.todo { width: 424px; max-width: 100%; }
.loading { font-size: 14px; padding: 6px; }
.brief-top { margin-bottom: 10px; }
.sent { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 9999px; background: var(--bubble-user-bg); font-size: 14px; }
.sent-note { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--bubble-user-bg); font-size: 13px; }
.plain, .making { width: 424px; max-width: 100%; border-radius: 24px; padding: 18px; display: flex; flex-direction: column; gap: 8px; }
.plain b, .making b { font-size: 20px; font-weight: 400; }
.plain p { margin: 0 0 6px; color: var(--text-secondary); font-size: 14px; }
.making p { margin: 0; font-size: 14px; }
.making .link { align-self: flex-start; font-size: 13px; color: var(--text-secondary); text-decoration: underline; text-underline-offset: 3px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.err { color: var(--color-error); font-size: 13px; margin: 8px 6px 0; }
</style>
