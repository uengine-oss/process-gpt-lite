<script setup>
defineProps({ size: { type: Number, default: 48 } })
</script>

<template>
  <div class="wm" :style="{ fontSize: size + 'px' }">process <i>gpt</i></div>
</template>

<style scoped>
.wm { font-family: var(--font-serif); font-weight: 500; letter-spacing: -0.02em; color: var(--ink); line-height: 1; }
.wm i { font-weight: 300; color: var(--text-secondary); margin-left: .08em; }
</style>
