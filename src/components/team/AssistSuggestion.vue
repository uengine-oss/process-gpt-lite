<script setup>
// A suggestion under a teammate's message, like the card a new mail brings: "이 일을 도와드릴까요?"
// with 시작 / 아니요 (lib/team/assist.js). 시작 runs it as me; while it runs everyone in the thread sees
// the progress, and the result arrives in the thread as my agent's message.
import { ref, computed, onBeforeUnmount } from 'vue'
import { useTeam } from '../../stores/team.js'

const props = defineProps({ s: Object })
const team = useTeam()
const busy = ref(false)
const err = ref('')
const t0 = Date.now()
const now = ref(Date.now())
const tick = setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => clearInterval(tick))
const elapsed = computed(() => { const s = Math.max(0, Math.round((now.value - t0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` })
async function go() {
  busy.value = true; err.value = ''
  try { await team.startSuggestion(props.s) } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="as glass" :class="s.state">
    <template v-if="s.state === 'open'">
      <div class="hd"><span class="verb" :title="s.work">{{ s.kind || '도움' }}</span><span class="q">이 일을 도와드릴까요? · <b :data-no-i18n="team.trSug(s, 'title') ? '' : null">{{ team.trSug(s, 'title') || s.title }}</b></span></div>
      <p class="why" :data-no-i18n="team.trSug(s, 'reason') ? '' : null">{{ team.trSug(s, 'reason') || s.reason }}</p>
      <div class="btns">
        <button class="b main press" :disabled="busy" @click="go">{{ busy ? '시작하는 중…' : '시작' }}</button>
        <button class="b ghost press" :disabled="busy" @click="team.dismissSuggestion(s)">아니요</button>
        <small class="note">내 계정·내 에이전트로 해요 · 결과는 이 대화에 올라와요</small>
      </div>
    </template>
    <p v-else-if="s.state === 'running'" class="run"><span class="shimmer-text">{{ team.assistStatus[s.id] || '에이전트가 작업하는 중' }}</span><small> · {{ elapsed }}</small></p>
    <p v-else-if="s.state === 'done'" class="fin">✓ {{ s.title }} — 결과가 아래에 올라왔어요</p>
    <p v-else class="fin bad">{{ s.title }} — 작업하지 못했어요</p>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.as { align-self: stretch; margin: 2px 0 4px 36px; max-width: 460px; border-radius: 18px; padding: 12px 14px; color: var(--text-primary); border: 1px solid rgba(122, 90, 245, .35); }
.hd { display: flex; align-items: flex-start; gap: 8px; }
.verb { flex: none; height: 26px; line-height: 26px; padding: 0 8px; border-radius: 7px; background: #7a5af5; color: #fff; font-size: 13px; font-weight: 500; }
.q { font-size: 14.5px; line-height: 26px; }
.q b { font-weight: 600; }
.why { margin: 6px 0 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; }
.btns { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.b { height: 32px; padding: 0 16px; border-radius: 16px; font-size: 14px; background: rgba(127, 127, 127, .14); color: var(--text-primary); }
.b.main { background: #7a5af5; color: #fff; }
.b.ghost { background: transparent; color: var(--text-secondary); }
.b:disabled { opacity: .55; }
.note { font-size: 11.5px; color: var(--text-tertiary); margin-left: 4px; }
.run, .fin { margin: 0; font-size: 13.5px; }
.run small { color: var(--text-tertiary); }
.fin { color: var(--text-secondary); }
.fin.bad { color: #c62828; }
.err { margin: 6px 0 0; font-size: 12.5px; color: #c62828; }
.done, .failed { padding: 8px 14px; border-color: rgba(127, 127, 127, .25); }
</style>
