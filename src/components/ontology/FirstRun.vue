<script setup>
// 처음: 무엇을 읽고 무엇을 남기는지 알리고 「지난 메일 읽기(90일)」. 읽는 동안 진행 막대, 다 읽으면 「지도 그리는 중…」.
import { computed } from 'vue'
const props = defineProps({
  phase: { type: String, default: 'empty' }, // empty | mail | build | off | error
  job: { type: Object, default: null },
  error: { type: String, default: '' },
  busy: Boolean,
  note: { type: String, default: '' },
})
const emit = defineEmits(['start', 'retry'])
const ratio = computed(() => (props.job?.total ? Math.min(1, (props.job.done || 0) / props.job.total) : 0))
const weeks = computed(() => props.job?.detail?.weeks || 0)
// what the job has found so far, a line at a time (server lib/ontology/feed.js) — the last few, newest at the bottom
const feed = computed(() => (props.job?.detail?.feed || []).slice(-6))
</script>

<template>
  <div class="first glass">
    <template v-if="phase === 'off'">
      <b class="ttl">아직 지도를 그릴 수 없어요</b>
      <p class="lead">Ontological DB 가 연결되지 않았어요. 관리자에게 연결을 부탁해 주세요.</p>
    </template>

    <template v-else-if="phase === 'error'">
      <b class="ttl">지도를 불러오지 못했어요</b>
      <p class="lead">잠시 뒤 다시 불러와 보세요. 계속 안 되면 관리자에게 알려 주세요.</p>
      <button class="go press" :disabled="busy" @click="emit('retry')">다시 불러오기</button>
    </template>

    <template v-else-if="phase === 'mail'">
      <b class="ttl">지난 메일을 읽고 있어요</b>
      <div class="bar"><i :style="{ width: `${ratio * 100}%` }" /></div>
      <p class="prog">
        <template v-if="job?.total">{{ (job.total || 0).toLocaleString('ko-KR') }}통 중 {{ (job.done || 0).toLocaleString('ko-KR') }}통 읽음 · 일 {{ job.found || 0 }}개</template>
        <template v-else>메일함을 여는 중…</template>
      </p>
      <p v-if="job?.detail?.stage === 'chat'" class="sub">먼저 채팅 인계 기록 {{ job.detail.chat || 0 }}건의 일 이름을 맞추고 있어요. 메일은 그 이름으로 읽어요.</p>
      <ul v-if="feed.length" class="feed" data-testid="onto-feed" aria-live="polite">
        <li v-for="f in feed" :key="f.at + f.text">{{ f.text }}</li>
      </ul>
      <p class="sub">창을 닫아도 계속 읽어요. 다 읽으면 지도를 그려요.</p>
    </template>

    <template v-else-if="phase === 'build'">
      <b class="ttl shimmer-text">지도 그리는 중…</b>
      <div class="bar busy"><i /></div>
      <p class="sub">일 이름을 맞추고, 건마다 다음 일로 넘어간 횟수를 세요.<template v-if="weeks"> 지난 {{ weeks }}주 지도도 함께 그리고 있어요.</template></p>
      <ul v-if="feed.length" class="feed" data-testid="onto-feed" aria-live="polite">
        <li v-for="f in feed" :key="f.at + f.text">{{ f.text }}</li>
      </ul>
    </template>

    <template v-else>
      <b class="ttl">회사 프로세스 지도를 그려 볼까요?</b>
      <p class="lead">지난 메일과 채팅 인계 기록에서 누가 누구에게 어떤 일을 넘겼는지 모아 회사의 일 흐름을 그려요.</p>
      <ul class="what">
        <li><b>읽는 것</b> 지난 90일 동안 받은 · 보낸 메일의 본문과 첨부(회사가 보낸 양식은 칸까지), 채팅 인계 기록</li>
        <li><b>거르는 것</b> 뉴스레터 · 자동 알림 · 일정 초대는 규칙으로 먼저 빼요</li>
        <li><b>남기는 것</b> 지도에는 누가 · 누구에게 · 어떤 일 · 언제뿐이에요. 읽은 메일은 내 메일 보관함에만 남아요</li>
      </ul>
      <p v-if="note" class="sub">{{ note }}</p>
      <button class="go press" :disabled="busy" @click="emit('start')">{{ busy ? '시작하는 중…' : '지난 메일 읽기(90일)' }}</button>
    </template>
    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
.first { width: 100%; max-width: 620px; margin: 24px auto; border-radius: 24px; padding: 28px 30px; display: flex; flex-direction: column; gap: 12px; animation: blur-in .45s var(--spring) both; }
.ttl { font-size: 21px; font-weight: 600; letter-spacing: -0.02em; }
.lead { margin: 0; font-size: 14.5px; line-height: 1.6; color: var(--text-primary); }
.what { margin: 2px 0 4px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; }
.what li { font-size: 13.5px; line-height: 1.5; color: var(--text-secondary); padding: 9px 12px; border-radius: 12px; background: var(--field-bg); }
.what b { color: var(--text-primary); font-weight: 600; margin-right: 8px; }
.go { align-self: flex-start; height: 46px; padding: 0 24px; border-radius: 23px; background: var(--ink); color: var(--text-primary-on); font-size: 15px; font-weight: 500; }
.go:disabled { opacity: .55; }
.bar { height: 10px; border-radius: 5px; background: var(--field-bg); overflow: hidden; position: relative; }
.bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: var(--color-success); transition: width .6s var(--spring); }
.bar.busy i { width: 35%; animation: slide 1.4s ease-in-out infinite; }
@keyframes slide { from { left: -35%; } to { left: 100%; } }
.prog { margin: 0; font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; }
.sub { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 0; color: var(--color-error); font-size: 13.5px; }
.feed { list-style: none; margin: 2px 0 0; padding: 10px 12px; border-radius: 12px; background: var(--field-bg); display: flex; flex-direction: column; gap: 5px; }
.feed li { font-size: 13px; line-height: 1.5; color: var(--text-secondary); animation: blur-in .4s var(--spring) both; }
.feed li:last-child { color: var(--text-primary); }
@media (max-width: 760px) {
  .first { margin: 12px 0; padding: 22px 20px; }
}
</style>
