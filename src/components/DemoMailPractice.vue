<script setup>
// 연습 메일 받기: a demo mailbox gets one of the fictional practice mails (server
// fixtures/demo-practice-mail.json), read at once as a real inbox would be — the Home card, the
// brief and any drafts it asks for follow. Tutorial readers need no developer console for it.
import { ref, onMounted } from 'vue'
import { api } from '../api.js'

const list = ref([])
const pick = ref('')
const busy = ref(false)
const said = ref('')
onMounted(async () => {
  list.value = await api('/mail/demo-templates').catch(() => [])
  pick.value = list.value[0]?.id || ''
})
async function send() {
  busy.value = true
  said.value = ''
  try {
    const r = await api('/mail/demo-arrive', { method: 'POST', body: { template: pick.value } })
    said.value = r.fresh ? '메일이 도착했어요. 홈과 채팅에서 확인해 보세요.' : '메일함을 읽었어요.'
  } catch (e) { said.value = e.message } finally { busy.value = false }
}
const chosen = () => list.value.find((t) => t.id === pick.value)
</script>

<template>
  <div class="practice">
    <div class="row">
      <select v-model="pick" aria-label="연습 메일 고르기">
        <option v-for="t in list" :key="t.id" :value="t.id">{{ t.label }}</option>
      </select>
      <button class="pill-btn" :disabled="busy || !pick" @click="send">{{ busy ? '받는 중…' : '연습 메일 받기' }}</button>
    </div>
    <small v-if="chosen()" class="sub">{{ chosen().from }} · {{ chosen().subject }}<template v-if="chosen().hint"> — {{ chosen().hint }}</template></small>
    <small v-if="said" class="said">{{ said }}</small>
  </div>
</template>

<style scoped>
.practice { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.row { display: flex; gap: 8px; align-items: center; }
select { flex: 1; min-width: 0; height: 38px; border-radius: 12px; padding: 0 10px; border: 1px solid var(--hairline, rgba(0, 0, 0, .12)); background: var(--cell-bg, rgba(255, 255, 255, .7)); color: var(--text-primary); font-size: 14px; }
.sub { color: var(--text-secondary); font-size: 13px; line-height: 1.45; }
.said { color: var(--text-primary); font-size: 13px; }
</style>
