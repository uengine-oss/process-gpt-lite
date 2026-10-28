<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'

// Types `text` char by char; emits done. `cps` = characters per second.
const props = defineProps({ text: String, cps: { type: Number, default: 22 }, caret: { type: Boolean, default: true } })
const emit = defineEmits(['done'])
const shown = ref('')
let timer

function run() {
  clearInterval(timer)
  shown.value = ''
  let i = 0
  // English mode: type the translation (a half-typed Korean string has no dictionary entry)
  const chars = [...(window.osI18n ? window.osI18n.tr(props.text || '') : props.text || '')]
  timer = setInterval(() => {
    shown.value += chars[i++] ?? ''
    if (i >= chars.length) { clearInterval(timer); emit('done') }
  }, 1000 / props.cps)
}
watch(() => props.text, run, { immediate: true })
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <span>{{ shown }}<span v-if="caret" class="caret">|</span></span>
</template>

<style scoped>
.caret { animation: caret 1s steps(1) infinite; font-weight: 300; margin-left: 1px; opacity: .6; }
</style>
