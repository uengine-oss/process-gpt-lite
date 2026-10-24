<script setup>
import { ref, onMounted } from 'vue'
import FormCard from './FormCard.vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// A work item (todolist row) to fill in and submit. Used in chat and in the instance view.
const props = defineProps({ todoId: String, msgId: String, done: Boolean })
const emit = defineEmits(['submitted'])
const data = ref(null)
const busy = ref(false)
const err = ref('')
const sent = ref(props.done)

onMounted(async () => {
  data.value = await api(`/todos/${props.todoId}`)
  if (['DONE', 'SUBMITTED'].includes(data.value.todo.status)) sent.value = true
})
async function submit(values) {
  busy.value = true
  err.value = ''
  try {
    await api(`/todos/${props.todoId}/submit`, { method: 'POST', body: { values, messageId: props.msgId } })
    sent.value = true
    emit('submitted')
  } catch (e) { err.value = '제출하지 못했어요. ' + e.message.slice(0, 80) } finally { busy.value = false }
}
</script>

<template>
  <div v-if="!data" class="loading shimmer-text">불러오는 중</div>
  <div v-else-if="sent" class="sent blur-in"><Icon name="check" :size="16" /> {{ data.todo.activity_name }} 제출됨</div>
  <div v-else class="todo">
    <FormCard v-if="data.form?.fields?.length" :title="data.todo.activity_name" :subtitle="data.instName" :fields="data.form.fields" :values="data.values" :busy="busy" @submit="submit" />
    <div v-else class="plain glass">
      <b class="serif">{{ data.todo.activity_name }}</b>
      <p>{{ data.todo.description || '확인 후 완료로 표시하세요.' }}</p>
      <button class="dark-btn" :disabled="busy" @click="submit({})">완료</button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.todo { width: 424px; max-width: 100%; }
.loading { font-size: 14px; padding: 6px; }
.sent { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 9999px; background: var(--bubble-user-bg); font-size: 14px; }
.plain { width: 424px; max-width: 100%; border-radius: 24px; padding: 18px; display: flex; flex-direction: column; gap: 8px; }
.plain b { font-size: 20px; font-weight: 400; }
.plain p { margin: 0 0 6px; color: var(--text-secondary); font-size: 14px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.err { color: var(--color-error); font-size: 13px; margin: 8px 6px 0; }
</style>
