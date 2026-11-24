<script setup>
// 채팅에 올린 파일을 어느 단계 결과로 낼지(server lib/ontology/stepfiles.js 'step-file-ask'): 맡아 기다리는 단계 중 하나를 고르면 그 단계로 내고,
// 「새 요청으로」는 예전처럼 파일 사건(시작할 프로세스 제안)으로 간다. 고르기 전에는 아무 단계에도 붙지 않는다.
import { computed, ref } from 'vue'
import Icon from '../Icon.vue'
import { api } from '../../api.js'

const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content || {})
const busy = ref('')
const err = ref('')
async function answer(body, key) {
  busy.value = key; err.value = ''
  try { await api('/ontology/step-files', { method: 'POST', body: { messageId: props.msg.id, ...body } }) } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const chosen = computed(() => (c.value.options || []).find((o) => o.todoId === c.value.todoId) || null)
</script>

<template>
  <div v-if="c.state === 'submitted'" class="done blur-in" data-testid="step-file-ask" data-state="submitted"><Icon name="check" :size="16" /> 「{{ c.task || chosen?.task }}」 결과로 냈어요</div>
  <div v-else-if="c.state === 'new'" class="done blur-in" data-testid="step-file-ask" data-state="new"><Icon name="check" :size="16" /> 새 요청으로 볼게요</div>
  <div v-else class="ask glass" data-testid="step-file-ask" data-state="asking">
    <p>{{ c.text }}</p>
    <div class="files"><span v-for="f in c.files || []" :key="f.path || f.url" class="f"><Icon name="doc" :size="14" /> {{ f.name }}</span></div>
    <button v-for="o in c.options || []" :key="o.todoId" type="button" class="opt press" :disabled="!!busy" data-testid="step-file-option" :data-todo="o.todoId" :data-task="o.task"
      @click="answer({ todoId: o.todoId }, o.todoId)">
      <b>{{ o.task }}</b><small>{{ o.subject }}</small>
    </button>
    <div class="foot">
      <button type="button" class="ghost press" :disabled="!!busy" data-testid="step-file-new" @click="answer({ none: true }, 'none')">새 요청으로</button>
    </div>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.ask { width: 424px; max-width: 100%; border-radius: 24px; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; --regular-bg: var(--bubble-agent-bg); }
p { margin: 0; font-size: 15px; line-height: 1.5; }
.files { display: flex; flex-wrap: wrap; gap: 6px; }
.f { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-secondary); }
.opt { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 14px; border-radius: 14px; background: var(--field-bg); text-align: left; }
.opt b { font-size: 15px; font-weight: 500; }
.opt small { font-size: 12px; color: var(--text-secondary); }
.foot { display: flex; justify-content: flex-end; }
.ghost { height: 36px; padding: 0 14px; border-radius: 9999px; color: var(--text-secondary); font-size: 14px; }
.done { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 9999px; background: var(--bubble-user-bg); font-size: 14px; }
.err { color: var(--color-error); font-size: 13px; }
</style>
