<script setup>
// 말로 고치기의 미리 보기(지도 오른쪽 패널, 폰은 아래 시트): 서버의 계획(Plan)을 글로 — 범위 · 고치기 전 · 고친 뒤 · 되묻는 것과 답 ·
// 바뀌는 것(OntoChangeList) · 한 말. 그림은 지도가 그린다(고친 뒤 = plan.after 의 더함 · 뺌 · 바뀜, 고치기 전 = plan.before).
// 단추: 적용(관리자 — 아니면 plan.whyNot) · 의견으로 남기기(plan.canVoice, 있는 프로세스일 때) · 고쳐 말하기(말을 입력 칸에 되돌린다) · 그만두기.
// 이 패널은 부르지 않는다 — 지도 화면이 받아 서버에 보낸다.
import { ref, computed, watch } from 'vue'
import OntoChangeList from './OntoChangeList.vue'

const props = defineProps({
  plan: { type: Object, required: true },
  admin: Boolean,
  busy: { type: String, default: '' }, // '' | 'plan' | 'apply' | 'voice'
  side: { type: String, default: 'after' }, // 'before' | 'after'
  resolving: { type: Number, default: 0 }, // 「말로 정리하기」: the conflict's opinions this closes
  error: { type: String, default: '' },
})
const emit = defineEmits(['update:side', 'answer', 'apply', 'voice', 'rephrase', 'stop'])

const p = computed(() => props.plan || {})
const isNew = computed(() => p.value.scope === 'new')
const ops = computed(() => p.value.ops || [])
const canApply = computed(() => props.admin && p.value.canApply !== false && ops.value.length > 0)
const whyNot = computed(() => {
  if (canApply.value) return ''
  if (p.value.whyNot) return p.value.whyNot
  if (!props.admin) return '적용은 관리자만 할 수 있어요 — 의견으로 남길 수 있어요'
  return ops.value.length ? '' : '지도에서 바꿀 것이 없어요.'
})
const canVoice = computed(() => !!p.value.canVoice && !!p.value.proc?.key && !isNew.value)
const scopeText = computed(() => {
  if (isNew.value) return `새 프로세스${p.value.name ? ` 「${p.value.name}」` : ''} — 적용하면 「제안」 단계로 지도에 들어가요`
  if (p.value.scope === 'range') {
    const r = p.value.range || {}
    return `고른 범위 안에서만 · 단계 ${(r.tasks || []).length}개 · 관계 ${(r.ways || []).length}개`
  }
  return '이 프로세스 전체에서'
})
const rangeNames = computed(() => (p.value.scope === 'range' ? p.value.range?.tasks || [] : []))
const answer = ref('')
watch(() => props.plan, () => { answer.value = '' })
function reply() {
  const a = answer.value.trim()
  if (a && !props.busy) emit('answer', a)
}
const secs = computed(() => (p.value.ms ? `${(p.value.ms / 1000).toFixed(1)}초` : ''))
</script>

