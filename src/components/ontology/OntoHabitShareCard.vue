<script setup>
// 일의 방법 공유(design-v0.3 §10, server lib/ontology/ways.js askShare): 「이 순서를 기억할게요」 다음에 한 번 묻는 카드.
// 「공유하기」면 그 습관의 목표(일) 아래 방법 후보가 되고(이름 · 걸린 시간 · 받아들인 비율과 함께), 「나만 쓰기」면 어디에도 보이지
// 않는다. 답은 서버가 카드에 남기고(state · task), 이 기기에서는 답한 즉시 그 결과를 보인다.
import { computed, ref } from 'vue'
import { api } from '../../api.js'
import { CLS_KO } from './fmt.js'

const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content || {})
const busy = ref('')
const err = ref('')
const mine = ref(null) // {state, task} right after answering, until the card's own update arrives
const state = computed(() => (c.value.state && c.value.state !== 'pending' ? c.value.state : mine.value?.state || c.value.state || 'pending'))
const task = computed(() => c.value.task || mine.value?.task || '')
const what = computed(() => CLS_KO[c.value.cls] || c.value.cls || '결과물')

async function answer(a) {
  err.value = ''; busy.value = a
  try {
    const r = await api('/ontology/ways/answer', { method: 'POST', body: { messageId: props.msg.id, followupId: c.value.followupId, answer: a } })
    mine.value = { state: r?.answer || a, task: r?.task || '' }
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div class="hsc" data-testid="habit-share-card" :data-state="state">
    <span class="badge">일의 방법 공유</span>
    <p class="txt">{{ c.text }}</p>
    <div class="habit">
      <span class="when">{{ what }} 결과물 뒤에</span>
      <q class="act">{{ c.action }}</q>
    </div>
    <template v-if="state === 'pending'">
      <div class="btns">
        <button class="pill yes press" :disabled="!!busy" data-testid="habit-share-yes" @click="answer('shared')">{{ busy === 'shared' ? '공유하는 중…' : '공유하기' }}</button>
        <button class="pill press" :disabled="!!busy" data-testid="habit-share-no" @click="answer('private')">나만 쓰기</button>
      </div>
      <small class="why">공유는 「공유하기」를 누를 때만 해요. 나만 쓰면 어디에도 보이지 않아요.</small>
    </template>
    <small v-else-if="state === 'shared'" class="done ok" data-testid="habit-share-done">공유했어요<template v-if="task"> · 목표 「{{ task }}」</template></small>
    <small v-else class="done" data-testid="habit-share-done">나만 써요</small>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.hsc { word-break: keep-all; overflow-wrap: anywhere; width: 424px; max-width: 100%; display: flex; flex-direction: column; gap: 10px; padding: 16px 16px 14px; border-radius: 24px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); }
.badge { font-size: 12px; color: var(--text-secondary); letter-spacing: .04em; }
.txt { margin: 0; font-size: 15.5px; line-height: 1.6; }
.habit { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border-radius: 14px; background: var(--field-bg); }
.when { font-size: 12.5px; color: var(--text-secondary); }
.act { font-size: 14.5px; font-weight: 500; line-height: 1.5; quotes: '“' '”'; }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); }
.pill.yes { background: var(--ink); color: var(--ink-inverse); }
.pill:disabled { opacity: .55; }
.why { font-size: 12px; color: var(--text-tertiary); line-height: 1.45; }
.done { font-size: 13px; color: var(--text-secondary); }
.done.ok { color: var(--color-success); font-weight: 500; }
.err { font-size: 12.5px; color: var(--color-error); }
</style>
