<script setup>
// A Home card for one process-gpt notification addressed to me: a step that is mine to decide
// (its choices as buttons, like hark's Release/Remind actions), or a teammate's request.
import { ref, computed } from 'vue'
import { useApp } from '../stores/app.js'
import { useRouter } from 'vue-router'
import { useTeam } from '../stores/team.js'
import StepOutputs from './mining/StepOutputs.vue'
import AccessDecide from './context/AccessDecide.vue'
import { noticeText } from '../noticeText.js'
import { useSwipeAway } from '../swipeAway.js'

const props = defineProps({ n: Object })
const app = useApp()
// a step of this card's instance runs on someone's desktop now (server lib/localAgents): its state, live (stores/app.js localActive)
const instOf = (n) => n?.instId || (() => { const m = /^\/(?:routines|projects\/p)\/([^/?#]+)/.exec(String(n?.url || '')); return m ? decodeURIComponent(m[1]) : null })()
const localRun = computed(() => { const id = instOf(props.n); return id ? app.localActive[id] || null : null })
const router = useRouter()
const team = useTeam()
const busy = ref('')
// an earlier step's summary can carry a sandbox link ("[견적서.xlsx](/workspace/…)"): its chip below opens the file
const ctxText = computed(() => String(props.n.context || props.n.text || '').replace(/\[([^\]\n]+)\]\(<?(?:sandbox:)?\/workspace\/[^)>\n]*>?\)/g, '$1'))
// the card's words: an agent answer copied into a notice can end in a ```json block (noticeText.js)
const titleText = computed(() => noticeText(props.n.title, 160) || props.n.title)
// (a teammate's message names its room below the writer; a 1:1 room named after the writer adds nothing)
const ctxShown = computed(() => props.n.type === 'chat' && ctxText.value.trim() === String(props.n.from || '').trim() ? '' : noticeText(ctxText.value, 400))

// phone: a sideways swipe puts the card away (src/swipeAway.js)
const sw = useSwipeAway(() => app.dismissNotification(props.n))
const card = sw.el
const dx = sw.dx
const swipeStyle = sw.style
const { down, move, up } = sw

// a teammate's 'team' notice is a share or a mention; its title is in the recipient's language
// (lib/team/messenger.js notifyMembers: "…를 공유했어요" / "… shared …", "…나를 언급했어요" / "… mentioned you")
// (the server's own titles — lib/team/messenger.js notifyMembers; 「…님이 물어봤어요」 is a request the AI sent for someone, lib/askTeammate.js)
const teamVerb = (title) => (/나를 언급했어요|\bmentioned you\b/.test(title || '') ? '멘션' : /공유했어요|\sshared\s/.test(title || '') ? '공유' : /님이 물어봤어요|\basked you something\b/.test(title || '') ? '질문' : '멘션')
// the AI waiting on me (server lib/askPerson.js): what it waits for
const ASK_VERB = { question: '질문', approval: '승인', login: '로그인', hands: '확인' }
const verb = computed(() => props.n.type === 'ai_ask' ? ASK_VERB[props.n.kind] || '질문' : props.n.type === 'context_access' ? '참고 요청' : props.n.type === 'context_sensitive' ? '민감 제안' : String(props.n.type || '').startsWith('context_access') ? '공유' : props.n.type === 'agent_failed' || props.n.type === 'mission_failed' ? '실패' : props.n.type === 'mining' ? '추천' : props.n.type === 'improve' ? '제약' : props.n.type === 'meeting_action' ? '할 일' : props.n.type === 'ask_teammate' ? '팀원 답' : props.n.type === 'chat' ? '메시지' : (props.n.type === 'team' ? teamVerb(props.n.title) : props.n.type === 'mention' ? '요청' : props.n.type !== 'workitem' ? '알림' : props.n.choices ? '결정' : '입력'))
// process-gpt's own notification types share the table
const kinds = { ai_ask: 'Process GPT', context_access: '팀 맥락 공유', context_access_result: '팀 맥락 공유', context_access_digest: '팀 맥락 공유', context_sensitive: '팀 맥락 공유', agent_failed: '프로세스 에이전트 단계', mission_failed: '예약 실행 실패', mission: '예약 실행 결과', chat: 'process-gpt 채팅', handover: '업무 인계', merge_request: '변경 요청', mining: '프로세스 마이닝', improve: '프로세스 개선', folder_access: '폴더 권한 요청', mail_access: '메일 본문 요청', ask_teammate: '팀원에게 묻기' }
const when = computed(() => {
  const d = new Date(props.n.at)
  const mins = Math.round((Date.now() - d) / 60000)
  return mins < 1 ? '방금' : mins < 60 ? `${mins}분 전` : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
})

async function act(choice) {
  // the AI's question, approval or sign-in: where it asks (the card stays until it is answered there)
  if (!choice && props.n.type === 'ai_ask' && props.n.place) return router.push(props.n.place)
  // a teammate's share or mention (components/team): opens our thread at that message
  const m = /^\/pro\/team\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(String(props.n.url || ''))
  if (!choice && m) { app.dismissNotification(props.n); return team.openMessenger(m[1], m[2]) }
  // a message in a 1:1 or group room (process-gpt's chat trigger: '/chats?id=<room>') opens that room
  const room = /^\/chats\?id=([\w.:-]+)/.exec(String(props.n.url || ''))
  if (!choice && room) { app.dismissNotification(props.n); return team.openMessenger(room[1]) }
  // a shared-folder notice (반영 요청, 인계) opens the variation to review
  if (!choice && String(props.n.url || '').startsWith('/folders/')) { app.dismissNotification(props.n); return router.push(props.n.url) }
  // a process-mining recommendation opens the mined flow (views/MiningView.vue); it stays until decided
  if (!choice && String(props.n.url || '').startsWith('/mining/')) return router.push(props.n.url)
  // a new constraint in a process (lib/improve/service.js checkConstraint) opens its 개선 view
  if (!choice && String(props.n.url || '').startsWith('/improve/')) return router.push(props.n.url)
  // a failed agent step (lib/stepRetry.js) opens its instance, where 「다시 시도」 is; a failed scheduled
  // run opens its task's run history (lib/missions.js)
  if (!choice && /^\/(projects|routines|settings)\//.test(String(props.n.url || ''))) { app.dismissNotification(props.n); return router.push(props.n.url) }
  // a scheduled run's result opens the task's own conversation in the chat (server lib/missions.js chatUrl)
  if (!choice && /^\/chat\/c\/[^/?#]+$/.test(String(props.n.url || ''))) { app.dismissNotification(props.n); return router.push(props.n.url) }
  // a teammate the AI asked for me answered, or has not yet (server lib/askTeammate.js): the chat where I asked
  if (!choice && props.n.type === 'ask_teammate' && props.n.url === '/chat') { app.dismissNotification(props.n); return router.push('/chat') }
  // a work item opens its instance page, where its form is (InstanceHeader 「내 입력이 필요해요」); the
  // card stays until the step is done
  const inst = (id) => router.push(`/routines/${encodeURIComponent(id)}`)
  if (!choice && props.n.type === 'workitem' && props.n.instId) return inst(props.n.instId)
  busy.value = choice || 'open'
  try { const r = await app.actNotification(props.n, choice); if (r?.instId) inst(r.instId) } finally { busy.value = '' }
}
</script>

<template>
  <div ref="card" class="nc glass" :class="[n.type, { swiping: !!dx }]" :style="swipeStyle" data-test="notice-card"
    @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
    <div class="head">
      <span class="verb">{{ verb }}</span>
      <span class="title" :title="n.title">{{ titleText }}</span>
      <button class="x press" title="닫기" aria-label="닫기" data-test="notice-close" @click="app.dismissNotification(n)">×</button>
    </div>
    <p v-if="n.type === 'team'" class="who">{{ n.from }}님 · {{ when }}</p>
    <p v-else-if="n.type === 'mention'" class="who">{{ n.from }}님 · {{ when }}</p>
    <!-- a teammate's message: who wrote it (the server finds the writer when the notice names no one) -->
    <p v-else-if="n.type === 'chat' && n.from" class="who" data-test="notice-from">{{ n.from }}님 · {{ when }}</p>
    <p v-else-if="n.type !== 'workitem'" class="who">{{ kinds[n.type] || 'process-gpt' }} · {{ when }}</p>
    <p v-else class="who">{{ n.process }}<template v-if="n.role"> · {{ n.role }}</template> · {{ when }}</p>
    <p v-if="ctxShown" class="ctx">{{ ctxShown }}</p>
    <p v-if="localRun" class="lrun" :class="localRun.state" data-test="notice-local-run"><span class="dot" />{{ localRun.label }} · {{ localRun.state === 'queued' ? 'PC 앱이 켜지면 시작' : localRun.state === 'running' ? `실행 중${localRun.device ? ` (${localRun.device})` : ''}` : '보냄' }}<template v-if="localRun.lines?.length"> — {{ localRun.lines.at(-1).text }}</template></p>
    <!-- a step to decide: the earlier steps' outputs open right here (IeumOffice · ArtCraft) -->
    <StepOutputs v-if="n.type === 'workitem' && n.todoId" :todo-id="n.todoId" />
    <!-- 팀 맥락 공유: 팀원의 참고 요청은 이 카드에서 바로 허락·거절(깊이·기간·뺄 턴) -->
    <AccessDecide v-if="n.type === 'context_access'" :n="n" />
    <div v-else class="btns">
      <template v-if="n.choices">
        <button v-for="o in n.choices.options" :key="o.key" class="b press" :class="{ main: o === n.choices.options[0] }"
          :disabled="!!busy" :title="o.label" @click="act(o.key)">{{ busy === o.key ? '처리 중…' : o.key }}</button>
      </template>
      <button class="b ghost press" :disabled="!!busy" @click="act()">{{ n.type === 'mention' ? '채팅에서 보기' : n.type === 'ai_ask' ? '답하러 가기' : n.choices ? '자세히' : n.type === 'merge_request' || n.type === 'mining' ? '검토하기' : n.type === 'improve' ? '개선 보기' : n.type === 'agent_failed' ? '인스턴스 보기' : n.type === 'mission_failed' ? '실행 기록 보기' : '열기' }}</button>
    </div>
  </div>
</template>

<style scoped>
.nc { border-radius: 24px; padding: 16px 16px 14px 20px; color: var(--text-primary); min-width: 0; max-width: 100%; overflow: hidden;
  touch-action: pan-y; }
.nc.swiping { user-select: none; }
.head { display: flex; align-items: flex-start; gap: 8px; }
.verb { flex: none; height: 30px; line-height: 30px; padding: 0 9px; border-radius: 8px; background: var(--color-attention); color: #fff; font-size: 15px; font-weight: 500; }
.mention .verb, .team .verb { background: #2a78d6; }
.ai_ask .verb { background: #7a5af5; }
.context_access .verb { background: #7a5af5; }
.context_sensitive .verb { background: #c2410c; }
.context_access_result .verb, .context_access_digest .verb { background: #2a78d6; }
.mission .verb { background: #3d3d3a; }
.agent_failed .verb, .mission_failed .verb { background: var(--color-error); }
.title { flex: 1; min-width: 0; font-size: 16px; line-height: 1.45; padding-top: 3px; font-weight: 500; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.x { flex: none; width: 28px; height: 28px; border-radius: 14px; color: var(--text-tertiary); font-size: 20px; line-height: 26px; }
.who { margin: 4px 0 0; color: var(--text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.ctx { margin: 8px 0 0; font-size: 14px; line-height: 1.55; color: var(--text-primary); overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.lrun { margin: 8px 0 0; font-size: 13px; color: var(--text-secondary); display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lrun .dot { width: 8px; height: 8px; border-radius: 4px; background: var(--color-attention); flex: none; align-self: center; }
.lrun.running .dot { background: #34c759; animation: pulse 1.6s ease-in-out infinite; }
.btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.b { height: 36px; padding: 0 16px; border-radius: 18px; font-size: 15px; background: rgba(0, 0, 0, .06); color: var(--text-primary); }
.b.main { background: var(--color-attention); color: #fff; }
.b.ghost { background: transparent; color: var(--text-secondary); }
.b:disabled { opacity: .55; }
</style>
