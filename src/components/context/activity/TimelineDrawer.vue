<script setup>
// 맥락 하나의 시간순 보기(GET /team-activity/:user/timeline): 원문 = 프롬프트 문장과 답 첫 줄, 요약 = 유형 이름과 바꿔 쓴 한 줄,
// 제목 = 시각과 작업 유형. 원문 깊이가 없으면 「원문 보기」 = 참고 요청(POST /context/access-requests) — 같은 팀은 보통 바로 허락된다.
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../../Icon.vue'
import { api } from '../../../api.js'
import { DEPTH, kindColor, stamp } from './fmt.js'

const props = defineProps({ target: Object })   // {user, conversationId, title}
const emit = defineEmits(['close', 'granted'])
const t = ref(null), err = ref(''), busy = ref(false), note = ref('')

async function load() {
  err.value = ''
  try { t.value = await api(`/team-activity/${props.target.user}/timeline?conv=${encodeURIComponent(props.target.conversationId)}`) }
  catch (e) { t.value = null; err.value = e.status === 404 ? '이 맥락은 지금 볼 수 없어요(비공개로 바뀌었거나 허락이 끝났어요).' : e.message }
}
async function ask() {
  busy.value = true; note.value = ''
  try {
    const r = await api('/context/access-requests', { method: 'POST', body: { conversationId: props.target.conversationId, depth: 'content', doing: '팀 활동에서 살펴봄' } })
    if (r.status === 'granted') { note.value = r.via === 'auto' ? '자동으로 허락됐어요 — 원문을 엽니다' : '허락됐어요'; await load(); emit('granted') }
    else if (r.status === 'pending') note.value = '요청함 — 주인에게 갔습니다'
    else if (r.status === 'denied') note.value = '주인의 규칙으로 거절됐어요'
  } catch (e) { note.value = e.message } finally { busy.value = false }
}
const onKey = (e) => { if (e.key === 'Escape') emit('close') }
onMounted(() => { load(); window.addEventListener('keydown', onKey) })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
watch(() => props.target?.conversationId, () => { note.value = ''; load() })
const KIND = { ai: 'AI 작업', artifact: '산출물', excluded: '뺀 턴' }
</script>

<template>
  <Teleport to="body">
    <div class="veil" @click.self="emit('close')">
      <aside class="dr glass blur-in" role="dialog" :aria-label="`${target.title} 시간순 보기`">
        <header>
          <div class="hd">
            <small>{{ t?.item.owner_name }} · 시간순 보기</small>
            <h2>{{ t?.item.title || target.title }}</h2>
          </div>
          <button class="x press" aria-label="닫기" @click="emit('close')"><Icon name="close" :size="18" /></button>
        </header>
        <template v-if="t">
          <div class="meta">
            <i class="dp" :class="t.item.depth">{{ DEPTH[t.item.depth] }}</i>
            <small>{{ t.item.why.join(' · ') }}</small>
            <span class="sp" />
            <button v-if="t.request" class="ask press" :disabled="busy || note.startsWith('요청함')" @click="ask">{{ busy ? '요청 중…' : '원문 보기' }}</button>
          </div>
          <p v-if="note" class="note" :class="{ ok: note.includes('허락') }">{{ note }}</p>
          <p v-if="t.item.purpose" class="purpose">{{ t.item.purpose }}</p>
          <div v-if="t.item.summary" class="sum">
            <p>{{ t.item.summary }}</p>
            <p v-if="t.item.decisions?.length" class="dq"><b>정한 것</b> {{ t.item.decisions.join(' · ') }}</p>
            <p v-if="t.item.questions?.length" class="dq"><b>열린 질문</b> {{ t.item.questions.join(' · ') }}</p>
          </div>
          <ol class="lines scroll">
            <li v-for="(l, i) in t.lines" :key="i" :class="l.kind">
              <span class="tm">{{ stamp(l.at) }}</span>
              <div class="body">
                <template v-if="l.kind === 'prompt'">
                  <span class="w" :style="{ color: kindColor(l.work) }">{{ l.work }}</span>
                  <template v-if="l.prompt">
                    <p class="pr">{{ l.prompt }}</p>
                    <p v-if="l.answer" class="an">↳ {{ l.answer }}</p>
                  </template>
                  <p v-else-if="l.type" class="ty"><b>{{ l.type }}</b><template v-if="l.line"> — {{ l.line }}</template></p>
                  <p v-else class="ty dim">요청 한 번 — 내용은 요약 깊이부터</p>
                </template>
                <template v-else>
                  <span class="w">{{ KIND[l.kind] }}</span>
                  <p class="ty">
                    <template v-if="l.kind === 'ai'">{{ l.title || 'AI 작업' }} · {{ l.status_label }}</template>
                    <template v-else-if="l.kind === 'artifact'"><a v-if="l.url" :href="l.url" target="_blank" rel="noopener">{{ l.name }}</a><span v-else>{{ l.name || '파일' }}</span></template>
                    <template v-else>주인이 허락에서 뺀 턴</template>
                  </p>
                </template>
              </div>
            </li>
          </ol>
          <p v-if="!t.lines.length" class="dim">아직 기록된 턴이 없어요</p>
        </template>
        <p v-else-if="err" class="err">{{ err }}</p>
        <p v-else class="dim">불러오는 중…</p>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .22); display: flex; justify-content: flex-end; }
