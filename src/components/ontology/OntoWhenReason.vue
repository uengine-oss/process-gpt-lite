<script setup>
// 결정 한 줄: 이유와 효력일(기본 오늘 = 지금부터, 뒷날을 고르면 그날부터). 고정 · 은퇴 · 되살림이 같이 쓴다.
import { computed } from 'vue'
import { today, dayKo } from './ontoText.js'

const props = defineProps({ reason: String, date: String, placeholder: { type: String, default: '이유(선택)' } })
const emit = defineEmits(['update:reason', 'update:date'])
const later = computed(() => !!props.date && props.date > today())
</script>

<template>
  <div class="wr">
    <input class="in" :value="reason" :placeholder="placeholder" maxlength="200" data-testid="onto-reason" @input="emit('update:reason', $event.target.value)" />
    <label class="when" :class="{ later }">
      <span>효력일</span>
      <input type="date" :value="date || today()" :min="today()" data-testid="onto-valid-from" @input="emit('update:date', $event.target.value)" />
    </label>
    <small class="hint">{{ later ? `${dayKo(date)}부터 적용돼요. 그 전까지는 지금 그대로예요.` : '지금부터 적용돼요.' }}</small>
  </div>
</template>

<style scoped>
.wr { word-break: keep-all; overflow-wrap: anywhere; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.in { flex: 1 1 180px; min-width: 0; height: 36px; padding: 0 12px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font-size: 14px; }
.in::placeholder { color: var(--text-tertiary); }
.when { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 4px 0 10px; border-radius: 12px; background: var(--field-bg); font-size: 12.5px; color: var(--text-secondary); flex: none; }
.when.later { color: var(--color-info); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--color-info) 55%, transparent); }
.when input { border: 0; outline: 0; background: none; font-size: 13.5px; color: var(--text-primary); height: 32px; color-scheme: dark; }
:root[data-theme="light"] .when input { color-scheme: light; }
.hint { flex-basis: 100%; font-size: 12px; color: var(--text-tertiary); margin-left: 2px; }
</style>
