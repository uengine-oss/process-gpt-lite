<script setup>
// 말로 프로세스 지도 고치기 · 더하기: 지도 카드 아래쪽의 입력 한 줄(넓은 화면은 범례 바로 위, 폰은 지도 아래).
// 안내 글은 쓰는 쪽(지도 화면)이 범위에 맞춰 준다 — 새 프로세스 · 이 프로세스 · 고른 단계. 고른 것이 있으면 「고른 것 N개 · 지우기」,
// 「말로 정리하기」로 열렸으면 그 줄(context)이 위에 붙는다. Enter 는 보내기, Shift + Enter 는 줄 바꿈(한글을 조합하는 중에는 보내지 않는다).
// 안내 글은 직접 그린다(textarea 의 placeholder 는 한 줄 높이에서 잘린다) — 칸은 안내 글 높이만큼 커진다.
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  scope: { type: String, default: 'new' }, // 'new' | 'process' | 'range'
  pending: Boolean, // 말을 지도로 옮기는 중
  picked: { type: Number, default: 0 }, // 고른 일 + 관계
  context: { type: String, default: '' },
  error: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'submit', 'clear-pick', 'clear-context'])

const ta = ref(null)
const ph = ref(null)
const wrap = ref(null)
const MAX = 132
function grow() {
  const el = ta.value
  if (!el) return
  el.style.height = 'auto'
  const h = Math.max(el.scrollHeight, !props.modelValue && ph.value ? ph.value.offsetHeight : 0)
  el.style.height = `${Math.min(h, MAX)}px`
}
watch(() => [props.modelValue, props.placeholder, props.pending], () => nextTick(grow))
let ro
onMounted(() => { grow(); ro = new ResizeObserver(() => grow()); if (wrap.value) ro.observe(wrap.value) })
onBeforeUnmount(() => ro?.disconnect())

function send() {
  if (props.pending || !props.modelValue.trim()) return
  emit('submit')
}
function onKey(e) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  send()
}
defineExpose({
  focus() {
    nextTick(() => {
      const el = ta.value
      if (!el) return
      el.focus()
      const n = el.value.length
      el.setSelectionRange(n, n)
    })
  },
})
</script>

<template>
  <div class="ebox" :class="{ pending }" data-testid="onto-edit-box" :data-scope="scope">
    <div v-if="picked || context" class="top">
      <span v-if="picked" class="chip" data-testid="onto-edit-picked">고른 것 {{ picked }}개 · <button class="lk press" data-testid="onto-edit-picked-clear" @click="emit('clear-pick')">지우기</button></span>
      <span v-if="context" class="chip cx" data-testid="onto-edit-context">{{ context }} · <button class="lk press" @click="emit('clear-context')">그만두기</button></span>
    </div>
    <div ref="wrap" class="row glass">
      <div class="field">
        <textarea v-show="!pending" ref="ta" rows="1" :value="modelValue" :aria-label="placeholder" maxlength="1000" enterkeyhint="send" data-testid="onto-edit-input"
          @input="emit('update:modelValue', $event.target.value)" @keydown="onKey" />
        <div v-if="!modelValue && !pending" ref="ph" class="ph" aria-hidden="true" data-testid="onto-edit-placeholder">{{ placeholder }}</div>
        <p v-if="pending" class="pend pulse" data-testid="onto-edit-box-pending">말을 지도로 옮기는 중…</p>
      </div>
      <button class="send press" :disabled="pending || !modelValue.trim()" aria-label="보내기" title="보내기 (Enter)" data-testid="onto-edit-send" @click="send"><Icon name="up" :size="16" /></button>
    </div>
    <small v-if="error" class="err" data-testid="onto-edit-box-error">{{ error }}</small>
  </div>
</template>

<style scoped>
.ebox { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; width: 100%; max-width: 660px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 11px; border-radius: 13px; font-size: 12.5px; color: var(--text-primary); white-space: nowrap;
  background: color-mix(in srgb, #5468ff 14%, var(--regular-solid-bg)); box-shadow: inset 0 0 0 1px color-mix(in srgb, #5468ff 40%, transparent); }
.chip.cx { background: color-mix(in srgb, #e8590c 12%, var(--regular-solid-bg)); box-shadow: inset 0 0 0 1px color-mix(in srgb, #e8590c 40%, transparent); white-space: normal; height: auto; min-height: 26px; padding: 3px 11px; }
.lk { font-size: 12.5px; font-weight: 600; color: var(--text-primary); text-decoration: underline; text-underline-offset: 2px; }
.row { display: flex; align-items: flex-end; gap: 6px; width: 100%; min-width: 0; padding: 5px 5px 5px 14px; border-radius: 21px; box-shadow: var(--shadow-card), inset 0 0 0 1px var(--hairline); }
.field { position: relative; flex: 1; min-width: 0; }
textarea { display: block; width: 100%; box-sizing: border-box; min-height: 32px; max-height: 132px; resize: none; border: 0; outline: 0; background: none; padding: 6px 0; margin: 0;
  font: inherit; font-size: 14px; line-height: 20px; color: var(--text-primary); overflow-y: auto; scrollbar-width: thin; }
.ph { position: absolute; left: 0; right: 0; top: 0; padding: 6px 0; font-size: 14px; line-height: 20px; color: var(--text-tertiary); pointer-events: none; word-break: keep-all; overflow-wrap: anywhere; }
.pend { margin: 0; padding: 6px 0; font-size: 14px; line-height: 20px; color: var(--text-secondary); }
.send { flex: none; width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; background: var(--ink); color: var(--text-primary-on); }
.send:disabled { opacity: .3; cursor: default; }
.err { font-size: 12.5px; color: var(--color-error); padding-left: 6px; }
</style>