.dr { width: min(520px, 100%); height: 100%; box-sizing: border-box; padding: 20px 22px 16px; display: flex; flex-direction: column; gap: 10px; background: var(--regular-solid-bg); box-shadow: var(--shadow-card); border-radius: 26px 0 0 26px; }
header { display: flex; align-items: flex-start; gap: 10px; }
.hd { flex: 1; min-width: 0; }
.hd small { color: var(--text-secondary); font-size: 13px; }
h2 { margin: 2px 0 0; font-size: 21px; font-weight: 600; letter-spacing: -0.01em; }
.x { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--button-bg); flex: none; }
.meta { display: flex; align-items: center; gap: 8px; }
.meta small { color: var(--text-secondary); font-size: 12.5px; }
.sp { flex: 1; }
.dp { font-style: normal; font-size: 12px; padding: 2px 9px; border-radius: 9px; background: var(--field-bg); color: var(--text-secondary); }
.dp.summary { background: rgba(76, 141, 246, .16); color: var(--color-info); }
.dp.content { background: rgba(59, 185, 138, .16); color: var(--color-success); }
.ask { height: 34px; padding: 0 16px; border-radius: 17px; background: var(--color-attention); color: #fff; font-size: 14px; font-weight: 500; }
.ask:disabled { opacity: .55; }
.note { margin: 0; font-size: 13.5px; padding: 8px 12px; border-radius: 12px; background: var(--field-bg); }
.note.ok { color: var(--color-success); }
.purpose { margin: 0; font-size: 13.5px; color: var(--text-secondary); }
.sum { padding: 10px 12px; border-radius: 14px; background: var(--cell-bg); font-size: 14px; line-height: 1.5; }
.sum p { margin: 0; }
.sum .dq { margin-top: 6px; font-size: 13px; color: var(--text-secondary); }
.sum .dq b { color: var(--text-primary); font-weight: 600; margin-right: 4px; }
.lines { list-style: none; margin: 0; padding: 0 2px 0 0; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 2px; }
.lines li { display: grid; grid-template-columns: 92px 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--hairline); }
.tm { font-size: 12px; color: var(--text-tertiary); padding-top: 2px; }
.body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.w { font-size: 11.5px; font-weight: 600; color: var(--text-secondary); }
.pr { margin: 0; font-size: 14px; }
.an { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.45; }
.ty { margin: 0; font-size: 13.5px; }
.ty b { font-weight: 600; }
.ty a { color: var(--color-info); }
.dim { color: var(--text-tertiary); font-size: 13px; margin: 0; }
.err { color: var(--color-error); font-size: 14px; }
</style>
