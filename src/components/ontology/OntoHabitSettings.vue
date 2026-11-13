<script setup>
// 개인 습관을 지도에 보이기(design-v0.3 §4): 기준 이상만(같은 역할 N명 이상, 기본 3) · 모두(이름 없이) · 끄기.
// 셈에는 늘 모두 들어가고, 이 설정은 지도 · 검토 안건 · 역할 화면에 보이는지만 정한다. 관리자만 바꾸고 다른 사람은 읽기만.
// habits: 지도 응답의 habits {mode, min, hidden}. emits changed(저장 뒤 — 지도를 다시 불러온다)
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { HABIT_MODE_KO } from './fmt.js'

const props = defineProps({ habits: { type: Object, default: null }, admin: Boolean })
const emit = defineEmits(['changed'])
const mode = ref('threshold')
const min = ref(3)
const busy = ref(false)
const err = ref('')
const note = ref('')
const sync = () => { mode.value = props.habits?.mode || 'threshold'; min.value = props.habits?.min ?? 3 }
watch(() => props.habits, sync, { immediate: true })

const MODES = ['threshold', 'all', 'off']
const dirty = computed(() => mode.value !== (props.habits?.mode || 'threshold') || (mode.value === 'threshold' && Number(min.value) !== (props.habits?.min ?? 3)))
const current = computed(() => (props.habits?.mode === 'threshold' || !props.habits?.mode ? `기준 이상만(같은 역할 ${props.habits?.min ?? 3}명)` : HABIT_MODE_KO[props.habits.mode]))
const hidden = computed(() => props.habits?.hidden || 0)

async function save() {
  busy.value = true; err.value = ''; note.value = ''
  try {
    const n = Math.max(1, Math.min(50, Math.round(Number(min.value) || 3)))
    await api('/ontology/settings', { method: 'PUT', body: { mode: mode.value, min: n } })
    note.value = '저장했어요. 지도를 다시 그려요.'
    emit('changed', { kind: 'habits', mode: mode.value, min: n })
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="hs" data-testid="onto-habit-settings">
    <div class="hd"><b>개인 습관을 지도에 보이기</b><small v-if="!admin">{{ current }}</small></div>
    <template v-if="admin">
      <div class="opts" role="radiogroup" aria-label="개인 습관을 지도에 보이기">
        <label v-for="m in MODES" :key="m" class="opt" :class="{ on: mode === m }" :data-testid="`onto-habit-mode-${m}`">
          <input v-model="mode" type="radio" name="onto-habit-mode" :value="m">
          <template v-if="m === 'threshold'">
            <span>기준 이상만(같은 역할</span>
            <input v-model.number="min" class="num" type="number" min="1" max="50" :disabled="mode !== 'threshold'" aria-label="같은 역할 사람 수" data-testid="onto-habit-min" @click.stop>
            <span>명)</span>
          </template>
          <span v-else>{{ HABIT_MODE_KO[m] }}</span>
        </label>
      </div>
      <div class="row">
        <small class="why">셈에는 늘 모두 들어가요. 여기서는 지도 · 검토 안건 · 역할 화면에 보이는지만 정해요.</small>
        <button class="go press" :disabled="busy || !dirty" data-testid="onto-habit-save" @click="save">{{ busy ? '저장하는 중…' : '저장' }}</button>
      </div>
    </template>
    <small v-if="hidden" class="hid" data-testid="onto-habit-hidden">{{ props.habits?.mode === 'off' ? '꺼 두어' : '기준에 못 미쳐' }} 지도에 안 보이는 습관 {{ hidden }}개</small>
    <small v-if="note" class="ok">{{ note }}</small>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.hs { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 16px; background: var(--cell-bg); word-break: keep-all; overflow-wrap: anywhere; }
.hd { display: flex; flex-direction: column; gap: 2px; }
.hd b { font-size: 14px; font-weight: 600; }
.hd small { font-size: 13px; color: var(--text-secondary); }
.opts { display: flex; flex-direction: column; gap: 4px; }
.opt { display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 4px 10px; border-radius: 12px; font-size: 13.5px; cursor: pointer; color: var(--text-secondary); }
.opt.on { background: var(--field-bg); color: var(--text-primary); }
.opt input[type=radio] { margin: 0; accent-color: var(--text-primary); }
.num { width: 52px; height: 28px; padding: 0 6px; border-radius: 8px; border: 0; outline: 0; background: var(--regular-solid-bg); box-shadow: inset 0 0 0 1px var(--hairline); font-size: 13.5px; color: var(--text-primary); text-align: center; font-variant-numeric: tabular-nums; }
.num:disabled { opacity: .5; }
.row { display: flex; align-items: flex-end; gap: 10px; }
.why { flex: 1; font-size: 12px; color: var(--text-tertiary); line-height: 1.45; }
.go { flex: none; height: 32px; padding: 0 16px; border-radius: 9999px; font-size: 13px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go:disabled { opacity: .45; cursor: default; }
.hid { font-size: 12.5px; color: var(--text-secondary); }
.ok { font-size: 12.5px; color: var(--color-success); }
.err { font-size: 12.5px; color: var(--color-error); }
</style>