<template>
  <div class="oep" data-testid="onto-edit-preview" :data-scope="p.scope" :data-side="side">
    <small class="scope" data-testid="onto-edit-preview-scope">{{ scopeText }}</small>
    <small v-if="rangeNames.length" class="rg">{{ rangeNames.join(' · ') }}</small>

    <div v-if="p.before" class="seg" role="group" aria-label="고치기 전 · 고친 뒤">
      <button :class="{ on: side === 'before' }" data-testid="onto-edit-preview-before" @click="emit('update:side', 'before')">고치기 전</button>
      <button :class="{ on: side === 'after' }" data-testid="onto-edit-preview-after" @click="emit('update:side', 'after')">고친 뒤</button>
    </div>
    <small class="hint">{{ side === 'before' && p.before ? '지금 지도예요.' : '지도에 고친 뒤를 그렸어요 — 아직 바뀐 것은 없어요.' }}</small>

    <p v-if="busy === 'plan'" class="pend pulse" data-testid="onto-edit-preview-pending">말을 지도로 옮기는 중…</p>
    <template v-else>
      <OntoChangeList :plan="plan" />
      <form v-if="p.question" class="ans" @submit.prevent="reply">
        <input v-model="answer" class="in" maxlength="300" placeholder="답을 적어 주세요" data-testid="onto-edit-preview-answer" />
        <button class="ghost press" type="submit" :disabled="!!busy || !answer.trim()" data-testid="onto-edit-preview-answer-send">답하기</button>
      </form>
    </template>

    <div class="said">
      <small class="cap">한 말</small>
      <q data-testid="onto-edit-preview-words">{{ p.words }}</q>
    </div>
    <p v-if="resolving" class="res" data-testid="onto-edit-preview-resolve">엇갈린 의견 {{ resolving }}개를 이 말로 정리해요. 적용하면 그 의견들은 닫혀요.</p>

    <small v-if="p.model" class="meta">{{ p.model }}<template v-if="secs"> · {{ secs }}</template></small>

    <!-- the buttons stay at the panel's foot while the list scrolls -->
    <div class="foot">
      <div class="btns">
        <button class="go press" :disabled="!!busy || !canApply" :title="whyNot" data-testid="onto-edit-preview-apply" @click="emit('apply')">{{ busy === 'apply' ? '적용하는 중…' : isNew ? '지도에 넣기' : '적용' }}</button>
        <button v-if="canVoice" class="pill press" :disabled="!!busy" data-testid="onto-edit-preview-voice" @click="emit('voice')">{{ busy === 'voice' ? '남기는 중…' : '의견으로 남기기' }}</button>
        <button class="pill press" :disabled="!!busy" data-testid="onto-edit-preview-rephrase" @click="emit('rephrase')">고쳐 말하기</button>
        <span class="sp" />
        <button class="ghost press" :disabled="busy === 'apply' || busy === 'voice'" data-testid="onto-edit-preview-stop" @click="emit('stop')">그만두기</button>
      </div>
      <small v-if="whyNot" class="why" data-testid="onto-edit-preview-whynot">{{ whyNot }}</small>
      <small v-if="error" class="err" data-testid="onto-edit-preview-error">{{ error }}</small>
    </div>
  </div>
</template>

<style scoped>
.oep { display: flex; flex-direction: column; gap: 10px; min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }
.scope { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.rg { margin-top: -6px; font-size: 12px; color: var(--text-tertiary); line-height: 1.5; }
.seg { align-self: flex-start; display: inline-flex; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg button { height: 28px; padding: 0 13px; border-radius: 9999px; font-size: 12.5px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--text-primary-on); }
.hint { margin-top: -4px; font-size: 12px; color: var(--text-tertiary); }
.pend { margin: 0; padding: 10px 12px; border-radius: 14px; background: var(--field-bg); font-size: 13.5px; color: var(--text-secondary); }
.ans { display: flex; gap: 6px; }
.in { flex: 1; min-width: 0; height: 34px; padding: 0 12px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font-size: 13.5px; color: var(--text-primary); }
.in::placeholder { color: var(--text-tertiary); }
.said { display: flex; flex-direction: column; gap: 3px; padding-top: 8px; border-top: 1px solid var(--hairline); }
.cap { font-size: 11.5px; color: var(--text-tertiary); }
.said q { font-size: 13.5px; line-height: 1.55; color: var(--text-primary); quotes: '「' '」'; }
.res { margin: 0; padding: 8px 10px; border-radius: 12px; font-size: 12.5px; line-height: 1.5; background: color-mix(in srgb, #e8590c 12%, transparent); }
/* SidePanel's body pads 18px at the bottom: the foot covers it so nothing shows under the buttons */
.foot { position: sticky; bottom: -18px; z-index: 1; margin: 0 -18px -18px; padding: 10px 18px 18px; display: flex; flex-direction: column; gap: 6px;
  background: linear-gradient(var(--regular-solid-bg), var(--regular-solid-bg)), var(--surface-secondary); box-shadow: 0 -1px 0 var(--hairline); }
.btns { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sp { flex: 1; }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--text-primary-on); white-space: nowrap; }
.pill { height: 34px; padding: 0 13px; border-radius: 9999px; font-size: 13px; font-weight: 500; background: var(--field-bg); color: var(--text-primary); white-space: nowrap; }
.ghost { height: 34px; padding: 0 10px; border-radius: 9999px; font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.go:disabled, .pill:disabled, .ghost:disabled { opacity: .45; cursor: default; }
.why { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.err { font-size: 12.5px; color: var(--color-error); }
.meta { font-size: 11px; color: var(--text-tertiary); }
</style>
