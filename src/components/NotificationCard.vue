<script setup>
// A Home card for one process-gpt notification addressed to me: a step that is mine to decide
// (its choices as buttons, like hark's Release/Remind actions), or a teammate's request.
import { ref, computed } from 'vue'
import { useApp } from '../stores/app.js'
import { useRouter } from 'vue-router'
import { useTeam } from '../stores/team.js'
import StepOutputs from './mining/StepOutputs.vue'

const props = defineProps({ n: Object })
const app = useApp()
const router = useRouter()
const team = useTeam()
const busy = ref('')

const verb = computed(() => props.n.type === 'agent_failed' || props.n.type === 'mission_failed' ? '실패' : props.n.type === 'mining' ? '추천' : props.n.type === 'improve' ? '제약' : (props.n.type === 'team' ? (/공유했어요/.test(props.n.title) ? '공유' : '멘션') : props.n.type === 'mention' ? '요청' : props.n.type !== 'workitem' ? '알림' : props.n.choices ? '결정' : '입력'))
// process-gpt's own notification types share the table
const kinds = { agent_failed: '프로세스 에이전트 단계', mission_failed: '예약 실행 실패', mission: '예약 실행 결과', chat: 'process-gpt 채팅', handover: '업무 인계', merge_request: '변경 요청', mining: '프로세스 마이닝', improve: '프로세스 개선' }
const when = computed(() => {
  const d = new Date(props.n.at)
  const mins = Math.round((Date.now() - d) / 60000)
  return mins < 1 ? '방금' : mins < 60 ? `${mins}분 전` : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
})

async function act(choice) {
  // a teammate's share or mention (components/team): opens our thread at that message
  const m = /^\/pro\/team\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(String(props.n.url || ''))
  if (!choice && m) { app.dismissNotification(props.n); return team.openMessenger(m[1], m[2]) }
  // a shared-folder notice (반영 요청, 인계) opens the variation to review
  if (!choice && String(props.n.url || '').startsWith('/folders/')) { app.dismissNotification(props.n); return router.push(props.n.url) }
  // a process-mining recommendation opens the mined flow (views/MiningView.vue); it stays until decided
  if (!choice && String(props.n.url || '').startsWith('/mining/')) return router.push(props.n.url)
  // a new constraint in a process (lib/improve/service.js checkConstraint) opens its 개선 view
  if (!choice && String(props.n.url || '').startsWith('/improve/')) return router.push(props.n.url)
  // a failed agent step (lib/stepRetry.js) opens its instance, where 「다시 시도」 is; a failed scheduled
  // run opens its task's run history (lib/missions.js)
  if (!choice && /^\/(projects|settings)\//.test(String(props.n.url || ''))) { app.dismissNotification(props.n); return router.push(props.n.url) }
  busy.value = choice || 'open'
  try { await app.actNotification(props.n, choice) } finally { busy.value = '' }
}
</script>

<template>
  <div class="nc glass" :class="n.type">
    <div class="head">
      <span class="verb">{{ verb }}</span>
      <span class="title">{{ n.title }}</span>
      <button class="x press" title="닫기" @click="app.dismissNotification(n)">×</button>
    </div>
    <p v-if="n.type === 'team'" class="who">{{ n.from }}님 · {{ when }}</p>
    <p v-else-if="n.type === 'mention'" class="who">{{ n.from }}님 · {{ when }}</p>
    <p v-else-if="n.type !== 'workitem'" class="who">{{ kinds[n.type] || 'process-gpt' }} · {{ when }}</p>
    <p v-else class="who">{{ n.process }}<template v-if="n.role"> · {{ n.role }}</template> · {{ when }}</p>
    <p v-if="n.context || n.text" class="ctx">{{ n.context || n.text }}</p>
    <!-- a step to decide: the earlier steps' outputs open right here (IeumOffice · ArtCraft) -->
    <StepOutputs v-if="n.type === 'workitem' && n.todoId" :todo-id="n.todoId" />
    <div class="btns">
      <template v-if="n.choices">
        <button v-for="o in n.choices.options" :key="o.key" class="b press" :class="{ main: o === n.choices.options[0] }"
          :disabled="!!busy" :title="o.label" @click="act(o.key)">{{ busy === o.key ? '처리 중…' : o.key }}</button>
      </template>
      <button class="b ghost press" :disabled="!!busy" @click="act()">{{ n.type === 'mention' ? '채팅에서 보기' : n.choices ? '자세히' : n.type === 'merge_request' || n.type === 'mining' ? '검토하기' : n.type === 'improve' ? '개선 보기' : n.type === 'agent_failed' ? '인스턴스 보기' : n.type === 'mission_failed' ? '실행 기록 보기' : '열기' }}</button>
    </div>
  </div>
</template>

<style scoped>
.nc { border-radius: 24px; padding: 16px 16px 14px 20px; color: var(--text-primary); }
.head { display: flex; align-items: flex-start; gap: 8px; }
.verb { flex: none; height: 30px; line-height: 30px; padding: 0 9px; border-radius: 8px; background: var(--color-attention); color: #fff; font-size: 15px; font-weight: 500; }
.mention .verb, .team .verb { background: #2a78d6; }
.mission .verb { background: #3d3d3a; }
.agent_failed .verb, .mission_failed .verb { background: var(--color-error); }
.title { flex: 1; font-size: 16px; line-height: 30px; font-weight: 500; }
.x { flex: none; width: 28px; height: 28px; border-radius: 14px; color: var(--text-tertiary); font-size: 20px; line-height: 26px; }
.who { margin: 4px 0 0; color: var(--text-secondary); font-size: 13px; }
.ctx { margin: 8px 0 0; font-size: 14px; line-height: 1.55; color: var(--text-primary);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.b { height: 36px; padding: 0 16px; border-radius: 18px; font-size: 15px; background: rgba(0, 0, 0, .06); color: var(--text-primary); }
.b.main { background: var(--color-attention); color: #fff; }
.b.ghost { background: transparent; color: var(--text-secondary); }
.b:disabled { opacity: .55; }
</style>
