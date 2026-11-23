<script setup>
// 설정 › 습관: 비서가 배운 후행 습관(server lib/followups.js). 내 것만 보이고, 끄거나 지울 수 있다.
import { onMounted, ref } from 'vue'
import { api } from '../api.js'

const habits = ref(null)
const minSeen = ref(2)
const err = ref('')
async function load() {
  try { const r = await api('/followups'); habits.value = r.habits; minSeen.value = r.minSeen } catch (e) { err.value = e.message }
}
onMounted(load)
const note = (h) => {
  if (h.state === 'muted') return '묻지 않아요'
  if (h.origin !== 'told' && h.seen < minSeen.value) return '한 번 더 보면 물어볼게요'
  return h.origin === 'told' ? '직접 말씀하신 습관 · 다음부터 물어봐요' : '다음부터 물어봐요'
}
async function setState(h, state) { await api(`/followups/${h.id}`, { method: 'PATCH', body: { state } }); await load() }
async function remove(h) { await api(`/followups/${h.id}`, { method: 'DELETE' }); await load() }
</script>

<template>
  <p class="cap">결과물을 받은 뒤 습관처럼 시키는 일을 기억해 두었다가, 다음에 먼저 묻습니다. 눌러야 실행하고, 다른 사람에게는 보이지 않습니다.</p>
  <p v-if="err" class="cap err">{{ err }}</p>
  <p v-else-if="habits && !habits.length" class="cap" data-testid="habits-empty">아직 배운 습관이 없어요. 「앞으로 슬라이드 만들면 로고는 유엔진으로 바꿔 줘」처럼 직접 말해도 됩니다.</p>
  <div v-if="habits?.length" class="list glass">
    <div v-for="h in habits" :key="h.id" class="li col" data-testid="habit-row" :class="{ off: h.state === 'muted' }">
      <div class="main">
        <small class="when">{{ h.when }}</small>
        <b>{{ h.action }}</b>
        <small>{{ note(h) }} · 본 횟수 {{ h.seen }} · 수락 {{ h.accepted }} · 거절 {{ h.declined }}<template v-if="h.files?.length"> · 파일 {{ h.files.map((f) => f.name).join(', ') }}</template></small>
      </div>
      <div class="acts">
        <button v-if="h.state === 'on'" class="pill-btn sm" data-testid="habit-mute" @click="setState(h, 'muted')">끄기</button>
        <button v-else class="pill-btn sm" data-testid="habit-on" @click="setState(h, 'on')">켜기</button>
        <button class="pill-btn sm" data-testid="habit-remove" @click="remove(h)">지우기</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cap { color: var(--text-secondary); font-size: 14px; margin: 0 0 18px; line-height: 1.6; }
.err { color: var(--color-error); }
.list { width: 100%; border-radius: 24px; padding: 4px 22px; margin-bottom: 14px; display: flex; flex-direction: column; }
.li { display: flex; flex-direction: column; gap: 10px; padding: 18px 0; border-bottom: 1px solid var(--hairline); }
.li:last-child { border-bottom: 0; }
.li.off { opacity: .55; }
.main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.main b { font-weight: 500; font-size: 15.5px; line-height: 1.4; }
.main small { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.main .when { color: var(--text-tertiary); }
.acts { display: flex; gap: 6px; }
</style>
